/**
 * docx-import.js — import a .docx Word document into the natural-language
 * input box, extracting both text (as Markdown) and embedded images.
 *
 * Strategy (A+ "original position"):
 *   1) mammoth.convertToMarkdown() turns the document body into Markdown
 *      (headings, lists, tables, bold/italic preserved).
 *   2) The convertImage hook fires once per inline image. We:
 *        - upload renderable images (png/jpeg/gif/webp/bmp) to IndexedDB via
 *          RF_ImageManager and remember {assetId, name};
 *        - emit a stable placeholder token `[[RF-IMG:<assetId>]]` at the
 *          image's position in the Markdown stream so we can re-insert it
 *          later, exactly where it appeared in the source document;
 *        - skip non-renderable formats (EMF/WMF/...) — the browser cannot
 *          display them — and count them for the summary, returning {} so
 *          mammoth drops them.
 *   3) The Markdown (with placeholders) is dropped into #rf-input-text. The
 *      user then clicks 解析 as usual; the LLM is instructed (see
 *      prompt-builder rule 7) to keep `[[RF-IMG:...]]` tokens verbatim.
 *   4) After parsing finishes (parser:done), reinsertImages() walks every
 *      text block, splits it on the placeholders, and turns each placeholder
 *      into a real image block in place. Any images whose placeholder the LLM
 *      dropped are appended to the last section so nothing is ever lost.
 *
 * Public:
 *   RF_DocxImport.init()
 *   RF_DocxImport.openPicker()
 *   RF_DocxImport.PLACEHOLDER_RE
 */
(function () {
  "use strict";

  var TA_ID  = "rf-input-text";
  var INPUT_ID = "rf-docx-file";

  // Renderable image MIME types — anything else (EMF/WMF/x-emf/x-wmf, …) the
  // browser can't paint, so we skip it and tell the user.
  var RENDERABLE = /^image\/(png|jpe?g|gif|webp|bmp)$/i;

  // Visual placeholder: 📷[图片N] where N is 1-based index.
  // We also support BOTH formats for backward compatibility:
  // - 📷[图片N] (new visual format)
  // - [[RF-IMG:id]] (old format, for backward compatibility)
  var PLACEHOLDER_RE = /📷\[图片(\d+)\]|\[\[RF-IMG:([a-zA-Z0-9_-]+)\]\]/g;

  // Pending images collected during the most recent import, consumed when the
  // next parse completes. Keyed nothing fancy — a flat list is enough.
  var pending = [];          // [{assetId, name}]
  var awaitingParse = false; // true between a successful import and parser:done

  function init() {
    var ta = document.getElementById(TA_ID);
    if (!ta) return;

    // Inject a hidden file input once.
    var input = document.getElementById(INPUT_ID);
    if (!input) {
      input = document.createElement("input");
      input.type = "file";
      input.id = INPUT_ID;
      input.accept = ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      input.style.display = "none";
      document.body.appendChild(input);
      input.addEventListener("change", onFileChosen);
    }

    // When a parse completes, fold any pending images back into the report.
    if (window.RF_Bus) {
      window.RF_Bus.on("parser:done", function () {
        // 隐藏导入图片预览面板
        var panel = document.getElementById("rf-imported-images");
        if (panel) panel.hidden = true;

        if (awaitingParse) {
          awaitingParse = false;
          // Defer so RF_State.set("report", …) from the parser has settled.
          setTimeout(reinsertImages, 0);
        }
      });
    }

    // 清空输入时也隐藏图片预览
    var clearBtn = document.getElementById("rf-btn-clear-input");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        var panel = document.getElementById("rf-imported-images");
        if (panel) panel.hidden = true;
      });
    }
  }

  function openPicker() {
    if (!window.mammoth) {
      window.RF_UI.toast.err("Word 解析库未加载，请刷新页面后重试");
      return;
    }
    var input = document.getElementById(INPUT_ID);
    if (input) { input.value = ""; input.click(); }
  }

  function onFileChosen(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) {
      window.RF_UI.toast.err("请选择 .docx 格式文件（旧版 .doc 不支持，请先在 Word 中另存为 .docx）");
      return;
    }
    importFile(file);
  }

  function importFile(file) {
    var log = window.RF_Log;
    var skipped = { count: 0, types: {} };
    var uploaded = [];        // {assetId, name}
    var uploadQueue = [];     // Promises

    log && log.info("docx-import: start " + file.name);
    window.RF_UI.toast.show("正在解析 Word…");

    var convertImage = window.mammoth.images.imgElement(function (image) {
      var ctype = (image.contentType || "").toLowerCase();
      if (!RENDERABLE.test(ctype)) {
        skipped.count++;
        skipped.types[ctype || "unknown"] = (skipped.types[ctype || "unknown"] || 0) + 1;
        // Returning a non-img element with no src — but to truly drop it we
        // return an empty span via the promise below.
        return Promise.resolve({ src: "" });
      }
      // Pull the raw bytes and wrap as a File so RF_ImageManager.upload works.
      var p = image.readAsArrayBuffer().then(function (buffer) {
        var blob = new Blob([buffer], { type: ctype });
        var ext = ctype.split("/")[1] || "png";
        var name = "word-image-" + (uploaded.length + 1) + "." + ext;
        var f = new File([blob], name, { type: ctype });
        return window.RF_ImageManager.upload(f).then(function (rec) {
          uploaded.push({ assetId: rec.id, name: rec.name });
          // Carry our id in the src; we match on src (not alt) when rewriting
          // the Markdown, since the writer may escape brackets in alt text.
          return { src: "rf-img:" + rec.id };
        });
      });
      uploadQueue.push(p);
      return p;
    });

    file.arrayBuffer().then(function (buf) {
      return window.mammoth.convertToMarkdown(
        { arrayBuffer: buf },
        { convertImage: convertImage }
      );
    }).then(function (result) {
      // Wait for every image upload to settle before we touch the textarea.
      return Promise.all(uploadQueue).then(function () { return result; });
    }).then(function (result) {
      var md = result.value || "";
      // mammoth renders images as ![alt](src). We tagged renderable images
      // with src="rf-img:<id>" — rewrite each to a VISUAL placeholder.
      // Use 📷[图片N:id] format with newlines so it stands out in the textarea.
      var imgNum = 0;
      var imgOrderMap = {}; // 记录图片序号 → assetId 的映射，供预览面板使用
      md = md.replace(/!\[[^\]]*\]\(rf-img:([a-zA-Z0-9_-]+)\)/g, function (_, id) {
        imgNum++;
        imgOrderMap[imgNum] = id;
        return "\n\n📷[图片" + imgNum + "]\n\n";
      });
      // Skipped images: mammoth emitted ![](empty) — strip those leftovers.
      md = md.replace(/!\[[^\]]*\]\(\s*\)/g, "");

      var ta = document.getElementById(TA_ID);
      if (ta) {
        var existing = ta.value.trim();
        ta.value = existing ? (existing + "\n\n" + md) : md;
        // Notify listeners (draft auto-save, parse-button state, …).
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }

      // 设置图片序号（供删除功能使用）
      uploaded.forEach(function (item, idx) { item.index = idx + 1; });

      pending = uploaded.slice();
      awaitingParse = uploaded.length > 0;

      // 显示导入图片预览面板
      renderImportedImagesPreview(uploaded);

      reportSummary(uploaded.length, skipped, result.messages);
      log && log.info("docx-import: done, " + uploaded.length + " images, " + skipped.count + " skipped");
    }).catch(function (err) {
      log && log.error("docx-import: " + (err && err.message || err));
      window.RF_UI.toast.err("Word 解析失败：" + (err && err.message || err));
    });
  }

  // ------------------------------------------------------------------
  // Import preview: show imported images in a thumbnail grid before parse.
  // ------------------------------------------------------------------
  function renderImportedImagesPreview(uploaded) {
    var panel = document.getElementById("rf-imported-images");
    var grid = document.getElementById("rf-imported-images-grid");
    var countEl = document.getElementById("rf-imported-images-count");
    if (!panel || !grid) return;

    // 清空旧内容
    grid.innerHTML = "";

    // 无图片时隐藏面板
    if (!uploaded || !uploaded.length) {
      panel.hidden = true;
      return;
    }

    // 更新计数
    countEl.textContent = uploaded.length + " 张";
    panel.hidden = false;

    // 渲染缩略图
    uploaded.forEach(function (item, idx) {
      var div = document.createElement("div");
      div.className = "rf-imported-images__item";
      div.dataset.index = idx + 1;
      div.dataset.assetId = item.assetId;
      div.title = item.name || "图片 " + (idx + 1);

      window.RF_Assets.url(item.assetId).then(function (url) {
        if (!url) return;
        var img = document.createElement("img");
        img.src = url;
        img.loading = "lazy";
        div.appendChild(img);
      });

      // 删除按钮
      var delBtn = document.createElement("button");
      delBtn.className = "rf-imported-images__delete";
      delBtn.innerHTML = "✕";
      delBtn.title = "删除此图片";
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation(); // 阻止触发大图预览
        deleteImage(idx + 1, item.assetId);
      });
      div.appendChild(delBtn);

      // 点击：定位到 textarea 中的对应位置（不触发删除）
      div.addEventListener("click", function (e) {
        if (e.target === delBtn) return;
        var ta = document.getElementById(TA_ID);
        if (ta) {
          var placeholder = "📷[图片" + (idx + 1) + "]";
          var pos = ta.value.indexOf(placeholder);
          if (pos >= 0) {
            ta.focus();
            ta.setSelectionRange(pos, pos + placeholder.length);

            // === 精确居中计算 ===
            // 让占位符出现在「文本框真正可用的可视区域」的正中央
            // 注意：textarea 的 clientHeight 已经是被预览面板压缩后的高度了
            //       但滚动到下方时，内容可能被面板视觉遮挡，所以要留底部余量

            var computed = window.getComputedStyle(ta);
            var actualLineHeight = parseFloat(computed.lineHeight);
            if (isNaN(actualLineHeight) || actualLineHeight < 5) {
              actualLineHeight = parseFloat(computed.fontSize) * 1.7;
            }
            var paddingTop = parseFloat(computed.paddingTop) || 14;
            var paddingBottom = parseFloat(computed.paddingBottom) || 14;

            // 占位符所在的行号（0-based）
            var lineIndex = ta.value.slice(0, pos).split("\n").length - 1;

            // 占位符距离全文顶部的像素位置
            var placeholderTop = lineIndex * actualLineHeight;

            // 额外的底部安全边距（防止被面板视觉遮挡）
            var safetyMargin = actualLineHeight * 2;

            // 可用高度 = 文本框高度 - 上下内边距 - 安全边距
            var availableHeight = ta.clientHeight - paddingTop - paddingBottom - safetyMargin;

            // 目标：让占位符在可用高度中垂直居中
            var centerOffset = (availableHeight - actualLineHeight) / 2;
            var targetScrollTop = Math.max(0, placeholderTop - centerOffset);

            ta.scrollTop = targetScrollTop;
          }
        }
        // 显示大图
        window.RF_Assets.url(item.assetId).then(function (url) {
          if (!url) return;
          var modal = document.createElement("div");
          modal.className = "rf-imported-images__modal";
          modal.tabIndex = 0;
          var img = document.createElement("img");
          img.src = url;
          modal.appendChild(img);
          var close = function () { modal.parentNode && modal.parentNode.removeChild(modal); };
          modal.addEventListener("click", close);
          modal.addEventListener("keydown", function (e) {
            if (e.key === "Escape" || e.key === "Enter" || e.key === " ") close();
          });
          document.body.appendChild(modal);
          modal.focus();
        });
      });

      grid.appendChild(div);
    });
  }

  // 删除图片：从文本框移除占位符，重新编号剩余图片，更新 pending 数组
  function deleteImage(imageIndex, assetId) {
    var ta = document.getElementById(TA_ID);
    if (!ta) return;

    // 1. 从文本框移除被删除的图片占位符
    var placeholder = "📷[图片" + imageIndex + "]";
    ta.value = ta.value.replace(new RegExp("\\n*" + placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "\\n*", "g"), "\n");

    // 2. 重新编号剩余图片（序号大于被删除的都要减 1）
    var maxIndex = 100; // 合理的上限
    for (var i = imageIndex + 1; i <= maxIndex; i++) {
      var oldPlaceholder = "📷[图片" + i + "]";
      var newPlaceholder = "📷[图片" + (i - 1) + "]";
      if (ta.value.indexOf(oldPlaceholder) === -1) break; // 没有更多了，提前退出
      ta.value = ta.value.split(oldPlaceholder).join(newPlaceholder);
    }

    // 3. 更新 pending 数组（移除并重新编号）
    pending = pending.filter(function (p) { return p.assetId !== assetId; });
    pending.forEach(function (p, i) { p.index = i + 1; });

    // 4. 移除 IndexedDB 中的图片
    try { window.RF_Assets.remove(assetId); } catch (e) {}

    // 5. 重新渲染预览面板
    renderImportedImagesPreview(pending);

    // 6. 触发 input 事件通知其他监听者
    ta.dispatchEvent(new Event("input", { bubbles: true }));

    window.RF_UI.toast.show("已删除图片 " + imageIndex);
  }

  // 探测一个 text 块的 content 是否包含任何图片占位符（新或旧格式）。
  // 与 PLACEHOLDER_RE 对应，但用一个独立的 test 实例避免 lastIndex 状态污染。
  function hasPlaceholder(content) {
    if (typeof content !== "string" || !content) return false;
    if (content.indexOf("[[RF-IMG:") >= 0) return true;
    // 📷[图片N] 视觉新格式。indexOf 比正则便宜，先做廉价短路。
    if (content.indexOf("📷[图片") < 0) return false;
    return /📷\[图片\d+\]/.test(content);
  }

  // ------------------------------------------------------------------
  // After parse: replace [[RF-IMG:id]] placeholders with real image blocks.
  // ------------------------------------------------------------------
  function reinsertImages() {
    if (!pending.length) return;
    var report = window.RF_State.get("report");
    if (!report || !Array.isArray(report.sections)) { pending = []; return; }

    var byId = {};
    pending.forEach(function (p) { byId[p.assetId] = p; });
    var used = {};

    report.sections.forEach(function (section) {
      if (!Array.isArray(section.blocks)) return;
      var out = [];
      section.blocks.forEach(function (block) {
        if (block && block.type === "text" && hasPlaceholder(block.content)) {
          splitTextBlock(block, byId, used, out);
        } else {
          out.push(block);
        }
      });
      section.blocks = out;
    });

    // Any image whose placeholder the LLM dropped → append to last section so
    // we never silently lose an image.
    var orphans = pending.filter(function (p) { return !used[p.assetId]; });
    if (orphans.length) {
      var last = report.sections[report.sections.length - 1];
      if (!last) {
        last = { id: "s-img", heading: "图片", level: 1, blocks: [] };
        report.sections.push(last);
      }
      if (!Array.isArray(last.blocks)) last.blocks = [];
      orphans.forEach(function (p) {
        last.blocks.push(imageBlock(p.assetId));
      });
    }

    pending = [];
    // Re-validate + push so preview/editor refresh.
    var v = window.RF_Schema.validate(report);
    window.RF_State.set("report", v.normalized);
    try { window.RF_Storage.set("draft", "current", v.normalized); } catch (e) {}
    if (orphans.length) {
      window.RF_UI.toast.show(
        orphans.length + " 张图片未匹配到原位置，已追加到末尾，可手动调整");
    }
  }

  // Split one text block's content on placeholders, producing alternating
  // text + image blocks, pushed into `out`.
  function splitTextBlock(block, byId, used, out) {
    var content = block.content;
    var lastIndex = 0;
    var m;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(content)) !== null) {
      var before = content.slice(lastIndex, m.index);
      if (before.trim()) {
        out.push({ type: "text", format: block.format || "markdown", content: before.trim() });
      }
      // 支持两种格式:
      // - m[1] = 序号 (新格式 📷[图片N])
      // - m[2] = assetId (旧格式 [[RF-IMG:id]])
      var id = m[2]; // 旧格式直接取 assetId
      if (!id && m[1]) {
        // 新格式：按序号从 pending 数组中查找 assetId
        var idx = parseInt(m[1], 10) - 1;
        if (pending[idx]) id = pending[idx].assetId;
      }
      if (id && byId[id] && !used[id]) {
        out.push(imageBlock(id));
        used[id] = true;
      }
      lastIndex = m.index + m[0].length;
    }
    var rest = content.slice(lastIndex);
    if (rest.trim()) {
      out.push({ type: "text", format: block.format || "markdown", content: rest.trim() });
    }
  }

  function imageBlock(assetId) {
    return { type: "image", assetId: assetId, src: null, caption: "" };
  }

  function reportSummary(okCount, skipped, messages) {
    var parts = ["Word 导入完成"];
    parts.push("文字已填入录入框");
    if (okCount) parts.push("成功导入 " + okCount + " 张图片");
    if (skipped.count) {
      var typeList = Object.keys(skipped.types).map(function (t) {
        return t.replace("image/", "") + "×" + skipped.types[t];
      }).join("、");
      parts.push("跳过 " + skipped.count + " 张无法解析的图片（" + typeList + "）");
    }
    var msg = parts.join("，");
    if (skipped.count) {
      window.RF_UI.toast.warn(msg + "。EMF/WMF 等矢量格式浏览器无法渲染，请在 Word 中将其另存为 PNG 后重新插入");
    } else {
      window.RF_UI.toast.ok(msg + "。点击「解析」继续结构化");
    }
  }

  window.RF_DocxImport = {
    init: init,
    openPicker: openPicker,
    PLACEHOLDER_RE: PLACEHOLDER_RE
  };
})();

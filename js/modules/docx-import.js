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

  // Stable, LLM-friendly placeholder. assetId is our own id (e.g. "a-xxxx"),
  // which contains only [a-z0-9-], so this regex is safe.
  var PLACEHOLDER_RE = /\[\[RF-IMG:([a-zA-Z0-9_-]+)\]\]/g;

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
        if (awaitingParse) {
          awaitingParse = false;
          // Defer so RF_State.set("report", …) from the parser has settled.
          setTimeout(reinsertImages, 0);
        }
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
      // with src="rf-img:<id>" — rewrite each to our bare placeholder token,
      // regardless of what (possibly escaped) alt text the writer produced.
      md = md.replace(/!\[[^\]]*\]\(rf-img:([a-zA-Z0-9_-]+)\)/g, "[[RF-IMG:$1]]");
      // Skipped images: mammoth emitted ![](empty) — strip those leftovers.
      md = md.replace(/!\[[^\]]*\]\(\s*\)/g, "");

      var ta = document.getElementById(TA_ID);
      if (ta) {
        var existing = ta.value.trim();
        ta.value = existing ? (existing + "\n\n" + md) : md;
        // Notify listeners (draft auto-save, parse-button state, …).
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }

      pending = uploaded.slice();
      awaitingParse = uploaded.length > 0;

      reportSummary(uploaded.length, skipped, result.messages);
      log && log.info("docx-import: done, " + uploaded.length + " images, " + skipped.count + " skipped");
    }).catch(function (err) {
      log && log.error("docx-import: " + (err && err.message || err));
      window.RF_UI.toast.err("Word 解析失败：" + (err && err.message || err));
    });
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
        if (block && block.type === "text" && typeof block.content === "string" &&
            block.content.indexOf("[[RF-IMG:") >= 0) {
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
      var id = m[1];
      if (byId[id] && !used[id]) {
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

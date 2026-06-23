/**
 * bootstrap.js — application entry. Runs last (after all defer scripts).
 *
 * Wires the DOM events, restores config + draft + last template, kicks off
 * the preview, and exposes a tiny window.RF for debugging.
 */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", boot);

  function boot() {
    if (!window.RF_VENDOR || !window.RF_VENDOR.ok) {
      // vendor-shim already rendered a banner; avoid throwing further.
      console.error("[boot] aborting due to missing vendor libs");
      return;
    }

    // Initialize subsystems (order matters — they wire DOM listeners).
    window.RF_ConfigManager.init();    // loads "config.llm" into state
    window.RF_Editor.init();           // binds to state.report
    window.RF_Preview.init();          // creates the iframe doc, listens for state changes
    if (window.RF_ScrollSync) window.RF_ScrollSync.init();  // editor ↔ preview scroll sync
    if (window.RF_BlockHighlight) window.RF_BlockHighlight.init();  // block click highlight
    if (window.RF_SmartHighlight) window.RF_SmartHighlight.init();  // 智能高亮按钮
    window.RF_History.init();          // history button + Ctrl+S

    // ===== Template selector =====
    populateTemplateSelect();
    window.RF_Bus.on("template:registered", populateTemplateSelect);

    var sel = document.getElementById("rf-template-select");
    if (sel) {
      sel.addEventListener("change", function () { setTemplate(sel.value); });
    }
    initTemplateSwitch();

    // ===== Restore last template & draft =====
    var ui = window.RF_Storage.get("config", "ui", {}) || {};
    var lastTpl = ui.lastTemplateId && window.ReportFlowTemplates.has(ui.lastTemplateId)
      ? ui.lastTemplateId
      : window.ReportFlowTemplates.pickDefault();
    setTemplate(lastTpl);

    var savedDraft = window.RF_Storage.get("draft", "current", null);
    if (savedDraft) {
      var v = window.RF_Schema.validate(savedDraft);
      window.RF_State.set("report", v.normalized);
    } else {
      // Nothing saved — start with empty so the editor shows its empty state.
      window.RF_State.set("report", window.RF_Schema.empty());
    }

    // ===== Save indicator =====
    bindSaveIndicator();
    bindStorageIndicator();

    // ===== Buttons =====
    bindButton("rf-btn-parse",          onParse);
    bindButton("rf-btn-load-sample",    onLoadSample);
    if (window.RF_DocxImport) {
      window.RF_DocxImport.init();
      bindButton("rf-btn-import-docx", function () { window.RF_DocxImport.openPicker(); });
    }
    bindButton("rf-btn-clear-input",    onClearInput);
    bindButton("rf-btn-clear",          onClearReport);
    if (window.RF_InputRewrite) window.RF_InputRewrite.init();
    bindButton("rf-btn-export-zip",     function () { window.RF_ExportZip.exportZip(); });
    bindButton("rf-btn-export-pdf",     function () { window.RF_ExportPdf.exportPdf(); });
    bindButton("rf-btn-export-html",    function () { window.RF_ExportHtml.exportHtml(); });
    bindButton("rf-btn-export-png",     function () { window.RF_ExportPng.exportPng(); });
    bindButton("rf-btn-export-docx",    function () { window.RF_ExportDocx.exportDocx(); });
    bindButton("rf-btn-fullscreen-preview", toggleFullscreenPreview);
    bindButton("rf-btn-help",           openHelp);

    // ===== 表格粘贴（三处入口的 A、B 在 bootstrap 里统一接） =====
    bindLeftPaneTablePaste();
    bindButton("rf-btn-paste-table",    onPasteTableButton);

    // ===== Keyboard shortcuts =====
    document.addEventListener("keydown", function (e) {
      var inInput = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && inInput) {
        var ta = document.getElementById("rf-input-text");
        if (e.target === ta) { e.preventDefault(); onParse(); }
      }
    });

    // ===== Splitters =====
    bindSplitters();

    // ===== Pane collapse（自然语言录入） =====
    initInputCollapse();

    // ===== Work mode 切换（标准 / 简易） =====
    initWorkMode();

    // ===== Mobile ⋮ 菜单（仅 ≤768px 由 CSS 显示） =====
    initMobileMore();

    // Storage quota notice
    window.RF_Bus.on("storage:quota", function () {
      window.RF_UI.toast.warn("浏览器存储空间已满，新内容无法保存。请在帮助中清理历史。");
    });

    window.RF_Log.info("boot: ready, template=" + lastTpl);

    // Debug surface
    window.RF = {
      state: window.RF_State,
      bus: window.RF_Bus,
      log: window.RF_Log,
      storage: window.RF_Storage,
      assets: window.RF_Assets,
      schema: window.RF_Schema,
      llm: window.RF_LLM,
      parser: window.RF_Parser,
      templates: window.ReportFlowTemplates,
      version: "0.1.0"
    };
  }

  function populateTemplateSelect() {
    var sel = document.getElementById("rf-template-select");
    if (!sel) return;
    var current = sel.value;
    sel.innerHTML = "";
    window.ReportFlowTemplates.list().forEach(function (m) {
      var o = document.createElement("option");
      o.value = m.id; o.textContent = m.name;
      o.title = m.description || "";
      sel.appendChild(o);
    });
    var stateTpl = window.RF_State.get("templateId");
    if (stateTpl) sel.value = stateTpl;
    else if (current && window.ReportFlowTemplates.has(current)) sel.value = current;
    syncTemplateSwitchUI();
  }

  // ===== Template switch (custom dropdown, mirrors .rf-mode-switch styling) =====
  // 单一真值：上面的 <select id="rf-template-select">。本函数只做：
  //   1) 触发器按钮的文案 + 菜单项的渲染
  //   2) 点击菜单项 → 写回 sel.value 并派发 "change"，复用现有 setTemplate 路径
  //   3) 点击外部 / Esc 关闭菜单
  function initTemplateSwitch() {
    var trigger = document.getElementById("rf-template-trigger");
    var menu    = document.getElementById("rf-template-menu");
    var sel     = document.getElementById("rf-template-select");
    if (!trigger || !menu || !sel) return;

    function open() {
      renderMenu();
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      // 让菜单宽度与整个模板切换器（"[图标] 模板 | 名称 ▾"）等宽并左对齐，
      // 视觉上像是这块导航段直接展开成下拉。
      alignMenuToHost();
      // 焦点放到当前激活项，方便键盘操作
      var active = menu.querySelector(".rf-template-switch__option.is-active") ||
                   menu.querySelector(".rf-template-switch__option");
      if (active) active.focus();
      document.addEventListener("mousedown", onDocDown, true);
      document.addEventListener("keydown", onKeyDown, true);
    }
    function alignMenuToHost() {
      var host = trigger.parentElement; // .rf-template-switch (position: relative)
      if (!host) return;
      menu.style.left  = "0px";
      menu.style.width = host.offsetWidth + "px";
    }
    function close() {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    }
    function onDocDown(e) {
      if (menu.contains(e.target) || trigger.contains(e.target)) return;
      close();
    }
    function onKeyDown(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); trigger.focus(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        var items = Array.prototype.slice.call(menu.querySelectorAll(".rf-template-switch__option"));
        if (!items.length) return;
        var idx = items.indexOf(document.activeElement);
        var next = e.key === "ArrowDown"
          ? (idx + 1) % items.length
          : (idx - 1 + items.length) % items.length;
        items[next].focus();
      }
    }

    function renderMenu() {
      menu.innerHTML = "";
      var current = sel.value;
      Array.prototype.forEach.call(sel.options, function (opt) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "rf-template-switch__option" + (opt.value === current ? " is-active" : "");
        b.setAttribute("role", "option");
        b.setAttribute("aria-selected", opt.value === current ? "true" : "false");
        if (opt.title) b.title = opt.title;
        b.innerHTML =
          '<span class="rf-template-switch__option-check" aria-hidden="true">✓</span>' +
          '<span>' + escapeHtml(opt.textContent) + '</span>';
        b.addEventListener("click", function () {
          if (sel.value !== opt.value) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          }
          close();
          trigger.focus();
        });
        menu.appendChild(b);
      });
    }

    trigger.addEventListener("click", function () {
      if (menu.hidden) open(); else close();
    });

    syncTemplateSwitchUI();
  }

  // 同步触发器文案到 select 当前值。populateTemplateSelect / setTemplate 后调用即可。
  function syncTemplateSwitchUI() {
    var sel   = document.getElementById("rf-template-select");
    var label = document.getElementById("rf-template-trigger-label");
    if (!sel || !label) return;
    var opt = sel.options[sel.selectedIndex];
    label.textContent = opt ? opt.textContent : "模板";
    var trigger = document.getElementById("rf-template-trigger");
    if (trigger && opt && opt.title) trigger.title = opt.title;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function setTemplate(id) {
    if (!id || !window.ReportFlowTemplates.has(id)) return;
    window.RF_State.set("templateId", id);
    var ui = window.RF_Storage.get("config", "ui", {}) || {};
    ui.lastTemplateId = id;
    try { window.RF_Storage.set("config", "ui", ui); } catch (e) {}
    var sel = document.getElementById("rf-template-select");
    if (sel && sel.value !== id) sel.value = id;
    syncTemplateSwitchUI();
    var manifest = (window.ReportFlowTemplates.get(id) || {}).manifest || {};
    var tplStatus = document.getElementById("rf-status-template");
    if (tplStatus) tplStatus.textContent = "模板：" + manifest.name;
    var hint = document.getElementById("rf-preview-hint");
    if (hint) hint.textContent = manifest.name + "  ·  " + (manifest.description || "");
  }

  function bindButton(id, handler) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("click", handler);
  }

  function bindSaveIndicator() {
    var status = document.getElementById("rf-status-save");
    if (!status) return;
    var tmr;
    function flash(text, cls) {
      status.className = "rf-status " + (cls || "");
      status.textContent = text;
      if (tmr) clearTimeout(tmr);
      tmr = setTimeout(function () {
        status.className = "rf-status rf-status--ok";
        status.textContent = "● 已保存";
      }, 1500);
    }
    window.RF_Bus.on("draft:saved",  function () { flash("● 已保存", "rf-status--ok"); });
    window.RF_Bus.on("state:report", function () { status.className = "rf-status"; status.textContent = "○ 编辑中…"; });
  }

  function bindStorageIndicator() {
    var st = document.getElementById("rf-status-storage");
    if (!st) return;
    function refresh() {
      var u = window.RF_Storage.usage();
      var ls = (u.totalBytes / 1024).toFixed(0) + " KB";
      window.RF_Assets.usageBytes().then(function (idb) {
        var idbStr = (idb / 1024 / 1024).toFixed(2) + " MB";
        st.textContent = "存储：LS " + ls + " · IDB " + idbStr;
      }).catch(function () {
        st.textContent = "存储：LS " + ls;
      });
    }
    refresh();
    window.RF_Bus.on("draft:saved", refresh);
    window.RF_Bus.on("history:saved", refresh);
    window.RF_Bus.on("assets:changed", refresh);
    window.RF_Bus.on("state:report", refresh);
    setInterval(refresh, 8000);
  }

  function onParse() {
    var ta = document.getElementById("rf-input-text");
    if (!ta || !ta.value.trim()) {
      window.RF_UI.toast.warn("请先在左侧输入文本"); return;
    }
    var c = window.RF_ConfigManager.get();
    if (!c.apiKey || !c.baseUrl || !c.model) {
      window.RF_UI.toast.warn("请先在「设置」配置大模型 API");
      window.RF_ConfigManager.openModal();
      return;
    }
    var btn = document.getElementById("rf-btn-parse");
    if (btn) { btn.disabled = true; btn.textContent = "解析中…"; }
    var progress = window.RF_ParseProgress && window.RF_ParseProgress.start();
    window.RF_Parser.parse(ta.value, {
      onProgress: function (ev) { if (progress) progress.update(ev); }
    }).then(function (out) {
      window.RF_State.set("report", out.report);
      try { window.RF_Storage.set("draft", "current", out.report); } catch (e) {}
      if (progress) progress.success({ sections: out.report.sections.length, warnings: out.errors.length });
      window.RF_UI.toast.ok("解析完成（" + out.report.sections.length + " 章节" +
        (out.errors.length ? "，" + out.errors.length + " 处自动修正" : "") + "）");
    }).catch(function (err) {
      var msg = String(err && err.message || err);
      if (progress) progress.fail(msg);
      window.RF_UI.toast.err(msg);
    }).then(function () {
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="rf-icon">⚡</span><span>解析</span>'; }
    });
  }

  function onLoadSample() {
    fetch("assets/samples/sample-input.txt")
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        var ta = document.getElementById("rf-input-text");
        if (ta) ta.value = txt;
        // Also drop the golden JSON straight into the report so the user can
        // see a populated preview without hitting the LLM.
        return fetch("assets/samples/sample-report.json").then(function (r) { return r.json(); });
      })
      .then(function (json) {
        var v = window.RF_Schema.validate(json);
        window.RF_State.set("report", v.normalized);
        window.RF_UI.toast.ok("已载入示例");
      })
      .catch(function (err) {
        window.RF_UI.toast.warn("载入示例失败（在 file:// 下浏览器可能拦截 fetch）。请改用本地静态服务，或先配置 LLM 后点击「解析」");
        console.warn(err);
      });
  }

  function onClearInput() {
    var ta = document.getElementById("rf-input-text");
    if (ta) ta.value = "";
  }

  function onClearReport() {
    window.RF_UI.confirm({
      title: "清空当前报告",
      body: "确认清空当前报告的所有内容？此操作将重置为空白报告，并删除报告中引用的所有图片资源（IndexedDB），且无法撤销。LLM 设置与历史快照将保留。",
      danger: true,
      confirmLabel: "确认清空"
    }).then(function (ok) {
      if (!ok) return;
      window.RF_State.set("report", window.RF_Schema.empty());
      try { window.RF_Storage.remove("draft", "current"); } catch (e) {}
      var ta = document.getElementById("rf-input-text");
      if (ta) ta.value = "";
      // Wipe IndexedDB images so the storage indicator actually drops to 0,
      // and broadcast assets:changed so the indicator refreshes immediately
      // instead of waiting for the next 8s poll tick.
      var done = function () {
        window.RF_Bus.emit("assets:changed");
        window.RF_UI.toast.ok("已清空");
      };
      if (window.RF_Assets && window.RF_Assets.clearAll) {
        window.RF_Assets.clearAll().then(done, function (err) {
          window.RF_Log.warn("clear: assets clearAll failed " + (err && err.message));
          done();
        });
      } else {
        done();
      }
    });
  }

  // ===== 表格粘贴入口 A：左侧自然语言框智能识别 =====
  function bindLeftPaneTablePaste() {
    var ta = document.getElementById("rf-input-text");
    if (!ta || !window.RF_TablePaste) return;
    ta.addEventListener("paste", function (e) {
      var dt = e.clipboardData;
      if (!dt) return;
      var html = dt.getData("text/html") || "";
      var text = dt.getData("text/plain") || "";
      var kind = window.RF_TablePaste.detectKind(html, text);
      if (!kind) return;       // 不像表格就让默认粘贴接管

      // 阻止默认粘贴
      e.preventDefault();
      var result = window.RF_TablePaste.fromStrings(html, text);
      if (!result.ok) {
        // 兜底：还是把 text 粘进去
        insertAtCaret(ta, text);
        return;
      }
      var spec = result.spec;
      window.RF_UI.confirm({
        title: "检测到表格",
        body: "剪贴板中是 " + spec.rows.length + " 行 × " + spec.columns.length +
              " 列的表格。要直接作为表格块插入到当前报告，还是按文本粘贴到输入框继续编辑？",
        confirmLabel: "插入为表格块",
        cancelLabel: "按文本粘贴"
      }).then(function (asTable) {
        if (asTable) {
          injectTableBlockAtEnd(spec);
          window.RF_UI.toast.ok("已作为表格块插入");
        } else {
          insertAtCaret(ta, text);
          ta.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    });
  }

  // ===== 表格粘贴入口 B：中栏「📋 粘贴表格」按钮 =====
  function onPasteTableButton() {
    if (!window.RF_TablePaste) {
      window.RF_UI.toast.warn("表格粘贴模块未加载");
      return;
    }
    // textarea 拿不到 text/html，用一个隐藏 contentEditable div 接 paste
    var sink = document.createElement("div");
    sink.contentEditable = "true";
    sink.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;";
    document.body.appendChild(sink);
    sink.focus();
    var done = false;
    sink.addEventListener("paste", function (e) {
      if (done) return;
      done = true;
      var result = window.RF_TablePaste.fromClipboardEvent(e);
      e.preventDefault();
      if (sink.parentNode) sink.parentNode.removeChild(sink);
      if (!result.ok) {
        window.RF_UI.toast.warn("剪贴板内没有可识别的表格");
        return;
      }
      injectTableBlockAtEnd(result.spec);
      window.RF_UI.toast.ok("已作为表格块插入（" + result.spec.rows.length + " 行 × " + result.spec.columns.length + " 列）");
    }, { once: true });
    window.RF_UI.toast.show("请按 Ctrl/Cmd+V 粘贴…");
    // 5 秒超时清理
    setTimeout(function () {
      if (done) return;
      if (sink.parentNode) sink.parentNode.removeChild(sink);
    }, 5000);
  }

  function injectTableBlockAtEnd(spec) {
    var rep = window.RF_State.get("report");
    if (!rep) rep = window.RF_Schema.empty();
    var rep2 = JSON.parse(JSON.stringify(rep));
    if (!rep2.sections || !rep2.sections.length) {
      rep2.sections = [{
        id: window.RF_Schema.uid("s-"),
        heading: "数据",
        level: 1,
        blocks: []
      }];
    }
    var lastSec = rep2.sections[rep2.sections.length - 1];
    lastSec.blocks.push({
      type: "table",
      title: "",
      caption: "",
      spec: spec
    });
    var v = window.RF_Schema.validate(rep2);
    window.RF_State.set("report", v.normalized);
  }

  function insertAtCaret(ta, text) {
    var start = ta.selectionStart, end = ta.selectionEnd;
    var v = ta.value;
    ta.value = v.slice(0, start) + text + v.slice(end);
    ta.selectionStart = ta.selectionEnd = start + text.length;
  }

  function toggleFullscreenPreview() {
    var iframe = document.getElementById("rf-preview-frame");
    if (!iframe) return;
    if (iframe.requestFullscreen) iframe.requestFullscreen();
  }

  function openHelp() {
    var body = document.createElement("div");
    body.style.fontSize = "14px"; body.style.lineHeight = "1.7";
    body.innerHTML = [
      "<h3 style='margin-top:0'>快速上手</h3>",
      "<ol style='padding-left:20px'>",
      "  <li>点击右上角「设置」配置大模型 API（默认预设 DeepSeek）。</li>",
      "  <li>左侧粘贴或输入自然语言文本，点击「解析」或按 <kbd>Ctrl/Cmd+Enter</kbd>。</li>",
      "  <li>在中栏修改字段，右栏会实时预览。</li>",
      "  <li>顶部下拉切换模板，内容不丢失。</li>",
      "  <li>点击右下「导出 ZIP」获得 <code>项目名.zip</code>，解压后双击 <code>report.html</code> 离线可看。</li>",
      "</ol>",
      "<h3>关于 CORS</h3>",
      "<p>受浏览器同源策略限制，并非所有大模型 API 都允许直接从浏览器调用。</p>",
      "<ul style='padding-left:20px'>",
      "  <li>✅ <b>通常可直连</b>：DeepSeek、Moonshot、智谱、本地 Ollama。</li>",
      "  <li>⚠ <b>需代理</b>：OpenAI、通义千问 DashScope、文心一言。</li>",
      "</ul>",
      "<p>若直连被 CORS 拦截，可在「设置」中填写 <b>CORS 代理 URL</b>。</p>",
      "<h3>关于隐私</h3>",
      "<p>API 密钥、草稿、图片均仅存储在你的浏览器（localStorage / IndexedDB），不会上传任何服务器。</p>",
      "<h3>快捷键</h3>",
      "<ul style='padding-left:20px'>",
      "  <li><kbd>Ctrl/Cmd + Enter</kbd>（焦点在输入框时） — 解析</li>",
      "  <li><kbd>Ctrl/Cmd + S</kbd> — 保存为快照</li>",
      "  <li><kbd>Esc</kbd> — 关闭模态框</li>",
      "</ul>"
    ].join("");
    window.RF_UI.modal.open({ title: "帮助", bodyEl: body, size: "lg" });
  }

  // ===== Splitters (resizable panes) =====
  function bindSplitters() {
    var workspace = document.querySelector(".rf-workspace");
    if (!workspace) return;
    var splitters = workspace.querySelectorAll(".rf-splitter");
    splitters.forEach(function (sp) {
      sp.addEventListener("pointerdown", function (e) {
        // 折叠态下相邻 splitter 已被加上 .is-disabled，pointer-events 已 none，
        // 这里再守一道，防止编程触发。
        if (sp.classList.contains("is-disabled")) return;
        e.preventDefault(); sp.setPointerCapture(e.pointerId);
        var startX = e.clientX;
        var startCols = window.getComputedStyle(workspace).gridTemplateColumns.split(" ").map(parseFloat);
        // We only resize the column immediately before this splitter and the one immediately after.
        var spIdx = Array.prototype.indexOf.call(workspace.children, sp);
        var leftIdx  = spIdx - 1;   // pane index in cols
        var rightIdx = spIdx + 1;
        function move(ev) {
          var dx = ev.clientX - startX;
          var newLeft  = Math.max(180, startCols[leftIdx]  + dx);
          var newRight = Math.max(180, startCols[rightIdx] - dx);
          var cols = startCols.slice();
          cols[leftIdx]  = newLeft;
          cols[rightIdx] = newRight;
          workspace.style.gridTemplateColumns = cols.map(function (n, i) {
            // splitter columns keep their original 6px width
            return (i === 1 || i === 3) ? "6px" : n + "px";
          }).join(" ");
        }
        function up(ev) {
          sp.releasePointerCapture(e.pointerId);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
    });
  }

  // ===== Pane collapse — input pane =====
  // 折叠时把整列宽度压到 COLLAPSED_W，左侧 splitter 失活；展开时恢复折叠前的列宽。
  // 状态写到 RF_Storage.config.ui.inputCollapsed，刷新页面保留。
  function initInputCollapse() {
    var COLLAPSED_W = 42;            // 与 .rf-pane__rail 视觉宽度匹配
    var workspace = document.querySelector(".rf-workspace");
    var pane      = document.querySelector(".rf-pane--input");
    var btnFold   = document.getElementById("rf-btn-collapse-input");
    var btnExpand = document.getElementById("rf-btn-expand-input");
    if (!workspace || !pane || !btnFold || !btnExpand) return;

    // 折叠前的列宽快照（数字数组，pane/splitter/pane/splitter/pane）。null 表示未保存过。
    var savedCols = null;

    function readUi() { return window.RF_Storage.get("config", "ui", {}) || {}; }
    function writeUi(patch) {
      try {
        var ui = readUi();
        Object.assign(ui, patch);
        window.RF_Storage.set("config", "ui", ui);
      } catch (e) { /* 配额满等情况静默忽略，UI 状态本就不是关键数据 */ }
    }

    function leftSplitter() {
      // .rf-pane--input 之后的第一个 .rf-splitter
      var n = pane.nextElementSibling;
      while (n && !n.classList.contains("rf-splitter")) n = n.nextElementSibling;
      return n;
    }

    function setCollapsed(collapsed) {
      var sp = leftSplitter();
      var styleCols = workspace.style.gridTemplateColumns;
      // 简易模式只有两栏，列宽完全交给 CSS（含 :has 折叠规则），
      // 不再写 inline，避免覆盖 CSS 的两栏布局。
      var isSuggest = document.body.getAttribute("data-work-mode") === "suggest";

      if (collapsed) {
        // 1) 记下当前列宽（仅在还没记或上次记的不是折叠态时记）。
        //    若 inline 样式为空，说明用户从没拖过，存 null，展开时让 CSS 默认接管。
        if (!pane.classList.contains("is-collapsed")) {
          savedCols = styleCols ? styleCols : null;
        }
        // 2) 切类
        pane.classList.add("is-collapsed");
        if (sp) sp.classList.add("is-disabled");
        btnFold.setAttribute("aria-expanded", "false");
        // 3) 改 grid 列宽：标准模式按 5 轨道分配；简易模式让 CSS 接管
        if (!isSuggest) applyCollapsedCols();
        else workspace.style.gridTemplateColumns = "";
      } else {
        pane.classList.remove("is-collapsed");
        if (sp) sp.classList.remove("is-disabled");
        btnFold.setAttribute("aria-expanded", "true");
        // 恢复
        if (!isSuggest && savedCols) {
          workspace.style.gridTemplateColumns = savedCols;
        } else {
          // 没快照 / 简易模式 → 清掉 inline，回到 CSS 默认 minmax 比例
          workspace.style.gridTemplateColumns = "";
        }
      }

      writeUi({ inputCollapsed: !!collapsed });
    }

    function applyCollapsedCols() {
      // 折叠态下当前 grid 实际像素，按比例把"输入栏腾出的空间"分给中/右两栏
      var cur = window.getComputedStyle(workspace).gridTemplateColumns.split(" ").map(parseFloat);
      // cur 形如 [w0, 6, w2, 6, w4]；如果 grid 已塌成 1 列（窄屏），CSS 会接管，无需写 inline
      if (cur.length < 5) { workspace.style.gridTemplateColumns = ""; return; }
      var freed = cur[0] - COLLAPSED_W;
      var midRight = cur[2] + cur[4];
      var newMid, newRight;
      if (midRight > 0) {
        newMid   = cur[2] + freed * (cur[2] / midRight);
        newRight = cur[4] + freed * (cur[4] / midRight);
      } else {
        newMid = cur[2]; newRight = cur[4];
      }
      workspace.style.gridTemplateColumns =
        COLLAPSED_W + "px 6px " + newMid + "px 6px " + newRight + "px";
    }

    btnFold.addEventListener("click", function () { setCollapsed(true); });
    btnExpand.addEventListener("click", function () { setCollapsed(false); });

    // 恢复持久化状态
    // 移动端（≤768px）默认应该上下平分能看到两块，不要继承桌面端的折叠记忆，
    // 否则用户在桌面折叠后切到手机会只看到一条 rail。
    var isMobile = window.matchMedia("(max-width: 768px)").matches;
    if (readUi().inputCollapsed && !isMobile) setCollapsed(true);
  }

  // ===== Work mode — 标准 / 简易 =====
  // 标准模式：三栏（自然语言 / 结构化编辑 / 预览）。
  // 简易模式：仅自然语言 + 预览两栏，隐藏结构化编辑栏。
  // 通过 body[data-work-mode] 让 CSS 接管显示，避免 JS 散写 inline 样式。
  // 状态持久化到 RF_Storage.config.ui.workMode；切换时清掉 inline grid 列宽
  // （否则三栏列宽会卡住两栏布局）。
  //
  // 移动端（≤768px）软强制：mql.matches 时忽略持久化设置、强制 suggest，
  // 不写回 storage —— 桌面端的偏好不被污染。监听 mql 变化让旋屏/调整窗口实时跟随。
  function initWorkMode() {
    var btnStd = document.getElementById("rf-mode-standard");
    var btnSug = document.getElementById("rf-mode-suggest");
    var workspace = document.querySelector(".rf-workspace");
    if (!btnStd || !btnSug || !workspace) return;

    var mql = window.matchMedia("(max-width: 768px)");

    function readUi() { return window.RF_Storage.get("config", "ui", {}) || {}; }
    function writeUi(patch) {
      try {
        var ui = readUi();
        Object.assign(ui, patch);
        window.RF_Storage.set("config", "ui", ui);
      } catch (e) { /* 静默：UI 状态不是关键数据 */ }
    }

    // 渲染 mode 到 DOM（更新 body[data-work-mode]、按钮 aria/active、清 inline 列宽、广播 resize）。
    // 不写 storage —— 是否持久化由调用方决定。
    function render(mode) {
      var m = (mode === "suggest") ? "suggest" : "standard";
      document.body.setAttribute("data-work-mode", m);
      btnStd.classList.toggle("is-active", m === "standard");
      btnSug.classList.toggle("is-active", m === "suggest");
      btnStd.setAttribute("aria-selected", m === "standard" ? "true" : "false");
      btnSug.setAttribute("aria-selected", m === "suggest" ? "true" : "false");
      // 切换模式时清空 inline grid 列宽：上一种模式留下的像素宽度
      // 在新模式的列数下没有意义，让 CSS 默认接管。
      workspace.style.gridTemplateColumns = "";
      // 通知滚动同步、预览等模块视口已变（防止滚动比例错位）
      window.dispatchEvent(new Event("resize"));
    }

    // 用户主动切换：写回 storage（仅桌面端会触发，移动端按钮已被 CSS 隐藏）。
    function apply(mode) {
      render(mode);
      writeUi({ workMode: (mode === "suggest") ? "suggest" : "standard" });
    }

    // 当前应展示的 mode：移动端强制 suggest；否则取持久化值，缺省 standard。
    function effectiveMode() {
      if (mql.matches) return "suggest";
      return readUi().workMode || "standard";
    }

    btnStd.addEventListener("click", function () {
      if (mql.matches) return;   // 移动端 mode-switch 已 display:none；保险拦一下
      apply("standard");
    });
    btnSug.addEventListener("click", function () {
      if (mql.matches) return;
      apply("suggest");
    });

    // 初次渲染
    render(effectiveMode());

    // 旋屏 / 调整窗口大小时重新决定 effectiveMode。
    // 旧 Safari 不支持 addEventListener("change", ...)，回退到 addListener。
    var onMqlChange = function () { render(effectiveMode()); };
    if (mql.addEventListener) mql.addEventListener("change", onMqlChange);
    else if (mql.addListener) mql.addListener(onMqlChange);
  }

  // ===== Mobile "more" menu =====
  // 顶栏右侧 ⋮ 按钮（仅 ≤768px 显示，CSS 控制可见性）。
  // 菜单项点击 → 代理点击对应桌面按钮（#rf-btn-history / settings / help），
  // 复用既有所有事件绑定，保持单一真值。
  function initMobileMore() {
    var trigger = document.getElementById("rf-btn-mobile-more");
    var menu    = document.getElementById("rf-mobile-menu");
    if (!trigger || !menu) return;

    var actionToBtnId = {
      history:  "rf-btn-history",
      settings: "rf-btn-settings",
      help:     "rf-btn-help"
    };

    function open() {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      document.addEventListener("mousedown", onDocDown, true);
      document.addEventListener("keydown", onKeyDown, true);
    }
    function close() {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    }
    function onDocDown(e) {
      if (menu.contains(e.target) || trigger.contains(e.target)) return;
      close();
    }
    function onKeyDown(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); trigger.focus(); }
    }

    trigger.addEventListener("click", function () {
      if (menu.hidden) open(); else close();
    });

    Array.prototype.forEach.call(menu.querySelectorAll(".rf-mobile-more__item"), function (item) {
      item.addEventListener("click", function () {
        var btn = document.getElementById(actionToBtnId[item.dataset.action]);
        close();
        // setTimeout 让菜单先关闭（避免 modal 打开时菜单还在前面挡）
        if (btn) setTimeout(function () { btn.click(); }, 0);
      });
    });
  }
})();

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
    window.RF_History.init();          // history button + Ctrl+S

    // ===== Template selector =====
    populateTemplateSelect();
    window.RF_Bus.on("template:registered", populateTemplateSelect);

    var sel = document.getElementById("rf-template-select");
    if (sel) {
      sel.addEventListener("change", function () { setTemplate(sel.value); });
    }

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
    bindButton("rf-btn-clear-input",    onClearInput);
    if (window.RF_InputRewrite) window.RF_InputRewrite.init();
    bindButton("rf-btn-export-zip",     function () { window.RF_ExportZip.exportZip(); });
    bindButton("rf-btn-export-pdf",     function () { window.RF_ExportPdf.exportPdf(); });
    bindButton("rf-btn-fullscreen-preview", toggleFullscreenPreview);
    bindButton("rf-btn-help",           openHelp);

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
  }

  function setTemplate(id) {
    if (!id || !window.ReportFlowTemplates.has(id)) return;
    window.RF_State.set("templateId", id);
    var ui = window.RF_Storage.get("config", "ui", {}) || {};
    ui.lastTemplateId = id;
    try { window.RF_Storage.set("config", "ui", ui); } catch (e) {}
    var sel = document.getElementById("rf-template-select");
    if (sel && sel.value !== id) sel.value = id;
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
    window.RF_UI.toast.show("正在调用 " + (c.model || "LLM") + "…");
    window.RF_Parser.parse(ta.value).then(function (out) {
      window.RF_State.set("report", out.report);
      try { window.RF_Storage.set("draft", "current", out.report); } catch (e) {}
      window.RF_UI.toast.ok("解析完成（" + out.report.sections.length + " 章节" +
        (out.errors.length ? "，" + out.errors.length + " 处自动修正" : "") + "）");
    }).catch(function (err) {
      window.RF_UI.toast.err(String(err && err.message || err));
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
})();

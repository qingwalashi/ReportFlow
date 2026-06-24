/**
 * preview.js — the iframe-isolated preview pane.
 *
 * Builds a host document inside the iframe, loads the active template's CSS,
 * and re-runs renderReport whenever:
 *   - state.report changes
 *   - state.templateId changes
 *
 * The iframe has its own ECharts instance (loaded via vendored libs).
 */
(function () {
  "use strict";

  var bus   = window.RF_Bus;
  var state = window.RF_State;
  var log   = window.RF_Log;

  // 智能高亮 <mark> 与 **加粗** 相邻时会破坏 CommonMark 的定界符配对（漏出裸 **）。
  // 跑 marked 前先把 <mark> 标签换成私有区哨兵字符，渲染后再还原。详见 renderer-host.js。
  var HL_OPEN_TOKEN  = String.fromCharCode(0xE000);
  var HL_CLOSE_TOKEN = String.fromCharCode(0xE001);
  var HL_KIND = { num: "0", text: "1" };
  var HL_KIND_REV = { "0": "num", "1": "text" };

  function markedWithHl(parse, text) {
    if (text.indexOf("<mark class=\"rf-hl") < 0) return parse(text);
    var tmp = text
      .replace(/<mark class="rf-hl rf-hl--(num|text)">/g, function (_, kind) {
        return HL_OPEN_TOKEN + (HL_KIND[kind] || "0");
      })
      .replace(/<\/mark>/g, HL_CLOSE_TOKEN);
    return parse(tmp)
      .replace(new RegExp(HL_OPEN_TOKEN + "([01])", "g"), function (_, k) {
        return '<mark class="rf-hl rf-hl--' + (HL_KIND_REV[k] || "num") + '">';
      })
      .replace(new RegExp(HL_CLOSE_TOKEN, "g"), "</mark>");
  }

  var IFRAME_ID = "rf-preview-frame";
  var rerenderTimer = null;
  var resizeTimer = null;
  // Debounce window: render N ms after the last change. While the user is
  // typing (consecutive state:report events), each new event resets the
  // timer, so we only run one full ECharts dispose+init cycle when they
  // pause. 150ms is below the human "felt instantaneous" threshold (~200ms)
  // for one-off changes (parse complete, template switch) but well above
  // typical inter-keystroke intervals (125-200ms), which is exactly what
  // we need.
  var IDLE_MS = 150;
  var attachedTemplateIds = Object.create(null); // id -> true (its CSS loaded)

  function $iframe() { return document.getElementById(IFRAME_ID); }

  function init() {
    var iframe = $iframe();
    if (!iframe) return;
    // Initial doc with vendored libs and a #root for templates.
    iframe.srcdoc = baseDoc();
    iframe.addEventListener("load", function onload() {
      iframe.removeEventListener("load", onload);
      log.info("preview: iframe ready");
      attachResizeHandling(iframe);
      scheduleRender();
    });

    bus.on("state:report",     scheduleRender);
    bus.on("state:templateId", function (e) { onTemplateChange(e); scheduleRender(); });
    bus.on("template:registered", scheduleRender);
    bus.on("preview:force",       scheduleRender);
  }

  function baseDoc() {
    // Uses sibling-relative paths so the iframe can load the same vendored
    // scripts. Works under both http(s) and file:// because the page itself
    // already loaded successfully from one of those origins.
    return [
      "<!doctype html>",
      "<html lang='zh-CN'><head><meta charset='utf-8'>",
      "<style id='rf-preview-base'>",
      "html,body{margin:0;padding:0;background:#fff;color:#1a1f2c;}",
      "body{font-family:'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;}",
      "#root{padding:32px 36px;max-width:920px;margin:0 auto;}",
      // Scrollbar — match the host shell's .rf-edit-scroll / textarea
      // scrollbars so the preview pane visually agrees with panes 01/02.
      // Kept here (not in the host CSS) because the iframe is a separate
      // document; webkit scrollbar selectors don't cross the boundary.
      "html::-webkit-scrollbar,body::-webkit-scrollbar{width:10px;height:10px;}",
      "html::-webkit-scrollbar-thumb,body::-webkit-scrollbar-thumb{background:#BFC7D6;border-radius:8px;border:2px solid transparent;background-clip:padding-box;}",
      "html::-webkit-scrollbar-thumb:hover,body::-webkit-scrollbar-thumb:hover{background:#A5AEC1;background-clip:padding-box;}",
      "html::-webkit-scrollbar-track,body::-webkit-scrollbar-track{background:transparent;}",
      // Block-highlight selected style — kept here so it works across all
      // templates without each template having to opt in. The preview side
      // .rf-block has no native border/background, so we add the full box;
      // negative margin offsets the padding/border so neighbouring text
      // doesn't reflow when a block is selected/deselected.
      ".rf-block--selected{border:1px solid #2d5cf6;background:#e8efff;border-radius:3px;padding:5px 7px;margin:-6px -8px;}",
      // 智能高亮（荧光笔）—— 正文 text 块里 <mark class="rf-hl rf-hl--num|text">。
      // 表格单元格的同色底色由 table-format.js 走内联 style 输出，无需在此声明。
      ".rf-hl{border-radius:2px;padding:0 2px;color:inherit;}",
      ".rf-hl--num{background:#fff1a8;}",
      ".rf-hl--text{background:#c8f2d4;}",
      "</style>",
      "<script src='libs/echarts.min.js'></scr" + "ipt>",
      "<script src='libs/marked.min.js'></scr" + "ipt>",
      "</head><body><div id='root'></div></body></html>"
    ].join("");
  }

  function onTemplateChange(/* e */) {
    // Nothing to clean up here yet; reattachCss will run on next render.
  }

  function scheduleRender() {
    if (rerenderTimer) clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(function () {
      rerenderTimer = null;
      // requestAnimationFrame so the actual paint coalesces with the
      // next frame instead of fighting with whatever the user is doing.
      requestAnimationFrame(doRender);
    }, IDLE_MS);
  }

  // ECharts canvases don't follow CSS container changes on their own: once
  // init() measures the container, the canvas size is frozen. When the preview
  // pane is resized (splitter drag, browser resize, work-mode switch) the
  // iframe's own window fires `resize`; we debounce and re-measure every live
  // chart instead of doing a full dispose+init re-render (which would also
  // reset scroll and flash). Instances are looked up by their container node
  // via getInstanceByDom, so we don't need to track them manually — and we
  // only ever touch containers still attached to the DOM.
  function resizeAllCharts() {
    var iframe = $iframe();
    if (!iframe || !iframe.contentDocument) return;
    var win = iframe.contentWindow;
    if (!win || !win.echarts) return;
    var bodies = iframe.contentDocument.querySelectorAll(".rf-chart-card__body");
    for (var i = 0; i < bodies.length; i++) {
      var inst = win.echarts.getInstanceByDom(bodies[i]);
      if (inst) {
        try { inst.resize(); } catch (e) { /* instance may be mid-dispose */ }
      }
    }
  }

  function attachResizeHandling(iframe) {
    var win = iframe.contentWindow;
    if (!win) return;
    win.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resizeAllCharts, 120);
    });
  }

  function doRender() {
    var iframe = $iframe();
    if (!iframe || !iframe.contentDocument) return;
    var doc = iframe.contentDocument;
    var win = iframe.contentWindow;
    var root = doc.getElementById("root");
    if (!root) return;

    var report = state.get("report");
    var tplId  = state.get("templateId");
    if (!report || !tplId) return;

    ensureTemplateCss(doc, tplId);

    // The template runs inside the iframe; chart-adapter.js lives on the
    // parent window, but ECharts must come from inside the iframe (so canvas
    // sizing and event loops match the iframe's window). We bridge by passing
    // a ctx with renderChart that uses the iframe's own echarts.
    var ctx = buildIframeCtx(win, doc, root);

    // Clear previous content
    root.innerHTML = "";
    root.className = "rf-tpl-" + tplId;

    var tpl = window.ReportFlowTemplates.get(tplId);
    if (!tpl) {
      root.innerHTML = '<div style="padding:24px;color:#999">未找到模板：' + tplId + '</div>';
      return;
    }
    try {
      tpl.renderReport(report, root, ctx);
    } catch (err) {
      console.error("[preview] template threw", err);
      root.innerHTML = '<pre style="padding:24px;color:#c33;white-space:pre-wrap">模板渲染失败：\n' +
        (err && err.stack || String(err)) + '</pre>';
      log.error("template: " + tplId + " threw " + (err && err.message));
    }

    bus.emit("preview:rendered", { templateId: tplId });
  }

  function buildIframeCtx(win, doc, /* root */ root) {
    return {
      mode: "preview",
      doc: doc,
      win: win,
      renderChart: function (spec, container, theme) {
        if (!win.echarts) return null;
        var inst = win.echarts.getInstanceByDom(container);
        if (inst) inst.dispose();
        inst = win.echarts.init(container, null, { renderer: "canvas" });
        inst.setOption(window.RF_Chart.buildOption(spec, theme || {}));
        return inst;
      },
      chartToSvg: function (spec, theme) {
        // Use parent window's helper — runs offscreen.
        return window.RF_Chart.toSvgString(spec, theme || {});
      },
      resolveAssetUrl: function (assetId) {
        return window.RF_ImageManager.previewUrl(assetId);
      },
      marked: function (text) {
        if (!text) return "";
        try {
          if (win.marked && win.marked.parse) {
            return markedWithHl(win.marked.parse, String(text));
          }
        } catch (e) {}
        return String(text).replace(/[&<>]/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c];
        }).replace(/\n/g, "<br>");
      },
      escapeHtml: function (s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
      },
      formatCell: function (value, format) {
        return window.RF_TableFormat
          ? window.RF_TableFormat.formatCell(value, format)
          : String(value == null ? "" : value);
      },
      footerText: function () {
        var cm = window.RF_ConfigManager;
        var cfg = cm && typeof cm.getReport === "function" ? cm.getReport() : null;
        return (cfg && cfg.showFooter && cfg.footerText) || "";
      }
    };
  }

  function ensureTemplateCss(doc, tplId) {
    if (attachedTemplateIds[tplId]) return;
    var manifest = (window.ReportFlowTemplates.get(tplId) || {}).manifest;
    if (!manifest) return;
    var href = "templates/" + tplId + "/" + (manifest.stylesheet || "style.css");
    var link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.rfTpl = tplId;
    // The chart containers get their size (e.g. height:320px) from this
    // stylesheet. On the FIRST switch to a template the link loads async, so
    // the initial doRender measures a 0-height container and echarts paints a
    // blank chart ("有的时候模板切换，图表没有绘制出来"). Re-render once the CSS
    // lands so charts are measured against the real, styled dimensions.
    // onerror also re-renders so a missing stylesheet doesn't wedge us.
    link.addEventListener("load", scheduleRender);
    link.addEventListener("error", scheduleRender);
    doc.head.appendChild(link);
    attachedTemplateIds[tplId] = true;
  }

  /** Snapshot the current preview iframe DOM for export. */
  function snapshotForExport() {
    var iframe = $iframe();
    if (!iframe || !iframe.contentDocument) return null;
    var doc = iframe.contentDocument;
    var root = doc.getElementById("root");
    return {
      doc: doc,
      rootHtml: root ? root.outerHTML : "",
      rootClass: root ? root.className : "",
      bodyClass: doc.body ? doc.body.className : "",
      head: doc.head ? doc.head.outerHTML : ""
    };
  }

  window.RF_Preview = {
    init: init,
    render: scheduleRender,
    snapshotForExport: snapshotForExport
  };
})();

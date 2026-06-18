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

  var IFRAME_ID = "rf-preview-frame";
  var rerenderTimer = null;
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
          if (win.marked && win.marked.parse) return win.marked.parse(String(text));
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

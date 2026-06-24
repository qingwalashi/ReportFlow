/**
 * renderer-host.js — invokes the active template's renderReport against a
 * container DOM (which lives inside the preview iframe).
 *
 * Provides templates with a `ctx` object so they don't need to import anything
 * directly:
 *
 *   ctx = {
 *     renderChart(spec, container, opts?) -> echarts instance,
 *     resolveAssetUrl(assetId)            -> Promise<string>,
 *     marked(text)                        -> html string (for markdown text blocks),
 *     mode: "preview" | "export",
 *   }
 */
(function () {
  "use strict";

  function buildCtx(opts) {
    opts = opts || {};
    return {
      mode: opts.mode || "preview",
      renderChart: function (spec, container, theme) {
        // Templates can pass theme overrides; chart-adapter handles defaults.
        return window.RF_Chart.renderChart(spec, container, theme || {});
      },
      chartToSvg: function (spec, theme) {
        return window.RF_Chart.toSvgString(spec, theme || {});
      },
      resolveAssetUrl: function (assetId) {
        return window.RF_ImageManager.previewUrl(assetId);
      },
      marked: function (text) {
        if (!text) return "";
        try {
          if (window.marked && window.marked.parse) {
            return window.marked.parse(String(text));
          }
        } catch (e) { console.warn("marked failed", e); }
        // Fallback: escape + simple newline -> <br>.
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

  /**
   * render(report, container, templateId, opts)
   *   - clears container
   *   - calls active template's renderReport
   *   - returns an array of {assetId, container} promises so the caller can
   *     resolve image src after-the-fact (templates are sync-friendly)
   */
  function render(report, container, templateId, opts) {
    if (!container) throw new Error("renderer-host: container required");
    var tpl = window.ReportFlowTemplates.get(templateId);
    if (!tpl) {
      container.innerHTML = '<div style="padding:24px;color:#999">未找到模板：' + templateId + '</div>';
      return;
    }

    // Unmount prior template
    if (container.__rfMounted && container.__rfMounted.onUnmount) {
      try { container.__rfMounted.onUnmount(container); } catch (e) {}
    }

    container.innerHTML = "";
    container.className = "rf-tpl-" + tpl.manifest.id; // scoping hook
    var ctx = buildCtx(opts);
    try {
      tpl.renderReport(report, container, ctx);
    } catch (err) {
      console.error("[template]", templateId, "renderReport threw", err);
      container.innerHTML = '<pre style="padding:24px;color:#c33;white-space:pre-wrap">模板渲染失败：\n' +
        ctx.escapeHtml(err && err.stack || String(err)) + '</pre>';
      if (window.RF_Log) window.RF_Log.error("template: " + templateId + " threw " + err.message);
      return;
    }

    if (tpl.onMount) {
      try { tpl.onMount(container); } catch (e) { console.error(e); }
    }
    container.__rfMounted = tpl;
    return tpl;
  }

  window.RF_Renderer = { render: render, buildCtx: buildCtx };
})();

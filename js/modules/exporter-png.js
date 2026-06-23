/**
 * exporter-png.js — render the preview as a single long PNG image.
 *
 * Strategy:
 *  - Build a hidden host on the parent document that mirrors the HTML export
 *    structure 1:1 (same body class, same #root class, same export-specific
 *    CSS overrides) so the rasterised image matches what `导出 HTML` would
 *    produce when opened in a browser — not the narrower PDF layout.
 *  - SVG-coerce charts and inline image assets as data: URLs (html2canvas
 *    can't fetch IDB blob URLs reliably).
 *  - Use html2pdf().from(el).toCanvas().get('canvas') to reuse its rendering
 *    pipeline (font load, scale, transform quirks). Then convert to PNG.
 */
(function () {
  "use strict";

  var state = window.RF_State;
  var log   = window.RF_Log;

  function exportPng() {
    if (typeof window.html2pdf !== "function") {
      window.RF_UI.toast.err("html2pdf 未加载，无法导出 PNG");
      return Promise.reject(new Error("html2pdf missing"));
    }
    var report = state.get("report");
    if (!report) { window.RF_UI.toast.warn("没有可导出的内容"); return Promise.reject(new Error("empty")); }

    var snap = window.RF_Preview.snapshotForExport();
    if (!snap) { window.RF_UI.toast.err("预览未就绪"); return Promise.reject(new Error("preview not ready")); }

    // Hidden host. Width 920px = HTML export's #root max-width — the host is
    // the "viewport" html2canvas measures against. We keep the body class
    // (template scope) on the host so body-scoped template selectors still
    // match, and we let #root's CSS handle padding/centering rather than
    // inline styles, so template-level rules can still adjust them.
    var host = document.createElement("div");
    host.id = "rf-png-host";
    host.className = snap.bodyClass || "";
    host.style.cssText = [
      "position:fixed", "left:-99999px", "top:0",
      "width:920px",
      "box-sizing:border-box",
      "background:#fff",
      "color:#1a1f2c",
      "font-family:'PingFang SC','Microsoft YaHei',sans-serif",
      "font-size:14px",
      "line-height:1.7"
    ].join(";");

    // Inline preview CSS, then layer the same export-specific overrides used
    // by the HTML exporter so the two outputs render identically.
    var styleEl = document.createElement("style");
    var rawCss = collectCssText(snap.doc);
    var overrideCss =
      "\n/* png-export overrides — kept in sync with exporter-html.js */\n" +
      "#rf-png-host{margin:0;padding:0;min-height:100%;}" +
      "#rf-png-host #root{box-sizing:border-box;max-width:920px;margin:0 auto;padding:32px 36px;}";
    styleEl.textContent = rawCss + overrideCss;
    host.appendChild(styleEl);

    var srcRoot = snap.doc.getElementById("root");
    var rootClone = srcRoot.cloneNode(true);

    // Replace ECharts canvases with SVG (disableAnimation so we capture the
    // settled frame, not an opening tween — same trick as PDF/ZIP exporters).
    var blockSpecs = [];
    (report.sections || []).forEach(function (s) {
      (s.blocks || []).forEach(function (b) { if (b && b.type === "chart") blockSpecs.push(b); });
    });
    var tplTheme = window.RF_Chart.themeOf(state.get("templateId"));
    var bodies = rootClone.querySelectorAll(".rf-chart-card__body");
    bodies.forEach(function (h, i) {
      var blk = blockSpecs[i]; if (!blk) return;
      try {
        var svg = window.RF_Chart.toSvgString(blk.spec,
          Object.assign({ width: 720, height: 320, disableAnimation: true }, tplTheme));
        h.innerHTML = svg.replace(/<svg /, '<svg style="width:100%;height:auto;" ');
      } catch (e) { log.warn("png: chart svg failed " + e.message); }
    });

    // Resolve image assets to data URLs (html2canvas can't fetch IDB blob URLs
    // reliably, same constraint that drives this in exporter-pdf.js).
    var imgs = rootClone.querySelectorAll('img[data-rf-asset]');
    var imgPromises = Array.prototype.map.call(imgs, function (img) {
      var id = img.getAttribute("data-rf-asset");
      return window.RF_Assets.get(id).then(function (rec) {
        if (!rec || !rec.blob) return;
        return blobToDataUrl(rec.blob).then(function (data) {
          img.src = data;
        });
      });
    });

    // Same DOM shape as exporter-html.js: #root with the cloned className.
    // No inline padding — let the override CSS rule above own it, so any
    // template-level fine-tuning still applies.
    var rootEl = document.createElement("div");
    rootEl.id = "root";
    rootEl.className = rootClone.className;
    rootEl.innerHTML = rootClone.innerHTML;
    host.appendChild(rootEl);

    document.body.appendChild(host);
    log.info("png: start");

    return Promise.all([
      window.RF_ExportCss.inlineCssUrls(rawCss).then(function (css) {
        styleEl.textContent = css + overrideCss;
      })
    ].concat(imgPromises)).then(function () {
      var opts = {
        // We don't actually emit a PDF — these options are forwarded by
        // html2pdf to its underlying html2canvas call.
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" }
      };
      // toCanvas() returns the Worker chain (not the canvas itself); .get('canvas')
      // resolves to the actual HTMLCanvasElement once rendering settles.
      return window.html2pdf().set(opts).from(rootEl).toCanvas().get("canvas");
    }).then(function (canvas) {
      if (!canvas || typeof canvas.toBlob !== "function") {
        throw new Error("html2canvas 未返回 canvas");
      }
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (!blob) reject(new Error("canvas.toBlob returned null"));
          else resolve(blob);
        }, "image/png");
      });
    }).then(function (blob) {
      triggerDownload(blob, safeFileName(report) + ".png");
      window.RF_UI.toast.ok("已导出 PNG");
      log.info("png: ok " + blob.size + "B");
    }).catch(function (err) {
      window.RF_UI.toast.err("PNG 导出失败：" + (err && err.message));
      log.error("png: " + (err && err.message));
      throw err;
    }).then(function () {
      if (host && host.parentNode) host.parentNode.removeChild(host);
    }, function () {
      if (host && host.parentNode) host.parentNode.removeChild(host);
    });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload  = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  function collectCssText(doc) {
    return window.RF_ExportCss.collectCssText(doc);
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function safeFileName(report) {
    var base = (report.meta && report.meta.title) || "reportflow-report";
    return String(base).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 60) || "report";
  }

  window.RF_ExportPng = { exportPng: exportPng };
})();

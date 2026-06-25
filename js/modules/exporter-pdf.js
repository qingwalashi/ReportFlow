/**
 * exporter-pdf.js — render the preview to PDF via html2pdf.js.
 *
 * Strategy:
 *  - Take the preview iframe document, clone its root, and run html2pdf
 *    against the clone (so we can SVG-coerce charts without disturbing live preview).
 *  - A4 portrait, scale 2 for crisp text, 12mm margin.
 *  - Page-break hint: any element with `.rf-pagebreak-before` triggers a new page.
 */
(function () {
  "use strict";

  var state = window.RF_State;
  var log   = window.RF_Log;

  function exportPdf() {
    if (typeof window.html2pdf !== "function") {
      window.RF_UI.toast.err("html2pdf 未加载，无法导出 PDF");
      return Promise.reject(new Error("html2pdf missing"));
    }
    var report = state.get("report");
    if (!report) { window.RF_UI.toast.warn("没有可导出的内容"); return Promise.reject(new Error("empty")); }

    var snap = window.RF_Preview.snapshotForExport();
    if (!snap) { window.RF_UI.toast.err("预览未就绪"); return Promise.reject(new Error("preview not ready")); }

    // Build a hidden export host on the parent page using inlined CSS so
    // html2canvas (which runs against the parent doc) can read it.
    var host = document.createElement("div");
    host.id = "rf-pdf-host";
    host.style.cssText = [
      "position:fixed", "left:-99999px", "top:0",
      "width:794px",         // ~ A4 width @ 96dpi
      "background:#fff",
      "color:#1a1f2c",
      "font-family:'PingFang SC','Microsoft YaHei',sans-serif"
    ].join(";");

    // Inline the CSS gathered from the preview iframe. The url() assets it
    // references (e.g. a template hero background) are inlined to data: URLs
    // below so html2canvas reliably captures them regardless of base path.
    var styleEl = document.createElement("style");
    var rawCss = collectCssText(snap.doc);
    styleEl.textContent = rawCss;
    host.appendChild(styleEl);

    // Clone the rendered root and replace charts with SVG.
    var srcRoot = snap.doc.getElementById("root");
    var rootClone = srcRoot.cloneNode(true);

    var blockSpecs = [];
    (report.sections || []).forEach(function (s) {
      (s.blocks || []).forEach(function (b) { if (b && b.type === "chart") blockSpecs.push(b); });
    });
    // Pull active template's theme so SVG palette/textColor match the preview.
    var tplTheme = window.RF_Chart.themeOf(state.get("templateId"));
    var bodies = rootClone.querySelectorAll(".rf-chart-card__body");
    bodies.forEach(function (h, i) {
      var blk = blockSpecs[i]; if (!blk) return;
      try {
        var svg = window.RF_Chart.toSvgString(blk.spec,
          Object.assign({ width: 720, height: 320, disableAnimation: true }, tplTheme));
        h.innerHTML = svg.replace(/<svg /, '<svg style="width:100%;height:auto;" ');
      } catch (e) { log.warn("pdf: chart svg failed " + e.message); }
    });

    // Resolve image assets to data URLs (html2canvas can't fetch IDB blob URLs reliably).
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

    // Wrap clone in #root with template scoping class preserved.
    var rootEl = document.createElement("div");
    rootEl.id = "root";
    rootEl.className = rootClone.className;
    rootEl.innerHTML = rootClone.innerHTML;
    rootEl.style.cssText = "padding:32px 28px;";
    host.appendChild(rootEl);

    document.body.appendChild(host);
    log.info("pdf: start");

    return Promise.all([
      window.RF_ExportCss.inlineCssUrls(rawCss).then(function (css) {
        var prep = window.RF_ExportCss.prepareRasterCss(css);
        styleEl.textContent = prep.css;
        window.RF_ExportCss.applyHeroPhotoInline(rootEl, prep.headerImageUrl);
      })
    ].concat(imgPromises)).then(function () {
      var opts = {
        margin: [12, 12, 14, 12],
        filename: safeFileName(report) + ".pdf",
        image: { type: "jpeg", quality: 0.92 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css", "legacy"], before: [".rf-pagebreak-before"], avoid: [".rf-section", ".rf-chart-card", ".rf-img"] }
      };
      return window.html2pdf().set(opts).from(rootEl).save();
    }).then(function () {
      window.RF_UI.toast.ok("已导出 PDF");
      log.info("pdf: ok");
    }).catch(function (err) {
      window.RF_UI.toast.err("PDF 导出失败：" + (err && err.message));
      log.error("pdf: " + (err && err.message));
      throw err;
    }).then(function () {
      // Cleanup whether success or failure.
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

  function safeFileName(report) {
    var base = (report.meta && report.meta.title) || "reportflow-report";
    return String(base).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 60) || "report";
  }

  window.RF_ExportPdf = { exportPdf: exportPdf };
})();

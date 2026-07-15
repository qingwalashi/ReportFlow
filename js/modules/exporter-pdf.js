/**
 * exporter-pdf.js — export the preview to PDF via the browser's native print
 * pipeline ("Save as PDF"), NOT via html2canvas rasterisation.
 *
 * Rationale:
 *   The previous implementation ran html2pdf.js → html2canvas → jsPDF, which
 *   captures the page as a bitmap and pastes it into a PDF. Text became a
 *   raster, files were large, zoom blurred, and page breaks were coarse. This
 *   exporter instead builds a self-contained HTML document (same shape as
 *   exporter-html.js) in a hidden iframe, layers print-only CSS on top
 *   (@page A4 + margins, page-break hints, hide interactive chrome), and calls
 *   iframe.contentWindow.print(). The user picks "Save as PDF" in the browser
 *   dialog; the result is a vector PDF with selectable text and SVG charts.
 *
 * Page-break hint (unchanged from before): any element with
 *   .rf-pagebreak-before  triggers a page break, and .rf-section /
 *   .rf-chart-card / .rf-img are asked to avoid being split across pages.
 */
(function () {
  "use strict";

  var state = window.RF_State;
  var log   = window.RF_Log;

  function exportPdf() {
    var report = state.get("report");
    if (!report) { window.RF_UI.toast.warn("没有可导出的内容"); return Promise.reject(new Error("empty")); }

    var snap = window.RF_Preview.snapshotForExport();
    if (!snap) { window.RF_UI.toast.err("预览未就绪"); return Promise.reject(new Error("preview not ready")); }

    log.info("pdf: start (print pipeline)");

    return buildPrintableHtml(snap, report).then(function (html) {
      return openAndPrint(html, safeFileName(report));
    }).then(function () {
      window.RF_UI.toast.ok("已打开打印对话框，请选择“另存为 PDF”");
      log.info("pdf: print dialog opened");
    }).catch(function (err) {
      window.RF_UI.toast.err("PDF 导出失败：" + (err && err.message));
      log.error("pdf: " + (err && err.message));
      throw err;
    });
  }

  /**
   * Build a self-contained HTML document string that renders identically to the
   * preview, with print-only CSS layered on top. Mirrors exporter-html.js's
   * assembly so the two exports stay visually consistent.
   */
  function buildPrintableHtml(snap, report) {
    var srcDoc = snap.doc;
    var srcRoot = srcDoc.getElementById("root");
    if (!srcRoot) return Promise.reject(new Error("preview root missing"));

    var rootClone = srcRoot.cloneNode(true);

    // Replace canvas charts with inline SVG (vector, disableAnimation so we
    // capture the settled frame — same trick as HTML/PNG/ZIP exporters).
    var tplTheme = window.RF_Chart.themeOf(state.get("templateId"));
    var blockSpecs = [];
    (report.sections || []).forEach(function (s) {
      (s.blocks || []).forEach(function (b) {
        if (b && b.type === "chart") blockSpecs.push(b);
      });
    });
    var bodies = rootClone.querySelectorAll(".rf-chart-card__body, [data-rf-chart]");
    bodies.forEach(function (host, i) {
      var blk = blockSpecs[i]; if (!blk) return;
      try {
        var svg = window.RF_Chart.toSvgString(blk.spec,
          Object.assign({ width: 720, height: 320, disableAnimation: true }, tplTheme));
        host.innerHTML = svg.replace(/<svg /, '<svg style="width:100%;height:auto;" ');
      } catch (e) {
        log.warn("pdf: chart svg failed " + e.message);
      }
    });

    // Resolve image assets (assetId → IDB blob) to data: URLs so the iframe
    // document is fully self-contained (no dependency on parent's blob URLs).
    return collectAssetsAsDataUrls(report).then(function (assetMap) {
      var imgs = rootClone.querySelectorAll('img[data-rf-asset]');
      imgs.forEach(function (img) {
        var id = img.getAttribute("data-rf-asset");
        var dataUrl = assetMap[id];
        if (dataUrl) img.setAttribute("src", dataUrl);
        else img.setAttribute("alt", (img.alt || "") + "（资源缺失）");
        img.removeAttribute("data-rf-asset");
      });

      var cssText = collectCssText(srcDoc);
      return window.RF_ExportCss.inlineCssUrls(cssText).then(function (inlinedCss) {
        var meta = report.meta || {};
        var title = (meta.title || "ReportFlow 报告");
        return [
          "<!doctype html>",
          "<html lang='zh-CN'><head><meta charset='utf-8'>",
          "<meta name='viewport' content='width=device-width,initial-scale=1'>",
          "<title>" + escapeHtml(title) + "</title>",
          "<style>",
          // Base fallback (placed BEFORE inlined template CSS so templates can override).
          // Light themes fall through to these defaults; dark themes (cyber-security,
          // tech-minimal, supercomputing 等) will provide their own body background/color
          // via their template stylesheet — previously the hardcoded `background:#fff`
          // was placed after inlinedCss and always won, making PDF exports of dark themes
          // lose their brand colors and turn unreadable (light text on white).
          "html,body{margin:0;padding:0;background:#fff;color:#1a1f2c;",
          "font-family:'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;}",
          "#root{box-sizing:border-box;max-width:920px;margin:0 auto;padding:32px 36px;}",
          inlinedCss,
          // Print-specific rules. @page controls PDF paper + margin; the rest
          // hints the layout engine where it may or may not break pages.
          buildPrintCss(),
          "</style>",
          "</head><body class='" + escapeHtml(snap.bodyClass || "") + "'>",
          "<div id='root' class='" + escapeHtml(rootClone.className || "") + "'>",
          rootClone.innerHTML,
          "</div>",
          "</body></html>"
        ].join("\n");
      });
    });
  }

  /** Print CSS: A4 portrait, 12mm margins, page-break hints, hide chrome. */
  function buildPrintCss() {
    return [
      "@page{size:A4 portrait;margin:12mm;}",
      // Let the whole document paint on printed pages.
      //
      // Previously html,body was forced to background:#fff !important, which
      // blew away dark themes' gradients and left light-on-white text unreadable.
      // We now let template CSS drive html/body colors, and only set:
      //   - print-color-adjust: exact (browsers otherwise strip background colors
      //     for ink saving — we need gradients/hero swatches/chart bars to render)
      //   - NO forced background/color — the theme owns it.
      "@media print{",
        "html,body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}",
        "*{-webkit-print-color-adjust:exact;print-color-adjust:exact;}",
        // Widen #root to the printable area — we're already inside a page box
        // whose padding is @page's margin, so extra padding would waste space.
        "#root{max-width:none!important;margin:0!important;padding:0!important;}",
        // Explicit page-break hooks — same names as the previous html2pdf setup
        // so any content authored against them keeps working.
        ".rf-pagebreak-before{break-before:page;page-break-before:always;}",
        ".rf-pagebreak-after{break-after:page;page-break-after:always;}",
        // Avoid splitting cohesive units across pages when possible.
        ".rf-section,.rf-chart-card,.rf-img,figure,table{break-inside:avoid;page-break-inside:avoid;}",
        "h1,h2,h3,h4{break-after:avoid;page-break-after:avoid;}",
        // Hide anything that only makes sense on screen.
        ".rf-export-fs-btn,.rf-dl-btn,.rf-export-fs,button,[data-rf-hide-print]{display:none!important;}",
        // Anchors should print as text, not the underlined blue web style.
        "a{color:inherit;text-decoration:none;}",
      "}"
    ].join("\n");
  }

  function collectAssetsAsDataUrls(report) {
    var ids = [];
    (report.sections || []).forEach(function (s) {
      (s.blocks || []).forEach(function (b) {
        if (b && b.type === "image" && b.assetId) ids.push(b.assetId);
      });
    });
    if (!ids.length) return Promise.resolve({});
    return Promise.all(ids.map(function (id) {
      return window.RF_Assets.get(id).then(function (rec) {
        if (!rec || !rec.blob) return null;
        return blobToDataUrl(rec.blob).then(function (data) {
          return { assetId: id, dataUrl: data };
        });
      });
    })).then(function (records) {
      var map = {};
      records.forEach(function (r) { if (r) map[r.assetId] = r.dataUrl; });
      return map;
    });
  }

  /**
   * Drop the HTML into a hidden iframe and invoke print(). We keep the iframe
   * around long enough for the print dialog to read from it, then remove it.
   */
  function openAndPrint(html, filenameHint) {
    return new Promise(function (resolve, reject) {
      var iframe = document.createElement("iframe");
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.cssText = [
        "position:fixed", "right:0", "bottom:0",
        "width:0", "height:0", "border:0",
        "opacity:0", "pointer-events:none"
      ].join(";");
      // Suggested filename (browsers use the document title as the default
      // "Save as PDF" name; setting it here beats the generic "about:blank").
      document.body.appendChild(iframe);

      var win;
      try {
        win = iframe.contentWindow;
        var doc = iframe.contentDocument || (win && win.document);
        if (!doc) throw new Error("iframe document unavailable");
        doc.open();
        doc.write(html);
        doc.close();
        // Some browsers reset window.name to something ugly; the <title> in
        // the HTML we wrote already suggests a nice default filename.
        if (filenameHint) try { win.name = filenameHint; } catch (e) {}
      } catch (e) {
        cleanup();
        reject(e);
        return;
      }

      var done = false;
      function fire() {
        if (done) return;
        done = true;
        // Give the iframe a beat to lay out fonts/images before printing —
        // otherwise Chromium sometimes prints before webfonts settle.
        setTimeout(function () {
          try {
            win.focus();
            win.print();
            resolve();
          } catch (e) {
            reject(e);
          } finally {
            // Keep the iframe for a while so the print preview can read it,
            // then remove. 60s is generous; users usually confirm within that.
            setTimeout(cleanup, 60000);
          }
        }, 250);
      }

      function cleanup() {
        if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }

      // Prefer the load event; fall back to a timeout in case document.write
      // triggered readystatechange before we could attach.
      if (iframe.contentDocument && iframe.contentDocument.readyState === "complete") {
        fire();
      } else {
        iframe.addEventListener("load", fire);
        setTimeout(fire, 1500);
      }
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

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  window.RF_ExportPdf = { exportPdf: exportPdf };
})();

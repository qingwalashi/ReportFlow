/**
 * exporter-html.js — export the rendered preview as a single self-contained .html file.
 *
 * Same pipeline as exporter-zip.js (chart → SVG, CSS gathered from the iframe,
 * report meta wired into <title>) — the only difference is that images are
 * inlined as data: URLs instead of being written to a sibling assets/ folder,
 * so the output is a single file you can email or double-click anywhere.
 *
 * Helpers (collectCssText, blobToDataUrl, safeFileName, escapeHtml,
 * triggerDownload) duplicate exporter-zip.js intentionally — see plan: we'll
 * extract a common module after all four exporters stabilise.
 */
(function () {
  "use strict";

  var state = window.RF_State;
  var log   = window.RF_Log;

  function exportHtml() {
    var report = state.get("report");
    if (!report) { window.RF_UI.toast.warn("没有可导出的内容"); return Promise.reject(new Error("empty")); }

    var snap = window.RF_Preview.snapshotForExport();
    if (!snap) {
      window.RF_UI.toast.err("预览未就绪");
      return Promise.reject(new Error("preview not ready"));
    }
    log.info("export: html start");

    return collectAssetsAsDataUrls(report)
      .then(function (assetMap) {
        var html = buildExportHtml(snap, assetMap, report);
        var blob = new Blob([html], { type: "text/html;charset=utf-8" });
        triggerDownload(blob, safeFileName(report) + ".html");
        window.RF_UI.toast.ok("已导出 HTML");
        log.info("export: html ok " + blob.size + "B");
      })
      .catch(function (err) {
        window.RF_UI.toast.err("HTML 导出失败：" + (err && err.message));
        log.error("export: html " + (err && err.message));
        throw err;
      });
  }

  /** Resolve every image assetId in the report to a data: URL. */
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

  /** Build the self-contained report.html string. */
  function buildExportHtml(snap, assetMap, report) {
    var srcDoc = snap.doc;
    var srcRoot = srcDoc.getElementById("root");
    if (!srcRoot) throw new Error("preview root missing");
    var rootClone = srcRoot.cloneNode(true);

    // Replace canvas charts with inline SVG (same as ZIP — disableAnimation
    // so the SVG captures the final frame, not a zero-arc opening tween).
    var tplTheme = window.RF_Chart.themeOf(state.get("templateId"));
    var bodies = rootClone.querySelectorAll(".rf-chart-card__body, [data-rf-chart]");
    var blockSpecs = [];
    (report.sections || []).forEach(function (s) {
      (s.blocks || []).forEach(function (b) {
        if (b && b.type === "chart") blockSpecs.push(b);
      });
    });
    bodies.forEach(function (host, i) {
      var blk = blockSpecs[i];
      if (!blk) return;
      try {
        var svg = window.RF_Chart.toSvgString(blk.spec,
          Object.assign({ width: 720, height: 320, disableAnimation: true }, tplTheme));
        host.innerHTML = "";
        var wrap = srcDoc.createElement("div");
        wrap.style.cssText = "width:100%;max-width:100%;";
        wrap.innerHTML = svg.replace(/<svg /, '<svg style="width:100%;height:auto;" ');
        host.appendChild(wrap);
      } catch (e) {
        log.warn("export: chart svg failed " + e.message);
      }
    });

    // Rewrite <img data-rf-asset="..."> with a data: URL.
    var imgs = rootClone.querySelectorAll('img[data-rf-asset]');
    imgs.forEach(function (img) {
      var id = img.getAttribute("data-rf-asset");
      var dataUrl = assetMap[id];
      if (dataUrl) {
        img.setAttribute("src", dataUrl);
      } else {
        img.setAttribute("alt", (img.alt || "") + "（资源缺失）");
      }
      img.removeAttribute("data-rf-asset");
    });

    var cssText = collectCssText(srcDoc);

    var meta = report.meta || {};
    var title = (meta.title || "ReportFlow 报告");
    var html = [
      "<!doctype html>",
      "<html lang='zh-CN'><head><meta charset='utf-8'>",
      "<meta name='viewport' content='width=device-width,initial-scale=1'>",
      "<title>" + escapeHtml(title) + "</title>",
      "<style>",
      cssText,
      // Export-specific overrides — ordered last so they win over template CSS.
      "html,body{margin:0;padding:0;min-height:100%;background:#fff;color:#1a1f2c;",
      "font-family:'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;}",
      "#root{box-sizing:border-box;max-width:920px;margin:0 auto;padding:32px 36px;}",
      "</style>",
      "</head><body class='" + escapeHtml(snap.bodyClass || "") + "'>",
      "<div id='root' class='" + escapeHtml(rootClone.className || "") + "'>",
      rootClone.innerHTML,
      "</div>",
      "</body></html>"
    ].join("\n");
    return html;
  }

  function collectCssText(doc) {
    var out = [];
    Array.prototype.forEach.call(doc.querySelectorAll("style"), function (s) {
      if (s.textContent) out.push(s.textContent);
    });
    Array.prototype.forEach.call(doc.styleSheets, function (sheet) {
      try {
        var rules = sheet.cssRules;
        if (!rules) return;
        var buf = [];
        for (var i = 0; i < rules.length; i++) buf.push(rules[i].cssText);
        out.push(buf.join("\n"));
      } catch (e) {
        // Cross-origin stylesheet — skip silently.
      }
    });
    return out.join("\n\n");
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload  = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
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

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  window.RF_ExportHtml = { exportHtml: exportHtml };
})();

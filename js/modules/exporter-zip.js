/**
 * exporter-zip.js — package the rendered report into a folder-style zip.
 *
 * The output zip looks like:
 *   <project>/
 *     report.html          (self-contained, references assets/ relatively)
 *     assets/
 *       img-xxx.png
 *       img-yyy.jpg
 *
 * Charts are converted to inline SVG (no JS needed in the exported HTML).
 * Images stored in IndexedDB are extracted to assets/ and `<img src>` is
 * rewritten to `assets/<filename>`. External-URL images (legacy) are kept
 * as-is and a warning is logged.
 */
(function () {
  "use strict";

  var state  = window.RF_State;
  var log    = window.RF_Log;

  function exportZip() {
    if (!window.JSZip) {
      window.RF_UI.toast.err("JSZip 未加载，无法导出 ZIP");
      return Promise.reject(new Error("JSZip missing"));
    }
    var report = state.get("report");
    if (!report) { window.RF_UI.toast.warn("没有可导出的内容"); return Promise.reject(new Error("empty")); }

    var snap = window.RF_Preview.snapshotForExport();
    if (!snap) {
      window.RF_UI.toast.err("预览未就绪");
      return Promise.reject(new Error("preview not ready"));
    }
    log.info("export: zip start");

    return Promise.resolve()
      .then(function () { return collectAssets(report); })
      .then(function (assetMap) {
        return buildExportHtml(snap, assetMap, report).then(function (html) {
          return packageZip(html, assetMap, report);
        });
      })
      .then(function (blob) {
        triggerDownload(blob, safeFileName(report) + ".zip");
        window.RF_UI.toast.ok("已导出 ZIP");
        log.info("export: zip ok " + blob.size + "B");
      })
      .catch(function (err) {
        window.RF_UI.toast.err("导出失败：" + (err && err.message));
        log.error("export: " + (err && err.message));
        throw err;
      });
  }

  /** Walks the report and resolves all image assetIds to {assetId, blob, filename}. */
  function collectAssets(report) {
    var ids = [];
    (report.sections || []).forEach(function (s) {
      (s.blocks || []).forEach(function (b) {
        if (b && b.type === "image" && b.assetId) ids.push(b.assetId);
      });
    });
    if (!ids.length) return Promise.resolve({});

    return Promise.all(ids.map(function (id) {
      return window.RF_Assets.get(id).then(function (rec) {
        if (!rec) return null;
        var ext = window.RF_ImageManager.extOf(rec);
        return { assetId: id, blob: rec.blob, filename: id + "." + ext };
      });
    })).then(function (records) {
      var map = {};
      records.forEach(function (r) { if (r) map[r.assetId] = r; });
      return map;
    });
  }

  /** Build the self-contained report.html string. Returns Promise<string>. */
  function buildExportHtml(snap, assetMap, report) {
    // 1) Get a clone of the rendered root so we can mutate without disturbing preview.
    var srcDoc = snap.doc;
    var srcRoot = srcDoc.getElementById("root");
    if (!srcRoot) throw new Error("preview root missing");
    var rootClone = srcRoot.cloneNode(true);

    // 2) Replace canvas charts with inline SVG.
    //    During preview, charts are rendered into <div class="rf-chart-card__body"> via ECharts canvas.
    //    For export we use chart-adapter.toSvgString() with the original spec to get crisp SVG.
    //    Pull the active template's theme so palette/textColor match the preview — without this
    //    the SVG would fall back to chart-adapter's built-in default palette.
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
        // disableAnimation: capture the final, fully-laid-out frame.
        // Without it, echarts emits the SVG mid-animation (at frame 0
        // pie slices have zero arc, labels have opacity 0, axis ticks
        // haven't moved into place) — so the export looks blank even
        // though all the structure, ids and colors are correct.
        var svg = window.RF_Chart.toSvgString(blk.spec,
          Object.assign({ width: 720, height: 320, disableAnimation: true }, tplTheme));
        host.innerHTML = "";
        // Responsive SVG wrapper so the chart scales to the container on mobile.
        var wrap = srcDoc.createElement("div");
        wrap.className = "rf-chart-resp";
        wrap.innerHTML = svg.replace(/<svg /, '<svg style="width:100%;height:auto;" ');
        host.appendChild(wrap);
        // Fullscreen preview button
        if (window.RF_Chart.addFullscreenButton) {
          window.RF_Chart.addFullscreenButton(host, srcDoc);
        }
      } catch (e) {
        log.warn("export: chart svg failed " + e.message);
      }
    });

    // 3) Rewrite <img data-rf-asset="..."> to relative paths.
    var imgs = rootClone.querySelectorAll('img[data-rf-asset]');
    imgs.forEach(function (img) {
      var id = img.getAttribute("data-rf-asset");
      var rec = assetMap[id];
      if (rec) {
        img.setAttribute("src", "assets/" + rec.filename);
      } else {
        // Mark missing so user notices.
        img.setAttribute("alt", (img.alt || "") + "（资源缺失）");
      }
      img.removeAttribute("data-rf-asset");
    });

    // 4) Inline CSS — concatenate every <style> and reachable stylesheet from
    //    the preview iframe (which has base/template CSS already loaded).
    var cssText = collectCssText(srcDoc);

    var meta = report.meta || {};
    var title = (meta.title || "ReportFlow 报告");
    // Inline url() assets referenced from CSS (e.g. a template hero background)
    // so report.html renders the background even without the dev server.
    return window.RF_ExportCss.inlineCssUrls(cssText).then(function (inlinedCss) {
      var html = [
        "<!doctype html>",
        "<html lang='zh-CN'><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width,initial-scale=1'>",
        "<title>" + escapeHtml(title) + "</title>",
        "<style>",
        // 1) Inline ALL CSS gathered from the preview iframe first (base + template).
        inlinedCss,
        // 2) Then our export-specific overrides — ordered last so they win
        //    against any conflicting rules from the collected sheets.
        //    Body fills the viewport (so any template background or page color
        //    extends edge-to-edge), and a centered, max-width #root holds the
        //    actual report content.
        "html,body{margin:0;padding:0;min-height:100%;background:#fff;color:#1a1f2c;",
        "font-family:'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;}",
        "#root{box-sizing:border-box;max-width:920px;margin:0 auto;padding:32px 36px;}",
        // --- chart export: responsive SVG + fullscreen overlay ---
        window.RF_Chart.exportFullscreenCss || "",
        "</style>",
        "</head><body class='" + escapeHtml(snap.bodyClass || "") + "'>",
        "<div id='root' class='" + escapeHtml(rootClone.className || "") + "'>",
        rootClone.innerHTML,
        "</div>",
        // --- chart fullscreen runtime (delegated, no deps) ---
        "<script>",
        window.RF_Chart.exportFullscreenScript || "",
        "</scr" + "ipt>",
        "</body></html>"
      ].join("\n");
      return html;
    });
  }

  function collectCssText(doc) {
    return window.RF_ExportCss.collectCssText(doc);
  }

  function packageZip(html, assetMap, report) {
    var zip = new window.JSZip();
    var folder = zip.folder(safeFileName(report));
    folder.file("report.html", html);
    folder.file("README.txt",
      "ReportFlow 导出包\n" +
      "------------------\n" +
      "解压后双击 report.html 即可离线查看本报告。\n" +
      "如果在服务器上发布，请确保保留 assets/ 目录与 report.html 同级。\n"
    );
    var assetsFolder = folder.folder("assets");
    Object.keys(assetMap).forEach(function (id) {
      var rec = assetMap[id];
      if (rec && rec.blob) assetsFolder.file(rec.filename, rec.blob);
    });
    return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
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

  window.RF_ExportZip = { exportZip: exportZip };
})();

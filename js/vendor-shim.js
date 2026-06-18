/**
 * vendor-shim.js — verify vendored libraries are loaded before the app boots.
 *
 * Runs as a deferred classic script BEFORE any js/core/* script. If a library
 * is missing, surfaces a visible banner instead of letting the app silently
 * crash later with "echarts is not defined".
 */
(function () {
  "use strict";

  var REQUIRED = [
    { global: "echarts",    label: "ECharts",    file: "libs/echarts.min.js" },
    { global: "JSZip",      label: "JSZip",      file: "libs/jszip.min.js" },
    { global: "html2pdf",   label: "html2pdf.js",file: "libs/html2pdf.bundle.min.js" },
    { global: "marked",     label: "marked",     file: "libs/marked.min.js" }
  ];

  var missing = REQUIRED.filter(function (r) { return typeof window[r.global] === "undefined"; });

  // Build a readiness object the rest of the app can consult.
  window.RF_VENDOR = {
    ok: missing.length === 0,
    missing: missing,
    versions: {
      // Best-effort; libs may not advertise versions identically.
      echarts:   (window.echarts && window.echarts.version) || null,
      jszip:     (window.JSZip && window.JSZip.version) || null,
      marked:    (window.marked && window.marked.parse ? "12.x" : null),
      html2pdf:  (typeof window.html2pdf === "function" ? "0.10.x" : null)
    }
  };

  if (missing.length === 0) return;

  // Render a top banner so the user knows what's wrong on file:// where
  // network errors are silent.
  function renderBanner() {
    var banner = document.createElement("div");
    banner.setAttribute("role", "alert");
    banner.style.cssText = [
      "position:fixed", "left:0", "right:0", "top:0", "z-index:9999",
      "background:#6b1d1d", "color:#fff",
      "padding:10px 16px", "font:13px/1.5 -apple-system,Segoe UI,sans-serif",
      "box-shadow:0 4px 16px rgba(0,0,0,.2)"
    ].join(";");
    var list = missing.map(function (m) { return m.label + " (" + m.file + ")"; }).join("、");
    banner.innerHTML =
      "<strong>启动失败：</strong>缺少必要依赖 — " + list +
      "。请确认 <code>libs/</code> 下文件存在；如使用 file:// 直接打开，浏览器可能拦截了脚本，请改用本地静态服务（如 <code>python3 -m http.server</code>）。";
    document.body.appendChild(banner);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderBanner);
  } else {
    renderBanner();
  }

  console.error("[ReportFlow] missing vendor libs:", missing);
})();

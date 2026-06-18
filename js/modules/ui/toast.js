/**
 * ui/toast.js — non-blocking toast notifications.
 *
 *   RF_UI.toast.show("已保存");
 *   RF_UI.toast.ok("解析完成");
 *   RF_UI.toast.warn("存储接近上限");
 *   RF_UI.toast.err("LLM 请求失败：网络错误");
 */
(function () {
  "use strict";

  var root = null;
  function ensureRoot() {
    if (root) return root;
    root = document.getElementById("rf-toast-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "rf-toast-root";
      root.className = "rf-toast-root";
      document.body.appendChild(root);
    }
    return root;
  }

  function show(msg, opts) {
    ensureRoot();
    opts = opts || {};
    var el = document.createElement("div");
    el.className = "rf-toast" + (opts.kind ? " rf-toast--" + opts.kind : "");
    el.textContent = msg;
    root.appendChild(el);
    var timeout = opts.duration || (opts.kind === "err" ? 4500 : 2400);
    setTimeout(function () {
      el.style.transition = "opacity .2s ease, transform .2s ease";
      el.style.opacity = "0";
      el.style.transform = "translateY(4px)";
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, timeout);
  }

  window.RF_UI = window.RF_UI || {};
  window.RF_UI.toast = {
    show: show,
    ok:   function (m) { show(m, { kind: "ok" }); },
    warn: function (m) { show(m, { kind: "warn" }); },
    err:  function (m) { show(m, { kind: "err", duration: 5500 }); }
  };
})();

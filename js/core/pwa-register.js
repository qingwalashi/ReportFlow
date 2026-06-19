/**
 * pwa-register.js — register Service Worker, surface install + update events.
 *
 * 行为：
 *  - 仅在 https / localhost 下注册（浏览器对 SW 的安全要求）。
 *  - 监听 SW 更新：当检测到新版本就绪时，弹出一条可点击的"刷新使用新版本"提示。
 *  - 监听 beforeinstallprompt：在合适的时机暴露安装入口（默认开启，可静音）。
 *  - 暴露 window.RF_PWA：少量调试方法（updateNow / unregisterAll）。
 *
 * 该模块不依赖业务模块，运行于 DOMContentLoaded 之后即可。
 */
(function () {
  "use strict";

  // 仅在支持 SW 且为安全上下文时启用（file:// 不支持）
  if (!("serviceWorker" in navigator)) return;
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    console.info("[pwa] SW 需要 HTTPS 或 localhost，已跳过注册");
    return;
  }

  // SW 与本文件同目录（项目根），相对路径保证可部署到任意子目录
  var SW_URL = "sw.js";
  var deferredInstallPrompt = null;

  document.addEventListener("DOMContentLoaded", function () {
    register();
    bindInstallPrompt();
  });

  function register() {
    navigator.serviceWorker
      .register(SW_URL, { scope: "./" })
      .then(function (reg) {
        // 已有等待中的 worker（用户上次离开未刷新）
        if (reg.waiting && navigator.serviceWorker.controller) {
          notifyUpdateReady(reg);
        }
        // 新版本被发现 -> 进入 installing
        reg.addEventListener("updatefound", function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", function () {
            if (sw.state === "installed" && navigator.serviceWorker.controller) {
              notifyUpdateReady(reg);
            }
          });
        });
        // 新 SW 接管后刷新一次（可选：默认不强制刷新，由用户点击）
      })
      .catch(function (err) {
        console.warn("[pwa] SW 注册失败：", err && err.message);
      });

    // SW 主动通知（如 activate 后）
    navigator.serviceWorker.addEventListener("message", function (e) {
      var data = e.data || {};
      if (data.type === "RF_SW_ACTIVATED") {
        // 静默：不打扰用户；若想提示可在此 toast
        // if (window.RF_UI && window.RF_UI.toast) window.RF_UI.toast.ok("已可离线使用");
      }
    });

    // 接管页面后无需自动 reload —— 现代浏览器配合 clients.claim() 已可平滑接管。
  }

  // ============== 新版本可用提示 ==============
  function notifyUpdateReady(reg) {
    if (document.getElementById("rf-pwa-update")) return; // 防重复

    var bar = document.createElement("div");
    bar.id = "rf-pwa-update";
    bar.setAttribute("role", "status");
    bar.style.cssText = [
      "position:fixed", "left:50%", "bottom:18px",
      "transform:translateX(-50%)",
      "z-index:99998",
      "display:flex", "align-items:center", "gap:12px",
      "padding:10px 14px",
      "background:#1f57b8", "color:#fff",
      "border-radius:999px",
      "box-shadow:0 8px 24px rgba(31,87,184,.32)",
      "font:500 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
      "max-width:calc(100vw - 24px)"
    ].join(";");

    var msg = document.createElement("span");
    msg.textContent = "新版本已就绪";
    msg.style.cssText = "white-space:nowrap";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "刷新启用";
    btn.style.cssText = [
      "appearance:none", "border:0", "cursor:pointer",
      "padding:6px 12px", "border-radius:999px",
      "background:#fff", "color:#1f57b8",
      "font:600 12px/1 inherit"
    ].join(";");
    btn.addEventListener("click", function () {
      if (reg.waiting) reg.waiting.postMessage({ type: "RF_SW_SKIP_WAITING" });
      // SW 接管后刷新一次，用上新资源
      var refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (refreshing) return;
        refreshing = true;
        location.reload();
      });
    });

    var dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "关闭");
    dismiss.textContent = "✕";
    dismiss.style.cssText = [
      "appearance:none", "border:0", "cursor:pointer",
      "background:transparent", "color:rgba(255,255,255,.85)",
      "font:600 14px/1 inherit", "padding:2px 4px"
    ].join(";");
    dismiss.addEventListener("click", function () {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    });

    bar.appendChild(msg);
    bar.appendChild(btn);
    bar.appendChild(dismiss);
    document.body.appendChild(bar);
  }

  // ============== 安装入口（beforeinstallprompt） ==============
  function bindInstallPrompt() {
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferredInstallPrompt = e;
      // 默认不弹横幅，避免打扰；提供 API 供后续接入"安装"按钮
      // 若需立即提示，可在这里调用 showInstallHint()
    });

    window.addEventListener("appinstalled", function () {
      deferredInstallPrompt = null;
      if (window.RF_UI && window.RF_UI.toast) {
        window.RF_UI.toast.ok("已添加到主屏幕");
      }
    });
  }

  // ============== 调试 / 主动 API ==============
  window.RF_PWA = {
    /** 立即触发安装提示（如果浏览器允许） */
    promptInstall: function () {
      if (!deferredInstallPrompt) return Promise.resolve(false);
      deferredInstallPrompt.prompt();
      return deferredInstallPrompt.userChoice.then(function (c) {
        deferredInstallPrompt = null;
        return c && c.outcome === "accepted";
      });
    },
    /** 立即检查更新 */
    updateNow: function () {
      return navigator.serviceWorker.getRegistration().then(function (reg) {
        return reg ? reg.update() : null;
      });
    },
    /** 卸载所有 SW + 清空 reportflow-* 缓存（调试用） */
    unregisterAll: function () {
      return Promise.all([
        navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister(); }));
        }),
        caches.keys().then(function (keys) {
          return Promise.all(
            keys.filter(function (k) { return k.indexOf("reportflow-") === 0; })
                .map(function (k) { return caches.delete(k); })
          );
        })
      ]);
    }
  };
})();

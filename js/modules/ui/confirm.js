/**
 * ui/confirm.js — promise-based confirm dialog wrapping the modal.
 *
 *   var ok = await RF_UI.confirm({ title: "删除草稿?", body: "无法恢复", danger: true });
 */
(function () {
  "use strict";

  function confirm(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var body = document.createElement("div");
      body.style.fontSize = "14px";
      body.textContent = opts.body || "";

      var foot = document.createElement("div");
      foot.style.cssText = "display:flex;gap:8px;width:100%;justify-content:flex-end";

      var cancel = document.createElement("button");
      cancel.className = "rf-btn rf-btn--ghost";
      cancel.textContent = opts.cancelLabel || "取消";

      var confirmBtn = document.createElement("button");
      confirmBtn.className = "rf-btn " + (opts.danger ? "rf-btn--danger" : "rf-btn--primary");
      confirmBtn.textContent = opts.confirmLabel || "确定";

      foot.appendChild(cancel);
      foot.appendChild(confirmBtn);

      var m = window.RF_UI.modal.open({
        title: opts.title || "请确认",
        bodyEl: body,
        footerEl: foot,
        size: "md",
        onClose: function () { resolve(false); }
      });

      cancel.addEventListener("click", function () { m.close(); });
      confirmBtn.addEventListener("click", function () {
        // Resolve true and prevent the onClose from also resolving false.
        m.close = (function (orig) {
          return function () { orig(); };
        })(m.close);
        // Replace onClose handler before close fires
        resolve(true);
        // Close the modal (its onClose will resolve(false) but the promise
        // has already settled).
        m.close();
      });
    });
  }

  window.RF_UI = window.RF_UI || {};
  window.RF_UI.confirm = confirm;
})();

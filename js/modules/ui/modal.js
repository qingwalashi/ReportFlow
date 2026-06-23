/**
 * ui/modal.js — single-instance modal manager.
 *
 * Usage:
 *   var m = RF_UI.modal.open({
 *     title: "设置",
 *     bodyHTML: "<p>...</p>",          // OR
 *     bodyEl: someElement,
 *     footerEl: customFooter,           // optional
 *     size: "lg" | "md",                // default "md"
 *     onClose: function() {},
 *   });
 *   m.close();
 */
(function () {
  "use strict";

  var root = null;
  var current = null;

  function ensureRoot() {
    if (root) return root;
    root = document.getElementById("rf-modal-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "rf-modal-root";
      root.className = "rf-modal-root";
      root.hidden = true;
      document.body.appendChild(root);
    }
    // Close only when both the press and the release land on the backdrop.
    // A text selection that starts inside the modal and ends on the backdrop
    // (e.g. right-to-left drag-select past the edge) fires a click whose
    // target is the backdrop — without this guard that would wrongly close.
    var downOnRoot = false;
    root.addEventListener("mousedown", function (e) {
      downOnRoot = e.target === root;
    });
    root.addEventListener("click", function (e) {
      if (e.target === root && downOnRoot) close();
      downOnRoot = false;
    });
    document.addEventListener("keydown", function (e) {
      if (current && e.key === "Escape") close();
    });
    return root;
  }

  function open(opts) {
    ensureRoot();
    if (current) close();

    var modal = document.createElement("div");
    modal.className = "rf-modal" + (opts.size === "lg" ? " rf-modal--lg" : "");

    // Head
    var head = document.createElement("div");
    head.className = "rf-modal__head";
    var title = document.createElement("div");
    title.className = "rf-modal__title";
    title.textContent = opts.title || "";
    var closeBtn = document.createElement("button");
    closeBtn.className = "rf-modal__close";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.innerHTML = "✕";
    closeBtn.addEventListener("click", close);
    head.appendChild(title);
    head.appendChild(closeBtn);

    // Body
    var body = document.createElement("div");
    body.className = "rf-modal__body";
    if (opts.bodyEl) body.appendChild(opts.bodyEl);
    else if (opts.bodyHTML) body.innerHTML = opts.bodyHTML;

    modal.appendChild(head);
    modal.appendChild(body);

    // Foot
    if (opts.footerEl) {
      var foot = document.createElement("div");
      foot.className = "rf-modal__foot";
      foot.appendChild(opts.footerEl);
      modal.appendChild(foot);
    }

    root.innerHTML = "";
    root.appendChild(modal);
    root.hidden = false;

    current = { el: modal, opts: opts };
    return { close: close, body: body, modal: modal };
  }

  function close() {
    if (!current) return;
    var opts = current.opts;
    current = null;
    if (root) {
      root.hidden = true;
      root.innerHTML = "";
    }
    if (opts && typeof opts.onClose === "function") {
      try { opts.onClose(); } catch (e) { console.error(e); }
    }
  }

  window.RF_UI = window.RF_UI || {};
  window.RF_UI.modal = { open: open, close: close };
})();

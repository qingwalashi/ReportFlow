/**
 * parse-progress.js — floating progress panel for the 解析 flow.
 *
 * Renders a small fixed panel in the bottom-right that shows phase status
 * ("调用模型…" / "JSON 修复中…" / 校验), a live char counter, and a tail
 * preview of the streamed model output so the user can see thinking progress.
 *
 * Public API:
 *   var p = RF_ParseProgress.start();
 *   p.update({ phase, message, delta, total, ... });
 *   p.success({ sections, warnings });
 *   p.fail(message);
 *
 * Only one panel exists at a time — calling start() again replaces it.
 */
(function () {
  "use strict";

  var rootEl = null;
  var els = null;
  // Tail of streamed output kept for the live preview. We cap to avoid layout
  // jank on long generations — the full text is in memory inside the parser
  // promise chain anyway.
  var TAIL_CHARS = 600;
  var tailContent = "";
  var tailReason  = "";
  // Cumulative char counts of the *full* stream (not just the tail) — used to
  // drive the token estimator without keeping every char in memory.
  var fullContentLen = 0;
  var fullReasonLen  = 0;
  // Rough char-class counters for the token estimate. We split chars into
  // CJK-ish (≈1 token each) vs everything else (≈4 chars/token), which is
  // OpenAI's published rule-of-thumb when no tokenizer is available. Good
  // enough for a progress indicator; not a billing-grade count.
  var cjkChars   = 0;
  var otherChars = 0;
  var tStart = 0;
  var tickTimer = null;
  // Per-run labels so the same panel can serve other flows (e.g. 智能高亮).
  var labels = { done: "解析完成", fail: "解析失败" };

  function isCjk(code) {
    // CJK Unified Ideographs + Extension A + common CJK punctuation +
    // Hiragana/Katakana + Hangul. Covers what users actually paste here.
    return (code >= 0x3040 && code <= 0x30FF)   // Hiragana / Katakana
        || (code >= 0x3400 && code <= 0x4DBF)   // CJK Ext A
        || (code >= 0x4E00 && code <= 0x9FFF)   // CJK Unified
        || (code >= 0xAC00 && code <= 0xD7AF)   // Hangul
        || (code >= 0xF900 && code <= 0xFAFF)   // CJK Compatibility
        || (code >= 0xFF00 && code <= 0xFFEF);  // Halfwidth/Fullwidth
  }
  function tallyChars(s) {
    for (var i = 0; i < s.length; i++) {
      if (isCjk(s.charCodeAt(i))) cjkChars++;
      else otherChars++;
    }
  }
  function estimatedTokens() {
    // 1 token per CJK char + 1 token per ~4 non-CJK chars. Ceil so very short
    // streams don't display "0".
    return cjkChars + Math.ceil(otherChars / 4);
  }
  function formatTokens(n) {
    if (n < 1000) return n + " tok";
    if (n < 10000) return (n / 1000).toFixed(2) + "k tok";
    return (n / 1000).toFixed(1) + "k tok";
  }

  function ensureMount() {
    if (rootEl && document.body.contains(rootEl)) return;
    rootEl = document.createElement("div");
    rootEl.className = "rf-parse-progress";
    rootEl.setAttribute("role", "status");
    rootEl.setAttribute("aria-live", "polite");
    rootEl.innerHTML =
      '<div class="rf-pp__head">' +
      '  <span class="rf-pp__dot" aria-hidden="true"></span>' +
      '  <span class="rf-pp__phase">准备中…</span>' +
      '  <span class="rf-pp__elapsed" title="耗时">0.0s</span>' +
      '  <button type="button" class="rf-pp__toggle" aria-label="折叠/展开" title="折叠/展开">−</button>' +
      '  <button type="button" class="rf-pp__close" aria-label="关闭" title="关闭" hidden>×</button>' +
      '</div>' +
      '<div class="rf-pp__meta">' +
      '  <span class="rf-pp__counter" title="按 CJK ≈ 1 token、其它 ≈ 4 chars/token 估算，仅供参考">~0 tok</span>' +
      '  <span class="rf-pp__kind"></span>' +
      '</div>' +
      '<div class="rf-pp__body">' +
      '  <pre class="rf-pp__tail" aria-label="模型输出预览"></pre>' +
      '</div>';
    document.body.appendChild(rootEl);
    els = {
      root:     rootEl,
      phase:    rootEl.querySelector(".rf-pp__phase"),
      elapsed:  rootEl.querySelector(".rf-pp__elapsed"),
      dot:      rootEl.querySelector(".rf-pp__dot"),
      counter:  rootEl.querySelector(".rf-pp__counter"),
      kind:     rootEl.querySelector(".rf-pp__kind"),
      tail:     rootEl.querySelector(".rf-pp__tail"),
      body:     rootEl.querySelector(".rf-pp__body"),
      toggle:   rootEl.querySelector(".rf-pp__toggle"),
      close:    rootEl.querySelector(".rf-pp__close")
    };
    els.toggle.addEventListener("click", function () {
      var collapsed = rootEl.classList.toggle("rf-parse-progress--collapsed");
      els.toggle.textContent = collapsed ? "+" : "−";
    });
    els.close.addEventListener("click", function () { dismiss(); });
  }

  function start(cfg) {
    cfg = cfg || {};
    ensureMount();
    labels = {
      done: cfg.doneLabel || "解析完成",
      fail: cfg.failLabel || "解析失败"
    };
    tailContent = "";
    tailReason  = "";
    fullContentLen = 0;
    fullReasonLen  = 0;
    cjkChars   = 0;
    otherChars = 0;
    tStart = Date.now();
    rootEl.classList.remove("rf-parse-progress--ok", "rf-parse-progress--err", "rf-parse-progress--collapsed");
    els.toggle.textContent = "−";
    els.close.hidden = true;
    els.phase.textContent = cfg.startLabel || "构建提示…";
    els.elapsed.textContent = "0.0s";
    els.counter.textContent = "~0 tok";
    els.kind.textContent = "";
    els.tail.textContent = "";
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(function () {
      els.elapsed.textContent = ((Date.now() - tStart) / 1000).toFixed(1) + "s";
    }, 100);

    return {
      update: update,
      success: success,
      fail: fail,
      dismiss: dismiss
    };
  }

  function update(ev) {
    if (!els) return;
    if (ev.phase === "stream" && typeof ev.delta === "string") {
      tallyChars(ev.delta);
      if (ev.kind === "reasoning") {
        fullReasonLen += ev.delta.length;
        tailReason += ev.delta;
        if (tailReason.length > TAIL_CHARS) tailReason = tailReason.slice(-TAIL_CHARS);
        els.kind.textContent = ev.repair ? "修复 · 思考中" : "思考中";
        els.tail.textContent = tailReason;
      } else {
        fullContentLen += ev.delta.length;
        tailContent += ev.delta;
        if (tailContent.length > TAIL_CHARS) tailContent = tailContent.slice(-TAIL_CHARS);
        els.kind.textContent = ev.repair ? "修复 · 输出中" : "输出中";
        els.tail.textContent = tailContent;
      }
      els.counter.textContent = "~" + formatTokens(estimatedTokens());
      els.tail.scrollTop = els.tail.scrollHeight;
      els.phase.textContent = ev.repair ? "JSON 修复中…" : "模型生成中…";
      return;
    }
    if (ev.message) els.phase.textContent = ev.message;
    if (ev.phase === "parse-json") {
      els.kind.textContent = "解析 JSON";
    } else if (ev.phase === "validate") {
      els.kind.textContent = "校验结构";
    } else if (ev.phase === "repair") {
      els.kind.textContent = "修复中";
      // Repair pass starts a new stream; reset tail + token tally so we don't
      // mix outputs and the counter reflects the repair generation only.
      tailContent = "";
      tailReason  = "";
      fullContentLen = 0;
      fullReasonLen  = 0;
      cjkChars   = 0;
      otherChars = 0;
      els.tail.textContent = "";
      els.counter.textContent = "~0 tok";
    }
  }

  function success(info) {
    if (!els) return;
    rootEl.classList.add("rf-parse-progress--ok");
    els.phase.textContent = (info && info.label) || labels.done;
    // info.summary: free-form text (用于高亮等流程)；否则回退到「N 章节 · M 警告」。
    els.kind.textContent  = (info && typeof info.summary === "string")
      ? info.summary
      : (info && info.sections != null)
        ? (info.sections + " 章节" + (info.warnings ? " · " + info.warnings + " 警告" : ""))
        : "";
    finalize();
  }

  function fail(message) {
    if (!els) return;
    rootEl.classList.add("rf-parse-progress--err");
    els.phase.textContent = labels.fail;
    els.kind.textContent  = "";
    if (message) {
      // Show the error in the tail area so it's visible without expanding.
      els.tail.textContent = String(message);
    }
    finalize();
  }

  function finalize() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (els && els.elapsed) {
      els.elapsed.textContent = ((Date.now() - tStart) / 1000).toFixed(1) + "s";
    }
    if (els && els.close) els.close.hidden = false;
    // Auto-dismiss success after a short delay; failures stay until the user
    // closes them (or another parse starts) so the message can be read.
    if (rootEl.classList.contains("rf-parse-progress--ok")) {
      setTimeout(function () {
        // Only dismiss if still in this same success state (user might have
        // started another parse in the meantime).
        if (rootEl && rootEl.classList.contains("rf-parse-progress--ok")) dismiss();
      }, 2200);
    }
  }

  function dismiss() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null; els = null;
  }

  window.RF_ParseProgress = { start: start };
})();

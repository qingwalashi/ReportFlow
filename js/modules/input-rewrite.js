/**
 * input-rewrite.js — AI rewrite of a selection inside the natural-language
 * input textarea (#rf-input-text).
 *
 * Flow:
 *   user selects text -> clicks #rf-btn-rewrite-sel (or hits Alt+R)
 *   -> modal opens with snapshot of original + instruction box + presets
 *   -> "生成" calls LLM, result shown in a read-only textarea
 *   -> user can regenerate / edit / replace / cancel
 *
 * Replacement uses textarea.setRangeText(...) and dispatches an "input"
 * event so any listener (draft auto-save, parse-button enable state, …)
 * reacts as if the user typed.
 *
 * Public:
 *   RF_InputRewrite.init()
 *   RF_InputRewrite.openForCurrentSelection()
 *   RF_InputRewrite.buildRewriteMessages(originalText, instruction)
 *   RF_InputRewrite.sanitizeRewrite(text)
 */
(function () {
  "use strict";

  var TA_ID  = "rf-input-text";
  var BTN_ID = "rf-btn-rewrite-sel";

  // Hard cap: refuse to even open the modal beyond this — keeps prompts
  // small and avoids burning tokens on what is almost certainly the wrong
  // workflow (whole-doc rewrite belongs in 解析, not 改写选区).
  var MAX_SEL_CHARS = 4000;

  // Soft hint: above this, show an inline note inside the modal but allow.
  var SOFT_SEL_CHARS = 2000;

  // Presets append (or seed) the instruction box. Phrased as imperatives so
  // they read naturally when the user lets the preset stand on its own.
  var PRESETS = [
    { label: "自动排版", text: "在不改变原意的前提下，按内容自身的结构重新排版：并列要点用编号或项目符号分点换行，多主题用空行分段，关键数据用 **加粗** 突出。" },
    { label: "精简",     text: "在不丢失关键信息的前提下，把这段话压缩到原长度的三分之二左右。" },
    { label: "扩写",     text: "保留原意并补充必要的过渡与细节，让表述更完整、读起来更顺畅。" },
    { label: "纠错",     text: "修正错别字、标点、语法和不通顺的表达，不要改变原意，也不要改变排版结构。" },
    { label: "正式化",   text: "改写成更书面化、更正式的公文风格，避免口语词。" },
    { label: "口语化",   text: "改写成自然、口语化的表达，去掉公文腔。" }
  ];

  // ------------------------------------------------------------------
  // Bootstrap: button enable-state + keyboard shortcut
  // ------------------------------------------------------------------
  function init() {
    var ta  = document.getElementById(TA_ID);
    var btn = document.getElementById(BTN_ID);
    if (!ta || !btn) return;

    btn.addEventListener("click", openForCurrentSelection);

    var refresh = function () { syncButton(ta, btn); };
    ta.addEventListener("select",  refresh);
    ta.addEventListener("mouseup", refresh);
    ta.addEventListener("keyup",   refresh);
    ta.addEventListener("input",   refresh);
    // Catches selections cleared by clicking outside, focus changes, etc.
    document.addEventListener("selectionchange", function () {
      if (document.activeElement === ta) refresh();
    });
    refresh();

    // Alt+R while focus is in the textarea and there's a real selection.
    ta.addEventListener("keydown", function (e) {
      if (e.altKey && (e.key === "r" || e.key === "R")) {
        if (ta.selectionStart !== ta.selectionEnd) {
          e.preventDefault();
          openForCurrentSelection();
        }
      }
    });
  }

  function syncButton(ta, btn) {
    var s = ta.selectionStart, e = ta.selectionEnd;
    var sel = (s !== e) ? ta.value.slice(s, e) : "";
    var has = sel.trim().length > 0;
    btn.disabled = !has;
    btn.title = has
      ? "AI 改写选中文本（" + sel.length + " 字 / Alt+R）"
      : "请先在文本框中选中要改写的内容";
  }

  // ------------------------------------------------------------------
  // Entry point
  // ------------------------------------------------------------------
  function openForCurrentSelection() {
    var ta = document.getElementById(TA_ID);
    if (!ta) return;
    var s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) {
      window.RF_UI.toast.warn("请先在文本框中选中要改写的内容");
      return;
    }
    var original = ta.value.slice(s, e);
    if (!original.trim()) {
      window.RF_UI.toast.warn("选中的内容只有空白字符");
      return;
    }
    if (original.length > MAX_SEL_CHARS) {
      window.RF_UI.toast.warn("选中文本超过 " + MAX_SEL_CHARS + " 字，请缩小选区");
      return;
    }

    // Reuse the parse flow's config check — same UX shape, no surprises.
    var c = window.RF_ConfigManager.get();
    if (!c.apiKey || !c.baseUrl || !c.model) {
      window.RF_UI.toast.warn("请先在「设置」配置大模型 API");
      window.RF_ConfigManager.openModal();
      return;
    }

    // Snapshot lets us validate the replacement target later — the textarea
    // can change underneath us while the modal is open (sample loaded,
    // user typed, clear button pressed). See doReplace().
    openModal({
      taValue:  ta.value,
      start:    s,
      end:      e,
      original: original
    });
  }

  // ------------------------------------------------------------------
  // Modal: build DOM, manage state machine, wire LLM round-trips.
  // ------------------------------------------------------------------
  function openModal(snapshot) {
    var view = buildModalDOM(snapshot);
    var ctx = {
      snapshot: snapshot,
      currentRequestCtrl: null,    // AbortController; UI-level cancel only
      state: "idle"                // idle | loading | has-result | editing-result
    };
    var modalApi;

    PRESETS.forEach(function (p, i) {
      view.presetBtns[i].addEventListener("click", function () {
        var cur = view.instrInput.value.trim();
        view.instrInput.value = cur ? (cur + "\n" + p.text) : p.text;
        view.instrInput.focus();
      });
    });

    view.btnGenerate.addEventListener("click",   function () { runGenerate(ctx, view); });
    view.btnRegenerate.addEventListener("click", function () { runGenerate(ctx, view); });
    view.btnEdit.addEventListener("click",       function () { setState(ctx, view, "editing-result"); view.resultArea.focus(); });
    view.btnReplace.addEventListener("click",    function () { doReplace(ctx, view, modalApi); });
    view.btnCancel.addEventListener("click",     function () { modalApi.close(); });

    // Ctrl/Cmd+Enter inside the instruction box fires 生成 (or 重新生成).
    view.instrInput.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        runGenerate(ctx, view);
      }
    });

    modalApi = window.RF_UI.modal.open({
      title: "AI 改写选区",
      bodyEl: view.body,
      footerEl: view.footer,
      size: "lg",
      onClose: function () {
        // Drop any in-flight result so we don't toast/setState after close.
        if (ctx.currentRequestCtrl) {
          try { ctx.currentRequestCtrl.abort(); } catch (e) {}
          ctx.currentRequestCtrl = null;
        }
      }
    });

    setState(ctx, view, "idle");
    setTimeout(function () { view.instrInput.focus(); }, 0);
  }

  function buildModalDOM(snapshot) {
    var body = document.createElement("div");
    body.className = "rf-rewrite";

    // ---- Original text (read-only display, with soft length hint) ----
    var origLabel = document.createElement("div");
    origLabel.className = "rf-rewrite__label";
    origLabel.textContent = "原文（" + snapshot.original.length + " 字）";

    var origView = document.createElement("pre");
    origView.className = "rf-rewrite__orig";
    origView.textContent = snapshot.original;

    // ---- Instruction input ----
    var instrLabel = document.createElement("div");
    instrLabel.className = "rf-rewrite__label";
    instrLabel.textContent = "改写要求";

    var instrInput = document.createElement("textarea");
    instrInput.className = "rf-textarea rf-rewrite__instr";
    instrInput.placeholder = "写下你的改写要求，例如「压缩到 50 字以内」「翻译成英文」…  Ctrl+Enter 生成";
    instrInput.rows = 3;

    // ---- Preset chips ----
    var presetRow = document.createElement("div");
    presetRow.className = "rf-rewrite__presets";
    var presetBtns = PRESETS.map(function (p) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "rf-btn rf-btn--ghost rf-btn--sm";
      b.textContent = p.label;
      presetRow.appendChild(b);
      return b;
    });

    // ---- Status / inline error line ----
    var statusEl = document.createElement("div");
    statusEl.className = "rf-rewrite__status";
    if (snapshot.original.length > SOFT_SEL_CHARS) {
      statusEl.textContent = "提示：选区较长（" + snapshot.original.length + " 字），生成会更慢、消耗更多 token。";
    }

    // ---- Result block (hidden until first generation) ----
    var resultBlock = document.createElement("div");
    resultBlock.className = "rf-rewrite__result";
    var resultLabel = document.createElement("div");
    resultLabel.className = "rf-rewrite__label";
    resultLabel.textContent = "生成结果";
    var resultArea = document.createElement("textarea");
    resultArea.className = "rf-textarea rf-rewrite__result-area";
    resultArea.rows = 8;
    resultArea.readOnly = true;
    resultBlock.appendChild(resultLabel);
    resultBlock.appendChild(resultArea);

    body.appendChild(origLabel);
    body.appendChild(origView);
    body.appendChild(instrLabel);
    body.appendChild(instrInput);
    body.appendChild(presetRow);
    body.appendChild(statusEl);
    body.appendChild(resultBlock);

    // ---- Footer ----
    var footer = document.createElement("div");
    footer.className = "rf-rewrite__foot";

    var btnCancel    = mkBtn("rf-btn rf-btn--ghost",   "取消");
    var btnRegen     = mkBtn("rf-btn rf-btn--ghost",   "重新生成");
    var btnEdit      = mkBtn("rf-btn rf-btn--ghost",   "编辑结果");
    var btnGenerate  = mkBtn("rf-btn rf-btn--primary", "生成");
    var btnReplace   = mkBtn("rf-btn rf-btn--primary", "替换");

    footer.appendChild(btnCancel);
    footer.appendChild(btnRegen);
    footer.appendChild(btnEdit);
    footer.appendChild(btnGenerate);
    footer.appendChild(btnReplace);

    return {
      body: body, footer: footer,
      origView: origView,
      instrInput: instrInput,
      presetBtns: presetBtns,
      resultBlock: resultBlock,
      resultArea: resultArea,
      statusEl: statusEl,
      btnGenerate: btnGenerate,
      btnRegenerate: btnRegen,
      btnEdit: btnEdit,
      btnReplace: btnReplace,
      btnCancel: btnCancel,
      _initialStatus: statusEl.textContent  // remember for setState resets
    };
  }

  function mkBtn(cls, label) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = label;
    return b;
  }

  // ------------------------------------------------------------------
  // State machine
  // ------------------------------------------------------------------
  function setState(ctx, view, next) {
    ctx.state = next;
    var s = next;

    show(view.btnGenerate,    s === "idle");
    show(view.btnRegenerate,  s === "has-result" || s === "editing-result");
    show(view.btnEdit,        s === "has-result");
    show(view.btnReplace,     s === "has-result" || s === "editing-result");

    view.instrInput.disabled    = (s === "loading");
    view.btnGenerate.disabled   = (s === "loading");
    view.btnRegenerate.disabled = (s === "loading");
    view.resultArea.readOnly    = (s !== "editing-result");

    show(view.resultBlock, s !== "idle");

    if (s === "loading") {
      view.statusEl.textContent = "正在生成…（关闭对话框可取消）";
    } else if (s === "idle") {
      // Restore the soft-length hint (if any), clear stale errors.
      view.statusEl.textContent = view._initialStatus || "";
    } else {
      view.statusEl.textContent = "";
    }
  }

  // ------------------------------------------------------------------
  // LLM round-trip
  // ------------------------------------------------------------------
  function runGenerate(ctx, view) {
    var instruction = (view.instrInput.value || "").trim();
    if (!instruction) {
      view.statusEl.textContent = "请填写改写指令，或点击预设按钮。";
      return;
    }
    // Cancel any previous in-flight call (UI-level — see header comment).
    if (ctx.currentRequestCtrl) {
      try { ctx.currentRequestCtrl.abort(); } catch (e) {}
    }
    var ctrl = new AbortController();
    ctx.currentRequestCtrl = ctrl;

    setState(ctx, view, "loading");

    var messages = buildRewriteMessages(ctx.snapshot.original, instruction);

    window.RF_LLM.complete({
      messages: messages,
      maxTokens: 2048,
      temperature: 0.4,
      timeoutMs: 60000
    }).then(function (text) {
      // Note: llm-client.js currently builds its own AbortController and
      // ignores opts.signal, so this only stops UI side-effects, not the
      // network request. That's an accepted trade-off — see plan.
      if (ctrl.signal.aborted) return;
      var clean = sanitizeRewrite(text);
      if (!clean) {
        view.statusEl.textContent = "模型未返回内容，请调整指令后重试。";
        setState(ctx, view, "idle");
        return;
      }
      view.resultArea.value = clean;
      setState(ctx, view, "has-result");
    }).catch(function (err) {
      if (ctrl.signal.aborted || (err && err.name === "AbortError")) {
        return;  // user-initiated abort, silent
      }
      var msg = String(err && err.message || err);
      view.statusEl.textContent = "改写失败：" + msg;
      window.RF_UI.toast.err(msg);
      setState(ctx, view, "idle");
    }).then(function () {
      if (ctx.currentRequestCtrl === ctrl) ctx.currentRequestCtrl = null;
    });
  }

  /**
   * Strip wrapping ``` fences and surrounding paired quotes the model
   * may have added despite the system prompt forbidding them.
   *
   * Conservative on quote stripping: a quote pair is only treated as
   * "wrapping" when (a) the matching open/close chars are at both ends,
   * AND (b) the same opening char doesn't appear again inside, AND (c)
   * there is no newline in between. This avoids eating real quotes that
   * happen to sit at the start of the first list item / end of the last
   * sentence in a multi-line, multi-bullet rewrite.
   */
  function sanitizeRewrite(text) {
    if (!text) return "";
    var t = String(text).trim();
    // ```lang\n...\n```  or  ```\n...\n```
    if (/^```/.test(t)) {
      t = t.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
    }
    if (t.length >= 2) {
      var first = t.charAt(0), last = t.charAt(t.length - 1);
      var pairs = { '"': '"', "“": "”", "'": "'", "‘": "’" };
      var inner = t.slice(1, -1);
      if (pairs[first] && pairs[first] === last
          && inner.indexOf(first) < 0
          && inner.indexOf("\n") < 0) {
        t = inner.trim();
      }
    }
    return t;
  }

  // ------------------------------------------------------------------
  // Replace
  // ------------------------------------------------------------------
  function doReplace(ctx, view, modalApi) {
    var ta = document.getElementById(TA_ID);
    if (!ta) { modalApi.close(); return; }
    var snap = ctx.snapshot;
    var replacement = view.resultArea.value;

    var live = ta.value;
    var sliceLive = live.slice(snap.start, snap.end);

    if (live === snap.taValue && sliceLive === snap.original) {
      applyReplace(ta, snap.start, snap.end, replacement);
      modalApi.close();
      return;
    }

    // Try to relocate the original by indexOf — only safe if unique.
    var firstIdx = live.indexOf(snap.original);
    var nextIdx  = firstIdx >= 0 ? live.indexOf(snap.original, firstIdx + 1) : -1;
    if (firstIdx >= 0 && nextIdx < 0) {
      applyReplace(ta, firstIdx, firstIdx + snap.original.length, replacement);
      modalApi.close();
      return;
    }

    // Either the original vanished or appears multiple times — ask first.
    window.RF_UI.confirm({
      title: "原文已变化",
      body: "在打开此对话框期间，输入框内容发生了变化，原始位置已不可靠。仍要按当前位置替换吗？",
      danger: true,
      confirmLabel: "仍然替换",
      cancelLabel: "放弃"
    }).then(function (ok) {
      if (!ok) return;
      var s = Math.min(snap.start, ta.value.length);
      var e = Math.min(snap.end,   ta.value.length);
      applyReplace(ta, s, e, replacement);
      modalApi.close();
    });
  }

  function applyReplace(ta, start, end, replacement) {
    ta.focus();
    // 'end' parameter places the caret right after the inserted text.
    ta.setRangeText(replacement, start, end, "end");
    // Notify any listeners — draft auto-save, parse-button enable state, etc.
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    window.RF_UI.toast.ok("已替换选区");
  }

  // ------------------------------------------------------------------
  // Prompt assembly
  // ------------------------------------------------------------------
  function buildRewriteMessages(originalText, instruction) {
    var system = [
      "你是一名严谨的中文文本改写助手。用户会给你一段「原文」和一条「改写要求」，你需要按照要求改写原文。",
      "",
      "排版与格式判断（重要）：",
      "- 按内容自身的结构选择最易读的版式，不要拘泥于原文的版式。",
      "- 出现并列的多条信息（≥3 条要点、步骤、原因、措施、清单）时，使用「1. 2. 3.」编号或「- 」项目符号分点换行，每点一行。",
      "- 涉及多个不同主题、阶段或视角时，用空行分段；段落之间用一个空行（即两个换行符）分隔。",
      "- 单一主旨且较短的内容保持为一整段，不要硬拆。",
      "- 标题、章节号若原文已有则保留；若改写要求要求结构化呈现，可以新增简短的小标题（用「**加粗**」标注，独占一行）。",
      "- 列表项内部仍可包含「**加粗**」突出关键数据。",
      "",
      "硬性输出规则：",
      "1) 直接输出改写后的正文，不要写「好的」「以下是」「这是改写后的版本」等开场白，也不要在末尾追加解释。",
      "2) 不要使用 markdown 代码块（```）包裹整段结果。",
      "3) 不要在整段结果的最外层添加成对的引号、书名号或括号（列表项或段落内部该有的标点照常保留）。",
      "4) 保持原文的语种（中文输入就用中文输出，除非「改写要求」明确要求翻译）。",
      "5) 保留原文中的事实、数字、人名、机构名和专有名词，不要凭空增删数据。",
      "6) 输出长度由「改写要求」决定；若未指定，保持与原文相近。",
      "",
      "如果你判断「改写要求」与原文无关或无法执行，依然只输出原文本身，不要输出解释。"
    ].join("\n");
    var user = [
      "【改写要求】",
      instruction,
      "",
      "【原文】",
      originalText
    ].join("\n");
    return [
      { role: "system", content: system },
      { role: "user",   content: user }
    ];
  }

  function show(el, on) { if (el) el.style.display = on ? "" : "none"; }

  window.RF_InputRewrite = {
    init: init,
    openForCurrentSelection: openForCurrentSelection,
    buildRewriteMessages: buildRewriteMessages,
    sanitizeRewrite: sanitizeRewrite
  };
})();

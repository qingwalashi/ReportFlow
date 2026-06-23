/**
 * smart-highlight.js — 智能高亮（荧光笔）。
 *
 * 中栏底部「🖍️ 智能高亮」按钮 → 弹窗选择高亮类型（数字/文字，至少一项，默认数字）
 * → 调用 LLM 识别报告中的关键数字与关键结论，给正文（text 块）与表格单元格打高亮。
 *
 * 高亮的承载方式（非破坏式以外的最小侵入）：
 *   - 正文：在 text 块 content 命中片段处包裹 <mark class="rf-hl rf-hl--num|text">，
 *           marked 默认透传行内 HTML，预览与导出都能渲染。
 *   - 表格：给单元格设置 cell.style.hl = "num"|"text"，table-format.js 输出底色。
 *
 * 识别范围自动择优：小文档整体一次调用；大文档按章节逐个调用。
 * 未配置 LLM（或调用失败）时回退到本地正则规则。
 *
 * 公共：RF_SmartHighlight.init() / .open()
 */
(function () {
  "use strict";

  var state  = window.RF_State;
  var schema = window.RF_Schema;
  var log    = window.RF_Log;

  // 整体 vs 分章节的体量阈值（便于调整）。
  var WHOLE_MAX_CHARS    = 6000;
  var WHOLE_MAX_SECTIONS = 6;

  var MARK_OPEN  = '<mark class="rf-hl rf-hl--';
  // 清除：把 <mark class="rf-hl ...">...</mark> 还原为内部文本。
  var MARK_WRAP_RE  = /<mark class="rf-hl[^"]*">([\s\S]*?)<\/mark>/g;

  function init() {
    var btn = document.getElementById("rf-btn-smart-highlight");
    if (btn) btn.addEventListener("click", open);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function llmConfigured() {
    var c = (window.RF_ConfigManager && window.RF_ConfigManager.get()) || {};
    return !!(c.baseUrl && c.apiKey && c.model);
  }

  // ===== 弹窗 =====
  function open() {
    var report = state.get("report");
    if (!report || !(report.sections || []).length) {
      window.RF_UI.toast.warn("尚无内容可高亮");
      return;
    }

    var body = document.createElement("div");
    body.className = "rf-hl-dialog";

    var tip = document.createElement("div");
    tip.className = "rf-hl-dialog__tip";
    tip.textContent = llmConfigured()
      ? "勾选要高亮的类型，AI 将自动识别报告中的关键数字与关键结论并标注。"
      : "未配置 AI 模型，将使用本地规则识别（数字、加粗词、引号短语等）。可在「设置」中配置模型以获得更智能的结果。";
    body.appendChild(tip);

    var numChk  = checkboxRow("数字高亮", "识别关键数字、KPI、百分比、金额、同比环比等", true);
    var textChk = checkboxRow("文字高亮", "识别关键结论、核心观点、重要术语等", false);
    body.appendChild(numChk.row);
    body.appendChild(textChk.row);

    // 底部按钮
    var foot = document.createElement("div");
    foot.style.cssText = "display:flex;gap:8px;width:100%;align-items:center";

    var clearBtn = document.createElement("button");
    clearBtn.className = "rf-btn rf-btn--ghost";
    clearBtn.textContent = "清除全部高亮";

    var spacer = document.createElement("div");
    spacer.style.flex = "1";

    var startBtn = document.createElement("button");
    startBtn.className = "rf-btn rf-btn--primary";
    startBtn.textContent = "开始识别";

    foot.appendChild(clearBtn);
    foot.appendChild(spacer);
    foot.appendChild(startBtn);

    function selectedKinds() {
      var k = [];
      if (numChk.input.checked)  k.push("num");
      if (textChk.input.checked) k.push("text");
      return k;
    }
    function syncStart() {
      startBtn.disabled = selectedKinds().length === 0;
    }
    numChk.input.addEventListener("change", syncStart);
    textChk.input.addEventListener("change", syncStart);
    syncStart();

    var m = window.RF_UI.modal.open({
      title: "🖍️ 智能高亮",
      bodyEl: body,
      footerEl: foot,
      size: "md"
    });

    startBtn.addEventListener("click", function () {
      var kinds = selectedKinds();
      if (!kinds.length) { window.RF_UI.toast.warn("请至少选择一种高亮类型"); return; }
      m.close();
      runHighlight(kinds);
    });

    clearBtn.addEventListener("click", function () {
      window.RF_UI.confirm({
        title: "清除全部高亮？",
        body: "将移除正文与表格上的所有智能高亮标记。",
        danger: true,
        confirmLabel: "清除"
      }).then(function (ok) {
        if (!ok) return;
        clearAll();
      });
    });
  }

  function checkboxRow(label, hint, checked) {
    var row = document.createElement("label");
    row.className = "rf-hl-dialog__opt";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!checked;
    var txt = document.createElement("div");
    txt.className = "rf-hl-dialog__opt-txt";
    var t = document.createElement("div");
    t.className = "rf-hl-dialog__opt-label";
    t.textContent = label;
    var h = document.createElement("div");
    h.className = "rf-hl-dialog__opt-hint";
    h.textContent = hint;
    txt.appendChild(t);
    txt.appendChild(h);
    row.appendChild(input);
    row.appendChild(txt);
    return { row: row, input: input };
  }

  // ===== 主流程 =====
  function runHighlight(kinds) {
    var report = state.get("report");
    var useLLM = llmConfigured();

    if (!useLLM) {
      var local = localDetect(report, kinds);
      applyResult(report, local, kinds);
      return;
    }

    // 右下角实时回显面板（复用解析流程的浮窗）。
    var progress = window.RF_ParseProgress && window.RF_ParseProgress.start({
      startLabel: "准备高亮识别…",
      doneLabel:  "高亮完成",
      failLabel:  "高亮失败"
    });
    function onProgress(ev) { if (progress) progress.update(ev); }

    var sizing = measure(report);
    var whole = sizing.totalChars <= WHOLE_MAX_CHARS && sizing.sectionCount <= WHOLE_MAX_SECTIONS;
    log.info("smart-highlight: " + (whole ? "整体" : "按章节") +
             " (chars=" + sizing.totalChars + ", sections=" + sizing.sectionCount + ")");
    onProgress({
      phase: "request",
      message: whole ? "AI 识别中…（整体识别）"
                     : "AI 识别中…（按章节，共 " + sizing.sectionCount + " 章）"
    });

    var task = whole ? detectWhole(report, kinds, onProgress)
                     : detectPerSection(report, kinds, onProgress);
    task.then(function (result) {
      var counts = applyResult(report, result, kinds);
      if (progress) progress.success({
        summary: "已高亮 " + counts.textCount + " 处文本、" + counts.cellCount + " 个单元格"
      });
    }).catch(function (err) {
      log.warn("smart-highlight: LLM 失败，回退本地规则：" + (err && err.message || err));
      if (progress) progress.fail("AI 识别失败，已改用本地规则");
      window.RF_UI.toast.warn("AI 识别失败，已改用本地规则");
      var local = localDetect(report, kinds);
      applyResult(report, local, kinds);
    });
  }

  function measure(report) {
    var totalChars = 0;
    (report.sections || []).forEach(function (sec) {
      (sec.blocks || []).forEach(function (blk) {
        if (blk.type === "text") totalChars += (blk.content || "").length;
        else if (blk.type === "table") {
          ((blk.spec && blk.spec.rows) || []).forEach(function (row) {
            row.forEach(function (cell) { totalChars += String(cell.v == null ? "" : cell.v).length; });
          });
        }
      });
    });
    return { totalChars: totalChars, sectionCount: (report.sections || []).length };
  }

  // 收集待标注 payload。onlySection 指定时只收该章节。
  function collectPayload(report, onlySection) {
    var texts = [];
    var cells = [];
    (report.sections || []).forEach(function (sec, si) {
      if (onlySection != null && si !== onlySection) return;
      (sec.blocks || []).forEach(function (blk, bi) {
        if (blk.type === "text") {
          if ((blk.content || "").trim()) texts.push({ id: "s" + si + "-b" + bi, content: blk.content });
        } else if (blk.type === "table") {
          var rows = (blk.spec && blk.spec.rows) || [];
          var headerRows = (blk.spec && blk.spec.headerRows) || 1;
          rows.forEach(function (row, ri) {
            if (ri < headerRows) return; // 跳过表头
            row.forEach(function (cell, ci) {
              if (cell.hidden) return;
              var v = String(cell.v == null ? "" : cell.v);
              if (!v.trim()) return;
              cells.push({ id: "s" + si + "-b" + bi + "-r" + ri + "-c" + ci, v: v });
            });
          });
        }
      });
    });
    return { texts: texts, cells: cells };
  }

  function detectWhole(report, kinds, onProgress) {
    var payload = collectPayload(report, null);
    if (!payload.texts.length && !payload.cells.length) return Promise.resolve(emptyResult());
    return callLLM(payload, kinds, onProgress);
  }

  function detectPerSection(report, kinds, onProgress) {
    var sections = report.sections || [];
    var merged = emptyResult();
    var chain = Promise.resolve();
    sections.forEach(function (sec, si) {
      chain = chain.then(function () {
        var payload = collectPayload(report, si);
        if (!payload.texts.length && !payload.cells.length) return;
        if (onProgress) onProgress({
          phase: "request",
          message: "识别章节 " + (si + 1) + "/" + sections.length + "…"
        });
        return callLLM(payload, kinds, onProgress).then(function (r) {
          merged.textHighlights = merged.textHighlights.concat(r.textHighlights);
          merged.cellHighlights = merged.cellHighlights.concat(r.cellHighlights);
        }).catch(function (e) {
          // 单章失败不致命，跳过该章。
          log.warn("smart-highlight: 章节 " + si + " 识别失败：" + (e && e.message || e));
        });
      });
    });
    return chain.then(function () { return merged; });
  }

  function callLLM(payload, kinds, onProgress) {
    var messages = window.RF_Prompts.buildHighlightPrompt(payload, kinds);
    return window.RF_LLM.complete({
      messages: messages,
      jsonMode: true,
      temperature: 0.1,
      stream: true,
      onDelta: function (ev) {
        if (onProgress) onProgress({ phase: "stream", delta: ev.delta, kind: ev.kind, total: ev.total });
      }
    }).then(function (raw) {
      if (onProgress) onProgress({ phase: "parse-json", message: "解析结果…" });
      return normalizeResult(parseJsonLoose(raw), kinds);
    });
  }

  // 复用 parser.js 的容错思路。
  function parseJsonLoose(text) {
    if (text == null) return {};
    var s = String(text).trim();
    if (s.startsWith("```")) s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "");
    var first = s.indexOf("{"), last = s.lastIndexOf("}");
    if (first > 0 && last > first) s = s.slice(first, last + 1);
    try { return JSON.parse(s); } catch (e) { return {}; }
  }

  function emptyResult() { return { textHighlights: [], cellHighlights: [] }; }

  function normalizeResult(obj, kinds) {
    var out = emptyResult();
    obj = obj || {};
    (Array.isArray(obj.textHighlights) ? obj.textHighlights : []).forEach(function (h) {
      if (!h || typeof h.id !== "string" || typeof h.phrase !== "string") return;
      var kind = h.kind === "text" ? "text" : "num";
      if (kinds.indexOf(kind) < 0) return;
      if (!h.phrase) return;
      out.textHighlights.push({ id: h.id, phrase: h.phrase, kind: kind });
    });
    (Array.isArray(obj.cellHighlights) ? obj.cellHighlights : []).forEach(function (h) {
      if (!h || typeof h.id !== "string") return;
      var kind = h.kind === "text" ? "text" : "num";
      if (kinds.indexOf(kind) < 0) return;
      out.cellHighlights.push({ id: h.id, kind: kind });
    });
    return out;
  }

  // ===== 本地回退识别 =====
  function localDetect(report, kinds) {
    var result = emptyResult();
    var wantNum  = kinds.indexOf("num") >= 0;
    var wantText = kinds.indexOf("text") >= 0;

    (report.sections || []).forEach(function (sec, si) {
      (sec.blocks || []).forEach(function (blk, bi) {
        if (blk.type === "text") {
          var id = "s" + si + "-b" + bi;
          var content = blk.content || "";
          var seen = {};
          function push(phrase, kind) {
            phrase = (phrase || "").trim();
            if (!phrase) return;
            var key = kind + "::" + phrase;
            if (seen[key]) return;
            seen[key] = true;
            result.textHighlights.push({ id: id, phrase: phrase, kind: kind });
          }
          if (wantNum) {
            // 同比/环比 + 百分比、纯百分比、金额、带千分位/小数的数字
            var numRe = /(同比|环比)?[^，。；\s]{0,4}?[¥$￥]?\d[\d,.]*\s*%?/g;
            var mm, count = 0;
            while ((mm = numRe.exec(content)) && count < 6) {
              var s = mm[0].trim();
              if (/\d/.test(s) && s.length >= 2) { push(s, "num"); count++; }
            }
          }
          if (wantText) {
            var b; var bRe = /\*\*([^*]+)\*\*/g;
            while ((b = bRe.exec(content))) push(b[1], "text");
            var q; var qRe = /[「『"“]([^」』"”]{2,20})[」』"”]/g;
            while ((q = qRe.exec(content))) push(q[1], "text");
          }
        } else if (blk.type === "table" && wantNum) {
          var rows = (blk.spec && blk.spec.rows) || [];
          var cols = (blk.spec && blk.spec.columns) || [];
          var headerRows = (blk.spec && blk.spec.headerRows) || 1;
          rows.forEach(function (row, ri) {
            if (ri < headerRows) return;
            row.forEach(function (cell, ci) {
              if (cell.hidden) return;
              var fmt = cell.format || (cols[ci] && cols[ci].format);
              var isNum = (fmt && fmt.kind && fmt.kind !== "text" && fmt.kind !== "date") ||
                          (typeof cell.v === "number");
              if (isNum) {
                result.cellHighlights.push({ id: "s" + si + "-b" + bi + "-r" + ri + "-c" + ci, kind: "num" });
              }
            });
          });
        }
      });
    });
    return result;
  }

  // ===== 应用结果 =====
  function applyResult(report, result, kinds) {
    var rep = clone(report);
    var textCount = 0, cellCount = 0;

    // 先按 (si,bi) 聚合文本高亮，便于同一段一次处理。
    var byBlock = {};
    result.textHighlights.forEach(function (h) {
      (byBlock[h.id] = byBlock[h.id] || []).push(h);
    });

    Object.keys(byBlock).forEach(function (id) {
      var loc = parseTextId(id);
      if (!loc) return;
      var sec = rep.sections[loc.si];
      var blk = sec && sec.blocks[loc.bi];
      if (!blk || blk.type !== "text") return;
      var content = blk.content || "";
      byBlock[id].forEach(function (h) {
        var wrapped = wrapFirst(content, h.phrase, h.kind);
        if (wrapped.changed) { content = wrapped.content; textCount++; }
      });
      blk.content = content;
    });

    result.cellHighlights.forEach(function (h) {
      var loc = parseCellId(h.id);
      if (!loc) return;
      var sec = rep.sections[loc.si];
      var blk = sec && sec.blocks[loc.bi];
      if (!blk || blk.type !== "table") return;
      var row = blk.spec && blk.spec.rows && blk.spec.rows[loc.ri];
      var cell = row && row[loc.ci];
      if (!cell || cell.hidden) return;
      cell.style = cell.style || {};
      cell.style.hl = h.kind;
      cellCount++;
    });

    commit(rep);

    if (textCount + cellCount === 0) {
      window.RF_UI.toast.warn("未识别到可高亮的内容");
    } else {
      window.RF_UI.toast.ok("已高亮 " + textCount + " 处文本、" + cellCount + " 个单元格");
    }
    return { textCount: textCount, cellCount: cellCount };
  }

  // 在 content 中找 phrase 第一次出现（且不在已有 <mark> 内）的位置并包裹。
  function wrapFirst(content, phrase, kind) {
    if (!phrase) return { content: content, changed: false };
    var ranges = markRanges(content);
    var from = 0;
    while (true) {
      var idx = content.indexOf(phrase, from);
      if (idx < 0) return { content: content, changed: false };
      var end = idx + phrase.length;
      if (!overlapsAny(idx, end, ranges)) {
        var open = MARK_OPEN + kind + '">';
        var newContent = content.slice(0, idx) + open + phrase + "</mark>" + content.slice(end);
        return { content: newContent, changed: true };
      }
      from = idx + 1;
    }
  }

  // 返回 content 中已存在的 <mark class="rf-hl..">...</mark> 的字符区间，避免嵌套。
  function markRanges(content) {
    var ranges = [];
    var re = new RegExp(MARK_WRAP_RE.source, "g");
    var m;
    while ((m = re.exec(content))) ranges.push([m.index, m.index + m[0].length]);
    return ranges;
  }
  function overlapsAny(a, b, ranges) {
    for (var i = 0; i < ranges.length; i++) {
      if (a < ranges[i][1] && b > ranges[i][0]) return true;
    }
    return false;
  }

  function parseTextId(id) {
    var m = /^s(\d+)-b(\d+)$/.exec(id);
    return m ? { si: +m[1], bi: +m[2] } : null;
  }
  function parseCellId(id) {
    var m = /^s(\d+)-b(\d+)-r(\d+)-c(\d+)$/.exec(id);
    return m ? { si: +m[1], bi: +m[2], ri: +m[3], ci: +m[4] } : null;
  }

  // ===== 清除 =====
  function clearAll() {
    var rep = clone(state.get("report"));
    var removed = 0;
    (rep.sections || []).forEach(function (sec) {
      (sec.blocks || []).forEach(function (blk) {
        if (blk.type === "text" && blk.content) {
          var re = new RegExp(MARK_WRAP_RE.source, "g");
          if (re.test(blk.content)) {
            blk.content = blk.content.replace(new RegExp(MARK_WRAP_RE.source, "g"), "$1");
            removed++;
          }
        } else if (blk.type === "table") {
          ((blk.spec && blk.spec.rows) || []).forEach(function (row) {
            row.forEach(function (cell) {
              if (cell.style && cell.style.hl) { delete cell.style.hl; removed++; }
            });
          });
        }
      });
    });
    commit(rep);
    window.RF_UI.toast.ok(removed ? "已清除全部高亮" : "没有需要清除的高亮");
  }

  function commit(rep) {
    var v = schema.validate(rep);
    state.set("report", v.normalized);
    try {
      window.RF_Storage.set("draft", "current", v.normalized);
    } catch (e) { /* 持久化失败不阻塞 */ }
  }

  window.RF_SmartHighlight = { init: init, open: open };
})();

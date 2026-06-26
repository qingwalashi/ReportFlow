/**
 * chart-suggestion.js — 图表添加建议（针对自然语言录入原文）。
 *
 * 左侧底部「📊 图表建议」按钮 → 调用 LLM 识别左侧自然语言录入原文中适合加图表的数据段落
 * → 在录入原文对应段落末尾插入 [📊 建议添加XX图] 标记，便于用户后续补充图表。
 *
 * 标记格式：在适合添加图表的段落末尾插入 [📊 建议添加饼图/柱状图/折线图]
 *
 * 重要：此功能直接操作左侧自然语言录入框的原文，不重写内容，仅定位插入标记
 *
 * 公共：RF_ChartSuggestion.init() / .run()
 */
(function () {
  "use strict";

  var log = window.RF_Log;

  // 标记样式和正则
  var CHART_MARK = "[📊 建议添加{type}]";
  var CHART_MARK_RE = /\[📊\s*建议添加[^\]]+\]/g;

  // 分析体量阈值
  var MAX_PARAGRAPHS = 20;

  function init() {
    var btn = document.getElementById("rf-btn-chart-suggestion");
    if (btn) btn.addEventListener("click", run);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function llmConfigured() {
    return !!(window.RF_ConfigManager && window.RF_ConfigManager.isConfigured());
  }

  // ===== 主入口 =====
  function run() {
    // 获取左侧自然语言录入框的原文
    var inputEl = document.getElementById("rf-input-text");
    var inputText = (inputEl && inputEl.value) || "";
    if (!inputText.trim()) {
      window.RF_UI.toast.warn("请先在左侧自然语言录入框中输入内容");
      return;
    }

    // 检查是否已配置 LLM
    if (!llmConfigured()) {
      window.RF_UI.toast.warn("请先在「设置」配置大模型 API");
      window.RF_ConfigManager.openModal();
      return;
    }

    // 进度显示
    var progress = window.RF_ParseProgress && window.RF_ParseProgress.start({
      startLabel: "正在分析自然语言原文…",
      doneLabel:  "分析完成",
      failLabel:  "分析失败"
    });
    function onProgress(ev) { if (progress) progress.update(ev); }

    log.info("chart-suggestion: 分析自然语言原文（" + inputText.length + " 字符）");
    onProgress({ phase: "request", message: "AI 分析中…" });

    detectOnInputText(inputText, onProgress).then(function (result) {
      var count = applySuggestionsToInput(inputEl, result);
      if (progress) {
        if (count > 0) {
          progress.success({ summary: "已在 " + count + " 处插入图表建议标记" });
          window.RF_UI.toast.ok("已在自然语言原文中插入 " + count + " 处图表建议标记");
        } else {
          progress.success({ summary: "未识别到适合添加图表的数据段" });
          window.RF_UI.toast.show("未识别到适合添加图表的数据段，当前内容已足够清晰");
        }
      }
    }).catch(function (err) {
      log.warn("chart-suggestion: 分析失败：" + (err && err.message || err));
      if (progress) progress.fail("分析失败：" + (err && err.message || err));
      window.RF_UI.toast.err("分析失败：" + (err && err.message || err));
    });
  }

  // 将自然语言文本按段落分割
  function splitParagraphs(text) {
    var result = [];
    var paragraphs = text.split(/\n\n+/);
    var currentIndex = 0;
    paragraphs.forEach(function (p) {
      var trimmed = p.trim();
      if (trimmed) {
        var startIdx = text.indexOf(trimmed, currentIndex);
        var endIdx = startIdx + trimmed.length;
        result.push({
          id: "p" + result.length,
          content: trimmed,
          startIndex: startIdx,
          endIndex: endIdx
        });
        currentIndex = endIdx;
      }
    });
    return result;
  }

  function detectOnInputText(inputText, onProgress) {
    // 先移除已有的图表建议标记
    var cleanText = inputText.replace(CHART_MARK_RE, "").trim();
    if (!cleanText) return Promise.resolve(emptyResult());

    var paragraphs = splitParagraphs(cleanText);
    if (!paragraphs.length) return Promise.resolve(emptyResult());

    // 如果文本太长，分段处理
    if (paragraphs.length > MAX_PARAGRAPHS) {
      paragraphs = paragraphs.slice(0, MAX_PARAGRAPHS);
      log.info("chart-suggestion: 段落过多，仅分析前 " + MAX_PARAGRAPHS + " 段");
    }

    var payload = { texts: paragraphs };
    return callLLM(payload, onProgress);
  }

  function callLLM(payload, onProgress) {
    var messages = buildChartSuggestionPrompt(payload);
    return window.RF_LLM.complete({
      messages: messages,
      jsonMode: true,
      temperature: 0.2,
      stream: true,
      onDelta: function (ev) {
        if (onProgress) onProgress({ phase: "stream", delta: ev.delta, kind: ev.kind, total: ev.total });
      }
    }).then(function (raw) {
      if (onProgress) onProgress({ phase: "parse-json", message: "解析结果…" });
      return normalizeResult(parseJsonLoose(raw));
    });
  }

  function buildChartSuggestionPrompt(payload) {
    var system = [
      "你是一名专业的数据分析助手，擅长识别报告中适合用图表展示的数据段。",
      "",
      "任务说明：",
      "1. 分析用户提供的每个文本段落，判断是否包含适合用图表展示的数据。",
      "2. 只对包含以下特征的数据段提出建议：",
      "   - 多个类别的数值对比（如各部门营收、各产品销量、各地区占比）",
      "   - 时间序列数据（如月度趋势、季度变化、年度增长）",
      "   - 百分比分布或占比数据",
      "   - 至少包含 3 个以上的数值数据点",
      "3. 如果段落只是纯文字描述、没有具体数值、或数据点少于 3 个，不要建议。",
      "4. 根据数据特点选择最合适的图表类型：",
      "   - 饼图：适合展示占比、份额、构成比例数据",
      "   - 柱状图：适合展示不同类别间的对比",
      "   - 折线图：适合展示时间趋势、连续变化",
      "5. 输出严格的 JSON 格式，不要输出其他解释文字。",
      "",
      "JSON 输出格式：",
      "{",
      '  "suggestions": [',
      '    { "id": "段落ID", "chartType": "饼图|柱状图|折线图", "reason": "简短说明，不超过20字" }',
      "  ]",
      "}",
      "",
      "重要提醒：",
      "- 只对确实包含数据的段落提出建议，宁缺毋滥",
      "- 如果没有任何段落适合添加图表，返回空数组：{\"suggestions\": []}",
      "- chartType 只能是「饼图」、「柱状图」、「折线图」这三个值之一"
    ].join("\n");

    var userText = payload.texts.map(function (t) {
      return "【段落 ID: " + t.id + "】\n" + t.content;
    }).join("\n\n");

    return [
      { role: "system", content: system },
      { role: "user", content: userText }
    ];
  }

  function parseJsonLoose(text) {
    if (text == null) return {};
    var s = String(text).trim();
    if (s.startsWith("```")) s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "");
    var first = s.indexOf("{"), last = s.lastIndexOf("}");
    if (first > 0 && last > first) s = s.slice(first, last + 1);
    try { return JSON.parse(s); } catch (e) { return {}; }
  }

  function emptyResult() { return { suggestions: [] }; }

  function normalizeResult(obj) {
    var out = emptyResult();
    obj = obj || {};
    var validTypes = { "饼图": true, "柱状图": true, "折线图": true };
    (Array.isArray(obj.suggestions) ? obj.suggestions : []).forEach(function (s) {
      if (!s || typeof s.id !== "string") return;
      var chartType = String(s.chartType || "").trim();
      if (!validTypes[chartType]) return;
      var reason = String(s.reason || "").trim();
      out.suggestions.push({ id: s.id, chartType: chartType, reason: reason });
    });
    return out;
  }

  // ===== 应用建议到自然语言输入框 =====
  function applySuggestionsToInput(inputEl, result) {
    if (!inputEl || !result || !result.suggestions || !result.suggestions.length) {
      return 0;
    }

    var originalText = inputEl.value;
    var paragraphs = splitParagraphs(originalText);
    // 从后往前处理，避免前面的插入影响后面的索引
    var reversedSuggestions = result.suggestions.slice().reverse();
    var insertedCount = 0;

    reversedSuggestions.forEach(function (s) {
      // 解析段落索引（id格式：p0, p1, p2...）
      var m = /^p(\d+)$/.exec(s.id);
      if (!m) return;
      var pIdx = +m[1];
      var paragraph = paragraphs[pIdx];
      if (!paragraph) return;

      // 检查该段落是否已有相同类型的标记，避免重复
      var existingMark = CHART_MARK.replace("{type}", s.chartType);
      var pContent = originalText.slice(paragraph.startIndex, paragraph.endIndex);
      if (pContent.indexOf(existingMark) >= 0) return;

      // 构建标记
      var mark = CHART_MARK.replace("{type}", s.chartType);
      if (s.reason) {
        mark = CHART_MARK.replace("{type}", s.chartType + "：" + s.reason);
      }

      // 找到插入位置：在段落末尾（句号之前）
      var insertPos = paragraph.endIndex;
      var pEndText = originalText.slice(insertPos - 2, insertPos);
      // 如果段落末尾有句号、感叹号等标点，在标点前插入
      if (/[。！？.!?]/.test(pEndText)) {
        // 找最后一个标点的位置
        for (var i = insertPos - 1; i >= paragraph.startIndex; i--) {
          var c = originalText.charAt(i);
          if (/[。！？.!?]/.test(c)) {
            insertPos = i;
            break;
          }
        }
      }

      // 插入标记
      inputEl.value = originalText.slice(0, insertPos) + " " + mark + originalText.slice(insertPos);
      originalText = inputEl.value;
      insertedCount++;

      // 重新计算所有段落位置（因为插入后后面的索引都变了）
      paragraphs = splitParagraphs(originalText);
    });

    // 触发 input 事件，让其他监听者（如自动保存）知道内容变了
    if (insertedCount > 0) {
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    }

    return insertedCount;
  }

  window.RF_ChartSuggestion = { init: init, run: run };
})();

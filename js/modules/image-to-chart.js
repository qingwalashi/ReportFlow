/**
 * image-to-chart.js — 把图片发给多模态大模型，按本项目的图表规范识别为 ChartSpec。
 *
 * 入口：RF_ImageToChart.convert(file, onProgress?) -> Promise<ChartSpec | null>
 *   - 成功识别为图表：resolve 一个符合 schema 的 ChartSpec
 *       { kind: "pie"|"bar"|"line", categories, series:[{name,data}], unit, title }
 *   - 不适合转图表：resolve null（调用方据此提示「未识别到图表内容」）
 *   - 调用出错：reject Error（网络/未配置/超时等，由调用方决定怎么提示）
 *
 * 使用 OpenAI Vision 风格的消息：content 为数组，混入
 *   { type: "image_url", image_url: { url: "data:image/...;base64,..." } }
 * 适用于支持视觉的 OpenAI 兼容模型（GPT-4o、Qwen-VL、GLM-4V、Doubao-Vision 等）。
 */
(function () {
  "use strict";

  var log = window.RF_Log;

  // 与 schema.js 的 CHART_KINDS / fixChartSpec 保持一致。
  var KIND_MAP = {
    "pie": "pie", "bar": "bar", "line": "line",
    "饼图": "pie", "柱状图": "bar", "条形图": "bar", "折线图": "line", "曲线图": "line"
  };

  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      if (!(file instanceof Blob)) {
        reject(new Error("无效的文件"));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || "")); };
      reader.onerror = function () { reject(reader.error || new Error("读取图片失败")); };
      reader.readAsDataURL(file);
    });
  }

  // 中文别名 → 英文 kind
  var KIND_LABEL = { pie: "饼图", bar: "柱状图", line: "折线图" };

  function buildMessages(dataUrl, forceKind) {
    var system;
    if (forceKind && KIND_LABEL[forceKind]) {
      // 「指定类型」模式：用户已明确要哪种图，模型只负责抽数据。
      // 即使图里画的是另一种图表，也尽力把可对应的数据按用户指定的类型组织起来。
      var zh = KIND_LABEL[forceKind];
      system = [
        "你是一名报告图表识别助手。用户已经指定了希望输出的图表类型，",
        "你的任务是【尽力】从图片中抽取与之匹配的数据，而不是再次判断图表类型。",
        "",
        "用户指定的图表类型：" + forceKind + "（" + zh + "）",
        "",
        "工作流程：",
        "1) 仔细观察图片，理解其中的可量化数据（不论图片本身是哪种图表，甚至是表格、数据列表，",
        "   只要能合理映射成 " + zh + " 的『类别 + 数值』，就尽量抽取）。",
        "2) 把数据组织为下面的 JSON（kind 必须是 " + forceKind + "）：",
        "   {",
        '     "suitable": true,',
        '     "title": "<图表标题（看图上方/下方/标题；若无可写空串）>",',
        '     "spec": {',
        '       "kind": "' + forceKind + '",',
        '       "categories": ["类别1", "类别2", ...],',
        '       "series": [ { "name": "系列名", "data": [数字1, 数字2, ...] } ],',
        '       "unit": "<单位，例如 \\"%\\"、\\"万元\\"，没有就写空串>"',
        "     }",
        "   }",
        "3) 只有当图片里【完全没有】可读出的数值（如纯照片、装饰图、UI 截图、二维码、",
        "   流程图等没有数字的内容），才返回：",
        '   { "suitable": false, "reason": "<不超过 30 字>" }',
        "",
        "硬性要求：",
        "- 仅输出一个 JSON 对象，不要解释、不要 markdown 代码块。",
        "- kind 必须严格等于 \"" + forceKind + "\"，不要替换为其他类型。",
        "- categories 与 series[].data 长度必须一致；series[].data 全部为数字（不要带百分号、不要带千分位逗号；百分比就把单位写成 \"%\"，数值仍是去掉 % 后的数字）。",
        (forceKind === "pie"
          ? "- 饼图（pie）只能有一个 series，series[0].data 与 categories 一一对应；如果原图是多系列，请聚合或取主要系列。"
          : "- 多系列数据（如分组柱/堆叠/多折线）请如实拆成多个 series，每个 series 都对应同一组 categories。"),
        "- 若部分数值不易精确读出，按肉眼最接近的值合理估计；不要编造与图明显不符的数据。"
      ].join("\n");
    } else {
      // 「自动识别」模式：模型自己判断图表类型。
      system = [
        "你是一名报告图表识别助手，擅长把图片中的图表（饼图、柱状图/条形图、折线图）还原为结构化数据。",
        "",
        "任务说明：",
        "1) 仔细观察图片。判断它是否是一张可以转化为本系统图表的数据图：",
        "   - 适合：饼图/环形图、柱状图/条形图、折线图/曲线图，且能从图中读出明确的类别与数值。",
        "   - 不适合：照片、风景、人物、流程图、思维导图、示意图、纯文字截图、组织架构、地图、UI 截图、二维码等。",
        "2) 如果适合：把图中的数据原样抽取出来，输出严格 JSON：",
        "   {",
        '     "suitable": true,',
        '     "title": "<图表标题（看图上方/下方/标题；若无可写空串）>",',
        '     "spec": {',
        '       "kind": "pie" | "bar" | "line",',
        '       "categories": ["类别1", "类别2", ...],',
        '       "series": [ { "name": "系列名", "data": [数字1, 数字2, ...] } ],',
        '       "unit": "<单位，例如 \\"%\\"、\\"万元\\"，没有就写空串>"',
        "     }",
        "   }",
        "3) 如果不适合：输出",
        '   { "suitable": false, "reason": "<不超过 30 字的简短原因>" }',
        "",
        "硬性要求：",
        "- 仅输出一个 JSON 对象，不要解释、不要 markdown 代码块。",
        "- kind 只能是 pie / bar / line 三个值之一（必须用英文小写）。",
        "- categories 与 series[].data 长度必须一致；series[].data 全部为数字（不要带百分号、不要带千分位逗号；百分比就把单位写成 \"%\"，数值仍是去掉 % 后的数字）。",
        "- 若图中数值无法精确读出，请按肉眼最接近的值合理估计，不要编造与图明显不符的数据；若大半数值都无法判读，按 suitable=false 返回。",
        "- 多系列图（堆叠柱/分组柱/多折线）请如实拆成多个 series，每个 series 都对应同一组 categories。",
        "- 饼图（pie）只能有一个 series，series[0].data 与 categories 一一对应。",
        "- 不要把照片、流程图、UI 截图、思维导图当成图表。"
      ].join("\n");
    }

    var userText = forceKind && KIND_LABEL[forceKind]
      ? "请按 " + KIND_LABEL[forceKind] + "（" + forceKind + "）抽取这张图片中的数据，并仅输出符合规范的 JSON。"
      : "请按要求识别这张图片，并仅输出符合规范的 JSON。";

    var userParts = [
      { type: "text", text: userText },
      { type: "image_url", image_url: { url: dataUrl } }
    ];

    return [
      { role: "system", content: system },
      { role: "user", content: userParts }
    ];
  }

  function parseJsonLoose(text) {
    if (text == null) return null;
    var s = String(text).trim();
    if (s.startsWith("```")) s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "");
    var first = s.indexOf("{"), last = s.lastIndexOf("}");
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  // 规范化 + 校验模型输出。返回 { suitable, spec?, title?, reason? }。
  // forceKind 非空时：哪怕模型返回的 kind 不对，也强制矫正为用户选择的类型。
  function normalize(obj, forceKind) {
    if (!obj || typeof obj !== "object") return { suitable: false, reason: "模型返回为空或不可解析" };

    // 「不适合」分支
    if (obj.suitable === false) {
      return { suitable: false, reason: String(obj.reason || "").slice(0, 60) };
    }

    var spec = obj.spec || obj;          // 兼容模型把字段平铺在最外层
    if (!spec || typeof spec !== "object") return { suitable: false, reason: "返回缺少 spec" };

    var kind;
    if (forceKind && KIND_MAP[forceKind]) {
      // 用户已指定类型：直接用，不再看模型给的 kind。
      kind = forceKind;
    } else {
      kind = KIND_MAP[String(spec.kind || "").toLowerCase()] || KIND_MAP[String(spec.kind || "")];
      if (!kind) return { suitable: false, reason: "图表类型不在 pie/bar/line 之列" };
    }

    var categories = Array.isArray(spec.categories) ? spec.categories.map(function (c) { return String(c).trim(); }).filter(Boolean) : [];
    if (categories.length < 2) return { suitable: false, reason: "类别少于 2 项，无法构成图表" };

    var rawSeries = Array.isArray(spec.series) ? spec.series : [];
    if (!rawSeries.length) return { suitable: false, reason: "未抽取到任何数据系列" };

    var series = rawSeries.map(function (s, idx) {
      var name = (s && typeof s.name === "string" && s.name.trim()) ? s.name.trim() : ("系列 " + (idx + 1));
      var data = Array.isArray(s && s.data) ? s.data.map(function (v) {
        if (typeof v === "number" && isFinite(v)) return v;
        var n = Number(String(v == null ? "" : v).replace(/[,，\s%％]/g, ""));
        return isFinite(n) ? n : 0;
      }) : [];
      // 对齐 categories 长度
      if (data.length < categories.length) {
        while (data.length < categories.length) data.push(0);
      } else if (data.length > categories.length) {
        data = data.slice(0, categories.length);
      }
      return { name: name, data: data };
    });

    // 饼图只保留第一组
    if (kind === "pie") series = series.slice(0, 1);

    // 全 0 的系列说明没真抽到数，否定掉
    var anyNonZero = series.some(function (s) { return s.data.some(function (v) { return v !== 0; }); });
    if (!anyNonZero) return { suitable: false, reason: "未从图中读出有效数值" };

    var unit = "";
    if (typeof spec.unit === "string") unit = spec.unit.trim();
    // 去掉模型偶尔写成的「单位：」前缀
    unit = unit.replace(/^单位[:：]\s*/, "");

    var title = "";
    if (typeof obj.title === "string") title = obj.title.trim();
    else if (typeof spec.title === "string") title = spec.title.trim();

    return {
      suitable: true,
      title: title,
      spec: { kind: kind, categories: categories, series: series, unit: unit }
    };
  }

  function llmConfigured() {
    return !!(window.RF_ConfigManager && window.RF_ConfigManager.isConfiguredVision && window.RF_ConfigManager.isConfiguredVision());
  }

  /**
   * 主入口。
   * @param {File|Blob} file 要识别的图片
   * @param {object} [opts]
   * @param {"auto"|"pie"|"bar"|"line"} [opts.forceKind="auto"] 用户指定的图表类型；非 auto 时模型会尽力按该类型抽数据
   * @param {(ev:{phase:string,message?:string,delta?:string,total?:number})=>void} [opts.onProgress]
   * @returns {Promise<{title:string, spec:object} | null>} 成功 → {title, spec}；不适合 → null
   */
  function convert(file, opts) {
    // 兼容旧签名 convert(file, onProgressFn)
    if (typeof opts === "function") opts = { onProgress: opts };
    opts = opts || {};
    var onProgress = opts.onProgress;
    var rawForce = String(opts.forceKind || "auto").toLowerCase();
    var forceKind = (rawForce === "pie" || rawForce === "bar" || rawForce === "line") ? rawForce : null;

    if (!llmConfigured()) {
      return Promise.reject(new Error("尚未配置「多模态模型」。请在「设置 → 多模态模型」中填写支持视觉的模型，例如 GPT-4o、Qwen-VL、GLM-4V、Doubao-Vision 等。"));
    }
    var cfg = window.RF_ConfigManager.getVision && window.RF_ConfigManager.getVision();
    if (cfg && cfg.api === "dify") {
      return Promise.reject(new Error("Dify Chatflow 暂不支持「图片转图表」，请在「设置 → 多模态模型」中切换到 OpenAI 兼容的多模态模型"));
    }
    if (!file || !(file instanceof Blob)) {
      return Promise.reject(new Error("没有提供有效的图片文件"));
    }
    // 粗粒度大小保护：超过 8MB 的图片让模型很慢且容易触发服务商上限。
    if (file.size > 8 * 1024 * 1024) {
      return Promise.reject(new Error("图片过大（>8MB），请压缩后再试"));
    }

    function emit(ev) { try { onProgress && onProgress(ev); } catch (e) {} }

    emit({ phase: "encode", message: "读取图片…" });
    return fileToDataUrl(file).then(function (dataUrl) {
      emit({ phase: "request", message: forceKind ? ("按 " + KIND_LABEL[forceKind] + " 识别中…") : "AI 识别中…" });
      var messages = buildMessages(dataUrl, forceKind);
      return window.RF_LLM.complete({
        config: cfg,
        messages: messages,
        jsonMode: true,
        temperature: 0.1,
        // 视觉识别通常较慢，给到 90s
        timeoutMs: 90000,
        stream: true,
        onDelta: function (ev) {
          emit({ phase: "stream", delta: ev.delta, total: ev.total, kind: ev.kind });
        }
      }).catch(function (err) {
        // 当前模型不支持视觉输入时，服务端 400 的报错里通常会出现
        // image_url / multimodal / vision / not support image 等关键字。
        // 抹掉冗长的服务端原文，给出一句对用户有指导意义的提示。
        var msg = (err && err.message) || String(err);
        var lower = msg.toLowerCase();
        var looksLikeNoVision =
              lower.indexOf("image_url") >= 0 ||
              lower.indexOf("image url") >= 0 ||
              lower.indexOf("multimodal") >= 0 ||
              lower.indexOf("multi-modal") >= 0 ||
              lower.indexOf("vision") >= 0 ||
              lower.indexOf("not support image") >= 0 ||
              lower.indexOf("does not support image") >= 0 ||
              lower.indexOf("unsupported content") >= 0 ||
              lower.indexOf("unknown variant") >= 0;
        if (looksLikeNoVision) {
          var cfg2 = window.RF_ConfigManager && window.RF_ConfigManager.getVision && window.RF_ConfigManager.getVision();
          var modelName = (cfg2 && cfg2.model) || "当前模型";
          var ne = new Error(
            "「" + modelName + "」不支持图片输入。请在「设置 → 多模态模型」中切换到支持视觉的模型，"
            + "例如：GPT-4o / GPT-4o-mini、Qwen-VL-Plus / Qwen-VL-Max、GLM-4V、"
            + "Doubao-Vision、Gemini 1.5、Claude 3.5 Sonnet 等。"
          );
          ne.cause = err;
          throw ne;
        }
        throw err;
      });
    }).then(function (raw) {
      emit({ phase: "parse-json", message: "解析结果…" });
      var parsed = parseJsonLoose(raw);
      var norm = normalize(parsed, forceKind);
      if (log) {
        if (norm.suitable) {
          log.info("image-to-chart: ok kind=" + norm.spec.kind + " categories=" + norm.spec.categories.length
                   + (forceKind ? " (forced)" : ""));
        } else {
          log.info("image-to-chart: not suitable — " + (norm.reason || "")
                   + (forceKind ? " (forced=" + forceKind + ")" : ""));
        }
      }
      if (!norm.suitable) return null;
      return { title: norm.title || "", spec: norm.spec };
    });
  }

  window.RF_ImageToChart = { convert: convert };
})();

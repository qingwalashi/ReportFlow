/**
 * prompt-builder.js — assemble the system prompt + few-shot for the parser.
 *
 * The model is instructed to emit ONLY a JSON object matching our schema,
 * with no commentary, no markdown fences. The few-shot example demonstrates
 * the canonical structure on a tiny input.
 */
(function () {
  "use strict";

  var SCHEMA_TEXT = [
    "JSON Schema (compact):",
    "{",
    '  "schemaVersion": 1,',
    '  "meta": {',
    '    "title": string, "subtitle"?: string, "author"?: string,',
    '    "date"?: string (YYYY-MM-DD), "tags"?: string[]',
    '  },',
    '  "sections": [',
    '    {',
    '      "id": string (e.g. "s-1"),',
    '      "heading": string,',
    '      "level": 1|2|3,',
    '      "blocks": [',
    '        { "type":"text", "format":"markdown", "content": string }',
    '        | { "type":"chart", "title": string, "spec": {',
    '             "kind":"pie"|"bar"|"line",',
    '             "categories": string[],',
    '             "series": [{ "name": string, "data": number[] }],',
    '             "unit"?: string',
    '           } }',
    '        | { "type":"image", "assetId": null, "src": null, "caption": string }',
    '      ]',
    '    }',
    '  ]',
    "}"
  ].join("\n");

  var SYSTEM_PROMPT = [
    "你是结构化报告解析器。你的任务是把用户提供的中文/英文自然语言汇报文本转换为严格符合给定 JSON Schema 的 JSON 对象。",
    "",
    "硬性要求：",
    "1) 只输出一个合法的 JSON 对象，不输出任何解释、不要用 markdown 代码块包裹。",
    "2) 字段必须严格匹配 schema；缺失信息使用合理占位（空字符串、空数组、占位值）。",
    "3) 文本块 (type:text) 的 content 使用 markdown 语法保留原文重点：用 **加粗** 突出关键数据，用列表组织并列项。",
    "4) 一旦原文出现「饼图 / 柱状图 / 折线图」、「占比 / 分布」、「环比 / 同比」、「走势 / 趋势」等线索，或包含可量化的多组数字，就生成对应的 chart 块。",
    "5) chart.spec.kind 仅取 pie / bar / line。pie 用于占比/分布，bar 用于跨类别对比，line 用于时间序列走势。",
    "6) chart.spec.series[].data 全部为 number；如原文是百分比，把 % 去掉、unit 设为 \"%\"。",
    "7) image 块仅在用户文本明确提及「现场图 / 截图 / 配图」等时插入；assetId 与 src 都置为 null（用户后续会自己上传）。",
    "8) section.heading 优先沿用原文一级标题（一、二、三…）；找不到则按主题划分 3-5 个章节。",
    "9) meta.title 如缺失，请基于内容主题生成简洁标题。date 如缺失，留空字符串。",
    "",
    SCHEMA_TEXT
  ].join("\n");

  var FEW_SHOT_USER = [
    "本季度销售额：华东 120 万、华南 80 万、华北 50 万。客户满意度从 88 提升到 92。下季度计划重点拓展华北。请配饼图。"
  ].join("\n");

  var FEW_SHOT_ASSISTANT = JSON.stringify({
    schemaVersion: 1,
    meta: { title: "季度销售概况", subtitle: "", author: "", date: "", tags: [] },
    sections: [
      {
        id: "s-1", heading: "一、销售概况", level: 1,
        blocks: [
          { type: "text", format: "markdown", content: "本季度销售额按大区分布：**华东 120 万**、华南 80 万、华北 50 万。客户满意度从 88 提升到 **92**。" },
          { type: "chart", title: "销售额按大区分布",
            spec: { kind: "pie", categories: ["华东", "华南", "华北"],
                    series: [{ name: "销售额", data: [120, 80, 50] }], unit: "万元" } }
        ]
      },
      {
        id: "s-2", heading: "二、下季度计划", level: 1,
        blocks: [
          { type: "text", format: "markdown", content: "重点拓展 **华北** 大区。" }
        ]
      }
    ]
  });

  function buildParsePrompt(userText) {
    return [
      { role: "system",    content: SYSTEM_PROMPT },
      { role: "user",      content: FEW_SHOT_USER },
      { role: "assistant", content: FEW_SHOT_ASSISTANT },
      { role: "user",      content: "请把以下文本结构化为 JSON：\n\n" + (userText || "") }
    ];
  }

  function buildRepairPrompt(brokenText, errorMsg) {
    return [
      { role: "system", content: "你是 JSON 修复器。输入是一个试图符合给定 schema 但解析失败的字符串，请返回修复后的合法 JSON 对象，不要解释。" + "\n" + SCHEMA_TEXT },
      { role: "user",   content: "解析错误：" + (errorMsg || "JSON.parse failed") + "\n\n原始内容：\n" + brokenText }
    ];
  }

  window.RF_Prompts = {
    buildParsePrompt: buildParsePrompt,
    buildRepairPrompt: buildRepairPrompt
  };
})();

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
    '        | { "type":"table", "title": string, "caption": string, "spec": {',
    '             "columns": [{ "key": string, "header": string,',
    '                           "align"?: "left"|"center"|"right",',
    '                           "format"?: { "kind":"text"|"number"|"percent"|"currency", "decimals"?: number, "thousands"?: boolean, "prefix"?: string, "suffix"?: string } }],',
    '             "rows": [[ { "v": string|number,',
    '                          "rowspan"?: number, "colspan"?: number, "hidden"?: boolean,',
    '                          "style"?: { "align"?: "left"|"center"|"right", "bold"?: boolean, "color"?: string, "bg"?: string },',
    '                          "format"?: same-as-column-format } ]],',
    '             "headerRows": number (default 1),',
    '             "footerRows": number (default 0),',
    '             "unit"?: string',
    '           } }',
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
    "7b) 若原文中出现形如 [[RF-IMG:xxxx]] 的标记（来自 Word 导入的图片占位符），必须把该标记原样、逐字保留在所在位置的 text 块 content 中，不要翻译、改写、删除或移动它，也不要为它生成 image 块——系统会在解析后自动替换为真实图片。",
    "8) section.heading 优先沿用原文一级标题（一、二、三…）；找不到则按主题划分 3-5 个章节。",
    "9) meta.title 如缺失，请基于内容主题生成简洁标题。date 如缺失，留空字符串。",
    "10) 表格识别：当原文出现「表格 / 明细 / 清单 / 对照表 / 一览表」，或包含 ≥2 列 × ≥3 行的并列结构化数据（含 TSV、HTML <table>、Markdown 表格、Excel 粘贴的多列内容），输出 type=table。",
    "    - columns[].header 写入列名；rows 是二维数组，每个 cell 必须是对象 { \"v\": ... }，不要用裸字符串。",
    "    - 单元格内若含多行内容（如项目描述、备注、多行地址、换行后的补充说明），在 cell.v 中用 \\n 表示换行，渲染时会保留为换行；不要为了规避换行而把一个单元格拆成多列或多行。",
    "    - 数字字段必须填到 cell.v 为 number（不要带千分位逗号、不要带 %），并通过 cell.format（或 column.format）记录显示格式：百分比的内部值是小数，例如 12.34% 存为 0.1234 + format={kind:\"percent\", decimals:2}。",
    "    - 不要凭空合并单元格——除非原文明示说「合并」或在多行的同一列重复同一标签作为分组。",
    "    - 表格标题写入 title；单位说明（如「单位：万元」）写入 spec.unit；脚注/来源写入 caption。",
    "    - 既可以从已有的 Excel/TSV 数据生成 table，也可以从「Q1 销售额：华东 120、华北 80、华南 60」这样的并列描述生成 2 列 N 行的简单表。",
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

  // 第二个 few-shot：表格识别（既来自描述、也带数字格式）
  var FEW_SHOT_TABLE_USER = [
    "整理一下三个产品线的成本和毛利明细，做成表格：A 产品成本 120 万、收入 200 万；B 产品成本 80 万、收入 150 万；C 产品成本 60 万、收入 90 万。单位都是万元。"
  ].join("\n");

  var FEW_SHOT_TABLE_ASSISTANT = JSON.stringify({
    schemaVersion: 1,
    meta: { title: "产品线成本毛利明细", subtitle: "", author: "", date: "", tags: [] },
    sections: [
      {
        id: "s-1", heading: "一、明细", level: 1,
        blocks: [
          {
            type: "table",
            title: "产品线成本与毛利",
            caption: "",
            spec: {
              columns: [
                { key: "c0", header: "产品线", align: "left" },
                { key: "c1", header: "成本",   align: "right", format: { kind: "number", decimals: 0, thousands: true } },
                { key: "c2", header: "收入",   align: "right", format: { kind: "number", decimals: 0, thousands: true } },
                { key: "c3", header: "毛利",   align: "right", format: { kind: "number", decimals: 0, thousands: true } }
              ],
              rows: [
                [ { v: "A 产品" }, { v: 120 }, { v: 200 }, { v:  80 } ],
                [ { v: "B 产品" }, { v:  80 }, { v: 150 }, { v:  70 } ],
                [ { v: "C 产品" }, { v:  60 }, { v:  90 }, { v:  30 } ]
              ],
              headerRows: 1,
              footerRows: 0,
              unit: "万元"
            }
          }
        ]
      }
    ]
  });

  function buildParsePrompt(userText) {
    return [
      { role: "system",    content: SYSTEM_PROMPT },
      { role: "user",      content: FEW_SHOT_USER },
      { role: "assistant", content: FEW_SHOT_ASSISTANT },
      { role: "user",      content: FEW_SHOT_TABLE_USER },
      { role: "assistant", content: FEW_SHOT_TABLE_ASSISTANT },
      { role: "user",      content: "请把以下文本结构化为 JSON：\n\n" + (userText || "") }
    ];
  }

  function buildRepairPrompt(brokenText, errorMsg) {
    return [
      { role: "system", content: "你是 JSON 修复器。输入是一个试图符合给定 schema 但解析失败的字符串，请返回修复后的合法 JSON 对象，不要解释。" + "\n" + SCHEMA_TEXT },
      { role: "user",   content: "解析错误：" + (errorMsg || "JSON.parse failed") + "\n\n原始内容：\n" + brokenText }
    ];
  }

  // ===== 智能高亮 =====
  // 让模型在已结构化的报告片段里挑出「关键数字」和/或「关键结论」并标注坐标，
  // 而不是改写原文。payload 由 smart-highlight.js 组装：
  //   { texts: [{ id, content }], cells: [{ id, v }] }
  // kinds 是启用的高亮类型数组，取值 "num" / "text"。
  function buildHighlightPrompt(payload, kinds) {
    var wantNum  = kinds.indexOf("num") >= 0;
    var wantText = kinds.indexOf("text") >= 0;

    var rules = [
      "你是报告重点标注助手。下面给出一份报告里若干文本段（texts）和表格单元格（cells），",
      "每项都带唯一 id。请识别其中值得高亮的内容，仅返回一个 JSON 对象，不要解释、不要 markdown 代码块。",
      "",
      "启用的高亮类型：" + (wantNum ? "num（关键数字/KPI/百分比/金额/同比环比） " : "") + (wantText ? "text（关键结论/重要术语/核心观点）" : ""),
      "只输出已启用类型的标注；未启用的类型一律不要出现。",
      "",
      "输出格式：",
      "{",
      '  "textHighlights": [ { "id": "<文本段 id>", "phrase": "<必须是该段 content 中可精确匹配的连续子串>", "kind": "num"|"text" } ],',
      '  "cellHighlights": [ { "id": "<单元格 id>", "kind": "num"|"text" } ]',
      "}",
      "",
      "要求：",
      "1) phrase 必须是对应文本段 content 里【原样存在】的子串（含标点/数字），不要改写、不要拼接跨句内容。",
      "2) 每段最多标注 1-3 个最关键的片段，宁缺毋滥，避免整段泛标。",
      "3) 表头/单位/说明类单元格不要标注；cells 里只标真正承载关键数值或结论的格子。",
      "4) 若某段/某格没有值得高亮的内容，就不要为它输出任何项。",
      "5) kind 只能是已启用类型之一。"
    ].join("\n");

    return [
      { role: "system", content: rules },
      { role: "user",   content: "待标注数据（JSON）：\n" + JSON.stringify(payload) }
    ];
  }

  window.RF_Prompts = {
    buildParsePrompt: buildParsePrompt,
    buildRepairPrompt: buildRepairPrompt,
    buildHighlightPrompt: buildHighlightPrompt
  };
})();

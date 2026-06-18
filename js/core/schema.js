/**
 * schema.js — pure-JS validator for the Report JSON contract.
 *
 * Returns: { ok: bool, errors: [{path, msg}], normalized: <coerced object> }
 *
 * Philosophy: be lenient on input (LLMs drift), strict on output. validateAndFix()
 * coerces missing fields to safe defaults so the editor and templates never
 * crash on a half-formed structure.
 */
(function () {
  "use strict";

  var SCHEMA_VERSION = 1;

  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
  function isArr(v) { return Array.isArray(v); }
  function isStr(v) { return typeof v === "string"; }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function uid(prefix) {
    return (prefix || "id-") + Math.random().toString(36).slice(2, 9);
  }

  var CHART_KINDS = ["pie", "bar", "line"];
  var STYLE_ALIGN = ["left", "center", "right"];
  var STYLE_BORDER = ["none", "thin", "thick"];
  var FORMAT_KINDS = ["text", "number", "percent", "currency", "date"];
  var MAX_TABLE_ROWS = 200;
  var MAX_TABLE_COLS = 30;

  function validateAndFix(input) {
    var errors = [];
    var data = isObj(input) ? input : {};

    var out = {
      schemaVersion: SCHEMA_VERSION,
      meta: fixMeta(data.meta, errors),
      sections: fixSections(data.sections, errors)
    };
    return { ok: errors.length === 0, errors: errors, normalized: out };
  }

  function fixMeta(meta, errors) {
    var m = isObj(meta) ? meta : {};
    return {
      title:    isStr(m.title) ? m.title.trim() : "未命名报告",
      subtitle: isStr(m.subtitle) ? m.subtitle.trim() : "",
      author:   isStr(m.author) ? m.author.trim() : "",
      date:     isStr(m.date) ? m.date.trim() : "",
      tags:     isArr(m.tags) ? m.tags.filter(isStr) : []
    };
  }

  function todayIso() {
    var d = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function fixSections(sections, errors) {
    var arr = isArr(sections) ? sections : [];
    return arr.map(function (s, i) { return fixSection(s, i, errors); });
  }

  function fixSection(sec, i, errors) {
    var s = isObj(sec) ? sec : {};
    var path = "sections[" + i + "]";
    if (!isStr(s.heading) || !s.heading.trim()) {
      errors.push({ path: path + ".heading", msg: "章节标题为空，已用占位替代" });
    }
    return {
      id:      isStr(s.id) ? s.id : uid("s-"),
      heading: isStr(s.heading) && s.heading.trim() ? s.heading.trim() : ("章节 " + (i + 1)),
      level:   isNum(s.level) ? Math.max(1, Math.min(3, s.level | 0)) : 1,
      blocks:  fixBlocks(s.blocks, path, errors)
    };
  }

  function fixBlocks(blocks, path, errors) {
    var arr = isArr(blocks) ? blocks : [];
    return arr.map(function (b, j) {
      return fixBlock(b, path + ".blocks[" + j + "]", errors);
    }).filter(Boolean);
  }

  function fixBlock(blk, path, errors) {
    var b = isObj(blk) ? blk : {};
    if (b.type === "text" || (!b.type && isStr(b.content))) {
      return {
        type: "text",
        format: b.format === "plain" ? "plain" : "markdown",
        content: isStr(b.content) ? b.content : ""
      };
    }
    if (b.type === "chart") {
      return { type: "chart", title: isStr(b.title) ? b.title : "", spec: fixChartSpec(b.spec, path, errors) };
    }
    if (b.type === "image") {
      // accept either assetId (preferred) or src (legacy / external URL)
      return {
        type: "image",
        assetId: isStr(b.assetId) ? b.assetId : null,
        src:     isStr(b.src) ? b.src : null,
        caption: isStr(b.caption) ? b.caption : ""
      };
    }
    if (b.type === "table") {
      return {
        type: "table",
        title:   isStr(b.title) ? b.title : "",
        caption: isStr(b.caption) ? b.caption : "",
        spec:    fixTableSpec(b.spec, path, errors)
      };
    }
    errors.push({ path: path, msg: "未知块类型: " + JSON.stringify(b.type) });
    return null;
  }

  function fixChartSpec(spec, path, errors) {
    var s = isObj(spec) ? spec : {};
    var kind = CHART_KINDS.indexOf(s.kind) >= 0 ? s.kind : "bar";
    if (s.kind && CHART_KINDS.indexOf(s.kind) < 0) {
      errors.push({ path: path + ".spec.kind", msg: "未知图表类型 " + s.kind + "，已回退为 bar" });
    }
    var categories = isArr(s.categories) ? s.categories.map(String) : [];
    var rawSeries = isArr(s.series) ? s.series : [];
    var series = rawSeries.map(function (sr, idx) {
      var sObj = isObj(sr) ? sr : {};
      return {
        name: isStr(sObj.name) ? sObj.name : ("系列 " + (idx + 1)),
        data: isArr(sObj.data) ? sObj.data.map(toNum) : []
      };
    });
    if (!series.length) series = [{ name: "数值", data: categories.map(function () { return 0; }) }];
    return { kind: kind, categories: categories, series: series, unit: isStr(s.unit) ? s.unit : "" };
  }
  function toNum(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  // ---------- table block ----------

  function clampInt(v, min, max, dflt) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function fixStyle(s) {
    var x = isObj(s) ? s : {};
    var out = {};
    if (STYLE_ALIGN.indexOf(x.align) >= 0) out.align = x.align;
    if (x.bold === true) out.bold = true;
    if (x.italic === true) out.italic = true;
    if (isStr(x.color) && /^#[0-9a-fA-F]{3,8}$/.test(x.color)) out.color = x.color;
    if (isStr(x.bg)    && /^#[0-9a-fA-F]{3,8}$/.test(x.bg))    out.bg    = x.bg;
    if (STYLE_BORDER.indexOf(x.borderTop) >= 0)    out.borderTop = x.borderTop;
    if (STYLE_BORDER.indexOf(x.borderBottom) >= 0) out.borderBottom = x.borderBottom;
    return out;
  }

  function fixFormat(f) {
    if (!isObj(f)) return null;
    if (FORMAT_KINDS.indexOf(f.kind) < 0) return null;
    if (f.kind === "text") return { kind: "text" };
    var out = { kind: f.kind };
    out.decimals  = clampInt(f.decimals, 0, 6, 0);
    out.thousands = !!f.thousands;
    if (isStr(f.prefix)) out.prefix = f.prefix.slice(0, 8);
    if (isStr(f.suffix)) out.suffix = f.suffix.slice(0, 8);
    return out;
  }

  function emptyCell() {
    return { v: "", rowspan: 1, colspan: 1, hidden: false, style: {}, format: null };
  }

  function fixCell(c) {
    if (c == null) return emptyCell();
    // 兼容 LLM 输出裸字符串 / 数字
    if (typeof c === "string" || typeof c === "number") {
      return { v: c, rowspan: 1, colspan: 1, hidden: false, style: {}, format: null };
    }
    var x = isObj(c) ? c : {};
    var v;
    if (typeof x.v === "number" && isFinite(x.v)) v = x.v;
    else if (typeof x.v === "string") v = x.v;
    else if (x.v == null) v = "";
    else v = String(x.v);
    return {
      v: v,
      rowspan: clampInt(x.rowspan, 1, MAX_TABLE_ROWS, 1),
      colspan: clampInt(x.colspan, 1, MAX_TABLE_COLS, 1),
      hidden:  x.hidden === true,
      style:   fixStyle(x.style),
      format:  fixFormat(x.format)
    };
  }

  /**
   * 从 cell 的 rowspan/colspan 重建 merges 数组，并修正 hidden 标记。
   * 这是 schema 的"自愈"层：LLM 写错合并描述时，以可见格的 rowspan/colspan 为准。
   */
  function rebuildMerges(rows) {
    var merges = [];
    var R = rows.length;
    if (!R) return merges;
    var C = 0;
    rows.forEach(function (r) { if (r.length > C) C = r.length; });
    // 占位掩码：true 表示该位置已被某个合并主格吃掉
    var occupied = [];
    for (var i = 0; i < R; i++) {
      occupied[i] = [];
      for (var j = 0; j < C; j++) occupied[i][j] = false;
    }
    for (var ri = 0; ri < R; ri++) {
      for (var ci = 0; ci < C; ci++) {
        var cell = rows[ri][ci];
        if (!cell) continue;
        if (occupied[ri][ci]) {
          // 该位置在合并范围内：强制 hidden
          cell.hidden = true;
          cell.rowspan = 1;
          cell.colspan = 1;
          continue;
        }
        // 主格
        cell.hidden = false;
        var rs = cell.rowspan, cs = cell.colspan;
        // 边界裁剪
        if (ri + rs > R) rs = R - ri;
        if (ci + cs > C) cs = C - ci;
        cell.rowspan = rs;
        cell.colspan = cs;
        if (rs > 1 || cs > 1) {
          merges.push({ r: ri, c: ci, rowspan: rs, colspan: cs });
          for (var dr = 0; dr < rs; dr++) {
            for (var dc = 0; dc < cs; dc++) {
              if (dr === 0 && dc === 0) continue;
              occupied[ri + dr][ci + dc] = true;
            }
          }
        }
      }
    }
    return merges;
  }

  function fixTableSpec(spec, path, errors) {
    var s = isObj(spec) ? spec : {};
    // columns
    var rawCols = isArr(s.columns) ? s.columns : [];
    var columns = rawCols.map(function (c, i) {
      var col = isObj(c) ? c : {};
      return {
        key:    isStr(col.key) ? col.key : ("c" + i),
        header: isStr(col.header) ? col.header : "",
        width:  isStr(col.width) ? col.width : "auto",
        align:  STYLE_ALIGN.indexOf(col.align) >= 0 ? col.align : "left",
        format: fixFormat(col.format)
      };
    });
    // rows
    var rawRows = isArr(s.rows) ? s.rows : [];
    if (rawRows.length > MAX_TABLE_ROWS) {
      errors.push({ path: path + ".spec.rows", msg: "表格行数超出上限 " + MAX_TABLE_ROWS + "，已截断" });
      rawRows = rawRows.slice(0, MAX_TABLE_ROWS);
    }
    var rows = rawRows.map(function (row) {
      var r = isArr(row) ? row : [];
      return r.map(fixCell);
    });
    // 列数自适应：以最长行 / columns 取最大
    var maxCols = columns.length;
    rows.forEach(function (r) { if (r.length > maxCols) maxCols = r.length; });
    if (maxCols > MAX_TABLE_COLS) {
      errors.push({ path: path + ".spec.columns", msg: "表格列数超出上限 " + MAX_TABLE_COLS + "，已截断" });
      maxCols = MAX_TABLE_COLS;
    }
    while (columns.length < maxCols) {
      columns.push({ key: "c" + columns.length, header: "", width: "auto", align: "left", format: null });
    }
    if (columns.length > maxCols) columns.length = maxCols;
    rows = rows.map(function (r) {
      var x = r.slice(0, maxCols);
      while (x.length < maxCols) x.push(emptyCell());
      return x;
    });
    // 至少 1 行 1 列，避免编辑器空状态
    if (!columns.length) {
      columns = [
        { key: "c0", header: "列 1", width: "auto", align: "left", format: null },
        { key: "c1", header: "列 2", width: "auto", align: "left", format: null }
      ];
    }
    if (!rows.length) {
      rows = [
        columns.map(function () { return emptyCell(); }),
        columns.map(function () { return emptyCell(); })
      ];
    }
    var headerRows = clampInt(s.headerRows, 0, 5, 1);
    var footerRows = clampInt(s.footerRows, 0, 5, 0);
    if (headerRows + footerRows > rows.length) {
      headerRows = Math.min(headerRows, rows.length);
      footerRows = 0;
    }
    var merges = rebuildMerges(rows);
    return {
      columns: columns,
      rows: rows,
      headerRows: headerRows,
      footerRows: footerRows,
      merges: merges,
      defaultAlign: STYLE_ALIGN.indexOf(s.defaultAlign) >= 0 ? s.defaultAlign : "left",
      unit: isStr(s.unit) ? s.unit : ""
    };
  }

  // ---------- end table block ----------

  function emptyReport() {
    return validateAndFix({
      meta: { title: "新建报告" },
      sections: [
        { heading: "一、概述", blocks: [{ type: "text", content: "在此输入概述内容。" }] }
      ]
    }).normalized;
  }

  window.RF_Schema = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    CHART_KINDS: CHART_KINDS,
    STYLE_ALIGN: STYLE_ALIGN,
    STYLE_BORDER: STYLE_BORDER,
    FORMAT_KINDS: FORMAT_KINDS,
    MAX_TABLE_ROWS: MAX_TABLE_ROWS,
    MAX_TABLE_COLS: MAX_TABLE_COLS,
    validate: validateAndFix,
    empty: emptyReport,
    uid: uid,
    // table helpers — 让 table-editor / table-paste 复用归一化逻辑
    fixTableSpec: function (spec) { return fixTableSpec(spec, "table", []); },
    fixCell: fixCell,
    fixStyle: fixStyle,
    fixFormat: fixFormat,
    rebuildMerges: rebuildMerges,
    emptyCell: emptyCell
  };
})();

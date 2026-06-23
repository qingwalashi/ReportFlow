/**
 * table-paste.js — 剪贴板 → table spec 的纯函数库。
 *
 * 策略：HTML 优先（保留合并/对齐/加粗/数字格式），TSV 兜底。
 * Excel/WPS/Numbers/Google Sheets 复制时同时写两种格式到 clipboard。
 *
 * 入口：
 *   RF_TablePaste.fromClipboardEvent(ev) → { ok, spec, source } | { ok:false, reason }
 *   RF_TablePaste.parseHtmlTable(htmlStr) → spec | null
 *   RF_TablePaste.parseTsv(textStr) → spec | null
 *   RF_TablePaste.detectKind(html, text) → "html" | "tsv" | null  // 给 UI 预判用
 */
(function () {
  "use strict";

  var STYLE_ALIGN = ["left", "center", "right"];

  function fromClipboardEvent(ev) {
    var dt = ev && ev.clipboardData;
    if (!dt) return { ok: false, reason: "no-clipboard-data" };
    var html = dt.getData("text/html") || "";
    var text = dt.getData("text/plain") || "";
    return fromStrings(html, text);
  }

  function fromStrings(html, text) {
    if (html && /<table[\s>]/i.test(html)) {
      try {
        var spec = parseHtmlTable(html);
        if (spec && spec.columns.length) { hoistColumnFormats(spec); return { ok: true, spec: spec, source: "html" }; }
      } catch (e) { /* fall through */ }
    }
    if (text && /\t/.test(text) && /\n/.test(text)) {
      var spec2 = parseTsv(text);
      if (spec2 && spec2.columns.length) { hoistColumnFormats(spec2); return { ok: true, spec: spec2, source: "tsv" }; }
    }
    // 退一步：只有一行也能识别（单行表格不常见但允许）
    if (text && /\t/.test(text)) {
      var spec3 = parseTsv(text);
      if (spec3 && spec3.columns.length) { hoistColumnFormats(spec3); return { ok: true, spec: spec3, source: "tsv" }; }
    }
    return { ok: false, reason: "neither-html-nor-tsv" };
  }

  /**
   * 把"列里至少一个 cell 检出某 format"的列级化：
   *   — 如果一列里 ≥1 个 cell 是 percent，列级 format 设为 percent。
   *   — 否则若 ≥1 是 number，列级 format 设为 number（取最常见的小数位 + 任一开千分位）。
   *
   * 这样从 Excel 粘贴后，同列内"1,200"和"800"会一起显示成"1,200"和"800"。
   * 不删除 cell.format，渲染时 cell.format 优先于 column.format。
   */
  function hoistColumnFormats(spec) {
    var nCols = spec.columns.length;
    for (var c = 0; c < nCols; c++) {
      var votes = { percent: 0, number: 0, currency: 0 };
      var maxDec = 0;
      var thousands = false;
      var prefix = "";
      spec.rows.forEach(function (row) {
        var cell = row[c];
        if (!cell || cell.hidden) return;
        var f = cell.format;
        if (!f) return;
        if (f.kind === "percent") votes.percent++;
        else if (f.kind === "number") votes.number++;
        else if (f.kind === "currency") { votes.currency++; if (f.prefix) prefix = f.prefix; }
        if (f.decimals && f.decimals > maxDec) maxDec = f.decimals;
        if (f.thousands) thousands = true;
      });
      var picked = null;
      if (votes.percent > 0) picked = { kind: "percent", decimals: maxDec, thousands: thousands };
      else if (votes.currency > 0) picked = { kind: "currency", decimals: maxDec, thousands: thousands, prefix: prefix };
      else if (votes.number > 0) picked = { kind: "number", decimals: maxDec, thousands: thousands };
      if (picked) spec.columns[c].format = picked;
    }
  }

  function detectKind(html, text) {
    if (html && /<table[\s>]/i.test(html)) return "html";
    if (text && /\t/.test(text) && text.split("\n").length >= 2) return "tsv";
    return null;
  }

  // ---------- HTML ----------

  function parseHtmlTable(html) {
    // Office 复制的 HTML 常含 conditional comments + namespaces — DOMParser 都能忽略
    var doc = new DOMParser().parseFromString(html, "text/html");
    var table = doc.querySelector("table");
    if (!table) return null;

    // 收集所有 tr（thead/tbody/tfoot 都按出现顺序合在一起）
    var trs = Array.prototype.slice.call(table.querySelectorAll("tr"));
    if (!trs.length) return null;

    // headerRows: 优先 <thead> 里的 tr 数
    var headerRows = 0;
    var thead = table.querySelector("thead");
    if (thead) headerRows = thead.querySelectorAll("tr").length;

    // 二维 grid，遇到 rowspan/colspan 时把下方/右方位置标记为 hidden
    var grid = [];
    trs.forEach(function (tr, ri) {
      grid[ri] = grid[ri] || [];
      var ci = 0;
      var cells = Array.prototype.slice.call(tr.children).filter(function (n) {
        return n.tagName === "TD" || n.tagName === "TH";
      });
      cells.forEach(function (td) {
        // 跳过已被上方 rowspan 占用的位置
        while (grid[ri][ci] && grid[ri][ci].hidden) ci++;
        var rs = parseInt(td.getAttribute("rowspan") || "1", 10) || 1;
        var cs = parseInt(td.getAttribute("colspan") || "1", 10) || 1;
        var cellText = (td.innerText || td.textContent || "").replace(/ /g, " ").trim();
        var v = extractCellValue(cellText);
        var fmt = detectFormat(cellText);
        var cell = {
          v: v,
          rowspan: rs,
          colspan: cs,
          hidden: false,
          style: extractStyle(td),
          format: fmt
        };
        grid[ri][ci] = cell;
        // 占位
        for (var dr = 0; dr < rs; dr++) {
          for (var dc = 0; dc < cs; dc++) {
            if (dr === 0 && dc === 0) continue;
            grid[ri + dr] = grid[ri + dr] || [];
            grid[ri + dr][ci + dc] = {
              v: "", rowspan: 1, colspan: 1, hidden: true, style: {}, format: null
            };
          }
        }
        ci += cs;
      });
    });

    // 列数 = 最长行
    var maxCols = 0;
    grid.forEach(function (r) { if (r.length > maxCols) maxCols = r.length; });
    if (!maxCols) return null;

    // 补齐每行
    grid = grid.map(function (r) {
      while (r.length < maxCols) {
        r.push({ v: "", rowspan: 1, colspan: 1, hidden: false, style: {}, format: null });
      }
      return r;
    });

    // 没有 thead 时，用第一行作为表头（最常见的 Excel 复制行为）
    if (!headerRows) headerRows = 1;

    // columns 取首行的 header 文本，并把首行从 rows 里移除（headerRows 仍然记录）
    // 但为了支持二级表头（headerRows > 1），columns 只用 grid[0] 的可见格
    var columns = [];
    for (var c = 0; c < maxCols; c++) {
      var cell0 = grid[0][c];
      var headerText = cell0 && !cell0.hidden ? String(cell0.v) : "";
      columns.push({
        key: "c" + c,
        header: headerText,
        width: "auto",
        align: (cell0 && cell0.style && cell0.style.align) || "left",
        format: null
      });
    }

    // rows 从 headerRows 开始
    var rows = grid.slice(headerRows);
    // 边界：如果整张表只有 1 行（headerRows=1, rows 空），保留首行作为唯一数据行避免空表
    if (!rows.length) {
      rows = [grid[0].map(function () {
        return { v: "", rowspan: 1, colspan: 1, hidden: false, style: {}, format: null };
      })];
    }

    return {
      columns: columns,
      rows: rows,
      headerRows: 1,           // 已把多级表头压缩为一级；columns.header 已含首行内容
      footerRows: 0,
      merges: [],              // schema 重建
      defaultAlign: "left",
      unit: ""
    };
  }

  function extractCellValue(rawText) {
    var raw = rawText.trim();
    if (raw === "") return "";
    // 数字识别：剥离币种、千分位逗号、% 后能 parseFloat
    var s = raw.replace(/^[¥$￥€£]/, "").replace(/,/g, "").replace(/%$/, "").trim();
    if (s !== "" && !isNaN(Number(s))) {
      var n = Number(s);
      if (raw.indexOf("%") >= 0) return n / 100;
      return n;
    }
    return raw;
  }

  function extractStyle(td) {
    var s = {};
    var cs = td.getAttribute("style") || "";
    var attrAlign = td.getAttribute("align");
    if (attrAlign && STYLE_ALIGN.indexOf(attrAlign.toLowerCase()) >= 0) {
      s.align = attrAlign.toLowerCase();
    } else {
      var m = /text-align\s*:\s*(left|right|center)/i.exec(cs);
      if (m) s.align = m[1].toLowerCase();
    }
    if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(cs) || td.querySelector("b,strong")) s.bold = true;
    if (/font-style\s*:\s*italic/i.test(cs) || td.querySelector("i,em")) s.italic = true;

    var color = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(cs);
    if (color) {
      var hex = colorToHex(color[1].trim());
      if (hex) s.color = hex;
    }
    var bg = /background(?:-color)?\s*:\s*([^;]+)/i.exec(cs);
    if (bg) {
      var bgHex = colorToHex(bg[1].trim());
      if (bgHex && bgHex !== "#ffffff") s.bg = bgHex;   // 白底无意义
    }
    return s;
  }

  /** 把 CSS 颜色字符串转成 #rrggbb；不识别或透明时返回 null。 */
  function colorToHex(str) {
    if (!str) return null;
    str = str.toLowerCase().trim();
    if (str === "transparent" || str === "inherit" || str === "initial") return null;
    if (/^#[0-9a-f]{6}$/.test(str)) return str;
    if (/^#[0-9a-f]{3}$/.test(str)) {
      return "#" + str[1] + str[1] + str[2] + str[2] + str[3] + str[3];
    }
    var rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(str);
    if (rgb) {
      return "#" + toHex2(+rgb[1]) + toHex2(+rgb[2]) + toHex2(+rgb[3]);
    }
    return null;
  }

  function toHex2(n) {
    var h = (n & 0xff).toString(16);
    return h.length < 2 ? "0" + h : h;
  }

  function detectFormat(text) {
    var t = (text || "").trim();
    if (t === "") return null;
    // 千分位整数或小数：1,234 / 1,234.56
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) {
      return { kind: "number", decimals: countDec(t), thousands: true };
    }
    // 普通小数：1234.5
    if (/^-?\d+\.\d+$/.test(t)) {
      return { kind: "number", decimals: countDec(t), thousands: false };
    }
    // 百分比：12% / 12.34%
    if (/^-?\d+(\.\d+)?%$/.test(t)) {
      var pure = t.slice(0, -1);
      return { kind: "percent", decimals: countDec(pure), thousands: false };
    }
    // 千分位百分比：1,234%
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?%$/.test(t)) {
      var pure2 = t.slice(0, -1);
      return { kind: "percent", decimals: countDec(pure2), thousands: true };
    }
    // 货币
    if (/^[¥$￥€£]/.test(t)) {
      return { kind: "currency", decimals: countDec(t), thousands: /\d,\d/.test(t), prefix: t.charAt(0) };
    }
    return null;
  }

  function countDec(text) {
    var i = text.indexOf(".");
    if (i < 0) return 0;
    var after = text.slice(i + 1).replace(/\D.*$/, "");
    return after.length;
  }

  // ---------- TSV ----------

  function parseTsv(text) {
    if (text == null) return null;
    var s = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    s = s.replace(/\n+$/, "");
    if (s === "") return null;

    // 制表符分隔：按 RFC4180 风格解析，支持带引号的多行单元格。
    // Excel/WPS/Sheets 复制含换行的单元格时，会用双引号包裹该字段并把 \n/\t 转义在内——
    // 直接 split("\n") 会把一个多行单元格错拆成多行，所以制表符路径走逐字符解析。
    if (s.indexOf("\t") >= 0) {
      return buildSpec(parseDelimitedRows(s, "\t").map(function (row) {
        return row.map(function (cellField) {
          var raw = cellField.replace(/ /g, " ").trim();
          return {
            v: extractCellValue(raw),
            rowspan: 1, colspan: 1, hidden: false, style: {}, format: detectFormat(raw)
          };
        });
      }));
    }

    var lines = s.split("\n");
    if (!lines.length) return null;

    // 分隔符：优先 \t，其次连续 ≥2 空格
    var firstHasTab = lines[0].indexOf("\t") >= 0;
    var splitter;
    if (firstHasTab) splitter = function (line) { return line.split("\t"); };
    else splitter = function (line) { return line.split(/\s{2,}/); };

    var grid = lines.map(function (line) {
      return splitter(line).map(function (field) {
        var raw = field.replace(/ /g, " ").trim();
        return {
          v: extractCellValue(raw),
          rowspan: 1,
          colspan: 1,
          hidden: false,
          style: {},
          format: detectFormat(raw)
        };
      });
    });

    return buildSpec(grid);
  }

  /**
   * 把二维 grid（每格已是 cell 对象）补齐成 table spec：第一行作表头，
   * 其余作数据行；列数对齐到最长行；至少 1 行 1 列避免空表。
   * 制表符路径与空格路径共用。
   */
  function buildSpec(grid) {
    if (!grid || !grid.length) return null;
    var maxCols = 0;
    grid.forEach(function (r) { if (r.length > maxCols) maxCols = r.length; });
    if (!maxCols) return null;
    // 补齐
    grid = grid.map(function (r) {
      while (r.length < maxCols) {
        r.push({ v: "", rowspan: 1, colspan: 1, hidden: false, style: {}, format: null });
      }
      return r;
    });

    // 第一行作 header
    var columns = grid[0].map(function (h, i) {
      return {
        key: "c" + i,
        header: String(h.v != null ? h.v : ""),
        width: "auto",
        align: "left",
        format: null
      };
    });
    var rows = grid.slice(1);
    if (!rows.length) {
      rows = [columns.map(function () {
        return { v: "", rowspan: 1, colspan: 1, hidden: false, style: {}, format: null };
      })];
    }
    return {
      columns: columns,
      rows: rows,
      headerRows: 1,
      footerRows: 0,
      merges: [],
      defaultAlign: "left",
      unit: ""
    };
  }

  /**
   * RFC4180 风格的分隔文本解析：字段可用双引号包裹，字段内可含分隔符或换行，
   * 双引号本身用 "" 转义。用于解析 Excel/WPS/Sheets 复制多行单元格时的 TSV。
   *
   * 仅在字段起始位置（前一字符是 delim / \n / 文本开头）才把 " 视作引用起点，
   * 因此未引用字段里的字面引号（如 say "hi"）会原样保留，行为与 split 一致。
   * @param {string} text  已统一为 \n 换行、去除行尾 \n 的文本
   * @param {string} delim 单字符字段分隔符（"\t"）
   * @returns {string[][]}
   */
  function parseDelimitedRows(text, delim) {
    var rows = [], row = [], field = "";
    var inQuotes = false;
    var fieldStart = true;
    var i = 0, n = text.length;
    while (i < n) {
      var ch = text.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++;
        } else {
          field += ch; i++;
        }
      } else if (fieldStart && ch === '"') {
        inQuotes = true; fieldStart = false; i++;
      } else if (ch === delim) {
        row.push(field); field = ""; fieldStart = true; i++;
      } else if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = ""; fieldStart = true; i++;
      } else {
        field += ch; fieldStart = false; i++;
      }
    }
    if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  window.RF_TablePaste = {
    fromClipboardEvent: fromClipboardEvent,
    fromStrings: fromStrings,
    parseHtmlTable: parseHtmlTable,
    parseTsv: parseTsv,
    detectKind: detectKind
  };
})();

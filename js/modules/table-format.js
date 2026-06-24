/**
 * table-format.js — 表格单元格的数字格式化与文本解析。
 *
 * formatCell(value, format) 由模板渲染端 + 编辑器只读态共用：把"内部值"格式化成显示串。
 * parseCell(text)             由编辑器输入端共用：把用户输入的串还原成内部值（数字识别）。
 *
 * 设计原则：内部值始终用最简形式存储（百分比落库为小数 0.1234，渲染为 "12.34%"）。
 * 这样不论何时切换数字格式，原值都不丢精度。
 */
(function () {
  "use strict";

  // 智能高亮底色（荧光笔风格）。与 preview.js baseDoc 中 .rf-hl--* 保持一致。
  var HL_NUM_BG  = "#fff1a8";  // 数字高亮 — 黄
  var HL_TEXT_BG = "#c8f2d4";  // 文字高亮 — 绿

  /**
   * @param {number|string} value  内部值（文本或数字）
   * @param {object|null}   format { kind, decimals, thousands, prefix, suffix }
   * @returns {string} 显示文本
   */
  function formatCell(value, format) {
    if (value == null) return "";
    if (!format || !format.kind || format.kind === "text") return String(value);

    var num = Number(value);
    if (!isFinite(num)) return String(value);

    var decimals  = clampInt(format.decimals, 0, 6, 0);
    var thousands = !!format.thousands;
    var prefix = format.prefix || "";
    var suffix = format.suffix || "";

    var n;
    switch (format.kind) {
      case "percent":
        n = num * 100;
        return prefix + applyDecimals(n, decimals, thousands) + "%" + suffix;
      case "currency":
        return prefix + applyDecimals(num, decimals, thousands) + suffix;
      case "number":
        return prefix + applyDecimals(num, decimals, thousands) + suffix;
      case "date":
        return formatDate(value);
      default:
        return String(value);
    }
  }

  function applyDecimals(n, decimals, thousands) {
    var fixed = Number(n).toFixed(decimals);
    if (!thousands) return fixed;
    var parts = fixed.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  }

  function formatDate(v) {
    // v 可能是 ISO 串或时间戳；只做基础格式化，复杂日期由用户原样输入
    var d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) return String(v);
    var pad = function (x) { return x < 10 ? "0" + x : "" + x; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  /**
   * 把用户在 contentEditable 单元格输入的文本，还原成内部值。
   * 规则：
   *   - 仅含数字 + 千分位逗号 + 小数点 + 可选前后缀 → 数字
   *   - 末尾 % → 数字 / 100（避免 0.05 显示为 5%，而真实存储是 0.05）
   *   - 否则保持字符串
   *
   * 同时返回 detected：建议给该 cell 设置的 format（如自动加千分位）。
   * 调用方可以选择是否采纳 detected。
   *
   * @param {string} text
   * @returns {{ value: number|string, detected: object|null }}
   */
  function parseCell(text) {
    if (text == null) return { value: "", detected: null };
    var raw = String(text).trim();
    if (raw === "") return { value: "", detected: null };

    var detected = null;
    var s = raw;

    // 剥离币种前缀
    var prefix = "";
    if (/^[¥$￥€£]/.test(s)) {
      prefix = s.charAt(0);
      s = s.slice(1).trim();
    }

    // 末尾 %
    var isPct = /%$/.test(s);
    if (isPct) s = s.slice(0, -1).trim();

    // 千分位
    var hadComma = /\d,\d/.test(s);
    var stripped = s.replace(/,/g, "");

    if (stripped === "" || isNaN(Number(stripped))) {
      // 不是合法数字：原样存字符串（保留 %、千分位等）
      return { value: raw, detected: null };
    }

    var num = Number(stripped);
    var decimals = 0;
    var dotIdx = stripped.indexOf(".");
    if (dotIdx >= 0) decimals = stripped.length - dotIdx - 1;

    if (isPct) {
      detected = { kind: "percent", decimals: decimals, thousands: hadComma };
      return { value: num / 100, detected: detected };
    }
    if (prefix) {
      detected = { kind: "currency", decimals: decimals, thousands: hadComma, prefix: prefix };
      return { value: num, detected: detected };
    }
    if (hadComma || decimals > 0) {
      detected = { kind: "number", decimals: decimals, thousands: hadComma };
    }
    return { value: num, detected: detected };
  }

  function clampInt(v, min, max, dflt) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return dflt;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  window.RF_TableFormat = {
    formatCell: formatCell,
    parseCell:  parseCell,
    renderTableHtml: renderTableHtml,
    escMultiline: escMultiline
  };

  /**
   * 通用 table → HTML 字符串渲染。各模板可调用此函数并把结果 insertAdjacentHTML。
   * 各模板的差异化通过外层 figure class（rf-tpl-xxx-table）+ 模板自有 CSS 表达。
   *
   * @param {object} blk    type=table 的块
   * @param {object} opts   { figClass, tableClass, captionPosition: "top"|"bottom" }
   * @returns {string}
   */
  function renderTableHtml(blk, opts) {
    opts = opts || {};
    var spec = blk.spec || {};
    var columns = spec.columns || [];
    var rows = spec.rows || [];
    var headerRows = spec.headerRows || 1;
    var footerRows = spec.footerRows || 0;
    var figClass = opts.figClass || "rf-table-fig";
    var tableClass = opts.tableClass || "rf-table";

    var html = '<figure class="' + figClass + '">';
    if (blk.title) html += '<figcaption class="rf-table-title">' + esc(blk.title) + '</figcaption>';
    // 横向滚动容器：窄屏（手机）下表格可左右拖动查看，不被压缩换行。
    // 标题 / 脚注留在容器外，滚动时保持固定。
    html += '<div class="rf-table-scroll">';
    html += '<table class="' + tableClass + '">';

    // thead — 至少 columns.header 一行
    html += '<thead><tr>';
    columns.forEach(function (c) {
      var st = c.align ? ' style="text-align:' + c.align + '"' : '';
      html += '<th' + st + '>' + escMultiline(c.header || "") + '</th>';
    });
    html += '</tr>';
    // 多级表头（headerRows > 1）：把 rows[0..headerRows-2] 也作为 thead 行渲染
    var bodyStart = 0;
    if (headerRows > 1) {
      var extraHeaderRows = Math.min(headerRows - 1, rows.length);
      for (var hi = 0; hi < extraHeaderRows; hi++) {
        html += '<tr>';
        rows[hi].forEach(function (cell, ci) {
          if (cell.hidden) return;
          html += renderCell(cell, columns[ci], "th");
        });
        html += '</tr>';
        bodyStart++;
      }
    }
    html += '</thead>';

    // tbody
    var bodyEnd = rows.length - footerRows;
    if (bodyEnd < bodyStart) bodyEnd = bodyStart;
    html += '<tbody>';
    for (var ri = bodyStart; ri < bodyEnd; ri++) {
      html += '<tr>';
      rows[ri].forEach(function (cell, ci) {
        if (cell.hidden) return;
        html += renderCell(cell, columns[ci], "td");
      });
      html += '</tr>';
    }
    html += '</tbody>';

    // tfoot
    if (footerRows > 0 && bodyEnd < rows.length) {
      html += '<tfoot>';
      for (var fi = bodyEnd; fi < rows.length; fi++) {
        html += '<tr>';
        rows[fi].forEach(function (cell, ci) {
          if (cell.hidden) return;
          html += renderCell(cell, columns[ci], "td");
        });
        html += '</tr>';
      }
      html += '</tfoot>';
    }

    html += '</table>';
    html += '</div>';

    var captionParts = [];
    if (blk.caption) captionParts.push(blk.caption);
    if (spec.unit) captionParts.push("单位：" + spec.unit);
    if (captionParts.length) {
      html += '<figcaption class="rf-table-caption">' + esc(captionParts.join(" · ")) + '</figcaption>';
    }
    html += '</figure>';
    return html;
  }

  function renderCell(cell, col, tag) {
    var attrs = "";
    if (cell.rowspan && cell.rowspan > 1) attrs += ' rowspan="' + cell.rowspan + '"';
    if (cell.colspan && cell.colspan > 1) attrs += ' colspan="' + cell.colspan + '"';
    var styleStr = composeCellStyle(cell, col);
    if (styleStr) attrs += ' style="' + styleStr + '"';
    var displayed = formatCell(cell.v, cell.format || (col && col.format));
    return "<" + tag + attrs + ">" + escMultiline(displayed) + "</" + tag + ">";
  }

  function composeCellStyle(cell, col) {
    var s = cell.style || {};
    var parts = [];
    var align = s.align || (col && col.align);
    if (align && align !== "left") parts.push("text-align:" + align);
    if (s.bold) parts.push("font-weight:600");
    if (s.italic) parts.push("font-style:italic");
    if (s.color) parts.push("color:" + s.color);
    if (s.bg) parts.push("background:" + s.bg);
    // 智能高亮底色 —— 与正文 <mark class="rf-hl--*"> 同色。放在 s.bg 之后，
    // 使高亮优先于单元格自定义背景（高亮是临时的、可一键清除的标注）。
    if (s.hl === "num")  parts.push("background:" + HL_NUM_BG);
    if (s.hl === "text") parts.push("background:" + HL_TEXT_BG);
    if (s.borderTop && s.borderTop !== "none") {
      parts.push("border-top:" + (s.borderTop === "thick" ? "2px" : "1px") + " solid currentColor");
    }
    if (s.borderBottom && s.borderBottom !== "none") {
      parts.push("border-bottom:" + (s.borderBottom === "thick" ? "2px" : "1px") + " solid currentColor");
    }
    return parts.join(";");
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * 先 HTML 转义，再把换行符转成 <br>，使单元格内的多行文本能正确渲染。
   * 与纯文本块 escapeHtml(...).replace(/\n/g, "<br>") 的约定一致。
   * \r 顺带剔除，避免 \r\n 在渲染时产生多余空行。
   */
  function escMultiline(s) {
    return esc(s).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>");
  }
})();

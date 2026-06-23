/**
 * table-editor.js — 类 Excel 网格编辑器（contentEditable + 工具栏 + 合并 + 样式 + 数字格式）。
 *
 * 对外契约：
 *   var inst = RF_TableEditor.mount(host, blk, secIdx, blkIdx, callbacks);
 *   inst.destroy();
 *   callbacks.onChange(newBlk)            // 内容/结构变化（只更新 spec/title/caption），editor.js 走非 structural patch
 *   callbacks.onStructural(newBlk)        // 行/列/合并变化时也走 onChange，但此处保留扩展位
 *
 * 内部状态：
 *   spec        - 当前归一化后的 table spec（每次操作会 deep-clone 后改）
 *   activeR/C   - 活动单元格坐标
 *   selection   - 矩形选区 { r0, c0, r1, c1 }（默认 = active 单格）
 *
 * 性能：editor.js 只在 structural patch 后整体重渲染；table-editor 内部所有操作走自管 DOM 更新，
 * 通过 callbacks.onChange 把 spec 写回 state（非 structural），不引发表单重建，焦点不丢。
 */
(function () {
  "use strict";

  var schema = window.RF_Schema;
  var fmt    = window.RF_TableFormat;
  var paste  = window.RF_TablePaste;
  var ui     = window.RF_UI;

  var COLOR_SWATCHES = ["", "#1a1f2c", "#c0392b", "#27ae60", "#2563eb", "#a37b00"];
  var BG_SWATCHES    = ["", "#fff8e1", "#e8f5e9", "#e3f2fd", "#fce4ec", "#f4f6fa"];

  function mount(host, blk, secIdx, blkIdx, callbacks) {
    var ctx = {
      host: host,
      blk: blk,
      spec: clone(blk.spec),
      title: blk.title || "",
      caption: blk.caption || "",
      activeR: 0,
      activeC: 0,
      selection: { r0: 0, c0: 0, r1: 0, c1: 0 },
      callbacks: callbacks || {},
      // DOM 引用
      root: null, gridEl: null, toolbarEl: null,
      isSelecting: false
    };

    ctx.root = el("div", "rf-table-edit");
    host.appendChild(ctx.root);

    // 标题
    var titleInput = textInput(ctx.title, function (v) {
      ctx.title = v;
      emitChange(ctx);
    });
    titleInput.placeholder = "表格标题（可空）";
    titleInput.className += " rf-table-edit__title";
    ctx.root.appendChild(titleInput);

    // 工具栏
    ctx.toolbarEl = buildToolbar(ctx);
    ctx.root.appendChild(ctx.toolbarEl);

    // 粘贴提示
    var hint = el("div", "rf-table-edit__paste-hint", "💡 单元格内按 Alt+Enter 换行；Ctrl/Cmd+V 粘贴整体替换或填入数据");
    ctx.root.appendChild(hint);

    // 网格
    ctx.gridEl = el("div", "rf-table-edit__grid-wrap");
    ctx.root.appendChild(ctx.gridEl);
    renderGrid(ctx);

    // caption / unit
    var capRow = el("div", "rf-row rf-table-edit__caprow");
    var capInput = textInput(ctx.caption, function (v) {
      ctx.caption = v; emitChange(ctx);
    });
    capInput.placeholder = "表注（说明 / 来源 / 单位）";
    var unitInput = textInput(ctx.spec.unit || "", function (v) {
      ctx.spec.unit = v; emitChange(ctx);
    });
    unitInput.placeholder = "整表单位（如：万元）";
    unitInput.style.maxWidth = "140px";
    capRow.appendChild(capInput);
    capRow.appendChild(unitInput);
    ctx.root.appendChild(capRow);

    // 全局键盘 / 选区事件
    bindGridEvents(ctx);

    return {
      destroy: function () {
        if (ctx.root && ctx.root.parentNode) ctx.root.parentNode.removeChild(ctx.root);
      }
    };
  }

  // ---------- toolbar ----------

  function buildToolbar(ctx) {
    var bar = el("div", "rf-table-edit__toolbar");

    // 文字组
    var g1 = group(bar, "文字");
    g1.appendChild(toolBtn("B", "加粗", function () { applyStyle(ctx, { bold: toggle("bold", ctx) }); }, { bold: true }));
    g1.appendChild(toolBtn("I", "斜体", function () { applyStyle(ctx, { italic: toggle("italic", ctx) }); }, { italic: true }));
    g1.appendChild(alignSelect(ctx));
    g1.appendChild(colorPicker(ctx, "字色", "color", COLOR_SWATCHES));
    g1.appendChild(colorPicker(ctx, "背景", "bg", BG_SWATCHES));

    // 数字格式组
    var g2 = group(bar, "数字");
    g2.appendChild(formatSelect(ctx));
    g2.appendChild(toolBtn("−小数", "减少小数位", function () { changeDecimals(ctx, -1); }));
    g2.appendChild(toolBtn("+小数", "增加小数位", function () { changeDecimals(ctx, +1); }));
    g2.appendChild(toolBtn("千分位", "切换千分位", function () { toggleThousands(ctx); }));

    // 行列组
    var g3 = group(bar, "行列");
    g3.appendChild(toolBtn("+行↑", "上方插入行", function () { insertRow(ctx, "above"); }));
    g3.appendChild(toolBtn("+行↓", "下方插入行", function () { insertRow(ctx, "below"); }));
    g3.appendChild(toolBtn("+列←", "左侧插入列", function () { insertCol(ctx, "left"); }));
    g3.appendChild(toolBtn("+列→", "右侧插入列", function () { insertCol(ctx, "right"); }));
    g3.appendChild(toolBtn("删行", "删除当前行", function () { deleteRow(ctx); }));
    g3.appendChild(toolBtn("删列", "删除当前列", function () { deleteCol(ctx); }));

    // 合并组
    var g4 = group(bar, "合并");
    g4.appendChild(toolBtn("合并", "合并选区", function () { mergeSelection(ctx); }));
    g4.appendChild(toolBtn("拆分", "拆分当前合并", function () { splitActive(ctx); }));
    g4.appendChild(toolBtn("表头±", "切换为表头行", function () { toggleHeaderRow(ctx); }));

    return bar;
  }

  function group(parent, label) {
    var g = el("div", "rf-tbar-group");
    g.appendChild(el("span", "rf-tbar-group__label", label));
    parent.appendChild(g);
    return g;
  }

  function toolBtn(label, title, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "rf-tbar-btn";
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("mousedown", function (e) { e.preventDefault(); });  // 不抢焦点
    b.addEventListener("click", onClick);
    return b;
  }

  function alignSelect(ctx) {
    var sel = document.createElement("select");
    sel.className = "rf-tbar-select";
    sel.title = "对齐";
    [["", "对齐"], ["left", "左"], ["center", "中"], ["right", "右"]].forEach(function (op) {
      var o = document.createElement("option");
      o.value = op[0]; o.textContent = op[1];
      sel.appendChild(o);
    });
    sel.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    sel.addEventListener("change", function () {
      if (sel.value) applyStyle(ctx, { align: sel.value });
      sel.value = "";
    });
    return sel;
  }

  function formatSelect(ctx) {
    var sel = document.createElement("select");
    sel.className = "rf-tbar-select";
    sel.title = "数字格式";
    [
      ["", "格式"],
      ["text", "文本"],
      ["number", "数值"],
      ["percent", "百分比"],
      ["currency", "货币"],
      ["date", "日期"]
    ].forEach(function (op) {
      var o = document.createElement("option");
      o.value = op[0]; o.textContent = op[1];
      sel.appendChild(o);
    });
    sel.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    sel.addEventListener("change", function () {
      if (sel.value) applyFormat(ctx, sel.value);
      sel.value = "";
    });
    return sel;
  }

  function colorPicker(ctx, label, key, swatches) {
    var wrap = el("span", "rf-tbar-color");
    wrap.title = label;
    var box = el("button", "rf-tbar-btn rf-tbar-color__btn");
    box.type = "button";
    box.textContent = label;
    box.addEventListener("mousedown", function (e) { e.preventDefault(); });

    var pop = el("div", "rf-tbar-color__pop");
    swatches.forEach(function (color) {
      var sw = document.createElement("span");
      sw.className = "rf-tbar-color__sw";
      sw.style.background = color || "transparent";
      if (!color) sw.textContent = "✕";
      sw.title = color || "清除";
      sw.addEventListener("mousedown", function (e) { e.preventDefault(); });
      sw.addEventListener("click", function () {
        var patch = {};
        if (color) patch[key] = color;
        else patch[key] = null;        // 清除
        applyStyle(ctx, patch);
        pop.style.display = "none";
      });
      pop.appendChild(sw);
    });
    pop.style.display = "none";

    box.addEventListener("click", function (e) {
      e.stopPropagation();
      pop.style.display = pop.style.display === "none" ? "flex" : "none";
    });
    document.addEventListener("click", function () { pop.style.display = "none"; });

    wrap.appendChild(box);
    wrap.appendChild(pop);
    return wrap;
  }

  // 取选区中第一个可见 cell 的某属性，用于按钮的 toggle 状态
  function toggle(key, ctx) {
    var cell = visibleCellAt(ctx, ctx.activeR, ctx.activeC);
    if (!cell) return true;
    return !(cell.style && cell.style[key]);
  }

  // ---------- grid render ----------

  function renderGrid(ctx) {
    var spec = ctx.spec;
    var html = '<table class="rf-table-edit__grid">';
    // colgroup
    html += '<colgroup>';
    html += '<col class="rf-table-edit__rownum-col">';
    spec.columns.forEach(function () { html += '<col>'; });
    html += '</colgroup>';
    // 列号 / 列头编辑
    html += '<thead>';
    // 第一行：列字母（A B C…）
    html += '<tr class="rf-table-edit__col-letters"><th></th>';
    spec.columns.forEach(function (c, ci) {
      html += '<th class="rf-table-edit__col-letter" data-c="' + ci + '">' + colLetter(ci) + '</th>';
    });
    html += '</tr>';
    // 表头行（columns.header）
    html += '<tr class="rf-table-edit__header"><th class="rf-table-edit__rownum">表头</th>';
    spec.columns.forEach(function (c, ci) {
      html += '<th class="rf-table-edit__th" data-r="-1" data-c="' + ci + '" contenteditable="true" data-kind="header" style="' +
        styleStr({ align: c.align }) + '">' + escMultiline(c.header || "") + '</th>';
    });
    html += '</tr>';
    html += '</thead>';
    // body
    html += '<tbody>';
    spec.rows.forEach(function (row, ri) {
      var isHeaderBand = ri < (spec.headerRows - 1);  // headerRows 中第一行已被 columns 占用，多余的算次级表头
      var isFooterBand = (ri >= spec.rows.length - spec.footerRows);
      var rowClass = "rf-table-edit__row" +
        (isHeaderBand ? " rf-table-edit__row--header" : "") +
        (isFooterBand ? " rf-table-edit__row--footer" : "");
      html += '<tr class="' + rowClass + '">';
      html += '<th class="rf-table-edit__rownum" data-r="' + ri + '">' + (ri + 1) + '</th>';
      row.forEach(function (cell, ci) {
        if (cell.hidden) return;
        var attrs = '';
        if (cell.rowspan > 1) attrs += ' rowspan="' + cell.rowspan + '"';
        if (cell.colspan > 1) attrs += ' colspan="' + cell.colspan + '"';
        var st = composeCellStyle(cell, spec.columns[ci]);
        var displayed = fmt.formatCell(cell.v, cell.format || (spec.columns[ci] && spec.columns[ci].format));
        html += '<td class="rf-table-edit__td" data-r="' + ri + '" data-c="' + ci + '"' +
          attrs + (st ? ' style="' + st + '"' : '') +
          ' contenteditable="true">' + escMultiline(displayed) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    ctx.gridEl.innerHTML = html;
    highlightSelection(ctx);
  }

  function colLetter(i) {
    var s = "";
    var n = i;
    do { s = String.fromCharCode(65 + n % 26) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  }

  function composeCellStyle(cell, col) {
    var s = cell.style || {};
    var parts = [];
    var align = s.align || (col && col.align);
    if (align) parts.push("text-align:" + align);
    if (s.bold) parts.push("font-weight:600");
    if (s.italic) parts.push("font-style:italic");
    if (s.color) parts.push("color:" + s.color);
    if (s.bg) parts.push("background:" + s.bg);
    return parts.join(";");
  }

  function styleStr(o) {
    var p = [];
    if (o.align) p.push("text-align:" + o.align);
    return p.join(";");
  }

  // ---------- events ----------

  function bindGridEvents(ctx) {
    var grid = ctx.gridEl;
    var mouseDownAt = null;

    grid.addEventListener("mousedown", function (e) {
      var td = closestCell(e.target);
      if (!td) return;
      var r = +td.dataset.r, c = +td.dataset.c;
      if (r < 0) return;          // 表头行点击：只激活，不进选区
      mouseDownAt = { r: r, c: c };
      ctx.activeR = r; ctx.activeC = c;
      ctx.selection = { r0: r, c0: c, r1: r, c1: c };
      ctx.isSelecting = true;
      highlightSelection(ctx);
    });

    grid.addEventListener("mouseover", function (e) {
      if (!ctx.isSelecting || !mouseDownAt) return;
      var td = closestCell(e.target);
      if (!td) return;
      var r = +td.dataset.r, c = +td.dataset.c;
      if (r < 0) return;
      ctx.selection = {
        r0: Math.min(mouseDownAt.r, r), c0: Math.min(mouseDownAt.c, c),
        r1: Math.max(mouseDownAt.r, r), c1: Math.max(mouseDownAt.c, c)
      };
      highlightSelection(ctx);
    });

    document.addEventListener("mouseup", function () {
      ctx.isSelecting = false;
      mouseDownAt = null;
    });

    // contentEditable commit on blur
    grid.addEventListener("focusin", function (e) {
      var td = closestCell(e.target);
      if (!td) return;
      var r = +td.dataset.r, c = +td.dataset.c;
      if (r < 0) {
        // 列头编辑
        return;
      }
      // 进入编辑：把 td 的显示文本换回内部值（数字脱壳）便于编辑
      var cell = ctx.spec.rows[r] && ctx.spec.rows[r][c];
      if (cell && typeof cell.v === "number") {
        td.textContent = String(cell.v);
      }
    });

    grid.addEventListener("focusout", function (e) {
      var td = closestCell(e.target);
      if (!td) return;
      var rAttr = td.dataset.r;
      var cAttr = td.dataset.c;
      if (rAttr == null || cAttr == null) return;
      var r = +rAttr, c = +cAttr;
      var raw = (td.innerText || "").replace(/ /g, " ").trim();
      if (r === -1) {
        // 表头编辑
        ctx.spec.columns[c].header = raw;
        td.innerHTML = escMultiline(raw);
        emitChange(ctx);
        return;
      }
      var cell = ctx.spec.rows[r][c];
      var parsed = fmt.parseCell(raw);
      cell.v = parsed.value;
      // 自动 detected 不主动回写——避免每次都改用户的格式。仅当 cell.format 为空且 detected 存在时才接管。
      if (parsed.detected && !cell.format) cell.format = parsed.detected;
      // 重新格式化显示（保留单元格内换行）
      var displayed = fmt.formatCell(cell.v, cell.format || (ctx.spec.columns[c] && ctx.spec.columns[c].format));
      td.innerHTML = escMultiline(displayed);
      emitChange(ctx);
    });

    // 键盘导航
    grid.addEventListener("keydown", function (e) {
      var td = closestCell(e.target);
      if (!td) return;
      var rAttr = td.dataset.r, cAttr = td.dataset.c;
      if (rAttr == null || cAttr == null) return;
      var r = +rAttr, c = +cAttr;

      if (e.key === "Tab") {
        e.preventDefault();
        td.blur();
        var dc = e.shiftKey ? -1 : 1;
        var nr = r, nc = c + dc;
        if (nc >= ctx.spec.columns.length) { nc = 0; nr++; }
        if (nc < 0) { nc = ctx.spec.columns.length - 1; nr--; }
        focusCell(ctx, Math.max(0, nr), nc);
      } else if (e.key === "Enter" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        td.blur();
        focusCell(ctx, r + 1, c);
      } else if (e.key === "Enter" && (e.altKey || e.shiftKey)) {
        // 单元格内换行（Alt+Enter 同 Excel，Shift+Enter 同通用编辑器）
        e.preventDefault();
        insertLineBreak(td);
      } else if (e.key === "Escape") {
        td.blur();
      } else if (e.key === "ArrowUp" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); td.blur(); focusCell(ctx, r - 1, c);
      } else if (e.key === "ArrowDown" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); td.blur(); focusCell(ctx, r + 1, c);
      }
    });

    // 内部粘贴：替换全表 / 从此处填入
    grid.addEventListener("paste", function (e) {
      var result = paste.fromClipboardEvent(e);
      if (!result.ok) return;     // 让默认行为接管（粘到当前 cell）
      e.preventDefault();
      ui.confirm({
        title: "粘贴表格",
        body: "检测到剪贴板中有 " + result.spec.rows.length + " 行 × " + result.spec.columns.length + " 列的表格。",
        confirmLabel: "替换全表",
        cancelLabel: "从此处填入"
      }).then(function (replace) {
        if (replace) {
          ctx.spec = schema.fixTableSpec(result.spec);
          emitChange(ctx, { structural: true });
          renderGrid(ctx);
        } else {
          fillFromCell(ctx, ctx.activeR, ctx.activeC, result.spec);
          emitChange(ctx, { structural: true });
          renderGrid(ctx);
        }
      });
    });
  }

  function closestCell(node) {
    while (node && node.nodeType === 1) {
      if (node.classList && (node.classList.contains("rf-table-edit__td") || node.classList.contains("rf-table-edit__th"))) return node;
      node = node.parentNode;
    }
    return null;
  }

  function focusCell(ctx, r, c) {
    if (r < 0) r = 0;
    if (r >= ctx.spec.rows.length) r = ctx.spec.rows.length - 1;
    if (c < 0) c = 0;
    if (c >= ctx.spec.columns.length) c = ctx.spec.columns.length - 1;
    // 跳过 hidden 单元格——找右侧第一个可见格
    while (ctx.spec.rows[r][c] && ctx.spec.rows[r][c].hidden && c < ctx.spec.columns.length - 1) c++;
    ctx.activeR = r; ctx.activeC = c;
    ctx.selection = { r0: r, c0: c, r1: r, c1: c };
    var td = ctx.gridEl.querySelector('.rf-table-edit__td[data-r="' + r + '"][data-c="' + c + '"]');
    if (td) {
      td.focus();
      // 光标移到末尾
      placeCaretAtEnd(td);
    }
    highlightSelection(ctx);
  }

  function placeCaretAtEnd(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * 在 contentEditable 单元格的光标处插入一个换行（<br>）。
   * 用于 Alt+Enter / Shift+Enter：单元格内多行编辑。
   * 空单元格里插入 <br> 后再补一个，否则光标会停在 <br> 之前、视觉上看不到新行。
   */
  function insertLineBreak(td) {
    var sel = window.getSelection();
    var br = document.createElement("br");
    if (!sel || !sel.rangeCount) {
      td.appendChild(br);
    } else {
      var range = sel.getRangeAt(0);
      if (!td.contains(range.commonAncestorContainer)) {
        td.appendChild(br);
      } else {
        range.deleteContents();
        range.insertNode(br);
        range.setStartAfter(br);
        range.setEndAfter(br);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    // 空单元格末尾补一个 <br> 撑高，避免光标停在不可见位置
    if (!td.textContent && td.querySelectorAll("br").length < 2) {
      td.appendChild(document.createElement("br"));
    }
  }

  function highlightSelection(ctx) {
    var sel = ctx.selection;
    var tds = ctx.gridEl.querySelectorAll(".rf-table-edit__td");
    Array.prototype.forEach.call(tds, function (td) {
      var r = +td.dataset.r, c = +td.dataset.c;
      var inside = r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;
      var isActive = r === ctx.activeR && c === ctx.activeC;
      td.classList.toggle("is-selected", inside && !isActive);
      td.classList.toggle("is-active", isActive);
    });
  }

  // ---------- structural ops ----------

  function applyStyle(ctx, patch) {
    forSelectedCells(ctx, function (cell) {
      cell.style = cell.style || {};
      Object.keys(patch).forEach(function (k) {
        var v = patch[k];
        if (v === false || v == null) delete cell.style[k];
        else cell.style[k] = v;
      });
    });
    renderGrid(ctx);
    emitChange(ctx);
  }

  function applyFormat(ctx, kind) {
    forSelectedCells(ctx, function (cell) {
      if (kind === "text") cell.format = { kind: "text" };
      else cell.format = Object.assign({
        kind: kind, decimals: 0, thousands: kind === "number" || kind === "currency"
      }, cell.format && cell.format.kind === kind ? cell.format : {}, { kind: kind });
    });
    renderGrid(ctx);
    emitChange(ctx);
  }

  function changeDecimals(ctx, delta) {
    forSelectedCells(ctx, function (cell) {
      if (!cell.format || cell.format.kind === "text") {
        cell.format = { kind: "number", decimals: 0, thousands: false };
      }
      var d = (cell.format.decimals || 0) + delta;
      if (d < 0) d = 0; if (d > 6) d = 6;
      cell.format.decimals = d;
    });
    renderGrid(ctx);
    emitChange(ctx);
  }

  function toggleThousands(ctx) {
    forSelectedCells(ctx, function (cell) {
      if (!cell.format || cell.format.kind === "text") {
        cell.format = { kind: "number", decimals: 0, thousands: true };
      } else {
        cell.format.thousands = !cell.format.thousands;
      }
    });
    renderGrid(ctx);
    emitChange(ctx);
  }

  function forSelectedCells(ctx, fn) {
    var s = ctx.selection;
    for (var r = s.r0; r <= s.r1; r++) {
      for (var c = s.c0; c <= s.c1; c++) {
        var cell = ctx.spec.rows[r] && ctx.spec.rows[r][c];
        if (cell && !cell.hidden) fn(cell, r, c);
      }
    }
  }

  function visibleCellAt(ctx, r, c) {
    return ctx.spec.rows[r] && ctx.spec.rows[r][c];
  }

  // 行列增删 — 必须修正穿越的合并区
  function insertRow(ctx, where) {
    var pos = where === "above" ? ctx.activeR : ctx.activeR + 1;
    var newRow = ctx.spec.columns.map(function () { return schema.emptyCell(); });
    ctx.spec.rows.splice(pos, 0, newRow);
    // 修正穿越的 rowspan
    ctx.spec.rows.forEach(function (row, r) {
      row.forEach(function (cell, c) {
        if (cell.hidden) return;
        if (cell.rowspan > 1 && r < pos && r + cell.rowspan > pos) {
          cell.rowspan++;
        }
      });
    });
    rebuild(ctx);
  }

  function insertCol(ctx, where) {
    var pos = where === "left" ? ctx.activeC : ctx.activeC + 1;
    ctx.spec.columns.splice(pos, 0, {
      key: "c" + ctx.spec.columns.length, header: "", width: "auto", align: "left", format: null
    });
    ctx.spec.rows.forEach(function (row) {
      row.splice(pos, 0, schema.emptyCell());
    });
    // 修正穿越的 colspan
    ctx.spec.rows.forEach(function (row) {
      row.forEach(function (cell, c) {
        if (cell.hidden) return;
        if (cell.colspan > 1 && c < pos && c + cell.colspan > pos) {
          cell.colspan++;
        }
      });
    });
    rebuild(ctx);
  }

  function deleteRow(ctx) {
    if (ctx.spec.rows.length <= 1) return;
    ctx.spec.rows.splice(ctx.activeR, 1);
    if (ctx.activeR >= ctx.spec.rows.length) ctx.activeR = ctx.spec.rows.length - 1;
    rebuild(ctx);
  }

  function deleteCol(ctx) {
    if (ctx.spec.columns.length <= 1) return;
    ctx.spec.columns.splice(ctx.activeC, 1);
    ctx.spec.rows.forEach(function (row) { row.splice(ctx.activeC, 1); });
    if (ctx.activeC >= ctx.spec.columns.length) ctx.activeC = ctx.spec.columns.length - 1;
    rebuild(ctx);
  }

  function mergeSelection(ctx) {
    var s = ctx.selection;
    if (s.r0 === s.r1 && s.c0 === s.c1) return;     // 单格无须合并
    var main = ctx.spec.rows[s.r0][s.c0];
    main.rowspan = s.r1 - s.r0 + 1;
    main.colspan = s.c1 - s.c0 + 1;
    main.hidden = false;
    for (var r = s.r0; r <= s.r1; r++) {
      for (var c = s.c0; c <= s.c1; c++) {
        if (r === s.r0 && c === s.c0) continue;
        var cell = ctx.spec.rows[r][c];
        cell.rowspan = 1;
        cell.colspan = 1;
        cell.hidden = true;
      }
    }
    rebuild(ctx);
  }

  function splitActive(ctx) {
    var cell = ctx.spec.rows[ctx.activeR][ctx.activeC];
    if (!cell || (cell.rowspan === 1 && cell.colspan === 1)) return;
    var rs = cell.rowspan, cs = cell.colspan;
    cell.rowspan = 1; cell.colspan = 1;
    for (var dr = 0; dr < rs; dr++) {
      for (var dc = 0; dc < cs; dc++) {
        if (dr === 0 && dc === 0) continue;
        var t = ctx.spec.rows[ctx.activeR + dr][ctx.activeC + dc];
        if (t) {
          t.hidden = false;
          t.rowspan = 1;
          t.colspan = 1;
        }
      }
    }
    rebuild(ctx);
  }

  function toggleHeaderRow(ctx) {
    // 把活动行设为/取消"表头行"——通过调整 headerRows 实现
    // 简化：当 activeR === headerRows-1 时取消最近一层；否则把 headerRows 设为 activeR
    if (ctx.activeR === 0) {
      ctx.spec.headerRows = ctx.spec.headerRows >= 2 ? 1 : 2;
    } else {
      ctx.spec.headerRows = ctx.activeR + 1;
    }
    rebuild(ctx);
  }

  function rebuild(ctx) {
    ctx.spec = schema.fixTableSpec(ctx.spec);
    renderGrid(ctx);
    emitChange(ctx, { structural: true });
  }

  function fillFromCell(ctx, r0, c0, srcSpec) {
    srcSpec.rows.forEach(function (srcRow, dr) {
      var r = r0 + dr;
      // 自动扩展
      while (ctx.spec.rows.length <= r) {
        ctx.spec.rows.push(ctx.spec.columns.map(function () { return schema.emptyCell(); }));
      }
      srcRow.forEach(function (srcCell, dc) {
        var c = c0 + dc;
        while (ctx.spec.columns.length <= c) {
          ctx.spec.columns.push({
            key: "c" + ctx.spec.columns.length, header: "", width: "auto", align: "left", format: null
          });
          ctx.spec.rows.forEach(function (row) { row.push(schema.emptyCell()); });
        }
        ctx.spec.rows[r][c] = clone(srcCell);
      });
    });
  }

  // ---------- emit ----------

  function emitChange(ctx, opts) {
    if (!ctx.callbacks.onChange) return;
    var newBlk = {
      type: "table",
      title: ctx.title,
      caption: ctx.caption,
      spec: ctx.spec
    };
    ctx.callbacks.onChange(newBlk, opts || {});
  }

  // ---------- helpers ----------

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function textInput(value, onInput) {
    var i = document.createElement("input");
    i.type = "text";
    i.className = "rf-input";
    i.value = value || "";
    i.addEventListener("input", function () { onInput(i.value); });
    return i;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // 单元格内换行：先转义再把 \n 渲染成 <br>，复用 table-format 的实现保持一致。
  function escMultiline(s) {
    return fmt.escMultiline(s);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  window.RF_TableEditor = { mount: mount };
})();

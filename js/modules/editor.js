/**
 * editor.js — structured form editor.
 *
 * Renders the current report state into the middle pane as editable form
 * controls. Each input writes back into the report object and triggers a
 * state.set("report", ...) → which re-renders the preview.
 *
 * The editor mutates a *clone* per change to keep object identity rules
 * simple: state.set fires only when the new top-level reference differs.
 */
(function () {
  "use strict";

  var bus    = window.RF_Bus;
  var state  = window.RF_State;
  var schema = window.RF_Schema;
  var assets = window.RF_Assets;
  var imgMgr = window.RF_ImageManager;

  var rootEl = null;
  var saveTimer = null;
  var SAVE_DEBOUNCE = 500;

  // True only while we're inside our own commit() call. The state:report
  // bus event we emit there fires synchronously, so we use this flag to
  // suppress our own render() — otherwise every keystroke would tear down
  // and rebuild the entire form, ripping the focused input out from under
  // the user (lost caret, broken IME composition, "typing feels stuck").
  //
  // External sources of state:report (parser, template switch, history,
  // load-sample) don't go through commit(), so they still trigger render().
  // Structural commits (add/remove/move section or block) explicitly
  // request a rebuild via commit(rep, { structural: true }).
  var selfCommitting = false;

  function init() {
    rootEl = document.getElementById("rf-editor-root");
    if (!rootEl) return;

    bus.on("state:report", function () {
      if (selfCommitting) return;
      render();
    });

    // Buttons in foot
    var addSec = document.getElementById("rf-btn-add-section");
    if (addSec) addSec.addEventListener("click", function () {
      var rep = clone(state.get("report"));
      rep.sections.push({
        id: schema.uid("s-"),
        heading: "新章节",
        level: 1,
        blocks: [{ type: "text", format: "markdown", content: "" }]
      });
      commit(rep, { structural: true });
    });

    // Generate summary button
    var genSummaryBtn = document.getElementById("rf-btn-generate-summary");
    if (genSummaryBtn) genSummaryBtn.addEventListener("click", generateSummary);
  }

  /**
   * Persist a report change.
   *   opts.structural: true  -> rebuild the editor form (shape changed)
   *   opts.structural: false -> field value changed; preserve form DOM
   * Default is non-structural — the common case (typing into a field).
   */
  function commit(report, opts) {
    var v = schema.validate(report);
    selfCommitting = true;
    try { state.set("report", v.normalized); }
    finally { selfCommitting = false; }
    if (opts && opts.structural) render();
    schedulePersist();
  }

  function schedulePersist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try {
        window.RF_Storage.set("draft", "current", state.get("report"));
        bus.emit("draft:saved", { ts: Date.now() });
      } catch (e) {
        window.RF_UI.toast.warn("草稿保存失败（可能存储已满）");
      }
    }, SAVE_DEBOUNCE);
  }

  function render() {
    if (!rootEl) return;
    var report = state.get("report");
    if (!report) {
      rootEl.innerHTML = '<div class="rf-empty">尚无内容。在左侧粘贴文本并点击「解析」，或直接编辑。</div>';
      bus.emit("editor:rendered");
      return;
    }
    rootEl.innerHTML = "";
    rootEl.appendChild(renderMeta(report.meta));
    (report.sections || []).forEach(function (sec, i) {
      rootEl.appendChild(renderSection(sec, i));
    });
    bus.emit("editor:rendered");
  }

  // ===== Meta =====
  function renderMeta(meta) {
    var box = el("div", "rf-sec");
    var head = el("div", "rf-sec__head");
    head.appendChild(el("div", "rf-sec__title", "📄 报告基本信息"));
    box.appendChild(head);

    var body = el("div", "rf-sec__body");
    body.appendChild(field("标题",   text(meta.title,    function (v) { patchMeta({ title: v }); })));
    body.appendChild(field("副标题", text(meta.subtitle, function (v) { patchMeta({ subtitle: v }); })));

    var row = el("div", "rf-field-row");
    row.appendChild(field("作者", text(meta.author, function (v) { patchMeta({ author: v }); })));
    row.appendChild(field("日期", buildDatePicker(meta, function (v) { patchMeta({ date: v }); })));
    body.appendChild(row);

    body.appendChild(field("标签 (逗号分隔)",
      text((meta.tags || []).join(", "), function (v) {
        patchMeta({ tags: v.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean) });
      })
    ));
    box.appendChild(body);
    return box;
  }

  function patchMeta(partial) {
    var rep = clone(state.get("report"));
    rep.meta = Object.assign({}, rep.meta, partial);
    commit(rep);
  }

  // ===== Section =====
  function renderSection(sec, secIdx) {
    var box = el("div", "rf-sec");

    var head = el("div", "rf-sec__head");
    var headInput = text(sec.heading, function (v) {
      var rep = clone(state.get("report"));
      rep.sections[secIdx].heading = v;
      commit(rep);
    });
    headInput.placeholder = "章节标题";
    head.appendChild(headInput);

    var actions = el("div", "rf-sec__actions");
    actions.appendChild(btn("ghost", "↑", function () { moveSection(secIdx, -1); }, "上移"));
    actions.appendChild(btn("ghost", "↓", function () { moveSection(secIdx, +1); }, "下移"));
    actions.appendChild(btn("danger", "删除", function () { removeSection(secIdx); }));
    head.appendChild(actions);
    box.appendChild(head);

    var body = el("div", "rf-sec__body");
    (sec.blocks || []).forEach(function (blk, blkIdx) {
      body.appendChild(renderBlock(blk, secIdx, blkIdx, sec.blocks.length));
    });

    var addRow = el("div", "rf-row");
    addRow.appendChild(btn("ghost", "+ 文本",  function () { addBlock(secIdx, { type: "text", format: "markdown", content: "" }); }));
    addRow.appendChild(btn("ghost", "+ 图表",  function () { addBlock(secIdx, defaultChart()); }));
    addRow.appendChild(btn("ghost", "+ 表格",  function () { addBlock(secIdx, defaultTable()); }));
    addRow.appendChild(btn("ghost", "+ 图片",  function () { addBlock(secIdx, { type: "image", assetId: null, caption: "" }); }));
    body.appendChild(addRow);

    box.appendChild(body);
    return box;
  }

  function defaultChart() {
    return {
      type: "chart", title: "新图表",
      spec: { kind: "bar", categories: ["A", "B", "C"], series: [{ name: "数值", data: [10, 20, 15] }], unit: "" }
    };
  }

  function defaultTable() {
    return {
      type: "table", title: "新表格", caption: "",
      spec: {
        columns: [
          { key: "c0", header: "项目", width: "auto", align: "left",   format: null },
          { key: "c1", header: "Q1",   width: "auto", align: "right",  format: null },
          { key: "c2", header: "Q2",   width: "auto", align: "right",  format: null }
        ],
        rows: [
          [ { v: "示例 A", rowspan:1, colspan:1, hidden:false, style:{}, format:null },
            { v: 100,      rowspan:1, colspan:1, hidden:false, style:{}, format:null },
            { v: 120,      rowspan:1, colspan:1, hidden:false, style:{}, format:null } ],
          [ { v: "示例 B", rowspan:1, colspan:1, hidden:false, style:{}, format:null },
            { v: 80,       rowspan:1, colspan:1, hidden:false, style:{}, format:null },
            { v: 90,       rowspan:1, colspan:1, hidden:false, style:{}, format:null } ]
        ],
        headerRows: 1, footerRows: 0, merges: [], defaultAlign: "left", unit: ""
      }
    };
  }

  function moveSection(idx, delta) {
    var rep = clone(state.get("report"));
    var arr = rep.sections;
    var to = idx + delta;
    if (to < 0 || to >= arr.length) return;
    var [item] = arr.splice(idx, 1);
    arr.splice(to, 0, item);
    commit(rep, { structural: true });
  }
  function removeSection(idx) {
    window.RF_UI.confirm({
      title: "删除该章节？", body: "章节及其所有块将被删除。",
      danger: true, confirmLabel: "删除"
    }).then(function (ok) {
      if (!ok) return;
      var rep = clone(state.get("report"));
      rep.sections.splice(idx, 1);
      commit(rep, { structural: true });
    });
  }

  // ===== Block =====
  function renderBlock(blk, secIdx, blkIdx, total) {
    var box = el("div", "rf-blk rf-blk--" + blk.type);
    var head = el("div", "rf-blk__head");
    var label = blk.type === "text" ? "文本"
              : blk.type === "chart" ? "图表"
              : blk.type === "table" ? "表格"
              : "图片";
    head.appendChild(el("span", "rf-blk__type", label));

    var actions = el("div", "rf-blk__actions");
    actions.appendChild(btn("ghost", "↑", function () { moveBlock(secIdx, blkIdx, -1); }));
    actions.appendChild(btn("ghost", "↓", function () { moveBlock(secIdx, blkIdx, +1); }));
    actions.appendChild(btn("danger", "✕", function () { removeBlock(secIdx, blkIdx); }));
    head.appendChild(actions);
    box.appendChild(head);

    if (blk.type === "text") {
      var taWrap = el("div", "rf-text-edit");
      var ed = richText(blk.content, function (v) { patchBlock(secIdx, blkIdx, { content: v }); });
      ed.dataset.placeholder = "正文（**加粗**、高亮即时显示效果；其它 Markdown 以原文显示）";
      // 文本快捷工具栏（加粗 / 高亮），参考表格编辑器的 B / 高亮按钮
      taWrap.appendChild(buildTextToolbar(ed, function () {
        patchBlock(secIdx, blkIdx, { content: richHtmlToMd(ed) });
      }));
      taWrap.appendChild(ed);
      var expandBtn = btn("ghost", "⛶", function () {
        openTextFullscreen(secIdx, blkIdx, ed);
      }, "全屏编辑");
      expandBtn.classList.add("rf-text-edit__expand");
      taWrap.appendChild(expandBtn);
      box.appendChild(taWrap);
    }
    else if (blk.type === "chart") {
      box.appendChild(renderChartEditor(blk, secIdx, blkIdx));
    }
    else if (blk.type === "image") {
      box.appendChild(renderImageEditor(blk, secIdx, blkIdx));
    }
    else if (blk.type === "table") {
      mountTableEditor(blk, secIdx, blkIdx, box);
    }
    return box;
  }

  function mountTableEditor(blk, secIdx, blkIdx, box) {
    if (!window.RF_TableEditor) {
      box.appendChild(el("div", "rf-empty", "（table-editor.js 未加载）"));
      return;
    }
    var inst = window.RF_TableEditor.mount(box, blk, secIdx, blkIdx, {
      onChange: function (newBlk /*, opts */) {
        // 把表格的 spec/title/caption 整体回写。
        //
        // 这里【永远】走非 structural patch —— 即便是行/列/合并等结构性表格
        // 操作。table-editor 内部已通过 renderGrid 自管整张网格的 DOM，表单里
        // 这个 block 的位置和形态都不变，无需重建表单。
        //
        // 若透传 structural=true，commit() 会 render() 整个编辑区：当前表格连同
        // 页面上【其它所有表格】都会被销毁重挂。重挂出来的新实例 activeR/activeC
        // 默认 0/0，于是每个表格的首个单元格都被点亮成 is-active —— 这正是
        // “点一个单元格，焦点跳到别的表格首格” 的根因。去掉 structural 即可保住
        // 焦点、且不干扰其它表格。预览侧仍会在每次 state:report 时重渲，不受影响。
        patchBlock(secIdx, blkIdx, {
          title: newBlk.title,
          caption: newBlk.caption,
          spec: newBlk.spec
        });
      },
      // 「放大编辑」：打开弹窗，里面挂一个更大的同 block 表格编辑器。
      onExpand: function () {
        openTableFullscreen(secIdx, blkIdx, inst);
      }
    });
  }

  // 在大弹窗中独立编辑表格。弹窗里挂第二个 table-editor 实例，绑定同一个 block，
  // 同样走非 structural 的 patchBlock 回写（commit 内 selfCommitting 守卫，不重渲表单、
  // 不丢焦点、不影响其它表格）。关闭后用最新的 block 调 inst.reload()，让内联实例
  // 同步弹窗里所做的修改。
  function openTableFullscreen(secIdx, blkIdx, inlineInst) {
    function currentBlk() {
      var rep = state.get("report");
      return rep && rep.sections[secIdx] && rep.sections[secIdx].blocks[blkIdx];
    }
    var blk = currentBlk();
    if (!blk) return;

    var host = el("div", "rf-table-fullscreen");
    var bigInst = window.RF_TableEditor.mount(host, blk, secIdx, blkIdx, {
      onChange: function (newBlk) {
        patchBlock(secIdx, blkIdx, {
          title: newBlk.title,
          caption: newBlk.caption,
          spec: newBlk.spec
        });
      }
      // 不传 onExpand：弹窗内不再显示「放大」按钮，避免自我嵌套。
    });

    window.RF_UI.modal.open({
      title: "编辑表格",
      bodyEl: host,
      size: "lg",
      onClose: function () {
        if (bigInst) bigInst.destroy();
        // 把弹窗里编辑后的最新内容同步回内联实例。
        var latest = currentBlk();
        if (latest && inlineInst && typeof inlineInst.reload === "function") {
          inlineInst.reload(latest);
        }
      }
    });
  }

  // 在大弹窗中编辑文本块。大编辑器与小框共用 patchBlock 回写，
  // 因 commit() 内 selfCommitting 守卫，输入不会重渲表单也不会丢焦点。
  // 关闭弹窗后用最新内容同步回小框（sourceEd 是内联富文本编辑器）。
  function openTextFullscreen(secIdx, blkIdx, sourceEd) {
    var rep = state.get("report");
    var content = (rep && rep.sections[secIdx] && rep.sections[secIdx].blocks[blkIdx] &&
                   rep.sections[secIdx].blocks[blkIdx].content) || "";
    var bigEd = richText(content, function (v) {
      patchBlock(secIdx, blkIdx, { content: v });
      if (sourceEd) sourceEd.innerHTML = mdToRichHtml(v);
    });
    bigEd.classList.add("rf-richtext--fullscreen");
    bigEd.dataset.placeholder = "正文（**加粗**、高亮即时显示效果；其它 Markdown 以原文显示）";
    var bigWrap = el("div", "rf-text-fullscreen");
    bigWrap.appendChild(buildTextToolbar(bigEd, function () {
      var md = richHtmlToMd(bigEd);
      patchBlock(secIdx, blkIdx, { content: md });
      if (sourceEd) sourceEd.innerHTML = mdToRichHtml(md);
    }));
    bigWrap.appendChild(bigEd);
    window.RF_UI.modal.open({
      title: "编辑文本",
      bodyEl: bigWrap,
      size: "lg"
    });
    setTimeout(function () { bigEd.focus(); }, 0);
  }

  function renderChartEditor(blk, secIdx, blkIdx) {
    var wrap = document.createElement("div");
    var titleInput = text(blk.title || "", function (v) { patchBlock(secIdx, blkIdx, { title: v }); });
    titleInput.placeholder = "图表标题";
    wrap.appendChild(field("标题", titleInput));

    var grid = el("div", "rf-chart-grid");
    var kindSel = select(["bar", "line", "pie"], blk.spec.kind, function (v) {
      patchBlock(secIdx, blkIdx, { spec: Object.assign({}, blk.spec, { kind: v }) });
    });
    grid.appendChild(field("类型", kindSel));
    var unitInput = text(blk.spec.unit || "", function (v) {
      patchBlock(secIdx, blkIdx, { spec: Object.assign({}, blk.spec, { unit: v }) });
    });
    unitInput.placeholder = "单位（可选）";
    grid.appendChild(field("单位", unitInput));
    wrap.appendChild(grid);

    // categories
    var catsInput = text((blk.spec.categories || []).join(", "), function (v) {
      var arr = v.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
      patchBlock(secIdx, blkIdx, { spec: Object.assign({}, blk.spec, { categories: arr }) });
    });
    catsInput.placeholder = "类别，用逗号分隔，如：华东, 华南, 华北";
    wrap.appendChild(field("类别", catsInput));

    // series — JSON-edit textarea (compact, 1 line per series)
    var seriesText = (blk.spec.series || []).map(function (s) {
      return s.name + ": " + (s.data || []).join(", ");
    }).join("\n");
    var seriesArea = textarea(seriesText, function (v) {
      var lines = v.split(/\n+/).map(function (line) { return line.trim(); }).filter(Boolean);
      var series = lines.map(function (line) {
        var parts = line.split(":");
        var name = parts.length > 1 ? parts.shift().trim() : "系列";
        var nums = parts.join(":").split(/[,，]/).map(function (n) { return Number(n.trim()) || 0; });
        return { name: name, data: nums };
      });
      patchBlock(secIdx, blkIdx, { spec: Object.assign({}, blk.spec, { series: series }) });
    });
    seriesArea.rows = 3;
    seriesArea.classList.add("rf-mono");
    seriesArea.placeholder = "每行一组：系列名: 1, 2, 3";
    wrap.appendChild(field("数据系列", seriesArea, "格式：系列名: 数1, 数2, 数3（每行一组）"));
    return wrap;
  }

  function renderImageEditor(blk, secIdx, blkIdx) {
    var wrap = document.createElement("div");
    var preview = el("div", "rf-img-blk__preview", "（尚未上传）");
    if (blk.assetId) {
      assets.url(blk.assetId).then(function (url) {
        if (!url) { preview.textContent = "（资源丢失：" + blk.assetId + "）"; return; }
        preview.innerHTML = "";
        var img = document.createElement("img"); img.src = url; preview.appendChild(img);
      });
    } else if (blk.src) {
      preview.innerHTML = "";
      var img = document.createElement("img"); img.src = blk.src; preview.appendChild(img);
    }
    wrap.appendChild(preview);

    var row = el("div", "rf-row");
    var fileInput = document.createElement("input");
    fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.style.display = "none";
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      if (!f) return;
      imgMgr.upload(f).then(function (rec) {
        var rep = clone(state.get("report"));
        var prev = rep.sections[secIdx].blocks[blkIdx];
        if (prev.assetId && prev.assetId !== rec.id) {
          imgMgr.remove(prev.assetId);
        }
        rep.sections[secIdx].blocks[blkIdx] = Object.assign({}, prev, { assetId: rec.id, src: null });
        // Structural: assetId going from null to a value adds a "移除" button.
        commit(rep, { structural: true });
      });
    });
    var pickBtn = btn("ghost", "上传图片", function () { fileInput.click(); });
    row.appendChild(pickBtn); row.appendChild(fileInput);

    var captionInput = text(blk.caption || "", function (v) {
      patchBlock(secIdx, blkIdx, { caption: v });
    });
    captionInput.placeholder = "图片说明";
    row.appendChild(captionInput);

    if (blk.assetId) {
      row.appendChild(btn("danger", "移除", function () {
        imgMgr.remove(blk.assetId);
        // Structural: removing the asset removes this very 「移除」 button.
        patchBlock(secIdx, blkIdx, { assetId: null }, { structural: true });
      }));
    }
    wrap.appendChild(row);
    return wrap;
  }

  function patchBlock(secIdx, blkIdx, partial, opts) {
    var rep = clone(state.get("report"));
    var b = rep.sections[secIdx].blocks[blkIdx];
    rep.sections[secIdx].blocks[blkIdx] = Object.assign({}, b, partial);
    commit(rep, opts);
  }
  function moveBlock(secIdx, blkIdx, delta) {
    var rep = clone(state.get("report"));
    var arr = rep.sections[secIdx].blocks;
    var to = blkIdx + delta;
    if (to < 0 || to >= arr.length) return;
    var [item] = arr.splice(blkIdx, 1);
    arr.splice(to, 0, item);
    commit(rep, { structural: true });
  }
  function addBlock(secIdx, blk) {
    var rep = clone(state.get("report"));
    rep.sections[secIdx].blocks.push(blk);
    commit(rep, { structural: true });
  }
  function removeBlock(secIdx, blkIdx) {
    var rep = clone(state.get("report"));
    var b = rep.sections[secIdx].blocks[blkIdx];
    if (b && b.assetId) imgMgr.remove(b.assetId);
    rep.sections[secIdx].blocks.splice(blkIdx, 1);
    commit(rep, { structural: true });
  }

  // ===== 文本快捷工具栏（加粗 / 高亮）=====
  // ===== 文本快捷工具栏（加粗 / 高亮）=====
  // 文本块为富文本编辑器（contentEditable）：**加粗** 与 <mark> 高亮即时显示效果，
  // 其它 Markdown（列表 / 标题 / `代码` / 链接）以原文显示。底层仍以 Markdown
  // 存储（mdToRichHtml ↔ richHtmlToMd 双向转换），预览与导出沿用既有渲染。
  function buildTextToolbar(ed, onChange) {
    var bar = el("div", "rf-text-toolbar");

    bar.appendChild(txtBtn("B", "加粗", "rf-text-toolbar__btn--bold", function () {
      toggleBold(ed);
      onChange();
    }));

    bar.appendChild(hlBtn("num", "数字高亮", "#fff1a8", function () {
      applyHighlight(ed, "num");
      onChange();
    }));
    bar.appendChild(hlBtn("text", "文字高亮", "#c8f2d4", function () {
      applyHighlight(ed, "text");
      onChange();
    }));
    return bar;
  }

  function txtBtn(label, title, extraCls, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "rf-text-toolbar__btn" + (extraCls ? " " + extraCls : "");
    b.textContent = label;
    b.title = title;
    b.addEventListener("mousedown", function (e) { e.preventDefault(); }); // 不抢焦点 / 保留选区
    b.addEventListener("click", onClick);
    return b;
  }

  function hlBtn(kind, title, bg, onClick) {
    var b = txtBtn("", title, "rf-text-toolbar__btn--hl", onClick);
    var sw = el("span", "rf-text-toolbar__sw");
    sw.style.background = bg;
    b.appendChild(sw);
    b.appendChild(document.createTextNode(kind === "num" ? "数字" : "文字"));
    return b;
  }

  // 富文本编辑器（contentEditable）。值以 Markdown 形式进出。
  function richText(value, onInput) {
    var ed = document.createElement("div");
    ed.className = "rf-richtext";
    ed.contentEditable = "true";
    ed.spellcheck = false;
    ed.innerHTML = mdToRichHtml(value);
    ed.addEventListener("input", function () { onInput(richHtmlToMd(ed)); });
    return ed;
  }

  // ---- 工具栏操作（contentEditable 选区）----
  function toggleBold(ed) {
    ed.focus();
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || !ed.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
    // execCommand 同时支持「加粗」与「取消加粗」的切换，跨节点选区也可用。
    try { document.execCommand("bold"); } catch (e) { /* 老浏览器忽略 */ }
  }

  function applyHighlight(ed, kind) {
    ed.focus();
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    if (!ed.contains(range.commonAncestorContainer)) return;

    // 选区已在 mark 内 → 取消高亮（再次点击=清除）。
    var existing = enclosingMark(ed, range.commonAncestorContainer);
    if (existing) { unwrapEl(existing); return; }

    var mark = document.createElement("mark");
    mark.className = "rf-hl rf-hl--" + kind;
    if (range.collapsed) {
      mark.textContent = "高亮文本";
      range.insertNode(mark);
    } else {
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
    }
    // 选中刚包裹的内容，便于继续编辑
    var r = document.createRange();
    r.selectNodeContents(mark);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function enclosingMark(root, node) {
    while (node && node !== root) {
      if (node.nodeType === 1 && node.nodeName === "MARK" &&
          node.className.indexOf("rf-hl") >= 0) return node;
      node = node.parentNode;
    }
    return null;
  }

  // 把元素替换为它的子节点（脱壳），用于取消高亮。
  function unwrapEl(elm) {
    var parent = elm.parentNode;
    if (!parent) return;
    while (elm.firstChild) parent.insertBefore(elm.firstChild, elm);
    parent.removeChild(elm);
  }

  // ---- Markdown ↔ 富文本 HTML（仅处理 **加粗** 与 <mark> 高亮）----
  // 其它 Markdown 一律按原文（转义后）保留为纯文本节点。
  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // 仅把 **...** 转为 <strong>，其余文本转义。
  function inlineBold(s) {
    var out = "", re = /\*\*([\s\S]+?)\*\*/g, last = 0, m;
    while ((m = re.exec(s))) {
      out += escHtml(s.slice(last, m.index)) + "<strong>" + escHtml(m[1]) + "</strong>";
      last = m.index + m[0].length;
    }
    return out + escHtml(s.slice(last));
  }

  function mdToRichHtml(md) {
    md = String(md == null ? "" : md);
    // 关键：**加粗** 可能跨越 <mark> 边界（如 `**前<mark…>中</mark>后**` 或
    // `**<mark…>文本</mark>**`）。若先按 <mark> 切片再各自跑 inlineBold，**
    // 会被拆散、无法配对，导致编辑器里显示成字面星号。
    // 因此先把 <mark> 起止标签替换成哨兵占位符（不含 & < > 不会被转义影响），
    // 在「整串」上做加粗匹配，最后再把占位符还原成真正的 <mark> 标签。
    // 占位符用 NUL 控制字符做边界：用户在 contentEditable 中无法输入，
    // 因此绝不会与正文冲突；也不含 & < >（不受 escHtml 影响），更不会被 ** 误吞。
    var Z = String.fromCharCode(0);            // 边界标记
    var opens = [];
    var tmp = md
      .replace(/<mark class="rf-hl rf-hl--(num|text)">/g, function (_, kind) {
        opens.push(kind);
        return Z + "o" + (opens.length - 1) + Z;   // 起始：Zo<idx>Z
      })
      .replace(/<\/mark>/g, Z + "c" + Z);          // 结束：ZcZ

    var openRe = new RegExp(Z + "o(\\d+)" + Z, "g");
    var closeRe = new RegExp(Z + "c" + Z, "g");
    var html = inlineBold(tmp)
      .replace(openRe, function (_, i) {
        return "<mark class=\"rf-hl rf-hl--" + opens[Number(i)] + "\">";
      })
      .replace(closeRe, "</mark>");

    return html.replace(/\n/g, "<br>");
  }

  function richHtmlToMd(ed) {
    // contentEditable \u5E38\u628A\u7A7A\u683C\u6362\u6210 &nbsp;(\u00A0)\uFF0C\u56DE\u5199\u65F6\u8FD8\u539F\u4E3A\u666E\u901A\u7A7A\u683C\u3002
    return nodeToMd(ed).replace(/\u00A0/g, " ");
  }

  function nodeToMd(node) {
    var md = "";
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var ch = kids[i];
      if (ch.nodeType === 3) {            // 文本节点
        md += ch.nodeValue;
      } else if (ch.nodeType === 1) {     // 元素
        var name = ch.nodeName;
        var fw = ch.style && ch.style.fontWeight;
        var styledBold = fw === "bold" || fw === "bolder" || (parseInt(fw, 10) >= 600);
        if (name === "BR") {
          md += "\n";
        } else if (name === "STRONG" || name === "B") {
          md += "**" + nodeToMd(ch) + "**";
        } else if (name === "MARK") {
          var kind = ch.className.indexOf("rf-hl--num") >= 0 ? "num" : "text";
          md += '<mark class="rf-hl rf-hl--' + kind + '">' + nodeToMd(ch) + "</mark>";
        } else if (styledBold) {
          // 某些浏览器 execCommand("bold") 产出 <span style="font-weight:..">
          md += "**" + nodeToMd(ch) + "**";
        } else if (name === "DIV" || name === "P") {
          // contentEditable 用 div/p 表示新行：块前补换行（非开头且未已换行）。
          if (md && !/\n$/.test(md)) md += "\n";
          md += nodeToMd(ch);
        } else {
          md += nodeToMd(ch);
        }
      }
    }
    return md;
  }

  // ===== Helpers =====
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function field(label, control, hint) {
    var w = el("label", "rf-field");
    w.appendChild(el("span", "rf-field__label", label));
    w.appendChild(control);
    if (hint) w.appendChild(el("span", "rf-field__hint", hint));
    return w;
  }
  function text(value, onInput, opts) {
    var i = document.createElement("input");
    i.type = "text"; i.className = "rf-input"; i.value = value || "";
    if (opts && opts.placeholder) i.placeholder = opts.placeholder;
    i.addEventListener("input", function () { onInput(i.value); });
    return i;
  }
  function textarea(value, onInput) {
    var t = document.createElement("textarea");
    t.className = "rf-textarea"; t.value = value || "";
    t.addEventListener("input", function () { onInput(t.value); });
    return t;
  }
  function select(options, value, onChange) {
    var s = document.createElement("select");
    s.className = "rf-select";
    options.forEach(function (op) {
      var o = document.createElement("option"); o.value = op; o.textContent = op;
      if (op === value) o.selected = true;
      s.appendChild(o);
    });
    s.addEventListener("change", function () { onChange(s.value); });
    return s;
  }
  function btn(kind, label, onClick, title) {
    var b = document.createElement("button");
    b.className = "rf-btn rf-btn--" + (kind === "primary" ? "primary" : kind === "danger" ? "danger" : "ghost");
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  // 日期快捷下拉：input + 📅 按钮 + 下拉菜单（今天/本周/本月/本季度/本年/自定义）。
  // 选中后写入 input 并调用 onChange；菜单点击外部关闭。
  function buildDatePicker(meta, onChange) {
    var wrap = el("div", "rf-date-picker");
    var input = text(meta.date, function (v) { onChange(v); }, { placeholder: "可空。点击 📅 选择" });
    wrap.appendChild(input);

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "rf-btn rf-btn--ghost rf-date-picker__btn";
    trigger.title = "选择日期";
    trigger.textContent = "📅";
    wrap.appendChild(trigger);

    var menu = el("div", "rf-date-picker__menu");
    menu.hidden = true;
    wrap.appendChild(menu);

    var d = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    var iso = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    // ISO 8601 周（以周四锚定）
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    var yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    var weekNo = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
    var qNames = ["第一", "第二", "第三", "第四"];
    var fmt = {
      today:   iso,
      week:    t.getUTCFullYear() + " 年第 " + weekNo + " 周",
      month:   d.getFullYear() + " 年 " + (d.getMonth() + 1) + " 月",
      quarter: d.getFullYear() + " 年" + qNames[Math.floor(d.getMonth() / 3)] + "季度",
      year:    d.getFullYear() + " 年"
    };

    var items = [
      { label: "今天 (" + fmt.today + ")",       value: fmt.today   },
      { label: "本周 (" + fmt.week + ")",         value: fmt.week    },
      { label: "本月 (" + fmt.month + ")",        value: fmt.month   },
      { label: "本季度 (" + fmt.quarter + ")",    value: fmt.quarter },
      { label: "本年 (" + fmt.year + ")",         value: fmt.year    },
      { label: "自定义日期…",                      value: "__custom__" }
    ];
    items.forEach(function (it) {
      var rowEl = el("div", "rf-date-picker__item", it.label);
      rowEl.addEventListener("click", function (e) {
        e.stopPropagation();
        closeMenu();
        if (it.value === "__custom__") {
          var picker = document.createElement("input");
          picker.type = "date";
          picker.style.position = "fixed";
          picker.style.left = "-9999px";
          document.body.appendChild(picker);
          var cleanup = function () {
            if (picker.parentNode) picker.parentNode.removeChild(picker);
          };
          picker.addEventListener("change", function () {
            if (picker.value) { input.value = picker.value; onChange(picker.value); }
            cleanup();
          });
          picker.addEventListener("blur", cleanup);
          try {
            if (typeof picker.showPicker === "function") picker.showPicker();
            else picker.click();
          } catch (_) { picker.click(); }
        } else {
          input.value = it.value;
          onChange(it.value);
        }
      });
      menu.appendChild(rowEl);
    });

    var onDocClick = null;
    function closeMenu() {
      menu.hidden = true;
      if (onDocClick) {
        document.removeEventListener("click", onDocClick);
        onDocClick = null;
      }
    }
    function openMenu() {
      menu.hidden = false;
      onDocClick = function (e) { if (!wrap.contains(e.target)) closeMenu(); };
      // 延后到下一轮事件循环再挂，避免与触发本次打开的 click 冒泡冲突
      setTimeout(function () { document.addEventListener("click", onDocClick); }, 0);
    }

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.hidden) openMenu(); else closeMenu();
    });

    return wrap;
  }

  // ===== 摘要生成 =====
  function generateSummary() {
    var report = state.get("report");
    if (!report || !report.sections || report.sections.length === 0) {
      window.RF_UI.toast.warn("请先解析或创建报告内容");
      return;
    }

    // 检查是否已有摘要章节
    var existingSummaryIdx = report.sections.findIndex(function (s) {
      return s.heading === "摘要" || s.heading === "报告摘要" || s.heading === "执行摘要";
    });

    var btn = document.getElementById("rf-btn-generate-summary");
    var originalText = btn ? btn.innerHTML : "";
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = "⏳ 正在生成...";
    }

    // 构建 prompt：提取所有文本内容
    var allText = [];
    report.sections.forEach(function (sec) {
      if (existingSummaryIdx >= 0 && sec.heading === report.sections[existingSummaryIdx].heading) return;
      allText.push("【" + sec.heading + "】");
      (sec.blocks || []).forEach(function (blk) {
        if (blk.type === "text") {
          allText.push(blk.content);
        } else if (blk.type === "chart") {
          allText.push("[图表: " + blk.title + "]");
        } else if (blk.type === "table") {
          allText.push("[表格: " + blk.title + "]");
        }
      });
    });

    var prompt = [
      {
        role: "system",
        content: "你是报告摘要助手。请基于下面的报告内容，生成一份简洁、专业的执行摘要，长度约 150-250 字。要求：\n"
               + "1) 涵盖核心结论和关键数据\n"
               + "2) 使用正式、专业的商务语气\n"
               + "3) 用 **加粗** 突出最重要的数字或结论\n"
               + "4) 只输出摘要内容本身，不要任何解释、标题或 markdown 代码块\n"
               + "5) 摘要应该是一个完整的段落或由几个短句组成"
      },
      {
        role: "user",
        content: "报告标题：" + (report.meta && report.meta.title || "无标题") + "\n\n"
               + "报告内容：\n" + allText.join("\n\n")
      }
    ];

    window.RF_LLM.complete({
      messages: prompt,
      temperature: 0.6,
      maxTokens: 600
    }).then(function (summaryText) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }

      var rep = clone(report);
      var summarySection = {
        id: schema.uid("s-"),
        heading: "摘要",
        level: 1,
        blocks: [{
          type: "text",
          format: "markdown",
          content: String(summaryText || "").trim()
        }]
      };

      if (existingSummaryIdx >= 0) {
        // 更新现有摘要
        rep.sections[existingSummaryIdx] = summarySection;
        window.RF_UI.toast.ok("摘要已更新");
      } else {
        // 在最前面插入新的摘要章节
        rep.sections.unshift(summarySection);
        window.RF_UI.toast.ok("摘要已生成并添加到报告开头");
      }

      commit(rep, { structural: true });
    }).catch(function (err) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
      window.RF_UI.toast.error("摘要生成失败: " + (err.message || String(err)));
    });
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  window.RF_Editor = { init: init, render: render, generateSummary: generateSummary };
})();

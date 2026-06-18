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
      return;
    }
    rootEl.innerHTML = "";
    rootEl.appendChild(renderMeta(report.meta));
    (report.sections || []).forEach(function (sec, i) {
      rootEl.appendChild(renderSection(sec, i));
    });
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
    row.appendChild(field("日期", text(meta.date,   function (v) { patchMeta({ date: v }); }, { placeholder: "YYYY-MM-DD" })));
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
    var label = blk.type === "text" ? "文本" : blk.type === "chart" ? "图表" : "图片";
    head.appendChild(el("span", "rf-blk__type", label));

    var actions = el("div", "rf-blk__actions");
    actions.appendChild(btn("ghost", "↑", function () { moveBlock(secIdx, blkIdx, -1); }));
    actions.appendChild(btn("ghost", "↓", function () { moveBlock(secIdx, blkIdx, +1); }));
    actions.appendChild(btn("danger", "✕", function () { removeBlock(secIdx, blkIdx); }));
    head.appendChild(actions);
    box.appendChild(head);

    if (blk.type === "text") {
      var ta = textarea(blk.content, function (v) { patchBlock(secIdx, blkIdx, { content: v }); });
      ta.placeholder = "支持 Markdown：**加粗**、列表、`代码`...";
      ta.rows = 4;
      box.appendChild(ta);
    }
    else if (blk.type === "chart") {
      box.appendChild(renderChartEditor(blk, secIdx, blkIdx));
    }
    else if (blk.type === "image") {
      box.appendChild(renderImageEditor(blk, secIdx, blkIdx));
    }
    return box;
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
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  window.RF_Editor = { init: init, render: render };
})();

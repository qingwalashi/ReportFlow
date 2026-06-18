/**
 * history.js — drafts and snapshot history.
 *
 * Storage layout:
 *   storage.draft.history       -> [{id, ts, title, sections, snapshotKey}]
 *   storage.draft.snapshot:<id> -> the full Report JSON for that snapshot
 *
 * "Save snapshot" copies the current report into a new versioned entry.
 * "Load" replaces the live report.
 */
(function () {
  "use strict";

  var storage = window.RF_Storage;
  var state   = window.RF_State;
  var schema  = window.RF_Schema;
  var bus     = window.RF_Bus;
  var log     = window.RF_Log;

  var INDEX_NS = "draft", INDEX_KEY = "history";
  var SNAP_NS  = "draft";

  function init() {
    var btn = document.getElementById("rf-btn-history");
    if (btn) btn.addEventListener("click", openModal);
    var snap = document.getElementById("rf-btn-snapshot");
    if (snap) snap.addEventListener("click", saveSnapshot);

    // Ctrl+S shortcut
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault(); saveSnapshot();
      }
    });
  }

  function list() {
    return storage.get(INDEX_NS, INDEX_KEY, []) || [];
  }

  function saveSnapshot() {
    var report = state.get("report");
    if (!report) { window.RF_UI.toast.warn("没有可快照的内容"); return; }
    var id = "snap-" + Date.now().toString(36);
    var entry = {
      id: id,
      ts: Date.now(),
      title: (report.meta && report.meta.title) || "未命名",
      templateId: state.get("templateId") || null,
      sections: (report.sections || []).length
    };
    try {
      storage.set(SNAP_NS, "snapshot:" + id, report);
      var idx = list();
      idx.unshift(entry);
      // Cap to most-recent 30
      if (idx.length > 30) {
        idx.slice(30).forEach(function (e) {
          try { storage.del(SNAP_NS, "snapshot:" + e.id); } catch (err) {}
        });
        idx = idx.slice(0, 30);
      }
      storage.set(INDEX_NS, INDEX_KEY, idx);
      window.RF_UI.toast.ok("已保存快照");
      log.info("history: snapshot " + id);
      bus.emit("history:saved", entry);
    } catch (err) {
      window.RF_UI.toast.err("快照保存失败：" + (err && err.message));
    }
  }

  function loadSnapshot(id) {
    var rep = storage.get(SNAP_NS, "snapshot:" + id, null);
    if (!rep) { window.RF_UI.toast.err("快照不存在或已被清理"); return; }
    var v = schema.validate(rep);
    state.set("report", v.normalized);
    storage.set("draft", "current", v.normalized);
    window.RF_UI.toast.ok("已载入快照");
  }

  function deleteSnapshot(id) {
    try { storage.del(SNAP_NS, "snapshot:" + id); } catch (e) {}
    var idx = list().filter(function (e) { return e.id !== id; });
    storage.set(INDEX_NS, INDEX_KEY, idx);
  }

  function openModal() {
    var body = document.createElement("div");
    var entries = list();
    if (!entries.length) {
      body.innerHTML = '<div class="rf-empty">尚无历史快照。点击底部「📌 存为快照」或按 Ctrl/Cmd+S 创建一个。</div>';
    } else {
      var ul = document.createElement("div");
      ul.style.cssText = "display:flex;flex-direction:column;gap:8px;";
      entries.forEach(function (e) {
        var row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--rf-line);border-radius:6px;background:#fff;";
        var info = document.createElement("div"); info.style.flex = "1";
        var t = document.createElement("div");
        t.textContent = e.title;
        t.style.cssText = "font-weight:600;margin-bottom:2px;";
        var sub = document.createElement("div");
        sub.style.cssText = "font-size:12px;color:var(--rf-text-muted);";
        sub.textContent = new Date(e.ts).toLocaleString() +
          "  ·  " + e.sections + " 章节" +
          (e.templateId ? "  ·  " + e.templateId : "");
        info.appendChild(t); info.appendChild(sub);
        row.appendChild(info);

        var loadBtn = document.createElement("button");
        loadBtn.className = "rf-btn rf-btn--primary";
        loadBtn.textContent = "载入";
        loadBtn.addEventListener("click", function () {
          loadSnapshot(e.id);
          window.RF_UI.modal.close();
        });

        var delBtn = document.createElement("button");
        delBtn.className = "rf-btn rf-btn--danger";
        delBtn.textContent = "删除";
        delBtn.addEventListener("click", function () {
          window.RF_UI.confirm({ title: "删除该快照？", body: e.title, danger: true })
            .then(function (ok) {
              if (!ok) return;
              deleteSnapshot(e.id);
              row.remove();
              if (!list().length) {
                body.innerHTML = '<div class="rf-empty">尚无历史快照。</div>';
              }
            });
        });
        row.appendChild(loadBtn); row.appendChild(delBtn);
        ul.appendChild(row);
      });
      body.appendChild(ul);
    }

    window.RF_UI.modal.open({
      title: "历史快照（最近 30 条）",
      bodyEl: body,
      size: "lg"
    });
  }

  window.RF_History = {
    init: init,
    list: list,
    saveSnapshot: saveSnapshot,
    loadSnapshot: loadSnapshot,
    deleteSnapshot: deleteSnapshot,
    openModal: openModal
  };
})();

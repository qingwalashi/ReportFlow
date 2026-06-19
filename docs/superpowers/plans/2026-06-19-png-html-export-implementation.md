# 实时预览图片导出 + 纯 HTML 导出 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在右侧"实时预览"面板新增 PNG 长图导出 + 单文件 HTML 导出，并把现有 PDF/ZIP 与新增项一起收纳进单一"导出 ▾"下拉菜单，使顶栏更紧凑。

**Architecture:** 把三个 exporter 中重复的"克隆 #root → 图表 SVG 化 → 收集 CSS → 解析图片资源 → 文件名清洗"逻辑抽到 `exporter-common.js`；新增 `exporter-png.js`（复用 `html2pdf().toCanvas()` 拿 canvas，再 `canvas.toBlob` 为 PNG）和 `exporter-html.js`（图片用 data URL 内联，输出单一 .html 文件）。重构后的 PDF / ZIP 行为字节级保持一致。

**Tech Stack:** 纯静态 + 已有 vendored libs（`html2pdf.bundle.min.js` / `jszip.min.js`）。**不引入新依赖。**

## Global Constraints

- 纯静态项目：所有依赖 vendored 在 `libs/`，不引入新的第三方包。
- IIFE + `window.RF_*` 全局命名空间，禁用 ESM。
- 兼容 `file://` 与 http(s) 双协议。
- 旧 exporter（PDF / ZIP）的对外 API 与导出文件**功能与视觉**保持一致；允许内部重构带来的非语义微差（如 attribute 顺序、空白）。
- 加载脚本顺序：`exporter-common.js` 必须排在 `exporter-pdf.js` / `exporter-zip.js` / `exporter-png.js` / `exporter-html.js` 之前。
- 预览快照入口固定为 `window.RF_Preview.snapshotForExport()`，返回 `{ doc, rootHtml, rootClass, bodyClass, head }`。
- 项目无单元测试基础设施；本计划用"手工功能验证"代替自动化测试，每个任务的验证步骤都写明具体点击路径与预期结果。
- 中文 UI 文案、按钮顺序：PDF / 图片 / HTML / ZIP。
- 任何 commit 信息以 `feat:` / `refactor:` / `fix:` 开头，使用中英文混排正文，不带 Co-Authored-By。

---

## 文件结构总览

| 路径 | 责任 | 本计划操作 |
|------|------|----------|
| `js/modules/exporter-common.js` | 共享 helper：`cloneRoot` / `resolveImages` / `collectCssText` / `safeFileName` / `triggerDownload` / `setBusy` | 新增（Task 1） |
| `js/modules/exporter-pdf.js` | PDF 导出（重构成调用 common） | 修改（Task 2） |
| `js/modules/exporter-zip.js` | ZIP 导出（重构成调用 common） | 修改（Task 3） |
| `js/modules/exporter-png.js` | PNG 长图导出 | 新增（Task 4） |
| `js/modules/exporter-html.js` | 单文件 HTML 导出 | 新增（Task 5） |
| `index.html` | 顶栏 4 个按钮换成下拉；script 列表加新模块 | 修改（Task 6） |
| `css/components.css` | 追加 `.rf-export-menu*` 样式 | 修改（Task 6） |
| `js/core/bootstrap.js` | 移除旧 `rf-btn-export-zip` / `rf-btn-export-pdf` 绑定，改成 `rf-btn-export` + 菜单委托 | 修改（Task 6） |

---

## Task 1：抽取 `exporter-common.js` 共享 helper

**Files:**
- Create: `js/modules/exporter-common.js`

**Interfaces:**
- Produces:
  - `RF_ExportCommon.cloneRoot(snap, report)` → `{ rootClone: HTMLElement, doc: Document }`
    把预览 iframe 的 `#root` 克隆出来，并把所有 `.rf-chart-card__body, [data-rf-chart]` 容器内 ECharts 图表替换为 inline SVG。
  - `RF_ExportCommon.resolveImages(rootClone, mode)` → `Promise<assetMap>`
    `mode="dataurl"`：把 `<img data-rf-asset="...">` 的 `src` 改写成 base64 data URL，移除 `data-rf-asset`，返回空对象 `{}`。
    `mode="filemap"`：保留 `data-rf-asset`，把 `src` 改写成 `assets/<id>.<ext>`，返回 `{ [assetId]: { assetId, blob, filename } }` 供 ZIP 写文件。
  - `RF_ExportCommon.collectCssText(doc)` → `string`
    串联 doc 内所有 `<style>` 与可读 `styleSheet.cssRules`。
  - `RF_ExportCommon.safeFileName(report)` → `string`
    清洗 `report.meta.title`，截 60 字符，fallback `"report"`。
  - `RF_ExportCommon.triggerDownload(blob, filename)` → `void`
  - `RF_ExportCommon.setBusy(btn, busy, busyLabel)` → `void`
    `busy=true` 时给按钮加 `disabled`，把第一个 `<span>` 文本节点（非 icon、非 caret）替换为 `busyLabel`，并把原文存到 `dataset.rfOriginalLabel`；`busy=false` 时还原。

- [ ] **Step 1：创建文件并写入完整实现**

```js
// js/modules/exporter-common.js
/**
 * exporter-common.js — shared helpers used by every exporter
 * (pdf / zip / png / html). Keeps the four exporters thin and the
 * "what does export do" logic in one place.
 *
 * Loaded BEFORE any exporter-*.js — see index.html script order.
 */
(function () {
  "use strict";

  var state = window.RF_State;
  var log   = window.RF_Log;

  /**
   * Clone the preview's #root and replace every chart container with an
   * inline SVG (so the clone is fully static — no canvas, no ECharts at
   * runtime). Caller must NOT mutate the live preview.
   */
  function cloneRoot(snap, report) {
    if (!snap || !snap.doc) throw new Error("preview snapshot missing");
    var srcDoc  = snap.doc;
    var srcRoot = srcDoc.getElementById("root");
    if (!srcRoot) throw new Error("preview root missing");
    var rootClone = srcRoot.cloneNode(true);

    // Pull active template's theme so SVG palette/textColor match the preview.
    var tplTheme = window.RF_Chart.themeOf(state.get("templateId"));

    // Sequence of chart specs in document order — same order the renderer used.
    var blockSpecs = [];
    (report.sections || []).forEach(function (s) {
      (s.blocks || []).forEach(function (b) {
        if (b && b.type === "chart") blockSpecs.push(b);
      });
    });

    var bodies = rootClone.querySelectorAll(".rf-chart-card__body, [data-rf-chart]");
    bodies.forEach(function (host, i) {
      var blk = blockSpecs[i];
      if (!blk) return;
      try {
        // disableAnimation: capture the final, fully-laid-out frame.
        var svg = window.RF_Chart.toSvgString(
          blk.spec,
          Object.assign({ width: 720, height: 320, disableAnimation: true }, tplTheme)
        );
        host.innerHTML = "";
        var wrap = srcDoc.createElement("div");
        wrap.style.cssText = "width:100%;max-width:100%;";
        wrap.innerHTML = svg.replace(/<svg /, '<svg style="width:100%;height:auto;" ');
        host.appendChild(wrap);
      } catch (e) {
        log.warn("export: chart svg failed " + e.message);
      }
    });

    return { rootClone: rootClone, doc: srcDoc };
  }

  /**
   * Resolve every <img data-rf-asset="..."> in the clone.
   *
   *  mode="dataurl"  → src becomes base64 data: URL, attribute removed.
   *                    Returns an empty assetMap. Used by PDF / PNG / HTML.
   *  mode="filemap"  → src becomes "assets/<id>.<ext>". data-rf-asset is
   *                    removed but the {id, blob, filename} record is
   *                    returned so the caller (ZIP) can write the file.
   */
  function resolveImages(rootClone, mode) {
    var imgs = rootClone.querySelectorAll('img[data-rf-asset]');
    if (!imgs.length) return Promise.resolve({});

    if (mode === "dataurl") {
      var jobs = Array.prototype.map.call(imgs, function (img) {
        var id = img.getAttribute("data-rf-asset");
        return window.RF_Assets.get(id).then(function (rec) {
          if (!rec || !rec.blob) {
            img.setAttribute("alt", (img.alt || "") + "（资源缺失）");
            img.removeAttribute("data-rf-asset");
            return;
          }
          return blobToDataUrl(rec.blob).then(function (data) {
            img.src = data;
            img.removeAttribute("data-rf-asset");
          });
        });
      });
      return Promise.all(jobs).then(function () { return {}; });
    }

    if (mode === "filemap") {
      var ids = [];
      imgs.forEach(function (img) {
        var id = img.getAttribute("data-rf-asset");
        if (id) ids.push(id);
      });
      return Promise.all(ids.map(function (id) {
        return window.RF_Assets.get(id).then(function (rec) {
          if (!rec) return null;
          var ext = window.RF_ImageManager.extOf(rec);
          return { assetId: id, blob: rec.blob, filename: id + "." + ext };
        });
      })).then(function (records) {
        var map = {};
        records.forEach(function (r) { if (r) map[r.assetId] = r; });
        // Rewrite <img> src now that we know filenames.
        imgs.forEach(function (img) {
          var id  = img.getAttribute("data-rf-asset");
          var rec = map[id];
          if (rec) {
            img.setAttribute("src", "assets/" + rec.filename);
          } else {
            img.setAttribute("alt", (img.alt || "") + "（资源缺失）");
          }
          img.removeAttribute("data-rf-asset");
        });
        return map;
      });
    }

    return Promise.reject(new Error("resolveImages: unknown mode " + mode));
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload  = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  function collectCssText(doc) {
    var out = [];
    Array.prototype.forEach.call(doc.querySelectorAll("style"), function (s) {
      if (s.textContent) out.push(s.textContent);
    });
    Array.prototype.forEach.call(doc.styleSheets, function (sheet) {
      try {
        var rules = sheet.cssRules;
        if (!rules) return;
        var buf = [];
        for (var i = 0; i < rules.length; i++) buf.push(rules[i].cssText);
        out.push(buf.join("\n"));
      } catch (e) {
        // Cross-origin or file:// without permission — skip.
      }
    });
    return out.join("\n\n");
  }

  function safeFileName(report) {
    var base = (report && report.meta && report.meta.title) || "reportflow-report";
    return String(base)
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .slice(0, 60) || "report";
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /**
   * Toggle a button between "ready" and "busy" states. When busy, the
   * button is disabled and its first text-bearing <span> is replaced
   * with `busyLabel` (default "导出中…"). The original text is stashed
   * on `btn.dataset.rfOriginalLabel` so it can be restored.
   */
  function setBusy(btn, busy, busyLabel) {
    if (!btn) return;
    var labelSpan = findLabelSpan(btn);
    if (busy) {
      btn.setAttribute("disabled", "");
      btn.setAttribute("aria-busy", "true");
      if (labelSpan && btn.dataset.rfOriginalLabel == null) {
        btn.dataset.rfOriginalLabel = labelSpan.textContent;
        labelSpan.textContent = busyLabel || "导出中…";
      }
    } else {
      btn.removeAttribute("disabled");
      btn.removeAttribute("aria-busy");
      if (labelSpan && btn.dataset.rfOriginalLabel != null) {
        labelSpan.textContent = btn.dataset.rfOriginalLabel;
        delete btn.dataset.rfOriginalLabel;
      }
    }
  }

  /** First <span> child whose text isn't a single icon/caret glyph. */
  function findLabelSpan(btn) {
    var spans = btn.querySelectorAll("span");
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (s.classList.contains("rf-icon")) continue;
      if (s.classList.contains("rf-export-menu__caret")) continue;
      return s;
    }
    return null;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  window.RF_ExportCommon = {
    cloneRoot:      cloneRoot,
    resolveImages:  resolveImages,
    collectCssText: collectCssText,
    safeFileName:   safeFileName,
    triggerDownload: triggerDownload,
    setBusy:        setBusy,
    escapeHtml:     escapeHtml,
    blobToDataUrl:  blobToDataUrl
  };
})();
```

- [ ] **Step 2：在 `index.html` 临时挂载该脚本（验证语法）**

打开 `index.html`，在 `<script defer src="js/modules/exporter-zip.js"></script>` 这行**之前**插入：

```html
<script defer src="js/modules/exporter-common.js"></script>
```

具体位置：
- 在 [index.html:168](index.html#L168) `<script defer src="js/modules/exporter-zip.js"></script>` 之前。

- [ ] **Step 3：浏览器加载验证**

在浏览器打开 `index.html`，开 DevTools Console 跑：

```js
typeof window.RF_ExportCommon
// 期望输出: "object"

Object.keys(window.RF_ExportCommon).sort()
// 期望输出: ["blobToDataUrl","cloneRoot","collectCssText","escapeHtml","resolveImages","safeFileName","setBusy","triggerDownload"]
```

确认没有 console error 报红。

- [ ] **Step 4：commit**

```bash
git add js/modules/exporter-common.js index.html
git commit -m "refactor: 抽取 exporter-common.js 作为四个 exporter 共享 helper"
```

---

## Task 2：把 `exporter-pdf.js` 改成调用 common

**Files:**
- Modify: `js/modules/exporter-pdf.js`（整体重写）

**Interfaces:**
- Consumes: `RF_ExportCommon.cloneRoot` / `resolveImages("dataurl")` / `collectCssText` / `safeFileName`（Task 1）
- Produces: `RF_ExportPdf.exportPdf()` → Promise（**与原版签名一致**）

**重要：** 重构后导出的 PDF 在视觉与内容上必须与原版一致。这一步是纯重构，不改可观察行为。

- [ ] **Step 1：替换文件全部内容**

```js
// js/modules/exporter-pdf.js
/**
 * exporter-pdf.js — render the preview to PDF via html2pdf.js.
 *
 * Strategy unchanged from earlier revisions; the only change in this
 * file is delegating shared logic (root clone, chart-to-SVG, image
 * resolution, css collection, filename) to RF_ExportCommon so all
 * four exporters share one implementation.
 */
(function () {
  "use strict";

  var state  = window.RF_State;
  var log    = window.RF_Log;
  var common = window.RF_ExportCommon;

  function exportPdf() {
    if (typeof window.html2pdf !== "function") {
      window.RF_UI.toast.err("html2pdf 未加载，无法导出 PDF");
      return Promise.reject(new Error("html2pdf missing"));
    }
    var report = state.get("report");
    if (!report) { window.RF_UI.toast.warn("没有可导出的内容"); return Promise.reject(new Error("empty")); }

    var snap = window.RF_Preview.snapshotForExport();
    if (!snap) { window.RF_UI.toast.err("预览未就绪"); return Promise.reject(new Error("preview not ready")); }

    var cloned = common.cloneRoot(snap, report);
    var rootClone = cloned.rootClone;

    // Build a hidden export host on the parent page using inlined CSS so
    // html2canvas (which runs against the parent doc) can read it.
    var host = document.createElement("div");
    host.id = "rf-pdf-host";
    host.style.cssText = [
      "position:fixed", "left:-99999px", "top:0",
      "width:794px",         // ~ A4 width @ 96dpi
      "background:#fff",
      "color:#1a1f2c",
      "font-family:'PingFang SC','Microsoft YaHei',sans-serif"
    ].join(";");

    var styleEl = document.createElement("style");
    styleEl.textContent = common.collectCssText(snap.doc);
    host.appendChild(styleEl);

    // Wrap clone in #root with template scoping class preserved.
    var rootEl = document.createElement("div");
    rootEl.id = "root";
    rootEl.className = rootClone.className;
    rootEl.innerHTML = rootClone.innerHTML;
    rootEl.style.cssText = "padding:32px 28px;";
    host.appendChild(rootEl);

    document.body.appendChild(host);
    log.info("pdf: start");

    // Resolve images AFTER mounting (resolveImages mutates rootClone, but
    // rootEl was constructed from rootClone.innerHTML which was a string
    // copy — so re-query rootEl directly).
    return common.resolveImages(rootEl, "dataurl").then(function () {
      var opts = {
        margin: [12, 12, 14, 12],
        filename: common.safeFileName(report) + ".pdf",
        image: { type: "jpeg", quality: 0.92 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css", "legacy"], before: [".rf-pagebreak-before"], avoid: [".rf-section", ".rf-chart-card", ".rf-img"] }
      };
      return window.html2pdf().set(opts).from(rootEl).save();
    }).then(function () {
      window.RF_UI.toast.ok("已导出 PDF");
      log.info("pdf: ok");
    }).catch(function (err) {
      window.RF_UI.toast.err("PDF 导出失败：" + (err && err.message));
      log.error("pdf: " + (err && err.message));
      throw err;
    }).then(function () {
      if (host && host.parentNode) host.parentNode.removeChild(host);
    }, function () {
      if (host && host.parentNode) host.parentNode.removeChild(host);
    });
  }

  window.RF_ExportPdf = { exportPdf: exportPdf };
})();
```

- [ ] **Step 2：浏览器手工验证 PDF 仍可导出**

1. 打开 `index.html`。
2. 顶栏点【载入示例】→ 等待预览渲染。
3. 点底部【📄 导出 PDF】（Task 6 之前按钮还在原位）。
4. 等待下载，打开 PDF：标题、章节、文字、图表（如示例含）、图片（如示例含）应与改造前一致。

确认 console 无报错。

- [ ] **Step 3：commit**

```bash
git add js/modules/exporter-pdf.js
git commit -m "refactor(pdf): 走 RF_ExportCommon 共享管线，行为不变"
```

---

## Task 3：把 `exporter-zip.js` 改成调用 common

**Files:**
- Modify: `js/modules/exporter-zip.js`（整体重写）

**Interfaces:**
- Consumes: `RF_ExportCommon.cloneRoot` / `resolveImages("filemap")` / `collectCssText` / `safeFileName` / `triggerDownload` / `escapeHtml`
- Produces: `RF_ExportZip.exportZip()` → Promise（**与原版签名一致**）

- [ ] **Step 1：替换文件全部内容**

```js
// js/modules/exporter-zip.js
/**
 * exporter-zip.js — package the rendered report into a folder-style zip.
 *
 *   <project>/
 *     report.html          (self-contained, references assets/ relatively)
 *     assets/
 *       img-xxx.png
 *       img-yyy.jpg
 *
 * Charts are inline SVG (no JS in the exported HTML). Images stored
 * in IndexedDB are extracted to assets/ and <img src> is rewritten
 * to "assets/<filename>".
 */
(function () {
  "use strict";

  var state  = window.RF_State;
  var log    = window.RF_Log;
  var common = window.RF_ExportCommon;

  function exportZip() {
    if (!window.JSZip) {
      window.RF_UI.toast.err("JSZip 未加载，无法导出 ZIP");
      return Promise.reject(new Error("JSZip missing"));
    }
    var report = state.get("report");
    if (!report) { window.RF_UI.toast.warn("没有可导出的内容"); return Promise.reject(new Error("empty")); }

    var snap = window.RF_Preview.snapshotForExport();
    if (!snap) { window.RF_UI.toast.err("预览未就绪"); return Promise.reject(new Error("preview not ready")); }
    log.info("export: zip start");

    var cloned = common.cloneRoot(snap, report);
    var rootClone = cloned.rootClone;

    return common.resolveImages(rootClone, "filemap").then(function (assetMap) {
      var html = buildExportHtml(snap, rootClone, report);
      return packageZip(html, assetMap, report);
    }).then(function (blob) {
      common.triggerDownload(blob, common.safeFileName(report) + ".zip");
      window.RF_UI.toast.ok("已导出 ZIP");
      log.info("export: zip ok " + blob.size + "B");
    }).catch(function (err) {
      window.RF_UI.toast.err("导出失败：" + (err && err.message));
      log.error("export: " + (err && err.message));
      throw err;
    });
  }

  /** Build the self-contained report.html string. rootClone is already
   *  chart-SVG-ed and image-src-rewritten by the caller. */
  function buildExportHtml(snap, rootClone, report) {
    var cssText = common.collectCssText(snap.doc);
    var meta = report.meta || {};
    var title = meta.title || "ReportFlow 报告";
    return [
      "<!doctype html>",
      "<html lang='zh-CN'><head><meta charset='utf-8'>",
      "<meta name='viewport' content='width=device-width,initial-scale=1'>",
      "<title>" + common.escapeHtml(title) + "</title>",
      "<style>",
      cssText,
      "html,body{margin:0;padding:0;min-height:100%;background:#fff;color:#1a1f2c;",
      "font-family:'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;}",
      "#root{box-sizing:border-box;max-width:920px;margin:0 auto;padding:32px 36px;}",
      "</style>",
      "</head><body class='" + common.escapeHtml(snap.bodyClass || "") + "'>",
      "<div id='root' class='" + common.escapeHtml(rootClone.className || "") + "'>",
      rootClone.innerHTML,
      "</div>",
      "</body></html>"
    ].join("\n");
  }

  function packageZip(html, assetMap, report) {
    var zip = new window.JSZip();
    var folder = zip.folder(common.safeFileName(report));
    folder.file("report.html", html);
    folder.file("README.txt",
      "ReportFlow 导出包\n" +
      "------------------\n" +
      "解压后双击 report.html 即可离线查看本报告。\n" +
      "如果在服务器上发布，请确保保留 assets/ 目录与 report.html 同级。\n"
    );
    var assetsFolder = folder.folder("assets");
    Object.keys(assetMap).forEach(function (id) {
      var rec = assetMap[id];
      if (rec && rec.blob) assetsFolder.file(rec.filename, rec.blob);
    });
    return zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });
  }

  window.RF_ExportZip = { exportZip: exportZip };
})();
```

- [ ] **Step 2：浏览器手工验证 ZIP 仍可导出**

1. 重新加载 `index.html`，载入示例。
2. 点【📦 导出 ZIP】，等下载完成。
3. 解压：应包含 `<title>/report.html`、`<title>/README.txt`、`<title>/assets/`（如示例含图）。
4. 双击 `report.html`，应在浏览器里完整显示报告（含图表 SVG、图片）。

确认 console 无报错。

- [ ] **Step 3：commit**

```bash
git add js/modules/exporter-zip.js
git commit -m "refactor(zip): 走 RF_ExportCommon 共享管线，行为不变"
```

---

## Task 4：新增 `exporter-png.js` — PNG 长图导出

**Files:**
- Create: `js/modules/exporter-png.js`
- Modify: `index.html`（在 `exporter-zip.js` 之后追加 `exporter-png.js`）

**Interfaces:**
- Consumes: `RF_ExportCommon.cloneRoot` / `resolveImages("dataurl")` / `collectCssText` / `safeFileName` / `triggerDownload`；`window.html2pdf`（已 vendored）
- Produces: `RF_ExportPng.exportPng()` → Promise

**关键决策：** 不直接调 `html2canvas`（bundle 没暴露到全局），改用 `html2pdf().from(host).set(opts).toCanvas()` 拿到 canvas，再 `canvas.toBlob("image/png")`。**不引入新依赖。**

- [ ] **Step 1：创建 `js/modules/exporter-png.js`**

```js
// js/modules/exporter-png.js
/**
 * exporter-png.js — render the preview to a single tall PNG image.
 *
 * Designed for share-on-IM scenarios (微信 / 钉钉 / 飞书 / 朋友圈).
 * The whole report becomes ONE image, no pagination.
 *
 * Implementation: piggy-back on html2pdf's bundled html2canvas via
 * the chainable .toCanvas() output — saves us a separate vendored
 * dependency. Same hidden-host-on-parent-doc approach as PDF.
 */
(function () {
  "use strict";

  var state  = window.RF_State;
  var log    = window.RF_Log;
  var common = window.RF_ExportCommon;

  // Browser canvas safety ceiling — most engines stop rendering past
  // 16384px. Leave 384px of headroom.
  var MAX_CANVAS_PX = 16000;

  function exportPng() {
    if (typeof window.html2pdf !== "function") {
      window.RF_UI.toast.err("html2pdf 未加载，无法导出图片");
      return Promise.reject(new Error("html2pdf missing"));
    }
    var report = state.get("report");
    if (!report) { window.RF_UI.toast.warn("没有可导出的内容"); return Promise.reject(new Error("empty")); }

    var snap = window.RF_Preview.snapshotForExport();
    if (!snap) { window.RF_UI.toast.err("预览未就绪"); return Promise.reject(new Error("preview not ready")); }

    var cloned = common.cloneRoot(snap, report);
    var rootClone = cloned.rootClone;

    // Build hidden host on parent page (same pattern as PDF).
    var host = document.createElement("div");
    host.id = "rf-png-host";
    host.style.cssText = [
      "position:fixed", "left:-99999px", "top:0",
      "width:920px",          // matches preview content max-width
      "background:#fff",
      "color:#1a1f2c",
      "font-family:'PingFang SC','Microsoft YaHei',sans-serif"
    ].join(";");

    var styleEl = document.createElement("style");
    styleEl.textContent = common.collectCssText(snap.doc);
    host.appendChild(styleEl);

    var rootEl = document.createElement("div");
    rootEl.id = "root";
    rootEl.className = rootClone.className;
    rootEl.innerHTML = rootClone.innerHTML;
    rootEl.style.cssText = "padding:32px 36px;";
    host.appendChild(rootEl);

    document.body.appendChild(host);
    log.info("png: start");

    return common.resolveImages(rootEl, "dataurl").then(function () {
      // Pick scale by measured height so the canvas stays within the
      // engine's safety ceiling.
      var contentHeight = host.scrollHeight || rootEl.scrollHeight;
      var scale = 2;
      if (contentHeight * scale > MAX_CANVAS_PX) {
        scale = 1;
        window.RF_UI.toast.warn("报告较长，已降为单倍清晰度导出");
        if (contentHeight > MAX_CANVAS_PX) {
          window.RF_UI.toast.warn("报告超过 16000px，建议改用 PDF 或 ZIP");
        }
      }
      var opts = {
        html2canvas: {
          scale: scale,
          useCORS: true,
          backgroundColor: "#ffffff",
          windowWidth: 920
        }
      };
      return window.html2pdf().set(opts).from(host).toCanvas();
    }).then(function (canvas) {
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (!blob) return reject(new Error("canvas.toBlob 返回空"));
          resolve(blob);
        }, "image/png");
      });
    }).then(function (blob) {
      common.triggerDownload(blob, common.safeFileName(report) + ".png");
      window.RF_UI.toast.ok("已导出图片");
      log.info("png: ok " + blob.size + "B");
    }).catch(function (err) {
      window.RF_UI.toast.err("图片导出失败：" + (err && err.message));
      log.error("png: " + (err && err.message));
      throw err;
    }).then(function () {
      if (host && host.parentNode) host.parentNode.removeChild(host);
    }, function () {
      if (host && host.parentNode) host.parentNode.removeChild(host);
    });
  }

  window.RF_ExportPng = { exportPng: exportPng };
})();
```

- [ ] **Step 2：在 `index.html` 注册新脚本**

在 [index.html](index.html) `<script defer src="js/modules/exporter-zip.js"></script>` 这行**之后**追加：

```html
<script defer src="js/modules/exporter-png.js"></script>
```

- [ ] **Step 3：浏览器 console 临时调用验证**

打开 `index.html` → 载入示例 → 等预览渲染完 → DevTools Console 执行：

```js
window.RF_ExportPng.exportPng();
```

预期：浏览器下载 `<title>.png` 文件。打开它：
- 内容应包含完整报告（标题、章节、所有 block）。
- 图表是清晰矢量样式（SVG 渲染到 canvas，2× 时不糊）。
- 中文字体正常显示。
- 背景纯白，无 iframe 边框、无外层 padding 灰底。

把 png 拖进微信/钉钉聊天框试粘贴，确认完整可见。

- [ ] **Step 4：commit**

```bash
git add js/modules/exporter-png.js index.html
git commit -m "feat: 新增预览 PNG 长图导出，复用 html2pdf 内置 toCanvas"
```

---

## Task 5：新增 `exporter-html.js` — 单文件 HTML 导出

**Files:**
- Create: `js/modules/exporter-html.js`
- Modify: `index.html`（在 `exporter-png.js` 之后追加）

**Interfaces:**
- Consumes: `RF_ExportCommon.cloneRoot` / `resolveImages("dataurl")` / `collectCssText` / `safeFileName` / `triggerDownload` / `escapeHtml`
- Produces: `RF_ExportHtml.exportHtml()` → Promise

**输出形态：** 单个 `.html` 文件，所有 CSS 内联在 `<style>`，所有图片转 base64 data URL，所有图表是 inline SVG。无外部脚本依赖。

- [ ] **Step 1：创建 `js/modules/exporter-html.js`**

```js
// js/modules/exporter-html.js
/**
 * exporter-html.js — export the preview as ONE self-contained .html file.
 *
 * Difference from ZIP's report.html: every <img> becomes a base64
 * data: URL so the file is genuinely a single file (no assets/
 * folder, no relative paths). Charts are already inline SVG.
 *
 * Trade-off: file size is ~1.33x the sum of image sizes. Users who
 * care about size should pick ZIP instead.
 */
(function () {
  "use strict";

  var state  = window.RF_State;
  var log    = window.RF_Log;
  var common = window.RF_ExportCommon;

  // Soft warning threshold — not a hard cap. 20MB is a reasonable
  // ceiling for "still email-attachable" without becoming silly.
  var WARN_BYTES = 20 * 1024 * 1024;

  function exportHtml() {
    var report = state.get("report");
    if (!report) { window.RF_UI.toast.warn("没有可导出的内容"); return Promise.reject(new Error("empty")); }

    var snap = window.RF_Preview.snapshotForExport();
    if (!snap) { window.RF_UI.toast.err("预览未就绪"); return Promise.reject(new Error("preview not ready")); }
    log.info("html: start");

    var cloned = common.cloneRoot(snap, report);
    var rootClone = cloned.rootClone;

    return common.resolveImages(rootClone, "dataurl").then(function () {
      var html = buildSingleFileHtml(snap, rootClone, report);
      var blob = new Blob([html], { type: "text/html;charset=utf-8" });
      common.triggerDownload(blob, common.safeFileName(report) + ".html");
      if (blob.size > WARN_BYTES) {
        var mb = (blob.size / 1024 / 1024).toFixed(1);
        window.RF_UI.toast.warn("HTML 文件较大（" + mb + "MB），建议改用 ZIP");
      } else {
        window.RF_UI.toast.ok("已导出 HTML");
      }
      log.info("html: ok " + blob.size + "B");
    }).catch(function (err) {
      window.RF_UI.toast.err("HTML 导出失败：" + (err && err.message));
      log.error("html: " + (err && err.message));
      throw err;
    });
  }

  function buildSingleFileHtml(snap, rootClone, report) {
    var cssText = common.collectCssText(snap.doc);
    var meta = report.meta || {};
    var title = meta.title || "ReportFlow 报告";
    return [
      "<!doctype html>",
      "<html lang='zh-CN'><head><meta charset='utf-8'>",
      "<meta name='viewport' content='width=device-width,initial-scale=1'>",
      "<title>" + common.escapeHtml(title) + "</title>",
      "<style>",
      cssText,
      "html,body{margin:0;padding:0;min-height:100%;background:#fff;color:#1a1f2c;",
      "font-family:'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;}",
      "#root{box-sizing:border-box;max-width:920px;margin:0 auto;padding:32px 36px;}",
      "</style>",
      "</head><body class='" + common.escapeHtml(snap.bodyClass || "") + "'>",
      "<div id='root' class='" + common.escapeHtml(rootClone.className || "") + "'>",
      rootClone.innerHTML,
      "</div>",
      "</body></html>"
    ].join("\n");
  }

  window.RF_ExportHtml = { exportHtml: exportHtml };
})();
```

- [ ] **Step 2：在 `index.html` 注册新脚本**

在 [index.html](index.html) `<script defer src="js/modules/exporter-png.js"></script>` 这行**之后**追加：

```html
<script defer src="js/modules/exporter-html.js"></script>
```

- [ ] **Step 3：浏览器 console 临时调用验证**

打开 `index.html` → 载入示例 → DevTools Console 执行：

```js
window.RF_ExportHtml.exportHtml();
```

预期：浏览器下载 `<title>.html` 文件。

验证：
1. 关闭原浏览器 tab，把下载的 .html 文件拖到一个**新**浏览器窗口（确保不依赖任何外部资源）。
2. 应完整显示：标题、章节、文字、图表（SVG）、图片（应可见，不是破图图标）。
3. 在文件管理器里查看大小：含图示例约几百 KB ~ 几 MB。
4. 用文本编辑器打开 .html，搜 `data:image` 应有匹配（图片已 base64 内联）。
5. 搜 `<script` 应**只**匹配 `<script>` 在 cssText 内的字符串引用（如有），不应有真正可执行的 `<script src=` 标签。

- [ ] **Step 4：commit**

```bash
git add js/modules/exporter-html.js index.html
git commit -m "feat: 新增预览单文件 HTML 导出，所有图片内联为 data URL"
```

---

## Task 6：UI 改造 — 顶栏改为"导出 ▾"下拉菜单

**Files:**
- Modify: `index.html`（替换 preview pane foot 的按钮区）
- Modify: `css/components.css`（追加 `.rf-export-menu*` 样式）
- Modify: `js/core/bootstrap.js`（移除旧 ID 绑定，新增菜单委托）

**Interfaces:**
- Consumes: `RF_ExportPdf.exportPdf` / `RF_ExportPng.exportPng` / `RF_ExportHtml.exportHtml` / `RF_ExportZip.exportZip`；`RF_ExportCommon.setBusy`
- Produces: 无新对外 API（仅 UI）

**Caveat：** 此前各 export 函数没有"导出中…"状态。本任务把"按钮 busy 切换"放在菜单事件委托一处统一做（Task 1 的 `setBusy`），不改各 exporter 内部。

### Step 1：替换 `index.html` preview pane foot

打开 [index.html:106-114](index.html#L106-L114)，把这一段：

```html
<div class="rf-pane__foot">
  <button class="rf-btn rf-btn--primary" id="rf-btn-export-zip">
    <span class="rf-icon">📦</span><span>导出 ZIP</span>
  </button>
  <button class="rf-btn rf-btn--ghost" id="rf-btn-export-pdf">
    <span class="rf-icon">📄</span><span>导出 PDF</span>
  </button>
  <button class="rf-btn rf-btn--ghost" id="rf-btn-fullscreen-preview" title="全屏预览">⛶</button>
</div>
```

替换为：

```html
<div class="rf-pane__foot">
  <div class="rf-export-menu" id="rf-export-menu">
    <button class="rf-btn rf-btn--primary rf-export-menu__trigger"
            id="rf-btn-export"
            aria-haspopup="menu" aria-expanded="false">
      <span class="rf-icon">📦</span><span>导出</span><span class="rf-export-menu__caret">▾</span>
    </button>
    <div class="rf-export-menu__list" id="rf-export-menu-list" role="menu" hidden>
      <button class="rf-export-menu__item" type="button" role="menuitem" data-fmt="pdf">
        <span class="rf-export-menu__icon">📄</span>
        <span class="rf-export-menu__label">PDF</span>
        <span class="rf-export-menu__hint">打印 / 归档</span>
      </button>
      <button class="rf-export-menu__item" type="button" role="menuitem" data-fmt="png">
        <span class="rf-export-menu__icon">🖼</span>
        <span class="rf-export-menu__label">图片</span>
        <span class="rf-export-menu__hint">长图分享</span>
      </button>
      <button class="rf-export-menu__item" type="button" role="menuitem" data-fmt="html">
        <span class="rf-export-menu__icon">🌐</span>
        <span class="rf-export-menu__label">HTML</span>
        <span class="rf-export-menu__hint">单文件，双击即看</span>
      </button>
      <button class="rf-export-menu__item" type="button" role="menuitem" data-fmt="zip">
        <span class="rf-export-menu__icon">🗂</span>
        <span class="rf-export-menu__label">ZIP</span>
        <span class="rf-export-menu__hint">资源可拆分</span>
      </button>
    </div>
  </div>
  <button class="rf-btn rf-btn--ghost" id="rf-btn-fullscreen-preview" title="全屏预览">⛶</button>
</div>
```

- [ ] **Step 2：在 `css/components.css` 末尾追加菜单样式**

打开 [css/components.css](css/components.css)，在文件末尾追加：

```css
/* ===== Export menu (preview pane foot) =====
   A dropdown that opens upward (foot is at the bottom of the pane).
   Visual language reuses .rf-date-picker__menu — same border, shadow,
   item padding — so the topbar/foot dropdowns feel like one family. */
.rf-export-menu { position: relative; display: inline-flex; }

.rf-export-menu__trigger[aria-expanded="true"] .rf-export-menu__caret {
  transform: rotate(180deg);
}
.rf-export-menu__caret {
  display: inline-block;
  font-size: 11px;
  line-height: 1;
  margin-left: 2px;
  transition: transform .15s ease;
  opacity: .85;
}

.rf-export-menu__list {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 30;
  min-width: 220px;
  background: var(--rf-bg-elev);
  border: 1px solid var(--rf-line);
  border-radius: var(--rf-radius);
  box-shadow: var(--rf-shadow);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.rf-export-menu__list[hidden] { display: none; }

.rf-export-menu__item {
  display: grid;
  grid-template-columns: 22px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: 0;
  background: transparent;
  border-radius: var(--rf-radius-sm);
  color: var(--rf-text);
  font-family: var(--rf-font);
  font-size: var(--rf-text-sm);
  text-align: left;
  cursor: pointer;
  transition: background .12s ease;
}
.rf-export-menu__item:hover,
.rf-export-menu__item:focus-visible {
  background: var(--rf-bg-soft);
  outline: none;
}
.rf-export-menu__icon {
  font-size: 14px;
  line-height: 1;
  text-align: center;
  opacity: .9;
}
.rf-export-menu__label {
  font-weight: 500;
  letter-spacing: -.005em;
}
.rf-export-menu__hint {
  font-size: var(--rf-text-xs);
  color: var(--rf-text-dim);
  letter-spacing: .01em;
}
```

- [ ] **Step 3：替换 `js/core/bootstrap.js` 中的旧绑定**

打开 [js/core/bootstrap.js:62-63](js/core/bootstrap.js#L62-L63)，把这两行：

```js
    bindButton("rf-btn-export-zip",     function () { window.RF_ExportZip.exportZip(); });
    bindButton("rf-btn-export-pdf",     function () { window.RF_ExportPdf.exportPdf(); });
```

替换为：

```js
    bindExportMenu();
```

然后在该文件**任意函数定义区**（建议紧邻 `bindButton` 的定义之后；如果不确定，放在 `function bindButton(...)` 函数定义之后即可）追加：

```js
  /**
   * Export menu: one trigger button + 4 items. Click trigger toggles the
   * menu; click outside or ESC closes it; click an item closes the menu,
   * sets the trigger button to "busy" state and dispatches the export.
   * Re-arming on completion is done in finally — even if the export
   * rejects we must restore the button.
   */
  function bindExportMenu() {
    var trigger = document.getElementById("rf-btn-export");
    var list    = document.getElementById("rf-export-menu-list");
    if (!trigger || !list) return;

    function openMenu() {
      list.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      // Defer so the click that opened the menu doesn't immediately close it.
      setTimeout(function () {
        document.addEventListener("click", onDocClick, true);
        document.addEventListener("keydown", onKeyDown, true);
      }, 0);
    }
    function closeMenu() {
      list.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
    }
    function onDocClick(e) {
      var menu = document.getElementById("rf-export-menu");
      if (menu && !menu.contains(e.target)) closeMenu();
    }
    function onKeyDown(e) {
      if (e.key === "Escape") { closeMenu(); trigger.focus(); }
    }

    trigger.addEventListener("click", function (e) {
      if (trigger.hasAttribute("disabled")) return;
      e.stopPropagation();
      if (list.hidden) openMenu(); else closeMenu();
    });

    list.addEventListener("click", function (e) {
      var item = e.target.closest(".rf-export-menu__item");
      if (!item) return;
      var fmt = item.dataset.fmt;
      closeMenu();
      runExport(fmt);
    });

    function runExport(fmt) {
      var common = window.RF_ExportCommon;
      var labels = { pdf: "导出 PDF…", png: "生成图片…", html: "打包 HTML…", zip: "打包 ZIP…" };
      common.setBusy(trigger, true, labels[fmt] || "导出中…");
      var p;
      switch (fmt) {
        case "pdf":  p = window.RF_ExportPdf.exportPdf(); break;
        case "png":  p = window.RF_ExportPng.exportPng(); break;
        case "html": p = window.RF_ExportHtml.exportHtml(); break;
        case "zip":  p = window.RF_ExportZip.exportZip(); break;
        default:     p = Promise.resolve();
      }
      Promise.resolve(p).catch(function () { /* exporter already toasted */ })
                       .then(function () { common.setBusy(trigger, false); });
    }
  }
```

- [ ] **Step 4：浏览器手工功能验证（完整路径）**

1. 重新加载 `index.html`。点【载入示例】等预览渲染。
2. 点【📦 导出 ▾】按钮 → 下拉应**向上展开**，依次列出 PDF / 图片 / HTML / ZIP 四项；caret 旋转 180°。
3. 点页面任意空白处 → 下拉关闭，caret 复位。
4. 再次打开下拉，按 **ESC** → 下拉关闭，焦点回到触发按钮。
5. 再次打开下拉，**Tab** 键 → 应能依次聚焦四个菜单项（焦点环可见）。Enter / Space 应触发该项。
6. 依次测试四项：
   - **PDF**：触发后按钮文案变为"导出 PDF…"且 disabled，下载完成后按钮恢复。打开 PDF 内容正确。
   - **图片**：触发后按钮文案"生成图片…"。下载 .png，打开内容完整。
   - **HTML**：按钮文案"打包 HTML…"。下载 .html 双击打开，所有内容可见。
   - **ZIP**：按钮文案"打包 ZIP…"。下载 .zip 解压结构正确。
7. 故意弄个失败：在 console `delete window.RF_ExportPng;` 然后选图片项 → 应弹错误 toast 且按钮恢复（不留死灰）。刷新页面恢复。
8. 窄窗（< 980px）下下拉不应溢出右侧——若溢出，把 `.rf-export-menu__list` 的 `left: 0` 改为 `right: 0` 即可（响应式调整记入下一次提交）。

- [ ] **Step 5：commit**

```bash
git add index.html css/components.css js/core/bootstrap.js
git commit -m "feat(ui): 顶栏导出按钮收纳为下拉菜单（PDF/图片/HTML/ZIP）"
```

---

## Self-Review

**Spec coverage 检查**（对照 [docs/superpowers/specs/2026-06-19-png-html-export-design.md](docs/superpowers/specs/2026-06-19-png-html-export-design.md)）：

- ✅ 共享 helper `exporter-common.js` → Task 1
- ✅ PDF 重构 → Task 2
- ✅ ZIP 重构 → Task 3
- ✅ PNG 长图导出 → Task 4
- ✅ HTML 单文件导出 → Task 5
- ✅ 顶栏导出下拉（顺序 PDF/图片/HTML/ZIP） → Task 6
- ✅ 导出中按钮 busy 状态 → Task 6 的 `setBusy`
- ✅ 体积保护（PNG 长度兜底、HTML > 20MB 警告） → Task 4 / Task 5
- ✅ 错误处理（未就绪、外部资源缺失、用户重复点击） → 各 Task 的 catch + setBusy 释放
- ✅ 加载顺序（common 在前） → Task 1 Step 2 + Task 4 Step 2 + Task 5 Step 2

**Placeholder 扫描**：通读六个 task —— 没有 TBD / TODO / "实现细节稍后补"。每段代码都是完整可粘贴的实际内容。

**类型一致性**：
- `RF_ExportCommon.cloneRoot(snap, report)` 在 Task 1 定义返回 `{ rootClone, doc }`，在 Task 2/3/4/5 都解构 `var rootClone = cloned.rootClone`。✓
- `resolveImages` 在 Task 1 定义 `mode="dataurl" | "filemap"`，Task 2/4/5 用 `"dataurl"`，Task 3 用 `"filemap"`。✓
- `setBusy(btn, busy, busyLabel)` 在 Task 1 定义，在 Task 6 的 `runExport` 里以 3 参形式调用，与定义一致。✓
- `safeFileName` / `triggerDownload` / `escapeHtml` / `collectCssText` 全部命名在五个 task 间一致。✓

无问题，进入交付环节。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-19-png-html-export-implementation.md`. Two execution options:

**1. Subagent-Driven（推荐）** — 每个 Task 派一个全新 subagent 实施，主 session 在两 task 之间审阅；快速迭代、上下文不会被前序代码塞满。

**2. Inline Execution** — 在当前 session 里按顺序执行所有 Task，每个 Task 完成后做 checkpoint 报告。

哪种方式？

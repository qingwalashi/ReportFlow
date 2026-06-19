# 实时预览 — 图片导出 + 纯 HTML 导出 — 设计

**日期**: 2026-06-19
**范围**: 在右侧"实时预览"面板新增两种导出格式（PNG 长图、单文件 HTML），并把现有 PDF/ZIP 与新增项一起收纳进单一"导出"下拉菜单，使顶栏更紧凑。

## 目标

让用户用"一份预览"产出**四种交付物**，每种各自适合的场景：

| 格式 | 典型用途 |
|------|---------|
| PDF | 正式提交、打印、归档 |
| 图片（PNG 长图） | 微信 / 钉钉 / 飞书 / 朋友圈分享 |
| HTML（单文件） | 邮件附件、内网 OA 上传，双击即可看 |
| ZIP | 体积敏感场景（图多）、需要资源可独立编辑 |

## 选型决策（已与用户确认）

| 维度 | 选择 | 理由 |
|------|------|------|
| 图片切分策略 | **单张 PNG 长图**，不按 A4 页切分 | 报告分享场景 99% 是"一张图发出去" |
| HTML 图片处理 | **全部内联为 data URL** | 单文件 = 一个文件就够；要省体积应该用 ZIP |
| UI 入口 | **顶栏一个"导出 ▾"下拉菜单**，依次 PDF / 图片 / HTML / ZIP；保留独立的【⛶ 全屏预览】 | 4 个格式平等，下拉避免按钮挤；样式复用 `.rf-date-picker__menu` |
| 进度反馈 | **沿用现有模式**：按钮 disabled + 文案改"导出中…"，完成 toast | 与已有 PDF / ZIP 一致 |

## 总体策略：复用现有"快照 + 克隆"管线

现有 PDF / ZIP 都走同一条预备路径：
1. 调 `RF_Preview.snapshotForExport()` 拿到 iframe 文档快照
2. 克隆 `#root`，把 ECharts canvas 替换成 SVG（`RF_Chart.toSvgString`），把 `<img data-rf-asset>` 解析成实际资源
3. 套上收集来的 CSS（base + template），按目标格式打包

新增的 PNG 和 HTML 走同一条路径，**只在第 3 步分叉**。

## 模块边界

新增两个独立模块，与现有 exporter 平行；不动现有两个模块的对外接口：

| 文件 | 对外 API | 依赖 |
|------|---------|------|
| `js/modules/exporter-png.js` | `RF_ExportPng.exportPng()` → Promise | 复用 `html2pdf.bundle.min.js` 暴露的 `window.html2pdf`：先 `.from(el).set(opts).toCanvas()` 拿到 canvas，再走 `canvas.toBlob("image/png")`。**不引入新的第三方依赖**（html2canvas 在 html2pdf bundle 里没有暴露到全局，但 `.toCanvas()` 内部调它，效果等价） |
| `js/modules/exporter-html.js` | `RF_ExportHtml.exportHtml()` → Promise | 无新增依赖；纯 DOM + FileReader |

**为什么不复用 `exporter-zip.js` 里的 `buildExportHtml`**：那个函数与 ZIP 的"图片走 `assets/<file>`"策略耦合，调用方要自己提供 `assetMap`。我们抽出一个共享 helper（见下节）。

### 共享 helper：抽到 `js/modules/exporter-common.js`

把现在三个 exporter 都重复用到的逻辑统一进来：

```js
RF_ExportCommon = {
  // 把预览快照里的 #root 克隆出来，做完通用变换（chart→SVG），返回 { rootClone, doc }
  cloneRoot(snap, report) -> { rootClone, doc },

  // 把 #root 里的 <img data-rf-asset> 解析为：
  //   mode="dataurl"    → 改写 src 为 data: URL（用于 PNG / 纯 HTML / PDF）
  //   mode="filemap"    → 不改 src，返回 { assetId, blob, filename } map（用于 ZIP）
  resolveImages(rootClone, mode) -> Promise<assetMap>,

  // 收集 iframe 文档里所有可读 <style> 与 stylesheet 的 cssText
  collectCssText(doc) -> string,

  // 文件名清洗（已存在三份相同实现）
  safeFileName(report) -> string,
}
```

**重构原则**：抽离时不改三个现有 exporter 的对外行为；diff 应该是"删了重复代码、改成调 helper"，输出文件字节级相等（或仅空白差异）。这一步先跑现有 ZIP / PDF 一遍肉眼对比导出文件是否仍正确，再继续做 PNG / HTML。

## PNG 导出 — 实现细节

### 渲染管线

```
preview iframe
   │ snapshotForExport()
   ▼
RF_ExportCommon.cloneRoot()           # chart → SVG
   ▼
RF_ExportCommon.resolveImages(mode="dataurl")   # IDB blob → data URL
   ▼
mount to hidden host on parent doc
   │  host { position:fixed; left:-99999px; width:920px; background:#fff; }
   │  inline collected CSS via <style>
   ▼
html2pdf().from(host).set({ html2canvas: { scale, useCORS:true, backgroundColor:"#fff" } }).toCanvas()
   ▼
canvas.toBlob("image/png")
   ▼
triggerDownload(<title>.png)
```

`width: 920px` 与 [exporter-zip.js:156](js/modules/exporter-zip.js#L156) 的 `#root max-width:920px` 对齐——保证导出图与 ZIP 内 HTML 视觉一致。

`scale: 2` 让长图在高清屏上不糊（与现有 PDF 的 `html2canvas.scale=2` 一致）。

### 长度兜底

html2canvas 在大多数浏览器里能可靠输出到约 16384px 高（Canvas API 上限）。我们：

1. 计算 host 的 `scrollHeight`，若 `× scale > 16000`，先 `toast.warn("报告过长，将以单倍清晰度导出")` 再把 `scale` 自动降为 1。
2. 如果 1× 仍超过 16000，给一次明确提示：`toast.warn("报告超过 16000px，建议使用 PDF 或 ZIP 导出")` 并继续尝试（让浏览器自己截或抛错）。

不做"分批拼接"——这超出 YAGNI 范围；真正长到这种程度的报告应该走 PDF。

### 图表保真

ECharts 在 PNG 里必须是位图（不是 SVG）才能被 html2canvas 一次性 rasterize。但我们已经在克隆里把图表换成 SVG——SVG 在 html2canvas 里**也能正常截**（它把 SVG 转 image 再画到 canvas）。所以无需特殊处理。**唯一要确认的**：SVG 必须有显式 `width`/`height` 属性，否则部分 html2canvas 版本会画成 0×0。当前 `RF_Chart.toSvgString` 输出已带显式 `width="720" height="320"`，把这个保留即可。

### 图片资源

`<img data-rf-asset="...">` 通过 `RF_ExportCommon.resolveImages("dataurl")` 替换为 data URL（IDB blob → FileReader），与 PDF 走同一条路径。**外链 URL 图片**（legacy）走 `useCORS:true`，跨域失败时 html2canvas 会留空——和现有 PDF 行为一致，不再单独处理。

## 纯 HTML 导出 — 实现细节

### 输出形态

一个 `.html` 文件，**完全自包含**：
- `<style>` 内联所有 CSS（base + template）
- `<img>` 全部 data URL
- 图表全部 inline SVG（克隆阶段已转）
- **无外部脚本依赖**（不嵌 echarts.min.js、不嵌 marked.min.js）—— 图表已是静态 SVG，文本块在预览渲染时已经 marked 过，导出时 DOM 里就是 HTML

### 与 ZIP 内 `report.html` 的差异

| 项 | ZIP 内 report.html | 纯 HTML 导出 |
|----|------------------|------------|
| 图片 | 引用 `assets/<file>` | 内联 data URL |
| 文件个数 | HTML + 多个图片文件 | 1 个 |
| 体积 | 小 | 大（~1.33× 图片总和） |
| 用途 | 网站发布、想替换图片时 | 邮件、OA 上传 |

复用 `buildExportHtml` 的"包外壳"代码（doctype + meta + style + body），只把"图片解析模式"参数化。最终 `exporter-zip.js` 与 `exporter-html.js` 的差异只剩两行：传给 `resolveImages` 的 mode、最后是 `triggerDownload(html, ".html")` 还是 `packageZip(html, assetMap, report)`。

### 体积保护

不做硬上限。完成后看实际 blob 大小，若 > 20MB 仅 `toast.warn("HTML 文件较大（XXMB），建议改用 ZIP 导出")`，不阻断下载。

## UI — 导出下拉菜单

### HTML

替换 [index.html:106-114](index.html#L106) 的 pane foot 内容：

```html
<div class="rf-pane__foot">
  <div class="rf-export-menu">
    <button class="rf-btn rf-btn--primary" id="rf-btn-export" aria-haspopup="menu" aria-expanded="false">
      <span class="rf-icon">📦</span><span>导出</span><span class="rf-export-menu__caret">▾</span>
    </button>
    <div class="rf-export-menu__list" id="rf-export-menu-list" role="menu" hidden>
      <button class="rf-export-menu__item" data-fmt="pdf" role="menuitem">
        <span class="rf-export-menu__icon">📄</span>
        <span class="rf-export-menu__label">PDF</span>
        <span class="rf-export-menu__hint">打印 / 归档</span>
      </button>
      <button class="rf-export-menu__item" data-fmt="png" role="menuitem">
        <span class="rf-export-menu__icon">🖼</span>
        <span class="rf-export-menu__label">图片</span>
        <span class="rf-export-menu__hint">长图分享</span>
      </button>
      <button class="rf-export-menu__item" data-fmt="html" role="menuitem">
        <span class="rf-export-menu__icon">🌐</span>
        <span class="rf-export-menu__label">HTML</span>
        <span class="rf-export-menu__hint">单文件，双击即看</span>
      </button>
      <button class="rf-export-menu__item" data-fmt="zip" role="menuitem">
        <span class="rf-export-menu__icon">🗂</span>
        <span class="rf-export-menu__label">ZIP</span>
        <span class="rf-export-menu__hint">资源可拆分</span>
      </button>
    </div>
  </div>
  <button class="rf-btn rf-btn--ghost" id="rf-btn-fullscreen-preview" title="全屏预览">⛶</button>
</div>
```

### CSS（追加到 `css/components.css`）

样式风格与 [components.css:194-217](css/components.css#L194-L217) 的 `.rf-date-picker__menu` 完全一致——同样的边框、阴影、padding、hover 底色——保持顶栏视觉语言统一。

要点：
- 下拉**向上展开**（pane foot 在底部，向下没空间），`bottom: calc(100% + 4px); left: 0;`
- 菜单宽度 `min-width: 220px`，三列布局：图标 / 主标签 / 浅色 hint
- 按钮上的 `▾` caret 在展开态翻转 180°
- ESC 键关闭、菜单外点击关闭、Tab 键焦点循环（用 `focus-visible` ring 即可，不写花哨的 keyboard nav）

### 行为绑定（`js/core/bootstrap.js`）

`#rf-btn-export-zip`、`#rf-btn-export-pdf` 这两个旧 ID 在 [js/core/bootstrap.js](js/core/bootstrap.js) 里有事件绑定。**移除旧绑定**，统一改成：

```js
document.getElementById("rf-btn-export").addEventListener("click", toggleMenu);
document.getElementById("rf-export-menu-list").addEventListener("click", function (e) {
  var btn = e.target.closest(".rf-export-menu__item");
  if (!btn) return;
  closeMenu();
  switch (btn.dataset.fmt) {
    case "pdf":  return RF_ExportPdf.exportPdf();
    case "png":  return RF_ExportPng.exportPng();
    case "html": return RF_ExportHtml.exportHtml();
    case "zip":  return RF_ExportZip.exportZip();
  }
});
```

每个 `exportXxx()` 函数内部要做的小改动：开始时 `setBusy(btn, true)`（把触发按钮置灰 + 改文案"导出中…"），完成/失败时 `setBusy(btn, false)`。**这里 btn 是顶层"导出"按钮**——下拉里的子项点完就关菜单，无需自己显示忙态。

## 文件改动清单

| 文件 | 操作 |
|------|------|
| `js/modules/exporter-common.js` | 新增 |
| `js/modules/exporter-png.js` | 新增 |
| `js/modules/exporter-html.js` | 新增 |
| `js/modules/exporter-pdf.js` | 重构：调用 `RF_ExportCommon`，对外 API 不变 |
| `js/modules/exporter-zip.js` | 重构：调用 `RF_ExportCommon`，对外 API 不变 |
| `index.html` | 1) 顶栏 4 个按钮换成下拉；2) 在 `<script defer>` 列表里加 `exporter-common.js` / `exporter-png.js` / `exporter-html.js`，**`exporter-common.js` 必须在其它三个 exporter 之前** |
| `css/components.css` | 追加 `.rf-export-menu*` 块 |
| `js/core/bootstrap.js` | 移除旧的两个按钮绑定，加新的 `#rf-btn-export` + 菜单委托 |

不动：`preview.js`、`renderer-host.js`、`scroll-sync.js`、`block-highlight.js`、所有 `templates/`、`css/base.css`、`css/app.css`。

## 错误处理

| 失败 | 处理 |
|------|------|
| 预览未就绪（`snapshotForExport()` 返回 null） | `toast.err("预览未就绪")`，与现有一致 |
| html2canvas 抛错（PNG） | `toast.err("图片导出失败：" + msg)` + `log.error` |
| 长度超阈值（PNG） | 见 PNG 章节"长度兜底" |
| 图片 IDB 资源缺失 | 复用现有 ZIP 的处理：`alt` 加"（资源缺失）"标记，导出继续 |
| 用户在导出中再次点击下拉 | `setBusy` 已让父按钮 disabled，下拉打不开；不需要额外加锁 |

## 验证清单

实施完成后用一份"含 2 个章节、1 张图、1 个图表、1 段长 markdown 文本"的样本逐个验证：

- [ ] PDF 导出：与改造前字节级一致或仅元数据差异
- [ ] ZIP 导出：解压后 `report.html` 与改造前字节级一致
- [ ] PNG 导出：双击能在系统看图器打开；钉钉/微信粘贴可见完整内容；图表清晰、中文字体不糊
- [ ] HTML 导出：从邮件附件下载后双击 → 浏览器打开 → 图片、图表、文本全部可见，无 404
- [ ] 下拉菜单：键盘 Tab 进入、Enter 触发、ESC 关闭；窗口很窄时不溢出
- [ ] 导出中按钮文案变"导出中…"且无法重复点击
- [ ] 任一导出失败 → 按钮恢复，toast 显示原因，不留下灰按钮

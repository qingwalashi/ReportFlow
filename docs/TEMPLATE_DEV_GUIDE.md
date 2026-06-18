# 模板开发指南

ReportFlow 的模板与核心**完全解耦**——核心不知道你的模板叫什么、长什么样，模板也不需要 import 任何核心模块。模板就是一个自注册的 IIFE 脚本，遵守一份小契约即可。

## 1. 文件结构

每套模板 = `templates/<id>/` 下一个文件夹：

```
templates/my-template/
├── template.json     # 静态清单
├── style.css         # 全部选择器以 .rf-tpl-<id> 开头
├── render.js         # 自注册到 window.ReportFlowTemplates
└── preview.png       # 缩略图（可选）
```

## 2. `template.json`

```json
{
  "id": "my-template",
  "name": "我的模板",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "一句话描述风格定位。",
  "stylesheet": "style.css",
  "preview": "preview.png",
  "capabilities": {
    "charts": ["pie", "bar", "line"],
    "images": true,
    "pdfSafe": true
  }
}
```

- `id` 必须与文件夹名一致，并作为 CSS 前缀使用。
- `pdfSafe: true` 表示可放心走 PDF 导出（深色背景 / 现代 CSS 渐变请设 `false`）。

## 3. `style.css` — 必须加前缀

```css
/* ✅ 正确 */
.rf-tpl-my-template { font-family: ...; }
.rf-tpl-my-template .rf-section__heading { color: #f00; }

/* ❌ 错误 — 会污染 ReportFlow 主界面 */
body { background: black; }
.rf-section { padding: 24px; }
```

预览容器 `<div id="root">` 在运行时会被加上 `class="rf-tpl-<id>"`，你的样式以此为根选择器。

## 4. `render.js` — 自注册契约

```js
(function () {
  "use strict";

  var THEME = {
    palette: ["#ff6b6b", "#4ecdc4", "#ffe66d"],
    textColor: "#222",
    axisColor: "#999",
    splitColor: "#eee",
    fontFamily: 'inherit'
  };

  function renderReport(data, container, ctx) {
    // data    : Report JSON（结构见 DATA_SCHEMA.md）
    // container: 你要渲染进去的 DOM 元素（已挂在 iframe 内）
    // ctx     : 工具集合，见下文

    var meta = data.meta || {};
    var sections = data.sections || [];

    // ① 头部
    var h1 = document.createElement("h1");
    h1.textContent = meta.title || "未命名报告";
    container.appendChild(h1);

    // ② 章节
    sections.forEach(function (sec) {
      var secEl = document.createElement("section");
      secEl.className = "rf-section";

      var head = document.createElement("h2");
      head.className = "rf-section__heading";
      head.textContent = sec.heading;
      secEl.appendChild(head);

      (sec.blocks || []).forEach(function (blk) {
        renderBlock(blk, secEl, ctx);
      });

      container.appendChild(secEl);
    });
  }

  function renderBlock(blk, host, ctx) {
    if (blk.type === "text") {
      var div = document.createElement("div");
      div.className = "rf-text";
      div.innerHTML = ctx.marked(blk.content || "");
      host.appendChild(div);
    } else if (blk.type === "chart") {
      var card = document.createElement("div");
      card.className = "rf-chart-card";
      var body = document.createElement("div");
      body.className = "rf-chart-card__body";
      body.style.cssText = "width:100%;height:320px";
      card.appendChild(body);
      host.appendChild(card);
      requestAnimationFrame(function () {
        ctx.renderChart(blk.spec, body, THEME);
      });
    } else if (blk.type === "image") {
      var img = document.createElement("img");
      if (blk.assetId) {
        Promise.resolve(ctx.resolveAssetUrl(blk.assetId)).then(function (u) {
          if (u) img.src = u;
        });
        img.setAttribute("data-rf-asset", blk.assetId); // 必须，导出会用
      } else if (blk.src) {
        img.src = blk.src;
      }
      host.appendChild(img);
    }
  }

  window.ReportFlowTemplates.register({
    manifest: { /* 同 template.json，用于程序内查询 */
      id: "my-template", name: "我的模板", version: "1.0.0",
      stylesheet: "style.css", capabilities: { charts: ["pie","bar","line"], pdfSafe: true }
    },
    renderReport: renderReport
  });
})();
```

## 5. `ctx` 提供的工具

每次 `renderReport` 调用时，`ctx` 至少包含：

| 字段 | 说明 |
|---|---|
| `ctx.mode` | `"preview"` 或 `"export"`（导出 PDF 时为 export） |
| `ctx.renderChart(spec, container, theme)` | 把通用 chart spec 渲染为 ECharts canvas |
| `ctx.chartToSvg(spec, theme)` | 同上但返回 SVG 字符串 |
| `ctx.resolveAssetUrl(assetId)` | 返回 `Promise<string>`，本地图片的 object URL |
| `ctx.marked(text)` | 把 markdown 渲染为 HTML 字符串 |
| `ctx.escapeHtml(s)` | 转义 HTML |

## 6. 接入你的模板

在 `index.html` 末尾的「Templates」注释区块加一行：

```html
<script defer src="templates/my-template/render.js"></script>
```

刷新浏览器，模板下拉框就会出现「我的模板」。**核心代码零修改**。

## 7. 校验清单

发布前过一遍：

- [ ] `style.css` 所有选择器都以 `.rf-tpl-<id>` 开头？
- [ ] `<img data-rf-asset="...">` 属性已加（否则导出 ZIP 找不到图片）？
- [ ] 图表容器有显式 `width` / `height`？
- [ ] 在三种页面尺寸（小 / 中 / 大）都试过？
- [ ] 切换到你的模板再切回去，前一个模板的样式没残留？
- [ ] PDF 导出（`pdfSafe: true` 时）没出现样式失真？

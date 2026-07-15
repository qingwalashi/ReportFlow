/**
 * Template: guozi-cloud (国资云主题) — render.js
 *
 * 浅色蓝色科技风：纸白底、深蓝石板字、青/电光蓝强调。
 * 头部是一个实景大屏照片 hero：照片在底层，上面叠一层蓝调玻璃蒙版，
 * 标题与机构名压在蒙版之上。蒙版与照片解耦，替换照片不影响可读性。
 * 参考宁波市国资云驾驶舱大屏配色（深蓝 + 青）。
 *
 * 替换头图：把照片放进本文件夹命名为 header.jpg（或 header.png），
 *           再到 style.css 改 --tpl-header-image 即可。
 */
(function () {
  "use strict";

  var THEME = {
    // 冷色系，但拉开相邻色相以便饼/柱图各系列可区分：
    // 电光蓝 → 天空青 → 靛蓝 → 青绿 → 浅蓝 → 水蓝
    palette: ["#1e6fff", "#16b6e8", "#4f46e5", "#06b6a4", "#7aa7ff", "#38bdf8"],
    textColor: "#16202e",
    axisColor: "#7a869a",
    splitColor: "#d8e6f7",
    fontFamily: '"Inter", "PingFang SC", "SF Pro Text", "Microsoft YaHei", sans-serif',
    pieBorderColor: "#ffffff",
    pieBorderWidth: 2
  };

  // 机构名 — 作为 hero 的固定署名（照片替换后仍然展示）
  var ORG_NAME = "宁波市国资云";

  // 专属平台图标 — 云 + 数据节点（表达「国资云」），inline SVG 随署名缩放
  var ORG_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M7 18h9.5a3.5 3.5 0 0 0 .6-6.95 5 5 0 0 0-9.66-1.2A4 4 0 0 0 7 18Z"/>' +
    '<circle cx="9.5" cy="14" r="0.6" fill="currentColor" stroke="none"/>' +
    '<circle cx="12.5" cy="14" r="0.6" fill="currentColor" stroke="none"/>' +
    '<circle cx="15.5" cy="14" r="0.6" fill="currentColor" stroke="none"/>' +
    '</svg>';

  function renderReport(data, container, ctx) {
    var meta = (data && data.meta) || {};
    var sections = (data && data.sections) || [];

    // ---- Hero header（照片 + 蒙版 + 标题）----
    var hero = h(container, "div", "rf-hero");
    h(hero, "div", "rf-hero__photo");     // 背景照片层（CSS 变量控制图片）
    h(hero, "div", "rf-hero__scrim");     // 渐变蒙版层

    var inner = h(hero, "div", "rf-hero__inner");
    var org = h(inner, "div", "rf-hero__org");
    // 专属平台标记：云 + 数据节点图标（表达国资云）
    var icon = h(org, "span", "rf-hero__icon");
    icon.innerHTML = ORG_ICON;
    h(org, "span", "", ORG_NAME);

    h(inner, "h1", "rf-hero__title", meta.title || "未命名报告");
    if (meta.subtitle) h(inner, "div", "rf-hero__subtitle", meta.subtitle);

    var byline = h(inner, "div", "rf-hero__byline");
    if (meta.author) addMeta(byline, "撰写", meta.author);
    if (meta.date)   addMeta(byline, "日期", meta.date);
    if (meta.version) addMeta(byline, "版本", "v" + meta.version);

    if (Array.isArray(meta.tags) && meta.tags.length) {
      var tagsBox = h(inner, "div", "rf-hero__tags");
      meta.tags.forEach(function (t) { h(tagsBox, "span", "rf-tag", t); });
    }

    // ---- Body ----
    // 注意：section 必须是 #root 的直接子节点，宿主的滚动联动 / 点击编辑
    // （scroll-sync.js、block-highlight.js）依赖 "#root > section.rf-section"
    // 这一约定来配对编辑区与预览区的区块。
    sections.forEach(function (sec) {
      var secEl = h(container, "section", "rf-section");
      if (sec.heading) h(secEl, "h2", "rf-section__heading", sec.heading);
      (sec.blocks || []).forEach(function (blk) { renderBlock(blk, secEl, ctx); });
    });

    var footText = ctx.footerText && ctx.footerText();
    if (footText) h(container, "div", "rf-doc-footer", footText);
  }

  function addMeta(host, key, val) {
    var item = h(host, "span", "rf-hero__meta");
    h(item, "span", "rf-hero__meta-key", key);
    h(item, "span", "rf-hero__meta-val", val);
  }

  function renderBlock(blk, host, ctx) {
    if (!blk || !blk.type) return;
    var wrap = h(host, "div", "rf-block rf-block--" + blk.type);

    if (blk.type === "text") {
      var html = blk.format === "plain"
        ? "<p>" + ctx.escapeHtml(blk.content || "").replace(/\n/g, "<br>") + "</p>"
        : ctx.marked(blk.content || "");
      var box = h(wrap, "div", "rf-text"); box.innerHTML = html;
      return;
    }
    if (blk.type === "chart") {
      var card = h(wrap, "div", "rf-chart-card");
      if (blk.title) h(card, "div", "rf-chart-card__title", blk.title);
      var cbody = h(card, "div", "rf-chart-card__body");
      requestAnimationFrame(function () {
        try { ctx.renderChart(blk.spec, cbody, THEME); }
        catch (e) { cbody.textContent = "图表渲染失败"; }
      });
      return;
    }
    if (blk.type === "image") {
      var fig = h(wrap, "figure", "rf-img");
      var img = h(fig, "img"); img.alt = blk.caption || "";
      if (blk.assetId) {
        Promise.resolve(ctx.resolveAssetUrl(blk.assetId)).then(function (url) {
          if (url) img.src = url;
        });
        img.setAttribute("data-rf-asset", blk.assetId);
      } else if (blk.src) {
        img.src = blk.src;
      }
      if (blk.caption) h(fig, "figcaption", "rf-img__caption", blk.caption);
      return;
    }
    if (blk.type === "table") {
      if (window.RF_TableFormat && window.RF_TableFormat.renderTableHtml) {
        wrap.insertAdjacentHTML("beforeend", window.RF_TableFormat.renderTableHtml(blk, {
          figClass:   "rf-tpl-guozi-cloud-table",
          tableClass: "rf-table"
        }));
      } else {
        wrap.textContent = "（表格模块未加载）";
      }
    }
  }

  function h(parent, tag, cls, text) {
    var el = (parent.ownerDocument || document).createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  window.ReportFlowTemplates.register({
    manifest: {
      id: "guozi-cloud",
      name: "国资云",
      version: "1.0.0",
      author: "ReportFlow",
      description: "浅色蓝色科技风 + 可替换实景头图，参考宁波市国资云驾驶舱配色，适合国资云对外汇报。",
      stylesheet: "style.css",
      capabilities: { charts: ["pie", "bar", "line"], images: true, pdfSafe: true }
    },
    theme: THEME,
    renderReport: renderReport
  });
})();

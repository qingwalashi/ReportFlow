/**
 * Template: library (图书馆主题) — render.js
 *
 * 白调阅读室风：建筑白纸底、墨灰正文、藏书绿 + 黄铜强调，衬线标题。
 * 头部是一个中庭实景照片 hero：照片在底层，上面叠一层「轻调」玻璃蒙版
 * （区别于超算/国资云的深色压暗蒙版——这里保留照片的明亮白调，
 * 标题用墨色压在浅色蒙版之上）。蒙版与照片解耦，替换照片不影响可读性。
 *
 * 替换头图：把照片放进本文件夹命名为 header.jpg（或 header.png），
 *           再到 style.css 改 --tpl-header-image 即可。
 */
(function () {
  "use strict";

  var THEME = {
    // 暖中性 + 藏书绿/黄铜的克制点缀，拉开相邻色相以便饼/柱图各系列可区分：
    // 藏书绿 → 黄铜金 → 鼠尾草绿 → 赭石 → 青灰 → 浅金
    palette: ["#2f6b57", "#b8924e", "#5c8a6f", "#a9683f", "#6f8a93", "#d8b878"],
    textColor: "#232a2e",
    axisColor: "#8a8478",
    splitColor: "#e4e2da",
    fontFamily: '"Inter", "PingFang SC", "SF Pro Text", "Microsoft YaHei", sans-serif',
    pieBorderColor: "#ffffff",
    pieBorderWidth: 2
  };

  // 机构名 — 作为 hero 的固定署名（照片替换后仍然展示）
  var ORG_NAME = "宁波市图书馆";

  // 专属平台图标 — 翻开的书（表达「图书馆」），inline SVG 随署名缩放
  var ORG_ICON =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 6.5C10.5 5.3 8.4 4.8 5.5 5 4.7 5 4 5.7 4 6.5v10.4c0 .9.8 1.6 1.7 1.5 2.6-.2 4.7.3 6.3 1.6"/>' +
    '<path d="M12 6.5c1.5-1.2 3.6-1.7 6.5-1.5.8 0 1.5.7 1.5 1.5v10.4c0 .9-.8 1.6-1.7 1.5-2.6-.2-4.7.3-6.3 1.6"/>' +
    '<path d="M12 6.5V20"/>' +
    '</svg>';

  function renderReport(data, container, ctx) {
    var meta = (data && data.meta) || {};
    var sections = (data && data.sections) || [];

    // ---- Hero header（照片 + 蒙版 + 标题）----
    var hero = h(container, "div", "rf-hero");
    h(hero, "div", "rf-hero__photo");     // 背景照片层（CSS 变量控制图片）
    h(hero, "div", "rf-hero__scrim");     // 渐变蒙版层（轻调）

    var inner = h(hero, "div", "rf-hero__inner");
    var org = h(inner, "div", "rf-hero__org");
    // 专属平台标记：翻开的书图标（表达图书馆）
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
          figClass:   "rf-tpl-library-table",
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
      id: "library",
      name: "图书馆",
      version: "1.0.0",
      author: "ReportFlow",
      description: "白调阅读室风 + 可替换中庭实景头图，墨灰正文与藏书绿/黄铜强调、衬线标题，适合宁波市图书馆对外汇报。",
      stylesheet: "style.css",
      capabilities: { charts: ["pie", "bar", "line"], images: true, pdfSafe: true }
    },
    theme: THEME,
    renderReport: renderReport
  });
})();

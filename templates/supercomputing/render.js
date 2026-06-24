/**
 * Template: supercomputing (超算中心主题) — render.js
 *
 * Codex 浅色风格：纸白底、石墨黑字、单一青色强调。
 * 头部是一个实景照片 hero：照片在底层，上面叠一层石墨渐变蒙版，
 * 标题与机构名压在蒙版之上。蒙版与照片解耦，替换照片不影响可读性。
 *
 * 替换头图：把照片放进本文件夹命名为 header.jpg（或 header.png），
 *           再到 style.css 改 --tpl-header-image 即可。
 */
(function () {
  "use strict";

  var THEME = {
    palette: ["#2563eb", "#0ea5e9", "#60a5fa", "#1e3a8a", "#38bdf8", "#7dd3fc"],
    textColor: "#16202e",
    axisColor: "#7a869a",
    splitColor: "#dce6f5",
    fontFamily: '"Inter", "PingFang SC", "SF Pro Text", "Microsoft YaHei", sans-serif',
    pieBorderColor: "#ffffff",
    pieBorderWidth: 2
  };

  // 机构名 — 作为 hero 的固定署名（照片替换后仍然展示）
  var ORG_NAME = "宁波市人工智能超算中心";

  function renderReport(data, container, ctx) {
    var meta = (data && data.meta) || {};
    var sections = (data && data.sections) || [];

    // ---- Hero header（照片 + 蒙版 + 标题）----
    var hero = h(container, "div", "rf-hero");
    h(hero, "div", "rf-hero__photo");     // 背景照片层（CSS 变量控制图片）
    h(hero, "div", "rf-hero__scrim");     // 渐变蒙版层

    var inner = h(hero, "div", "rf-hero__inner");
    var org = h(inner, "div", "rf-hero__org");
    h(org, "span", "rf-hero__dot");
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
    // 这一约定来配对编辑区与预览区的区块。因此这里不再用 .rf-body 包裹，
    // 居中宽度改由 .rf-section / .rf-doc-footer 自身承担。
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
          figClass:   "rf-tpl-supercomputing-table",
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
      id: "supercomputing",
      name: "超算中心",
      version: "1.0.0",
      author: "ReportFlow",
      description: "Codex 浅色风格 + 可替换实景头图，适合超算中心对外汇报。",
      stylesheet: "style.css",
      capabilities: { charts: ["pie", "bar", "line"], images: true, pdfSafe: true }
    },
    theme: THEME,
    renderReport: renderReport
  });
})();

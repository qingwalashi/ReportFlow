/**
 * Template: sre-platform (SRE 观测主题) — render.js
 *
 * 设计理念：打破顶图与正文界限，建立连续的观测系统视觉语言。
 * 通过背景渐变、网格、数据连接线等元素，营造"运维观测平台"的整体感。
 *
 * 标志性设计：
 *   1. 连续渐变背景 - hero 到正文无断点
 *   2. 观测网格 - 全页面细微点阵
 *   3. 数据连接线条 - 章节间蓝线连接
 *   4. 状态指示器 - 章节标题旁圆点
 *   5. 代码注释风格 - 元数据 /* 装饰
 *
 * 配色体系：
 *   主蓝 #2563eb - 观测、数据
 *   水鸭绿 #0d9488 - 健康、SLO
 *   琥珀 #d97706 - 预警
 *   故障红 #dc2626 - 异常
 */
(function () {
  "use strict";

  var THEME = {
    // SRE 观测配色体系
    palette: ["#2563eb", "#0d9488", "#d97706", "#0ea5e9", "#8b5cf6", "#dc2626"],
    textColor: "#0f172a",
    axisColor: "#64748b",
    splitColor: "#e2e8f0",
    fontFamily: '"Inter", "PingFang SC", -apple-system, sans-serif',
    pieBorderColor: "#ffffff",
    pieBorderWidth: 2
  };

  function renderReport(data, container, ctx) {
    var meta = (data && data.meta) || {};
    var sections = (data && data.sections) || [];

    // ---- Hero 区域（无边界设计）----
    var hero = h(container, "div", "rf-hero");
    var inner = h(hero, "div", "rf-hero__inner");

    // 标题与副标题
    h(inner, "h1", "rf-hero__title", meta.title || "未命名报告");
    if (meta.subtitle) h(inner, "div", "rf-hero__subtitle", meta.subtitle);

    // 元数据：代码注释风格 /* key: value */
    var byline = h(inner, "div", "rf-hero__byline");
    if (meta.author) addMeta(byline, "author", meta.author);
    if (meta.date)   addMeta(byline, "date", meta.date);
    if (meta.version) addMeta(byline, "version", "v" + meta.version);

    if (Array.isArray(meta.tags) && meta.tags.length) {
      var tagsBox = h(inner, "div", "rf-hero__tags");
      meta.tags.forEach(function (t) { h(tagsBox, "span", "rf-tag", t); });
    }

    // ---- 正文区域 ----
    // 与 hero 背景连续渐变，无边界感
    // 章节之间添加数据连接线，形成数据流视觉
    sections.forEach(function (sec, idx) {
      var secEl = h(container, "section", "rf-section");
      // 设置章节序号，用于 CSS 显示
      secEl.setAttribute("data-section", "§" + String(idx + 1).padStart(2, "0"));

      if (sec.heading) {
        h(secEl, "h2", "rf-section__heading", sec.heading);
      }
      (sec.blocks || []).forEach(function (blk) {
        renderBlock(blk, secEl, ctx);
      });
    });

    var footText = ctx.footerText && ctx.footerText();
    if (footText) h(container, "div", "rf-doc-footer", footText);
  }

  // 元数据：代码注释风格 /* key: value */
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
      // 观测面板风格的图表卡片
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
          figClass:   "rf-tpl-sre-platform-table",
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
      id: "sre-platform",
      name: "SRE 平台服务",
      version: "1.0.0",
      author: "ReportFlow",
      description: "SRE 运维观测主题：打破顶图与正文界限，蓝灰连续渐变背景 + 观测网格 + 数据连接线条，营造专业的监控平台视觉风格。",
      stylesheet: "style.css",
      capabilities: { charts: ["pie", "bar", "line"], images: true, pdfSafe: true }
    },
    theme: THEME,
    renderReport: renderReport
  });
})();

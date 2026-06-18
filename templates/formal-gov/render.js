/**
 * Template: formal-gov (公务正式) — render.js
 *
 * Self-registers on load. Reads the canonical Report JSON, renders into the
 * provided container. Uses ctx.renderChart / ctx.marked / ctx.resolveAssetUrl
 * so the template never imports anything directly.
 */
(function () {
  "use strict";

  var THEME = {
    palette: ["#133a72", "#3b6fbf", "#7aa3e0", "#bcd0eb", "#1f7a4d", "#a37b00"],
    textColor: "#1a1f2c",
    axisColor: "#4a5568",
    splitColor: "#e8eef9",
    fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif'
  };

  function renderReport(data, container, ctx) {
    var meta = (data && data.meta) || {};
    var sections = (data && data.sections) || [];

    // ===== Header =====
    var header = h(container, "div", "rf-doc-header");
    h(header, "div", "rf-doc-title", meta.title || "未命名报告");
    if (meta.subtitle) h(header, "div", "rf-doc-subtitle", meta.subtitle);

    var byline = h(header, "div", "rf-doc-byline");
    if (meta.author) h(byline, "span", "", "撰稿：" + meta.author);
    if (meta.date)   h(byline, "span", "", "日期：" + meta.date);

    if (Array.isArray(meta.tags) && meta.tags.length) {
      var tagWrap = h(header, "div", "rf-tags");
      meta.tags.forEach(function (t) { h(tagWrap, "span", "rf-tag", t); });
    }

    // ===== Sections =====
    sections.forEach(function (sec) {
      var secEl = h(container, "section", "rf-section");
      h(secEl, "h2", "rf-section__heading", sec.heading || "");
      (sec.blocks || []).forEach(function (blk) { renderBlock(blk, secEl, ctx); });
    });

    // ===== Footer =====
    var foot = h(container, "div", "rf-doc-footer");
    foot.textContent = "—— 本报告由 ReportFlow 生成 ——";
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
      var body = h(card, "div", "rf-chart-card__body");
      // Defer chart init to next frame so layout has size.
      requestAnimationFrame(function () {
        try { ctx.renderChart(blk.spec, body, THEME); }
        catch (e) { console.warn("[formal-gov] chart failed", e); body.textContent = "图表渲染失败"; }
      });
      return;
    }

    if (blk.type === "image") {
      var fig = h(wrap, "figure", "rf-img");
      var img = h(fig, "img", ""); img.alt = blk.caption || "";
      if (blk.assetId) {
        Promise.resolve(ctx.resolveAssetUrl(blk.assetId)).then(function (url) {
          if (url) img.src = url; else img.alt = "（图片资源缺失：" + blk.assetId + "）";
        });
      } else if (blk.src) {
        img.src = blk.src;
      } else {
        img.alt = "（未上传图片）";
      }
      if (blk.caption) h(fig, "figcaption", "rf-img__caption", blk.caption);
      // Mark for export packaging
      if (blk.assetId) img.setAttribute("data-rf-asset", blk.assetId);
      return;
    }

    if (blk.type === "table") {
      if (window.RF_TableFormat && window.RF_TableFormat.renderTableHtml) {
        wrap.insertAdjacentHTML("beforeend", window.RF_TableFormat.renderTableHtml(blk, {
          figClass:   "rf-tpl-formal-gov-table",
          tableClass: "rf-table"
        }));
      } else {
        wrap.textContent = "（表格模块未加载）";
      }
      return;
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
      id: "formal-gov",
      name: "公务正式",
      version: "1.0.0",
      author: "ReportFlow",
      description: "深蓝主色 + 宋体衬线，适配公文风格的工作汇报、述职报告。",
      stylesheet: "style.css",
      capabilities: { charts: ["pie", "bar", "line"], images: true, pdfSafe: true }
    },
    theme: THEME,
    renderReport: renderReport
  });
})();

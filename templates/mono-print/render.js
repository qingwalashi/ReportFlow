/**
 * Template: mono-print (水墨刊印) — render.js
 *
 * Pure grayscale + serif typography. Distinguishes chart series by
 * lightness rather than hue. Self-registers on load.
 */
(function () {
  "use strict";

  var THEME = {
    // 黑→灰阶梯：依次降低明度对比，避免邻近两段太接近
    palette: ["#111111", "#4a4a4a", "#7a7a7a", "#a0a0a0", "#c4c4c4", "#dcdcdc"],
    textColor: "#1a1a1a",
    axisColor: "#5c5c5c",
    splitColor: "#dcdcdc",
    fontFamily: '"Source Han Serif SC", "Songti SC", SimSun, "PingFang SC", serif',
    // 饼图扇区之间用浅灰描边分隔（白底纸面，避免相邻灰段糊在一起）
    pieBorderColor: "#fafafa",
    pieBorderWidth: 1.5
  };

  function renderReport(data, container, ctx) {
    var meta = (data && data.meta) || {};
    var sections = (data && data.sections) || [];

    // ===== Header =====
    var header = h(container, "div", "rf-doc-header");
    h(header, "div", "rf-doc-eyebrow", (meta.date || "") + (meta.version ? "　第 " + meta.version + " 版" : ""));
    h(header, "h1", "rf-doc-title", meta.title || "未命名报告");
    if (meta.subtitle) h(header, "div", "rf-doc-subtitle", meta.subtitle);

    var byline = h(header, "div", "rf-doc-byline");
    if (meta.author) h(byline, "span", "", "撰稿　" + meta.author);
    if (meta.date)   h(byline, "span", "", "日期　" + meta.date);

    if (Array.isArray(meta.tags) && meta.tags.length) {
      var tagWrap = h(header, "div", "rf-tags");
      meta.tags.forEach(function (t) { h(tagWrap, "span", "rf-tag", t); });
    }

    // ===== Sections =====
    sections.forEach(function (sec, i) {
      var secEl = h(container, "section", "rf-section");
      var heading = h(secEl, "h2", "rf-section__heading");
      h(heading, "span", "rf-section__index", String(i + 1).padStart(2, "0"));
      h(heading, "span", "rf-section__text", sec.heading || "");
      (sec.blocks || []).forEach(function (blk) { renderBlock(blk, secEl, ctx); });
    });

    // ===== Footer =====
    var footText = ctx.footerText && ctx.footerText();
    if (footText) h(container, "div", "rf-doc-footer", footText);
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
      requestAnimationFrame(function () {
        try { ctx.renderChart(blk.spec, body, THEME); }
        catch (e) { console.warn("[mono-print] chart failed", e); body.textContent = "图表渲染失败"; }
      });
      return;
    }

    if (blk.type === "image") {
      var fig = h(wrap, "figure", "rf-img");
      var img = h(fig, "img"); img.alt = blk.caption || "";
      if (blk.assetId) {
        Promise.resolve(ctx.resolveAssetUrl(blk.assetId)).then(function (url) {
          if (url) img.src = url; else img.alt = "（图片资源缺失：" + blk.assetId + "）";
        });
        img.setAttribute("data-rf-asset", blk.assetId);
      } else if (blk.src) {
        img.src = blk.src;
      } else {
        img.alt = "（未上传图片）";
      }
      if (blk.caption) h(fig, "figcaption", "rf-img__caption", blk.caption);
      return;
    }

    if (blk.type === "table") {
      if (window.RF_TableFormat && window.RF_TableFormat.renderTableHtml) {
        wrap.insertAdjacentHTML("beforeend", window.RF_TableFormat.renderTableHtml(blk, {
          figClass:   "rf-tpl-mono-print-table",
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
      id: "mono-print",
      name: "水墨刊印",
      version: "1.0.0",
      author: "ReportFlow",
      description: "纯黑白灰阶 + 宋体衬线，借鉴旧式报刊版样，适合需要克制、严肃质感的报告。",
      stylesheet: "style.css",
      capabilities: { charts: ["pie", "bar", "line"], images: true, pdfSafe: true }
    },
    theme: THEME,
    renderReport: renderReport
  });
})();

/**
 * Template: cyber-security (网络安全态势主题) — render.js
 *
 * 设计理念：营造安全运营中心（SOC）指挥大屏的视觉语言。
 * Hero 区域采用深邃暗蓝基调，象征安全监控的深度与警戒感；
 * 正文区域平滑过渡到浅灰白，保证长文本阅读舒适度。
 *
 * 标志性设计：
 *   1. 深色 Hero 渐变到浅色正文 - 从"监控大屏"过渡到"报告正文"
 *   2. 六边形安全网格 - 象征安全防护网
 *   3. 威胁等级色条 - 章节左侧采用安全/警告/危险色彩系统
 *   4. 终端命令风格 - 元数据使用 $ 前缀的终端样式
 *   5. 盾牌/锁图标元素 - Hero 区域水印，章节标题安全图标
 *   6. 关键数字 KPI 卡片 - 态势感知仪表盘风格
 *
 * 配色体系（安全态势主题）：
 *   主青 #06b6d4  - 安全、防护、监控
 *   主蓝 #3b82f6  - 稳定、信任、合规
 *   预警 #f59e0b  - 中危、警告
 *   危险 #ef4444  - 高危、阻断、事件
 *   深紫 #8b5cf6  - 加密、隐私
 *   背景 深蓝 #0b1437 → 靛蓝 → 浅灰白 #f4f7fc
 */
(function () {
  "use strict";

  var THEME = {
    // 网络安全态势配色体系（深色卡片底：#111a3a / #151f45）
    palette: ["#22d3ee", "#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#f87171"],
    textColor: "#e2e8f0",       // 亮字，匹配 --sec-ink
    axisColor: "#94a3b8",       // 刻度/次级文字
    splitColor: "rgba(148,163,184,0.18)", // 网格线：深色底上用半透明亮色，避免刺眼
    fontFamily: '"Inter", "PingFang SC", -apple-system, sans-serif',
    pieBorderColor: "rgba(34,211,238,0.25)", // 饼图扇区分割线：半透青，和扫描线色系呼应
    pieBorderWidth: 2
  };

  // 安全等级徽章类名映射
  var SEVERITY_CLASS = {
    "info": "sec-badge sec-badge--info",
    "low": "sec-badge sec-badge--low",
    "medium": "sec-badge sec-badge--medium",
    "high": "sec-badge sec-badge--high",
    "critical": "sec-badge sec-badge--critical"
  };

  function renderReport(data, container, ctx) {
    var meta = (data && data.meta) || {};
    var sections = (data && data.sections) || [];

    var hasSubtitle = !!(meta.subtitle && meta.subtitle.trim());
    var hasAuthor   = !!(meta.author && meta.author.trim());
    var hasDate     = !!(meta.date && meta.date.trim());
    var hasVersion  = !!(meta.version && String(meta.version).trim());
    var hasByline   = hasAuthor || hasDate || hasVersion;
    var hasTags     = Array.isArray(meta.tags) && meta.tags.length;
    var hasSeverity = !!(meta.severity && String(meta.severity).trim());
    var hasClassif  = !!(meta.classification && String(meta.classification).trim());

    // ---- Hero 区域（深色安全监控大屏风格）----
    var hero = h(container, "div", "rf-hero");
    var inner = h(hero, "div", "rf-hero__inner");

    // 内容紧凑度
    if (!hasSubtitle && !hasByline && !hasTags && !hasSeverity && !hasClassif) {
      hero.classList.add("rf-hero--title-only");
    } else if (!hasByline && !hasTags) {
      hero.classList.add("rf-hero--no-meta");
    }

    // Hero 顶部分类/密级标签行
    if (hasClassif || hasSeverity) {
      var topBar = h(inner, "div", "rf-hero__top-bar");
      // 左上角 - 盾牌图标 + 报告分类
      var brandBox = h(topBar, "div", "rf-hero__brand");
      brandBox.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
        '<path d="m9 12 2 2 4-4"/>' +
        '</svg>';
      h(brandBox, "span", null, hasClassif ? meta.classification : "SECURITY REPORT");

      // 右上角 - 密级/威胁等级徽章
      if (hasSeverity) {
        var badge = h(topBar, "span", getSeverityClass(meta.severity));
        badge.textContent = meta.severity.toUpperCase();
      }
    }

    // 标题
    h(inner, "h1", "rf-hero__title", meta.title || "未命名报告");
    if (hasSubtitle) h(inner, "div", "rf-hero__subtitle", meta.subtitle);

    // 元数据：终端命令风格 $ key: value
    if (hasByline) {
      var byline = h(inner, "div", "rf-hero__byline");
      if (hasAuthor)  addMeta(byline, "analyst", meta.author);
      if (hasDate)    addMeta(byline, "date", meta.date);
      if (hasVersion) addMeta(byline, "rev", "v" + meta.version);
    }

    // 标签：安全事件标签样式
    if (hasTags) {
      var tagsBox = h(inner, "div", "rf-hero__tags");
      meta.tags.forEach(function (t) { h(tagsBox, "span", "rf-tag", t); });
    }

    // ---- 正文区域 ----
    sections.forEach(function (sec, idx) {
      var secEl = h(container, "section", "rf-section");
      secEl.setAttribute("data-section", String(idx + 1).padStart(2, "0"));

      // 章节威胁等级（来自 sec.severity 或循环使用）
      var secSev = sec.severity || cycleSeverity(idx);
      secEl.setAttribute("data-severity", secSev);

      if (sec.heading) {
        var heading = h(secEl, "h2", "rf-section__heading");
        // 章节安全图标（小盾牌）
        var icon = h(heading, "span", "rf-section__icon");
        icon.innerHTML =
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
          'stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
          '</svg>';
        h(heading, "span", "rf-section__heading-text", sec.heading);
        // 章节号
        h(heading, "span", "rf-section__num", "§" + String(idx + 1).padStart(2, "0"));
      }
      (sec.blocks || []).forEach(function (blk) {
        renderBlock(blk, secEl, ctx);
      });
    });

    var footText = ctx.footerText && ctx.footerText();
    if (footText) h(container, "div", "rf-doc-footer", footText);
  }

  function getSeverityClass(s) {
    var key = String(s || "").toLowerCase();
    return SEVERITY_CLASS[key] || SEVERITY_CLASS.info;
  }

  // 根据章节序号轮换安全等级视觉（无显式声明时）
  function cycleSeverity(idx) {
    var order = ["info", "info", "low", "info", "medium"];
    return order[idx % order.length];
  }

  // 元数据：终端命令风格 $ key=value
  function addMeta(host, key, val) {
    var item = h(host, "span", "rf-hero__meta");
    var prompt = h(item, "span", "rf-hero__prompt", "$ ");
    h(item, "span", "rf-hero__meta-key", key);
    h(item, "span", "rf-hero__meta-eq", ": ");
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
      // SOC 仪表盘风格的图表卡片 - 顶部状态点 + 标题
      var card = h(wrap, "div", "rf-chart-card");
      // 右上角红黄绿状态点（绝对定位，不占标题流）
      var ctrl = h(card, "div", "rf-chart-card__ctrl");
      ctrl.innerHTML =
        '<span class="rf-dot rf-dot--danger"></span>' +
        '<span class="rf-dot rf-dot--warn"></span>' +
        '<span class="rf-dot rf-dot--ok"></span>';
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
          figClass:   "rf-tpl-cyber-security-table",
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
      id: "cyber-security",
      name: "网络安全态势",
      version: "1.0.0",
      author: "ReportFlow",
      description: "网络安全态势主题：深邃暗蓝 Hero 渐变到浅白正文，六边形安全网格、盾牌/锁安全元素、威胁等级色条、终端命令风格元数据，打造 SOC 安全运营中心视觉。",
      stylesheet: "style.css",
      capabilities: { charts: ["pie", "bar", "line"], images: true, pdfSafe: true }
    },
    theme: THEME,
    renderReport: renderReport
  });
})();

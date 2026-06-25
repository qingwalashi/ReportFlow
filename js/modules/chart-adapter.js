/**
 * chart-adapter.js — translate the canonical chart spec into an ECharts option.
 *
 * Templates may override renderChart() to apply their own palette, but most
 * just call ctx.renderChart(spec, container) which lands here.
 *
 *   spec: { kind: "pie"|"bar"|"line", categories, series:[{name,data}], unit }
 *   theme: { palette: [...], textColor, axisColor, splitColor, fontFamily }
 */
(function () {
  "use strict";

  function buildOption(spec, theme) {
    theme = theme || {};
    var palette = theme.palette || ["#2d5cf6","#52c41a","#faad14","#13c2c2","#722ed1","#eb2f96","#fa541c"];
    var textColor = theme.textColor || "#1a1f2c";
    var axisColor = theme.axisColor || "#8a93a3";
    var splitColor = theme.splitColor || "#eef0f4";
    var fontFamily = theme.fontFamily || "inherit";

    var common = {
      color: palette,
      textStyle: { color: textColor, fontFamily: fontFamily, fontSize: 12 },
      grid: { left: 48, right: 24, top: 36, bottom: 32, containLabel: true },
      tooltip: { trigger: spec.kind === "pie" ? "item" : "axis", confine: true },
      legend: { type: "scroll", top: 4, textStyle: { color: textColor, fontSize: 12 } },
      animation: !theme.disableAnimation
    };

    var unit = spec.unit ? " " + spec.unit : "";

    if (spec.kind === "pie") {
      var first = spec.series[0] || { data: [] };
      var pieData = (spec.categories || []).map(function (cat, i) {
        return { name: cat, value: first.data[i] != null ? first.data[i] : 0 };
      });
      return Object.assign({}, common, {
        legend: Object.assign({}, common.legend, { left: "center" }),
        series: [{
          type: "pie",
          radius: ["38%", "70%"],
          avoidLabelOverlap: true,
          itemStyle: {
            borderColor: theme.pieBorderColor != null ? theme.pieBorderColor : "#fff",
            borderWidth: theme.pieBorderWidth != null ? theme.pieBorderWidth : 2,
            borderRadius: theme.pieBorderRadius != null ? theme.pieBorderRadius : 4
          },
          label: { color: textColor, formatter: "{b} {d}%" },
          data: pieData
        }]
      });
    }

    // bar / line — share x-axis category, y-axis value
    var axisCommon = {
      xAxis: {
        type: "category",
        data: spec.categories || [],
        axisLine: { lineStyle: { color: splitColor } },
        axisTick: { show: false },
        axisLabel: { color: axisColor, fontSize: 11 }
      },
      yAxis: {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: splitColor, type: "dashed" } },
        axisLabel: { color: axisColor, fontSize: 11, formatter: spec.unit ? "{value}" + unit : "{value}" }
      }
    };

    var seriesArr = (spec.series || []).map(function (s, i) {
      if (spec.kind === "line") {
        return {
          name: s.name, type: "line", smooth: true,
          symbol: "circle", symbolSize: 6,
          lineStyle: { width: 2 },
          data: s.data || []
        };
      }
      // bar
      return {
        name: s.name, type: "bar",
        barMaxWidth: 32,
        itemStyle: { borderRadius: [4, 4, 0, 0] },
        data: s.data || []
      };
    });

    return Object.assign({}, common, axisCommon, { series: seriesArr });
  }

  /**
   * renderChart(spec, container, theme?) -> echarts instance.
   * Container should be a sized DOM element (host code sets width/height).
   */
  function renderChart(spec, container, theme) {
    if (!container) throw new Error("chart-adapter: container required");
    if (!window.echarts) throw new Error("chart-adapter: echarts not loaded");
    var inst = window.echarts.getInstanceByDom(container);
    if (inst) inst.dispose();
    inst = window.echarts.init(container, null, { renderer: "canvas" });
    inst.setOption(buildOption(spec, theme));
    return inst;
  }

  /** Convert an existing ECharts instance to inline SVG string for export. */
  function toSvgString(spec, theme) {
    if (!window.echarts) return "";
    var w = (theme && theme.width)  || 720;
    var h = (theme && theme.height) || 320;
    var off = document.createElement("div");
    // position:absolute pulls this temporary host out of the app shell's
    // flex layout (body is display:flex; flex-direction:column). Without
    // this, flex sizing rules can compress the host to 0×0 at the moment
    // echarts.init() measures it synchronously, producing an empty SVG
    // and the "图表不显示" symptom in exported HTML/PDF.
    off.style.cssText = "position:absolute;left:-99999px;top:0;" +
                        "width:" + w + "px;height:" + h + "px;";
    document.body.appendChild(off);
    var inst = window.echarts.init(off, null, { renderer: "svg" });
    // Defensive: if echarts somehow still measured 0×0 (e.g. an unusual
    // CSS rule we didn't anticipate), force a reflow and re-init once.
    if (inst.getWidth() < 1 || inst.getHeight() < 1) {
      void off.offsetHeight;            // force reflow
      inst.dispose();
      inst = window.echarts.init(off, null, { renderer: "svg" });
    }
    inst.setOption(buildOption(spec, theme));
    var svg = off.querySelector("svg");
    var out = svg ? namespaceSvgIds(svg.outerHTML) : "";
    if (!out && window.RF_Log) {
      window.RF_Log.warn("chart: toSvgString returned empty (kind=" + (spec && spec.kind) + ")");
    }
    inst.dispose();
    document.body.removeChild(off);
    return out;
  }

  /**
   * Rewrite all in-document ID references in an SVG string with a unique
   * prefix, so multiple SVGs from successive toSvgString() calls don't
   * collide when embedded together in one HTML document.
   *
   * Why this is needed: zrender's SVG renderer hands out IDs from a counter
   * that resets per-instance. Since we dispose() after every export, the
   * next init() starts the counter back at zero — so chart 1, 2, 3 all
   * emit `<defs><linearGradient id="zr0-c0">...` with the same id. The
   * browser only honors the first; charts 2 and 3 render with broken
   * fills/clips and show as blank.
   *
   * Rewrites: id="x", url(#x), xlink:href="#x", href="#x" (SVG2).
   * Leaves external href/url untouched.
   */
  function namespaceSvgIds(svgStr) {
    if (!svgStr) return svgStr;
    // 8-char alphanumeric. With 36^8 ≈ 2.8 trillion possibilities the chance
    // of two charts in the same export getting the same prefix is negligible.
    var prefix = "rf" + Math.random().toString(36).slice(2, 10) + "_";
    return svgStr
      .replace(/\b(id|href|xlink:href)="([^"]*)"/g, function (m, attr, val) {
        if (attr === "id") return attr + '="' + prefix + val + '"';
        // href / xlink:href: only rewrite #-fragments (intra-SVG refs);
        // pass through external URLs unchanged.
        if (val.charAt(0) === "#") return attr + '="#' + prefix + val.slice(1) + '"';
        return m;
      })
      .replace(/url\(#([^)"\s]+)\)/g, function (_, id) {
        return 'url(#' + prefix + id + ')';
      });
  }

  /**
   * Look up a registered template's chart theme by id.
   * Used by exporters to keep SVG output in sync with the live preview's
   * palette / text / axis colors. Returns {} when the template doesn't
   * declare a theme (legacy registrations) — buildOption will fall back
   * to its built-in defaults.
   */
  function themeOf(templateId) {
    var reg = window.ReportFlowTemplates;
    var spec = templateId && reg ? reg.get(templateId) : null;
    return (spec && spec.theme) || {};
  }

  // ============================================================
  // Export-only: responsive SVG charts + per-chart fullscreen view
  // ------------------------------------------------------------
  // Exported HTML/ZIP charts are static SVG (no ECharts in the output).
  // To make them usable on phones we (1) scale the SVG to the container
  // width, and (2) add a fullscreen button that — on mobile — flips the
  // chart to landscape so a wide chart can be read without squinting.
  // PDF/PNG exports use their own chart path and never see these helpers.
  // ============================================================

  // 16×16 "expand corners" icon (inherits currentColor).
  var FS_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3' +
    'M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';

  /**
   * Append a fullscreen-preview button to a chart card (the parent of the
   * chart body). Idempotent — won't add a second button to the same card.
   * Used by the HTML/ZIP exporters after they inject the responsive SVG.
   */
  function addFullscreenButton(bodyEl, doc) {
    var card = bodyEl && bodyEl.parentNode;
    if (!card || !card.querySelector) return;
    if (card.querySelector(".rf-chart-fs-btn")) return;
    var btn = (doc || document).createElement("button");
    btn.className = "rf-chart-fs-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "全屏查看");
    btn.title = "全屏查看";
    btn.innerHTML = FS_ICON;
    card.appendChild(btn);
  }

  // Styles injected (after template CSS, so they win) into the exported file.
  var EXPORT_FS_CSS = [
    ".rf-chart-card{position:relative;}",
    ".rf-chart-resp{width:100%;max-width:100%;}",
    ".rf-chart-resp svg{width:100%;height:auto;display:block;}",
    ".rf-chart-fs-btn{position:absolute;top:8px;right:8px;z-index:3;width:30px;height:30px;",
    "display:inline-flex;align-items:center;justify-content:center;padding:0;line-height:0;",
    "border:1px solid rgba(0,0,0,.12);border-radius:6px;background:rgba(255,255,255,.82);",
    "color:#444;cursor:pointer;-webkit-tap-highlight-color:transparent;",
    "transition:background .15s,box-shadow .15s;}",
    ".rf-chart-fs-btn:hover{background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.14);}",
    ".rf-chart-fs-btn svg{width:16px;height:16px;display:block;}",
    // Fullscreen overlay — light background, scrollable, keeps SVG aspect ratio
    ".rf-chart-fs{position:fixed;inset:0;z-index:99999;background:rgba(250,250,252,.98);",
    "overflow:auto;-webkit-overflow-scrolling:touch;",
    "display:flex;flex-direction:column;align-items:center;justify-content:center;",
    "padding:48px 16px;}",
    ".rf-chart-fs__stage{width:96vw;display:flex;justify-content:center;flex:none;}",
    ".rf-chart-fs__stage svg{width:100%;height:auto;max-width:100%;}",
    ".rf-chart-fs.is-rotated .rf-chart-fs__stage{transform:rotate(90deg);width:90vh;height:auto;}",
    ".rf-chart-fs__close{position:fixed;top:14px;right:16px;z-index:1;width:40px;height:40px;",
    "border:none;border-radius:50%;background:rgba(0,0,0,.08);color:#1a1f2c;font-size:20px;",
    "line-height:40px;text-align:center;cursor:pointer;}",
    ".rf-chart-fs__close:hover{background:rgba(0,0,0,.14);}",
    "@media print{.rf-chart-fs-btn,.rf-chart-fs{display:none!important;}}"
  ].join("");

  // Self-contained runtime for the exported file. Bound via event delegation,
  // so it works regardless of how many charts the report has.
  var EXPORT_FS_SCRIPT = [
    "(function(){",
    "var mqCoarse=window.matchMedia&&window.matchMedia('(pointer: coarse)');",
    "function coarse(){return mqCoarse?mqCoarse.matches:false;}",
    "function portrait(){return window.matchMedia('(orientation: portrait)').matches;}",
    "function lockLandscape(){try{if(screen.orientation&&screen.orientation.lock)return screen.orientation.lock('landscape');}catch(e){}return null;}",
    "function unlock(){try{if(screen.orientation&&screen.orientation.unlock)screen.orientation.unlock();}catch(e){}}",
    "function open(card){",
    "var svg=card.querySelector('.rf-chart-card__body svg');if(!svg)return;",
    "var ov=document.createElement('div');ov.className='rf-chart-fs';",
    "var close=document.createElement('button');close.className='rf-chart-fs__close';",
    "close.setAttribute('aria-label','关闭');close.innerHTML='\\u2715';",
    "var stage=document.createElement('div');stage.className='rf-chart-fs__stage';",
    "stage.appendChild(svg.cloneNode(true));ov.appendChild(close);ov.appendChild(stage);",
    "document.body.appendChild(ov);document.body.style.overflow='hidden';",
    "var locked=false;",
    "function sync(){if(!locked&&portrait()&&coarse())ov.classList.add('is-rotated');else ov.classList.remove('is-rotated');}",
    "var req=ov.requestFullscreen||ov.webkitRequestFullscreen||ov.msRequestFullscreen;",
    "Promise.resolve().then(function(){if(req)return req.call(ov);}).then(function(){",
    "var p=lockLandscape();if(p&&p.then)return p.then(function(){locked=true;},function(){});",
    "}).catch(function(){}).then(sync);",
    "sync();window.addEventListener('resize',sync);",
    "function destroy(){window.removeEventListener('resize',sync);unlock();",
    "var ex=document.exitFullscreen||document.webkitExitFullscreen||document.msExitFullscreen;",
    "try{if((document.fullscreenElement||document.webkitFullscreenElement)&&ex)ex.call(document);}catch(e){}",
    "document.body.style.overflow='';if(ov.parentNode)ov.parentNode.removeChild(ov);",
    "document.removeEventListener('keydown',onKey);}",
    "function onKey(e){if(e.key==='Escape'||e.keyCode===27)destroy();}",
    "close.addEventListener('click',destroy);",
    "ov.addEventListener('click',function(e){if(e.target===ov)destroy();});",
    "document.addEventListener('keydown',onKey);",
    "}",
    "document.addEventListener('click',function(e){",
    "var btn=e.target.closest&&e.target.closest('.rf-chart-fs-btn');if(!btn)return;",
    "var card=btn.closest('.rf-chart-card');if(card)open(card);});",
    "})();"
  ].join("");

  window.RF_Chart = {
    buildOption: buildOption,
    renderChart: renderChart,
    toSvgString: toSvgString,
    themeOf: themeOf,
    addFullscreenButton: addFullscreenButton,
    exportFullscreenCss: EXPORT_FS_CSS,
    exportFullscreenScript: EXPORT_FS_SCRIPT
  };
})();

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

  window.RF_Chart = {
    buildOption: buildOption,
    renderChart: renderChart,
    toSvgString: toSvgString,
    themeOf: themeOf
  };
})();

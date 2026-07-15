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
      // Give the bottom axis extra room so a wrapped 2–3 line x-label doesn't
      // get clipped below the plot area. containLabel already sizes for one
      // line; wrapping needs the padding.
      grid: { left: 48, right: 24, top: 36, bottom: 48, containLabel: true },
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
        legend: Object.assign({}, common.legend, {
          left: "center",
          // Wrap long pie legend labels the same way as x-axis categories so
          // narrow charts don't clip them (legend scroll still handles overflow
          // in the other dimension). formatter runs per legend item.
          formatter: function (name) {
            return wrapLabel(name, pieLegendMaxChars(spec.categories && spec.categories.length));
          }
        }),
        series: [{
          type: "pie",
          radius: ["38%", "70%"],
          avoidLabelOverlap: true,
          itemStyle: {
            borderColor: theme.pieBorderColor != null ? theme.pieBorderColor : "#fff",
            borderWidth: theme.pieBorderWidth != null ? theme.pieBorderWidth : 2,
            borderRadius: theme.pieBorderRadius != null ? theme.pieBorderRadius : 4
          },
          // Pie slice labels wrap too — long category names on outer labels
          // used to run off the SVG viewbox and get cropped.
          label: {
            color: textColor,
            formatter: function (params) {
              return wrapLabel(params.name, 10) + " " + params.percent + "%";
            }
          },
          data: pieData
        }]
      });
    }

    // bar / line — share x-axis category, y-axis value
    var catCount = (spec.categories || []).length || 1;
    // Rough chars-per-line budget for x-axis labels. Fewer categories → each
    // gets more horizontal space, so we allow longer lines before wrapping.
    // These numbers are calibrated for the 720px chart width used in exports
    // and roughly match what fits in the preview at typical widths.
    var xCharsPerLine = xAxisCharsPerLine(catCount);
    var axisCommon = {
      xAxis: {
        type: "category",
        data: spec.categories || [],
        axisLine: { lineStyle: { color: splitColor } },
        axisTick: { show: false },
        axisLabel: {
          color: axisColor,
          fontSize: 11,
          // hideOverlap:false + interval:0 forces every category label to
          // render; wrapping keeps them readable when they'd otherwise
          // overlap. Wrapped labels grow downward, which the grid.bottom
          // adjustment below allowances for. maxLines is generous (6) so
          // long CJK category names actually show in full rather than
          // being ellipsised on the axis.
          interval: 0,
          hideOverlap: false,
          formatter: function (val) { return wrapLabel(val, xCharsPerLine, 6); }
        }
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

    // 让 x 轴的多行标签不被 grid.bottom 裁掉。containLabel:true 会按标签
    // 实际渲染尺寸预留空间，但我们把 x 轴 formatter 设成可能拆到 6 行，
    // 对应的 bottom 需要跟着上调，否则 SVG 导出场景下 (viewBox 固定)
    // 底部标签仍会被切。经验值：每行 ~16px。
    var xLines = estimateWrappedLines(spec.categories || [], xCharsPerLine);
    if (xLines > 1) {
      common = Object.assign({}, common, {
        grid: Object.assign({}, common.grid, {
          bottom: Math.max(common.grid.bottom, 24 + xLines * 16)
        })
      });
    }

    return Object.assign({}, common, axisCommon, { series: seriesArr });
  }

  /** Peek at every category and return the max wrap-line count. */
  function estimateWrappedLines(categories, perLine) {
    var max = 1;
    for (var i = 0; i < categories.length; i++) {
      var wrapped = wrapLabel(categories[i], perLine, 6);
      var n = wrapped.split("\n").length;
      if (n > max) max = n;
    }
    return max;
  }

  /**
   * Wrap a label string into fixed-width lines separated by "\n" (which
   * ECharts' rich-text renderer treats as a hard line break in labels).
   *
   * Splits on whitespace when present; falls back to character splits for
   * runs of CJK/other whitespace-less text so a long 类别名称 wraps too.
   * Caps at `maxLines` (default 3) with a trailing ellipsis on the last
   * line when content was truncated — the axis band stays bounded and the
   * reader still gets a signal that more text existed.
   */
  function wrapLabel(text, perLine, maxLines) {
    var s = String(text == null ? "" : text);
    if (!s || perLine <= 0) return s;
    var lim = maxLines || 3;
    var lines = [];
    var truncated = false;

    if (/\s/.test(s)) {
      // Whitespace-separated — pack whole words per line.
      var words = s.split(/\s+/);
      var buf = "";
      for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (!buf.length) {
          buf = w;
        } else if (buf.length + 1 + w.length <= perLine) {
          buf += " " + w;
        } else {
          lines.push(buf);
          buf = w;
          if (lines.length >= lim) { truncated = true; break; }
        }
      }
      if (!truncated && buf) lines.push(buf);
      if (!truncated && lines.length > lim) {
        lines = lines.slice(0, lim);
        truncated = true;
      }
    } else {
      // No whitespace — character-wise wrap (handles CJK).
      var buf2 = "";
      for (var k = 0; k < s.length; k++) {
        buf2 += s.charAt(k);
        if (buf2.length >= perLine) {
          lines.push(buf2);
          buf2 = "";
          if (lines.length >= lim) {
            if (k < s.length - 1) truncated = true;
            break;
          }
        }
      }
      if (!truncated && buf2 && lines.length < lim) lines.push(buf2);
    }

    if (truncated && lines.length) {
      var last = lines[lines.length - 1];
      if (last.length >= perLine) last = last.slice(0, Math.max(0, perLine - 1));
      lines[lines.length - 1] = last + "…";
    }
    return lines.join("\n");
  }

  // Heuristic: how many chars fit on ONE line of an x-axis category label
  // given N categories in a ~720px-wide chart. The plot area (right - left
  // in `grid`) is ~648px; dividing by 6.5px/char (11px font, mixed CJK/ASCII)
  // and rounding down keeps a small safety margin.
  function xAxisCharsPerLine(n) {
    if (n <= 3) return 14;
    if (n <= 5) return 10;
    if (n <= 8) return 7;
    if (n <= 12) return 5;
    return 4;
  }

  // Pie legend items sit in a horizontal scroll strip. Give them a moderate
  // budget — long names still wrap, short ones stay on one line.
  function pieLegendMaxChars(n) {
    if (!n || n <= 4) return 14;
    if (n <= 8) return 10;
    return 8;
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

  // Export-only: make inline SVG charts scale on narrow screens.
  // Fullscreen buttons live in export-fullscreen.js.

  /**
   * Rewrite an ECharts SVG string so it scales to the container width on
   * narrow screens. Strips fixed width/height attributes (which mobile
   * browsers honour over CSS), injects viewBox when missing, and sets
   * preserveAspectRatio so the chart is never clipped.
   */
  function makeSvgResponsive(svgStr) {
    if (!svgStr) return svgStr;
    var openRe = /<svg\b([^>]*)>/;
    var m = svgStr.match(openRe);
    if (!m) return svgStr;

    var attrs = m[1];
    var w = (attrs.match(/\bwidth="(\d+(?:\.\d+)?)"/) || [])[1];
    var h = (attrs.match(/\bheight="(\d+(?:\.\d+)?)"/) || [])[1];
    var hasViewBox = /\bviewBox\s*=/.test(attrs);

    var cleaned = attrs
      .replace(/\bwidth="[^"]*"/g, "")
      .replace(/\bheight="[^"]*"/g, "")
      .replace(/\sstyle="[^"]*"/g, "");

    if (!hasViewBox && w && h) {
      cleaned += ' viewBox="0 0 ' + w + " " + h + '"';
    }
    cleaned += ' preserveAspectRatio="xMidYMid meet"';
    cleaned += ' style="width:100%;height:auto;max-width:100%;display:block;"';

    return svgStr.replace(openRe, "<svg" + cleaned + ">");
  }

  window.RF_Chart = {
    buildOption: buildOption,
    renderChart: renderChart,
    toSvgString: toSvgString,
    makeSvgResponsive: makeSvgResponsive,
    themeOf: themeOf
  };
})();

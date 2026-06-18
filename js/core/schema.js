/**
 * schema.js — pure-JS validator for the Report JSON contract.
 *
 * Returns: { ok: bool, errors: [{path, msg}], normalized: <coerced object> }
 *
 * Philosophy: be lenient on input (LLMs drift), strict on output. validateAndFix()
 * coerces missing fields to safe defaults so the editor and templates never
 * crash on a half-formed structure.
 */
(function () {
  "use strict";

  var SCHEMA_VERSION = 1;

  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
  function isArr(v) { return Array.isArray(v); }
  function isStr(v) { return typeof v === "string"; }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function uid(prefix) {
    return (prefix || "id-") + Math.random().toString(36).slice(2, 9);
  }

  var CHART_KINDS = ["pie", "bar", "line"];

  function validateAndFix(input) {
    var errors = [];
    var data = isObj(input) ? input : {};

    var out = {
      schemaVersion: SCHEMA_VERSION,
      meta: fixMeta(data.meta, errors),
      sections: fixSections(data.sections, errors)
    };
    return { ok: errors.length === 0, errors: errors, normalized: out };
  }

  function fixMeta(meta, errors) {
    var m = isObj(meta) ? meta : {};
    return {
      title:    isStr(m.title) ? m.title.trim() : "未命名报告",
      subtitle: isStr(m.subtitle) ? m.subtitle.trim() : "",
      author:   isStr(m.author) ? m.author.trim() : "",
      date:     isStr(m.date) ? m.date.trim() : todayIso(),
      tags:     isArr(m.tags) ? m.tags.filter(isStr) : []
    };
  }

  function todayIso() {
    var d = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function fixSections(sections, errors) {
    var arr = isArr(sections) ? sections : [];
    return arr.map(function (s, i) { return fixSection(s, i, errors); });
  }

  function fixSection(sec, i, errors) {
    var s = isObj(sec) ? sec : {};
    var path = "sections[" + i + "]";
    if (!isStr(s.heading) || !s.heading.trim()) {
      errors.push({ path: path + ".heading", msg: "章节标题为空，已用占位替代" });
    }
    return {
      id:      isStr(s.id) ? s.id : uid("s-"),
      heading: isStr(s.heading) && s.heading.trim() ? s.heading.trim() : ("章节 " + (i + 1)),
      level:   isNum(s.level) ? Math.max(1, Math.min(3, s.level | 0)) : 1,
      blocks:  fixBlocks(s.blocks, path, errors)
    };
  }

  function fixBlocks(blocks, path, errors) {
    var arr = isArr(blocks) ? blocks : [];
    return arr.map(function (b, j) {
      return fixBlock(b, path + ".blocks[" + j + "]", errors);
    }).filter(Boolean);
  }

  function fixBlock(blk, path, errors) {
    var b = isObj(blk) ? blk : {};
    if (b.type === "text" || (!b.type && isStr(b.content))) {
      return {
        type: "text",
        format: b.format === "plain" ? "plain" : "markdown",
        content: isStr(b.content) ? b.content : ""
      };
    }
    if (b.type === "chart") {
      return { type: "chart", title: isStr(b.title) ? b.title : "", spec: fixChartSpec(b.spec, path, errors) };
    }
    if (b.type === "image") {
      // accept either assetId (preferred) or src (legacy / external URL)
      return {
        type: "image",
        assetId: isStr(b.assetId) ? b.assetId : null,
        src:     isStr(b.src) ? b.src : null,
        caption: isStr(b.caption) ? b.caption : ""
      };
    }
    errors.push({ path: path, msg: "未知块类型: " + JSON.stringify(b.type) });
    return null;
  }

  function fixChartSpec(spec, path, errors) {
    var s = isObj(spec) ? spec : {};
    var kind = CHART_KINDS.indexOf(s.kind) >= 0 ? s.kind : "bar";
    if (s.kind && CHART_KINDS.indexOf(s.kind) < 0) {
      errors.push({ path: path + ".spec.kind", msg: "未知图表类型 " + s.kind + "，已回退为 bar" });
    }
    var categories = isArr(s.categories) ? s.categories.map(String) : [];
    var rawSeries = isArr(s.series) ? s.series : [];
    var series = rawSeries.map(function (sr, idx) {
      var sObj = isObj(sr) ? sr : {};
      return {
        name: isStr(sObj.name) ? sObj.name : ("系列 " + (idx + 1)),
        data: isArr(sObj.data) ? sObj.data.map(toNum) : []
      };
    });
    if (!series.length) series = [{ name: "数值", data: categories.map(function () { return 0; }) }];
    return { kind: kind, categories: categories, series: series, unit: isStr(s.unit) ? s.unit : "" };
  }
  function toNum(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function emptyReport() {
    return validateAndFix({
      meta: { title: "新建报告" },
      sections: [
        { heading: "一、概述", blocks: [{ type: "text", content: "在此输入概述内容。" }] }
      ]
    }).normalized;
  }

  window.RF_Schema = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    CHART_KINDS: CHART_KINDS,
    validate: validateAndFix,
    empty: emptyReport,
    uid: uid
  };
})();

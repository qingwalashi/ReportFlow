/**
 * parser.js — natural language -> Report JSON.
 *
 * Flow:
 *   1) Build parse prompt (system + few-shot + user text).
 *   2) Call LLM with response_format json_object.
 *   3) Try JSON.parse on the result; strip ``` fences if present.
 *   4) On parse failure, run ONE repair-pass with the broken text + error.
 *   5) Run RF_Schema.validate() and surface non-fatal issues to the caller.
 *
 * Resolves with: { ok, report, errors, raw }
 */
(function () {
  "use strict";

  var bus    = window.RF_Bus;
  var state  = window.RF_State;
  var schema = window.RF_Schema;
  var log    = window.RF_Log;

  function parseJsonLoose(text) {
    if (text == null) return null;
    var s = String(text).trim();
    // Strip ``` fences if any
    if (s.startsWith("```")) {
      s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "");
    }
    // Some models prepend "Here is the JSON:" — keep just the first {...} block.
    var first = s.indexOf("{"), last = s.lastIndexOf("}");
    if (first > 0 && last > first) s = s.slice(first, last + 1);
    try { return JSON.parse(s); }
    catch (e) {
      var err = new Error("JSON.parse failed: " + e.message);
      err.raw = s; err.cause = e;
      throw err;
    }
  }

  function parse(text, opts) {
    opts = opts || {};
    var onProgress = typeof opts.onProgress === "function" ? opts.onProgress : function () {};
    if (!text || !text.trim()) {
      return Promise.reject(new Error("输入为空"));
    }
    state.set("ui.parsing", true);
    bus.emit("parser:start", { length: text.length });
    log.info("parser: start (" + text.length + " chars)");
    onProgress({ phase: "prompt", message: "构建提示…" });

    var messages = window.RF_Prompts.buildParsePrompt(text);

    onProgress({ phase: "request", message: "调用模型…" });
    return window.RF_LLM.complete({
      messages: messages,
      jsonMode: true,
      temperature: 0.2,
      stream: true,
      onDelta: function (ev) {
        // Forward each token delta so the UI can render a live transcript.
        onProgress({ phase: "stream", delta: ev.delta, kind: ev.kind, total: ev.total });
      }
    }).then(function (raw) {
      onProgress({ phase: "parse-json", message: "解析 JSON…", rawLength: (raw || "").length });
      try {
        return { obj: parseJsonLoose(raw), raw: raw };
      } catch (firstErr) {
        log.warn("parser: first JSON parse failed, attempting repair");
        onProgress({ phase: "repair", message: "JSON 修复中…" });
        var repairMessages = window.RF_Prompts.buildRepairPrompt(firstErr.raw || raw, firstErr.message);
        return window.RF_LLM.complete({
          messages: repairMessages,
          jsonMode: true,
          temperature: 0.0,
          stream: true,
          onDelta: function (ev) {
            onProgress({ phase: "stream", delta: ev.delta, kind: ev.kind, total: ev.total, repair: true });
          }
        }).then(function (raw2) {
          return { obj: parseJsonLoose(raw2), raw: raw2 };
        });
      }
    }).then(function (out) {
      onProgress({ phase: "validate", message: "校验结构…" });
      var v = schema.validate(out.obj);
      bus.emit("parser:done", { errors: v.errors });
      log.info("parser: done, " + v.normalized.sections.length + " sections, " + v.errors.length + " warnings");
      state.set("ui.parsing", false);
      onProgress({ phase: "done", sections: v.normalized.sections.length, warnings: v.errors.length });
      return { ok: true, report: v.normalized, errors: v.errors, raw: out.raw };
    }).catch(function (err) {
      state.set("ui.parsing", false);
      log.error("parser: " + (err && err.message || err));
      bus.emit("parser:error", err);
      onProgress({ phase: "error", message: err && err.message || String(err) });
      throw err;
    });
  }

  window.RF_Parser = { parse: parse };
})();

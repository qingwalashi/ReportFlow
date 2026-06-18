/**
 * logger.js — operation log (ring buffer in memory + persisted tail).
 *
 * Each entry: { ts, level, tag, msg, meta }
 *  level ∈ "info" | "warn" | "error"
 *
 * The log persists to localStorage `logs:tail` (last MAX_TAIL entries only).
 */
(function () {
  "use strict";

  var MAX_RING = 1000;   // in-memory cap
  var MAX_TAIL = 200;    // persisted cap
  var FLUSH_DEBOUNCE = 600;

  var ring = [];
  var flushTimer = null;
  var storage = window.RF_Storage;
  var bus = window.RF_Bus;

  // Restore tail from previous session so 历史日志 doesn't appear empty after reload.
  try {
    var prior = storage.get("logs", "tail", []);
    if (Array.isArray(prior)) ring = prior.slice(-MAX_RING);
  } catch (e) { /* noop */ }

  function record(level, tag, msg, meta) {
    var entry = {
      ts: Date.now(),
      level: level,
      tag: tag || "app",
      msg: String(msg == null ? "" : msg),
      meta: meta || null
    };
    ring.push(entry);
    if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING);
    bus.emit("log:append", entry);
    scheduleFlush();
    // Also mirror to console for devs.
    var consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleFn("[" + tag + "]", msg, meta || "");
    return entry;
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      try {
        storage.set("logs", "tail", ring.slice(-MAX_TAIL));
      } catch (err) { /* quota — silently drop log persistence */ }
    }, FLUSH_DEBOUNCE);
  }

  function info(msg, meta)  { return record("info",  pickTag(msg), strip(msg), meta); }
  function warn(msg, meta)  { return record("warn",  pickTag(msg), strip(msg), meta); }
  function error(msg, meta) { return record("error", pickTag(msg), strip(msg), meta); }

  // Optional convention: messages prefixed "tag: ..." use that tag.
  function pickTag(s) {
    if (typeof s !== "string") return "app";
    var m = s.match(/^([a-zA-Z][\w-]{1,20}):/);
    return m ? m[1] : "app";
  }
  function strip(s) {
    if (typeof s !== "string") return s;
    return s.replace(/^[a-zA-Z][\w-]{1,20}:\s*/, "");
  }

  function all() { return ring.slice(); }
  function clear() {
    ring = [];
    try { storage.del("logs", "tail"); } catch (e) {}
    bus.emit("log:cleared", null);
  }

  window.RF_Log = {
    info: info, warn: warn, error: error,
    all: all, clear: clear
  };
})();

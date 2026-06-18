/**
 * state.js — single source of truth for app-wide reactive state.
 *
 * Keys (so consumers can spell them right):
 *   "report"       -> current Report JSON (the editor + preview both bind to this)
 *   "templateId"   -> active template id
 *   "config.llm"   -> LLM config object
 *   "ui.parsing"   -> bool, true while LLM parse is in flight
 *
 * Emits "state:<key>" via RF_Bus on every set, with payload = { value, prev }.
 */
(function () {
  "use strict";

  var bus = window.RF_Bus;
  var data = Object.create(null);

  function get(key) { return data[key]; }

  function set(key, value) {
    var prev = data[key];
    if (prev === value) return;
    data[key] = value;
    bus.emit("state:" + key, { value: value, prev: prev });
    bus.emit("state:any", { key: key, value: value, prev: prev });
  }

  /** patch shallow-merges a partial object into an existing object value. */
  function patch(key, partial) {
    var cur = data[key] || {};
    var next = Object.assign({}, cur, partial);
    set(key, next);
  }

  function snapshot() {
    // Shallow clone — adequate for small top-level state.
    return Object.assign({}, data);
  }

  window.RF_State = { get: get, set: set, patch: patch, snapshot: snapshot };
})();

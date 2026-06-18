/**
 * event-bus.js — global pub/sub. No dependencies.
 *
 * Usage:
 *   bus.on("report:changed", fn)   -> returns unsubscribe()
 *   bus.once("config:saved", fn)
 *   bus.emit("report:changed", payload)
 */
(function () {
  "use strict";

  var listeners = Object.create(null);

  function on(evt, fn) {
    if (typeof fn !== "function") return function () {};
    (listeners[evt] || (listeners[evt] = [])).push(fn);
    return function off() {
      var arr = listeners[evt];
      if (!arr) return;
      var i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    };
  }

  function once(evt, fn) {
    var off = on(evt, function (payload) {
      try { fn(payload); } finally { off(); }
    });
    return off;
  }

  function emit(evt, payload) {
    var arr = listeners[evt];
    if (!arr || !arr.length) return;
    // Snapshot so a handler can off() during iteration safely.
    arr.slice().forEach(function (fn) {
      try { fn(payload); }
      catch (err) { console.error("[bus] handler error for", evt, err); }
    });
  }

  function clear(evt) {
    if (evt) delete listeners[evt];
    else listeners = Object.create(null);
  }

  window.RF_Bus = { on: on, once: once, emit: emit, clear: clear };
})();

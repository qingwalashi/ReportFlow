/**
 * storage.js — typed wrapper around localStorage with a versioned namespace.
 *
 * All keys live under "rf:v1:<ns>:<key>". Serializes JSON. On QuotaExceededError
 * emits "storage:quota" so the UI can offer cleanup; the failing setItem still
 * throws so callers can react.
 *
 * APIs:
 *   storage.get(ns, key, fallback?)
 *   storage.set(ns, key, value)
 *   storage.del(ns, key)
 *   storage.list(ns)        -> [{key, sizeBytes}]
 *   storage.usage()         -> {totalBytes, byNamespace}
 *   storage.clearNs(ns)
 *   storage.clearAll()
 */
(function () {
  "use strict";

  var ROOT = "rf:v1:";
  var bus = window.RF_Bus;

  function fullKey(ns, key) { return ROOT + ns + ":" + key; }

  function get(ns, key, fallback) {
    try {
      var raw = localStorage.getItem(fullKey(ns, key));
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      console.warn("[storage] get failed", ns, key, err);
      return fallback;
    }
  }

  function set(ns, key, value) {
    var raw;
    try { raw = JSON.stringify(value); }
    catch (err) {
      console.error("[storage] cannot stringify", ns, key, err);
      throw err;
    }
    try {
      localStorage.setItem(fullKey(ns, key), raw);
      return true;
    } catch (err) {
      // Most browsers throw QuotaExceededError; some throw NS_ERROR_DOM_QUOTA_REACHED.
      var isQuota =
        err && (err.name === "QuotaExceededError" ||
                err.code === 22 || err.code === 1014);
      if (isQuota) {
        bus.emit("storage:quota", {
          attemptedKey: fullKey(ns, key),
          attemptedSize: raw.length
        });
      }
      throw err;
    }
  }

  function del(ns, key) {
    try { localStorage.removeItem(fullKey(ns, key)); } catch (e) {}
  }

  function list(ns) {
    var prefix = ROOT + (ns ? ns + ":" : "");
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(prefix) === 0) {
        var v = localStorage.getItem(k) || "";
        out.push({ key: k, sizeBytes: v.length });
      }
    }
    return out.sort(function (a, b) { return b.sizeBytes - a.sizeBytes; });
  }

  function usage() {
    var byNs = {};
    var total = 0;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf(ROOT) !== 0) continue;
      var v = localStorage.getItem(k) || "";
      var size = v.length + k.length; // rough char count
      total += size;
      var rest = k.slice(ROOT.length);
      var ns = rest.split(":")[0];
      byNs[ns] = (byNs[ns] || 0) + size;
    }
    return { totalBytes: total, byNamespace: byNs };
  }

  function clearNs(ns) {
    list(ns).forEach(function (entry) {
      try { localStorage.removeItem(entry.key); } catch (e) {}
    });
  }

  function clearAll() {
    list("").forEach(function (entry) {
      try { localStorage.removeItem(entry.key); } catch (e) {}
    });
  }

  window.RF_Storage = {
    get: get, set: set, del: del,
    list: list, usage: usage,
    clearNs: clearNs, clearAll: clearAll,
    ROOT: ROOT
  };
})();

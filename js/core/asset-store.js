/**
 * asset-store.js — IndexedDB-backed Blob store for images.
 *
 * One database "rf-assets", one object store "images" keyed by assetId.
 * Each record: { id, blob, name, type, size, createdAt }
 *
 * Public API (all return Promises):
 *   assetStore.put(blob, meta?)   -> {id, ...record}
 *   assetStore.get(id)            -> record | null
 *   assetStore.url(id)            -> object URL (cached)
 *   assetStore.del(id)
 *   assetStore.list()             -> records[]
 *   assetStore.usageBytes()       -> rough byte count
 *   assetStore.revokeAll()        -> revoke any object URLs created via url()
 *
 * Note: asset IDs are time-ordered + random for uniqueness without crypto deps.
 */
(function () {
  "use strict";

  var DB_NAME = "rf-assets";
  var STORE   = "images";
  var DB_VERSION = 1;

  var dbPromise = null;
  var urlCache = Object.create(null);

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror   = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(mode) {
    return open().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  function genId() {
    // img-<base36 timestamp>-<base36 random>
    var t = Date.now().toString(36);
    var r = Math.floor(Math.random() * 1e9).toString(36);
    return "img-" + t + "-" + r;
  }

  function put(blob, meta) {
    if (!(blob instanceof Blob)) {
      return Promise.reject(new Error("asset-store.put expects a Blob"));
    }
    var record = {
      id: (meta && meta.id) || genId(),
      blob: blob,
      name: (meta && meta.name) || "image",
      type: blob.type || "application/octet-stream",
      size: blob.size,
      createdAt: Date.now()
    };
    return tx("readwrite").then(function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.put(record);
        req.onsuccess = function () { resolve(record); };
        req.onerror   = function () { reject(req.error); };
      });
    });
  }

  function get(id) {
    return tx("readonly").then(function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror   = function () { reject(req.error); };
      });
    });
  }

  function url(id) {
    if (urlCache[id]) return Promise.resolve(urlCache[id]);
    return get(id).then(function (rec) {
      if (!rec) return null;
      var u = URL.createObjectURL(rec.blob);
      urlCache[id] = u;
      return u;
    });
  }

  function del(id) {
    if (urlCache[id]) {
      try { URL.revokeObjectURL(urlCache[id]); } catch (e) {}
      delete urlCache[id];
    }
    return tx("readwrite").then(function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.delete(id);
        req.onsuccess = function () { resolve(true); };
        req.onerror   = function () { reject(req.error); };
      });
    });
  }

  function list() {
    return tx("readonly").then(function (store) {
      return new Promise(function (resolve, reject) {
        var req = store.getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror   = function () { reject(req.error); };
      });
    });
  }

  function usageBytes() {
    return list().then(function (records) {
      return records.reduce(function (s, r) { return s + (r.size || 0); }, 0);
    });
  }

  function revokeAll() {
    Object.keys(urlCache).forEach(function (k) {
      try { URL.revokeObjectURL(urlCache[k]); } catch (e) {}
      delete urlCache[k];
    });
  }

  window.RF_Assets = {
    put: put, get: get, url: url, del: del,
    list: list, usageBytes: usageBytes, revokeAll: revokeAll
  };
})();

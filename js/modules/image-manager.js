/**
 * image-manager.js — bridge between report blocks (assetId) and IndexedDB Blobs.
 *
 *   imageManager.upload(file)       -> {id, name, type, size}
 *   imageManager.previewUrl(assetId) -> string|null  (cached object URL)
 *   imageManager.remove(assetId)
 *   imageManager.toBlob(assetId)    -> Blob|null    (for export packaging)
 *
 * For images with a remote `src` (no assetId), previewUrl returns the src
 * directly; export will keep it as-is and warn the user.
 */
(function () {
  "use strict";

  var assets = window.RF_Assets;
  var log = window.RF_Log;

  function upload(file) {
    return assets.put(file, { name: file.name, type: file.type })
      .then(function (rec) {
        log.info("image: uploaded " + rec.id + " (" + rec.size + "B, " + rec.type + ")");
        return { id: rec.id, name: rec.name, type: rec.type, size: rec.size };
      });
  }

  function previewUrl(assetId) { return assets.url(assetId); }

  function remove(assetId) { return assets.del(assetId); }

  function toBlob(assetId) {
    return assets.get(assetId).then(function (rec) { return rec ? rec.blob : null; });
  }

  function extOf(record) {
    var t = (record && record.type) || "";
    if (t.indexOf("png")  >= 0) return "png";
    if (t.indexOf("jpeg") >= 0 || t.indexOf("jpg") >= 0) return "jpg";
    if (t.indexOf("webp") >= 0) return "webp";
    if (t.indexOf("gif")  >= 0) return "gif";
    if (t.indexOf("svg")  >= 0) return "svg";
    return "bin";
  }

  window.RF_ImageManager = {
    upload: upload,
    previewUrl: previewUrl,
    remove: remove,
    toBlob: toBlob,
    record: function (id) { return assets.get(id); },
    extOf: extOf
  };
})();

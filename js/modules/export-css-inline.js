/**
 * export-css-inline.js — shared CSS helpers for the exporters.
 *
 * Two jobs:
 *   1) collectCssText(doc)       — concatenate every <style> + reachable
 *      stylesheet from the preview iframe (base + template CSS). Relative
 *      url(...) references are resolved to ABSOLUTE here, against each
 *      stylesheet's own href (NOT the main page) — a template's
 *      `background-image: url("header.jpg")` lives in
 *      templates/<id>/style.css, so "header.jpg" must resolve next to that
 *      file, not next to index.html.
 *   2) inlineCssUrls(cssText)    — fetch every absolute url(...) target and
 *      rewrite it to a data: URL so the exported HTML/PDF/PNG is fully
 *      self-contained and survives being moved off the dev server.
 *
 * Why per-sheet resolution matters: when CSS is gathered via cssRules.cssText,
 * some browsers leave url() relative. If we then resolve against the main
 * document base we get the wrong path (e.g. /header.jpg instead of
 * /templates/supercomputing/header.jpg) and the fetch 404s. Resolving against
 * sheet.href at collection time is the only place we still know the real base.
 *
 * Asset <img> tags are handled separately by each exporter (assetId ->
 * IndexedDB blob). This module only covers images referenced *from CSS*.
 */
(function () {
  "use strict";

  var URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

  // Rewrite every relative url(...) in `cssText` to an absolute URL against
  // `baseHref`. data:, #fragment and already-absolute URLs are left alone.
  function absolutizeUrls(cssText, baseHref) {
    if (!cssText || !baseHref) return cssText;
    return cssText.replace(URL_RE, function (whole, quote, href) {
      var raw = (href || "").trim();
      if (!raw) return whole;
      if (/^(data:|#|https?:|blob:)/i.test(raw)) return whole;
      try {
        var abs = new URL(raw, baseHref).href;
        return 'url("' + abs + '")';
      } catch (e) {
        return whole;
      }
    });
  }

  function collectCssText(doc) {
    var out = [];
    var baseHref = doc.baseURI || (doc.defaultView && doc.defaultView.location.href);

    // Inline <style> tags — resolve relative urls against the document base.
    Array.prototype.forEach.call(doc.querySelectorAll("style"), function (s) {
      if (s.textContent) out.push(absolutizeUrls(s.textContent, baseHref));
    });

    // <link>/loaded stylesheets — resolve against each sheet's own href so a
    // template stylesheet's url() points back into its own folder.
    Array.prototype.forEach.call(doc.styleSheets, function (sheet) {
      try {
        var rules = sheet.cssRules;
        if (!rules) return;
        var buf = [];
        for (var i = 0; i < rules.length; i++) buf.push(rules[i].cssText);
        out.push(absolutizeUrls(buf.join("\n"), sheet.href || baseHref));
      } catch (e) {
        // Cross-origin stylesheet — skip silently.
      }
    });
    return out.join("\n\n");
  }

  // Pull out every url(...) target that we should try to inline.
  function extractUrls(cssText) {
    var seen = Object.create(null);
    var list = [];
    var m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(cssText)) !== null) {
      var raw = (m[2] || "").trim();
      if (!raw) continue;
      if (/^data:/i.test(raw)) continue;          // already inline
      if (/^#/.test(raw)) continue;               // svg fragment ref
      if (seen[raw]) continue;
      seen[raw] = true;
      list.push(raw);
    }
    return list;
  }

  // Map a file extension to an image MIME type. The dev-server proxy may serve
  // assets with a wrong/empty Content-Type, which would yield a data: URL like
  // `data:;base64,...` that html2canvas rejects ("Unsupported image type").
  // Deriving the MIME from the extension keeps the data: URL decodable.
  function mimeForUrl(url) {
    var ext = (String(url).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [])[1];
    switch ((ext || "").toLowerCase()) {
      case "jpg":
      case "jpeg": return "image/jpeg";
      case "png":  return "image/png";
      case "gif":  return "image/gif";
      case "webp": return "image/webp";
      case "svg":  return "image/svg+xml";
      case "avif": return "image/avif";
      case "bmp":  return "image/bmp";
      case "ico":  return "image/x-icon";
      default:     return "";
    }
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload  = function () {
        // strip the "data:...;base64," prefix, keep only the payload
        var s = String(r.result);
        var comma = s.indexOf(",");
        resolve(comma >= 0 ? s.slice(comma + 1) : s);
      };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  function fetchAsDataUrl(url) {
    return fetch(url).then(function (resp) {
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp.blob();
    }).then(function (blob) {
      // Prefer a real image MIME from the blob; otherwise derive from the
      // extension so a proxy's bad Content-Type can't break decoding.
      var mime = (/^image\//i.test(blob.type) ? blob.type : "") || mimeForUrl(url) || "application/octet-stream";
      return blobToBase64(blob).then(function (b64) {
        return "data:" + mime + ";base64," + b64;
      });
    });
  }

  function escapeForRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * inlineCssUrls(cssText) -> Promise<string>
   * Rewrites every fetchable url(...) to a data: URL. Expects absolute URLs
   * (collectCssText already absolutizes). Failures are left as-is so one
   * missing asset never breaks the whole export.
   */
  function inlineCssUrls(cssText) {
    if (!cssText) return Promise.resolve("");
    var urls = extractUrls(cssText);
    if (!urls.length) return Promise.resolve(cssText);

    return Promise.all(urls.map(function (u) {
      var abs;
      try { abs = new URL(u, document.baseURI).href; }
      catch (e) { abs = u; }
      return fetchAsDataUrl(abs).then(function (dataUrl) {
        if (window.RF_Log) {
          var head = String(dataUrl).slice(0, 40);
          window.RF_Log.info("[css-inline] ok " + u + " -> " + head +
            " (" + dataUrl.length + "B)");
        }
        return { from: u, to: dataUrl };
      }, function (err) {
        if (window.RF_Log) {
          window.RF_Log.warn("[css-inline] FAIL " + u + " : " + (err && err.message));
        }
        return null; // leave this url() untouched on failure
      });
    })).then(function (pairs) {
      var result = cssText;
      pairs.forEach(function (p) {
        if (!p) return;
        var inner = new RegExp(
          "url\\(\\s*(['\"]?)" + escapeForRegex(p.from) + "\\1\\s*\\)", "g");
        result = result.replace(inner, 'url("' + p.to + '")');
      });
      return result;
    });
  }

  window.RF_ExportCss = {
    collectCssText: collectCssText,
    inlineCssUrls: inlineCssUrls
  };
})();

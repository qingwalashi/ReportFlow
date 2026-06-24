/**
 * exporter-docx.js — export the report as a genuine, editable .docx file.
 *
 * Strategy (native OOXML, NOT an HTML-as-doc hack):
 *  Walk the report DATA MODEL (meta → sections → blocks) and emit
 *  WordprocessingML. JSZip (already vendored) packages the parts into a
 *  .docx. This yields an editable Word document with native headings,
 *  native tables (with merges / number formats / shading) and embedded
 *  chart + image raster images — at the cost of template CSS fidelity
 *  (intentional: Word can't honour arbitrary CSS, so a semantic mapping
 *  beats a pixel clone). Use `导出 PNG` for pixel-fidelity output.
 *
 * Block mapping:
 *   text(markdown) → marked.parse → DOM walker → Word runs/paragraphs
 *                    (headings, bold/italic/code, lists, quote, hr, links,
 *                     inline markdown tables)
 *   text(plain)    → one paragraph per blank-line block, \n → <w:br/>
 *   chart          → RF_Chart.toSvgString → rasterise to PNG@2x → inline image
 *   image          → fetch asset (or external src) → embed, normalise to PNG
 *   table          → <w:tbl> with gridSpan / vMerge merges, header shading,
 *                    per-cell format via RF_TableFormat.formatCell
 *
 * Helpers (collectCssText, blobToDataUrl, safeFileName, triggerDownload) are
 * duplicated from the other exporters intentionally — see exporter-html.js.
 */
(function () {
  "use strict";

  var state = window.RF_State;
  var log   = window.RF_Log;

  // 智能高亮 <mark> 与 **加粗** 相邻时会破坏 CommonMark 的定界符配对（漏出裸 **）。
  // 跑 marked 前先把 <mark> 标签换成私有区哨兵字符，渲染后再还原。详见 renderer-host.js。
  var HL_OPEN_TOKEN  = String.fromCharCode(0xE000);
  var HL_CLOSE_TOKEN = String.fromCharCode(0xE001);
  var HL_KIND = { num: "0", text: "1" };
  var HL_KIND_REV = { "0": "num", "1": "text" };
  // 高亮底色（与预览 .rf-hl--num/.rf-hl--text 保持一致）。
  var HL_FILL = { num: "FFF1A8", text: "C8F2D4" };

  function markedWithHl(text) {
    var s = String(text);
    if (!(window.marked && window.marked.parse)) {
      return "<p>" + escapeXml(s) + "</p>";
    }
    if (s.indexOf("<mark class=\"rf-hl") < 0) return window.marked.parse(s);
    var tmp = s
      .replace(/<mark class="rf-hl rf-hl--(num|text)">/g, function (_, kind) {
        return HL_OPEN_TOKEN + (HL_KIND[kind] || "0");
      })
      .replace(/<\/mark>/g, HL_CLOSE_TOKEN);
    return window.marked.parse(tmp)
      .replace(new RegExp(HL_OPEN_TOKEN + "([01])", "g"), function (_, k) {
        return '<mark class="rf-hl rf-hl--' + (HL_KIND_REV[k] || "num") + '">';
      })
      .replace(new RegExp(HL_CLOSE_TOKEN, "g"), "</mark>");
  }

  // Content width on an A4 portrait page with 1in margins ≈ 6.27in.
  // 1px@96dpi = 9525 EMU; 1in = 914400 EMU.
  var CONTENT_WIDTH_EMU = 5731510; // ≈ 602px
  var CHART_W = 720, CHART_H = 320;

  // Font sizes (half-points → pt = val/2) inlined into heading/title runs so
  // size is honoured regardless of how a reader resolves style inheritance.
  // Kept in sync with the <w:sz> values declared in STYLES_XML.
  var HEADING_SZ = {
    Title:    44, // 22pt
    Subtitle: 30, // 15pt
    Byline:   20, // 10pt (smaller than body 11pt for visual separation)
    Heading1: 36, // 18pt
    Heading2: 30, // 15pt
    Heading3: 26  // 13pt
  };

  // ====================================================================
  // Public entry
  // ====================================================================

  function exportDocx() {
    if (!window.JSZip) {
      window.RF_UI.toast.err("JSZip 未加载，无法导出 Word");
      return Promise.reject(new Error("JSZip missing"));
    }
    var report = state.get("report");
    if (!report) { window.RF_UI.toast.warn("没有可导出的内容"); return Promise.reject(new Error("empty")); }

    var tplTheme = window.RF_Chart.themeOf(state.get("templateId"));
    var ctx = newContext();
    log.info("export: docx start");

    return buildBody(report, ctx, tplTheme)
      .then(function (bodyXml) {
        var zip = new window.JSZip();
        zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
        zip.file("_rels/.rels", ROOT_RELS_XML);
        zip.file("word/document.xml", wrapDocumentXml(bodyXml));
        zip.file("word/styles.xml", STYLES_XML);
        zip.file("word/_rels/document.xml.rels", documentRelsXml(ctx));
        zip.file("docProps/core.xml", coreXml(report));
        ctx.media.forEach(function (m) { zip.file(m.path, m.blob); });
        return zip.generateAsync({
          type: "blob",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          compression: "DEFLATE",
          compressionOptions: { level: 6 }
        });
      })
      .then(function (blob) {
        triggerDownload(blob, safeFileName(report) + ".docx");
        window.RF_UI.toast.ok("已导出 Word");
        log.info("export: docx ok " + blob.size + "B");
      })
      .catch(function (err) {
        window.RF_UI.toast.err("Word 导出失败：" + (err && err.message));
        log.error("export: docx " + (err && err.message));
        throw err;
      });
  }

  function newContext() {
    return {
      rIdCounter: 0,   // rIds for word/_rels/document.xml.rels (images + hyperlinks)
      imageCount: 0,
      media: [],       // { path, blob }
      rels: [],        // { id, type, target, targetMode? }
      hyperlinks: {}   // url -> rId (dedupe)
    };
  }

  // ====================================================================
  // Body assembly — walks meta + sections + blocks (async for images/charts)
  // ====================================================================

  function buildBody(report, ctx, tplTheme) {
    var parts = [];
    var meta = report.meta || {};

    if (meta.title) {
      parts.push(makeParagraph(runXml(meta.title, { b: true, sz: HEADING_SZ.Title }), "Title"));
    }
    if (meta.subtitle) {
      parts.push(makeParagraph(runXml(meta.subtitle, { sz: HEADING_SZ.Subtitle }), "Subtitle"));
    }
    var bylineParts = [];
    if (meta.author) bylineParts.push(meta.author);
    if (meta.date) bylineParts.push(meta.date);
    if (bylineParts.length) {
      parts.push(makeParagraph(runXml(bylineParts.join(" · "), { sz: HEADING_SZ.Byline }), "Byline"));
    }
    if (meta.tags && meta.tags.length) {
      parts.push(makeParagraph(runXml("标签：" + meta.tags.join(" / "), {}), "Caption"));
    }

    // Note: no TOC field is emitted. Word's Navigation Pane (审阅/导航)
    // already lists every Heading1/2/3 via each style's <w:outlineLvl>,
    // so outline navigation works without an in-document table of contents.
    var sections = report.sections || [];
    var chain = Promise.resolve();
    sections.forEach(function (sec) {
      chain = chain.then(function () {
        if (sec.heading) {
          var lvl = Math.max(1, Math.min(3, sec.level || 1));
          var hsz = HEADING_SZ["Heading" + lvl];
          parts.push(makeParagraph(runXml(sec.heading, { sz: hsz }), "Heading" + lvl));
        }
        var bp = Promise.resolve();
        (sec.blocks || []).forEach(function (blk) {
          bp = bp.then(function () {
            return renderBlock(blk, ctx, tplTheme).then(function (xml) {
              if (xml) parts.push(xml);
            });
          });
        });
        return bp;
      });
    });
    return chain.then(function () { return parts.join(""); });
  }

  function renderBlock(blk, ctx, theme) {
    if (!blk || !blk.type) return Promise.resolve("");

    if (blk.type === "text") {
      var xml = blk.format === "plain"
        ? plainToParagraphs(blk.content)
        : markdownToParagraphs(blk.content, ctx);
      return Promise.resolve(xml);
    }

    if (blk.type === "table") {
      return Promise.resolve(tableBlockToXml(blk, ctx));
    }

    if (blk.type === "chart") {
      var cxml = "";
      if (blk.title) cxml += makeParagraph(runXml(blk.title, { b: true }), null, "center");
      var svg = "";
      try {
        svg = window.RF_Chart.toSvgString(blk.spec,
          Object.assign({ width: CHART_W, height: CHART_H, disableAnimation: true }, theme || {}));
      } catch (e) { log.warn("docx: chart svg failed " + e.message); }
      if (!svg) {
        cxml += makeParagraph(runXml("［图表渲染失败］", { i: true }), "Caption", "center");
        return Promise.resolve(cxml);
      }
      return svgToPngBlob(svg, CHART_W, CHART_H, 2)
        .then(function (blob) {
          cxml += addImage(ctx, blob, "png", CHART_W, CHART_H);
          return cxml;
        })
        .catch(function (e) {
          log.warn("docx: chart rasterise failed " + e.message);
          cxml += makeParagraph(runXml("［图表渲染失败］", { i: true }), "Caption", "center");
          return cxml;
        });
    }

    if (blk.type === "image") {
      var ixml = "";
      var loadPromise;
      if (blk.assetId) {
        loadPromise = window.RF_Assets.get(blk.assetId).then(function (rec) { return rec ? rec.blob : null; });
      } else if (blk.src) {
        loadPromise = fetch(blk.src)
          .then(function (r) { return r.ok ? r.blob() : null; })
          .catch(function () { return null; });
      } else {
        loadPromise = Promise.resolve(null);
      }
      return loadPromise.then(function (blob) {
        if (!blob) {
          return makeParagraph(runXml("［图片资源缺失］", { i: true }), "Caption", "center");
        }
        return normalizeImage(blob).then(function (d) {
          ixml += addImage(ctx, d.blob, d.ext, d.width, d.height);
          if (blk.caption) ixml += makeParagraph(runXml(blk.caption, {}), "Caption", "center");
          return ixml;
        });
      });
    }

    return Promise.resolve("");
  }

  // ====================================================================
  // Markdown → OOXML
  // ====================================================================

  function markdownToParagraphs(content, ctx) {
    if (!content) return "";
    var html;
    try {
      html = markedWithHl(content);
    } catch (e) {
      html = "<p>" + escapeXml(content) + "</p>";
    }
    var doc = new DOMParser().parseFromString("<div>" + html + "</div>", "text/html");
    var root = doc.body.firstChild;
    if (!root) return "";
    var out = [];
    walkBlock(root, ctx, out);
    return out.join("");
  }

  function walkBlock(node, ctx, out) {
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) {
        var t = collapseWs(n.nodeValue);
        if (t) out.push(makeParagraph(runXml(t, {}), null));
        continue;
      }
      if (n.nodeType !== 1) continue;
      var tag = n.tagName.toLowerCase();
      switch (tag) {
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
          var hlvl = Math.max(1, Math.min(3, parseInt(tag.slice(1), 10) || 1));
          var hsz2 = HEADING_SZ["Heading" + hlvl];
          var szRpr = '<w:sz w:val="' + hsz2 + '"/><w:szCs w:val="' + hsz2 + '"/>';
          out.push(makeParagraph(itemsToXml(inlineRuns(n, ctx, {}), ctx, szRpr), "Heading" + hlvl));
          break;
        case "p":
          out.push(makeParagraph(itemsToXml(inlineRuns(n, ctx, {}), ctx, ""), null));
          break;
        case "blockquote":
          out.push(makeParagraph(itemsToXml(inlineRuns(n, ctx, {}), ctx, ""), "Quote"));
          break;
        case "pre":
          out.push(makeCodeBlock(n.textContent));
          break;
        case "ul":
          walkList(n, ctx, out, false, 0);
          break;
        case "ol":
          walkList(n, ctx, out, true, 0);
          break;
        case "hr":
          out.push(makeHr());
          break;
        case "table":
          out.push(htmlTableToXml(n, ctx));
          break;
        case "br": break;
        default:
          out.push(makeParagraph(itemsToXml(inlineRuns(n, ctx, {}), ctx, ""), null));
      }
    }
  }

  function walkList(node, ctx, out, ordered, depth) {
    var lis = node.children;
    var idx = 1;
    var indent = "";
    for (var d = 0; d < depth; d++) indent += "    ";
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      if (!li || li.tagName.toLowerCase() !== "li") continue;
      var prefix = indent + (ordered ? (idx + ". ") : "• ");
      // Split inline content from nested lists.
      var inlineHolder = node.ownerDocument.createElement("span");
      var nested = [];
      for (var j = 0; j < li.childNodes.length; j++) {
        var ch = li.childNodes[j].cloneNode(true);
        var cn = (ch.nodeName || "").toLowerCase();
        if (cn === "ul" || cn === "ol") nested.push(ch);
        else inlineHolder.appendChild(ch);
      }
      var items = [{ t: "run", fmt: {}, text: prefix }].concat(inlineRuns(inlineHolder, ctx, {}));
      out.push(makeListParagraph(itemsToXml(items, ctx, "")));
      for (var k = 0; k < nested.length; k++) {
        walkList(nested[k], ctx, out, nested[k].tagName.toLowerCase() === "ol", depth + 1);
      }
      idx++;
    }
  }

  /** Returns an array of inline "items": {t:"run",fmt,text} | {t:"br"} | {t:"a",href,items} */
  function inlineRuns(node, ctx, fmt) {
    fmt = fmt || {};
    var items = [];
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (c.nodeType === 3) {
        var text = collapseWs(c.nodeValue);
        if (text) items.push({ t: "run", fmt: fmt, text: text });
      } else if (c.nodeType === 1) {
        var tag = c.tagName.toLowerCase();
        if (tag === "br") {
          items.push({ t: "br" });
        } else if (tag === "strong" || tag === "b") {
          items = items.concat(inlineRuns(c, ctx, mergeFmt(fmt, { b: true })));
        } else if (tag === "em" || tag === "i") {
          items = items.concat(inlineRuns(c, ctx, mergeFmt(fmt, { i: true })));
        } else if (tag === "del" || tag === "s" || tag === "strike") {
          items = items.concat(inlineRuns(c, ctx, mergeFmt(fmt, { strike: true })));
        } else if (tag === "code") {
          items = items.concat(inlineRuns(c, ctx, mergeFmt(fmt, { code: true })));
        } else if (tag === "mark") {
          var hlKind = /rf-hl--text/.test(c.className || "") ? "text" : "num";
          items = items.concat(inlineRuns(c, ctx, mergeFmt(fmt, { hl: hlKind })));
        } else if (tag === "a") {
          var href = c.getAttribute("href") || "";
          var sub = inlineRuns(c, ctx, fmt);
          items.push({ t: "a", href: href, items: sub });
        } else {
          // Unknown inline (span, img, etc.) — recurse transparently.
          items = items.concat(inlineRuns(c, ctx, fmt));
        }
      }
    }
    return items;
  }

  function itemsToXml(items, ctx, extraRPr) {
    var out = "";
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.t === "br") {
        out += "<w:br/>";
      } else if (it.t === "run") {
        out += runXml(it.text, it.fmt, extraRPr);
      } else if (it.t === "a") {
        var rid = ensureHyperlink(ctx, it.href);
        out += '<w:hyperlink r:id="' + rid + '">' +
          itemsToXml(it.items, ctx, '<w:rStyle w:val="Hyperlink"/>' + (extraRPr || "")) +
          "</w:hyperlink>";
      }
    }
    return out;
  }

  function plainToParagraphs(content) {
    var paras = String(content || "").split(/\n{2,}/);
    var out = "";
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i];
      if (!p.replace(/\s/g, "")) continue;
      out += makeParagraph(runXml(p.replace(/^\n+|\n+$/g, ""), {}), null);
    }
    return out;
  }

  function makeCodeBlock(text) {
    var lines = String(text || "").replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
    var out = "";
    for (var i = 0; i < lines.length; i++) {
      out += '<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr>' +
        runXml(lines[i], {}) + "</w:p>";
    }
    return out;
  }

  function makeHr() {
    return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>';
  }

  // ====================================================================
  // Table block → <w:tbl>
  // ====================================================================

  function tableBlockToXml(blk, ctx) {
    var out = "";
    if (blk.title) out += makeParagraph(runXml(blk.title, { b: true }), null);
    out += tableToXml(blk.spec || {}, ctx);
    var cap = [];
    if (blk.caption) cap.push(blk.caption);
    if (blk.spec && blk.spec.unit) cap.push("单位：" + blk.spec.unit);
    if (cap.length) out += makeParagraph(runXml(cap.join(" · "), {}), "Caption");
    return out;
  }

  function tableToXml(spec, ctx) {
    var columns = spec.columns || [];
    var rows = spec.rows || [];
    var headerRows = spec.headerRows || 1;
    var footerRows = spec.footerRows || 0;
    var merges = spec.merges || [];
    var nCols = columns.length;
    if (!nCols || !rows.length) return "";

    var total = 9000; // twips, ~6.25in
    var colWidths = columns.map(function (c) {
      return parseColWidth(c.width, total, nCols);
    });

    var xml = '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:jc w:val="center"/><w:tblBorders>' +
      borderXml("top") + borderXml("left") + borderXml("bottom") + borderXml("right") +
      borderXml("insideH") + borderXml("insideV") +
      '</w:tblBorders><w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid>';
    for (var g = 0; g < nCols; g++) xml += '<w:gridCol w:w="' + colWidths[g] + '"/>';
    xml += "</w:tblGrid>";

    // Synthetic header row from columns[].header (kept even if headerRows=0, since
    // columns usually carry the real headers; matches renderTableHtml in table-format.js).
    if (columns.some(function (c) { return c.header; })) {
      xml += '<w:tr><w:trPr><w:tblHeader/></w:trPr>';
      for (var c = 0; c < nCols; c++) {
        xml += renderHeaderCell(columns[c].header || "", colWidths[c], columns[c]);
      }
      xml += "</w:tr>";
    }

    // Extra multi-level header rows (rows[0 .. headerRows-2]) come from data.
    var headerExtra = Math.max(0, Math.min(headerRows - 1, rows.length));
    for (var r = 0; r < headerExtra; r++) {
      xml += renderTableRow(rows[r], columns, colWidths, merges, r, true, false);
    }

    var bodyEnd = Math.max(headerExtra, rows.length - footerRows);
    for (var r2 = headerExtra; r2 < bodyEnd; r2++) {
      xml += renderTableRow(rows[r2], columns, colWidths, merges, r2, false, false);
    }

    for (var r3 = bodyEnd; r3 < rows.length; r3++) {
      xml += renderTableRow(rows[r3], columns, colWidths, merges, r3, false, true);
    }

    xml += "</w:tbl>";
    return xml;
  }

  function renderTableRow(row, columns, colWidths, merges, rIdx, isHeader, isFooter) {
    var xml = "<w:tr>";
    if (isHeader) xml += '<w:trPr><w:tblHeader/></w:trPr>';
    var c = 0;
    var nCols = columns.length;
    while (c < nCols) {
      var cell = row[c];
      if (!cell) { c++; continue; }
      var master = findMasterAt(merges, rIdx, c);
      if (master) {
        xml += renderCell(cell, columns[c], colWidths[c], isHeader, isFooter,
          master.colspan, "restart");
        c += master.colspan;
      } else if (cell.hidden) {
        var cov = findCoveringMerge(merges, rIdx, c);
        if (cov && rIdx > cov.r && c === cov.c) {
          // Vertical-merge continue cell — empty, spans the master's columns.
          xml += renderCell(null, columns[c], colWidths[c], isHeader, isFooter,
            cov.colspan, "continue");
          c += cov.colspan;
        } else {
          c++; // horizontally spanned by a master to the left → skip
        }
      } else {
        xml += renderCell(cell, columns[c], colWidths[c], isHeader, isFooter, 1, null);
        c++;
      }
    }
    xml += "</w:tr>";
    return xml;
  }

  function renderHeaderCell(headerText, colWidth, col) {
    var jc = jcOf(null, col);
    var tcPr = '<w:tcPr><w:tcW w:w="' + colWidth + '" w:type="dxa"/><w:vAlign w:val="center"/>' +
      '<w:shd w:val="clear" w:color="auto" w:fill="F2F4F8"/></w:tcPr>';
    var para = makeCellPara(runXmlRpr(headerText, "<w:b/>"), jc);
    return "<w:tc>" + tcPr + para + "</w:tc>";
  }

  function renderCell(cell, col, colWidth, isHeader, isFooter, gridSpan, vMerge) {
    var tcPr = '<w:tcPr><w:tcW w:w="' + colWidth + '" w:type="dxa"/><w:vAlign w:val="center"/>';
    if (gridSpan > 1) tcPr += '<w:gridSpan w:val="' + gridSpan + '"/>';
    if (vMerge === "restart") tcPr += '<w:vMerge w:val="restart"/>';
    else if (vMerge === "continue") tcPr += "<w:vMerge/>";

    if (vMerge !== "continue") {
      var s = (cell && cell.style) || {};
      var fill = null;
      if (isHeader) fill = "F2F4F8";
      if (s.bg) fill = hexColor(s.bg);
      if (fill) tcPr += '<w:shd w:val="clear" w:color="auto" w:fill="' + fill + '"/>';
    }
    tcPr += "</w:tcPr>";

    if (vMerge === "continue") {
      return "<w:tc>" + tcPr + "<w:p/></w:tc>";
    }
    var displayed = window.RF_TableFormat
      ? window.RF_TableFormat.formatCell(cell.v, cell.format || (col && col.format))
      : String(cell.v == null ? "" : cell.v);
    var jc = jcOf(cell, col);
    var rPr = "";
    if (isHeader || isFooter || (cell.style && cell.style.bold)) rPr += "<w:b/>";
    if (cell.style && cell.style.italic) rPr += "<w:i/>";
    if (cell.style && cell.style.strike) rPr += "<w:strike/>";
    if (cell.style && cell.style.color) rPr += '<w:color w:val="' + hexColor(cell.style.color) + '"/>';
    var para = makeCellPara(runXmlRpr(displayed, rPr), jc);
    return "<w:tc>" + tcPr + para + "</w:tc>";
  }

  /** Build a compact cell paragraph from already-assembled inner run XML. */
  function makeCellPara(innerXml, jc) {
    var pPr = '<w:pPr>' + (jc ? '<w:jc w:val="' + jc + '"/>' : '') +
      '<w:spacing w:before="20" w:after="20" w:line="240" w:lineRule="auto"/></w:pPr>';
    return '<w:p>' + pPr + (innerXml || "") + '</w:p>';
  }

  /** Build a <w:r> from plain text + a raw rPr fragment (e.g. "<w:b/>"). */
  function runXmlRpr(text, rPrStr) {
    var rPrTag = rPrStr ? '<w:rPr>' + rPrStr + '</w:rPr>' : '';
    var parts = String(text == null ? "" : text).split("\n");
    var body = "";
    for (var i = 0; i < parts.length; i++) {
      if (i > 0) body += '<w:br/>';
      body += '<w:t xml:space="preserve">' + escapeXml(parts[i]) + '</w:t>';
    }
    return '<w:r>' + rPrTag + body + '</w:r>';
  }

  function borderXml(edge) {
    return '<w:' + edge + ' w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>';
  }

  function jcOf(cell, col) {
    var align = (cell && cell.style && cell.style.align) || (col && col.align) || "left";
    return (align === "center" || align === "right") ? align : "left";
  }

  function findMasterAt(merges, r, c) {
    for (var i = 0; i < merges.length; i++) {
      var m = merges[i];
      if (m.r === r && m.c === c) return m;
    }
    return null;
  }
  function findCoveringMerge(merges, r, c) {
    for (var i = 0; i < merges.length; i++) {
      var m = merges[i];
      if (r >= m.r && r < m.r + m.rowspan && c >= m.c && c < m.c + m.colspan) {
        if (r === m.r && c === m.c) continue;
        return m;
      }
    }
    return null;
  }

  /** Markdown <table> (GFM) → simple Word table. */
  function htmlTableToXml(tableEl, ctx) {
    var trs = tableEl.querySelectorAll("tr");
    if (!trs.length) return "";
    var nCols = trs[0].querySelectorAll("th,td").length || 1;
    var colW = Math.floor(9000 / nCols);
    var xml = '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:jc w:val="center"/><w:tblBorders>' +
      borderXml("top") + borderXml("left") + borderXml("bottom") + borderXml("right") +
      borderXml("insideH") + borderXml("insideV") +
      '</w:tblBorders><w:tblLook w:val="04A0"/></w:tblPr><w:tblGrid>';
    for (var g = 0; g < nCols; g++) xml += '<w:gridCol w:w="' + colW + '"/>';
    xml += "</w:tblGrid>";
    for (var r = 0; r < trs.length; r++) {
      var cells = trs[r].querySelectorAll("th,td");
      var isHead = trs[r].parentElement && trs[r].parentElement.tagName.toLowerCase() === "thead";
      xml += "<w:tr>";
      if (isHead) xml += '<w:trPr><w:tblHeader/></w:trPr>';
      for (var c = 0; c < cells.length; c++) {
        var th = cells[c].tagName.toLowerCase() === "th";
        var shd = (isHead || th) ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F4F8"/>' : "";
        var fmt = (isHead || th) ? { b: true } : {};
        var items = inlineRuns(cells[c], ctx, fmt);
        xml += "<w:tc><w:tcPr><w:tcW w:w=\"" + colW + "\" w:type=\"dxa\"/><w:vAlign w:val=\"center\"/>" + shd + "</w:tcPr>" +
          makeCellPara(itemsToXml(items, ctx, ""), "left") + "</w:tc>";
      }
      xml += "</w:tr>";
    }
    xml += "</w:tbl>";
    return xml;
  }

  // ====================================================================
  // Run / paragraph / image primitives
  // ====================================================================

  function runXml(text, fmt, extraRPr) {
    fmt = fmt || {};
    var rPr = "";
    if (fmt.b) rPr += "<w:b/>";
    if (fmt.i) rPr += "<w:i/>";
    if (fmt.strike) rPr += "<w:strike/>";
    if (fmt.sz) rPr += '<w:sz w:val="' + fmt.sz + '"/><w:szCs w:val="' + fmt.sz + '"/>';
    if (fmt.code) rPr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F4F8"/>';
    if (fmt.hl) rPr += '<w:shd w:val="clear" w:color="auto" w:fill="' + (HL_FILL[fmt.hl] || HL_FILL.num) + '"/>';
    if (fmt.color) rPr += '<w:color w:val="' + hexColor(fmt.color) + '"/>';
    if (extraRPr) rPr += extraRPr;
    var rPrTag = rPr ? "<w:rPr>" + rPr + "</w:rPr>" : "";
    var parts = String(text == null ? "" : text).split("\n");
    var body = "";
    for (var i = 0; i < parts.length; i++) {
      if (i > 0) body += "<w:br/>";
      body += '<w:t xml:space="preserve">' + escapeXml(parts[i]) + "</w:t>";
    }
    return "<w:r>" + rPrTag + body + "</w:r>";
  }

  function makeParagraph(innerXml, styleName, jc) {
    var parts = [];
    if (styleName) parts.push('<w:pStyle w:val="' + styleName + '"/>');
    if (jc) parts.push('<w:jc w:val="' + jc + '"/>');
    var pPr = parts.length ? "<w:pPr>" + parts.join("") + "</w:pPr>" : "";
    return "<w:p>" + pPr + (innerXml || "") + "</w:p>";
  }

  function makeListParagraph(innerXml) {
    var pPr = '<w:pPr><w:ind w:left="480" w:hanging="360"/></w:pPr>';
    return "<w:p>" + pPr + (innerXml || "") + "</w:p>";
  }

  function addImage(ctx, blob, ext, pxW, pxH) {
    ctx.imageCount++;
    var idx = ctx.imageCount;
    var rid = nextRid(ctx);
    var file = "image" + idx + "." + ext;
    ctx.media.push({ path: "word/media/" + file, blob: blob });
    ctx.rels.push({ id: rid, type: "image", target: "media/" + file });

    var emuW, emuH;
    if (pxW && pxH) {
      emuW = pxW * 9525;
      emuH = pxH * 9525;
      if (emuW > CONTENT_WIDTH_EMU) {
        var s = CONTENT_WIDTH_EMU / emuW;
        emuW = Math.round(emuW * s);
        emuH = Math.round(emuH * s);
      }
    } else {
      emuW = CONTENT_WIDTH_EMU;
      emuH = Math.round(CONTENT_WIDTH_EMU * 0.5);
    }
    return drawingXml(rid, emuW, emuH, "图 " + idx, idx);
  }

  function drawingXml(rid, emuW, emuH, name, id) {
    return [
      '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>',
      '<wp:inline distT="0" distB="0" distL="0" distR="0">',
      '<wp:extent cx="' + emuW + '" cy="' + emuH + '"/>',
      '<wp:effectExtent l="0" t="0" r="0" b="0"/>',
      '<wp:docPr id="' + id + '" name="' + escapeXml(name) + '"/>',
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>',
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">',
      '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + id + '" name="' + escapeXml(name) + '"/><pic:cNvPicPr/></pic:nvPicPr>',
      '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>',
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + emuW + '" cy="' + emuH + '"/></a:xfrm>',
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>',
      "</wp:inline></w:drawing></w:r></w:p>"
    ].join("");
  }

  function ensureHyperlink(ctx, href) {
    if (!href) href = "";
    if (ctx.hyperlinks[href]) return ctx.hyperlinks[href];
    var rid = nextRid(ctx);
    ctx.hyperlinks[href] = rid;
    ctx.rels.push({ id: rid, type: "hyperlink", target: href, targetMode: "External" });
    return rid;
  }

  function nextRid(ctx) { ctx.rIdCounter++; return "rId" + ctx.rIdCounter; }

  // ====================================================================
  // Image / chart rasterisation helpers
  // ====================================================================

  function svgToPngBlob(svgStr, w, h, scale) {
    scale = scale || 2;
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);
      img.onload = function () {
        try {
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          var g = canvas.getContext("2d");
          g.fillStyle = "#ffffff"; // white matte so transparent charts don't render black
          g.fillRect(0, 0, canvas.width, canvas.height);
          g.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error("toBlob null")); }, "image/png");
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error("svg image load failed")); };
      img.src = url;
    });
  }

  /** PNG/JPEG pass through; other formats rasterise to PNG. Resolves px size. */
  function normalizeImage(blob) {
    var type = (blob && blob.type) || "";
    if (type.indexOf("png") >= 0 || type.indexOf("jpeg") >= 0 || type.indexOf("jpg") >= 0) {
      var ext = type.indexOf("png") >= 0 ? "png" : "jpeg";
      return bitmapSize(blob).then(function (d) {
        return { blob: blob, ext: ext, width: d.width, height: d.height };
      });
    }
    return createBitmapSafe(blob).then(function (bmp) {
      var w = bmp.width, h = bmp.height;
      var canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (nb) {
          nb ? resolve({ blob: nb, ext: "png", width: w, height: h }) : reject(new Error("toBlob null"));
        }, "image/png");
      });
    });
  }

  function bitmapSize(blob) {
    return createBitmapSafe(blob).then(function (bmp) {
      var d = { width: bmp.width, height: bmp.height };
      if (bmp.close) bmp.close();
      return d;
    });
  }

  function createBitmapSafe(blob) {
    if (typeof createImageBitmap === "function") return createImageBitmap(blob);
    // Fallback for browsers without createImageBitmap: decode via <img>.
    return blobToDataUrl(blob).then(function (url) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error("image decode failed")); };
        img.src = url;
      });
    });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  // ====================================================================
  // OOXML part templates
  // ====================================================================

  function wrapDocumentXml(bodyXml) {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      "<w:body>" + (bodyXml || "") +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
      "</w:sectPr></w:body></w:document>";
  }

  function documentRelsXml(ctx) {
    var rows = ctx.rels.map(function (r) {
      var typeNs = r.type === "image"
        ? "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
        : "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
      var attrs = ' Id="' + r.id + '" Type="' + typeNs + '" Target="' + escapeXml(r.target) + '"';
      if (r.targetMode) attrs += ' TargetMode="' + r.targetMode + '"';
      return "<Relationship" + attrs + "/>";
    }).join("");
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rows + "</Relationships>";
  }

  function coreXml(report) {
    var meta = (report && report.meta) || {};
    var nowIso;
    try { nowIso = new Date().toISOString(); } catch (e) { nowIso = "2026-06-22T00:00:00Z"; }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      "<dc:title>" + escapeXml(meta.title || "") + "</dc:title>" +
      "<dc:creator>" + escapeXml(meta.author || "ReportFlow") + "</dc:creator>" +
      "<dc:subject>" + escapeXml(meta.subtitle || "") + "</dc:subject>" +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + nowIso + "</dcterms:created>" +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + nowIso + "</dcterms:modified>" +
      "</cp:coreProperties>";
  }

  var CONTENT_TYPES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Default Extension="jpg" ContentType="image/jpeg"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    "</Types>";

  var ROOT_RELS_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    "</Relationships>";

  // Style hierarchy (half-points: sz = pt × 2):
  //   Title 44(22pt) > Heading1 36(18pt) > Subtitle/Heading2 30(15pt)
  //   > Heading3 26(13pt) > Normal/Byline 22(11pt) > Caption/Code 20(10pt)
  // Headings carry <w:outlineLvl> so Word's TOC field collects them;
  // Normal/Title/Subtitle/Byline are pinned to level 9 (body text) so the
  // document title and byline never leak into a generated TOC.
  var STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑" w:cs="Calibri"/>' +
    '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
    '<w:color w:val="1A1F2C"/>' +
    '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>' +
    "</w:rPr></w:rPrDefault>" +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    // ---- Normal (正文 11pt) ----
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>' +
    // ---- Title (报告标题 22pt 加粗 居中) ----
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:uiPriority w:val="10"/>' +
    '<w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="240"/><w:outlineLvl w:val="9"/></w:pPr>' +
    '<w:rPr><w:b/><w:bCs/><w:spacing w:val="20"/><w:kern w:val="32"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>' +
    // ---- Subtitle (副标题 15pt 居中 中灰) ----
    '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:uiPriority w:val="9"/>' +
    '<w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/><w:outlineLvl w:val="9"/></w:pPr>' +
    '<w:rPr><w:color w:val="5A6B85"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>' +
    // ---- Byline (作者/日期 10pt 居中 浅灰，小于正文 11pt 以拉开区分) ----
    '<w:style w:type="paragraph" w:styleId="Byline"><w:name w:val="Byline"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
    '<w:pPr><w:jc w:val="center"/><w:spacing w:after="200"/><w:outlineLvl w:val="9"/></w:pPr>' +
    '<w:rPr><w:color w:val="8A93A3"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>' +
    // ---- Heading1 (一级标题 18pt 加粗 主色，进目录层级 1) ----
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:uiPriority w:val="9"/>' +
    '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr>' +
    '<w:rPr><w:b/><w:bCs/><w:color w:val="1F57B8"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>' +
    // ---- Heading2 (二级标题 15pt 加粗 主色，进目录层级 2) ----
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:uiPriority w:val="9"/>' +
    '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="280" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr>' +
    '<w:rPr><w:b/><w:bCs/><w:color w:val="1F57B8"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>' +
    // ---- Heading3 (三级标题 13pt 加粗 亮蓝，进目录层级 3) ----
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:uiPriority w:val="9"/>' +
    '<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="220" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr>' +
    '<w:rPr><w:b/><w:bCs/><w:color w:val="2D5CF6"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>' +
    // ---- Quote ----
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
    '<w:pPr><w:ind w:left="480"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="2D5CF6"/></w:pBdr><w:outlineLvl w:val="9"/></w:pPr>' +
    '<w:rPr><w:i/><w:color w:val="5A6B85"/></w:rPr></w:style>' +
    // ---- Code (等宽 10pt 灰底) ----
    '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' +
    '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F4F8"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>' +
    // ---- Caption (图表说明 10pt 居中 斜体 浅灰) ----
    '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/><w:outlineLvl w:val="9"/></w:pPr>' +
    '<w:rPr><w:i/><w:color w:val="8A93A3"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>' +
    // ---- Hyperlink (字符样式) ----
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
    '<w:rPr><w:color w:val="2D5CF6"/><w:u w:val="single"/></w:rPr></w:style>' +
    "</w:styles>";

  // ====================================================================
  // Misc helpers
  // ====================================================================

  function parseColWidth(w, total, n) {
    if (!w || w === "auto") return Math.floor(total / n);
    var m = /^(\d+(?:\.\d+)?)px$/.exec(w);
    if (m) return Math.round(parseFloat(m[1]) * 15); // 1px = 15 twips
    m = /^(\d+(?:\.\d+)?)%$/.exec(w);
    if (m) return Math.round(parseFloat(m[1]) / 100 * total);
    return Math.floor(total / n);
  }

  function mergeFmt(base, patch) {
    return Object.assign({}, base, patch);
  }

  function collapseWs(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ");
  }

  function hexColor(s) {
    var v = String(s || "").replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(v)) v = v.replace(/(.)/g, "$1$1");
    if (/^[0-9a-fA-F]{6}$/.test(v) || /^[0-9a-fA-F]{8}$/.test(v)) return v.toUpperCase();
    return "000000";
  }

  function escapeXml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c];
    });
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function safeFileName(report) {
    var base = (report.meta && report.meta.title) || "reportflow-report";
    return String(base).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-").slice(0, 60) || "report";
  }

  window.RF_ExportDocx = { exportDocx: exportDocx };
})();

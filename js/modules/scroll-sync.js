/**
 * scroll-sync.js — bidirectional scroll synchronization between the
 * structured editor pane (.rf-edit-scroll) and the preview iframe.
 *
 * Strategy
 *  - Granularity: section. report.sections is an ordered array; both
 *    sides render in the same order, so the i-th .rf-sec on the left
 *    corresponds to the i-th #root > section.rf-section on the right.
 *  - Active section: the one with the largest visible-area intersection
 *    with the source side's scroll viewport. Robust at boundaries where
 *    plain "first visible" judgement would flip-flop.
 *  - Alignment: target section's top edge to the destination's scroll
 *    container top.
 *  - Throttle: rAF (one update per frame max).
 *  - Anti-loop: when we programmatically scroll side B, we set
 *    lockSide=B and release after 150ms. Scroll events on B during the
 *    lock window are ignored.
 *  - Suppression: if an INPUT/TEXTAREA inside .rf-edit-scroll has focus,
 *    do NOT propagate editor-side scrolls (avoids IME / focus-induced
 *    jitter from disturbing the preview).
 *
 * Preview scroll container: the iframe element itself has a small fixed
 * height (it does NOT grow with its content), so the iframe's INNER
 * <html> is what scrolls — confirmed by runtime inspection: outer wrap
 * scrollHeight≈clientHeight (not scrollable), iframe.contentDocument's
 * scrollingElement.scrollHeight ≫ clientHeight (the real scroll host).
 *
 * IMPORTANT: srcdoc iframes replace contentDocument when their srcdoc
 * is set; a listener bound during preview.js's initial assignment may
 * be attached to a transient document and lost when the real document
 * loads. We must re-bind on every preview:rendered event, comparing
 * the current contentDocument identity to the last bound one.
 *
 * Wired in bootstrap.js after RF_Preview.init().
 */
(function () {
  "use strict";

  var bus = window.RF_Bus;

  var EDIT_SCROLL_SEL = ".rf-edit-scroll";
  var EDIT_SECTION_SEL = ".rf-sec";
  var PREVIEW_SECTION_SEL = "#root > section.rf-section";
  var IFRAME_ID = "rf-preview-frame";
  var LOCK_MS = 150;

  // "editor" | "preview" | null
  var lockSide = null;
  var lockTimer = null;
  var rafPending = false;

  // The contentDocument we currently have a scroll listener on. When
  // the iframe srcdoc reloads, contentDocument is replaced; we detect
  // identity change and rebind.
  var boundDoc = null;

  function init() {
    var editScroll = document.querySelector(EDIT_SCROLL_SEL);
    if (!editScroll) return;
    editScroll.addEventListener("scroll", onEditorScroll, { passive: true });

    bus.on("preview:rendered", bindPreviewIfNeeded);
    bindPreviewIfNeeded();
  }

  function bindPreviewIfNeeded() {
    var iframe = document.getElementById(IFRAME_ID);
    if (!iframe) return;
    var doc = iframe.contentDocument;
    if (!doc || doc === boundDoc) return;
    // New (or replaced) document — bind here. The previous listener,
    // if any, is gone with the previous document; no explicit removal
    // needed.
    boundDoc = doc;
    doc.addEventListener("scroll", onPreviewScroll, { passive: true });
  }

  function onEditorScroll() {
    if (lockSide === "editor") return;
    if (editorHasFocusedInput()) return;
    schedule(function () { syncFrom("editor"); });
  }

  function onPreviewScroll() {
    if (lockSide === "preview") return;
    schedule(function () { syncFrom("preview"); });
  }

  function schedule(fn) {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      try { fn(); } catch (e) { /* swallow — never break user scrolling */ }
    });
  }

  function editorHasFocusedInput() {
    var ae = document.activeElement;
    if (!ae) return false;
    var tag = ae.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA") return false;
    var editScroll = document.querySelector(EDIT_SCROLL_SEL);
    return !!(editScroll && editScroll.contains(ae));
  }

  function syncFrom(side) {
    var src = getSide(side);
    var dst = getSide(side === "editor" ? "preview" : "editor");
    if (!src || !dst) return;
    if (!src.sections.length || !dst.sections.length) return;

    if (src.scrollEl.scrollHeight <= src.scrollEl.clientHeight + 1) return;

    var idx = activeSectionIndex(src);
    if (idx < 0) return;

    idx = Math.min(idx, dst.sections.length - 1);

    var targetTop = dst.sectionTops[idx];

    if (Math.abs(dst.scrollEl.scrollTop - targetTop) < 1) return;

    acquireLock(side === "editor" ? "preview" : "editor");
    dst.scrollEl.scrollTop = targetTop;
  }

  function acquireLock(which) {
    lockSide = which;
    if (lockTimer) clearTimeout(lockTimer);
    lockTimer = setTimeout(function () {
      lockSide = null;
      lockTimer = null;
    }, LOCK_MS);
  }

  /**
   * Return descriptor for one side, or null if not currently usable.
   *  scrollEl: the element whose scrollTop we read/write
   *  viewportTop / viewportBottom: scrollEl-relative viewport bounds
   *  sections: array of section elements (in order)
   *  sectionTops: array of section top offsets, in scrollEl coordinates
   */
  function getSide(which) {
    if (which === "editor") {
      var es = document.querySelector(EDIT_SCROLL_SEL);
      if (!es) return null;
      var secs = Array.prototype.slice.call(es.querySelectorAll(EDIT_SECTION_SEL));
      var tops = secs.map(function (s) { return offsetTopWithin(s, es); });
      return {
        scrollEl: es,
        viewportTop: es.scrollTop,
        viewportBottom: es.scrollTop + es.clientHeight,
        sections: secs,
        sectionTops: tops
      };
    }
    // preview — scroll happens INSIDE the iframe document
    var iframe = document.getElementById(IFRAME_ID);
    if (!iframe || !iframe.contentDocument) return null;
    var doc = iframe.contentDocument;
    var scrollEl = doc.scrollingElement || doc.documentElement;
    if (!scrollEl) return null;
    var psecs = Array.prototype.slice.call(doc.querySelectorAll(PREVIEW_SECTION_SEL));
    // Sections live in the iframe document; their offsetTop chain
    // terminates at <body>/<html> inside the iframe — same coordinate
    // system as scrollEl.scrollTop.
    var ptops = psecs.map(function (s) { return offsetTopWithin(s, scrollEl); });
    return {
      scrollEl: scrollEl,
      viewportTop: scrollEl.scrollTop,
      viewportBottom: scrollEl.scrollTop + scrollEl.clientHeight,
      sections: psecs,
      sectionTops: ptops
    };
  }

  /**
   * Index of the section with the largest pixel-area overlap with the
   * source side's scroll viewport. Returns -1 if nothing overlaps.
   */
  function activeSectionIndex(side) {
    var vt = side.viewportTop, vb = side.viewportBottom;
    var bestIdx = -1, bestOverlap = -1;
    for (var i = 0; i < side.sections.length; i++) {
      var top = side.sectionTops[i];
      var bottom = top + side.sections[i].offsetHeight;
      var overlap = Math.min(bottom, vb) - Math.max(top, vt);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  /**
   * Sum offsetTop up the offsetParent chain until we reach (or just
   * past) scrollEl. Works inside both the editor pane and the iframe
   * document — in both cases, sections are descendants of scrollEl
   * and the chain terminates naturally.
   */
  function offsetTopWithin(el, scrollEl) {
    var top = 0;
    var node = el;
    while (node && node !== scrollEl) {
      top += node.offsetTop || 0;
      node = node.offsetParent;
      if (!node) break;
    }
    return top;
  }

  window.RF_ScrollSync = { init: init, acquireLock: acquireLock };
})();

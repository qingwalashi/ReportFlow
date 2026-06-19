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

  // Bound to the iframe's current contentWindow. Re-bound on every
  // preview:rendered event in case the iframe was reloaded (template
  // switch, srcdoc rewrite, etc).
  var boundPreviewWin = null;

  function init() {
    var editScroll = document.querySelector(EDIT_SCROLL_SEL);
    if (!editScroll) return;

    editScroll.addEventListener("scroll", onEditorScroll, { passive: true });

    // Preview iframe may not be ready at init time; bind on first render
    // and re-bind whenever the iframe gets a new contentWindow.
    bus.on("preview:rendered", bindPreviewIfNeeded);
    // Also try immediately in case preview was already rendered before
    // we ran (race with bootstrap order).
    bindPreviewIfNeeded();
  }

  function bindPreviewIfNeeded() {
    var iframe = document.getElementById(IFRAME_ID);
    if (!iframe || !iframe.contentWindow) return;
    var win = iframe.contentWindow;
    if (win === boundPreviewWin) return; // already bound to this window

    // Old window (if any) is gone with the previous iframe document; no
    // explicit removeEventListener needed.
    boundPreviewWin = win;
    win.addEventListener("scroll", onPreviewScroll, { passive: true });
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

    // Nothing to sync if the source can't scroll.
    if (src.scrollEl.scrollHeight <= src.scrollEl.clientHeight + 1) return;

    var idx = activeSectionIndex(src);
    if (idx < 0) return;

    // Clamp against destination's section count (transient mismatch
    // during preview's 150ms render debounce).
    idx = Math.min(idx, dst.sections.length - 1);

    var dstSec = dst.sections[idx];
    var targetTop = sectionOffsetTop(dstSec, dst.scrollEl);

    // Avoid pointless writes that would still trigger a scroll event
    // and consume a lock window.
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
   * Return descriptor for one side, or null if not currently mountable.
   *  scrollEl: the element whose scrollTop we read/write
   *  viewportTop / viewportBottom: scrollEl-relative viewport bounds
   *  sections: array of section elements (in order)
   */
  function getSide(which) {
    if (which === "editor") {
      var es = document.querySelector(EDIT_SCROLL_SEL);
      if (!es) return null;
      var secs = es.querySelectorAll(EDIT_SECTION_SEL);
      return {
        scrollEl: es,
        viewportTop: es.scrollTop,
        viewportBottom: es.scrollTop + es.clientHeight,
        sections: Array.prototype.slice.call(secs)
      };
    }
    // preview
    var iframe = document.getElementById(IFRAME_ID);
    if (!iframe || !iframe.contentDocument) return null;
    var doc = iframe.contentDocument;
    var scrollEl = doc.scrollingElement || doc.documentElement;
    if (!scrollEl) return null;
    var psecs = doc.querySelectorAll(PREVIEW_SECTION_SEL);
    return {
      scrollEl: scrollEl,
      viewportTop: scrollEl.scrollTop,
      viewportBottom: scrollEl.scrollTop + scrollEl.clientHeight,
      sections: Array.prototype.slice.call(psecs)
    };
  }

  /**
   * Index of the section with the largest pixel-area overlap with the
   * source side's scroll viewport. Returns -1 if nothing overlaps
   * (shouldn't happen given the scrollHeight check, but defensive).
   *
   * We use offsetTop/offsetHeight for stable, scroll-independent
   * geometry (getBoundingClientRect would also work but mixes in the
   * scrollEl's own client rect).
   */
  function activeSectionIndex(side) {
    var vt = side.viewportTop, vb = side.viewportBottom;
    var bestIdx = -1, bestOverlap = -1;
    for (var i = 0; i < side.sections.length; i++) {
      var sec = side.sections[i];
      var top = offsetTopWithin(sec, side.scrollEl);
      var bottom = top + sec.offsetHeight;
      var overlap = Math.min(bottom, vb) - Math.max(top, vt);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  /** Offset of a section relative to its scroll container. */
  function sectionOffsetTop(sec, scrollEl) {
    return offsetTopWithin(sec, scrollEl);
  }

  /**
   * Sum offsetTop up the offsetParent chain until we reach (or pass)
   * scrollEl. Works for both the editor pane and the iframe's
   * documentElement (where the chain terminates at body/html naturally).
   */
  function offsetTopWithin(el, scrollEl) {
    var top = 0;
    var node = el;
    while (node && node !== scrollEl) {
      top += node.offsetTop || 0;
      node = node.offsetParent;
      // Defensive: if offsetParent is null before we reach scrollEl
      // (e.g. element became display:none mid-iteration), bail with
      // what we have rather than loop forever.
      if (!node) break;
    }
    return top;
  }

  window.RF_ScrollSync = { init: init };
})();

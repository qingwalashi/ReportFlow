/**
 * block-highlight.js — bidirectional click-to-highlight between the
 * structured editor pane (.rf-blk) and the preview iframe (.rf-block).
 *
 * Click a block on either side → both sides mark the corresponding
 * block as selected, identified by (secIdx, blkIdx) which line up
 * with report.sections[i].blocks[j] on both sides naturally.
 *
 * Behaviour
 *  - Toggle: clicking the same block again clears the selection.
 *  - Switch: clicking a different block transfers the highlight.
 *  - Excludes interactive controls (input/textarea/button/select/a):
 *    those clicks pass through normally and don't affect selection.
 *  - If the corresponding block on the OTHER side is fully outside the
 *    viewport, scroll it into view. We acquire RF_ScrollSync's lock
 *    first so the resulting scroll event doesn't bounce back through
 *    section-grain sync.
 *  - Survives DOM rebuilds: re-applies on `editor:rendered` and
 *    `preview:rendered`. If the selected coords no longer exist
 *    (block was deleted), selection clears.
 *
 * Wired in bootstrap.js after RF_ScrollSync.init().
 */
(function () {
  "use strict";

  var bus = window.RF_Bus;

  var EDIT_ROOT_ID = "rf-editor-root";
  var EDIT_SEC_SEL = ".rf-sec";
  var EDIT_BLK_SEL = ".rf-blk";
  var EDIT_BLK_CLS = "rf-blk--selected";

  var IFRAME_ID = "rf-preview-frame";
  var PREV_SEC_SEL = "#root > section.rf-section";
  var PREV_BLK_SEL = ".rf-block";
  var PREV_BLK_CLS = "rf-block--selected";

  // Tags whose clicks should NOT trigger selection (editing/navigation).
  // closest() walks up from event.target, so this catches clicks on the
  // controls themselves and any inner spans they might have.
  var IGNORE_SEL = "input,textarea,button,select,a,label";

  // null when nothing selected.
  var selected = null;

  // Track the document we've bound the preview click listener to, so
  // we can rebind across srcdoc reloads (template switch, etc).
  var boundDoc = null;

  function init() {
    var editRoot = document.getElementById(EDIT_ROOT_ID);
    if (editRoot) {
      // Use capture so we see the click before any inner widget can
      // stop propagation. We still respect IGNORE_SEL via closest().
      editRoot.addEventListener("click", onEditorClick, true);
    }

    bus.on("editor:rendered", reapply);
    bus.on("preview:rendered", function () {
      bindPreviewIfNeeded();
      reapply();
    });
    bindPreviewIfNeeded();
  }

  function bindPreviewIfNeeded() {
    var iframe = document.getElementById(IFRAME_ID);
    if (!iframe) return;
    var doc = iframe.contentDocument;
    if (!doc || doc === boundDoc) return;
    boundDoc = doc;
    doc.addEventListener("click", onPreviewClick, true);
  }

  function onEditorClick(ev) {
    var t = ev.target;
    if (!t) return;
    if (t.closest && t.closest(IGNORE_SEL)) return;
    var blk = t.closest && t.closest(EDIT_BLK_SEL);
    if (!blk) {
      // Click landed somewhere inside #rf-editor-root but outside any
      // block (section header, "+ 文本" toolbar, gaps between blocks,
      // meta area). Treat as "deselect".
      clearSelection();
      return;
    }
    var coords = coordsForEditorBlock(blk);
    if (!coords) return;
    handleSelection(coords, "editor");
  }

  function onPreviewClick(ev) {
    var t = ev.target;
    if (!t) return;
    if (t.closest && t.closest(IGNORE_SEL)) return;
    var blk = t.closest && t.closest(PREV_BLK_SEL);
    if (!blk) {
      // Click landed somewhere in the iframe document but not on any
      // .rf-block (section heading, padding, body whitespace, etc).
      clearSelection();
      return;
    }
    var coords = coordsForPreviewBlock(blk);
    if (!coords) return;
    handleSelection(coords, "preview");
  }

  function clearSelection() {
    if (!selected) return;
    selected = null;
    applyHighlight(undefined);  // no auto-scroll on deselect
  }

  /**
   * Compute (secIdx, blkIdx) for an editor-side block.
   * Editor structure:
   *   #rf-editor-root
   *     > .rf-sec (META — also uses class rf-sec; has no .rf-blk inside)
   *     > .rf-sec (one per real section)
   *         > .rf-sec__head
   *         > .rf-sec__body
   *             > .rf-blk … .rf-blk           (the blocks we care about)
   *             > .rf-row                     (the "+ 文本" toolbar row, NOT a block)
   *
   * Because the meta div is also a .rf-sec but corresponds to no entry
   * in report.sections, we subtract 1 to get the section index that
   * lines up with the preview side (which doesn't render meta as a
   * section). META_OFFSET = 1.
   */
  var META_OFFSET = 1;

  function coordsForEditorBlock(blk) {
    var sec = blk.closest(EDIT_SEC_SEL);
    if (!sec) return null;
    var editRoot = document.getElementById(EDIT_ROOT_ID);
    if (!editRoot) return null;
    var allSecs = editRoot.querySelectorAll(EDIT_SEC_SEL);
    var rawIdx = indexOfNode(allSecs, sec);
    // rawIdx 0 = meta (unreachable in practice — meta has no .rf-blk
    // children — but be defensive).
    if (rawIdx < META_OFFSET) return null;
    var secIdx = rawIdx - META_OFFSET;
    // Within this section, find blk's index among .rf-blk siblings only.
    var blks = sec.querySelectorAll(EDIT_BLK_SEL);
    var blkIdx = indexOfNode(blks, blk);
    if (blkIdx < 0) return null;
    return { secIdx: secIdx, blkIdx: blkIdx };
  }

  function coordsForPreviewBlock(blk) {
    var iframe = document.getElementById(IFRAME_ID);
    if (!iframe || !iframe.contentDocument) return null;
    var doc = iframe.contentDocument;
    var sec = blk.closest("section.rf-section");
    if (!sec) return null;
    var allSecs = doc.querySelectorAll(PREV_SEC_SEL);
    var secIdx = indexOfNode(allSecs, sec);
    if (secIdx < 0) return null;
    var blks = sec.querySelectorAll(PREV_BLK_SEL);
    var blkIdx = indexOfNode(blks, blk);
    if (blkIdx < 0) return null;
    return { secIdx: secIdx, blkIdx: blkIdx };
  }

  function indexOfNode(list, node) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] === node) return i;
    }
    return -1;
  }

  /**
   * Apply (or toggle) a click. `originSide` tells us which side the
   * user clicked, so we know which side to potentially scroll the
   * counterpart into view on.
   */
  function handleSelection(coords, originSide) {
    if (selected
        && selected.secIdx === coords.secIdx
        && selected.blkIdx === coords.blkIdx) {
      // Same block clicked — toggle off.
      selected = null;
    } else {
      selected = coords;
    }
    applyHighlight(originSide);
  }

  /**
   * Re-apply the current `selected` to the DOM. Called on click and
   * on every editor:rendered / preview:rendered. Clears selection if
   * the block coords are now invalid (block was deleted).
   *
   * `originSide` is "editor" | "preview" | undefined. When defined,
   * scroll the OPPOSITE side's block into view if it's off-screen.
   * On rebuild events we don't auto-scroll (the user didn't click).
   */
  function applyHighlight(originSide) {
    // Always start clean — cheaper than tracking previous targets.
    clearAll();
    if (!selected) return;

    var editBlk = findEditorBlock(selected);
    var prevBlk = findPreviewBlock(selected);

    if (!editBlk && !prevBlk) {
      // Coords no longer point anywhere on either side — drop them.
      selected = null;
      return;
    }

    if (editBlk) editBlk.classList.add(EDIT_BLK_CLS);
    if (prevBlk) prevBlk.classList.add(PREV_BLK_CLS);

    if (originSide === "editor" && prevBlk) {
      scrollBlockToTopThird(prevBlk, "preview");
    } else if (originSide === "preview" && editBlk) {
      scrollBlockToTopThird(editBlk, "editor");
    }
  }

  function reapply() {
    applyHighlight(undefined);
  }

  function clearAll() {
    var prev = document.querySelectorAll("." + EDIT_BLK_CLS);
    for (var i = 0; i < prev.length; i++) prev[i].classList.remove(EDIT_BLK_CLS);
    var iframe = document.getElementById(IFRAME_ID);
    if (iframe && iframe.contentDocument) {
      var pPrev = iframe.contentDocument.querySelectorAll("." + PREV_BLK_CLS);
      for (var j = 0; j < pPrev.length; j++) pPrev[j].classList.remove(PREV_BLK_CLS);
    }
  }

  function findEditorBlock(coords) {
    var editRoot = document.getElementById(EDIT_ROOT_ID);
    if (!editRoot) return null;
    var sec = editRoot.querySelectorAll(EDIT_SEC_SEL)[coords.secIdx + META_OFFSET];
    if (!sec) return null;
    var blks = sec.querySelectorAll(EDIT_BLK_SEL);
    return blks[coords.blkIdx] || null;
  }

  function findPreviewBlock(coords) {
    var iframe = document.getElementById(IFRAME_ID);
    if (!iframe || !iframe.contentDocument) return null;
    var doc = iframe.contentDocument;
    var sec = doc.querySelectorAll(PREV_SEC_SEL)[coords.secIdx];
    if (!sec) return null;
    var blks = sec.querySelectorAll(PREV_BLK_SEL);
    return blks[coords.blkIdx] || null;
  }

  // ---------- scroll-into-view helpers ----------

  // Position the block's top this fraction of the way down the viewport
  // (0.3 → top sits ~30% from the viewport top → "centered, slightly
  // upward, with the block's top guaranteed visible"). Tall blocks
  // simply extend below the viewport from there; their top is still on
  // screen, which is what the user wants.
  var TOP_FRACTION = 0.3;

  /**
   * Scroll the destination so `el` lines up TOP_FRACTION down the
   * viewport. Always scrolls — no "already visible" short-circuit —
   * so each click re-anchors the destination.
   *
   *   side: "editor" | "preview" — which side `el` lives on. Used to
   *         (a) pick the right scroll container and (b) acquire
   *         scroll-sync's lock for THAT side, so the scroll event we're
   *         about to cause doesn't bounce back through section-grain sync.
   */
  function scrollBlockToTopThird(el, side) {
    var scrollEl = side === "editor"
      ? document.querySelector(".rf-edit-scroll")
      : (function () {
          var iframe = document.getElementById(IFRAME_ID);
          if (!iframe || !iframe.contentDocument) return null;
          return iframe.contentDocument.scrollingElement
              || iframe.contentDocument.documentElement;
        })();
    if (!scrollEl) return;

    // Block's top relative to scrollEl's content (not viewport).
    // getBoundingClientRect gives viewport-relative coords; adding the
    // current scrollTop converts to content coords for both the editor
    // pane (DOM scroll container) and the iframe document (where rects
    // are relative to the iframe viewport).
    var elRect = el.getBoundingClientRect();
    var scRect = scrollEl.getBoundingClientRect
      ? scrollEl.getBoundingClientRect()
      : { top: 0 };
    var blockTopInContent = (elRect.top - scRect.top) + scrollEl.scrollTop;

    var target = blockTopInContent - scrollEl.clientHeight * TOP_FRACTION;

    // Clamp to valid scroll range.
    var maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
    if (target < 0) target = 0;
    if (target > maxScroll) target = maxScroll;

    if (Math.abs(scrollEl.scrollTop - target) < 1) return;

    acquire(side);
    scrollEl.scrollTop = target;
  }

  function acquire(side) {
    if (window.RF_ScrollSync && typeof window.RF_ScrollSync.acquireLock === "function") {
      window.RF_ScrollSync.acquireLock(side);
    }
  }

  window.RF_BlockHighlight = { init: init };
})();

/**
 * export-fullscreen.js — corner buttons (下载图片 / 全屏查看) for the live
 * preview iframe AND exported HTML/ZIP.
 *
 * Coverage:
 *   Preview iframe : "下载图片" only. Fullscreen is driven by the top-shell
 *                    button that fullscreens the whole iframe.
 *   Exported HTML  : both buttons. Fullscreen opens a self-contained
 *                    overlay (touch + portrait → rotated to landscape).
 *   Fullscreen ov. : the download button is re-attached inside the overlay
 *                    so users can still save the chart/table/image from
 *                    within fullscreen.
 *
 * A single BASE_CSS + DOWNLOAD_SCRIPT is shared between preview and export
 * so the two environments look and behave identically. Additional
 * EXPORT_ONLY_CSS + FULLSCREEN_SCRIPT are appended only in the export path.
 *
 * Callers:
 *   preview.js                 → previewCss + previewScript + decoratePreviewRoot(root)
 *   exporter-html.js / -zip.js → exportCss + exportScript + decorateExportRoot(root)
 *   exporter-pdf.js            → nothing here; its print CSS hides both classes
 *   exporter-png.js            → strips both classes before rasterising
 */
(function () {
  "use strict";

  var FS_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3' +
    'M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';

  // "download" arrow into a tray — same line weight / style as FS_ICON.
  var DL_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';

  function makeFsButton(kind, doc) {
    var btn = (doc || document).createElement("button");
    btn.className = "rf-export-fs-btn rf-export-fs-btn--" + kind;
    btn.type = "button";
    btn.setAttribute("aria-label", "全屏查看");
    btn.title = "全屏查看";
    btn.innerHTML = FS_ICON;
    return btn;
  }

  function makeDlButton(kind, doc) {
    var btn = (doc || document).createElement("button");
    btn.className = "rf-dl-btn rf-dl-btn--" + kind;
    btn.type = "button";
    btn.setAttribute("aria-label", "下载图片");
    btn.title = "下载图片";
    btn.innerHTML = DL_ICON;
    return btn;
  }

  /** Attach fullscreen + download buttons to a chart card. Idempotent. */
  function addChartButton(bodyEl, doc) {
    var card = bodyEl && bodyEl.parentNode;
    if (!card || !card.querySelector) return;
    // 使用 setAttribute 确保样式在 innerHTML 序列化时被保留
    card.setAttribute("style", (card.getAttribute("style") || "") + ";position:relative;");
    if (!card.querySelector(".rf-dl-btn--chart")) {
      card.appendChild(makeDlButton("chart", doc));
    }
    if (!card.querySelector(".rf-export-fs-btn--chart")) {
      card.appendChild(makeFsButton("chart", doc));
    }
  }

  /** Attach fullscreen + download buttons to a table figure. Idempotent. */
  function addTableButton(figEl, doc) {
    if (!figEl || !figEl.querySelector) return;
    if (!figEl.querySelector(".rf-table-scroll")) return;
    figEl.setAttribute("style", (figEl.getAttribute("style") || "") + ";position:relative;");
    if (!figEl.querySelector(".rf-dl-btn--table")) {
      figEl.appendChild(makeDlButton("table", doc));
    }
    if (!figEl.querySelector(".rf-export-fs-btn--table")) {
      figEl.appendChild(makeFsButton("table", doc));
    }
  }

  /** Attach fullscreen + download buttons to an image container. Idempotent. */
  function addImageButton(imgWrapEl, doc) {
    if (!imgWrapEl || !imgWrapEl.querySelector) return;
    if (!imgWrapEl.querySelector("img")) return;
    imgWrapEl.setAttribute("style", (imgWrapEl.getAttribute("style") || "") + ";position:relative;");
    if (!imgWrapEl.querySelector(".rf-dl-btn--image")) {
      imgWrapEl.appendChild(makeDlButton("image", doc));
    }
    if (!imgWrapEl.querySelector(".rf-export-fs-btn--image")) {
      imgWrapEl.appendChild(makeFsButton("image", doc));
    }
  }

  /**
   * Attach corner buttons to every chart / table / image target under root.
   * Called by exporters (on a cloned #root) and by preview.js (on the live
   * #root inside the iframe, after each render).
   */
  function decorateExportRoot(rootClone, doc) {
    decorate(rootClone, doc, { fullscreen: true, download: true });
  }

  /**
   * Preview variant: only add the download button. Fullscreen inside the
   * preview iframe is driven by the top-shell button that fullscreens the
   * whole iframe — a per-chart overlay would double up on that.
   */
  function decoratePreviewRoot(rootLive, doc) {
    decorate(rootLive, doc, { fullscreen: false, download: true });
  }

  function decorate(root, doc, flags) {
    if (!root) return;
    var chartBodies = root.querySelectorAll(".rf-chart-card__body");
    chartBodies.forEach(function (body) {
      var card = body.parentNode;
      if (!card || !card.querySelector) return;
      card.setAttribute("style", (card.getAttribute("style") || "") + ";position:relative;");
      if (flags.download && !card.querySelector(".rf-dl-btn--chart")) {
        card.appendChild(makeDlButton("chart", doc));
      }
      if (flags.fullscreen && !card.querySelector(".rf-export-fs-btn--chart")) {
        card.appendChild(makeFsButton("chart", doc));
      }
    });
    var tableScrolls = root.querySelectorAll(".rf-table-scroll");
    tableScrolls.forEach(function (scroll) {
      var fig = scroll.parentNode;
      while (fig && fig.tagName !== "FIGURE") fig = fig.parentNode;
      if (!fig) return;
      fig.setAttribute("style", (fig.getAttribute("style") || "") + ";position:relative;");
      if (flags.download && !fig.querySelector(".rf-dl-btn--table")) {
        fig.appendChild(makeDlButton("table", doc));
      }
      if (flags.fullscreen && !fig.querySelector(".rf-export-fs-btn--table")) {
        fig.appendChild(makeFsButton("table", doc));
      }
    });
    var imgFigs = root.querySelectorAll(".rf-block--image .rf-img");
    imgFigs.forEach(function (fig) {
      if (!fig.querySelector("img")) return;
      fig.setAttribute("style", (fig.getAttribute("style") || "") + ";position:relative;");
      if (flags.download && !fig.querySelector(".rf-dl-btn--image")) {
        fig.appendChild(makeDlButton("image", doc));
      }
      if (flags.fullscreen && !fig.querySelector(".rf-export-fs-btn--image")) {
        fig.appendChild(makeFsButton("image", doc));
      }
    });
  }

  // ─── CSS ─────────────────────────────────────────────────────────────────
  // Shared between preview (BASE_CSS piece) and export (BASE_CSS + EXPORT_ONLY_CSS).
  // Kept as one big string so we don't scatter selectors between two files.

  // Rules that must exist wherever the buttons live (preview iframe + export).
  var BASE_CSS = [
    ".rf-chart-card{position:relative;}",
    ".rf-block--table figure{position:relative;}",
    ".rf-block--image .rf-img{position:relative;}",
    // Corner button base. rf-dl-btn sits to the left of rf-export-fs-btn
    // (right:36px vs right:8px) so they don't overlap.
    ".rf-export-fs-btn,.rf-dl-btn{position:absolute;top:8px;z-index:100;width:26px;height:26px;",
    "display:inline-flex;align-items:center;justify-content:center;padding:0;line-height:0;",
    "border:1px solid rgba(0,0,0,.1);border-radius:4px;background:rgba(255,255,255,.7);",
    "color:rgba(0,0,0,.4);cursor:pointer;-webkit-tap-highlight-color:transparent;",
    "transition:opacity .15s,background .15s,border-color .15s,color .15s;",
    "opacity:.65;box-shadow:none;}",
    ".rf-export-fs-btn{right:8px;}",
    // rf-dl-btn defaults to the corner slot (right:8px) so preview — which
    // shows only the download button — doesn't leave an empty slot on the
    // right. When the fullscreen button is present alongside, DL shifts
    // 28px left so both fit side-by-side.
    ".rf-dl-btn{right:8px;}",
    ".rf-dl-btn:not(:last-child){right:36px;}",
    ".rf-export-fs-btn:hover,.rf-dl-btn:hover{opacity:1;background:rgba(255,255,255,.9);",
    "border-color:rgba(0,0,0,.18);color:rgba(0,0,0,.55);}",
    ".rf-export-fs-btn:disabled,.rf-dl-btn:disabled{cursor:wait;opacity:.35;}",
    ".rf-export-fs-btn svg,.rf-dl-btn svg{width:14px;height:14px;display:block;stroke-width:2;}",
    "@media print{.rf-export-fs-btn,.rf-dl-btn{display:none!important;}}"
  ].join("");

  // Rules that only exist in the exported doc (fullscreen overlay + responsive tweaks).
  var EXPORT_ONLY_CSS = [
    "body{overflow-x:hidden;-webkit-text-size-adjust:100%;}",
    "#root{box-sizing:border-box;width:100%;overflow-x:hidden;}",
    ".rf-chart-card{overflow:visible!important;}",
    ".rf-chart-card__body{height:auto!important;min-height:0;overflow:visible;}",
    ".rf-chart-resp{width:100%;max-width:100%;overflow:visible;}",
    ".rf-chart-resp svg{width:100%!important;height:auto!important;max-width:100%;display:block;}",
    "@media(max-width:640px){#root{padding:20px 16px!important;}}",
    ".rf-export-fs{position:fixed;inset:0;z-index:99999;background:rgba(250,250,252,.98);",
    "overflow:auto;-webkit-overflow-scrolling:touch;",
    "display:flex;flex-direction:column;align-items:center;",
    "padding:48px 16px;}",
    ".rf-export-fs__stage{width:96vw;display:flex;flex-direction:column;flex:none;margin:auto;}",
    ".rf-export-fs--chart .rf-export-fs__stage{align-items:center;}",
    ".rf-export-fs--chart .rf-export-fs__stage svg{width:100%;height:auto;max-width:100%;}",
    ".rf-export-fs--table .rf-export-fs__stage{width:96vw;max-height:90vh;overflow:auto;",
    "-webkit-overflow-scrolling:touch;align-items:stretch;}",
    ".rf-export-fs--table .rf-table-scroll{overflow-x:auto;max-width:none;width:100%;",
    "-webkit-overflow-scrolling:touch;}",
    ".rf-export-fs--table .rf-table th,.rf-export-fs--table .rf-table td{white-space:nowrap;}",
    ".rf-export-fs--table .rf-table-title{margin-bottom:12px;}",
    ".rf-export-fs--table .rf-table-caption{margin-top:12px;}",
    ".rf-export-fs--image .rf-export-fs__stage{align-items:center;max-width:100%;}",
    ".rf-export-fs--image .rf-export-fs__stage img{max-width:100%;max-height:90vh;width:auto;height:auto;object-fit:contain;}",
    ".rf-export-fs.is-rotated .rf-export-fs__stage{transform:rotate(90deg);width:90vh;height:auto;}",
    ".rf-export-fs__close{position:fixed;top:14px;right:16px;z-index:1;width:40px;height:40px;",
    "border:none;border-radius:50%;background:rgba(0,0,0,.08);color:#1a1f2c;font-size:20px;",
    "line-height:40px;text-align:center;cursor:pointer;}",
    ".rf-export-fs__close:hover{background:rgba(0,0,0,.14);}",
    "@media print{.rf-export-fs{display:none!important;}}"
  ].join("");

  var EXPORT_CSS = BASE_CSS + EXPORT_ONLY_CSS;

  // ─── JavaScript runtime ──────────────────────────────────────────────────
  // Two flavours emitted as strings:
  //   DOWNLOAD_SCRIPT   — click delegation + rasterisation helpers.
  //   FULLSCREEN_SCRIPT — click delegation + overlay mount/destroy.
  //
  // Both are self-contained IIFEs. They share only a target-locating pattern
  // (event.target.closest) but each owns its own state, so we can drop the
  // download runtime into the preview iframe alone (fullscreen preview there
  // uses the top-shell button, not the corner button).

  var DOWNLOAD_SCRIPT = [
    "(function(){",
    // ── helpers ────────────────────────────────────────────────────────────
    "function safeName(s){return String(s||'chart').replace(/[\\\\/:*?\"<>|]+/g,'-').replace(/\\s+/g,'-').slice(0,60)||'image';}",
    // Chromium blocks anchor.click() downloads originating from srcdoc /
    // opaque-origin iframes — the click just navigates to the blob URL
    // instead of saving. When we're inside such an iframe, hand the blob
    // to the parent window so the anchor click happens in the top-level
    // document. Same-origin (srcdoc inherits parent origin) so this call
    // is legal. In the exported HTML this path is skipped (no parent).
    "function trigger(blob,name){",
    "try{if(window.parent&&window.parent!==window&&typeof window.parent.RF_DownloadBlob==='function'){",
    "window.parent.RF_DownloadBlob(blob,name);return;",
    "}}catch(e){}",
    "var url=URL.createObjectURL(blob);var a=document.createElement('a');",
    "a.href=url;a.download=name;a.rel='noopener';document.body.appendChild(a);a.click();",
    "document.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(url);},1000);",
    "}",
    // Serialize an SVG element to a data URL a browser Image() can decode.
    // Handles xmlns injection for detached/inline SVGs so drawImage doesn't
    // silently emit a blank frame.
    "function svgToUrl(svg){",
    "var clone=svg.cloneNode(true);",
    "if(!clone.getAttribute('xmlns'))clone.setAttribute('xmlns','http://www.w3.org/2000/svg');",
    "if(!clone.getAttribute('xmlns:xlink'))clone.setAttribute('xmlns:xlink','http://www.w3.org/1999/xlink');",
    "var xml=new XMLSerializer().serializeToString(clone);",
    "return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(xml);",
    "}",
    // Rasterise an <svg> element (already in the DOM, sized) to a PNG blob.
    // scale=2 for retina-crisp output; falls back to width/height attrs when
    // the element wasn't laid out (0×0 getBoundingClientRect).
    "function svgToPng(svg,scale){return new Promise(function(res,rej){",
    "var box=svg.getBoundingClientRect();",
    "var w=Math.max(1,Math.round((box.width||parseFloat(svg.getAttribute('width'))||720)));",
    "var h=Math.max(1,Math.round((box.height||parseFloat(svg.getAttribute('height'))||320)));",
    "var s=scale||2;var url=svgToUrl(svg);var img=new Image();",
    "img.onload=function(){var c=document.createElement('canvas');c.width=w*s;c.height=h*s;",
    "var g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);",
    "g.drawImage(img,0,0,c.width,c.height);",
    "c.toBlob(function(b){b?res(b):rej(new Error('toBlob null'));},'image/png');",
    "};img.onerror=function(){rej(new Error('svg image load failed'));};img.src=url;",
    "});}",
    // Rasterise an <img> element (or url) to a PNG blob via canvas. Works for
    // data:, blob:, and same-origin URLs. For cross-origin without CORS this
    // will taint the canvas — we fall back to fetching the src as a blob and
    // downloading it verbatim (see download() below).
    "function imgToPng(img){return new Promise(function(res,rej){",
    "var w=img.naturalWidth||img.width;var h=img.naturalHeight||img.height;",
    "if(!w||!h){rej(new Error('image not loaded'));return;}",
    "var c=document.createElement('canvas');c.width=w;c.height=h;",
    "var g=c.getContext('2d');",
    "try{g.drawImage(img,0,0);c.toBlob(function(b){b?res(b):rej(new Error('toBlob null'));},'image/png');}",
    "catch(e){rej(e);}",
    "});}",
    // Rasterise an arbitrary HTML element by wrapping it into an SVG
    // <foreignObject>. We inline every reachable same-doc stylesheet so
    // template CSS still applies inside the SVG sandbox.
    "function collectDocCss(){",
    "var out=[];var sheets=document.styleSheets;",
    "for(var i=0;i<sheets.length;i++){var s=sheets[i];",
    "try{var r=s.cssRules;if(!r)continue;",
    "for(var j=0;j<r.length;j++)out.push(r[j].cssText);}catch(e){}}",
    "return out.join('\\n');",
    "}",
    "function htmlToPng(el,extraCss){return new Promise(function(res,rej){",
    "var box=el.getBoundingClientRect();",
    "var w=Math.max(1,Math.ceil(box.width));var h=Math.max(1,Math.ceil(box.height));",
    // Clone the target and any relevant styles into a fresh subtree so
    // foreignObject renders a stable snapshot.
    "var clone=el.cloneNode(true);",
    "clone.querySelectorAll('.rf-export-fs-btn,.rf-dl-btn').forEach(function(b){b.parentNode.removeChild(b);});",
    "var css=collectDocCss()+(extraCss||'');",
    "var wrapper=document.createElement('div');",
    "wrapper.setAttribute('xmlns','http://www.w3.org/1999/xhtml');",
    "wrapper.style.cssText='background:#fff;width:'+w+'px;';",
    "wrapper.appendChild(clone);",
    "var xhtml=new XMLSerializer().serializeToString(wrapper);",
    "var svg='<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"'+w+'\" height=\"'+h+'\">'+",
    "'<foreignObject width=\"100%\" height=\"100%\"><style>'+css+'</style>'+xhtml+'</foreignObject></svg>';",
    "var url='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);",
    "var img=new Image();img.onload=function(){",
    "var s=2;var c=document.createElement('canvas');c.width=w*s;c.height=h*s;",
    "var g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);",
    "g.drawImage(img,0,0,c.width,c.height);",
    "c.toBlob(function(b){b?res(b):rej(new Error('toBlob null'));},'image/png');",
    "};img.onerror=function(){rej(new Error('foreignObject rasterise failed'));};",
    "img.src=url;",
    "});}",
    // ── click delegation ──────────────────────────────────────────────────
    "function busy(btn,on){if(!btn)return;btn.disabled=!!on;}",
    "function downloadChart(card,btn){",
    // 1) prefer echarts (canvas renderer in preview): use its own toolbox path.
    "var body=card.querySelector('.rf-chart-card__body');",
    "if(body&&window.echarts&&window.echarts.getInstanceByDom){",
    "var inst=window.echarts.getInstanceByDom(body);",
    "if(inst&&inst.getDataURL){",
    "try{",
    "var url=inst.getDataURL({type:'png',pixelRatio:2,backgroundColor:'#fff'});",
    "fetch(url).then(function(r){return r.blob();}).then(function(b){",
    "trigger(b,safeName(chartName(card))+'.png');busy(btn,false);",
    "}).catch(function(){busy(btn,false);});return;",
    "}catch(e){}}}",
    // 2) fallback: inline SVG rasterised via canvas.
    "var svg=card.querySelector('.rf-chart-card__body svg');",
    "if(!svg){busy(btn,false);return;}",
    "svgToPng(svg,2).then(function(b){",
    "trigger(b,safeName(chartName(card))+'.png');busy(btn,false);",
    "}).catch(function(){busy(btn,false);});",
    "}",
    "function chartName(card){",
    "var t=card.querySelector('.rf-chart-card__title');return (t&&t.textContent)||'chart';",
    "}",
    "function downloadImage(fig,btn){",
    "var img=fig.querySelector('img');if(!img){busy(btn,false);return;}",
    "var name=(fig.querySelector('.rf-img__caption')||{}).textContent||img.alt||'image';",
    // Same-origin / data: / blob: → fetch the source as a Blob so we get the
    // untranscoded original. Cross-origin without CORS → fall through to
    // canvas rasterisation, which may throw; last-ditch we try a direct
    // anchor download using the src.
    "var done=function(b){trigger(b,safeName(name)+'.png');busy(btn,false);};",
    "var fail=function(){",
    "try{var a=document.createElement('a');a.href=img.src;a.download=safeName(name);",
    "document.body.appendChild(a);a.click();document.body.removeChild(a);}catch(e){}",
    "busy(btn,false);",
    "};",
    "fetch(img.src).then(function(r){if(!r.ok)throw 0;return r.blob();}).then(function(b){",
    "if(/^image\\/png/i.test(b.type||''))return done(b);",
    // Non-PNG blob → convert to PNG so extension matches the filename.
    "imgToPng(img).then(done,function(){done(b);});",
    "}).catch(function(){imgToPng(img).then(done,fail);});",
    "}",
    "function downloadTable(fig,btn){",
    "var title=(fig.querySelector('.rf-table-title')||{}).textContent||'table';",
    "htmlToPng(fig).then(function(b){trigger(b,safeName(title)+'.png');busy(btn,false);})",
    ".catch(function(){busy(btn,false);});",
    "}",
    "document.addEventListener('click',function(e){",
    "var b=e.target.closest&&e.target.closest('.rf-dl-btn');",
    "if(!b)return;",
    "e.preventDefault();e.stopPropagation();",
    "if(b.disabled)return;",
    "busy(b,true);",
    "if(b.classList.contains('rf-dl-btn--chart')){",
    "var card=b.closest('.rf-chart-card');if(card)downloadChart(card,b);else busy(b,false);",
    "}else if(b.classList.contains('rf-dl-btn--table')){",
    "var fig=b.closest('figure');if(fig)downloadTable(fig,b);else busy(b,false);",
    "}else if(b.classList.contains('rf-dl-btn--image')){",
    "var fi=b.closest('.rf-img');if(fi)downloadImage(fi,b);else busy(b,false);",
    "}else busy(b,false);",
    "},true);",
    "})();"
  ].join("");

  var FULLSCREEN_SCRIPT = [
    "(function(){",
    "var mqCoarse=window.matchMedia&&window.matchMedia('(pointer: coarse)');",
    "function coarse(){return mqCoarse?mqCoarse.matches:false;}",
    "function portrait(){return window.matchMedia('(orientation: portrait)').matches;}",
    "function lockLandscape(){try{if(screen.orientation&&screen.orientation.lock)return screen.orientation.lock('landscape');}catch(e){}return null;}",
    "function unlock(){try{if(screen.orientation&&screen.orientation.unlock)screen.orientation.unlock();}catch(e){}}",
    "function tplScope(){var r=document.getElementById('root');return r&&r.className?r.className:'';}",
    "function mount(ov,stage,extraClass){",
    "ov.className='rf-export-fs'+(extraClass?' '+extraClass:'');",
    "var close=document.createElement('button');close.className='rf-export-fs__close';",
    "close.setAttribute('aria-label','关闭');close.innerHTML='\\u2715';",
    "ov.appendChild(close);ov.appendChild(stage);",
    "document.body.appendChild(ov);document.body.style.overflow='hidden';",
    "var locked=false;",
    "function sync(){if(!locked&&portrait()&&coarse())ov.classList.add('is-rotated');else ov.classList.remove('is-rotated');}",
    "var req=ov.requestFullscreen||ov.webkitRequestFullscreen||ov.msRequestFullscreen;",
    "Promise.resolve().then(function(){if(req)return req.call(ov);}).then(function(){",
    "var p=lockLandscape();if(p&&p.then)return p.then(function(){locked=true;},function(){});",
    "}).catch(function(){}).then(sync);",
    "sync();window.addEventListener('resize',sync);",
    "function destroy(){window.removeEventListener('resize',sync);unlock();",
    "var ex=document.exitFullscreen||document.webkitExitFullscreen||document.msExitFullscreen;",
    "try{if((document.fullscreenElement||document.webkitFullscreenElement)&&ex)ex.call(document);}catch(e){}",
    "document.body.style.overflow='';if(ov.parentNode)ov.parentNode.removeChild(ov);",
    "document.removeEventListener('keydown',onKey);}",
    "function onKey(e){if(e.key==='Escape'||e.keyCode===27)destroy();}",
    "close.addEventListener('click',destroy);",
    "ov.addEventListener('click',function(e){if(e.target===ov)destroy();});",
    "document.addEventListener('keydown',onKey);",
    "}",
    "function openChart(card){",
    "var svg=card.querySelector('.rf-chart-card__body svg');if(!svg)return;",
    "var ov=document.createElement('div');",
    "var stage=document.createElement('div');stage.className='rf-export-fs__stage';",
    // Wrap the SVG in a mini rf-chart-card so the delegated download click
    // handler (which walks up to .rf-chart-card) can find the SVG again.
    "var host=document.createElement('div');host.className='rf-chart-card';",
    "host.style.cssText='position:relative;width:100%;background:transparent;';",
    "var body=document.createElement('div');body.className='rf-chart-card__body';",
    "body.appendChild(svg.cloneNode(true));",
    "host.appendChild(body);host.appendChild(makeOvDl('chart'));",
    "stage.appendChild(host);",
    "mount(ov,stage,'rf-export-fs--chart');",
    "}",
    "function makeOvDl(kind){",
    "var b=document.createElement('button');b.type='button';",
    "b.className='rf-dl-btn rf-dl-btn--'+kind;b.title='下载图片';b.setAttribute('aria-label','下载图片');",
    "b.innerHTML='" + DL_ICON.replace(/'/g, "\\'") + "';return b;",
    "}",
    "function openTable(fig){",
    "var ov=document.createElement('div');",
    "var stage=document.createElement('div');stage.className='rf-export-fs__stage';",
    "var scope=document.createElement('div');",
    "var sc=tplScope();if(sc)scope.className=sc;",
    "var clone=fig.cloneNode(true);",
    "clone.querySelectorAll('.rf-export-fs-btn,.rf-dl-btn').forEach(function(b){b.parentNode.removeChild(b);});",
    "clone.appendChild(makeOvDl('table'));",
    "scope.appendChild(clone);stage.appendChild(scope);",
    "mount(ov,stage,'rf-export-fs--table');",
    "}",
    "function openImage(fig){",
    "var img=fig.querySelector('img');if(!img)return;",
    "var ov=document.createElement('div');",
    "var stage=document.createElement('div');stage.className='rf-export-fs__stage';",
    "var scope=document.createElement('div');",
    "var sc=tplScope();if(sc)scope.className=sc;",
    "var clone=fig.cloneNode(true);",
    "clone.querySelectorAll('.rf-export-fs-btn,.rf-dl-btn').forEach(function(b){b.parentNode.removeChild(b);});",
    "clone.appendChild(makeOvDl('image'));",
    "scope.appendChild(clone);stage.appendChild(scope);",
    "mount(ov,stage,'rf-export-fs--image');",
    "}",
    "document.addEventListener('click',function(e){",
    "var t=e.target.closest&&e.target.closest('.rf-export-fs-btn--chart');",
    "if(t){var c=t.closest('.rf-chart-card');if(c)openChart(c);return;}",
    "t=e.target.closest&&e.target.closest('.rf-export-fs-btn--table');",
    "if(t){var f=t.closest('figure');if(f)openTable(f);return;}",
    "t=e.target.closest&&e.target.closest('.rf-export-fs-btn--image');",
    "if(t){var fi=t.closest('.rf-img');if(fi)openImage(fi);}",
    "});",
    "})();"
  ].join("");

  var EXPORT_SCRIPT  = DOWNLOAD_SCRIPT + FULLSCREEN_SCRIPT;
  // Preview iframe uses only the download runtime (fullscreen there is driven
  // by the top-shell button, and the fullscreen overlay isn't wired into the
  // iframe). Kept as a named export so preview.js can pick just this piece.
  var PREVIEW_CSS    = BASE_CSS;
  var PREVIEW_SCRIPT = DOWNLOAD_SCRIPT;

  window.RF_ExportFullscreen = {
    addChartButton: addChartButton,
    addTableButton: addTableButton,
    addImageButton: addImageButton,
    decorateExportRoot: decorateExportRoot,
    decoratePreviewRoot: decoratePreviewRoot,
    exportCss: EXPORT_CSS,
    exportScript: EXPORT_SCRIPT,
    previewCss: PREVIEW_CSS,
    previewScript: PREVIEW_SCRIPT
  };

  // Parent-side helper the preview iframe calls to trigger a download.
  // Chromium blocks anchor.click() saves that originate from srcdoc /
  // opaque-origin iframes; running the click on the top-level document
  // sidesteps that. Exposed on window so DOWNLOAD_SCRIPT can find it via
  // window.parent.RF_DownloadBlob. Also fine to call from other host code.
  window.RF_DownloadBlob = function (blob, name) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = name || "image.png";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) {
      if (window.RF_Log) window.RF_Log.warn("download blob failed: " + (e && e.message));
    }
  };
})();

/**
 * export-fullscreen.js — fullscreen / landscape preview for exported HTML & ZIP.
 *
 * Injected into self-contained report.html after export. Charts and wide tables
 * get a corner button that opens a fullscreen overlay; on touch devices in
 * portrait the overlay rotates to landscape for easier reading.
 */
(function () {
  "use strict";

  var FS_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3' +
    'M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';

  function makeButton(kind, doc) {
    var btn = (doc || document).createElement("button");
    btn.className = "rf-export-fs-btn rf-export-fs-btn--" + kind;
    btn.type = "button";
    btn.setAttribute("aria-label", "全屏查看");
    btn.title = "全屏查看";
    btn.innerHTML = FS_ICON;
    return btn;
  }

  /** Append a fullscreen button to a chart card. Idempotent. */
  function addChartButton(bodyEl, doc) {
    var card = bodyEl && bodyEl.parentNode;
    if (!card || !card.querySelector) return;
    if (card.querySelector(".rf-export-fs-btn--chart")) return;
    // 使用 setAttribute 确保样式在 innerHTML 序列化时被保留
    card.setAttribute("style", (card.getAttribute("style") || "") + ";position:relative;");
    card.appendChild(makeButton("chart", doc));
  }

  /** Append a fullscreen button to a table figure. Idempotent. */
  function addTableButton(figEl, doc) {
    if (!figEl || !figEl.querySelector) return;
    if (!figEl.querySelector(".rf-table-scroll")) return;
    if (figEl.querySelector(".rf-export-fs-btn--table")) return;
    figEl.setAttribute("style", (figEl.getAttribute("style") || "") + ";position:relative;");
    figEl.appendChild(makeButton("table", doc));
  }

  /** Append a fullscreen button to an image container. Idempotent. */
  function addImageButton(imgWrapEl, doc) {
    if (!imgWrapEl || !imgWrapEl.querySelector) return;
    if (!imgWrapEl.querySelector("img")) return;
    if (imgWrapEl.querySelector(".rf-export-fs-btn--image")) return;
    imgWrapEl.setAttribute("style", (imgWrapEl.getAttribute("style") || "") + ";position:relative;");
    imgWrapEl.appendChild(makeButton("image", doc));
  }

  /** Add fullscreen buttons to all charts, tables & images in an export DOM clone. */
  function decorateExportRoot(rootClone, doc) {
    if (!rootClone) return;
    var chartBodies = rootClone.querySelectorAll(".rf-chart-card__body");
    chartBodies.forEach(function (body) {
      addChartButton(body, doc);
    });
    var tableScrolls = rootClone.querySelectorAll(".rf-table-scroll");
    tableScrolls.forEach(function (scroll) {
      var fig = scroll.parentNode;
      while (fig && fig.tagName !== "FIGURE") fig = fig.parentNode;
      if (fig) addTableButton(fig, doc);
    });
    var imgFigs = rootClone.querySelectorAll(".rf-block--image .rf-img");
    imgFigs.forEach(function (fig) {
      addImageButton(fig, doc);
    });
  }

  var EXPORT_CSS = [
    "body{overflow-x:hidden;-webkit-text-size-adjust:100%;}",
    "#root{box-sizing:border-box;width:100%;overflow-x:hidden;}",
    ".rf-chart-card{position:relative;overflow:visible!important;}",
    ".rf-chart-card__body{height:auto!important;min-height:0;overflow:visible;}",
    ".rf-chart-resp{width:100%;max-width:100%;overflow:visible;}",
    ".rf-chart-resp svg{width:100%!important;height:auto!important;max-width:100%;display:block;}",
    ".rf-block--table figure{position:relative;}",
    ".rf-block--image .rf-img{position:relative;}",
    "@media(max-width:640px){#root{padding:20px 16px!important;}}",
    ".rf-export-fs-btn{position:absolute;top:12px;right:12px;z-index:100;width:36px;height:36px;",
    "display:inline-flex;align-items:center;justify-content:center;padding:0;line-height:0;",
    "border:2px solid #3b82f6;border-radius:8px;background:#fff;",
    "color:#3b82f6;cursor:pointer;-webkit-tap-highlight-color:transparent;",
    "transition:all .15s;box-shadow:0 2px 8px rgba(59,130,246,.3);}",
    ".rf-export-fs-btn:hover{background:#eff6ff;box-shadow:0 4px 12px rgba(59,130,246,.4);}",
    ".rf-export-fs-btn svg{width:20px;height:20px;display:block;stroke-width:2.5;}",
    ".rf-export-fs{position:fixed;inset:0;z-index:99999;background:rgba(250,250,252,.98);",
    "overflow:auto;-webkit-overflow-scrolling:touch;",
    "display:flex;flex-direction:column;align-items:center;justify-content:center;",
    "padding:48px 16px;}",
    ".rf-export-fs__stage{width:96vw;display:flex;flex-direction:column;flex:none;}",
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
    "@media print{.rf-export-fs-btn,.rf-export-fs{display:none!important;}}"
  ].join("");

  var EXPORT_SCRIPT = [
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
    "stage.appendChild(svg.cloneNode(true));mount(ov,stage,'rf-export-fs--chart');",
    "}",
    "function openTable(fig){",
    "var ov=document.createElement('div');",
    "var stage=document.createElement('div');stage.className='rf-export-fs__stage';",
    "var scope=document.createElement('div');",
    "var sc=tplScope();if(sc)scope.className=sc;",
    "var clone=fig.cloneNode(true);",
    "var btn=clone.querySelector('.rf-export-fs-btn--table');",
    "if(btn&&btn.parentNode)btn.parentNode.removeChild(btn);",
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
    "var btn=clone.querySelector('.rf-export-fs-btn--image');",
    "if(btn&&btn.parentNode)btn.parentNode.removeChild(btn);",
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
    "});
    "})();"
  ].join("");

  window.RF_ExportFullscreen = {
    addChartButton: addChartButton,
    addTableButton: addTableButton,
    addImageButton: addImageButton,
    decorateExportRoot: decorateExportRoot,
    exportCss: EXPORT_CSS,
    exportScript: EXPORT_SCRIPT
  };
})();

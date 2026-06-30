/**
 * input-image-highlight.js — 在自然语言录入框（#rf-input-text）中对图片
 * 占位符 `📷[图片N]` 进行常驻高亮（默认选中态视觉效果）。
 *
 * 原理：
 *   textarea 不支持对部分文字着色。这里在 textarea 后面叠一个尺寸/字体/
 *   行距/内边距完全一致的镜像 div（.rf-input-mirror），把同样的文本写进
 *   去，但把所有非占位符字符的颜色设为透明，只让占位符片段以黄色背景
 *   显示。textarea 浮在镜像之上、背景透明，所以最终看到的是：
 *     - 镜像层：仅图片占位符的黄色高亮背景
 *     - textarea 层：用户实际可编辑的全部文字
 *
 *   关键点：镜像层的宽度必须严格等于 textarea.clientWidth（即去掉滚动条
 *   后的内容宽度），否则一旦 textarea 出现纵向滚动条，两边的换行位置就
 *   会偏移，越往下错得越多。这里通过 ResizeObserver + scroll 事件实时
 *   把 textarea 的 clientWidth/clientHeight 和字体 metrics 同步到镜像层。
 *
 * 公共：RF_InputImageHighlight.init() / .refresh()
 */
(function () {
  "use strict";

  var TA_ID = "rf-input-text";

  // 与 docx-import.js 中 PLACEHOLDER_RE 一致，但这里只匹配「📷[图片N]」可视格式；
  // 旧版 [[RF-IMG:xxx]] 标记不属于用户视觉关心的对象，这里不做高亮。
  var PH_RE = /📷\[图片\d+\]/g;

  // 影响字符布局的全部 CSS 属性 —— 必须从 textarea 1:1 复制到镜像层，
  // 否则 wrap 位置会偏。box-sizing 已经在 CSS 里写死为 border-box。
  var SYNC_PROPS = [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant",
    "fontStretch", "fontFeatureSettings", "fontVariationSettings",
    "lineHeight", "letterSpacing", "wordSpacing", "textIndent",
    "textTransform", "textAlign", "direction",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
    "tabSize",
    "whiteSpace", "wordBreak", "overflowWrap", "wordWrap"
  ];

  var taEl = null;
  var mirrorEl = null;
  var rafPending = false;
  var ro = null;

  function init() {
    var ta = document.getElementById(TA_ID);
    if (!ta || ta.dataset.rfImgHl === "1") return;
    ta.dataset.rfImgHl = "1";

    var parent = ta.parentNode;
    if (!parent) return;

    // 包一层 wrap，把 textarea 挪进去，再插入镜像 div。
    var wrap = document.createElement("div");
    wrap.className = "rf-input-wrap";

    var mirror = document.createElement("div");
    mirror.className = "rf-input-mirror";
    mirror.setAttribute("aria-hidden", "true");

    parent.insertBefore(wrap, ta);
    wrap.appendChild(mirror);
    wrap.appendChild(ta);

    taEl = ta;
    mirrorEl = mirror;

    // input 事件覆盖：用户输入、导入 Word、AI 改写替换、载入示例/草稿、清空。
    // 所有以编程方式改动 textarea 的入口都会派发 input（项目内现有约定）。
    ta.addEventListener("input", scheduleRefresh);
    ta.addEventListener("scroll", syncScroll);
    window.addEventListener("resize", scheduleRefresh);

    // textarea 尺寸变化（splitter 拖动、面板折叠/展开、字号缩放）时
    // 必须同步镜像层宽高，否则字符 wrap 位置会偏。
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(scheduleRefresh);
      ro.observe(ta);
    }

    // 草稿可能在 init 之后再回填，做几次延迟刷新更稳妥。
    refresh();
    setTimeout(refresh, 0);
    setTimeout(refresh, 200);
  }

  function scheduleRefresh() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      refresh();
    });
  }

  function refresh() {
    if (!taEl || !mirrorEl) return;
    syncStyle();
    mirrorEl.innerHTML = render(taEl.value);
    syncScroll();
  }

  // 把 textarea 的 computed style 1:1 复制到镜像层，再用 clientWidth/Height
  // 锁死镜像层尺寸 —— textarea.clientWidth 是去掉滚动条后的内容宽度，
  // 这正是文字真正可以排列的宽度。
  function syncStyle() {
    var cs = window.getComputedStyle(taEl);
    for (var i = 0; i < SYNC_PROPS.length; i++) {
      var p = SYNC_PROPS[i];
      mirrorEl.style[p] = cs[p];
    }
    // clientWidth/Height 不含边框、不含滚动条 —— border-box 下镜像层
    // 把它当成「外边盒尺寸」，padding 由 SYNC_PROPS 复制保证内边距一致，
    // 这样镜像与 textarea 的「内容区盒」严丝合缝。
    mirrorEl.style.width = taEl.clientWidth + "px";
    mirrorEl.style.height = taEl.clientHeight + "px";
    // border-box 配合 padding 复制后，需要把边框宽度归零以避免重复算入。
    mirrorEl.style.borderWidth = "0";
  }

  function syncScroll() {
    if (!taEl || !mirrorEl) return;
    mirrorEl.scrollTop = taEl.scrollTop;
    mirrorEl.scrollLeft = taEl.scrollLeft;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
    });
  }

  function render(text) {
    if (text == null) return "";
    var t = String(text);
    // textarea 视觉上把末尾的换行折叠掉一个，镜像 div 不会；补一个空格
    // 让滚动高度对齐。
    if (t.charAt(t.length - 1) === "\n") t += " ";

    var out = "";
    var last = 0;
    var m;
    PH_RE.lastIndex = 0;
    while ((m = PH_RE.exec(t)) !== null) {
      out += escapeHtml(t.slice(last, m.index));
      out += '<mark class="rf-input-mirror__mark">' + escapeHtml(m[0]) + "</mark>";
      last = m.index + m[0].length;
    }
    out += escapeHtml(t.slice(last));
    return out;
  }

  window.RF_InputImageHighlight = { init: init, refresh: refresh };
})();

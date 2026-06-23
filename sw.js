/**
 * sw.js — ReportFlow Service Worker
 *
 * 策略：
 *  - 预缓存核心 App Shell（HTML/CSS/JS/templates/libs/品牌资源），保证首屏即装即用、离线可开。
 *  - 静态资源：cache-first，命中即返回；未命中再从网络取回并写入缓存。
 *  - 导航请求（HTML）：network-first，失败回退到缓存的 index.html，保证离线可进入。
 *  - 新版本激活时清理旧缓存，并通过 postMessage 通知页面提示用户刷新。
 *
 * 注意：本项目是纯静态站点（无构建工具），所有路径均使用相对路径，
 *      支持部署到任意子目录（如 GitHub Pages 子路径）。
 */
"use strict";

// 升级缓存：发布新版只需改这里的版本号，旧缓存会在 activate 时被清理。
const CACHE_VERSION = "v1.4.3";
const CACHE_NAME = "reportflow-" + CACHE_VERSION;

// 计算 SW 作用域内的相对根（部署到子目录也可用）
const SCOPE = self.registration && self.registration.scope
  ? self.registration.scope
  : self.location.href.replace(/sw\.js.*$/, "");

// 预缓存清单（相对于 SW 所在目录）
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",

  // 样式
  "./css/reset.css",
  "./css/base.css",
  "./css/components.css",
  "./css/table.css",
  "./css/app.css",

  // 第三方依赖
  "./libs/echarts.min.js",
  "./libs/jszip.min.js",
  "./libs/mammoth.browser.min.js",
  "./libs/html2pdf.bundle.min.js",
  "./libs/marked.min.js",

  // 启动前自检
  "./js/vendor-shim.js",

  // Core
  "./js/core/event-bus.js",
  "./js/core/state.js",
  "./js/core/storage.js",
  "./js/core/asset-store.js",
  "./js/core/logger.js",
  "./js/core/schema.js",
  "./js/core/bootstrap.js",
  "./js/core/pwa-register.js",

  // Modules
  "./js/modules/ui/modal.js",
  "./js/modules/ui/toast.js",
  "./js/modules/ui/confirm.js",
  "./js/modules/template-registry.js",
  "./js/modules/chart-adapter.js",
  "./js/modules/image-manager.js",
  "./js/modules/docx-import.js",
  "./js/modules/table-format.js",
  "./js/modules/table-paste.js",
  "./js/modules/table-editor.js",
  "./js/modules/renderer-host.js",
  "./js/modules/preview.js",
  "./js/modules/editor.js",
  "./js/modules/scroll-sync.js",
  "./js/modules/block-highlight.js",
  "./js/modules/smart-highlight.js",
  "./js/modules/config-manager.js",
  "./js/modules/llm-client.js",
  "./js/modules/prompt-builder.js",
  "./js/modules/input-rewrite.js",
  "./js/modules/parser.js",
  "./js/modules/history.js",
  "./js/modules/exporter-zip.js",
  "./js/modules/exporter-pdf.js",
  "./js/modules/exporter-html.js",
  "./js/modules/exporter-png.js",
  "./js/modules/exporter-docx.js",

  // Templates
  "./templates/minimal-business/render.js",
  "./templates/formal-gov/render.js",
  "./templates/mono-print/render.js",
  "./templates/tech-minimal/render.js",

  // 品牌资源
  "./assets/brand/favicon.svg",
  "./assets/brand/favicon.ico",
  "./assets/brand/logo.svg",
  "./assets/brand/icon-maskable.svg"
];

// ============== 安装：预缓存 App Shell ==============
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // 单个失败不应导致整个 install 失败：逐个 add，宽容缺失（如可选模板/示例资源）
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) => {
            console.warn("[sw] precache miss:", url, err && err.message);
          })
        )
      );
      // 立刻进入 waiting；激活由用户/页面控制
      await self.skipWaiting();
    })
  );
});

// ============== 激活：清理旧缓存，接管已打开页面 ==============
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("reportflow-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
      // 通知所有客户端：新版本已就绪
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      clients.forEach((c) => {
        c.postMessage({ type: "RF_SW_ACTIVATED", version: CACHE_VERSION });
      });
    })()
  );
});

// ============== 拉取：路由到不同策略 ==============
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // 只处理 GET；POST（如 LLM 调用）一律放行
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // 跨源请求（CDN、LLM API 等）不在此 SW 控制范围，直接放行
  if (url.origin !== self.location.origin) return;

  // chrome-extension / blob: / data: 等也跳过
  if (!url.protocol.startsWith("http")) return;

  // 导航请求：network-first，离线回退 index.html
  if (req.mode === "navigate") {
    event.respondWith(navigationHandler(req));
    return;
  }

  // 其它静态资源：cache-first
  event.respondWith(cacheFirst(req));
});

async function navigationHandler(req) {
  try {
    const fresh = await fetch(req);
    // 顺手刷新 index.html 缓存（同源主页）
    const cache = await caches.open(CACHE_NAME);
    cache.put("./index.html", fresh.clone()).catch(() => {});
    return fresh;
  } catch (e) {
    const cache = await caches.open(CACHE_NAME);
    const cached = (await cache.match(req)) || (await cache.match("./index.html"));
    if (cached) return cached;
    return new Response(
      "<h1>离线且未缓存此页</h1><p>请先在线打开一次 ReportFlow，再尝试离线使用。</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: false });
  if (cached) {
    // 后台异步刷新（stale-while-revalidate 思想，但不阻塞）
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type !== "opaque") {
          cache.put(req, res.clone()).catch(() => {});
        }
      })
      .catch(() => {});
    return cached;
  }
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200 && fresh.type !== "opaque") {
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (e) {
    // 兜底：找一次缓存（可能是不同查询参数版本）
    const fallback = await cache.match(req, { ignoreSearch: true });
    if (fallback) return fallback;
    throw e;
  }
}

// ============== 消息：支持页面手动触发更新 ==============
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "RF_SW_SKIP_WAITING") {
    self.skipWaiting();
  }
});

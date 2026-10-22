// sw.js - 通用 Service Worker (适配 GitHub Pages 多项目)
// 动态确定当前应用的子目录，缓存严格按项目隔离，避免误删/误用其它 PWA 的缓存

// ---------- 1. 动态路径与缓存名称 ----------
// 获取当前 sw.js 所在的目录路径（例如 '/p2p-chat/'）
const BASE_PATH = self.location.pathname.replace(/[^/]+$/, '');
// 项目标识，例如 '/p2p-chat/' -> 'p2p-chat'；根目录部署 -> 'root'
const PROJECT = BASE_PATH.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'root';
// 缓存前缀必须带项目名与分隔符，避免项目名互为前缀时互相误删（如 p2p 与 p2p-chat）
const CACHE_PREFIX = `pwa-cache-${PROJECT}--`;
const CACHE_VERSION = 'v12';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
// 旧版本命名（pwa-cache-p2p-chat-v11），仅用于迁移时清理本项目遗留缓存
const LEGACY_CACHE_RE = PROJECT === 'root'
  ? /^pwa-cache-v\d+$/
  : new RegExp(`^pwa-cache-${PROJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-v\\d+$`);

// 判断请求是否属于本项目作用域
function inScope(pathname) {
  return pathname === BASE_PATH || pathname.startsWith(BASE_PATH);
}

// 预缓存资源列表（全部使用相对于当前 sw.js 的路径）
const PRECACHE_URLS = [
  BASE_PATH,                 // 例如 '/p2p-chat/'
  `${BASE_PATH}index.html`,
  `${BASE_PATH}manifest.json`,
  `${BASE_PATH}peerjs.min.js`,
  `${BASE_PATH}icons/icon-192.png`,
  `${BASE_PATH}icons/icon-512.png`,
  `${BASE_PATH}icons/icon-maskable-192.png`,
  `${BASE_PATH}icons/icon-maskable-512.png`,
  `${BASE_PATH}icons/favicon.ico`,
];

// 静态资源扩展名（用于判断是否缓存优先）
const STATIC_EXTENSIONS = ['js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'woff', 'woff2', 'ttf', 'eot', 'ico'];

// ---------- 2. 工具函数 ----------
function isStaticResource(url) {
  const ext = url.pathname.split('.').pop().toLowerCase();
  return STATIC_EXTENSIONS.includes(ext);
}

function isNavigateRequest(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.destination === 'document');
}

// 只在本项目自己的缓存里查找，绝不命中其它 PWA 的同名资源
async function matchOwnCache(request) {
  const cache = await caches.open(CACHE_NAME);
  return cache.match(request);
}

async function putOwnCache(request, response) {
  const cache = await caches.open(CACHE_NAME);
  return cache.put(request, response);
}

// ---------- 3. 安装阶段 ----------
self.addEventListener('install', (event) => {
  console.log('[SW] 安装中，BASE_PATH =', BASE_PATH, 'CACHE =', CACHE_NAME);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] 预缓存资源:', PRECACHE_URLS);
        // 使用 allSettled 忽略单个资源失败
        return Promise.allSettled(
          PRECACHE_URLS.map(url => cache.add(url).catch(err => console.warn(`预缓存失败 ${url}:`, err)))
        );
      })
      .then(() => self.skipWaiting()) // 立即激活
  );
});

// ---------- 4. 激活阶段（只清理本项目的旧缓存） ----------
self.addEventListener('activate', (event) => {
  console.log('[SW] 激活中...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache === CACHE_NAME) return undefined;
          // 仅删除：本项目前缀的新命名缓存 / 本项目旧命名的缓存
          const isOwnNew = cache.startsWith(CACHE_PREFIX);
          const isOwnLegacy = LEGACY_CACHE_RE.test(cache);
          if (isOwnNew || isOwnLegacy) {
            console.log('[SW] 删除本项目旧缓存:', cache);
            return caches.delete(cache);
          }
          return undefined; // 其它 PWA 的缓存一律不动
        })
      );
    }).then(() => self.clients.claim()) // 立即控制所有页面
  );
});

// ---------- 5. 请求拦截 ----------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 只处理同源 GET 请求，且必须落在本项目作用域内
  if (url.origin !== location.origin || request.method !== 'GET' || !inScope(url.pathname)) {
    return;
  }

  // ----- 5.1 导航请求（HTML）：网络优先，失败回退本项目缓存 -----
  if (isNavigateRequest(request)) {
    event.respondWith(
      fetch(request)
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            putOwnCache(request, networkResponse.clone()).catch(() => {});
          }
          return networkResponse;
        })
        .catch(async () => {
          const cachedResponse = await matchOwnCache(request);
          if (cachedResponse) {
            console.log('[SW] 离线模式，使用缓存页面:', url.pathname);
            return cachedResponse;
          }
          const fallback = await matchOwnCache(`${BASE_PATH}index.html`);
          if (fallback) return fallback;
          return new Response(
            '<h1>📴 离线状态</h1><p>请检查网络连接后刷新页面。</p>',
            { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/html' } }
          );
        })
    );
    return;
  }

  // ----- 5.2 静态资源请求：缓存优先，未命中则网络请求并缓存 -----
  if (isStaticResource(url)) {
    event.respondWith(
      matchOwnCache(request).then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            putOwnCache(request, networkResponse.clone()).catch(() => {});
          }
          return networkResponse;
        }).catch(() => {
          return new Response('', { status: 408 });
        });
      })
    );
    return;
  }

  // ----- 5.3 其他请求（如 API）默认不缓存，直接走网络 -----
  // （业务数据通常存储在 IndexedDB 中，不受影响）
});

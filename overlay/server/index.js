'use strict';
/**
 * 红果短剧 Web 版 —— headless HTTP 服务
 *
 *  上游 main.js 原样加载（5547 行 / 106 个 IPC），Electron 由 shim/electron.js 模拟：
 *    POST /api/ipc/<channel>   -> ipcMain.handle 的 handler
 *    GET  /api/events          -> webContents.send 的 SSE 广播
 *    GET  /__stream/...        -> protocol.handle('hongguo-stream') 的 Range 响应
 *    GET  /__local/...         -> protocol.handle('hongguo-local') 的本地文件 Range 响应
 *    其余                      -> dist-react 静态资源
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { EventEmitter } = require('node:events');

const PORT = Number(process.env.PORT || 9636);
const HOST = process.env.HOST || '0.0.0.0';

// 镜像构建时由 sync.mjs 写入；/api/health 用它报告上游版本与完整源码地址。
// 本地直接运行旧工程没有该文件，忽略即可。
let buildInfo = null;
try {
  buildInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'BUILD-INFO.json'), 'utf8'));
} catch { /* no build info */ }

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...args);
}

// ---------------------------------------------------------------- 模块劫持
const shim = require('../shim/electron');
const originalLoad = Module._load;

const updaterStub = new EventEmitter();
Object.assign(updaterStub, {
  netSession: shim.session.defaultSession,
  autoDownload: false,
  channel: 'latest',
  setFeedURL: () => {},
  checkForUpdates: async () => null,
  downloadUpdate: async () => [],
  quitAndInstall: () => {},
});

Module._load = function (request, parent, isMain) {
  if (request === 'electron') return shim;
  if (request === 'electron-updater') return { autoUpdater: updaterStub };

  // 桌面版靠 file:// 来源判定可信；Web 版来源是可信的 HTTP 服务本身，直接放行。
  if (/native[\\/]renderer-security$/.test(request)) {
    return {
      createRendererSecurity: () => ({
        isTrustedUrl: () => true,
        isTrustedSender: () => true,
        protectWindow: () => {},
      }),
    };
  }

  // 桌面版只接受 null / file:// origin；浏览器同源请求会带 http Origin，放宽为同服务放行。
  if (/native[\\/]media-access$/.test(request)) {
    const real = originalLoad.call(this, request, parent, isMain);
    return {
      createMediaAccess: (...args) => {
        const access = real.createMediaAccess(...args);
        access.corsHeaders = () => ({
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        return access;
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------- SSE 广播
const clients = new Set();
function broadcast(channel, payload) {
  let data;
  try { data = JSON.stringify({ channel, payload }); } catch { return; }
  const frame = `data: ${data}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}
shim.__web.setEventSink(broadcast);

function serveEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  const timer = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 断连时由 close 清理 */ } }, 20000);
  req.on('close', () => { clearInterval(timer); clients.delete(res); });
}

// ---------------------------------------------------------------- IPC 分发
/** 把上游返回的自定义 scheme 地址改成同源 HTTP 路径，浏览器才能播放。 */
function rewriteMediaUrls(value) {
  if (typeof value === 'string') {
    return value
      .replace(/hongguo-stream:\/\/play\//g, '/__stream/play/')
      .replace(/hongguo-local:\/\/f\//g, '/__local/f/')
      .replace(/hongguo-stream:\/\//g, '/__stream/')
      .replace(/hongguo-local:\/\//g, '/__local/');
  }
  if (Array.isArray(value)) return value.map(rewriteMediaUrls);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = rewriteMediaUrls(item);
    return out;
  }
  return value;
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (error) { reject(new Error('请求体不是合法 JSON: ' + error.message)); }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

async function serveIpc(req, res, channel) {
  try {
    const body = await readBody(req);
    const args = Array.isArray(body.args) ? body.args : [];
    const result = await shim.__web.invoke(channel, ...args);
    json(res, 200, { ok: true, result: rewriteMediaUrls(result) });
  } catch (error) {
    log(`[IPC] ${channel} 失败:`, error?.message || error);
    json(res, 200, { ok: false, error: error?.message || String(error) });
  }
}

// ---------------------------------------------------------------- 流协议桥接
async function serveStream(req, res, scheme, rest) {
  const handler = shim.__web.streamHandler(scheme);
  if (!handler) { res.writeHead(503); res.end('stream handler not ready'); return; }

  const ac = new AbortController();
  req.on('close', () => { if (!res.writableEnded) ac.abort(); });

  // 伪装成上游期望的自定义 scheme Request，保持其 URL 解析逻辑完全不变。
  const fakeRequest = {
    url: `${scheme}://${rest}`,
    method: req.method,
    headers: new Headers(req.headers),
    signal: ac.signal,
    initiatorOrigin: undefined,
  };

  try {
    const response = await handler(fakeRequest);
    const headers = {};
    for (const [key, value] of response.headers) headers[key] = value;
    res.writeHead(response.status, headers);
    if (!response.body) { res.end(); return; }
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (!res.headersSent) {
      log(`[Stream] ${scheme} 失败:`, error?.message || error);
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (!res.writableEnded) res.end();
  }
}

// ---------------------------------------------------------------- 静态资源
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
const STATIC_DIR = path.join(shim.__web.appDir, 'dist-react');

async function fallbackIndex(res) {
  try {
    const html = await fsp.readFile(path.join(STATIC_DIR, 'index.html'));
    if (res.headersSent) return;
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(html);
  } catch {
    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('前端产物未构建（dist-react 缺失）');
    }
  }
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(STATIC_DIR, '.' + rel);
  if (!file.startsWith(STATIC_DIR + path.sep) && file !== path.join(STATIC_DIR, 'index.html')) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  let stat;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    await fallbackIndex(res); // SPA 回退
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    // 入口与引导/桥接脚本随改造频繁更新，禁止缓存；带 hash 的 assets 可长缓存。
    'Cache-Control': (rel === '/index.html' || rel === '/bridge.js' || rel === '/web-compat.js')
      ? 'no-store' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  try {
    await pipeline(fs.createReadStream(file), res);
  } catch {
    // 客户端（播放器/页面）提前断开是正常现象，不能再写响应头
    if (!res.writableEnded) res.destroy();
  }
}

// ------------------------------------------------- 整合播放内核（zfdang / hongguo-open-player）
/**
 * 播放内核来自 zfdang/hongguo-open-player（GPL-3.0-only），源码原样复制在 ../hgop/，
 * 各文件保留原 SPDX 许可头。这里只复用服务端流式解密 + Range + 分片预加载能力：
 *   GET  /hgop/stream/:vid    -> 直接给 <video> 供给带 Range 的 MP4
 *   POST /hgop/prefetch/:vid  -> 提前构建后续分集的播放计划（连播秒开）
 * 纯数字 vid（红果官方源）走这里，绕开上游 main.js 的 300MB 在线内存缓存；
 * xifan / hema / custom 等自定义源（vid 非纯数字）仍由原 IPC + protocol.handle 链路处理。
 */
const HGOP_ENABLED = process.env.HONGGUO_HGOP !== '0';
let hgop = null;
if (HGOP_ENABLED) {
  try {
    hgop = require('../hgop/services/streamService');
    const MB = 1024 * 1024;
    // 玩客云 armv7 / 256MB 容器：上游默认 128MB LRU + 32MB 分片计划会 OOM。
    // 实测播放时 plans 顶格堆到 8 个(约 10MB 估算 + 上万个 CENC 样本对象)且不会自动过期，
    // 这里把「当前集 + 预热的下一集」之外的计划全部挡掉，正常播放只用得到 2~3 个。
    hgop.maxCacheBytes = Number(process.env.HONGGUO_HGOP_CACHE_MB || 8) * MB;
    hgop.maxCacheCount = 1;
    // 留够「当前集 + 预热下一集 + 前后集」的余量：卡太死会导致播放中计划被淘汰后
    // 反复重建（每次重建都要拉 moov 并生成上万样本对象），内存和 CPU 不降反升。
    // 真正的回收交给下面的过期清理，停止播放后内存会自然回落。
    hgop.maxPlanCount = Number(process.env.HONGGUO_HGOP_PLANS || 5);
    hgop.maxPlanBytes = Number(process.env.HONGGUO_HGOP_PLAN_MB || 12) * MB;
    hgop.maxPending = 4;
    // 播放瞬间内存/CPU 峰值的主要来源：浏览器首播会并发发多个 Range 请求，而上游
    // getStreamingPlan 没有 in-flight 去重，同一集会同时构建 2~3 份计划（每份都拉
    // moov 并生成上万个 CENC 样本对象）。这里合并并发构建，顺带给命中的计划保活
    // （上游只看 90s expires 且命中时不刷新，看一集超过 90s 会中途重建计划）。
    const planFlights = new Map();
    const rawGetPlan = hgop.getStreamingPlan.bind(hgop);
    hgop.getStreamingPlan = (...args) => {
      const key = `${args[0]}:${args[1]}`;
      const cached = hgop.plans.get(key);
      if (cached?.expires > Date.now()) {
        cached.expires = Date.now() + 90000;
        hgop.plans.delete(key);
        hgop.plans.set(key, cached);
        return Promise.resolve(cached.plan);
      }
      if (planFlights.has(key)) return planFlights.get(key);
      const pending = rawGetPlan(...args).then(plan => {
        for (const item of hgop.plans.values()) {
          if (item.plan === plan) { item.expires = Date.now() + 90000; break; }
        }
        return plan;
      }).finally(() => planFlights.delete(key));
      planFlights.set(key, pending);
      return pending;
    };
    log(`[hgop] 635 播放内核就绪：缓存 ${Math.round(hgop.maxCacheBytes / MB)}MB / 计划 ${Math.round(hgop.maxPlanBytes / MB)}MB / 最多 ${hgop.maxPlanCount} 个`);
  } catch (error) {
    console.error('[hgop] 播放内核加载失败，自动回退原 IPC 播放链路:', error);
    hgop = null;
  }
}

/** streamService 沿用 Express 的 req.query，这里手动补齐等价对象。 */
function hgopQuery(req) {
  const out = {};
  for (const [key, value] of new URL(req.url, 'http://localhost').searchParams) out[key] = value;
  return out;
}

async function hgopStream(req, res, vid) {
  if (!hgop) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('hgop disabled'); return; }
  if (!/^\d{1,30}$/.test(vid)) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('invalid vid'); return; }
  // 一段流传输结束后，延迟请管家评估是否需要回收播放期间累积的 ArrayBuffer。
  res.once?.('close', () => setTimeout(() => maybeGc('stream-close'), 3000).unref?.());
  req.query = hgopQuery(req);
  // 桥接层在播放地址上附带了下一集 vid：稍延迟后预热其分片计划，切集时直接命中缓存。
  // 延迟 800ms 是为了不与当前集的首片下载抢带宽，保证首播速度。
  const nextVid = req.query.next_vid;
  if (nextVid && /^\d{1,30}$/.test(nextVid)) {
    const nextQuality = ['auto', '720p', '1080p'].includes(req.query.quality) ? req.query.quality : 'auto';
    setTimeout(() => hgopWarm(nextVid, nextQuality, []), 800).unref?.();
  }
  try { await hgop.handleStream(req, res, vid); }
  catch (error) { log(`[hgop] stream ${vid} 异常:`, error?.message || error); if (!res.writableEnded) res.destroy(); }
}

/**
 * 上游 prefetch() 会先延迟 4 秒，且在 activeStreams > 0（Web 端播放流常驻）时直接放弃，
 * 等于预加载永不执行。这里改为直接预热分片计划缓存：切集时 getStreamingPlan 命中即秒开。
 * 同时只允许 1 个预热任务：每个计划构建期间会持有 moov 元数据与数万个样本对象，
 * armv7 上并发构建会让内存峰值翻倍，串行预热仍远快于用户看完一集的时间。
 */
const hgopWarming = new Set();
function hgopWarm(vid, quality, nextVids) {
  const key = `${vid}:${quality}`;
  if (hgop.plans.has(key) || hgopWarming.has(key) || hgopWarming.size >= 1) return;
  hgopWarming.add(key);
  const controller = new AbortController();
  hgop.getStreamingPlan(vid, quality, controller.signal, 45000, nextVids)
    .then(() => log(`[hgop] 预热完成 ${key}`))
    .catch(error => log(`[hgop] 预热失败 ${key}:`, error?.message || error))
    .finally(() => hgopWarming.delete(key));
}

function hgopPrefetch(req, res, vid) {
  if (!hgop || !/^\d{1,30}$/.test(vid)) { res.writeHead(202); res.end(); return; }
  const query = hgopQuery(req);
  const quality = ['auto', '720p', '1080p'].includes(query.quality) ? query.quality : 'auto';
  const nextVids = String(query.next_vids || '').split(',')
    .map(item => item.trim()).filter(item => /^\d{1,30}$/.test(item)).slice(0, 4);
  try { hgopWarm(vid, quality, nextVids); }
  catch (error) { log(`[hgop] prefetch ${vid} 异常:`, error?.message || error); }
  res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end('{"ok":true}');
}

// ------------------------------------------------------- 内存诊断（/api/health）
const MBYTES = 1024 * 1024;
const mb = n => Math.round(n / MBYTES * 10) / 10;

function memorySnapshot() {
  const m = process.memoryUsage();
  return {
    rss: mb(m.rss), heapTotal: mb(m.heapTotal), heapUsed: mb(m.heapUsed),
    external: mb(m.external), arrayBuffers: mb(m.arrayBuffers),
  };
}

function hgopSnapshot() {
  if (!hgop) return null;
  let planBytes = 0;
  let cacheBytes = 0;
  for (const item of hgop.plans.values()) planBytes += item.plan?.bytes || 0;
  for (const entry of hgop.cache.values()) cacheBytes += entry.size || 0;
  return {
    plans: hgop.plans.size, planMB: mb(planBytes), planLimitMB: mb(hgop.maxPlanBytes),
    cache: hgop.cache.size, cacheMB: mb(cacheBytes), cacheLimitMB: mb(hgop.maxCacheBytes),
    warming: hgopWarming.size, activeStreams: hgop.activeStreams,
    inFlight: hgop.inFlight.size, pending: hgop.queue.length,
  };
}

// ------------------------------------------------- 缓存管家 / 温和 GC（armv7 内存适配）
let gcCount = 0;
let lastGcAt = 0;
let lastGcRssMB = 0;
let janitorRemoved = 0;

/**
 * 上游只在「新建计划」时淘汰 plans，播放结束后 8 个计划会一直驻留到下次播放。
 * 这里按 90s TTL 主动清掉过期计划，并对数量/字节做兜底，让空闲内存真正回落。
 */
function pruneHgopCaches() {
  if (!hgop) return 0;
  const now = Date.now();
  let removed = 0;
  for (const [key, item] of hgop.plans) {
    if (!item || !(item.expires > now)) { hgop.plans.delete(key); removed++; }
  }
  const limit = hgop.maxPlanCount || 3;
  while (hgop.plans.size > limit) { hgop.plans.delete(hgop.plans.keys().next().value); removed++; }
  let planBytes = 0;
  for (const item of hgop.plans.values()) planBytes += item.plan?.bytes || 0;
  while (hgop.plans.size > 1 && planBytes > (hgop.maxPlanBytes || 6 * MBYTES)) {
    const oldest = hgop.plans.keys().next().value;
    planBytes -= hgop.plans.get(oldest)?.plan?.bytes || 0;
    hgop.plans.delete(oldest);
    removed++;
  }
  if (hgop.cache?.size > (hgop.maxCacheCount || 1)) hgop.pruneCache?.();
  return removed;
}

/**
 * 播放时 axios 会持续分配 512KB ArrayBuffer，V8 只有在堆吃紧时才回收它们。
 * 这里只在「无活跃流 + RSS 偏高」时做一次兜底 full GC，限频 120s，
 * 避免 armv7 上频繁 full GC 占满 CPU 造成播放卡顿。
 */
function maybeGc(reason) {
  if (typeof global.gc !== 'function') return;
  const now = Date.now();
  if (now - lastGcAt < 120000) return;
  const before = process.memoryUsage().rss;
  if (before < 80 * MBYTES) return;
  if (hgop && hgop.activeStreams > 0) return;
  lastGcAt = now;
  gcCount++;
  try {
    global.gc();
    lastGcRssMB = mb(process.memoryUsage().rss);
    log(`[mem] GC(${reason}) ${mb(before)}MB -> ${lastGcRssMB}MB`);
  } catch (error) {
    log(`[mem] GC 跳过:`, error?.message || error);
  }
}

const cacheJanitor = setInterval(() => {
  janitorRemoved += pruneHgopCaches();
  maybeGc('idle');
}, 30000);
cacheJanitor.unref();

// ---------------------------------------------------------------- 启动
let mainReady = false;
try {
  require(path.join(shim.__web.appDir, 'main.js'));
  mainReady = true;
  log(`上游主进程已加载：${shim.__web.listChannels().length} 个 IPC 通道，流协议 ${shim.__web.streamSchemes().join(', ') || '(待启动注册)'}`);
} catch (error) {
  console.error('[FATAL] 上游 main.js 加载失败:', error);
  process.exitCode = 1;
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { res.writeHead(400); res.end('bad request'); return; }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(); return;
  }

  if (pathname === '/api/health') {
    json(res, 200, {
      ok: mainReady,
      mode: 'hongguo-web-headless',
      channels: shim.__web.listChannels().length,
      streams: shim.__web.streamSchemes(),
      hgop: !!hgop,
      sseClients: clients.size,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      uptime: Math.round(process.uptime()),
      build: buildInfo,
      mem: memorySnapshot(),
      hgopStats: hgopSnapshot(),
      gc: {
        enabled: typeof global.gc === 'function',
        count: gcCount,
        lastRssMB: lastGcRssMB,
        prunedPlans: janitorRemoved,
        heapLimitMB: mb(require('node:v8').getHeapStatistics().heap_size_limit),
      },
    });
    return;
  }
  if (pathname === '/api/events') { serveEvents(req, res); return; }
  if (pathname.startsWith('/api/ipc/')) {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '需要 POST' }); return; }
    await serveIpc(req, res, decodeURIComponent(pathname.slice('/api/ipc/'.length)));
    return;
  }
  if (pathname.startsWith('/__stream/')) {
    await serveStream(req, res, 'hongguo-stream', pathname.slice('/__stream/'.length));
    return;
  }
  if (pathname.startsWith('/__local/')) {
    await serveStream(req, res, 'hongguo-local', pathname.slice('/__local/'.length));
    return;
  }
  if (pathname.startsWith('/hgop/stream/')) {
    await hgopStream(req, res, decodeURIComponent(pathname.slice('/hgop/stream/'.length)));
    return;
  }
  if (pathname.startsWith('/hgop/prefetch/')) {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '需要 POST' }); return; }
    hgopPrefetch(req, res, decodeURIComponent(pathname.slice('/hgop/prefetch/'.length)));
    return;
  }
  await serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => log(`红果短剧 Web 版已监听 http://${HOST}:${PORT}`));

const keepAlive = setInterval(() => { log(`[心跳] SSE ${clients.size} 客户端, RSS ${Math.round(process.memoryUsage().rss / 1048576)}MB`); }, 5 * 60 * 1000);
keepAlive.unref();

process.on('uncaughtException', error => console.error('[uncaughtException]', error));
process.on('unhandledRejection', error => console.error('[unhandledRejection]', error));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`收到 ${signal}，关闭服务`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

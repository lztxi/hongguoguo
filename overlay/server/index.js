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
// 播放计划的存活时间。上游默认只有 90s，而一集短剧常看 1~3 分钟，预热好的计划
// 往往在切集之前就过期，于是重新拉 moov + 重新注册播放设备（冷启动 1~2s）。
// 计划本身很小（线上 5 个约 3.2MB，上限 12MB），放宽 TTL 几乎不增加常驻内存，
// 回收仍由 maxPlanCount / maxPlanBytes 与空闲降级负责。
const PLAN_TTL_MS = Math.min(60, Math.max(2,
  Number(process.env.HONGGUO_HGOP_PLAN_TTL_MIN || 10) || 10)) * 60 * 1000;
// 连播预热深度：每集开播后提前备好后续几集的分片计划。
// 0 = 完全禁用预热，1 = 旧行为（只预热下一集），默认 3 集。
const WARM_DEPTH = Math.min(4, Math.max(0,
  Number(process.env.HONGGUO_HGOP_WARM_DEPTH ?? 3) || 0));
// ③ 预热避让：旧实现固定开播后 800ms 就启动预热，而那段时间正是当前集首片在
// 缓冲（armv7 上还要同时做 CENC 解密），预热的设备注册 / 取址 / 解析 moov 会
// 直接抢带宽和 CPU，反而让换集那一下更顿。改为「首片已稳定推送」之后再启动。
const WARM_TRIGGER_BYTES = Math.min(4096, Math.max(64,
  Number(process.env.HONGGUO_HGOP_WARM_TRIGGER_KB || 512) || 512)) * 1024;
const WARM_MIN_DELAY_MS = Math.min(15000, Math.max(0,
  Number(process.env.HONGGUO_HGOP_WARM_DELAY_MS ?? 2000) || 0));
const WARM_FALLBACK_MS = 8000;
// ① 首片预缓冲：只缓存播放计划时，切集虽省了取址，浏览器仍要等服务端向上游
// 拉 mdat 的前几个 512KB 分片并实时解密。这里在预热阶段就把下一集开头若干 MB
// 「已解密」数据备好，切集时由 plan.read 直接吐出，才是真正的秒开。
// 0 = 禁用；默认每集 1MB、总量封顶 4MB（相对约 52MB 常驻 RSS 可忽略）。
const PREBUF_BYTES = Math.min(2, Math.max(0,
  Number(process.env.HONGGUO_HGOP_PREBUF_MB ?? 1) || 0)) * 1024 * 1024;
const PREBUF_LIMIT_BYTES = Math.min(12, Math.max(1,
  Number(process.env.HONGGUO_HGOP_PREBUF_LIMIT_MB || 4) || 4)) * 1024 * 1024;

// ------------------------------------------------- 上游取源故障容错（熔断 + 退避 + 自动重试）
/**
 * 2026-11-10 红果官方临时收紧校验，取址接口返回 HTTP 200 + content-length: 0，
 * 上游两个项目同时报障。故障期间有两件事特别难受：
 *   1. 预热队列每 250ms 就注册一个新设备并重新取址，几十次无效请求反而可能让
 *      本机 IP 被风控盯得更久；
 *   2. <video> 一收到 500 就锁死，官方恢复后还得手动刷新页面。
 * 这里在 overlay 层加三层保护，不改上游复制源码（同步上游不冲突）：
 *   - 区分「红果接口坏了」与「我们本地坏了」，写进 /api/health 与网页角标；
 *   - 播放请求在响应头写出之前自动重试有限次，浏览器只是多等几秒；
 *   - 连续失败达阈值后熔断：暂停预热队列并指数退避，一次播放成功即惰性解封
 *     （不主动探测、不额外打接口，用户点播本身就是探测）。
 * HONGGUO_UPSTREAM_GUARD=0 可一键回到旧行为。
 */
const clampNum = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const GUARD = {
  enabled: process.env.HONGGUO_UPSTREAM_GUARD !== '0',
  failThreshold: clampNum(process.env.HONGGUO_UPSTREAM_FAIL_THRESHOLD, 2, 10, 3) | 0,
  retryMax: clampNum(process.env.HONGGUO_UPSTREAM_RETRY_MAX, 0, 4, 2) | 0,
  retryBaseMs: clampNum(process.env.HONGGUO_UPSTREAM_RETRY_BASE_MS, 300, 10000, 1200) | 0,
  retryDeadlineMs: clampNum(process.env.HONGGUO_UPSTREAM_RETRY_DEADLINE_MS, 3000, 60000, 20000) | 0,
  cooldownBaseMs: clampNum(process.env.HONGGUO_UPSTREAM_COOLDOWN_MS, 5000, 120000, 30000) | 0,
  cooldownMaxMs: clampNum(process.env.HONGGUO_UPSTREAM_COOLDOWN_MAX_MS, 30000, 600000, 300000) | 0,
};
// 这些是「上游接口/片源侧」的错误；AbortError、ECONNRESET 等属于客户端切集/断连，
// UNSUPPORTED_BYTEVC2 / SECURITY_BLOCKED 属于内容本身，都不能算上游临时故障。
const UPSTREAM_FAULT_CODES = new Set([
  'EMPTY_RESPONSE', 'BUSINESS_REJECTED', 'MISSING_MODEL', 'INVALID_RESPONSE',
  'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED',
]);
const upstream = {
  failures: 0, trips: 0, retries: 0, warmSuppressed: 0,
  cooldownUntil: 0, cooldownMs: 0, lastSuccessAt: 0, lastRecoveryAt: 0,
  lastFailure: null, lastLocalError: null,
  warmingPaused: false, warmResumeTimer: null,
};
let planCallPurpose = 'play'; // 仅在同一同步调用栈内标记，见 withPlanPurpose()
function withPlanPurpose(purpose, fn) {
  const prev = planCallPurpose;
  planCallPurpose = purpose;
  try { return fn(); } finally { planCallPurpose = prev; }
}

function isUpstreamFault(error) {
  if (!error || error.name === 'AbortError' || error.code === 'ERR_STREAM_PREMATURE_CLOSE') return false;
  if (UPSTREAM_FAULT_CODES.has(String(error.code || ''))) return true;
  const msg = String(error.message || '');
  return /空响应|签名或设备鉴权|播放接口|视频源不可用|App 接口暂未提供|未返回本集片源|片源地址或密钥无法解析|取源失败/.test(msg);
}
function upstreamCooling() {
  return GUARD.enabled && Date.now() < upstream.cooldownUntil;
}
function noteLocalError(error) {
  upstream.lastLocalError = {
    message: String(error?.message || error).slice(0, 240), at: new Date().toISOString(),
  };
}
function noteUpstreamSuccess() {
  upstream.lastSuccessAt = Date.now();
  if (upstream.failures || upstream.cooldownUntil) {
    upstream.lastRecoveryAt = Date.now();
    log(`[upstream] 取源恢复，预热队列解封（此前连续失败 ${upstream.failures} 次）`);
  }
  upstream.failures = 0;
  upstream.cooldownUntil = 0;
  upstream.cooldownMs = 0;
  if (upstream.warmingPaused) resumeWarmQueue(0);
}
/** final=false 表示「播放自动重试中的一次失败」：只记录，不重复累加/延长退避。 */
function noteUpstreamFailure(error, purpose, final = true) {
  upstream.lastFailure = {
    code: String(error?.code || 'STREAM_ERROR'),
    message: String(error?.message || error).slice(0, 240),
    purpose, at: new Date().toISOString(),
  };
  if (final) upstream.failures += 1;
  if (!GUARD.enabled || upstream.failures < GUARD.failThreshold) return;
  if (upstreamCooling() && upstream.warmingPaused) return; // 已熔断，别反复重置退避
  // 指数退避：30s → 60s → 120s → 300s 封顶；一次成功即清零。
  upstream.cooldownMs = upstream.cooldownMs
    ? Math.min(upstream.cooldownMs * 2, GUARD.cooldownMaxMs)
    : GUARD.cooldownBaseMs;
  upstream.cooldownUntil = Date.now() + upstream.cooldownMs;
  upstream.trips += 1;
  log(`[upstream] 连续 ${upstream.failures} 次取源失败，判定上游接口故障；预热暂停 ${Math.round(upstream.cooldownMs / 1000)}s，播放请求仍会自动重试`);
  pauseWarmQueue();
}
function pauseWarmQueue() {
  upstream.warmingPaused = true;
  warmQueue.length = 0; // 故障期排队的任务全部作废，避免解封后集中轰炸
  if (upstream.warmResumeTimer) clearTimeout(upstream.warmResumeTimer);
  const wait = Math.max(1000, upstream.cooldownUntil - Date.now());
  upstream.warmResumeTimer = setTimeout(() => {
    upstream.warmResumeTimer = null;
    upstream.warmingPaused = false;
    // 半开（half-open）：退避结束后把计数清零，让 health/角标回到正常态，
    // 不再把一次已经过去的故障挂成「持续故障」；若上游仍坏，下一次失败会
    // 重新计数并按翻倍的退避再次熔断。cooldownMs 故意保留用于指数退避。
    upstream.failures = 0;
    upstream.lastRecoveryAt = Date.now();
    log('[upstream] 退避结束（半开）：预热队列恢复，等待下一次播放确认上游状态');
    runWarmQueue();
  }, wait);
  upstream.warmResumeTimer.unref?.();
}
function resumeWarmQueue(delay) {
  if (upstream.warmResumeTimer) {
    clearTimeout(upstream.warmResumeTimer);
    upstream.warmResumeTimer = null;
  }
  upstream.warmingPaused = false;
  setTimeout(runWarmQueue, delay || 0).unref?.();
}
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });

/** 所有取址/计划构建的唯一入口：播放侧自动重试，预热侧遇熔断立即让路。 */
async function guardedGetPlan(call, args, purpose) {
  const attempts = purpose === 'play' && GUARD.enabled ? 1 + GUARD.retryMax : 1;
  const deadline = Date.now() + GUARD.retryDeadlineMs;
  for (let attempt = 0; ; attempt++) {
    if (purpose === 'warm' && upstreamCooling()) {
      upstream.warmSuppressed += 1;
      throw Object.assign(new Error('上游取源故障，预热已进入退避'), { code: 'UPSTREAM_COOLDOWN' });
    }
    try {
      const plan = await call(...args);
      noteUpstreamSuccess();
      return plan;
    } catch (error) {
      if (!isUpstreamFault(error)) { noteLocalError(error); throw error; }
      const last = attempt + 1 >= attempts || Date.now() >= deadline;
      noteUpstreamFailure(error, purpose, last);
      if (last) throw error;
      upstream.retries += 1;
      const wait = Math.min(GUARD.retryBaseMs * (2 ** attempt), 8000, Math.max(0, deadline - Date.now()));
      log(`[upstream] 取源失败（${error.code || 'UNKNOWN'}），${wait}ms 后自动重试 ${attempt + 1}/${attempts - 1}`);
      await sleep(wait);
    }
  }
}

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
      const purpose = planCallPurpose; // play = 用户点播（可自动重试），warm = 预热（遇熔断让路）
      const cached = hgop.plans.get(key);
      if (cached?.expires > Date.now()) {
        cached.expires = Date.now() + PLAN_TTL_MS;
        hgop.plans.delete(key);
        hgop.plans.set(key, cached);
        return Promise.resolve(cached.plan);
      }
      if (planFlights.has(key)) return planFlights.get(key);
      const pending = guardedGetPlan(rawGetPlan, args, purpose).then(plan => {
        attachPrebuffer(plan, key);
        // 上游写入 plans 时用的是 90s TTL，这里统一续到我们配置的时长；
        // planFlights 命中/空闲淘汰都读同一个 expires，行为保持一致。
        for (const item of hgop.plans.values()) {
          if (item.plan === plan) { item.expires = Date.now() + PLAN_TTL_MS; break; }
        }
        return plan;
      }).finally(() => planFlights.delete(key));
      planFlights.set(key, pending);
      return pending;
    };
    log(`[hgop] 635 播放内核就绪：缓存 ${Math.round(hgop.maxCacheBytes / MB)}MB / 计划 ${Math.round(hgop.maxPlanBytes / MB)}MB / 最多 ${hgop.maxPlanCount} 个 / TTL ${Math.round(PLAN_TTL_MS / 60000)} 分钟 / 连播预热 ${WARM_DEPTH} 集 / 首片预缓冲 ${Math.round(PREBUF_BYTES / MB)}MB×${Math.round(PREBUF_LIMIT_BYTES / MB)}MB 上限 / 预热避让 ${WARM_MIN_DELAY_MS}ms+${Math.round(WARM_TRIGGER_BYTES / 1024)}KB`);
    log(`[upstream] 取源容错${GUARD.enabled ? `已启用：连续 ${GUARD.failThreshold} 次失败熔断 ${Math.round(GUARD.cooldownBaseMs / 1000)}s 起（指数退避封顶 ${Math.round(GUARD.cooldownMaxMs / 1000)}s）/ 播放自动重试 ${GUARD.retryMax} 次` : '已禁用（HONGGUO_UPSTREAM_GUARD=0）'}`);
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
  // 前端在播放地址上附带后续 3 集 vid：入队串行预热，切集时直接命中分片计划。
  // 首个任务延迟 800ms，避免与当前集首片下载抢带宽；其余由队列依次接上。
  // 首个任务把后续 vid 一并传给 App 接口批量取址，后面的计划构建会快很多。
  const warmList = [];
  const pushVid = value => {
    const v = String(value || '').trim();
    if (/^\d{1,30}$/.test(v) && !warmList.includes(v)) warmList.push(v);
  };
  pushVid(req.query.next_vid);
  for (const v of String(req.query.next_vids || '').split(',')) pushVid(v);
  if (WARM_DEPTH > 0 && warmList.length) {
    const nextQuality = ['auto', '720p', '1080p'].includes(req.query.quality) ? req.query.quality : 'auto';
    const jobs = warmList.slice(0, WARM_DEPTH);
    const t0 = Date.now();
    let fired = false, scheduled = false, written = 0;
    const fire = () => {
      if (fired) return;
      fired = true;
      clearTimeout(fallback);
      // 每个任务都带上后续 vid，让上游有机会一次批量取址，减少重复的设备注册
      jobs.forEach((v, i) => hgopWarm(v, nextQuality, jobs.slice(i + 1, i + 4)));
      log(`[hgop] 预热启动：开播后 ${Date.now() - t0}ms / 已推送 ${Math.round(written / 1024)}KB / ${jobs.length} 集`);
    };
    const fallback = setTimeout(fire, WARM_FALLBACK_MS);
    fallback.unref?.();
    // 等当前集首片真正推给浏览器之后再开始预热，别再和首播抢 CPU / 带宽。
    const originalWrite = res.write;
    res.write = function (chunk, ...rest) {
      const result = originalWrite.call(this, chunk, ...rest);
      if (!fired && !scheduled && chunk && typeof chunk !== 'function') {
        written += typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk.length || 0);
        if (written >= WARM_TRIGGER_BYTES) {
          scheduled = true;
          const wait = Math.max(200, WARM_MIN_DELAY_MS - (Date.now() - t0));
          setTimeout(fire, wait).unref?.();
        }
      }
      return result;
    };
  }
  try { await hgop.handleStream(req, res, vid); }
  catch (error) { log(`[hgop] stream ${vid} 异常:`, error?.message || error); if (!res.writableEnded) res.destroy(); }
}

// ------------------------------------------------------- ① 下一集首片预缓冲
/**
 * 不改上游 streamService / rangeMedia 源码：给构建好的 plan 换一层 read 包装。
 * handleStream 照常 writeHead(206) + pipeline(plan.read(start,end))，包装后的
 * 生成器先从内存吐出已解密的开头字节，剩余区间再交给原始生成器；产出字节数
 * 严格等于 end-start+1，Content-Range / Content-Length 语义不变。
 */
const RAW_READ = Symbol('hgopRawRead');
const prebuf = new Map(); // key -> { data, expires, hits }
let prebufFilled = 0, prebufHits = 0, prebufFailures = 0;

function prebufTotalBytes() {
  let total = 0;
  for (const item of prebuf.values()) total += item.data.length;
  return total;
}

function trimPrebuf() {
  const now = Date.now();
  for (const [key, item] of prebuf) if (item.expires <= now) prebuf.delete(key);
  let total = prebufTotalBytes();
  if (total <= PREBUF_LIMIT_BYTES) return;
  for (const [key, item] of prebuf) {
    if (prebuf.size <= 1) break;
    prebuf.delete(key);
    total -= item.data.length;
    if (total <= PREBUF_LIMIT_BYTES) break;
  }
  if (total > PREBUF_LIMIT_BYTES) prebuf.clear();
}

function attachPrebuffer(plan, key) {
  if (!plan || !PREBUF_BYTES || plan[RAW_READ]) return;
  const rawRead = plan.read;
  if (typeof rawRead !== 'function') return;
  plan[RAW_READ] = rawRead;
  plan.read = function (start, end, signal) {
    const item = prebuf.get(key);
    const from = Number(start) || 0;
    const to = Number(end);
    if (!item || item.expires <= Date.now() || from >= item.data.length || to < from) {
      return rawRead.call(plan, start, end, signal);
    }
    const data = item.data;
    const headEnd = Math.min(to, data.length - 1);
    return (async function* () {
      signal?.throwIfAborted();
      if (from <= headEnd) {
        item.hits++;
        prebufHits++;
        item.expires = Date.now() + PLAN_TTL_MS; // 命中保活，与播放计划同寿命
        yield data.subarray(from, headEnd + 1);
      }
      if (to >= data.length) {
        yield* rawRead.call(plan, Math.max(from, data.length), to, signal);
      }
    })();
  };
}

/** 预热队列里串行执行：把该集开头 PREBUF_BYTES 字节提前拉好并解密。 */
async function fillPrebuffer(plan, key, signal) {
  if (!PREBUF_BYTES || !plan || signal?.aborted) return;
  const current = prebuf.get(key);
  if (current && current.expires > Date.now() + 30000) return;
  const rawRead = plan[RAW_READ] || plan.read;
  const want = Math.min(PREBUF_BYTES, Number(plan.size) || PREBUF_BYTES);
  const chunks = [];
  let got = 0;
  const t0 = Date.now();
  try {
    for await (const chunk of rawRead.call(plan, 0, want - 1, signal)) {
      if (signal?.aborted) return;
      const copy = Buffer.from(chunk); // axios 的 Buffer 可能在后续请求里复用
      chunks.push(copy);
      got += copy.length;
      if (got >= want) break;
    }
  } catch (error) {
    prebufFailures++;
    log(`[hgop] 首片预缓冲跳过 ${key}:`, error?.message || error);
    return;
  }
  if (!got) return;
  let data = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, got);
  if (data.length > want) data = Buffer.from(data.subarray(0, want));
  prebuf.delete(key);
  prebuf.set(key, { data, expires: Date.now() + PLAN_TTL_MS, hits: 0 });
  trimPrebuf();
  prebufFilled++;
  log(`[hgop] 首片预缓冲完成 ${key}: ${Math.round(data.length / 1024)}KB / ${Date.now() - t0}ms`);
}

/**
 * 上游 prefetch() 会先延迟 4 秒，且在 activeStreams > 0（Web 端播放流常驻）时直接放弃，
 * 等于预加载永不执行。这里改为直接预热分片计划缓存：切集时 getStreamingPlan 命中即秒开。
 *
 * 严格串行但「不丢弃」：每个计划构建期间会持有 moov 元数据与数万个样本对象，
 * armv7 上并发构建会让内存峰值翻倍。旧实现用 `size >= 1` 直接 return，连播时后一个
 * 预热请求被静默丢掉，第 3 集必然冷启动；改成 FIFO 队列后同一时刻仍只跑 1 个，
 * 但后续集会排队补上，总耗时远短于一集的观看时间。
 */
const hgopWarming = new Set();
const warmQueue = [];
let warmActive = false;

function planUsable(key) {
  const item = hgop?.plans.get(key);
  // 留 30s 余量：即将过期的计划也要重新预热，否则切集时刚好撞上重建
  return !!item && item.expires > Date.now() + 30000;
}

function runWarmQueue() {
  if (warmActive || !hgop) return;
  // 上游接口故障时暂停整条预热队列：不再注册设备、不再取址，避免无效请求轰炸。
  // 播放请求不受此限制（用户主动点播本身就是一次低成本的恢复探测）。
  if (upstreamCooling()) {
    if (!upstream.warmingPaused) pauseWarmQueue();
    return;
  }
  const job = warmQueue.shift();
  if (!job) return;
  if (planUsable(job.key) || hgopWarming.has(job.key)) {
    setTimeout(runWarmQueue, 0).unref?.();
    return;
  }
  warmActive = true;
  hgopWarming.add(job.key);
  const controller = new AbortController();
  withPlanPurpose('warm', () =>
    hgop.getStreamingPlan(job.vid, job.quality, controller.signal, 45000, job.nextVids))
    .then(async plan => {
      log(`[hgop] 预热完成 ${job.key}（队列余 ${warmQueue.length}）`);
      // 单独给首片预缓冲 8s 上限，CDN 慢节点不能把整条预热队列拖死
      const fillSignal = typeof AbortSignal.any === 'function'
        ? AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])
        : controller.signal;
      await fillPrebuffer(plan, job.key, fillSignal);
    })
    .catch(error => log(`[hgop] 预热失败 ${job.key}:`, error?.message || error))
    .finally(() => {
      hgopWarming.delete(job.key);
      warmActive = false;
      // 任务之间留一点空隙，避免连续 3 集预热把 armv7 的 CPU 一直占满
      setTimeout(runWarmQueue, 250).unref?.();
    });
}

function hgopWarm(vid, quality, nextVids) {
  const key = `${vid}:${quality}`;
  if (upstreamCooling()) { upstream.warmSuppressed += 1; return; }
  if (planUsable(key) || hgopWarming.has(key)) return;
  if (warmQueue.some(job => job.key === key)) return;
  if (warmQueue.length >= 6) return; // 异常情况下不无限堆积
  warmQueue.push({ vid, quality, key, nextVids: nextVids || [] });
  runWarmQueue();
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
    warming: hgopWarming.size, warmQueue: warmQueue.length,
    planTtlMinutes: Math.round(PLAN_TTL_MS / 60000), warmDepth: WARM_DEPTH,
    prebuf: {
      entries: prebuf.size, mb: mb(prebufTotalBytes()), limitMB: mb(PREBUF_LIMIT_BYTES),
      perEpisodeMB: mb(PREBUF_BYTES), filled: prebufFilled, hits: prebufHits,
      failures: prebufFailures,
    },
    activeStreams: hgop.activeStreams,
    inFlight: hgop.inFlight.size, pending: hgop.queue.length,
  };
}

/** 一眼分清「我们坏了」还是「红果接口坏了」，网页角标与排障都读这里。 */
function upstreamSnapshot() {
  const now = Date.now();
  const cooling = upstreamCooling();
  const last = upstream.lastFailure;
  const local = upstream.lastLocalError;
  const recent = item => !!item && now - Date.parse(item.at) < 2 * 60 * 1000;
  let state = 'ok', blame = 'none', hint = '取源正常';
  if (cooling) {
    state = 'cooldown'; blame = 'upstream';
    hint = '红果接口暂时不可用：已暂停预热，播放会自动重试，恢复后自动解封';
  } else if (recent(last) && upstream.failures > 0) {
    state = 'degraded'; blame = 'upstream';
    hint = '红果接口偶发失败：播放已自动重试';
  } else if (recent(local) && (!recent(last) || local.at > last.at)) {
    state = 'local-error'; blame = 'us';
    hint = '播放服务本地异常，请查看容器日志';
  }
  return {
    guard: GUARD.enabled ? 'on' : 'off',
    state, blame, hint, ok: state === 'ok',
    failures: upstream.failures, trips: upstream.trips,
    retries: upstream.retries, warmSuppressed: upstream.warmSuppressed,
    warmingPaused: upstream.warmingPaused,
    cooldownRemainingSec: Math.max(0, Math.ceil((upstream.cooldownUntil - now) / 1000)),
    cooldownMs: upstream.cooldownMs,
    config: {
      failThreshold: GUARD.failThreshold, retryMax: GUARD.retryMax,
      retryBaseMs: GUARD.retryBaseMs, retryDeadlineMs: GUARD.retryDeadlineMs,
      cooldownBaseMs: GUARD.cooldownBaseMs, cooldownMaxMs: GUARD.cooldownMaxMs,
    },
    lastFailure: last, lastLocalError: local,
    lastSuccessAt: upstream.lastSuccessAt ? new Date(upstream.lastSuccessAt).toISOString() : null,
    lastRecoveryAt: upstream.lastRecoveryAt ? new Date(upstream.lastRecoveryAt).toISOString() : null,
  };
}

// ------------------------------------------------- 缓存管家 / 空闲降级（armv7 内存适配）
let gcCount = 0;
let lastGcAt = 0;
let lastGcRssMB = 0;
let janitorRemoved = 0;

/**
 * 长时间没人用时把进程压到最低占用：
 *   - 心跳类请求（Docker HEALTHCHECK 的 /api/health、浏览器 SSE 长连接 /api/events）
 *     不算「使用」，否则 60s 一次的健康检查会让空闲判定永远不生效；
 *   - 有播放流 / 预热任务 / 进行中的分片时一律不降级，避免看到一半卡住；
 *   - 达到阈值后清空 hgop 分片计划与 LRU 缓存，连做两次 full GC，
 *     把播放期间 axios 分配的 512KB ArrayBuffer 尽量还给系统；
 *   - 只清缓存，不关服务、不断连接，任何业务请求到达即无感唤醒
 *     （代价：唤醒后首播要重建一次分片计划，约 1~2s）。
 * 阈值用 HONGGUO_IDLE_SLEEP_MINUTES 调整（默认 30 分钟），
 * HONGGUO_IDLE_SLEEP=0 可整体禁用，方便出问题时秒回原行为。
 */
const IDLE_SLEEP_ENABLED = process.env.HONGGUO_IDLE_SLEEP !== '0';
const IDLE_SLEEP_MINUTES = Math.min(24 * 60, Math.max(1,
  Number(process.env.HONGGUO_IDLE_SLEEP_MINUTES || 30) || 30));
const IDLE_SLEEP_MS = IDLE_SLEEP_MINUTES * 60 * 1000;
let lastActivityAt = Date.now();
let sleeping = false;
let sleepCount = 0;
let wakeCount = 0;
let lastSleepAt = 0;
let lastDropCount = 0;
let lastSleepRssMB = 0;

function isBusy() {
  return !!(hgop && (hgop.activeStreams > 0 || hgopWarming.size > 0 || warmQueue.length > 0
    || (hgop.inFlight && hgop.inFlight.size > 0)
    || (hgop.waitingStreams && hgop.waitingStreams.length > 0)));
}

function noteActivity() {
  lastActivityAt = Date.now();
  if (sleeping) {
    sleeping = false;
    wakeCount++;
    log(`[idle] 业务请求到达，唤醒（第 ${wakeCount} 次）`);
  }
}

function idleSnapshot() {
  return {
    enabled: IDLE_SLEEP_ENABLED,
    sleeping,
    sleepCount,
    wakeCount,
    idleSeconds: Math.round((Date.now() - lastActivityAt) / 1000),
    thresholdMinutes: IDLE_SLEEP_MINUTES,
    busy: isBusy(),
    lastSleepAt: lastSleepAt ? new Date(lastSleepAt).toISOString() : null,
    droppedPlans: lastDropCount,
    rssAfterSleepMB: lastSleepRssMB,
  };
}

function enterIdleSleep() {
  sleeping = true;
  sleepCount++;
  lastSleepAt = Date.now();
  const before = mb(process.memoryUsage().rss);
  let dropped = 0;
  try {
    if (hgop) {
      dropped = hgop.plans.size + hgop.cache.size + prebuf.size;
      hgop.plans.clear();
      hgop.cache.clear();
      prebuf.clear();
      // zfdang v1.11.0 起新增了渐进式分片缓存等 Map（fragmentCache 单集可达 64MB），
      // 空闲时一并释放，避免 256MB 容器长时间挂着旧播放数据。
      for (const timer of hgop.prefetchTimers?.values() || []) clearTimeout(timer);
      for (const name of ['fragmentCache', 'prefetchTimers', 'quickAborts',
                          'consumedRefreshes', 'streamControllers']) {
        const map = hgop[name];
        if (map && typeof map.clear === 'function') { dropped += map.size; map.clear(); }
      }
    }
  } catch (error) {
    log('[idle] 清缓存跳过:', error?.message || error);
  }
  lastDropCount = dropped;
  // 连续两次 full GC：V8 需要多轮标记才能收干净跨代引用
  if (typeof global.gc === 'function') {
    try { global.gc(); global.gc(); gcCount += 2; } catch { /* 未开 --expose-gc */ }
  }
  lastGcAt = Date.now(); // 避免管家紧接着又触发一次 GC
  lastSleepRssMB = mb(process.memoryUsage().rss);
  log(`[idle] 空闲 ${IDLE_SLEEP_MINUTES} 分钟 → 低功耗：清 ${dropped} 项缓存，RSS ${before}MB -> ${lastSleepRssMB}MB`);
}

function evaluateIdle() {
  if (!IDLE_SLEEP_ENABLED || sleeping || isBusy()) return;
  if (Date.now() - lastActivityAt < IDLE_SLEEP_MS) return;
  enterIdleSleep();
}

/**
 * 上游只在「新建计划」时淘汰 plans，播放结束后 8 个计划会一直驻留到下次播放。
 * 这里按 getStreamingPlan 包装器统一设置的 expires（默认 10 分钟，见 PLAN_TTL_MS）
 * 主动清掉过期计划，并对数量/字节做兜底，让空闲内存真正回落。
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
  trimPrebuf();
  return removed;
}

/**
 * 播放时 axios 会持续分配 512KB ArrayBuffer，V8 只有在堆吃紧时才回收它们。
 * 这里只在「无活跃流 + RSS 偏高」时做一次兜底 full GC，限频 120s，
 * 避免 armv7 上频繁 full GC 占满 CPU 造成播放卡顿。
 * 门槛 80MB → 40MB：armv7 常态 RSS 只有 45~56MB，原门槛让这个兜底
 * 从未触发过（线上 health 的 gc.count 长期为 0），等于形同虚设。
 */
function maybeGc(reason) {
  if (typeof global.gc !== 'function') return;
  const now = Date.now();
  if (now - lastGcAt < 120000) return;
  const before = process.memoryUsage().rss;
  if (before < 40 * MBYTES) return;
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
  if (!sleeping) janitorRemoved += pruneHgopCaches();
  evaluateIdle();
  if (!sleeping) maybeGc('idle');
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

  // Docker HEALTHCHECK 每 60s 打 /api/health，浏览器 SSE 长连接只在建立时
  // 请求一次 /api/events 之后每 20s 发 ping：这两类都不算「有人在用」。
  if (pathname !== '/api/health' && pathname !== '/api/events') noteActivity();

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
      upstream: upstreamSnapshot(),
      gc: {
        enabled: typeof global.gc === 'function',
        count: gcCount,
        lastRssMB: lastGcRssMB,
        prunedPlans: janitorRemoved,
        heapLimitMB: mb(require('node:v8').getHeapStatistics().heap_size_limit),
      },
      idle: idleSnapshot(),
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

server.listen(PORT, HOST, () => {
  log(`红果短剧 Web 版已监听 http://${HOST}:${PORT}`);
  log(`[idle] 空闲降级${IDLE_SLEEP_ENABLED ? `已启用：无业务请求 ${IDLE_SLEEP_MINUTES} 分钟后清缓存 + full GC` : '已禁用'}`);
});

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

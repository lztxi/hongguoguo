'use strict';
/**
 * 从上游 preload.js 自动生成浏览器版 window.electronAPI 桥接，并注入 dist-react/index.html。
 * 上游更新时重新跑一次即可，不需要手工维护 100+ 个方法。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const OUT = path.join(APP, 'dist-react');
const preload = fs.readFileSync(path.join(APP, 'preload.js'), 'utf8');
const body = preload.slice(preload.indexOf('exposeInMainWorld'));

// 按 preload 里两个空格缩进的 `name:` 切块
const blocks = [];
let current = null;
for (const line of body.split(/\r?\n/)) {
  const match = /^  ([A-Za-z_$][\w$]*):\s*(.*)$/.exec(line);
  if (match) {
    if (current) blocks.push(current);
    current = { name: match[1], text: match[2] + '\n' };
  } else if (current) {
    current.text += line + '\n';
  }
}
if (current) blocks.push(current);

const invokes = [];
const events = [];
for (const block of blocks) {
  const invoke = /ipcRenderer\.invoke\(\s*'([^']+)'/.exec(block.text);
  const on = /ipcRenderer\.on\(\s*'([^']+)'/.exec(block.text);
  if (invoke) invokes.push([block.name, invoke[1]]);
  else if (on) events.push([block.name, on[1]]);
}

if (invokes.length < 80 || events.length < 15) {
  throw new Error(`preload 解析异常：invoke=${invokes.length}, on=${events.length}，请检查上游格式是否变化`);
}

const invokeLines = invokes.map(([name, channel]) => `    ${name}: (...args) => invoke(${JSON.stringify(channel)}, ...args),`);
const eventLines = events.map(([name, channel]) => `    ${name}: (cb) => on(${JSON.stringify(channel)}, cb),`);

const bridge = `/* 自动生成：由 web/gen-bridge.mjs 依据 app/preload.js 产出，请勿手改 */
(function () {
  'use strict';
  const listeners = new Map();

  // 软解播放器在 Web Worker 里 fetch 媒体 URL，Worker 没有页面的 baseURI，
  // 相对路径会直接抛 "Failed to parse URL from /__stream/..."。
  // 统一把自定义流协议 / 相对流路径转成同源绝对 URL（IPC 返回值与 SSE 事件都过这里）。
  function absolutize(value) {
    if (typeof value === 'string') {
      var s = value;
      if (s.indexOf('hongguo-stream://') === 0) s = '/__stream/' + s.slice(17);
      else if (s.indexOf('hongguo-local://') === 0) s = '/__local/' + s.slice(16);
      if (s.indexOf('/__stream/') === 0 || s.indexOf('/__local/') === 0 || s.indexOf('/hgop/') === 0) {
        return new URL(s, document.baseURI).href;
      }
      return s;
    }
    if (Array.isArray(value)) return value.map(absolutize);
    if (value && typeof value === 'object') {
      var out = {};
      for (var k in value) if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = absolutize(value[k]);
      return out;
    }
    return value;
  }

  // 剧集列表缓存：给播放地址附带下一集 vid，服务端据此提前预热分片计划。
  var hgopSeries = new Map();
  function rememberEpisodes(seriesId, result) {
    try {
      var list = result && ((result.data && result.data.episodes) || result.episodes);
      if (!Array.isArray(list) || list.length < 2 || !list[0] || list[0].vid == null) return;
      var vids = list.slice()
        .sort(function (a, b) { return (Number(a.vid_index) || 0) - (Number(b.vid_index) || 0); })
        .map(function (e) { return String(e.vid); })
        .filter(function (v) { return /^\\d{6,30}$/.test(v); });
      if (vids.length) hgopSeries.set(String(seriesId), vids);
    } catch (_) {}
  }

  function invoke(channel, ...args) {
    return fetch(new URL('api/ipc/' + encodeURIComponent(channel), document.baseURI), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: args }),
      credentials: 'same-origin'
    }).then(function (r) {
      if (!r.ok) throw new Error('服务响应 HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j.ok) throw new Error(j.error || '请求失败');
      if (channel === 'get-series-episodes') rememberEpisodes(args[0], j.result);
      return absolutize(j.result);
    });
  }

  function on(channel, cb) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
    return function () {
      var set = listeners.get(channel);
      if (set) set.delete(cb);
    };
  }

  try {
    var es = new EventSource(new URL('api/events', document.baseURI));
    es.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        var set = listeners.get(msg.channel);
        if (!set) return;
        set.forEach(function (cb) {
          try { cb(absolutize(msg.payload)); } catch (err) { console.error('[bridge] listener', msg.channel, err); }
        });
      } catch (err) { console.error('[bridge] bad event', err); }
    };
    window.addEventListener('pagehide', function () { es.close(); });
  } catch (err) {
    console.error('[bridge] EventSource 不可用', err);
  }

  window.electronAPI = {
${invokeLines.join('\n')}
${eventLines.join('\n')}
  };

  // ---------------------------------------------------------------- 整合播放内核
  // 纯数字 vid = 红果官方源，直接交给服务端 635 流式解密内核（/hgop/stream/<vid>），
  // 跳过上游 prepare-online-play 的 300MB 整集内存缓存；连播时前端本来就会为
  // 后续 2 集调用 prefetch，这里转成 /hgop/prefetch 提前构建播放计划，实现秒开。
  // 非数字 vid（xifan/hema/custom 自定义源）保留原 IPC 链路，功能不丢失。
  // 在控制台执行 localStorage.setItem('hongguo:hgop','0') 可临时切回原播放链路。
  var HGOP_QUALITIES = ['auto', '720p', '1080p'];
  function hgopEnabled() {
    try { return window.localStorage.getItem('hongguo:hgop') !== '0'; } catch (_) { return true; }
  }
  function hgopQuality(value) {
    return HGOP_QUALITIES.indexOf(value) >= 0 ? value : 'auto';
  }
  function hgopVid(value) {
    return /^\\d{6,30}$/.test(String(value == null ? '' : value));
  }
  function hgopResult(payload) {
    var params = ['quality=' + encodeURIComponent(hgopQuality(payload.quality))];
    if (payload.force) params.push('refresh=' + Date.now());
    var vids = hgopSeries.get(String(payload.seriesId));
    if (vids) {
      var index = vids.indexOf(String(payload.vid));
      if (index >= 0) {
        // 把后续 3 集一起带给服务端：连播时逐集命中已构建好的分片计划。
        // 只带下一集的话，第 3 集必然撞上 1~2s 的冷启动（拉 moov + 注册设备）。
        var upcoming = [];
        for (var i = index + 1; i < vids.length && upcoming.length < 3; i++) upcoming.push(String(vids[i]));
        if (upcoming.length) {
          params.push('next_vid=' + encodeURIComponent(upcoming[0]));
          if (upcoming.length > 1) params.push('next_vids=' + encodeURIComponent(upcoming.slice(1).join(',')));
        }
      }
    }
    var url = '/hgop/stream/' + encodeURIComponent(payload.vid) + '?' + params.join('&');
    return { success: true, url: absolutize(url), streamId: 'hgop:' + payload.vid,
      size: 0, cached: false, streaming: true, codec: '' };
  }

  var rawPrepareOnlinePlay = window.electronAPI.prepareOnlinePlay;
  window.electronAPI.prepareOnlinePlay = function (payload) {
    var p = payload || {};
    if (!hgopEnabled() || !hgopVid(p.vid)) return rawPrepareOnlinePlay(payload);
    if (p.prefetch) {
      try {
        var url = new URL('hgop/prefetch/' + encodeURIComponent(p.vid)
          + '?quality=' + encodeURIComponent(hgopQuality(p.quality)), document.baseURI);
        fetch(url, { method: 'POST', credentials: 'same-origin' }).catch(function () {});
      } catch (_) {}
    }
    return Promise.resolve(hgopResult(p));
  };

  var rawReleaseOnlinePlay = window.electronAPI.releaseOnlinePlay;
  window.electronAPI.releaseOnlinePlay = function (payload) {
    var p = payload || {};
    if (typeof p.streamId === 'string' && p.streamId.indexOf('hgop:') === 0) {
      return Promise.resolve({ success: true });
    }
    return rawReleaseOnlinePlay(payload);
  };

  window.__hongguoWeb = { invoke: invoke, on: on, hgopEnabled: hgopEnabled, version: '2.0.0' };
})();
`;

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'bridge.js'), bridge);

// 注入到构建产物入口；普通 script 会先于 type=module 执行，保证 electronAPI 在 React 挂载前就绪
const indexFile = path.join(OUT, 'index.html');
let html = fs.readFileSync(indexFile, 'utf8');
html = html.replace(/<script src="\.\/bridge\.js"><\/script>\s*/g, '');
html = html.replace('<script src="./bridge.js"></script>', '');
html = html.replace('</head>', '  <script src="./bridge.js"></script>\n  </head>');
fs.writeFileSync(indexFile, html);

console.log(`[bridge] 生成完毕：${invokes.length} 个 invoke / ${events.length} 个事件，已注入 dist-react/index.html`);

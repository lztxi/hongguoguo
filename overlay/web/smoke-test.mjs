'use strict';
/** 本机冒烟测试：拉起 server，验证主进程加载、IPC 分发、静态资源与 SSE。 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 6399);
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', d => { output += d.toString(); process.stdout.write(d); });
child.stderr.on('data', d => { output += d.toString(); process.stderr.write(d); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ready() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  return null;
}

async function ipc(channel, ...args) {
  try {
    const r = await fetch(`${BASE}/api/ipc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
      signal: AbortSignal.timeout(20000),
    });
    return await r.json();
  } catch (error) { return { ok: false, error: error.message }; }
}

let failed = 0;
try {
  const health = await ready();
  if (!health) { console.error('[FAIL] 服务未就绪'); process.exitCode = 1; }
  else {
    console.log('\n[health]', JSON.stringify(health));
    if (!health.ok || health.channels < 100) { console.error('[FAIL] 主进程未完整加载'); failed++; }

    for (const file of ['/', '/bridge.js']) {
      const r = await fetch(BASE + file);
      const text = await r.text();
      console.log(`[static] ${file} -> ${r.status}, ${text.length} 字节`);
      if (!r.ok) failed++;
      if (file === '/' && !text.includes('bridge.js')) { console.error('[FAIL] 首页未注入 bridge'); failed++; }
      if (file === '/bridge.js' && !text.includes('window.electronAPI')) { console.error('[FAIL] bridge 内容异常'); failed++; }
    }

    const checks = [
      'get-app-info', 'get-settings', 'get-download-tasks', 'get-series-list',
      'get-queue-status', 'get-ffmpeg-status', 'get-media-sources',
      'get-watch-history', 'get-storage-usage', 'get-proxy-status',
      'browse-categories', 'get-merge-tasks', 'get-account-status',
    ];
    for (const channel of checks) {
      const result = await ipc(channel);
      const brief = JSON.stringify(result?.result ?? result?.error ?? result).slice(0, 160);
      console.log(`[ipc] ${channel.padEnd(22)} ${result.ok ? 'OK ' : 'ERR'} ${brief}`);
      if (!result.ok) failed++;
    }
  }
} finally {
  child.kill();
  await sleep(300);
  console.log(`\n[result] ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
  if (failed) console.log('\n--- 服务日志尾部 ---\n' + output.slice(-4000));
  process.exitCode = failed ? 1 : 0;
}

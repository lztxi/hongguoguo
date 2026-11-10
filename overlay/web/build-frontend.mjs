'use strict';
/** 在本机（Windows / macOS / Linux）构建前端静态产物，不需要 Electron。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com';
const shell = process.platform === 'win32';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell, env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`);
}

// SKIP_VITE=1：离线/复现模式下复用已有的 dist-react，仍会重跑桥接生成与兼容脚本注入。
// 上游 preload.js 一变，bridge.js 必须重新生成，这一步任何模式都不能跳过。
if (process.env.SKIP_VITE) {
  console.log('[build] SKIP_VITE=1：复用已有 dist-react');
} else {
  if (!fs.existsSync(path.join(APP, 'node_modules', 'vite'))) {
    console.log('[build] 安装前端构建依赖（--ignore-scripts 跳过 Electron 二进制）...');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${REGISTRY}`], APP);
  }

  console.log('[build] vite build ...');
  run('npx', ['vite', 'build', '--config', 'vite.config.js'], APP);
}

console.log('[build] 生成浏览器桥接 ...');
run(process.execPath, [path.join(ROOT, 'web', 'gen-bridge.mjs')], ROOT);

const out = path.join(APP, 'dist-react');

// vite build 会清空 outDir，兼容引导脚本与注入必须在 build 之后重建。
// 用外部脚本而非内联脚本：首页 CSP 的 script-src 没有 'unsafe-inline'。
fs.copyFileSync(path.join(ROOT, 'web', 'web-compat.js'), path.join(out, 'web-compat.js'));
fs.copyFileSync(path.join(ROOT, 'web', 'sidebar-collapse.js'), path.join(out, 'sidebar-collapse.js'));
fs.copyFileSync(path.join(ROOT, 'web', 'version-badge.js'), path.join(out, 'version-badge.js'));

/**
 * 自制增强脚本不走 vite 的 [hash] 命名，浏览器按旧 URL 缓存一小时。
 * 这里给它们加内容指纹：文件一变 URL 就变，刷新页面立刻拿到新版，
 * 不用强刷、也不用等缓存过期（服务端对这些文件另有 no-store 兜底）。
 */
function stamp(name) {
  return crypto.createHash('sha1')
    .update(fs.readFileSync(path.join(out, name)))
    .digest('hex').slice(0, 8);
}
const V_COMPAT = stamp('web-compat.js');
const V_SIDEBAR = stamp('sidebar-collapse.js');
const V_BADGE = stamp('version-badge.js');

const htmlPath = path.join(out, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
let dirty = false;

// 复用旧 index.html（SKIP_VITE=1）时同样刷新指纹，避免「内容变了 URL 没变」；
// 同时兼容历史上没有 ?v= 的旧注入，第一次跑就能补上指纹。
const refreshed = html
  .replace(/(src="\.\/web-compat\.js)(\?v=[0-9a-f]{8})?(")/g, '$1?v=' + V_COMPAT + '$3')
  .replace(/(src="\.\/sidebar-collapse\.js)(\?v=[0-9a-f]{8})?(")/g, '$1?v=' + V_SIDEBAR + '$3')
  .replace(/(src="\.\/version-badge\.js)(\?v=[0-9a-f]{8})?(")/g, '$1?v=' + V_BADGE + '$3');
if (refreshed !== html) { html = refreshed; dirty = true; }

if (!html.includes('web-compat.js')) {
  const boot = '    <script src="./web-compat.js?v=' + V_COMPAT + '"></script>\n';
  if (html.includes('src="./bridge.js"')) {
    html = html.replace(/( *<script src="\.\/bridge\.js"><\/script>)/, boot + '$1');
  } else {
    html = html.replace('</head>', boot + '  </head>');
  }
  dirty = true;
}
if (!html.includes('sidebar-collapse.js')) {
  const tag = '    <script src="./sidebar-collapse.js?v=' + V_SIDEBAR + '"></script>\n';
  const bridge = html.match(/ *<script src="\.\/bridge\.js"><\/script>/);
  if (bridge) html = html.replace(bridge[0], bridge[0] + '\n' + tag.replace(/\n$/, ''));
  else html = html.replace('</head>', tag + '  </head>');
  dirty = true;
}
if (!html.includes('version-badge.js')) {
  const tag = '    <script src="./version-badge.js?v=' + V_BADGE + '"></script>\n';
  const side = html.match(/ *<script src="\.\/sidebar-collapse\.js[^"]*"><\/script>/);
  if (side) html = html.replace(side[0], side[0] + '\n' + tag.replace(/\n$/, ''));
  else html = html.replace('</head>', tag + '  </head>');
  dirty = true;
}
if (dirty) fs.writeFileSync(htmlPath, html);

const files = fs.readdirSync(out);
console.log(`[build] 完成：${out}`);
console.log(`[build] 产物：${files.join(', ')}`);

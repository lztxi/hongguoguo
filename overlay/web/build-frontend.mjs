'use strict';
/** 在本机（Windows / macOS / Linux）构建前端静态产物，不需要 Electron。 */
import fs from 'node:fs';
import path from 'node:path';
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

const htmlPath = path.join(out, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
if (!html.includes('web-compat.js')) {
  const boot = '    <script src="./web-compat.js"></script>\n';
  if (html.includes('src="./bridge.js"')) {
    html = html.replace(/( *<script src="\.\/bridge\.js"><\/script>)/, boot + '$1');
  } else {
    html = html.replace('</head>', boot + '  </head>');
  }
  fs.writeFileSync(htmlPath, html);
}

const files = fs.readdirSync(out);
console.log(`[build] 完成：${out}`);
console.log(`[build] 产物：${files.join(', ')}`);

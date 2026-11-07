#!/usr/bin/env node
'use strict';
/**
 * 从两个上游仓库拉取 upstream.lock.json 锁定的版本，叠加 overlay/ 定制层，
 * 产出可直接 `docker build` 的 build/ 目录。上游源码零修改（唯一例外是
 * overlay/hgop/patches.json 里带锚点校验的内存适配补丁）。
 *
 * 环境变量：
 *   SKIP_FRONTEND=1       跳过前端构建（只组装源码，用于校验补丁/兼容性）
 *   DIST_REACT_FROM=<dir> 离线模式：复制已有 dist-react 而非重新 vite build
 *   NPM_REGISTRY=<url>    前端依赖源（CI 建议 registry.npmjs.org）
 *   FORCE_DOWNLOAD=1      忽略 .cache 里的归档重新下载
 *   SOURCE_URL=<url>      写进镜像 BUILD-INFO.json 的源码地址（AGPL 第 13 条）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'upstream.lock.json');
const OVERLAY = path.join(ROOT, 'overlay');
const BUILD = path.join(ROOT, 'build');
const CACHE = path.join(ROOT, '.cache');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));

const log = (...args) => console.log('[sync]', ...args);
const warn = (...args) => console.warn('[sync:warn]', ...args);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`);
}

async function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10_000 && process.env.FORCE_DOWNLOAD !== '1') {
    log('使用缓存归档', path.basename(dest));
    return;
  }
  log('下载', url);
  const res = await fetch(url, { headers: { 'User-Agent': 'hongguoguo' } });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function extract(zip, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const r = spawnSync(PYTHON, [path.join(ROOT, 'scripts', 'unzip.py'), zip, dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`解压失败: ${r.stderr || r.stdout}`);
  return r.stdout.trim().split(/\r?\n/).pop();
}

const SKIP_TOP = new Set(['.git', '.github', 'node_modules', 'dist', 'dist-react', '.cache']);
function copyDir(from, to, skip = SKIP_TOP) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst, skip);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** 锚点补丁：每个 find 必须精确命中 1 次，否则视为上游已改动，要求人工合并。 */
function applyPatches(hgopDir) {
  const spec = JSON.parse(fs.readFileSync(path.join(OVERLAY, 'hgop', 'patches.json'), 'utf8'));
  const applied = [];
  for (const file of spec.files) {
    const target = path.join(hgopDir, file.path);
    let text = fs.readFileSync(target, 'utf8');
    for (const edit of file.edits) {
      const hits = text.split(edit.find).length - 1;
      if (hits !== 1) {
        throw new Error(
          `[patch] ${file.path} / ${edit.id}: 锚点命中 ${hits} 次（期望 1）。\n` +
          `上游很可能改动了这段代码，请人工检查并更新 overlay/hgop/patches.json 后再构建。\n` +
          `锚点：${JSON.stringify(edit.find.slice(0, 120))}`
        );
      }
      text = text.replace(edit.find, edit.replace);
      applied.push(`${file.path}#${edit.id}`);
    }
    fs.writeFileSync(target, text);
    log(`已应用补丁 ${file.path}（${file.edits.length} 处）`);
  }
  return applied;
}

function gitRevision() {
  const r = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'local';
}

// ------------------------------------------------------------------ 1. 清理
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

// ------------------------------------------------------------------ 2. jackotom 上游（主进程 / 前端源码）
const j = lock.jackotom;
const jZip = path.join(CACHE, `jackotom-${j.tag}.zip`);
await download(`https://codeload.github.com/${j.repo}/zip/refs/tags/${encodeURIComponent(j.tag)}`, jZip);
const jRoot = extract(jZip, path.join(CACHE, `jackotom-${j.tag}-src`));
copyDir(jRoot, path.join(BUILD, 'app'));
log(`上游 1 就位：${j.repo} ${j.tag} (${j.sha.slice(0, 10)})`);

// ------------------------------------------------------------------ 3. zfdang 上游（播放内核）
const z = lock.zfdang;
const zZip = path.join(CACHE, `zfdang-${z.tag}.zip`);
await download(`https://codeload.github.com/${z.repo}/zip/refs/tags/${encodeURIComponent(z.tag)}`, zZip);
const zRoot = extract(zZip, path.join(CACHE, `zfdang-${z.tag}-src`));
const zServer = path.join(zRoot, 'src', 'server');
if (!fs.existsSync(zServer)) throw new Error(`上游目录结构变化：找不到 ${zServer}`);
for (const group of ['services', 'native']) {
  const dir = path.join(zServer, group);
  if (!fs.existsSync(dir)) throw new Error(`上游目录结构变化：找不到 ${dir}`);
  let count = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    copyFile(path.join(dir, name), path.join(BUILD, 'hgop', group, name));
    count++;
  }
  log(`hgop/${group}: ${count} 个文件`);
}
copyFile(path.join(zRoot, 'LICENSE'), path.join(BUILD, 'hgop', 'LICENSE'));
log(`上游 2 就位：${z.repo} ${z.tag} (${z.sha.slice(0, 10)})`);

// ------------------------------------------------------------------ 4. 锚点补丁
const patchIds = applyPatches(path.join(BUILD, 'hgop'));

// ------------------------------------------------------------------ 5. 定制层
copyFile(path.join(OVERLAY, 'Dockerfile'), path.join(BUILD, 'Dockerfile'));
copyFile(path.join(OVERLAY, 'docker-compose.yml'), path.join(BUILD, 'docker-compose.yml'));
copyFile(path.join(OVERLAY, 'dockerignore'), path.join(BUILD, '.dockerignore'));
for (const dir of ['shim', 'server', 'web']) copyDir(path.join(OVERLAY, dir), path.join(BUILD, dir), new Set());
log('定制层 overlay/ 已叠加（shim / server / web / Dockerfile / compose）');

// ------------------------------------------------------------------ 6. 前端产物
const mode = process.env.SKIP_FRONTEND === '1' ? 'skip'
  : process.env.DIST_REACT_FROM ? 'offline' : 'full';
if (mode === 'offline') {
  copyDir(process.env.DIST_REACT_FROM, path.join(BUILD, 'app', 'dist-react'), new Set());
  log('离线模式：复用已有 dist-react');
}
if (mode !== 'skip') {
  const env = {};
  if (mode === 'offline') env.SKIP_VITE = '1';
  if (process.env.NPM_REGISTRY) env.NPM_REGISTRY = process.env.NPM_REGISTRY;
  if (mode === 'full') {
    // 软解资源是回退路径；下载失败不应阻断构建（默认走浏览器原生 HEVC 硬解）。
    try {
      run(process.execPath, ['scripts/setup-software-player.cjs'], { cwd: path.join(BUILD, 'app'), env });
    } catch (error) {
      warn('软解资源下载失败，已跳过：', error.message);
    }
  }
  run(process.execPath, [path.join(BUILD, 'web', 'build-frontend.mjs')], { cwd: BUILD, env });
  log(`前端构建完成（${mode}）`);
} else {
  warn('SKIP_FRONTEND=1：build/app/dist-react 缺失，仅可用于校验，不能直接打镜像');
}

// ------------------------------------------------------------------ 7. 构建信息
const info = {
  project: 'hongguo-web',
  overlayRevision: gitRevision(),
  builtAt: new Date().toISOString(),
  jackotom: { repo: j.repo, tag: j.tag, sha: j.sha, license: j.license },
  zfdang: { repo: z.repo, tag: z.tag, sha: z.sha, license: z.license },
  patches: patchIds,
  sourceUrl: process.env.SOURCE_URL || 'https://github.com/lztxi/hongguoguo',
};
fs.writeFileSync(path.join(BUILD, 'BUILD-INFO.json'), JSON.stringify(info, null, 2) + '\n');
log(`完成 → ${BUILD}`);
console.log(JSON.stringify({ jackotom: j.tag, zfdang: z.tag, patches: patchIds.length, mode }, null, 2));

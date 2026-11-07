#!/usr/bin/env node
'use strict';
/**
 * 对 sync.mjs 生成的 build/ 做离线验收。不联网、不构建镜像，CI 的 PR 阶段必跑。
 * 重点验证：上游版本一致、补丁已正确重放、桥接脚本基于新 preload 重新生成、
 * 关键 JS 语法通过。任何一项失败都会阻断合并。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const LOCK = JSON.parse(fs.readFileSync(path.join(ROOT, 'upstream.lock.json'), 'utf8'));
const PATCHES = JSON.parse(fs.readFileSync(path.join(ROOT, 'overlay', 'hgop', 'patches.json'), 'utf8'));
const requireFrontend = process.env.SKIP_FRONTEND !== '1';

const failures = [];
const notes = [];
function check(name, condition, detail = '') {
  if (condition) notes.push(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
  else failures.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
}
function exists(rel) { return fs.existsSync(path.join(BUILD, rel)); }
function read(rel) { return fs.readFileSync(path.join(BUILD, rel), 'utf8'); }
function syntax(rel) {
  const r = spawnSync(process.execPath, ['--check', path.join(BUILD, rel)], { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || 'syntax error').trim().slice(0, 200);
}

console.log('[verify] 检查 build/ ...');
check('build 目录存在', fs.existsSync(BUILD));

// 1. 构建信息与锁定版本一致
if (exists('BUILD-INFO.json')) {
  const info = JSON.parse(read('BUILD-INFO.json'));
  check('jackotom 版本一致', info.jackotom.tag === LOCK.jackotom.tag, `${info.jackotom.tag} / ${LOCK.jackotom.tag}`);
  check('zfdang 版本一致', info.zfdang.tag === LOCK.zfdang.tag, `${info.zfdang.tag} / ${LOCK.zfdang.tag}`);
  check('已声明源码地址', /^https?:\/\//.test(info.sourceUrl || ''), info.sourceUrl);
  notes.push(`  ℹ️  构建版本：jackotom ${info.jackotom.tag} + zfdang ${info.zfdang.tag} + overlay ${info.overlayRevision}`);
} else {
  failures.push('  ❌ 缺少 BUILD-INFO.json（sync.mjs 未成功跑完）');
}

// 2. 上游源码与播放内核
check('上游 main.js', exists('app/main.js'));
check('上游 preload.js', exists('app/preload.js'));
check('上游 package.json', exists('app/package.json'));
check('hgop 目录', exists('hgop/services/streamService.js') && exists('hgop/native/app-source.js'));
check('hgop LICENSE (AGPL)', exists('hgop/LICENSE') && read('hgop/LICENSE').includes('AFFERO GENERAL PUBLIC LICENSE'));

// 3. 补丁重放结果：每条 replace 的特征串必须出现，原始 find 必须消失
const ss = exists('hgop/services/streamService.js') ? read('hgop/services/streamService.js') : '';
for (const file of PATCHES.files) {
  for (const edit of file.edits) {
    const needle = edit.id === 'add-maxPlanCount-field'
      ? 'this.maxPlanCount = 8;'
      : 'this.plans.size > (this.maxPlanCount || 8)';
    check(`补丁 ${edit.id}`, ss.includes(needle), needle);
  }
}
check('补丁未残留上游硬编码上限', !ss.includes('while (this.plans.size > 8 ||'));

// 4. 定制层
for (const rel of ['shim/electron.js', 'server/index.js', 'Dockerfile', 'docker-compose.yml', '.dockerignore']) {
  check(`定制层 ${rel}`, exists(rel));
}
check('Dockerfile 打包 BUILD-INFO', exists('Dockerfile') && read('Dockerfile').includes('COPY BUILD-INFO.json'));
check('compose 端口 9636', exists('docker-compose.yml') && read('docker-compose.yml').includes('9636:9636'));
check('health 暴露 build 信息', exists('server/index.js') && read('server/index.js').includes('build: buildInfo'));

// 5. 语法
for (const rel of ['server/index.js', 'shim/electron.js', 'hgop/services/streamService.js',
                   'hgop/services/rangeMedia.js', 'hgop/native/app-source.js']) {
  if (!exists(rel)) { failures.push(`  ❌ 语法检查跳过（缺失）${rel}`); continue; }
  const err = syntax(rel);
  check(`语法 ${rel}`, err === null, err || '');
}

// 6. 前端产物与桥接
if (requireFrontend) {
  check('dist-react/index.html', exists('app/dist-react/index.html'));
  check('dist-react/bridge.js', exists('app/dist-react/bridge.js'));
  check('dist-react/web-compat.js', exists('app/dist-react/web-compat.js'));
  if (exists('app/dist-react/index.html')) {
    const html = read('app/dist-react/index.html');
    check('index.html 注入 bridge.js', html.includes('./bridge.js'));
    check('index.html 注入 web-compat.js', html.includes('./web-compat.js'));
    check('无内联脚本（CSP）', !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html));
  }
  if (exists('app/dist-react/bridge.js')) {
    const bridge = read('app/dist-react/bridge.js');
    const invokes = (bridge.match(/=> invoke\(/g) || []).length;
    check('桥接方法数 >= 80', invokes >= 80, `${invokes} 个`);
    check('桥接启用 hgop 播放', bridge.includes('/hgop/stream/'));
    check('桥接处理下一集预热', bridge.includes('next_vid'));
    check('桥接语法', syntax('app/dist-react/bridge.js') === null);
  }
} else {
  notes.push('  ⚠️  SKIP_FRONTEND=1：已跳过前端产物检查');
}

console.log(notes.join('\n'));
if (failures.length) {
  console.error('\n[verify] 失败：\n' + failures.join('\n'));
  process.exit(1);
}
console.log(`\n[verify] 全部通过（${notes.length} 项）`);

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
  check('dist-react/sidebar-collapse.js', exists('app/dist-react/sidebar-collapse.js'));
  if (exists('app/dist-react/index.html')) {
    const html = read('app/dist-react/index.html');
    check('index.html 注入 bridge.js', html.includes('./bridge.js'));
    check('index.html 注入 web-compat.js', html.includes('./web-compat.js'));
    check('index.html 注入 sidebar-collapse.js', html.includes('./sidebar-collapse.js'));
    check('无内联脚本（CSP）', !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html));
  }
  if (exists('app/dist-react/sidebar-collapse.js')) {
    const sc = read('app/dist-react/sidebar-collapse.js');
    check('侧栏收起语法', syntax('app/dist-react/sidebar-collapse.js') === null);
    check('侧栏收起支持自动模式', sc.includes("'auto'") && sc.includes('player-focused'));
    check('侧栏收起支持手动模式', sc.includes("'expanded'") && sc.includes("'collapsed'"));
    check('侧栏收起持久化偏好', sc.includes('hongguo:sidebar-mode'));
  }
  if (exists('app/dist-react/bridge.js')) {
    const bridge = read('app/dist-react/bridge.js');
    const invokes = (bridge.match(/=> invoke\(/g) || []).length;
    check('桥接方法数 >= 80', invokes >= 80, `${invokes} 个`);
    check('桥接启用 hgop 播放', bridge.includes('/hgop/stream/'));
    check('桥接处理下一集预热', bridge.includes('next_vid'));
    check('桥接预热后续多集', bridge.includes('next_vids') && bridge.includes('upcoming.length < 3'));
    check('桥接语法', syntax('app/dist-react/bridge.js') === null);
  }
} else {
  notes.push('  ⚠️  SKIP_FRONTEND=1：已跳过前端产物检查');
}

// 7. 空闲降级（玩客云 armv7 长时间无人使用时压低占用）
if (exists('server/index.js')) {
  const srv = read('server/index.js');
  check('空闲阈值可配置', srv.includes('HONGGUO_IDLE_SLEEP_MINUTES'));
  check('空闲降级可一键禁用', srv.includes("HONGGUO_IDLE_SLEEP !== '0'"));
  check('心跳/SSE 不计入活跃', srv.includes("pathname !== '/api/health' && pathname !== '/api/events'"));
  check('播放中不降级', srv.includes('function isBusy()') && srv.includes('hgopWarming.size > 0'));
  check('空闲后清缓存并 full GC',
    srv.includes('hgop.plans.clear()') && srv.includes('hgop.cache.clear()')
    && srv.includes('global.gc(); global.gc();'));
  check('GC 门槛已从 80MB 下调', srv.includes('before < 40 * MBYTES') && !srv.includes('before < 80 * MBYTES'));
  check('health 暴露 idle 状态', srv.includes('idle: idleSnapshot()'));
}

// 8. 连播预热（换集秒开：修掉「只预热 1 集 + 后一个被丢弃」与 90s TTL 过期）
if (exists('server/index.js')) {
  const srv = read('server/index.js');
  check('播放计划 TTL 放宽且可配置',
    srv.includes('HONGGUO_HGOP_PLAN_TTL_MIN') && srv.includes('PLAN_TTL_MS')
    && !srv.includes('Date.now() + 90000'));
  check('连播预热深度可配置/可禁用', srv.includes('HONGGUO_HGOP_WARM_DEPTH'));
  check('预热队列化（串行但不丢弃）',
    srv.includes('const warmQueue = []') && srv.includes('function runWarmQueue()')
    && !srv.includes('hgopWarming.size >= 1'));
  check('预热跳过条件检查计划有效期', srv.includes('function planUsable(') && srv.includes('expires > Date.now() + 30000'));
  check('播放地址读取后续多集', srv.includes('req.query.next_vids') && srv.includes('warmList'));
  check('health 暴露预热队列与 TTL', srv.includes('warmQueue: warmQueue.length') && srv.includes('planTtlMinutes'));
}

console.log(notes.join('\n'));
if (failures.length) {
  console.error('\n[verify] 失败：\n' + failures.join('\n'));
  process.exit(1);
}
console.log(`\n[verify] 全部通过（${notes.length} 项）`);

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
  check('dist-react/version-badge.js', exists('app/dist-react/version-badge.js'));
  check('dist-react/speed-panel.js', exists('app/dist-react/speed-panel.js'));
  if (exists('app/dist-react/index.html')) {
    const html = read('app/dist-react/index.html');
    check('index.html 注入 bridge.js', html.includes('./bridge.js'));
    check('index.html 注入 web-compat.js', html.includes('./web-compat.js'));
    check('index.html 注入 sidebar-collapse.js', html.includes('./sidebar-collapse.js'));
    check('index.html 注入 version-badge.js', html.includes('./version-badge.js'));
    check('index.html 注入 speed-panel.js', html.includes('./speed-panel.js'));
    check('增强脚本带内容指纹（改完刷新即生效）',
      /web-compat\.js\?v=[0-9a-f]{8}/.test(html)
      && /sidebar-collapse\.js\?v=[0-9a-f]{8}/.test(html)
      && /version-badge\.js\?v=[0-9a-f]{8}/.test(html)
      && /speed-panel\.js\?v=[0-9a-f]{8}/.test(html));
    check('无内联脚本（CSP）', !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html));
  }
  if (exists('app/dist-react/version-badge.js')) {
    const badge = read('app/dist-react/version-badge.js');
    check('版本角标读取 health 的上游版本', badge.includes('/api/health') && badge.includes('jackotom') && badge.includes('zfdang'));
    check('版本角标说明上游升级机制', badge.includes('上游升级需合并升级 PR'));
    check('版本信息移入设置页且不再有悬浮层',
      badge.includes('.settings-container') && badge.includes('settings-card')
      && badge.includes('MutationObserver') && !badge.includes('position:fixed'));
    check('版本角标语法', syntax('app/dist-react/version-badge.js') === null);
  }
  if (exists('app/dist-react/speed-panel.js')) {
    const speed = read('app/dist-react/speed-panel.js');
    check('倍速面板语法', syntax('app/dist-react/speed-panel.js') === null);
    check('倍速面板含滑杆、加减与预设档位',
      speed.includes("range.type = 'range'") && speed.includes('hg-speed-step')
      && speed.includes('PRESETS') && speed.includes('data-rate'));
    check('倍速面板拦截上游循环点击并复用其回调',
      speed.includes("addEventListener('click'") && speed.includes('stopPropagation()')
      && speed.includes('__reactFiber$') && speed.includes('props.onRateChange'));
    check('倍速面板不误触播放快捷键且可关闭',
      speed.includes("'dialog'") && speed.includes("event.key === 'Escape'")
      && speed.includes('function close()'));
    check('倍速面板是播放器右下角小浮层，不铺全屏黑幕或模糊',
      speed.includes('pointer-events:none;background:transparent')
      && speed.includes('right:16px;bottom:90px') && speed.includes('width:300px')
      && !speed.includes('rgba(0,0,0,.52)')
      && !speed.includes('align-items:center;justify-content:center'));
    check('倍速面板挂进播放器容器，内嵌/全屏都贴控制条',
      speed.includes("closest('.player-stage')")
      && speed.includes('is-viewport') && speed.includes('function mountMask'));
    check('播放器容器被 React 替换后面板可自动重挂',
      speed.includes('!mask.isConnected') && speed.includes('opened = false'));
    check('倍速面板点面板外可关闭且不拦截播放器点击',
      speed.includes("target.closest('.hg-speed-panel')")
      && speed.includes('if (opened) { close(); return; }')
      && speed.includes('pointer-events:auto'));
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
  check('自制增强脚本禁止缓存，改完刷新即生效',
    srv.includes('NO_STORE_FILES.has(rel)') && srv.includes("'/version-badge.js'")
    && srv.includes("'/speed-panel.js'")
    && srv.includes("'/sidebar-collapse.js'") && !srv.includes("rel === '/bridge.js' || rel === '/web-compat.js'"));
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

// 9. 首片预缓冲 + 预热避让（让「点击 → 画面」而不只是「点击 → 响应头」变快）
if (exists('server/index.js')) {
  const srv = read('server/index.js');
  check('首片预缓冲可配置/可禁用', srv.includes('HONGGUO_HGOP_PREBUF_MB') && srv.includes('PREBUF_BYTES'));
  check('预缓冲总量封顶且会淘汰', srv.includes('HONGGUO_HGOP_PREBUF_LIMIT_MB') && srv.includes('function trimPrebuf()'));
  check('plan.read 包装保持 Range 字节数语义',
    srv.includes('function attachPrebuffer(') && srv.includes('data.subarray(from, headEnd + 1)')
    && srv.includes('yield* rawRead.call('));
  check('预缓冲由预热队列串行填充', srv.includes('await fillPrebuffer(plan, job.key'));
  check('预缓冲有超时保护', srv.includes('AbortSignal.timeout(8000)'));
  check('预缓冲计入 health 与空闲降级',
    srv.includes('prebuf: {') && srv.includes('prebufTotalBytes()') && srv.includes('prebuf.clear()'));
  check('预热避让首播窗口',
    srv.includes('HONGGUO_HGOP_WARM_DELAY_MS') && srv.includes('WARM_TRIGGER_BYTES')
    && !srv.includes('}, 800).unref?.()'));
  check('预热等首片实际写出后触发',
    srv.includes('const originalWrite = res.write') && srv.includes('written >= WARM_TRIGGER_BYTES'));
  const deployCompose = fs.readFileSync(path.join(ROOT, 'deploy', 'docker-compose.yml'), 'utf8');
  check('部署 compose 暴露新配置',
    deployCompose.includes('HONGGUO_HGOP_PREBUF_MB') && deployCompose.includes('HONGGUO_HGOP_WARM_DELAY_MS'));
}

// 10. 上游版本可见性 + 不再「静静落后」的检测机制
{
  const srv = exists('server/index.js') ? read('server/index.js') : '';
  check('空闲降级清理新版内核的额外缓存',
    srv.includes('fragmentCache') && srv.includes('prefetchTimers') && srv.includes('streamControllers'));
  const badge = exists('web/version-badge.js') ? read('web/version-badge.js') : '';
  check('版本角标读取 build 字段', badge.includes("'/api/health'") && badge.includes('build.jackotom'));
  check('版本信息作为设置页卡片挂载并自愈重挂',
    badge.includes('function ensureCard()') && badge.includes('container.appendChild(card)')
    && badge.includes('MutationObserver') && badge.includes('.settings-header'));
  check('版本卡片复用界面同款样式，不留悬浮层',
    badge.includes('settings-card') && badge.includes('proxy-status-row')
    && badge.includes('var(--danger)') && !badge.includes('position:fixed')
    && !badge.includes('badge.style.left'));
  const fe = read('web/build-frontend.mjs');
  check('前端构建注入版本角标',
    fe.includes("'version-badge.js'") && fe.includes("html.includes('version-badge.js')"));
  check('前端构建注入倍速面板并刷新指纹',
    fe.includes("'speed-panel.js'") && fe.includes('V_SPEED')
    && fe.includes("html.includes('speed-panel.js')"));
  const checkWf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'check-upstream.yml'), 'utf8');
  check('每次 push 也检查上游', checkWf.includes('push:') && checkWf.includes('paths-ignore'));
  const buildWf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-image.yml'), 'utf8');
  check('出镜像时提醒上游落后',
    buildWf.includes('上游版本落后提醒') && buildWf.includes('changed=true'));
  const up = fs.readFileSync(path.join(ROOT, 'deploy', 'upgrade.sh'), 'utf8');
  check('升级脚本回显上游版本',
    up.includes('应用上游：') && up.includes('jackotom') && up.includes('zfdang'));
  // 不硬编码具体版本号：上游一天发好几版，锁文件每次升级都改，断言只校验格式，
  // 「lock 与 BUILD-INFO 一致」由前面的断言负责。
  check('锁文件版本格式有效',
    /^v\d+/.test(LOCK.jackotom.tag) && /^v\d+/.test(LOCK.zfdang.tag),
    `${LOCK.jackotom.tag} / ${LOCK.zfdang.tag}`);
}

// 11. 上游取源故障容错（2026-11-10 官方空响应事件）
{
  const srv = exists('server/index.js') ? read('server/index.js') : '';
  check('容错可一键禁用且参数可配置',
    srv.includes("HONGGUO_UPSTREAM_GUARD !== '0'") && srv.includes('HONGGUO_UPSTREAM_FAIL_THRESHOLD')
    && srv.includes('HONGGUO_UPSTREAM_RETRY_MAX') && srv.includes('HONGGUO_UPSTREAM_COOLDOWN_MAX_MS'));
  check('区分上游故障与本地/客户端错误',
    srv.includes('function isUpstreamFault(') && srv.includes("'EMPTY_RESPONSE'")
    && srv.includes("error.name === 'AbortError'") && srv.includes('noteLocalError'));
  check('播放侧自动重试且有总时限',
    srv.includes('async function guardedGetPlan(') && srv.includes('GUARD.retryMax')
    && srv.includes('GUARD.retryDeadlineMs') && srv.includes('guardedGetPlan(rawGetPlan, args, purpose)'));
  check('预热侧标记 purpose 且熔断让路',
    srv.includes("withPlanPurpose('warm'") && srv.includes('UPSTREAM_COOLDOWN')
    && srv.includes('if (upstreamCooling())'));
  check('熔断暂停预热队列并指数退避',
    srv.includes('function pauseWarmQueue()') && srv.includes('warmQueue.length = 0')
    && srv.includes('upstream.cooldownMs * 2') && srv.includes('GUARD.cooldownMaxMs'));
  check('播放成功立即解封',
    srv.includes('function noteUpstreamSuccess()') && srv.includes('if (upstream.warmingPaused) resumeWarmQueue(0)'));
  check('health 暴露故障分类',
    srv.includes('upstream: upstreamSnapshot()') && srv.includes("blame = 'upstream'")
    && srv.includes("blame = 'us'") && srv.includes('cooldownRemainingSec'));
  const badge = exists('web/version-badge.js') ? read('web/version-badge.js') : '';
  check('版本卡片轮询上游状态',
    badge.includes('info.upstream') && badge.includes('setInterval(refresh, POLL_MS)')
    && badge.includes("document.addEventListener('visibilitychange'"));
  check('故障时设置按钮橙点提示且恢复后还原',
    badge.includes('data-hg-alert') && badge.includes('红果接口繁忙')
    && badge.includes("removeAttribute('data-hg-alert')") && badge.includes('function markNav()'));
  const compose = fs.readFileSync(path.join(ROOT, 'deploy', 'docker-compose.yml'), 'utf8');
  const envExample = fs.readFileSync(path.join(ROOT, 'deploy', '.env.example'), 'utf8');
  check('部署配置暴露容错开关',
    compose.includes('HONGGUO_UPSTREAM_GUARD') && envExample.includes('HONGGUO_UPSTREAM_RETRY_BASE_MS'));
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  check('文档说明容错与故障分类',
    readme.includes('上游取源故障容错') && readme.includes('"blame": "upstream"'));
  const up = fs.readFileSync(path.join(ROOT, 'deploy', 'upgrade.sh'), 'utf8');
  check('升级脚本回显取源状态', up.includes('取源状态：'));
  check('服务端语法', syntax('server/index.js') === null);
  check('版本角标语法', syntax('web/version-badge.js') === null);
}

console.log(notes.join('\n'));
if (failures.length) {
  console.error('\n[verify] 失败：\n' + failures.join('\n'));
  process.exit(1);
}
console.log(`\n[verify] 全部通过（${notes.length} 项）`);

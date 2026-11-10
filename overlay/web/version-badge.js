/**
 * 版本与运行状态：设置页里的一张原生卡片（Web 版独立层，绝不修改上游源码）。
 *
 * 演进：最早是固定 left:10px;bottom:8px 的左下角角标，先后压住过侧栏底部的
 * 「收起侧栏」按钮和主内容区的海报。2026-11-10 起改成设置页内的 .settings-card，
 * 直接复用上游的 settings-card / settings-group / settings-label /
 * proxy-status-row / settings-hint / btn 与主题 CSS 变量，页面任何位置都不再有
 * 悬浮层；侧栏 footer 原本就有一行上游版本号，两者互不重复。文件名沿用
 * version-badge.js，避免改动构建注入、no-store 白名单和部署脚本。
 *
 * 为什么还需要它：容器镜像的 `latest` 更新不等于上游源码升级 —— 只有自动构建库
 * 合并了 upstream.lock.json 的升级 PR 并重新出镜像，应用版本才会变。这里同时把
 * 2026-11-10 加的「一眼分清是谁坏了」搬进设置页：读 /api/health 的 upstream
 * 字段，故障时显示故障归属与自动重试进度，恢复后自动还原。
 *
 * - 只在设置页渲染：React 首次挂载、页面重渲染或节点被替换时由 MutationObserver 补挂；
 * - 取源故障时给侧栏 / 竖屏导航的「设置」按钮加一个 ::after 小橙点（不插元素、
 *   不占布局、不遮挡），点进去看详情；恢复后自动移除；
 * - 页面加载时请求一次 /api/health，之后每 30s 轮询（该接口不计入活跃度，
 *   不会阻止空闲降级）；切回标签页时立即刷新一次；请求失败保留上一次状态；
 * - 外部脚本 + 动态 <style>，符合首页 CSP（script-src 'self' / style-src 'unsafe-inline'）。
 */
(function () {
  'use strict';

  var CARD_ID = 'hg-version-card';
  var STYLE_ID = 'hg-version-info-css';
  var POLL_MS = 30000;

  // 只补上游没有的少量样式，配色/圆角/边框全部走上游主题变量。
  var CSS = [
    '.hg-version-card > .settings-group{border-bottom:0}',
    '.hg-version-card .proxy-status-text{white-space:normal;overflow:visible;text-overflow:clip}',
    '.proxy-dot.hg-version-dot-bad{background:var(--danger)}',
    '.hg-version-rows{margin-top:2px}',
    '.hg-version-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;',
    'padding:7px 0;border-bottom:1px solid var(--border-muted);',
    'font-size:12px;line-height:1.7;color:var(--text-secondary)}',
    '.hg-version-row:last-child{border-bottom:0}',
    '.hg-version-row b{font-weight:600;color:var(--text-primary);text-align:right;',
    'word-break:break-all;font-variant-numeric:tabular-nums}',
    // 故障时「设置」按钮右上角的小橙点：纯伪元素，不改变布局也不遮挡任何控件
    '.sidebar-item[data-hg-alert="1"],.compact-navigation button[data-hg-alert="1"]{position:relative}',
    '.sidebar-item[data-hg-alert="1"]::after,.compact-navigation button[data-hg-alert="1"]::after{',
    'content:"";position:absolute;top:7px;right:9px;width:8px;height:8px;border-radius:50%;',
    'background:var(--danger);pointer-events:none}'
  ].join('');

  var card = null;         // 设置页里的卡片，ensureCard() 里创建
  var dot = null;
  var summary = null;
  var hint = null;
  var alertBox = null;
  var detail = null;
  var toggleBtn = null;
  var refreshBtn = null;
  var expanded = false;
  var lastInfo = null;
  var alertDirty = true;   // 故障状态变化后需要重新标记导航按钮
  var frame = 0;

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function isBad() {
    return !!(lastInfo && lastInfo.upstream && lastInfo.upstream.ok === false);
  }

  function addRow(key, value) {
    var row = el('div', 'hg-version-row');
    row.appendChild(el('span', '', key));
    row.appendChild(el('b', '', value));
    detail.appendChild(row);
  }

  /** 与设置页其它卡片完全同构：section.settings-card > div.settings-group。 */
  function buildCard() {
    var section = el('section', 'settings-card hg-version-card');
    section.id = CARD_ID;
    section.setAttribute('aria-label', '版本与运行状态');
    var group = el('div', 'settings-group');
    group.appendChild(el('span', 'settings-label', '版本与运行状态'));

    var status = el('div', 'proxy-status-row');
    dot = el('span', 'proxy-dot proxy-dot-off');
    summary = el('span', 'proxy-status-text', '版本检查中…');
    refreshBtn = el('button', 'btn btn-outline btn-sm', '刷新');
    refreshBtn.type = 'button';
    refreshBtn.addEventListener('click', function () {
      refreshBtn.disabled = true;
      refresh(function () { refreshBtn.disabled = false; });
    });
    status.appendChild(dot);
    status.appendChild(summary);
    status.appendChild(refreshBtn);
    group.appendChild(status);

    hint = el('p', 'settings-hint',
      '镜像更新只拉已构建版本；上游升级需合并升级 PR 后重新出镜像。');
    group.appendChild(hint);

    alertBox = el('p', 'alert alert-error hg-version-alert');
    alertBox.setAttribute('role', 'alert');
    alertBox.hidden = true;
    group.appendChild(alertBox);

    var actions = el('div', 'preset-row');
    toggleBtn = el('button', 'btn btn-outline btn-sm', '详细信息');
    toggleBtn.type = 'button';
    toggleBtn.addEventListener('click', function () {
      expanded = !expanded;
      detail.hidden = !expanded;
      toggleBtn.textContent = expanded ? '收起详情' : '详细信息';
    });
    actions.appendChild(toggleBtn);
    group.appendChild(actions);

    detail = el('div', 'hg-version-rows');
    detail.hidden = true;
    group.appendChild(detail);

    section.appendChild(group);
    return section;
  }

  /** 设置页可能还没访问（visited 里才有），也可能被 React 重渲染替换掉。 */
  function ensureCard() {
    var container = document.querySelector('.main-content[data-page="settings"] .settings-container')
      || document.querySelector('.settings-container');
    if (!container) return;
    // settings 还在「加载中…」时先不插，避免容器换成正式内容时闪一下。
    if (!container.querySelector('.settings-header')
      && /加载中/.test(container.textContent || '')) return;
    if (card && card.parentNode === container && card.isConnected) return;
    if (!card) card = buildCard();
    container.appendChild(card);
    if (lastInfo) render(lastInfo);
  }

  /** 故障时只改导航按钮的一个属性，不往侧栏里塞任何元素。 */
  function markNav() {
    var bad = isBad();
    var tip = bad ? ((lastInfo.upstream && lastInfo.upstream.hint) || '取源异常，点设置查看') : '';
    var nodes = document.querySelectorAll(
      '.sidebar-footer .sidebar-item, .compact-navigation button');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var label = (node.getAttribute('title') || '') + ' ' + (node.textContent || '');
      if (label.indexOf('设置') < 0) continue;
      if (Object.prototype.hasOwnProperty.call(node.dataset, 'hgOrigTitle') === false) {
        node.dataset.hgOrigTitle = node.getAttribute('title') || '';
      }
      if (bad) {
        node.setAttribute('data-hg-alert', '1');
        node.setAttribute('title', tip);
      } else {
        node.removeAttribute('data-hg-alert');
        if (node.dataset.hgOrigTitle) node.setAttribute('title', node.dataset.hgOrigTitle);
        else node.removeAttribute('title');
      }
    }
  }

  function schedule() {
    if (frame) return;
    frame = window.requestAnimationFrame(function () {
      frame = 0;
      ensureCard();
      // 导航按钮被 React 替换掉时把橙点补回来；正常态只依赖 alertDirty。
      if (alertDirty || (isBad() && !document.querySelector('[data-hg-alert="1"]'))) {
        alertDirty = false;
        markNav();
      }
    });
  }

  function render(info) {
    lastInfo = info;
    alertDirty = true;
    var build = info && info.build;
    var st = info && info.upstream;
    var bad = !!st && st.ok === false;

    var jackotom = build && build.jackotom && build.jackotom.tag ? build.jackotom.tag : '';
    var zfdang = build && build.zfdang && build.zfdang.tag ? build.zfdang.tag : '';
    var overlay = build && build.overlayRevision ? build.overlayRevision : '?';
    var versionLabel = jackotom
      ? 'v' + String(jackotom).replace(/^v/, '')
        + (zfdang ? ' · 内核 ' + String(zfdang).replace(/^v/, '') : '')
      : '版本未知';

    if (!card) { schedule(); return; }   // ensureCard() 建好后会用 lastInfo 补渲染

    while (detail.firstChild) detail.removeChild(detail.firstChild);
    dot.className = 'proxy-dot ' + (bad ? 'hg-version-dot-bad'
      : info ? 'proxy-dot-on' : 'proxy-dot-off');
    var local = !!(st && st.blame === 'us');
    if (bad) {
      summary.textContent = local ? '播放服务异常 · 请看日志' : '红果接口繁忙 · 自动重试中';
      alertBox.textContent = (st.hint || st.state || '取源异常')
        + '　故障归属：' + (local ? '本机服务' : '红果上游接口')
        + '　官方恢复后播放会自动成功。';
      alertBox.hidden = false;
    } else {
      summary.textContent = versionLabel;
      alertBox.textContent = '';
      alertBox.hidden = true;
    }
    hint.textContent = '镜像更新只拉已构建版本；上游升级需合并升级 PR 后重新出镜像。';

    addRow('应用上游', (jackotom || '?') + ' · jackotom/hongguo-drama');
    addRow('播放内核', (zfdang || '?') + ' · zfdang/hongguo-open-player');
    addRow('定制层修订', overlay);
    if (build && build.builtAt) {
      addRow('构建时间', String(build.builtAt).replace('T', ' ').slice(0, 19) + ' UTC');
    }
    addRow('取源状态', bad ? (st.hint || st.state || '异常') : '正常');
    if (bad) {
      addRow('故障归属', local ? '本机服务' : '红果上游接口');
      addRow('连续失败 / 自动重试', (st.failures || 0) + ' 次 / ' + (st.retries || 0) + ' 次');
      if (st.cooldownRemainingSec > 0) {
        addRow('预热退避剩余', st.cooldownRemainingSec + ' 秒（期间不重复取址）');
      }
    }
    addRow('说明', '上游升级需合并升级 PR 后重新出镜像');
    schedule();
  }

  function refresh(done) {
    var finish = function () { if (typeof done === 'function') done(); };
    try {
      fetch('/api/health', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (info) { if (info) render(info); else schedule(); finish(); })
        .catch(function () { /* 保留上一次状态，短暂断网不闪红 */ schedule(); finish(); });
    } catch (_) { schedule(); finish(); }
  }

  ready(function () {
    if (!document.getElementById(STYLE_ID)) {
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // childList 负责设置页首次挂载与 React 替换节点；class 变化不需要重新测量，
    // 因为卡片是文档流里的普通元素，随容器自动排布。
    if (typeof MutationObserver === 'function') {
      var mo = new MutationObserver(schedule);
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
    schedule();
    refresh();
    // /api/health 属于心跳类请求，不刷新活跃度，轮询不会阻止空闲降级。
    setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refresh();
    });
  });
})();

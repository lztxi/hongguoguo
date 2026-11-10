/**
 * 构建版本角标 + 取源状态提示（Web 版独立层，绝不修改上游源码）。
 *
 * 为什么需要：容器镜像的 `latest` 更新不等于上游源码升级 —— 只有自动构建库合并了
 * upstream.lock.json 的升级 PR 并重新出镜像，应用版本才会变。以前只能查
 * /api/health 才能确认，容易误以为「更新了镜像却没跟上上游」。
 * 2026-11-10 红果官方取址接口短暂返回空响应，第三方播放器集体报障；角标顺带
 * 承担「一眼分清是谁坏了」的职责：读 /api/health 的 upstream 字段，故障时提示
 * 正在自动重试，接口恢复后自动还原版本号（无需手动刷新页面）。
 *
 * - 页面加载时请求一次 /api/health，之后每 30s 轮询（该接口不计入活跃度，
 *   不会阻止空闲降级）；切回标签页时立即刷新一次；
 * - 外部脚本 + 动态 <style>，符合首页 CSP（script-src 'self' / style-src 'unsafe-inline'）；
 * - 挂在 body 下的独立元素，不侵入 React 的 #root，也不会被重渲染冲掉；
 * - 颜色继承 body，浅色/深色界面都能看清；请求失败时保留上一次状态。
 */
(function () {
  'use strict';

  var BOX_ID = 'hg-version-badge';
  var STYLE_ID = 'hg-version-badge-css';
  var POLL_MS = 30000;
  var CSS = [
    '.hg-version-badge{',
    'position:fixed;left:10px;bottom:8px;z-index:9998;max-width:300px;',
    'font:11px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
    'color:inherit;background:rgba(127,127,127,.14);border:1px solid rgba(127,127,127,.28);',
    'border-radius:6px;padding:2px 8px;cursor:pointer;opacity:.55;',
    'transition:opacity .18s ease;user-select:none;box-sizing:border-box;',
    '}',
    '.hg-version-badge:hover,.hg-version-badge:focus{opacity:1;outline:none}',
    '.hg-version-badge[data-open="1"]{opacity:1}',
    '.hg-version-badge[data-alert="1"]{',
    'opacity:1;color:#e08a3c;border-color:rgba(224,138,60,.65);',
    'background:rgba(224,138,60,.12);font-weight:600;',
    '}',
    '.hg-version-detail{',
    'margin-top:6px;padding-top:6px;border-top:1px solid rgba(127,127,127,.28);',
    'white-space:pre-line;word-break:break-all;cursor:default;font-weight:400;color:inherit;',
    '}',
    '@media (max-width:640px){.hg-version-badge{max-width:200px;font-size:10px}}'
  ].join('');

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function line(parent, text) {
    var div = document.createElement('div');
    div.textContent = text;
    parent.appendChild(div);
  }

  ready(function () {
    if (document.getElementById(BOX_ID)) return;

    if (!document.getElementById(STYLE_ID)) {
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    var box = document.createElement('div');
    box.id = BOX_ID;
    box.className = 'hg-version-badge';
    box.setAttribute('role', 'button');
    box.tabIndex = 0;
    box.title = '点击查看构建版本详情';

    var label = document.createElement('div');
    label.textContent = '版本检查中…';
    box.appendChild(label);

    var detail = document.createElement('div');
    detail.className = 'hg-version-detail';
    detail.hidden = true;
    box.appendChild(detail);
    document.body.appendChild(box);

    function toggle() {
      var open = box.getAttribute('data-open') === '1';
      box.setAttribute('data-open', open ? '0' : '1');
      detail.hidden = open;
    }
    box.addEventListener('click', toggle);
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });

    var versionLabel = '版本未知';

    function render(info) {
      var build = info && info.build;
      while (detail.firstChild) detail.removeChild(detail.firstChild);
      if (build) {
        var jackotom = (build.jackotom && build.jackotom.tag) || '?';
        var zfdang = (build.zfdang && build.zfdang.tag) || '?';
        var overlay = build.overlayRevision || '?';
        versionLabel = 'v' + String(jackotom).replace(/^v/, '') + ' · 内核 ' + String(zfdang).replace(/^v/, '');
        line(detail, '应用上游：' + jackotom + '（jackotom/hongguo-drama）');
        line(detail, '播放内核：' + zfdang + '（zfdang/hongguo-open-player）');
        line(detail, '定制层：' + overlay);
        if (build.builtAt) line(detail, '构建时间：' + String(build.builtAt).replace('T', ' ').slice(0, 19) + ' UTC');
        line(detail, '镜像更新只拉已构建版本；上游升级需合并升级 PR 后重新出镜像。');
      }

      var st = info && info.upstream;
      var bad = !!st && st.ok === false;
      if (bad) {
        var local = st.blame === 'us';
        label.textContent = local ? '播放服务异常 · 请看日志' : '红果接口繁忙 · 自动重试中';
        box.setAttribute('data-alert', '1');
        box.title = st.hint || '取源异常';
        line(detail, '取源状态：' + (st.hint || st.state));
        line(detail, '故障归属：' + (local ? '本机服务' : '红果上游接口') +
          '　连续失败 ' + (st.failures || 0) + ' 次　自动重试 ' + (st.retries || 0) + ' 次');
        if (st.cooldownRemainingSec > 0) {
          line(detail, '预热退避剩余 ' + st.cooldownRemainingSec + ' 秒，期间不会重复取址。');
        }
        line(detail, '官方恢复后播放会自动成功，角标也会自动还原。');
      } else {
        label.textContent = versionLabel;
        box.setAttribute('data-alert', '0');
        box.title = '点击查看构建版本详情';
        if (st) line(detail, '取源状态：正常');
      }
    }

    function refresh() {
      try {
        fetch('/api/health', { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (info) { if (info) render(info); })
          .catch(function () { /* 保留上一次状态，短暂断网不闪红 */ });
      } catch (_) { /* 忽略 */ }
    }

    refresh();
    // /api/health 属于心跳类请求，不刷新活跃度，轮询不会阻止空闲降级。
    setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refresh();
    });
  });
})();

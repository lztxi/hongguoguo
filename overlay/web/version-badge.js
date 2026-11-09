/**
 * 构建版本角标（Web 版独立层，绝不修改上游源码）。
 *
 * 为什么需要：容器镜像的 `latest` 更新不等于上游源码升级 —— 只有自动构建库合并了
 * upstream.lock.json 的升级 PR 并重新出镜像，应用版本才会变。以前只能查
 * /api/health 才能确认，容易误以为「更新了镜像却没跟上上游」。
 *
 * - 页面加载时只请求一次 /api/health（该接口不计入活跃度，不会阻止空闲降级）；
 * - 外部脚本 + 动态 <style>，符合首页 CSP（script-src 'self' / style-src 'unsafe-inline'）；
 * - 挂在 body 下的独立元素，不侵入 React 的 #root，也不会被重渲染冲掉；
 * - 颜色继承 body，浅色/深色界面都能看清；失败时优雅降级为「版本未知」。
 */
(function () {
  'use strict';

  var BOX_ID = 'hg-version-badge';
  var STYLE_ID = 'hg-version-badge-css';
  var CSS = [
    '.hg-version-badge{',
    'position:fixed;left:10px;bottom:8px;z-index:9998;max-width:280px;',
    'font:11px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
    'color:inherit;background:rgba(127,127,127,.14);border:1px solid rgba(127,127,127,.28);',
    'border-radius:6px;padding:2px 8px;cursor:pointer;opacity:.55;',
    'transition:opacity .18s ease;user-select:none;box-sizing:border-box;',
    '}',
    '.hg-version-badge:hover,.hg-version-badge:focus{opacity:1;outline:none}',
    '.hg-version-badge[data-open="1"]{opacity:1}',
    '.hg-version-detail{',
    'margin-top:6px;padding-top:6px;border-top:1px solid rgba(127,127,127,.28);',
    'white-space:pre-line;word-break:break-all;cursor:default;',
    '}',
    '@media (max-width:640px){.hg-version-badge{max-width:180px;font-size:10px}}'
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

    function render(info) {
      var build = info && info.build;
      if (!build) { label.textContent = '版本未知'; return; }
      var jackotom = (build.jackotom && build.jackotom.tag) || '?';
      var zfdang = (build.zfdang && build.zfdang.tag) || '?';
      var overlay = build.overlayRevision || '?';
      label.textContent = 'v' + String(jackotom).replace(/^v/, '') + ' · 内核 ' + String(zfdang).replace(/^v/, '');
      line(detail, '应用上游：' + jackotom + '（jackotom/hongguo-drama）');
      line(detail, '播放内核：' + zfdang + '（zfdang/hongguo-open-player）');
      line(detail, '定制层：' + overlay);
      if (build.builtAt) line(detail, '构建时间：' + String(build.builtAt).replace('T', ' ').slice(0, 19) + ' UTC');
      line(detail, '镜像更新只拉已构建版本；上游升级需合并升级 PR 后重新出镜像。');
    }

    try {
      fetch('/api/health', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(render)
        .catch(function () { label.textContent = '版本未知'; });
    } catch (_) {
      label.textContent = '版本未知';
    }
  });
})();

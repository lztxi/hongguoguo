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
 * - 颜色继承 body，浅色/深色界面都能看清；请求失败时保留上一次状态；
 * - 位置实时跟随侧栏右边缘：写死在 left:10px 会压住侧栏底部的「收起侧栏」
 *   按钮（侧栏宽度在 214/190/164/62px 间变化，竖屏布局还会整条隐藏），
 *   因此改为测量 .sidebar 的右边界，把角标放到侧栏右侧的内容区里。
 */
(function () {
  'use strict';

  var BOX_ID = 'hg-version-badge';
  var STYLE_ID = 'hg-version-badge-css';
  var POLL_MS = 30000;
  var GAP = 10;                 // 与侧栏右缘 / 屏幕左缘的间距
  var MAX_W = 300;
  var badge = null;             // 角标 DOM，ready() 里赋值
  var observedSidebar = null;   // 已绑定 ResizeObserver 的侧栏节点
  var sidebarObserver = null;
  var placeFrame = 0;
  var CSS = [
    // left / max-width 的初始值只是兜底：place() 会用内联样式按侧栏宽度覆盖。
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

  function schedulePlace() {
    if (placeFrame) return;
    placeFrame = window.requestAnimationFrame(function () {
      placeFrame = 0;
      place();
    });
  }

  /**
   * 侧栏底部有「收起侧栏」控件，角标固定在 left:10px 会直接盖住它。
   * 侧栏宽度随展开 / 收起 / 窗口宽度在 214、190、164、62px 间变化，
   * 竖屏布局（.layout-portrait）还会整条 display:none —— 所以不能写死
   * 任何宽度，直接量 .sidebar 的右边缘最稳：侧栏可见就贴在它右侧的内容
   * 区里，侧栏隐藏就回落到屏幕左下角。
   */
  function place() {
    if (!badge) return;
    var side = document.querySelector('.sidebar');
    var left = GAP;
    if (side) {
      var r = side.getBoundingClientRect();
      var cs = window.getComputedStyle(side);
      if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') {
        left = Math.round(r.right) + GAP;
      }
    }
    if (!isFinite(left)) left = GAP;
    // 极窄视口兜底：至少给角标留 110px，别把它顶出屏幕右侧
    left = Math.max(GAP, Math.min(left, Math.max(GAP, window.innerWidth - 110)));
    var cap = window.innerWidth <= 640 ? 200 : MAX_W;
    var maxW = Math.max(110, Math.min(cap, window.innerWidth - left - GAP));
    var l = left + 'px';
    var m = maxW + 'px';
    if (badge.style.left !== l) badge.style.left = l;
    if (badge.style.maxWidth !== m) badge.style.maxWidth = m;
    watchSidebar(side);
  }

  /** 侧栏收起有 180ms 宽度动画，ResizeObserver 才能逐帧跟随而不跳变。 */
  function watchSidebar(side) {
    if (typeof ResizeObserver !== 'function') return;
    if (side === observedSidebar) return;
    if (sidebarObserver) sidebarObserver.disconnect();
    observedSidebar = side;
    sidebarObserver = null;
    if (!side) return;
    sidebarObserver = new ResizeObserver(schedulePlace);
    sidebarObserver.observe(side);
  }

  function bindPlacement() {
    window.addEventListener('resize', schedulePlace, { passive: true });
    if (typeof MutationObserver !== 'function') { schedulePlace(); return; }
    // 收起 class 挂在 <html>，竖屏 / 播放页 class 挂在 .app-layout；
    // childList 负责 React 首次挂载或替换侧栏后重新测量。
    // attributeFilter 只盯 class，place() 写 style 不会造成自触发死循环。
    var mo = new MutationObserver(schedulePlace);
    mo.observe(document.documentElement, {
      attributes: true, attributeFilter: ['class'], childList: true, subtree: true
    });
    schedulePlace();
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
    badge = box;
    bindPlacement();

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
      schedulePlace();  // 每 30s 顺带校准一次位置，作为观察器漏事件的兜底
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

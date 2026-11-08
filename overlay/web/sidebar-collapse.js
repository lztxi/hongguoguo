/**
 * 侧边栏收起增强（Web 版独立层，绝不修改上游源码）。
 *
 * 设计要点：
 * - 状态挂在 <html> 的 class 上，React 只管 #root 内部，不会覆盖；
 * - 脚本在 <head> 同步执行，React 挂载前就设好初始 class，避免闪一下展开态；
 * - 三种模式：auto（默认，窗口窄或进入播放页自动收起）/ expanded / collapsed；
 * - 偏好写 localStorage，刷新与多标签页同步；
 * - 只注入一个控件区与一段 CSS，导航项靠原生 title 做图标态提示；
 * - 所有 DOM 写入幂等，配合 MutationObserver 后不会形成回调死循环。
 *
 * CSP：style-src 允许 'unsafe-inline'，脚本本身是外部文件（script-src 'self'）。
 */
(function () {
  'use strict';

  var KEY = 'hongguo:sidebar-mode';
  var NARROW = 1200;                  // 窗口宽度小于此值时自动收起
  var MODES = ['auto', 'expanded', 'collapsed'];
  var STYLE_ID = 'hg-sidebar-collapse-css';
  var root = document.documentElement;
  var frame = 0;
  var layoutObserver = null;
  var observedLayouts = (typeof WeakSet === 'function') ? new WeakSet() : null;
  var mode = readMode();

  function readMode() {
    try {
      var v = window.localStorage.getItem(KEY);
      return MODES.indexOf(v) >= 0 ? v : 'auto';
    } catch (_) { return 'auto'; }
  }

  function saveMode(v) {
    mode = v;
    try { window.localStorage.setItem(KEY, v); } catch (_) { /* 禁用存储时仍可本次会话使用 */ }
  }

  function isNarrow() { return window.innerWidth < NARROW; }

  function isPlayerFocused() {
    var app = document.querySelector('.app-layout');
    return !!(app && app.classList.contains('player-focused'));
  }

  function shouldCollapse() {
    if (mode === 'collapsed') return true;
    if (mode === 'expanded') return false;
    return isNarrow() || isPlayerFocused();
  }

  /** 幂等写 class：值没变就不碰 DOM，避免 MutationObserver 自我触发。 */
  function setRootClass(name, on) {
    if (root.classList.contains(name) !== on) root.classList.toggle(name, on);
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function setAttr(node, name, value) {
    if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
  }

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.sidebar { transition: width .18s ease; }',
      'html.hg-sidebar-collapsed .sidebar { width: 62px !important; }',
      'html.hg-sidebar-collapsed .sidebar-brand { justify-content: center; padding: 13px 0 26px; }',
      'html.hg-sidebar-collapsed .sidebar-brand > div:not(.logo) { display: none; }',
      'html.hg-sidebar-collapsed .sidebar-group-label { display: none; }',
      'html.hg-sidebar-collapsed .sidebar-menu { padding: 0 8px; }',
      'html.hg-sidebar-collapsed .sidebar-item { justify-content: center; gap: 0; padding: 10px 0; }',
      'html.hg-sidebar-collapsed .sidebar-item > span { display: none; }',
      'html.hg-sidebar-collapsed .sidebar-footer { padding: 12px 8px; }',
      'html.hg-sidebar-collapsed .footer-note { display: none; }',

      '.hg-sidebar-controls { display: flex; align-items: center; gap: 6px; margin-top: 8px; }',
      '.hg-side-btn { display: flex; align-items: center; justify-content: center; gap: 6px;',
      '  height: 30px; padding: 0 8px; border: 1px solid var(--border); border-radius: 8px;',
      '  background: transparent; color: var(--text-secondary); font-size: 12px;',
      '  cursor: pointer; -webkit-app-region: no-drag; }',
      '.hg-side-btn:hover { background: var(--sidebar-hover); }',
      '.hg-side-btn-main { flex: 1 1 auto; min-width: 0; }',
      '.hg-side-btn-auto { flex: 0 0 32px; width: 32px; padding: 0; }',
      '.hg-side-btn-auto.is-on { color: var(--accent-text); border-color: var(--accent-border);',
      '  background: var(--accent-soft, transparent); }',
      '.hg-side-icon { font-size: 15px; line-height: 1; }',
      '.hg-side-btn-auto .hg-side-icon { font-size: 11px; font-weight: 700; }',
      '.hg-side-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      'html.hg-sidebar-collapsed .hg-sidebar-controls { flex-direction: column; gap: 6px; }',
      'html.hg-sidebar-collapsed .hg-side-btn { width: 100%; flex: 0 0 auto; padding: 0; }',
      'html.hg-sidebar-collapsed .hg-side-label { display: none; }'
    ].join('\n');
    (document.head || root).appendChild(style);
  }

  function ensureControls() {
    var footer = document.querySelector('.sidebar .sidebar-footer');
    if (!footer || footer.querySelector('.hg-sidebar-controls')) return;

    var box = document.createElement('div');
    box.className = 'hg-sidebar-controls';

    var main = document.createElement('button');
    main.type = 'button';
    main.className = 'hg-side-btn hg-side-btn-main';
    main.innerHTML = '<span class="hg-side-icon">«</span><span class="hg-side-label">收起侧栏</span>';

    var auto = document.createElement('button');
    auto.type = 'button';
    auto.className = 'hg-side-btn hg-side-btn-auto';
    auto.innerHTML = '<span class="hg-side-icon">A</span>';

    main.addEventListener('click', function () {
      // 点击即转为手动模式，并反转当前收起状态
      saveMode(shouldCollapse() ? 'expanded' : 'collapsed');
      schedule();
    });
    auto.addEventListener('click', function () {
      // 手动 → 自动；自动 → 手动（保持当前展开/收起状态，避免跳变）
      saveMode(mode === 'auto' ? (shouldCollapse() ? 'collapsed' : 'expanded') : 'auto');
      schedule();
    });

    box.appendChild(main);
    box.appendChild(auto);
    footer.appendChild(box);
  }

  /** 收起后只剩图标，用原生 title 做悬浮提示。 */
  function applyTitles() {
    var items = document.querySelectorAll('.sidebar .sidebar-item');
    for (var i = 0; i < items.length; i++) {
      var btn = items[i];
      if (btn.getAttribute('title')) continue;
      var span = btn.querySelector('span');
      var text = span ? span.textContent.trim() : '';
      if (text) setAttr(btn, 'title', text);
    }
  }

  function updateControls(collapsed) {
    var main = document.querySelector('.hg-side-btn-main');
    var auto = document.querySelector('.hg-side-btn-auto');
    if (main) {
      setText(main.querySelector('.hg-side-icon'), collapsed ? '»' : '«');
      setText(main.querySelector('.hg-side-label'), collapsed ? '展开侧栏' : '收起侧栏');
      var mainTitle = (collapsed ? '展开侧栏' : '收起侧栏') + '（Alt+S）';
      setAttr(main, 'title', mainTitle);
      setAttr(main, 'aria-label', mainTitle);
      setAttr(main, 'aria-pressed', String(collapsed));
    }
    if (auto) {
      var on = mode === 'auto';
      if (auto.classList.contains('is-on') !== on) auto.classList.toggle('is-on', on);
      var autoTitle = on
        ? '自动收起已开启：窗口较窄或进入播放页时自动收起；点击改为手动'
        : '自动收起已关闭：由你手动控制；点击恢复自动';
      setAttr(auto, 'title', autoTitle);
      setAttr(auto, 'aria-label', autoTitle);
      setAttr(auto, 'aria-pressed', String(on));
    }
  }

  function apply() {
    var collapsed = shouldCollapse();
    setRootClass('hg-sidebar-collapsed', collapsed);
    setRootClass('hg-sidebar-auto', mode === 'auto');
    ensureControls();
    applyTitles();
    updateControls(collapsed);
    bindLayoutObserver();
  }

  function schedule() {
    if (frame) return;
    frame = window.requestAnimationFrame(function () {
      frame = 0;
      apply();
    });
  }

  /** 单独观察 .app-layout 的 class，才能感知播放页 / 竖屏切换。 */
  function bindLayoutObserver() {
    if (!layoutObserver || typeof MutationObserver !== 'function') return;
    var app = document.querySelector('.app-layout');
    if (!app) return;
    if (observedLayouts && observedLayouts.has(app)) return;
    layoutObserver.observe(app, { attributes: true, attributeFilter: ['class'] });
    if (observedLayouts) observedLayouts.add(app);
  }

  function boot() {
    injectCss();
    apply();

    if (typeof MutationObserver === 'function') {
      // 只观察子节点变化，用于重新注入控件 / 给新导航项补 title。
      // 属性变化交给 bindLayoutObserver 单独观察，避免捕获本脚本自己的写入。
      var bodyObserver = new MutationObserver(function () { schedule(); });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
      layoutObserver = new MutationObserver(function () { schedule(); });
      bindLayoutObserver();
    }

    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('keydown', function (e) {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 's' || e.key === 'S')) {
        var tag = (e.target && e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
        e.preventDefault();
        saveMode(shouldCollapse() ? 'expanded' : 'collapsed');
        schedule();
      }
    });
    window.addEventListener('storage', function (e) {
      if (e.key !== KEY) return;
      mode = readMode();
      schedule();
    });
  }

  // 立即设定初始 class（此时 React 还没挂载，先靠窗口宽度判断，避免闪烁）
  setRootClass('hg-sidebar-collapsed', mode === 'collapsed' || (mode === 'auto' && isNarrow()));
  setRootClass('hg-sidebar-auto', mode === 'auto');

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

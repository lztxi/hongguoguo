/**
 * 播放速度面板（Web 版独立层，绝不修改上游源码）。
 *
 * 上游桌面端只有一个 .player-controls-rate 按钮：点一下 +0.25、到 4 倍回 1 倍，
 * 没法精细调速；移动端则是一个 0.25 步长的 select。这里把它换成截图那样的
 * 「播放速度」面板：数值 + 可拖动滑杆 + 加减按钮 + 常用档位胶囊。
 *
 * - 面板贴在播放器右下角、控制条上方的约 300px 半透明小浮层：定位层挂进
 *   .player-stage（position:relative），完整覆盖播放器但不铺黑幕、不做整屏模糊，
 *   pointer-events:none 让视频画面与其它控件照常可见可点；内嵌播放器 / 全屏播放
 *   都能贴住控制条，不需要写死视口坐标；关闭由 document 捕获阶段的「点面板外」负责；
 * - 在 document 捕获阶段拦下倍速按钮 / select 的点击，阻止上游的 +0.25 与原生下拉，
 *   改为打开/关闭面板（React 18 的事件委托挂在 #root，捕获阶段拦截不会触发它的 onClick）；
 * - 写回状态优先用 React fiber 上 PlayerControls 的 onRateChange（就是 Player.jsx 的
 *   changePlaybackRate）：React 状态、按钮文字、video.playbackRate、localStorage
 *   偏好与提示一次性同步；fiber 不可用时回退直接设 video.playbackRate，
 *   Player.jsx 的 onRateChange 监听会把它同步回 React；
 * - 拖动滑杆用 (value, false, false) 避免每帧写盘 / 弹提示，松手才 (value, true, true)
 *   提交；加减步长 0.1、滑杆 0.05，范围沿用上游的 0.25~4；
 * - role="dialog" 让上游 ignoresPlaybackShortcut 自动忽略面板内按键，
 *   不会误触快进 / 切集快捷键；Esc、返回按钮、点面板外或再点倍速按钮均可关闭；
 * - 外部（快捷键、更多菜单里的 select）改速时，用捕获阶段的 ratechange 同步面板数值；
 * - 外部脚本 + 动态 <style>，符合首页 CSP（script-src 'self' / style-src 'unsafe-inline'）。
 */
(function () {
  'use strict';

  var MIN = 0.25;
  var MAX = 4;
  var STEP = 0.05;       // 滑杆步长，可到 1.60x 这样的精细值
  var NUDGE = 0.1;       // 加减按钮步长
  var PRESETS = [
    { value: 1, label: '1.0', note: '正常' },
    { value: 1.25, label: '1.25', note: '' },
    { value: 1.5, label: '1.5', note: '' },
    { value: 2, label: '2.0', note: '' },
    { value: 3, label: '3.0', note: '' }
  ];
  var STYLE_ID = 'hg-speed-panel-css';
  var MASK_ID = 'hg-speed-mask';

  var CSS = [
    // 定位层挂在 .player-stage 内（relative），铺满播放器但完全透明、不接收事件：
    // 既不压暗视频，也不挡播放器其它控件；只有小面板自己 pointer-events:auto。
    // 找不到播放器容器时加 is-viewport 兜底，退回视口定位。
    '.hg-speed-mask{position:absolute;inset:0;z-index:10000;',
    'pointer-events:none;background:transparent}',
    '.hg-speed-mask.is-viewport{position:fixed}',
    '.hg-speed-mask[hidden]{display:none}',
    // 控制条占播放器底部约 83px，面板底部留 90px 正好贴在它上沿。
    '.hg-speed-panel{position:absolute;right:16px;bottom:90px;',
    'width:300px;max-width:calc(100vw - 24px);box-sizing:border-box;',
    'padding:11px 16px 14px;border-radius:12px;',
    'background:rgba(20,20,23,.72);color:#fff;',
    'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);',
    'border:1px solid rgba(255,255,255,.09);',
    'box-shadow:0 10px 30px rgba(0,0,0,.38);',
    'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
    'pointer-events:auto;user-select:none;-webkit-user-select:none;',
    'animation:hg-speed-in .16s ease-out}',
    '@keyframes hg-speed-in{',
    'from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    '.hg-speed-head{display:flex;align-items:center;gap:6px;',
    'padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.14)}',
    '.hg-speed-back{width:24px;height:24px;flex:0 0 24px;border:0;border-radius:50%;',
    'background:transparent;color:#fff;font-size:20px;line-height:1;cursor:pointer}',
    '.hg-speed-back:hover{background:rgba(255,255,255,.12)}',
    '.hg-speed-head span{font-size:13px;font-weight:600}',
    '.hg-speed-value{text-align:right;font-size:22px;font-weight:700;',
    'padding:9px 2px 7px;font-variant-numeric:tabular-nums;letter-spacing:.3px}',
    '.hg-speed-value small{font-size:.62em;font-weight:500;margin-left:2px;opacity:.85}',
    '.hg-speed-slider-row{display:flex;align-items:center;gap:10px}',
    '.hg-speed-step{width:26px;height:26px;flex:0 0 26px;border:0;border-radius:50%;',
    'background:rgba(255,255,255,.14);color:#fff;font-size:17px;line-height:1;cursor:pointer}',
    '.hg-speed-step:hover{background:rgba(255,255,255,.24)}',
    '.hg-speed-range{flex:1;min-width:0;height:3px;border-radius:2px;outline:none;',
    '-webkit-appearance:none;appearance:none;cursor:pointer}',
    '.hg-speed-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;',
    'width:14px;height:14px;border:0;border-radius:50%;background:#fff;',
    'box-shadow:0 1px 5px rgba(0,0,0,.45);cursor:pointer}',
    '.hg-speed-range::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;',
    'background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.45);cursor:pointer}',
    // 打开面板会自动聚焦滑杆：别用 outline 画一整圈外框（不像原生倍速页），
    // 焦点提示改放在把手的光晕上，键盘用户仍看得见。
    '.hg-speed-range:focus-visible{outline:none}',
    '.hg-speed-range:focus-visible::-webkit-slider-thumb{',
    'box-shadow:0 0 0 4px rgba(255,255,255,.22),0 1px 5px rgba(0,0,0,.45)}',
    '.hg-speed-range:focus-visible::-moz-range-thumb{',
    'box-shadow:0 0 0 4px rgba(255,255,255,.22),0 1px 5px rgba(0,0,0,.45)}',
    '.hg-speed-presets{display:flex;gap:6px;justify-content:space-between;margin-top:16px}',
    '.hg-speed-preset{flex:1;min-width:0;display:flex;flex-direction:column;',
    'align-items:center;gap:4px}',
    '.hg-speed-preset button{width:100%;padding:7px 0;border:0;border-radius:999px;',
    'background:rgba(255,255,255,.14);color:#fff;font:600 12px/1.2 inherit;cursor:pointer;',
    'font-variant-numeric:tabular-nums}',
    '.hg-speed-preset button:hover{background:rgba(255,255,255,.24)}',
    '.hg-speed-preset button.is-active{background:#fff;color:#17171a}',
    '.hg-speed-preset small{font-size:10px;color:rgba(255,255,255,.55);min-height:13px}',
    '@media (max-width:520px){',
    '.hg-speed-panel{right:8px;bottom:78px;width:min(300px,calc(100vw - 20px));',
    'padding:9px 12px 12px}',
    '.hg-speed-value{font-size:20px;padding:7px 2px 6px}',
    '.hg-speed-presets{gap:4px;margin-top:13px}.hg-speed-preset button{font-size:11px}}'
  ].join('');

  var mask = null;
  var valueNum = null;
  var range = null;
  var presetButtons = [];
  var opened = false;
  var current = 1;
  var trigger = null;

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

  function clamp(value) {
    if (!isFinite(value)) return 1;
    return Math.max(MIN, Math.min(MAX, Math.round(value / STEP) * STEP));
  }

  /** 从 React 18 fiber 上找 PlayerControls 的 rate / onRateChange（不依赖播放器全局）。 */
  function rateContext() {
    var node = document.querySelector('.player-controls-rate');
    if (!node) return null;
    var fiberKey = Object.keys(node).filter(function (k) { return k.indexOf('__reactFiber$') === 0; })[0];
    var fiber = fiberKey ? node[fiberKey] : null;
    var guard = 0;
    while (fiber && guard++ < 40) {
      var props = fiber.memoizedProps;
      if (props && typeof props.onRateChange === 'function') {
        return { handler: props.onRateChange, rate: Number(props.rate) };
      }
      fiber = fiber.return;
    }
    return null;
  }

  function currentRate() {
    var ctx = rateContext();
    if (ctx && isFinite(ctx.rate) && ctx.rate > 0) return clamp(ctx.rate);
    var node = document.querySelector('.player-controls-rate');
    if (node) {
      var parsed = parseFloat(node.textContent || '');
      if (isFinite(parsed) && parsed > 0) return clamp(parsed);
    }
    var video = document.querySelector('video');
    return video && video.playbackRate ? clamp(video.playbackRate) : 1;
  }

  /** value 写回播放器；commit=false 用于拖动中，不弹提示也不写 localStorage。 */
  function apply(value, commit) {
    value = clamp(value);
    render(value);
    var ctx = rateContext();
    if (ctx) {
      // changePlaybackRate(value, notify, persist)
      ctx.handler(value, !!commit, !!commit);
      return;
    }
    var video = document.querySelector('video');
    if (video) video.playbackRate = value;   // 触发 Player.jsx 的 onRateChange 同步回去
  }

  function render(value) {
    value = clamp(value);
    current = value;
    valueNum.textContent = value.toFixed(2);
    range.value = String(value);
    var pct = ((value - MIN) / (MAX - MIN) * 100).toFixed(1);
    range.style.background = 'linear-gradient(90deg,#fff 0%,#fff ' + pct + '%,'
      + 'rgba(255,255,255,.28) ' + pct + '%,rgba(255,255,255,.28) 100%)';
    range.setAttribute('aria-valuetext', value.toFixed(2) + ' 倍');
    for (var i = 0; i < presetButtons.length; i++) {
      var btn = presetButtons[i];
      var on = Math.abs(Number(btn.getAttribute('data-rate')) - value) < 0.001;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function buildPanel() {
    mask = el('div', 'hg-speed-mask');
    mask.id = MASK_ID;
    mask.hidden = true;
    var panel = el('div', 'hg-speed-panel');
    // 非模态浮层：role=dialog 只为让上游 ignoresPlaybackShortcut 忽略面板内按键，
    // 不设 aria-modal，视频与其它控件仍可正常交互。
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '播放速度');

    var head = el('div', 'hg-speed-head');
    var back = el('button', 'hg-speed-back', '\u2039');
    back.type = 'button';
    back.setAttribute('aria-label', '关闭播放速度设置');
    back.addEventListener('click', close);
    head.appendChild(back);
    head.appendChild(el('span', '', '播放速度'));
    panel.appendChild(head);

    var value = el('div', 'hg-speed-value');
    valueNum = el('span', '', '1.00');
    value.appendChild(valueNum);
    value.appendChild(el('small', '', 'x'));
    panel.appendChild(value);

    var slider = el('div', 'hg-speed-slider-row');
    var minus = el('button', 'hg-speed-step', '\u2212');
    minus.type = 'button';
    minus.setAttribute('aria-label', '降低播放速度 0.1 倍');
    minus.addEventListener('click', function () { apply(current - NUDGE, true); });
    range = document.createElement('input');
    range.type = 'range';
    range.className = 'hg-speed-range';
    range.min = String(MIN);
    range.max = String(MAX);
    range.step = String(STEP);
    range.setAttribute('aria-label', '播放速度');
    range.addEventListener('input', function () { apply(Number(range.value), false); });
    range.addEventListener('change', function () { apply(Number(range.value), true); });
    var plus = el('button', 'hg-speed-step', '+');
    plus.type = 'button';
    plus.setAttribute('aria-label', '提高播放速度 0.1 倍');
    plus.addEventListener('click', function () { apply(current + NUDGE, true); });
    slider.appendChild(minus);
    slider.appendChild(range);
    slider.appendChild(plus);
    panel.appendChild(slider);

    var presets = el('div', 'hg-speed-presets');
    PRESETS.forEach(function (item) {
      var unit = el('div', 'hg-speed-preset');
      var btn = el('button', '', item.label);
      btn.type = 'button';
      btn.setAttribute('data-rate', String(item.value));
      btn.setAttribute('aria-label', '设为 ' + item.label + ' 倍速');
      btn.addEventListener('click', function () { apply(item.value, true); });
      unit.appendChild(btn);
      unit.appendChild(el('small', '', item.note));
      presets.appendChild(unit);
      presetButtons.push(btn);
    });
    panel.appendChild(presets);
    panel.title = '拖动滑杆可在 0.25× – 4.00× 间精细调节';

    mask.appendChild(panel);
    // 初始挂 body 兜底（React 可能还没渲染出 .player-stage），open() 时移进播放器。
    mask.classList.add('is-viewport');
    document.body.appendChild(mask);
  }

  /**
   * 面板要贴的是播放器右下角而不是视口右下角：.player-stage 是 relative 容器，
   * 把定位层挂进去，内嵌播放器、剧场模式、全屏播放都能自动对齐控制条上沿。
   * React 重渲染换掉 stage 节点时，下次 open 会重新挂载。
   */
  function mountMask(node) {
    var stage = node && node.closest ? node.closest('.player-stage') : null;
    var host = stage || document.body;
    if (mask.parentNode !== host) host.appendChild(mask);
    mask.classList.toggle('is-viewport', !stage);
  }

  function open(node) {
    if (opened) return;
    trigger = node;
    mountMask(node);
    if (node && node.tagName !== 'SELECT') node.title = '播放速度设置：拖动滑杆精细调节';
    opened = true;
    mask.hidden = false;
    render(currentRate());
    // 焦点交给滑杆：方向键可直接微调；面板 role=dialog 会让上游忽略播放快捷键。
    window.setTimeout(function () { try { range.focus(); } catch (_) { /* 忽略 */ } }, 0);
  }

  function close() {
    if (!opened) return;
    opened = false;
    mask.hidden = true;
    if (trigger && trigger.isConnected) { try { trigger.focus(); } catch (_) { /* 忽略 */ } }
    trigger = null;
    // 关闭后让播放器控制条重新出现（面板打开期间它可能已自动隐藏）。
    try { document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })); } catch (_) { /* 忽略 */ }
  }

  function rateControl(node) {
    if (!node || !node.closest) return null;
    return node.closest('.player-controls-rate');
  }

  ready(function () {
    if (!document.getElementById(STYLE_ID)) {
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    buildPanel();

    // select 的下拉由 mousedown 打开，先挡掉；click 再统一交给面板。
    document.addEventListener('mousedown', function (event) {
      var node = rateControl(event.target);
      if (node && node.tagName === 'SELECT') event.preventDefault();
    }, true);
    // touchstart 也要挡，否则移动端仍会弹原生选择器。
    document.addEventListener('touchstart', function (event) {
      var node = rateControl(event.target);
      if (node && node.tagName === 'SELECT') event.preventDefault();
    }, { capture: true, passive: false });
    // 透明定位层不接收点击，改在捕获阶段关面板：点视频、进度条、其它控件时
    // 面板收起，同时不拦截那次点击本身（不 preventDefault / stopPropagation）。
    document.addEventListener('click', function (event) {
      if (!opened) return;
      var target = event.target;
      if (target && target.closest && (target.closest('.hg-speed-panel')
        || target.closest('.player-controls-rate'))) return;
      close();
    }, true);
    document.addEventListener('click', function (event) {
      var node = rateControl(event.target);
      if (!node) return;
      event.preventDefault();
      event.stopPropagation();
      // React 换掉 .player-stage（切集 / 切布局）会连带卸载定位层，重置状态后重挂，
      // 否则会出现「面板不见了但仍算打开、要连点两次才能再开」。
      if (opened && !mask.isConnected) opened = false;
      if (opened) { close(); return; }   // 再点倍速按钮即收起
      open(node);
    }, true);

    // 快捷键或「更多播放选项」里的 select 改速时同步面板（ratechange 不冒泡，用捕获）。
    document.addEventListener('ratechange', function (event) {
      if (!opened || !event.target || event.target.tagName !== 'VIDEO') return;
      render(event.target.playbackRate);
    }, true);

    document.addEventListener('keydown', function (event) {
      if (opened && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }, true);
  });
})();

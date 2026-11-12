/**
 * 播放速度面板（Web 版独立层，绝不修改上游源码）。
 *
 * 上游桌面端只有一个 .player-controls-rate 按钮：点一下 +0.25、到 4 倍回 1 倍，
 * 没法精细调速；移动端则是一个 0.25 步长的 select。这里把它换成截图那样的
 * 「播放速度」面板：大数值 + 可拖动滑杆 + 加减按钮 + 常用档位胶囊。
 *
 * - 在 document 捕获阶段拦下倍速按钮 / select 的点击，阻止上游的 +0.25 与原生下拉，
 *   改为打开面板（React 18 的事件委托挂在 #root，捕获阶段拦截不会触发它的 onClick）；
 * - 写回状态优先用 React fiber 上 PlayerControls 的 onRateChange（就是 Player.jsx 的
 *   changePlaybackRate）：React 状态、按钮文字、video.playbackRate、localStorage
 *   偏好与提示一次性同步；fiber 不可用时回退直接设 video.playbackRate，
 *   Player.jsx 的 onRateChange 监听会把它同步回 React；
 * - 拖动滑杆用 (value, false, false) 避免每帧写盘 / 弹提示，松手才 (value, true, true)
 *   提交；加减步长 0.1、滑杆 0.05，范围沿用上游的 0.25~4；
 * - role="dialog" 让上游 ignoresPlaybackShortcut 自动忽略面板内按键，
 *   不会误触快进 / 切集快捷键；Esc、返回按钮、点遮罩均可关闭；
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
    '.hg-speed-mask{position:fixed;inset:0;z-index:10000;display:flex;',
    'align-items:center;justify-content:center;padding:18px;',
    'background:rgba(0,0,0,.52);backdrop-filter:blur(3px);',
    '-webkit-backdrop-filter:blur(3px);animation:hg-speed-in .16s ease-out}',
    '.hg-speed-mask[hidden]{display:none}',
    '@keyframes hg-speed-in{from{opacity:0}to{opacity:1}}',
    '.hg-speed-panel{width:min(440px,100%);box-sizing:border-box;',
    'padding:16px 22px 24px;border-radius:18px;',
    'background:rgba(28,28,30,.96);color:#fff;',
    'box-shadow:0 18px 60px rgba(0,0,0,.55);',
    'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
    'user-select:none;-webkit-user-select:none}',
    '.hg-speed-head{display:flex;align-items:center;gap:8px;',
    'padding-bottom:13px;border-bottom:1px solid rgba(255,255,255,.14)}',
    '.hg-speed-back{width:32px;height:32px;flex:0 0 32px;border:0;border-radius:50%;',
    'background:transparent;color:#fff;font-size:26px;line-height:1;cursor:pointer}',
    '.hg-speed-back:hover{background:rgba(255,255,255,.12)}',
    '.hg-speed-head span{font-size:15px;font-weight:600}',
    '.hg-speed-value{text-align:center;font-size:36px;font-weight:700;',
    'padding:26px 0 22px;font-variant-numeric:tabular-nums;letter-spacing:.5px}',
    '.hg-speed-value small{font-size:.5em;font-weight:500;margin-left:2px;opacity:.85}',
    '.hg-speed-slider-row{display:flex;align-items:center;gap:14px}',
    '.hg-speed-step{width:38px;height:38px;flex:0 0 38px;border:0;border-radius:50%;',
    'background:rgba(255,255,255,.14);color:#fff;font-size:22px;line-height:1;cursor:pointer}',
    '.hg-speed-step:hover{background:rgba(255,255,255,.24)}',
    '.hg-speed-range{flex:1;min-width:0;height:4px;border-radius:2px;outline:none;',
    '-webkit-appearance:none;appearance:none;cursor:pointer}',
    '.hg-speed-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;',
    'width:18px;height:18px;border:0;border-radius:50%;background:#fff;',
    'box-shadow:0 1px 5px rgba(0,0,0,.45);cursor:pointer}',
    '.hg-speed-range::-moz-range-thumb{width:18px;height:18px;border:0;border-radius:50%;',
    'background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.45);cursor:pointer}',
    // 打开面板会自动聚焦滑杆：别用 outline 画一整圈外框（不像原生倍速页），
    // 焦点提示改放在把手的光晕上，键盘用户仍看得见。
    '.hg-speed-range:focus-visible{outline:none}',
    '.hg-speed-range:focus-visible::-webkit-slider-thumb{',
    'box-shadow:0 0 0 5px rgba(255,255,255,.22),0 1px 5px rgba(0,0,0,.45)}',
    '.hg-speed-range:focus-visible::-moz-range-thumb{',
    'box-shadow:0 0 0 5px rgba(255,255,255,.22),0 1px 5px rgba(0,0,0,.45)}',
    '.hg-speed-presets{display:flex;gap:8px;justify-content:space-between;margin-top:28px}',
    '.hg-speed-preset{flex:1;min-width:0;display:flex;flex-direction:column;',
    'align-items:center;gap:6px}',
    '.hg-speed-preset button{width:100%;padding:9px 0;border:0;border-radius:999px;',
    'background:rgba(255,255,255,.14);color:#fff;font:600 14px/1.2 inherit;cursor:pointer;',
    'font-variant-numeric:tabular-nums}',
    '.hg-speed-preset button:hover{background:rgba(255,255,255,.24)}',
    '.hg-speed-preset button.is-active{background:#fff;color:#17171a}',
    '.hg-speed-preset small{font-size:11px;color:rgba(255,255,255,.55);min-height:14px}',
    '.hg-speed-foot{margin:18px 0 0;text-align:center;font-size:11px;',
    'color:rgba(255,255,255,.42)}',
    '@media (max-width:420px){',
    '.hg-speed-panel{padding:14px 16px 20px}.hg-speed-value{font-size:32px;padding:20px 0 18px}',
    '.hg-speed-presets{gap:5px;margin-top:22px}.hg-speed-preset button{font-size:13px}}'
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
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
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
    panel.appendChild(el('p', 'hg-speed-foot', '拖动滑杆可在 0.25× – 4.00× 间精细调节'));

    mask.appendChild(panel);
    mask.addEventListener('click', function (event) {
      if (event.target === mask) close();
    });
    document.body.appendChild(mask);
  }

  function open(node) {
    if (opened) return;
    trigger = node;
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
    document.addEventListener('click', function (event) {
      var node = rateControl(event.target);
      if (!node) return;
      event.preventDefault();
      event.stopPropagation();
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

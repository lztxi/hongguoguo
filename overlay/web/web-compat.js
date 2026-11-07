/**
 * Web 版浏览器兼容引导（必须在 React 入口之前同步执行）。
 *
 * 桌面版跑在 file://，属于 secure context；通过 http://<局域网 IP> 访问时不是安全上下文，
 * Chromium 会隐藏 crypto.randomUUID 和 navigator.clipboard。上游渲染层在播放器初始化时
 * 直接调 crypto.randomUUID() 生成 requestId，缺了会抛 TypeError，导致视频永远拿不到 src。
 */
(function () {
  'use strict';

  if (window.crypto && typeof window.crypto.randomUUID !== 'function') {
    const cryptoObj = window.crypto;
    const randomUUID = function () {
      const bytes = new Uint8Array(16);
      cryptoObj.getRandomValues(bytes); // getRandomValues 是唯一不要求安全上下文的 Web Crypto API
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    };
    try {
      Object.defineProperty(cryptoObj, 'randomUUID', { configurable: true, writable: true, value: randomUUID });
    } catch (_) {
      Object.defineProperty(window, 'crypto', { configurable: true, value: Object.assign(Object.create(cryptoObj), { randomUUID }) });
    }
  }

  if (!navigator.clipboard) {
    let lastText = '';
    const writeText = async text => {
      lastText = String(text == null ? '' : text);
      try {
        const ta = document.createElement('textarea');
        ta.value = lastText;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch (_) { /* 复制不可用时至少保留到 readText */ }
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText, readText: async () => lastText },
    });
  }

  /**
   * 解码方式自动选择。
   *
   * 红果片源是 HEVC (hvc1)。实测：Windows 上的 Edge / Chrome 只要有系统 HEVC 解码器，
   * 原生 <video> 就能硬解播放（1080×1920、readyState 4），比 WASM 软解流畅得多且不占 CPU；
   * 而 Firefox / 老机器 / 无硬解环境仍需要软解兜底。
   *
   * 注意 canPlayType 的坑：不带 profile 的 'codecs="hvc1"' 在部分 Chromium 上返回空字符串，
   * 但 'codecs="hvc1.1.6.L93.B0"' 返回 'probably'，实际又能播。因此必须多种写法都探一遍。
   * 另外用 --disable-gpu 启动的无头浏览器会禁用系统解码器，不能作为用户环境的判断依据。
   */
  function detectHevc() {
    try {
      const v = document.createElement('video');
      const codecs = [
        'video/mp4; codecs="hvc1.1.6.L93.B0"',
        'video/mp4; codecs="hev1.1.6.L93.B0"',
        'video/mp4; codecs="hvc1"',
        'video/mp4; codecs="hev1"'
      ];
      return codecs.some(c => !!v.canPlayType(c));
    } catch (_) {
      return false;
    }
  }

  try {
    const ls = window.localStorage;
    const DECODE_KEY = 'hongguo:software-decode';
    const BOOT_KEY = 'hongguo:decode-boot';
    // 老版本引导脚本无条件写入过 true；升级后按真实解码能力纠正一次。
    // 用户手动选过 'false'（原生）时保持不动；之后所有手动选择都不再被覆盖。
    if (ls.getItem(BOOT_KEY) !== '2') {
      const prev = ls.getItem(DECODE_KEY);
      if (prev === null || prev === 'true') {
        ls.setItem(DECODE_KEY, detectHevc() ? 'false' : 'true');
      }
      ls.setItem(BOOT_KEY, '2');
    }
  } catch (_) { /* localStorage 被禁用时用户仍可手动切换 */ }
})();

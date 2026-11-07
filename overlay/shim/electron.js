'use strict';
/**
 * Electron 兼容层 —— 让上游 main.js 原样在纯 Node 中启动。
 *
 * 设计要点：
 *  - 不修改上游任何一行业务代码；所有 Electron API 由本文件模拟。
 *  - ipcMain.handle 注册进 handlers，由 server 通过 HTTP 分发调用。
 *  - webContents.send 变成 SSE 广播（setEventSink 注入）。
 *  - protocol.handle 注册进 streamHandlers，由 server 伪装自定义 scheme 的 Request 调用。
 *  - 窗口 / 菜单 / 快捷键 / 通知等桌面专有能力一律降级为 no-op。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

// 本机开发：<root>/app；容器：上游源码直接铺在 /app，用环境变量指定。
const APP_DIR = process.env.HONGGUO_APP_DIR || path.resolve(__dirname, '..', 'app');
const DATA_DIR = process.env.HONGGUO_DATA_DIR || path.resolve(__dirname, '..', 'data');
for (const dir of [DATA_DIR, path.join(DATA_DIR, 'downloads'), path.join(DATA_DIR, 'account')]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 只读挂载时由外部保证 */ }
}

const noop = () => {};
let eventSink = noop;
const handlers = new Map();
const streamHandlers = new Map();
const windows = [];
const ENTRY_URL = pathToFileURL(path.join(APP_DIR, 'dist-react', 'index.html')).href;

/** 万能 no-op 对象：未知方法返回空函数，避免逐个补 Electron API。 */
function stub(extra = {}) {
  const target = Object.assign({ on: noop, once: noop, off: noop, removeListener: noop }, extra);
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then' || prop === 'toJSON') return undefined; // 别被当成 thenable / 可序列化值
      return noop;
    },
    set(obj, prop, value) { obj[prop] = value; return true; },
  });
}

function makeSession() {
  return stub({
    // Electron 的 session.fetch 走 Chromium 网络栈；headless 下用 Node 全局 fetch 等价替代。
    // 账号模块（accountWebRequest）依赖它返回标准 Response，缺了会报 "reading 'headers'"。
    fetch: (...args) => fetch(...args),
    setProxy: async () => {},
    clearAuthCache: async () => {},
    closeAllConnections: async () => {},
    clearStorageData: async () => {},
    setPermissionRequestHandler: noop,
    setPermissionCheckHandler: noop,
    setUserAgent: noop,
    getUserAgent: () => 'Mozilla/5.0',
    resolveProxy: async () => 'direct://',
    cookies: stub({ get: async () => [], remove: async () => {}, set: async () => {} }),
    webRequest: stub(),
  });
}

function makeWebContents() {
  const wc = stub({
    send: (channel, payload) => { try { eventSink(channel, payload); } catch (err) { console.error('[shim] eventSink:', err.message); } },
    isDestroyed: () => false,
    mainFrame: { url: ENTRY_URL },
    getURL: () => ENTRY_URL,
    loadURL: noop,
    loadFile: noop,
    setWindowOpenHandler: noop,
    session: makeSession(),
    openDevTools: noop,
    insertCSS: async () => '',
    executeJavaScript: async () => null,
  });
  return wc;
}

function makeWindow() {
  const win = stub({
    webContents: makeWebContents(),
    contentView: stub({
      addChildView: noop,
      getBounds: () => ({ x: 0, y: 0, width: 1100, height: 750 }),
    }),
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    isFocused: () => true,
    getBounds: () => ({ x: 0, y: 0, width: 1100, height: 750 }),
    getSize: () => [1100, 750],
    setBounds: noop,
    setContentSize: noop,
    setMenuBarVisibility: noop,
    setAlwaysOnTop: noop,
    setOpacity: noop,
    setSkipTaskbar: noop,
    setTitle: noop,
    show: noop, hide: noop, focus: noop, close: noop,
    loadURL: noop, loadFile: noop,
  });
  windows.push(win);
  return win;
}

class BrowserWindow { constructor() { return makeWindow(); } }
BrowserWindow.getAllWindows = () => windows.slice();
BrowserWindow.fromWebContents = () => null;
BrowserWindow.fromId = () => null;

class WebContentsView { constructor() { return stub({ webContents: makeWebContents(), setBounds: noop }); } }

// ---------- app ----------
const pathMap = {
  userData: DATA_DIR,
  appData: DATA_DIR,
  sessionData: path.join(DATA_DIR, 'session'),
  downloads: path.join(DATA_DIR, 'downloads'),
  temp: os.tmpdir(),
  home: os.homedir(),
  desktop: DATA_DIR,
  documents: DATA_DIR,
  videos: path.join(DATA_DIR, 'downloads'),
  pictures: DATA_DIR,
  cache: path.join(DATA_DIR, 'cache'),
  logs: path.join(DATA_DIR, 'logs'),
  exe: process.execPath,
  module: APP_DIR,
};
const app = new EventEmitter();
Object.assign(app, {
  getPath: name => pathMap[name] || DATA_DIR,
  setPath: (name, value) => { pathMap[name] = value; },
  getVersion: () => { try { return require(path.join(APP_DIR, 'package.json')).version; } catch { return '6.1.0'; } },
  getName: () => '红果短剧',
  setName: noop,
  getAppPath: () => APP_DIR,
  requestSingleInstanceLock: () => true,
  releaseSingleInstanceLock: noop,
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  // 保持 false：让 resolveFfmpeg 回退到 PATH，容器内使用系统 ffmpeg
  isPackaged: false,
  quit: () => console.warn('[shim] app.quit() 已忽略（Web 服务常驻）'),
  exit: noop,
  relaunch: noop,
  focus: noop,
  hide: noop,
  setAboutPanelOptions: noop,
  setLoginItemSettings: noop,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  getLocale: () => 'zh-CN',
  getSystemLocale: () => 'zh-CN',
  getPreferredSystemLanguages: () => ['zh-CN'],
  dock: stub(),
  commandLine: { hasSwitch: () => false, getSwitchValue: () => '', appendSwitch: noop, removeSwitch: noop },
});

// ---------- safeStorage（AES-256-GCM，密钥落数据目录） ----------
function storageKey() {
  const file = path.join(DATA_DIR, 'safe-storage.key');
  try {
    const raw = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    if (raw.length === 32) return raw;
  } catch { /* 首次运行 */ }
  const key = crypto.randomBytes(32);
  try { fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 }); } catch { /* 只读时退化为进程内密钥 */ }
  return key;
}
let secretKey;
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'aes-256-gcm',
  encryptString(value) {
    secretKey ||= storageKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
    const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  },
  decryptString(input) {
    secretKey ||= storageKey();
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  },
};

// ---------- net（Electron net.request 的 fetch 版模拟） ----------
function netRequest(options = {}) {
  const request = new EventEmitter();
  let aborted = false;
  request.abort = () => { aborted = true; };
  request.end = () => {
    void (async () => {
      try {
        const response = await fetch(options.url, {
          headers: options.headers || {},
          signal: AbortSignal.timeout(12000),
        });
        if (aborted) return;
        const incoming = new EventEmitter();
        incoming.statusCode = response.status;
        incoming.headers = Object.fromEntries(response.headers.entries());
        request.emit('response', incoming);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (aborted) return;
        incoming.emit('data', bytes);
        incoming.emit('end');
      } catch (error) {
        if (!aborted) request.emit('error', error);
      }
    })();
    return request;
  };
  return request;
}
const net = { request: netRequest, fetch: (...args) => fetch(...args), isOnline: () => true };

// ---------- 其余桌面 API ----------
const ipcMain = {
  handle(channel, handler) { handlers.set(channel, handler); },
  removeHandler(channel) { handlers.delete(channel); },
  on: noop, once: noop, removeListener: noop,
};
const protocol = {
  registerSchemesAsPrivileged: noop,
  handle(scheme, handler) { streamHandlers.set(scheme, handler); },
  unhandle(scheme) { streamHandlers.delete(scheme); },
};
const defaultSession = makeSession();
const session = Object.assign(makeSession(), {
  defaultSession,
  fromPartition: () => makeSession(),
});
const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: '' }),
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showErrorBox: (title, content) => console.error(`[shim][dialog] ${title}: ${content}`),
};
const shell = {
  openPath: async () => '',
  openExternal: async () => {},
  showItemInFolder: noop,
  trashItem: async () => {},
  beep: noop,
};
const Menu = {
  setApplicationMenu: noop,
  buildFromTemplate: () => stub(),
  getApplicationMenu: () => null,
};
const Notification = class NotificationStub {
  constructor() { return stub({ show: noop, close: noop, on: noop }); }
};
Notification.isSupported = () => false;
const display = { workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const screen = {
  getPrimaryDisplay: () => display,
  getDisplayMatching: () => display,
  getAllDisplays: () => [display],
  getDisplayNearestPoint: () => display,
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  on: noop,
};
const globalShortcut = { register: () => true, unregister: noop, unregisterAll: noop, isRegistered: () => false };

const updater = new EventEmitter();
Object.assign(updater, {
  netSession: makeSession(),
  autoDownload: false,
  autoInstallOnAppQuit: false,
  channel: 'latest',
  currentVersion: { version: '6.1.0' },
  logger: null,
  setFeedURL: noop,
  checkForUpdates: async () => null,
  downloadUpdate: async () => [],
  quitAndInstall: noop,
  cancelDownload: noop,
});

const shim = {
  app, BrowserWindow, BaseWindow: BrowserWindow, View: WebContentsView, WebContentsView,
  globalShortcut, ipcMain, dialog, shell, session, protocol, Menu, Notification,
  screen, safeStorage, net, clipboard: stub({ readText: () => '', writeText: noop }),
  nativeImage: stub({ createFromPath: () => stub(), createEmpty: () => stub() }),
  contextBridge: { exposeInMainWorld: noop },
  ipcRenderer: stub({ invoke: async () => undefined, on: noop, send: noop }),
  powerSaveBlocker: { start: () => 1, stop: noop, isStarted: () => false },
  systemPreferences: stub({ isDarkMode: () => false }),
  webFrame: stub(),
};

// 供 HTTP 服务使用的内部接口（不参与 electron 模块解构）
Object.defineProperty(shim, '__web', {
  enumerable: false,
  value: {
    dataDir: DATA_DIR,
    appDir: APP_DIR,
    setEventSink(fn) { eventSink = fn; },
    listChannels() { return [...handlers.keys()]; },
    hasChannel(channel) { return handlers.has(channel); },
    async invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`未知 IPC 通道: ${channel}`);
      // upstream 的 episode-panel / boss-key 会校验 event.sender === mainWindow.webContents。
      // 第一个创建的窗口才是主窗口（后续可能追加登录窗/悬浮窗），固定取它。
      const wc = windows.length ? windows[0].webContents : makeWebContents();
      const event = { sender: wc, senderFrame: wc.mainFrame, returnValue: undefined };
      return await handler(event, ...args);
    },
    streamHandler(scheme) { return streamHandlers.get(scheme); },
    streamSchemes() { return [...streamHandlers.keys()]; },
  },
});

module.exports = shim;

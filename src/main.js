// 悬浮课表 · 主进程：窗口、数据存储、位置记忆（阶段1）
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const APP_ID = 'com.floating.schedule';
const TEST_MODE = process.env.SCHEDULE_TEST_MODE === '1';
const testFlag = (name) => TEST_MODE && process.env[name] === '1';
const RENDERER_ENTRY_URL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;

// Windows GUI 子进程的标准输出可能已关闭；日志绝不能使主进程崩溃。
function writeTestLog(level, args) {
  if (!TEST_MODE || !process.env.SCHEDULE_LOG_FILE) return;
  try {
    fs.appendFileSync(process.env.SCHEDULE_LOG_FILE, `[${level}] ${args.map(String).join(' ')}\n`, 'utf8');
  } catch {}
}
function logMain(...args) { writeTestLog('INFO', args); try { console.log(...args); } catch {} }
function warnMain(...args) { writeTestLog('WARN', args); try { console.warn(...args); } catch {} }
function errorMain(...args) { writeTestLog('ERROR', args); try { console.error(...args); } catch {} }
for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', () => {});
}

const GAP = 24; // 距工作区右下角边距
const MIN_W = 460, MIN_H = 320, DEF_W = 640, DEF_H = 480;

const DEFAULT_DATA = {
  version: 1,
  settings: {
    semesterStart: '',      // 第一周周一，用于计算当前周
    weekCount: 20,
    periodsPerDay: 8,
    periodTimes: [
      { start: '08:00', end: '08:45' },
      { start: '08:55', end: '09:40' },
      { start: '09:50', end: '10:35' },
      { start: '10:45', end: '11:30' },
      { start: '11:40', end: '12:25' },
      { start: '14:00', end: '14:45' },
      { start: '14:55', end: '15:40' },
      { start: '15:50', end: '16:35' },
    ],
    opacity: 0.65,
    autoStart: false,
  },
  window: null, // { x, y, width, height }
  viewWeek: null, // 上次查看的周，启动时恢复
  weeks: {},
};

/* ---------- 数据存储 ---------- */

// 便携版：数据放 exe 同目录（electron-builder portable 用环境变量给出真实路径）；
// 其他打包形态：exe 所在目录；开发模式：项目根目录。
// 若目标目录不可写，回退到 Electron 的用户数据目录，避免静默丢失修改。
let resolvedDataDir = null;

function preferredDataDir() {
  if (TEST_MODE && process.env.SCHEDULE_TEST_DATA_DIR) return process.env.SCHEDULE_TEST_DATA_DIR;
  if (app.isPackaged) {
    if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
    return path.dirname(process.execPath);
  }
  return app.getAppPath();
}

function isWritableDir(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function dataDir() {
  if (resolvedDataDir) return resolvedDataDir;
  const preferred = preferredDataDir();
  if (isWritableDir(preferred)) return (resolvedDataDir = preferred);

  const fallback = app.getPath('userData');
  fs.mkdirSync(fallback, { recursive: true });
  if (!isWritableDir(fallback)) throw new Error('程序目录与用户数据目录均不可写');
  warnMain('[store] 程序目录不可写，已回退到用户数据目录:', fallback);
  return (resolvedDataDir = fallback);
}

function dataFile() {
  return path.join(dataDir(), 'schedule.json');
}

function backupFile() {
  return path.join(dataDir(), 'schedule.bak');
}

function defaultData() {
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStoreDocument(value) {
  return isPlainObject(value) &&
    value.version === 1 &&
    isPlainObject(value.settings) &&
    isPlainObject(value.weeks);
}

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

function isTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour < 24 && minute >= 0 && minute < 60;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function normalizeStore(raw) {
  const def = defaultData();
  const source = isPlainObject(raw) ? raw : {};
  const sourceSettings = isPlainObject(source.settings) ? source.settings : {};
  const periodsPerDay = clampInteger(sourceSettings.periodsPerDay, def.settings.periodsPerDay, 4, 14);
  const weekCount = clampInteger(sourceSettings.weekCount, def.settings.weekCount, 1, 30);
  const sourceTimes = Array.isArray(sourceSettings.periodTimes) ? sourceSettings.periodTimes : [];
  const periodTimes = Array.from({ length: periodsPerDay }, (_, index) => {
    const hasSourceItem = isPlainObject(sourceTimes[index]);
    const item = hasSourceItem ? sourceTimes[index] : {};
    return {
      start: isTime(item.start) ? item.start : (hasSourceItem ? '' : (def.settings.periodTimes[index]?.start || '')),
      end: isTime(item.end) ? item.end : (hasSourceItem ? '' : (def.settings.periodTimes[index]?.end || '')),
    };
  });

  const normalized = {
    version: def.version,
    settings: {
      semesterStart: isValidDate(sourceSettings.semesterStart) ? sourceSettings.semesterStart : '',
      weekCount,
      periodsPerDay,
      periodTimes,
      opacity: Math.min(Math.max(Number(sourceSettings.opacity) || def.settings.opacity, 0.5), 1),
      autoStart: typeof sourceSettings.autoStart === 'boolean' ? sourceSettings.autoStart : def.settings.autoStart,
    },
    window: null,
    viewWeek: null,
    weeks: {},
  };

  if (isPlainObject(source.window) && Number.isFinite(source.window.x) && Number.isFinite(source.window.y)) {
    normalized.window = {
      x: Math.round(source.window.x),
      y: Math.round(source.window.y),
      width: clampInteger(source.window.width, DEF_W, MIN_W, 8192),
      height: clampInteger(source.window.height, DEF_H, MIN_H, 8192),
    };
  }

  const viewWeek = Number(source.viewWeek);
  if (Number.isInteger(viewWeek) && viewWeek >= 1 && viewWeek <= weekCount) normalized.viewWeek = viewWeek;

  const sourceWeeks = isPlainObject(source.weeks) ? source.weeks : {};
  for (let week = 1; week <= weekCount; week++) {
    const sourceWeek = isPlainObject(sourceWeeks[week]) ? sourceWeeks[week] : null;
    if (!sourceWeek) continue;
    const days = {};
    for (let day = 0; day < 5; day++) {
      const sourceDay = Array.isArray(sourceWeek[day]) ? sourceWeek[day] : [];
      days[day] = Array.from({ length: periodsPerDay }, (_, period) => {
        const value = sourceDay[period];
        return typeof value === 'string' ? value : '';
      });
    }
    normalized.weeks[week] = days;
  }
  return normalized;
}

function readStoreFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadStore() {
  const main = readStoreFile(dataFile());
  if (isStoreDocument(main)) return normalizeStore(main);

  const backup = readStoreFile(backupFile());
  if (isStoreDocument(backup)) {
    warnMain('[store] 主数据文件不可读，已从 schedule.bak 恢复');
    return normalizeStore(backup);
  }
  // 文件缺失或损坏：重建默认值，不崩溃
  return defaultData();
}

function saveStore(store) {
  const f = dataFile();
  const temp = path.join(dataDir(), `schedule.${process.pid}.${Date.now()}.tmp`);
  const normalized = normalizeStore(store);
  try {
    fs.writeFileSync(temp, JSON.stringify(normalized, null, 2), 'utf8');
    // 只有可解析的对象才有资格成为备份，避免损坏主文件覆盖最后一份有效 bak。
    if (isStoreDocument(readStoreFile(f))) fs.copyFileSync(f, backupFile());
    fs.renameSync(temp, f);
    return normalized;
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function saveStoreQuietly(store, context) {
  try {
    return saveStore(store);
  } catch (error) {
    errorMain(`[store] ${context}保存失败:`, error.message);
    return null;
  }
}

let injectedSaveFailures = 0;

function saveRendererStore(store) {
  if (TEST_MODE && injectedSaveFailures > 0) {
    injectedSaveFailures--;
    throw new Error('模拟写入失败');
  }
  // window 只由主进程维护；渲染层持有的启动快照不能覆盖刚保存的窗口位置。
  const current = loadStore();
  const incoming = isPlainObject(store) ? { ...store } : {};
  incoming.window = current.window;
  return saveStore(incoming);
}

function runStoreSelfCheck() {
  const originalDataDir = resolvedDataDir;
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-schedule-store-'));
  try {
    resolvedDataDir = testDir;
    const saved = saveStore({
      settings: {
        periodsPerDay: 99,
        weekCount: 0,
        semesterStart: '2026-09-07',
        periodTimes: [{ start: '99:99', end: '08:45' }],
        opacity: 9,
      },
      window: { x: 'bad', y: 12 },
      viewWeek: 99,
      weeks: { 1: { 0: ['数据结构', 123] } },
    });
    const normalized = saved.settings.periodsPerDay === 14 &&
      saved.settings.weekCount === 1 &&
      saved.settings.semesterStart === '2026-09-07' &&
      saved.settings.opacity === 1 &&
      saved.settings.periodTimes[0].start === '' &&
      saved.settings.periodTimes[0].end === '08:45' &&
      saved.window === null &&
      saved.weeks[1][0][0] === '数据结构' && saved.weeks[1][0][1] === '';

    // 第二次保存生成备份，再故意损坏主文件，验证可从备份读取。
    saveStore(saved);
    const backupBeforeRepair = fs.readFileSync(backupFile(), 'utf8');
    let backupRecovered = true;
    let backupPreserved = true;
    for (const invalidMain of ['{损坏的数据', '{}', '{"settings":{}}']) {
      fs.writeFileSync(dataFile(), invalidMain, 'utf8');
      const recovered = loadStore();
      backupRecovered &&= recovered.weeks[1]?.[0]?.[0] === '数据结构';
      saveStore(recovered);
      backupPreserved &&= fs.readFileSync(backupFile(), 'utf8') === backupBeforeRepair;
    }
    const recovered = loadStore();
    const authoritativeWindow = { x: 24, y: 36, width: 640, height: 480 };
    saveStore({ ...recovered, window: authoritativeWindow });
    const rendererSaved = saveRendererStore({
      ...recovered,
      window: { x: 999, y: 999, width: 999, height: 999 },
      viewWeek: 2,
    });
    const windowPreserved = JSON.stringify(rendererSaved.window) === JSON.stringify(authoritativeWindow);
    if (!normalized || !backupRecovered || !backupPreserved || !windowPreserved) {
      throw new Error('数据归一化、备份恢复或有效备份保留断言失败');
    }
    logMain('[STORE-E2E] PASS normalize-and-backup-recovery');
  } finally {
    resolvedDataDir = originalDataDir;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

/* ---------- 窗口位置 ---------- */

function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x + wa.width - DEF_W - GAP,
    y: wa.y + wa.height - DEF_H - GAP,
    width: DEF_W,
    height: DEF_H,
  };
}

function isBoundsVisible(bounds) {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const intersectionWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const intersectionHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return intersectionWidth >= 100 && intersectionHeight >= 60;
  });
}

// 恢复上次位置；若窗口已完全不在任何屏幕内（被拖出屏外/拔掉显示器），回右下角
function restoreBounds(store) {
  const saved = store.window || {};
  if (typeof saved.x !== 'number' || typeof saved.y !== 'number') {
    return { bounds: defaultBounds(), restored: false };
  }
  const b = {
    x: saved.x, y: saved.y,
    width: saved.width || DEF_W,
    height: saved.height || DEF_H,
  };
  const visible = isBoundsVisible(b); // 至少露出 100×60
  return { bounds: visible ? b : defaultBounds(), restored: visible };
}

let displayRecoveryTimer = null;

function scheduleDisplayRecovery() {
  clearTimeout(displayRecoveryTimer);
  displayRecoveryTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || isBoundsVisible(win.getBounds())) return;
    const bounds = defaultBounds();
    win.setBounds(bounds);
    const store = loadStore();
    store.window = bounds;
    saveStoreQuietly(store, '显示器变化后窗口位置');
    logMain('[WIN] display changed, restored to ' + JSON.stringify(bounds));
  }, 250);
}

/* ---------- 桌面层置底（F3 桌面挂件模式） ---------- */

// 需求：窗口只在桌面之上、其他一切窗口之下。Electron 无置底 API，
// 用 koffi 调 Win32 SetWindowPos(HWND_BOTTOM)：失焦/显示时压到底层。
let SetWindowPos = null;
try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  SetWindowPos = user32.func(
    'int SetWindowPos(void* hWnd, void* hWndInsertAfter, int X, int Y, int cx, int cy, unsigned int uFlags)'
  );
} catch (e) {
  warnMain('[Z] koffi 不可用，窗口将不置底:', e.message);
}

let zLogged = false;
function pinToBottom() {
  if (!SetWindowPos || !win || win.isDestroyed()) return;
  try {
    // HWND_BOTTOM(1) + SWP_NOMOVE(0x2)|SWP_NOSIZE(0x1)|SWP_NOACTIVATE(0x10)
    SetWindowPos(win.getNativeWindowHandle(), 1, 0, 0, 0, 0, 0x13);
    zLogged = true;
  } catch {
    // 置底失败时静默降级；GUI 程序可能没有可写的标准输出，不能因日志再触发 EPIPE。
  }
}

/* ---------- 窗口 ---------- */

let win = null;
let windowBlurCount = 0;

function createWindow() {
  const store = loadStore();
  const { bounds, restored } = restoreBounds(store);

  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,                 // 无边框
    transparent: true,            // 真半透明：Acrylic 在此机器/此版本实测未生效，改用透明窗口 + CSS 自绘卡片
    backgroundColor: '#00000000',
    alwaysOnTop: false,           // 桌面挂件：不置顶，靠 pinToBottom 压到其他窗口之下
    resizable: true,
    skipTaskbar: true,            // 不占任务栏
    show: false,
    title: '悬浮课表',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== RENDERER_ENTRY_URL) event.preventDefault();
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  logMain('[MAT] window mode=transparent (acrylic 诊断记录见开发日志)');

  // 桌面挂件置底：显示后与失焦时压到底层（点击窗口可临时前置编辑，失焦自动回落）
  win.on('show', () => setTimeout(pinToBottom, 150));
  win.on('blur', () => {
    if (TEST_MODE) windowBlurCount++;
    pinToBottom();
  });
  win.on('closed', () => { win = null; });

  // 位置/大小变化防抖保存（400ms），关闭时兜底保存
  let saveTimer = null;
  const persistBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        const s = loadStore();
        s.window = win.getBounds();
        saveStoreQuietly(s, '窗口位置');
      }
    }, 400);
  };
  win.on('move', persistBounds);
  win.on('resize', persistBounds);
  win.on('close', () => {
    if (win && !win.isDestroyed()) {
      const s = loadStore();
      s.window = win.getBounds();
      saveStoreQuietly(s, '窗口位置');
    }
  });

  logMain(
    '[WIN] bounds=' + JSON.stringify(win.getBounds()) +
    (restored ? ' (restored)' : ' (default bottom-right)')
  );

  if (testFlag('SCHEDULE_SHOT')) runShotSelfCheck();
}

/* ---------- 开发自检：SCHEDULE_SHOT=1 时截图后退出 ---------- */

// 自检截图输出目录：默认系统临时目录（不污染项目根），可用 SCHEDULE_SHOT_DIR 指定
const shotDir = () => process.env.SCHEDULE_SHOT_DIR || os.tmpdir();

async function runShotSelfCheck() {
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const checks = await win.webContents.executeJavaScript(`(() => {
          const cs = (sel, prop) => getComputedStyle(document.querySelector(sel)).getPropertyValue(prop);
          return {
            headerDrag: cs('#app-header', '-webkit-app-region'),
            btnNoDrag: cs('#btn-settings', '-webkit-app-region'),
            rows: document.querySelectorAll('.cell-row').length,
            cells: document.querySelectorAll('.cell:not(.time)').length,
            timeBg: cs('.cell.time', 'background-color'),
            timeBorder: cs('.cell.time', 'border-top-width'),
          };
        })()`);
        if (testFlag('SCHEDULE_TEST_MIN_VIEWPORT')) {
          win.setSize(MIN_W, MIN_H); // 阶段 3：验证代表性最小视口
          await new Promise((r) => setTimeout(r, 900));
          logMain('[SHOT] resized to ' + JSON.stringify(win.getBounds()));
        }
        await win.webContents.executeJavaScript(
          'document.body.style.background = "#9fb8d0";' // 模拟桌面底色便于查看半透明效果
        );
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir(), 'dev-screenshot.png'), img.toPNG());
        logMain('[SHOT] ' + JSON.stringify(checks));
        if (testFlag('SCHEDULE_E2E')) {
          await runPhase2E2E();
          await runPhase3E2E();
          await runPhase4E2E();
          if (testFlag('SCHEDULE_FAILURE_E2E')) await runFailureE2E();
          if (testFlag('SCHEDULE_TEST_MIN_VIEWPORT')) await runLayoutE2E();
          await runSecurityE2E();
          if (e2eFailures.length) throw new Error(`E2E 失败 ${e2eFailures.length} 项：${e2eFailures.join('；')}`);
        }

        // 截取真实屏幕：验证半透明/磨砂的实际观感（整屏 + 窗口区域）
        const { desktopCapturer } = require('electron');
        const scale = screen.getPrimaryDisplay().scaleFactor || 1;
        logMain('[SHOT] scaleFactor=' + scale + ' display=' + JSON.stringify(screen.getPrimaryDisplay().size));
        const srcs = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: screen.getPrimaryDisplay().size,
        });
        if (srcs[0]) {
          fs.writeFileSync(path.join(shotDir(), 'dev-screen-full.png'), srcs[0].thumbnail.toPNG());
          const b = win.getBounds();
          const pad = 80;
          const crop = srcs[0].thumbnail.crop({
            x: Math.max(0, Math.round(b.x * scale) - pad),
            y: Math.max(0, Math.round(b.y * scale) - pad),
            width: Math.round(b.width * scale) + pad * 2,
            height: Math.round(b.height * scale) + pad * 2,
          });
          fs.writeFileSync(path.join(shotDir(), 'dev-screen-crop.png'), crop.toPNG());
          logMain('[SHOT] screen-crop saved, thumbnail=' + JSON.stringify(srcs[0].thumbnail.getSize()));
        }

        // 设置浮层可打开性断言（截图后再开，避免遮住网格图）
        await win.webContents.executeJavaScript(`document.getElementById('btn-settings').click()`);
        await new Promise((r) => setTimeout(r, 100));
        const settingsOk = await win.webContents.executeJavaScript(`
          window.__settingsClicked === true && !document.getElementById('settings-overlay').hidden
        `);
        logMain('[SHOT] settingsOpen=' + settingsOk);
        if (settingsOk) {
          await new Promise((r) => setTimeout(r, 300)); // 等浮层完成一帧渲染
          const img2 = await win.webContents.capturePage();
          fs.writeFileSync(path.join(shotDir(), 'dev-screenshot-settings.png'), img2.toPNG());
          await win.webContents.executeJavaScript(`document.getElementById('btn-settings-close').click()`);
        }
      } catch (e) {
        process.exitCode = 1;
        errorMain('[SHOT] failed:', e);
      }
      app.exit(process.exitCode || 0);
    }, 1200);
  });
}

/* ---------- 托盘图标（F12） ---------- */

let tray = null;

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) { win.hide(); } else { win.show(); win.focus(); }
}

// 窗口拖到看不见的地方时的救援入口：回右下角默认位置并保存
function restoreDefaultPosition() {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.setBounds(defaultBounds());
  const s = loadStore();
  s.window = win.getBounds();
  saveStoreQuietly(s, '恢复默认位置');
  logMain('[WIN] restored default position: ' + JSON.stringify(win.getBounds()));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('悬浮课表');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏课表', click: toggleWindow },
    { label: '恢复默认位置', click: restoreDefaultPosition },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', toggleWindow);
}

/* ---------- 开机自启 ---------- */

const LOGIN_ITEM_ARGS = [];

function autoStartExecutable() {
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
  if (app.isPackaged && portableFile && path.isAbsolute(portableFile)) {
    return path.normalize(portableFile);
  }
  return process.execPath;
}

function readAutoStart(target = autoStartExecutable()) {
  return app.getLoginItemSettings({ path: target, args: LOGIN_ITEM_ARGS }).openAtLogin;
}

function sameWindowsPath(left, right) {
  if (!left || !right) return false;
  return path.normalize(String(left)).toLowerCase() === path.normalize(String(right)).toLowerCase();
}

function ownedAutoStartItems(target) {
  const settings = app.getLoginItemSettings({ path: target, args: LOGIN_ITEM_ARGS });
  return (settings.launchItems || []).filter(
    (item) => String(item.name || '').toLowerCase() === APP_ID.toLowerCase()
  );
}

function legacyAutoStartItems(target) {
  return ownedAutoStartItems(target).filter((item) => item.path && !sameWindowsPath(item.path, target));
}

function clearLegacyAutoStart(target, items = legacyAutoStartItems(target)) {
  for (const item of items) {
    app.setLoginItemSettings({
      openAtLogin: false,
      path: item.path,
      args: Array.isArray(item.args) ? item.args : LOGIN_ITEM_ARGS,
      name: item.name || APP_ID,
    });
    logMain('[AUTOSTART] removed legacy path=' + item.path);
  }
}

function setAutoStart(enabled) {
  const target = autoStartExecutable();
  if (enabled && !fs.existsSync(target)) {
    throw new Error(`开机自启目标不存在：${target}`);
  }
  const previousTarget = readAutoStart(target);
  const previousLegacy = legacyAutoStartItems(target);
  try {
    // 先写入正式目标，再移除历史临时路径；任一步失败都恢复调用前状态。
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: target,
      args: LOGIN_ITEM_ARGS,
      name: APP_ID,
    });
    clearLegacyAutoStart(target, previousLegacy);
    return readAutoStart(target);
  } catch (error) {
    try {
      app.setLoginItemSettings({
        openAtLogin: previousTarget,
        path: target,
        args: LOGIN_ITEM_ARGS,
        name: APP_ID,
      });
      for (const item of previousLegacy) {
        app.setLoginItemSettings({
          openAtLogin: item.enabled !== false,
          path: item.path,
          args: Array.isArray(item.args) ? item.args : LOGIN_ITEM_ARGS,
          name: item.name || APP_ID,
        });
      }
    } catch (rollbackError) {
      throw new Error(`开机自启设置失败，且原状态恢复失败：${rollbackError.message}`);
    }
    throw error;
  }
}

function migrateLegacyAutoStart() {
  const target = autoStartExecutable();
  if (sameWindowsPath(target, process.execPath)) return;
  const targetEnabled = readAutoStart(target);
  const legacyEnabled = legacyAutoStartItems(target).some((item) => item.enabled !== false);
  if (!targetEnabled && legacyEnabled) {
    const migrated = setAutoStart(true);
    logMain('[AUTOSTART] migrated-to-portable=' + migrated + ' path=' + target);
  } else if (targetEnabled) {
    clearLegacyAutoStart(target);
  }
}

function runAutoStartSelfCheck() {
  const target = autoStartExecutable();
  if (!sameWindowsPath(target, target.toUpperCase())) {
    throw new Error('Windows 自启路径比较未忽略大小写');
  }
  const ownedItems = ownedAutoStartItems(target);
  if (legacyAutoStartItems(target).length || ownedItems.some((item) => item.enabled === false)) {
    logMain('[AUTOSTART] self-check skipped to preserve existing login item state');
    return;
  }
  const original = readAutoStart(target);
  const probe = !original;
  try {
    const changed = setAutoStart(probe);
    if (changed !== probe) throw new Error('测试状态未能写入');
    logMain('[AUTOSTART] probe -> ' + changed + ' path=' + target);
  } finally {
    const restored = setAutoStart(original);
    if (restored !== original) throw new Error('原有开机自启状态未能恢复');
    logMain('[AUTOSTART] restored -> ' + restored + ' path=' + target);
  }
}

/* ---- 阶段 2 E2E：翻页 / 编辑 / 独立性 / 复制上周 ---- */

const e2eFailures = [];

function recordE2E(scope, name, ok, detail) {
  logMain(`[${scope}] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' -> ' + detail : ''}`);
  if (!ok) e2eFailures.push(`${scope}/${name}`);
  return ok;
}

async function runPhase2E2E() {
  const js = (code) => win.webContents.executeJavaScript(code);
  const longCourse = '高等数学课程名称长度超过三十个字符用于验证保存过程不会静默截断内容\n习题课';
  const log = (name, ok, detail) => recordE2E('E2E', name, ok, detail);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (code, timeout = 2000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await js(code)) return true;
      await wait(30);
    }
    return false;
  };
  try {
    // 启动周恢复断言（SCHEDULE_EXPECT_WEEK=2 时校验从磁盘恢复的是第 2 周）
    const initialLabel = await js(`document.getElementById('week-label').textContent`);
    if (process.env.SCHEDULE_EXPECT_WEEK) {
      log('initial-restore-week' + process.env.SCHEDULE_EXPECT_WEEK,
        initialLabel.includes(`第 ${process.env.SCHEDULE_EXPECT_WEEK} 周`), initialLabel);
    } else {
      logMain('[E2E] initial-week -> ' + initialLabel);
    }
    // 归一到第 1 周，保证后续断言确定性
    for (let i = 0; i < 40; i++) {
      if ((await js(`document.getElementById('week-label').textContent`)).includes('第 1 周')) break;
      await js(`document.getElementById('btn-prev').click()`);
      await wait(30);
    }
    await js(`document.getElementById('btn-next').click()`);
    await waitFor(`document.getElementById('week-label').textContent.includes('第 2 周')`);
    const weekLabel = await js(`document.getElementById('week-label').textContent`);
    log('nav-to-week2', weekLabel.includes('第 2 周'), weekLabel);

    const editStart = await js(`(() => {
      try {
        const cell = document.querySelectorAll('.cell:not(.time)')[0];
        cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        const editor = document.querySelector('.cell-editor');
        return { ok: !!editor, active: document.activeElement?.className || '' };
      } catch (error) {
        return { ok: false, error: String(error), stack: error.stack };
      }
    })()`);
    const firstEditorFocused = editStart.ok && await waitFor(
      `document.activeElement?.classList.contains('cell-editor')`
    );
    log('start-edit-week2', firstEditorFocused, JSON.stringify(editStart));
    if (!editStart.ok) throw new Error(editStart.error || '编辑器未出现');
    log('editor-without-silent-30-char-limit',
      !(await js(`document.querySelector('.cell-editor').hasAttribute('maxlength')`)));
    await js(`(() => {
      const i = document.querySelector('.cell-editor');
      i.value = ${JSON.stringify(longCourse)};
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await waitFor(`document.querySelectorAll('.cell:not(.time)')[0].textContent === ${JSON.stringify(longCourse)}`);
    log('edit-week2-multiline-cell',
      await js(`(() => {
        const text = document.querySelectorAll('.cell:not(.time)')[0].textContent;
        return text === ${JSON.stringify(longCourse)};
      })()`));

    await js(`document.getElementById('btn-next').click()`);
    await waitFor(`document.getElementById('week-label').textContent.includes('第 3 周')`);
    log('week3-independent',
      (await js(`document.querySelectorAll('.cell:not(.time)')[0].textContent`)) === '');

    // 建立“用户已经点击并激活窗口”的起始条件；复制完成后不再补焦。
    win.show();
    win.focus();
    win.webContents.focus();
    await wait(100);
    const blurBeforeCopy = windowBlurCount;
    await js(`(() => {
      const button = document.getElementById('btn-copy');
      button.focus();
      button.click();
    })()`);
    await waitFor(`
      !document.getElementById('copy-confirm-overlay').hidden &&
      document.activeElement === document.getElementById('btn-copy-confirm-cancel')
    `);
    const confirmState = await js(`(() => ({
      open: !document.getElementById('copy-confirm-overlay').hidden,
      cancelFocused: document.activeElement === document.getElementById('btn-copy-confirm-cancel')
    }))()`);
    log('copy-confirm-in-app', confirmState.open && confirmState.cancelFocused, JSON.stringify(confirmState));
    const confirmImage = await win.webContents.capturePage();
    fs.writeFileSync(path.join(shotDir(), 'dev-screenshot-copy-confirm.png'), confirmImage.toPNG());
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESCAPE' });
    await waitFor(`document.getElementById('copy-confirm-overlay').hidden`);
    const cancelState = await js(`(() => ({
      hidden: document.getElementById('copy-confirm-overlay').hidden,
      openerFocused: document.activeElement === document.getElementById('btn-copy'),
      text: document.querySelectorAll('.cell:not(.time)')[0].textContent
    }))()`);
    log('copy-confirm-cancel', cancelState.hidden && cancelState.openerFocused && cancelState.text === '',
      JSON.stringify(cancelState));
    await js(`document.getElementById('btn-copy').click()`);
    await waitFor(`
      !document.getElementById('copy-confirm-overlay').hidden &&
      document.activeElement === document.getElementById('btn-copy-confirm-cancel')
    `);
    await js(`document.getElementById('btn-copy-confirm-ok').click()`);
    await waitFor(`document.querySelectorAll('.cell:not(.time)')[0].textContent === ${JSON.stringify(longCourse)}`);
    log('copy-prev-week',
      await js(`(() => {
        const text = document.querySelectorAll('.cell:not(.time)')[0].textContent;
        return text === ${JSON.stringify(longCourse)};
      })()`));
    const naturalFocus = await js(`({
      document: document.hasFocus(),
      opener: document.activeElement === document.getElementById('btn-copy')
    })`);
    log('copy-confirm-keeps-window-focus', windowBlurCount === blurBeforeCopy && win.isFocused() &&
      naturalFocus.document && naturalFocus.opener,
      `blur=${blurBeforeCopy}->${windowBlurCount} window=${win.isFocused()} document=${naturalFocus.document} opener=${naturalFocus.opener}`);

    const cellPoint = await js(`(() => {
      const rect = document.querySelectorAll('.cell:not(.time)')[0].getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    for (const event of [
      { type: 'mouseDown', button: 'left', clickCount: 1 },
      { type: 'mouseUp', button: 'left', clickCount: 1 },
      { type: 'mouseDown', button: 'left', clickCount: 2 },
      { type: 'mouseUp', button: 'left', clickCount: 2 },
    ]) {
      win.webContents.sendInputEvent({ ...event, x: cellPoint.x, y: cellPoint.y });
    }
    const copiedEditorFocused = await waitFor(`document.activeElement?.classList.contains('cell-editor')`);
    const focusState = await js(`({ document: document.hasFocus(), editor: document.activeElement?.classList.contains('cell-editor') })`);
    log('copy-then-edit', copiedEditorFocused && win.isFocused() && focusState.document && focusState.editor,
      `window=${win.isFocused()} document=${focusState.document} editor=${focusState.editor}`);
    const beforeInput = await js(`document.querySelector('.cell-editor').value`);
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'K' });
    await waitFor(`document.querySelector('.cell-editor')?.value !== ${JSON.stringify(beforeInput)}`);
    const typedText = await js(`document.querySelector('.cell-editor')?.value`);
    log('copy-then-real-key-input', typeof typedText === 'string' && typedText !== beforeInput,
      JSON.stringify({ before: beforeInput, after: typedText }));
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
    await waitFor(`document.querySelectorAll('.cell:not(.time)')[0].textContent === ${JSON.stringify('K')}`);
    log('copy-then-edit-saved',
      (await js(`document.querySelectorAll('.cell:not(.time)')[0].textContent`)) === 'K');

    const todayDisabled = await js(`document.getElementById('btn-today').disabled`);
    if (todayDisabled) {
      log('back-to-today-disabled-without-semester', true);
    } else {
      await js(`document.getElementById('btn-today').click()`);
      log('back-to-today', (await js(`document.getElementById('week-label').textContent`)).includes('第 1 周'));
    }

    await js(`document.getElementById('btn-next').click()`); // 结束在周 2：供下一次运行的恢复断言
    await waitFor(`!document.getElementById('btn-settings').disabled`);
  } catch (e) {
    errorMain('[E2E] failed:', e);
    e2eFailures.push(`E2E/exception:${e.message}`);
  }
}

/* ---- 阶段 3 E2E：设置面板 ---- */

async function runPhase3E2E() {
  const js = (code) => win.webContents.executeJavaScript(code);
  const log = (name, ok, detail) => recordE2E('E2E3', name, ok, detail);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (code, timeout = 2000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await js(code)) return true;
      await wait(30);
    }
    return false;
  };
  const eq = (a, b) => a === b;
  try {
    await waitFor(`!document.getElementById('btn-settings').disabled`);
    log('no-highlight-without-semester', await js(`
      document.querySelectorAll('.cell.today, .cell.now, .day-head.today').length === 0
    `));
    await js(`document.getElementById('btn-set-semester').click()`);
    await waitFor(`!document.getElementById('settings-overlay').hidden`);
    log('open-settings-from-semester-hint', await js(`!document.getElementById('settings-overlay').hidden`));
    for (let i = 0; i < 20; i++) {
      if (!(await js(`document.getElementById('btn-settings-save').disabled`))) break;
      await wait(50);
    }
    log('autostart-ready', !(await js(`document.getElementById('btn-settings-save').disabled`)));

    // 4/14 节边界不留下可点击但无结果的按钮
    await js(`(() => {
      const i = document.getElementById('set-periods');
      i.value = '4';
      i.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    log('four-periods-hide-delete', await js(`
      [...document.querySelectorAll('#set-times .time-row-del')].every((button) => button.hidden)
    `));
    await js(`(() => {
      const i = document.getElementById('set-periods');
      i.value = '14';
      i.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    log('fourteen-periods-hide-add', await js(`document.getElementById('btn-add-period').hidden`));

    // 每天课数 → 9（草稿即时联动时间列表）
    await js(`(() => {
      const i = document.getElementById('set-periods');
      i.value = '9';
      i.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    log('draft-rows-9',
      eq(await js(`document.querySelectorAll('#set-times .time-row').length`), 9));

    // 第 1 节开始时间改为 08:10
    await js(`(() => {
      const s = document.querySelector('#set-times .time-row input[type="time"]');
      s.value = '08:10';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

    // 时间错误留在设置面板内，不关闭草稿
    await js(`(() => {
      const end = document.querySelectorAll('#set-times .time-row input[type="time"]')[1];
      end.value = '08:00';
      end.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('btn-settings-save').click();
    })()`);
    log('time-error-keeps-settings-draft', await js(`
      !document.getElementById('settings-overlay').hidden &&
      !document.getElementById('time-error').hidden &&
      document.getElementById('time-error').textContent.includes('节次时间有误')
    `));
    await js(`(() => {
      const end = document.querySelectorAll('#set-times .time-row input[type="time"]')[1];
      end.value = '08:45';
      end.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);

    // 开学日期 + 不透明度 0.8（input 事件触发即时预览）
    await js(`(() => {
      const d = document.getElementById('set-semester-start'); d.value = '2026-09-07';
      const o = document.getElementById('set-opacity'); o.value = '0.8';
      o.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    const savingLabel = await js(`(() => {
      document.getElementById('btn-settings-save').click();
      return document.getElementById('btn-settings-save').textContent;
    })()`);
    log('settings-saving-label', savingLabel === '保存中…', savingLabel);
    await waitFor(`document.getElementById('settings-overlay').hidden`);

    log('grid-rows-9', eq(await js(`document.querySelectorAll('.cell-row').length`), 9));
    log('time-updated', eq(await js(`document.querySelector('.cell.time span').textContent`), '08:10'));
    log('hint-hidden', await js(`document.getElementById('hint').hidden`));
    const appBg = await js(`getComputedStyle(document.getElementById('app')).backgroundColor`);
    log('alpha-applied', /rgba\(214, 232, 248, 0\.8/.test(appBg), appBg);

    // 重开设置：值应从已保存数据回填
    await js(`document.getElementById('btn-settings').click()`);
    await waitFor(`!document.getElementById('settings-overlay').hidden`);
    log('reopen-persisted',
      eq(await js(`document.getElementById('set-periods').value`), '9') &&
      eq(await js(`document.getElementById('set-semester-start').value`), '2026-09-07'));
    await js(`document.getElementById('btn-settings-cancel').click()`);
  } catch (e) {
    errorMain('[E2E3] failed:', e);
    e2eFailures.push(`E2E3/exception:${e.message}`);
  }
}

/* ---- 阶段 4 E2E：当前天 / 当前节高亮 ---- */

async function runPhase4E2E() {
  const js = (code) => win.webContents.executeJavaScript(code);
  const log = (name, ok, detail) => recordE2E('E2E4', name, ok, detail);
  try {
    const r = await js(`(() => {
      window.__refreshHighlight(); // 先刷新，消除测试与渲染之间的时间差
      const d = new Date();
      const dayIndex = (d.getDay() + 6) % 7;
      const viewingCurrentWeek = document.getElementById('week-label').textContent.includes('第 ' + currentWeek() + ' 周');
      const today = viewingCurrentWeek && dayIndex <= 4 ? dayIndex : -1;
      const minutes = d.getHours() * 60 + d.getMinutes();
      const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
      let nowP = -1;
      document.querySelectorAll('.cell-row').forEach((row, i) => {
        const spans = row.querySelectorAll('.cell.time span');
        if (spans.length >= 2) {
          const s = toMin(spans[0].textContent);
          const e = toMin(spans[1].textContent);
          if (!isNaN(s) && !isNaN(e) && minutes >= s && minutes <= e) nowP = i;
        }
      });
      const rows = document.querySelectorAll('.cell-row').length;
      const todayCells = [...document.querySelectorAll('.cell.today')].map((c) => +c.dataset.day);
      const nowCells = [...document.querySelectorAll('.cell.now')].map((c) => c.dataset.day + '-' + c.dataset.period);
      const headToday = [...document.querySelectorAll('.day-head.today')].map((c) => +c.dataset.dayIndex);
      return { today, nowP, rows, todayCells, nowCells, headToday, viewingCurrentWeek };
    })()`);
    const okToday = r.today >= 0
      ? r.todayCells.length === r.rows &&
        r.todayCells.every((x) => x === r.today) &&
        r.headToday.length === 1 && r.headToday[0] === r.today
      : r.todayCells.length === 0 && r.headToday.length === 0;
    log('today-column' + (r.today >= 0 ? '-' + (r.today + 1) : '-not-current-week'), okToday,
      `cells=${r.todayCells.length}/${r.rows} head=${JSON.stringify(r.headToday)}`);
    const expectNow = r.nowP >= 0 && r.today >= 0 ? [r.today + '-' + r.nowP] : [];
    const okNow = JSON.stringify(r.nowCells) === JSON.stringify(expectNow);
    log('current-period' + (r.nowP >= 0 ? '-p' + (r.nowP + 1) : '-none'), okNow,
      'now=' + JSON.stringify(r.nowCells));
  } catch (e) {
    errorMain('[E2E4] failed:', e);
    e2eFailures.push(`E2E4/exception:${e.message}`);
  }
}

/* ---- 阶段 3 E2E：保存失败不提交，并可原地重试 ---- */

async function runFailureE2E() {
  const js = (code) => win.webContents.executeJavaScript(code);
  const log = (name, ok, detail) => recordE2E('E2E-FAIL', name, ok, detail);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (code, timeout = 2500) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await js(code)) return true;
      await wait(30);
    }
    return false;
  };

  try {
    // 格子：失败时编辑器和输入保留，下一次 Enter 可成功。
    await js(`document.querySelector('.cell:not(.time)').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await waitFor(`document.activeElement?.classList.contains('cell-editor')`);
    injectedSaveFailures = 1;
    await js(`(() => {
      const editor = document.querySelector('.cell-editor');
      editor.value = '失败后保留并可重试';
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await waitFor(`document.querySelector('.cell-editor') && !document.querySelector('.cell-editor').disabled`);
    log('cell-keeps-editor', await js(`
      document.querySelector('.cell-editor')?.value === '失败后保留并可重试' &&
      document.getElementById('save-status').textContent.includes('课程保存失败')
    `));
    await js(`document.querySelector('.cell-editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await waitFor(`!document.querySelector('.cell-editor')`);
    log('cell-retry-succeeds', await js(`document.querySelector('.cell:not(.time)').textContent === '失败后保留并可重试'`));

    // 翻周：失败保持原周，重试后才更新周标签。
    const weekBefore = await js(`document.getElementById('week-label').textContent`);
    injectedSaveFailures = 1;
    await js(`document.getElementById('btn-next').click()`);
    await waitFor(`document.getElementById('save-status').textContent.includes('切换周次失败')`);
    log('week-keeps-current-view', (await js(`document.getElementById('week-label').textContent`)) === weekBefore);
    await js(`document.getElementById('btn-next').click()`);
    await waitFor(`document.getElementById('week-label').textContent !== ${JSON.stringify(weekBefore)}`);
    log('week-retry-succeeds', (await js(`document.getElementById('week-label').textContent`)) !== weekBefore);

    // 复制：失败保持本周内容，重试后才覆盖为上一周。
    const copiedBefore = await js(`document.querySelector('.cell:not(.time)').textContent`);
    injectedSaveFailures = 1;
    await js(`document.getElementById('btn-copy').click()`);
    await waitFor(`!document.getElementById('copy-confirm-overlay').hidden`);
    await js(`document.getElementById('btn-copy-confirm-ok').click()`);
    await waitFor(`document.getElementById('save-status').textContent.includes('复制上周失败')`);
    log('copy-keeps-current-grid', (await js(`document.querySelector('.cell:not(.time)').textContent`)) === copiedBefore);
    await js(`document.getElementById('btn-copy').click()`);
    await waitFor(`!document.getElementById('copy-confirm-overlay').hidden`);
    await js(`document.getElementById('btn-copy-confirm-ok').click()`);
    await waitFor(`document.querySelector('.cell:not(.time)').textContent === '失败后保留并可重试'`);
    log('copy-retry-succeeds', await js(`document.querySelector('.cell:not(.time)').textContent === '失败后保留并可重试'`));

    // 设置：失败留在面板并保留草稿，重试成功后才关闭和更新。
    await js(`document.getElementById('btn-settings').click()`);
    await waitFor(`!document.getElementById('settings-overlay').hidden && !document.getElementById('btn-settings-save').disabled`);
    const originalWeeks = +(await js(`document.getElementById('set-weeks').value`));
    const draftWeeks = originalWeeks > 1 ? originalWeeks - 1 : originalWeeks + 1;
    injectedSaveFailures = 1;
    await js(`(() => {
      document.getElementById('set-weeks').value = ${draftWeeks};
      document.getElementById('btn-settings-save').click();
    })()`);
    await waitFor(`!document.getElementById('settings-error').hidden`);
    log('settings-keeps-draft', await js(`
      !document.getElementById('settings-overlay').hidden &&
      +document.getElementById('set-weeks').value === ${draftWeeks} &&
      document.getElementById('settings-error').textContent.includes('设置保存失败')
    `));
    await js(`document.getElementById('btn-settings-save').click()`);
    await waitFor(`document.getElementById('settings-overlay').hidden`);
    log('settings-retry-succeeds', await js(`document.getElementById('week-label').textContent.includes('共 ${draftWeeks} 周')`));
  } catch (error) {
    errorMain('[E2E-FAIL] failed:', error);
    e2eFailures.push(`E2E-FAIL/exception:${error.message}`);
  } finally {
    injectedSaveFailures = 0;
  }
}

/* ---- 阶段 3 E2E：最小视口、设置滚动与焦点边界 ---- */

async function runLayoutE2E() {
  const js = (code) => win.webContents.executeJavaScript(code);
  const log = (name, ok, detail) => recordE2E('E2E-LAYOUT', name, ok, detail);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const grid = await js(`(() => {
      const header = document.getElementById('app-header');
      const scroll = document.getElementById('scroll');
      const row = document.querySelector('.cell-row');
      const dayWidths = [...row.querySelectorAll('.cell:not(.time)')].map((cell) => cell.getBoundingClientRect().width);
      const headerRect = header.getBoundingClientRect();
      const controlsInside = [...header.querySelectorAll('button')].every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left >= headerRect.left - 1 && rect.right <= headerRect.right + 1 &&
          rect.top >= headerRect.top - 1 && rect.bottom <= headerRect.bottom + 1;
      });
      return {
        viewport: [innerWidth, innerHeight],
        documentFits: document.documentElement.scrollWidth <= innerWidth + 1,
        headerFits: header.scrollWidth <= header.clientWidth + 1 && controlsInside,
        rowWidth: row.getBoundingClientRect().width,
        minDayWidth: Math.min(...dayWidths),
        scrollOwnsOverflow: getComputedStyle(scroll).overflowX === 'auto',
      };
    })()`);
    // Windows 在部分 DPI 下会把无边框窗口的物理边界向上取整 1px。
    log('minimum-window', grid.viewport[0] >= MIN_W && grid.viewport[0] <= MIN_W + 1 &&
      grid.viewport[1] >= MIN_H && grid.viewport[1] <= MIN_H + 1, JSON.stringify(grid.viewport));
    log('header-contained', grid.headerFits && grid.documentFits, JSON.stringify(grid));
    log('grid-readable', grid.rowWidth >= 411.5 && grid.minDayWidth >= 63.5 && grid.scrollOwnsOverflow, JSON.stringify(grid));

    await js(`document.getElementById('btn-settings').click()`);
    await wait(150);
    await js(`(() => {
      const input = document.getElementById('set-periods');
      input.value = 14;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await wait(50);
    const settings = await js(`(() => {
      const panel = document.getElementById('settings-panel').getBoundingClientRect();
      const head = document.getElementById('settings-head').getBoundingClientRect();
      const body = document.getElementById('settings-body');
      const actions = document.querySelector('.settings-actions').getBoundingClientRect();
      const add = document.getElementById('btn-add-period');
      return {
        bodyScrolls: body.scrollHeight > body.clientHeight,
        fixedRegionsVisible: head.top >= panel.top - 1 && head.bottom <= panel.bottom + 1 &&
          actions.top >= panel.top - 1 && actions.bottom <= panel.bottom + 1,
        addHidden: add.hidden,
        addFocusable: isVisibleForFocus(add),
      };
    })()`);
    log('settings-body-scroll', settings.bodyScrolls && settings.fixedRegionsVisible, JSON.stringify(settings));
    log('hidden-add-skipped', settings.addHidden && !settings.addFocusable, JSON.stringify(settings));

    await js(`(() => {
      const input = document.getElementById('set-periods');
      input.value = 4;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const deletesSkipped = await js(`
      [...document.querySelectorAll('.time-row-del')].every((button) => button.hidden && !isVisibleForFocus(button))
    `);
    log('hidden-delete-skipped', deletesSkipped);
    await js(`document.getElementById('btn-settings-cancel').click()`);
  } catch (error) {
    errorMain('[E2E-LAYOUT] failed:', error);
    e2eFailures.push(`E2E-LAYOUT/exception:${error.message}`);
  }
}

/* ---- 阶段 3 E2E：页面边界与 IPC 参数防护 ---- */

async function runSecurityE2E() {
  const js = (code) => win.webContents.executeJavaScript(code);
  const log = (name, ok, detail) => recordE2E('E2E-SECURITY', name, ok, detail);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const csp = await js(`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || ''`);
    log('csp-present', csp.includes("default-src 'self'") && csp.includes("object-src 'none'"), csp);

    const windowsBefore = BrowserWindow.getAllWindows().length;
    await js(`window.open('https://example.com/', '_blank')`);
    await wait(100);
    log('new-window-denied', BrowserWindow.getAllWindows().length === windowsBefore,
      `before=${windowsBefore} after=${BrowserWindow.getAllWindows().length}`);

    await js(`location.href = 'https://example.com/'`);
    await wait(100);
    log('external-navigation-denied', win.webContents.getURL() === RENDERER_ENTRY_URL, win.webContents.getURL());

    const trustedShapeAccepted = isTrustedIpcEvent({
      sender: win.webContents,
      senderFrame: { url: RENDERER_ENTRY_URL },
    });
    const wrongSenderRejected = !isTrustedIpcEvent({
      sender: {},
      senderFrame: { url: RENDERER_ENTRY_URL },
    });
    const wrongUrlRejected = !isTrustedIpcEvent({
      sender: win.webContents,
      senderFrame: { url: 'https://example.com/' },
    });
    log('ipc-source-checked', trustedShapeAccepted && wrongSenderRejected && wrongUrlRejected,
      `trusted=${trustedShapeAccepted} sender=${wrongSenderRejected} url=${wrongUrlRejected}`);

    const invalidTypeRejected = await js(`
      window.api.setAutoStart('true').then(() => false, (error) => String(error).includes('布尔值'))
    `);
    log('ipc-type-checked', invalidTypeRejected);

    const previousBounds = win.getBounds();
    win.setBounds({ ...previousBounds, x: 100000, y: 100000 });
    scheduleDisplayRecovery();
    await wait(400);
    log('offscreen-window-recovered', isBoundsVisible(win.getBounds()), JSON.stringify(win.getBounds()));
  } catch (error) {
    errorMain('[E2E-SECURITY] failed:', error);
    e2eFailures.push(`E2E-SECURITY/exception:${error.message}`);
  }
}

/* ---------- 生命周期 ---------- */

let testAutoStartState = false;

function isTrustedIpcEvent(event) {
  return !!(win && !win.isDestroyed() &&
    event?.sender === win.webContents &&
    event?.senderFrame?.url === RENDERER_ENTRY_URL);
}

function trustedIpcHandler(handler) {
  return (event, ...args) => {
    if (!isTrustedIpcEvent(event)) throw new Error('已拒绝非应用页面的请求');
    return handler(...args);
  };
}

function setRendererAutoStart(value) {
  if (typeof value !== 'boolean') throw new TypeError('开机自启参数必须是布尔值');
  if (TEST_MODE && !testFlag('SCHEDULE_TEST_AUTOSTART')) {
    const previous = testAutoStartState;
    testAutoStartState = value;
    return { previous, current: testAutoStartState };
  }
  const previous = readAutoStart();
  const current = setAutoStart(value);
  return { previous, current };
}

function getRendererAutoStart() {
  if (TEST_MODE && !testFlag('SCHEDULE_TEST_AUTOSTART')) return testAutoStartState;
  return readAutoStart();
}

// 隔离 E2E 使用独立用户目录，不与用户正在运行的实例争抢锁。
const gotLock = testFlag('SCHEDULE_ISOLATED_E2E') ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);

    if (testFlag('SCHEDULE_STORE_E2E')) {
      try {
        runStoreSelfCheck();
      } catch (error) {
        process.exitCode = 1;
        errorMain('[STORE-E2E] FAIL:', error.message);
      }
      app.quit();
      return;
    }

    // 打包版自检钩子：切换一次状态并恢复，验证外层 portable exe 路径下 API 可用。
    if (!TEST_MODE || testFlag('SCHEDULE_TEST_AUTOSTART')) {
      try {
        migrateLegacyAutoStart();
      } catch (e) {
        errorMain('[AUTOSTART] legacy migration failed:', e);
      }
    }
    if (testFlag('SCHEDULE_TEST_AUTOSTART')) {
      try {
        runAutoStartSelfCheck();
      } catch (e) {
        process.exitCode = 1;
        errorMain('[AUTOSTART] failed:', e);
      }
    }

    ipcMain.handle('app:quit', trustedIpcHandler(() => app.quit()));
    ipcMain.handle('store:load', trustedIpcHandler(() => loadStore()));
    ipcMain.handle('store:save', trustedIpcHandler((data) => saveRendererStore(data)));
    ipcMain.handle('app:set-autostart', trustedIpcHandler(setRendererAutoStart));
    ipcMain.handle('app:get-autostart', trustedIpcHandler(getRendererAutoStart));
    createWindow();
    createTray();
    for (const eventName of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(eventName, scheduleDisplayRecovery);
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}

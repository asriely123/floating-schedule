// 悬浮课表 · 主进程：窗口、数据存储、位置记忆（阶段1）
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  console.warn('[store] 程序目录不可写，已回退到用户数据目录:', fallback);
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
  const date = new Date(value + 'T00:00:00');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
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
        return typeof value === 'string' ? value.slice(0, 30) : '';
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
  if (main) return normalizeStore(main);

  const backup = readStoreFile(backupFile());
  if (backup) {
    console.warn('[store] 主数据文件不可读，已从 schedule.bak 恢复');
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
    if (fs.existsSync(f)) fs.copyFileSync(f, backupFile());
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
    console.error(`[store] ${context}保存失败:`, error.message);
    return null;
  }
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
        periodTimes: [{ start: '99:99', end: '08:45' }],
        opacity: 9,
      },
      window: { x: 'bad', y: 12 },
      viewWeek: 99,
      weeks: { 1: { 0: ['数据结构', 123] } },
    });
    const normalized = saved.settings.periodsPerDay === 14 &&
      saved.settings.weekCount === 1 &&
      saved.settings.opacity === 1 &&
      saved.settings.periodTimes[0].start === '' &&
      saved.settings.periodTimes[0].end === '08:45' &&
      saved.window === null &&
      saved.weeks[1][0][0] === '数据结构' && saved.weeks[1][0][1] === '';

    // 第二次保存生成备份，再故意损坏主文件，验证可从备份读取。
    saveStore(saved);
    fs.writeFileSync(dataFile(), '{损坏的数据', 'utf8');
    const recovered = loadStore();
    const backupRecovered = recovered.weeks[1]?.[0]?.[0] === '数据结构';
    if (!normalized || !backupRecovered) throw new Error('数据归一化或备份恢复断言失败');
    console.log('[STORE-E2E] PASS normalize-and-backup-recovery');
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
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const iw = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const ih = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return iw >= 100 && ih >= 60; // 至少露出一角
  });
  return { bounds: visible ? b : defaultBounds(), restored: visible };
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
  console.warn('[Z] koffi 不可用，窗口将不置底:', e.message);
}

let zLogged = false;
function pinToBottom() {
  if (!SetWindowPos || !win || win.isDestroyed()) return;
  try {
    // HWND_BOTTOM(1) + SWP_NOMOVE(0x2)|SWP_NOSIZE(0x1)|SWP_NOACTIVATE(0x10)
    SetWindowPos(win.getNativeWindowHandle(), 1, 0, 0, 0, 0, 0x13);
    if (!zLogged) { zLogged = true; console.log('[Z] window pinned to bottom (desktop-widget mode)'); }
  } catch (e) {
    console.error('[Z] pinToBottom failed:', e);
  }
}

/* ---------- 窗口 ---------- */

let win = null;

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

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  console.log('[MAT] window mode=transparent (acrylic 诊断记录见开发日志)');

  // 桌面挂件置底：显示后与失焦时压到底层（点击窗口可临时前置编辑，失焦自动回落）
  win.on('show', () => setTimeout(pinToBottom, 150));
  win.on('blur', pinToBottom);
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

  console.log(
    '[WIN] bounds=' + JSON.stringify(win.getBounds()) +
    (restored ? ' (restored)' : ' (default bottom-right)')
  );

  if (process.env.SCHEDULE_SHOT) runShotSelfCheck();
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
        if (process.env.SCHEDULE_TEST_RESIZE) {
          win.setSize(700, 520); // 验证 resize 事件触发位置保存
          await new Promise((r) => setTimeout(r, 900));
          console.log('[SHOT] resized to ' + JSON.stringify(win.getBounds()));
        }
        await win.webContents.executeJavaScript(
          'document.body.style.background = "#9fb8d0";' // 模拟桌面底色便于查看半透明效果
        );
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(shotDir(), 'dev-screenshot.png'), img.toPNG());
        console.log('[SHOT] ' + JSON.stringify(checks));
        if (process.env.SCHEDULE_E2E) {
          await runPhase2E2E();
          await runPhase3E2E();
          await runPhase4E2E();
        }

        // 截取真实屏幕：验证半透明/磨砂的实际观感（整屏 + 窗口区域）
        const { desktopCapturer } = require('electron');
        const scale = screen.getPrimaryDisplay().scaleFactor || 1;
        console.log('[SHOT] scaleFactor=' + scale + ' display=' + JSON.stringify(screen.getPrimaryDisplay().size));
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
          console.log('[SHOT] screen-crop saved, thumbnail=' + JSON.stringify(srcs[0].thumbnail.getSize()));
        }

        // 设置浮层可打开性断言（截图后再开，避免遮住网格图）
        const settingsOk = await win.webContents.executeJavaScript(`(() => {
          document.getElementById('btn-settings').click();
          const visible = !document.getElementById('settings-overlay').hidden;
          const opened = window.__settingsClicked === true;
          return opened && visible;
        })()`);
        console.log('[SHOT] settingsOpen=' + settingsOk);
        if (settingsOk) {
          await new Promise((r) => setTimeout(r, 300)); // 等浮层完成一帧渲染
          const img2 = await win.webContents.capturePage();
          fs.writeFileSync(path.join(shotDir(), 'dev-screenshot-settings.png'), img2.toPNG());
          await win.webContents.executeJavaScript(`document.getElementById('btn-settings-close').click()`);
        }
      } catch (e) {
        console.error('[SHOT] failed:', e);
      }
      app.quit();
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
  console.log('[WIN] restored default position: ' + JSON.stringify(win.getBounds()));
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

/* ---- 阶段 2 E2E：翻页 / 编辑 / 独立性 / 复制上周 ---- */

async function runPhase2E2E() {
  const js = (code) => win.webContents.executeJavaScript(code);
  const log = (name, ok, detail) =>
    console.log(`[E2E] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' -> ' + detail : ''}`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // 启动周恢复断言（SCHEDULE_EXPECT_WEEK=2 时校验从磁盘恢复的是第 2 周）
    const initialLabel = await js(`document.getElementById('week-label').textContent`);
    if (process.env.SCHEDULE_EXPECT_WEEK) {
      log('initial-restore-week' + process.env.SCHEDULE_EXPECT_WEEK,
        initialLabel.includes(`第 ${process.env.SCHEDULE_EXPECT_WEEK} 周`), initialLabel);
    } else {
      console.log('[E2E] initial-week -> ' + initialLabel);
    }
    // 归一到第 1 周，保证后续断言确定性
    for (let i = 0; i < 40; i++) {
      if ((await js(`document.getElementById('week-label').textContent`)).includes('第 1 周')) break;
      await js(`document.getElementById('btn-prev').click()`);
      await wait(30);
    }
    await js(`document.getElementById('btn-next').click()`);
    const weekLabel = await js(`document.getElementById('week-label').textContent`);
    log('nav-to-week2', weekLabel.includes('第 2 周'), weekLabel);

    await js(`document.querySelectorAll('.cell:not(.time)')[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await js(`(() => {
      const i = document.querySelector('.cell-editor');
      i.value = '高等数学\n习题课';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await wait(400); // 等保存落盘
    log('edit-week2-multiline-cell',
      (await js(`document.querySelectorAll('.cell:not(.time)')[0].textContent`)) === '高等数学\n习题课');

    await js(`document.getElementById('btn-next').click()`);
    log('week3-independent',
      (await js(`document.querySelectorAll('.cell:not(.time)')[0].textContent`)) === '');

    await js(`window.confirm = () => true; document.getElementById('btn-copy').click()`);
    log('copy-prev-week',
      (await js(`document.querySelectorAll('.cell:not(.time)')[0].textContent`)) === '高等数学\n习题课');

    await js(`document.getElementById('btn-today').click()`);
    log('back-to-today', (await js(`document.getElementById('week-label').textContent`)).includes('第 1 周'));

    await js(`document.getElementById('btn-next').click()`); // 结束在周 2：供下一次运行的恢复断言
  } catch (e) {
    console.error('[E2E] failed:', e);
  }
}

/* ---- 阶段 3 E2E：设置面板 ---- */

async function runPhase3E2E() {
  const js = (code) => win.webContents.executeJavaScript(code);
  const log = (name, ok, detail) =>
    console.log(`[E2E3] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' -> ' + detail : ''}`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const eq = (a, b) => a === b;
  try {
    await js(`document.getElementById('btn-settings').click()`);
    log('open-settings', await js(`!document.getElementById('settings-overlay').hidden`));
    for (let i = 0; i < 20; i++) {
      if (!(await js(`document.getElementById('btn-settings-save').disabled`))) break;
      await wait(50);
    }
    log('autostart-ready', !(await js(`document.getElementById('btn-settings-save').disabled`)));

    // 每天课数 8 → 9（草稿即时联动时间列表）
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

    // 开学日期 + 不透明度 0.8（input 事件触发即时预览）
    await js(`(() => {
      const d = document.getElementById('set-semester-start'); d.value = '2026-09-07';
      const o = document.getElementById('set-opacity'); o.value = '0.8';
      o.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    await js(`document.getElementById('btn-settings-save').click()`);
    await wait(400);

    log('grid-rows-9', eq(await js(`document.querySelectorAll('.cell-row').length`), 9));
    log('time-updated', eq(await js(`document.querySelector('.cell.time span').textContent`), '08:10'));
    log('hint-hidden', await js(`document.getElementById('hint').hidden`));
    const appBg = await js(`getComputedStyle(document.getElementById('app')).backgroundColor`);
    log('alpha-applied', /rgba\(214, 232, 248, 0\.8/.test(appBg), appBg);

    // 重开设置：值应从已保存数据回填
    await js(`document.getElementById('btn-settings').click()`);
    log('reopen-persisted',
      eq(await js(`document.getElementById('set-periods').value`), '9') &&
      eq(await js(`document.getElementById('set-semester-start').value`), '2026-09-07'));
    await js(`document.getElementById('btn-settings-cancel').click()`);
  } catch (e) {
    console.error('[E2E3] failed:', e);
  }
}

/* ---- 阶段 4 E2E：当前天 / 当前节高亮 ---- */

async function runPhase4E2E() {
  const js = (code) => win.webContents.executeJavaScript(code);
  const log = (name, ok, detail) =>
    console.log(`[E2E4] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' -> ' + detail : ''}`);
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
    console.error('[E2E4] failed:', e);
  }
}

/* ---------- 生命周期 ---------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.floating.schedule');

    if (process.env.SCHEDULE_STORE_E2E) {
      try {
        runStoreSelfCheck();
      } catch (error) {
        process.exitCode = 1;
        console.error('[STORE-E2E] FAIL:', error.message);
      }
      app.quit();
      return;
    }

    // 打包版自检钩子：注册开机自启并立即撤销（验证 exe 路径下 API 可用）
    if (process.env.SCHEDULE_TEST_AUTOSTART) {
      try {
        app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
        const on = app.getLoginItemSettings().openAtLogin;
        console.log('[AUTOSTART] enable -> ' + on + ' path=' + process.execPath);
        app.setLoginItemSettings({ openAtLogin: false, path: process.execPath });
        console.log('[AUTOSTART] disable -> ' + app.getLoginItemSettings().openAtLogin);
      } catch (e) {
        console.error('[AUTOSTART] failed:', e);
      }
    }

    ipcMain.handle('app:quit', () => app.quit());
    ipcMain.handle('store:load', () => loadStore());
    ipcMain.handle('store:save', (_e, data) => saveStore(data));
    ipcMain.handle('app:set-autostart', (_e, v) => {
      app.setLoginItemSettings({ openAtLogin: !!v, path: process.execPath });
      return app.getLoginItemSettings().openAtLogin;
    });
    ipcMain.handle('app:get-autostart', () => app.getLoginItemSettings().openAtLogin);
    createWindow();
    createTray();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}

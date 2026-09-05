// 悬浮课表 · 渲染层：课表渲染 / 编辑 / 翻页 / 复制上周
const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEKDAY_COUNT = 5;

let data = null;      // schedule.json 业务快照；保存时主进程会忽略其中的 window 字段
let viewWeek = 1;     // 当前显示周
let editingKey = null; // 正在编辑的格子 'day-period'
let editingWeek = null;
let editingSavePromise = null;
let scheduleSaving = false;
let saveQueue = Promise.resolve();
let copyConfirmResolve = null;
let copyConfirmOpener = null;

const $ = (sel) => document.querySelector(sel);

/* ---------- 周计算 ---------- */

function mondayOf(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return NaN;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 周一为一周起点
  return d.getTime();
}

function currentWeek() {
  const s = data?.settings;
  if (!s || !s.semesterStart) return 1;
  const start = mondayOf(s.semesterStart);
  if (isNaN(start)) return 1;
  const n = Math.floor((mondayOf(new Date()) - start) / 604800000) + 1;
  return Math.min(Math.max(n, 1), s.weekCount || 1);
}

/* ---------- 数据访问 ---------- */

function cellText(week, day, period) {
  const arr = data.weeks[week]?.[day];
  return (arr && arr[period]) || '';
}

function cellAriaLabel(day, period, text) {
  const course = text ? `课程：${text.replace(/\n/g, '；')}` : '空课程';
  return `${DAY_NAMES[day]}第 ${period + 1} 节，${course}。按 Enter 或空格编辑`;
}

function updateCellAccessibility(cell, day, period, text) {
  cell.tabIndex = 0;
  cell.setAttribute('role', 'button');
  cell.setAttribute('aria-label', cellAriaLabel(day, period, text));
}

function cloneStore(store = data) {
  return JSON.parse(JSON.stringify(store));
}

function setCellText(store, week, day, period, text) {
  if (!store.weeks[week]) store.weeks[week] = {};
  const arr = store.weeks[week][day] || (store.weeks[week][day] = []);
  arr[period] = text;
}

function visibleDayCount(store = data) {
  return store?.settings?.showWeekend ? DAY_NAMES.length : WEEKDAY_COUNT;
}

function setSaveError(error, action = '保存失败') {
  const status = $('#save-status');
  status.textContent = `${action}：${chineseErrorMessage(error, '请检查程序目录权限后重试')}`;
  status.hidden = false;
}

function clearSaveError() {
  const status = $('#save-status');
  status.textContent = '';
  status.hidden = true;
}

function saveData(store = data) {
  const snapshot = cloneStore(store);
  const request = saveQueue.catch(() => {}).then(() => window.api.save(snapshot));
  saveQueue = request;
  return request;
}

/* ---------- 渲染 ---------- */

function renderHead() {
  const head = $('#head-row');
  head.innerHTML = '';
  const timeHead = document.createElement('div');
  timeHead.className = 'time-head';
  timeHead.textContent = '时间';
  head.appendChild(timeHead);
  DAY_NAMES.slice(0, visibleDayCount()).forEach((name, i) => {
    const day = document.createElement('div');
    day.className = 'day-head';
    day.dataset.day = name;
    day.dataset.dayIndex = i;
    day.textContent = name;
    head.appendChild(day);
  });
}

function renderGrid() {
  const body = $('#grid-body');
  body.innerHTML = '';
  const times = data.settings.periodTimes || [];
  const n = data.settings.periodsPerDay;
  for (let p = 0; p < n; p++) {
    const row = document.createElement('div');
    row.className = 'cell-row';

    const timeCell = document.createElement('div');
    timeCell.className = 'cell time';
    const t = times[p];
    if (t) {
      const s = document.createElement('span');
      s.textContent = t.start;
      const e = document.createElement('span');
      e.textContent = t.end;
      timeCell.append(s, e);
    } else {
      timeCell.textContent = ' ';
    }
    row.appendChild(timeCell);

    for (let d = 0; d < visibleDayCount(); d++) {
      const text = cellText(viewWeek, d, p);
      const cell = document.createElement('div');
      cell.className = 'cell' + (text ? '' : ' empty');
      cell.dataset.day = d;
      cell.dataset.period = p;
      updateCellAccessibility(cell, d, p, text);
      cell.textContent = text;
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
}

function renderHeader() {
  const s = data.settings;
  const isCurrent = !!s.semesterStart && viewWeek === currentWeek();
  $('#week-label').innerHTML =
    `第 ${viewWeek} 周 ／ 共 ${s.weekCount} 周` +
    (isCurrent ? `<span class="cur-week"> · 本周</span>` : '');
  $('#btn-prev').disabled = scheduleSaving || viewWeek <= 1;
  $('#btn-next').disabled = scheduleSaving || viewWeek >= s.weekCount;
  $('#btn-copy').disabled = scheduleSaving || viewWeek <= 1;
  $('#btn-today').disabled = scheduleSaving || viewWeek === currentWeek() || !s.semesterStart;
  $('#btn-settings').disabled = scheduleSaving;
  const hint = $('#hint');
  hint.hidden = !!s.semesterStart;
  const setupButton = $('#btn-set-semester');
  if (setupButton) setupButton.disabled = scheduleSaving;
}

function setScheduleBusy(busy) {
  scheduleSaving = busy;
  $('#app').setAttribute('aria-busy', String(busy));
  $('#app').classList.toggle('schedule-saving', busy);
  $('#grid-body').inert = busy;
  renderHeader();
}

function renderAll() {
  const dayCount = visibleDayCount();
  const scroll = $('#scroll');
  scroll.style.setProperty('--day-count', dayCount);
  scroll.classList.toggle('weekend-visible', dayCount === DAY_NAMES.length);
  renderHead();
  renderHeader();
  renderGrid();
  refreshHighlight();
}

/* ---------- 当前天 / 当前节高亮（F10，30 秒刷新） ---------- */

function refreshHighlight() {
  const d = new Date();
  const dayIndex = (d.getDay() + 6) % 7; // 0=周一 .. 4=周五, 5/6=周末
  const viewingCurrentWeek = !!data.settings.semesterStart && viewWeek === currentWeek();
  const today = viewingCurrentWeek && dayIndex < visibleDayCount() ? dayIndex : -1;
  const minutes = d.getHours() * 60 + d.getMinutes();

  // 当前正在上的节次（按 settings 时间表判断；仅今天列生效）
  let nowP = -1;
  if (today >= 0) {
    const times = data.settings.periodTimes || [];
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (!t || !t.start || !t.end) continue;
      const s = timeToMinutes(t.start);
      const e = timeToMinutes(t.end);
      if (!isNaN(s) && !isNaN(e) && minutes >= s && minutes <= e) nowP = i;
    }
  }

  document.querySelectorAll('.day-head').forEach((el) => {
    el.classList.toggle('today', +el.dataset.dayIndex === today);
  });
  document.querySelectorAll('.cell[data-day]').forEach((el) => {
    const day = +el.dataset.day;
    el.classList.toggle('today', day === today);
    el.classList.toggle('now', day === today && +el.dataset.period === nowP);
  });
}

/* ---------- 编辑 ---------- */

async function startEdit(cell) {
  if (scheduleSaving || !$('#settings-overlay').hidden || !$('#copy-confirm-overlay').hidden) return;
  const day = +cell.dataset.day;
  const period = +cell.dataset.period;
  const nextKey = `${day}-${period}`;
  if (editingKey === nextKey) return;
  if (editingKey !== null && !(await commitEdit())) return; // 保存成功后再切换格子
  if (scheduleSaving || editingKey !== null || !cell.isConnected) return;
  editingKey = `${day}-${period}`;
  editingWeek = viewWeek;
  cell.classList.add('editing');
  cell.classList.remove('empty');
  cell.textContent = '';
  cell.removeAttribute('role');
  cell.removeAttribute('tabindex');
  cell.setAttribute('aria-label', `正在编辑${DAY_NAMES[day]}第 ${period + 1} 节课程`);

  const input = document.createElement('textarea');
  input.className = 'cell-editor';
  input.setAttribute('aria-label', `${DAY_NAMES[day]}第 ${period + 1} 节课程`);
  input.value = cellText(viewWeek, day, period);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void commitEdit(); }
    else if (e.key === 'Escape') { cancelEdit(); }
  });
  input.addEventListener('blur', () => { void commitEdit(); });
  cell.appendChild(input);
  if (editingKey === nextKey && input.isConnected) {
    input.focus();
    input.select();
  }
}

function activeCell(day, period) {
  return document.querySelector(`.cell[data-day="${day}"][data-period="${period}"]`);
}

function finishEdit(cell, day, period, text) {
  editingKey = null;
  editingWeek = null;
  if (!cell) return;
  cell.classList.remove('editing', 'saving');
  cell.removeAttribute('aria-busy');
  cell.textContent = text;
  cell.classList.toggle('empty', !text);
  updateCellAccessibility(cell, day, period, text);
  cell.focus();
}

function commitEdit() {
  if (editingSavePromise) return editingSavePromise;
  if (editingKey === null) return Promise.resolve(true);
  const key = editingKey;
  const week = editingWeek;
  const [day, period] = key.split('-').map(Number);
  const cell = activeCell(day, period);
  const input = cell && cell.querySelector('.cell-editor');
  const text = (input?.value || '').trim();
  const previousText = cellText(week, day, period);
  if (previousText === text) {
    finishEdit(cell, day, period, text);
    return Promise.resolve(true);
  }

  const operation = (async () => {
    input.disabled = true;
    cell.classList.add('saving');
    cell.setAttribute('aria-busy', 'true');
    try {
      const next = cloneStore(data);
      setCellText(next, week, day, period, text);
      const saved = await saveData(next);
      data = saved;
      clearSaveError();
      finishEdit(cell, day, period, text);
      return true;
    } catch (error) {
      setSaveError(error, '课程保存失败');
      input.disabled = false;
      cell.classList.remove('saving');
      cell.removeAttribute('aria-busy');
      setTimeout(() => {
        if (editingKey === key && input.isConnected) input.focus();
      }, 0);
      return false;
    }
  })();
  editingSavePromise = operation;
  operation.finally(() => {
    if (editingSavePromise === operation) editingSavePromise = null;
  });
  return operation;
}

function cancelEdit() {
  if (editingKey === null || editingSavePromise) return;
  const [day, period] = editingKey.split('-').map(Number);
  const cell = activeCell(day, period);
  editingKey = null;
  editingWeek = null;
  if (cell) {
    cell.classList.remove('editing');
    const text = cellText(viewWeek, day, period);
    cell.textContent = text;
    cell.classList.toggle('empty', !text);
    updateCellAccessibility(cell, day, period, text);
    const input = cell.querySelector('.cell-editor');
    input && input.remove();
    cell.focus();
  }
}

/* ---------- 事件 ---------- */

function bindEvents() {
  $('#grid-body').addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.cell:not(.time)');
    if (cell) void startEdit(cell);
  });
  $('#grid-body').addEventListener('keydown', (e) => {
    if (e.target.matches('.cell-editor')) return;
    const cell = e.target.closest('.cell:not(.time)');
    if (cell && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      void startEdit(cell);
    }
  });
  $('#btn-prev').addEventListener('click', () => { void goWeek(viewWeek - 1); });
  $('#btn-next').addEventListener('click', () => { void goWeek(viewWeek + 1); });
  $('#btn-today').addEventListener('click', () => { void goWeek(currentWeek()); });
  $('#btn-copy').addEventListener('click', () => { void copyPrevWeek(); });
  $('#btn-copy-confirm-cancel').addEventListener('click', () => closeCopyConfirmation(false));
  $('#btn-copy-confirm-ok').addEventListener('click', () => closeCopyConfirmation(true));
  $('#btn-settings').addEventListener('click', () => { void openSettings(); });
  $('#btn-set-semester').addEventListener('click', () => { void openSettings(); });
  $('#btn-settings-close').addEventListener('click', () => closeSettings(false));
  $('#btn-settings-cancel').addEventListener('click', () => closeSettings(false));
  $('#btn-settings-save').addEventListener('click', () => saveSettings());
  $('#btn-quit').addEventListener('click', () => window.api.quit());
  $('#btn-add-period').addEventListener('click', () => addTimeRow());
  $('#set-show-weekend').addEventListener('change', () => {
    if (draft) draft.showWeekend = $('#set-show-weekend').checked;
  });
  $('#set-periods').addEventListener('change', () => {
    draft.periodsPerDay = Math.min(Math.max(+$('#set-periods').value || 8, 4), 14);
    $('#set-periods').value = draft.periodsPerDay;
    rebuildTimeRows();
  });
  $('#set-opacity').addEventListener('input', () => {
    const v = +$('#set-opacity').value;
    $('#opacity-value').textContent = Math.round(v * 100) + '%';
    document.documentElement.style.setProperty('--alpha', v);
  });
  document.addEventListener('keydown', (e) => {
    const copyOverlay = $('#copy-confirm-overlay');
    if (!copyOverlay.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeCopyConfirmation(false);
        return;
      }
      if (e.key === 'Tab') {
        const first = $('#btn-copy-confirm-cancel');
        const last = $('#btn-copy-confirm-ok');
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        } else if (![first, last].includes(document.activeElement)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
      return;
    }
    const overlay = $('#settings-overlay');
    if (overlay.hidden) return;
    if (e.key === 'Escape' && !settingsSaving) {
      e.preventDefault();
      closeSettings(false);
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = [...$('#settings-panel').querySelectorAll(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter(isVisibleForFocus);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (!$('#settings-panel').contains(active) || !focusables.includes(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

function requestCopyConfirmation() {
  if (copyConfirmResolve) return Promise.resolve(false);
  copyConfirmOpener = $('#btn-copy');
  $('#copy-confirm-overlay').hidden = false;
  $('#btn-copy-confirm-cancel').focus();
  return new Promise((resolve) => { copyConfirmResolve = resolve; });
}

function closeCopyConfirmation(confirmed) {
  if (!copyConfirmResolve) return;
  const resolve = copyConfirmResolve;
  const opener = copyConfirmOpener;
  copyConfirmResolve = null;
  copyConfirmOpener = null;
  $('#copy-confirm-overlay').hidden = true;
  if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  resolve(confirmed);
}

/* Tab 循环只纳入当前确实可见的控件，避免 4/14 节边界的 hidden 控件抢焦点。 */
function isVisibleForFocus(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
    && element.getClientRects().length > 0;
}

/* ---------- 设置面板 ---------- */

let draft = null;
let prevAlpha = 0.65;
let settingsSession = 0;
let autoStartLoading = false;
let autoStartResolved = false;
let settingsSaving = false;
let settingsOpener = null;

function setSettingsBusy(busy) {
  const saving = settingsSaving;
  $('#settings-body').querySelectorAll('button, input').forEach((control) => {
    control.disabled = saving;
  });
  $('#set-autostart').disabled = saving || busy || !autoStartResolved;
  $('#btn-settings-save').disabled = busy || saving || !autoStartResolved;
  $('#btn-settings-close').disabled = settingsSaving;
  $('#btn-settings-cancel').disabled = settingsSaving;
  $('#btn-quit').disabled = settingsSaving;
  $('#btn-settings-save').textContent = saving ? '保存中…' : '保存';
  $('#settings-panel').setAttribute('aria-busy', String(saving || busy));
}

function chineseErrorMessage(error, fallback) {
  const message = String(error?.message || '').trim();
  return /[\u3400-\u9fff]/.test(message) ? message : fallback;
}

function setSettingsError(target, message, error, fallback = '请检查程序目录权限或系统设置后重试') {
  const status = $(target);
  const detail = error ? `：${chineseErrorMessage(error, fallback)}` : '';
  status.textContent = `${message}${detail}`;
  status.hidden = false;
}

function clearSettingsError() {
  ['#settings-error', '#time-error', '#autostart-error'].forEach((target) => {
    const status = $(target);
    status.textContent = '';
    status.hidden = true;
  });
}

function timeToMinutes(value) {
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
}

function validatePeriodTimes(times) {
  let previousEnd = -1;
  for (let i = 0; i < times.length; i++) {
    const { start = '', end = '' } = times[i] || {};
    if (!start && !end) continue;
    if (!start || !end) return `第 ${i + 1} 节需要同时填写开始和结束时间`;
    const startMinute = timeToMinutes(start);
    const endMinute = timeToMinutes(end);
    if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute) || startMinute >= endMinute) {
      return `第 ${i + 1} 节的结束时间必须晚于开始时间`;
    }
    if (startMinute < previousEnd) return `第 ${i + 1} 节与上一节时间重叠或顺序错误`;
    previousEnd = endMinute;
  }
  return '';
}

async function openSettings() {
  if (scheduleSaving || !(await commitEdit())) return;
  if (scheduleSaving || !$('#settings-overlay').hidden) return;
  if (window.api.testMode) window.__settingsClicked = true;
  settingsOpener = document.activeElement;
  const session = ++settingsSession;
  const s = data.settings;
  draft = {
    periodsPerDay: s.periodsPerDay,
    times: JSON.parse(JSON.stringify(s.periodTimes || [])),
    showWeekend: !!s.showWeekend,
    initialAutoStart: !!s.autoStart,
  };
  prevAlpha = s.opacity ?? 0.65;
  $('#set-periods').value = draft.periodsPerDay;
  $('#set-show-weekend').checked = draft.showWeekend;
  $('#set-weeks').value = s.weekCount;
  $('#set-semester-start').value = s.semesterStart || '';
  $('#set-opacity').value = prevAlpha;
  $('#opacity-value').textContent = Math.round(prevAlpha * 100) + '%';
  rebuildTimeRows();
  clearSettingsError();
  $('#settings-overlay').hidden = false;
  autoStartLoading = true;
  autoStartResolved = false;
  setSettingsBusy(true);
  $('#set-autostart').checked = draft.initialAutoStart;
  $('#set-periods').focus();
  window.api.getAutoStart().then((v) => {
    if (session !== settingsSession || !draft) return;
    draft.initialAutoStart = !!v;
    $('#set-autostart').checked = !!v;
    autoStartResolved = true;
  }).catch((error) => {
    if (session !== settingsSession || !draft) return;
    setSettingsError('#autostart-error', '读取开机自启失败', error, '请关闭设置后重新打开再试');
  }).finally(() => {
    if (session !== settingsSession || !draft) return;
    autoStartLoading = false;
    setSettingsBusy(false);
  });
}

function rebuildTimeRows() {
  const wrap = $('#set-times');
  wrap.innerHTML = '';
  for (let i = 0; i < draft.periodsPerDay; i++) {
    const row = document.createElement('div');
    row.className = 'time-row';
    const label = document.createElement('span');
    label.className = 'time-row-label';
    label.textContent = `第 ${i + 1} 节`;
    const start = document.createElement('input');
    start.type = 'time';
    start.value = draft.times[i]?.start || '';
    start.addEventListener('change', () => {
      if (!draft.times[i]) draft.times[i] = {};
      draft.times[i].start = start.value;
    });
    const end = document.createElement('input');
    end.type = 'time';
    end.value = draft.times[i]?.end || '';
    end.addEventListener('change', () => {
      if (!draft.times[i]) draft.times[i] = {};
      draft.times[i].end = end.value;
    });
    const del = document.createElement('button');
    del.className = 'time-row-del';
    del.textContent = '✕';
    del.title = '删除本节';
    del.hidden = draft.periodsPerDay <= 4;
    del.addEventListener('click', () => removeTimeRow(i));
    row.append(label, start, end, del);
    wrap.appendChild(row);
  }
  $('#set-periods').value = draft.periodsPerDay;
  $('#btn-add-period').hidden = draft.periodsPerDay >= 14;
}

function addTimeRow() {
  if (draft.periodsPerDay >= 14) return;
  draft.periodsPerDay++;
  rebuildTimeRows();
}

function removeTimeRow(i) {
  if (draft.periodsPerDay <= 4) return;
  draft.times.splice(i, 1);
  draft.periodsPerDay--;
  rebuildTimeRows();
}

function closeSettings(commit) {
  if (!commit) {
    document.documentElement.style.setProperty('--alpha', prevAlpha); // 还原透明度预览
  }
  $('#settings-overlay').hidden = true;
  settingsSession++;
  autoStartLoading = false;
  autoStartResolved = false;
  settingsSaving = false;
  draft = null;
  if (settingsOpener instanceof HTMLElement && settingsOpener.isConnected) settingsOpener.focus();
  settingsOpener = null;
}

async function saveSettings() {
  if (!draft || autoStartLoading || settingsSaving) return;
  clearSettingsError();
  const next = JSON.parse(JSON.stringify(data));
  const s = next.settings;
  s.periodsPerDay = Math.min(Math.max(+$('#set-periods').value || 8, 4), 14);
  s.weekCount = Math.min(Math.max(+$('#set-weeks').value || 20, 1), 30);
  s.semesterStart = $('#set-semester-start').value || '';
  s.opacity = +$('#set-opacity').value;
  s.showWeekend = !!draft.showWeekend;
  s.autoStart = $('#set-autostart').checked || false;
  // 节次时间与每天课数对齐（不足补空、多余截断）
  s.periodTimes = draft.times.slice(0, s.periodsPerDay);
  while (s.periodTimes.length < s.periodsPerDay) s.periodTimes.push({ start: '', end: '' });
  // 旧周数据按行补齐/截断
  const timeError = validatePeriodTimes(s.periodTimes);
  if (timeError) {
    setSettingsError('#time-error', '节次时间有误', new Error(timeError));
    return;
  }
  for (const w of Object.keys(next.weeks)) {
    for (let d = 0; d < DAY_NAMES.length; d++) {
      const arr = next.weeks[w]?.[d];
      if (!arr) continue;
      next.weeks[w][d] = arr.slice(0, s.periodsPerDay);
      while (next.weeks[w][d].length < s.periodsPerDay) next.weeks[w][d].push('');
    }
  }
  if (viewWeek > s.weekCount) next.viewWeek = s.weekCount;
  settingsSaving = true;
  setSettingsBusy(true);
  let autoStartBeforeSave = null;
  let autoStartWritten = false;
  try {
    if (autoStartResolved) {
      const result = await window.api.setAutoStart(s.autoStart);
      const actualAutoStart = typeof result === 'object' ? result.current : result;
      autoStartBeforeSave = typeof result === 'object' ? result.previous : draft.initialAutoStart;
      if (actualAutoStart !== s.autoStart) throw new Error('开机自启状态未能更新');
      autoStartWritten = true;
    }
    const saved = await saveData(next);
    data = saved;
    if (viewWeek > s.weekCount) viewWeek = s.weekCount;
    document.documentElement.style.setProperty('--alpha', s.opacity);
    clearSaveError();
    closeSettings(true);
    renderAll();
  } catch (error) {
    let rollbackError = null;
    if (draft && autoStartResolved && autoStartWritten && autoStartBeforeSave !== null) {
      try {
        const rollbackResult = await window.api.setAutoStart(autoStartBeforeSave);
        const rolledBack = typeof rollbackResult === 'object' ? rollbackResult.current : rollbackResult;
        if (rolledBack !== autoStartBeforeSave) throw new Error('开机自启状态未能还原');
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
      }
    }
    const action = autoStartWritten ? '设置保存失败' : '无法保存设置';
    setSettingsError('#settings-error', action, error);
    if (rollbackError) {
      setSettingsError('#settings-error', `${action}；开机自启状态回退失败`, rollbackError);
    }
    settingsSaving = false;
    setSettingsBusy(false);
  }
}

async function goWeek(n) {
  if (scheduleSaving || !(await commitEdit())) return;
  if (scheduleSaving) return;
  const targetWeek = Math.min(Math.max(n, 1), data.settings.weekCount);
  if (targetWeek === viewWeek) return;
  setScheduleBusy(true);
  try {
    const next = cloneStore(data);
    next.viewWeek = targetWeek; // 保存成功后才切换界面
    const saved = await saveData(next);
    data = saved;
    viewWeek = targetWeek;
    clearSaveError();
    renderAll();
  } catch (error) {
    setSaveError(error, '切换周次失败');
  } finally {
    setScheduleBusy(false);
  }
}

async function copyPrevWeek() {
  if (scheduleSaving || viewWeek <= 1 || !(await commitEdit())) return;
  if (scheduleSaving || viewWeek <= 1) return;
  const confirmed = await requestCopyConfirmation();
  if (!confirmed) return;
  const copyButton = $('#btn-copy');
  setScheduleBusy(true);
  try {
    const next = cloneStore(data);
    const prev = next.weeks[viewWeek - 1] || {};
    next.weeks[viewWeek] = cloneStore(prev);
    const saved = await saveData(next);
    data = saved;
    clearSaveError();
    renderAll();
  } catch (error) {
    setSaveError(error, '复制上周失败');
  } finally {
    setScheduleBusy(false);
    if (copyButton.isConnected && !copyButton.disabled) copyButton.focus();
  }
}

/* ---------- 启动 ---------- */

async function init() {
  data = await window.api.load();
  if (!data.weeks || typeof data.weeks !== 'object') data.weeks = {};
  // 恢复上次查看的周；无记录或越界时退回当前周
  const s = data.settings;
  viewWeek = (typeof data.viewWeek === 'number' && data.viewWeek >= 1 && data.viewWeek <= s.weekCount)
    ? data.viewWeek
    : currentWeek();
  document.documentElement.style.setProperty('--alpha', s.opacity ?? 0.65);
  setInterval(refreshHighlight, 30000); // 30 秒检查一次当前天/节
  if (window.api.testMode) window.__refreshHighlight = refreshHighlight; // 仅供隔离 E2E 消除时间差
  bindEvents();
  renderAll();
}

init();

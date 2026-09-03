// 悬浮课表 · 渲染层：课表渲染 / 编辑 / 翻页 / 复制上周
const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五'];

let data = null;      // schedule.json 全量（窗口 bounds 字段由主进程维护，渲染层不改）
let viewWeek = 1;     // 当前显示周
let editingKey = null; // 正在编辑的格子 'day-period'
let saveQueue = Promise.resolve();

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

function setCellText(week, day, period, text) {
  if (!data.weeks[week]) data.weeks[week] = {};
  const arr = data.weeks[week][day] || (data.weeks[week][day] = []);
  arr[period] = text;
  void saveData().catch(() => {});
}

function setSaveError(error) {
  const status = $('#save-status');
  status.textContent = `保存失败：${error?.message || '请检查程序目录权限后重试'}`;
  status.hidden = false;
}

function clearSaveError() {
  const status = $('#save-status');
  status.textContent = '';
  status.hidden = true;
}

function saveData(store = data) {
  const request = saveQueue.catch(() => {}).then(() => window.api.save(store));
  saveQueue = request;
  return request.then(() => {
    clearSaveError();
    return true;
  }).catch((error) => {
    setSaveError(error);
    throw error;
  });
}

/* ---------- 渲染 ---------- */

function renderHead() {
  const head = $('#head-row');
  head.innerHTML = '';
  const timeHead = document.createElement('div');
  timeHead.className = 'time-head';
  timeHead.textContent = '时间';
  head.appendChild(timeHead);
  DAY_NAMES.forEach((name, i) => {
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

    for (let d = 0; d < 5; d++) {
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
  $('#btn-prev').disabled = viewWeek <= 1;
  $('#btn-next').disabled = viewWeek >= s.weekCount;
  $('#btn-copy').disabled = viewWeek <= 1;
  $('#btn-today').disabled = viewWeek === currentWeek() || !s.semesterStart;
  const hint = $('#hint');
  hint.hidden = !!s.semesterStart;
  hint.textContent = '尚未设置开学日期，暂以第 1 周显示';
}

function renderAll() {
  renderHead();
  renderHeader();
  renderGrid();
  refreshHighlight();
}

/* ---------- 当前天 / 当前节高亮（F10，30 秒刷新） ---------- */

function toMin(text) {
  const [h, m] = String(text).split(':').map(Number);
  return h * 60 + m;
}

function refreshHighlight() {
  const d = new Date();
  const dayIndex = (d.getDay() + 6) % 7; // 0=周一 .. 4=周五, 5/6=周末
  const viewingCurrentWeek = viewWeek === currentWeek();
  const today = viewingCurrentWeek && dayIndex <= 4 ? dayIndex : -1;
  const minutes = d.getHours() * 60 + d.getMinutes();

  // 当前正在上的节次（按 settings 时间表判断；仅今天列生效）
  let nowP = -1;
  if (today >= 0) {
    const times = data.settings.periodTimes || [];
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (!t || !t.start || !t.end) continue;
      const s = toMin(t.start);
      const e = toMin(t.end);
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

function startEdit(cell) {
  if (editingKey !== null) commitEdit(); // 先提交上一个编辑
  const day = +cell.dataset.day;
  const period = +cell.dataset.period;
  editingKey = `${day}-${period}`;
  cell.classList.add('editing');
  cell.classList.remove('empty');
  cell.textContent = '';
  cell.removeAttribute('role');
  cell.removeAttribute('tabindex');
  cell.setAttribute('aria-label', `正在编辑${DAY_NAMES[day]}第 ${period + 1} 节课程`);

  const input = document.createElement('textarea');
  input.className = 'cell-editor';
  input.setAttribute('aria-label', `${DAY_NAMES[day]}第 ${period + 1} 节课程`);
  input.maxLength = 30;
  input.value = cellText(viewWeek, day, period);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEdit(); }
    else if (e.key === 'Escape') { cancelEdit(); }
  });
  input.addEventListener('blur', () => commitEdit());
  cell.appendChild(input);
  input.focus();
  input.select();
}

function activeCell(day, period) {
  return document.querySelector(`.cell[data-day="${day}"][data-period="${period}"]`);
}

function commitEdit() {
  if (editingKey === null) return;
  const [day, period] = editingKey.split('-').map(Number);
  const cell = activeCell(day, period);
  const input = cell && cell.querySelector('.cell-editor');
  const text = (input && input.value || '').trim();
  editingKey = null;
  if (cell) {
    cell.classList.remove('editing');
    cell.textContent = text;
    cell.classList.toggle('empty', !text);
    updateCellAccessibility(cell, day, period, text);
  }
  if (cellText(viewWeek, day, period) !== text) setCellText(viewWeek, day, period, text);
  input && input.remove();
  cell && cell.focus();
}

function cancelEdit() {
  if (editingKey === null) return;
  const [day, period] = editingKey.split('-').map(Number);
  const cell = activeCell(day, period);
  editingKey = null;
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
    if (cell) startEdit(cell);
  });
  $('#grid-body').addEventListener('keydown', (e) => {
    if (e.target.matches('.cell-editor')) return;
    const cell = e.target.closest('.cell:not(.time)');
    if (cell && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      startEdit(cell);
    }
  });
  $('#btn-prev').addEventListener('click', () => goWeek(viewWeek - 1));
  $('#btn-next').addEventListener('click', () => goWeek(viewWeek + 1));
  $('#btn-today').addEventListener('click', () => goWeek(currentWeek()));
  $('#btn-copy').addEventListener('click', () => copyPrevWeek());
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-settings-close').addEventListener('click', () => closeSettings(false));
  $('#btn-settings-cancel').addEventListener('click', () => closeSettings(false));
  $('#btn-settings-save').addEventListener('click', () => saveSettings());
  $('#btn-quit').addEventListener('click', () => window.api.quit());
  $('#btn-add-period').addEventListener('click', () => addTimeRow());
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
  $('#set-autostart').addEventListener('change', () => { draft.autoStart = $('#set-autostart').checked; });
  document.addEventListener('keydown', (e) => {
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
    )];
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
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
  $('#btn-settings-save').disabled = busy || saving;
  $('#btn-settings-close').disabled = settingsSaving;
  $('#btn-settings-cancel').disabled = settingsSaving;
  $('#btn-quit').disabled = settingsSaving;
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

function openSettings() {
  window.__settingsClicked = true;
  settingsOpener = document.activeElement;
  const session = ++settingsSession;
  const s = data.settings;
  draft = {
    periodsPerDay: s.periodsPerDay,
    times: JSON.parse(JSON.stringify(s.periodTimes || [])),
    autoStart: !!s.autoStart,
    initialAutoStart: !!s.autoStart,
  };
  prevAlpha = s.opacity ?? 0.65;
  $('#set-periods').value = draft.periodsPerDay;
  $('#set-weeks').value = s.weekCount;
  $('#set-semester-start').value = s.semesterStart || '';
  $('#set-opacity').value = prevAlpha;
  $('#opacity-value').textContent = Math.round(prevAlpha * 100) + '%';
  rebuildTimeRows();
  $('#settings-overlay').hidden = false;
  autoStartLoading = true;
  autoStartResolved = false;
  setSettingsBusy(true);
  $('#set-autostart').checked = draft.autoStart;
  $('#set-periods').focus();
  window.api.getAutoStart().then((v) => {
    if (session !== settingsSession || !draft) return;
    draft.autoStart = !!v;
    draft.initialAutoStart = !!v;
    $('#set-autostart').checked = !!v;
    autoStartResolved = true;
  }).catch((error) => {
    if (session !== settingsSession || !draft) return;
    setSaveError(error);
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
    del.addEventListener('click', () => removeTimeRow(i));
    row.append(label, start, end, del);
    wrap.appendChild(row);
  }
  $('#set-periods').value = draft.periodsPerDay;
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
  const next = JSON.parse(JSON.stringify(data));
  const s = next.settings;
  s.periodsPerDay = Math.min(Math.max(+$('#set-periods').value || 8, 4), 14);
  s.weekCount = Math.min(Math.max(+$('#set-weeks').value || 20, 1), 30);
  s.semesterStart = $('#set-semester-start').value || '';
  s.opacity = +$('#set-opacity').value;
  s.autoStart = $('#set-autostart').checked || false;
  // 节次时间与每天课数对齐（不足补空、多余截断）
  s.periodTimes = draft.times.slice(0, s.periodsPerDay);
  while (s.periodTimes.length < s.periodsPerDay) s.periodTimes.push({ start: '', end: '' });
  // 旧周数据按行补齐/截断
  const timeError = validatePeriodTimes(s.periodTimes);
  if (timeError) {
    setSaveError(new Error(timeError));
    return;
  }
  for (const w of Object.keys(next.weeks)) {
    for (let d = 0; d < 5; d++) {
      const arr = next.weeks[w]?.[d];
      if (!arr) continue;
      next.weeks[w][d] = arr.slice(0, s.periodsPerDay);
      while (next.weeks[w][d].length < s.periodsPerDay) next.weeks[w][d].push('');
    }
  }
  if (viewWeek > s.weekCount) next.viewWeek = s.weekCount;
  settingsSaving = true;
  setSettingsBusy(true);
  try {
    if (autoStartResolved) {
      const actualAutoStart = await window.api.setAutoStart(s.autoStart);
      if (actualAutoStart !== s.autoStart) throw new Error('开机自启状态未能更新');
    }
    await saveData(next);
    data = next;
    if (viewWeek > s.weekCount) viewWeek = s.weekCount;
    document.documentElement.style.setProperty('--alpha', s.opacity);
    closeSettings(true);
    renderAll();
  } catch (error) {
    if (draft && autoStartResolved && draft.initialAutoStart !== s.autoStart) {
      window.api.setAutoStart(draft.initialAutoStart).catch(() => {});
    }
    setSaveError(error);
    settingsSaving = false;
    setSettingsBusy(false);
  }
}

function goWeek(n) {
  viewWeek = Math.min(Math.max(n, 1), data.settings.weekCount);
  data.viewWeek = viewWeek; // 记住查看位置：下次启动恢复
  void saveData().catch(() => {});
  renderAll();
}

function copyPrevWeek() {
  if (viewWeek <= 1) return;
  if (!window.confirm('复制上一周将覆盖本周现有课程，是否继续？')) return;
  const prev = data.weeks[viewWeek - 1] || {};
  data.weeks[viewWeek] = JSON.parse(JSON.stringify(prev));
  void saveData().catch(() => {});
  renderAll();
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
  window.__refreshHighlight = refreshHighlight; // 供 E2E 消除时间差
  bindEvents();
  renderAll();
}

init();

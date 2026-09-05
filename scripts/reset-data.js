// 重置 schedule.json 为干净默认值（保留窗口位置）；E2E/开发前初始化用
// 用法：node scripts/reset-data.js [--semester=YYYY-MM-DD]
const fs = require('fs');
const path = require('path');

const arg = process.argv.find((a) => a.startsWith('--semester='));
const semester = arg ? arg.split('=')[1] : '';

const DEFAULT_PERIOD_TIMES = [
  { start: '08:00', end: '08:45' },
  { start: '08:55', end: '09:40' },
  { start: '09:50', end: '10:35' },
  { start: '10:45', end: '11:30' },
  { start: '11:40', end: '12:25' },
  { start: '14:00', end: '14:45' },
  { start: '14:55', end: '15:40' },
  { start: '15:50', end: '16:35' },
];

const file = path.join(__dirname, '..', 'schedule.json');
const def = {
  version: 1,
  settings: {
    semesterStart: semester,
    weekCount: 20,
    periodsPerDay: 8,
    periodTimes: DEFAULT_PERIOD_TIMES,
    opacity: 0.65,
    showWeekend: false,
    autoStart: false,
  },
  window: null,
  viewWeek: null,
  weeks: {},
};
try {
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (cur.window) def.window = cur.window;
} catch { /* 不存在的文件：无窗口位置可保留 */ }
fs.writeFileSync(file, JSON.stringify(def, null, 2));
console.log('schedule.json 已重置' + (def.window ? '（保留窗口位置）' : '') +
  (semester ? `，开学日期=${semester}` : ''));

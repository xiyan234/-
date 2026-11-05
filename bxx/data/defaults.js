const PERIOD_TIMES = [
  { period: 1, start: '08:00', end: '08:45' },
  { period: 2, start: '08:50', end: '09:35' },
  { period: 3, start: '09:45', end: '10:30' },
  { period: 4, start: '10:40', end: '11:25' },
  { period: 5, start: '11:30', end: '12:15' },
  { period: 6, start: '13:30', end: '14:15' },
  { period: 7, start: '14:20', end: '15:05' },
  { period: 8, start: '15:15', end: '16:00' },
  { period: 9, start: '16:05', end: '16:50' },
  { period: 10, start: '18:00', end: '18:45' },
  { period: 11, start: '18:50', end: '19:35' },
  { period: 12, start: '19:40', end: '20:25' }
];

const ALL_WEEKS = Array.from({ length: 18 }, (_, index) => index + 1);
const ODD_WEEKS = ALL_WEEKS.filter((week) => week % 2 === 1);
const EVEN_WEEKS = ALL_WEEKS.filter((week) => week % 2 === 0);

const SETTINGS = {
  timetableName: '2026-2027学年 第一学期',
  semesterStartMonday: '2026-08-31',
  totalWeeks: 18,
  showWeekend: true,
  periodTimes: PERIOD_TIMES
};

const COURSES = [
  { id: 'demo-1', name: '高等数学', teacher: '教师A', room: '教A-203', day: 1, startPeriod: 1, endPeriod: 2, weeks: ALL_WEEKS, colorIndex: 0 },
  { id: 'demo-2', name: '大学英语', teacher: '教师B', room: '教B-105', day: 1, startPeriod: 3, endPeriod: 4, weeks: ALL_WEEKS, colorIndex: 1 },
  { id: 'demo-3', name: '程序设计基础', teacher: '教师C', room: '机房A-301', day: 1, startPeriod: 6, endPeriod: 8, weeks: ALL_WEEKS, colorIndex: 2 },
  { id: 'demo-4', name: '线性代数', teacher: '教师D', room: '教A-112', day: 2, startPeriod: 1, endPeriod: 2, weeks: ALL_WEEKS, colorIndex: 3 },
  { id: 'demo-5', name: '体育', teacher: '教师E', room: '东操场', day: 2, startPeriod: 6, endPeriod: 7, weeks: ODD_WEEKS, colorIndex: 4 },
  { id: 'demo-6', name: '中国近现代史纲要', teacher: '教师F', room: '教C-208', day: 3, startPeriod: 3, endPeriod: 4, weeks: ALL_WEEKS, colorIndex: 5 },
  { id: 'demo-7', name: '大学物理', teacher: '教师G', room: '教A-306', day: 3, startPeriod: 6, endPeriod: 7, weeks: ALL_WEEKS, colorIndex: 6 },
  { id: 'demo-8', name: '物理实验', teacher: '教师H', room: '实验楼B-204', day: 4, startPeriod: 1, endPeriod: 3, weeks: EVEN_WEEKS, colorIndex: 7 },
  { id: 'demo-9', name: '数据结构', teacher: '教师I', room: '教B-401', day: 4, startPeriod: 6, endPeriod: 8, weeks: ALL_WEEKS, colorIndex: 8 },
  { id: 'demo-10', name: '形势与政策', teacher: '教师J', room: '报告厅', day: 5, startPeriod: 3, endPeriod: 4, weeks: [2, 6, 10, 14], colorIndex: 9 }
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  defaultCourses: () => clone(COURSES),
  defaultSettings: () => clone(SETTINGS),
  PERIOD_TIMES
};


/**
 * 解析结果 → 课表课程对象的映射（纯函数）。
 * 输出字段与其他页面读取的课程结构完全一致，导入后无需改动课表页。
 */

const { courseColorIndex } = require('../colors.js');

const COURSE_FIELDS = [
  'id', 'name', 'teacher', 'room', 'day',
  'startPeriod', 'endPeriod', 'weeks', 'colorIndex', 'note'
];

function maxWeekOf(rows) {
  return (rows || []).reduce((max, row) => {
    const local = Math.max.apply(null, (row.weeks || []).concat([0]));
    return Math.max(max, local);
  }, 0);
}

function toCourses(rows, totalWeeks) {
  const limit = Math.max(1, Number(totalWeeks) || 18);
  const stamp = Date.now();
  return (rows || []).map((row, index) => ({
    id: 'course-pdf-' + stamp + '-' + index,
    name: row.name,
    teacher: row.teacher || '',
    room: row.room || '',
    day: row.day,
    startPeriod: row.startPeriod,
    endPeriod: row.endPeriod,
    weeks: (row.weeks || []).filter((week) => week >= 1 && week <= limit),
    colorIndex: courseColorIndex(row.name),
    note: ''
  })).filter((course) => course.weeks.length > 0);
}

module.exports = { COURSE_FIELDS, maxWeekOf, toCourses };

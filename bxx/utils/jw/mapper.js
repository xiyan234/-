/**
 * 教务课程 → 本应用课程结构 的映射（纯函数，可单测）。
 *
 * 两边的字段名不一样（教务是 rooms/day/startPeriod，应用是 room/day/startPeriod + note），
 * 这类映射最容易出现"少一个字段导致详情页空白"的问题，所以单独拆出来钉死。
 */

const { courseColorIndex } = require('../colors');

/** 应用侧课程对象的完整字段，改结构时同步这里和测试 */
const COURSE_FIELDS = [
  'id', 'name', 'teacher', 'room', 'day',
  'startPeriod', 'endPeriod', 'weeks', 'colorIndex', 'note'
];

/** 教务返回数据里最大的周次，用来决定总周数下限，避免第 19 周的课被裁掉 */
function maxWeekOf(rows) {
  return (rows || []).reduce((max, row) => {
    const local = Math.max.apply(null, (row.weeks || []).concat([0]));
    return Math.max(max, local);
  }, 0);
}

/**
 * @param {Array} rows 教务解析结果
 * @param {number} totalWeeks 课表总周数
 * @returns {Array} 应用可用的课程数组
 */
function toCourses(rows, totalWeeks) {
  const limit = Math.max(1, Number(totalWeeks) || 18);
  const stamp = Date.now();
  return (rows || []).map((row, index) => ({
    id: 'course-jw-' + stamp + '-' + index,
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

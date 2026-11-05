const test = require('node:test');
const assert = require('node:assert/strict');
const {
  currentWeek,
  dateForDay,
  dateStamp,
  weekRange
} = require('../utils/date');

test('按第一周周一计算当前周', () => {
  assert.equal(currentWeek('2026-08-31', 18, new Date(2026, 8, 21)), 4);
  assert.equal(currentWeek('2026-08-31', 18, new Date(2026, 7, 1)), 1);
  assert.equal(currentWeek('2026-08-31', 18, new Date(2027, 5, 1)), 18);
});

test('按周次和星期计算日期', () => {
  assert.equal(dateStamp(dateForDay('2026-08-31', 4, 0)), '2026-09-21');
  assert.equal(dateStamp(dateForDay('2026-08-31', 4, 6)), '2026-09-27');
  assert.equal(weekRange('2026-08-31', 4), '9月21日–9月27日');
});


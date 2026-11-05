const test = require('node:test');
const assert = require('node:assert/strict');
const { formatWeeks, parseWeeks } = require('../utils/weeks');

test('解析连续、离散与单双周', () => {
  assert.deepEqual(parseWeeks('1-4,7,9', 18), [1, 2, 3, 4, 7, 9]);
  assert.deepEqual(parseWeeks('1-8单周', 18), [1, 3, 5, 7]);
  assert.deepEqual(parseWeeks('2-8双周', 18), [2, 4, 6, 8]);
});

test('压缩显示周次', () => {
  assert.equal(formatWeeks([1, 2, 3, 5, 8, 9]), '1-3、5、8-9周');
  assert.equal(formatWeeks([]), '未设置');
});


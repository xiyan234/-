const test = require('node:test');
const assert = require('node:assert/strict');
const { assignCourseColors, courseColorIndex } = require('../utils/colors');

test('同名课程始终得到相同色号', () => {
  assert.equal(courseColorIndex('高等数学'), courseColorIndex('高等 数学'));
});

test('课程数不超过色板时尽量不撞色', () => {
  const allocation = assignCourseColors(['高等数学', '大学英语', '大学物理', '程序设计']);
  assert.equal(new Set(Object.values(allocation)).size, 4);
});


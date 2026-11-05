const test = require('node:test');
const assert = require('node:assert/strict');
const { answer } = require('../utils/uni');

test('小鸮能回答课表、记事与历史入口', () => {
  assert.match(answer('这周课表怎么看', { week: 5 }), /第 5 周/);
  assert.match(answer('添加记事'), /记事/);
  assert.match(answer('历史记录在哪里'), /历史/);
});

test('默认回答如实说明本机规则模式', () => {
  assert.match(answer('你好'), /本机规则/);
  assert.match(answer('你好'), /不会把课表或姓名发送给模型/);
});

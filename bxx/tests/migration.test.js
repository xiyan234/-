const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('五个主页面都登记为 tabBar', () => {
  const app = JSON.parse(read('app.json'));
  assert.deepEqual(app.tabBar.list.map((item) => item.text), ['课表', '记事', '小鸮', '校园', '我的']);
});

test('所有删除路径都包含影响条数和不可恢复说明', () => {
  const confirm = read('utils/confirm.js');
  assert.match(confirm, /影响.*条数据/);
  assert.match(confirm, /删除后无法恢复/);
  assert.match(read('pages/notes/index.js'), /confirmDelete/);
  assert.match(read('pages/uni/index.js'), /confirmDelete/);
  assert.match(read('pages/me/index.js'), /confirmDelete/);
});

test('小鸮提供历史记录与系统键盘语音提示', () => {
  const page = read('pages/uni/index.js');
  assert.match(page, /loadHistory/);
  assert.match(page, /系统键盘/);
  assert.match(page, /键盘上的麦克风/);
});

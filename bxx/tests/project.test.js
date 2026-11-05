const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('项目配置中的页面文件完整', () => {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  app.pages.forEach((page) => {
    ['js', 'json', 'wxml', 'wxss'].forEach((extension) => {
      assert.equal(fs.existsSync(path.join(root, `${page}.${extension}`)), true, `${page}.${extension}`);
    });
  });
});

test('所有 JSON 文件都能解析', () => {
  const queue = [root];
  while (queue.length) {
    const directory = queue.pop();
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      // debug/ 是本地探测抓下来的原始响应，格式不可控，不参与解析校验
      if (entry.name === '.git' || entry.name === 'debug' || entry.name === 'node_modules') return;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(file);
      else if (entry.name.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')), file);
    });
  }
});


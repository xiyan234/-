const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const { inflateZlib } = require('../utils/pdf/inflate');
const { extractTextItems } = require('../utils/pdf/extract');
const { parsePdfTimetable, toCourses, COURSE_FIELDS, PdfImportError } = require('../utils/pdf');

// 真实课表 PDF 含个人信息，不随公开仓库分发；本地有样本时才跑样本相关用例
const fixturePath = path.join(__dirname, 'fixtures/timetable.pdf');
const hasFixture = fs.existsSync(fixturePath);
const fixture = hasFixture ? fs.readFileSync(fixturePath) : null;
const sampleTest = hasFixture ? test : (name, fn) => test.skip(name, fn);
const asBytes = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

function ucs2hex(text) {
  let hex = '';
  for (const char of text) hex += char.charCodeAt(0).toString(16).padStart(4, '0');
  return hex;
}

function fakePdf(content, dictionary) {
  const head = Buffer.from('%PDF-1.4\n' + (dictionary || '') + '\nstream\n', 'latin1');
  const body = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const tail = Buffer.from('\nendstream\n%%EOF', 'latin1');
  return asBytes(Buffer.concat([head, body, tail]));
}

function headerContent(extra) {
  return 'BT\n1 0 0 1 133 521 Tm\n<' + ucs2hex('星期一') + '> Tj\n'
    + '1 0 0 1 236 521 Tm\n<' + ucs2hex('星期二') + '> Tj\n' + (extra || '') + 'ET';
}

test('自研 DEFLATE 解压与 Node zlib 逐字节一致（含存储块与动态 Huffman）', () => {
  const samples = [
    Buffer.from(''),
    Buffer.from('hello world'),
    Buffer.from('中文课表 大学英语3 复变函数与积分变换（A）'.repeat(500), 'utf8'),
    Buffer.from(Array.from({ length: 120000 }, (_, index) => (index * 37 + 11) % 256))
  ];
  samples.forEach((raw, index) => {
    [0, 1, 6, 9].forEach((level) => {
      const packed = zlib.deflateSync(raw, { level });
      const output = Buffer.from(inflateZlib(asBytes(packed)));
      assert.equal(output.equals(raw), true, `样本 ${index} 压缩级别 ${level} 不一致`);
    });
  });
});

sampleTest('真实课表 PDF 的三个内容流都能解压出文字与坐标', () => {
  const items = extractTextItems(asBytes(fixture));
  assert.equal(items.length, 243);
  assert.equal(items.some((item) => item.text.includes('2026-2027学年第1学期')), true);
  assert.equal(items.some((item) => item.text.trim() === '星期一'), true);
  assert.equal(items.filter((item) => /\(\d+-\d+节\)/.test(item.text)).length, 21);
  assert.equal(items.every((item) => Number.isFinite(item.x) && Number.isFinite(item.y)), true);
});

sampleTest('真实课表 PDF 还原出 21 个课程块，六个字段零缺失', () => {
  const result = parsePdfTimetable(asBytes(fixture));
  assert.equal(result.rows.length, 21);
  assert.equal(result.term, '2026-2027学年第1学期');
  assert.equal(result.maxWeek, 18);
  assert.equal(result.distinct, 15);
  assert.deepEqual(result.warnings, []);

  const byDay = {};
  result.rows.forEach((row) => { byDay[row.day] = (byDay[row.day] || 0) + 1; });
  assert.deepEqual(byDay, { 1: 5, 2: 5, 3: 4, 4: 2, 5: 3, 6: 2 });

  result.rows.forEach((row, index) => {
    assert.ok(row.name, `第 ${index + 1} 条缺课程名`);
    assert.ok(row.day >= 1 && row.day <= 7, `第 ${index + 1} 条星期越界`);
    assert.ok(row.startPeriod >= 1 && row.endPeriod >= row.startPeriod, `第 ${index + 1} 条节次异常`);
    assert.ok(row.weeks.length > 0, `第 ${index + 1} 条缺周次`);
    assert.ok(row.room, `第 ${index + 1} 条缺教室`);
    assert.ok(row.teacher, `第 ${index + 1} 条缺教师`);
  });

  const names = result.rows.map((row) => row.name);
  assert.equal(names.includes('复变函数与积分变换（A）'), true, '跨行课程名要拼完整');
  assert.equal(names.includes('嵌入式系统创新应用与实践'), true, '跨行课程名要拼完整');
  assert.equal(names.some((name) => name === '（A）' || name === '实践'), false, '课程名被截断');
  assert.equal(names.every((name) => name.length >= 2), true);
});

sampleTest('单双周与离散周都能正确展开', () => {
  const rows = parsePdfTimetable(asBytes(fixture)).rows;
  const oddEven = rows.find((row) => row.name === '大学英语3' && row.room === '二教C-403');
  assert.deepEqual(oddEven.weeks, [1, 3, 4, 6, 7, 9, 12, 13, 15, 16, 17]);
  const scattered = rows.find((row) => row.name === '大学英语3' && row.room === '实验楼F-304');
  assert.deepEqual(scattered.weeks, [2, 5, 8, 11, 14]);
});

sampleTest('解析结果映射成现有课表结构，总周数裁剪正确', () => {
  const { rows, maxWeek } = parsePdfTimetable(asBytes(fixture));
  const courses = toCourses(rows, maxWeek);
  assert.equal(courses.length, 21);
  assert.deepEqual(Object.keys(courses[0]), COURSE_FIELDS);
  assert.equal(courses.every((course) => course.id.startsWith('course-pdf-')), true);
  assert.equal(courses.every((course) => course.weeks.length > 0), true);
  assert.equal(courses.every((course) => course.note === ''), true);
  assert.equal(courses.every((course) => Number.isInteger(course.colorIndex)), true);
  const clipped = toCourses(rows, 9);
  assert.equal(clipped.every((course) => course.weeks.every((week) => week <= 9)), true);
});

function expectKind(input, kind) {
  assert.throws(() => parsePdfTimetable(input), (error) => {
    assert.ok(error instanceof PdfImportError, '应抛出 PdfImportError');
    assert.equal(error.kind, kind);
    assert.ok(error.message.length > 0, '错误信息不能为空');
    return true;
  });
}

test('非 PDF、加密文件、无文字层与非中文文件都有明确失败类型', () => {
  expectKind(asBytes(Buffer.from('not a pdf')), 'NOT_PDF');
  expectKind(fakePdf('BT\nET', '/Encrypt 5 0 R'), 'ENCRYPTED');
  expectKind(fakePdf('no text operators here'), 'NO_TEXT_LAYER');
  expectKind(fakePdf('BT\n1 0 0 1 100 500 Tm\n(hello) Tj\nET'), 'UNSUPPORTED_FORMAT');
});

test('有表头但无课程、或课程信息不完整时停止导入', () => {
  expectKind(fakePdf(headerContent(), '/Encoding /UniGB-UCS2-H'), 'NO_COURSES');
  const broken = headerContent('1 0 0 1 104 480 Tm\n<' + ucs2hex('(1-2节)/校区:北区') + '> Tj\n');
  expectKind(fakePdf(broken, '/Encoding /UniGB-UCS2-H'), 'PARSE_INCOMPLETE');
});

test('PDF 导入页为每类解析失败都准备了处理建议', () => {
  const page = read('pages/pdfimport/index.js');
  assert.match(page, /require\('\.\.\/\.\.\/utils\/pdf\/index\.js'\)/, '解析模块必须显式指向文件、不能指向目录');
  assert.doesNotMatch(page.slice(0, page.indexOf('Page({')), /require\(['"][^'"]*utils\/pdf['"]\)/, '顶层不得 require 目录，避免整页白屏');
  assert.match(page, /onLoad\(\)/, '要有模块自检');
  assert.match(page, /moduleStatus/, '页面要显示模块加载状态');
  ['NOT_PDF', 'FILE_TOO_LARGE', 'ENCRYPTED', 'NO_TEXT_LAYER', 'UNSUPPORTED_FORMAT',
    'NO_COURSES', 'PARSE_INCOMPLETE', 'INFLATE_FAILED', 'READ_FAILED', 'MODULE_FAILED', 'DEFAULT']
    .forEach((kind) => assert.match(page, new RegExp(`\\b${kind}\\b`), `缺少 ${kind} 的提示`));
});

test('教务导入分支已完整恢复', () => {
  ['utils/jw/zfClient.js', 'utils/jw/session.js', 'utils/jw/mapper.js',
    'scripts/probe-jw.js', 'check-login.bat', 'tests/jw.test.js'].forEach((entry) => {
    assert.equal(fs.existsSync(path.join(root, entry)), true, `${entry} 未恢复`);
  });
  const js = read('pages/import/index.js');
  const wxml = read('pages/import/index.wxml');
  ['importTimetable', 'currentTerm', 'getStepLog', 'startImport', 'changeSemester']
    .forEach((name) => assert.match(js, new RegExp(`\\b${name}\\b`), `教务页缺少 ${name}`));
  ['updateUsername', 'updatePassword', 'toggleDiagnostics']
    .forEach((name) => assert.match(wxml, new RegExp(`\\b${name}\\b`), `教务页缺少 ${name}`));
  assert.match(wxml, /从教务系统导入课表/);
});

test('两种导入方式并列：双标签、互相切换、页面都已注册', () => {
  const app = JSON.parse(read('app.json'));
  assert.equal(app.pages.includes('pages/import/index'), true);
  assert.equal(app.pages.includes('pages/pdfimport/index'), true);

  const jwWxml = read('pages/import/index.wxml');
  const jwJs = read('pages/import/index.js');
  const pdfWxml = read('pages/pdfimport/index.wxml');
  const pdfJs = read('pages/pdfimport/index.js');

  [jwWxml, pdfWxml].forEach((wxml) => {
    assert.match(wxml, /class="mode-switch"/);
    assert.match(wxml, /教务系统导入/);
    assert.match(wxml, /PDF 导入/);
    assert.match(wxml, /class="mode-item active"/);
  });
  assert.match(jwWxml, /bindtap="openPdfImport"/);
  assert.match(jwJs, /openPdfImport\s*\(/);
  assert.match(jwJs, /\/pages\/pdfimport\/index/);
  assert.match(pdfWxml, /bindtap="openJwImport"/);
  assert.match(pdfJs, /openJwImport\s*\(/);
  assert.match(pdfJs, /\/pages\/import\/index/);
  assert.match(pdfWxml, /从 PDF 导入课表/);
});

test('两个导入页结构完整：标签配对、事件都有对应方法', () => {
  [['pages/import/index.wxml', 'pages/import/index.js'],
    ['pages/pdfimport/index.wxml', 'pages/pdfimport/index.js']].forEach(([wxmlFile, jsFile]) => {
    const wxml = read(wxmlFile);
    const js = read(jsFile);
    assert.equal((wxml.match(/<view\b/g) || []).length, (wxml.match(/<\/view>/g) || []).length, wxmlFile);
    const taps = [...wxml.matchAll(/bind(?:tap|change|input)="(\w+)"/g)].map((match) => match[1]);
    assert.ok(taps.length >= 3, wxmlFile);
    taps.forEach((name) => assert.match(js, new RegExp(`\\b${name}\\s*\\(`), `${wxmlFile} 的 ${name} 没有对应方法`));
  });
});

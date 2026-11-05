const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const zf = require('../utils/jw/zfClient');
const session = require('../utils/jw/session');
const mapper = require('../utils/jw/mapper');

/* ============================ RSA 加密（端到端验证） ============================ */

test('密码加密结果能被标准 RSA 私钥解开（PKCS#1 v1.5）', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const jwk = publicKey.export({ format: 'jwk' });

  // 正方下发的 modulus 是带前导 0x00 的 128 字节，这里补齐成同样的形状
  let modulusBytes = Buffer.from(jwk.n, 'base64url');
  if (modulusBytes.length < 128) {
    modulusBytes = Buffer.concat([Buffer.alloc(128 - modulusBytes.length), modulusBytes]);
  }
  const modulusB64 = modulusBytes.toString('base64');
  const exponentB64 = Buffer.from(jwk.e, 'base64url').toString('base64');

  const password = 'Passw0rd!中文';
  const cipher = zf.encryptPassword(password, modulusB64, exponentB64);

  // 密文长度必须等于模长（1024 位 → 128 字节 → Base64 172 字符）
  assert.equal(Buffer.from(cipher, 'base64').length, 128);

  const plain = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(cipher, 'base64')
  );
  assert.equal(plain.toString('utf8'), password);
});

test('同一密码每次加密结果不同（填充随机），但都能解开', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const jwk = publicKey.export({ format: 'jwk' });
  let modulusBytes = Buffer.from(jwk.n, 'base64url');
  if (modulusBytes.length < 128) {
    modulusBytes = Buffer.concat([Buffer.alloc(128 - modulusBytes.length), modulusBytes]);
  }
  const modulusB64 = modulusBytes.toString('base64');
  const exponentB64 = Buffer.from(jwk.e, 'base64url').toString('base64');

  const first = zf.encryptPassword('abc123', modulusB64, exponentB64);
  const second = zf.encryptPassword('abc123', modulusB64, exponentB64);
  assert.notEqual(first, second);

  [first, second].forEach((cipher) => {
    const plain = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(cipher, 'base64')
    );
    assert.equal(plain.toString('utf8'), 'abc123');
  });
});

test('modulus 带前导 0x00 时仍按真实位长算模长（回归：曾算出 129 字节导致必然登录失败）', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.from(jwk.n, 'base64url');
  // 模拟正方：Base64 解出来多一个前导 0x00 字节
  const withLeadingZero = Buffer.concat([Buffer.alloc(1), raw]);
  const modulusB64 = withLeadingZero.toString('base64');
  const exponentB64 = Buffer.from(jwk.e, 'base64url').toString('base64');

  assert.equal(Buffer.from(modulusB64, 'base64').length, 129);

  const cipher = zf.encryptPassword('secret-2026', modulusB64, exponentB64);
  assert.equal(Buffer.from(cipher, 'base64').length, 128);

  const plain = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(cipher, 'base64')
  );
  assert.equal(plain.toString('utf8'), 'secret-2026');
});

/* ============================ 登录页字段判定 ============================ */

test('登录页要求加密时返回 required 并带回 csrftoken', () => {
  const html = '<input type="hidden" name="csrftoken" value="abc-123">'
    + '<input type="hidden" name="mmsfjm" value="1">';
  const result = zf.decidePasswordMode(html);
  assert.equal(result.mode, 'required');
  assert.equal(result.csrfToken, 'abc-123');
});

test('缺少加密标记时抛 PAGE_CHANGED，绝不降级成明文提交', () => {
  assert.throws(
    () => zf.decidePasswordMode('<input type="hidden" name="csrftoken" value="x">'),
    (error) => error.kind === 'PAGE_CHANGED'
  );
});

test('加密标记取值异常时同样拒绝猜测', () => {
  assert.throws(
    () => zf.decidePasswordMode('<input type="hidden" name="mmsfjm" value="9">'),
    (error) => error.kind === 'PAGE_CHANGED'
  );
});

test('隐藏字段扫描覆盖表单外的 input', () => {
  const html = '<form><input type="hidden" name="a" value="1"></form>'
    + '<input type="hidden" name="mmsfjm" value="1">';
  const fields = zf.readHiddenFields(html);
  assert.equal(fields.a, '1');
  assert.equal(fields.mmsfjm, '1');
});

test('公钥接口返回的 JSON 能解析出 modulus 与 exponent', () => {
  const body = '{"modulus":"AJKHO3luA3Gz","exponent":"AQAB"}';
  const key = zf.parsePublicKey(body);
  assert.equal(key.modulus, 'AJKHO3luA3Gz');
  assert.equal(key.exponent, 'AQAB');
});

/* ============================ 登录表单组装 ============================ */

/* 取自北化教务真实登录页的关键片段（含两个 name=mm 的输入框与无引号 value） */
const ZF_LOGIN_PAGE = [
  '<input type="hidden" name="yzcskz" id="yzcskz" value= 5>',
  '<input type="hidden" name="mmsfjm" id="mmsfjm" value= 1>',
  '<input type="hidden" name="xxdm" id="xxdm" value= 10010>',
  '<input type="hidden" name="dlsbsdsj" id="dlsbsdsj" value= 30>',
  '<input type="hidden" id="csrftoken" name="csrftoken" value="cb6bf526-7394,cb6bf5267394"/>',
  '<input type="hidden" id="language" name="language" value="zh_CN"/>',
  '<input type="hidden" name="scene_id" id="scene_id" value= >',
  '<input type="text" class="form-control" name="yhm" id="yhm" value="">',
  '<input type="password" name="mm" id="hidMm" style="display:none">',
  '<input type="text" class="form-control" name="mm" id="mm" value="">'
].join('');

function parseForm(body) {
  return body.split('&').map((pair) => {
    const index = pair.indexOf('=');
    return {
      name: decodeURIComponent(pair.slice(0, index)),
      value: decodeURIComponent(pair.slice(index + 1))
    };
  });
}

test('登录表单保留页面全部隐藏字段，不再只提交四个参数', () => {
  const fields = parseForm(zf.buildLoginForm(ZF_LOGIN_PAGE, '2025040064', 'CIPHER=='));
  const byName = (name) => fields.filter((f) => f.name === name);

  assert.equal(byName('yzcskz')[0].value, '5');
  assert.equal(byName('xxdm')[0].value, '10010', '学校代码必须带上');
  assert.equal(byName('mmsfjm')[0].value, '1');
  assert.equal(byName('dlsbsdsj')[0].value, '30');
  assert.equal(byName('csrftoken')[0].value, 'cb6bf526-7394,cb6bf5267394');
  assert.equal(byName('language')[0].value, 'zh_CN');
  assert.equal(byName('scene_id')[0].value, '', '无引号空值也要提交为 scene_id=');
});

test('URL 传参版整串不含 %（避免被网络层二次转义）', () => {
  const query = zf.buildLoginQueryRaw(ZF_LOGIN_PAGE, '2025040064', 'AbC/dEf=');
  assert.equal(query.indexOf('%'), -1, '整串不能出现 %，否则真机上会被再转义一次');
  assert.equal(query.indexOf('+'), -1, '+ 在 query 里会被解码成空格');

  const fields = parseForm(query);
  assert.equal(fields.filter((f) => f.name === 'yhm').length, 1);
  assert.equal(fields.filter((f) => f.name === 'mm').length, 2, '两个 mm 都要带上');
  // 值里的逗号、斜杠、等号都要原样保留，不能编码
  assert.equal(parseForm(query).filter((f) => f.name === 'csrftoken')[0].value, 'cb6bf526-7394,cb6bf5267394');
});

test('识别服务端到底有没有收到表单字段（ydType 标记）', () => {
  assert.equal(zf.receivedLoginParams('<input type="hidden" name="ydType" id="ydType" value= >'), true);
  assert.equal(zf.receivedLoginParams('<input type="hidden" name="ydType" id="ydType" value= 0>'), false);
  assert.equal(zf.receivedLoginParams(''), false);
});

test('无 + 密文：长度不变、仍能被标准私钥解开', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const jwk = publicKey.export({ format: 'jwk' });
  const modulus = Buffer.from(jwk.n, 'base64url').toString('base64');
  const exponent = Buffer.from(jwk.e, 'base64url').toString('base64');

  const cipher = zf.encryptPasswordNoPlus('pwd-123456', modulus, exponent);
  assert.equal(cipher.indexOf('+'), -1, '结果里不能有 +');
  assert.equal(Buffer.from(cipher, 'base64').length, 128, '块长仍是 128 字节');
  const plain = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(cipher, 'base64')
  );
  assert.equal(plain.toString('utf8'), 'pwd-123456');
});

test('学号提交一次、密码提交两次（对应页面上两个 name=mm 的输入框）', () => {
  const fields = parseForm(zf.buildLoginForm(ZF_LOGIN_PAGE, '2025040064', 'CIPHER=='));
  const yhm = fields.filter((f) => f.name === 'yhm');
  const mm = fields.filter((f) => f.name === 'mm');

  assert.equal(yhm.length, 1);
  assert.equal(yhm[0].value, '2025040064');
  assert.equal(mm.length, 2, '两个 mm 都要提交密文');
  assert.equal(mm[0].value, 'CIPHER==');
  assert.equal(mm[1].value, 'CIPHER==');
});

test('兼容模式把 mmsfjm 置 0 并提交明文密码', () => {
  const fields = parseForm(zf.buildLoginForm(ZF_LOGIN_PAGE, '2025040064', 'my pwd', { plain: true }));
  const byName = (name) => fields.filter((f) => f.name === name);

  assert.equal(byName('mmsfjm')[0].value, '0', '兼容模式必须声明"密码未加密"');
  assert.equal(byName('mm').length, 2);
  assert.equal(byName('mm')[0].value, 'my pwd', '明文原样提交');
  assert.equal(byName('csrftoken')[0].value.length > 0, true, '其余字段照旧透传');
});

test('页面没有验证码时不提交 yzm；有验证码字段时才带上', () => {
  const withoutCaptcha = zf.buildLoginForm(ZF_LOGIN_PAGE, '2025040064', 'CIPHER==');
  assert.equal(withoutCaptcha.indexOf('yzm='), -1, '不能凭空拼一个空 yzm');
  assert.equal(zf.hasCaptchaField(ZF_LOGIN_PAGE), false);

  const withCaptcha = ZF_LOGIN_PAGE + '<input type="text" name="yzm" id="yzm" value="">';
  const form = zf.buildLoginForm(withCaptcha, '2025040064', 'CIPHER==');
  assert.notEqual(form.indexOf('yzm='), -1, '页面有验证码字段时应原样提交');
  assert.equal(zf.hasCaptchaField(withCaptcha), true);
});

test('csrftoken 里的逗号按表单规则编码为 %2C', () => {
  const form = zf.buildLoginForm(ZF_LOGIN_PAGE, '2025040064', 'CIPHER==');
  assert.ok(
    form.indexOf('csrftoken=cb6bf526-7394%2Ccb6bf5267394') !== -1,
    '实际表单：' + form
  );
});

/* ============================ 登录失败判定 ============================ */

test('密码错误不会被误判成需要验证码（页面脚本里出现"验证码"不算）', () => {
  const html = '<input type="text" name="yhm">'
    + '<p id="tips" class="bg_danger sl_danger"><span class="glyphicon"></span>用户名或密码不正确，请重新输入！</p>'
    + '<script>var tab = "短信验证码";</script>';
  const failure = zf.parseLoginFailure(html);
  assert.equal(failure.kind, 'INVALID_CREDENTIALS');
  assert.equal(failure.tips, '用户名或密码不正确，请重新输入！');
});

test('页面存在验证码输入框时判为需要验证码', () => {
  const html = '<input type="text" name="yzm"><p id="tips">请输入验证码</p>';
  assert.equal(zf.parseLoginFailure(html).kind, 'NEED_CAPTCHA');
});

test('锁定与停用单独归类，方便给不同提示', () => {
  assert.equal(
    zf.parseLoginFailure('<p id="tips">密码错误次数过多，账号已锁定 30 分钟</p>').kind,
    'ACCOUNT_LOCKED'
  );
  assert.equal(
    zf.parseLoginFailure('<p id="tips">该账号已停用</p>').kind,
    'ACCOUNT_DISABLED'
  );
});

test('每种错误都有给用户看的中文话术', () => {
  ['NEED_CAPTCHA', 'INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'ACCOUNT_DISABLED',
    'SESSION_EXPIRED', 'NETWORK_RETRYABLE', 'PAGE_CHANGED', 'QUERY_DENIED',
    'VALIDATION_FAILED', 'UNSUPPORTED', 'DOMAIN_BLOCKED'].forEach((kind) => {
    const text = zf.describeZfError(kind);
    assert.ok(text && text !== '导入没有完成，请稍后重试。', kind + ' 缺少专属话术');
  });
});

/* ============================ 课表解析 ============================ */

test('节次分段：多个时间段拆成多段', () => {
  assert.deepEqual(zf.parsePeriods('1-2,5-6'), [[1, 2], [5, 6]]);
  assert.deepEqual(zf.parsePeriods('3'), [[3, 3]]);
  assert.deepEqual(zf.parsePeriods('1-2节'), [[1, 2]]);
});

test('周次解析：单双周与分段', () => {
  assert.deepEqual(zf.parseWeeks('1-16周(单)'), [1, 3, 5, 7, 9, 11, 13, 15]);
  assert.deepEqual(zf.parseWeeks('1-8,10-16'), [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(zf.parseWeeks('3'), [3]);
});

test('kbList 解析：按节次分段展开，缺课名或星期越界的行跳过', () => {
  const body = JSON.stringify({
    kbList: [
      { kcmc: '高等数学', xqj: '1', jcs: '1-2', zcd: '1-16周', xm: '张三', cdmc: '主教 101' },
      { kcmc: '大学物理', xqj: '3', jcs: '3-4,5-6', zcd: '1-16周(单)', xm: '李四', cdmc: '实验楼 202' },
      { kcmc: '', xqj: '2', jcs: '1-2', zcd: '1-16周' },
      { kcmc: '越界课', xqj: '9', jcs: '1-2', zcd: '1-16周' }
    ]
  });
  const courses = zf.parseKbList(body);
  assert.equal(courses.length, 3);
  assert.equal(courses[0].name, '高等数学');
  assert.equal(courses[0].room, '主教 101');
  assert.deepEqual(courses[0].weeks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(courses[1].startPeriod, 3);
  assert.equal(courses[2].startPeriod, 5);
  assert.deepEqual(courses[1].weeks, [1, 3, 5, 7, 9, 11, 13, 15]);
});

test('单双周两行合并成一门课，周次取并集', () => {
  const merged = zf.mergeCourses([
    { name: '体育', teacher: '王', room: '操场', day: 2, startPeriod: 3, endPeriod: 4, weeks: [1, 3, 5] },
    { name: '体育', teacher: '王', room: '操场', day: 2, startPeriod: 3, endPeriod: 4, weeks: [2, 4, 6] }
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].weeks, [1, 2, 3, 4, 5, 6]);
});

test('登录成功首页含退出链接时不会被误判成登录页', () => {
  // 首页里出现 login_slogin.html 是退出链接的 href，不是登录表单
  const indexPage = '<a href="/jwglxt/xtgl/login_slogin.html?time=1">退出</a>'
    + '<div id="menu">课表查询</div>';
  const loginPage = '<form action="/jwglxt/xtgl/login_slogin.html">'
    + '<input type="text" name="yhm"><input type="password" name="mm"></form>';
  assert.equal(session.looksLikeLoginPage(indexPage), false);
  assert.equal(session.looksLikeLoginPage(loginPage), true);
});

/* ============================ 字段映射 ============================ */

test('教务课程映射后字段齐全，且与课程编辑页字段一致', () => {
  const courses = mapper.toCourses([
    { name: '高等数学', teacher: '张三', room: '主教 101', day: 1, startPeriod: 1, endPeriod: 2, weeks: [1, 2, 3] }
  ], 18);
  assert.equal(courses.length, 1);
  const course = courses[0];
  assert.deepEqual(Object.keys(course).sort(), mapper.COURSE_FIELDS.slice().sort());
  assert.equal(course.room, '主教 101');
  assert.equal(course.note, '');
  assert.equal(typeof course.id, 'string');
  assert.equal(typeof course.colorIndex, 'number');

  // 编辑页读写的字段都必须存在，否则编辑导入的课程会丢数据
  ['name', 'teacher', 'room', 'day', 'startPeriod', 'endPeriod', 'weeks', 'colorIndex', 'note']
    .forEach((field) => assert.ok(field in course, '编辑页字段缺失：' + field));
});

test('超出总周数的周次被裁掉，全都超出的课程被丢弃', () => {
  const courses = mapper.toCourses([
    { name: '正常课', day: 2, startPeriod: 3, endPeriod: 4, weeks: [1, 20] },
    { name: '全超出', day: 3, startPeriod: 1, endPeriod: 2, weeks: [25] }
  ], 18);
  assert.equal(courses.length, 1);
  assert.deepEqual(courses[0].weeks, [1]);
});

test('maxWeekOf 用于把总周数撑到够用，避免第 19 周的课被裁掉', () => {
  assert.equal(mapper.maxWeekOf([{ weeks: [1, 5] }, { weeks: [9] }]), 9);
  assert.equal(mapper.maxWeekOf([]), 0);
});

/* ============================ 学期推算 ============================ */

test('学期码换算', () => {
  assert.equal(zf.xqmOf(1), '3');
  assert.equal(zf.xqmOf(2), '12');
  assert.equal(zf.xqmOf(3), '16');
  assert.throws(() => zf.xqmOf(4), (error) => error.kind === 'VALIDATION_FAILED');
});

test('11 月默认落在本学年第一学期', () => {
  const term = zf.currentTerm(new Date('2026-11-02T10:00:00'));
  assert.equal(term.xnm, '2026');
  assert.equal(term.semester, 1);
  assert.equal(term.xqm, '3');
  assert.equal(term.label, '2026-2027 学年第 1 学期');
});

test('3 月默认落在上一学年第二学期', () => {
  const term = zf.currentTerm(new Date('2027-03-05T10:00:00'));
  assert.equal(term.xnm, '2026');
  assert.equal(term.semester, 2);
  assert.equal(term.xqm, '12');
});

/* ============================ 地址规范化 ============================ */

test('教务地址规范化：裸域名 / 带 jwglxt / 完整登录页都能补全', () => {
  assert.equal(
    session.loginUrlFor('jwglxt.buct.edu.cn'),
    'https://jwglxt.buct.edu.cn/jwglxt/xtgl/login_slogin.html'
  );
  assert.equal(
    session.loginUrlFor('https://jwglxt.buct.edu.cn/jwglxt'),
    'https://jwglxt.buct.edu.cn/jwglxt/xtgl/login_slogin.html'
  );
  assert.equal(
    session.loginUrlFor('https://jwglxt.buct.edu.cn/jwglxt/xtgl/login_slogin.html'),
    'https://jwglxt.buct.edu.cn/jwglxt/xtgl/login_slogin.html'
  );
});

test('教务根路径保留 /jwglxt 段，避免课表接口 404', () => {
  assert.equal(
    session.jwRootOf('https://jwglxt.buct.edu.cn/jwglxt/xtgl/login_slogin.html'),
    'https://jwglxt.buct.edu.cn/jwglxt'
  );
});

/* ============================ Set-Cookie 拆分 ============================ */

test('多个 Set-Cookie 被合并成一条时能正确拆开', () => {
  const merged = 'JSESSIONID=ABC123; Path=/jwglxt; HttpOnly, _csrf=TOKEN456; Path=/';
  assert.deepEqual(session.splitSetCookie(merged), [
    'JSESSIONID=ABC123; Path=/jwglxt; HttpOnly',
    '_csrf=TOKEN456; Path=/'
  ]);
});

test('Expires 里的逗号不会被误当成 cookie 分隔符', () => {
  const one = 'JSESSIONID=ABC123; Path=/jwglxt; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly';
  assert.deepEqual(session.splitSetCookie(one), [one]);
});

test('已是数组或空值时原样处理', () => {
  assert.deepEqual(session.splitSetCookie(['a=1', 'b=2']), ['a=1', 'b=2']);
  assert.deepEqual(session.splitSetCookie(''), []);
  assert.deepEqual(session.splitSetCookie(undefined), []);
});

/* ============================ 分层边界 ============================ */

test('协议层保持纯净：不含任何网络请求', () => {
  const source = read('utils/jw/zfClient.js');
  assert.doesNotMatch(source, /wx\.request/);
  assert.doesNotMatch(source, /wx\.setStorage/);
  assert.doesNotMatch(source, /console\.log/);
});

test('页面不落盘密码：import 页不含密码写入存储', () => {
  const source = read('pages/import/index.js');
  assert.doesNotMatch(source, /setStorageSync\([^)]*password/i);
  assert.match(source, /password: ''/);
});

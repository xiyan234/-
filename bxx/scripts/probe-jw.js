/**
 * 教务系统登录链路探测（只在电脑上跑，不进小程序包）
 *
 * 用途：把小程序里那 4 个请求用 node 原样重放一遍，把每一步的**原始响应**存到
 *       debug/ 目录，用来判断失败到底是协议问题还是账号问题。
 *
 * 用法：
 *   node scripts/probe-jw.js                       # 用假账号跑，只看协议通不通
 *   node scripts/probe-jw.js 你的学号               # 交互式输入密码，密码不回显、不落盘
 *
 * 【安全】密码只在这一刻进入内存，加密后立即发出，不写文件、不打印、不联网上报。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

const zf = require('../utils/jw/zfClient');

const ORIGIN = 'https://jwglxt.buct.edu.cn';
const LOGIN_URL = ORIGIN + '/jwglxt/xtgl/login_slogin.html';
const ROOT = ORIGIN + '/jwglxt';
const DEBUG_DIR = path.join(__dirname, '..', 'debug');

const jar = new Map();

function cookieHeader() {
  const parts = [];
  jar.forEach((value, name) => parts.push(name + '=' + value));
  return parts.join('; ');
}

function eatCookies(setCookie) {
  if (!setCookie) return;
  setCookie.forEach((line) => {
    const first = String(line).split(';')[0];
    const index = first.indexOf('=');
    if (index <= 0) return;
    const name = first.slice(0, index).trim();
    const value = first.slice(index + 1).trim();
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  });
}

function request(options, postBody, redirects) {
  const left = redirects === undefined ? 5 : redirects;
  return new Promise((resolve, reject) => {
    const headers = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    }, options.headers || {});
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (postBody) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(postBody);
    }
    const req = https.request({
      hostname: 'jwglxt.buct.edu.cn',
      port: 443,
      path: options.path,
      method: options.method || 'GET',
      headers,
      rejectUnauthorized: false
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        eatCookies(res.headers['set-cookie']);
        const status = res.statusCode;
        const location = res.headers.location || '';
        // 小程序 wx.request 会自动跟随 302，node 端得自己跟，否则看不到登录成功的首页
        if (status >= 300 && status < 400 && location && left > 0) {
          const next = /^https?:\/\//i.test(location)
            ? location.replace(/^https?:\/\/[^/]+/i, '')
            : location;
          const method = status === 303 ? 'GET' : (options.method || 'GET');
          resolve(request({ path: next, method, headers: options.headers }, status === 303 ? null : postBody, left - 1));
          return;
        }
        resolve({
          status,
          location,
          finalPath: options.path,
          setCookie: res.headers['set-cookie'] || [],
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (postBody) req.write(postBody);
    req.end();
  });
}

function save(name, text) {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(path.join(DEBUG_DIR, name), text, 'utf8');
}

function mask(text) {
  const value = String(text || '');
  if (value.length <= 8) return value;
  return value.slice(0, 6) + '...(' + value.length + ' chars)';
}

function summarizeForm(html) {
  const fields = zf.readFormFields(html);
  return fields.map((field) => field.name + '(' + field.type + ')');
}

async function main() {
  const username = String(process.argv[2] || '0000000000').trim();
  let password = String(process.argv[3] || 'probe_password_123');

  const report = [];
  const log = (line) => {
    report.push(line);
    console.log(line);
  };

  // 0. 登录页
  const pageTime = Date.now();
  const page = await request({ path: '/jwglxt/xtgl/login_slogin.html' });
  save('01-login-page.html', page.body);

  log('=== 0. 登录页 ===');
  log('status      : ' + page.status);
  log('bytes       : ' + page.body.length);
  log('set-cookie  : ' + page.setCookie.map((c) => String(c).split(';')[0].split('=')[0]).join(', '));
  log('form fields : ' + summarizeForm(page.body).join(' '));

  const mode = zf.decidePasswordMode(page.body);
  log('pwd mode    : ' + mode.mode);
  log('csrf        : ' + mask(mode.csrfToken));
  log('captcha box : ' + zf.hasCaptchaField(page.body));

  // 表单 action / 提交按钮
  const actionMatch = /<form[^>]*action=["']([^"']*)["']/i.exec(page.body);
  log('form action : ' + (actionMatch ? actionMatch[1] : '(none)'));
  const idMatch = /<form[^>]*id=["']([^"']*)["']/i.exec(page.body);
  log('form id     : ' + (idMatch ? idMatch[1] : '(none)'));

  // 1. 公钥
  const keyRes = await request({ path: '/jwglxt/xtgl/login_getPublicKey.html?time=' + Date.now() });
  save('02-public-key.json', keyRes.body);
  const key = zf.parsePublicKey(keyRes.body);
  const modBytes = require('../utils/jw/crypto').b64ToBytes(key.modulus);
  log('');
  log('=== 1. 公钥 ===');
  log('status      : ' + keyRes.status);
  log('modulus b64 : ' + mask(key.modulus));
  log('modulus byte: ' + modBytes.length + '  (首位 ' + modBytes[0] + ')');
  log('exponent b64: ' + key.exponent);

  const useQuery = process.argv.includes('--query');
  // query 模式下密文要进 URL，必须不含 +（+ 在 query 里会被解码成空格）
  const cipher = useQuery
    ? zf.encryptPasswordNoPlus(password, key.modulus, key.exponent)
    : zf.encryptPassword(password, key.modulus, key.exponent);
  log('cipher b64  : ' + mask(cipher));
  log('diag cipher : ' + zf.diagnoseEncryption(key.modulus, key.exponent).slice(0, 32) + '  ← 与小程序诊断里的 diag 对照');

  // 2a. 浏览器在提交登录前会先"退出当前会话里可能残留的账号"
  //     （login.js 的 yhdl() 第一步），我们之前漏了这一步
  const logout = await request({
    path: '/jwglxt/xtgl/login_logoutAccount.html',
    method: 'POST'
  }, 'csrfTokenLogout=');
  log('');
  log('=== 1.5 退出残留会话 ===');
  log('status      : ' + logout.status);
  log('body        : ' + String(logout.body).replace(/\s+/g, ' ').slice(0, 80));

  // 2b. 信息确认检查（浏览器每次登录都会问一次，false 表示需要弹窗，通常直接继续）
  const xqr = await request({
    path: '/jwglxt/xtgl/yhgl_cxXxqrCheck.html',
    method: 'POST'
  }, 'yhm=' + encodeURIComponent(username));
  log('xqr check   : ' + xqr.status + ' / ' + String(xqr.body).slice(0, 40));

  // 3. 提交登录（浏览器把 action 拼上 ?time=页面加载时间戳）
  const form = zf.buildLoginForm(page.body, username, cipher);
  save('03-post-form.txt', form.replace(/(mm=)[^&]*/g, '$1<CIPHER>'));
  log('');
  log('=== 2. 提交表单 ===');
  log('body        : ' + form.replace(/(mm=)[^&]*/g, '$1<CIPHER>'));
  log('body bytes  : ' + Buffer.byteLength(form));

  // 可选：--query 用"字段放 URL、body 留空"的方式提交
  // （小程序真机上带大 body 的 POST 会丢会话 Cookie，空 body 的不会）
  const queryPath = '/jwglxt/xtgl/login_slogin.html?time=' + pageTime + '&'
    + zf.buildLoginQueryRaw(page.body, username, cipher);
  log('via         : ' + (useQuery ? 'URL 参数 (body 为空, urlLen=' + queryPath.length + ')' : '表单 body'));

  const post = useQuery
    ? await request({ path: queryPath, method: 'POST' })
    : await request({
      path: '/jwglxt/xtgl/login_slogin.html?time=' + pageTime,
      method: 'POST'
    }, form);
  save('04-post-response.html', post.body);

  log('');
  log('=== 3. 提交结果 ===');
  log('status      : ' + post.status);
  log('location    : ' + (post.location || '(none)'));
  log('final url   : ' + post.finalPath);
  log('bytes       : ' + post.body.length);
  log('title       : ' + ((/<title>([\s\S]*?)<\/title>/i.exec(post.body) || [])[1] || '').trim());
  log('yhm box     : ' + /name=["']yhm["']/i.test(post.body));
  log('tips        : [' + zf.extractTips(post.body) + ']');
  log('failure kind: ' + zf.parseLoginFailure(post.body).kind);
  log('login ok    : ' + !/name=["']yhm["']/i.test(post.body));
  log('cookies now : ' + Array.from(jar.keys()).join(', '));

  // 3. 探活
  const probe = await request({ path: '/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default' });
  save('05-probe.html', probe.body);
  log('');
  log('=== 4. 课表页探活 ===');
  log('status      : ' + probe.status);
  log('bytes       : ' + probe.body.length);
  log('location    : ' + (probe.location || '(none)'));
  log('login page  : ' + /name=["']yhm["']/i.test(probe.body));

  // 4. 课表数据
  const kb = await request({
    path: '/jwglxt/kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151',
    method: 'POST'
  }, 'xnm=2025&xqm=3&kzlx=ck&xsdm=&kclbdm=&kclxdm=');
  save('06-kb.json', kb.body);
  log('');
  log('=== 5. 课表接口 ===');
  log('status      : ' + kb.status);
  log('bytes       : ' + kb.body.length);
  log('head        : ' + String(kb.body).replace(/\s+/g, ' ').slice(0, 160));

  save('00-report.txt', report.join('\n'));
  console.log('\n原始响应已存到 debug/ 目录');
}

if (process.argv[3]) {
  main().catch((error) => {
    console.error('探测失败：' + error.message);
    process.exit(1);
  });
} else if (process.argv[2]) {
  // 有学号但没密码 → 交互式输入，不回显
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write('请输入教务密码（输入时不显示）：');
  const stdin = process.stdin;
  stdin.setRawMode && stdin.setRawMode(true);
  let buf = '';
  const onData = (chunk) => {
    const text = chunk.toString('utf8');
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode && stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        console.log('密码指纹：' + zf.passwordFingerprint(buf) + '  ← 与小程序诊断里的 pwdFp 对照');
        rl.close();
        process.argv[3] = buf;
        main().catch((error) => {
          console.error('探测失败：' + error.message);
          process.exit(1);
        });
        return;
      }
      if (ch === '\u0003') process.exit(0);
      if (ch === '\u007f' || ch === '\b') {
        buf = buf.slice(0, -1);
        continue;
      }
      buf += ch;
    }
  };
  stdin.on('data', onData);
} else {
  main().catch((error) => {
    console.error('探测失败：' + error.message);
    process.exit(1);
  });
}

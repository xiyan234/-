/**
 * 教务会话层：Cookie 罐 + 四个请求组成的导入链路。
 *
 * 小程序 wx.request 不会自动保存和携带 Cookie，而正方登录是**有状态会话**：
 * 取登录页时发下 JSESSIONID，提交密码时认证的就是这个会话，后面查课表还要用它。
 * 所以这里自己维护一个按域名分桶的 Cookie 罐。
 *
 * 四个请求全部同域（都在 jwglxt.buct.edu.cn）：
 *   1. GET  /jwglxt/xtgl/login_slogin.html          取 csrftoken 与加密标记
 *   2. GET  /jwglxt/xtgl/login_getPublicKey.html    取 RSA 公钥（本校公钥不在页面里）
 *   3. POST /jwglxt/xtgl/login_slogin.html          提交学号与 RSA 密文
 *   4. POST /jwglxt/kbcx/xskbcx_cxXsKb.html         取课表 JSON
 *
 * 【安全边界】密码只在内存里过一手：加密后立刻提交，不写 Storage、不进日志、不拼进错误信息。
 */

const {
  GNMKDM,
  ZfError,
  buildLoginForm,
  buildLoginFormData,
  buildLoginQueryRaw,
  b64RoundTripOk,
  currentTerm,
  decidePasswordMode,
  describeZfError,
  diagnoseBigInt,
  diagnoseEncryption,
  encryptPasswordNoPlus,
  hasCaptchaField,
  mergeCourses,
  parseKbList,
  parseLoginFailure,
  parsePublicKey,
  passwordFingerprint,
  receivedLoginParams,
  xqmOf
} = require('./zfClient');

const TIMEOUT = 20000;

/** 域名 → { cookie 名: 值 } */
const jar = new Map();

function hostOf(url) {
  const match = /^https?:\/\/([^/?#]+)/i.exec(String(url || ''));
  return match ? match[1].toLowerCase() : '';
}

function cookieHeaderOf(url) {
  const bucket = jar.get(hostOf(url));
  if (!bucket || bucket.size === 0) return '';
  const parts = [];
  bucket.forEach((value, name) => parts.push(name + '=' + value));
  return parts.join('; ');
}

/** 只取 cookie 的「名字」，绝不输出值 —— 用于真机排查会话问题 */
function cookieNamesOf(url) {
  const bucket = jar.get(hostOf(url));
  return bucket ? Array.from(bucket.keys()) : [];
}

/**
 * 真机排查用的分步日志。
 * 手机端在「···」→「打开调试」后可在 vConsole 里看到；
 * 同时缓存到内存里，导入失败时可以直接在页面上展开查看。
 * 【安全】只记录 URL、状态码、响应字节数、cookie 名，绝不记录密码、密文和 cookie 值。
 */
const stepLog = [];

function logStep(step, detail) {
  const line = '[' + step + '] ' + (() => {
    try {
      return JSON.stringify(detail);
    } catch (error) {
      return String(detail);
    }
  })();
  stepLog.push(line);
  if (stepLog.length > 40) stepLog.shift();
  try {
    console.log('[jw] ' + line);
  } catch (error) {
    /* 日志失败不能影响主流程 */
  }
}

function resetStepLog() {
  stepLog.length = 0;
}

function getStepLog() {
  return stepLog.slice();
}

/**
 * 微信真机上可能把多个 Set-Cookie 合并成一条字符串返回（用逗号分隔），
 * 而 Expires 日期本身也含逗号（"Expires=Wed, 21 Oct 2025 07:28:00 GMT"），
 * 所以不能盲目按逗号切 —— 只在逗号后面紧跟「名字=」时才认为是下一条 cookie。
 */
function splitSetCookie(value) {
  if (Array.isArray(value)) return value;
  const text = String(value || '');
  if (!text) return [];
  return text
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function eatCookies(url, setCookie) {
  if (!setCookie) return;
  const list = splitSetCookie(setCookie);
  const host = hostOf(url);
  if (!host) return;
  if (!jar.has(host)) jar.set(host, new Map());
  const bucket = jar.get(host);
  list.forEach((line) => {
    const first = String(line).split(';')[0];
    const index = first.indexOf('=');
    if (index <= 0) return;
    const name = first.slice(0, index).trim();
    const value = first.slice(index + 1).trim();
    if (!name) return;
    if (value === '' || /max-age=0/i.test(String(line))) bucket.delete(name);
    else bucket.set(name, value);
  });
}

function clearCookies(url) {
  if (url) jar.delete(hostOf(url));
  else jar.clear();
}

/** 头字段大小写不固定，统一按小写找 */
function headerValue(header, name) {
  if (!header) return '';
  const target = name.toLowerCase();
  const keys = Object.keys(header);
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() === target) return header[keys[i]];
  }
  return '';
}

function isDomainError(message) {
  return /合法域名|domain list|not in domain|url not in/i.test(String(message || ''));
}

/**
 * 从 Set-Cookie 里挑出 JSESSIONID。
 * 用来判断"这次响应是否给了一个新的会话 ID" —— 服务端认得旧会话时不会重新下发，
 * 所以"又下发了一个不同的 JSESSIONID"就等于"它没收到我们发的 Cookie"。
 */
function pickSessionId(setCookie) {
  const list = splitSetCookie(setCookie);
  for (let i = 0; i < list.length; i += 1) {
    const first = String(list[i]).split(';')[0];
    const index = first.indexOf('=');
    if (index <= 0) continue;
    if (/^JSESSIONID$/i.test(first.slice(0, index).trim())) {
      return first.slice(index + 1).trim();
    }
  }
  return '';
}

/** 发一个请求，返回 { statusCode, body, header, sessionRenewed }。body 永远是字符串 */
/**
 * Cookie 传递方式。
 *
 * manual：我们自己在请求头里写 Cookie（电脑上一直这么干，没问题）。
 * native：完全不设 Cookie 头，交给微信自己的 Cookie 仓库去带。
 *
 * 【为什么要 native】`Cookie` 在浏览器规范里是"禁止脚本设置"的头。真机上出现过
 * "同一个 Cookie，GET 带得上、POST 带不上"的现象（取公钥认了会话、紧接着提交
 * 密码却不认），最合理的解释就是 POST 走了另一条网络实现，把我们设的头丢掉了，
 * 而它自己系统里的 Cookie 仓库本来是有值的。这种情况下不设比设更可靠。
 */
let cookieMode = 'manual';

// 依次尝试的顺序：先交给微信自己的 Cookie 仓库，再试小写 cookie 头，
// 最后用大写 Cookie 头（电脑上一直是这个，最保险但真机 POST 上可能被丢）
const COOKIE_MODES = ['native', 'lower', 'manual'];

function setCookieMode(mode) {
  cookieMode = COOKIE_MODES.indexOf(mode) >= 0 ? mode : 'manual';
}

function requestRaw(options) {
  const method = options.method || 'GET';
  const header = Object.assign({}, options.header || {});
  if (options.form) header['Content-Type'] = 'application/x-www-form-urlencoded';
  const cookie = cookieMode === 'native' ? '' : cookieHeaderOf(options.url);
  if (cookie) {
    // 部分网络实现只按精确名字过滤 Cookie，小写形式能绕过去
    if (cookieMode === 'lower') header.cookie = cookie;
    else header.Cookie = cookie;
  }
  const host = hostOf(options.url);
  const bucketBefore = jar.get(host);
  const sidBefore = bucketBefore ? bucketBefore.get('JSESSIONID') || '' : '';

  return new Promise((resolve, reject) => {
    wx.request({
      url: options.url,
      method,
      data: options.data,
      header,
      timeout: options.timeout || TIMEOUT,
      dataType: 'text',
      success(res) {
        const setCookie = headerValue(res.header, 'set-cookie');
        const sidAfter = pickSessionId(setCookie);
        eatCookies(options.url, setCookie);
        const raw = res.data;
        resolve({
          statusCode: res.statusCode,
          header: res.header || {},
          body: typeof raw === 'string' ? raw : JSON.stringify(raw),
          sessionRenewed: Boolean(sidAfter && sidBefore && sidAfter !== sidBefore)
        });
      },
      fail(err) {
        const message = (err && err.errMsg) || '未知错误';
        reject(new ZfError(
          isDomainError(message) ? 'DOMAIN_BLOCKED' : 'NETWORK_RETRYABLE',
          isDomainError(message) ? describeZfError('DOMAIN_BLOCKED') : '网络请求失败：' + message
        ));
      }
    });
  });
}

/* ============================ 地址规范化 ============================ */

/**
 * 把用户填的地址补成完整登录页地址。
 * 支持三种写法：完整登录页 / 带 /jwglxt 的根 / 裸域名。
 */
function loginUrlFor(address) {
  let text = String(address || '').trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
  text = text.replace(/^http:\/\//i, 'https://');
  const originMatch = /^(https:\/\/[^/]+)/i.exec(text);
  if (!originMatch) return '';
  const origin = originMatch[1];
  if (/login_slogin\.html/i.test(text)) return text.split('?')[0];
  const path = text.slice(origin.length).replace(/\/+$/, '');
  if (/\/xtgl$/i.test(path)) return origin + path + '/login_slogin.html';
  if (/\/jwglxt$/i.test(path)) return origin + path + '/xtgl/login_slogin.html';
  if (!path) return origin + '/jwglxt/xtgl/login_slogin.html';
  return origin + path + '/xtgl/login_slogin.html';
}

/**
 * 从登录页地址倒推教务根路径（含 /jwglxt 这一段）。
 * 少了这段会出现"登录成功但课表接口 404"，而且极难往"路径不够长"上想。
 */
function jwRootOf(address) {
  const login = loginUrlFor(address);
  if (!login) return '';
  const root = login.replace(/\/xtgl\/login_slogin\.html.*$/i, '');
  return root || '';
}

/* ============================ 导入流程 ============================ */

/**
 * 判断返回的是不是登录页。
 * 【只能看有没有学号输入框】登录成功后的首页里常常带一个指向 login_slogin.html
 * 的"退出"链接，按文件名匹配会把成功登录误判成失败。
 */
function looksLikeLoginPage(body) {
  return /name=["']yhm["']/i.test(String(body || ''));
}

function fail(kind, message) {
  return { ok: false, kind, error: message || describeZfError(kind), courses: [], term: null };
}

/**
 * 登录并抓取课表。
 * @param {{address?:string, username:string, password:string, semester?:number, xnm?:string}} input
 * @returns {Promise<{ok:boolean, kind?:string, error?:string, courses:Array, term?:object}>}
 */
async function importTimetable(input) {
  const address = input.address || 'https://jwglxt.buct.edu.cn/jwglxt/xtgl/login_slogin.html';
  const username = String(input.username || '').trim();
  const password = String(input.password || '');

  if (!username) return fail('VALIDATION_FAILED', '请填写学号');
  if (!password) return fail('VALIDATION_FAILED', '请填写密码');

  const loginUrl = loginUrlFor(address);
  const root = jwRootOf(address);
  if (!loginUrl || !root) return fail('VALIDATION_FAILED', '教务系统地址不正确');

  const base = currentTerm();
  const semester = Number(input.semester || base.semester);
  const xnm = String(input.xnm || base.xnm);
  let xqm;
  try {
    xqm = xqmOf(semester);
  } catch (error) {
    return fail('VALIDATION_FAILED', '学期选择不正确');
  }

  try {
    // 换账号先清会话，避免串号
    clearCookies();
    // 自动重试时保留上一轮的日志，方便对比几次的差异
    if (!input.__modeIndex) resetStepLog();
    const modeIndex = Math.min(Number(input.__modeIndex) || 0, COOKIE_MODES.length - 1);
    const mode0 = COOKIE_MODES[modeIndex];
    setCookieMode(mode0);
    logStep('start', {
      loginUrl,
      root,
      xnm,
      xqm,
      // 只记录"形状"，不记录内容：用于判断首尾空格、全角字符、长度异常
      userLen: username.length,
      pwdLen: password.length,
      pwdHasSpace: /\s/.test(password),
      pwdHasNonAscii: /[^\x00-\x7F]/.test(password),
      // 指纹：同一个密码在电脑和手机上算出来的值必须一样，
      // 不一样就说明输入的内容本身不同（输入法、自动填充、不可见字符）
      pwdFp: passwordFingerprint(password),
      cookieMode: mode0
    });

    // 0. 【进链路之前必须清空任何多余请求】
    //
    // 真机上同一个"对象形式 body"的提交，8 分钟内出现过两种结果：
    //   19170 = 服务端认出了会话；19101 = 没认出（csrftoken 为空）。
    // 请求内容一模一样，说明服务端每次处理它的机器可能不同 —— 而登录这条链
    // 依赖"同一个会话里的同一把私钥"，落到别的节点上就必然失败。
    // 浏览器能稳定登录，是因为它复用同一条连接；请求越少，落在同一台机器上的
    // 概率越高。所以这里只保留最短的三步：取登录页 → 取公钥 → 提交密码。
    // （退出旧会话、POST 通道探针这些纯诊断请求都去掉了。）

    // 1. 取登录页（这一句同时建立会话、拿到 csrftoken）
    const pageTime = Date.now();
    const page = await requestRaw({ url: loginUrl, method: 'GET' });
    if (page.statusCode >= 400) {
      return fail('NETWORK_RETRYABLE', '登录页返回 HTTP ' + page.statusCode);
    }
    const mode = decidePasswordMode(page.body);
    const csrfToken = mode.csrfToken;
    const cookieNames = cookieNamesOf(root);
    const hasSessionCookie = cookieNames.some((name) => /JSESSIONID/i.test(name));
    logStep('1-login-page', {
      status: page.statusCode,
      bytes: page.body.length,
      passwordMode: mode.mode,
      hasCsrf: Boolean(csrfToken),
      hasCaptchaField: hasCaptchaField(page.body),
      cookies: cookieNames,
      hasSession: hasSessionCookie
    });

    // 登录页必须发下 JSESSIONID，后面提交密码认的就是这个会话。
    // 拿不到时服务端会当成"没有会话"直接弹回登录页，而且**不写任何提示文本** ——
    // 表现和"密码错误"几乎一样，只有靠 error 文案里有没有服务器原话才能区分。
    if (!hasSessionCookie) {
      return fail(
        'NO_SESSION_COOKIE',
        '当前环境没有接到教务系统的会话 Cookie（微信开发者工具模拟器常见）。请用手机扫码预览，在真机上再试。'
      );
    }

    // 2. 取 RSA 公钥（本校公钥由独立接口下发，不在登录页 HTML 里）
    let cipher = password;
    if (mode.mode === 'required') {
      const keyResponse = await requestRaw({
        url: root + '/xtgl/login_getPublicKey.html?time=' + Date.now(),
        method: 'GET'
      });
      const key = parsePublicKey(keyResponse.body);
      // 用"结果不含 + 的密文"：密文要放进 URL，而 `+` 在 query 里会被当成空格。
      // 换一组随机填充重算即可，PKCS#1 的任何一组合法填充服务端都能解。
      cipher = encryptPasswordNoPlus(password, key.modulus, key.exponent);
      logStep('2-public-key', {
        status: keyResponse.statusCode,
        bytes: keyResponse.body.length,
        cipherB64Len: cipher.length,
        // 自检：同一把公钥下，BigInt 与 jsbn 两套实现必须算出同一段密文。
        // 与用户密码无关，可以安全外显（没有私钥无法还原明文）。
        diag: diagnoseEncryption(key.modulus, key.exponent),
        b64: b64RoundTripOk(key.modulus),
        elapsed: Date.now() - pageTime,
        bigInt: diagnoseBigInt(),
        sessionRenewed: Boolean(keyResponse.sessionRenewed)
      });

      // 【会话自检】带着 Cookie 再请求一次同域接口时，服务端认得这个会话就不会
      // 重新下发 JSESSIONID。若又下发了一个不同的，说明我们设的 Cookie 头压根没
      // 发出去 —— 那后面的登录提交必然是"新会话 + 旧 csrftoken"，服务端会一声
      // 不吭地把人弹回登录页，看起来和密码错误一模一样。
      if (keyResponse.sessionRenewed) {
        logStep('2a-session-renewed', { cookieMode: mode0, bytes: keyResponse.body.length });
        if (modeIndex < COOKIE_MODES.length - 1) {
          // 这种写法带不上会话，换下一种
          return importTimetable(Object.assign({}, input, { __modeIndex: modeIndex + 1, __retry: 1 }));
        }
        return fail(
          'COOKIE_BLOCKED',
          '这个环境没有把会话 Cookie 发回服务器，每次请求都被当成新会话。请把诊断信息发给开发者。'
        );
      }
    } else {
      logStep('2-public-key', { skipped: true, reason: 'password mode = ' + mode.mode });
    }

    // 3. 提交登录：按页面真实表单字段组装，与浏览器提交内容保持一致
    //
    // 【这里不允许再有任何请求】正方的私钥是存在会话里的，而且每次调用
    // login_getPublicKey 都会重新生成一把、覆盖上一把。所以从"取公钥"到
    // "提交密码"之间必须零请求：中间只要插一个请求（哪怕是退出旧会话、
    // 或者那个返回 false 的信息确认预检），服务端手里的私钥就可能已经不是
    // 我们加密时用的那一把 —— 解出来是乱码，提示却仍然是"密码不正确"。
    // 实测依据：请求不带有效会话时，失败页是 19101 字节；带会话时是 19170 字节。
    // 与浏览器、也与「电脑上已验证登录成功」的脚本完全一致：
    // 手拼 query string，mm 提交两次（页面上本来就有两个 name=mm 的输入框）。
    const form = buildLoginForm(page.body, username, cipher);
    // 原样字符版（整串不含 %，mm 提交两次）：只在对象形式也没送达时兜底
    const rawBody = buildLoginQueryRaw(page.body, username, cipher);

    // 浏览器加载登录页时会把表单 action 拼上 ?time=页面加载时间戳
    // （login.js 第一行 document.forms[0].action += "?time=" + 时间戳），
    // 服务端用它判断"打开页面到提交"的间隔，缺了会被当作非浏览器提交。
    //
    // 【提交前快照】只记长度，不记 Cookie 值。
    // cookieLen > 0 说明这次提交确实带上了会话；如果服务端返回的页面**没有变长**
    // （不带提示文字时是登录页本身，带提示时是"登录页 + 提示"，一定会更长），
    // 就说明它把这次提交当成了全新会话 —— 会话里没有私钥，必然解出一堆乱码。
    logStep('2.9-before-post', {
      cookieMode: mode0,
      cookieLen: cookieHeaderOf(loginUrl).length,
      gapMs: Date.now() - pageTime,
      csrfLen: String(csrfToken || '').length
    });

    // 【主路径：对象形式的表单，交给微信自己序列化】
    //
    // 真机上逐项试出来的结论（都是在同一台服务器上对照过的字节数）：
    //   手拼的字符串 body（里面带 %2C/%2B/%3D）  -> 19101，且 csrftoken 为空
    //   字段放 URL、body 留空                    -> 19171，字段一个都没送到
    //   对象形式 body                            -> 19170，会话和 21 个字段全部到位
    // 字符串 body 里那些 `%` 会被网络层再处理一次，导致服务端解析失败、会话被清掉；
    // 对象形式由微信按标准方式序列化，没有这个问题。
    let via = 'object';
    let post = await requestRaw({
      url: loginUrl + '?time=' + pageTime,
      method: 'POST',
      data: buildLoginFormData(page.body, username, cipher),
      form: true
    });
    logStep('3a-post-body', {
      status: post.statusCode,
      bytes: post.body.length,
      pageBytes: page.body.length,
      paramsReceived: receivedLoginParams(post.body),
      sessionSeenByServer: post.body.length > page.body.length
    });

    // 兜底：字段一个都没送到（没走到密码校验，不算密码错误）时，
    // 换成"原样字符 + mm 两次"的字符串 body 再交一次。
    if (
      post.statusCode >= 400 ||
      (looksLikeLoginPage(post.body) && !receivedLoginParams(post.body))
    ) {
      via = 'raw';
      post = await requestRaw({
        url: loginUrl + '?time=' + pageTime,
        method: 'POST',
        data: rawBody,
        form: true
      });
      logStep('3b-post-raw', {
        status: post.statusCode,
        bytes: post.body.length,
        pageBytes: page.body.length,
        paramsReceived: receivedLoginParams(post.body),
        sessionSeenByServer: post.body.length > page.body.length
      });
    }

    // 【服务端到底认没认这个会话】认了就是"登录页 + 一句提示"，页面一定变长；
    // 没认就是"不带会话的那一版登录页 + 提示"，比登录页还短
    // （实测：带会话 19170，不带会话 19101~19103，登录页本身 19114）。
    const sessionSeen = !looksLikeLoginPage(post.body) || post.body.length > page.body.length;

    if (looksLikeLoginPage(post.body)) {
      const failure = parseLoginFailure(post.body);
      logStep('3-post-login', {
        status: post.statusCode,
        bytes: post.body.length,
        pageBytes: page.body.length,
        // 登录页原样返回说明请求压根没进登录逻辑：
        // 服务端真走到密码校验时，一定会多出一句提示文字
        bounced: post.body.length === page.body.length,
        sessionSeenByServer: sessionSeen,
        via,
        paramsReceived: receivedLoginParams(post.body),
        fields: form.split('&').length,
        bodyLen: (via === 'raw' ? rawBody : '').length,
        result: 'still-on-login-page',
        failureKind: failure.kind,
        tips: (failure.tips || '').slice(0, 60)
      });
      let message = describeZfError(failure.kind);
      // 服务器原话比我们的通用话术更有诊断价值（"次数过多""验证码"等都在里面）
      if (failure.tips) {
        message = message + '（系统提示：' + failure.tips + '）';
      }

      // 返回的页面和登录页字节数完全相同、又没有任何提示文字 =>
      // 服务端既没校验密码也没报错，只是把请求弹回登录页。
      // 这时说"密码不正确"是误判，最常见的原因是连续失败次数过多被临时锁定
      // （本校登录页里 yzcskz=5 表示 5 次，dlsbsdsj=30 表示锁 30 分钟）。
      if (post.body.length === page.body.length && !failure.tips) {
        logStep('3b-bounced', { pageBytes: page.body.length, postBytes: post.body.length });
        return fail(
          'LOGIN_BOUNCED',
          '教务系统这次没有处理登录提交：既没有校验密码，也没有给出任何提示。最常见的原因是连续失败次数过多被临时锁定（本校规则是 5 次、锁 30 分钟）。请先在电脑浏览器确认能否正常登录，等一段时间再试。'
        );
      }

      // 两种提交方式都没把字段送达（服务端一个字段都没收到）：
      // 这时它只能回一句"密码不正确"，与密码本身无关，必须单独说清楚。
      if (!receivedLoginParams(post.body)) {
        logStep('3e-params-lost', { via, bytes: post.body.length });
        return fail(
          'PARAMS_LOST',
          '学号密码这次没有送达教务系统：它一个表单字段都没收到，所以只能回一句"密码不正确"。这不是密码的问题，是当前环境的网络层改写了请求。请把诊断信息发给开发者。'
        );
      }

      // 有提示、但页面比登录页还短 => 服务端把这次提交当成了全新会话，
      // 会话里没有私钥，密码必然解错。这时报"密码不正确"是彻底的误导
      if (!sessionSeen) {
        // 这类失败没有走到密码校验（csrftoken 为空），不累计登录失败次数，
        // 所以可以安全地整条链路重来一次 —— 换一次"落点"往往就正常了。
        if (modeIndex < COOKIE_MODES.length - 1) {
          logStep('3c-will-retry', { from: post.body.length, to: COOKIE_MODES[modeIndex + 1] });
          return importTimetable(Object.assign({}, input, { __modeIndex: modeIndex + 1, __retry: 1 }));
        }
        return fail(
          'SESSION_LOST_ON_POST',
          '这次登录提交没有被教务系统认成同一个会话：它拿不到解密密码所需的密钥，所以只能回一句"密码不正确"。已自动重试过一次仍不行，请退出本页重新进「从教务系统导入」；如果每次都这样，试一下切换网络（4G / Wi-Fi）。'
        );
      }

      // 【诊断：换成不依赖会话私钥的兼容模式再交一次】
      //
      // 到这里说明：会话认了、21 个字段都到了、密码字符串和电脑上完全一致
      // （指纹带位置权重），加密又是用学校自己的 jsbn 算的。那唯一还能怀疑的
      // 就是"我们加密用的公钥，和服务器会话里那把私钥不是一对"。
      //
      // 正方给不支持 JS 的浏览器留了 mmsfjm=0：密码不加密、直接明文比对，
      // 完全不需要会话私钥。用它就能把这件事一次证死：
      //   能登上   -> 密钥对不上，真机上的加密链路不可靠
      //   仍被拒绝 -> 与密钥无关，服务端就是不认这组凭据
      const plainPost = await requestRaw({
        url: loginUrl + '?time=' + pageTime,
        method: 'POST',
        data: buildLoginFormData(page.body, username, password, { plain: true }),
        form: true
      });
      const plainOk = plainPost.statusCode < 400 && !looksLikeLoginPage(plainPost.body);
      logStep('3f-plaintext-try', {
        status: plainPost.statusCode,
        bytes: plainPost.body.length,
        pageBytes: page.body.length,
        sessionSeenByServer: plainPost.body.length > page.body.length,
        paramsReceived: receivedLoginParams(plainPost.body),
        ok: plainOk,
        tips: (parseLoginFailure(plainPost.body).tips || '').slice(0, 40)
      });

      if (!plainOk) {
        return fail(
          failure.kind,
          message + '（已再用学校自己的兼容模式试过一次，同样被拒绝，说明与加密方式无关。）'
        );
      }
      // 兼容模式登上了：不 return，继续往下取课表
      post = plainPost;
    }

    logStep('3-post-login', {
      status: post.statusCode,
      bytes: post.body.length,
      result: 'ok',
      cookies: cookieNamesOf(root)
    });

    if (!cookieHeaderOf(root)) {
      return fail('SESSION_EXPIRED', '登录后没有拿到会话，学校可能关闭了网页端登录。');
    }

    // 4. 探活，顺便区分"没权限"和"会话失效"
    const probe = await requestRaw({
      url: root + '/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=' + GNMKDM + '&layout=default',
      method: 'GET'
    });
    logStep('4-probe', {
      status: probe.statusCode,
      bytes: probe.body.length,
      loginPage: looksLikeLoginPage(probe.body)
    });
    if (looksLikeLoginPage(probe.body)) return fail('SESSION_EXPIRED');
    if (/没有访问权限|无访问权限/.test(probe.body)) return fail('QUERY_DENIED');

    // 5. 取课表
    const kb = await requestRaw({
      url: root + '/kbcx/xskbcx_cxXsKb.html?gnmkdm=' + GNMKDM,
      method: 'POST',
      form: true,
      data: 'xnm=' + xnm + '&xqm=' + xqm + '&kzlx=ck&xsdm=&kclbdm=&kclxdm='
    });

    logStep('5-kb', {
      status: kb.statusCode,
      bytes: kb.body.length,
      head: String(kb.body).replace(/\s+/g, ' ').slice(0, 100)
    });
    if (!kb.body || kb.body.trim().length < 2) {
      return fail('QUERY_DENIED', '教务系统没有返回课表，可能这个学期还没排课。');
    }
    if (kb.body.trim().charAt(0) === '<') {
      if (looksLikeLoginPage(kb.body)) return fail('SESSION_EXPIRED');
      return fail('QUERY_DENIED');
    }

    const parsed = parseKbList(kb.body);
    const courses = mergeCourses(parsed);
    logStep('6-parse', { kbRows: parsed.length, courses: courses.length });
    const term = {
      xnm,
      xqm,
      semester,
      label: xnm + '-' + (Number(xnm) + 1) + ' 学年第 ' + semester + ' 学期'
    };

    if (!courses.length) {
      return {
        ok: false,
        kind: 'QUERY_DENIED',
        error: '教务系统有返回数据，但没解析出课程。可能这个学期还没排课，或学期选错了。',
        courses: [],
        term
      };
    }

    return { ok: true, kind: '', error: '', courses, term };
  } catch (error) {
    logStep('error', {
      kind: error && error.kind ? error.kind : 'UNKNOWN',
      message: (error && error.message ? String(error.message) : '').slice(0, 120)
    });
    if (error instanceof ZfError) {
      return fail(error.kind, error.kind === 'DOMAIN_BLOCKED' ? describeZfError('DOMAIN_BLOCKED') : error.message);
    }
    return fail('NETWORK_RETRYABLE', (error && error.message) || '导入失败');
  }
}

module.exports = {
  clearCookies,
  getStepLog,
  importTimetable,
  jwRootOf,
  loginUrlFor,
  looksLikeLoginPage,
  requestRaw,
  resetStepLog,
  splitSetCookie
};

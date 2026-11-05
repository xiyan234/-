/**
 * 正方教务（jwglxt）协议层 —— 纯函数，无网络、无存储、可单测。
 *
 * 负责三件事：
 *   1. 把密码按 PKCS#1 v1.5 加密成教务系统能解的密文
 *   2. 从登录页 HTML 里读出 csrftoken / 密码加密标记
 *   3. 把课表接口返回的 kbList JSON 解析成结构化课程
 *
 * 【安全边界】本文件只做数学，不保存密码、不发送密码、不打印密码。
 */

const { b64ToBytes, bytesToB64, randomBytes, utf8Encode } = require('./crypto');

/** 课表查询的功能模块码（正方固定值） */
const GNMKDM = 'N2151';
/** 验证码字段名。本校实测登录页无验证码，保留以便其他学校复用 */
const CAPTCHA_FIELD = 'yzm';

class ZfError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'ZfError';
    this.kind = kind;
  }
}

/* ============================ 学期与学年 ============================ */

/** 学期序号 → 正方学期码：1→3，2→12，3(小学期)→16 */
function xqmOf(semester) {
  if (Number(semester) === 1) return '3';
  if (Number(semester) === 2) return '12';
  if (Number(semester) === 3) return '16';
  throw new ZfError('VALIDATION_FAILED', '学期只能是 1 / 2 / 3');
}

/**
 * 按当前日期推算学年与学期，作为导入时的默认值（用户可改）。
 * 9-12 月与次年 1 月算第 1 学期，2-7 月算第 2 学期，8 月默认给即将开始的新学期。
 */
function currentTerm(now) {
  const date = now || new Date();
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  let xnm;
  let semester;
  if (month >= 9) {
    xnm = year;
    semester = 1;
  } else if (month === 1) {
    xnm = year - 1;
    semester = 1;
  } else if (month === 8) {
    xnm = year;
    semester = 1;
  } else {
    xnm = year - 1;
    semester = 2;
  }
  return {
    xnm: String(xnm),
    semester,
    xqm: xqmOf(semester),
    label: `${xnm}-${xnm + 1} 学年第 ${semester} 学期`
  };
}

/* ============================ RSA 加密 ============================ */

function ensureBigInt() {
  if (typeof BigInt !== 'function') {
    throw new ZfError('UNSUPPORTED', '当前微信版本不支持密码加密所需的大数运算，请升级微信后重试。');
  }
}

function bytesToBigInt(bytes) {
  let value = BigInt(0);
  const eight = BigInt(8);
  for (let i = 0; i < bytes.length; i += 1) {
    value = (value * BigInt(256)) + BigInt(bytes[i]);
  }
  return value;
}

function bigIntToBytes(value, length) {
  const out = new Uint8Array(length);
  let current = value;
  const mask = BigInt(0xff);
  const eight = BigInt(8);
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(current & mask);
    current >>= eight;
  }
  return out;
}

/**
 * 真实模长（字节）。
 *
 * 【为什么不直接用 bitLength/8】本校下发的 modulus Base64 解出来是 129 字节，
 * 首字节是补位用的 0x00，真实模长 128 字节。用位长换算时只要哪里差一位，
 * 就会得到 129 字节的密文块 —— base64 长度仍是 172（只是少了末尾的 "="），
 * 从外面完全看不出来，服务端却按 128 字节解密，必然失败。
 * 直接数"去掉前导零后剩几个字节"最稳，且与 BigInteger 的位长定义等价。
 */
function modulusByteLength(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i += 1;
  return bytes.length - i;
}

/** BigInteger 的比特长度，等价于 jsbn 的 n.bitLength() */
function bitLengthOf(value) {
  if (value <= BigInt(0)) return 0;
  return value.toString(2).length;
}

function modPow(base, exponent, modulus) {
  const one = BigInt(1);
  const two = BigInt(2);
  let result = one;
  let b = base % modulus;
  let e = exponent;
  while (e > BigInt(0)) {
    if (e % two === one) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= BigInt(1);
  }
  return result;
}

/** PKCS#1 v1.5 type-2 填充：0x00 0x02 + ≥8 个随机非零字节 + 0x00 + 数据 */
function pkcs1PadType2(data, keyLength, fixedByte) {
  const padLength = keyLength - data.length - 3;
  if (padLength < 8) throw new ZfError('VALIDATION_FAILED', '密码过长，超出加密块容量');
  const out = new Uint8Array(keyLength);
  out[0] = 0x00;
  out[1] = 0x02;
  if (fixedByte) {
    // 自检专用：填充固定成同一个非零字节。同样的明文 + 同样的公钥
    // 必然得到同样的密文，才能在电脑和手机之间逐字节对照。
    for (let i = 0; i < padLength; i += 1) out[2 + i] = fixedByte;
  } else {
    const random = randomBytes(padLength);
    for (let i = 0; i < padLength; i += 1) {
      out[2 + i] = random[i] === 0 ? (i % 254) + 1 : random[i];
    }
  }
  out[2 + padLength] = 0x00;
  out.set(data, 3 + padLength);
  return out;
}

/**
 * 加密自检：用固定明文 + 固定填充算一次密文。
 * 不涉及用户密码，结果可以安全地显示在页面上（没有私钥无法还原明文）。
 * 电脑与手机各跑一次，密文一致就说明加密实现完全一致。
 */
const DIAG_PLAIN = 'BPDIAG2026X';
const DIAG_FILL = 0x5a;

function diagnoseEncryption(modulusB64, exponentB64) {
  let big = '';
  let bigErr = '';
  try {
    big = encryptPasswordBigInt(DIAG_PLAIN, modulusB64, exponentB64, DIAG_FILL);
  } catch (error) {
    bigErr = error.message;
  }
  const js = encryptPasswordJsbn(DIAG_PLAIN, modulusB64, exponentB64, DIAG_FILL);
  const modBytes = b64ToBytes(modulusB64);
  let bits = 0;
  try {
    bits = new BigInteger(bytesToHex(modBytes), 16).bitLength();
  } catch (error) {
    bits = -1;
  }
  return {
    // 同一把公钥、同一段明文、同一套填充 => 两套实现必须给出完全相同的密文
    same: Boolean(big) && big === js,
    bigErr,
    big: big ? big.slice(0, 12) : '-',
    js: js.slice(0, 12),
    len: js.length,
    tail: js.slice(-1),
    modLen: modBytes.length,
    keyLen: modulusByteLength(modBytes),
    bits
  };
}

/** Base64 解码再编码能否还原原文（真机上用来确认编解码没走样） */
function b64RoundTripOk(b64) {
  const raw = String(b64 || '').replace(/[^A-Za-z0-9+/]/g, '');
  const back = bytesToB64(b64ToBytes(b64)).replace(/=+$/, '');
  return back === raw;
}

/**
 * BigInt 健康检查：真机上如果 BigInt 是近似实现（用 Number 模拟），
 * 1024 位运算会静默算错。这两条断言在正确实现下是固定值。
 */
function diagnoseBigInt() {
  if (typeof BigInt !== 'function') return 'none';
  try {
    const shiftOk = (BigInt(1) << BigInt(70)).toString() === '1180591620717411303424';
    const modOk = ((BigInt(1) << BigInt(1000)) + BigInt(7)) % BigInt(97) === BigInt(43);
    return shiftOk && modOk ? 'ok' : 'BAD';
  } catch (error) {
    return 'ERR';
  }
}

/* ============== 默认实现：不依赖 BigInt（学校前端同款 jsbn） ============== */

/**
 * 对外统一入口。默认走 jsbn，原因见下面 encryptPasswordJsbn 的注释。
 * BigInt 版本保留在 encryptPasswordBigInt，仅供单元测试与对照。
 */
function encryptPassword(password, modulusB64, exponentB64, fixedByte) {
  return encryptPasswordJsbn(password, modulusB64, exponentB64, fixedByte);
}

/* ============== 第二套实现：不依赖 BigInt（学校前端同款 jsbn） ============== */

/**
 * 【为什么需要第二套】
 * BigInt 在新版引擎里完全正确，但微信真机的 JS 引擎版本差异很大：实测同一份
 * 代码在电脑上算出的密文能被服务器解开，在手机上却不行 —— 长度一样（172 字符），
 * 内容不对。这类"静默算错"没法在外部捕获，只能换一套不依赖 BigInt 的实现。
 *
 * jsbn 是正方登录页自己用的库（纯 32 位整型数组 + Montgomery 模幂），
 * 在任何 JS 引擎上行为一致，且天然与服务器兼容。
 */
const BigInteger = require('./vendor/jsbn');

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const h = bytes[i].toString(16);
    out += h.length === 1 ? '0' + h : h;
  }
  return out;
}

function hexToBytes(hex) {
  const clean = hex.length % 2 ? '0' + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function encryptPasswordJsbn(password, modulusB64, exponentB64, fixedByte) {
  const modulusBytes = b64ToBytes(modulusB64);
  const n = new BigInteger(bytesToHex(modulusBytes), 16);
  // 本校指数为 65537（AQAB）。jsbn 精简版只保留 modPowInt（e 必须是 32 位以内的整数），
  // 小指数加密正是它的标准用法。
  const eNum = parseInt(bytesToHex(b64ToBytes(exponentB64)), 16);
  if (!(eNum > 0) || eNum > 0x7fffffff) {
    throw new ZfError('UNSUPPORTED', '公钥指数超出预期（' + eNum + '），无法用兼容模式加密');
  }
  const keyLength = modulusByteLength(modulusBytes);
  const data = utf8Encode(password);
  const padded = pkcs1PadType2(data, keyLength, fixedByte);
  const cipher = new BigInteger(bytesToHex(padded), 16).modPowInt(eNum, n);
  const raw = hexToBytes(cipher.toString(16));
  // modPow 的结果可能比模长少几个前导零字节，补齐到整块
  const block = new Uint8Array(keyLength);
  block.set(raw, keyLength - raw.length);
  return bytesToB64(block);
}

/**
 * 密码指纹：只输出长度和一个校验值，**不输出明文**。
 * 用途是判断「电脑上输入的那串」和「手机上输入的那串」是不是同一串字符，
 * 比如输入法把 @ 换成了全角、或者末尾跟了一个不可见字符。
 */
function passwordFingerprint(text) {
  const s = String(text || '');
  let sum = 0;
  let xor = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    sum = (sum + c * (i + 1)) % 99991;
    xor = (xor ^ ((c << 1) & 0xffff)) & 0xffff;
  }
  return 'len=' + s.length + ',sum=' + sum + ',xor=' + xor.toString(16);
}


/**
 * 等价于正方登录页 jsbn 的 RSAKey.encrypt：PKCS#1 v1.5 + Base64 输出。
 *
 * 【坑 1】modulus 与 exponent 都是 **Base64 编码**的，不是十六进制。
 * 【坑 2】本校下发的 modulus **带一个前导 0x00 字节**（Base64 解出来 129 字节），
 *   但真实模长是 1024 位 = 128 字节。若直接拿 Base64 解码长度当模长，
 *   填充块会多一个字节，服务器私钥解不开 —— 表现为"密码正确也说密码错"。
 *   所以模长必须按 BigInteger 的比特长度算，和 jsbn 的 (bitLength+7)>>3 一致。
 */
function encryptPasswordBigInt(password, modulusB64, exponentB64, fixedByte) {
  ensureBigInt();
  const modulusBytes = b64ToBytes(modulusB64);
  const n = bytesToBigInt(modulusBytes);
  const e = bytesToBigInt(b64ToBytes(exponentB64));
  const keyLength = modulusByteLength(modulusBytes);
  const data = utf8Encode(password);
  const padded = pkcs1PadType2(data, keyLength, fixedByte);
  const cipher = modPow(bytesToBigInt(padded), e, n);
  return bytesToB64(bigIntToBytes(cipher, keyLength));
}

/* ============================ 登录页解析 ============================ */

/**
 * 从登录页 HTML 读 csrftoken 与密码加密标记。
 *
 * 扫**整页**所有 input 而不是只看表单内部：正方有把 mmsfjm 放到表单外的版本。
 * 读不到 mmsfjm 时**绝不默认"不用加密"** —— 那样会把密码明文发给服务器。
 */
function readHiddenFields(html) {
  const out = {};
  const tags = String(html || '').match(/<input[^>]*>/gi) || [];
  tags.forEach((tag) => {
    if (!/type\s*=\s*["']?hidden/i.test(tag)) return;
    const nameMatch = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!nameMatch) return;
    const valueMatch = /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const key = nameMatch[1] !== undefined ? nameMatch[1]
      : nameMatch[2] !== undefined ? nameMatch[2] : nameMatch[3];
    const value = !valueMatch ? '' : (valueMatch[1] !== undefined ? valueMatch[1]
      : valueMatch[2] !== undefined ? valueMatch[2] : valueMatch[3]);
    out[String(key || '').trim()] = value;
  });
  return out;
}

/**
 * 判定这次登录要不要加密密码。
 * 返回 { mode: 'required' | 'plain', csrfToken }
 * 标记缺失或取值异常一律抛 PAGE_CHANGED，不猜。
 */
function decidePasswordMode(html) {
  const hidden = readHiddenFields(html);
  const csrfToken = hidden.csrftoken || '';
  const raw = hidden.mmsfjm;
  if (raw === undefined) {
    throw new ZfError('PAGE_CHANGED', '登录页缺少密码加密标记（mmsfjm），页面结构可能已变化');
  }
  const value = String(raw).trim();
  if (value === '1') return { mode: 'required', csrfToken };
  if (value === '0') return { mode: 'plain', csrfToken };
  throw new ZfError('PAGE_CHANGED', '登录页的密码加密标记取值异常（' + value + '），不做明文降级');
}

/** 解析 /xtgl/login_getPublicKey.html 返回的 {modulus, exponent} */
function parsePublicKey(body) {
  let root;
  try {
    root = JSON.parse(String(body || '').replace(/^\uFEFF/, '').trim());
  } catch (error) {
    throw new ZfError('PAGE_CHANGED', '教务系统没有返回有效的加密公钥');
  }
  const modulus = String((root && root.modulus) || '').trim();
  const exponent = String((root && root.exponent) || '').trim();
  if (!modulus || !exponent) throw new ZfError('PAGE_CHANGED', '教务系统返回的加密公钥不完整');
  return { modulus, exponent };
}

/* ============================ 课表解析 ============================ */

/** "1-2,5-6" / "3" / "1-2节" → [[1,2],[5,6]] / [[3,3]] */
function parsePeriods(jcs) {
  const text = String(jcs || '').replace(/[节次\s]/g, '');
  const pattern = /(\d+)\s*[-–—~至]\s*(\d+)|(\d+)/g;
  const out = [];
  let match = pattern.exec(text);
  while (match) {
    if (match[1] !== undefined) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (start > 0 && end >= start) out.push([start, end]);
    } else if (match[3] !== undefined) {
      const single = Number(match[3]);
      if (single > 0) out.push([single, single]);
    }
    match = pattern.exec(text);
  }
  return out;
}

/**
 * 周次文本 → 周次数组。
 * 支持 "1-16"、"1-16周(单)"、"1-8,10-16"、"3"。
 * 刻意不用正则后行断言（(?<!\d)），老版本 iOS 的 JS 引擎不支持，会整页报错。
 */
function parseWeeks(zcd) {
  const text = String(zcd || '');
  const onlyOdd = text.indexOf('单') >= 0;
  const onlyEven = text.indexOf('双') >= 0;
  const cleaned = text.replace(/[单双周（）()【】\[\]\s]/g, '');
  const weeks = {};
  const push = (week) => {
    if (week <= 0 || week > 30) return;
    if (onlyOdd && week % 2 === 0) return;
    if (onlyEven && week % 2 === 1) return;
    weeks[week] = true;
  };
  const pattern = /(\d+)\s*[-–—~至]\s*(\d+)|(\d+)/g;
  let match = pattern.exec(cleaned);
  while (match) {
    if (match[1] !== undefined) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      for (let week = from; week <= to; week += 1) push(week);
    } else if (match[3] !== undefined) {
      push(Number(match[3]));
    }
    match = pattern.exec(cleaned);
  }
  return Object.keys(weeks).map(Number).sort((left, right) => left - right);
}

/**
 * kbList JSON → 结构化课程。
 * 兼容 {kbList:[…]} 与裸数组两种根结构；缺课名或星期越界的行直接跳过，不编造。
 */
function parseKbList(body) {
  let root;
  try {
    root = JSON.parse(String(body || '').replace(/^\uFEFF/, '').trim());
  } catch (error) {
    throw new ZfError('PAGE_CHANGED', '课表数据格式无法识别');
  }
  const rows = Array.isArray(root) ? root : (root && (root.kbList || root.data)) || [];
  if (!Array.isArray(rows)) throw new ZfError('PAGE_CHANGED', '课表数据格式无法识别');

  const courses = [];
  rows.forEach((row) => {
    const name = String((row && row.kcmc) || '').trim();
    if (!name) return;
    const day = Number(String((row && row.xqj) || '').trim());
    if (!(day >= 1 && day <= 7)) return;
    const rooms = ['xqmc', 'cdxqmc', 'cdmc', 'jxcdmc']
      .map((field) => String((row && row[field]) || '').trim())
      .filter((value) => value !== '')
      .filter((value, index, list) => list.indexOf(value) === index)
      .join(' ');
    const teacher = String((row && row.xm) || '').trim();
    const weeksText = String((row && row.zcd) || '').trim();
    const weeks = parseWeeks(weeksText);
    parsePeriods(String((row && row.jcs) || '')).forEach(([startPeriod, endPeriod]) => {
      courses.push({
        name,
        teacher,
        room: rooms,
        day,
        startPeriod,
        endPeriod,
        weeksText,
        weeks
      });
    });
  });
  return courses;
}

/**
 * 同一门课常有 单周/双周 两行，或分周次多行。
 * 按「课名+教师+教室+星期+节次」合并，周次取并集，避免课表格子里叠出两层。
 */
function mergeCourses(courses) {
  const buckets = new Map();
  courses.forEach((course) => {
    const key = [course.name, course.teacher, course.room, course.day, course.startPeriod, course.endPeriod].join('|');
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        name: course.name,
        teacher: course.teacher,
        room: course.room,
        day: course.day,
        startPeriod: course.startPeriod,
        endPeriod: course.endPeriod,
        weeks: course.weeks.slice()
      });
      return;
    }
    const union = new Set(existing.weeks.concat(course.weeks));
    existing.weeks = Array.from(union).sort((left, right) => left - right);
  });
  return Array.from(buckets.values());
}

/* ============================ 登录失败判定 ============================ */

/** 解析页面里所有带 name 的 input，保持 HTML 中的原始顺序 */
function readFormFields(html) {
  const fields = [];
  const tags = String(html || '').match(/<input[^>]*>/gi) || [];
  tags.forEach((tag) => {
    const nameMatch = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!nameMatch) return;
    const name = String(
      nameMatch[1] !== undefined ? nameMatch[1]
        : nameMatch[2] !== undefined ? nameMatch[2] : nameMatch[3] || ''
    ).trim();
    if (!name) return;

    const typeMatch = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const type = String(
      typeMatch ? (typeMatch[1] !== undefined ? typeMatch[1]
        : typeMatch[2] !== undefined ? typeMatch[2] : typeMatch[3]) : 'text'
    ).toLowerCase();

    const valueMatch = /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = !valueMatch ? '' : String(
      valueMatch[1] !== undefined ? valueMatch[1]
        : valueMatch[2] !== undefined ? valueMatch[2] : valueMatch[3]
    );

    fields.push({ name, type, value, checked: /\bchecked\b/i.test(tag) });
  });
  return fields;
}

/**
 * 组装登录 POST body，尽量与浏览器真实提交保持一致。
 *
 * 【为什么不能只提交四个字段】正方登录页里有十几个隐藏字段（xxdm 学校代码、
 * yzcskz 验证码策略、mmsfjm 加密标记等），浏览器会全部提交。只提交
 * csrftoken/yhm/mm 时，服务端可能因缺少学校标识或参数结构不符，统一返回
 * "用户名或密码不正确"这类模糊提示（防爆破设计），表现为"密码明明对却登不上"。
 *
 * 【为什么不硬拼空 yzm】页面没有验证码输入框时浏览器不会提交 yzm；
 * 固定拼一个空的 yzm= 会让服务端进入验证码校验分支并同样返回模糊失败提示。
 * 现在改为：页面里有才提交，没有就不提交。
 *
 * 【为什么 mm 要提交两次】页面上有两个 name=mm 的输入框（隐藏的 hidMm 与可见的
 * 密码框），正方提交时两者都写入密文，服务端取第一个。
 */
function buildLoginForm(html, username, cipher, options) {
  // options.plain = true 时走正方自带的"兼容模式"：把 mmsfjm 置 0，
  // mm 传明文。这条路是正方给不支持 JS 的浏览器留的退路，不需要会话里的私钥，
  // 只在"服务端认不出会话、加密提交注定失败"时才用。
  const plain = Boolean(options && options.plain);
  const fields = readFormFields(html);
  const parts = [];

  fields.forEach((field) => {
    // 学号与密码由调用方填充，其余字段原样透传
    if (field.name === 'yhm' || field.name === 'mm') return;
    if (field.type === 'checkbox' || field.type === 'radio') {
      if (!field.checked) return; // 未勾选的复选框浏览器不提交
    }
    if (field.type === 'submit' || field.type === 'button' || field.type === 'reset' || field.type === 'file') return;
    const value = plain && field.name === 'mmsfjm' ? '0' : field.value;
    parts.push(encodeURIComponent(field.name) + '=' + encodeURIComponent(value));
  });

  parts.push('yhm=' + encodeURIComponent(username));
  parts.push('mm=' + encodeURIComponent(cipher));
  parts.push('mm=' + encodeURIComponent(cipher));

  return parts.join('&');
}

/** 页面是否存在验证码输入框（仅用于提示，不再影响提交内容） */
function hasCaptchaField(html) {
  return readFormFields(html).some((field) => field.name === CAPTCHA_FIELD);
}

/**
 * 只转义会破坏 URL 结构的字符，其余原样保留。
 *
 * 【为什么不用 encodeURIComponent】把编码好的 query 整串交给小程序的网络接口时，
 * 真机上会被**再转义一次**（`=`→`%3D`、`&`→`%26`），服务端于是只看到一个没有
 * `=` 的巨型参数，一个字段都取不到（实测返回 19171 字节、csrftoken 有值、ydType=0）。
 * 只要 URL 里不出现 `%`，就不会触发那次二次转义 —— 所以这里只处理必须处理的字符。
 */
function minimizeUrlValue(value) {
  return String(value).replace(/[%&#+\s]/g, function (ch) {
    if (ch === '%') return '%25';
    if (ch === '&') return '%26';
    if (ch === '#') return '%23';
    if (ch === '+') return '%2B';
    return '%20';
  });
}

/**
 * 组装登录 query（**原样字符**，整体不含 `%`，前提是密文里没有 `+`）。
 * 用法：`POST login_slogin.html?time=<ts>&<本函数返回值>`，body 留空。
 *
 * 之所以要把字段搬到 URL 上：真机上带较大 body 的 POST 会丢掉会话 Cookie
 * （服务端返回 19101 字节、csrftoken 为空的那一版页面），而空 body 的 POST 不会。
 * 正方这个登录接口会从 query string 解析字段，空 body 提交同样能走完密码校验。
 */
function buildLoginQueryRaw(html, username, cipher) {
  const fields = readFormFields(html);
  const parts = [];

  fields.forEach((field) => {
    if (field.name === 'yhm' || field.name === 'mm') return;
    if (field.type === 'checkbox' || field.type === 'radio') {
      if (!field.checked) return;
    }
    if (field.type === 'submit' || field.type === 'button' || field.type === 'reset' || field.type === 'file') return;
    parts.push(field.name + '=' + minimizeUrlValue(field.value));
  });

  parts.push('yhm=' + minimizeUrlValue(username));
  parts.push('mm=' + minimizeUrlValue(cipher));
  parts.push('mm=' + minimizeUrlValue(cipher));

  return parts.join('&');
}

/**
 * 服务端这次到底有没有收到表单字段。
 *
 * 依据：收到字段时错误页里是 `name="ydType" ... value= >`（空值），
 * 一个字段都没收到时是 `value= 0`。电脑 UA 与手机 UA 下都稳定，实测对照过。
 * 用途：判断"这次提交根本没被当成登录处理"，从而决定要不要换提交方式重试，
 * 而不是把"字段没送到"误报成"密码不正确"。
 */
function receivedLoginParams(html) {
  return /name=["']ydType["'][^>]*value=\s*>/i.test(String(html || ''));
}

/**
 * 加密密码，并保证 base64 结果里**不含 `+`**。
 *
 * 因为 `+` 在 query string 里会被解码成空格，密文一进 URL 就坏了；而 `%2B`
 * 又会把 `%` 带进 URL、触发小程序的二次转义。PKCS#1 的填充字节本来就是随机的，
 * 换一组随机填充重新算即可 —— 任何一组都合法，服务端只要求能解出明文。
 * 实测平均重试十几次就能拿到不含 `+` 的密文，单次 1~4ms。
 */
function encryptPasswordNoPlus(password, modulusB64, exponentB64) {
  for (let i = 0; i < 400; i += 1) {
    const cipher = encryptPassword(password, modulusB64, exponentB64);
    if (cipher.indexOf('+') < 0) return cipher;
  }
  return encryptPassword(password, modulusB64, exponentB64);
}

/**
 * 组装登录参数（**对象形式**），交给小程序的网络接口自己序列化。
 *
 * 【为什么不用拼好的字符串】网络接口对 String 类型的 data 有额外处理，
 * 实测在小程序里会出问题：服务端收到的不是一次表单提交，而是被当成普通页面
 * 访问退回登录页（表现为"密码明明对却提示密码错"，且没有任何服务器提示）。
 * 改成对象后，微信按 `encodeURIComponent(k)=encodeURIComponent(v)&...` 的
 * 标准方式序列化，与浏览器提交表单一致。
 *
 * 【为什么只放一个 mm】对象无法容纳重复键。页面上两个 mm 浏览器都填同一段
 * 密文，服务端取到的就是密文；只提交一个，取到的同样是密文，实测无差别。
 */
function buildLoginFormData(html, username, cipher, options) {
  // options.plain = true 走正方给不支持 JS 的浏览器留的兼容模式：mmsfjm 置 0、mm 传明文。
  // 这条路不依赖会话里的私钥，用来验证"问题是不是出在 RSA 密钥对不上"。
  const plain = Boolean(options && options.plain);
  const fields = readFormFields(html);
  const data = {};
  fields.forEach((field) => {
    if (field.name === 'yhm' || field.name === 'mm') return;
    if (field.type === 'checkbox' || field.type === 'radio') {
      if (!field.checked) return;
    }
    if (field.type === 'submit' || field.type === 'button' || field.type === 'reset' || field.type === 'file') return;
    data[field.name] = plain && field.name === 'mmsfjm' ? '0' : field.value;
  });
  data.yhm = username;
  data.mm = cipher;
  return data;
}

/** 取登录失败页里服务器给出的提示文本（正方放在 id="tips" 的元素里） */
function extractTips(html) {
  const body = String(html || '');
  // 用反向引用闭合同名标签：提示文本里常嵌 <span> 图标，不能遇到第一个 </x> 就截断
  const match = /<([a-z]+)[^>]*id=["']tips["'][^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (!match) return '';
  return match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 判定这次登录为什么没成功。
 *
 * 【顺序很重要】必须先看有没有验证码**输入框**，再看文案。
 * 登录页里"验证码"三个字是常见文案（短信验证码、图形验证码 tab），
 * 只按文案匹配会把"密码错误"误判成"需要验证码"。
 */
function parseLoginFailure(html) {
  const body = String(html || '');
  if (new RegExp('name=["\']' + CAPTCHA_FIELD + '["\']', 'i').test(body)) {
    return { kind: 'NEED_CAPTCHA', tips: extractTips(body) };
  }
  const tips = extractTips(body);
  const text = tips || body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  if (/锁定|冻结|次数过多/.test(text)) return { kind: 'ACCOUNT_LOCKED', tips };
  if (/停用|禁用|注销|已失效/.test(text)) return { kind: 'ACCOUNT_DISABLED', tips };
  if (/验证码/.test(text)) return { kind: 'NEED_CAPTCHA', tips };
  if (/用户名或密码|密码不正确|密码错误|用户名不存在|账号或密码/.test(text)) {
    return { kind: 'INVALID_CREDENTIALS', tips };
  }
  return { kind: 'INVALID_CREDENTIALS', tips };
}

/* ============================ 错误话术 ============================ */

const ERROR_TEXT = {
  NEED_CAPTCHA: '这次登录需要验证码，请先在浏览器登录一次教务系统，再回来重试。',
  INVALID_CREDENTIALS: '学号或密码不正确，请检查后重试。',
  ACCOUNT_LOCKED: '账号因多次输错被临时锁定，请等待一段时间后再试，或联系教务处解锁。',
  ACCOUNT_DISABLED: '这个账号当前不可用，请联系教务处确认状态。',
  SESSION_EXPIRED: '登录状态已失效，请重新导入。',
  NO_SESSION_COOKIE: '当前环境没有接到教务系统的会话 Cookie，请改用手机预览后重试。',
  COOKIE_BLOCKED: '当前环境不会把会话 Cookie 发回服务器，请改用手机预览后重试。',
  METHOD_LOST: '当前环境没有如实发出 POST 请求，请改用手机预览后重试。',
  LOGIN_BOUNCED: '教务系统没有处理这次登录提交，可能是连续失败被临时锁定，请稍后再试。',
  SESSION_LOST_ON_POST: '登录提交没有被认成同一个会话，服务端拿不到解密密码的密钥。',
  PARAMS_LOST: '学号密码没有送达教务系统，服务端一个表单字段都没收到。',
  NETWORK_RETRYABLE: '教务系统暂时连不上，请检查网络后重试。',
  PAGE_CHANGED: '教务系统页面结构有变化，暂时无法识别，请稍后再试。',
  QUERY_DENIED: '学校没有开放当前账号的课表查询权限，请联系教务处。',
  VALIDATION_FAILED: '填写的信息不完整或格式不对。',
  UNSUPPORTED: '当前微信版本过低，请升级后再试。',
  DOMAIN_BLOCKED: '还没有在小程序后台配置教务系统域名，请先按说明添加。'
};

function describeZfError(kind) {
  return ERROR_TEXT[kind] || '导入没有完成，请稍后重试。';
}

module.exports = {
  CAPTCHA_FIELD,
  ERROR_TEXT,
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
  encryptPassword,
  encryptPasswordBigInt,
  encryptPasswordJsbn,
  encryptPasswordNoPlus,
  extractTips,
  hasCaptchaField,
  mergeCourses,
  parseKbList,
  parseLoginFailure,
  parsePeriods,
  parsePublicKey,
  parseWeeks,
  passwordFingerprint,
  receivedLoginParams,
  readFormFields,
  readHiddenFields,
  xqmOf
};

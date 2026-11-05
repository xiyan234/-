/**
 * 加密工具（纯 JS，无依赖）
 *
 * 小程序里没有 atob / btoa / TextEncoder，正方登录的 RSA 加密又要用到它们，
 * 所以这里补最小实现。只做编码和随机数，不涉及任何网络与存储。
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 → 字节数组。忽略换行、空格等非字母表字符 */
function b64ToBytes(b64) {
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const v = B64.indexOf(clean[i]);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p] = (buf >> bits) & 0xff;
      p += 1;
    }
  }
  return out.subarray(0, p);
}

/** 字节数组 → Base64（带 = 补齐） */
function bytesToB64(bytes) {
  let out = '';
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    buf = (buf << 8) | bytes[i];
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64[(buf >> bits) & 0x3f];
    }
  }
  if (bits > 0) out += B64[(buf << (6 - bits)) & 0x3f];
  while (out.length % 4 !== 0) out += '=';
  return out;
}

/** 字符串 → UTF-8 字节。含代理对处理，密码里有 emoji 也不会坏 */
function utf8Encode(text) {
  const s = String(text || '');
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      i += 1;
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/**
 * 随机字节。只用于 RSA 填充块，不用于生成密钥。
 *
 * 【为什么不用 wx.getRandomValues】它是**异步** API（结果在 success 回调的
 * `res.randomValues` 里），同步调用只会拿到 undefined，拿不到任何字节。
 * 曾经把它当同步用，导致填充块恒为「1,2,3...」这种固定序列 —— 虽然仍满足
 * PKCS#1「全非零」的要求，但每次密文的填充都可预测。
 * 这里直接用 Math.random；调用方还会把 0 替换成非零值，保证填充合法。
 */
function randomBytes(len) {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

module.exports = { b64ToBytes, bytesToB64, randomBytes, utf8Encode };

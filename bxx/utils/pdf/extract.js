/**
 * 从课表 PDF 里取出「文字 + 坐标」。
 *
 * 本校导出的课表 PDF 是固定模板：内容流用 FlateDecode 压缩，文字用
 * (...) Tj / <...> Tj 绘制，每段文字前面有 Tm 或 Td 给出坐标，中文按
 * UniGB-UCS2-H 的双字节 UCS-2 编码。这里只提取文字层，不做页面渲染，
 * 因此不需要 canvas、字体文件或 Worker。
 */

const { inflateZlib, toBytes } = require('./inflate.js');
const { PdfImportError } = require('./errors.js');

const TOKEN = /([-\d.]+(?:\s+[-\d.]+){5})\s+Tm|([-\d.]+)\s+([-\d.]+)\s+Td|\(((?:\\.|[^()\\])*)\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj/g;

function latin1(bytes) {
  let text = '';
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    text += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK));
  }
  return text;
}

function streamsOf(bytes, raw) {
  const streams = [];
  let cursor = 0;
  while ((cursor = raw.indexOf('stream', cursor)) >= 0) {
    if (cursor > 0 && raw.slice(cursor - 3, cursor) === 'end') { cursor += 6; continue; }
    let start = cursor + 6;
    if (raw[start] === '\r') start += 1;
    if (raw[start] === '\n') start += 1;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    let stop = end;
    if (raw[stop - 1] === '\n') stop -= 1;
    if (raw[stop - 1] === '\r') stop -= 1;
    if (stop > start) streams.push(bytes.subarray(start, stop));
    cursor = end + 9;
  }
  return streams;
}

function decodeBytes(bytes, ucs2) {
  let text = '';
  if (ucs2) {
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    }
    return text;
  }
  bytes.forEach((byte) => { text += String.fromCharCode(byte); });
  return text;
}

function decodeLiteral(raw, ucs2) {
  const bytes = [];
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== '\\') { bytes.push(char.charCodeAt(0) & 0xff); continue; }
    const next = raw[++index];
    if (next >= '0' && next <= '7') {
      let octal = next;
      for (let count = 0; count < 2 && raw[index + 1] >= '0' && raw[index + 1] <= '7'; count += 1) {
        octal += raw[++index];
      }
      bytes.push(parseInt(octal, 8) & 0xff);
    } else {
      const escapes = { n: 10, r: 13, t: 9, b: 8, f: 12 };
      bytes.push(escapes[next] !== undefined ? escapes[next] : next.charCodeAt(0));
    }
  }
  return decodeBytes(bytes, ucs2);
}

function decodeHex(raw, ucs2) {
  const hex = raw.replace(/\s+/g, '');
  const bytes = [];
  for (let index = 0; index + 1 < hex.length; index += 2) bytes.push(parseInt(hex.slice(index, index + 2), 16));
  return decodeBytes(bytes, ucs2);
}

function scanContent(content, group, ucs2, items) {
  TOKEN.lastIndex = 0;
  let x = 0;
  let y = 0;
  let match;
  while ((match = TOKEN.exec(content)) !== null) {
    if (match[1] !== undefined) {
      const matrix = match[1].split(/\s+/).map(Number);
      x = matrix[4];
      y = matrix[5];
    } else if (match[2] !== undefined) {
      x += Number(match[2]);
      y += Number(match[3]);
    } else if (match[4] !== undefined) {
      items.push({ group, x, y, text: decodeLiteral(match[4], ucs2) });
    } else if (match[5] !== undefined) {
      items.push({ group, x, y, text: decodeHex(match[5], ucs2) });
    }
  }
}

/**
 * @param {ArrayBuffer|Uint8Array} input PDF 文件二进制
 * @returns {Array<{group:number,x:number,y:number,text:string}>} 带坐标的文字片段
 */
function extractTextItems(input) {
  const bytes = toBytes(input);
  const raw = latin1(bytes);
  if (raw.slice(0, 5) !== '%PDF-') {
    throw new PdfImportError('NOT_PDF', '这不是 PDF 文件，请选择从学校课表页导出的 PDF。');
  }
  if (/\/Encrypt\b/.test(raw)) {
    throw new PdfImportError('ENCRYPTED', '这份 PDF 已加密，请重新导出一份未加密的课表。');
  }

  const ucs2 = /UniGB-UCS2-H|Identity-H|UCS2|UTF-16/i.test(raw);
  const items = [];
  let decodedStreams = 0;
  streamsOf(bytes, raw).forEach((chunk, group) => {
    let content = null;
    try {
      content = latin1(inflateZlib(chunk));
      decodedStreams += 1;
    } catch (error) {
      const plain = latin1(chunk);
      if (!/BT|Tm|Tj/.test(plain)) return;
      content = plain;
    }
    scanContent(content, group, ucs2, items);
  });

  if (!items.length) {
    if (!decodedStreams) {
      throw new PdfImportError('INFLATE_FAILED', '无法读取 PDF 内容，文件可能已损坏或使用了不支持的压缩方式。');
    }
    throw new PdfImportError('NO_TEXT_LAYER', '这份 PDF 没有可读取的文字层（可能是截图或扫描件），请在课表页用「输出 PDF」重新导出。');
  }
  if (!items.some((item) => /[\u4e00-\u9fa5]/.test(item.text))) {
    throw new PdfImportError('UNSUPPORTED_FORMAT', '无法识别 PDF 里的中文，可能不是学校导出的课表文件。');
  }
  return items;
}

module.exports = { extractTextItems, decodeLiteral };

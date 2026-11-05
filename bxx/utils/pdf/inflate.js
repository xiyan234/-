/**
 * 极简 zlib / DEFLATE 解压，纯 JS、无第三方依赖。
 *
 * 课表 PDF 的内容流是「2 字节 zlib 头 + DEFLATE + 4 字节 Adler32」。
 * 小程序里没有 zlib，也不想为了解压引入整套 PDF 运行时，所以这里只实现
 * DEFLATE 解码需要的固定 Huffman、动态 Huffman、存储块和 LZ77 回溯。
 * 输入 Uint8Array / ArrayBuffer，返回解压后的 Uint8Array。
 */

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuffman(lengths) {
  const count = new Array(16).fill(0);
  lengths.forEach((length) => { if (length) count[length] += 1; });
  count[0] = 0;
  const offsets = new Array(16).fill(0);
  for (let length = 1; length < 15; length += 1) offsets[length + 1] = offsets[length] + count[length];
  const symbol = [];
  lengths.forEach((length, index) => {
    if (!length) return;
    symbol[offsets[length]] = index;
    offsets[length] += 1;
  });
  return { count, symbol };
}

function fixedTables() {
  const literal = [];
  for (let index = 0; index < 144; index += 1) literal.push(8);
  for (let index = 144; index < 256; index += 1) literal.push(9);
  for (let index = 256; index < 280; index += 1) literal.push(7);
  for (let index = 280; index < 288; index += 1) literal.push(8);
  return {
    literal: buildHuffman(literal),
    distance: buildHuffman(new Array(32).fill(5))
  };
}

function inflateZlib(input) {
  const bytes = toBytes(input);
  if (bytes.length < 6) throw new Error('压缩流内容过短');
  const cmf = bytes[0];
  const flg = bytes[1];
  if ((cmf & 0x0f) !== 8 || (cmf >> 4) > 7) throw new Error('不支持的压缩算法');
  if (((cmf << 8) + flg) % 31 !== 0) throw new Error('压缩流头部校验失败');
  if (flg & 0x20) throw new Error('不支持预设字典的压缩流');

  let pos = 2;
  let bitBuffer = 0;
  let bitCount = 0;
  let output = new Uint8Array(8192);
  let length = 0;

  function push(value) {
    if (length === output.length) {
      const bigger = new Uint8Array(output.length * 2);
      bigger.set(output);
      output = bigger;
    }
    output[length] = value;
    length += 1;
  }

  function bits(need) {
    while (bitCount < need) {
      if (pos >= bytes.length) throw new Error('压缩流意外结束');
      bitBuffer |= bytes[pos] << bitCount;
      pos += 1;
      bitCount += 8;
    }
    const value = bitBuffer & ((1 << need) - 1);
    bitBuffer >>>= need;
    bitCount -= need;
    return value;
  }

  function decodeSymbol(table) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let size = 1; size <= 15; size += 1) {
      code |= bits(1);
      const count = table.count[size];
      if (code - first < count) {
        const symbol = table.symbol[index + (code - first)];
        if (symbol === undefined) throw new Error('压缩流含无效编码');
        return symbol;
      }
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('压缩流含无效 Huffman 编码');
  }

  function dynamicTables() {
    const literalCount = bits(5) + 257;
    const distanceCount = bits(5) + 1;
    const codeLengthCount = bits(4) + 4;
    const codeLengths = new Array(19).fill(0);
    for (let index = 0; index < codeLengthCount; index += 1) codeLengths[CLEN_ORDER[index]] = bits(3);
    const codeTable = buildHuffman(codeLengths);
    const lengths = [];
    while (lengths.length < literalCount + distanceCount) {
      const symbol = decodeSymbol(codeTable);
      if (symbol < 16) {
        lengths.push(symbol);
      } else if (symbol === 16) {
        if (!lengths.length) throw new Error('压缩流长度表损坏');
        const repeat = bits(2) + 3;
        const previous = lengths[lengths.length - 1];
        for (let index = 0; index < repeat; index += 1) lengths.push(previous);
      } else if (symbol === 17) {
        const repeat = bits(3) + 3;
        for (let index = 0; index < repeat; index += 1) lengths.push(0);
      } else if (symbol === 18) {
        const repeat = bits(7) + 11;
        for (let index = 0; index < repeat; index += 1) lengths.push(0);
      } else {
        throw new Error('压缩流长度表含无效符号');
      }
    }
    return {
      literal: buildHuffman(lengths.slice(0, literalCount)),
      distance: buildHuffman(lengths.slice(literalCount))
    };
  }

  let final = 0;
  do {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuffer = 0;
      bitCount = 0;
      if (pos + 4 > bytes.length) throw new Error('压缩流存储块不完整');
      const size = bytes[pos] | (bytes[pos + 1] << 8);
      const inverse = bytes[pos + 2] | (bytes[pos + 3] << 8);
      pos += 4;
      if ((size ^ 0xffff) !== inverse) throw new Error('压缩流存储块长度校验失败');
      if (pos + size > bytes.length) throw new Error('压缩流存储块数据不完整');
      for (let index = 0; index < size; index += 1) push(bytes[pos + index]);
      pos += size;
      continue;
    }
    const tables = type === 1 ? fixedTables() : type === 2 ? dynamicTables() : null;
    if (!tables) throw new Error('压缩流含保留块类型');
    for (;;) {
      const symbol = decodeSymbol(tables.literal);
      if (symbol < 256) {
        push(symbol);
        continue;
      }
      if (symbol === 256) break;
      const lengthIndex = symbol - 257;
      if (lengthIndex >= LEN_BASE.length) throw new Error('压缩流含无效长度码');
      const runLength = LEN_BASE[lengthIndex] + bits(LEN_EXTRA[lengthIndex]);
      const distanceSymbol = decodeSymbol(tables.distance);
      if (distanceSymbol >= DIST_BASE.length) throw new Error('压缩流含无效距离码');
      const distance = DIST_BASE[distanceSymbol] + bits(DIST_EXTRA[distanceSymbol]);
      if (distance > length) throw new Error('压缩流回溯距离越界');
      for (let index = 0; index < runLength; index += 1) {
        const value = output[length - distance];
        push(value);
      }
    }
  } while (!final);

  return output.subarray(0, length);
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('文件内容不是二进制数据');
}

module.exports = { inflateZlib, toBytes };

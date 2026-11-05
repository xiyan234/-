/** 解析失败时带可识别的类型，页面据此给出具体的处理建议。 */
class PdfImportError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'PdfImportError';
    this.kind = kind;
  }
}

module.exports = { PdfImportError };

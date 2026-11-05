const { courseColorIndex } = require('../../utils/colors');
const { DAY_NAMES } = require('../../utils/constants');
const { confirmReplace } = require('../../utils/confirm');
const { loadCourses, loadSettings, saveCourses, saveSettings } = require('../../utils/storage');
const { formatWeeks } = require('../../utils/weeks');

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const ERROR_HINTS = {
  NOT_PDF: [
    '在学校课表页点「输出 PDF」保存文件，不要选截图、Word 或其它格式',
    '文件要先发到微信（发给「文件传输助手」即可），才能在这里选择'
  ],
  FILE_TOO_LARGE: ['课表 PDF 通常只有几十 KB，超过 10 MB 说明选错文件了', '请重新从课表页导出'],
  ENCRYPTED: ['这份 PDF 带密码或加密，请重新导出一份未加密的课表'],
  NO_TEXT_LAYER: ['截图和扫描件没有文字层，无法识别', '请在课表页用「输出 PDF」重新导出，不要用手机截屏'],
  UNSUPPORTED_FORMAT: [
    '目前识别学校课表页导出的表格格式课表',
    '如果学校改过导出模板，可改用课表页的「列表」格式重新导一份'
  ],
  NO_COURSES: ['请确认选的是「学生课表查询」导出的课表，不是空白页或成绩单', '导出时学年学期要选对'],
  PARSE_INCOMPLETE: ['为避免把错误课表写进去，本次已停止导入', '重新导出 PDF 再试；仍不行可以用下方「手动添加单门课程」'],
  INFLATE_FAILED: ['文件可能损坏，重新导出或重新发送一次'],
  READ_FAILED: ['把 PDF 重新发到微信再选一次', '电脑上导出的文件用「文件传输助手」发到手机即可'],
  MODULE_FAILED: [
    'PDF 解析模块没有加载成功，请在微信开发者工具点「编译」重新构建',
    '若仍失败，检查 utils/pdf/ 目录是否完整（应有 6 个 js 文件）'
  ],
  DEFAULT: ['请确认选择的是学校课表页导出的 PDF', '仍有问题可以点下方「手动添加单门课程」逐门添加']
};

function sizeText(size) {
  const value = Number(size) || 0;
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}

Page({
  data: {
    fileName: '',
    fileSizeText: '',
    loading: false,
    loadingText: '',
    error: '',
    errorHint: [],
    preview: null,
    previewTotal: 0,
    previewMore: 0,
    previewWarning: '',
    moduleStatus: '正在检查…',
    saving: false
  },

  onLoad() {
    // 解析模块按需加载：即使它出问题，页面也能正常显示并给出可诊断的提示
    try {
      const pdf = require('../../utils/pdf/index.js');
      if (!pdf || typeof pdf.parsePdfTimetable !== 'function') throw new Error('解析接口缺失');
      this.pdf = pdf;
      this.setData({ moduleStatus: '就绪' });
    } catch (error) {
      this.pdf = null;
      this.setData({ moduleStatus: '加载失败：' + ((error && error.message) || '未知错误') });
    }
  },

  openJwImport() {
    wx.redirectTo({ url: '/pages/import/index' });
  },

  choosePdf() {
    if (this.data.loading) return;
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['pdf'],
      success: (res) => {
        const file = (res.tempFiles || [])[0];
        if (!file) {
          this.fail('READ_FAILED', '没有选到文件，请重新选择一次。');
          return;
        }
        const name = file.name || '课表.pdf';
        if (!/\.pdf$/i.test(name)) {
          this.fail('NOT_PDF', '请选择 .pdf 格式的课表文件。');
          return;
        }
        if (Number(file.size) > MAX_FILE_SIZE) {
          this.fail('FILE_TOO_LARGE', '文件超过 10 MB，请重新导出课表 PDF。');
          return;
        }
        this.readAndParse(file.path || file.tempFilePath, name, file.size);
      },
      fail: (error) => {
        if (/cancel/i.test((error && error.errMsg) || '')) return;
        this.fail('READ_FAILED', '无法打开文件，请重新选择一次。');
      }
    });
  },

  readAndParse(path, name, size) {
    if (!this.pdf) {
      this.fail('MODULE_FAILED', 'PDF 解析模块没有加载成功，暂时无法导入。' + this.data.moduleStatus);
      return;
    }
    this.setData({
      loading: true,
      loadingText: '正在解析 PDF…',
      error: '',
      errorHint: [],
      preview: null,
      previewWarning: '',
      fileName: name,
      fileSizeText: sizeText(size)
    });
    wx.showLoading({ title: '正在解析…', mask: true });

    // 让 loading 先渲染一帧，再做同步解析
    setTimeout(() => {
      let buffer;
      try {
        buffer = wx.getFileSystemManager().readFileSync(path);
      } catch (error) {
        wx.hideLoading();
        this.fail('READ_FAILED', '读取文件失败，请把 PDF 重新发送到微信后再选择。');
        return;
      }

      let result;
      try {
        result = this.pdf.parsePdfTimetable(buffer);
      } catch (error) {
        wx.hideLoading();
        this.fail((error && error.kind) || 'DEFAULT', (error && error.message) || '解析失败，请换一份课表 PDF。');
        return;
      }
      wx.hideLoading();
      this.showPreview(result);
    }, 30);
  },

  fail(kind, message) {
    this.setData({
      loading: false,
      loadingText: '',
      preview: null,
      previewWarning: '',
      error: message,
      errorHint: ERROR_HINTS[kind] || ERROR_HINTS.DEFAULT
    });
  },

  showPreview(result) {
    const rows = result.rows || [];
    const settings = loadSettings();
    const totalWeeks = Math.max(Number(settings.totalWeeks) || 18, result.maxWeek || 0);

    const previewItems = rows
      .slice()
      .sort((left, right) => (left.day - right.day) || (left.startPeriod - right.startPeriod))
      .map((row) => ({
        key: `${row.name}-${row.day}-${row.startPeriod}-${row.endPeriod}`,
        name: row.name,
        color: courseColorIndex(row.name),
        meta: `${DAY_NAMES[row.day - 1]} · 第 ${row.startPeriod}–${row.endPeriod} 节 · ${formatWeeks(row.weeks).replace(/周$/, '')}周`,
        room: row.room || '',
        teacher: row.teacher || ''
      }));

    this.pendingRows = rows;
    this.pendingTotalWeeks = totalWeeks;

    this.setData({
      loading: false,
      loadingText: '',
      error: '',
      errorHint: [],
      preview: {
        items: previewItems.slice(0, 60),
        term: result.term || '课表 PDF',
        distinct: result.distinct,
        blocks: rows.length,
        totalWeeks
      },
      previewTotal: previewItems.length,
      previewMore: Math.max(0, previewItems.length - 60),
      previewWarning: (result.warnings || []).join('；')
    });
  },

  async replaceAll() {
    if (!this.pendingRows || this.data.saving) return;
    const existing = loadCourses();
    const ok = await confirmReplace({
      title: '替换现有课表？',
      name: 'PDF 导入的课程',
      count: existing.length
    });
    if (!ok) return;
    this.commit(false);
  },

  async appendToExisting() {
    if (!this.pendingRows || this.data.saving) return;
    this.commit(true);
  },

  commit(append) {
    this.setData({ saving: true });
    const rows = this.pendingRows || [];
    const totalWeeks = this.pendingTotalWeeks || 18;
    const imported = this.pdf.toCourses(rows, totalWeeks);

    let courses = imported;
    if (append) {
      const existing = loadCourses();
      const seen = new Set(existing.map((course) => [
        course.name, course.day, course.startPeriod, course.endPeriod
      ].join('|')));
      const fresh = imported.filter((course) => !seen.has([
        course.name, course.day, course.startPeriod, course.endPeriod
      ].join('|')));
      courses = existing.concat(fresh);
    }

    const settings = loadSettings();
    if (totalWeeks > (Number(settings.totalWeeks) || 18)) {
      saveSettings(Object.assign({}, settings, { totalWeeks }));
    }
    saveCourses(courses);

    this.pendingRows = null;
    this.setData({ saving: false, preview: null, previewWarning: '' });
    wx.showModal({
      title: '导入完成',
      content: append
        ? `已把 ${imported.length} 个课程时间段加入课表，当前共 ${courses.length} 个。`
        : `课表已更新为 ${courses.length} 个课程时间段。`,
      showCancel: false,
      success: () => wx.navigateBack()
    });
  },

  cancelPreview() {
    this.pendingRows = null;
    this.setData({ preview: null, previewWarning: '' });
  },

  openManual() {
    wx.navigateTo({ url: '/pages/course/edit' });
  }
});

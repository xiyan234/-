const { courseColorIndex } = require('../../utils/colors');
const { DAY_NAMES, SEMESTER_LABELS } = require('../../utils/constants');
const { confirmReplace } = require('../../utils/confirm');
const { currentTerm } = require('../../utils/jw/zfClient');
const { maxWeekOf, toCourses } = require('../../utils/jw/mapper');
const { importTimetable, getStepLog } = require('../../utils/jw/session');
const { loadCourses, loadSettings, saveCourses, saveSettings } = require('../../utils/storage');
const { formatWeeks } = require('../../utils/weeks');

const DEFAULT_ADDRESS = 'https://jwglxt.buct.edu.cn/jwglxt/xtgl/login_slogin.html';


Page({
  data: {
    address: DEFAULT_ADDRESS,
    showAdvanced: false,
    username: '',
    password: '',
    showPassword: false,
    semesterIndex: 0,
    semesterLabels: SEMESTER_LABELS,
    termLabel: '',
    loading: false,
    loadingText: '',
    error: '',
    errorKind: '',
    preview: null,
    previewTotal: 0,
    previewMore: 0,
    saving: false,
    // 失败时的分步诊断信息，直接展开就能看到卡在哪一步
    diagnostics: [],
    showDiagnostics: false
  },

  onLoad() {
    const term = currentTerm();
    this.setData({
      semesterIndex: term.semester - 1,
      termLabel: this.termText(term.semester)
    });
  },

  termText(semesterIndex) {
    const term = currentTerm();
    const semester = Number(semesterIndex) + 1;
    return `${term.xnm}-${Number(term.xnm) + 1} 学年第 ${semester} 学期`;
  },

  updateUsername(event) {
    this.setData({ username: event.detail.value, error: '' });
  },

  updatePassword(event) {
    this.setData({ password: event.detail.value, error: '' });
  },

  updateAddress(event) {
    this.setData({ address: event.detail.value, error: '' });
  },

  togglePassword() {
    this.setData({ showPassword: !this.data.showPassword });
  },

  toggleAdvanced() {
    this.setData({ showAdvanced: !this.data.showAdvanced });
  },

  toggleDiagnostics() {
    this.setData({ showDiagnostics: !this.data.showDiagnostics });
  },

  changeSemester(event) {
    const index = Number(event.detail.value);
    this.setData({ semesterIndex: index, termLabel: this.termText(index), error: '' });
  },

  async startImport() {
    if (this.data.loading) return;
    const username = String(this.data.username || '').trim();
    const password = String(this.data.password || '');
    if (!username) {
      this.setData({ error: '请填写学号', errorKind: 'VALIDATION_FAILED' });
      return;
    }
    if (!password) {
      this.setData({ error: '请填写密码', errorKind: 'VALIDATION_FAILED' });
      return;
    }

    this.setData({ loading: true, loadingText: '正在登录教务系统…', error: '', errorKind: '', preview: null });
    wx.showLoading({ title: '正在导入…', mask: true });

    let result;
    try {
      result = await importTimetable({
        address: this.data.address,
        username,
        password,
        semester: this.data.semesterIndex + 1
      });
    } catch (error) {
      result = { ok: false, kind: 'NETWORK_RETRYABLE', error: (error && error.message) || '导入失败' };
    }

    wx.hideLoading();

    if (!result || !result.ok) {
      this.setData({
        loading: false,
        loadingText: '',
        error: (result && result.error) || '导入没有完成，请稍后重试。',
        errorKind: (result && result.kind) || '',
        diagnostics: getStepLog(),
        showDiagnostics: false
      });
      return;
    }

    const rows = result.courses || [];
    const settings = loadSettings();
    const totalWeeks = Math.max(Number(settings.totalWeeks) || 18, maxWeekOf(rows));

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

    const distinct = new Set(rows.map((row) => row.name)).size;
    this.pendingRows = rows;
    this.pendingTotalWeeks = totalWeeks;

    this.setData({
      loading: false,
      loadingText: '',
      // 密码用到这里就不再需要，立刻从页面数据里清掉
      password: '',
      preview: {
        items: previewItems.slice(0, 60),
        term: (result.term && result.term.label) || '',
        distinct,
        blocks: rows.length,
        totalWeeks
      },
      previewTotal: previewItems.length,
      previewMore: Math.max(0, previewItems.length - 60)
    });
  },

  async replaceAll() {
    if (!this.pendingRows || this.data.saving) return;
    const existing = loadCourses();
    const ok = await confirmReplace({
      title: '替换现有课表？',
      name: '教务导入的课程',
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
    const imported = toCourses(rows, totalWeeks);

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
    this.setData({ saving: false, preview: null });
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
    this.setData({ preview: null });
  },

  openManual() {
    wx.navigateTo({ url: '/pages/course/edit' });
  },

  openPdfImport() {
    wx.redirectTo({ url: '/pages/pdfimport/index' });
  }
});

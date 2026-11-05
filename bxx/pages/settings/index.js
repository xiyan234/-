const { PERIOD_TIMES } = require('../../data/defaults');
const {
  loadSettings,
  loadCourses,
  resetAll,
  saveCourses,
  saveSettings
} = require('../../utils/storage');
const { confirmDelete, confirmReplace } = require('../../utils/confirm');

Page({
  data: {
    settings: {},
    totalWeekOptions: Array.from({ length: 30 }, (_, index) => index + 1),
    totalWeekIndex: 17
  },

  onLoad() {
    const settings = loadSettings();
    this.setData({
      settings,
      totalWeekIndex: Math.max(0, Number(settings.totalWeeks) - 1)
    });
  },

  updateName(event) {
    this.setData({ 'settings.timetableName': event.detail.value });
  },

  updateStartDate(event) {
    this.setData({ 'settings.semesterStartMonday': event.detail.value });
  },

  updateTotalWeeks(event) {
    const totalWeekIndex = Number(event.detail.value);
    this.setData({ totalWeekIndex, 'settings.totalWeeks': totalWeekIndex + 1 });
  },

  toggleWeekend(event) {
    this.setData({ 'settings.showWeekend': event.detail.value });
  },

  updatePeriod(event) {
    const index = Number(event.currentTarget.dataset.index);
    const field = event.currentTarget.dataset.field;
    this.setData({ [`settings.periodTimes[${index}].${field}`]: event.detail.value });
  },

  restorePeriodTimes() {
    this.setData({ 'settings.periodTimes': JSON.parse(JSON.stringify(PERIOD_TIMES)) });
    wx.showToast({ title: '已恢复默认作息', icon: 'none' });
  },

  save() {
    const settings = this.data.settings;
    if (!String(settings.timetableName || '').trim()) {
      wx.showToast({ title: '请填写课表名称', icon: 'none' });
      return;
    }
    saveSettings(settings);
    wx.showToast({ title: '设置已保存', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 400);
  },

  async resetDemo() {
    const confirmed = await confirmReplace({ title: '恢复示例课表？', name: '脱敏示例课表', count: loadCourses().length });
    if (!confirmed) return;
    resetAll();
    wx.showToast({ title: '已恢复示例课表', icon: 'success' });
    setTimeout(() => wx.reLaunch({ url: '/pages/timetable/index' }), 400);
  },

  async clearCourses() {
    const courses = loadCourses();
    const confirmed = await confirmDelete({ title: '清空全部课程？', name: '全部课程', count: courses.length, recoverable: false });
    if (!confirmed) return;
    saveCourses([]);
    wx.showToast({ title: '课程已清空', icon: 'success' });
    setTimeout(() => wx.reLaunch({ url: '/pages/timetable/index' }), 400);
  }
});


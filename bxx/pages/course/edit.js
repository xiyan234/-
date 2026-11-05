const { COURSE_COLORS, courseColorIndex } = require('../../utils/colors');
const { DAY_NAMES } = require('../../utils/constants');
const { formatWeeks } = require('../../utils/weeks');
const { loadCourses, loadSettings, saveCourses } = require('../../utils/storage');
const { confirmDelete } = require('../../utils/confirm');


Page({
  data: {
    isEditing: false,
    draft: {},
    dayNames: DAY_NAMES,
    dayIndex: 0,
    periodChoices: [],
    startIndex: 0,
    endIndex: 1,
    weekOptions: [],
    colors: COURSE_COLORS
  },

  onLoad(options) {
    this.settings = loadSettings();
    this.courses = loadCourses();
    const existing = options.id ? this.courses.find((course) => course.id === options.id) : null;
    const draft = existing
      ? JSON.parse(JSON.stringify(existing))
      : {
          id: `course-${Date.now()}`,
          name: '',
          teacher: '',
          room: '',
          day: 1,
          startPeriod: 1,
          endPeriod: 2,
          weeks: Array.from({ length: this.settings.totalWeeks }, (_, index) => index + 1),
          colorIndex: 0,
          note: ''
        };

    if (!existing) draft.colorIndex = courseColorIndex(draft.name);
    this.setData({
      isEditing: Boolean(existing),
      draft,
      dayIndex: Number(draft.day) - 1,
      periodChoices: this.settings.periodTimes.map((period) => `第 ${period.period} 节`),
      startIndex: Math.max(0, Number(draft.startPeriod) - 1),
      endIndex: Math.max(0, Number(draft.endPeriod) - 1),
      weekOptions: this.createWeekOptions(draft.weeks)
    });
    wx.setNavigationBarTitle({ title: existing ? '编辑课程' : '添加课程' });
  },

  createWeekOptions(selectedWeeks) {
    return Array.from({ length: this.settings.totalWeeks }, (_, index) => ({
      value: index + 1,
      selected: selectedWeeks.includes(index + 1)
    }));
  },

  updateField(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [`draft.${field}`]: event.detail.value });
  },

  changeDay(event) {
    const dayIndex = Number(event.detail.value);
    this.setData({ dayIndex, 'draft.day': dayIndex + 1 });
  },

  changeStart(event) {
    const startIndex = Number(event.detail.value);
    this.setData({ startIndex, 'draft.startPeriod': startIndex + 1 });
  },

  changeEnd(event) {
    const endIndex = Number(event.detail.value);
    this.setData({ endIndex, 'draft.endPeriod': endIndex + 1 });
  },

  toggleWeek(event) {
    const week = Number(event.currentTarget.dataset.week);
    const weeks = [...this.data.draft.weeks];
    const index = weeks.indexOf(week);
    if (index >= 0) weeks.splice(index, 1);
    else weeks.push(week);
    weeks.sort((left, right) => left - right);
    this.setData({ 'draft.weeks': weeks, weekOptions: this.createWeekOptions(weeks) });
  },

  selectAllWeeks() {
    const weeks = Array.from({ length: this.settings.totalWeeks }, (_, index) => index + 1);
    this.setData({ 'draft.weeks': weeks, weekOptions: this.createWeekOptions(weeks) });
  },

  clearWeeks() {
    this.setData({ 'draft.weeks': [], weekOptions: this.createWeekOptions([]) });
  },

  chooseColor(event) {
    this.setData({ 'draft.colorIndex': Number(event.currentTarget.dataset.index) });
  },

  save() {
    const draft = { ...this.data.draft, name: String(this.data.draft.name || '').trim() };
    if (!draft.name) {
      wx.showToast({ title: '请填写课程名称', icon: 'none' });
      return;
    }
    if (Number(draft.startPeriod) > Number(draft.endPeriod)) {
      wx.showToast({ title: '结束节次不能早于开始节次', icon: 'none' });
      return;
    }
    if (!draft.weeks.length) {
      wx.showToast({ title: '请至少选择一个周次', icon: 'none' });
      return;
    }

    const index = this.courses.findIndex((course) => course.id === draft.id);
    if (index >= 0) this.courses.splice(index, 1, draft);
    else this.courses.push(draft);
    saveCourses(this.courses);
    wx.showToast({ title: '已保存', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 400);
  },

  async remove() {
    const confirmed = await confirmDelete({
      title: '删除这门课程？',
      name: `${this.data.draft.name}（${formatWeeks(this.data.draft.weeks)}）`,
      count: 1,
      recoverable: false
    });
    if (!confirmed) return;
    saveCourses(this.courses.filter((course) => course.id !== this.data.draft.id));
    wx.navigateBack();
  }
});


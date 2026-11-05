const { loadHistory, loadNotes, removeAllUserData } = require('../../utils/appStore');
const { loadCourses } = require('../../utils/storage');
const { confirmDelete } = require('../../utils/confirm');

Page({
  data: { courseCount: 0, noteCount: 0, historyCount: 0 },
  onShow() {
    this.setData({ courseCount: loadCourses().length, noteCount: loadNotes().filter((item) => !item.deletedAt).length, historyCount: loadHistory().length });
  },
  openSettings() { wx.navigateTo({ url: '/pages/settings/index' }); },
  showAbout() { wx.showModal({ title: '关于百小鸮', content: '高校校园学习生活一站式智能助手\n微信小程序独立版', showCancel: false }); },
  async clearMiniData() {
    const count = this.data.noteCount + this.data.historyCount;
    const confirmed = await confirmDelete({ title: '删除小程序数据？', name: '全部记事和小鸮历史', count, recoverable: false });
    if (!confirmed) return;
    removeAllUserData();
    this.onShow();
    wx.showToast({ title: '已删除', icon: 'success' });
  }
});

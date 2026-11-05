const { loadNotes, saveNotes } = require('../../utils/appStore');

Page({
  data: { draft: { title: '', content: '', remindAt: '', done: false } },
  onLoad(options) {
    this.id = options.id || '';
    const existing = loadNotes().find((item) => item.id === this.id);
    if (existing) this.setData({ draft: existing });
    wx.setNavigationBarTitle({ title: existing ? '编辑记事' : '新建记事' });
  },
  update(event) { this.setData({ [`draft.${event.currentTarget.dataset.field}`]: event.detail.value }); },
  save() {
    const title = String(this.data.draft.title || '').trim();
    if (!title) return wx.showToast({ title: '请填写标题', icon: 'none' });
    const now = new Date().toISOString();
    const item = { ...this.data.draft, id: this.id || `note-${Date.now()}`, title, createdAt: this.data.draft.createdAt || now, updatedAt: now, deletedAt: null };
    const notes = loadNotes();
    const index = notes.findIndex((note) => note.id === item.id);
    if (index >= 0) notes.splice(index, 1, item); else notes.unshift(item);
    saveNotes(notes);
    wx.navigateBack();
  }
});

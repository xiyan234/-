const { loadNotes, saveNotes } = require('../../utils/appStore');
const { confirmDelete } = require('../../utils/confirm');

Page({
  data: { notes: [] },
  onShow() { this.setData({ notes: loadNotes().filter((item) => !item.deletedAt) }); },
  addNote() { wx.navigateTo({ url: '/pages/note/edit' }); },
  editNote(event) { wx.navigateTo({ url: `/pages/note/edit?id=${event.currentTarget.dataset.id}` }); },
  toggleDone(event) {
    const id = event.currentTarget.dataset.id;
    const notes = loadNotes().map((item) => item.id === id ? { ...item, done: !item.done, updatedAt: new Date().toISOString() } : item);
    saveNotes(notes);
    this.setData({ notes: notes.filter((item) => !item.deletedAt) });
  },
  async removeNote(event) {
    const id = event.currentTarget.dataset.id;
    const notes = loadNotes();
    const note = notes.find((item) => item.id === id);
    if (!note) return;
    const confirmed = await confirmDelete({ title: '删除这条记事？', name: note.title, count: 1, recoverable: false });
    if (!confirmed) return;
    saveNotes(notes.map((item) => item.id === id ? { ...item, deletedAt: new Date().toISOString() } : item));
    this.onShow();
  }
});

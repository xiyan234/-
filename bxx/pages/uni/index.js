const { loadHistory, saveHistory } = require('../../utils/appStore');
const { confirmDelete } = require('../../utils/confirm');
const { answer } = require('../../utils/uni');

Page({
  data: { text: '', messages: [], historyOpen: false, keyboardHint: '' },
  onShow() { this.setData({ messages: loadHistory() }); },
  updateText(event) { this.setData({ text: event.detail.value, keyboardHint: '' }); },
  send() {
    const text = String(this.data.text || '').trim();
    if (!text) return;
    const now = Date.now();
    const messages = this.data.messages.concat(
      { id: `u-${now}`, role: 'user', text, at: now },
      { id: `a-${now}`, role: 'assistant', text: answer(text, { week: 5 }), at: now + 1 }
    );
    saveHistory(messages);
    this.setData({ messages, text: '', keyboardHint: '' });
  },
  openKeyboardVoice() {
    this.setData({ keyboardHint: '已打开系统键盘，请点击键盘上的麦克风进行语音输入。' });
  },
  showHistory() { this.setData({ historyOpen: true }); },
  hideHistory() { this.setData({ historyOpen: false }); },
  noop() {},
  async clearHistory() {
    const count = this.data.messages.length;
    const confirmed = await confirmDelete({ title: '清空对话历史？', name: '小鸮对话历史', count, recoverable: false });
    if (!confirmed) return;
    saveHistory([]);
    this.setData({ messages: [], historyOpen: false });
  }
});

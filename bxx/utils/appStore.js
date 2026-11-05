const NOTES_KEY = 'baixiaoxiao.notes.v1';
const HISTORY_KEY = 'baixiaoxiao.xiao.history.v1';

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function read(key, fallback) {
  try {
    const value = wx.getStorageSync(key);
    return value === '' || value === undefined || value === null ? clone(fallback) : value;
  } catch (_) {
    return clone(fallback);
  }
}

function write(key, value) {
  wx.setStorageSync(key, clone(value));
  return value;
}

function loadNotes() {
  const value = read(NOTES_KEY, []);
  return Array.isArray(value) ? value : [];
}

function saveNotes(notes) { return write(NOTES_KEY, notes); }

function loadHistory() {
  const value = read(HISTORY_KEY, []);
  return Array.isArray(value) ? value : [];
}

function saveHistory(messages) { return write(HISTORY_KEY, messages.slice(-100)); }

function removeAllUserData() {
  wx.removeStorageSync(NOTES_KEY);
  wx.removeStorageSync(HISTORY_KEY);
}

module.exports = { HISTORY_KEY, NOTES_KEY, loadHistory, loadNotes, removeAllUserData, saveHistory, saveNotes };

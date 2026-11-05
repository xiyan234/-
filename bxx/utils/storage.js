const { defaultCourses, defaultSettings } = require('../data/defaults');

const SETTINGS_KEY = 'timetable.settings.v1';
const COURSES_KEY = 'timetable.courses.v1';

function getStorage(key, fallback) {
  try {
    const value = wx.getStorageSync(key);
    return value && typeof value === 'object' ? value : fallback;
  } catch (error) {
    return fallback;
  }
}

function loadSettings() {
  return { ...defaultSettings(), ...getStorage(SETTINGS_KEY, {}) };
}

function loadCourses() {
  const stored = getStorage(COURSES_KEY, null);
  if (Array.isArray(stored)) return stored;
  const demo = defaultCourses();
  saveCourses(demo);
  return demo;
}

function saveSettings(settings) {
  wx.setStorageSync(SETTINGS_KEY, settings);
}

function saveCourses(courses) {
  wx.setStorageSync(COURSES_KEY, courses);
}

function resetAll() {
  const settings = defaultSettings();
  const courses = defaultCourses();
  saveSettings(settings);
  saveCourses(courses);
  return { settings, courses };
}

module.exports = { loadCourses, loadSettings, resetAll, saveCourses, saveSettings };

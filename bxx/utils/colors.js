const COURSE_COLORS = [
  '#2E5AAC', '#E8624C', '#3FA97B', '#8E6BC9', '#D58B25', '#2F9DB5',
  '#C9547E', '#6B8F3F', '#5A6EE8', '#A8672D', '#3F8F82', '#825690',
  '#B23A2E', '#2F6B4F', '#3B4A6B', '#7A4E2C', '#5E3A87', '#276B7A'
];

function normalizeName(name) {
  return String(name || '').replace(/\s+/g, '');
}

function courseColorIndex(name) {
  const key = normalizeName(name);
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash % COURSE_COLORS.length;
}

function assignCourseColors(names) {
  const unique = Array.from(new Set((names || []).map(normalizeName).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, 'zh'));
  const output = {};
  const used = new Set();

  unique.forEach((name) => {
    const base = courseColorIndex(name);
    let selected = base;
    for (let offset = 0; offset < COURSE_COLORS.length; offset += 1) {
      const candidate = (base + offset) % COURSE_COLORS.length;
      if (!used.has(candidate)) {
        selected = candidate;
        break;
      }
    }
    used.add(selected);
    output[name] = selected;
  });

  return output;
}

module.exports = { COURSE_COLORS, assignCourseColors, courseColorIndex, normalizeName };


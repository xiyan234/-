function range(from, to) {
  const output = [];
  for (let value = from; value <= to; value += 1) output.push(value);
  return output;
}

function parseWeeks(input, totalWeeks = 20) {
  const max = Math.max(1, Number(totalWeeks) || 20);
  const text = String(input || '')
    .replace(/[第周]/g, '')
    .replace(/[，、；;]/g, ',')
    .replace(/[—–~至]/g, '-');
  const values = new Set();

  text.split(',').forEach((part) => {
    const token = part.trim();
    if (!token) return;
    const match = token.match(/^(\d+)(?:-(\d+))?\s*(单|双)?$/);
    if (!match) return;
    const start = Math.max(1, Number(match[1]));
    const end = Math.min(max, Number(match[2] || match[1]));
    const parity = match[3];
    range(Math.min(start, end), Math.max(start, end)).forEach((week) => {
      if (week > max) return;
      if (parity === '单' && week % 2 === 0) return;
      if (parity === '双' && week % 2 !== 0) return;
      values.add(week);
    });
  });

  return Array.from(values).sort((left, right) => left - right);
}

function formatWeeks(weeks) {
  const values = Array.from(new Set((weeks || []).map(Number).filter((value) => value > 0)))
    .sort((left, right) => left - right);
  if (!values.length) return '未设置';
  const ranges = [];
  let start = values[0];
  let previous = values[0];
  for (let index = 1; index <= values.length; index += 1) {
    const value = values[index];
    if (value === previous + 1) {
      previous = value;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    start = value;
    previous = value;
  }
  return `${ranges.join('、')}周`;
}

module.exports = { formatWeeks, parseWeeks };


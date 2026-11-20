function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function toArray(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function csvList(v) {
  return String(v || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

function numOrNull(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function intParam(v) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw httpError(404, 'Not found');
  return n;
}

function toCsv(rows, columns) {
  const esc = (v) => {
    if (v == null) return '';
    if (v instanceof Date) v = v.toISOString();
    if (typeof v === 'object') v = JSON.stringify(v);
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // avoid spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols = columns || (rows[0] ? Object.keys(rows[0]) : []);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

module.exports = { httpError, flash, toArray, csvList, numOrNull, intParam, toCsv };

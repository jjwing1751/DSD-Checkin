const { VISIT_TYPES, ROLES, WORK_TYPES, DAYS, COVERAGE_TYPES } = require('./constants');

function fmtTime(ts, tz) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/Chicago' });
}
function fmtDateTime(ts, tz) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/Chicago' });
}
function fmtDate(d) {
  if (!d) return '';
  const s = typeof d === 'string' ? d : new Date(d).toISOString().slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function fmtClock(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ampm}`;
}
function money(n) {
  if (n == null) return '';
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function minutesBetween(a, b) {
  if (!a) return null;
  return Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 60000);
}
function dwell(mins) {
  if (mins == null) return '';
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${mins % 60}m` : `${mins}m`;
}
const STATUS_LABELS = {
  pending_approval: 'Waiting for receiver', blocked: 'Blocked', checked_in: 'In store', checked_out: 'Checked out',
  auto_closed: 'No check-out', denied: 'Denied', cancelled: 'Cancelled',
  expected: 'Expected', confirmed: 'Confirmed', moved: 'Moved', missed: 'Missed', completed: 'Completed',
  pending_company: 'Waiting for company approval', pending_identity: 'Needs identity verification', identity_review: 'Identity in review',
  active: 'Active', suspended: 'Suspended', removed: 'Removed', pending: 'Pending', submitted: 'Submitted', verified: 'Verified', rejected: 'Rejected',
};
const statusLabel = (s) => STATUS_LABELS[s] || s;

module.exports = { VISIT_TYPES, ROLES, WORK_TYPES, DAYS, COVERAGE_TYPES, fmtTime, fmtDateTime, fmtDate, fmtClock, money, minutesBetween, dwell, statusLabel };

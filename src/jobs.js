// Background jobs: expected-visit generation, missed visits, auto-close, overstays,
// expiry reminders and the 18-month retention purge. Runs inside the web process
// every 15 minutes (guarded by an advisory lock), or once via `npm run jobs`.
const db = require('./db');
const alerts = require('./alerts');

async function generateExpectedVisits() {
  const r = await db.q(`
    INSERT INTO expected_visits(agreement_id, store_id, vendor_company_id, visit_type, visit_date, window_start, window_end, expected_dwell_min)
    SELECT a.id, a.store_id, a.vendor_company_id, a.visit_type, d::date, a.window_start, a.window_end, a.expected_dwell_min
      FROM service_agreements a
      JOIN stores s ON s.id = a.store_id AND s.active
      JOIN vendor_companies v ON v.id = a.vendor_company_id AND v.status <> 'suspended'
      CROSS JOIN LATERAL generate_series((now() AT TIME ZONE s.timezone)::date,
                                         (now() AT TIME ZONE s.timezone)::date + 13, interval '1 day') AS d
     WHERE a.active
       AND extract(dow FROM d)::int = ANY(a.days_of_week)
       AND d::date >= a.effective_from
       AND (a.effective_to IS NULL OR d::date <= a.effective_to)
    ON CONFLICT (agreement_id, visit_date) DO NOTHING`);
  return r.rowCount;
}

async function markMissedVisits() {
  const rows = await db.many(`
    UPDATE expected_visits e SET status = 'missed'
      FROM stores s, vendor_companies v
     WHERE s.id = e.store_id AND v.id = e.vendor_company_id
       AND e.status IN ('expected','confirmed','moved') AND e.visit_id IS NULL
       AND ((e.visit_date + e.window_end) AT TIME ZONE s.timezone) < now()
    RETURNING e.id, e.store_id, e.vendor_company_id, e.visit_date, s.name AS store_name, v.name AS vendor_name`);
  for (const e of rows) {
    await alerts.raise({
      kind: 'missed_visit', severity: 'warning', storeId: e.store_id, vendorCompanyId: e.vendor_company_id,
      audience: ['store_manager', 'vendor_admin', 'merchant'],
      message: `Missed visit: ${e.vendor_name} did not check in at ${e.store_name} on ${e.visit_date}.`,
      dedupeKey: `missed:${e.id}`,
    });
  }
  return rows.length;
}

async function autoCloseVisits() {
  // Visits still open after store close are closed and flagged "no check-out" (excluded from dwell).
  const closed = await db.many(`
    WITH c AS (
      SELECT v.id, s.timezone, s.store_close,
             (((v.check_in_at AT TIME ZONE s.timezone)::date + s.store_close) AT TIME ZONE s.timezone) AS close_at
        FROM visits v JOIN stores s ON s.id = v.store_id
       WHERE v.status = 'checked_in')
    UPDATE visits v SET status = 'auto_closed',
           check_out_at = CASE WHEN c.close_at > v.check_in_at THEN c.close_at ELSE c.close_at + interval '1 day' END
      FROM c
     WHERE v.id = c.id
       AND now() > CASE WHEN c.close_at > v.check_in_at THEN c.close_at ELSE c.close_at + interval '1 day' END
    RETURNING v.id, v.store_id, v.vendor_company_id`);
  for (const v of closed) {
    await alerts.raise({
      kind: 'no_checkout', severity: 'info', storeId: v.store_id, vendorCompanyId: v.vendor_company_id, visitId: v.id,
      audience: ['store_manager'], message: `Visit #${v.id} was auto-closed at store close with no check-out.`, dedupeKey: `noco:${v.id}`,
    });
  }
  // Pending approvals nobody acted on for 4 hours are cancelled.
  await db.q(`UPDATE visits SET status = 'cancelled' WHERE status IN ('pending_approval','blocked') AND requested_at < now() - interval '4 hours'`);
  return closed.length;
}

async function overstayAlerts() {
  const margin = await db.one(`SELECT value FROM settings WHERE key = 'overstay_margin_min'`);
  const rows = await db.many(`
    SELECT v.id, v.store_id, v.vendor_company_id, u.name AS rep_name, c.name AS vendor_name
      FROM visits v JOIN users u ON u.id = v.user_id LEFT JOIN vendor_companies c ON c.id = v.vendor_company_id
     WHERE v.status = 'checked_in' AND v.expected_out_at IS NOT NULL
       AND v.expected_out_at + make_interval(mins => $1) < now()`, [Number(margin ? margin.value : 30)]);
  for (const v of rows) {
    await alerts.raise({
      kind: 'overstay', severity: 'warning', storeId: v.store_id, vendorCompanyId: v.vendor_company_id, visitId: v.id,
      audience: ['store_manager', 'receiver'], message: `Overstay: ${v.rep_name || 'Rep'} (${v.vendor_name || 'visitor'}) is past expected check-out.`,
      dedupeKey: `overstay:${v.id}`,
    });
  }
}

async function expiryReminders() {
  const policies = await db.many(`
    SELECT p.id, p.coverage_type, p.expiry_date, p.vendor_company_id, c.name AS vendor_name, (p.expiry_date - current_date) AS days_left
      FROM insurance_policies p JOIN vendor_companies c ON c.id = p.vendor_company_id
     WHERE p.status = 'verified' AND p.expiry_date - current_date <= 30 AND p.expiry_date >= current_date - 1`);
  for (const p of policies) {
    const bucket = p.days_left < 0 ? 'lapsed' : p.days_left <= 7 ? '7' : '30';
    const message = bucket === 'lapsed'
      ? `Insurance lapsed: ${p.vendor_name} ${p.coverage_type} expired ${p.expiry_date}. Reps are blocked until a new COI is verified or an override is granted.`
      : `Insurance expiring: ${p.vendor_name} ${p.coverage_type} expires ${p.expiry_date} (${p.days_left} days).`;
    const emails = await alerts.emailsFor({ roles: ['dsd_ops'], vendorCompanyId: p.vendor_company_id, vendorAdminsOnly: true });
    await alerts.raise({
      kind: 'insurance_expiring', severity: bucket === 'lapsed' ? 'critical' : 'warning', vendorCompanyId: p.vendor_company_id,
      audience: ['dsd_ops', 'vendor_admin', 'merchant'], message, dedupeKey: `ins:${p.id}:${bucket}`, email: emails,
    });
  }
  const creds = await db.many(`
    SELECT cr.id, cr.expires_on, cr.user_id, cr.vendor_company_id, t.name, (cr.expires_on - current_date) AS days_left,
           coalesce(u.vendor_company_id, cr.vendor_company_id) AS company_id, u.email AS user_email, coalesce(u.name, c.name) AS holder
      FROM credentials cr JOIN credential_types t ON t.id = cr.credential_type_id
      LEFT JOIN users u ON u.id = cr.user_id LEFT JOIN vendor_companies c ON c.id = cr.vendor_company_id
     WHERE cr.status = 'verified' AND cr.expires_on IS NOT NULL
       AND cr.expires_on - current_date <= 30 AND cr.expires_on >= current_date`);
  for (const c of creds) {
    const bucket = c.days_left <= 7 ? '7' : '30';
    const emails = await alerts.emailsFor({ roles: [], vendorCompanyId: c.company_id, vendorAdminsOnly: true });
    if (c.user_email) emails.push(c.user_email);
    await alerts.raise({
      kind: 'credential_expiring', severity: 'warning', vendorCompanyId: c.company_id, userId: c.user_id,
      audience: ['vendor_admin', 'dsd_ops'], message: `Credential expiring: ${c.name} for ${c.holder} expires ${c.expires_on} (${c.days_left} days).`,
      dedupeKey: `cred:${c.id}:${bucket}`, email: emails,
    });
  }
}

async function retentionPurge() {
  const s = await db.one(`SELECT value FROM settings WHERE key = 'retention_months'`);
  const months = Number(s ? s.value : 18);
  await db.tx(async (c) => {
    await c.query(`SELECT set_config('app.retention_purge', 'on', true)`);
    await c.query(`DELETE FROM expected_visits WHERE visit_date < (current_date - make_interval(months => $1))`, [months]);
    await c.query(`DELETE FROM alerts WHERE created_at < now() - make_interval(months => $1)`, [months]);
    await c.query(`DELETE FROM visits WHERE requested_at < now() - make_interval(months => $1)`, [months]);
    await c.query(`DELETE FROM audit_events WHERE at < now() - make_interval(months => $1)`, [months]);
    await c.query(`DELETE FROM login_codes WHERE created_at < now() - interval '1 day'`);
  });
}

async function runAll() {
  const client = await db.pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(777001) AS ok')).rows[0].ok;
    if (!locked) return;
    await generateExpectedVisits();
    await markMissedVisits();
    await autoCloseVisits();
    await overstayAlerts();
    await expiryReminders();
    await retentionPurge();
  } catch (e) {
    console.error('jobs failed', e);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(777001)').catch(() => {});
    client.release();
  }
}

function startScheduler() {
  const every = Number(process.env.JOBS_INTERVAL_MIN || 15) * 60 * 1000;
  setTimeout(runAll, 5000);
  setInterval(runAll, every).unref();
}

module.exports = { runAll, startScheduler, generateExpectedVisits, markMissedVisits, autoCloseVisits, retentionPurge };

if (require.main === module) {
  runAll().then(() => db.pool.end());
}

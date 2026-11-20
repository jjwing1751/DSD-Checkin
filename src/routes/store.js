// Store dashboard for receivers and store managers: in store now, approvals, arrivals, roster, history.
const express = require('express');
const db = require('../db');
const alerts = require('../alerts');
const { audit } = require('../audit');
const { requireRole, canSeeStore } = require('../auth');
const { flash, intParam, httpError, toCsv } = require('../util');

const router = express.Router();
const staff = requireRole('receiver', 'store_manager', 'dsd_ops', 'merchant');

async function loadStore(req) {
  const id = intParam(req.params.id);
  if (!canSeeStore(req.user, id)) throw httpError(403, 'You can only see your own store.');
  const s = await db.one('SELECT * FROM stores WHERE id = $1', [id]);
  if (!s) throw httpError(404, 'Store not found');
  return s;
}

const VISIT_SELECT = `
  SELECT v.*, u.name AS rep_name, u.email AS rep_email, u.phone AS rep_phone, u.role AS rep_role, (u.selfie IS NOT NULL) AS has_selfie,
         c.name AS company_name, a.name AS approved_by_name, o.name AS override_by_name
    FROM visits v JOIN users u ON u.id = v.user_id
    LEFT JOIN vendor_companies c ON c.id = v.vendor_company_id
    LEFT JOIN users a ON a.id = v.approved_by
    LEFT JOIN users o ON o.id = v.override_by`;

router.get('/stores', requireRole('dsd_ops', 'merchant', 'receiver', 'store_manager'), async (req, res) => {
  if (['receiver', 'store_manager'].includes(req.user.role) && req.user.store_id) return res.redirect(`/store/${req.user.store_id}`);
  const stores = await db.many(`
    SELECT s.*,
      (SELECT count(*) FROM visits v WHERE v.store_id = s.id AND v.status = 'checked_in')::int AS in_store,
      (SELECT count(*) FROM visits v WHERE v.store_id = s.id AND v.status IN ('pending_approval','blocked'))::int AS waiting,
      (SELECT count(*) FROM expected_visits e WHERE e.store_id = s.id AND e.visit_date = (now() AT TIME ZONE s.timezone)::date
          AND e.status IN ('expected','confirmed','moved'))::int AS expected_today
      FROM stores s WHERE s.active ORDER BY s.store_number`);
  res.render('store/list', { title: 'Stores', stores });
});

router.get('/store/:id', staff, async (req, res) => {
  const store = await loadStore(req);
  const waiting = await db.many(`${VISIT_SELECT} WHERE v.store_id = $1 AND v.status IN ('pending_approval','blocked') ORDER BY v.requested_at`, [store.id]);
  const inStore = await db.many(`${VISIT_SELECT} WHERE v.store_id = $1 AND v.status = 'checked_in' ORDER BY v.check_in_at`, [store.id]);
  const arrivals = await db.many(`
    SELECT e.*, c.name AS company_name, u.name AS announced_by_name, v.status AS visit_status, v.check_in_at
      FROM expected_visits e JOIN vendor_companies c ON c.id = e.vendor_company_id
      LEFT JOIN users u ON u.id = e.announced_by LEFT JOIN visits v ON v.id = e.visit_id
     WHERE e.store_id = $1 AND e.visit_date = (now() AT TIME ZONE $2)::date
     ORDER BY e.window_start, c.name`, [store.id, store.timezone]);
  const doneToday = await db.many(`${VISIT_SELECT} WHERE v.store_id = $1 AND v.status IN ('checked_out','auto_closed','denied')
      AND (v.requested_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date ORDER BY v.check_out_at DESC NULLS LAST`, [store.id, store.timezone]);
  const storeAlerts = await db.many(`SELECT * FROM alerts WHERE store_id = $1 AND dismissed_at IS NULL AND created_at > now() - interval '2 days'
      ORDER BY created_at DESC LIMIT 20`, [store.id]);
  // Hourly load vs backdoor capacity.
  const load = {};
  for (const a of arrivals) {
    if (a.status === 'cancelled') continue;
    const h = Number(String(a.window_start).slice(0, 2));
    load[h] = (load[h] || 0) + 1;
  }
  res.render('store/dashboard', { title: store.name, store, waiting, inStore, arrivals, doneToday, storeAlerts, load, autoRefresh: true });
});

async function loadVisit(store, vid) {
  const v = await db.one(`${VISIT_SELECT} WHERE v.id = $1 AND v.store_id = $2`, [intParam(vid), store.id]);
  if (!v) throw httpError(404, 'Visit not found');
  return v;
}

async function markExpectedComplete(c, v) {
  if (v.expected_visit_id) await c.query(`UPDATE expected_visits SET status = 'completed' WHERE id = $1`, [v.expected_visit_id]);
}

// Receiver approves a soft-fail check-in (e.g. location not confirmed, soft credential missing).
router.post('/store/:id/visits/:vid/approve', requireRole('receiver', 'store_manager', 'dsd_ops'), async (req, res) => {
  const store = await loadStore(req);
  const v = await loadVisit(store, req.params.vid);
  if (v.status !== 'pending_approval') throw httpError(400, 'This visit is not waiting for approval');
  const reason = String(req.body.reason || '').trim();
  if (v.soft_failures.length && !reason) {
    flash(req, 'error', 'Enter a reason to approve a check-in with warnings.');
    return res.redirect(`/store/${store.id}`);
  }
  await db.tx(async (c) => {
    const dwell = v.expected_visit_id ? (await c.query('SELECT expected_dwell_min FROM expected_visits WHERE id = $1', [v.expected_visit_id])).rows[0].expected_dwell_min : 60;
    const r = await c.query(
      `UPDATE visits SET status = 'checked_in', check_in_at = now(), expected_out_at = now() + make_interval(mins => $3),
              approved_by = $2, approved_at = now(), acknowledged_by = $2, acknowledged_at = now(),
              override_reason = nullif($4,''), override_by = CASE WHEN $4 <> '' THEN $2::int END, override_scope = CASE WHEN $4 <> '' THEN 'soft' END,
              method = CASE WHEN location_ok THEN method ELSE 'manual' END
        WHERE id = $1 RETURNING *`, [v.id, req.user.id, dwell || 60, reason]);
    await markExpectedComplete(c, v);
    await audit(req, { action: 'visit.approved', entity: 'visit', entityId: v.id, storeId: store.id, before: v, after: r.rows[0] }, c);
  });
  if (reason) {
    await alerts.raise({ kind: 'override', severity: 'warning', storeId: store.id, vendorCompanyId: v.vendor_company_id, visitId: v.id,
      audience: ['store_manager', 'dsd_ops'], message: `Override at ${store.name}: ${v.rep_name} admitted despite ${v.soft_failures.join('; ')}. Reason: ${reason}`,
      dedupeKey: `ovr:${v.id}` });
  }
  flash(req, 'success', `${v.rep_name} is checked in.`);
  res.redirect(`/store/${store.id}`);
});

// Store manager overrides an insurance block for this one visit.
router.post('/store/:id/visits/:vid/override', requireRole('store_manager', 'dsd_ops'), async (req, res) => {
  const store = await loadStore(req);
  const v = await loadVisit(store, req.params.vid);
  if (v.status !== 'blocked') throw httpError(400, 'This visit is not blocked');
  const nonInsurance = v.hard_failures.filter((f) => !f.startsWith('Insurance:'));
  if (nonInsurance.length) throw httpError(400, `This block cannot be overridden at the store: ${nonInsurance.join('; ')}`);
  const reason = String(req.body.reason || '').trim();
  if (!reason) {
    flash(req, 'error', 'A reason is required to override an insurance block.');
    return res.redirect(`/store/${store.id}`);
  }
  await db.tx(async (c) => {
    const dwell = v.expected_visit_id ? (await c.query('SELECT expected_dwell_min FROM expected_visits WHERE id = $1', [v.expected_visit_id])).rows[0].expected_dwell_min : 60;
    const ins = { ...v.insurance_status, override: { scope: 'visit', reason, approved_by: req.user.name || req.user.email, expires_at: 'end of visit' } };
    const r = await c.query(
      `UPDATE visits SET status = CASE WHEN cardinality(soft_failures) > 0 THEN 'pending_approval' ELSE 'checked_in' END,
              check_in_at = CASE WHEN cardinality(soft_failures) > 0 THEN NULL ELSE now() END,
              expected_out_at = CASE WHEN cardinality(soft_failures) > 0 THEN NULL ELSE now() + make_interval(mins => $3) END,
              override_reason = $4, override_by = $2, override_scope = 'visit_insurance', insurance_status = $5,
              approved_by = $2, approved_at = now(), acknowledged_by = $2, acknowledged_at = now()
        WHERE id = $1 RETURNING *`, [v.id, req.user.id, dwell || 60, reason, JSON.stringify(ins)]);
    if (r.rows[0].status === 'checked_in') await markExpectedComplete(c, v);
    await audit(req, { action: 'visit.insurance_override', entity: 'visit', entityId: v.id, storeId: store.id, before: v, after: r.rows[0] }, c);
  });
  await alerts.raise({ kind: 'insurance_override', severity: 'critical', storeId: store.id, vendorCompanyId: v.vendor_company_id, visitId: v.id,
    audience: ['dsd_ops', 'store_manager'], message: `Insurance override at ${store.name} for ${v.rep_name} (${v.company_name}). Reason: ${reason}`,
    dedupeKey: `insovr:${v.id}`, email: await alerts.emailsFor({ roles: ['dsd_ops'] }) });
  flash(req, 'success', 'Insurance override recorded. DSD ops has been alerted.');
  res.redirect(`/store/${store.id}`);
});

router.post('/store/:id/visits/:vid/deny', requireRole('receiver', 'store_manager', 'dsd_ops'), async (req, res) => {
  const store = await loadStore(req);
  const v = await loadVisit(store, req.params.vid);
  if (!['pending_approval', 'blocked'].includes(v.status)) throw httpError(400, 'This visit is not waiting');
  const r = await db.one(`UPDATE visits SET status = 'denied', receiver_note = nullif($3,''), approved_by = $2, approved_at = now() WHERE id = $1 RETURNING *`,
    [v.id, req.user.id, String(req.body.reason || '').slice(0, 500)]);
  await db.q('UPDATE expected_visits SET visit_id = NULL WHERE visit_id = $1', [v.id]);
  await audit(req, { action: 'visit.denied', entity: 'visit', entityId: v.id, storeId: store.id, before: v, after: r });
  flash(req, 'success', 'Check-in denied.');
  res.redirect(`/store/${store.id}`);
});

router.post('/store/:id/visits/:vid/ack', requireRole('receiver', 'store_manager', 'dsd_ops'), async (req, res) => {
  const store = await loadStore(req);
  const v = await loadVisit(store, req.params.vid);
  await db.q('UPDATE visits SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND acknowledged_at IS NULL', [v.id, req.user.id]);
  await audit(req, { action: 'visit.acknowledged', entity: 'visit', entityId: v.id, storeId: store.id });
  res.redirect(`/store/${store.id}`);
});

// Receiver checks someone out (rep forgot) and can confirm delivery or flag a discrepancy.
router.post('/store/:id/visits/:vid/checkout', requireRole('receiver', 'store_manager', 'dsd_ops'), async (req, res) => {
  const store = await loadStore(req);
  const v = await loadVisit(store, req.params.vid);
  if (v.status !== 'checked_in') throw httpError(400, 'Not checked in');
  const r = await db.one(
    `UPDATE visits SET status = 'checked_out', check_out_at = now(), checked_out_by = $2, receiver_note = nullif($3,''), discrepancy = $4
      WHERE id = $1 RETURNING *`, [v.id, req.user.id, String(req.body.note || '').slice(0, 500), req.body.discrepancy === 'on']);
  await audit(req, { action: 'visit.checked_out_by_store', entity: 'visit', entityId: v.id, storeId: store.id, before: v, after: r });
  res.redirect(`/store/${store.id}`);
});

// Receiver notes on a visit already checked out (confirm delivery / discrepancy).
router.post('/store/:id/visits/:vid/note', requireRole('receiver', 'store_manager', 'dsd_ops'), async (req, res) => {
  const store = await loadStore(req);
  const v = await loadVisit(store, req.params.vid);
  const r = await db.one(`UPDATE visits SET receiver_note = nullif($2,''), discrepancy = $3 WHERE id = $1 RETURNING *`,
    [v.id, String(req.body.note || '').slice(0, 500), req.body.discrepancy === 'on']);
  await audit(req, { action: 'visit.receiver_note', entity: 'visit', entityId: v.id, storeId: store.id, before: v, after: r });
  res.redirect(`/store/${store.id}/visits/${v.id}`);
});

router.get('/store/:id/visits/:vid', staff, async (req, res) => {
  const store = await loadStore(req);
  const v = await loadVisit(store, req.params.vid);
  const work = await db.many('SELECT * FROM work_items WHERE visit_id = $1', [v.id]);
  const photos = await db.many('SELECT id FROM visit_photos WHERE visit_id = $1', [v.id]);
  const events = await db.many(`SELECT * FROM audit_events WHERE entity = 'visit' AND entity_id = $1 ORDER BY at`, [String(v.id)]);
  res.render('store/visit', { title: `Visit #${v.id}`, store, v, work, photos, events });
});

// One-tap evacuation roster.
router.get('/store/:id/roster', staff, async (req, res) => {
  const store = await loadStore(req);
  const inStore = await db.many(`${VISIT_SELECT} WHERE v.store_id = $1 AND v.status = 'checked_in' ORDER BY c.name, u.name`, [store.id]);
  res.render('store/roster', { title: `Roster: ${store.name}`, store, inStore, layout: 'print' });
});

router.get('/store/:id/history', staff, async (req, res) => {
  const store = await loadStore(req);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
  const rows = await db.many(`${VISIT_SELECT}
     WHERE v.store_id = $1
       AND (v.requested_at AT TIME ZONE $2)::date >= coalesce($3::date, (now() AT TIME ZONE $2)::date - 7)
       AND (v.requested_at AT TIME ZONE $2)::date <= coalesce($4::date, (now() AT TIME ZONE $2)::date)
     ORDER BY v.requested_at DESC LIMIT 2000`, [store.id, store.timezone, from, to]);
  if (req.query.format === 'csv') {
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="store-${store.store_number}-visits.csv"`);
    return res.send(toCsv(rows.map((v) => ({
      visit_id: v.id, rep: v.rep_name, rep_email: v.rep_email, company: v.company_name, visit_type: v.visit_type, source: v.source,
      status: v.status, method: v.method, requested_at: v.requested_at, check_in_at: v.check_in_at, check_out_at: v.check_out_at,
      dwell_min: v.check_in_at && v.check_out_at && v.status === 'checked_out' ? Math.round((v.check_out_at - v.check_in_at) / 60000) : '',
      hard_failures: v.hard_failures.join('; '), soft_failures: v.soft_failures.join('; '), override_reason: v.override_reason,
      override_by: v.override_by_name, insurance_compliant: v.insurance_status && v.insurance_status.compliant,
      discrepancy: v.discrepancy, receiver_note: v.receiver_note,
    }))));
  }
  res.render('store/history', { title: `History: ${store.name}`, store, rows, from: from || '', to: to || '' });
});

router.post('/store/:id/alerts/:aid/dismiss', staff, async (req, res) => {
  const store = await loadStore(req);
  await db.q('UPDATE alerts SET dismissed_at = now(), dismissed_by = $3 WHERE id = $1 AND store_id = $2', [intParam(req.params.aid), store.id, req.user.id]);
  res.redirect(`/store/${store.id}`);
});

// Store managers set receiving hours and backdoor capacity.
router.post('/store/:id/settings', requireRole('store_manager', 'dsd_ops'), async (req, res) => {
  const store = await loadStore(req);
  const t = (v, d) => (/^\d{2}:\d{2}$/.test(v || '') ? v : d);
  const r = await db.one(
    `UPDATE stores SET receiving_open = $2, receiving_close = $3, store_close = $4, capacity_per_hour = $5 WHERE id = $1 RETURNING *`,
    [store.id, t(req.body.receiving_open, store.receiving_open), t(req.body.receiving_close, store.receiving_close),
      t(req.body.store_close, store.store_close), Math.max(1, Number(req.body.capacity_per_hour) || store.capacity_per_hour)]);
  await audit(req, { action: 'store.hours_updated', entity: 'store', entityId: store.id, storeId: store.id, before: store, after: r });
  flash(req, 'success', 'Store settings saved.');
  res.redirect(`/store/${store.id}`);
});

module.exports = router;

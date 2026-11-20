// Backdoor QR check-in, digital visitor pass, and check-out with work proof.
const express = require('express');
const db = require('../db');
const alerts = require('../alerts');
const upload = require('../upload');
const { audit } = require('../audit');
const { requireLogin, requireRole, verifyCsrf, homePath } = require('../auth');
const { evaluateCheckIn } = require('../checks');
const { flash, intParam, httpError, toArray } = require('../util');
const { VISIT_TYPES, VENDOR_ROLES, WORK_TYPES } = require('../constants');

const router = express.Router();
const repOnly = requireRole('rep', 'field_service', 'visitor');

async function storeByToken(token) {
  const s = await db.one('SELECT * FROM stores WHERE qr_token = $1 AND active', [String(token)]);
  if (!s) throw httpError(404, 'This QR code is not recognized. Ask the receiver for help.');
  return s;
}

async function matchExpected(store, companyId) {
  if (!companyId) return [];
  return db.many(
    `SELECT e.* FROM expected_visits e
      WHERE e.store_id = $1 AND e.vendor_company_id = $2 AND e.visit_id IS NULL
        AND e.status IN ('expected','confirmed','moved','missed')
        AND e.visit_date = (now() AT TIME ZONE $3)::date
      ORDER BY abs(extract(epoch FROM (e.window_start - (now() AT TIME ZONE $3)::time))) LIMIT 5`,
    [store.id, companyId, store.timezone]
  );
}

// The URL printed on the backdoor poster.
router.get('/s/:token', requireLogin, async (req, res) => {
  const store = await storeByToken(req.params.token);
  const me = req.user;
  if (!VENDOR_ROLES.includes(me.role)) {
    if (me.role === 'admin' || me.store_id === store.id || ['dsd_ops', 'merchant'].includes(me.role)) return res.redirect(`/store/${store.id}`);
    return res.redirect(homePath(me));
  }
  const open = await db.one(
    `SELECT id FROM visits WHERE user_id = $1 AND status = 'checked_in' ORDER BY requested_at DESC LIMIT 1`, [me.id]);
  if (open) return res.redirect(`/visit/${open.id}`);
  if (me.status === 'pending_identity') {
    req.session.afterIdentity = req.originalUrl;
    flash(req, 'warning', 'Verify your identity before your first check-in.');
    return res.redirect('/rep/identity');
  }
  const expected = await matchExpected(store, me.vendor_company_id);
  const company = me.vendor_company_id ? await db.one('SELECT name, status FROM vendor_companies WHERE id = $1', [me.vendor_company_id]) : null;
  const defaultType = expected[0] ? expected[0].visit_type : me.role === 'field_service' ? 'field_service' : 'delivery';
  res.render('checkin/start', { title: `Check in: ${store.name}`, store, expected, company, defaultType, token: req.params.token });
});

router.post('/s/:token/checkin', repOnly, async (req, res) => {
  const store = await storeByToken(req.params.token);
  const me = req.user;
  const open = await db.one(`SELECT id FROM visits WHERE user_id = $1 AND status = 'checked_in' LIMIT 1`, [me.id]);
  if (open) return res.redirect(`/visit/${open.id}`);

  const company = me.vendor_company_id ? await db.one('SELECT * FROM vendor_companies WHERE id = $1', [me.vendor_company_id]) : null;
  const expectedList = await matchExpected(store, me.vendor_company_id);
  // No choice sent = best match for today; an explicit empty choice = unscheduled visit.
  const expected = req.body.expected_visit_id === undefined
    ? expectedList[0] || null
    : expectedList.find((e) => String(e.id) === String(req.body.expected_visit_id)) || null;
  const visitType = VISIT_TYPES[req.body.visit_type] ? req.body.visit_type : (expected ? expected.visit_type : 'delivery');
  const num = (v) => (v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const lat = num(req.body.lat);
  const lng = num(req.body.lng);
  const accuracy = num(req.body.accuracy);

  const result = await evaluateCheckIn({ user: me, company, store, visitType, lat, lng, accuracy });
  let status;
  // Hard failures block; soft issues (location, soft credentials) are recorded as warnings, never a wait.
  if (result.hard.length) status = 'blocked';
  else status = 'checked_in';

  const dwellMin = (expected && expected.expected_dwell_min) || 60;
  const visit = await db.tx(async (c) => {
    const r = await c.query(
      `INSERT INTO visits(user_id, vendor_company_id, store_id, expected_visit_id, visit_type, purpose, source, method, status,
                          check_in_lat, check_in_lng, check_in_accuracy_m, check_in_distance_m, location_ok,
                          credential_result, insurance_status, hard_failures, soft_failures, check_in_at, expected_out_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               CASE WHEN $9 = 'checked_in' THEN now() END,
               CASE WHEN $9 = 'checked_in' THEN now() + make_interval(mins => $19) END)
       RETURNING *`,
      [me.id, company ? company.id : null, store.id, expected ? expected.id : null, visitType,
        String(req.body.purpose || '').slice(0, 300) || null, expected ? 'scheduled' : 'unscheduled',
        result.location.ok && !result.location.skipped ? 'qr_geofence' : 'qr', status,
        lat, lng, accuracy, result.location.distance_m, result.location.ok,
        JSON.stringify({ credentials: result.credentials, location: result.location }), JSON.stringify(result.insurance),
        result.hard, result.soft, dwellMin]
    );
    const v = r.rows[0];
    if (expected) await c.query(`UPDATE expected_visits SET visit_id = $2, status = CASE WHEN $3 = 'checked_in' THEN 'completed' ELSE status END WHERE id = $1`, [expected.id, v.id, status]);
    await audit(req, { action: `visit.${status === 'checked_in' ? 'checked_in' : status}`, entity: 'visit', entityId: v.id, storeId: store.id, after: v }, c);
    return v;
  });

  const who = `${me.name || me.email}${company ? ` (${company.name})` : ''}`;
  if (status === 'blocked') {
    await alerts.raise({
      kind: 'credential_failure', severity: 'critical', storeId: store.id, vendorCompanyId: company && company.id, visitId: visit.id,
      audience: ['receiver', 'store_manager', 'dsd_ops'], message: `Check-in blocked at ${store.name}: ${who}. ${result.hard.join('; ')}`,
      dedupeKey: `block:${visit.id}`,
    });
  } else if (result.soft.length) {
    await alerts.raise({
      kind: 'checkin_warning', severity: 'info', storeId: store.id, vendorCompanyId: company && company.id, visitId: visit.id,
      audience: ['store_manager', 'dsd_ops'], message: `Checked in with warnings at ${store.name}: ${who}. ${result.soft.join('; ')}`,
      dedupeKey: `soft:${visit.id}`,
    });
  }
  res.redirect(`/visit/${visit.id}`);
});

async function ownVisit(req) {
  const v = await db.one(
    `SELECT v.*, s.name AS store_name, s.timezone, s.qr_token, c.name AS company_name
       FROM visits v JOIN stores s ON s.id = v.store_id LEFT JOIN vendor_companies c ON c.id = v.vendor_company_id
      WHERE v.id = $1`, [intParam(req.params.id)]);
  if (!v || v.user_id !== req.user.id) throw httpError(404, 'Visit not found');
  return v;
}

// Digital visitor pass (and status page while waiting for the receiver).
router.get('/visit/:id', repOnly, async (req, res) => {
  const v = await ownVisit(req);
  const work = await db.many('SELECT * FROM work_items WHERE visit_id = $1 ORDER BY id', [v.id]);
  res.render('checkin/pass', { title: 'Visitor pass', v, work });
});

router.post('/visit/:id/cancel', repOnly, async (req, res) => {
  const v = await ownVisit(req);
  if (v.status !== 'checked_in') throw httpError(400, 'This visit is already closed');
  await db.q(`UPDATE visits SET status = 'cancelled' WHERE id = $1`, [v.id]);
  await db.q(`UPDATE expected_visits SET visit_id = NULL WHERE visit_id = $1`, [v.id]);
  await audit(req, { action: 'visit.cancelled', entity: 'visit', entityId: v.id, storeId: v.store_id });
  res.redirect('/rep');
});

router.post('/visit/:id/checkout', repOnly, upload.images.array('photos', 4), verifyCsrf, async (req, res) => {
  const v = await ownVisit(req);
  if (v.status !== 'checked_in') throw httpError(400, 'You are not checked in on this visit');
  const types = toArray(req.body.work).filter((t) => WORK_TYPES[t]);
  await db.tx(async (c) => {
    for (const t of types) {
      await c.query('INSERT INTO work_items(visit_id, type) VALUES ($1,$2)', [v.id, t]);
    }
    for (const f of req.files || []) {
      await c.query('INSERT INTO visit_photos(visit_id, data, mime) VALUES ($1,$2,$3)', [v.id, f.buffer, f.mimetype]);
    }
    const r = await c.query(
      `UPDATE visits SET status = 'checked_out', check_out_at = now(), checked_out_by = $2, work_notes = nullif($3,'')
        WHERE id = $1 AND status = 'checked_in' RETURNING *`, [v.id, req.user.id, String(req.body.notes || '').slice(0, 1000)]);
    await audit(req, { action: 'visit.checked_out', entity: 'visit', entityId: v.id, storeId: v.store_id, before: v, after: r.rows[0] }, c);
  });
  flash(req, 'success', `Checked out of ${v.store_name}. Thanks!`);
  res.redirect('/rep');
});

module.exports = router;

// Vendor rep / field service rep home, identity verification, visit announcements, own credentials.
const express = require('express');
const db = require('../db');
const alerts = require('../alerts');
const upload = require('../upload');
const { audit } = require('../audit');
const { requireRole, verifyCsrf } = require('../auth');
const { flash, intParam, httpError } = require('../util');
const { evaluateInsurance } = require('../checks');
const { VISIT_TYPES } = require('../constants');

const router = express.Router();
const repOnly = requireRole('rep', 'field_service', 'visitor');

router.get('/rep', repOnly, async (req, res) => {
  const me = req.user;
  const company = me.vendor_company_id ? await db.one('SELECT * FROM vendor_companies WHERE id = $1', [me.vendor_company_id]) : null;
  const openVisit = await db.one(
    `SELECT v.*, s.name AS store_name FROM visits v JOIN stores s ON s.id = v.store_id
      WHERE v.user_id = $1 AND v.status IN ('pending_approval','blocked','checked_in') ORDER BY v.requested_at DESC LIMIT 1`, [me.id]);
  const upcoming = company ? await db.many(
    `SELECT e.*, s.name AS store_name, s.store_number, s.timezone, s.receiving_open, s.receiving_close
       FROM expected_visits e JOIN stores s ON s.id = e.store_id
      WHERE e.vendor_company_id = $1 AND e.visit_date BETWEEN current_date - 1 AND current_date + 7
        AND e.status IN ('expected','confirmed','moved')
      ORDER BY e.visit_date, e.window_start LIMIT 40`, [company.id]) : [];
  const recent = await db.many(
    `SELECT v.*, s.name AS store_name, s.timezone FROM visits v JOIN stores s ON s.id = v.store_id
      WHERE v.user_id = $1 ORDER BY v.requested_at DESC LIMIT 10`, [me.id]);
  let insurance = null;
  if (company) {
    const today = (await db.one(`SELECT current_date::text AS d`)).d;
    insurance = await evaluateInsurance(company, me.role === 'field_service' ? 'field_service' : 'delivery', today);
  }
  res.render('rep/home', { title: 'My visits', company, openVisit, upcoming, recent, insurance });
});

router.get('/rep/identity', repOnly, (req, res) => {
  res.render('rep/identity', { title: 'Verify your identity' });
});

router.post('/rep/identity', repOnly, upload.images.fields([{ name: 'id_photo', maxCount: 1 }, { name: 'selfie', maxCount: 1 }]), verifyCsrf, async (req, res) => {
  const idPhoto = req.files && req.files.id_photo && req.files.id_photo[0];
  const selfie = req.files && req.files.selfie && req.files.selfie[0];
  if (!idPhoto || !selfie) {
    flash(req, 'error', 'Add both a photo of your government ID and a selfie.');
    return res.redirect('/rep/identity');
  }
  const me = req.user;
  await db.q(
    `UPDATE users SET id_photo = $2, id_photo_type = $3, selfie = $4, selfie_type = $5,
            identity_submitted_at = now(), identity_reject_reason = NULL,
            status = 'identity_review'
      WHERE id = $1`,
    [me.id, idPhoto.buffer, idPhoto.mimetype, selfie.buffer, selfie.mimetype]
  );
  await audit(req, { action: 'identity.submitted', entity: 'user', entityId: me.id });
  await alerts.raise({
    kind: 'identity_review', vendorCompanyId: me.vendor_company_id, userId: me.id, audience: ['dsd_ops'],
    message: `Identity review needed for ${me.name || me.email}.`, dedupeKey: `idrev:${me.id}:${Date.now()}`,
  });
  const next = req.session.afterIdentity;
  delete req.session.afterIdentity;
  flash(req, 'success', 'Thanks. Your ID is in review. You can check in once it is approved.');
  res.redirect(next || '/rep');
});

// Confirm, move or cancel an expected visit; share ETA and planned work.
router.post('/rep/expected/:id', repOnly, async (req, res) => {
  const id = intParam(req.params.id);
  const me = req.user;
  const e = await db.one('SELECT e.*, s.timezone FROM expected_visits e JOIN stores s ON s.id = e.store_id WHERE e.id = $1', [id]);
  if (!e || e.vendor_company_id !== me.vendor_company_id) throw httpError(404, 'Not found');
  const action = req.body.action;
  let status = e.status;
  let visitDate = e.visit_date;
  let eta = null;
  if (action === 'cancel') status = 'cancelled';
  else if (action === 'confirm') status = 'confirmed';
  else if (action === 'move') {
    status = 'moved';
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '')) visitDate = req.body.date;
  } else throw httpError(400, 'Unknown action');
  if (/^\d{2}:\d{2}$/.test(req.body.eta || '') && status !== 'cancelled') {
    const r = await db.one(`SELECT (($1::date + $2::time) AT TIME ZONE $3) AS eta`, [visitDate, req.body.eta, e.timezone]);
    eta = r.eta;
  }
  const after = await db.one(
    `UPDATE expected_visits SET status = $2, visit_date = $3, eta = coalesce($4, eta), planned_work = coalesce(nullif($5,''), planned_work),
            announced_by = $6, announced_at = now()
      WHERE id = $1 RETURNING *`,
    [id, status, visitDate, eta, (req.body.planned_work || '').slice(0, 500), me.id]
  );
  await audit(req, { action: `expected_visit.${action}`, entity: 'expected_visit', entityId: id, storeId: e.store_id, before: e, after });
  flash(req, 'success', action === 'cancel' ? 'Visit cancelled. The store has been told.' : 'Visit updated. The store can see it.');
  res.redirect('/rep');
});

router.get('/rep/announce', repOnly, async (req, res) => {
  const stores = await db.many('SELECT id, store_number, name FROM stores WHERE active ORDER BY store_number');
  res.render('rep/announce', { title: 'Announce a visit', stores });
});

router.post('/rep/announce', repOnly, async (req, res) => {
  const me = req.user;
  if (!me.vendor_company_id) throw httpError(400, 'Only vendor reps can announce visits');
  const store = await db.one('SELECT * FROM stores WHERE id = $1 AND active', [Number(req.body.store_id)]);
  if (!store) throw httpError(400, 'Pick a store');
  const visitType = VISIT_TYPES[req.body.visit_type] ? req.body.visit_type : 'delivery';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') || !/^\d{2}:\d{2}$/.test(req.body.eta || '')) throw httpError(400, 'Enter a date and arrival time');
  const dwell = Math.max(5, Math.min(600, Number(req.body.dwell) || 45));
  const r = await db.one(
    `INSERT INTO expected_visits(store_id, vendor_company_id, visit_type, visit_date, window_start, window_end, expected_dwell_min,
                                 status, announced_by, announced_at, eta, planned_work)
     VALUES ($1,$2,$3,$4::date,$5::time,($5::time + make_interval(mins => $6)),$6,'confirmed',$7,now(),
             (($4::date + $5::time) AT TIME ZONE $8),$9) RETURNING *`,
    [store.id, me.vendor_company_id, visitType, req.body.date, req.body.eta, dwell, me.id, store.timezone, (req.body.planned_work || '').slice(0, 500)]
  );
  await audit(req, { action: 'expected_visit.announced', entity: 'expected_visit', entityId: r.id, storeId: store.id, after: r });
  const [h] = req.body.eta.split(':').map(Number);
  const [oh] = String(store.receiving_open).split(':').map(Number);
  const [ch] = String(store.receiving_close).split(':').map(Number);
  if (h < oh || h >= ch) flash(req, 'warning', `Announced. Note: ${store.name} receives ${store.receiving_open.slice(0, 5)} to ${store.receiving_close.slice(0, 5)}, and your arrival is outside those hours.`);
  else flash(req, 'success', `Announced. ${store.name} can see your visit.`);
  res.redirect('/rep');
});

router.get('/rep/credentials', repOnly, async (req, res) => {
  const me = req.user;
  const types = await db.many(`SELECT * FROM credential_types WHERE active AND holder = 'person' ORDER BY name`);
  const mine = await db.many(
    `SELECT c.id, c.credential_type_id, c.issuer, c.number, c.issued_on, c.expires_on, c.status, c.reject_reason, t.name
       FROM credentials c JOIN credential_types t ON t.id = c.credential_type_id WHERE c.user_id = $1 ORDER BY c.created_at DESC`, [me.id]);
  res.render('rep/credentials', { title: 'My credentials', types, mine });
});

router.post('/rep/credentials', repOnly, upload.docs.single('doc'), verifyCsrf, async (req, res) => {
  const me = req.user;
  const type = await db.one(`SELECT * FROM credential_types WHERE id = $1 AND active AND holder = 'person'`, [Number(req.body.credential_type_id)]);
  if (!type) throw httpError(400, 'Pick a credential');
  const f = req.file;
  const r = await db.one(
    `INSERT INTO credentials(credential_type_id, user_id, issuer, number, issued_on, expires_on, doc, doc_type, doc_name, submitted_by)
     VALUES ($1,$2,$3,$4,nullif($5,'')::date,nullif($6,'')::date,$7,$8,$9,$2) RETURNING id`,
    [type.id, me.id, req.body.issuer || null, req.body.number || null, req.body.issued_on || '', req.body.expires_on || '',
      f ? f.buffer : null, f ? f.mimetype : null, f ? f.originalname : null]
  );
  await audit(req, { action: 'credential.submitted', entity: 'credential', entityId: r.id, after: { type: type.name } });
  await alerts.raise({ kind: 'credential_review', userId: me.id, vendorCompanyId: me.vendor_company_id, audience: ['dsd_ops'],
    message: `Credential to review: ${type.name} for ${me.name || me.email}.`, dedupeKey: `credrev:${r.id}` });
  flash(req, 'success', 'Submitted for review.');
  res.redirect('/rep/credentials');
});

router.get('/rep/visits', repOnly, async (req, res) => {
  const visits = await db.many(
    `SELECT v.*, s.name AS store_name, s.timezone FROM visits v JOIN stores s ON s.id = v.store_id
      WHERE v.user_id = $1 ORDER BY v.requested_at DESC LIMIT 200`, [req.user.id]);
  res.render('rep/visits', { title: 'Visit history', visits });
});

module.exports = router;

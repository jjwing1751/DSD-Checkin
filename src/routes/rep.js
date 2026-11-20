// Vendor rep / field service rep home, identity verification, own credentials.
const express = require('express');
const db = require('../db');
const alerts = require('../alerts');
const upload = require('../upload');
const { audit } = require('../audit');
const { requireRole, verifyCsrf } = require('../auth');
const { flash, httpError } = require('../util');
const { evaluateInsurance } = require('../checks');

const router = express.Router();
const repOnly = requireRole('rep', 'field_service', 'visitor');

router.get('/rep', repOnly, async (req, res) => {
  const me = req.user;
  const company = me.vendor_company_id ? await db.one('SELECT * FROM vendor_companies WHERE id = $1', [me.vendor_company_id]) : null;
  const openVisit = await db.one(
    `SELECT v.*, s.name AS store_name, s.timezone FROM visits v JOIN stores s ON s.id = v.store_id
      WHERE v.user_id = $1 AND v.status = 'checked_in' ORDER BY v.requested_at DESC LIMIT 1`, [me.id]);
  const recent = await db.many(
    `SELECT v.*, s.name AS store_name, s.timezone FROM visits v JOIN stores s ON s.id = v.store_id
      WHERE v.user_id = $1 ORDER BY v.requested_at DESC LIMIT 10`, [me.id]);
  let insurance = null;
  if (company) {
    const today = (await db.one(`SELECT current_date::text AS d`)).d;
    insurance = await evaluateInsurance(company, me.role === 'field_service' ? 'field_service' : 'delivery', today);
  }
  res.render('rep/home', { title: 'My visits', company, openVisit, recent, insurance });
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

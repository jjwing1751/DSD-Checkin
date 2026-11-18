// Vendor company admin: their reps, insurance certificates (COI), company credentials, missed visits.
const express = require('express');
const db = require('../db');
const alerts = require('../alerts');
const upload = require('../upload');
const { audit } = require('../audit');
const { requireLogin, verifyCsrf } = require('../auth');
const { evaluateInsurance } = require('../checks');
const { flash, intParam, httpError, numOrNull } = require('../util');
const { COVERAGE_TYPES } = require('../constants');

const router = express.Router();

function vendorAdmin(req, res, next) {
  if (!req.user || !req.user.is_vendor_admin || !req.user.vendor_company_id) {
    return next(httpError(403, 'Only your company admin can open this page.'));
  }
  next();
}

router.get('/company', requireLogin, vendorAdmin, async (req, res) => {
  const companyId = req.user.vendor_company_id;
  const company = await db.one('SELECT * FROM vendor_companies WHERE id = $1', [companyId]);
  const reps = await db.many(`SELECT id, name, email, phone, role, status, is_vendor_admin, last_login_at FROM users WHERE vendor_company_id = $1 ORDER BY name`, [companyId]);
  const policies = await db.many(`SELECT id, coverage_type, carrier, policy_number, per_occurrence, aggregate, additional_insured, effective_date, expiry_date, status, reject_reason, (doc IS NOT NULL) AS has_doc
      FROM insurance_policies WHERE vendor_company_id = $1 ORDER BY expiry_date DESC`, [companyId]);
  const requirements = await db.many('SELECT * FROM insurance_requirements WHERE active ORDER BY id');
  const companyCredTypes = await db.many(`SELECT * FROM credential_types WHERE active AND holder = 'company' ORDER BY name`);
  const companyCreds = await db.many(`SELECT c.*, t.name FROM credentials c JOIN credential_types t ON t.id = c.credential_type_id WHERE c.vendor_company_id = $1 ORDER BY c.created_at DESC`, [companyId]);
  const today = (await db.one('SELECT current_date::text AS d')).d;
  const insurance = await evaluateInsurance(company, 'delivery', today);
  const missed = await db.many(`SELECT e.*, s.name AS store_name FROM expected_visits e JOIN stores s ON s.id = e.store_id
      WHERE e.vendor_company_id = $1 AND e.status = 'missed' AND e.visit_date > current_date - 30 ORDER BY e.visit_date DESC LIMIT 50`, [companyId]);
  const companyAlerts = await db.many(`SELECT * FROM alerts WHERE vendor_company_id = $1 AND 'vendor_admin' = ANY(audience) AND created_at > now() - interval '30 days' ORDER BY created_at DESC LIMIT 20`, [companyId]);
  res.render('company/home', { title: company.name, company, reps, policies, requirements, insurance, companyCredTypes, companyCreds, missed, companyAlerts });
});

router.post('/company/reps/:id/status', requireLogin, vendorAdmin, async (req, res) => {
  const id = intParam(req.params.id);
  const rep = await db.one('SELECT id, status, vendor_company_id FROM users WHERE id = $1', [id]);
  if (!rep || rep.vendor_company_id !== req.user.vendor_company_id) throw httpError(404, 'Not found');
  if (rep.id === req.user.id) throw httpError(400, 'You cannot change your own status here.');
  const action = req.body.action;
  let sql;
  if (action === 'suspend') sql = `UPDATE users SET status = 'suspended' WHERE id = $1 RETURNING id, status`;
  else if (action === 'remove') sql = `UPDATE users SET status = 'removed' WHERE id = $1 RETURNING id, status`;
  else if (action === 'reinstate') sql = `UPDATE users SET status = CASE WHEN identity_verified_at IS NOT NULL THEN 'active' ELSE 'pending_identity' END WHERE id = $1 RETURNING id, status`;
  else if (action === 'make_admin') sql = `UPDATE users SET is_vendor_admin = true WHERE id = $1 RETURNING id, is_vendor_admin`;
  else throw httpError(400, 'Unknown action');
  const after = await db.one(sql, [id]);
  if (['suspend', 'remove'].includes(action)) await db.q(`DELETE FROM session WHERE (sess->>'userId')::int = $1`, [id]).catch(() => {});
  await audit(req, { action: `user.${action}`, entity: 'user', entityId: id, before: rep, after });
  flash(req, 'success', 'Updated.');
  res.redirect('/company');
});

router.post('/company/policies', requireLogin, vendorAdmin, upload.docs.single('doc'), verifyCsrf, async (req, res) => {
  const b = req.body;
  if (!COVERAGE_TYPES.includes(b.coverage_type) && !(await db.one('SELECT 1 FROM insurance_requirements WHERE coverage_type = $1', [b.coverage_type]))) {
    throw httpError(400, 'Pick a coverage type');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.effective_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date || '')) throw httpError(400, 'Enter effective and expiry dates');
  if (!req.file) throw httpError(400, 'Attach the certificate of insurance (PDF or photo)');
  const r = await db.one(
    `INSERT INTO insurance_policies(vendor_company_id, coverage_type, carrier, policy_number, per_occurrence, aggregate, additional_insured,
                                    effective_date, expiry_date, doc, doc_type, doc_name, submitted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, coverage_type, policy_number, effective_date, expiry_date`,
    [req.user.vendor_company_id, b.coverage_type, b.carrier || null, b.policy_number || null, numOrNull(b.per_occurrence), numOrNull(b.aggregate),
      b.additional_insured === 'on', b.effective_date, b.expiry_date, req.file.buffer, req.file.mimetype, req.file.originalname, req.user.id]);
  await audit(req, { action: 'insurance_policy.submitted', entity: 'insurance_policy', entityId: r.id, after: r });
  await alerts.raise({ kind: 'coi_review', vendorCompanyId: req.user.vendor_company_id, audience: ['dsd_ops'],
    message: `Certificate of insurance to verify: ${b.coverage_type}, policy ${b.policy_number || ''}.`, dedupeKey: `coi:${r.id}` });
  flash(req, 'success', 'Certificate submitted. DSD ops will verify it.');
  res.redirect('/company');
});

router.post('/company/credentials', requireLogin, vendorAdmin, upload.docs.single('doc'), verifyCsrf, async (req, res) => {
  const type = await db.one(`SELECT * FROM credential_types WHERE id = $1 AND active AND holder = 'company'`, [Number(req.body.credential_type_id)]);
  if (!type) throw httpError(400, 'Pick a credential');
  const f = req.file;
  const r = await db.one(
    `INSERT INTO credentials(credential_type_id, vendor_company_id, issuer, number, issued_on, expires_on, doc, doc_type, doc_name, submitted_by)
     VALUES ($1,$2,$3,$4,nullif($5,'')::date,nullif($6,'')::date,$7,$8,$9,$10) RETURNING id`,
    [type.id, req.user.vendor_company_id, req.body.issuer || null, req.body.number || null, req.body.issued_on || '', req.body.expires_on || '',
      f ? f.buffer : null, f ? f.mimetype : null, f ? f.originalname : null, req.user.id]);
  await audit(req, { action: 'credential.submitted', entity: 'credential', entityId: r.id, after: { type: type.name } });
  flash(req, 'success', 'Submitted for review.');
  res.redirect('/company');
});

module.exports = router;

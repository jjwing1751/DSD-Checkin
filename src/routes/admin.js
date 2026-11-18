// Admin console for DSD ops / compliance and administrators.
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const alerts = require('../alerts');
const { audit } = require('../audit');
const { requireRole, hashPassword, normEmail, emailDomain } = require('../auth');
const { activeCompanyOverride, evaluateInsurance } = require('../checks');
const { flash, intParam, httpError, toArray, csvList, numOrNull, toCsv } = require('../util');
const { ROLES, VISIT_TYPES, COVERAGE_TYPES } = require('../constants');
const { DEFAULT_WEIGHTS } = require('../metrics');

const router = express.Router();
const ops = requireRole('dsd_ops');
const newToken = () => crypto.randomBytes(12).toString('base64url');
const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;

// ---------- Overview ----------
router.get('/admin', ops, async (req, res) => {
  const counts = await db.one(`SELECT
      (SELECT count(*) FROM users WHERE status = 'identity_review')::int AS identity,
      (SELECT count(*) FROM insurance_policies WHERE status = 'submitted')::int AS policies,
      (SELECT count(*) FROM credentials WHERE status = 'submitted')::int AS credentials,
      (SELECT count(*) FROM vendor_companies WHERE status = 'pending')::int AS vendors,
      (SELECT count(*) FROM visits WHERE status = 'checked_in')::int AS in_store,
      (SELECT count(*) FROM visits WHERE status IN ('pending_approval','blocked'))::int AS waiting,
      (SELECT count(*) FROM stores WHERE active)::int AS stores,
      (SELECT count(*) FROM visits WHERE requested_at > now() - interval '24 hours')::int AS visits_24h`);
  const recentAlerts = await db.many(`SELECT a.*, s.name AS store_name FROM alerts a LEFT JOIN stores s ON s.id = a.store_id
      WHERE a.dismissed_at IS NULL AND ('dsd_ops' = ANY(a.audience)) ORDER BY a.created_at DESC LIMIT 25`);
  res.render('admin/home', { title: 'Admin', counts, recentAlerts });
});

router.post('/admin/alerts/:id/dismiss', ops, async (req, res) => {
  await db.q('UPDATE alerts SET dismissed_at = now(), dismissed_by = $2 WHERE id = $1', [intParam(req.params.id), req.user.id]);
  res.redirect(req.get('referer') && req.get('referer').includes('/admin') ? req.get('referer') : '/admin');
});

// ---------- Stores ----------
router.get('/admin/stores', ops, async (req, res) => {
  const stores = await db.many('SELECT * FROM stores ORDER BY active DESC, store_number');
  res.render('admin/stores', { title: 'Stores', stores });
});

function storeFields(b) {
  const t = (v, d) => (/^\d{2}:\d{2}/.test(v || '') ? v : d);
  return [
    String(b.store_number || '').trim(), String(b.name || '').trim(), b.address || null, b.region || null, b.district || null,
    b.timezone || 'America/Chicago', numOrNull(b.lat), numOrNull(b.lng), Math.max(25, Number(b.geofence_m) || 200),
    t(b.receiving_open, '06:00'), t(b.receiving_close, '14:00'), t(b.store_close, '22:00'), Math.max(1, Number(b.capacity_per_hour) || 4),
  ];
}

router.post('/admin/stores', ops, async (req, res) => {
  const f = storeFields(req.body);
  if (!f[0] || !f[1]) throw httpError(400, 'Store number and name are required');
  const tzOk = await db.one('SELECT 1 FROM pg_timezone_names WHERE name = $1', [f[5]]);
  if (!tzOk) throw httpError(400, 'Unknown time zone');
  const r = await db.one(
    `INSERT INTO stores(store_number, name, address, region, district, timezone, lat, lng, geofence_m, receiving_open, receiving_close, store_close, capacity_per_hour, qr_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [...f, newToken()]);
  await audit(req, { action: 'store.created', entity: 'store', entityId: r.id, storeId: r.id, after: r });
  flash(req, 'success', `Store ${r.store_number} added. Print its backdoor QR poster next.`);
  res.redirect(`/admin/stores/${r.id}`);
});

router.get('/admin/stores/:id', ops, async (req, res) => {
  const s = await db.one('SELECT * FROM stores WHERE id = $1', [intParam(req.params.id)]);
  if (!s) throw httpError(404, 'Not found');
  const staff = await db.many(`SELECT id, name, email, role, status FROM users WHERE store_id = $1 ORDER BY role, name`, [s.id]);
  res.render('admin/store', { title: s.name, s, staff });
});

router.post('/admin/stores/:id', ops, async (req, res) => {
  const id = intParam(req.params.id);
  const before = await db.one('SELECT * FROM stores WHERE id = $1', [id]);
  if (!before) throw httpError(404, 'Not found');
  let after;
  if (req.body.action === 'rotate_qr') {
    after = await db.one('UPDATE stores SET qr_token = $2 WHERE id = $1 RETURNING *', [id, newToken()]);
    flash(req, 'warning', 'New QR code generated. The old poster no longer works; print and post the new one.');
  } else if (req.body.action === 'toggle') {
    after = await db.one('UPDATE stores SET active = NOT active WHERE id = $1 RETURNING *', [id]);
  } else {
    const f = storeFields(req.body);
    const tzOk = await db.one('SELECT 1 FROM pg_timezone_names WHERE name = $1', [f[5]]);
    if (!tzOk) throw httpError(400, 'Unknown time zone');
    after = await db.one(
      `UPDATE stores SET store_number=$2, name=$3, address=$4, region=$5, district=$6, timezone=$7, lat=$8, lng=$9, geofence_m=$10,
              receiving_open=$11, receiving_close=$12, store_close=$13, capacity_per_hour=$14 WHERE id = $1 RETURNING *`, [id, ...f]);
    flash(req, 'success', 'Store saved.');
  }
  await audit(req, { action: `store.${req.body.action || 'updated'}`, entity: 'store', entityId: id, storeId: id, before, after });
  res.redirect(`/admin/stores/${id}`);
});

// Printable backdoor poster.
router.get('/admin/stores/:id/poster', ops, async (req, res) => {
  const s = await db.one('SELECT * FROM stores WHERE id = $1', [intParam(req.params.id)]);
  if (!s) throw httpError(404, 'Not found');
  const url = `${baseUrl(req)}/s/${s.qr_token}`;
  const qr = await QRCode.toDataURL(url, { width: 900, margin: 1, errorCorrectionLevel: 'M' });
  res.render('admin/poster', { title: `Check-in poster: ${s.name}`, s, url, qr, layout: 'print' });
});

// ---------- Vendor companies ----------
router.get('/admin/vendors', ops, async (req, res) => {
  const vendors = await db.many(`
    SELECT c.*, (SELECT count(*) FROM users u WHERE u.vendor_company_id = c.id AND u.status = 'active')::int AS active_reps,
           (SELECT count(*) FROM insurance_policies p WHERE p.vendor_company_id = c.id AND p.status = 'submitted')::int AS policies_to_review,
           (SELECT min(expiry_date) FROM insurance_policies p WHERE p.vendor_company_id = c.id AND p.status = 'verified' AND p.expiry_date >= current_date) AS next_expiry
      FROM vendor_companies c ORDER BY (c.status = 'pending') DESC, c.name`);
  res.render('admin/vendors', { title: 'Vendor companies', vendors });
});

async function validateDomains(domains) {
  const blocked = await db.many('SELECT domain FROM blocked_email_domains WHERE domain = ANY($1)', [domains]);
  if (blocked.length) throw httpError(400, `Personal email domains cannot be vendor domains: ${blocked.map((b) => b.domain).join(', ')}`);
}

router.post('/admin/vendors', ops, async (req, res) => {
  const b = req.body;
  const domains = csvList(b.email_domains).map((d) => d.toLowerCase().replace(/^@/, ''));
  if (!String(b.name || '').trim()) throw httpError(400, 'Name is required');
  await validateDomains(domains);
  const r = await db.one(
    `INSERT INTO vendor_companies(name, vendor_number, email_domains, categories, delivers_by_vehicle, status)
     VALUES ($1,$2,$3,$4,$5,'pending') RETURNING *`,
    [b.name.trim(), b.vendor_number || null, domains, csvList(b.categories), b.delivers_by_vehicle === 'on']);
  await audit(req, { action: 'vendor_company.created', entity: 'vendor_company', entityId: r.id, after: r });
  flash(req, 'success', 'Vendor added as pending. Verify its insurance, then activate it.');
  res.redirect(`/admin/vendors/${r.id}`);
});

router.get('/admin/vendors/:id', ops, async (req, res) => {
  const c = await db.one('SELECT * FROM vendor_companies WHERE id = $1', [intParam(req.params.id)]);
  if (!c) throw httpError(404, 'Not found');
  const policies = await db.many(`SELECT p.id, p.coverage_type, p.carrier, p.policy_number, p.per_occurrence, p.aggregate, p.additional_insured,
      p.effective_date, p.expiry_date, p.status, p.reject_reason, p.verified_at, (p.doc IS NOT NULL) AS has_doc, u.name AS verified_by_name
      FROM insurance_policies p LEFT JOIN users u ON u.id = p.verified_by WHERE p.vendor_company_id = $1 ORDER BY p.status = 'submitted' DESC, p.expiry_date DESC`, [c.id]);
  const reps = await db.many(`SELECT id, name, email, role, status, is_vendor_admin, identity_verified_at FROM users WHERE vendor_company_id = $1 ORDER BY name`, [c.id]);
  const overrides = await db.many(`SELECT o.*, u.name AS approved_by_name FROM insurance_overrides o JOIN users u ON u.id = o.approved_by WHERE o.vendor_company_id = $1 ORDER BY o.created_at DESC LIMIT 20`, [c.id]);
  const active = await activeCompanyOverride(c.id);
  const today = (await db.one('SELECT current_date::text AS d')).d;
  const insByType = {};
  for (const vt of Object.keys(VISIT_TYPES)) insByType[vt] = await evaluateInsurance(c, vt, today);
  const maxDays = (await db.one(`SELECT value FROM settings WHERE key = 'max_company_override_days'`)).value;
  res.render('admin/vendor', { title: c.name, c, policies, reps, overrides, active, insByType, maxDays });
});

router.post('/admin/vendors/:id', ops, async (req, res) => {
  const id = intParam(req.params.id);
  const before = await db.one('SELECT * FROM vendor_companies WHERE id = $1', [id]);
  if (!before) throw httpError(404, 'Not found');
  const b = req.body;
  let after;
  if (['active', 'suspended', 'pending'].includes(b.status_action)) {
    after = await db.one('UPDATE vendor_companies SET status = $2 WHERE id = $1 RETURNING *', [id, b.status_action]);
    if (b.status_action === 'active' && before.status === 'pending') {
      const emails = await alerts.emailsFor({ roles: [], vendorCompanyId: id, vendorAdminsOnly: true });
      await alerts.raise({ kind: 'vendor_activated', vendorCompanyId: id, audience: ['vendor_admin'], message: `${before.name} is approved for store access.`, dedupeKey: `vact:${id}`, email: emails });
    }
  } else {
    const domains = csvList(b.email_domains).map((d) => d.toLowerCase().replace(/^@/, ''));
    await validateDomains(domains);
    after = await db.one(
      `UPDATE vendor_companies SET name=$2, vendor_number=$3, email_domains=$4, categories=$5, delivers_by_vehicle=$6, notes=$7 WHERE id = $1 RETURNING *`,
      [id, String(b.name || before.name).trim(), b.vendor_number || null, domains, csvList(b.categories), b.delivers_by_vehicle === 'on', b.notes || null]);
  }
  await audit(req, { action: 'vendor_company.updated', entity: 'vendor_company', entityId: id, before, after });
  flash(req, 'success', 'Vendor saved.');
  res.redirect(`/admin/vendors/${id}`);
});

router.post('/admin/policies/:id', ops, async (req, res) => {
  const id = intParam(req.params.id);
  const before = await db.one('SELECT id, vendor_company_id, coverage_type, status FROM insurance_policies WHERE id = $1', [id]);
  if (!before) throw httpError(404, 'Not found');
  const verify = req.body.action === 'verify';
  const after = await db.one(
    `UPDATE insurance_policies SET status = $2, verified_by = $3, verified_at = now(), reject_reason = $4,
            per_occurrence = coalesce($5, per_occurrence), aggregate = coalesce($6, aggregate),
            additional_insured = CASE WHEN $7 THEN true ELSE additional_insured END
      WHERE id = $1 RETURNING id, status, per_occurrence, aggregate, additional_insured`,
    [id, verify ? 'verified' : 'rejected', req.user.id, verify ? null : (req.body.reason || 'Rejected'),
      numOrNull(req.body.per_occurrence), numOrNull(req.body.aggregate), req.body.additional_insured === 'on']);
  await audit(req, { action: `insurance_policy.${verify ? 'verified' : 'rejected'}`, entity: 'insurance_policy', entityId: id, before, after });
  const emails = await alerts.emailsFor({ roles: [], vendorCompanyId: before.vendor_company_id, vendorAdminsOnly: true });
  await alerts.raise({ kind: 'coi_result', vendorCompanyId: before.vendor_company_id, audience: ['vendor_admin'],
    message: `Your ${before.coverage_type} certificate was ${verify ? 'verified' : `rejected: ${req.body.reason || ''}`}.`, dedupeKey: `coires:${id}:${Date.now()}`, email: emails });
  flash(req, 'success', `Policy ${verify ? 'verified' : 'rejected'}.`);
  res.redirect(`/admin/vendors/${before.vendor_company_id}`);
});

// Company-wide insurance override (DSD ops, up to the configured maximum days).
router.post('/admin/vendors/:id/override', ops, async (req, res) => {
  const id = intParam(req.params.id);
  const c = await db.one('SELECT id, name FROM vendor_companies WHERE id = $1', [id]);
  if (!c) throw httpError(404, 'Not found');
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw httpError(400, 'A reason is required');
  const maxDays = Number((await db.one(`SELECT value FROM settings WHERE key = 'max_company_override_days'`)).value) || 14;
  const days = Math.min(maxDays, Math.max(1, Number(req.body.days) || 7));
  const r = await db.one(
    `INSERT INTO insurance_overrides(vendor_company_id, reason, approved_by, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4)) RETURNING *`,
    [id, reason, req.user.id, days]);
  await audit(req, { action: 'insurance_override.created', entity: 'insurance_override', entityId: r.id, after: r });
  await alerts.raise({ kind: 'company_override', severity: 'warning', vendorCompanyId: id, audience: ['dsd_ops', 'merchant'],
    message: `Insurance override for ${c.name} for ${days} days by ${req.user.name || req.user.email}. Reason: ${reason}`, dedupeKey: `covr:${r.id}` });
  flash(req, 'success', `Override active for ${days} days.`);
  res.redirect(`/admin/vendors/${id}`);
});

router.post('/admin/overrides/:id/revoke', ops, async (req, res) => {
  const id = intParam(req.params.id);
  const r = await db.one('UPDATE insurance_overrides SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING *', [id]);
  if (!r) throw httpError(404, 'Not found');
  await audit(req, { action: 'insurance_override.revoked', entity: 'insurance_override', entityId: id, after: r });
  res.redirect(`/admin/vendors/${r.vendor_company_id}`);
});

// ---------- Insurance requirements (admin-configurable) ----------
router.get('/admin/insurance', ops, async (req, res) => {
  const reqs = await db.many('SELECT * FROM insurance_requirements ORDER BY active DESC, id');
  const pendingPolicies = await db.many(`SELECT p.id, p.coverage_type, p.policy_number, p.expiry_date, p.created_at, c.name AS vendor_name, c.id AS vendor_id
      FROM insurance_policies p JOIN vendor_companies c ON c.id = p.vendor_company_id WHERE p.status = 'submitted' ORDER BY p.created_at`);
  res.render('admin/insurance', { title: 'Insurance requirements', reqs, pendingPolicies });
});

function reqFields(b) {
  return [
    String(b.coverage_type || '').trim(), numOrNull(b.min_per_occurrence), numOrNull(b.min_aggregate), b.require_additional_insured === 'on',
    toArray(b.visit_types).filter((v) => VISIT_TYPES[v]), csvList(b.categories), b.vehicle_only === 'on', b.notes || null,
  ];
}

router.post('/admin/insurance', ops, async (req, res) => {
  const f = reqFields(req.body);
  if (!f[0]) throw httpError(400, 'Coverage type is required');
  const r = await db.one(
    `INSERT INTO insurance_requirements(coverage_type, min_per_occurrence, min_aggregate, require_additional_insured, visit_types, categories, vehicle_only, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, f);
  await audit(req, { action: 'insurance_requirement.created', entity: 'insurance_requirement', entityId: r.id, after: r });
  flash(req, 'success', 'Requirement added. It applies from the next check-in.');
  res.redirect('/admin/insurance');
});

router.post('/admin/insurance/:id', ops, async (req, res) => {
  const id = intParam(req.params.id);
  const before = await db.one('SELECT * FROM insurance_requirements WHERE id = $1', [id]);
  if (!before) throw httpError(404, 'Not found');
  let after;
  if (req.body.action === 'toggle') after = await db.one('UPDATE insurance_requirements SET active = NOT active WHERE id = $1 RETURNING *', [id]);
  else {
    after = await db.one(
      `UPDATE insurance_requirements SET coverage_type=$2, min_per_occurrence=$3, min_aggregate=$4, require_additional_insured=$5,
              visit_types=$6, categories=$7, vehicle_only=$8, notes=$9 WHERE id = $1 RETURNING *`, [id, ...reqFields(req.body)]);
  }
  await audit(req, { action: 'insurance_requirement.updated', entity: 'insurance_requirement', entityId: id, before, after });
  flash(req, 'success', 'Requirement saved.');
  res.redirect('/admin/insurance');
});

// ---------- Credential types + review queue ----------
router.get('/admin/credentials', ops, async (req, res) => {
  const types = await db.many('SELECT * FROM credential_types ORDER BY active DESC, name');
  const pending = await db.many(`
    SELECT cr.id, cr.issuer, cr.number, cr.issued_on, cr.expires_on, cr.created_at, (cr.doc IS NOT NULL) AS has_doc, t.name AS type_name,
           coalesce(u.name, u.email) AS person, c.name AS company
      FROM credentials cr JOIN credential_types t ON t.id = cr.credential_type_id
      LEFT JOIN users u ON u.id = cr.user_id LEFT JOIN vendor_companies c ON c.id = coalesce(cr.vendor_company_id, u.vendor_company_id)
     WHERE cr.status = 'submitted' ORDER BY cr.created_at`);
  res.render('admin/credentials', { title: 'Credentials', types, pending });
});

function credTypeFields(b) {
  return [
    String(b.name || '').trim(), b.holder === 'company' ? 'company' : 'person', toArray(b.visit_types).filter((v) => VISIT_TYPES[v]),
    b.enforcement === 'hard' ? 'hard' : 'soft', Number(b.validity_days) || null, b.description || null,
  ];
}

router.post('/admin/credentials', ops, async (req, res) => {
  const f = credTypeFields(req.body);
  if (!f[0]) throw httpError(400, 'Name is required');
  const r = await db.one(`INSERT INTO credential_types(name, holder, visit_types, enforcement, validity_days, description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, f);
  await audit(req, { action: 'credential_type.created', entity: 'credential_type', entityId: r.id, after: r });
  flash(req, 'success', 'Credential added. It is checked from the next check-in.');
  res.redirect('/admin/credentials');
});

router.post('/admin/credentials/:id', ops, async (req, res) => {
  const id = intParam(req.params.id);
  const before = await db.one('SELECT * FROM credential_types WHERE id = $1', [id]);
  if (!before) throw httpError(404, 'Not found');
  const after = req.body.action === 'toggle'
    ? await db.one('UPDATE credential_types SET active = NOT active WHERE id = $1 RETURNING *', [id])
    : await db.one(`UPDATE credential_types SET name=$2, holder=$3, visit_types=$4, enforcement=$5, validity_days=$6, description=$7 WHERE id = $1 RETURNING *`,
      [id, ...credTypeFields(req.body)]);
  await audit(req, { action: 'credential_type.updated', entity: 'credential_type', entityId: id, before, after });
  flash(req, 'success', 'Saved.');
  res.redirect('/admin/credentials');
});

router.post('/admin/credential-items/:id', ops, async (req, res) => {
  const id = intParam(req.params.id);
  const verify = req.body.action === 'verify';
  const r = await db.one(
    `UPDATE credentials SET status = $2, verified_by = $3, verified_at = now(), reject_reason = $4,
            expires_on = coalesce(nullif($5,'')::date, expires_on) WHERE id = $1 RETURNING id, status, user_id, expires_on`,
    [id, verify ? 'verified' : 'rejected', req.user.id, verify ? null : (req.body.reason || 'Rejected'), req.body.expires_on || '']);
  if (!r) throw httpError(404, 'Not found');
  await audit(req, { action: `credential.${r.status}`, entity: 'credential', entityId: id, after: r });
  res.redirect('/admin/credentials');
});

// ---------- Identity review ----------
router.get('/admin/identity', ops, async (req, res) => {
  const people = await db.many(`SELECT u.id, u.name, u.email, u.phone, u.role, u.identity_submitted_at, c.name AS company, c.status AS company_status
      FROM users u LEFT JOIN vendor_companies c ON c.id = u.vendor_company_id WHERE u.status = 'identity_review' ORDER BY u.identity_submitted_at`);
  res.render('admin/identity', { title: 'Identity review', people });
});

router.post('/admin/users/:id/identity', ops, async (req, res) => {
  const id = intParam(req.params.id);
  const approve = req.body.action === 'approve';
  const r = await db.one(
    approve
      ? `UPDATE users SET status = 'active', identity_verified_at = now(), identity_verified_by = $2, identity_reject_reason = NULL WHERE id = $1 AND status = 'identity_review' RETURNING id, email, status`
      : `UPDATE users SET status = 'pending_identity', identity_reject_reason = $3, id_photo = NULL, selfie = NULL WHERE id = $1 AND status = 'identity_review' RETURNING id, email, status`,
    approve ? [id, req.user.id] : [id, req.user.id, req.body.reason || 'Photos could not be matched. Please retake them.']);
  if (!r) throw httpError(404, 'Not in review');
  await audit(req, { action: approve ? 'identity.approved' : 'identity.rejected', entity: 'user', entityId: id, after: r });
  await alerts.raise({ kind: 'identity_result', userId: id, audience: [], message: approve ? 'Your identity is verified. You can now check in.' : `Identity not verified: ${req.body.reason || ''}`,
    dedupeKey: `idres:${id}:${Date.now()}`, email: [r.email] });
  flash(req, 'success', approve ? 'Identity approved.' : 'Identity rejected; the rep was asked to retake photos.');
  res.redirect('/admin/identity');
});

// ---------- Users ----------
router.get('/admin/users', ops, async (req, res) => {
  const role = ROLES[req.query.role] ? req.query.role : null;
  const qtext = String(req.query.q || '').trim();
  const users = await db.many(`SELECT u.id, u.name, u.email, u.role, u.status, u.is_vendor_admin, u.last_login_at, s.name AS store_name, c.name AS company
      FROM users u LEFT JOIN stores s ON s.id = u.store_id LEFT JOIN vendor_companies c ON c.id = u.vendor_company_id
     WHERE ($1::text IS NULL OR u.role = $1) AND ($2 = '' OR u.email ILIKE '%' || $2 || '%' OR u.name ILIKE '%' || $2 || '%')
     ORDER BY u.created_at DESC LIMIT 300`, [role, qtext]);
  const stores = await db.many('SELECT id, store_number, name FROM stores WHERE active ORDER BY store_number');
  res.render('admin/users', { title: 'Users', users, stores, role, q: qtext });
});

router.post('/admin/users', ops, async (req, res) => {
  const email = normEmail(req.body.email);
  const role = req.body.role;
  if (!emailDomain(email)) throw httpError(400, 'Enter a valid email');
  if (!['receiver', 'store_manager', 'merchant', 'dsd_ops', 'admin'].includes(role)) throw httpError(400, 'Pick a staff role');
  if (role === 'admin' && req.user.role !== 'admin') throw httpError(403, 'Only administrators can create administrators');
  const storeId = ['receiver', 'store_manager'].includes(role) ? Number(req.body.store_id) || null : null;
  if (['receiver', 'store_manager'].includes(role) && !storeId) throw httpError(400, 'Store staff need a store');
  const temp = req.body.password && req.body.password.length >= 10 ? req.body.password : crypto.randomBytes(9).toString('base64url');
  const r = await db.one(
    `INSERT INTO users(email, name, phone, role, store_id, password_hash, status) VALUES ($1,$2,$3,$4,$5,$6,'active')
     ON CONFLICT (email) DO NOTHING RETURNING id, email, role, store_id`,
    [email, req.body.name || null, req.body.phone || null, role, storeId, await hashPassword(temp)]);
  if (!r) throw httpError(400, 'A user with that email already exists');
  await audit(req, { action: 'user.created', entity: 'user', entityId: r.id, storeId, after: r });
  flash(req, 'success', `User created. Temporary password: ${temp}  (share it securely; they can be given a new one here any time).`);
  res.redirect('/admin/users');
});

router.get('/admin/users/:id', ops, async (req, res) => {
  const u = await db.one(`SELECT u.id, u.name, u.email, u.phone, u.role, u.status, u.store_id, u.vendor_company_id, u.is_vendor_admin,
      u.identity_verified_at, u.last_login_at, u.created_at, (u.selfie IS NOT NULL) AS has_selfie, (u.id_photo IS NOT NULL) AS has_id_photo, c.name AS company
      FROM users u LEFT JOIN vendor_companies c ON c.id = u.vendor_company_id WHERE u.id = $1`, [intParam(req.params.id)]);
  if (!u) throw httpError(404, 'Not found');
  const stores = await db.many('SELECT id, store_number, name FROM stores WHERE active ORDER BY store_number');
  const visits = await db.many(`SELECT v.id, v.status, v.requested_at, v.store_id, s.name AS store_name, s.timezone FROM visits v JOIN stores s ON s.id = v.store_id WHERE v.user_id = $1 ORDER BY v.requested_at DESC LIMIT 20`, [u.id]);
  res.render('admin/user', { title: u.name || u.email, u, stores, visits });
});

router.post('/admin/users/:id', ops, async (req, res) => {
  const id = intParam(req.params.id);
  const before = await db.one('SELECT id, email, role, status, store_id, is_vendor_admin FROM users WHERE id = $1', [id]);
  if (!before) throw httpError(404, 'Not found');
  if (before.role === 'admin' && req.user.role !== 'admin') throw httpError(403, 'Only administrators can change administrators');
  const b = req.body;
  let after;
  if (b.action === 'reset_password') {
    const temp = crypto.randomBytes(9).toString('base64url');
    after = await db.one('UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id', [id, await hashPassword(temp)]);
    flash(req, 'success', `New temporary password: ${temp}`);
  } else if (['suspended', 'active', 'removed'].includes(b.action)) {
    if (b.action === 'active' && ['rep', 'field_service', 'visitor'].includes(before.role)) {
      after = await db.one(`UPDATE users SET status = CASE WHEN identity_verified_at IS NOT NULL THEN 'active' ELSE 'pending_identity' END WHERE id = $1 RETURNING id, status`, [id]);
    } else {
      after = await db.one('UPDATE users SET status = $2 WHERE id = $1 RETURNING id, status', [id, b.action]);
    }
    if (b.action !== 'active') await db.q(`DELETE FROM session WHERE (sess->>'userId')::int = $1`, [id]).catch(() => {});
    flash(req, 'success', 'Status updated.');
  } else {
    let role = ROLES[b.role] ? b.role : before.role;
    if (role === 'admin' && req.user.role !== 'admin') role = before.role;
    after = await db.one(
      `UPDATE users SET name = $2, phone = $3, role = $4, store_id = $5, is_vendor_admin = $6 WHERE id = $1
       RETURNING id, name, role, store_id, is_vendor_admin`,
      [id, b.name || null, b.phone || null, role, Number(b.store_id) || null, b.is_vendor_admin === 'on']);
    flash(req, 'success', 'User saved.');
  }
  await audit(req, { action: `user.${b.action || 'updated'}`, entity: 'user', entityId: id, before, after });
  res.redirect(`/admin/users/${id}`);
});

// ---------- Settings ----------
router.get('/admin/settings', ops, async (req, res) => {
  const rows = await db.many('SELECT key, value FROM settings');
  const settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const domains = await db.many('SELECT domain FROM blocked_email_domains ORDER BY domain');
  res.render('admin/settings', { title: 'Settings', settings, weights: { ...DEFAULT_WEIGHTS, ...(settings.service_score_weights || {}) }, domains: domains.map((d) => d.domain) });
});

router.post('/admin/settings', ops, async (req, res) => {
  const b = req.body;
  const before = await db.many('SELECT key, value FROM settings');
  const set = (k, v) => db.q(`INSERT INTO settings(key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, JSON.stringify(v)]);
  await set('retention_months', Math.max(1, Number(b.retention_months) || 18));
  await set('overstay_margin_min', Math.max(0, Number(b.overstay_margin_min) || 30));
  await set('max_company_override_days', Math.max(1, Math.min(90, Number(b.max_company_override_days) || 14)));
  await set('require_location', b.require_location === 'on');
  await set('service_score_weights', {
    frequency: Number(b.w_frequency) || 0, on_time: Number(b.w_on_time) || 0, dwell: Number(b.w_dwell) || 0, coverage: Number(b.w_coverage) || 0,
  });
  const domains = csvList(b.blocked_domains).map((d) => d.toLowerCase().replace(/^@/, ''));
  await db.tx(async (c) => {
    await c.query('DELETE FROM blocked_email_domains');
    for (const d of domains) await c.query('INSERT INTO blocked_email_domains(domain) VALUES ($1) ON CONFLICT DO NOTHING', [d]);
  });
  await audit(req, { action: 'settings.updated', entity: 'settings', before: { rows: before }, after: { body: { ...b, _csrf: undefined } } });
  flash(req, 'success', 'Settings saved.');
  res.redirect('/admin/settings');
});

// ---------- Audit trail + exports ----------
router.get('/admin/audit', ops, async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
  const storeId = Number(req.query.store) || null;
  const entity = req.query.entity || null;
  const limit = req.query.format === 'csv' ? 50000 : 300;
  const rows = await db.many(`
    SELECT a.*, s.name AS store_name FROM audit_events a LEFT JOIN stores s ON s.id = a.store_id
     WHERE a.at >= coalesce($1::date, current_date - 7) AND a.at < coalesce($2::date, current_date) + 1
       AND ($3::int IS NULL OR a.store_id = $3) AND ($4::text IS NULL OR a.entity = $4)
     ORDER BY a.at DESC LIMIT ${limit}`, [from, to, storeId, entity]);
  if (req.query.format === 'csv') {
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="audit-trail.csv"');
    return res.send(toCsv(rows, ['id', 'at', 'actor_email', 'action', 'entity', 'entity_id', 'store_name', 'before', 'after', 'ip']));
  }
  const stores = await db.many('SELECT id, store_number, name FROM stores ORDER BY store_number');
  res.render('admin/audit', { title: 'Audit trail', rows, stores, from: from || '', to: to || '', storeId, entity });
});

router.get('/admin/visits.csv', ops, async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
  const rows = await db.many(`
    SELECT v.id AS visit_id, s.store_number, s.name AS store, c.name AS company, u.name AS person, u.email, v.visit_type, v.source, v.method, v.status,
           v.requested_at, v.check_in_at, v.check_out_at,
           CASE WHEN v.status = 'checked_out' THEN round(extract(epoch FROM v.check_out_at - v.check_in_at) / 60) END AS dwell_min,
           array_to_string(v.hard_failures, '; ') AS hard_failures, array_to_string(v.soft_failures, '; ') AS soft_failures,
           v.override_scope, v.override_reason, ob.email AS override_by, (v.insurance_status->>'compliant') AS insurance_compliant,
           v.location_ok, v.check_in_distance_m, v.discrepancy, v.receiver_note, v.work_notes
      FROM visits v JOIN stores s ON s.id = v.store_id JOIN users u ON u.id = v.user_id
      LEFT JOIN vendor_companies c ON c.id = v.vendor_company_id LEFT JOIN users ob ON ob.id = v.override_by
     WHERE v.requested_at >= coalesce($1::date, current_date - 30) AND v.requested_at < coalesce($2::date, current_date) + 1
     ORDER BY v.requested_at`, [from, to]);
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="visits.csv"');
  res.send(toCsv(rows));
});

module.exports = router;
module.exports.COVERAGE_TYPES = COVERAGE_TYPES;

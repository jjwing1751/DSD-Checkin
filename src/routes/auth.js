const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const mail = require('../mail');
const alerts = require('../alerts');
const { audit } = require('../audit');
const {
  issueCode, verifyCode, checkPassword, normEmail, emailDomain, homePath, requireLogin, USER_COLS,
} = require('../auth');
const { flash, csvList } = require('../util');
const { VENDOR_ROLES } = require('../constants');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, limit: Number(process.env.LOGIN_RATE_LIMIT_PER_MIN || 30), standardHeaders: true, legacyHeaders: false });

// Until SMTP is configured the code can't be emailed, so it is shown on screen (with a warning).
// DEV_SHOW_CODES=true also shows it when email is configured, for testing.
const showCodes = () => !mail.enabled() || /^(true|1|yes|on)$/i.test(String(process.env.DEV_SHOW_CODES || '').trim());

function safeNext(n) {
  return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : null;
}

async function companyForDomain(domain) {
  return db.one(`SELECT * FROM vendor_companies WHERE $1 = ANY(email_domains) ORDER BY (status = 'active') DESC, id LIMIT 1`, [domain]);
}

async function startSession(req, user) {
  await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
  req.session.userId = user.id;
  await db.q('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(homePath(req.user));
  res.render('login', { title: 'Sign in', next: safeNext(req.query.next) || '', step: 'email', email: '', error: null, devCode: null });
});

// Vendors and visitors: company email + one-time code (also the self-enrollment path).
router.post('/login/code', limiter, async (req, res) => {
  const email = normEmail(req.body.email);
  const next = safeNext(req.body.next) || '';
  const domain = emailDomain(email);
  const render = (error) => res.status(400).render('login', { title: 'Sign in', next, step: 'email', email, error, devCode: null });
  if (!domain) return render('Enter a valid email address.');

  const existing = await db.one('SELECT id, role, status, password_hash FROM users WHERE email = $1', [email]);
  if (existing && !VENDOR_ROLES.includes(existing.role)) {
    return res.render('login', { title: 'Sign in', next, step: 'password', email, error: null, devCode: null });
  }
  if (existing && ['suspended', 'removed'].includes(existing.status)) {
    return render('This account is not active. Contact your company admin.');
  }
  if (!existing) {
    const blocked = await db.one('SELECT 1 FROM blocked_email_domains WHERE domain = $1', [domain]);
    if (blocked) return render('Use your company email address. Personal addresses (Gmail, Yahoo, Outlook and similar) cannot be used.');
    const company = await companyForDomain(domain);
    if (company && company.status === 'suspended') return render('Your company is not currently approved for store access.');
  }
  const recent = await db.one(`SELECT count(*)::int AS n FROM login_codes WHERE email = $1 AND created_at > now() - interval '1 hour'`, [email]);
  if (recent.n >= 6) return render('Too many codes requested. Try again in an hour.');

  const code = await issueCode(email);
  await mail.send({ to: email, subject: 'Your store check-in code', text: `Your sign-in code is ${code}. It expires in 10 minutes.` });
  req.session.pendingEmail = email;
  res.render('login', { title: 'Enter code', next, step: 'code', email, error: null, devCode: showCodes() ? code : null });
});

router.post('/login/verify', limiter, async (req, res) => {
  const email = req.session.pendingEmail;
  const next = safeNext(req.body.next) || '';
  if (!email) return res.redirect('/login');
  const ok = await verifyCode(email, req.body.code || '');
  if (!ok) {
    return res.status(400).render('login', { title: 'Enter code', next, step: 'code', email, error: 'That code is wrong or expired.', devCode: null });
  }
  delete req.session.pendingEmail;
  const user = await db.one(`SELECT ${USER_COLS} FROM users WHERE email = $1`, [email]);
  if (!user) {
    // New enrollment: email is verified, collect details next.
    req.session.enrollEmail = email;
    req.session.enrollNext = next;
    return res.redirect('/enroll');
  }
  await startSession(req, user);
  await audit(req, { action: 'login', entity: 'user', entityId: user.id });
  res.redirect(next || homePath(user));
});

// Store and HQ staff: email + password (SSO is a later phase).
router.post('/login/password', limiter, async (req, res) => {
  const email = normEmail(req.body.email);
  const next = safeNext(req.body.next) || '';
  const row = await db.one('SELECT id, password_hash, status FROM users WHERE email = $1', [email]);
  if (!row || row.status !== 'active' || !(await checkPassword(req.body.password || '', row.password_hash))) {
    return res.status(400).render('login', { title: 'Sign in', next, step: 'password', email, error: 'Email or password is wrong.', devCode: null });
  }
  const user = await db.one(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [row.id]);
  await startSession(req, user);
  await audit(req, { action: 'login', entity: 'user', entityId: user.id });
  res.redirect(next || homePath(user));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/enroll', async (req, res) => {
  const email = req.session.enrollEmail;
  if (!email) return res.redirect('/login');
  const company = await companyForDomain(emailDomain(email));
  res.render('enroll', { title: 'Create your account', email, company, error: null, form: {} });
});

router.post('/enroll', async (req, res) => {
  const email = req.session.enrollEmail;
  if (!email) return res.redirect('/login');
  const domain = emailDomain(email);
  let company = await companyForDomain(domain);
  const form = req.body;
  const name = String(form.name || '').trim();
  const phone = String(form.phone || '').trim();
  const role = ['rep', 'field_service'].includes(form.role) ? form.role : 'rep';
  if (!name) return res.status(400).render('enroll', { title: 'Create your account', email, company, error: 'Enter your full name.', form });
  if (!company && !String(form.company_name || '').trim()) {
    return res.status(400).render('enroll', { title: 'Create your account', email, company, error: 'Enter your company name.', form });
  }
  if (company && company.status === 'suspended') {
    return res.status(400).render('enroll', { title: 'Create your account', email, company, error: 'Your company is not approved for store access.', form });
  }

  let firstForCompany = false;
  const user = await db.tx(async (c) => {
    if (!company) {
      const r = await c.query(
        `INSERT INTO vendor_companies(name, vendor_number, email_domains, categories, delivers_by_vehicle, status, requested_by_email)
         VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING *`,
        [String(form.company_name).trim(), form.vendor_number || null, [domain], csvList(form.categories), form.delivers_by_vehicle === 'on', email]
      );
      company = r.rows[0];
      firstForCompany = true;
      await audit(req, { action: 'vendor_company.requested', entity: 'vendor_company', entityId: company.id, after: company }, c);
    }
    const existingReps = await c.query('SELECT count(*)::int AS n FROM users WHERE vendor_company_id = $1', [company.id]);
    const r = await c.query(
      `INSERT INTO users(email, name, phone, role, vendor_company_id, is_vendor_admin, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending_identity') RETURNING id, email, name, role, vendor_company_id, status`,
      [email, name, phone, role, company.id, firstForCompany || existingReps.rows[0].n === 0]
    );
    await audit(req, { action: 'user.enrolled', entity: 'user', entityId: r.rows[0].id, after: r.rows[0] }, c);
    return r.rows[0];
  });
  if (firstForCompany) {
    await alerts.raise({
      kind: 'vendor_request', severity: 'info', vendorCompanyId: company.id, audience: ['dsd_ops'],
      message: `New vendor company request: ${company.name} (${domain}) from ${email}.`, dedupeKey: `vendor-req:${company.id}`,
      email: await alerts.emailsFor({ roles: ['dsd_ops'] }),
    });
  }
  const next = req.session.enrollNext;
  delete req.session.enrollEmail;
  delete req.session.enrollNext;
  await startSession(req, user);
  if (next) req.session.afterIdentity = next;
  flash(req, 'success', 'Account created. Next, verify your identity.');
  res.redirect('/rep/identity');
});

router.get('/account', requireLogin, (req, res) => res.redirect(homePath(req.user)));

module.exports = router;

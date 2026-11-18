const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { STORE_ROLES, VENDOR_ROLES } = require('./constants');

const USER_COLS = `id, email, name, phone, role, vendor_company_id, store_id, is_vendor_admin, status,
  identity_verified_at, identity_submitted_at, identity_reject_reason, (id_photo IS NOT NULL) AS has_id_photo, (selfie IS NOT NULL) AS has_selfie`;

async function loadUser(req, res, next) {
  req.user = null;
  if (req.session && req.session.userId) {
    const u = await db.one(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [req.session.userId]);
    if (u && !['suspended', 'removed'].includes(u.status)) req.user = u;
    else req.session.userId = null;
  }
  res.locals.user = req.user;
  next();
}

function homePath(user) {
  if (!user) return '/login';
  if (VENDOR_ROLES.includes(user.role)) return '/rep';
  if (STORE_ROLES.includes(user.role)) return user.store_id ? `/store/${user.store_id}` : '/stores';
  if (user.role === 'merchant') return '/merchant';
  return '/admin';
}

function requireLogin(req, res, next) {
  if (!req.user) {
    const nextUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/login?next=${nextUrl}`);
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return requireLogin(req, res, next);
    if (req.user.role === 'admin' || roles.includes(req.user.role)) return next();
    res.status(403).render('error', { title: 'Not allowed', message: 'Your role does not have access to this page.' });
  };
}

// Store staff only see their own store; HQ roles see all.
function canSeeStore(user, storeId) {
  if (!user) return false;
  if (['admin', 'dsd_ops', 'merchant'].includes(user.role)) return true;
  if (STORE_ROLES.includes(user.role)) return user.store_id === Number(storeId);
  return false;
}

// --- CSRF: per-session token, checked on every non-GET form post.
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Multipart bodies are parsed later by multer; those routes call verifyCsrf after upload.
  if (req.is('multipart/form-data')) return next();
  return verifyCsrf(req, res, next);
}

function verifyCsrf(req, res, next) {
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
  if (!token || token.length !== req.session.csrf.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf))) {
    return res.status(403).render('error', { title: 'Form expired', message: 'Please go back, reload the page and try again.' });
  }
  next();
}

// --- One-time codes for passwordless rep sign-in.
function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function hashCode(email, code) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret').update(`${email}:${code}`).digest('hex');
}
async function issueCode(email) {
  const code = newCode();
  await db.q(`INSERT INTO login_codes(email, code_hash, expires_at) VALUES ($1,$2, now() + interval '10 minutes')`, [email, hashCode(email, code)]);
  return code;
}
async function verifyCode(email, code) {
  const row = await db.one(
    `SELECT * FROM login_codes WHERE email = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    [email]
  );
  if (!row) return false;
  if (row.attempts >= 5) return false;
  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hashCode(email, String(code).trim())));
  if (ok) await db.q('UPDATE login_codes SET used_at = now() WHERE id = $1', [row.id]);
  else await db.q('UPDATE login_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
  return ok;
}

async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}
async function checkPassword(pw, hash) {
  if (!hash) return false;
  return bcrypt.compare(pw, hash);
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}
function emailDomain(e) {
  const m = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/.exec(normEmail(e));
  return m ? m[1] : null;
}

module.exports = {
  loadUser, requireLogin, requireRole, canSeeStore, homePath, csrf, verifyCsrf,
  issueCode, verifyCode, hashPassword, checkPassword, normEmail, emailDomain, USER_COLS,
};

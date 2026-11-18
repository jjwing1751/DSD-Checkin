// Serves stored images and documents with role checks. Nothing is public.
const express = require('express');
const db = require('../db');
const { requireLogin, canSeeStore } = require('../auth');
const { intParam, httpError } = require('../util');

const router = express.Router();
const HQ = ['admin', 'dsd_ops'];

function send(res, data, mime, name) {
  if (!data) throw httpError(404, 'File not found');
  res.set('Content-Type', mime || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=300');
  res.set('X-Content-Type-Options', 'nosniff');
  if (name) res.set('Content-Disposition', `inline; filename="${String(name).replace(/[^\w.\- ]/g, '_')}"`);
  res.send(data);
}

// Verified selfie: the face receivers check at the backdoor.
router.get('/files/user/:id/selfie', requireLogin, async (req, res) => {
  const id = intParam(req.params.id);
  const me = req.user;
  let allowed = me.id === id || [...HQ, 'merchant'].includes(me.role);
  if (!allowed && ['receiver', 'store_manager'].includes(me.role)) {
    allowed = Boolean(await db.one('SELECT 1 FROM visits WHERE user_id = $1 AND store_id = $2 LIMIT 1', [id, me.store_id]));
  }
  if (!allowed && me.is_vendor_admin) {
    allowed = Boolean(await db.one('SELECT 1 FROM users WHERE id = $1 AND vendor_company_id = $2', [id, me.vendor_company_id]));
  }
  if (!allowed) throw httpError(403, 'Not allowed');
  const u = await db.one('SELECT selfie, selfie_type FROM users WHERE id = $1', [id]);
  send(res, u && u.selfie, u && u.selfie_type);
});

// Government ID image: DSD ops only (and the person themselves).
router.get('/files/user/:id/id-photo', requireLogin, async (req, res) => {
  const id = intParam(req.params.id);
  if (!(req.user.id === id || HQ.includes(req.user.role))) throw httpError(403, 'Not allowed');
  const u = await db.one('SELECT id_photo, id_photo_type FROM users WHERE id = $1', [id]);
  send(res, u && u.id_photo, u && u.id_photo_type);
});

router.get('/files/policy/:id', requireLogin, async (req, res) => {
  const p = await db.one('SELECT vendor_company_id, doc, doc_type, doc_name FROM insurance_policies WHERE id = $1', [intParam(req.params.id)]);
  if (!p) throw httpError(404, 'Not found');
  const me = req.user;
  if (!(HQ.includes(me.role) || (me.is_vendor_admin && me.vendor_company_id === p.vendor_company_id))) throw httpError(403, 'Not allowed');
  send(res, p.doc, p.doc_type, p.doc_name);
});

router.get('/files/credential/:id', requireLogin, async (req, res) => {
  const c = await db.one(
    `SELECT cr.user_id, coalesce(cr.vendor_company_id, u.vendor_company_id) AS company_id, cr.doc, cr.doc_type, cr.doc_name
       FROM credentials cr LEFT JOIN users u ON u.id = cr.user_id WHERE cr.id = $1`, [intParam(req.params.id)]);
  if (!c) throw httpError(404, 'Not found');
  const me = req.user;
  if (!(HQ.includes(me.role) || me.id === c.user_id || (me.is_vendor_admin && me.vendor_company_id === c.company_id))) throw httpError(403, 'Not allowed');
  send(res, c.doc, c.doc_type, c.doc_name);
});

router.get('/files/visit-photo/:id', requireLogin, async (req, res) => {
  const p = await db.one(
    `SELECT ph.data, ph.mime, v.user_id, v.store_id, v.vendor_company_id
       FROM visit_photos ph JOIN visits v ON v.id = ph.visit_id WHERE ph.id = $1`, [intParam(req.params.id)]);
  if (!p) throw httpError(404, 'Not found');
  const me = req.user;
  const ok = me.id === p.user_id || canSeeStore(me, p.store_id) || (me.is_vendor_admin && me.vendor_company_id === p.vendor_company_id);
  if (!ok) throw httpError(403, 'Not allowed');
  send(res, p.data, p.mime);
});

module.exports = router;

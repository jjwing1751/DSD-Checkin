// HQ merchant team: agreed service schedules and the vendor compliance report.
const express = require('express');
const db = require('../db');
const { audit } = require('../audit');
const { requireRole } = require('../auth');
const { flash, intParam, httpError, toArray, toCsv } = require('../util');
const { vendorCompliance } = require('../metrics');
const { generateExpectedVisits } = require('../jobs');
const { VISIT_TYPES } = require('../constants');

const router = express.Router();
const merch = requireRole('merchant', 'dsd_ops');
const merchEdit = requireRole('merchant'); // merchant team owns schedules (admin always allowed)

router.get('/merchant', merch, async (req, res) => {
  const vendorId = Number(req.query.vendor) || null;
  const storeId = Number(req.query.store) || null;
  const agreements = await db.many(`
    SELECT a.*, c.name AS vendor_name, s.name AS store_name, s.store_number
      FROM service_agreements a JOIN vendor_companies c ON c.id = a.vendor_company_id JOIN stores s ON s.id = a.store_id
     WHERE ($1::int IS NULL OR a.vendor_company_id = $1) AND ($2::int IS NULL OR a.store_id = $2)
     ORDER BY a.active DESC, c.name, s.store_number, a.window_start LIMIT 1000`, [vendorId, storeId]);
  const vendors = await db.many(`SELECT id, name, status FROM vendor_companies WHERE status <> 'suspended' ORDER BY name`);
  const stores = await db.many(`SELECT id, store_number, name, region FROM stores WHERE active ORDER BY store_number`);
  res.render('merchant/agreements', { title: 'Service schedules', agreements, vendors, stores, vendorId, storeId });
});

function parseAgreement(body) {
  const days = toArray(body.days).map(Number).filter((d) => d >= 0 && d <= 6);
  if (!days.length) throw httpError(400, 'Pick at least one day');
  if (!/^\d{2}:\d{2}/.test(body.window_start || '') || !/^\d{2}:\d{2}/.test(body.window_end || '')) throw httpError(400, 'Enter a visit window');
  if (body.window_end <= body.window_start) throw httpError(400, 'Window end must be after start');
  return {
    vendor_company_id: Number(body.vendor_company_id),
    category: String(body.category || '').trim() || null,
    visit_type: VISIT_TYPES[body.visit_type] ? body.visit_type : 'delivery',
    days_of_week: [...new Set(days)].sort(),
    window_start: body.window_start,
    window_end: body.window_end,
    expected_dwell_min: Math.max(5, Math.min(600, Number(body.expected_dwell_min) || 30)),
    min_visits_per_week: Number(body.min_visits_per_week) || null,
    effective_from: /^\d{4}-\d{2}-\d{2}$/.test(body.effective_from || '') ? body.effective_from : new Date().toISOString().slice(0, 10),
    effective_to: /^\d{4}-\d{2}-\d{2}$/.test(body.effective_to || '') ? body.effective_to : null,
  };
}

// Clears not-yet-acted-on future expected visits so they regenerate from the current schedule.
async function resetFuture(agreementId) {
  await db.q(`DELETE FROM expected_visits WHERE agreement_id = $1 AND visit_date >= current_date AND status = 'expected' AND visit_id IS NULL`, [agreementId]);
}

// One agreement row per selected store ("store group" = multi-select).
router.post('/merchant/agreements', merchEdit, async (req, res) => {
  const a = parseAgreement(req.body);
  const storeIds = toArray(req.body.store_ids).map(Number).filter(Boolean);
  if (!storeIds.length) throw httpError(400, 'Pick at least one store');
  if (!(await db.one('SELECT 1 FROM vendor_companies WHERE id = $1', [a.vendor_company_id]))) throw httpError(400, 'Pick a vendor');
  for (const sid of storeIds) {
    const r = await db.one(
      `INSERT INTO service_agreements(vendor_company_id, store_id, category, visit_type, days_of_week, window_start, window_end,
                                      expected_dwell_min, min_visits_per_week, effective_from, effective_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [a.vendor_company_id, sid, a.category, a.visit_type, a.days_of_week, a.window_start, a.window_end, a.expected_dwell_min,
        a.min_visits_per_week, a.effective_from, a.effective_to, req.user.id]);
    await audit(req, { action: 'agreement.created', entity: 'service_agreement', entityId: r.id, storeId: sid, after: r });
  }
  await generateExpectedVisits();
  flash(req, 'success', `Schedule saved for ${storeIds.length} store${storeIds.length > 1 ? 's' : ''}.`);
  res.redirect(`/merchant?vendor=${a.vendor_company_id}`);
});

router.get('/merchant/agreements/:id', merch, async (req, res) => {
  const a = await db.one(`SELECT a.*, c.name AS vendor_name, s.name AS store_name FROM service_agreements a
      JOIN vendor_companies c ON c.id = a.vendor_company_id JOIN stores s ON s.id = a.store_id WHERE a.id = $1`, [intParam(req.params.id)]);
  if (!a) throw httpError(404, 'Not found');
  const upcoming = await db.many(`SELECT * FROM expected_visits WHERE agreement_id = $1 AND visit_date >= current_date - 14 ORDER BY visit_date LIMIT 40`, [a.id]);
  res.render('merchant/agreement', { title: 'Edit schedule', a, upcoming });
});

router.post('/merchant/agreements/:id', merchEdit, async (req, res) => {
  const id = intParam(req.params.id);
  const before = await db.one('SELECT * FROM service_agreements WHERE id = $1', [id]);
  if (!before) throw httpError(404, 'Not found');
  if (req.body.action === 'deactivate' || req.body.action === 'activate') {
    const after = await db.one('UPDATE service_agreements SET active = $2 WHERE id = $1 RETURNING *', [id, req.body.action === 'activate']);
    await resetFuture(id);
    await audit(req, { action: `agreement.${req.body.action}d`, entity: 'service_agreement', entityId: id, storeId: before.store_id, before, after });
  } else {
    const a = parseAgreement({ ...req.body, vendor_company_id: before.vendor_company_id });
    const after = await db.one(
      `UPDATE service_agreements SET category = $2, visit_type = $3, days_of_week = $4, window_start = $5, window_end = $6,
              expected_dwell_min = $7, min_visits_per_week = $8, effective_from = $9, effective_to = $10 WHERE id = $1 RETURNING *`,
      [id, a.category, a.visit_type, a.days_of_week, a.window_start, a.window_end, a.expected_dwell_min, a.min_visits_per_week, a.effective_from, a.effective_to]);
    await resetFuture(id);
    await audit(req, { action: 'agreement.updated', entity: 'service_agreement', entityId: id, storeId: before.store_id, before, after });
  }
  await generateExpectedVisits();
  flash(req, 'success', 'Schedule updated. Upcoming expected visits were regenerated.');
  res.redirect(`/merchant/agreements/${id}`);
});

function weekRange(q) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : new Date(Date.parse(to) - 6 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

router.get('/merchant/compliance', merch, async (req, res) => {
  const { from, to } = weekRange(req.query);
  const storeId = Number(req.query.store) || null;
  const { rows, weights } = await vendorCompliance({ from, to, storeId });
  if (req.query.format === 'csv') {
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="vendor-compliance-${from}-to-${to}.csv"`);
    return res.send(toCsv(rows));
  }
  const stores = await db.many('SELECT id, store_number, name FROM stores WHERE active ORDER BY store_number');
  res.render('merchant/compliance', { title: 'Vendor compliance', rows, weights, from, to, stores, storeId });
});

module.exports = router;

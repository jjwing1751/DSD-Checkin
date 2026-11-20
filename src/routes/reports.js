// Check-in / check-out reporting for HQ: visit log and roll-ups by store, day, month.
const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');
const { toCsv } = require('../util');

const router = express.Router();
const hq = requireRole('dsd_ops', 'merchant');

const GROUPS = {
  day: { label: 'Day', keys: ['d'], cols: ['day'] },
  month: { label: 'Month', keys: ["date_trunc('month', d)::date"], cols: ['month'] },
  store: { label: 'Store', keys: ['store_id'], cols: ['store'] },
  store_day: { label: 'Store by day', keys: ['store_id', 'd'], cols: ['store', 'day'] },
  store_month: { label: 'Store by month', keys: ['store_id', "date_trunc('month', d)::date"], cols: ['store', 'month'] },
  vendor: { label: 'Vendor', keys: ['vendor_company_id'], cols: ['vendor'] },
};

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

function filters(q) {
  const today = new Date().toISOString().slice(0, 10);
  const to = isDate(q.to) ? q.to : today;
  const from = isDate(q.from) ? q.from : new Date(Date.parse(to) - 29 * 86400000).toISOString().slice(0, 10);
  return {
    from, to,
    store: Number(q.store) || null,
    vendor: Number(q.vendor) || null,
    region: q.region ? String(q.region) : null,
  };
}

// One row per visit attempt, with its local date at the store.
const BASE = `
  SELECT v.*, s.store_number, s.name AS store_name, s.region, s.timezone,
         (coalesce(v.check_in_at, v.requested_at) AT TIME ZONE s.timezone)::date AS d
    FROM visits v JOIN stores s ON s.id = v.store_id
   WHERE v.status IN ('checked_in','checked_out','auto_closed','blocked')
     AND (coalesce(v.check_in_at, v.requested_at) AT TIME ZONE s.timezone)::date BETWEEN $1::date AND $2::date
     AND ($3::int IS NULL OR v.store_id = $3) AND ($4::int IS NULL OR v.vendor_company_id = $4) AND ($5::text IS NULL OR s.region = $5)`;

const METRICS = `
  count(*) FILTER (WHERE status <> 'blocked')::int AS check_ins,
  count(*) FILTER (WHERE status = 'checked_out')::int AS check_outs,
  count(*) FILTER (WHERE status = 'checked_in')::int AS in_store,
  count(*) FILTER (WHERE status = 'auto_closed')::int AS no_check_out,
  count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
  count(*) FILTER (WHERE status <> 'blocked' AND cardinality(soft_failures) > 0)::int AS warnings,
  count(DISTINCT vendor_company_id) FILTER (WHERE status <> 'blocked')::int AS vendors,
  count(DISTINCT user_id) FILTER (WHERE status <> 'blocked')::int AS reps,
  count(DISTINCT store_id) FILTER (WHERE status <> 'blocked')::int AS stores,
  round(avg(extract(epoch FROM check_out_at - check_in_at) / 60) FILTER (WHERE status = 'checked_out'))::int AS avg_dwell_min`;

router.get('/reports', hq, async (req, res) => {
  const f = filters(req.query);
  const group = GROUPS[req.query.group] ? req.query.group : 'day';
  const g = GROUPS[group];
  const params = [f.from, f.to, f.store, f.vendor, f.region];
  const rows = await db.many(`
    WITH b AS (${BASE})
    SELECT ${g.keys.map((k, i) => `${k} AS k${i}`).join(', ')}, ${METRICS}
      FROM b GROUP BY ${g.keys.map((k, i) => i + 1).join(', ')} ORDER BY ${g.keys.map((k, i) => i + 1).join(', ')}`, params);
  const total = await db.one(`WITH b AS (${BASE}) SELECT ${METRICS}, count(DISTINCT d)::int AS days FROM b`, params);
  const stores = await db.many('SELECT id, store_number, name, region FROM stores ORDER BY store_number');
  const vendors = await db.many('SELECT id, name FROM vendor_companies ORDER BY name');
  const regions = [...new Set(stores.map((s) => s.region).filter(Boolean))].sort();
  const storeById = Object.fromEntries(stores.map((s) => [s.id, s]));
  const vendorById = Object.fromEntries(vendors.map((v) => [v.id, v]));

  const label = (col, val) => {
    if (col === 'store') { const s = storeById[val]; return s ? `#${s.store_number} ${s.name}` : '—'; }
    if (col === 'vendor') { const v = vendorById[val]; return v ? v.name : 'Visitor (no company)'; }
    if (col === 'month') return new Date(`${val}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    return new Date(`${val}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  };
  const out = rows.map((r) => ({
    ...r,
    labels: g.cols.map((c, i) => label(c, r[`k${i}`])),
    keys: g.cols.map((c, i) => r[`k${i}`]),
  }));

  if (req.query.format === 'csv') {
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="checkins-by-${group}-${f.from}-to-${f.to}.csv"`);
    const csvRows = out.map((r) => {
      const o = {};
      g.cols.forEach((c, i) => { o[c] = c === 'store' ? storeById[r.keys[i]]?.store_number : c === 'vendor' ? r.labels[i] : r.keys[i]; });
      if (g.cols.includes('store')) o.store_name = storeById[r.keys[g.cols.indexOf('store')]]?.name;
      for (const k of ['check_ins', 'check_outs', 'in_store', 'no_check_out', 'blocked', 'warnings', 'vendors', 'reps', 'stores', 'avg_dwell_min']) o[k] = r[k];
      return o;
    });
    return res.send(toCsv(csvRows));
  }

  const max = Math.max(1, ...out.map((r) => r.check_ins));
  res.render('reports/index', {
    title: 'Check-in reports', wide: true, f, group, groups: GROUPS, g, rows: out, total, max, stores, vendors, regions,
    query: new URLSearchParams(Object.entries({ ...req.query, format: '' }).filter(([k, v]) => v && k !== 'format')).toString(),
  });
});

// Visit log: every check-in and check-out, filterable, with CSV.
router.get('/reports/visits', hq, async (req, res) => {
  const f = filters(req.query);
  const status = ['checked_in', 'checked_out', 'auto_closed', 'blocked'].includes(req.query.status) ? req.query.status : null;
  const csv = req.query.format === 'csv';
  const rows = await db.many(`
    WITH b AS (${BASE})
    SELECT b.id, b.d, b.store_id, b.store_number, b.store_name, b.timezone, b.status, b.visit_type, b.source, b.check_in_at, b.check_out_at, b.requested_at,
           b.hard_failures, b.soft_failures, b.override_reason, b.location_ok,
           CASE WHEN b.status = 'checked_out' THEN round(extract(epoch FROM b.check_out_at - b.check_in_at) / 60)::int END AS dwell_min,
           c.name AS vendor, u.name AS rep, u.email AS rep_email
      FROM b JOIN users u ON u.id = b.user_id LEFT JOIN vendor_companies c ON c.id = b.vendor_company_id
     WHERE ($6::text IS NULL OR b.status = $6)
     ORDER BY coalesce(b.check_in_at, b.requested_at) DESC
     LIMIT ${csv ? 100000 : 500}`, [f.from, f.to, f.store, f.vendor, f.region, status]);
  if (csv) {
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="visits-${f.from}-to-${f.to}.csv"`);
    return res.send(toCsv(rows.map((v) => ({
      visit_id: v.id, date: v.d, store_number: v.store_number, store: v.store_name, vendor: v.vendor, rep: v.rep, rep_email: v.rep_email,
      visit_type: v.visit_type, scheduled: v.source === 'scheduled', status: v.status, check_in_at: v.check_in_at, check_out_at: v.check_out_at,
      dwell_min: v.dwell_min, blocked_reason: v.hard_failures.join('; '), warnings: v.soft_failures.join('; '),
    }))));
  }
  const stores = await db.many('SELECT id, store_number, name, region FROM stores ORDER BY store_number');
  const vendors = await db.many('SELECT id, name FROM vendor_companies ORDER BY name');
  const regions = [...new Set(stores.map((s) => s.region).filter(Boolean))].sort();
  res.render('reports/visits', {
    title: 'Visit log', wide: true, f, status, rows, stores, vendors, regions,
    query: new URLSearchParams(Object.entries(req.query).filter(([k, v]) => v && k !== 'format')).toString(),
  });
});

module.exports = router;

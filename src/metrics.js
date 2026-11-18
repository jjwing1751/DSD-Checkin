// Schedule-compliance metrics and the weighted Service Score (per vendor, for a date range).
const db = require('./db');

const DEFAULT_WEIGHTS = { frequency: 30, on_time: 25, dwell: 25, coverage: 20 };

async function weights() {
  const r = await db.one(`SELECT value FROM settings WHERE key = 'service_score_weights'`);
  return { ...DEFAULT_WEIGHTS, ...(r ? r.value : {}) };
}

const pct = (n, d) => (d ? n / d : null);

async function vendorCompliance({ from, to, vendorCompanyId, storeId }) {
  const params = [from, to, vendorCompanyId || null, storeId || null];
  const expected = await db.many(`
    SELECT e.id, e.vendor_company_id, e.store_id, e.visit_date, e.window_start, e.window_end, e.expected_dwell_min, e.status,
           e.announced_at, e.created_at, v.check_in_at, v.check_out_at, v.status AS visit_status, s.timezone,
           ((v.check_in_at AT TIME ZONE s.timezone)::time) AS check_in_local
      FROM expected_visits e JOIN stores s ON s.id = e.store_id LEFT JOIN visits v ON v.id = e.visit_id
     WHERE e.agreement_id IS NOT NULL AND e.visit_date BETWEEN $1 AND $2
       AND e.visit_date <= (now() AT TIME ZONE s.timezone)::date
       AND ($3::int IS NULL OR e.vendor_company_id = $3) AND ($4::int IS NULL OR e.store_id = $4)`, params);
  const visits = await db.many(`
    SELECT v.id, v.vendor_company_id, v.store_id, v.status, v.check_in_at, v.check_out_at, v.hard_failures, v.soft_failures,
           v.override_reason, v.expected_visit_id, e.expected_dwell_min, e.announced_at, e.visit_date,
           EXISTS (SELECT 1 FROM work_items w WHERE w.visit_id = v.id) OR EXISTS (SELECT 1 FROM visit_photos p WHERE p.visit_id = v.id) AS has_proof
      FROM visits v JOIN stores s ON s.id = v.store_id LEFT JOIN expected_visits e ON e.id = v.expected_visit_id
     WHERE v.vendor_company_id IS NOT NULL AND v.status IN ('checked_in','checked_out','auto_closed')
       AND (v.check_in_at AT TIME ZONE s.timezone)::date BETWEEN $1 AND $2
       AND ($3::int IS NULL OR v.vendor_company_id = $3) AND ($4::int IS NULL OR v.store_id = $4)`, params);
  const agreements = await db.many(`
    SELECT a.vendor_company_id, a.store_id, coalesce(a.min_visits_per_week, cardinality(a.days_of_week)) AS min_week
      FROM service_agreements a
     WHERE a.active AND a.effective_from <= $2 AND (a.effective_to IS NULL OR a.effective_to >= $1)
       AND ($3::int IS NULL OR a.vendor_company_id = $3) AND ($4::int IS NULL OR a.store_id = $4)`, params);
  const companies = await db.many('SELECT id, name FROM vendor_companies');
  const names = Object.fromEntries(companies.map((c) => [c.id, c.name]));
  const W = await weights();
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
  const weeksInRange = days / 7;

  const byVendor = {};
  const get = (id) => (byVendor[id] ||= { vendor_company_id: id, vendor: names[id] || `#${id}`, exp: [], vis: [], agr: [] });
  expected.forEach((e) => get(e.vendor_company_id).exp.push(e));
  visits.forEach((v) => get(v.vendor_company_id).vis.push(v));
  agreements.forEach((a) => get(a.vendor_company_id).agr.push(a));

  const rows = Object.values(byVendor).map((g) => {
    const scheduled = g.exp.length;
    const completedExp = g.exp.filter((e) => e.check_in_at && ['checked_in', 'checked_out', 'auto_closed'].includes(e.visit_status));
    const onTime = completedExp.filter((e) => e.check_in_local >= e.window_start && e.check_in_local <= e.window_end).length;
    const missed = g.exp.filter((e) => e.status === 'missed').length;
    const dwellVisits = g.vis.filter((v) => v.status === 'checked_out' && v.check_out_at && v.expected_dwell_min);
    const ratios = dwellVisits.map((v) => (v.check_out_at - v.check_in_at) / 60000 / v.expected_dwell_min);
    const avgDwellRatio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
    const underHalf = ratios.filter((r) => r < 0.5).length;
    const allDwell = g.vis.filter((v) => v.status === 'checked_out' && v.check_out_at).map((v) => (v.check_out_at - v.check_in_at) / 60000);
    const storeTargets = {};
    g.agr.forEach((a) => { storeTargets[a.store_id] = (storeTargets[a.store_id] || 0) + Number(a.min_week); });
    const visitsByStore = {};
    g.vis.forEach((v) => { visitsByStore[v.store_id] = (visitsByStore[v.store_id] || 0) + 1; });
    const storesInAgreement = Object.keys(storeTargets).length;
    const covered = Object.entries(storeTargets).filter(([sid, min]) => (visitsByStore[sid] || 0) >= min * weeksInRange).length;
    const proof = g.vis.filter((v) => v.has_proof).length;
    const credOk = g.vis.filter((v) => !v.hard_failures.length && !v.soft_failures.length).length;
    const overrides = g.vis.filter((v) => v.override_reason).length;
    const advance = g.vis.filter((v) => v.announced_at && v.check_in_at - v.announced_at >= 24 * 3600 * 1000).length;
    const noCheckout = g.vis.filter((v) => v.status === 'auto_closed').length;

    const m = {
      vendor_company_id: g.vendor_company_id,
      vendor: g.vendor,
      scheduled,
      completed: completedExp.length,
      visits: g.vis.length,
      unscheduled: g.vis.filter((v) => !v.expected_visit_id).length,
      frequency: pct(completedExp.length, scheduled),
      on_time: pct(onTime, completedExp.length),
      missed_rate: pct(missed, scheduled),
      missed,
      avg_dwell_min: allDwell.length ? Math.round(allDwell.reduce((a, b) => a + b, 0) / allDwell.length) : null,
      dwell_ratio: avgDwellRatio,
      dwell_under_half: pct(underHalf, ratios.length),
      coverage: pct(covered, storesInAgreement),
      stores_in_agreement: storesInAgreement,
      work_proof: pct(proof, g.vis.length),
      credential_compliance: pct(credOk, g.vis.length),
      overrides,
      advance_notice: pct(advance, g.vis.length),
      no_checkout: noCheckout,
    };
    const parts = [
      ['frequency', m.frequency],
      ['on_time', m.on_time],
      ['dwell', m.dwell_ratio == null ? null : Math.min(1, m.dwell_ratio)],
      ['coverage', m.coverage],
    ].filter(([, v]) => v != null);
    const wsum = parts.reduce((a, [k]) => a + Number(W[k] || 0), 0);
    m.service_score = wsum ? Math.round((parts.reduce((a, [k, v]) => a + v * Number(W[k] || 0), 0) / wsum) * 100) : null;
    return m;
  });
  rows.sort((a, b) => (a.service_score ?? 101) - (b.service_score ?? 101));
  return { rows, weights: W };
}

module.exports = { vendorCompliance, weights, DEFAULT_WEIGHTS };

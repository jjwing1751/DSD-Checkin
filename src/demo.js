// Test data: vendor companies, reps, stores, schedules and ~90 days of check-ins/outs.
// Everything it creates is flagged is_demo so removeDemo() can take it out again.
const crypto = require('crypto');
const db = require('./db');
const { generateExpectedVisits } = require('./jobs');

const STORES = [
  ['D101', 'Lakeview Market', 'Chicago North', 'D1', 41.9365, -87.6466],
  ['D102', 'Evanston Market', 'Chicago North', 'D1', 42.0465, -87.6815],
  ['D103', 'Skokie Market', 'Chicago North', 'D2', 42.0334, -87.7334],
  ['D201', 'Naperville Market', 'Chicago West', 'D4', 41.7717, -88.1477],
  ['D202', 'Oak Brook Market', 'Chicago West', 'D4', 41.8397, -87.9536],
  ['D203', 'Schaumburg Market', 'Chicago West', 'D5', 42.0334, -88.0834],
  ['D301', 'Hyde Park Market', 'Chicago South', 'D7', 41.7943, -87.5907],
  ['D302', 'Orland Park Market', 'Chicago South', 'D8', 41.6303, -87.8539],
];

// name, domain, category, vehicle, visit type, days/week, window start, window hours, dwell min, reps
const VENDORS = [
  ['Prairie Snacks Co', 'prairiesnacks.example', 'snacks', true, 'delivery', 3, '06:00', 3, 40, ['Pat Driver', 'Chris Novak', 'Dana Ruiz']],
  ['Lakeshore Beverage', 'lakeshorebev.example', 'beverage', true, 'delivery', 5, '05:30', 3, 55, ['Lee Morgan', 'Sam Okafor', 'Rita Chen']],
  ['Heartland Bakery', 'heartlandbakery.example', 'bread', true, 'delivery', 6, '05:00', 2, 30, ['Alex Baker', 'Jordan Price']],
  ['Midwest Dairy Direct', 'midwestdairy.example', 'dairy', true, 'delivery', 4, '04:30', 3, 45, ['Morgan Hale', 'Taylor Brooks']],
  ['Great Lakes Chips', 'greatlakeschips.example', 'snacks', true, 'merchandising', 2, '09:00', 4, 60, ['Casey Wren', 'Jamie Lo']],
  ['Summit Water', 'summitwater.example', 'beverage', true, 'delivery', 2, '07:00', 4, 35, ['Robin Diaz']],
  ['Northside Greeting Cards', 'northsidecards.example', 'general merchandise', false, 'merchandising', 1, '10:00', 5, 75, ['Avery Kim']],
  ['Lakeshore Beverage Merchandising', 'lakeshorebev-merch.example', 'beverage', false, 'merchandising', 5, '09:00', 4, 70, ['Quinn Foster', 'Reese Adams']],
  ['Fresh Fields Produce', 'freshfields.example', 'produce', true, 'delivery', 6, '04:00', 3, 45, ['Mateo Silva', 'Ivy Grant']],
  ['Riverbend Coffee', 'riverbendcoffee.example', 'coffee', true, 'delivery', 2, '07:00', 3, 30, ['Noah Tran']],
  ['Tri-County Ice', 'tricountyice.example', 'ice', true, 'delivery', 3, '06:00', 4, 20, ['Ella Cruz']],
  ['Golden Tortilla Co', 'goldentortilla.example', 'bakery', true, 'delivery', 3, '05:30', 3, 30, ['Luis Ortega']],
  ['Harbor Seafood', 'harborseafood.example', 'seafood', true, 'delivery', 3, '05:00', 2, 35, ['Mia Walsh']],
  ['Cedar Floral', 'cedarfloral.example', 'floral', true, 'delivery', 3, '06:30', 3, 40, ['Owen Hart']],
  ['Blue Ridge Juice', 'blueridgejuice.example', 'beverage', true, 'delivery', 3, '06:00', 3, 30, ['Zoe Patel']],
  ['Maple Leaf Eggs', 'mapleleafeggs.example', 'dairy', true, 'delivery', 3, '05:00', 3, 25, ['Ben Fisher']],
  ['Kettle Creek Candy', 'kettlecreek.example', 'candy', false, 'merchandising', 2, '10:00', 4, 50, ['Lily Moore']],
  ['Polar Pops Frozen', 'polarpops.example', 'frozen', true, 'delivery', 2, '06:00', 3, 35, ['Eli Ward']],
  ['ColdChain Service', 'coldchainsvc.example', 'refrigeration', true, 'field_service', 0, null, 0, 90, ['Jo Tech', 'Drew Patel']],
  ['BrightLine Equipment', 'brightline.example', 'equipment', true, 'field_service', 0, null, 0, 120, ['Kai Romero']],
];

const DAYS_BACK = 90;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function hasDemo() {
  return Boolean(await db.one('SELECT 1 FROM vendor_companies WHERE is_demo LIMIT 1'));
}

async function loadDemo() {
  if (await hasDemo()) return { skipped: true };
  const storeIds = [];
  for (const [num, name, region, district, lat, lng] of STORES) {
    const r = await db.one(
      `INSERT INTO stores(store_number, name, address, region, district, timezone, lat, lng, geofence_m, receiving_open, receiving_close, store_close, capacity_per_hour, qr_token, is_demo)
       VALUES ($1,$2,$3,$4,$5,'America/Chicago',$6,$7,200,'05:00','14:00','22:00',4,$8,true)
       ON CONFLICT (store_number) DO UPDATE SET is_demo = true RETURNING id`,
      [num, name, `${name} (test store)`, region, district, lat, lng, crypto.randomBytes(12).toString('base64url')]);
    storeIds.push(r.id);
  }

  const vendors = [];
  for (const [name, domain, cat, vehicle, vtype, perWeek, winStart, winHours, dwell, reps] of VENDORS) {
    const c = await db.one(
      `INSERT INTO vendor_companies(name, vendor_number, email_domains, categories, delivers_by_vehicle, status, is_demo)
       VALUES ($1,$2,$3,$4,$5,'active',true) RETURNING id`,
      [name, `T${1000 + vendors.length}`, [domain], [cat], vehicle]);
    const repIds = [];
    for (const [i, repName] of reps.entries()) {
      // Skip any address that already belongs to a real account (e.g. one created by hand).
      const [first, last] = repName.toLowerCase().split(' ');
      let u = null;
      for (const email of [`${first}@${domain}`, `${first}.${last}@${domain}`]) {
        u = await db.one(
          `INSERT INTO users(email, name, phone, role, vendor_company_id, is_vendor_admin, status, identity_verified_at, is_demo)
           VALUES ($1,$2,$3,$4,$5,$6,'active', now() - interval '120 days', true)
           ON CONFLICT (email) DO NOTHING RETURNING id`,
          [email, repName, `312-555-${String(1000 + Math.floor(Math.random() * 9000))}`, vtype === 'field_service' ? 'field_service' : 'rep', c.id, i === 0]);
        if (u) break;
      }
      if (u) repIds.push(u.id);
    }
    // Verified insurance; Summit Water's auto policy expires in 10 days to show the reminder.
    await db.q(`INSERT INTO insurance_policies(vendor_company_id, coverage_type, carrier, policy_number, per_occurrence, aggregate, additional_insured, effective_date, expiry_date, status, verified_at)
      VALUES ($1,'Commercial general liability','Example Mutual',$2,1000000,2000000,true,current_date - 200,current_date + 165,'verified',now())`, [c.id, `CGL-T${c.id}`]);
    if (vehicle) {
      await db.q(`INSERT INTO insurance_policies(vendor_company_id, coverage_type, carrier, policy_number, per_occurrence, effective_date, expiry_date, status, verified_at)
        VALUES ($1,'Commercial auto liability','Example Mutual',$2,1000000,current_date - 200,current_date + $3::int,'verified',now())`,
      [c.id, `AUTO-T${c.id}`, name === 'Summit Water' ? 10 : 165]);
    }
    vendors.push({ id: c.id, name, vtype, perWeek, winStart, winHours, dwell, repIds });
  }

  // Agreed schedules, spread so each store sees a realistic mix of days.
  const agreements = [];
  for (const v of vendors.filter((x) => x.perWeek > 0)) {
    for (const [si, sid] of storeIds.entries()) {
      const allDays = [1, 2, 3, 4, 5, 6, 0];
      const offset = (si + v.id) % 7;
      const days = [];
      for (let k = 0; days.length < v.perWeek; k++) days.push(allDays[(offset + Math.floor(k * 7 / v.perWeek)) % 7]);
      const [h, m] = v.winStart.split(':').map(Number);
      const startMin = h * 60 + m + (si % 3) * 30;
      const endMin = startMin + v.winHours * 60;
      const fmt = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
      const a = await db.one(
        `INSERT INTO service_agreements(vendor_company_id, store_id, category, visit_type, days_of_week, window_start, window_end, expected_dwell_min, effective_from)
         VALUES ($1,$2,(SELECT categories[1] FROM vendor_companies WHERE id = $1),$3,$4,$5,$6,$7,current_date - $8::int) RETURNING id`,
        [v.id, sid, v.vtype, [...new Set(days)].sort(), fmt(startMin), fmt(endMin), v.dwell, DAYS_BACK + 1]);
      agreements.push({ id: a.id, vendor: v, storeId: sid, days: new Set(days), startMin, endMin });
    }
  }

  // Build past expected visits and actual visits in memory, then bulk insert.
  const now = new Date();
  const todayLocal = (await db.one(`SELECT (now() AT TIME ZONE 'America/Chicago')::date::text AS d, extract(hour FROM now() AT TIME ZONE 'America/Chicago')*60 + extract(minute FROM now() AT TIME ZONE 'America/Chicago') AS m`));
  const nowMin = Number(todayLocal.m);
  const exp = { agr: [], date: [], status: [] };
  const vis = { user: [], vendor: [], store: [], agr: [], date: [], type: [], inMin: [], dwell: [], status: [], soft: [], hard: [], dist: [] };
  const dayList = [];
  const base = new Date(`${todayLocal.d}T12:00:00Z`);
  for (let d = DAYS_BACK; d >= 0; d--) {
    const dt = new Date(base.getTime() - d * 86400000);
    dayList.push({ iso: dt.toISOString().slice(0, 10), dow: dt.getUTCDay(), isToday: d === 0 });
  }
  const addVisit = (v, storeId, agrId, day, inMin, dwell) => {
    if (day.isToday && inMin > nowMin) return false;
    const r = Math.random();
    let status = 'checked_out';
    let hard = [];
    let soft = [];
    if (r < 0.012) { status = 'blocked'; hard = ['Insurance: Commercial general liability']; }
    else if (day.isToday && inMin + dwell > nowMin) status = 'checked_in';
    else if (r < 0.04) status = 'auto_closed';
    if (status !== 'blocked' && Math.random() < 0.05) soft = ['Location not shared'];
    vis.user.push(pick(v.repIds)); vis.vendor.push(v.id); vis.store.push(storeId); vis.agr.push(agrId); vis.date.push(day.iso);
    vis.type.push(v.vtype); vis.inMin.push(Math.round(inMin)); vis.dwell.push(Math.round(dwell)); vis.status.push(status);
    vis.soft.push(soft.join('|')); vis.hard.push(hard.join('|')); vis.dist.push(soft.length ? null : Math.round(rnd(5, 120)));
    return status !== 'blocked';
  };
  for (const day of dayList) {
    for (const a of agreements) {
      if (!a.days.has(day.dow)) continue;
      const winEnd = a.endMin;
      const inMin = a.startMin + rnd(-25, (winEnd - a.startMin) + 20);
      const willVisit = Math.random() < 0.92;
      if (day.isToday && winEnd > nowMin) continue; // today's open windows are left to the scheduler
      let done = false;
      if (willVisit) done = addVisit(a.vendor, a.storeId, a.id, day, inMin, a.vendor.dwell * rnd(0.55, 1.45));
      exp.agr.push(a.id); exp.date.push(day.iso); exp.status.push(done ? 'completed' : 'missed');
    }
    // Unscheduled field-service visits.
    for (const v of vendors.filter((x) => x.vtype === 'field_service')) {
      for (const sid of storeIds) {
        if (Math.random() < 0.2) addVisit(v, sid, null, day, rnd(8 * 60, 16 * 60), v.dwell * rnd(0.5, 1.6));
      }
    }
  }

  await db.tx(async (c) => {
    await c.query(`
      INSERT INTO expected_visits(agreement_id, store_id, vendor_company_id, visit_type, visit_date, window_start, window_end, expected_dwell_min, status)
      SELECT a.id, a.store_id, a.vendor_company_id, a.visit_type, x.d::date, a.window_start, a.window_end, a.expected_dwell_min, x.s
        FROM unnest($1::int[], $2::text[], $3::text[]) AS x(a, d, s) JOIN service_agreements a ON a.id = x.a
      ON CONFLICT (agreement_id, visit_date) DO NOTHING`, [exp.agr, exp.date, exp.status]);
    await c.query(`
      INSERT INTO visits(user_id, vendor_company_id, store_id, expected_visit_id, visit_type, source, method, status,
                         check_in_at, check_out_at, expected_out_at, requested_at, location_ok, check_in_distance_m,
                         hard_failures, soft_failures, insurance_status, credential_result)
      SELECT x.u, x.v, x.s, e.id, x.t, CASE WHEN x.a IS NULL THEN 'unscheduled' ELSE 'scheduled' END,
             CASE WHEN x.soft = '' THEN 'qr_geofence' ELSE 'qr' END, x.st,
             CASE WHEN x.st = 'blocked' THEN NULL ELSE t.in_at END,
             CASE WHEN x.st = 'checked_out' THEN t.in_at + make_interval(mins => x.dw)
                  WHEN x.st = 'auto_closed' THEN ((x.d::date + time '22:00') AT TIME ZONE 'America/Chicago') END,
             CASE WHEN x.st = 'blocked' THEN NULL ELSE t.in_at + make_interval(mins => coalesce(e.expected_dwell_min, 60)) END,
             t.in_at, x.soft = '', x.dist,
             CASE WHEN x.hard = '' THEN '{}'::text[] ELSE string_to_array(x.hard, '|') END,
             CASE WHEN x.soft = '' THEN '{}'::text[] ELSE string_to_array(x.soft, '|') END,
             jsonb_build_object('compliant', x.hard = '', 'demo', true), '{}'::jsonb
        FROM unnest($1::int[], $2::int[], $3::int[], $4::int[], $5::text[], $6::text[], $7::int[], $8::int[], $9::text[], $10::text[], $11::text[], $12::int[])
             AS x(u, v, s, a, d, t, im, dw, st, soft, hard, dist)
        CROSS JOIN LATERAL (SELECT ((x.d::date + make_interval(mins => x.im)) AT TIME ZONE 'America/Chicago') AS in_at) t
        LEFT JOIN expected_visits e ON e.agreement_id = x.a AND e.visit_date = x.d::date`,
    [vis.user, vis.vendor, vis.store, vis.agr, vis.date, vis.type, vis.inMin, vis.dwell, vis.status, vis.soft, vis.hard, vis.dist]);
    await c.query(`UPDATE expected_visits e SET visit_id = v.id FROM visits v
      WHERE v.expected_visit_id = e.id AND v.status <> 'blocked' AND e.store_id = ANY($1)`, [storeIds]);
    // Work done for completed visits.
    await c.query(`
      INSERT INTO work_items(visit_id, type)
      SELECT v.id, CASE v.visit_type WHEN 'delivery' THEN 'delivery' WHEN 'merchandising' THEN 'merchandise' ELSE (ARRAY['repair','maintenance','install'])[1 + floor(random() * 3)::int] END
        FROM visits v WHERE v.status = 'checked_out' AND v.store_id = ANY($1)`, [storeIds]);
    await c.query(`
      INSERT INTO work_items(visit_id, type)
      SELECT v.id, (ARRAY['pull_up','reset','credit'])[1 + floor(random() * 3)::int]
        FROM visits v WHERE v.status = 'checked_out' AND v.visit_type IN ('delivery','merchandising') AND v.store_id = ANY($1) AND random() < 0.35`, [storeIds]);
  });
  await generateExpectedVisits();
  return { stores: storeIds.length, vendors: vendors.length, visits: vis.status.length };
}

async function removeDemo() {
  await db.tx(async (c) => {
    const s = (await c.query('SELECT id FROM stores WHERE is_demo')).rows.map((r) => r.id);
    const v = (await c.query('SELECT id FROM vendor_companies WHERE is_demo')).rows.map((r) => r.id);
    const u = (await c.query('SELECT id FROM users WHERE is_demo')).rows.map((r) => r.id);
    await c.query('UPDATE users SET vendor_company_id = NULL WHERE vendor_company_id = ANY($1) AND NOT is_demo', [v]);
    await c.query('UPDATE expected_visits SET announced_by = NULL WHERE announced_by = ANY($1)', [u]);
    await c.query('UPDATE expected_visits SET visit_id = NULL WHERE store_id = ANY($1) OR vendor_company_id = ANY($2)', [s, v]);
    await c.query('DELETE FROM alerts WHERE store_id = ANY($1) OR vendor_company_id = ANY($2) OR user_id = ANY($3)', [s, v, u]);
    await c.query('DELETE FROM visits WHERE store_id = ANY($1) OR vendor_company_id = ANY($2) OR user_id = ANY($3)', [s, v, u]);
    await c.query('DELETE FROM expected_visits WHERE store_id = ANY($1) OR vendor_company_id = ANY($2)', [s, v]);
    await c.query('DELETE FROM service_agreements WHERE store_id = ANY($1) OR vendor_company_id = ANY($2)', [s, v]);
    await c.query('DELETE FROM insurance_policies WHERE vendor_company_id = ANY($1)', [v]);
    await c.query('DELETE FROM insurance_overrides WHERE vendor_company_id = ANY($1)', [v]);
    await c.query('DELETE FROM credentials WHERE vendor_company_id = ANY($1) OR user_id = ANY($2)', [v, u]);
    await c.query('UPDATE users SET identity_verified_by = NULL WHERE identity_verified_by = ANY($1)', [u]);
    await c.query('DELETE FROM users WHERE id = ANY($1)', [u]);
    await c.query('UPDATE users SET store_id = NULL WHERE store_id = ANY($1)', [s]);
    await c.query('DELETE FROM vendor_companies WHERE id = ANY($1)', [v]);
    await c.query('DELETE FROM stores WHERE id = ANY($1)', [s]);
  });
}

module.exports = { loadDemo, removeDemo, hasDemo };

// Fixed fixtures for the end-to-end tests (stores 101/102/201, three vendors, staff with known passwords).
const crypto = require('crypto');
const db = require('../src/db');
const { migrate } = require('../src/migrate');
const { hashPassword } = require('../src/auth');
const { generateExpectedVisits } = require('../src/jobs');

async function upsertStore(s) {
  const r = await db.one(`INSERT INTO stores(store_number, name, address, region, district, timezone, lat, lng, geofence_m, receiving_open, receiving_close, store_close, capacity_per_hour, qr_token)
    VALUES ($1,$2,$3,$4,$5,'America/Chicago',$6,$7,200,'06:00','14:00','22:00',3,$8)
    ON CONFLICT (store_number) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [s.number, s.name, s.address, s.region, s.district, s.lat, s.lng, crypto.randomBytes(12).toString('base64url')]);
  return r.id;
}

async function upsertVendor(v) {
  const existing = await db.one('SELECT id FROM vendor_companies WHERE name = $1', [v.name]);
  if (existing) return existing.id;
  const r = await db.one(`INSERT INTO vendor_companies(name, vendor_number, email_domains, categories, delivers_by_vehicle, status)
    VALUES ($1,$2,$3,$4,$5,'active') RETURNING id`, [v.name, v.number, v.domains, v.categories, v.vehicle]);
  return r.id;
}

async function upsertUser(u, pw) {
  const r = await db.one(`INSERT INTO users(email, name, phone, role, store_id, vendor_company_id, is_vendor_admin, password_hash, status, identity_verified_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active', CASE WHEN $4 IN ('rep','field_service') THEN now() END)
    ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [u.email, u.name, u.phone || null, u.role, u.store_id || null, u.vendor_company_id || null, Boolean(u.is_vendor_admin), pw ? await hashPassword(pw) : null]);
  return r.id;
}

async function main() {
  await migrate();
  const pw = process.env.DEMO_PASSWORD || 'demo-password-123';
  const s1 = await upsertStore({ number: '101', name: 'Lakeview Market', address: '3000 N Clark St, Chicago, IL', region: 'Chicago North', district: 'D1', lat: 41.9365, lng: -87.6466 });
  const s2 = await upsertStore({ number: '102', name: 'Evanston Market', address: '1700 Sherman Ave, Evanston, IL', region: 'Chicago North', district: 'D1', lat: 42.0465, lng: -87.6815 });
  const s3 = await upsertStore({ number: '201', name: 'Naperville Market', address: '200 S Washington St, Naperville, IL', region: 'Chicago West', district: 'D4', lat: 41.7717, lng: -88.1477 });

  const snacks = await upsertVendor({ name: 'Prairie Snacks Co', number: 'V1001', domains: ['prairiesnacks.example'], categories: ['snacks'], vehicle: true });
  const bev = await upsertVendor({ name: 'Lakeshore Beverage', number: 'V1002', domains: ['lakeshorebev.example'], categories: ['beverage'], vehicle: true });
  const tech = await upsertVendor({ name: 'ColdChain Service', number: 'V2001', domains: ['coldchainsvc.example'], categories: ['refrigeration'], vehicle: false });

  if (!(await db.one('SELECT 1 FROM insurance_requirements LIMIT 1'))) {
    await db.q(`INSERT INTO insurance_requirements(coverage_type, min_per_occurrence, min_aggregate, require_additional_insured, notes) VALUES
      ('Commercial general liability', 1000000, 2000000, true, 'Example starting requirement; confirm with risk team')`);
    await db.q(`INSERT INTO insurance_requirements(coverage_type, min_per_occurrence, vehicle_only, notes) VALUES
      ('Commercial auto liability', 1000000, true, 'Example; vehicle delivery only')`);
  }
  for (const [vid, auto] of [[snacks, true], [bev, true], [tech, false]]) {
    if (await db.one('SELECT 1 FROM insurance_policies WHERE vendor_company_id = $1', [vid])) continue;
    await db.q(`INSERT INTO insurance_policies(vendor_company_id, coverage_type, carrier, policy_number, per_occurrence, aggregate, additional_insured, effective_date, expiry_date, status, verified_at)
      VALUES ($1::int,'Commercial general liability','Example Mutual','CGL-' || $1::text, 1000000, 2000000, true, current_date - 100, current_date + 265, 'verified', now())`, [vid]);
    if (auto) await db.q(`INSERT INTO insurance_policies(vendor_company_id, coverage_type, carrier, policy_number, per_occurrence, effective_date, expiry_date, status, verified_at)
      VALUES ($1::int,'Commercial auto liability','Example Mutual','AUTO-' || $1::text, 1000000, current_date - 100, current_date + 20, 'verified', now())`, [vid]);
  }
  if (!(await db.one('SELECT 1 FROM credential_types LIMIT 1'))) {
    await db.q(`INSERT INTO credential_types(name, holder, visit_types, enforcement, validity_days, description) VALUES
      ('Food handler certificate', 'person', '{merchandising}', 'soft', 1095, 'Example; list not decided')`);
  }

  await upsertUser({ email: 'ops@demo.example', name: 'Dana Ops', role: 'dsd_ops' }, pw);
  await upsertUser({ email: 'merchant@demo.example', name: 'Morgan Merchant', role: 'merchant' }, pw);
  await upsertUser({ email: 'receiver101@demo.example', name: 'Riley Receiver', role: 'receiver', store_id: s1 }, pw);
  await upsertUser({ email: 'manager101@demo.example', name: 'Sam Manager', role: 'store_manager', store_id: s1 }, pw);
  await upsertUser({ email: 'pat@prairiesnacks.example', name: 'Pat Driver', phone: '312-555-0101', role: 'rep', vendor_company_id: snacks, is_vendor_admin: true });
  await upsertUser({ email: 'lee@lakeshorebev.example', name: 'Lee Merch', role: 'rep', vendor_company_id: bev, is_vendor_admin: true });
  await upsertUser({ email: 'jo@coldchainsvc.example', name: 'Jo Tech', role: 'field_service', vendor_company_id: tech, is_vendor_admin: true });

  if (!(await db.one('SELECT 1 FROM service_agreements LIMIT 1'))) {
    for (const sid of [s1, s2, s3]) {
      await db.q(`INSERT INTO service_agreements(vendor_company_id, store_id, category, visit_type, days_of_week, window_start, window_end, expected_dwell_min, effective_from)
        VALUES ($1,$2,'snacks','delivery','{1,3,5}','06:00','09:00',45,current_date - 30)`, [snacks, sid]);
      await db.q(`INSERT INTO service_agreements(vendor_company_id, store_id, category, visit_type, days_of_week, window_start, window_end, expected_dwell_min, effective_from)
        VALUES ($1,$2,'beverage','merchandising','{0,1,2,3,4,5,6}','08:00','12:00',60,current_date - 30)`, [bev, sid]);
    }
  }
  await generateExpectedVisits();
  console.log(`Demo data loaded. Staff password for *@demo.example users: ${process.env.DEMO_PASSWORD ? '(DEMO_PASSWORD)' : pw}`);
  await db.pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

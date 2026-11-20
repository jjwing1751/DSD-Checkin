// End-to-end flow against a real Postgres. Set TEST_DATABASE_URL (a throwaway database; it is wiped).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test('e2e (skipped: set TEST_DATABASE_URL)', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = TEST_DB;
process.env.DISABLE_JOBS = 'true';
process.env.DEV_SHOW_CODES = 'false'; // no SMTP in tests, so codes still show on screen
process.env.LOGIN_RATE_LIMIT_PER_MIN = '10000';

const db = require('../src/db');
const { createApp } = require('../src/server');
const { migrate } = require('../src/migrate');
const jobs = require('../src/jobs');

let server;
let base;

class Client {
  constructor() { this.cookies = {}; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, url, body, { multipart } = {}) {
    const headers = { cookie: this.cookieHeader() };
    let payload;
    if (body && multipart) {
      payload = new FormData();
      for (const [k, v] of Object.entries(body)) {
        if (Array.isArray(v)) v.forEach((x) => payload.append(k, x));
        else payload.append(k, v);
      }
    } else if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) (Array.isArray(v) ? v : [v]).forEach((x) => p.append(k, x));
      payload = p.toString();
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
    }
    const text = await res.text();
    const m = /name="_csrf" value="([^"]+)"/.exec(text);
    if (m) this.csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text };
  }
  get(url) { return this.req('GET', url); }
  post(url, body = {}, opts) { return this.req('POST', url, { _csrf: this.csrf, ...body }, opts); }
  async follow(r) {
    while (r.status === 302 || r.status === 303) r = await this.get(r.location);
    return r;
  }
}

async function repLogin(email) {
  const c = new Client();
  await c.get('/login');
  const r = await c.post('/login/code', { email });
  const code = /Your code is <strong>(\d{6})<\/strong>/.exec(r.text);
  if (!code) return { c, r };
  const v = await c.post('/login/verify', { code: code[1] });
  return { c, r: v };
}

async function staffLogin(email, password = 'demo-password-123') {
  const c = new Client();
  await c.get('/login');
  const r = await c.post('/login/password', { email, password });
  assert.equal(r.status, 302, `staff login failed for ${email}`);
  return c;
}

const png = () => new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' });

before(async () => {
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  execFileSync(process.execPath, [path.join(__dirname, 'seed-fixtures.js')], { env: { ...process.env }, stdio: 'ignore' });
  await db.q(`INSERT INTO users(email, name, role, password_hash, status) SELECT 'admin@demo.example', 'Admin', 'admin', password_hash, 'active' FROM users WHERE email = 'ops@demo.example'`);
  // Make every demo schedule daily so the tests don't depend on the weekday they run.
  await db.q(`UPDATE service_agreements SET days_of_week = '{0,1,2,3,4,5,6}'`);
  await jobs.generateExpectedVisits();
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server && server.close();
  await db.pool.end();
});

const store = (n) => db.one('SELECT * FROM stores WHERE store_number = $1', [n]);

test('personal email domains cannot enroll', async () => {
  const { r } = await repLogin('someone@gmail.com');
  assert.match(r.text, /Use your company email address/);
});

test('verified rep checks in by QR in one tap, shows on the store dashboard, and checks out in one tap', async () => {
  const s = await store('101');
  const { c } = await repLogin('pat@prairiesnacks.example');
  const start = await c.get(`/s/${s.qr_token}`);
  assert.equal(start.status, 200);
  assert.match(start.text, /Lakeview Market/);
  const r = await c.post(`/s/${s.qr_token}/checkin`, { visit_type: 'delivery', lat: String(s.lat + 0.0003), lng: String(s.lng), accuracy: '20' });
  assert.equal(r.status, 302);
  const pass = await c.follow(r);
  assert.match(pass.text, /CHECKED IN/);
  const v = await db.one(`SELECT * FROM visits WHERE user_id = (SELECT id FROM users WHERE email = 'pat@prairiesnacks.example') ORDER BY id DESC LIMIT 1`);
  assert.equal(v.status, 'checked_in');
  assert.equal(v.method, 'qr_geofence');
  assert.equal(v.insurance_status.compliant, true);
  assert.equal(v.source, 'scheduled');
  assert.equal((await db.one('SELECT status FROM expected_visits WHERE id = $1', [v.expected_visit_id])).status, 'completed');

  const rc = await staffLogin('receiver101@demo.example');
  const dash = await rc.get(`/store/${s.id}`);
  assert.match(dash.text, /Pat Driver/);
  assert.match(dash.text, /In store now \(1\)/);
  const roster = await rc.get(`/store/${s.id}/roster`);
  assert.match(roster.text, /Pat Driver/);

  await c.get(`/visit/${v.id}`);
  const out = await c.post(`/visit/${v.id}/checkout`, { work: ['delivery', 'pull_up'], notes: 'All good', photos: png() }, { multipart: true });
  assert.equal(out.status, 302, out.text.slice(0, 300));
  const done = await db.one('SELECT status FROM visits WHERE id = $1', [v.id]);
  assert.equal(done.status, 'checked_out');
  const work = await db.many('SELECT * FROM work_items WHERE visit_id = $1', [v.id]);
  assert.equal(work.length, 2);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM visit_photos WHERE visit_id = $1', [v.id])).n, 1);

  // Receivers cannot see other stores.
  const other = await store('102');
  assert.equal((await rc.get(`/store/${other.id}`)).status, 403);
});

test('outside the geofence still checks in at once, recorded with a warning', async () => {
  const s = await store('101');
  const { c } = await repLogin('lee@lakeshorebev.example');
  await c.get(`/s/${s.qr_token}`);
  const r = await c.post(`/s/${s.qr_token}/checkin`, { visit_type: 'merchandising', lat: '41.0', lng: '-87.0', accuracy: '10' });
  const pass = await c.follow(r);
  assert.match(pass.text, /CHECKED IN/);
  const v = await db.one(`SELECT * FROM visits WHERE user_id = (SELECT id FROM users WHERE email = 'lee@lakeshorebev.example') ORDER BY id DESC LIMIT 1`);
  assert.equal(v.status, 'checked_in');
  assert.ok(v.check_in_at);
  assert.equal(v.location_ok, false);
  assert.ok(v.soft_failures.some((f) => f.startsWith('Location')));
  assert.ok(v.soft_failures.some((f) => f.includes('Food handler')));
  assert.ok(await db.one(`SELECT 1 FROM alerts WHERE kind = 'checkin_warning' AND visit_id = $1`, [v.id]));

  // The receiver can check someone out who forgot to.
  const rc = await staffLogin('receiver101@demo.example');
  await rc.get(`/store/${s.id}`);
  await rc.post(`/store/${s.id}/visits/${v.id}/checkout`, { note: 'ok' });
  assert.equal((await db.one('SELECT status FROM visits WHERE id = $1', [v.id])).status, 'checked_out');
});

test('lapsed insurance blocks check-in until DSD ops sets a company override', async () => {
  const s = await store('101');
  await db.q(`UPDATE insurance_policies SET expiry_date = current_date - 2 WHERE coverage_type = 'Commercial general liability'
               AND vendor_company_id = (SELECT id FROM vendor_companies WHERE name = 'Prairie Snacks Co')`);
  const { c } = await repLogin('pat@prairiesnacks.example');
  await c.get(`/s/${s.qr_token}`);
  const pass = await c.follow(await c.post(`/s/${s.qr_token}/checkin`, { visit_type: 'delivery', lat: String(s.lat), lng: String(s.lng) }));
  assert.match(pass.text, /Check-in blocked/);
  const v = await db.one(`SELECT * FROM visits WHERE user_id = (SELECT id FROM users WHERE email = 'pat@prairiesnacks.example') ORDER BY id DESC LIMIT 1`);
  assert.equal(v.status, 'blocked');
  assert.deepEqual(v.hard_failures, ['Insurance: Commercial general liability']);

  // A blocked attempt is not an open visit: the rep can retry right away.
  assert.equal((await c.get(`/s/${s.qr_token}`)).status, 200);

  // DSD ops company override lets the next check-in through without store action.
  const ops = await staffLogin('ops@demo.example');
  const vendor = await db.one(`SELECT id FROM vendor_companies WHERE name = 'Prairie Snacks Co'`);
  await ops.get(`/admin/vendors/${vendor.id}`);
  await ops.post(`/admin/vendors/${vendor.id}/override`, { days: '30', reason: 'COI renewal in review' });
  const ov = await db.one('SELECT * FROM insurance_overrides WHERE vendor_company_id = $1', [vendor.id]);
  const days = (new Date(ov.expires_at) - new Date(ov.created_at)) / 86400000;
  assert.ok(days <= 14.01, 'capped at 14 days');
  await c.get(`/s/${s.qr_token}`);
  await c.follow(await c.post(`/s/${s.qr_token}/checkin`, { visit_type: 'delivery', lat: String(s.lat), lng: String(s.lng) }));
  const v2 = await db.one(`SELECT * FROM visits WHERE user_id = (SELECT id FROM users WHERE email = 'pat@prairiesnacks.example') ORDER BY id DESC LIMIT 1`);
  assert.equal(v2.status, 'checked_in');
  assert.equal(v2.insurance_status.override.scope, 'company');
  await c.get(`/visit/${v2.id}`);
  await c.post(`/visit/${v2.id}/checkout`, {}, { multipart: true });
});

test('new rep with unknown company domain self-enrolls, verifies identity, and is blocked until company is approved', async () => {
  const { c, r } = await repLogin('alex@newbakery.example');
  assert.equal(r.location, '/enroll');
  await c.get('/enroll');
  const e = await c.post('/enroll', { name: 'Alex Baker', phone: '555', role: 'rep', company_name: 'New Bakery LLC', categories: 'bread' });
  assert.equal(e.location, '/rep/identity');
  const company = await db.one(`SELECT * FROM vendor_companies WHERE name = 'New Bakery LLC'`);
  assert.equal(company.status, 'pending');
  assert.deepEqual(company.email_domains, ['newbakery.example']);
  const u = await db.one(`SELECT * FROM users WHERE email = 'alex@newbakery.example'`);
  assert.equal(u.is_vendor_admin, true);

  await c.get('/rep/identity');
  const idr = await c.post('/rep/identity', { id_photo: png(), selfie: png() }, { multipart: true });
  assert.equal(idr.status, 302);
  assert.equal((await db.one('SELECT status FROM users WHERE id = $1', [u.id])).status, 'identity_review');

  const ops = await staffLogin('ops@demo.example');
  const q = await ops.get('/admin/identity');
  assert.match(q.text, /Alex Baker/);
  assert.equal((await ops.get(`/files/user/${u.id}/id-photo`)).status, 200);
  await ops.post(`/admin/users/${u.id}/identity`, { action: 'approve' });
  assert.equal((await db.one('SELECT status FROM users WHERE id = $1', [u.id])).status, 'active');

  // Receivers cannot view ID images.
  const rc = await staffLogin('receiver101@demo.example');
  assert.equal((await rc.get(`/files/user/${u.id}/id-photo`)).status, 403);

  const s = await store('101');
  await c.get(`/s/${s.qr_token}`);
  await c.follow(await c.post(`/s/${s.qr_token}/checkin`, { visit_type: 'delivery', lat: String(s.lat), lng: String(s.lng) }));
  const v = await db.one('SELECT * FROM visits WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [u.id]);
  assert.equal(v.status, 'blocked');
  assert.ok(v.hard_failures.includes('Vendor company is pending'));
  // Blocked attempts show in the HQ visit log.
  const ops2 = await staffLogin('ops@demo.example');
  assert.match((await ops2.get('/reports/visits?status=blocked')).text, /Alex Baker/);
});

test('audit log is append-only', async () => {
  await assert.rejects(db.q(`UPDATE audit_events SET action = 'x'`), /append-only/);
  await assert.rejects(db.q(`DELETE FROM audit_events`), /retention purge/);
});

test('jobs run, auto-close leftover visits, and the retention purge removes old rows', async () => {
  const s = await store('102');
  const pat = await db.one(`SELECT id, vendor_company_id FROM users WHERE email = 'lee@lakeshorebev.example'`);
  const old = await db.one(`INSERT INTO visits(user_id, vendor_company_id, store_id, visit_type, source, status, check_in_at, requested_at)
    VALUES ($1,$2,$3,'delivery','unscheduled','checked_in', now() - interval '2 days', now() - interval '2 days') RETURNING id`, [pat.id, pat.vendor_company_id, s.id]);
  const ancient = await db.one(`INSERT INTO visits(user_id, vendor_company_id, store_id, visit_type, source, status, requested_at)
    VALUES ($1,$2,$3,'delivery','unscheduled','checked_out', now() - interval '19 months') RETURNING id`, [pat.id, pat.vendor_company_id, s.id]);
  await jobs.runAll();
  assert.equal((await db.one('SELECT status FROM visits WHERE id = $1', [old.id])).status, 'auto_closed');
  assert.equal(await db.one('SELECT 1 FROM visits WHERE id = $1', [ancient.id]), null);
  const n = await db.one(`SELECT count(*)::int AS n FROM expected_visits WHERE visit_date >= current_date`);
  assert.ok(n.n > 0);
});

test('every staff page renders', async () => {
  const ops = await staffLogin('admin@demo.example');
  const s = await store('101');
  const vendor = await db.one(`SELECT id FROM vendor_companies LIMIT 1`);
  const agr = await db.one(`SELECT id FROM service_agreements LIMIT 1`);
  const u = await db.one(`SELECT id FROM users LIMIT 1`);
  const v = await db.one(`SELECT id FROM visits WHERE store_id = $1 LIMIT 1`, [s.id]);
  for (const url of ['/admin', '/admin/stores', `/admin/stores/${s.id}`, `/admin/stores/${s.id}/poster`, '/admin/vendors', `/admin/vendors/${vendor.id}`,
    '/admin/insurance', '/admin/credentials', '/admin/identity', '/admin/users', `/admin/users/${u.id}`, '/admin/settings', '/admin/audit',
    '/admin/audit?format=csv', '/reports', '/reports?group=month', '/reports?group=store', '/reports?group=store_day', '/reports?group=store_month', '/reports?group=vendor', '/reports?group=store_day&format=csv', '/reports/visits', '/reports/visits?format=csv', '/stores', `/store/${s.id}`, `/store/${s.id}/history`, `/store/${s.id}/history?format=csv`,
    `/store/${s.id}/visits/${v.id}`, '/merchant', `/merchant/agreements/${agr.id}`, '/merchant/compliance', '/merchant/compliance?format=csv']) {
    const r = await ops.get(url);
    assert.equal(r.status, 200, `${url} -> ${r.status}: ${r.text.slice(0, 200)}`);
  }
  const merch = await staffLogin('merchant@demo.example');
  await merch.get('/merchant');
  const create = await merch.post('/merchant/agreements', {
    vendor_company_id: String(vendor.id), store_ids: [String(s.id)], visit_type: 'delivery', days: ['1', '4'], window_start: '07:00', window_end: '09:00', expected_dwell_min: '30',
  });
  assert.equal(create.status, 302);
  assert.equal((await merch.get('/admin')).status, 403);
  const rep = (await repLogin('pat@prairiesnacks.example')).c;
  for (const url of ['/rep', '/rep/credentials', '/rep/visits', '/company']) {
    const r = await rep.get(url);
    assert.equal(r.status, 200, `${url} -> ${r.status}`);
  }
  assert.equal((await rep.get('/rep/announce')).status, 404);
  assert.equal((await rep.get('/reports')).status, 403);
});

test('test data loads, feeds the reports, and removes cleanly', async () => {
  const ops = await staffLogin('ops@demo.example');
  await ops.get('/admin/settings');
  const before = await db.one('SELECT count(*)::int AS n FROM vendor_companies');
  const load = await ops.post('/admin/demo', { action: 'load' });
  assert.equal(load.status, 302);
  const vendors = await db.one('SELECT count(*)::int AS n FROM vendor_companies WHERE is_demo');
  assert.equal(vendors.n, 20);
  const visits = await db.one('SELECT count(*)::int AS n FROM visits v JOIN stores s ON s.id = v.store_id WHERE s.is_demo');
  assert.ok(visits.n > 3000, `visits: ${visits.n}`);

  const d101 = await store('D101');
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const r = await ops.get(`/reports?group=store_month&store=${d101.id}&from=${from}&to=${today}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Check-ins/);
  assert.match(r.text, /Northbrook|D101|#D101/);
  const csv = await ops.get(`/reports?group=store&from=${from}&to=${today}&format=csv`);
  assert.match(csv.text, /^store,store_name,check_ins/);
  assert.match(csv.text, /D101/);
  // Roll-up totals equal the sum of the store rows.
  const lines = csv.text.trim().split('\n').slice(1).map((l) => l.split(','));
  const sum = lines.reduce((a, l) => a + Number(l[2]), 0);
  const tot = await db.one(`SELECT count(*)::int AS n FROM visits v JOIN stores s ON s.id = v.store_id
    WHERE v.status IN ('checked_in','checked_out','auto_closed') AND (v.check_in_at AT TIME ZONE s.timezone)::date BETWEEN $1 AND $2`, [from, today]);
  assert.equal(sum, tot.n);

  await ops.get('/admin/settings');
  await ops.post('/admin/demo', { action: 'remove' });
  assert.equal((await db.one('SELECT count(*)::int AS n FROM vendor_companies WHERE is_demo')).n, 0);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM stores WHERE is_demo')).n, 0);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM vendor_companies')).n, before.n);
});

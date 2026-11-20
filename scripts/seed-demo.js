// Loads the same test data as Admin > Settings > "Load test data", plus demo staff logins.
// Usage: DATABASE_URL=... DEMO_PASSWORD=... npm run seed:demo
const db = require('../src/db');
const { migrate } = require('../src/migrate');
const { hashPassword } = require('../src/auth');
const { loadDemo } = require('../src/demo');

async function main() {
  await migrate();
  const result = await loadDemo();
  const pw = process.env.DEMO_PASSWORD || 'demo-password-123';
  const hash = await hashPassword(pw);
  const store = await db.one(`SELECT id FROM stores WHERE store_number = 'D101'`);
  for (const [email, name, role, storeId] of [
    ['ops@demo.example', 'Dana Ops', 'dsd_ops', null],
    ['merchant@demo.example', 'Morgan Merchant', 'merchant', null],
    ['receiver@demo.example', 'Riley Receiver', 'receiver', store.id],
    ['manager@demo.example', 'Sam Manager', 'store_manager', store.id],
  ]) {
    await db.q(`INSERT INTO users(email, name, role, store_id, password_hash, status, is_demo) VALUES ($1,$2,$3,$4,$5,'active',true)
      ON CONFLICT (email) DO NOTHING`, [email, name, role, storeId, hash]);
  }
  console.log(result.skipped ? 'Test data already loaded.' : `Loaded ${result.stores} stores, ${result.vendors} vendors, ${result.visits} visits.`);
  console.log(`Staff logins (*@demo.example): password ${process.env.DEMO_PASSWORD ? '(DEMO_PASSWORD)' : pw}`);
  await db.pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

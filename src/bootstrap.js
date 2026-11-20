const db = require('./db');
const { hashPassword, normEmail } = require('./auth');

// Creates the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD if none exists.
async function bootstrapAdmin() {
  const existing = await db.one(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (existing) return;
  const email = normEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('No admin user yet. Set ADMIN_EMAIL and ADMIN_PASSWORD to create one on start.');
    return;
  }
  await db.q(
    `INSERT INTO users(email, name, role, password_hash, status) VALUES ($1, 'Administrator', 'admin', $2, 'active')
     ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash, status = 'active'`,
    [email, await hashPassword(password)]
  );
  console.log(`Created admin ${email}`);
}

module.exports = { bootstrapAdmin };

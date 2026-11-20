const db = require('./db');
const mail = require('./mail');

// Records an in-app alert. dedupeKey prevents the same alert being raised twice.
async function raise({ kind, severity = 'info', storeId, vendorCompanyId, userId, visitId, audience, message, dedupeKey, email }, client) {
  const runner = client || db.pool;
  const r = await runner.query(
    `INSERT INTO alerts(kind, severity, store_id, vendor_company_id, user_id, visit_id, audience, message, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [kind, severity, storeId || null, vendorCompanyId || null, userId || null, visitId || null, audience || [], message, dedupeKey || null]
  );
  if (r.rowCount && email && email.length) {
    for (const to of email) {
      mail.send({ to, subject: `DSD Check-in: ${message.slice(0, 80)}`, text: message }).catch((e) => console.error('mail failed', e.message));
    }
  }
  return r.rowCount > 0;
}

// Email addresses for a set of roles (optionally limited to a store / vendor company).
async function emailsFor({ roles, storeId, vendorCompanyId, vendorAdminsOnly }) {
  const rows = await db.many(
    `SELECT email FROM users WHERE status = 'active' AND (
       (role = ANY($1) AND ($2::int IS NULL OR store_id IS NULL OR store_id = $2))
       OR ($3::int IS NOT NULL AND $4 AND vendor_company_id = $3 AND is_vendor_admin)
     )`,
    [roles || [], storeId || null, vendorCompanyId || null, Boolean(vendorAdminsOnly)]
  );
  return rows.map((r) => r.email);
}

module.exports = { raise, emailsFor };

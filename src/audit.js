const db = require('./db');

// Strip binary/secret fields before writing to the audit log.
function clean(obj) {
  if (!obj) return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (Buffer.isBuffer(v)) { out[k] = '[binary]'; continue; }
    if (['password_hash', 'code_hash', 'id_photo', 'selfie', 'doc', 'data'].includes(k)) { out[k] = v ? '[redacted]' : null; continue; }
    out[k] = v;
  }
  return out;
}

async function audit(req, { action, entity, entityId, storeId, before, after }, client) {
  const runner = client || db.pool;
  const user = req && req.user;
  await runner.query(
    `INSERT INTO audit_events(actor_id, actor_email, action, entity, entity_id, store_id, before, after, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      user ? user.id : null,
      user ? user.email : null,
      action,
      entity,
      entityId == null ? null : String(entityId),
      storeId || null,
      before ? JSON.stringify(clean(before)) : null,
      after ? JSON.stringify(clean(after)) : null,
      req ? req.ip : null,
      req && req.get ? (req.get('user-agent') || '').slice(0, 300) : null,
    ]
  );
}

module.exports = { audit };

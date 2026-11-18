// Credential, insurance and location checks run at every check-in.
const db = require('./db');

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function storeToday(store) {
  const r = await db.one(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [store.timezone]);
  return r.d;
}

async function getSetting(key, fallback) {
  const r = await db.one('SELECT value FROM settings WHERE key = $1', [key]);
  return r ? r.value : fallback;
}

// Which insurance requirements apply to this company + visit type.
async function applicableRequirements(company, visitType) {
  return db.many(
    `SELECT * FROM insurance_requirements
      WHERE active
        AND (cardinality(visit_types) = 0 OR $1 = ANY(visit_types))
        AND (cardinality(categories) = 0 OR categories && $2::text[])
        AND (NOT vehicle_only OR $3)
      ORDER BY id`,
    [visitType, company.categories || [], Boolean(company.delivers_by_vehicle)]
  );
}

async function activeCompanyOverride(companyId) {
  return db.one(
    `SELECT o.*, u.name AS approved_by_name, u.email AS approved_by_email
       FROM insurance_overrides o JOIN users u ON u.id = o.approved_by
      WHERE o.vendor_company_id = $1 AND o.revoked_at IS NULL AND o.expires_at > now()
      ORDER BY o.expires_at DESC LIMIT 1`,
    [companyId]
  );
}

// Returns { ok, requirements: [{coverage_type, ok, reason, policy_id}], override }
async function evaluateInsurance(company, visitType, onDate) {
  const reqs = await applicableRequirements(company, visitType);
  const policies = await db.many(
    `SELECT id, coverage_type, carrier, policy_number, per_occurrence, aggregate, additional_insured, effective_date, expiry_date
       FROM insurance_policies
      WHERE vendor_company_id = $1 AND status = 'verified' AND effective_date <= $2 AND expiry_date >= $2`,
    [company.id, onDate]
  );
  const results = reqs.map((req) => {
    const candidates = policies.filter((p) => p.coverage_type === req.coverage_type);
    if (!candidates.length) return { coverage_type: req.coverage_type, ok: false, reason: 'No verified policy in force' };
    const good = candidates.find(
      (p) =>
        (req.min_per_occurrence == null || (p.per_occurrence || 0) >= req.min_per_occurrence) &&
        (req.min_aggregate == null || (p.aggregate || 0) >= req.min_aggregate) &&
        (!req.require_additional_insured || p.additional_insured)
    );
    if (!good) return { coverage_type: req.coverage_type, ok: false, reason: 'Policy limits or additional-insured wording below requirement' };
    return { coverage_type: req.coverage_type, ok: true, policy_id: good.id, policy_number: good.policy_number, expires: good.expiry_date };
  });
  const allOk = results.every((r) => r.ok);
  let override = null;
  if (!allOk) {
    const o = await activeCompanyOverride(company.id);
    if (o) override = { scope: 'company', id: o.id, reason: o.reason, approved_by: o.approved_by_name || o.approved_by_email, expires_at: o.expires_at };
  }
  return { ok: allOk || Boolean(override), compliant: allOk, requirements: results, override, checked_on: onDate };
}

// Returns [{credential_type_id, name, enforcement, holder, ok, reason}]
async function evaluateCredentials(user, company, visitType, onDate) {
  const types = await db.many(
    `SELECT * FROM credential_types WHERE active AND (cardinality(visit_types) = 0 OR $1 = ANY(visit_types)) ORDER BY id`,
    [visitType]
  );
  if (!types.length) return [];
  const creds = await db.many(
    `SELECT credential_type_id, user_id, vendor_company_id, expires_on
       FROM credentials
      WHERE status = 'verified' AND (expires_on IS NULL OR expires_on >= $3)
        AND (user_id = $1 OR ($2::int IS NOT NULL AND vendor_company_id = $2))`,
    [user.id, company ? company.id : null, onDate]
  );
  return types.map((t) => {
    const has = creds.some(
      (c) => c.credential_type_id === t.id && (t.holder === 'person' ? c.user_id === user.id : company && c.vendor_company_id === company.id)
    );
    return {
      credential_type_id: t.id,
      name: t.name,
      enforcement: t.enforcement,
      holder: t.holder,
      ok: has,
      reason: has ? null : `Missing or expired ${t.holder === 'company' ? 'company ' : ''}credential`,
    };
  });
}

/**
 * Runs every check for a check-in attempt.
 * Returns { hard: [..messages], soft: [..messages], insurance, credentials, location }
 */
async function evaluateCheckIn({ user, company, store, visitType, lat, lng, accuracy }) {
  const hard = [];
  const soft = [];
  const today = await storeToday(store);

  if (user.status !== 'active') hard.push('Identity not verified or account not active');

  let insurance = { ok: true, compliant: true, requirements: [], override: null, checked_on: today };
  if (company) {
    if (company.status !== 'active') hard.push(`Vendor company is ${company.status}`);
    insurance = await evaluateInsurance(company, visitType, today);
    if (!insurance.ok) {
      const missing = insurance.requirements.filter((r) => !r.ok).map((r) => r.coverage_type);
      hard.push(`Insurance: ${missing.join(', ')}`);
    }
  }

  const credentials = await evaluateCredentials(user, company, visitType, today);
  for (const c of credentials) {
    if (c.ok) continue;
    (c.enforcement === 'hard' ? hard : soft).push(`Credential: ${c.name}`);
  }

  // Geofence
  const location = { lat, lng, accuracy, distance_m: null, ok: false };
  if (lat != null && lng != null && store.lat != null && store.lng != null) {
    location.distance_m = Math.round(haversineMeters(lat, lng, store.lat, store.lng));
    const slack = Math.min(Number(accuracy) || 0, 150);
    location.ok = location.distance_m <= store.geofence_m + slack;
  } else if (store.lat == null || store.lng == null) {
    location.ok = true; // store has no coordinates configured: QR scan alone counts
    location.skipped = true;
  }
  if (!location.ok) {
    const requireLocation = (await getSetting('require_location', false)) === true;
    const msg = location.distance_m == null ? 'Location not shared' : `Location ${location.distance_m} m from store`;
    (requireLocation ? hard : soft).push(msg);
  }

  return { hard, soft, insurance, credentials, location, today };
}

module.exports = { evaluateCheckIn, evaluateInsurance, evaluateCredentials, haversineMeters, storeToday, getSetting, activeCompanyOverride };

-- DSD check-in: initial schema

CREATE TABLE stores (
  id               serial PRIMARY KEY,
  store_number     text NOT NULL UNIQUE,
  name             text NOT NULL,
  address          text,
  region           text,
  district         text,
  timezone         text NOT NULL DEFAULT 'America/Chicago',
  lat              double precision,
  lng              double precision,
  geofence_m       integer NOT NULL DEFAULT 200,
  receiving_open   time NOT NULL DEFAULT '06:00',
  receiving_close  time NOT NULL DEFAULT '14:00',
  store_close      time NOT NULL DEFAULT '22:00',
  capacity_per_hour integer NOT NULL DEFAULT 4,
  qr_token         text NOT NULL UNIQUE,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendor_companies (
  id                 serial PRIMARY KEY,
  name               text NOT NULL,
  vendor_number      text,
  email_domains      text[] NOT NULL DEFAULT '{}',
  categories         text[] NOT NULL DEFAULT '{}',
  delivers_by_vehicle boolean NOT NULL DEFAULT true,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  requested_by_email text,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_companies_domains ON vendor_companies USING gin (email_domains);

CREATE TABLE users (
  id                   serial PRIMARY KEY,
  email                text NOT NULL UNIQUE,
  name                 text,
  phone                text,
  role                 text NOT NULL CHECK (role IN ('rep','field_service','visitor','receiver','store_manager','merchant','dsd_ops','admin')),
  vendor_company_id    integer REFERENCES vendor_companies(id),
  store_id             integer REFERENCES stores(id),
  is_vendor_admin      boolean NOT NULL DEFAULT false,
  password_hash        text,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('pending_company','pending_identity','identity_review','active','suspended','removed')),
  id_photo             bytea,
  id_photo_type        text,
  selfie               bytea,
  selfie_type          text,
  identity_submitted_at timestamptz,
  identity_verified_at timestamptz,
  identity_verified_by integer REFERENCES users(id),
  identity_reject_reason text,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_company ON users(vendor_company_id);

CREATE TABLE login_codes (
  id          serial PRIMARY KEY,
  email       text NOT NULL,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_codes_email ON login_codes(email, created_at DESC);

-- Free / personal email domains that may never be used to enroll. Admin-editable.
CREATE TABLE blocked_email_domains (
  domain text PRIMARY KEY
);
INSERT INTO blocked_email_domains(domain) VALUES
 ('gmail.com'),('googlemail.com'),('yahoo.com'),('ymail.com'),('outlook.com'),('hotmail.com'),('live.com'),('msn.com'),
 ('aol.com'),('icloud.com'),('me.com'),('mac.com'),('proton.me'),('protonmail.com'),('gmx.com'),('mail.com'),
 ('zoho.com'),('yandex.com'),('comcast.net'),('att.net'),('verizon.net'),('sbcglobal.net');

-- Insurance requirements are admin-configurable (spec: requirements TBD).
CREATE TABLE insurance_requirements (
  id                     serial PRIMARY KEY,
  coverage_type          text NOT NULL,
  min_per_occurrence     numeric(14,2),
  min_aggregate          numeric(14,2),
  require_additional_insured boolean NOT NULL DEFAULT false,
  visit_types            text[] NOT NULL DEFAULT '{}',   -- empty = all visit types
  categories             text[] NOT NULL DEFAULT '{}',   -- empty = all vendor categories
  vehicle_only           boolean NOT NULL DEFAULT false, -- only companies that deliver by vehicle
  active                 boolean NOT NULL DEFAULT true,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE insurance_policies (
  id                 serial PRIMARY KEY,
  vendor_company_id  integer NOT NULL REFERENCES vendor_companies(id),
  coverage_type      text NOT NULL,
  carrier            text,
  policy_number      text,
  per_occurrence     numeric(14,2),
  aggregate          numeric(14,2),
  additional_insured boolean NOT NULL DEFAULT false,
  effective_date     date NOT NULL,
  expiry_date        date NOT NULL,
  doc                bytea,
  doc_type           text,
  doc_name           text,
  status             text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','rejected')),
  submitted_by       integer REFERENCES users(id),
  verified_by        integer REFERENCES users(id),
  verified_at        timestamptz,
  reject_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX insurance_policies_company ON insurance_policies(vendor_company_id);

-- Company-wide insurance overrides by DSD ops (max 14 days).
CREATE TABLE insurance_overrides (
  id                serial PRIMARY KEY,
  vendor_company_id integer NOT NULL REFERENCES vendor_companies(id),
  reason            text NOT NULL,
  approved_by       integer NOT NULL REFERENCES users(id),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Credential list is undecided: fully configurable by DSD ops.
CREATE TABLE credential_types (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  holder        text NOT NULL DEFAULT 'person' CHECK (holder IN ('person','company')),
  visit_types   text[] NOT NULL DEFAULT '{}',  -- empty = all
  enforcement   text NOT NULL DEFAULT 'soft' CHECK (enforcement IN ('hard','soft')),
  validity_days integer,
  active        boolean NOT NULL DEFAULT true,
  description   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credentials (
  id                 serial PRIMARY KEY,
  credential_type_id integer NOT NULL REFERENCES credential_types(id),
  user_id            integer REFERENCES users(id),
  vendor_company_id  integer REFERENCES vendor_companies(id),
  issuer             text,
  number             text,
  issued_on          date,
  expires_on         date,
  doc                bytea,
  doc_type           text,
  doc_name           text,
  status             text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','rejected')),
  submitted_by       integer REFERENCES users(id),
  verified_by        integer REFERENCES users(id),
  verified_at        timestamptz,
  reject_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR vendor_company_id IS NOT NULL)
);

-- Agreed service schedules, owned by the merchant team.
CREATE TABLE service_agreements (
  id                  serial PRIMARY KEY,
  vendor_company_id   integer NOT NULL REFERENCES vendor_companies(id),
  store_id            integer NOT NULL REFERENCES stores(id),
  category            text,
  visit_type          text NOT NULL,
  days_of_week        integer[] NOT NULL,          -- 0 = Sunday ... 6 = Saturday
  window_start        time NOT NULL,
  window_end          time NOT NULL,
  expected_dwell_min  integer NOT NULL DEFAULT 30,
  min_visits_per_week integer,
  effective_from      date NOT NULL DEFAULT current_date,
  effective_to        date,
  active              boolean NOT NULL DEFAULT true,
  created_by          integer REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_agreements_store ON service_agreements(store_id);
CREATE INDEX service_agreements_vendor ON service_agreements(vendor_company_id);

CREATE TABLE expected_visits (
  id                serial PRIMARY KEY,
  agreement_id      integer REFERENCES service_agreements(id),
  store_id          integer NOT NULL REFERENCES stores(id),
  vendor_company_id integer NOT NULL REFERENCES vendor_companies(id),
  visit_type        text NOT NULL,
  visit_date        date NOT NULL,
  window_start      time NOT NULL,
  window_end        time NOT NULL,
  expected_dwell_min integer,
  status            text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','confirmed','moved','cancelled','missed','completed')),
  announced_by      integer REFERENCES users(id),
  announced_at      timestamptz,
  eta               timestamptz,
  planned_work      text,
  visit_id          integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, visit_date)
);
CREATE INDEX expected_visits_store_date ON expected_visits(store_id, visit_date);
CREATE INDEX expected_visits_vendor_date ON expected_visits(vendor_company_id, visit_date);

CREATE TABLE visits (
  id                 serial PRIMARY KEY,
  user_id            integer NOT NULL REFERENCES users(id),
  vendor_company_id  integer REFERENCES vendor_companies(id),
  store_id           integer NOT NULL REFERENCES stores(id),
  expected_visit_id  integer REFERENCES expected_visits(id),
  visit_type         text NOT NULL,
  purpose            text,
  source             text NOT NULL CHECK (source IN ('scheduled','unscheduled')),
  method             text NOT NULL DEFAULT 'qr' CHECK (method IN ('qr','qr_geofence','manual')),
  status             text NOT NULL CHECK (status IN ('pending_approval','blocked','checked_in','checked_out','auto_closed','denied','cancelled')),
  check_in_lat       double precision,
  check_in_lng       double precision,
  check_in_accuracy_m double precision,
  check_in_distance_m double precision,
  location_ok        boolean,
  credential_result  jsonb NOT NULL DEFAULT '{}'::jsonb,
  insurance_status   jsonb NOT NULL DEFAULT '{}'::jsonb,
  hard_failures      text[] NOT NULL DEFAULT '{}',
  soft_failures      text[] NOT NULL DEFAULT '{}',
  override_reason    text,
  override_by        integer REFERENCES users(id),
  override_scope     text,
  approved_by        integer REFERENCES users(id),
  approved_at        timestamptz,
  acknowledged_by    integer REFERENCES users(id),
  acknowledged_at    timestamptz,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  check_in_at        timestamptz,
  expected_out_at    timestamptz,
  check_out_at       timestamptz,
  checked_out_by     integer REFERENCES users(id),
  work_notes         text,
  receiver_note      text,
  discrepancy        boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visits_store_status ON visits(store_id, status);
CREATE INDEX visits_store_time ON visits(store_id, requested_at);
CREATE INDEX visits_user ON visits(user_id, requested_at DESC);
CREATE INDEX visits_vendor_time ON visits(vendor_company_id, requested_at);
ALTER TABLE expected_visits ADD CONSTRAINT expected_visits_visit_fk FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE SET NULL;

CREATE TABLE work_items (
  id         serial PRIMARY KEY,
  visit_id   integer NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  type       text NOT NULL,
  quantity   integer,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE visit_photos (
  id         serial PRIMARY KEY,
  visit_id   integer NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  data       bytea NOT NULL,
  mime       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id                serial PRIMARY KEY,
  kind              text NOT NULL,
  severity          text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  store_id          integer REFERENCES stores(id),
  vendor_company_id integer REFERENCES vendor_companies(id),
  user_id           integer REFERENCES users(id),
  visit_id          integer REFERENCES visits(id) ON DELETE SET NULL,
  audience          text[] NOT NULL DEFAULT '{}',  -- roles that should see it
  message           text NOT NULL,
  dedupe_key        text UNIQUE,
  dismissed_at      timestamptz,
  dismissed_by      integer REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_store ON alerts(store_id, created_at DESC);

-- Append-only audit log.
CREATE TABLE audit_events (
  id          bigserial PRIMARY KEY,
  actor_id    integer,
  actor_email text,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  store_id    integer,
  before      jsonb,
  after       jsonb,
  ip          text,
  user_agent  text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity ON audit_events(entity, entity_id);
CREATE INDEX audit_events_at ON audit_events(at);
CREATE INDEX audit_events_store ON audit_events(store_id, at);

-- Audit rows can never be updated; they can only be deleted by the retention purge,
-- which sets app.retention_purge = 'on' for its transaction.
CREATE FUNCTION audit_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_events is append-only';
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.retention_purge', true), '') <> 'on' THEN
    RAISE EXCEPTION 'audit_events rows can only be removed by the retention purge';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_guard();

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
INSERT INTO settings(key, value) VALUES
  ('retention_months', '18'),
  ('overstay_margin_min', '30'),
  ('max_company_override_days', '14'),
  ('require_location', 'false');

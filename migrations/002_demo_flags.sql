-- Marks rows created by "Load test data" so they can be removed again in one step.
ALTER TABLE stores ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE vendor_companies ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
CREATE INDEX visits_checkin_time ON visits(check_in_at);

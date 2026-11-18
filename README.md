# DSD Store Check-in

Mobile-first web app that replaces paper backdoor logs. Vendor reps, field service reps and other visitors check in by scanning a QR poster at the store's backdoor on their own phones. Every visit is checked against the vendor's insurance and the configured credentials, shown live to the store, and recorded for HQ scorecards and audits.

Built from the product spec "DSD Store Check-in: Product Requirements (Draft)".

## What's in v1

| Who | What they can do |
| --- | --- |
| Vendor / field service rep | Self-enroll with a company email (personal domains rejected, one-time code), submit ID photo + selfie, scan the backdoor QR to check in (location checked against the store geofence), show a digital visitor pass, check out with work done and shelf photos, confirm / move / cancel scheduled visits with ETA, announce unscheduled visits, upload personal credentials |
| Vendor company admin | Upload certificates of insurance (COI), see insurance status, manage their reps (suspend, remove, make admin), see missed visits |
| Receiver | Store dashboard: waiting at the backdoor (with photo), in store now, today's arrivals vs backdoor capacity, approve soft-fail check-ins with a reason, acknowledge, check people out, receiver notes and discrepancies, evacuation roster, history + CSV |
| Store manager | Everything a receiver does, plus per-visit insurance overrides and receiving hours / capacity |
| HQ merchant | Owns agreed service schedules (days, window, dwell, min visits/week, per store or many stores at once) and the vendor compliance report with the weighted Service Score, CSV export |
| DSD ops / admin | Vendor companies and approved domains, COI verification, company insurance overrides (max 14 days), configurable insurance requirements, configurable credential types (hard or soft), identity review, users, stores and printable QR posters, settings, append-only audit trail + CSV, visit export |

Check-in rules:

* **Hard fails block** check-in: identity not verified, vendor company not active, insurance missing/expired/under limits, any "hard" credential. Only the insurance block can be overridden (store manager for one visit, DSD ops company-wide for up to 14 days). Every override needs a reason, is stored on the visit and raises an alert to DSD ops.
* **Soft fails** wait for the receiver: phone outside the geofence or location off, any "soft" credential. The receiver admits with a reason (logged) or denies.
* Insurance status at the moment of check-in is stored on each visit.

Background jobs run inside the web process every 15 minutes (with a database lock so only one instance runs them): generate expected visits 14 days ahead, mark missed visits, auto-close visits still open at store close (flagged "no check-out", excluded from dwell), overstay alerts, 30/7-day insurance and credential expiry reminders, and the 18-month retention purge.

Not in v1 (spec phases "Scale" / "Integrate" or open questions): SSO for staff, a third-party ID-verification or COI-tracking service, push/SMS notifications (in-app alerts and email only), offline check-in, native iOS/Android apps, "30 minutes out" location sharing, feeds to receiving/BI systems, receiver manual check-in for reps without a smartphone.

## Deploy on Render

1. In Render: **New > Blueprint**, pick this repository. `render.yaml` creates the web service and a Postgres database.
2. When prompted, set:
   * `ADMIN_EMAIL`, `ADMIN_PASSWORD`: the first administrator, created on first start.
   * `PUBLIC_URL`: the app's URL (e.g. `https://dsd-checkin.onrender.com`). It is printed into the QR posters, so set it before printing.
   * `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`: any SMTP provider. Sign-in codes are emailed, so this is needed before real reps use it. For a closed pilot without email you can set `DEV_SHOW_CODES=true` to show the code on screen (this skips email ownership checks; turn it off for real use).
3. Sign in as the admin, then: add stores (with backdoor latitude/longitude), print each store's QR poster, add staff, add insurance requirements and credentials, add vendor companies with their email domains, and have the merchant team load schedules.

Database migrations run automatically on every start.

## Run locally

```bash
npm install
export DATABASE_URL=postgres://postgres@localhost:5432/dsd
export ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me-please
npm run seed:demo      # optional: 3 stores, 3 vendors, staff and schedules (password demo-password-123)
npm run dev            # http://localhost:3000
```

Without SMTP settings (and outside production) sign-in codes are shown on screen and logged.

Demo accounts after `seed:demo`: `ops@demo.example`, `merchant@demo.example`, `receiver101@demo.example`, `manager101@demo.example` (staff, password above); reps `pat@prairiesnacks.example`, `lee@lakeshorebev.example`, `jo@coldchainsvc.example` sign in with a code.

## Tests

```bash
createdb dsd_test
TEST_DATABASE_URL=postgres://postgres@localhost:5432/dsd_test npm test
```

The end-to-end tests wipe that database and cover enrollment, QR check-in and check-out, geofence approval, insurance blocks and both kinds of override, identity review, file permissions, the append-only audit log, jobs and retention, and that every page renders.

## Tech

Node 20+, Express 5, server-rendered EJS, PostgreSQL. Photos and documents are stored in Postgres (`bytea`) and served only through role-checked routes; government ID images are visible to DSD ops only. Sessions are stored in Postgres.

# Hotel Management System — Backend Setup (Phases 3–5)

Follow these steps in order. Do each one, confirm it worked, then move to the next.

## 1. Create your Supabase project (the cloud database)

1. Go to https://supabase.com and sign up (free).
2. Click **New project**. Name it anything (e.g. `resort-management`). Pick a database password and **save it somewhere** — you'll need it in step 3.
3. Wait ~2 minutes for the project to finish provisioning.

## 2. Create the tables

1. In your Supabase project, open the **SQL Editor** (left sidebar).
2. Open `src/schema.sql` from this folder, copy its entire contents, paste into the SQL editor, and click **Run**.
3. Go to **Table Editor** (left sidebar) — you should now see all the tables (`admins`, `staff`, `rooms`, `invoices`, etc.) listed. This is the moment your data stops living in one browser and starts living in the cloud.

## 3. Get your database connection string

1. In Supabase: **Project Settings → Database → Connection string → URI**.
2. Copy it. It looks like `postgresql://postgres:[YOUR-PASSWORD]@db.xxxx.supabase.co:5432/postgres`.
3. Replace `[YOUR-PASSWORD]` with the database password from step 1.

## 4. Set up the backend locally (VS Code, Windows)

Open this `resort-backend` folder in VS Code, then open a terminal (`` Ctrl+` ``) and run:

```
npm install
```

This downloads Express, the Postgres driver, bcrypt, etc. — you'll see a `node_modules` folder appear.

Then:

```
copy .env.example .env
```

Open the new `.env` file and fill in:
- `DATABASE_URL` — the connection string from step 3
- `JWT_SECRET` — run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` in the terminal and paste the output
- `FRONTEND_ORIGIN` — leave as `http://127.0.0.1:5500` for now (that's the default address VS Code's "Live Server" extension uses)

## 5. Run the backend

```
npm run dev
```

**Expected result:** the terminal prints `Hotel API listening on port 4000` and stays running (don't close this terminal — leave it open).

If you see an error instead, stop here and send me the exact terminal output — don't try to fix multiple things at once.

## 6. Test it's alive

Open a browser and go to: `http://localhost:4000/api/health`
**Expected result:** you see `{"ok":true}`.

## 7. Test admin signup via the API directly

In a **second** terminal (keep the first one running `npm run dev`):

```
curl -X POST http://localhost:4000/api/auth/admin/signup -H "Content-Type: application/json" -d "{\"firstName\":\"Test\",\"lastName\":\"Admin\",\"email\":\"admin@test.com\",\"password\":\"test123\"}"
```

**Expected result:** a JSON response containing a `token` and a `user` object. If you get this, go check the Supabase Table Editor → `admins` table — your test admin should be sitting there as a real database row, not in any browser's localStorage.

## What's next (once steps 1–7 all work)

Confirm each step above worked, and tell me the result of step 7. Then we move to:
- **Phase 6:** wiring your actual `index.html` to call `frontend/api.js` instead of `storageGet`/`storageSet`, function by function, starting with login.
- **Phase 7:** a one-time migration tool to pull your *existing* localStorage data into this database, so nothing you've already entered is lost.
- **Phase 8:** the exact two-device test you described (create staff on Device A, log in and book a room on Device B, see it appear on Device A).
- **Phase 9:** deploying this backend (Render/Railway) and your frontend (Vercel/Netlify) so it works over the real internet, not just `localhost`.

Do not skip ahead to wiring the frontend before steps 1–7 above are confirmed working — if the foundation isn't solid, every problem after this gets harder to diagnose.

---

## Setting up admin password reset (added later)

This adds a real "Forgot Password?" flow for Admin accounts. Staff accounts are unaffected — staff still get their password reset by their Admin from Staff Management.

1. **Run the database migration.** In Supabase → SQL Editor, run the contents of `migrations/001_add_admin_password_reset.sql`. It's safe to run even if you're unsure whether it already ran.
2. **Install the new dependency:**
   ```
   npm install
   ```
   (this pulls in `nodemailer`, now listed in `package.json`).
3. **Add SMTP settings to your `.env`.** See the new block in `.env.example` — the easiest option is a Gmail **App Password** (not your normal Gmail password): Google Account → Security → 2-Step Verification → App passwords.
4. **Make sure `FRONTEND_ORIGIN` in `.env` points at wherever your frontend is actually hosted** (e.g. your Vercel/Netlify URL, or `http://127.0.0.1:5500` for local testing) — the reset email links to `<FRONTEND_ORIGIN>/reset-password.html?token=...`, so this has to be correct for the link to work.
5. **Upload `reset-password.html` to your frontend**, next to `index.html` — it isn't wired into the single-page app on purpose, it's a small standalone page so a reset link works even without loading the whole dashboard first.
6. **Test it end to end:** on the login page, click "Forgot Password?", enter a real admin email you control, and confirm the email arrives and the link on it resets your password.

---

## Staff invites by email (added later)

Admins no longer set a password when adding staff — the new hire gets an email with a link to set their own, the same pattern as the password reset above.

1. **Run the migration** `migrations/002_staff_invites_and_renewal_reminders.sql` in Supabase (covers this feature and the renewal reminders below in one file).
2. **Upload `staff-invite.html`** to your frontend, next to `index.html` — same reasoning as `reset-password.html`: a standalone page so the emailed link works without loading the whole dashboard first.
3. No new env vars needed — this reuses the SMTP settings from the password-reset setup above.
4. **Test it:** as an Admin, add a staff account with an email you control, confirm the invite arrives, and that clicking it lets you set a password and lands you straight in the dashboard. If an invite is lost or expires (links last 72 hours), there's a "Resend invite" button next to that staff member in Staff Management.

## Subscription renewal reminder emails (added later)

An admin gets emailed automatically when their plan is within 7 days of expiring — but since this server can go to sleep on a free host (see the note below), it can't reliably remind itself on a timer. Instead, it exposes an endpoint that YOU trigger once a day from outside:

1. Make sure you've run `migrations/002_staff_invites_and_renewal_reminders.sql` (same one as above).
2. **Generate a secret:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and put it in your `.env` as `CRON_SECRET`.
3. **Set up a free daily cron job** at [cron-job.org](https://cron-job.org) (no cost, no card):
   - URL: `https://<your-backend-url>/api/internal/send-renewal-reminders`
   - Method: `POST`
   - Header: `x-cron-secret: <the same value you put in CRON_SECRET>`
   - Schedule: once a day (any time)
4. **Test it manually first** with curl before relying on the schedule:
   ```
   curl -X POST https://<your-backend-url>/api/internal/send-renewal-reminders -H "x-cron-secret: <your secret>"
   ```
   It returns `{ checked, sent, failed }` so you can see it worked even with zero subscriptions currently due.

## Keeping a free-tier backend awake (added later)

If your backend is on a free host (Render's free tier is the common one), it goes to sleep after ~15 minutes of no traffic, and the next request can take 30-50 seconds to wake it back up — the frontend now explains this with a "waking up" message instead of a frozen spinner, but it's still a bad first impression. To avoid it entirely, set up a **second** free cron-job.org job:
   - URL: `https://<your-backend-url>/api/health`
   - Method: `GET`
   - Schedule: every 10 minutes
   - No header needed — this endpoint isn't protected.

This is separate from the renewal-reminder cron job above (different URL, different schedule, no secret) — you'll have two jobs running on cron-job.org once both are set up.

## Running the automated tests (added later)

A handful of unit tests now cover the trickiest pure logic — subscription upgrade/downgrade rules, discount math, and the plan/department/feature access tables — without needing a database connection.

```
npm install
npm test
```

These are deliberately narrow: they don't test anything that touches Postgres, Razorpay, or email directly. If you change `utils/planPricing.js` or the `PLAN_DEPARTMENTS`/`PLAN_FEATURES` tables in `middleware/rbac.js`, run `npm test` before deploying — that's exactly the kind of change these are meant to catch.

## Analytics (added later)

`index.html` now loads Google Analytics (GA4), which is free regardless of traffic. It ships with a placeholder ID (`G-XXXXXXXXXX`) that sends data nowhere useful until you replace it: create a free property at [analytics.google.com](https://analytics.google.com) → Admin → Create Property → Data Streams → Web, copy the Measurement ID shown there, and swap it into the two places marked in `index.html`'s `<head>`.
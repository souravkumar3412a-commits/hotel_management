# Resort Management System — Backend Setup (Phases 3–5)

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

**Expected result:** the terminal prints `Resort API listening on port 4000` and stays running (don't close this terminal — leave it open).

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

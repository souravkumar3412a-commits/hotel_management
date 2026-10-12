// Connects to your Supabase Postgres database using the connection string
// you'll put in .env as DATABASE_URL. Every route file imports `pool` from here.
const { Pool, types } = require('pg');

// Return DATE columns (e.g. a promo code's expiry_date) as plain "YYYY-MM-DD"
// text instead of letting node-pg turn them into JavaScript Date objects.
// Without this, the date reaches the browser as a full timestamp string and the
// Promo Codes page can't read it (expiry shows as an invalid date and an
// expired code never gets marked Expired). Only promo_codes.expiry_date uses
// the DATE type; every other date column is TIMESTAMPTZ and is unaffected.
types.setTypeParser(1082, (value) => value);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // required for Supabase's hosted Postgres
});

pool.on('error', (err) => {
  console.error('Unexpected database error', err);
});

module.exports = { pool };
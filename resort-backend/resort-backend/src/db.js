// Connects to your Supabase Postgres database using the connection string
// you'll put in .env as DATABASE_URL. Every route file imports `pool` from here.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // required for Supabase's hosted Postgres
});

pool.on('error', (err) => {
  console.error('Unexpected database error', err);
});

module.exports = { pool };

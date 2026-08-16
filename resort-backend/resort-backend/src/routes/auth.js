const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 12;
const TOKEN_EXPIRY = '12h';

function sign(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

// POST /api/auth/admin/signup
router.post('/admin/signup', async (req, res) => {
  const { firstName, lastName, email, password } = req.body;
  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ error: 'First name, last name, email and password are all required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const existing = await pool.query('SELECT id FROM admins WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An admin account with this email already exists.' });
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO admins (first_name, last_name, email, password_hash)
       VALUES ($1,$2,$3,$4) RETURNING id, first_name, last_name, email`,
      [firstName, lastName, normalizedEmail, hash]
    );
    const admin = result.rows[0];
    // Give every new tenant an empty settings row so later reads never 404.
    await pool.query('INSERT INTO hotel_settings (admin_id) VALUES ($1)', [admin.id]);
    await pool.query('INSERT INTO restaurant_settings (admin_id) VALUES ($1)', [admin.id]);

    const token = sign({ role: 'admin', adminId: admin.id, email: admin.email });
    res.status(201).json({ token, user: { role: 'admin', adminId: admin.id, email: admin.email, firstName: admin.first_name, lastName: admin.last_name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong creating the admin account.' });
  }
});

// POST /api/auth/admin/login
router.post('/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const result = await pool.query('SELECT * FROM admins WHERE email = $1', [normalizedEmail]);
    const admin = result.rows[0];
    if (!admin) return res.status(401).json({ error: 'No admin account found with that email.' });
    if (!admin.password_hash) {
      return res.status(401).json({ error: 'This account was created with Google — use "Continue with Google" instead.' });
    }
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect password.' });
    const token = sign({ role: 'admin', adminId: admin.id, email: admin.email });
    res.json({ token, user: { role: 'admin', adminId: admin.id, email: admin.email, firstName: admin.first_name, lastName: admin.last_name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong logging in.' });
  }
});

// POST /api/auth/admin/google — "Continue with Google" for the Admin role only.
// The frontend gets a Google access token via Google Identity Services and sends
// it here; we ask Google whose token it is, then either log that person in (if an
// admin with that email already exists) or create a brand-new admin account for
// them — this is standard "sign up or log in with Google" behavior in one step.
router.post('/admin/google', async (req, res) => {
  const { accessToken } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'Missing Google access token.' });
  try {
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!profileRes.ok) {
      return res.status(401).json({ error: 'Could not verify that Google account. Please try again.' });
    }
    const profile = await profileRes.json();
    if (!profile.email || profile.email_verified !== true && profile.email_verified !== 'true') {
      return res.status(401).json({ error: 'Your Google account\'s email isn\'t verified.' });
    }
    const normalizedEmail = profile.email.trim().toLowerCase();

    const existing = await pool.query('SELECT * FROM admins WHERE email = $1', [normalizedEmail]);
    let admin;
    if (existing.rows[0]) {
      admin = existing.rows[0];
      // Link this Google account to an existing (e.g. password-based) admin with the same email.
      if (!admin.google_sub) {
        await pool.query('UPDATE admins SET google_sub = $1 WHERE id = $2', [profile.sub, admin.id]);
      }
    } else {
      const result = await pool.query(
        `INSERT INTO admins (first_name, last_name, email, password_hash, auth_provider, google_sub)
         VALUES ($1,$2,$3,NULL,'google',$4) RETURNING id, first_name, last_name, email`,
        [profile.given_name || profile.name || 'Admin', profile.family_name || '', normalizedEmail, profile.sub]
      );
      admin = result.rows[0];
      await pool.query('INSERT INTO hotel_settings (admin_id) VALUES ($1)', [admin.id]);
      await pool.query('INSERT INTO restaurant_settings (admin_id) VALUES ($1)', [admin.id]);
    }

    const token = sign({ role: 'admin', adminId: admin.id, email: admin.email });
    res.json({ token, user: { role: 'admin', adminId: admin.id, email: admin.email, firstName: admin.first_name, lastName: admin.last_name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong signing in with Google.' });
  }
});

// POST /api/auth/staff/login
// Staff log in with (staffId, password) only — no email, no admin selection —
// exactly like the original UI. We look the staffId up across all tenants.
router.post('/staff/login', async (req, res) => {
  const { staffId, password } = req.body;
  if (!staffId || !password) return res.status(400).json({ error: 'Staff ID and password are required.' });
  try {
    const result = await pool.query('SELECT * FROM staff WHERE lower(staff_id) = lower($1)', [staffId]);
    const acct = result.rows[0];
    if (!acct) return res.status(401).json({ error: 'No staff account found with that Staff ID.' });
    const ok = await bcrypt.compare(password, acct.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect password.' });
    const token = sign({ role: 'staff', staffId: acct.staff_id, name: acct.name, department: acct.department, adminId: acct.admin_id });
    res.json({ token, user: { role: 'staff', staffId: acct.staff_id, name: acct.name, department: acct.department, adminId: acct.admin_id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong logging in.' });
  }
});

// GET /api/auth/me — used on app load to check if the stored token is still valid
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendPasswordResetEmail } = require('../utils/mailer');

const router = express.Router();
const SALT_ROUNDS = 12;
const TOKEN_EXPIRY = '12h';

// How long a password-reset link stays valid after it's requested.
const RESET_TOKEN_TTL_MINUTES = 30;

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
    await pool.query('INSERT INTO subscriptions (admin_id) VALUES ($1)', [admin.id]);
    await pool.query('INSERT INTO restaurant_settings (admin_id) VALUES ($1)', [admin.id]);

    const token = sign({ role: 'admin', adminId: admin.id, email: admin.email });
    res.status(201).json({ token, user: { role: 'admin', adminId: admin.id, email: admin.email, firstName: admin.first_name, lastName: admin.last_name, photo: null } });
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
    res.json({ token, user: { role: 'admin', adminId: admin.id, email: admin.email, firstName: admin.first_name, lastName: admin.last_name, photo: admin.photo_url || null } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong logging in.' });
  }
});

// POST /api/auth/admin/google
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
      await pool.query('INSERT INTO subscriptions (admin_id) VALUES ($1)', [admin.id]);
      await pool.query('INSERT INTO restaurant_settings (admin_id) VALUES ($1)', [admin.id]);
    }

    const token = sign({ role: 'admin', adminId: admin.id, email: admin.email });
    res.json({ token, user: { role: 'admin', adminId: admin.id, email: admin.email, firstName: admin.first_name, lastName: admin.last_name, photo: admin.photo_url || null } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong signing in with Google.' });
  }
});

// POST /api/auth/staff/login
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
    res.json({ token, user: { role: 'staff', staffId: acct.staff_id, name: acct.name, department: acct.department, adminId: acct.admin_id, photo: acct.photo_url || null } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong logging in.' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const r = await pool.query('SELECT id, email, first_name, last_name, photo_url FROM admins WHERE id = $1', [req.user.adminId]);
      if (!r.rows[0]) return res.status(401).json({ error: 'Account no longer exists.' });
      const a = r.rows[0];
      return res.json({ user: { role: 'admin', adminId: a.id, email: a.email, firstName: a.first_name, lastName: a.last_name, photo: a.photo_url || null } });
    }
    const r = await pool.query('SELECT staff_id, name, department, admin_id, photo_url FROM staff WHERE staff_id = $1 AND admin_id = $2', [req.user.staffId, req.user.adminId]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Account no longer exists.' });
    const s = r.rows[0];
    res.json({ user: { role: 'staff', staffId: s.staff_id, name: s.name, department: s.department, adminId: s.admin_id, photo: s.photo_url || null } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong loading your profile.' });
  }
});

// PUT /api/auth/admin/profile
router.put('/admin/profile', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  const { firstName, lastName, photo } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: 'First name and last name are required.' });
  try {
    const r = await pool.query(
      'UPDATE admins SET first_name = $1, last_name = $2, photo_url = $3 WHERE id = $4 RETURNING id, email, first_name, last_name, photo_url',
      [firstName, lastName, photo === undefined ? null : photo, req.user.adminId]
    );
    const a = r.rows[0];
    res.json({ role: 'admin', adminId: a.id, email: a.email, firstName: a.first_name, lastName: a.last_name, photo: a.photo_url || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong updating your profile.' });
  }
});

// PUT /api/auth/staff/profile
router.put('/staff/profile', requireAuth, async (req, res) => {
  if (req.user.role !== 'staff') return res.status(403).json({ error: 'Staff access required.' });
  const { name, photo } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  try {
    const r = await pool.query(
      'UPDATE staff SET name = $1, photo_url = $2 WHERE staff_id = $3 AND admin_id = $4 RETURNING staff_id, name, department, admin_id, photo_url',
      [name, photo === undefined ? null : photo, req.user.staffId, req.user.adminId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Account not found.' });
    const s = r.rows[0];
    res.json({ role: 'staff', staffId: s.staff_id, name: s.name, department: s.department, adminId: s.admin_id, photo: s.photo_url || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong updating your profile.' });
  }
});

// ============================================================
// Admin password reset (self-service)
// ============================================================
// Staff deliberately do NOT get a self-service reset here — their admin
// already has PUT /api/staff/:id/reset-password for that (see routes/staff.js).
// An admin has no one "above" them to ask, so they need their own flow.

// POST /api/auth/admin/forgot-password — body: { email }
// Always responds with the same generic message whether or not the email
// exists, so this endpoint can't be used to check which emails have an
// account here (a common account-enumeration mistake).
router.post('/admin/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  const normalizedEmail = String(email).trim().toLowerCase();
  const genericResponse = { message: 'If an account exists for that email, we\'ve sent a password reset link.' };

  try {
    const result = await pool.query('SELECT id, first_name, email, auth_provider FROM admins WHERE email = $1', [normalizedEmail]);
    const admin = result.rows[0];

    // Deliberately return the SAME response whether the admin exists, has no
    // password (Google-only account), or the email fails to send — the
    // person on the other end can't distinguish any of these cases, and
    // that's the point. Only a genuinely broken request (bad email format
    // above) gets a different response.
    if (!admin || admin.auth_provider === 'google') {
      return res.json(genericResponse);
    }

    // Raw token goes in the emailed link; only its SHA-256 hash is ever
    // stored, so a leaked database backup alone can't be used to reset
    // anyone's password.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

    await pool.query(
      'UPDATE admins SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3',
      [tokenHash, expiresAt, admin.id]
    );

    const frontendOrigin = (process.env.FRONTEND_ORIGIN || '').split(',')[0].trim() || 'http://127.0.0.1:5500';
    const resetLink = `${frontendOrigin}/reset-password.html?token=${rawToken}`;

    const sendResult = await sendPasswordResetEmail({ to: admin.email, firstName: admin.first_name, resetLink, ttlMinutes: RESET_TOKEN_TTL_MINUTES });
    if (!sendResult.ok) {
      // Log the real reason server-side for you to debug — never leak it to
      // the client, and never let a mail-server hiccup reveal account existence.
      console.error('Password reset email failed to send:', sendResult.error);
    }
    res.json(genericResponse);
  } catch (err) {
    console.error(err);
    // Still generic — an unexpected error here shouldn't tell anyone
    // whether the email exists either.
    res.json(genericResponse);
  }
});

// POST /api/auth/admin/reset-password — body: { token, newPassword }
router.post('/admin/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Reset token and new password are required.' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const result = await pool.query(
      'SELECT id FROM admins WHERE reset_token_hash = $1 AND reset_token_expires > now()',
      [tokenHash]
    );
    const admin = result.rows[0];
    if (!admin) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }
    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    // Clearing the token fields makes the link single-use — a second
    // attempt with the same link (or a leaked/replayed one) fails cleanly.
    await pool.query(
      'UPDATE admins SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = $2',
      [hash, admin.id]
    );
    res.json({ message: 'Your password has been reset. You can now log in with your new password.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong resetting your password.' });
  }
});

// ============================================================
// Staff invite acceptance
// ============================================================
// POST /api/auth/staff/accept-invite — body: { token, password }
// The counterpart to routes/staff.js's issueStaffInvite(): sets a first
// password for a staff account created without one, and — like the admin
// reset-password route above — clears the token so the link is single-use.
router.post('/staff/accept-invite', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Invite token and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const result = await pool.query(
      'SELECT id, staff_id, name, department, admin_id FROM staff WHERE invite_token_hash = $1 AND invite_token_expires > now()',
      [tokenHash]
    );
    const staffRow = result.rows[0];
    if (!staffRow) {
      return res.status(400).json({ error: 'This invite link is invalid or has expired. Ask your admin to resend it.' });
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    await pool.query(
      'UPDATE staff SET password_hash = $1, invite_token_hash = NULL, invite_token_expires = NULL WHERE id = $2',
      [hash, staffRow.id]
    );
    // Log them straight in — they just proved control of their own invite
    // link, which is the same trust level as a normal login.
    const token2 = sign({ role: 'staff', staffId: staffRow.staff_id, name: staffRow.name, department: staffRow.department, adminId: staffRow.admin_id });
    res.json({
      message: 'Your account is ready.',
      token: token2,
      user: { role: 'staff', staffId: staffRow.staff_id, name: staffRow.name, department: staffRow.department, adminId: staffRow.admin_id, photo: null }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong setting up your account.' });
  }
});

module.exports = router;
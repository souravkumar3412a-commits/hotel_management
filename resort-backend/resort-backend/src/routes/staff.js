const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin, getPlanAccess } = require('../middleware/rbac');
const { sendStaffInviteEmail } = require('../utils/mailer');

const router = express.Router();
const SALT_ROUNDS = 12;
const INVITE_TOKEN_TTL_HOURS = 72;

router.use(requireAuth);

// GET /api/staff — list this admin's staff
router.get('/', requireAdmin, async (req, res) => {
  const result = await pool.query(
    'SELECT id, staff_id, name, email, phone, department, created_at, (password_hash IS NULL) AS invite_pending FROM staff WHERE admin_id = $1 ORDER BY created_at',
    [req.user.adminId]
  );
  res.json(result.rows);
});

// Very light validation — good enough to catch obvious typos without being
// a strict/annoying email or phone-number parser.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function digitsOnly(s) { return String(s || '').replace(/\D/g, ''); }

// Generates and stores a fresh invite token for a staff row, and emails it.
// Shared by POST / (create) and POST /:id/resend-invite so both paths stay
// in sync. Never throws — a failed send is logged and the caller still
// succeeds, since the account exists either way and the Admin can resend.
async function issueStaffInvite({ staffRow, adminId }) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_HOURS * 60 * 60 * 1000);
  await pool.query(
    'UPDATE staff SET invite_token_hash = $1, invite_token_expires = $2 WHERE id = $3',
    [tokenHash, expiresAt, staffRow.id]
  );
  const settingsRes = await pool.query('SELECT hotel_name FROM hotel_settings WHERE admin_id = $1', [adminId]);
  const hotelName = settingsRes.rows[0] && settingsRes.rows[0].hotel_name;
  const frontendOrigin = (process.env.FRONTEND_ORIGIN || '').split(',')[0].trim() || 'http://127.0.0.1:5500';
  const inviteLink = `${frontendOrigin}/staff-invite.html?token=${rawToken}`;
  const sendResult = await sendStaffInviteEmail({
    to: staffRow.email, staffName: staffRow.name, hotelName, department: staffRow.department,
    staffId: staffRow.staff_id, inviteLink, ttlHours: INVITE_TOKEN_TTL_HOURS
  });
  if (!sendResult.ok) console.error('Staff invite email failed to send:', sendResult.error);
  return sendResult;
}

// POST /api/staff — create a staff account. Which departments are even
// allowed depends on the admin's current plan (see rbac.js PLAN_DEPARTMENTS)
// — a Restaurant-only admin can only ever create a Restaurant staff account,
// a Room+Banquet admin can create Room and Banquet staff, and so on.
// The Admin no longer sets a password here — the new staff member gets an
// emailed invite link and sets their own (see POST /auth/staff/accept-invite).
router.post('/', requireAdmin, async (req, res) => {
  const { staffId, name, email, phone, department } = req.body;
  if (!staffId || !name || !email || !phone || !department) {
    return res.status(400).json({ error: 'Staff ID, name, email, phone and department are all required.' });
  }
  if (!EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  const phoneDigits = digitsOnly(phone);
  if (phoneDigits.length < 7 || phoneDigits.length > 15) {
    return res.status(400).json({ error: 'Enter a valid phone number.' });
  }
  if (!['room', 'banquet', 'restaurant'].includes(department)) {
    return res.status(400).json({ error: 'Invalid department.' });
  }
  try {
    const { departments: planDepartments, active } = await getPlanAccess(req.user.adminId);
    if (!active) {
      return res.status(402).json({ error: 'Your subscription is not active. Please subscribe to continue.' });
    }
    if (!planDepartments.includes(department)) {
      return res.status(403).json({ error: `Your current plan doesn't include ${department} — upgrade your plan to add staff there.` });
    }
    // One staff account per department, and the number of departments you
    // can ever have staff in is capped by your plan (not a flat 3 anymore).
    const countRes = await pool.query('SELECT count(*) FROM staff WHERE admin_id = $1', [req.user.adminId]);
    if (parseInt(countRes.rows[0].count, 10) >= planDepartments.length) {
      return res.status(409).json({ error: 'All departments included in your plan are already staffed.' });
    }
    const deptTaken = await pool.query('SELECT id FROM staff WHERE admin_id = $1 AND department = $2', [req.user.adminId, department]);
    if (deptTaken.rows.length > 0) {
      return res.status(409).json({ error: 'That department already has a staff account. Remove it to add another.' });
    }
    const result = await pool.query(
      `INSERT INTO staff (admin_id, staff_id, name, email, phone, department)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, staff_id, name, email, phone, department, created_at`,
      [req.user.adminId, staffId, name, String(email).trim().toLowerCase(), phoneDigits, department]
    );
    const staffRow = result.rows[0];
    const sendResult = await issueStaffInvite({ staffRow, adminId: req.user.adminId });
    res.status(201).json(Object.assign({}, staffRow, { invitePending: true, inviteEmailSent: sendResult.ok }));
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return res.status(409).json({ error: 'That Staff ID is already in use.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong creating the staff account.' });
  }
});

// POST /api/staff/:id/resend-invite — for when the first email got lost,
// landed in spam, or its 72-hour link simply expired before they used it.
router.post('/:id/resend-invite', requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, staff_id, name, email, department, password_hash FROM staff WHERE id = $1 AND admin_id = $2',
      [req.params.id, req.user.adminId]
    );
    const staffRow = r.rows[0];
    if (!staffRow) return res.status(404).json({ error: 'Staff account not found.' });
    if (staffRow.password_hash) {
      return res.status(400).json({ error: 'This staff member has already set their password — use "Reset password" instead.' });
    }
    const sendResult = await issueStaffInvite({ staffRow, adminId: req.user.adminId });
    if (!sendResult.ok) {
      return res.status(502).json({ error: 'Could not send the invite email. Check your server\'s SMTP configuration.' });
    }
    res.json({ message: 'Invite email resent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong resending the invite.' });
  }
});

// DELETE /api/staff/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM staff WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});

// PUT /api/staff/:id — edit name/email/phone/department (Staff ID and
// password are changed through their own dedicated flows, not this one).
router.put('/:id', requireAdmin, async (req, res) => {
  const { name, email, phone, department } = req.body;
  if (!name || !email || !phone || !department) {
    return res.status(400).json({ error: 'Name, email, phone and department are all required.' });
  }
  if (!EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  const phoneDigits = digitsOnly(phone);
  if (phoneDigits.length < 7 || phoneDigits.length > 15) {
    return res.status(400).json({ error: 'Enter a valid phone number.' });
  }
  if (!['room', 'banquet', 'restaurant'].includes(department)) {
    return res.status(400).json({ error: 'Invalid department.' });
  }
  try {
    const { departments: planDepartments, active } = await getPlanAccess(req.user.adminId);
    if (!active) {
      return res.status(402).json({ error: 'Your subscription is not active. Please subscribe to continue.' });
    }
    if (!planDepartments.includes(department)) {
      return res.status(403).json({ error: `Your current plan doesn't include ${department} — upgrade your plan to move staff there.` });
    }
    // Same "one staff account per department" rule as creation — just
    // excluding this staff member's own current row from the check.
    const deptTaken = await pool.query(
      'SELECT id FROM staff WHERE admin_id = $1 AND department = $2 AND id <> $3',
      [req.user.adminId, department, req.params.id]
    );
    if (deptTaken.rows.length > 0) {
      return res.status(409).json({ error: departmentAlreadyStaffedError(department) });
    }
    const r = await pool.query(
      `UPDATE staff SET name=$1, email=$2, phone=$3, department=$4
       WHERE id=$5 AND admin_id=$6 RETURNING id, staff_id, name, email, phone, department, created_at`,
      [name, String(email).trim().toLowerCase(), phoneDigits, department, req.params.id, req.user.adminId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Staff account not found.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong updating the staff account.' });
  }
});
function departmentAlreadyStaffedError(department) {
  const labels = { room: 'Room Management', banquet: 'Banquet Management', restaurant: 'Restaurant Management' };
  return `${labels[department] || department} already has a staff account. Remove it to move this account there.`;
}

// PUT /api/staff/:id/reset-password
router.put('/:id/reset-password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const r = await pool.query(
    'UPDATE staff SET password_hash = $1 WHERE id = $2 AND admin_id = $3 RETURNING id',
    [hash, req.params.id, req.user.adminId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Staff account not found.' });
  res.status(204).end();
});

module.exports = router;
const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');

const router = express.Router();
const SALT_ROUNDS = 12;
const MAX_STAFF_ACCOUNTS = 3; // one per department, matches original app

router.use(requireAuth);

// GET /api/staff — list this admin's staff
router.get('/', requireAdmin, async (req, res) => {
  const result = await pool.query(
    'SELECT id, staff_id, name, department, created_at FROM staff WHERE admin_id = $1 ORDER BY created_at',
    [req.user.adminId]
  );
  res.json(result.rows);
});

// POST /api/staff — create a staff account
router.post('/', requireAdmin, async (req, res) => {
  const { staffId, name, department, password } = req.body;
  if (!staffId || !name || !department || !password) {
    return res.status(400).json({ error: 'Staff ID, name, department and password are all required.' });
  }
  if (!['room', 'banquet', 'restaurant'].includes(department)) {
    return res.status(400).json({ error: 'Invalid department.' });
  }
  try {
    const countRes = await pool.query('SELECT count(*) FROM staff WHERE admin_id = $1', [req.user.adminId]);
    if (parseInt(countRes.rows[0].count, 10) >= MAX_STAFF_ACCOUNTS) {
      return res.status(409).json({ error: 'All departments are staffed. Remove one to add another.' });
    }
    const deptTaken = await pool.query('SELECT id FROM staff WHERE admin_id = $1 AND department = $2', [req.user.adminId, department]);
    if (deptTaken.rows.length > 0) {
      return res.status(409).json({ error: 'That department already has a staff account. Remove it to add another.' });
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO staff (admin_id, staff_id, name, department, password_hash)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, staff_id, name, department, created_at`,
      [req.user.adminId, staffId, name, department, hash]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return res.status(409).json({ error: 'That Staff ID is already in use.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong creating the staff account.' });
  }
});

// DELETE /api/staff/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM staff WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});

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
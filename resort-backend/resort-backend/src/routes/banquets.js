const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin, requireDepartment } = require('../middleware/rbac');

const router = express.Router();
router.use(requireAuth);

// ---------- halls ----------
router.get('/halls', requireDepartment('banquet'), async (req, res) => {
  const r = await pool.query('SELECT * FROM banquet_halls WHERE admin_id = $1 ORDER BY name', [req.user.adminId]);
  res.json(r.rows);
});
router.post('/halls', requireAdmin, async (req, res) => {
  const b = req.body;
  const r = await pool.query(
    `INSERT INTO banquet_halls (admin_id, name, capacity, facilities, out_of_order, pricing)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user.adminId, b.name, b.capacity, JSON.stringify(b.facilities || []), !!b.outOfOrder, JSON.stringify(b.pricing || {})]
  );
  res.status(201).json(r.rows[0]);
});
router.put('/halls/:id', requireAdmin, async (req, res) => {
  const b = req.body;
  const r = await pool.query(
    `UPDATE banquet_halls SET name=$1, capacity=$2, facilities=$3, out_of_order=$4, pricing=$5
     WHERE id=$6 AND admin_id=$7 RETURNING *`,
    [b.name, b.capacity, JSON.stringify(b.facilities || []), !!b.outOfOrder, JSON.stringify(b.pricing || {}), req.params.id, req.user.adminId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Hall not found.' });
  res.json(r.rows[0]);
});
router.delete('/halls/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM banquet_halls WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});

// ---------- bookings ----------
router.get('/bookings', requireDepartment('banquet'), async (req, res) => {
  const r = await pool.query('SELECT * FROM banquet_bookings WHERE admin_id = $1 ORDER BY created_at DESC', [req.user.adminId]);
  res.json(r.rows);
});
router.post('/bookings', requireDepartment('banquet'), async (req, res) => {
  const b = req.body;
  const staffId = req.user.role === 'staff' ? req.user.staffId : null;
  const staffName = req.user.role === 'staff' ? req.user.name : null;
  try {
    const r = await pool.query(
      `INSERT INTO banquet_bookings (admin_id, booking_code, hall_id, customer_name, customer_phone, guest_count,
                                      pricing_basis, unit_price, duration_count, start_at, end_at, total_amount,
                                      created_by_staff_id, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.user.adminId, b.bookingCode, b.hallId, b.customerName, b.customerPhone, b.guestCount,
       b.pricingBasis, b.unitPrice, b.durationCount, b.startISO, b.endISO, b.totalAmount, staffId, staffName]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong creating the booking.' });
  }
});
router.put('/bookings/:id/status', requireDepartment('banquet'), async (req, res) => {
  const { status } = req.body; // 'completed' | 'cancelled'
  const r = await pool.query(
    'UPDATE banquet_bookings SET status=$1 WHERE id=$2 AND admin_id=$3 RETURNING *',
    [status, req.params.id, req.user.adminId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Booking not found.' });
  res.json(r.rows[0]);
});

module.exports = router;

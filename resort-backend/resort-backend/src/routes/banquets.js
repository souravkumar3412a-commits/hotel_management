const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdminDepartment, requireDepartment } = require('../middleware/rbac');
const { uploadImageToSupabase, deleteImageFromSupabase } = require('../utils/storage');

const router = express.Router();
router.use(requireAuth);

// ---------- halls ----------
router.get('/halls', requireDepartment('banquet'), async (req, res) => {
  const r = await pool.query('SELECT * FROM banquet_halls WHERE admin_id = $1 ORDER BY name', [req.user.adminId]);
  res.json(r.rows);
});
router.post('/halls', requireAdminDepartment('banquet'), async (req, res) => {
  const b = req.body;
  const r = await pool.query(
    `INSERT INTO banquet_halls (admin_id, name, capacity, facilities, out_of_order, pricing)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.user.adminId, b.name, b.capacity, JSON.stringify(b.facilities || []), !!b.outOfOrder, JSON.stringify(b.pricing || {})]
  );
  res.status(201).json(r.rows[0]);
});
router.put('/halls/:id', requireAdminDepartment('banquet'), async (req, res) => {
  const b = req.body;
  const r = await pool.query(
    `UPDATE banquet_halls SET name=$1, capacity=$2, facilities=$3, out_of_order=$4, pricing=$5
     WHERE id=$6 AND admin_id=$7 RETURNING *`,
    [b.name, b.capacity, JSON.stringify(b.facilities || []), !!b.outOfOrder, JSON.stringify(b.pricing || {}), req.params.id, req.user.adminId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Hall not found.' });
  res.json(r.rows[0]);
});
router.delete('/halls/:id', requireAdminDepartment('banquet'), async (req, res) => {
  await pool.query('DELETE FROM banquet_halls WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});

const HALL_MAX_PHOTOS = 5;

// POST /api/banquets/halls/:id/photos — body: { photoBase64, contentType }.
router.post('/halls/:id/photos', requireAdminDepartment('banquet'), async (req, res) => {
  const { photoBase64, contentType } = req.body;
  if (!photoBase64 || !contentType) return res.status(400).json({ error: 'Missing photo data.' });
  try {
    const hallRes = await pool.query('SELECT photos FROM banquet_halls WHERE id=$1 AND admin_id=$2', [req.params.id, req.user.adminId]);
    if (!hallRes.rows[0]) return res.status(404).json({ error: 'Hall not found.' });
    const photos = hallRes.rows[0].photos || [];
    if (photos.length >= HALL_MAX_PHOTOS) {
      return res.status(409).json({ error: `This hall already has the maximum of ${HALL_MAX_PHOTOS} photos. Remove one first.` });
    }
    const result = await uploadImageToSupabase('hall-photos', `${req.user.adminId}/${req.params.id}`, photoBase64, contentType);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    const updatedPhotos = photos.concat([result.url]);
    await pool.query('UPDATE banquet_halls SET photos=$1 WHERE id=$2', [JSON.stringify(updatedPhotos), req.params.id]);
    res.status(201).json({ photos: updatedPhotos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong uploading the photo.' });
  }
});

// DELETE /api/banquets/halls/:id/photos — body: { url }.
router.delete('/halls/:id/photos', requireAdminDepartment('banquet'), async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing photo URL.' });
  try {
    const hallRes = await pool.query('SELECT photos FROM banquet_halls WHERE id=$1 AND admin_id=$2', [req.params.id, req.user.adminId]);
    if (!hallRes.rows[0]) return res.status(404).json({ error: 'Hall not found.' });
    const photos = (hallRes.rows[0].photos || []).filter((p) => p !== url);
    await pool.query('UPDATE banquet_halls SET photos=$1 WHERE id=$2', [JSON.stringify(photos), req.params.id]);
    deleteImageFromSupabase('hall-photos', url);
    res.json({ photos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong removing the photo.' });
  }
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
  const advanceAmount = Number(b.advanceAmount) || 0;
  if (advanceAmount < 0 || advanceAmount > Number(b.totalAmount || 0)) {
    return res.status(400).json({ error: 'Advance payment can\'t be negative or more than the total.' });
  }
  try {
    const r = await pool.query(
      `INSERT INTO banquet_bookings (admin_id, booking_code, hall_id, customer_name, customer_phone, guest_count,
                                      event_type, food_package, decoration_package,
                                      pricing_basis, unit_price, duration_count, start_at, end_at, total_amount,
                                      advance_amount, advance_payment_method,
                                      created_by_staff_id, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [req.user.adminId, b.bookingCode, b.hallId, b.customerName, b.customerPhone, b.guestCount,
       b.eventType || null, b.foodPackage || null, b.decorationPackage || null,
       b.pricingBasis, b.unitPrice, b.durationCount, b.startISO, b.endISO, b.totalAmount,
       advanceAmount, advanceAmount > 0 ? (b.advancePaymentMethod || 'Cash') : null,
       staffId, staffName]
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
// PUT /api/banquets/bookings/:id/balance — mark the remaining balance as
// collected (e.g. paid in person on the day of the event).
router.put('/bookings/:id/balance', requireDepartment('banquet'), async (req, res) => {
  const r = await pool.query(
    "UPDATE banquet_bookings SET balance_paid = true, balance_paid_at = now() WHERE id=$1 AND admin_id=$2 RETURNING *",
    [req.params.id, req.user.adminId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Booking not found.' });
  res.json(r.rows[0]);
});

module.exports = router;
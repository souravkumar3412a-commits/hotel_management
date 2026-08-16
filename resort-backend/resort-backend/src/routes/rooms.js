const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin, requireDepartment } = require('../middleware/rbac');

const router = express.Router();
router.use(requireAuth);

// ---------- floors ----------
router.get('/floors', requireDepartment('room'), async (req, res) => {
  const r = await pool.query('SELECT * FROM room_floors WHERE admin_id = $1 ORDER BY floor', [req.user.adminId]);
  res.json(r.rows);
});
router.post('/floors', requireAdmin, async (req, res) => {
  const { floor, roomCount } = req.body;
  const r = await pool.query(
    'INSERT INTO room_floors (admin_id, floor, room_count) VALUES ($1,$2,$3) RETURNING *',
    [req.user.adminId, floor, roomCount || 0]
  );
  res.status(201).json(r.rows[0]);
});
router.put('/floors/:id', requireAdmin, async (req, res) => {
  const { roomCount } = req.body;
  const r = await pool.query(
    'UPDATE room_floors SET room_count=$1 WHERE id=$2 AND admin_id=$3 RETURNING *',
    [roomCount || 0, req.params.id, req.user.adminId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Floor not found.' });
  res.json(r.rows[0]);
});
router.delete('/floors/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM room_floors WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});
// ---------- categories ----------
router.get('/categories', requireDepartment('room'), async (req, res) => {
  const r = await pool.query('SELECT * FROM room_categories WHERE admin_id = $1 ORDER BY name', [req.user.adminId]);
  res.json(r.rows);
});
router.post('/categories', requireAdmin, async (req, res) => {
  const { name } = req.body;
  const r = await pool.query('INSERT INTO room_categories (admin_id, name) VALUES ($1,$2) RETURNING *', [req.user.adminId, name]);
  res.status(201).json(r.rows[0]);
});
router.delete('/categories/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM room_categories WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});

// ---------- rooms (inventory) ----------
// Returns each room plus its current active booking (if any) so the frontend
// can render status exactly like before, without storing status redundantly.
router.get('/', requireDepartment('room'), async (req, res) => {
  const r = await pool.query(
    `SELECT rm.*,
            b.id AS booking_id, b.guest_name, b.guest_phone, b.check_in, b.check_out, b.invoice_id
     FROM rooms rm
     LEFT JOIN room_bookings b ON b.room_id = rm.id AND b.status = 'active'
     WHERE rm.admin_id = $1
     ORDER BY rm.room_no`,
    [req.user.adminId]
  );
  res.json(r.rows);
});
router.post('/', requireAdmin, async (req, res) => {
  const b = req.body;
  const r = await pool.query(
    `INSERT INTO rooms (admin_id, room_no, floor, category_id, bed_type, ac, max_adults, max_children,
                         price, amenities, extra_bed_allowed, extra_bed_price, out_of_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [req.user.adminId, b.roomNo, b.floor, b.categoryId, b.bedType, !!b.ac, b.maxAdults || 2, b.maxChildren || 0,
     b.price || 0, JSON.stringify(b.amenities || []), !!b.extraBedAllowed, b.extraBedPrice || 0, !!b.outOfOrder]
  );
  res.status(201).json(r.rows[0]);
});
router.put('/:id', requireAdmin, async (req, res) => {
  const b = req.body;
  const r = await pool.query(
    `UPDATE rooms SET room_no=$1, floor=$2, category_id=$3, bed_type=$4, ac=$5, max_adults=$6, max_children=$7,
                       price=$8, amenities=$9, extra_bed_allowed=$10, extra_bed_price=$11, out_of_order=$12
     WHERE id=$13 AND admin_id=$14 RETURNING *`,
    [b.roomNo, b.floor, b.categoryId, b.bedType, !!b.ac, b.maxAdults, b.maxChildren, b.price,
     JSON.stringify(b.amenities || []), !!b.extraBedAllowed, b.extraBedPrice, !!b.outOfOrder, req.params.id, req.user.adminId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Room not found.' });
  res.json(r.rows[0]);
});
router.delete('/:id', requireAdmin, async (req, res) => {
  const active = await pool.query("SELECT id FROM room_bookings WHERE room_id=$1 AND status='active'", [req.params.id]);
  if (active.rows.length > 0) {
    return res.status(409).json({ error: 'This room currently has a guest — check it out before removing it.' });
  }
  await pool.query('DELETE FROM rooms WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});

// ---------- bookings ----------
router.get('/bookings', requireDepartment('room'), async (req, res) => {
  const { status } = req.query;
  const params = [req.user.adminId];
  let where = 'admin_id = $1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  const r = await pool.query(`SELECT * FROM room_bookings WHERE ${where} ORDER BY created_at DESC`, params);
  res.json(r.rows);
});

// GET /api/rooms/lookup/:roomNo — used by OTHER departments (e.g. Banquet staff
// looking up an in-house guest to autofill a booking). Deliberately open to any
// authenticated staff/admin in the tenant, not just Room department — but only
// returns the minimal guest details for a currently-occupied room, nothing else
// (no pricing, no full inventory), so it can't be used to browse Room data.
router.get('/lookup/:roomNo', async (req, res) => {
  const r = await pool.query(
    `SELECT rm.room_no, b.guest_name, b.guest_phone, b.guest_email, b.id_proof_type, b.id_proof_number
     FROM rooms rm
     JOIN room_bookings b ON b.room_id = rm.id AND b.status = 'active'
     WHERE rm.admin_id = $1 AND rm.room_no = $2`,
    [req.user.adminId, req.params.roomNo]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'No in-house guest found for that room.' });
  res.json(r.rows[0]);
});

router.post('/bookings', requireDepartment('room'), async (req, res) => {
  const b = req.body;
  const staffId = req.user.role === 'staff' ? req.user.staffId : null;
  try {
    // Guard: room must not already have an active booking.
    const active = await pool.query("SELECT id FROM room_bookings WHERE room_id=$1 AND status='active'", [b.roomId]);
    if (active.rows.length > 0) return res.status(409).json({ error: 'That room is already occupied.' });

    const r = await pool.query(
      `INSERT INTO room_bookings (admin_id, room_id, guest_name, guest_phone, guest_email, id_proof_type, id_proof_number, check_in, check_out, created_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.adminId, b.roomId, b.guestName, b.guestPhone, b.guestEmail || null, b.idProofType || null, b.idProofNumber || null, b.checkIn, b.checkOut || null, staffId]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong creating the booking.' });
  }
});
router.put('/bookings/:id/checkout', requireDepartment('room'), async (req, res) => {
  const r = await pool.query(
    "UPDATE room_bookings SET status='completed', check_out=now() WHERE id=$1 AND admin_id=$2 RETURNING *",
    [req.params.id, req.user.adminId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Booking not found.' });
  res.json(r.rows[0]);
});

module.exports = router;
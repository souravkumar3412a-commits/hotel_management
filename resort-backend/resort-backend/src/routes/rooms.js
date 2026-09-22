const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdminDepartment, requireDepartment } = require('../middleware/rbac');
const { uploadImageToSupabase, deleteImageFromSupabase } = require('../utils/storage');

const router = express.Router();
router.use(requireAuth);

// ---------- floors ----------
router.get('/floors', requireDepartment('room'), async (req, res) => {
  const r = await pool.query('SELECT * FROM room_floors WHERE admin_id = $1 ORDER BY floor', [req.user.adminId]);
  res.json(r.rows);
});
router.post('/floors', requireAdminDepartment('room'), async (req, res) => {
  const { floor, roomCount } = req.body;
  const r = await pool.query(
    'INSERT INTO room_floors (admin_id, floor, room_count) VALUES ($1,$2,$3) RETURNING *',
    [req.user.adminId, floor, roomCount || 0]
  );
  res.status(201).json(r.rows[0]);
});
router.put('/floors/:id', requireAdminDepartment('room'), async (req, res) => {
  const { roomCount } = req.body;
  const r = await pool.query(
    'UPDATE room_floors SET room_count=$1 WHERE id=$2 AND admin_id=$3 RETURNING *',
    [roomCount || 0, req.params.id, req.user.adminId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Floor not found.' });
  res.json(r.rows[0]);
});
router.delete('/floors/:id', requireAdminDepartment('room'), async (req, res) => {
  await pool.query('DELETE FROM room_floors WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});
// ---------- categories ----------
router.get('/categories', requireDepartment('room'), async (req, res) => {
  const r = await pool.query('SELECT * FROM room_categories WHERE admin_id = $1 ORDER BY name', [req.user.adminId]);
  res.json(r.rows);
});
router.post('/categories', requireAdminDepartment('room'), async (req, res) => {
  const { name } = req.body;
  const r = await pool.query('INSERT INTO room_categories (admin_id, name) VALUES ($1,$2) RETURNING *', [req.user.adminId, name]);
  res.status(201).json(r.rows[0]);
});
router.delete('/categories/:id', requireAdminDepartment('room'), async (req, res) => {
  await pool.query('DELETE FROM room_categories WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});

// ---------- rooms (inventory) ----------
// Returns each room plus its current active booking (if any) so the frontend
// can render status exactly like before, without storing status redundantly.
router.get('/', requireDepartment('room'), async (req, res) => {
  const r = await pool.query(
    `SELECT rm.*,
            b.id AS booking_id, b.guest_name, b.guest_phone, b.check_in, b.check_out, b.invoice_id,
            b.advance_amount, b.balance_paid
     FROM rooms rm
     LEFT JOIN room_bookings b ON b.room_id = rm.id AND b.status = 'active'
     WHERE rm.admin_id = $1
     ORDER BY rm.room_no`,
    [req.user.adminId]
  );
  res.json(r.rows);
});
router.post('/', requireAdminDepartment('room'), async (req, res) => {
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
router.put('/:id', requireAdminDepartment('room'), async (req, res) => {
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
router.delete('/:id', requireAdminDepartment('room'), async (req, res) => {
  const active = await pool.query("SELECT id FROM room_bookings WHERE room_id=$1 AND status='active'", [req.params.id]);
  if (active.rows.length > 0) {
    return res.status(409).json({ error: 'This room currently has a guest — check it out before removing it.' });
  }
  await pool.query('DELETE FROM rooms WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});

const ROOM_MAX_PHOTOS = 2;

// POST /api/rooms/:id/photos — body: { photoBase64, contentType }. Uploads
// one photo to Supabase Storage and appends its URL to this room's photo
// list, capped at ROOM_MAX_PHOTOS.
router.post('/:id/photos', requireAdminDepartment('room'), async (req, res) => {
  const { photoBase64, contentType } = req.body;
  if (!photoBase64 || !contentType) return res.status(400).json({ error: 'Missing photo data.' });
  try {
    const roomRes = await pool.query('SELECT photos FROM rooms WHERE id=$1 AND admin_id=$2', [req.params.id, req.user.adminId]);
    if (!roomRes.rows[0]) return res.status(404).json({ error: 'Room not found.' });
    const photos = roomRes.rows[0].photos || [];
    if (photos.length >= ROOM_MAX_PHOTOS) {
      return res.status(409).json({ error: `This room already has the maximum of ${ROOM_MAX_PHOTOS} photos. Remove one first.` });
    }
    const result = await uploadImageToSupabase('room-photos', `${req.user.adminId}/${req.params.id}`, photoBase64, contentType);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    const updatedPhotos = photos.concat([result.url]);
    await pool.query('UPDATE rooms SET photos=$1 WHERE id=$2', [JSON.stringify(updatedPhotos), req.params.id]);
    res.status(201).json({ photos: updatedPhotos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong uploading the photo.' });
  }
});

// DELETE /api/rooms/:id/photos — body: { url }. Removes one photo from the
// room's list and best-effort deletes it from Storage.
router.delete('/:id/photos', requireAdminDepartment('room'), async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing photo URL.' });
  try {
    const roomRes = await pool.query('SELECT photos FROM rooms WHERE id=$1 AND admin_id=$2', [req.params.id, req.user.adminId]);
    if (!roomRes.rows[0]) return res.status(404).json({ error: 'Room not found.' });
    const photos = (roomRes.rows[0].photos || []).filter((p) => p !== url);
    await pool.query('UPDATE rooms SET photos=$1 WHERE id=$2', [JSON.stringify(photos), req.params.id]);
    deleteImageFromSupabase('room-photos', url); // best-effort, not awaited on the response
    res.json({ photos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong removing the photo.' });
  }
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

// GET /api/rooms/guest-history?phone=98765XXXXX — "has this person stayed
// with us before?" lookup, used when a new booking is being created so
// staff can spot a returning guest instead of typing everything fresh.
// Deliberately open to any authenticated tenant user (not room-only) since
// Banquet staff booking a repeat customer benefits from this just as much —
// it only ever reads THIS tenant's own past bookings, scoped by admin_id,
// same as every other route here.
router.get('/guest-history', async (req, res) => {
  const digits = String(req.query.phone || '').replace(/\D/g, '');
  if (digits.length < 7) return res.status(400).json({ error: 'Enter a valid phone number to search.' });
  try {
    const roomStays = await pool.query(
      `SELECT rb.id, rb.guest_name, rb.guest_email, rb.check_in, rb.check_out, rb.status,
              rm.room_no, i.total_amount
       FROM room_bookings rb
       JOIN rooms rm ON rm.id = rb.room_id
       LEFT JOIN invoices i ON i.room_booking_id = rb.id
       WHERE rb.admin_id = $1 AND regexp_replace(rb.guest_phone, '\\D', '', 'g') = $2
       ORDER BY rb.check_in DESC LIMIT 10`,
      [req.user.adminId, digits]
    );
    const banquetStays = await pool.query(
      `SELECT bb.id, bb.customer_name, bb.start_at, bb.end_at, bb.status,
              bh.name AS hall_name, i.total_amount
       FROM banquet_bookings bb
       JOIN banquet_halls bh ON bh.id = bb.hall_id
       LEFT JOIN invoices i ON i.banquet_booking_id = bb.id
       WHERE bb.admin_id = $1 AND regexp_replace(bb.customer_phone, '\\D', '', 'g') = $2
       ORDER BY bb.start_at DESC LIMIT 10`,
      [req.user.adminId, digits]
    );
    const totalStays = roomStays.rows.length + banquetStays.rows.length;
    if (totalStays === 0) return res.json({ found: false });
    const totalSpent = roomStays.rows.reduce((sum, r) => sum + (Number(r.total_amount) || 0), 0)
      + banquetStays.rows.reduce((sum, r) => sum + (Number(r.total_amount) || 0), 0);
    // Whichever record (room or banquet) is most recent gives us the best
    // name/email to suggest autofilling with.
    const mostRecentRoom = roomStays.rows[0];
    const mostRecentBanquet = banquetStays.rows[0];
    const mostRecent = !mostRecentBanquet ? mostRecentRoom
      : !mostRecentRoom ? mostRecentBanquet
      : (new Date(mostRecentRoom.check_in) > new Date(mostRecentBanquet.start_at) ? mostRecentRoom : mostRecentBanquet);
    res.json({
      found: true,
      totalStays,
      totalSpent,
      suggestedName: mostRecentRoom ? mostRecentRoom.guest_name : mostRecentBanquet.customer_name,
      suggestedEmail: mostRecentRoom ? mostRecentRoom.guest_email : null,
      lastStay: mostRecentRoom
        ? { type: 'room', label: 'Room ' + mostRecentRoom.room_no, date: mostRecentRoom.check_in }
        : { type: 'banquet', label: mostRecentBanquet.hall_name, date: mostRecentBanquet.start_at },
      roomStays: roomStays.rows,
      banquetStays: banquetStays.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong looking up guest history.' });
  }
});

router.post('/bookings', requireDepartment('room'), async (req, res) => {
  const b = req.body;
  const staffId = req.user.role === 'staff' ? req.user.staffId : null;
  const advanceAmount = Number(b.advanceAmount) || 0;
  if (advanceAmount < 0) return res.status(400).json({ error: 'Advance payment can\'t be negative.' });
  try {
    // Guard: room must not already have an active booking.
    const active = await pool.query("SELECT id FROM room_bookings WHERE room_id=$1 AND status='active'", [b.roomId]);
    if (active.rows.length > 0) return res.status(409).json({ error: 'That room is already occupied.' });

    const r = await pool.query(
      `INSERT INTO room_bookings (admin_id, room_id, guest_name, guest_phone, guest_email, id_proof_type, id_proof_number, check_in, check_out,
                                   advance_amount, advance_payment_method, created_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.user.adminId, b.roomId, b.guestName, b.guestPhone, b.guestEmail || null, b.idProofType || null, b.idProofNumber || null, b.checkIn, b.checkOut || null,
       advanceAmount, advanceAmount > 0 ? (b.advancePaymentMethod || 'Cash') : null, staffId]
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
// PUT /api/rooms/bookings/:id/balance — mark the remaining balance as
// collected (mirrors the same idea on the banquet side).
router.put('/bookings/:id/balance', requireDepartment('room'), async (req, res) => {
  const r = await pool.query(
    "UPDATE room_bookings SET balance_paid = true, balance_paid_at = now() WHERE id=$1 AND admin_id=$2 RETURNING *",
    [req.params.id, req.user.adminId]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Booking not found.' });
  res.json(r.rows[0]);
});

module.exports = router;
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdminDepartment, requireDepartment } = require('../middleware/rbac');
const { uploadImageToSupabase, deleteImageFromSupabase } = require('../utils/storage');
const { validateRoomRow, MAX_IMPORT_ROWS } = require('../utils/importRows');

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

// POST /api/rooms/import — body: { rooms: [{ rowNumber, roomNo, category, bedType, ac, maxAdults,
// maxChildren, price, amenities, extraBed, extraBedPrice }] }. Bulk-creates rooms from a spreadsheet.
// Every row is validated again here (the browser's preview is a convenience, not a guarantee).
// Behaves exactly like adding the rooms by hand: floors are created/extended so they cover the
// highest room number on them (otherwise editing a floor later would delete the "extra" rooms),
// and new categories are created on the fly. Rooms that already exist are skipped, never overwritten.
// With `dryRun: true` it does all the work and reports exactly what WOULD happen, then rolls back —
// that's what the import preview screen uses, so there is one set of rules, not two.
router.post('/import', requireAdminDepartment('room'), async (req, res) => {
  const rows = req.body && req.body.rooms;
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'There are no rooms to import.' });
  if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ error: 'Please import at most ' + MAX_IMPORT_ROWS + ' rooms at a time.' });
  const adminId = req.user.adminId;
  const dryRun = req.body.dryRun === true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One import per hotel at a time, so two quick clicks can't create duplicates.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['import-rooms:' + adminId]);

    const existingRooms = new Set((await client.query('SELECT room_no FROM rooms WHERE admin_id = $1', [adminId])).rows.map((r) => String(r.room_no)));
    const catByName = new Map((await client.query('SELECT id, name FROM room_categories WHERE admin_id = $1', [adminId])).rows.map((c) => [c.name.trim().toLowerCase(), c.id]));
    const floorRows = (await client.query('SELECT id, floor, room_count FROM room_floors WHERE admin_id = $1', [adminId])).rows;

    const errors = [], skipped = [], warnings = [], valid = [];
    const seen = new Set();
    rows.forEach((raw, i) => {
      const rowNumber = Number(raw && raw.rowNumber) || (i + 2);
      const v = validateRoomRow(raw || {});
      if (v.errors.length) { errors.push({ row: rowNumber, message: v.errors.join(' ') }); return; }
      const no = String(v.value.roomNo);
      if (seen.has(no)) { errors.push({ row: rowNumber, message: 'Room ' + no + ' appears more than once in your file.' }); return; }
      seen.add(no);
      if (existingRooms.has(no)) { skipped.push({ row: rowNumber, message: 'Room ' + no + ' already exists, so it was skipped.' }); return; }
      v.warnings.forEach((w) => warnings.push({ row: rowNumber, message: w }));
      valid.push(v.value);
    });

    const createdCategories = [];
    for (const v of valid) {
      const key = v.category.toLowerCase();
      if (!catByName.has(key)) {
        const ins = await client.query('INSERT INTO room_categories (admin_id, name) VALUES ($1,$2) RETURNING id', [adminId, v.category]);
        catByName.set(key, ins.rows[0].id);
        createdCategories.push(v.category);
      }
    }
    for (const v of valid) {
      await client.query(
        `INSERT INTO rooms (admin_id, room_no, floor, category_id, bed_type, ac, max_adults, max_children,
                             price, amenities, extra_bed_allowed, extra_bed_price, out_of_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false)`,
        [adminId, String(v.roomNo), String(v.floor), catByName.get(v.category.toLowerCase()), v.bedType, v.ac,
         v.maxAdults, v.maxChildren, v.price, JSON.stringify(v.amenities), v.extraBedAllowed, v.extraBedPrice]
      );
    }

    // Make every floor's "rooms configured" cover its highest room position.
    const maxPosByFloor = new Map();
    valid.forEach((v) => { maxPosByFloor.set(v.floor, Math.max(maxPosByFloor.get(v.floor) || 0, v.pos)); });
    const createdFloors = [];
    for (const [floor, maxPos] of maxPosByFloor) {
      const existing = floorRows.find((f) => parseInt(f.floor, 10) === floor);
      if (!existing) {
        await client.query('INSERT INTO room_floors (admin_id, floor, room_count) VALUES ($1,$2,$3)', [adminId, String(floor), maxPos]);
        createdFloors.push(floor);
      } else if (existing.room_count < maxPos) {
        await client.query('UPDATE room_floors SET room_count = $1 WHERE id = $2', [maxPos, existing.id]);
      }
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    const preview = valid.slice(0, 8).map((v) => ({ roomNo: v.roomNo, floor: v.floor, category: v.category, bedType: v.bedType, ac: v.ac, price: v.price }));
    res.status(dryRun ? 200 : 201).json({ dryRun, imported: valid.length, skipped, errors, warnings, createdCategories, createdFloors, preview });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Something went wrong importing the rooms. Nothing was saved.' });
  } finally {
    client.release();
  }
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
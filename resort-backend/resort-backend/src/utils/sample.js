// "Try with sample data": fills an EMPTY account with realistic demo rooms, bookings,
// banquet events, menu items and invoices so a new admin can explore a busy dashboard,
// then removes all of it again with one click.
//
// Safety design:
//  * Every row this file creates is recorded in sample_data_rows (table + id). Clearing
//    deletes exactly those rows plus anything attached to a sample room/hall (practice
//    bookings and their invoices), so the admin's own data is never touched.
//  * Seeding is refused unless the account has no rooms, halls, menu items, bookings or
//    invoices yet, so sample rows can never be mixed into real records.
//  * Sample invoices are numbered SAMPLE-R-0001 etc. and never touch the real invoice
//    number sequence, and they carry no real phone numbers (so they can't trigger
//    loyalty rewards or show up in a real customer's history).
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin, getPlanAccess } = require('../middleware/rbac');

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

const DAY = 86400000;

// Small deterministic random generator, so the sample data looks the same every time.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r2 = (n) => Math.round(n * 100) / 100;

const GUESTS = [
  ['Aarav Mehta', '9000000101'], ['Diya Nair', '9000000102'], ['Kabir Singh', '9000000103'], ['Isha Kapoor', '9000000104'],
  ['Rohan Desai', '9000000105'], ['Meera Iyer', '9000000106'], ['Vihaan Shah', '9000000107'], ['Anaya Rao', '9000000108'],
  ['Arjun Patel', '9000000109'], ['Sara Khan', '9000000110'], ['Dev Malhotra', '9000000111'], ['Tara Joshi', '9000000112']
];
const PAYMENTS = ['Cash', 'UPI', 'Card', 'UPI', 'Cash'];

async function hasRows(client, sql, params) {
  const r = await client.query(sql, params);
  return r.rows.length > 0;
}

// What the status endpoint (and seeding) needs to know about this tenant.
async function getStatus(client, adminId) {
  const plan = await getPlanAccess(adminId);
  const tracked = await client.query('SELECT count(*)::int AS n FROM sample_data_rows WHERE admin_id = $1', [adminId]);
  const active = tracked.rows[0].n > 0;
  let empty = true;
  const checks = [
    'SELECT 1 FROM rooms WHERE admin_id = $1 LIMIT 1',
    'SELECT 1 FROM banquet_halls WHERE admin_id = $1 LIMIT 1',
    'SELECT 1 FROM menu_items WHERE admin_id = $1 LIMIT 1',
    'SELECT 1 FROM room_bookings WHERE admin_id = $1 LIMIT 1',
    'SELECT 1 FROM banquet_bookings WHERE admin_id = $1 LIMIT 1',
    'SELECT 1 FROM invoices WHERE admin_id = $1 LIMIT 1'
  ];
  for (const sql of checks) {
    if (await hasRows(client, sql, [adminId])) { empty = false; break; }
  }
  let reason = null;
  if (!plan.active) reason = 'subscription';
  else if (active) reason = 'already-active';
  else if (!empty) reason = 'not-empty';
  return { active, canSeed: !active && plan.active && empty, reason, departments: plan.departments };
}

router.get('/', async (req, res) => {
  const client = await pool.connect();
  try {
    res.json(await getStatus(client, req.user.adminId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong checking sample data.' });
  } finally {
    client.release();
  }
});

router.post('/', async (req, res) => {
  const adminId = req.user.adminId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sample-data:' + adminId]);
    const status = await getStatus(client, adminId);
    if (!status.canSeed) {
      await client.query('ROLLBACK');
      const msg = {
        subscription: 'Your subscription is not active.',
        'already-active': 'Sample data is already loaded.',
        'not-empty': 'Sample data is only available before you add your own rooms, menu, bookings or invoices.'
      }[status.reason] || 'Sample data can\'t be loaded right now.';
      return res.status(status.reason === 'subscription' ? 402 : 409).json({ error: msg });
    }
    const counts = await seed(client, adminId, status.departments);
    await client.query('COMMIT');
    res.status(201).json({ ok: true, counts });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Something went wrong loading the sample data. Nothing was saved.' });
  } finally {
    client.release();
  }
});

router.delete('/', async (req, res) => {
  const adminId = req.user.adminId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sample-data:' + adminId]);
    const removed = await wipe(client, adminId);
    await client.query('COMMIT');
    res.json({ ok: true, removed });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Something went wrong clearing the sample data. Nothing was changed.' });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------------ seeding
async function seed(client, adminId, departments) {
  const rnd = mulberry32(20261016);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const now = Date.now();
  const tracked = []; // [table, id]
  const track = (table, id) => tracked.push([table, id]);
  const counts = { rooms: 0, roomStays: 0, halls: 0, banquetBookings: 0, menuItems: 0, invoices: 0 };
  let roomInvSeq = 0, banqInvSeq = 0, foodInvSeq = 0;

  async function insertInvoice(o) {
    const ins = await client.query(
      `INSERT INTO invoices (admin_id, invoice_no, department, customer_name, customer_phone, table_no,
                              room_booking_id, banquet_booking_id, subtotal, discount_amount, total_amount,
                              payment_method, created_at)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,0,$9,$10,$11) RETURNING id`,
      [adminId, o.invoiceNo, o.department, o.customerName || null, o.tableNo || null,
       o.roomBookingId || null, o.banquetBookingId || null, o.subtotal, o.total, o.paymentMethod, new Date(o.createdAt)]
    );
    const id = ins.rows[0].id;
    track('invoices', id);
    counts.invoices++;
    for (const li of o.items || []) {
      await client.query('INSERT INTO invoice_line_items (invoice_id, name, quantity, unit_price, line_total) VALUES ($1,$2,$3,$4,$5)',
        [id, li.name, li.quantity, li.unitPrice, li.lineTotal]);
    }
    return id;
  }

  // ---------- rooms ----------
  if (departments.indexOf('room') !== -1) {
    const catDefs = [['Standard', 2200], ['Deluxe', 3200], ['Suite', 5200]];
    const catId = {};
    for (const [name] of catDefs) {
      const ex = await client.query('SELECT id FROM room_categories WHERE admin_id = $1 AND lower(name) = lower($2) LIMIT 1', [adminId, name]);
      if (ex.rows[0]) { catId[name] = ex.rows[0].id; continue; }
      const ins = await client.query('INSERT INTO room_categories (admin_id, name) VALUES ($1,$2) RETURNING id', [adminId, name]);
      catId[name] = ins.rows[0].id;
      track('room_categories', ins.rows[0].id);
    }
    const floorDefs = [[1, 5], [2, 5], [3, 2]];
    for (const [floor, count] of floorDefs) {
      const ex = await client.query('SELECT id FROM room_floors WHERE admin_id = $1 AND floor = $2 LIMIT 1', [adminId, String(floor)]);
      if (ex.rows[0]) continue;
      const ins = await client.query('INSERT INTO room_floors (admin_id, floor, room_count) VALUES ($1,$2,$3) RETURNING id', [adminId, String(floor), count]);
      track('room_floors', ins.rows[0].id);
    }
    const roomDefs = [
      [101, 'Standard', 'Double Bed', true], [102, 'Standard', 'Twin Beds', true], [103, 'Standard', 'Double Bed', false],
      [104, 'Standard', 'Single Bed', false], [105, 'Standard', 'Double Bed', true],
      [201, 'Deluxe', 'Queen Bed', true], [202, 'Deluxe', 'King Bed', true], [203, 'Deluxe', 'Queen Bed', true],
      [204, 'Deluxe', 'King Bed', true], [205, 'Deluxe', 'Queen Bed', true],
      [301, 'Suite', 'King Bed', true], [302, 'Suite', 'King Bed', true]
    ];
    const priceOf = { Standard: 2200, Deluxe: 3200, Suite: 5200 };
    const amenityPool = ['Wi-Fi', 'TV', 'Attached Bathroom', 'Hot Water', 'Refrigerator', 'Wardrobe', 'Balcony', 'Room Service'];
    const rooms = [];
    for (const [no, cat, bed, ac] of roomDefs) {
      const am = amenityPool.filter((_, i) => i < 4 || rnd() > 0.45);
      const ins = await client.query(
        `INSERT INTO rooms (admin_id, room_no, floor, category_id, bed_type, ac, max_adults, max_children, price,
                             amenities, extra_bed_allowed, extra_bed_price, out_of_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false) RETURNING id`,
        [adminId, String(no), String(Math.floor(no / 100)), catId[cat], bed, ac, cat === 'Suite' ? 4 : 2, cat === 'Standard' ? 1 : 2,
         priceOf[cat], JSON.stringify(am), cat !== 'Standard', cat === 'Standard' ? 0 : 800]
      );
      track('rooms', ins.rows[0].id);
      rooms.push({ id: ins.rows[0].id, no, price: priceOf[cat] });
      counts.rooms++;
    }

    // Four rooms are occupied right now (so occupancy and pending balances look real).
    const activeIdx = { 1: true, 4: true, 6: true, 9: true };
    const activeStart = {};
    Object.keys(activeIdx).forEach((i) => { activeStart[i] = now - (0.4 + rnd() * 1.6) * DAY; });
    // Two guests arrived within the last couple of hours, so "check-ins today" isn't an empty zero.
    activeStart[1] = now - 40 * 60000;
    activeStart[4] = now - 90 * 60000;

    // Past stays: sequential, non-overlapping, over roughly the last four weeks.
    const stays = [];
    rooms.forEach((room, idx) => {
      const limit = activeStart[idx] !== undefined ? activeStart[idx] - 0.3 * DAY : now - 0.5 * DAY;
      let cursor = now - (26 + rnd() * 2) * DAY;
      for (let guard = 0; guard < 12; guard++) {
        const start = cursor + (1 + Math.floor(rnd() * 4)) * DAY;
        const nights = 1 + Math.floor(rnd() * 3);
        const end = start + nights * DAY;
        if (end > limit) break;
        stays.push({ room, start, end, nights });
        cursor = end;
      }
    });
    stays.sort((a, b) => a.end - b.end);
    for (const st of stays) {
      const [gname, gphone] = pick(GUESTS);
      const subtotal = r2(st.nights * st.room.price);
      const total = r2(subtotal * 1.12);
      const method = pick(PAYMENTS);
      const advance = rnd() < 0.5 ? Math.round((total * 0.3) / 100) * 100 : 0;
      const bk = await client.query(
        `INSERT INTO room_bookings (admin_id, room_id, guest_name, guest_phone, check_in, check_out, status,
                                     advance_amount, advance_payment_method, balance_paid, balance_paid_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'completed',$7,$8,true,$6,$5) RETURNING id`,
        [adminId, st.room.id, gname, gphone, new Date(st.start), new Date(st.end), advance, advance > 0 ? method : null]
      );
      track('room_bookings', bk.rows[0].id);
      const invId = await insertInvoice({
        invoiceNo: 'SAMPLE-R-' + String(++roomInvSeq).padStart(4, '0'), department: 'room', customerName: gname,
        roomBookingId: bk.rows[0].id, subtotal, total, paymentMethod: method, createdAt: st.end,
        items: [{ name: 'Room ' + st.room.no + ' (' + st.nights + ' night' + (st.nights > 1 ? 's' : '') + ')', quantity: st.nights, unitPrice: st.room.price, lineTotal: subtotal }]
      });
      await client.query('UPDATE room_bookings SET invoice_id = $1 WHERE id = $2', [invId, bk.rows[0].id]);
      counts.roomStays++;
    }
    for (const key of Object.keys(activeIdx)) {
      const room = rooms[Number(key)];
      const [gname, gphone] = pick(GUESTS);
      const advance = Math.round((room.price * 0.4) / 100) * 100;
      const bk = await client.query(
        `INSERT INTO room_bookings (admin_id, room_id, guest_name, guest_phone, check_in, status,
                                     advance_amount, advance_payment_method, balance_paid, created_at)
         VALUES ($1,$2,$3,$4,$5,'active',$6,'UPI',false,$5) RETURNING id`,
        [adminId, room.id, gname, gphone, new Date(activeStart[key]), advance]
      );
      track('room_bookings', bk.rows[0].id);
      counts.roomStays++;
    }
  }

  // ---------- banquet ----------
  if (departments.indexOf('banquet') !== -1) {
    const halls = [];
    const hallDefs = [
      ['Grand Ballroom', 300, ['AC', 'Stage', 'Sound System', 'Parking', 'Catering Kitchen'], { hour: { enabled: true, price: 8000 }, day: { enabled: true, price: 60000 }, week: { enabled: false, price: 0 } }],
      ['Garden Lawn', 150, ['Open Air', 'Stage', 'Parking', 'Decor Lighting'], { hour: { enabled: true, price: 4500 }, day: { enabled: true, price: 35000 }, week: { enabled: false, price: 0 } }]
    ];
    for (const [name, capacity, facilities, pricing] of hallDefs) {
      const ins = await client.query(
        'INSERT INTO banquet_halls (admin_id, name, capacity, facilities, out_of_order, pricing) VALUES ($1,$2,$3,$4,false,$5) RETURNING id',
        [adminId, name, capacity, JSON.stringify(facilities), JSON.stringify(pricing)]
      );
      track('banquet_halls', ins.rows[0].id);
      halls.push({ id: ins.rows[0].id, dayPrice: pricing.day.price, capacity });
      counts.halls++;
    }
    const events = [
      // [hall idx, days from now (negative = past), event, food, decor, guests, name]
      [0, -22, 'Wedding', 'Veg Premium', 'Luxury', 240, 'Kapoor Family'],
      [1, -13, 'Birthday', 'Veg Standard', 'Standard', 80, 'Meera Iyer'],
      [0, -6, 'Conference', 'Veg Standard', 'Basic', 120, 'Nova Tech Pvt Ltd'],
      [1, 5, 'Anniversary', 'Non-Veg Premium', 'Luxury', 100, 'Desai Family'],
      [0, 12, 'Wedding', 'Veg Premium', 'Luxury', 260, 'Shah Family'],
      [1, 19, 'Reception', 'Non-Veg Standard', 'Standard', 140, 'Rao Family']
    ];
    let code = 0;
    for (const [hIdx, dOff, evType, food, decor, guests, cname] of events) {
      const hall = halls[hIdx];
      const start = new Date(now + dOff * DAY); start.setUTCHours(11, 30, 0, 0);
      const end = new Date(start.getTime() + 8 * 3600000);
      const past = dOff < 0;
      const base = hall.dayPrice;
      const withTax = r2(base * 1.18);
      const advance = Math.round(withTax * 0.4 / 1000) * 1000;
      const ins = await client.query(
        `INSERT INTO banquet_bookings (admin_id, booking_code, hall_id, customer_name, customer_phone, guest_count, event_type,
                                         food_package, decoration_package, pricing_basis, unit_price, duration_count, start_at, end_at,
                                         total_amount, advance_amount, advance_payment_method, balance_paid, balance_paid_at, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'day',$10,1,$11,$12,$13,$14,'UPI',$15,$16,$17,$18) RETURNING id`,
        [adminId, 'SMP-B' + String(++code).padStart(2, '0'), hall.id, cname, '9000000' + (200 + code), guests, evType, food, decor,
         base, start, end, base, advance, past, past ? end : null, past ? 'completed' : 'booked',
         new Date(Math.min(now - (1 + code) * DAY, start.getTime() - 10 * DAY))]  // booked well before the event, never "today"
      );
      track('banquet_bookings', ins.rows[0].id);
      counts.banquetBookings++;
      if (past) {
        const invId = await insertInvoice({
          invoiceNo: 'SAMPLE-B-' + String(++banqInvSeq).padStart(4, '0'), department: 'banquet', customerName: cname,
          banquetBookingId: ins.rows[0].id, subtotal: base, total: withTax, paymentMethod: 'UPI', createdAt: end.getTime()
        });
        await client.query('UPDATE banquet_bookings SET invoice_id = $1 WHERE id = $2', [invId, ins.rows[0].id]);
      }
    }
  }

  // ---------- restaurant ----------
  if (departments.indexOf('restaurant') !== -1) {
    const menuDefs = [
      ['Paneer Tikka', 'Starters', 260, true], ['Veg Spring Rolls', 'Starters', 180, true], ['Chicken 65', 'Starters', 290, false],
      ['Butter Chicken', 'Main Course', 360, false], ['Dal Makhani', 'Main Course', 240, true], ['Paneer Butter Masala', 'Main Course', 280, true],
      ['Veg Biryani', 'Rice', 250, true], ['Chicken Biryani', 'Rice', 320, false], ['Jeera Rice', 'Rice', 150, true],
      ['Butter Naan', 'Breads', 60, true], ['Tandoori Roti', 'Breads', 35, true],
      ['Gulab Jamun', 'Desserts', 110, true], ['Ice Cream', 'Desserts', 120, true],
      ['Masala Chai', 'Beverages', 50, true], ['Fresh Lime Soda', 'Beverages', 80, true], ['Cold Coffee', 'Beverages', 120, true]
    ];
    const menu = [];
    for (const [name, category, price, isVeg] of menuDefs) {
      const ins = await client.query('INSERT INTO menu_items (admin_id, name, category, price, is_veg) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [adminId, name, category, price, isVeg]);
      track('menu_items', ins.rows[0].id);
      menu.push({ name, price });
      counts.menuItems++;
    }
    const orders = [];
    for (let d = 27; d >= 0; d--) {
      const perDay = 1 + Math.floor(rnd() * 3) + (d % 7 === 0 || d % 7 === 6 ? 1 : 0); // a little busier on weekends
      for (let k = 0; k < perDay; k++) {
        const at = new Date(now - d * DAY); at.setUTCHours(6 + Math.floor(rnd() * 10), Math.floor(rnd() * 60), 0, 0); // ~12:00-21:30 IST
        if (at.getTime() > now) at.setTime(now - 3600000);
        orders.push(at.getTime());
      }
    }
    orders.sort((a, b) => a - b);
    for (const at of orders) {
      const nItems = 1 + Math.floor(rnd() * 4);
      const chosen = new Set();
      const items = [];
      while (items.length < nItems) {
        const m = pick(menu);
        if (chosen.has(m.name)) continue;
        chosen.add(m.name);
        const quantity = 1 + Math.floor(rnd() * 3);
        items.push({ name: m.name, quantity, unitPrice: m.price, lineTotal: r2(m.price * quantity) });
      }
      const subtotal = r2(items.reduce((s, i) => s + i.lineTotal, 0));
      await insertInvoice({
        invoiceNo: 'SAMPLE-F-' + String(++foodInvSeq).padStart(4, '0'), department: 'restaurant',
        customerName: rnd() < 0.4 ? pick(GUESTS)[0] : null, tableNo: 1 + Math.floor(rnd() * 4),
        subtotal, total: r2(subtotal * 1.05), paymentMethod: pick(PAYMENTS), createdAt: at, items
      });
    }
  }

  // Remember every row, in one statement.
  if (tracked.length) {
    await client.query(
      `INSERT INTO sample_data_rows (admin_id, table_name, row_id)
       SELECT $1, t, i FROM unnest($2::text[], $3::uuid[]) AS x(t, i)`,
      [adminId, tracked.map((x) => x[0]), tracked.map((x) => x[1])]
    );
  }
  return counts;
}

// ------------------------------------------------------------------ clearing
async function wipe(client, adminId) {
  const rows = (await client.query('SELECT table_name, row_id FROM sample_data_rows WHERE admin_id = $1', [adminId])).rows;
  const ids = (t) => rows.filter((r) => r.table_name === t).map((r) => r.row_id);
  const roomIds = ids('rooms'), hallIds = ids('banquet_halls');
  const removed = { invoices: 0, bookings: 0, rooms: 0, halls: 0, menuItems: 0 };

  // Invoices first: the sample ones, plus any made against a sample room/hall/booking while the
  // admin was practising (those would otherwise be left behind pointing at nothing).
  const inv = await client.query(
    `DELETE FROM invoices WHERE admin_id = $1 AND (
        id = ANY($2::uuid[])
        OR room_booking_id = ANY($3::uuid[])
        OR banquet_booking_id = ANY($4::uuid[])
        OR room_booking_id IN (SELECT id FROM room_bookings WHERE room_id = ANY($5::uuid[]))
        OR banquet_booking_id IN (SELECT id FROM banquet_bookings WHERE hall_id = ANY($6::uuid[]))
     )`,
    [adminId, ids('invoices'), ids('room_bookings'), ids('banquet_bookings'), roomIds, hallIds]
  );
  removed.invoices = inv.rowCount;

  const rb = await client.query('DELETE FROM room_bookings WHERE admin_id = $1 AND (id = ANY($2::uuid[]) OR room_id = ANY($3::uuid[]))', [adminId, ids('room_bookings'), roomIds]);
  const bb = await client.query('DELETE FROM banquet_bookings WHERE admin_id = $1 AND (id = ANY($2::uuid[]) OR hall_id = ANY($3::uuid[]))', [adminId, ids('banquet_bookings'), hallIds]);
  removed.bookings = rb.rowCount + bb.rowCount;
  removed.rooms = (await client.query('DELETE FROM rooms WHERE admin_id = $1 AND id = ANY($2::uuid[])', [adminId, roomIds])).rowCount;
  removed.halls = (await client.query('DELETE FROM banquet_halls WHERE admin_id = $1 AND id = ANY($2::uuid[])', [adminId, hallIds])).rowCount;
  removed.menuItems = (await client.query('DELETE FROM menu_items WHERE admin_id = $1 AND id = ANY($2::uuid[])', [adminId, ids('menu_items')])).rowCount;
  await client.query('DELETE FROM room_categories WHERE admin_id = $1 AND id = ANY($2::uuid[])', [adminId, ids('room_categories')]);
  // A floor we created goes away only if the admin hasn't put their own rooms on it since.
  await client.query(
    `DELETE FROM room_floors WHERE admin_id = $1 AND id = ANY($2::uuid[])
       AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.admin_id = $1 AND r.floor = room_floors.floor)`,
    [adminId, ids('room_floors')]
  );
  await client.query('DELETE FROM sample_data_rows WHERE admin_id = $1', [adminId]);
  return removed;
}

module.exports = router;
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');

const router = express.Router();
router.use(requireAuth);

// GET /api/invoices?department=restaurant — list, optionally filtered
// Joins in the room number + stay dates (when it's a room invoice) so the
// frontend doesn't need a second request per row just to show them.
router.get('/', async (req, res) => {
  const { department } = req.query;
  const params = [req.user.adminId];
  let where = 'i.admin_id = $1';
  if (department) { params.push(department); where += ` AND i.department = $${params.length}`; }
  const r = await pool.query(
    `SELECT i.*, rm.room_no AS room_no, rb.check_in AS room_check_in, rb.check_out AS room_check_out,
            rb.advance_amount AS room_advance_amount, rb.balance_paid AS room_balance_paid,
            bb.advance_amount AS banquet_advance_amount, bb.balance_paid AS banquet_balance_paid,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('name', li.name, 'quantity', li.quantity, 'unit_price', li.unit_price, 'line_total', li.line_total))
                      FROM invoice_line_items li WHERE li.invoice_id = i.id), '[]'::jsonb) AS items
     FROM invoices i
     LEFT JOIN room_bookings rb ON rb.id = i.room_booking_id
     LEFT JOIN rooms rm ON rm.id = rb.room_id
     LEFT JOIN banquet_bookings bb ON bb.id = i.banquet_booking_id
     WHERE ${where} ORDER BY i.created_at DESC`,
    params
  );
  res.json(r.rows);
});

// GET /api/invoices/:id — includes line items for restaurant invoices
router.get('/:id', async (req, res) => {
  const inv = await pool.query(
    `SELECT i.*, rm.room_no AS room_no, rb.check_in AS room_check_in, rb.check_out AS room_check_out
     FROM invoices i
     LEFT JOIN room_bookings rb ON rb.id = i.room_booking_id
     LEFT JOIN rooms rm ON rm.id = rb.room_id
     WHERE i.id=$1 AND i.admin_id=$2`,
    [req.params.id, req.user.adminId]
  );
  if (!inv.rows[0]) return res.status(404).json({ error: 'Invoice not found.' });
  const items = await pool.query('SELECT * FROM invoice_line_items WHERE invoice_id=$1', [req.params.id]);
  res.json({ ...inv.rows[0], items: items.rows });
});

// DELETE /api/invoices/:id — admin only. Staff can view history but not
// delete financial/invoice records (the frontend already hides this
// control for staff; this enforces it server-side too, so it can't be
// bypassed by calling the API directly).
router.delete('/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM invoices WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
  res.status(204).end();
});

// POST /api/invoices — creates an invoice; server assigns the sequential invoice number
router.post('/', async (req, res) => {
  const b = req.body;
  if (!['room', 'banquet', 'restaurant'].includes(b.department)) {
    return res.status(400).json({ error: 'Invalid department.' });
  }
  // A staff member can only ever bill for their own department — without
  // this, any valid staff login could create invoices (and consume the
  // invoice number sequence) for a department they don't belong to.
  if (req.user.role === 'staff' && req.user.department !== b.department) {
    return res.status(403).json({ error: 'Your department does not have access to this.' });
  }
  const staffId = req.user.role === 'staff' ? req.user.staffId : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // atomically bump and read this tenant's invoice sequence
    const seqRes = await client.query(
      'UPDATE hotel_settings SET invoice_seq = invoice_seq + 1 WHERE admin_id = $1 RETURNING invoice_seq',
      [req.user.adminId]
    );
    const seq = seqRes.rows[0].invoice_seq;
    // The invoice prefix is a user setting stored in restaurant_settings.extra
    // (e.g. {"invoicePrefix":"HTL"}) rather than its own column — see /settings/restaurant.
    const settingsRes = await client.query('SELECT extra FROM restaurant_settings WHERE admin_id = $1', [req.user.adminId]);
    const prefix = (settingsRes.rows[0] && settingsRes.rows[0].extra && settingsRes.rows[0].extra.invoicePrefix) || 'INV';
    const invoiceNo = `${prefix}-${String(seq).padStart(5, '0')}`;

    const invRes = await client.query(
      `INSERT INTO invoices (admin_id, invoice_no, department, customer_name, customer_phone, table_no,
                              room_booking_id, banquet_booking_id, subtotal, discount_amount, promo_code,
                              total_amount, payment_method, created_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.user.adminId, invoiceNo, b.department, b.customerName, b.customerPhone, b.tableNo || null,
       b.roomBookingId || null, b.banquetBookingId || null, b.subtotal || 0, b.discountAmount || 0,
       b.promoCode || null, b.totalAmount || 0, b.paymentMethod || null, staffId]
    );
    const invoice = invRes.rows[0];

    if (Array.isArray(b.items) && b.items.length > 0) {
      for (const item of b.items) {
        await client.query(
          'INSERT INTO invoice_line_items (invoice_id, name, quantity, unit_price, line_total) VALUES ($1,$2,$3,$4,$5)',
          [invoice.id, item.name, item.quantity || 1, item.unitPrice, item.lineTotal]
        );
      }
    }
    if (b.roomBookingId) {
      await client.query('UPDATE room_bookings SET invoice_id=$1 WHERE id=$2', [invoice.id, b.roomBookingId]);
    }
    if (b.promoCode) {
      await client.query(
        'UPDATE promo_codes SET used_count = used_count + 1 WHERE admin_id = $1 AND code = $2',
        [req.user.adminId, b.promoCode]
      );
    }
    if (b.banquetBookingId) {
      await client.query('UPDATE banquet_bookings SET invoice_id=$1 WHERE id=$2', [invoice.id, b.banquetBookingId]);
    }
    await client.query('COMMIT');
    res.status(201).json(invoice);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Something went wrong generating the invoice.' });
  } finally {
    client.release();
  }
});

// POST /api/invoices/:id/pdf — uploads a generated invoice PDF to Supabase Storage
// and saves its public URL, so it can be shared as a link (e.g. over WhatsApp,
// which can't auto-attach files from a website — only pre-fill text).
router.post('/:id/pdf', async (req, res) => {
  const { pdfBase64 } = req.body;
  if (!pdfBase64) return res.status(400).json({ error: 'Missing PDF data.' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'PDF sharing isn\'t configured on the server yet.' });
  }
  try {
    const inv = await pool.query('SELECT id, department FROM invoices WHERE id = $1 AND admin_id = $2', [req.params.id, req.user.adminId]);
    if (!inv.rows[0]) return res.status(404).json({ error: 'Invoice not found.' });
    if (req.user.role === 'staff' && req.user.department !== inv.rows[0].department) {
      return res.status(403).json({ error: 'Your department does not have access to this.' });
    }

    const buffer = Buffer.from(pdfBase64, 'base64');
    const bucket = 'invoices';
    const path = `${req.user.adminId}/${req.params.id}.pdf`;
    // Guard against an empty/malformed path ever being sent to Supabase.
    if (!req.user.adminId || !req.params.id || path.includes('//') || path.startsWith('/')) {
      console.error('Refusing to upload — invalid storage path constructed:', { bucket, path });
      return res.status(500).json({ error: 'Could not build a valid file path for this PDF.' });
    }
    // SUPABASE_URL must be just the bare project origin (e.g. https://xxxx.supabase.co).
    // A trailing slash or an accidental extra path segment (someone pasting a URL that
    // already includes /rest/v1, for example) makes the concatenated request URL below
    // not match Storage's expected route — the request then falls through to PostgREST
    // instead, which is exactly what a PGRST-prefixed error code means. Normalizing to
    // the origin here fixes that regardless of what shape the stored value is in.
    const supabaseOrigin = new URL(process.env.SUPABASE_URL).origin;
    console.log('Supabase Storage upload:', { bucket, path });

    const auth = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
    const uploadRes = await fetch(
      `${supabaseOrigin}/storage/v1/object/${bucket}/${path}`,
      {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, auth),
        body: buffer
      }
    );
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error('Supabase Storage upload failed:', { bucket, path, status: uploadRes.status, body: errText });
      return res.status(502).json({ error: 'Could not upload the PDF. Please try again.' });
    }

    const url = `${supabaseOrigin}/storage/v1/object/public/${bucket}/${path}`;
    await pool.query('UPDATE invoices SET pdf_url = $1 WHERE id = $2', [url, req.params.id]);
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong uploading the PDF.' });
  }
});

module.exports = router;
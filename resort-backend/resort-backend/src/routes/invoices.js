const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/invoices?department=restaurant — list, optionally filtered
// Joins in the room number + stay dates (when it's a room invoice) so the
// frontend doesn't need a second request per row just to show them.
router.get('/', async (req, res) => {
  const { department } = req.query;
  const params = [req.user.adminId];
  let where = 'i.admin_id = $1';

  if (department) {
    params.push(department);
    where += ` AND i.department = $${params.length}`;
  }

  const r = await pool.query(
    `SELECT i.*, rm.room_no AS room_no, rb.check_in AS room_check_in, rb.check_out AS room_check_out,
            COALESCE(
              (
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'name', li.name,
                    'quantity', li.quantity,
                    'unit_price', li.unit_price,
                    'line_total', li.line_total
                  )
                )
                FROM invoice_line_items li
                WHERE li.invoice_id = i.id
              ),
              '[]'::jsonb
            ) AS items
     FROM invoices i
     LEFT JOIN room_bookings rb ON rb.id = i.room_booking_id
     LEFT JOIN rooms rm ON rm.id = rb.room_id
     WHERE ${where}
     ORDER BY i.created_at DESC`,
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
     WHERE i.id = $1 AND i.admin_id = $2`,
    [req.params.id, req.user.adminId]
  );

  if (!inv.rows[0]) {
    return res.status(404).json({ error: 'Invoice not found.' });
  }

  const items = await pool.query(
    'SELECT * FROM invoice_line_items WHERE invoice_id = $1',
    [req.params.id]
  );

  res.json({
    ...inv.rows[0],
    items: items.rows
  });
});

// DELETE /api/invoices/:id
router.delete('/:id', async (req, res) => {
  await pool.query(
    'DELETE FROM invoices WHERE id = $1 AND admin_id = $2',
    [req.params.id, req.user.adminId]
  );

  res.status(204).end();
});

// POST /api/invoices — creates an invoice; server assigns the sequential invoice number
router.post('/', async (req, res) => {
  const b = req.body;
  const staffId = req.user.role === 'staff' ? req.user.staffId : null;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Atomically bump and read this tenant's invoice sequence
    const seqRes = await client.query(
      'UPDATE hotel_settings SET invoice_seq = invoice_seq + 1 WHERE admin_id = $1 RETURNING invoice_seq',
      [req.user.adminId]
    );

    const seq = seqRes.rows[0].invoice_seq;

    // The invoice prefix is a user setting stored in restaurant_settings.extra
    // (e.g. {"invoicePrefix":"HTL"}) rather than its own column.
    const settingsRes = await client.query(
      'SELECT extra FROM restaurant_settings WHERE admin_id = $1',
      [req.user.adminId]
    );

    const prefix =
      (settingsRes.rows[0] &&
        settingsRes.rows[0].extra &&
        settingsRes.rows[0].extra.invoicePrefix) ||
      'INV';

    const invoiceNo = `${prefix}-${String(seq).padStart(5, '0')}`;

    const invRes = await client.query(
      `INSERT INTO invoices (
        admin_id,
        invoice_no,
        department,
        customer_name,
        customer_phone,
        table_no,
        room_booking_id,
        banquet_booking_id,
        subtotal,
        discount_amount,
        promo_code,
        total_amount,
        payment_method,
        created_by_staff_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *`,
      [
        req.user.adminId,
        invoiceNo,
        b.department,
        b.customerName,
        b.customerPhone,
        b.tableNo || null,
        b.roomBookingId || null,
        b.banquetBookingId || null,
        b.subtotal || 0,
        b.discountAmount || 0,
        b.promoCode || null,
        b.totalAmount || 0,
        b.paymentMethod || null,
        staffId
      ]
    );

    const invoice = invRes.rows[0];

    if (Array.isArray(b.items) && b.items.length > 0) {
      for (const item of b.items) {
        await client.query(
          `INSERT INTO invoice_line_items (
            invoice_id,
            name,
            quantity,
            unit_price,
            line_total
          )
          VALUES ($1,$2,$3,$4,$5)`,
          [
            invoice.id,
            item.name,
            item.quantity || 1,
            item.unitPrice,
            item.lineTotal
          ]
        );
      }
    }

    if (b.roomBookingId) {
      await client.query(
        'UPDATE room_bookings SET invoice_id = $1 WHERE id = $2',
        [invoice.id, b.roomBookingId]
      );
    }

    if (b.promoCode) {
      await client.query(
        'UPDATE promo_codes SET used_count = used_count + 1 WHERE admin_id = $1 AND code = $2',
        [req.user.adminId, b.promoCode]
      );
    }

    if (b.banquetBookingId) {
      await client.query(
        'UPDATE banquet_bookings SET invoice_id = $1 WHERE id = $2',
        [invoice.id, b.banquetBookingId]
      );
    }

    await client.query('COMMIT');

    res.status(201).json(invoice);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);

    res.status(500).json({
      error: 'Something went wrong generating the invoice.'
    });
  } finally {
    client.release();
  }
});

// POST /api/invoices/:id/pdf
// Uploads a generated invoice PDF to Supabase Storage
// and saves its public URL so it can be shared as a link.
router.post('/:id/pdf', async (req, res) => {
  const { pdfBase64 } = req.body;

  if (!pdfBase64) {
    return res.status(400).json({
      error: 'Missing PDF data.'
    });
  }

  if (
    !process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return res.status(500).json({
      error: "PDF sharing isn't configured on the server yet."
    });
  }

  try {
    const inv = await pool.query(
      'SELECT id FROM invoices WHERE id = $1 AND admin_id = $2',
      [req.params.id, req.user.adminId]
    );

    if (!inv.rows[0]) {
      return res.status(404).json({
        error: 'Invoice not found.'
      });
    }

    // Convert Base64 PDF into a Buffer
    const buffer = Buffer.from(pdfBase64, 'base64');

    // Build a safe Supabase Storage path
    const storagePath = `${req.user.adminId}/${req.params.id}.pdf`;

    const encodedPath = storagePath
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    // Remove any trailing slash from the Supabase URL
    const supabaseUrl = process.env.SUPABASE_URL.replace(/\/+$/, '');

    // Upload URL
    const uploadUrl =
      `${supabaseUrl}/storage/v1/object/invoices/${encodedPath}`;

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/pdf',
        'x-upsert': 'true'
      },
      body: buffer
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();

      console.error(
        'Supabase Storage upload failed:',
        errText
      );

      return res.status(502).json({
        error: 'Could not upload the PDF. Please try again.'
      });
    }

    // Public URL of uploaded PDF
    const url =
      `${supabaseUrl}/storage/v1/object/public/invoices/${encodedPath}`;

    // Save PDF URL in database
    await pool.query(
      'UPDATE invoices SET pdf_url = $1 WHERE id = $2',
      [url, req.params.id]
    );

    res.json({ url });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: 'Something went wrong uploading the PDF.'
    });
  }
});

module.exports = router;
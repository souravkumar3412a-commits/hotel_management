const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin, getPlanAccess } = require('../middleware/rbac');

const router = express.Router();
router.use(requireAuth);

// An error that carries the HTTP status/message to send back, so a validation
// failure deep inside the invoice transaction can roll everything back and
// still reply with a clear 4xx instead of a generic 500.
function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

// Customers are identified by the LAST 10 DIGITS of their phone number, so
// "98765 43210", "+91 98765-43210" and "09876543210" all count as the same person.
function phoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

// No 0/O/1/I/L, so a code read aloud or typed from WhatsApp isn't ambiguous.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomRewardCode() {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (const x of bytes) out += CODE_ALPHABET[x % CODE_ALPHABET.length];
  return 'VIP-' + out;
}

// Automatic loyalty reward. Called inside the invoice transaction right after a
// restaurant invoice is saved. Every time a customer's total restaurant spend
// (counted from the day the admin switched the program on) crosses another
// multiple of the admin's threshold, ONE single-use code is created, locked to
// that customer's phone number. Returns the new reward, or null if none was earned.
async function maybeIssueLoyaltyReward(client, adminId, customerName, customerPhone, settingsExtra) {
  const cfg = settingsExtra && settingsExtra.loyalty;
  if (!cfg || !cfg.enabled) return null;
  const threshold = Number(cfg.spendThreshold);
  const value = Number(cfg.discountValue);
  const type = cfg.discountType === 'flat' ? 'flat' : 'percent';
  if (!(threshold > 0) || !(value > 0)) return null;
  if (type === 'percent' && value > 100) return null;
  const since = cfg.since ? new Date(cfg.since) : null;
  if (!since || isNaN(since.getTime())) return null; // never reward retroactively
  const key = phoneKey(customerPhone);
  if (key.length < 7) return null;

  // Row-lock this customer's progress so two bills saved at the same moment
  // can't both pay out the same milestone.
  await client.query(
    'INSERT INTO loyalty_progress (admin_id, phone_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [adminId, key]
  );
  const prog = (await client.query(
    'SELECT period_start, rewards_issued FROM loyalty_progress WHERE admin_id=$1 AND phone_key=$2 FOR UPDATE',
    [adminId, key]
  )).rows[0];
  const sameProgram = prog.period_start && new Date(prog.period_start).getTime() === since.getTime();
  const issued = sameProgram ? prog.rewards_issued : 0;

  const spentRes = await client.query(
    `SELECT COALESCE(SUM(total_amount), 0) AS spent FROM invoices
     WHERE admin_id = $1 AND department = 'restaurant' AND created_at >= $3
       AND right(regexp_replace(COALESCE(customer_phone, ''), '\\D', '', 'g'), 10) = $2`,
    [adminId, key, since]
  );
  const earned = Math.floor(Number(spentRes.rows[0].spent) / threshold + 1e-9);
  if (earned <= issued) {
    if (!sameProgram) {
      await client.query('UPDATE loyalty_progress SET period_start=$3, rewards_issued=0, updated_at=now() WHERE admin_id=$1 AND phone_key=$2', [adminId, key, since]);
    }
    return null;
  }

  let expiry = null;
  const validDays = parseInt(cfg.validDays, 10);
  if (validDays > 0) expiry = new Date(Date.now() + validDays * 86400000).toISOString().slice(0, 10);

  let promo = null;
  for (let attempt = 0; attempt < 5 && !promo; attempt++) {
    const ins = await client.query(
      `INSERT INTO promo_codes (admin_id, code, discount_type, discount_value, expiry_date, max_uses,
                                 customer_phone, customer_name, auto_generated)
       VALUES ($1,$2,$3,$4,$5,1,$6,$7,true)
       ON CONFLICT (admin_id, code) DO NOTHING RETURNING *`,
      [adminId, randomRewardCode(), type, value, expiry, key, customerName || null]
    );
    promo = ins.rows[0] || null;
  }
  if (!promo) return null;

  // Jump straight to `earned` (not issued + 1): one bill pays out one reward,
  // never a chain of catch-up rewards on the customer's next visits.
  await client.query(
    'UPDATE loyalty_progress SET period_start=$3, rewards_issued=$4, updated_at=now() WHERE admin_id=$1 AND phone_key=$2',
    [adminId, key, since, earned]
  );
  return {
    code: promo.code, discountType: promo.discount_type, discountValue: Number(promo.discount_value),
    expiryDate: expiry, customerName: customerName || '', spendThreshold: threshold
  };
}

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
  // Also block billing for a department the admin's PLAN doesn't cover —
  // closes the gap where a staff token from before a downgrade, or a
  // direct API call, could still generate invoices for it.
  const { departments: planDepartments, active } = await getPlanAccess(req.user.adminId);
  if (!active) {
    return res.status(402).json({ error: 'Your subscription is not active. Please subscribe to continue.' });
  }
  if (!planDepartments.includes(b.department)) {
    return res.status(403).json({ error: `Your current plan doesn't include ${b.department}.` });
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

    // Validate any promo code on the SERVER — the browser's own check can't be
    // trusted. Locks the code's row so a one-time code can't be redeemed by two
    // bills at the same moment.
    let appliedPromo = null;
    const claimedDiscount = Number(b.discountAmount) || 0;
    if (b.promoCode) {
      const pr = await client.query(
        `SELECT *, (expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE) AS is_expired
         FROM promo_codes WHERE admin_id = $1 AND upper(code) = upper($2) FOR UPDATE`,
        [req.user.adminId, String(b.promoCode)]
      );
      appliedPromo = pr.rows[0];
      if (!appliedPromo) throw httpError(400, 'That promo code is not valid.');
      if (appliedPromo.is_expired) throw httpError(400, 'That promo code has expired.');
      if (appliedPromo.max_uses != null && appliedPromo.used_count >= appliedPromo.max_uses) {
        throw httpError(400, 'That promo code has already been used up.');
      }
      if (appliedPromo.customer_phone && phoneKey(b.customerPhone) !== appliedPromo.customer_phone) {
        throw httpError(400, 'That promo code was issued to a different customer, so it can\'t be used on this bill.');
      }
      const preDiscount = (Number(b.totalAmount) || 0) + claimedDiscount;
      const rawAllowed = appliedPromo.discount_type === 'percent'
        ? preDiscount * Number(appliedPromo.discount_value) / 100
        : Number(appliedPromo.discount_value);
      const allowed = Math.min(rawAllowed, preDiscount);
      if (claimedDiscount > allowed + 0.05) {
        throw httpError(400, 'The discount on this bill doesn\'t match the promo code. Please remove and re-apply the code.');
      }
    } else if (b.department === 'restaurant' && claimedDiscount > 0) {
      throw httpError(400, 'A discount can only be given with a valid promo code.');
    }

    const invRes = await client.query(
      `INSERT INTO invoices (admin_id, invoice_no, department, customer_name, customer_phone, table_no,
                              room_booking_id, banquet_booking_id, subtotal, discount_amount, promo_code,
                              total_amount, payment_method, created_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.user.adminId, invoiceNo, b.department, b.customerName, b.customerPhone, b.tableNo || null,
       b.roomBookingId || null, b.banquetBookingId || null, b.subtotal || 0, b.discountAmount || 0,
       appliedPromo ? appliedPromo.code : null, b.totalAmount || 0, b.paymentMethod || null, staffId]
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
    if (appliedPromo) {
      await client.query(
        'UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1',
        [appliedPromo.id]
      );
    }
    if (b.banquetBookingId) {
      await client.query('UPDATE banquet_bookings SET invoice_id=$1 WHERE id=$2', [invoice.id, b.banquetBookingId]);
    }
    // Loyalty reward — in a savepoint so that if anything here goes wrong the
    // bill itself is still saved; a reward problem must never block billing.
    let loyaltyReward = null;
    if (b.department === 'restaurant') {
      await client.query('SAVEPOINT loyalty_reward');
      try {
        loyaltyReward = await maybeIssueLoyaltyReward(
          client, req.user.adminId, b.customerName, b.customerPhone,
          settingsRes.rows[0] && settingsRes.rows[0].extra
        );
        await client.query('RELEASE SAVEPOINT loyalty_reward');
      } catch (rewardErr) {
        console.error('Loyalty reward failed (bill saved anyway):', rewardErr);
        await client.query('ROLLBACK TO SAVEPOINT loyalty_reward');
        loyaltyReward = null;
      }
    }
    await client.query('COMMIT');
    res.status(201).json(Object.assign({}, invoice, { loyaltyReward }));
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
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
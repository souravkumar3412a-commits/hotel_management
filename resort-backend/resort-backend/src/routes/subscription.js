const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const GST_RATE = 0.18; // 18% GST on top of the base plan price

// Only the Admin who owns a tenant has a subscription — Staff access is
// governed by their Admin's subscription, not a subscription of their own.
function requireAdminSelf(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// Every admin gets a subscriptions row at signup (see auth.js), so this
// should always find one. If it's somehow missing (e.g. an account created
// before this feature existed), create the default inactive row on the fly.
async function getOrCreateSubscription(adminId) {
  let r = await pool.query('SELECT * FROM subscriptions WHERE admin_id = $1', [adminId]);
  if (!r.rows[0]) {
    r = await pool.query('INSERT INTO subscriptions (admin_id) VALUES ($1) RETURNING *', [adminId]);
  }
  let sub = r.rows[0];
  // Self-healing expiry check: a subscription that says 'active' but whose
  // expiry_date has passed is treated (and persisted) as 'expired' the next
  // time anyone checks it — no separate cron job needed for this simple case.
  if (sub.status === 'active' && sub.expiry_date && new Date(sub.expiry_date) < new Date()) {
    const upd = await pool.query(
      "UPDATE subscriptions SET status = 'expired', updated_at = now() WHERE id = $1 RETURNING *",
      [sub.id]
    );
    sub = upd.rows[0];
  }
  return sub;
}

function withGst(sub) {
  const base = Number(sub.amount);
  const gstAmount = Math.round(base * GST_RATE * 100) / 100;
  const totalAmount = Math.round((base + gstAmount) * 100) / 100;
  return Object.assign({}, sub, { gstRate: GST_RATE, gstAmount, totalAmount });
}

// Looks up a promo code and returns it only if it's actually usable right now
// (active, not expired, under its use limit). Case-insensitive.
async function findValidPromo(code) {
  if (!code) return null;
  const r = await pool.query(
    `SELECT * FROM subscription_promo_codes
     WHERE upper(code) = upper($1) AND active = true
       AND (expires_at IS NULL OR expires_at > now())
       AND (max_uses IS NULL OR used_count < max_uses)`,
    [code]
  );
  return r.rows[0] || null;
}
function applyDiscount(totalAmount, promo) {
  if (!promo) return totalAmount;
  const discounted = totalAmount * (1 - Number(promo.discount_percent) / 100);
  return Math.max(0, Math.round(discounted * 100) / 100);
}

// POST /api/subscription/validate-promo — lets the paywall show a live
// "X% off — new total ₹Y" preview before the admin commits to Subscribe.
// Re-validated again (independently) inside /subscribe, so nothing here is
// trusted on its own — this endpoint is just for the preview UI.
router.post('/validate-promo', requireAdminSelf, async (req, res) => {
  const { code } = req.body;
  try {
    const promo = await findValidPromo(code);
    if (!promo) return res.status(404).json({ error: 'That promo code is invalid or has expired.' });
    const sub = await getOrCreateSubscription(req.user.adminId);
    const { totalAmount } = withGst(sub);
    const payableAmount = applyDiscount(totalAmount, promo);
    res.json({
      code: promo.code, discountPercent: Number(promo.discount_percent),
      totalAmount, payableAmount, free: payableAmount <= 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong checking that code.' });
  }
});

// GET /api/subscription — the ONLY source of truth for "is this admin's
// account allowed into the dashboard". The frontend calls this after every
// login (and on page-refresh session-restore) rather than trusting anything
// cached locally, so a user can't bypass the paywall by editing localStorage.
router.get('/', requireAdminSelf, async (req, res) => {
  try {
    const sub = await getOrCreateSubscription(req.user.adminId);
    res.json(withGst(sub));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong checking your subscription.' });
  }
});

// POST /api/subscription/subscribe — called when the Admin clicks "Subscribe".
// Creates a real Razorpay order for the GST-inclusive amount and returns just
// enough for the frontend to open Razorpay Checkout. This does NOT activate
// the subscription — only a verified payment (see /verify below) does that.
router.post('/subscribe', requireAdminSelf, async (req, res) => {
  try {
    const sub = await getOrCreateSubscription(req.user.adminId);
    const { totalAmount } = withGst(sub);

    // A promo code (set up by you, e.g. 100% off for a friend) can make this
    // free — in which case we activate immediately and skip Razorpay
    // entirely, since there's nothing to actually charge.
    let promo = null;
    if (req.body.promoCode) {
      promo = await findValidPromo(req.body.promoCode);
      if (!promo) return res.status(400).json({ error: 'That promo code is invalid or has expired.' });
    }
    const payableAmount = applyDiscount(totalAmount, promo);

    if (payableAmount <= 0) {
      const upd = await pool.query(
        `UPDATE subscriptions
         SET status = 'active', start_date = now(), expiry_date = now() + interval '1 year',
             payment_provider = 'promo', payment_id = NULL, razorpay_order_id = NULL,
             promo_code_used = $1, updated_at = now()
         WHERE id = $2 RETURNING *`,
        [promo.code, sub.id]
      );
      await pool.query('UPDATE subscription_promo_codes SET used_count = used_count + 1 WHERE id = $1', [promo.id]);
      return res.json(Object.assign({ free: true }, withGst(upd.rows[0])));
    }

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: 'Payments aren\'t configured on the server yet.' });
    }
    const amountPaise = Math.round(payableAmount * 100); // Razorpay wants the smallest currency unit

    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const orderRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        receipt: `sub_${sub.id}`,
        notes: { adminId: req.user.adminId, planName: sub.plan_name, promoCode: promo ? promo.code : null }
      })
    });
    if (!orderRes.ok) {
      const errText = await orderRes.text();
      console.error('Razorpay order creation failed:', errText);
      return res.status(502).json({ error: 'Could not start the payment. Please try again.' });
    }
    const order = await orderRes.json();

    const upd = await pool.query(
      "UPDATE subscriptions SET status = 'pending', razorpay_order_id = $1, promo_code_used = $2, updated_at = now() WHERE id = $3 RETURNING *",
      [order.id, promo ? promo.code : null, sub.id]
    );
    const updated = withGst(upd.rows[0]);
    res.json({
      free: false,
      orderId: order.id,
      amountPaise: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      planName: updated.plan_name,
      baseAmount: Number(updated.amount),
      gstAmount: updated.gstAmount,
      totalAmount: updated.totalAmount,
      payableAmount: payableAmount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong starting your subscription.' });
  }
});

// POST /api/subscription/verify — receives the Razorpay Checkout success
// callback's payload (razorpay_order_id, razorpay_payment_id, razorpay_signature),
// verifies it was genuinely signed by Razorpay using our key secret (so a
// user can't just fake a "success" response from the browser), and ONLY on
// a valid signature marks the subscription active.
router.post('/verify', requireAdminSelf, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment details.' });
  }
  if (!process.env.RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: 'Payments aren\'t configured on the server yet.' });
  }
  try {
    const sub = await getOrCreateSubscription(req.user.adminId);
    if (sub.razorpay_order_id !== razorpay_order_id) {
      return res.status(400).json({ error: 'This payment does not match your current subscription attempt.' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment could not be verified.' });
    }

    const upd = await pool.query(
      `UPDATE subscriptions
       SET status = 'active', start_date = now(), expiry_date = now() + interval '1 year',
           payment_id = $1, payment_provider = 'razorpay', updated_at = now()
       WHERE id = $2 RETURNING *`,
      [razorpay_payment_id, sub.id]
    );
    // If a (partial-discount) promo code was used to get here, count it as
    // redeemed now that payment is actually verified — the free/100%-off
    // path already increments this itself in /subscribe, since it never
    // reaches this route.
    if (sub.promo_code_used) {
      await pool.query('UPDATE subscription_promo_codes SET used_count = used_count + 1 WHERE upper(code) = upper($1)', [sub.promo_code_used]);
    }
    res.json(withGst(upd.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong verifying your payment.' });
  }
});

module.exports = router;
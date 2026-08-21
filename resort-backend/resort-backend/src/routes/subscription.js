const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

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

// GET /api/subscription — the ONLY source of truth for "is this admin's
// account allowed into the dashboard". The frontend calls this after every
// login (and on page-refresh session-restore) rather than trusting anything
// cached locally, so a user can't bypass the paywall by editing localStorage.
router.get('/', requireAdminSelf, async (req, res) => {
  try {
    const sub = await getOrCreateSubscription(req.user.adminId);
    res.json(sub);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong checking your subscription.' });
  }
});

// POST /api/subscription/subscribe — called when the Admin clicks "Subscribe"
// on the paywall screen. This does NOT activate anything and does NOT talk to
// any payment provider yet — it only records that the admin started a
// subscription attempt (status -> 'pending'), which is exactly the state a
// real Razorpay order would put them in while payment is in progress.
//
// ============================================================
// FUTURE RAZORPAY INTEGRATION — exact wiring points:
// ============================================================
// 1) ORDER CREATION: replace the body of this route with a call to Razorpay's
//    Orders API (razorpay.orders.create({ amount: sub.amount * 100, currency:
//    'INR', ... })), store the returned order id (e.g. in payment_id), and
//    return { orderId, amount, keyId } to the frontend instead of the bare
//    subscription row.
// 2) CHECKOUT: on the frontend, api.subscribeToPlan()'s .then() is where the
//    Razorpay Checkout.js widget gets opened with that orderId (see the
//    startSubscribeFlow() function in index.html — marked with the same
//    FUTURE RAZORPAY comment).
// 3) VERIFICATION: add a new route, POST /api/subscription/verify, that
//    receives Razorpay's payment_id/order_id/signature from the Checkout
//    success callback, verifies the signature server-side with your Razorpay
//    key secret, and ONLY on successful verification runs the UPDATE below
//    (status -> 'active', start_date -> now(), expiry_date -> now() + 1 year,
//    payment_id -> the verified Razorpay payment id). A stub for this route
//    is included below, returning 501 until it's implemented.
// ============================================================
router.post('/subscribe', requireAdminSelf, async (req, res) => {
  try {
    const sub = await getOrCreateSubscription(req.user.adminId);
    const r = await pool.query(
      "UPDATE subscriptions SET status = 'pending', payment_provider = 'razorpay', updated_at = now() WHERE id = $1 RETURNING *",
      [sub.id]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong starting your subscription.' });
  }
});

// POST /api/subscription/verify — WHERE RAZORPAY PAYMENT VERIFICATION WILL
// GO. Not implemented yet, on purpose (per this task's scope) — this stub
// exists so the exact insertion point is unambiguous when that work happens.
router.post('/verify', requireAdminSelf, async (req, res) => {
  res.status(501).json({ error: 'Payment verification is not implemented yet.' });
});

module.exports = router;
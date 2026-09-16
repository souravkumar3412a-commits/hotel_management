const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { PLAN_DEPARTMENTS } = require('../middleware/rbac');

const router = express.Router();
router.use(requireAuth);

const GST_RATE = 0.18; // 18% GST on top of the base plan price

// Single source of truth for plan pricing. departments comes from rbac.js
// so access checks and pricing can never drift out of sync with each other.
const PLANS = {
  room_banquet: { name: 'Room + Banquet Management', amount: 8000, departments: PLAN_DEPARTMENTS.room_banquet },
  restaurant: { name: 'Restaurant Only', amount: 6000, departments: PLAN_DEPARTMENTS.restaurant },
  all: { name: 'All Departments (Room + Banquet + Restaurant)', amount: 12000, departments: PLAN_DEPARTMENTS.all }
};

function isValidPlan(planType) {
  return Object.prototype.hasOwnProperty.call(PLANS, planType);
}

// True only when targetPlan unlocks every department currentPlan already
// has, PLUS at least one more — i.e. a genuine upgrade, never sideways or
// down. With just these 3 tiers this means: the only valid upgrade target
// for room_banquet or restaurant is 'all'. A tenant already on 'all' has
// nothing left to upgrade to.
function isUpgrade(currentPlanType, targetPlanType) {
  const current = new Set(PLANS[currentPlanType].departments);
  const target = new Set(PLANS[targetPlanType].departments);
  const coversEverything = [...current].every((d) => target.has(d));
  const addsSomething = [...target].some((d) => !current.has(d));
  return coversEverything && addsSomething;
}

// Only the Admin who owns a tenant has a subscription — Staff access is
// governed by their Admin's subscription, not a subscription of their own.
function requireAdminSelf(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// Every admin gets a subscriptions row at signup (see auth.js), so this
// should always find one. If it's somehow missing, create the default
// inactive row on the fly.
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

// Adds GST + the resolved plan's departments/name to a subscription row for
// the frontend. baseAmount is ALWAYS derived from PLANS[plan_type], never
// trusted from the stored amount column, so it can't drift or be tampered.
function withGst(sub) {
  const plan = PLANS[sub.plan_type] || PLANS.all;
  const base = plan.amount;
  const gstAmount = Math.round(base * GST_RATE * 100) / 100;
  const totalAmount = Math.round((base + gstAmount) * 100) / 100;
  return Object.assign({}, sub, {
    planType: sub.plan_type,
    planLabel: plan.name,
    departments: plan.departments,
    baseAmount: base,
    gstRate: GST_RATE,
    gstAmount,
    totalAmount
  });
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

// GET /api/subscription/plans — the 3 tiers with GST-inclusive pricing, for
// the paywall / "upgrade" screen to render without hardcoding prices twice.
router.get('/plans', requireAdminSelf, async (req, res) => {
  const list = Object.keys(PLANS).map((planType) => {
    const p = PLANS[planType];
    const gstAmount = Math.round(p.amount * GST_RATE * 100) / 100;
    const totalAmount = Math.round((p.amount + gstAmount) * 100) / 100;
    return { planType, name: p.name, departments: p.departments, baseAmount: p.amount, gstAmount, totalAmount };
  });
  res.json(list);
});

// POST /api/subscription/validate-promo — body: { code, planType }. Lets the
// paywall show a live "X% off — new total ₹Y" preview. If the admin is
// already active, this previews the UPGRADE delta, not the full plan price.
// Re-validated again (independently) inside /subscribe, so nothing here is
// trusted on its own — this endpoint is just for the preview UI.
router.post('/validate-promo', requireAdminSelf, async (req, res) => {
  const { code, planType } = req.body;
  if (!isValidPlan(planType)) return res.status(400).json({ error: 'Invalid plan selected.' });
  try {
    const promo = await findValidPromo(code);
    if (!promo) return res.status(404).json({ error: 'That promo code is invalid or has expired.' });
    const sub = await getOrCreateSubscription(req.user.adminId);
    const targetTotal = withGst({ plan_type: planType }).totalAmount;
    let payableBase = targetTotal;
    if (sub.status === 'active') {
      if (!isUpgrade(sub.plan_type, planType)) {
        return res.status(400).json({ error: 'You can only upgrade to a plan that adds departments you don\'t already have.' });
      }
      payableBase = targetTotal - withGst(sub).totalAmount;
    }
    const payableAmount = applyDiscount(payableBase, promo);
    res.json({
      code: promo.code, discountPercent: Number(promo.discount_percent),
      totalAmount: payableBase, payableAmount, free: payableAmount <= 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong checking that code.' });
  }
});

// GET /api/subscription — the ONLY source of truth for "is this admin's
// account allowed into the dashboard, and which departments can they use".
// The frontend calls this after every login (and on page-refresh
// session-restore) rather than trusting anything cached locally.
router.get('/', requireAdminSelf, async (req, res) => {
  try {
    const sub = await getOrCreateSubscription(req.user.adminId);
    res.json(withGst(sub));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong checking your subscription.' });
  }
});

// POST /api/subscription/subscribe — body: { planType, promoCode }.
// - If the tenant is inactive/expired: a normal fresh subscribe to
//   whichever plan they picked, full price, new 1-year expiry.
// - If the tenant is already active: this is an UPGRADE. Only 'all' is a
//   valid target for either partial plan. They're charged just the price
//   DIFFERENCE (not the full plan again), and their existing expiry_date
//   is kept as-is — they're not getting a fresh year, just more
//   departments for the time they've already paid for.
router.post('/subscribe', requireAdminSelf, async (req, res) => {
  const { planType, promoCode } = req.body;
  if (!isValidPlan(planType)) return res.status(400).json({ error: 'Invalid plan selected.' });
  try {
    const sub = await getOrCreateSubscription(req.user.adminId);
    const isUpgradeFlow = sub.status === 'active';

    if (isUpgradeFlow) {
      if (sub.plan_type === planType) {
        return res.status(400).json({ error: 'You are already on this plan.' });
      }
      if (!isUpgrade(sub.plan_type, planType)) {
        return res.status(400).json({ error: 'You can only upgrade to a plan that adds departments you don\'t already have — downgrading or switching sideways isn\'t supported.' });
      }
    }

    const targetTotal = withGst({ plan_type: planType }).totalAmount;
    const payableBase = isUpgradeFlow ? (targetTotal - withGst(sub).totalAmount) : targetTotal;

    let promo = null;
    if (promoCode) {
      promo = await findValidPromo(promoCode);
      if (!promo) return res.status(400).json({ error: 'That promo code is invalid or has expired.' });
    }
    const payableAmount = applyDiscount(payableBase, promo);

    // Free (100%-off promo, or an upgrade delta of ₹0) — activate immediately,
    // skip Razorpay entirely since there's nothing to actually charge.
    if (payableAmount <= 0) {
      const setExpiry = isUpgradeFlow
        ? 'expiry_date = expiry_date' // keep existing expiry on upgrade
        : "expiry_date = now() + interval '1 year'";
      const upd = await pool.query(
        `UPDATE subscriptions
         SET status = 'active', plan_type = $1,
             start_date = COALESCE(start_date, now()), ${setExpiry},
             payment_provider = 'promo', payment_id = NULL, razorpay_order_id = NULL,
             promo_code_used = $2, updated_at = now()
         WHERE id = $3 RETURNING *`,
        [planType, promo ? promo.code : null, sub.id]
      );
      if (promo) await pool.query('UPDATE subscription_promo_codes SET used_count = used_count + 1 WHERE id = $1', [promo.id]);
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
        receipt: `sub_${sub.id}_${Date.now()}`,
        notes: { adminId: req.user.adminId, targetPlanType: planType, isUpgrade: isUpgradeFlow, promoCode: promo ? promo.code : null }
      })
    });
    if (!orderRes.ok) {
      const errText = await orderRes.text();
      console.error('Razorpay order creation failed:', errText);
      return res.status(502).json({ error: 'Could not start the payment. Please try again.' });
    }
    const order = await orderRes.json();

    // Stash the pending plan change on the row itself (pending_plan_type) so
    // /verify knows what to switch them to once payment is confirmed —
    // without this, a second browser tab or a retried request could verify
    // into the wrong plan.
    const upd = await pool.query(
      `UPDATE subscriptions
       SET status = 'pending', razorpay_order_id = $1, promo_code_used = $2,
           pending_plan_type = $3, updated_at = now()
       WHERE id = $4 RETURNING *`,
      [order.id, promo ? promo.code : null, planType, sub.id]
    );
    const updated = withGst(upd.rows[0]);
    res.json({
      free: false,
      isUpgrade: isUpgradeFlow,
      orderId: order.id,
      amountPaise: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      planType,
      planLabel: PLANS[planType].name,
      payableAmount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong starting your subscription.' });
  }
});

// POST /api/subscription/verify — receives the Razorpay Checkout success
// callback's payload, verifies it was genuinely signed by Razorpay (so a
// user can't just fake a "success" response from the browser), and ONLY on
// a valid signature activates the pending_plan_type that /subscribe stashed.
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

    const wasAlreadyActive = sub.status === 'active';
    const finalPlanType = sub.pending_plan_type || sub.plan_type;
    const setExpiry = wasAlreadyActive
      ? 'expiry_date = expiry_date' // upgrade: keep existing expiry, don't reset the term
      : "expiry_date = now() + interval '1 year'";

    const upd = await pool.query(
      `UPDATE subscriptions
       SET status = 'active', plan_type = $1, pending_plan_type = NULL,
           start_date = COALESCE(start_date, now()), ${setExpiry},
           payment_id = $2, payment_provider = 'razorpay', updated_at = now()
       WHERE id = $3 RETURNING *`,
      [finalPlanType, razorpay_payment_id, sub.id]
    );
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
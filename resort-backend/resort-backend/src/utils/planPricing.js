// Pure, I/O-free plan pricing and upgrade-eligibility logic — deliberately
// separated from routes/subscription.js (which also does database work) so
// this part can be unit tested without a database. See
// test/planPricing.test.js.
const { PLAN_DEPARTMENTS, PLAN_FEATURES } = require('../middleware/rbac');

const GST_RATE = 0.18; // 18% GST on top of the base plan price

// Single source of truth for plan pricing. departments/features come from
// rbac.js so access checks and pricing can never drift out of sync.
const PLANS = {
  room_banquet: { name: 'Room + Banquet Management', amount: 8000, departments: PLAN_DEPARTMENTS.room_banquet, features: PLAN_FEATURES.room_banquet },
  restaurant: { name: 'Restaurant Only', amount: 6000, departments: PLAN_DEPARTMENTS.restaurant, features: PLAN_FEATURES.restaurant },
  all: { name: 'All Departments (Room + Banquet + Restaurant)', amount: 12000, departments: PLAN_DEPARTMENTS.all, features: PLAN_FEATURES.all },
  premium: { name: 'Premium', amount: 18000, departments: PLAN_DEPARTMENTS.premium, features: PLAN_FEATURES.premium }
};

function isValidPlan(planType) {
  return Object.prototype.hasOwnProperty.call(PLANS, planType);
}

// True only when targetPlan covers every department AND every feature the
// currentPlan already has, PLUS adds at least one more of either — i.e. a
// genuine upgrade, never sideways or down. This is what makes 'all' ->
// 'premium' count as a valid upgrade even though both cover the same 3
// departments: premium adds the 'voice' and 'ai' features, which is enough
// on its own to qualify. Returns false for an unknown plan type on either
// side, rather than throwing.
function isUpgrade(currentPlanType, targetPlanType) {
  const cur = PLANS[currentPlanType], tgt = PLANS[targetPlanType];
  if (!cur || !tgt) return false;
  const curDepts = new Set(cur.departments), tgtDepts = new Set(tgt.departments);
  const curFeats = new Set(cur.features), tgtFeats = new Set(tgt.features);
  const deptsCovered = [...curDepts].every((d) => tgtDepts.has(d));
  const featsCovered = [...curFeats].every((f) => tgtFeats.has(f));
  const addsDept = [...tgtDepts].some((d) => !curDepts.has(d));
  const addsFeat = [...tgtFeats].some((f) => !curFeats.has(f));
  return deptsCovered && featsCovered && (addsDept || addsFeat);
}

// promo is a subscription_promo_codes row (or null/undefined for "no promo").
// Never returns a negative amount, and rounds to 2 decimal places like a
// real currency amount should.
function applyDiscount(totalAmount, promo) {
  if (!promo) return totalAmount;
  const discounted = totalAmount * (1 - Number(promo.discount_percent) / 100);
  return Math.max(0, Math.round(discounted * 100) / 100);
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
    features: plan.features,
    baseAmount: base,
    gstRate: GST_RATE,
    gstAmount,
    totalAmount
  });
}

module.exports = { PLANS, GST_RATE, isValidPlan, isUpgrade, applyDiscount, withGst };
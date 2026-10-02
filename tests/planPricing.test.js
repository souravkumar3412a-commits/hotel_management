const { PLANS, isValidPlan, isUpgrade, applyDiscount, withGst } = require('../utils/planPricing');

describe('isValidPlan', () => {
  test('accepts every real plan type', () => {
    Object.keys(PLANS).forEach((planType) => {
      expect(isValidPlan(planType)).toBe(true);
    });
  });

  test('rejects an unknown plan type', () => {
    expect(isValidPlan('gold_tier')).toBe(false);
    expect(isValidPlan('')).toBe(false);
    expect(isValidPlan(undefined)).toBe(false);
  });
});

describe('isUpgrade', () => {
  test('restaurant -> all is a real upgrade (adds departments)', () => {
    expect(isUpgrade('restaurant', 'all')).toBe(true);
  });

  test('room_banquet -> all is a real upgrade (adds restaurant)', () => {
    expect(isUpgrade('room_banquet', 'all')).toBe(true);
  });

  test('all -> premium is a real upgrade even with the same departments, because it adds features', () => {
    expect(isUpgrade('all', 'premium')).toBe(true);
  });

  test('all -> restaurant is NOT an upgrade (loses departments)', () => {
    expect(isUpgrade('all', 'restaurant')).toBe(false);
  });

  test('premium -> all is NOT an upgrade (loses features)', () => {
    expect(isUpgrade('premium', 'all')).toBe(false);
  });

  test('a plan is not an upgrade from itself (no new departments or features)', () => {
    expect(isUpgrade('all', 'all')).toBe(false);
    expect(isUpgrade('premium', 'premium')).toBe(false);
  });

  test('room_banquet -> restaurant is NOT an upgrade (sideways, loses room+banquet)', () => {
    expect(isUpgrade('room_banquet', 'restaurant')).toBe(false);
  });

  test('an unknown plan on either side is never an upgrade', () => {
    expect(isUpgrade('made_up_plan', 'all')).toBe(false);
    expect(isUpgrade('all', 'made_up_plan')).toBe(false);
  });
});

describe('applyDiscount', () => {
  test('no promo returns the original amount unchanged', () => {
    expect(applyDiscount(1000, null)).toBe(1000);
    expect(applyDiscount(1000, undefined)).toBe(1000);
  });

  test('a 100% promo brings the amount to exactly 0 (free)', () => {
    expect(applyDiscount(14160, { discount_percent: 100 })).toBe(0);
  });

  test('a 20% promo discounts correctly and rounds to 2 decimals', () => {
    expect(applyDiscount(1000, { discount_percent: 20 })).toBe(800);
    expect(applyDiscount(999, { discount_percent: 33 })).toBe(669.33);
  });

  test('never goes negative even with a (theoretically invalid) >100% value', () => {
    expect(applyDiscount(1000, { discount_percent: 150 })).toBe(0);
  });
});

describe('withGst', () => {
  test('adds 18% GST on top of the plan\'s base price, derived from PLANS — never from the stored row', () => {
    const result = withGst({ plan_type: 'restaurant', amount: 1 /* deliberately wrong — must be ignored */ });
    expect(result.baseAmount).toBe(PLANS.restaurant.amount);
    expect(result.gstAmount).toBeCloseTo(PLANS.restaurant.amount * 0.18, 2);
    expect(result.totalAmount).toBeCloseTo(PLANS.restaurant.amount * 1.18, 2);
  });

  test('falls back to the "all" plan\'s pricing for an unrecognized/missing plan_type', () => {
    const result = withGst({ plan_type: 'not_a_real_plan' });
    expect(result.baseAmount).toBe(PLANS.all.amount);
  });

  test('carries over every other field already on the row untouched', () => {
    const result = withGst({ plan_type: 'premium', status: 'active', id: 'sub_123' });
    expect(result.status).toBe('active');
    expect(result.id).toBe('sub_123');
  });
});
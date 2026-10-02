// These tests only check the shape and consistency of the static
// PLAN_DEPARTMENTS / PLAN_FEATURES tables in middleware/rbac.js — not the
// database-backed getPlanAccess()/requireDepartment() functions, which need
// a real Postgres connection and are out of scope for unit tests. The goal
// here is to catch the realistic mistake of adding a new plan to one table
// and forgetting the other, or mistyping a department/feature name.
const { PLAN_DEPARTMENTS, PLAN_FEATURES } = require('../middleware/rbac');

const VALID_DEPARTMENTS = ['room', 'banquet', 'restaurant'];
const VALID_FEATURES = ['voice', 'ai'];

describe('PLAN_DEPARTMENTS / PLAN_FEATURES consistency', () => {
  test('every plan listed in PLAN_DEPARTMENTS also has a PLAN_FEATURES entry, and vice versa', () => {
    expect(Object.keys(PLAN_DEPARTMENTS).sort()).toEqual(Object.keys(PLAN_FEATURES).sort());
  });

  test('every department name used is one of the 3 real departments', () => {
    Object.values(PLAN_DEPARTMENTS).forEach((depts) => {
      depts.forEach((d) => expect(VALID_DEPARTMENTS).toContain(d));
    });
  });

  test('every feature name used is one of the 2 real features', () => {
    Object.values(PLAN_FEATURES).forEach((feats) => {
      feats.forEach((f) => expect(VALID_FEATURES).toContain(f));
    });
  });

  test('no plan lists the same department twice', () => {
    Object.entries(PLAN_DEPARTMENTS).forEach(([planType, depts]) => {
      expect(new Set(depts).size).toBe(depts.length);
    });
  });

  test('"all" and "premium" cover every department', () => {
    expect(new Set(PLAN_DEPARTMENTS.all).size).toBe(VALID_DEPARTMENTS.length);
    expect(new Set(PLAN_DEPARTMENTS.premium).size).toBe(VALID_DEPARTMENTS.length);
  });

  test('only "premium" unlocks any features — every other plan is feature-free', () => {
    Object.entries(PLAN_FEATURES).forEach(([planType, feats]) => {
      if (planType === 'premium') {
        expect(feats.length).toBeGreaterThan(0);
      } else {
        expect(feats).toEqual([]);
      }
    });
  });

  test('"premium" specifically unlocks voice and ai (what the Key Modules marketing page promises)', () => {
    expect(PLAN_FEATURES.premium.sort()).toEqual(['ai', 'voice'].sort());
  });
});
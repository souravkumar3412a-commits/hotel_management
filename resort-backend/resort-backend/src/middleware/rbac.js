const { pool } = require('../db');

// Which departments each plan tier unlocks. Keep this in sync with the
// PLANS map in routes/subscription.js — that one has prices, this one is
// just used for access checks so routes don't need to know prices at all.
const PLAN_DEPARTMENTS = {
  room_banquet: ['room', 'banquet'],
  restaurant: ['restaurant'],
  all: ['room', 'banquet', 'restaurant'],
  premium: ['room', 'banquet', 'restaurant']
};

// Non-department features a plan unlocks. Only 'premium' has any right now
// (Voice commands + the AI Assistant) — every other tier gets an empty list.
const PLAN_FEATURES = {
  room_banquet: [],
  restaurant: [],
  all: [],
  premium: ['voice', 'ai']
};

// Looks up what an admin's tenant is currently allowed to use. Returns
// empty departments/features and active: false if there's no row, the
// subscription isn't active, or it has expired (mirrors the self-healing
// expiry check in routes/subscription.js, done here too since routes can
// be hit directly without going through GET /subscription first).
async function getPlanAccess(adminId) {
  const r = await pool.query(
    'SELECT plan_type, status, expiry_date FROM subscriptions WHERE admin_id = $1',
    [adminId]
  );
  const sub = r.rows[0];
  if (!sub) return { departments: [], features: [], active: false };
  const notExpired = !sub.expiry_date || new Date(sub.expiry_date) > new Date();
  const active = sub.status === 'active' && notExpired;
  if (!active) return { departments: [], features: [], active: false };
  return {
    departments: PLAN_DEPARTMENTS[sub.plan_type] || [],
    features: PLAN_FEATURES[sub.plan_type] || [],
    active: true
  };
}

// Admin-only, no department/feature check — for tenant-wide actions that
// aren't tied to a specific paid department (hotel name/logo, staff list, etc).
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// Department-gated, subscription-aware. Admin passes only if their PLAN
// covers every department listed. Staff passes only if their OWN
// department is in the list AND their admin's plan still covers it.
function requireDepartment(...allowedDepartments) {
  return async function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    try {
      const { departments: planDepartments, active } = await getPlanAccess(req.user.adminId);
      if (!active) {
        return res.status(402).json({ error: 'Your subscription is not active. Please subscribe to continue.' });
      }
      if (req.user.role === 'admin') {
        const covered = allowedDepartments.every((d) => planDepartments.includes(d));
        if (!covered) {
          return res.status(403).json({ error: 'Your current plan does not include this department. Upgrade your plan to unlock it.' });
        }
        return next();
      }
      if (req.user.role === 'staff' &&
          allowedDepartments.includes(req.user.department) &&
          planDepartments.includes(req.user.department)) {
        return next();
      }
      return res.status(403).json({ error: 'Your department does not have access to this.' });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Something went wrong checking your access.' });
    }
  };
}

// Admin-only AND department-gated in one middleware — for admin-only CRUD
// that's specific to one department (adding a room, editing a banquet hall,
// restaurant menu items). Staff never reach these regardless of plan.
function requireAdminDepartment(...departments) {
  const deptCheck = requireDepartment(...departments);
  return function (req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    return deptCheck(req, res, next);
  };
}

// Feature-gated (Voice, AI Assistant) — admin-only by design (these are
// owner/manager tools, not day-to-day staff tools), and only Premium plans
// carry any features at all.
function requireFeature(feature) {
  return async function (req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    try {
      const { features, active } = await getPlanAccess(req.user.adminId);
      if (!active) {
        return res.status(402).json({ error: 'Your subscription is not active. Please subscribe to continue.' });
      }
      if (!features.includes(feature)) {
        return res.status(403).json({ error: 'This feature is only available on the Premium plan. Upgrade to unlock it.' });
      }
      next();
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Something went wrong checking your access.' });
    }
  };
}

module.exports = {
  requireAdmin, requireDepartment, requireAdminDepartment, requireFeature,
  PLAN_DEPARTMENTS, PLAN_FEATURES, getPlanAccess
};
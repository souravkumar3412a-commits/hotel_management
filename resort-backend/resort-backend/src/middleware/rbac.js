// requireAuth (auth.js) answers "who is this?". This file answers "are they
// allowed to do THIS?" — the actual authorization your original app was missing.

// Only admins may proceed. Use for staff management, hotel setup, room/hall
// inventory config, promo codes, etc.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// Admins may always proceed. Staff may proceed only if their department is
// in the allowed list. Example: requireDepartment('room') lets Admin AND
// Room-department staff through, but blocks Restaurant/Banquet staff.
function requireDepartment(...allowedDepartments) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    if (req.user.role === 'admin') return next();
    if (req.user.role === 'staff' && allowedDepartments.includes(req.user.department)) {
      return next();
    }
    return res.status(403).json({ error: 'Your department does not have access to this.' });
  };
}

module.exports = { requireAdmin, requireDepartment };

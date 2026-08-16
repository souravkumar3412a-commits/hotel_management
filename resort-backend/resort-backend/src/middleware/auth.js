const jwt = require('jsonwebtoken');

// Every protected route runs this first. It reads the "Authorization: Bearer <token>"
// header, verifies it was really issued by our server (not forged), and attaches
// the decoded info (adminId, role, department) to req.user for later checks.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { role: 'admin'|'staff', adminId, staffId?, department? }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}

module.exports = { requireAuth };

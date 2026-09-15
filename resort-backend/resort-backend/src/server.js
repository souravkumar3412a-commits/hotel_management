require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const staffRoutes = require('./routes/staff');
const roomRoutes = require('./routes/rooms');
const banquetRoutes = require('./routes/banquets');
const restaurantRoutes = require('./routes/restaurant');
const invoiceRoutes = require('./routes/invoices');
const settingsRoutes = require('./routes/settings');
const subscriptionRoutes = require('./routes/subscription');

const app = express();

// Sets a batch of protective HTTP headers (blocks MIME-sniffing, stops the
// site being framed by another domain for clickjacking, etc). Free security
// with no downside for a JSON API like this one.
app.use(helmet());

// Render (like most hosts) sits your app behind a reverse proxy, which adds
// an X-Forwarded-For header. Without this, express-rate-limit can't reliably
// tell requests apart by IP and throws a validation error on every request.
app.set('trust proxy', 1);

// Only allow your actual frontend origin(s) to call this API.
// Set FRONTEND_ORIGIN in .env — comma-separated if you have more than one
// (e.g. your local dev server AND your deployed site).
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
if (allowedOrigins.length === 0) {
  // Falling through to "allow all" is fine on your own machine, but if this
  // ever prints on Render it means FRONTEND_ORIGIN isn't set there and the
  // API is open to being called from ANY website, not just yours. Check the
  // Environment tab in the Render dashboard if you see this in production.
  console.warn('WARNING: FRONTEND_ORIGIN is not set — CORS is allowing requests from ANY origin.');
}
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true, // "true" = allow all, useful while developing locally
  credentials: true
}));

// General ceiling on every API route (separate from the stricter login
// limiter below) so a scraper or bot can't hammer the whole API — 300
// requests per IP every 15 minutes is generous for a real user, easy to
// notice for anyone probing the site.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', apiLimiter);

// Default body size limit is only 100kb — too small for the hotel logo/stamp/
// signature images (sent as base64) and invoice PDFs. Raised to handle those.
app.use(express.json({ limit: '20mb' }));

// Slow down brute-force login attempts. Applies to all /api/auth/* routes.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});
app.use('/api/auth', loginLimiter, authRoutes);

app.use('/api/staff', staffRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/banquets', banquetRoutes);
app.use('/api/restaurant', restaurantRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/subscription', subscriptionRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Catch-all error handler — never leak stack traces to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Hotel API listening on port ${PORT}`));
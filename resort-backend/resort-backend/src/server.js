require('dotenv').config();
const express = require('express');
const cors = require('cors');
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

// Render (like most hosts) sits your app behind a reverse proxy, which adds
// an X-Forwarded-For header. Without this, express-rate-limit can't reliably
// tell requests apart by IP and throws a validation error on every request.
app.set('trust proxy', 1);

// Only allow your actual frontend origin(s) to call this API.
// Set FRONTEND_ORIGIN in .env — comma-separated if you have more than one
// (e.g. your local dev server AND your deployed site).
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true, // "true" = allow all, useful while developing locally
  credentials: true
}));

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
app.listen(PORT, () => console.log(`Resort API listening on port ${PORT}`));
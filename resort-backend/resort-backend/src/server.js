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

const app = express();

// Only allow your actual frontend origin(s) to call this API.
// Set FRONTEND_ORIGIN in .env — comma-separated if you have more than one
// (e.g. your local dev server AND your deployed site).
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true, // "true" = allow all, useful while developing locally
  credentials: true
}));

app.use(express.json());

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

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Catch-all error handler — never leak stack traces to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Resort API listening on port ${PORT}`));

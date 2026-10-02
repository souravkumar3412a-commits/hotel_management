const express = require('express');
const { pool } = require('../db');
const { sendRenewalReminderEmail } = require('../utils/mailer');

const router = express.Router();

// These routes are called by an external cron service (see README "Setting
// up renewal reminders"), not by anyone logged into the app — so they're
// protected by a shared secret header instead of the usual JWT auth.
function requireCronSecret(req, res, next) {
  if (!process.env.CRON_SECRET) {
    console.error('CRON_SECRET is not set — refusing all /api/internal requests.');
    return res.status(500).json({ error: 'This endpoint is not configured on the server.' });
  }
  const provided = req.headers['x-cron-secret'];
  if (!provided || provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing cron secret.' });
  }
  next();
}
router.use(requireCronSecret);

const REMINDER_WINDOW_DAYS = 7;
const PLAN_LABELS = { room_banquet: 'Room + Banquet Management', restaurant: 'Restaurant Only', all: 'All Departments', premium: 'Premium' };

// POST /api/internal/send-renewal-reminders — meant to be hit once a day by
// a free external cron service. Finds every ACTIVE subscription expiring
// within REMINDER_WINDOW_DAYS that hasn't already been reminded for its
// CURRENT expiry_date, emails the admin, and marks it sent so the same
// expiry can never trigger two emails (see routes/subscription.js for where
// that flag gets cleared again on a genuine renewal).
router.post('/send-renewal-reminders', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.plan_type, s.expiry_date, a.email, a.first_name
       FROM subscriptions s
       JOIN admins a ON a.id = s.admin_id
       WHERE s.status = 'active'
         AND s.expiry_date IS NOT NULL
         AND s.expiry_date <= now() + ($1 || ' days')::interval
         AND s.expiry_date > now()
         AND s.renewal_reminder_sent_at IS NULL`,
      [REMINDER_WINDOW_DAYS]
    );

    const frontendOrigin = (process.env.FRONTEND_ORIGIN || '').split(',')[0].trim() || 'http://127.0.0.1:5500';
    let sent = 0, failed = 0;

    for (const sub of result.rows) {
      const daysLeft = Math.max(1, Math.ceil((new Date(sub.expiry_date) - Date.now()) / (24 * 60 * 60 * 1000)));
      const sendResult = await sendRenewalReminderEmail({
        to: sub.email,
        firstName: sub.first_name,
        planLabel: PLAN_LABELS[sub.plan_type] || sub.plan_type,
        expiryDateLabel: new Date(sub.expiry_date).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }),
        daysLeft,
        renewLink: `${frontendOrigin}/index.html`
      });
      if (sendResult.ok) {
        sent++;
        await pool.query('UPDATE subscriptions SET renewal_reminder_sent_at = now() WHERE id = $1', [sub.id]);
      } else {
        failed++;
        console.error('Renewal reminder failed for subscription', sub.id, sendResult.error);
      }
    }
    res.json({ checked: result.rows.length, sent, failed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong sending renewal reminders.' });
  }
});

module.exports = router;
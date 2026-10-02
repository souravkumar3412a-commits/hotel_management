// Thin wrapper around nodemailer for every transactional email this app
// sends. Mirrors the same "gracefully explain what's missing" pattern used
// for GEMINI_API_KEY in routes/ai.js — if the SMTP env vars aren't set, we
// say so clearly in the server log rather than crashing or silently failing.
const nodemailer = require('nodemailer');

let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465, // true for port 465, false for 587/others (STARTTLS)
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  return cachedTransporter;
}

// Shared low-level sender. Returns { ok: true } or { ok: false, error }.
// Never throws — every caller here treats every outcome the same way from
// the requester's point of view (see each function below for why).
async function send({ to, subject, text, html }) {
  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, error: 'SMTP_HOST / SMTP_USER / SMTP_PASS are not set in .env — see .env.example.' };
  }
  const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await transporter.sendMail({ from: `"Eazzio Hotel Management System" <${fromAddress}>`, to, subject, text, html });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function button(href, label) {
  return `<p><a href="${href}" style="background:#0f9d76;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">${label}</a></p>`;
}
function plainLinkNote(href) {
  return `<p style="color:#666;font-size:12px;">Or paste this link into your browser:<br>${href}</p>`;
}

// Used by routes/auth.js POST /admin/forgot-password. A mail failure here
// is intentionally treated the same as "email doesn't exist" by the caller,
// so this function's result can't be used to guess account existence.
async function sendPasswordResetEmail({ to, firstName, resetLink, ttlMinutes }) {
  const greetingName = firstName || 'there';
  return send({
    to,
    subject: 'Reset your Eazzio password',
    text:
      `Hi ${greetingName},\n\n` +
      `We received a request to reset your Eazzio admin password. This link is valid for ${ttlMinutes} minutes:\n\n` +
      `${resetLink}\n\n` +
      `If you didn't request this, you can safely ignore this email — your password won't change.\n\n` +
      `— Eazzio`,
    html:
      `<p>Hi ${greetingName},</p>` +
      `<p>We received a request to reset your Eazzio admin password. This link is valid for <b>${ttlMinutes} minutes</b>:</p>` +
      button(resetLink, 'Reset your password') +
      plainLinkNote(resetLink) +
      `<p>If you didn't request this, you can safely ignore this email — your password won't change.</p>` +
      `<p>— Eazzio</p>`
  });
}

// Used by routes/staff.js POST / (create staff). The Admin never sees or
// sets the new hire's password — the staff member picks their own via this
// link, which is both more secure and more professional than an Admin
// typing a password and reading it out over the phone.
async function sendStaffInviteEmail({ to, staffName, hotelName, department, staffId, inviteLink, ttlHours }) {
  const deptLabel = { room: 'Room Management', banquet: 'Banquet Management', restaurant: 'Restaurant Management' }[department] || department;
  return send({
    to,
    subject: `You've been added to ${hotelName || 'Eazzio'} — set up your account`,
    text:
      `Hi ${staffName},\n\n` +
      `${hotelName || 'Your hotel'} has added you as staff for ${deptLabel} on Eazzio.\n\n` +
      `Your Staff ID is: ${staffId}\n\n` +
      `Set your own password to activate your account (this link is valid for ${ttlHours} hours):\n\n` +
      `${inviteLink}\n\n` +
      `— Eazzio`,
    html:
      `<p>Hi ${staffName},</p>` +
      `<p>${hotelName || 'Your hotel'} has added you as staff for <b>${deptLabel}</b> on Eazzio.</p>` +
      `<p>Your Staff ID is: <b>${staffId}</b></p>` +
      `<p>Set your own password to activate your account (this link is valid for <b>${ttlHours} hours</b>):</p>` +
      button(inviteLink, 'Set your password') +
      plainLinkNote(inviteLink) +
      `<p>— Eazzio</p>`
  });
}

// Used by the daily renewal-reminder check (see routes/subscription.js
// POST /internal/send-renewal-reminders). A failure here just means this
// admin won't get today's reminder — the caller logs it and moves on to
// the next admin rather than treating it as fatal.
async function sendRenewalReminderEmail({ to, firstName, planLabel, expiryDateLabel, daysLeft, renewLink }) {
  const greetingName = firstName || 'there';
  return send({
    to,
    subject: `Your Eazzio plan expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    text:
      `Hi ${greetingName},\n\n` +
      `Your ${planLabel} plan on Eazzio expires on ${expiryDateLabel} (${daysLeft} day${daysLeft === 1 ? '' : 's'} from now).\n\n` +
      `Renew from your dashboard so your team doesn't lose access:\n\n` +
      `${renewLink}\n\n` +
      `— Eazzio`,
    html:
      `<p>Hi ${greetingName},</p>` +
      `<p>Your <b>${planLabel}</b> plan on Eazzio expires on <b>${expiryDateLabel}</b> (${daysLeft} day${daysLeft === 1 ? '' : 's'} from now).</p>` +
      `<p>Renew from your dashboard so your team doesn't lose access:</p>` +
      button(renewLink, 'Renew my plan') +
      plainLinkNote(renewLink) +
      `<p>— Eazzio</p>`
  });
}

module.exports = { sendPasswordResetEmail, sendStaffInviteEmail, sendRenewalReminderEmail };
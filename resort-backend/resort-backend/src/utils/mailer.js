// Thin wrapper around nodemailer for the one transactional email this app
// sends: the admin password-reset link. Mirrors the same "gracefully explain
// what's missing" pattern used for GEMINI_API_KEY in routes/ai.js — if the
// SMTP env vars aren't set, we say so clearly in the server log rather than
// crashing or silently failing.
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

// Returns { ok: true } or { ok: false, error }. Never throws — callers
// (routes/auth.js) treat every outcome the same way from the requester's
// point of view, so a mail failure can't be used to guess account existence.
async function sendPasswordResetEmail({ to, firstName, resetLink, ttlMinutes }) {
  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, error: 'SMTP_HOST / SMTP_USER / SMTP_PASS are not set in .env — see .env.example.' };
  }
  const greetingName = firstName || 'there';
  const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await transporter.sendMail({
      from: `"Eazzio Hotel Management System" <${fromAddress}>`,
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
        `<p><a href="${resetLink}" style="background:#0f9d76;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;">Reset your password</a></p>` +
        `<p style="color:#666;font-size:12px;">Or paste this link into your browser:<br>${resetLink}</p>` +
        `<p>If you didn't request this, you can safely ignore this email — your password won't change.</p>` +
        `<p>— Eazzio</p>`
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { sendPasswordResetEmail };
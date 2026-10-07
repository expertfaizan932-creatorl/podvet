// Outbound transactional email.
//
// Everything is driven from the environment so the provider can be swapped
// without a code change -- Gmail during development, and a transactional
// provider (Brevo / Resend / SES) in production once volume justifies it.
// SMTP_HOST/PORT/USER/PASS are the only provider-specific values needed.
//
// Note on ports: the VPS blocks outbound 465, so this is written around
// STARTTLS on 587. If SMTP_SECURE is set the port is used with implicit TLS
// instead, which is what most other providers expect on 465.
const nodemailer = require('nodemailer');

let transporter = null;
let transporterFrom = null;

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  // Rebuilt when the env changes so a config reload picks up new credentials
  // without needing a process restart.
  const from = `${process.env.SMTP_USER}`;
  if (transporter && transporterFrom === from) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Some providers advertise STARTTLS but on a certificate nodemailer will
    // not otherwise accept. Enabling this keeps a self-signed / mis-chained
    // cert from silently failing every send.
    tls: { rejectUnauthorized: String(process.env.SMTP_ALLOW_SELF_SIGNED || '').toLowerCase() === 'true' },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  transporterFrom = from;
  return transporter;
}

async function sendMail({ to, subject, html, text }) {
  if (!smtpConfigured()) {
    // Loud on purpose: silently dropping a password-reset code would leave the
    // user staring at "code sent" with nothing arriving and no clue why.
    throw new Error('SMTP is not configured (SMTP_HOST / SMTP_USER / SMTP_PASS missing)');
  }
  return getTransporter().sendMail({
    from: process.env.SMTP_FROM || `"${process.env.SMTP_FROM_NAME || 'PodVet'}" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text: text || String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  });
}

module.exports = { sendMail, smtpConfigured };
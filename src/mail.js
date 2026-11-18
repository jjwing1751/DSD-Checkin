const nodemailer = require('nodemailer');

let transport = null;
if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

const enabled = () => Boolean(transport);

async function send({ to, subject, text }) {
  if (!transport) {
    console.log(`[mail disabled] to=${to} subject="${subject}"\n${text}`);
    return false;
  }
  await transport.sendMail({ from: process.env.MAIL_FROM || 'DSD Check-in <no-reply@example.com>', to, subject, text });
  return true;
}

module.exports = { send, enabled };

// lib/email.ts
import nodemailer from 'nodemailer';

type SendParams = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  fromOverride?: string;
};

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const PLANNING_FROM_EMAIL =
  process.env.PLANNING_FROM_EMAIL ||
  process.env.SMTP_FROM ||
  'MMG <no-reply@example.com>';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

async function sendWithResend(p: SendParams) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: p.fromOverride || PLANNING_FROM_EMAIL,
      to: p.to,
      subject: p.subject,
      html: p.html,
      text: p.text,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Resend error: ${res.status} ${t}`);
  }
}

async function sendWithSMTP(p: SendParams) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // 465 = SSL, sinon STARTTLS
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });

  await transporter.sendMail({
    from: p.fromOverride || PLANNING_FROM_EMAIL,
    to: p.to,
    subject: p.subject,
    html: p.html,
    text: p.text,
  });
}

export async function sendEmail(p: SendParams) {
  if (RESEND_API_KEY) return sendWithResend(p);
  if (SMTP_HOST) return sendWithSMTP(p);
  throw new Error('No email provider configured (RESEND_API_KEY or SMTP_* env vars missing).');
}

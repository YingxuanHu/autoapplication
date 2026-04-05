import nodemailer from "nodemailer";

type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT ?? "587");
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpFrom = process.env.SMTP_FROM;

function getTransporter() {
  if (!smtpHost || !smtpUser || !smtpPass || !smtpFrom || Number.isNaN(smtpPort)) {
    return null;
  }

  return nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });
}

export async function sendEmail(input: SendEmailInput) {
  const transporter = getTransporter();

  if (!transporter || !smtpFrom) {
    console.log(`[email] SMTP not configured. Email to ${input.to} was not sent.`);
    console.log(`[email] Subject: ${input.subject}`);
    console.log(`[email] Text: ${input.text}`);
    return false;
  }

  await transporter.sendMail({
    from: smtpFrom,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });

  return true;
}

require('dotenv').config();
const nodemailer = require('nodemailer');

async function sendSimpleTest() {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const result = await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.SMTP_USER,
    subject: 'TEST EMAIL - Check Your Gmail',
    text: 'This is a simple test email. If you see this, SMTP is working!',
    html: '<h2>✅ TEST EMAIL</h2><p>This is a simple test email. If you see this, SMTP is working!</p>',
  });

  console.log('✅ Simple test email sent!');
  console.log('Message ID:', result.messageId);
  console.log('Check your Gmail for: TEST EMAIL - Check Your Gmail');
}

sendSimpleTest().catch(console.error);

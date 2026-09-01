const https = require("https");
const nodemailer = require("nodemailer");
const logger = require("./logger").create("mailer");

// Render/production always uses Resend. Local development always uses SMTP.
// Render sets RENDER="true" automatically, so a stale custom provider setting
// cannot accidentally make the deployed service connect to Gmail SMTP.
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_API_URL = "https://api.resend.com/emails";
const IS_RENDER =
  process.env.RENDER === "true" ||
  Boolean(process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_HOSTNAME);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const MAIL_PROVIDER = IS_RENDER || IS_PRODUCTION ? "resend" : "smtp";
const FROM_EMAIL = process.env.FROM_EMAIL || "";
const FROM_NAME = process.env.FROM_NAME || "CALIDRO RACS";

console.log(
  `[MAILER] Provider selected: ${MAIL_PROVIDER} (${IS_RENDER ? "Render" : IS_PRODUCTION ? "production" : "local development"})`,
);

// Nodemailer SMTP transport (used for localhost/development by default).
let _smtpTransport = null;
function getSmtpTransport() {
  if (_smtpTransport) return _smtpTransport;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    logger.warn("SMTP credentials not configured; no email transport available.");
    return null;
  }
  _smtpTransport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  console.log(`[MAILER] Nodemailer SMTP transport created (${host}:${port})`);
  return _smtpTransport;
}

function sendMail({ to, subject, html, text }) {
  console.log("[MAILER] Sending email to:", to, "subject:", subject);

  if (MAIL_PROVIDER === "resend") {
    if (!RESEND_API_KEY) {
      const error = new Error("Resend is selected but RESEND_API_KEY is not configured.");
      logger.error(error.message);
      return Promise.reject(error);
    }
    if (!FROM_EMAIL) {
      const error = new Error("Resend is selected but FROM_EMAIL is not configured.");
      logger.error(error.message);
      return Promise.reject(error);
    }
    return sendViaResend({ to, subject, html, text });
  }

  // SMTP/Nodemailer is used only for local development.
  const transport = getSmtpTransport();
  if (!transport) {
    console.log("[MAILER] No email transport available - email not sent");
    logger.warn("No email transport available; emails will not be sent.");
    return Promise.resolve(false);
  }
  return transport
    .sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to,
      subject,
      html,
      text: text || "",
    })
    .then((info) => {
      console.log("[MAILER] (SMTP) Email sent successfully:", info.messageId);
      return { messageId: info.messageId };
    })
    .catch((err) => {
      console.log("[MAILER] (SMTP) Send failed:", err.message);
      logger.warn("SMTP send failed %s", err.message);
      throw err;
    });
}

function sendViaResend({ to, subject, html, text }) {
  const payload = JSON.stringify({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text: text || "",
  });

  console.log("[MAILER] (Resend) Sending from:", FROM_EMAIL, "to:", to);

  return new Promise((resolve, reject) => {
    const url = new URL(RESEND_API_URL);
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 15000,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body || "{}");
        } catch (_) {
          parsed = {};
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const messageId = parsed.id || `resend-${res.statusCode}`;
          console.log("[MAILER] (Resend) Email accepted:", messageId);
          resolve({ messageId, provider: "resend" });
        } else {
          const detail = parsed.message || parsed.error || body || "Unknown error";
          const errMsg = `Resend API ${res.statusCode}: ${detail}`;
          console.log("[MAILER] (Resend) Send failed:", errMsg);
          logger.warn("Resend send failed %s", errMsg);
          reject(new Error(errMsg));
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      const err = new Error("Resend API request timed out");
      console.log("[MAILER] (Resend) Timeout:", err.message);
      reject(err);
    });

    req.on("error", (err) => {
      console.log("[MAILER] (Resend) Request error:", err.message);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

// ─── Booking Confirmation Email (to customer) ───────────────────────────────
async function sendBookingConfirmationEmail({
  to,
  customerName,
  bookingReference,
  serviceName,
  dateLabel,
  timeLabel,
  totalLabel,
  paymentMethod,
  estimatedFee,
  locationAddress,
  issueDescription,
  travelMins,
  serviceDuration,
  isConfirmed = false, // when true, this is the follow‑up confirmation email
}) {
  const subject = isConfirmed
    ? `Booking Confirmed – ${bookingReference} | CALIDRO RACS`
    : `Booking Request Received – ${bookingReference} | CALIDRO RACS`;
  const feeDisplay = estimatedFee
    ? `₱${Number(estimatedFee).toFixed(2)}`
    : "To be confirmed";
  const payLabel = paymentMethod === "gcash" ? "GCash" : "Cash on Delivery";
  const durationHr =
    serviceDuration >= 60
      ? `${Math.floor(serviceDuration / 60)}h${serviceDuration % 60 ? ` ${serviceDuration % 60}m` : ""}`
      : `${serviceDuration}m`;
  const travelLine =
    travelMins > 0
      ? `
      <tr><td style="padding:6px 0;color:#6c757d;">Travel time</td><td style="padding:6px 0;font-weight:600;">${travelMins} min</td></tr>`
      : "";
  const issueLine = issueDescription
    ? `
      <tr><td style="padding:6px 0;color:#6c757d;">Issue described</td><td style="padding:6px 0;">${issueDescription}</td></tr>`
    : "";
  // dynamic header/body for pending vs confirmed
  const headerSub = isConfirmed
    ? "Booking Confirmed"
    : "Booking Request Received";
  const bodyIntro = isConfirmed
    ? `Thank you for booking with CALIDRO RACS! Your request has been <strong>confirmed</strong>. We look forward to servicing you.`
    : `Thank you for booking with CALIDRO RACS! Your request has been submitted and is currently <strong>pending confirmation</strong> by our team. You will receive another notification once it is confirmed.`;
  const statusPill = isConfirmed
    ? `<span class="status-pill" style="background:#ecfdf3;color:#047857;border:1px solid #86efac;">✅ CONFIRMED</span>`
    : `<span class="status-pill">⏳ PENDING CONFIRMATION</span>`;
  const html = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;}
.wrap{max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);}
.header{background:linear-gradient(135deg,#0d6efd,#0a58ca);padding:36px 32px;text-align:center;color:#fff;}
.header h1{margin:0;font-size:22px;letter-spacing:.5px;}
.ref-badge{display:inline-block;margin-top:12px;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.4);color:#fff;font-size:18px;font-weight:700;letter-spacing:2px;padding:8px 20px;border-radius:8px;}
.body{padding:32px;}
.status-pill{display:inline-block;background:#fff8e1;border:1px solid #ffd54f;color:#e65100;font-size:12px;font-weight:700;padding:4px 14px;border-radius:20px;margin-bottom:20px;}
 table{width:100%;border-collapse:collapse;}
td{vertical-align:top;font-size:14px;}
.section-title{font-size:13px;font-weight:700;color:#0d6efd;text-transform:uppercase;letter-spacing:.8px;margin:24px 0 10px;border-bottom:2px solid #e9ecef;padding-bottom:6px;}
.footer{background:#f8f9fa;padding:20px 32px;text-align:center;font-size:12px;color:#6c757d;}
.btn{display:inline-block;margin-top:20px;padding:12px 28px;background:#0d6efd;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;}
</style></head><body>
<div class="wrap">
  <div class="header">
    <h1>🔧 CALIDRO RACS</h1>
    <p style="margin:8px 0 4px;opacity:.85;">${headerSub}</p>
    <div class="ref-badge">${bookingReference}</div>
  </div>
  <div class="body">
    <p>Hi <strong>${customerName}</strong>,</p>
    <p>${bodyIntro}</p>
    ${statusPill}

    <div class="section-title">Booking Details</div>
    <table>
      <tr><td style="padding:6px 0;color:#6c757d;">Reference</td><td style="padding:6px 0;font-weight:700;color:#0d6efd;">${bookingReference}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Service</td><td style="padding:6px 0;font-weight:600;">${serviceName}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Date</td><td style="padding:6px 0;">${dateLabel}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Arrival window</td><td style="padding:6px 0;">${timeLabel}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Service duration</td><td style="padding:6px 0;">${durationHr}</td></tr>
      ${travelLine}
      <tr><td style="padding:6px 0;color:#6c757d;">Full block</td><td style="padding:6px 0;">${totalLabel}</td></tr>
      ${locationAddress ? `<tr><td style="padding:6px 0;color:#6c757d;">Location</td><td style="padding:6px 0;">${locationAddress}</td></tr>` : ""}
      ${issueLine}
    </table>

    <div class="section-title">Payment</div>
    <table>
      <tr><td style="padding:6px 0;color:#6c757d;">Method</td><td style="padding:6px 0;">${payLabel}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Estimated Fee</td><td style="padding:6px 0;font-weight:700;color:#198754;">${feeDisplay}</td></tr>
    </table>

    <p style="margin-top:24px;font-size:13px;color:#6c757d;">If you need to cancel or reschedule, please contact us at least 24 hours before your appointment.</p>
    <a href="/book-history" class="btn">View My Bookings</a>
  </div>
  <div class="footer">CALIDRO Refrigeration &amp; Air-Conditioning Services · Philippines<br>This is an automated message — please do not reply directly.</div>
</div>
</body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Technician arrival notification email ────────────────────────────────
async function sendTechArrivalNotificationEmail({
  to,
  customerName,
  bookingReference,
  techName,
  estimatedArrival,
}) {
  if (!to) return false;
  const subject = `Technician is nearby – ${bookingReference} | CALIDRO RACS`;
  const html = `
<p>Hi <strong>${customerName || 'Customer'}</strong>,</p>
<p>Your technician (${techName || 'technician'}) is now close to your location${
    estimatedArrival
      ? ` and is expected to arrive around ${estimatedArrival}`
      : ''
  }.</p>
<p>Please be ready to receive them. Thank you for choosing CALIDRO RACS!</p>
<p style="font-size:12px;color:#6c757d;">This is an automated notification. Do not reply to this message.</p>
`;
  return sendMail({ to, subject, html });
}

// ─── Walk-in Success + Account Credentials Email ───────────────────────────
async function sendWalkInCredentialsEmail({
  to,
  customerName,
  email,
  generatedPassword,
  resetLink, // optional password reset link
  bookingReference,
  serviceName,
  date,
  startTime,
}) {
  console.log("[WALK-IN EMAIL] Sending to:", to, "customerName:", customerName);
  
  if (!to) {
    console.log("[WALK-IN EMAIL] No recipient address provided");
    return false;
  }

  const safeName = String(customerName || "Customer").trim() || "Customer";
  const safeEmail = String(email || "").trim();
  const safeRef = String(bookingReference || "").trim() || "N/A";
  const safeService = String(serviceName || "Service").trim() || "Service";
  const safeDate = String(date || "").trim() || "N/A";
  const safeTime = String(startTime || "").trim() || "N/A";

  const subject = `Walk-in Appointment Confirmed – ${safeRef} | CALIDRO RACS`;
  const credentialRows = generatedPassword
    ? `
      <tr><td style="padding:6px 0;color:#6c757d;">Gmail</td><td style="padding:6px 0;font-weight:600;">${safeEmail}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Temporary Password</td><td style="padding:6px 0;font-weight:700;color:#b91c1c;">${generatedPassword}</td></tr>`
    : "";
  const linkRow = resetLink
    ? `<tr><td style="padding:6px 0;color:#6c757d;">Set Password</td><td style="padding:6px 0;"><a href="${resetLink}" target="_blank">Create/Change password</a></td></tr>`
    : "";
  const accountSection = generatedPassword
    ? `
    <div class="section-title">Account Access</div>
    <table>
      ${credentialRows}
      ${linkRow}
    </table>
    <p style="margin-top:14px;font-size:13px;color:#b91c1c;"><strong>Important:</strong> Please log in and change your password immediately (or use the link above).</p>`
    : "";

  const html = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;}
.wrap{max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);}
.header{background:linear-gradient(135deg,#0d6efd,#0a58ca);padding:36px 32px;text-align:center;color:#fff;}
.header h1{margin:0;font-size:22px;letter-spacing:.5px;}
.ref-badge{display:inline-block;margin-top:12px;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.4);color:#fff;font-size:18px;font-weight:700;letter-spacing:2px;padding:8px 20px;border-radius:8px;}
.body{padding:32px;}
table{width:100%;border-collapse:collapse;}
td{vertical-align:top;font-size:14px;}
.section-title{font-size:13px;font-weight:700;color:#0d6efd;text-transform:uppercase;letter-spacing:.8px;margin:24px 0 10px;border-bottom:2px solid #e9ecef;padding-bottom:6px;}
.status-pill{display:inline-block;background:#ecfdf3;border:1px solid #86efac;color:#047857;font-size:12px;font-weight:700;padding:4px 14px;border-radius:20px;margin-bottom:20px;}
.footer{background:#f8f9fa;padding:20px 32px;text-align:center;font-size:12px;color:#6c757d;}
</style></head><body>
<div class="wrap">
  <div class="header">
    <h1>🔧 CALIDRO RACS</h1>
    <p style="margin:8px 0 4px;opacity:.85;">Walk-in Appointment Confirmed</p>
    <div class="ref-badge">${safeRef}</div>
  </div>
  <div class="body">
    <p>Hi <strong>${safeName}</strong>,</p>
    <p>Your walk-in appointment has been successfully recorded. Our team will proceed based on your selected schedule.</p>
    <span class="status-pill">✅ CONFIRMED</span>

    <div class="section-title">Booking Details</div>
    <table>
      <tr><td style="padding:6px 0;color:#6c757d;">Reference</td><td style="padding:6px 0;font-weight:700;color:#0d6efd;">${safeRef}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Service</td><td style="padding:6px 0;font-weight:600;">${safeService}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Date</td><td style="padding:6px 0;">${safeDate}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Time</td><td style="padding:6px 0;">${safeTime}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Email</td><td style="padding:6px 0;">${safeEmail || "N/A"}</td></tr>
    </table>

    ${accountSection}
  </div>
  <div class="footer">CALIDRO Refrigeration &amp; Air-Conditioning Services · Philippines<br>This is an automated message — please do not reply directly.</div>
</div>
</body></html>`;

  let text =
    `Hi ${safeName},\n\n` +
    `Your walk-in appointment has been successfully recorded.\n` +
    `Booking Reference: ${safeRef}\n` +
    `Service: ${safeService}\n` +
    `Date: ${safeDate}\n` +
    `Time: ${safeTime}\n` +
    `Email: ${safeEmail || "N/A"}\n`;
  if (generatedPassword) {
    text += `\nYour customer account credentials:\nGmail: ${safeEmail}\nTemporary Password: ${generatedPassword}\n`;
    if (resetLink) {
      text += `\nYou can set or change your password using the following secure link (expires shortly):\n${resetLink}\n`;
    }
    text += `\nPlease log in and change your password immediately.`;
  }

  return sendMail({ to, subject, html, text });
}

// ─── Technician New-Job Notification Email ───────────────────────────────────
async function sendTechnicianNotificationEmail({
  to,
  technicianName,
  customerName,
  bookingReference,
  serviceName,
  dateLabel,
  timeLabel,
  totalLabel,
  locationAddress,
  issueDescription,
}) {
  const subject = `New Booking Assigned – ${bookingReference} | CALIDRO RACS`;
  const issueLine = issueDescription
    ? `
      <tr><td style="padding:6px 0;color:#6c757d;">Issue</td><td style="padding:6px 0;">${issueDescription}</td></tr>`
    : "";
  const html = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif;}
.wrap{max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);}
.header{background:linear-gradient(135deg,#198754,#0f5132);padding:36px 32px;text-align:center;color:#fff;}
.header h1{margin:0;font-size:22px;}
.ref-badge{display:inline-block;margin-top:12px;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.4);color:#fff;font-size:16px;font-weight:700;letter-spacing:2px;padding:6px 18px;border-radius:8px;}
.body{padding:32px;}table{width:100%;border-collapse:collapse;}td{vertical-align:top;font-size:14px;}
.section-title{font-size:13px;font-weight:700;color:#198754;text-transform:uppercase;letter-spacing:.8px;margin:24px 0 10px;border-bottom:2px solid #e9ecef;padding-bottom:6px;}
.footer{background:#f8f9fa;padding:20px 32px;text-align:center;font-size:12px;color:#6c757d;}
.btn{display:inline-block;margin-top:20px;padding:12px 28px;background:#198754;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;}
</style></head><body>
<div class="wrap">
  <div class="header">
    <h1>🔧 New Job Assigned</h1>
    <div class="ref-badge">${bookingReference}</div>
  </div>
  <div class="body">
    <p>Hi <strong>${technicianName}</strong>,</p>
    <p>A new booking has been submitted and assigned to you. Please review the details below and prepare accordingly.</p>

    <div class="section-title">Job Details</div>
    <table>
      <tr><td style="padding:6px 0;color:#6c757d;">Reference</td><td style="padding:6px 0;font-weight:700;color:#198754;">${bookingReference}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Customer</td><td style="padding:6px 0;font-weight:600;">${customerName}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Service</td><td style="padding:6px 0;">${serviceName}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Date</td><td style="padding:6px 0;">${dateLabel}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Arrival window</td><td style="padding:6px 0;">${timeLabel}</td></tr>
      <tr><td style="padding:6px 0;color:#6c757d;">Full block (incl. travel)</td><td style="padding:6px 0;">${totalLabel}</td></tr>
      ${locationAddress ? `<tr><td style="padding:6px 0;color:#6c757d;">Customer location</td><td style="padding:6px 0;">${locationAddress}</td></tr>` : ""}
      ${issueLine}
    </table>

    <p style="margin-top:24px;font-size:13px;color:#6c757d;">Log in to the CALIDRO portal to confirm or update this booking.</p>
    <a href="/technician/appointments" class="btn">Open My Schedule</a>
  </div>
  <div class="footer">CALIDRO Refrigeration &amp; Air-Conditioning Services · Auto-notification</div>
</div>
</body></html>`;
  return sendMail({ to, subject, html });
}

async function sendResetEmail(to, resetLink) {
  const subject = "Password reset for CALIDRO RACS";
  // load expiration from env or default to 5 minutes for display
  const expiryMinutes = Number(process.env.RESET_PASSWORD_TOKEN_EXPIRES_MS)
    ? Math.round(Number(process.env.RESET_PASSWORD_TOKEN_EXPIRES_MS) / 60000)
    : 5;
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Password reset</title>
      <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600&display=swap" rel="stylesheet">
      <style>
        body { margin:0; padding:0; background:#f2f4f6; font-family:'Montserrat',Arial,Helvetica,sans-serif; }
        .container { width:100%; padding:40px 0; }
        .card { max-width:580px; margin:0 auto; background:#ffffff; border:1px solid #e0e0e0; border-radius:8px; overflow:hidden; }
        .header { background:#0d6efd; padding:20px; text-align:center; }
        .header img { max-width:120px; }
        .content { padding:32px 40px; }
        h1 { font-size:24px; color:#333333; margin-top:0; }
        p { font-size:16px; color:#51545e; line-height:1.625; margin:16px 0; }
        .btn { display:inline-block; background:#0d6efd; color:#ffffff; padding:12px 24px; border-radius:6px; text-decoration:none; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }
        .footer { padding:20px 40px; font-size:12px; color:#a8aaaf; text-align:center; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="card">
          <div class="header" style="color:#ffffff; font-size:24px; font-weight:700;">
            CALIDRO RACS
          </div>
          <div class="content">
            <h1>Password Reset Request</h1>
            <p>Hello,</p>
            <p>We received a request to reset your CALIDRO RACS account password. Click the button below to proceed. This link will expire in <strong>${expiryMinutes} minutes</strong>.</p>
            <p style="text-align:center; margin:32px 0;"><a href="${resetLink}" class="btn" style="background:#0d6efd; color:#ffffff !important; text-decoration:none;">Reset Password</a></p>
            <p>If you did not make this request, you can safely ignore this message. Your password will remain unchanged.</p>
            <p>Best regards,<br>CALIDRO RACS Team</p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} CALIDRO RACS. All rights reserved.
          </div>
        </div>
      </div>
    </body>
    </html>
  `;
  const text = `Reset your password: ${resetLink} (expires in ${expiryMinutes} minutes)`;
  return sendMail({ to, subject, html, text });
}


// ─── Shared Premium Email Styles ────────────────────────────────────────────
function premiumStyles(accentColor = '#3b82f6', accentDark = '#1d4ed8') {
  return `
<style>
body{margin:0;padding:0;background-color:#f8fafc;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;}
.wrap{max-width:600px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 25px -5px rgba(0,0,0,0.06);border:1px solid #f1f5f9;}
.header{background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);padding:40px 32px;text-align:center;color:#ffffff;position:relative;}
.header::after{content:'';position:absolute;bottom:0;left:0;right:0;height:4px;background:linear-gradient(90deg,${accentColor},${accentDark});}
.header h1{margin:0;font-size:22px;font-weight:600;letter-spacing:0.3px;}
.ref-badge{display:inline-block;margin-top:14px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#ffffff;font-size:14px;font-weight:600;letter-spacing:1.5px;padding:7px 22px;border-radius:24px;}
.body{padding:36px 32px;}
.status-pill{display:inline-flex;align-items:center;font-size:12px;font-weight:600;padding:5px 15px;border-radius:20px;margin-bottom:22px;text-transform:uppercase;letter-spacing:0.5px;}
table{width:100%;border-collapse:collapse;}td{vertical-align:middle;font-size:14px;color:#334155;}
.section-title{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:1.2px;margin:28px 0 10px;border-bottom:1px solid #f1f5f9;padding-bottom:7px;}
.detail-row td:first-child{color:#64748b;width:38%;padding:8px 0;}
.detail-row td:last-child{font-weight:500;color:#1e293b;padding:8px 0;}
.footer{background:#f8fafc;padding:22px 32px;text-align:center;font-size:13px;color:#94a3b8;border-top:1px solid #f1f5f9;}
.btn{display:inline-block;margin-top:22px;padding:13px 30px;background:${accentColor};color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;}
.info-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;margin:20px 0;}
.note-box{border-left:4px solid #eab308;background:#fefce8;padding:14px 16px;border-radius:0 8px 8px 0;font-size:13px;color:#854d0e;margin:16px 0;}
.total-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:18px 20px;margin-top:20px;}
.thank-box{background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1px solid #bbf7d0;border-radius:12px;padding:22px;margin:24px 0;text-align:center;}
</style>`;
}

function premiumFooter() {
  return `<div class="footer"><strong style="color:#64748b;">CALIDRO Refrigeration &amp; Air-Conditioning Services</strong><br><span style="display:inline-block;margin-top:6px;">Philippines · This is an automated message — please do not reply directly.</span></div>`;
}

// ─── sendEmail (simple helper) ───────────────────────────────────────────────
async function sendEmail(to, subject, body) {
  const text = body == null ? "" : String(body);
  const html = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => `<p>${l}</p>`).join("");
  return sendMail({ to, subject, text, html });
}

// ─── Repair Request Submitted (Enterprise / Scheduled booking) ───────────────
async function sendRepairRequestSubmittedEmail({
  to, customerName, workOrderNumber, unitType, brand, model,
  problemDescription, preferredDateLabel, preferredTime, locationAddress,
  paymentMethod,
}) {
  if (!to) return false;
  const safeWorkOrder = String(workOrderNumber || '').trim() || 'N/A';
  const safeName = String(customerName || 'Customer').trim();
  const safeUnit = [brand, model, unitType].filter(Boolean).join(' ') || 'N/A';
  const payLabel = paymentMethod === 'gcash' ? 'GCash' : paymentMethod === 'cash' ? 'Cash on Delivery' : paymentMethod || 'N/A';
  const issueRow = problemDescription ? `<tr class="detail-row"><td>Issue</td><td>${problemDescription}</td></tr>` : '';
  const scheduleRows = preferredDateLabel ? `<tr class="detail-row"><td>Preferred Date</td><td>${preferredDateLabel}</td></tr>
      ${preferredTime ? `<tr class="detail-row"><td>Preferred Time</td><td>${preferredTime}</td></tr>` : ''}` : '';

  const subject = `Repair Request Received – ${safeWorkOrder} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#3b82f6','#1d4ed8')}</head><body>
<div class="wrap">
  <div class="header"><h1>Repair Request Received</h1><div class="ref-badge">${safeWorkOrder}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${safeName}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Your repair request has been successfully submitted. Our team will review it and contact you to confirm the inspection schedule.</p>
    <div class="status-pill" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;">⏳ Pending Review</div>
    <div class="section-title">Repair Details</div>
    <table><tr class="detail-row"><td>Work Order</td><td style="font-weight:700;">${safeWorkOrder}</td></tr>
      <tr class="detail-row"><td>Unit</td><td>${safeUnit}</td></tr>
      ${issueRow}${scheduleRows}
      ${locationAddress ? `<tr class="detail-row"><td>Location</td><td>${locationAddress}</td></tr>` : ''}
      <tr class="detail-row"><td>Payment</td><td>${payLabel}</td></tr>
    </table>
    <div class="info-box" style="margin-top:24px;"><p style="margin:0;font-size:13px;color:#475569;">Please keep your work order number for tracking. Our team will contact you to confirm the schedule.</p></div>
    <a href="${process.env.APP_BASE_URL || ''}/book-history" class="btn">Track My Booking</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Booking Accepted Email ───────────────────────────────────────────────────
async function sendBookingAcceptedEmail({ to, customerName, bookingReference, serviceName, dateLabel, timeLabel, technicianName }) {
  if (!to) return false;
  const subject = `Booking Accepted – ${bookingReference} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#10b981','#047857')}</head><body>
<div class="wrap">
  <div class="header"><h1>Booking Accepted</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Great news! Your booking has been accepted and a technician has been assigned to your service.</p>
    <div class="status-pill" style="background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;">✅ Booking Accepted</div>
    <div class="section-title">Booking Details</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;color:#10b981;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
      <tr class="detail-row"><td>Date</td><td>${dateLabel || 'N/A'}</td></tr>
      <tr class="detail-row"><td>Arrival Window</td><td>${timeLabel || 'N/A'}</td></tr>
      ${technicianName ? `<tr class="detail-row"><td>Technician</td><td>${technicianName}</td></tr>` : ''}
    </table>
    <a href="${process.env.APP_BASE_URL || ''}/book-history" class="btn" style="background:#10b981;">View Booking</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Booking Expired Email ────────────────────────────────────────────────────
async function sendBookingExpiredEmail({ to, customerName, bookingReference, serviceName }) {
  if (!to) return false;
  const subject = `Booking Expired – ${bookingReference} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#f59e0b','#d97706')}</head><body>
<div class="wrap">
  <div class="header"><h1>Booking Expired</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Unfortunately, your booking request has expired as no technician was available to accept it in time.</p>
    <div class="status-pill" style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;">⏰ Booking Expired</div>
    <div class="section-title">Booking Details</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
    </table>
    <div class="note-box" style="margin-top:20px;"><strong>What next?</strong> Please book again and we will do our best to assign a technician quickly.</div>
    <a href="${process.env.APP_BASE_URL || ''}/book" class="btn" style="background:#f59e0b;">Book Again</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Technician Declined Email ────────────────────────────────────────────────
async function sendTechnicianDeclinedEmail({ to, customerName, bookingReference, serviceName, reason }) {
  if (!to) return false;
  const subject = `Booking Update – ${bookingReference} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#f59e0b','#d97706')}</head><body>
<div class="wrap">
  <div class="header"><h1>Booking Reassignment in Progress</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Your assigned technician was unable to accept your booking. We are reassigning another technician and will notify you shortly.</p>
    <div class="status-pill" style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;">🔄 Reassigning Technician</div>
    <div class="section-title">Booking Details</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
    </table>
    ${reason ? `<div class="note-box"><strong>Reason:</strong> ${reason}</div>` : ''}
    <p style="color:#475569;font-size:13px;line-height:1.6;margin-top:20px;">We apologize for any inconvenience. A new technician will be assigned as soon as possible.</p>
    <a href="${process.env.APP_BASE_URL || ''}/book-history" class="btn" style="background:#f59e0b;">View Booking</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Technician Arrived Email ─────────────────────────────────────────────────
async function sendTechnicianArrivedEmail({ to, customerName, bookingReference, serviceName, technicianName }) {
  if (!to) return false;
  const subject = `Technician Has Arrived – ${bookingReference} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#3b82f6','#1d4ed8')}</head><body>
<div class="wrap">
  <div class="header"><h1>Technician Has Arrived</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Your technician <strong>${technicianName || 'our technician'}</strong> has arrived at your location and is ready to begin the service.</p>
    <div class="status-pill" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;">📍 Technician On-Site</div>
    <div class="section-title">Service Details</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;color:#3b82f6;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
      <tr class="detail-row"><td>Technician</td><td>${technicianName || 'N/A'}</td></tr>
    </table>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Work Started Email ───────────────────────────────────────────────────────
async function sendWorkStartedEmail({ to, customerName, bookingReference, serviceName, technicianName, techName, serviceType }) {
  if (!to) return false;
  const isRepair = serviceType === 'repair' || serviceType === 'RepairService';
  const workLabel = isRepair ? 'Repair Work' : 'Service Work';
  const unitLabel = isRepair ? 'on your unit' : 'at your location';
  const tech = technicianName || techName;
  const subject = `${workLabel} Has Started – ${bookingReference} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#8b5cf6','#6d28d9')}</head><body>
<div class="wrap">
  <div class="header"><h1>${workLabel} Has Started</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Our technician has started ${isRepair ? 'the repair work' : 'the service work'} ${unitLabel}. We'll notify you once it's complete.</p>
    <div class="status-pill" style="background:#f5f3ff;color:#5b21b6;border:1px solid #ddd6fe;">🔧 Work In Progress</div>
    <div class="section-title">Service Details</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;color:#8b5cf6;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
      ${tech ? `<tr class="detail-row"><td>Technician</td><td>${tech}</td></tr>` : ''}
    </table>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Booking Completed Email (non-repair) ────────────────────────────────────
async function sendBookingCompletedEmail({ to, customerName, bookingReference, serviceName, technicianName, dateLabel }) {
  if (!to) return false;
  const subject = `Service Completed – ${bookingReference} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#10b981','#047857')}</head><body>
<div class="wrap">
  <div class="header"><h1>Service Completed</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Dear <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Your service has been successfully completed. Thank you for trusting CALIDRO RACS!</p>
    <div class="status-pill" style="background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;">✅ Service Completed</div>
    <div class="section-title">Service Summary</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;color:#10b981;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
      ${technicianName ? `<tr class="detail-row"><td>Technician</td><td>${technicianName}</td></tr>` : ''}
      ${dateLabel ? `<tr class="detail-row"><td>Date</td><td>${dateLabel}</td></tr>` : ''}
    </table>
    <div class="thank-box">
      <div style="font-size:15px;font-weight:700;color:#065f46;margin-bottom:6px;">Thank You for Choosing CALIDRO RACS!</div>
      <p style="font-size:13px;color:#047857;margin:0;line-height:1.5;">We look forward to serving you again. Your satisfaction is our top priority.</p>
    </div>
    <a href="${process.env.APP_BASE_URL || ''}/book-history" class="btn">View My Bookings</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Technician Cancelled Email ───────────────────────────────────────────────
async function sendTechnicianCancelledEmail({ to, customerName, bookingReference, serviceName, reason }) {
  if (!to) return false;
  const subject = `Booking Cancelled – ${bookingReference} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#ef4444','#dc2626')}</head><body>
<div class="wrap">
  <div class="header"><h1>Booking Cancelled</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">We regret to inform you that your booking has been cancelled. We apologize for any inconvenience caused.</p>
    <div class="status-pill" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;">❌ Booking Cancelled</div>
    <div class="section-title">Booking Details</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
    </table>
    ${reason ? `<div class="note-box"><strong>Reason:</strong> ${reason}</div>` : ''}
    <a href="${process.env.APP_BASE_URL || ''}/book" class="btn" style="background:#ef4444;">Book Again</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── No-Show Reschedule Email ─────────────────────────────────────────────────
async function sendNoShowRescheduleEmail({ to, customerName, bookingReference, serviceName, dateLabel, timeLabel, rescheduleUrl }) {
  if (!to) return false;
  const subject = `Rescheduling Required – ${bookingReference} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#f59e0b','#d97706')}</head><body>
<div class="wrap">
  <div class="header"><h1>Rescheduling Required</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">The no-show report has been reviewed. You may now choose a new visit from our live service availability.</p>
    <div class="status-pill" style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;">⚠️ Reschedule Needed</div>
    <div class="section-title">Booking Details</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
      ${dateLabel ? `<tr class="detail-row"><td>Previous Date</td><td>${dateLabel}</td></tr>` : ''}
      ${timeLabel ? `<tr class="detail-row"><td>Previous Time</td><td>${timeLabel}</td></tr>` : ''}
    </table>
    <div class="info-box"><p style="margin:0;font-size:13px;color:#475569;">This secure link is valid for 72 hours. Your selected slot is rechecked before it is confirmed.</p></div>
    <a href="${rescheduleUrl || `${process.env.APP_BASE_URL || ''}/book-history`}" class="btn" style="background:#f59e0b;">Choose New Schedule</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── No-Show Reported Email (awaiting admin review) ───────────────────────────
async function sendNoShowReportedEmail({ to, customerName, bookingReference, serviceName, technicianName, dateLabel, timeLabel, rescheduleUrl }) {
  if (!to) return false;
  const subject = `We Missed You – ${bookingReference} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#dc2626','#991b1b')}</head><body>
<div class="wrap">
  <div class="header"><h1>We Missed You</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Your technician has arrived at the service location, but you were unavailable at the scheduled time.</p>
    <div class="status-pill" style="background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;">🕐 No-Show Reported</div>
    <div class="section-title">Booking Details</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
      <tr class="detail-row"><td>Scheduled Date</td><td>${dateLabel || 'N/A'}</td></tr>
      <tr class="detail-row"><td>Scheduled Time</td><td>${timeLabel || 'N/A'}</td></tr>
    </table>
    <p style="color:#475569;line-height:1.6;">Please contact us to confirm your availability, or reschedule your appointment so we can serve you at a time that works for you.</p>
    ${rescheduleUrl ? `<a href="${rescheduleUrl}" class="btn" style="background:#dc2626;">Request Reschedule</a>` : `<a href="${process.env.APP_BASE_URL || ''}/book-history" class="btn" style="background:#dc2626;">Reschedule</a>`}
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Inspection Completed Email ───────────────────────────────────────────────
async function sendInspectionCompletedEmail({ to, customerName, bookingReference, serviceName, findings, severity }) {
  if (!to) return false;
  const subject = `Inspection Completed – ${bookingReference} | CALIDRO RACS`;
  const sevColor = severity === 'critical' ? '#dc2626' : severity === 'major' ? '#d97706' : '#059669';
  const sevLabel = severity ? severity.charAt(0).toUpperCase() + severity.slice(1) : 'N/A';
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#8b5cf6','#6d28d9')}</head><body>
<div class="wrap">
  <div class="header"><h1>Inspection Completed</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Dear <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Our technician has completed the inspection of your unit. The repair quotation has been prepared and is ready for your review.</p>
    <div class="status-pill" style="background:#f5f3ff;color:#5b21b6;border:1px solid #ddd6fe;">🔍 Inspection Complete</div>
    <div class="section-title">Inspection Summary</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;color:#8b5cf6;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
      ${severity ? `<tr class="detail-row"><td>Severity</td><td><span style="font-weight:700;color:${sevColor};">${sevLabel}</span></td></tr>` : ''}
      ${findings ? `<tr class="detail-row"><td>Findings</td><td style="line-height:1.5;">${findings}</td></tr>` : ''}
    </table>
    <div class="info-box"><p style="margin:0;font-size:13px;color:#475569;">📋 Please check your email for the detailed quotation. You may also view it by logging into your CALIDRO account.</p></div>
    <a href="${process.env.APP_BASE_URL || ''}/book-history" class="btn" style="background:#8b5cf6;">View Booking</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Quotation Ready Email ────────────────────────────────────────────────────
async function sendQuotationReadyEmail({ to, customerName, bookingReference, serviceName, parts, laborCost, totalCost, quotationNotes, deviationNote }) {
  if (!to) return false;
  const subject = `Repair Quotation Ready – ${bookingReference} | CALIDRO RACS`;
  const partsRows = (parts || []).map(p =>
    `<tr><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">${p.name}</td><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:center;">${p.quantity || 1}</td><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:right;">₱${Number(p.cost || 0).toLocaleString()}</td><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600;">₱${Number((p.cost || 0) * (p.quantity || 1)).toLocaleString()}</td></tr>`
  ).join('');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#3b82f6','#1d4ed8')}</head><body>
<div class="wrap">
  <div class="header"><h1>Repair Quotation Ready</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Dear <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Following our inspection, we have prepared a detailed quotation for your repair service. Please review the breakdown below and approve to proceed.</p>
    <div class="status-pill" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;">📋 Quotation Ready for Review</div>
    <div class="section-title">Service Details</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;color:#3b82f6;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
    </table>
    ${partsRows ? `
    <div class="section-title">Parts &amp; Materials</div>
    <table style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <thead><tr style="background:#f8fafc;"><th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;">Item</th><th style="padding:10px 12px;text-align:center;font-size:12px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;">Qty</th><th style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;">Price</th><th style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;">Total</th></tr></thead>
      <tbody>${partsRows}</tbody>
    </table>` : ''}
    <div class="total-box">
      <table>
        <tr><td style="padding:6px 0;color:#64748b;">Labor Cost</td><td style="padding:6px 0;text-align:right;font-weight:500;">₱${Number(laborCost || 0).toLocaleString()}</td></tr>
        ${partsRows ? `<tr><td style="padding:6px 0;color:#64748b;">Parts Subtotal</td><td style="padding:6px 0;text-align:right;font-weight:500;">₱${Number((totalCost || 0) - (laborCost || 0)).toLocaleString()}</td></tr>` : ''}
        <tr><td colspan="2" style="border-top:1px dashed #e2e8f0;padding-top:8px;"></td></tr>
        <tr><td style="padding-top:14px;font-weight:700;color:#0f172a;font-size:16px;">Total Estimated Cost</td><td style="padding-top:14px;text-align:right;font-weight:800;color:#3b82f6;font-size:18px;">₱${Number(totalCost || 0).toLocaleString()}</td></tr>
      </table>
    </div>
    ${quotationNotes ? `<div class="note-box"><strong>Technician Note:</strong><br><span style="display:inline-block;margin-top:4px;">${quotationNotes}</span></div>` : ''}
    ${deviationNote ? `<div class="note-box" style="border-left-color:#ef4444;background:#fef2f2;color:#991b1b;"><strong>Important:</strong><br><span style="display:inline-block;margin-top:4px;">${deviationNote}</span></div>` : ''}
    <div class="info-box" style="background:linear-gradient(to right,#eff6ff,#f5f3ff);border-color:#c7d2fe;text-align:center;margin-top:24px;">
      <p style="margin:0;font-size:14px;color:#1e40af;font-weight:600;">✅ Consent Confirmed</p>
      <p style="margin:8px 0 0;font-size:13px;color:#3b82f6;line-height:1.5;">Your repair has been approved on-site by our technician. We will proceed with the repair as discussed.</p>
    </div>
    <a href="${process.env.APP_BASE_URL || ''}/book-history?highlight=${bookingReference}" class="btn">View Your Booking</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Repair Completed + Invoice Email ────────────────────────────────────────
async function sendRepairCompletedEmail({ to, customerName, bookingReference, serviceName, technicianName, dateLabel, invoice, warranty }) {
  if (!to) return false;
  const subject = `Repair Completed – ${bookingReference} | CALIDRO RACS`;

  const partsRows = (invoice?.parts || []).map(p =>
    `<tr><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;">${p.name}</td><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:center;">${p.quantity}</td><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:right;">₱${Number(p.unitPrice || 0).toLocaleString()}</td><td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600;">₱${Number(p.total || 0).toLocaleString()}</td></tr>`
  ).join('');

  const actionsList = (invoice?.actionsPerformed || []).map(a => `<li style="padding:3px 0;font-size:13px;color:#475569;">${a}</li>`).join('');

  const warrantyBlock = warranty ? `
  <div class="section-title">Warranty Coverage</div>
  <div class="info-box" style="background:linear-gradient(135deg,#eff6ff,#dbeafe);border-color:#93c5fd;">
    <table>
      <tr><td style="padding:4px 0;color:#64748b;font-size:13px;width:40%;">Duration</td><td style="padding:4px 0;font-weight:600;font-size:13px;color:#1e40af;">${warranty.duration || '30 days'}</td></tr>
      <tr><td style="padding:4px 0;color:#64748b;font-size:13px;">Valid Until</td><td style="padding:4px 0;font-weight:600;font-size:13px;color:#1e40af;">${warranty.endDate || 'N/A'}</td></tr>
    </table>
    <p style="margin:10px 0 0;font-size:12px;color:#1e40af;">🛡️ Any issues within the warranty period will be repaired at no additional cost.</p>
  </div>` : '';

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#10b981','#047857')}</head><body>
<div class="wrap">
  <div class="header"><h1>Repair Completed &amp; Invoice</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Dear <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Your repair service has been <strong>successfully completed</strong>. Your unit is now fully operational. Please find the invoice details below.</p>
    <div class="status-pill" style="background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;">✅ Repair Completed</div>
    <div class="section-title">Service Summary</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;color:#10b981;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
      ${technicianName ? `<tr class="detail-row"><td>Technician</td><td>${technicianName}</td></tr>` : ''}
      ${dateLabel ? `<tr class="detail-row"><td>Date Completed</td><td>${dateLabel}</td></tr>` : ''}
    </table>

    ${partsRows ? `
    <div class="section-title">Parts Installed</div>
    <table style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <thead><tr style="background:#f8fafc;"><th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;">Item</th><th style="padding:10px 12px;text-align:center;font-size:12px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;">Qty</th><th style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;">Price</th><th style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:#64748b;border-bottom:1px solid #e2e8f0;">Total</th></tr></thead>
      <tbody>${partsRows}</tbody>
    </table>` : ''}

    ${actionsList ? `
    <div class="section-title">Actions Performed</div>
    <ul style="padding-left:18px;margin:0;">${actionsList}</ul>` : ''}

    <div class="section-title">Invoice Summary</div>
    <div class="total-box">
      <table>
        ${(invoice?.inspectionFee || 0) > 0 ? `<tr><td style="padding:6px 0;color:#64748b;">Inspection Fee</td><td style="padding:6px 0;text-align:right;font-weight:500;">₱${Number(invoice.inspectionFee).toLocaleString()}</td></tr>` : ''}
        ${(invoice?.travelFee || 0) > 0 ? `<tr><td style="padding:6px 0;color:#64748b;">Travel Fee</td><td style="padding:6px 0;text-align:right;font-weight:500;">₱${Number(invoice.travelFee).toLocaleString()}</td></tr>` : ''}
        <tr><td style="padding:6px 0;color:#64748b;">Labor Cost</td><td style="padding:6px 0;text-align:right;font-weight:500;">₱${Number(invoice?.laborCost || 0).toLocaleString()}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;">Parts Total</td><td style="padding:6px 0;text-align:right;font-weight:500;">₱${Number(invoice?.partsTotal || 0).toLocaleString()}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b;font-weight:600;">Total Amount</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#0f172a;">₱${Number(invoice?.grandTotal || invoice?.totalAmount || 0).toLocaleString()}</td></tr>
        ${invoice?.balancePaid ? `<tr><td style="padding:6px 0;color:#64748b;">Balance Paid</td><td style="padding:6px 0;text-align:right;color:#059669;">₱${Number(invoice.balancePaid).toLocaleString()}</td></tr>` : ''}
        ${invoice?.totalPaid ? `<tr><td colspan="2" style="border-top:1px dashed #e2e8f0;padding-top:8px;"></td></tr><tr><td style="padding-top:14px;font-weight:700;color:#047857;font-size:16px;">Total Paid</td><td style="padding-top:14px;text-align:right;font-weight:800;color:#047857;font-size:18px;">₱${Number(invoice.totalPaid).toLocaleString()}</td></tr>` : ''}
      </table>
    </div>

    ${warrantyBlock}

    <div class="thank-box" style="margin-top:24px;">
      <div style="font-size:16px;font-weight:700;color:#065f46;margin-bottom:8px;">🙏 Thank You for Choosing CALIDRO RACS!</div>
      <p style="font-size:13px;color:#047857;margin:0;line-height:1.6;">We sincerely appreciate your trust in our services. Your satisfaction is our top priority.</p>
    </div>

    <div class="section-title">Rate Your Experience</div>
    <p style="color:#475569;font-size:14px;margin-bottom:8px;">Your feedback helps us improve. Please take a moment to rate:</p>
    <div style="font-size:30px;margin:10px 0;">
      <a href="${process.env.APP_BASE_URL || ''}/book-history" style="color:#f59e0b;text-decoration:none;">★</a>
      <a href="${process.env.APP_BASE_URL || ''}/book-history" style="color:#f59e0b;text-decoration:none;">★</a>
      <a href="${process.env.APP_BASE_URL || ''}/book-history" style="color:#f59e0b;text-decoration:none;">★</a>
      <a href="${process.env.APP_BASE_URL || ''}/book-history" style="color:#f59e0b;text-decoration:none;">★</a>
      <a href="${process.env.APP_BASE_URL || ''}/book-history" style="color:#f59e0b;text-decoration:none;">★</a>
    </div>
    <a href="${process.env.APP_BASE_URL || ''}/book-history" class="btn">View My Bookings</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Reschedule Requested (by customer) ──────────────────────────────────────
async function sendRescheduleRequestedEmail({ to, customerName, bookingReference, serviceName, newDateLabel, newTimeLabel, reason }) {
  if (!to) return false;
  const subject = `Reschedule Request Received – ${bookingReference} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#f59e0b','#d97706')}</head><body>
<div class="wrap">
  <div class="header"><h1>Reschedule Request Received</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">We have received your request to reschedule your appointment. Our team will review and confirm the new schedule shortly.</p>
    <div class="status-pill" style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;">🗓️ Reschedule Requested</div>
    <div class="section-title">Reschedule Details</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
      ${newDateLabel ? `<tr class="detail-row"><td>Requested Date</td><td>${newDateLabel}</td></tr>` : ''}
      ${newTimeLabel ? `<tr class="detail-row"><td>Requested Time</td><td>${newTimeLabel}</td></tr>` : ''}
    </table>
    ${reason ? `<div class="note-box"><strong>Reason:</strong> ${reason}</div>` : ''}
    <a href="${process.env.APP_BASE_URL || ''}/book-history" class="btn" style="background:#f59e0b;">View Booking</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Reschedule Approved (by admin/technician) ────────────────────────────────
async function sendRescheduleApprovedEmail({ to, customerName, bookingReference, serviceName, newDateLabel, newTimeLabel }) {
  if (!to) return false;
  const subject = `Reschedule Confirmed – ${bookingReference} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#10b981','#047857')}</head><body>
<div class="wrap">
  <div class="header"><h1>Reschedule Confirmed</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Your reschedule request has been approved. Your appointment is now confirmed for the new date and time.</p>
    <div class="status-pill" style="background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;">✅ Reschedule Confirmed</div>
    <div class="section-title">New Schedule</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;color:#10b981;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
      ${newDateLabel ? `<tr class="detail-row"><td>New Date</td><td style="font-weight:600;">${newDateLabel}</td></tr>` : ''}
      ${newTimeLabel ? `<tr class="detail-row"><td>New Time</td><td>${newTimeLabel}</td></tr>` : ''}
    </table>
    <a href="${process.env.APP_BASE_URL || ''}/book-history" class="btn">View Booking</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// ─── Reschedule Rejected (by admin/technician) ────────────────────────────────
async function sendRescheduleRejectedEmail({ to, customerName, bookingReference, serviceName, reason }) {
  if (!to) return false;
  const subject = `Reschedule Request Declined – ${bookingReference} | CALIDRO RACS`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles('#ef4444','#dc2626')}</head><body>
<div class="wrap">
  <div class="header"><h1>Reschedule Request Declined</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${customerName || 'Customer'}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">Unfortunately, your reschedule request could not be approved. Your original booking schedule remains unchanged.</p>
    <div class="status-pill" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;">❌ Reschedule Declined</div>
    <div class="section-title">Booking Details</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || 'N/A'}</td></tr>
    </table>
    ${reason ? `<div class="note-box"><strong>Reason:</strong> ${reason}</div>` : ''}
    <p style="color:#475569;font-size:13px;line-height:1.6;margin-top:16px;">Please contact us if you need further assistance or want to discuss alternative schedules.</p>
    <a href="${process.env.APP_BASE_URL || ''}/book-history" class="btn" style="background:#ef4444;">View Booking</a>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

/**
 * Send a reschedule link to the customer so they can pick a new date/time.
 */
async function sendRescheduleLinkEmail({ to, customerName, bookingReference, serviceName, rescheduleLink, expiryDays = 7 }) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#1a5276;">Schedule Your New Visit</h2>
      <p>Hello ${customerName},</p>
      <p>Based on a past or missed appointment for <strong>${bookingReference || ""}</strong> (${serviceName || "your service"}), please use the link below to select a new date and time:</p>
      <div style="text-align:center;margin:30px 0;">
        <a href="${rescheduleLink}" style="background:#2e86c1;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:1rem;">Choose New Schedule</a>
      </div>
      <p style="color:#6c757d;font-size:0.9rem;">This link expires in <strong>${expiryDays} days</strong>.</p>
      <hr style="border:none;border-top:1px solid #e0e0e0;margin:20px 0;">
      <p style="color:#999;font-size:0.8rem;">RACS Ready App — Team Task Management</p>
    </div>`;

  await sendMail({
    to,
    subject: `Choose Your New Schedule — ${bookingReference || "Reschedule"}`,
    html,
    text: `Hi ${customerName}, choose your new visit: ${rescheduleLink} (expires in ${expiryDays} days)`,
  });
}

function sendPartsRequestEmail({ to, customerName, bookingReference, serviceName, missingParts = [] }) {
  const subject = `Parts Availability Update — Booking #${bookingReference}`;
  const partsListHtml = missingParts.map(p =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:0.88rem;color:#1e293b;">${p}</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;"><span style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;padding:2px 10px;border-radius:12px;font-size:0.75rem;font-weight:600;">Out of Stock</span></td></tr>`
  ).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Parts Update</title></head><body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:600px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  <div style="background:linear-gradient(135deg,#d97706 0%,#b45309 100%);padding:32px 40px;text-align:center;">
    <div style="font-size:2.5rem;margin-bottom:8px;">🔧</div>
    <h1 style="color:#fff;font-size:1.6rem;font-weight:800;margin:0 0 4px;">Parts Availability Update</h1>
    <p style="color:rgba(255,255,255,0.85);font-size:0.95rem;margin:0;">Booking #${bookingReference}</p>
  </div>
  <div style="padding:32px 40px;">
    <p style="font-size:1rem;color:#1e293b;margin:0 0 8px;">Hi <strong>${customerName}</strong>,</p>
    <p style="font-size:0.9rem;color:#475569;margin:0 0 24px;">Thank you for your patience. Our technician has completed the inspection for your <strong>${serviceName}</strong> service. Unfortunately, one or more required parts are currently out of stock.</p>
    <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
      <div style="font-weight:700;color:#92400e;margin-bottom:12px;">Parts Being Procured</div>
      <table width="100%" style="border-collapse:collapse;">
        <thead><tr><th style="text-align:left;padding:8px 12px;background:#fef3c7;font-size:0.8rem;color:#78350f;border-radius:6px 0 0 6px;">Part Name</th><th style="text-align:left;padding:8px 12px;background:#fef3c7;font-size:0.8rem;color:#78350f;border-radius:0 6px 6px 0;">Status</th></tr></thead>
        <tbody>${partsListHtml}</tbody>
      </table>
    </div>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
      <div style="font-weight:700;color:#166534;margin-bottom:8px;">What Happens Next</div>
      <div style="font-size:0.88rem;color:#15803d;line-height:1.7;">
        ✅ A procurement request has been raised for the missing parts.<br>
        📦 Once parts arrive, your repair will be scheduled immediately.<br>
        📧 You will receive a confirmation email with your repair date.<br>
        📞 Our team may contact you if alternative options are available.
      </div>
    </div>
    <p style="font-size:0.85rem;color:#64748b;text-align:center;">We apologize for any inconvenience and appreciate your patience.<br>If you have questions, please contact our support team.</p>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

// Admin Reschedule Notification Email
async function sendRescheduleNotificationEmail({
  to,
  customerName,
  bookingReference,
  serviceName,
  oldDateLabel,
  oldTimeLabel,
  newDateLabel,
  newTimeLabel,
  technicianName,
  reason,
}) {
  if (!to) return false;
  const subject = `Sorry for the inconvenience - ${bookingReference} | CALIDRO RACS`;
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">${premiumStyles("#f59e0b","#d97706")}</head><body>
<div class="wrap">
  <div class="header"><h1>Appointment Rescheduled</h1><div class="ref-badge">${bookingReference}</div></div>
  <div class="body">
    <p style="margin-top:0;font-size:16px;color:#1e293b;">Hi <strong>${customerName || "Customer"}</strong>,</p>
    <p style="color:#475569;line-height:1.6;">We sincerely apologize for the inconvenience. Our technician <strong>${technicianName || "our technician"}</strong> was unable to fulfill the original appointment. We have rescheduled your booking to a new date and time.</p>
    <div class="status-pill" style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;">Rescheduled</div>
    <div class="section-title">Schedule Change</div>
    <table>
      <tr class="detail-row"><td>Reference</td><td style="font-weight:700;">${bookingReference}</td></tr>
      <tr class="detail-row"><td>Service</td><td>${serviceName || "N/A"}</td></tr>
      <tr class="detail-row"><td>Previous Date</td><td>${oldDateLabel || "N/A"} at ${oldTimeLabel || "N/A"}</td></tr>
      <tr class="detail-row"><td>New Date</td><td style="font-weight:600;color:#0d6efd;">${newDateLabel || "TBD"}</td></tr>
      <tr class="detail-row"><td>New Time</td><td>${newTimeLabel || "TBD"}</td></tr>
    </table>
    ${reason ? `<div class="note-box"><strong>Reason:</strong> ${reason}</div>` : ""}
    <p style="color:#475569;font-size:13px;line-height:1.6;margin-top:16px;">Please review the new schedule and contact us if you need to make any further changes.</p>
    <div class="info-box" style="text-align:center;">
      <a href="${process.env.APP_BASE_URL || ""}/tracking" class="btn" style="background:#f59e0b;">View & Accept Schedule</a>
    </div>
  </div>
  ${premiumFooter()}
</div></body></html>`;
  return sendMail({ to, subject, html });
}

module.exports = {
  sendMail,
  sendEmail,
  sendResetEmail,
  sendBookingConfirmationEmail,
  sendRepairRequestSubmittedEmail,
  sendTechnicianNotificationEmail,
  sendWalkInCredentialsEmail,
  sendTechArrivalNotificationEmail,
  sendBookingAcceptedEmail,
  sendBookingExpiredEmail,
  sendTechnicianDeclinedEmail,
  sendTechnicianArrivedEmail,
  sendWorkStartedEmail,
  sendBookingCompletedEmail,
  sendTechnicianCancelledEmail,
  sendNoShowRescheduleEmail,
  sendNoShowReportedEmail,
  sendInspectionCompletedEmail,
  sendQuotationReadyEmail,
  sendRepairCompletedEmail,
  sendRescheduleRequestedEmail,
  sendRescheduleApprovedEmail,
  sendRescheduleRejectedEmail,
  sendRescheduleNotificationEmail,
  sendPartsRequestEmail,
  sendRescheduleLinkEmail,
};

const { validationResult } = require("express-validator");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const rateLimiter = require("../middleware/loginRateLimiter");
const mailer = require("../utils/mailer");
const audit = require("../utils/audit");

const FAKE_HASH = bcrypt.hashSync("invalid-password", 12);

// OTP storage (in production, use Redis or DB)
const otpStore = new Map();
// In-memory per-email limiter for forgot-password requests
const forgotStore = new Map();
const FORGOT_MAX = Number(process.env.FORGOT_MAX_ATTEMPTS) || 3;
const FORGOT_LOCK_MS = Number(process.env.FORGOT_LOCK_MS) || 5 * 60 * 1000; // default 5 minutes

function recordForgotAttempt(email) {
  const now = Date.now();
  const key = String(email || "")
    .replace(/[\$\{\}]/g, "")
    .toLowerCase();
  const rec = forgotStore.get(key) || {
    count: 0,
    firstAt: now,
    lockedUntil: 0,
  };
  // Reset window if older than lock window
  if (now - rec.firstAt > FORGOT_LOCK_MS) {
    rec.count = 0;
    rec.firstAt = now;
    rec.lockedUntil = 0;
  }
  rec.count += 1;
  if (rec.count >= FORGOT_MAX) {
    rec.lockedUntil = now + FORGOT_LOCK_MS;
  }
  forgotStore.set(key, rec);
  return rec;
}

function isForgotBlocked(email) {
  const key = String(email || "")
    .replace(/[\$\{\}]/g, "")
    .toLowerCase();
  const rec = forgotStore.get(key);
  if (!rec) return { blocked: false };
  if (rec.lockedUntil && Date.now() < rec.lockedUntil)
    return {
      blocked: true,
      retryAfter: Math.ceil((rec.lockedUntil - Date.now()) / 1000),
    };
  return { blocked: false };
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return header
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const [k, ...v] = pair.split("=");
      acc[k] = decodeURIComponent(v.join("="));
      return acc;
    }, {});
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOTPEmail(email, otp, type = "verification") {
  const subject =
    type === "login"
      ? "Your Login OTP - CALIDRO RACS"
      : "Verify Your Account - CALIDRO RACS";
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
      <style>
        body { font-family: 'Montserrat', Arial, sans-serif; background-color: #f4f7fa; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); }
        .header { background: linear-gradient(135deg, #007bff, #0056b3); color: white; padding: 30px 20px; text-align: center; }
        .header h1 { margin: 0; font-size: 24px; }
        .content { padding: 30px 20px; color: #333; line-height: 1.6; }
        .otp-code { background-color: #f8f9fa; border: 2px solid #007bff; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0; font-size: 32px; font-weight: bold; color: #007bff; letter-spacing: 4px; }
        .footer { background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 14px; }
        .footer p { margin: 5px 0; }
        .brand { color: #007bff; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1><i class="bi bi-snow2"></i> CALIDRO RACS</h1>
        </div>
        <div class="content">
          <h2>${type === "login" ? "Secure Login Verification" : "Account Verification Required"}</h2>
          <p>Hello,</p>
          <p>${type === "login" ? "To complete your sign-in process, please use the following One-Time Password (OTP):" : "Thank you for registering with CALIDRO RACS. To activate your account, please verify your email using the following One-Time Password (OTP):"}</p>
          <div class="otp-code">${otp}</div>
          <p><strong>Important:</strong> This OTP will expire in 10 minutes for security reasons. Please do not share this code with anyone.</p>
          <p>If you did not request this ${type === "login" ? "sign-in" : "registration"}, please ignore this email or contact our support team.</p>
          <p>Best regards,<br>The CALIDRO RACS Team</p>
        </div>
        <div class="footer">
          <p><span class="brand">CALIDRO RACS</span> - Your Trusted RACS-READY Service Partner</p>
          <p>This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    </body>
    </html>
  `;
  const text = `${type === "login" ? "Your login OTP is:" : "Your verification OTP is:"} ${otp}. This code expires in 10 minutes.`;
  try {
    const res = await mailer.sendMail({ to: email, subject, html, text });
    console.log(
      "sendOTPEmail: mailer.sendMail result for",
      email,
      res ? res.messageId || "sent" : "no-transporter",
    );
    return res;
  } catch (e) {
    console.error(
      "sendOTPEmail: error sending to",
      email,
      e && e.message ? e.message : e,
    );
    throw e;
  }
}

// Helper: generate & store a login OTP (used by secureAuthController for admin/secretary flows)
exports.generateLoginOTP = async function (email, userId, rememberMe = false) {
  const emailKey = String(email || "")
    .replace(/[\$\{\}]/g, "")
    .toLowerCase();
  const otp = generateOTP();
  const expires = Date.now() + 10 * 60 * 1000; // 10 minutes
  otpStore.set(emailKey, { userId, otp, expires, type: "login", rememberMe });
  try {
    await sendOTPEmail(email, otp, "login");
  } catch (e) {
    console.warn("generateLoginOTP: failed to send email", e && e.message);
  }
  return otp;
};

function sendGenericError(res, status = 400) {
  // Generic, non-enumerating error message
  return res
    .status(status)
    .json({ error: "Invalid email or password. Please try again." });
}

async function createAssessment({
  // TO-DO: Replace the token and reCAPTCHA action variables before running the sample.
  projectID = process.env.GOOGLE_CLOUD_PROJECT || "calidro-racs-1770773240175",
  recaptchaKey = process.env.RECAPTCHA_SITE_KEY,
  token = "action-token",
  recaptchaAction = "action-name",
}) {
  // Create the reCAPTCHA client.
  // TODO: Cache the client generation code (recommended) or call client.close() before exiting the method.
  const client =
    new (require("@google-cloud/recaptcha-enterprise").RecaptchaEnterpriseServiceClient)();
  const projectPath = client.projectPath(projectID);

  // Build the assessment request.
  const request = {
    assessment: {
      event: {
        token: token,
        siteKey: recaptchaKey,
      },
    },
    parent: projectPath,
  };

  const [response] = await client.createAssessment(request);

  // Check if the token is valid.
  if (!response.tokenProperties.valid) {
    console.log(
      `The CreateAssessment call failed because the token was: ${response.tokenProperties.invalidReason}`,
    );
    return null;
  }

  // Check if the expected action was executed.
  // The `action` property is set by user client in the grecaptcha.enterprise.execute() method.
  if (response.tokenProperties.action === recaptchaAction) {
    // Get the risk score and the reason(s).
    // For more information on interpreting the assessment, see:
    // https://cloud.google.com/recaptcha/docs/interpret-assessment
    console.log(`The reCAPTCHA score is: ${response.riskAnalysis.score}`);
    response.riskAnalysis.reasons.forEach((reason) => {
      console.log(reason);
    });

    return response.riskAnalysis.score;
  } else {
    console.log(
      "The action attribute in your reCAPTCHA tag does not match the action you are expecting to score",
    );
    return null;
  }
}

async function verifyRecaptcha(token, action = "LOGIN", ts) {
  console.log(
    `Verifying reCAPTCHA for action: ${action}, token: ${token ? "present" : "missing"}`,
  );
  // If no secret is configured, skip verification (useful for local/dev)
  const secret = process.env.RECAPTCHA_SECRET;
  if (!secret) {
    console.log("No RECAPTCHA_SECRET set, skipping verification");
    return true;
  }

  if (!token) {
    console.log("No token provided");
    return false;
  }

  try {
    const params = new URLSearchParams();
    params.append("secret", secret);
    params.append("response", token);

    const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      body: params,
    });
    const data = await res.json();
    console.log("reCAPTCHA response:", data);
    if (!data.success) return false;

    // If a client-side timestamp was provided, enforce a freshness window.
    try {
      if (ts) {
        const then = Number(ts) || 0;
        const now = Date.now();
        // Make the allowed age configurable via environment variable (ms).
        // Default to 3 minutes (180000 ms) as requested.
        const maxAgeMs =
          Number(process.env.RECAPTCHA_TS_MAX_AGE_MS) || 3 * 60 * 1000;
        if (now - then > maxAgeMs) {
          console.log("reCAPTCHA token too old (age > " + maxAgeMs + "ms)");
          return false;
        }
      }
    } catch (e) {}

    return true;
  } catch (e) {
    console.error("reCAPTCHA verification error:", e);
    // If verification fails due to network issues, be conservative and reject
    return false;
  }
}

exports.register = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res
        .status(400)
        .json({ error: "Registration failed. Please check your input." });
    }

    // Verify math captcha
    const mathCaptcha = String(req.body.mathCaptcha || "").trim();
    const mathAnswer = String(req.body.mathAnswer || "");
    if (mathCaptcha !== mathAnswer) {
      return res
        .status(400)
        .json({ error: "Incorrect math captcha. Please try again." });
    }

    // Basic server-side sanitization and size checks
    let email = String(req.body.email || "").trim();
    let password = String(req.body.password || "");

    // Optional customer profile fields (trim, normalize and size-check)
    const firstName =
      String(req.body.firstName || "")
        .trim()
        .substring(0, 20) || undefined;
    const lastName =
      String(req.body.lastName || "")
        .trim()
        .substring(0, 20) || undefined;
    // normalize phone to digits only (server-side canonicalization)
    const _rawPhone = String(req.body.phone || "").trim() || "";
    const phone = _rawPhone
      ? _rawPhone.replace(/\D+/g, "").substring(0, 32)
      : undefined;
    const address = {
      province: String(req.body.addressProvince || "").trim() || undefined,
      city: String(req.body.addressCity || "").trim() || undefined,
      barangay: String(req.body.addressBarangay || "").trim() || undefined,
      postalCode:
        String(req.body.addressPostal || "")
          .trim()
          .substring(0, 4) || undefined,
    };
    // Remove empty address fields
    Object.keys(address).forEach((k) => {
      if (!address[k]) delete address[k];
    });

    if (!email || !password || email.length > 50 || password.length > 20) {
      return res
        .status(400)
        .json({ error: "Registration failed. Please check your input." });
    }

    // enforce new complexity: 8-20 chars, letters/numbers, exactly one uppercase, each special char !,@,#,$ may appear at most once
    if (
      !/^(?=(?:.*[A-Z]){1})(?!.*[A-Z].*[A-Z])(?!.*!.*!)(?!.*@.*@)(?!.*#.*#)(?!.*\$.*\$)[A-Za-z0-9@!#$]{8,20}$/.test(
        password,
      )
    ) {
      return res.status(400).json({
        error:
          "Password must be 8–20 characters, letters/numbers and may include !,#,$; each may appear at most once and exactly one uppercase letter.",
      });
    }

    // Prevent common NoSQL injection patterns by removing operator chars
    email = email.replace(/[\$\{\}]/g, "");

    const exists = await User.findOne({ email });
    if (exists) {
      // Inform client that the email is already registered so it can show a specific message
      return res.status(409).json({ error: "Email is already registered." });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const user = new User({
      email,
      passwordHash: hashedPassword,
      firstName,
      lastName,
      phone,
      address,
      role: "customer", // Assuming default role
    });

    await user.save();

    // Audit log: record who created the account (actor and target set to the new user id)
    try {
      await audit.logEvent({
        actor: user._id,
        target: user._id,
        action: "USER_REGISTER",
        module: "auth",
        req,
        details: { email, role: "customer" },
      });
    } catch (e) {
      console.warn("audit.logEvent failed", e && e.message);
    }

    res
      .status(201)
      .json({ message: "Registration successful. You can now sign in." });
  } catch (err) {
    next(err);
  }
};

// Verify register OTP
exports.verifyRegisterOTP = async (req, res, next) => {
  try {
    // Debug incoming request
    try {
      console.debug("verifyRegisterOTP body:", {
        email: req.body.email,
        otp: req.body.otp,
      });
    } catch (e) {}

    let email = String(req.body.email || "").trim();
    let otp = String(req.body.otp || "").trim();

    if (!email || !otp) {
      return res.status(400).json({ error: "Missing email or OTP." });
    }

    // normalize email to match storage keys
    const emailKey = email.replace(/[\$\{\}]/g, "").toLowerCase();

    const ip =
      req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;

    // Check rate-limiter before validating OTP
    const blockedIp = rateLimiter.isBlocked("ip", ip);
    if (blockedIp.blocked)
      return res.status(429).json({
        error: `Too many verification attempts. Please try again in ${blockedIp.retryAfterLabel || "a few minutes"}.`,
        retryAfter: Math.ceil(blockedIp.retryAfter / 1000),
      });
    const blockedEmail = rateLimiter.isBlocked("email", emailKey);
    if (blockedEmail.blocked)
      return res.status(429).json({
        error: `Too many verification attempts. Please try again in ${blockedEmail.retryAfterLabel || "a few minutes"}.`,
        retryAfter: Math.ceil(blockedEmail.retryAfter / 1000),
      });

    const stored = otpStore.get(emailKey);
    try {
      console.debug(
        "verifyRegisterOTP stored:",
        stored
          ? {
              type: stored.type,
              expires: stored.expires,
              hasPassword: !!stored.password,
            }
          : null,
      );
    } catch (e) {}

    if (
      !stored ||
      stored.type !== "register" ||
      stored.otp !== otp ||
      Date.now() > stored.expires
    ) {
      // record failed attempt on both email and IP
      try {
        rateLimiter.recordFailed("email", emailKey);
      } catch (e) {}
      try {
        rateLimiter.recordFailed("ip", ip);
      } catch (e) {}
      const nowBlockedEmail = rateLimiter.isBlocked("email", emailKey);
      const nowBlockedIp = rateLimiter.isBlocked("ip", ip);
      if (nowBlockedEmail.blocked || nowBlockedIp.blocked) {
        const retryAfter = Math.ceil(
          (nowBlockedEmail.retryAfter || nowBlockedIp.retryAfter || 0) / 1000,
        );
        return res.status(429).json({
          error: "Too many attempts. Please try again later.",
          retryAfter,
        });
      }
      return res.status(400).json({ error: "Invalid or expired OTP." });
    }

    // Ensure stored registration payload contains required profile fields
    if (
      !stored.firstName ||
      !stored.lastName ||
      !stored.phone ||
      !stored.password
    ) {
      console.warn(
        "verifyRegisterOTP: incomplete stored registration data for",
        emailKey,
        stored,
      );
      return res.status(400).json({
        error: "Incomplete registration data. Please start registration again.",
      });
    }

    // Create user
    const user = new User({
      email,
      firstName: stored.firstName,
      lastName: stored.lastName,
      phone: stored.phone,
      address: stored.address,
    });
    await user.setPassword(stored.password);
    await user.save();

    // Clean up
    otpStore.delete(emailKey);

    // Success: reset any limiter counters for this email/ip
    try {
      rateLimiter.reset("email", emailKey);
    } catch (e) {}
    try {
      rateLimiter.reset("ip", ip);
    } catch (e) {}

    res
      .status(201)
      .json({ message: "Account created successfully. Please log in." });
  } catch (err) {
    next(err);
  }
};

// Resend registration OTP (throttled)
exports.resendRegisterOTP = async (req, res, next) => {
  try {
    let email = String(req.body.email || "").trim();

    if (!email) {
      return res.status(400).json({ error: "Invalid request." });
    }

    email = email.replace(/[\$\{\}]/g, "");
    const emailKey = email.toLowerCase();

    console.log("resendRegisterOTP: emailKey=", emailKey);
    const stored = otpStore.get(emailKey);
    console.log("resendRegisterOTP: stored=", !!stored);
    if (!stored || stored.type !== "register") {
      return res
        .status(400)
        .json({ error: "No pending registration for that email." });
    }

    const now = Date.now();
    const lastSent = stored.lastSent || 0;
    // Throttle resends to once per 60 seconds
    if (now - lastSent < 60 * 1000) {
      return res
        .status(429)
        .json({ error: "Please wait before requesting another code." });
    }

    const otp = generateOTP();
    stored.otp = otp;
    stored.expires = now + 10 * 60 * 1000;
    stored.lastSent = now;
    otpStore.set(emailKey, stored);

    await sendOTPEmail(email, otp, "register");

    res.status(200).json({ message: "OTP resent to your email." });
  } catch (err) {
    next(err);
  }
};

// Resend login OTP (throttled)
exports.resendLoginOTP = async (req, res, next) => {
  try {
    let email = String(req.body.email || "").trim();

    if (!email) {
      return res.status(400).json({ error: "Invalid request." });
    }

    email = email.replace(/[\$\{\}]/g, "");
    const emailKey = email.toLowerCase();

    console.log("resendLoginOTP: emailKey=", emailKey);
    const stored = otpStore.get(emailKey);
    console.log("resendLoginOTP: stored=", !!stored);
    if (!stored || stored.type !== "login") {
      return res
        .status(400)
        .json({ error: "No pending login for that email." });
    }

    const now = Date.now();
    const lastSent = stored.lastSent || 0;
    // Throttle resends to once per 60 seconds
    if (now - lastSent < 60 * 1000) {
      return res
        .status(429)
        .json({ error: "Please wait before requesting another code." });
    }

    const otp = generateOTP();
    stored.otp = otp;
    stored.expires = now + 10 * 60 * 1000;
    stored.lastSent = now;
    otpStore.set(emailKey, stored);

    await sendOTPEmail(email, otp, "login");

    res.status(200).json({ message: "OTP resent to your email." });
  } catch (err) {
    next(err);
  }
};

// Verify login OTP
exports.verifyLoginOTP = async (req, res, next) => {
  try {
    let email = String(req.body.email || "").trim();
    let otp = String(req.body.otp || "").trim();

    if (!email || !otp) {
      return res.status(400).json({ error: "Invalid request." });
    }

    const emailKey = email.replace(/[\$\{\}]/g, "").toLowerCase();
    const ip =
      req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;

    // Check rate-limiter for IP/email
    const blockedIp = rateLimiter.isBlocked("ip", ip);
    if (blockedIp.blocked)
      return res.status(429).json({
        error: `Too many login attempts. Please try again in ${blockedIp.retryAfterLabel || "a few minutes"}.`,
        retryAfter: Math.ceil(blockedIp.retryAfter / 1000),
      });
    const blockedEmail = rateLimiter.isBlocked("email", emailKey);
    if (blockedEmail.blocked)
      return res.status(429).json({
        error: `Too many login attempts. Please try again in ${blockedEmail.retryAfterLabel || "a few minutes"}.`,
        retryAfter: Math.ceil(blockedEmail.retryAfter / 1000),
      });

    const stored = otpStore.get(emailKey);
    if (
      !stored ||
      stored.type !== "login" ||
      stored.otp !== otp ||
      Date.now() > stored.expires
    ) {
      // record failed attempt for both email and IP
      try {
        rateLimiter.recordFailed("email", emailKey);
      } catch (e) {}
      try {
        rateLimiter.recordFailed("ip", ip);
      } catch (e) {}
      const nowBlockedEmail = rateLimiter.isBlocked("email", emailKey);
      const nowBlockedIp = rateLimiter.isBlocked("ip", ip);
      if (nowBlockedEmail.blocked || nowBlockedIp.blocked) {
        const retryAfter = Math.ceil(
          (nowBlockedEmail.retryAfter || nowBlockedIp.retryAfter || 0) / 1000,
        );
        return res.status(429).json({
          error: "Too many attempts. Please try again later.",
          retryAfter,
        });
      }
      return res.status(400).json({ error: "Invalid or expired OTP." });
    }

    // Get user
    const user = await User.findById(stored.userId);
    if (!user) {
      return res.status(400).json({ error: "User not found." });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Audit: successful login
    try {
      await audit.logEvent({
        actor: user._id,
        target: user._id,
        action: "login",
        module: "auth",
        req,
        details: { role: user.role },
      });
    } catch (e) {}

    // Clean up
    otpStore.delete(emailKey);

    // Establish a server-side session id
    const sessionId = require("crypto").randomBytes(24).toString("hex");
    user.currentSessionId = sessionId;
    await user.save();

    const payload = { id: user._id, role: user.role, sessionId };
    const defaultMaxAge = Number(process.env.SESSION_MAX_AGE_MS) || 30 * 60 * 1000;
    const maxAge = stored.rememberMe ? 30 * 24 * 60 * 60 * 1000 : defaultMaxAge; // 30 days if rememberMe, else default
    const token = jwt.sign(payload, process.env.JWT_SECRET || "dev-secret", {
      expiresIn: Math.floor(maxAge / 1000) + "s",
    });

    const isProd = process.env.NODE_ENV === "production";
    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: isProd,
      sameSite: "Strict",
      maxAge: maxAge,
      path: "/",
    });

    // Role-based redirect server-side where appropriate
    let redirect = "/";
    if (user.role === "admin") redirect = "/admin";
    else if (user.role === "secretary") redirect = "/secretary";
    else if (user.role === "technician") redirect = "/technician";
    else if (user.role === "customer") {
      redirect = req.body.returnTo ? decodeURIComponent(req.body.returnTo) : "/";
    }

    // If the client expects JSON, return JSON with redirect; otherwise perform server redirect
    const acceptsJson =
      req.headers &&
      req.headers.accept &&
      req.headers.accept.indexOf("application/json") !== -1;
    if (acceptsJson) {
      return res.status(200).json({
        message: "Login successful.",
        redirect,
        user: { id: user._id, email: user.email, role: user.role },
      });
    }

    return res.redirect(303, redirect);
  } catch (err) {
    next(err);
  }
};

// Forgot password - sends single-use token if email exists (response is intentionally generic)
exports.forgotPassword = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      if (process.env.NODE_ENV !== "production") {
        try {
          console.debug("forgotPassword: validation failed", errors.array());
        } catch (e) {}
      }
      return res.status(400).json({ error: "Invalid request data." });
    }

    let email = String(req.body.email || "").trim();

    // Prevent common NoSQL injection patterns
    email = email.replace(/[\$\{\}]/g, "");
    
    // Normalize email to lowercase for consistent database lookup
    email = email.toLowerCase();

    console.log("[AUTH] forgotPassword request for email:", email);

    // Rate limit per-email: block after FORGOT_MAX attempts for FORGOT_LOCK_MS
    const blocked = isForgotBlocked(email);
    if (blocked.blocked) {
      return res.status(429).json({
        error:
          "Too many requests. Please wait before retrying. Additional failures will extend the lock.",
        retryAfter: blocked.retryAfter,
      });
    }

    // math captcha validation
    const mathCaptcha = String(req.body.mathCaptcha || "").trim();
    const mathAnswer = String(req.body.mathAnswer || "").trim();
    if (!mathCaptcha || mathCaptcha !== mathAnswer) {
      // record attempt to deter brute-force/enumeration
      recordForgotAttempt(email);
      return res.status(400).json({ error: "Invalid captcha. Please try again." });
    }

    // Find user by normalized lowercase email
    const user = await User.findOne({ email });
    if (!user) {
      // record attempt for unknown email as well (prevent enumeration)
      recordForgotAttempt(email);
      // generic response
      return res.status(200).json({
        message:
          "If an account with that email exists, we have sent a password reset link.",
      });
    }

    const token = user.createPasswordResetToken();
    await user.save();

    // Build reset link
    const resetLink = `${req.protocol}://${req.get("host")}/reset-password?token=${token}`;

    // Send email using mailer utility; fail gracefully and stay generic in response
    try {
      const mailResult = await mailer.sendResetEmail(email, resetLink);
      console.log("[AUTH] sendResetEmail result for", email, mailResult && mailResult.messageId ? "OK" : mailResult);
      if (mailResult && mailResult.messageId) {
        console.log("[AUTH] Reset password email sent successfully to:", email, "MessageID:", mailResult.messageId);
        audit.logEvent({
          actor: user._id,
          target: user._id,
          action: 'password_reset_email_sent',
          module: 'auth',
          req,
          details: { messageId: mailResult.messageId }
        }).catch(() => {});
      } else if (mailResult === false) {
        console.warn(
          "[AUTH] Reset password email not sent - SMTP not configured for:",
          email,
        );
      } else {
        console.warn(
          "[AUTH] Reset password email send returned unexpected result for:",
          email,
          "Result:",
          mailResult,
        );
      }
    } catch (e) {
      console.error("[AUTH] Error sending reset password email to", email, ":", e && e.message, e && e.response);
      // do not expose failure to the client
    }

    // record this send attempt (counts toward per-email limit)
    try {
      recordForgotAttempt(email);
    } catch (e) {}

    // Send generic response
    return res.status(200).json({
      message:
        "If an account with that email exists, we have sent a password reset link.",
    });
  } catch (err) {
    next(err);
  }
};

// Reset password with token
exports.resetPassword = async (req, res, next) => {
  try {
    const { token, password, csrfToken, email, mathCaptcha, mathAnswer } = req.body;

    // Validate types and sizes early
    if (
      !token ||
      !password ||
      !email ||
      typeof token !== "string" ||
      typeof password !== "string" ||
      typeof email !== "string" ||
      token.length > 256 ||
      password.length > 20 ||
      email.length > 50
    )
      return res
        .status(400)
        .json({ error: "Reset failed. Please check your input." });

    // Validate math captcha
    if (!mathCaptcha || mathCaptcha !== mathAnswer) {
      return res
        .status(400)
        .json({ error: "Incorrect captcha. Please try again." });
    }

    // server-side complexity check (align with client rules)
    if (
      !/^(?=(?:.*[A-Z]){1})(?=.*[0-9@!#$])(?!.*[A-Z].*[A-Z])(?!.*[!@#$].*[!@#$])[A-Za-z0-9@!#$]{8,20}$/.test(
        password,
      )
    ) {
      return res.status(400).json({
        error:
          "Password must be 8-20 characters long, letters/numbers and may include !,#,$; each may appear at most once (at least one uppercase).",
      });
    }

    // CSRF double-submit check
    const cookies = parseCookies(req);
    const cookieToken = cookies["XSRF-TOKEN"] || "";
    if (!csrfToken || !cookieToken || csrfToken !== cookieToken) {
      return res
        .status(400)
        .json({ error: "Reset failed. Please check your input." });
    }

    // Normalize and validate email
    const normalizedEmail = email.replace(/[\$\{\}]/g, "").toLowerCase();
    
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpires: { $gt: Date.now() },
      email: normalizedEmail, // Ensure email matches the token owner
    });
    if (!user)
      return res
        .status(400)
        .json({ error: "Reset failed. Please check your input." });

    await user.setPassword(password);
    user.clearPasswordReset();
    // Clear any existing sessions on password reset
    user.currentSessionId = undefined;
    await user.save();

    // Clear any active auth cookies for safety
    res.clearCookie("auth_token", { path: "/" });

    res.json({ message: "Password reset successful. Please log in." });
  } catch (err) {
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Record failed attempt for validation failures
      const ip = req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;
      let email = String(req.body.email || "").trim().toLowerCase();
      email = email.replace(/[\$\{\}]/g, ""); // remove operator chars
      if (email) rateLimiter.recordFailed("email", email);
      rateLimiter.recordFailed("ip", ip);
      
      if (process.env.NODE_ENV !== "production")
        try {
          console.debug("login: validation failed", errors.array());
        } catch (e) {}
      return sendGenericError(res);
    }

    // CSRF double-submit check
    const cookies = parseCookies(req);
    const sent = req.body.csrfToken || "";
    const cookieToken = cookies["XSRF-TOKEN"] || "";
    if (!sent || !cookieToken || sent !== cookieToken) {
      // Record failed attempt for CSRF mismatch
      const ip = req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;
      let email = String(req.body.email || "").trim().toLowerCase();
      email = email.replace(/[\$\{\}]/g, "");
      if (email) rateLimiter.recordFailed("email", email);
      rateLimiter.recordFailed("ip", ip);
      
      // Bad token - treat as generic auth failure
      if (process.env.NODE_ENV !== "production")
        try {
          console.warn(
            "login: CSRF mismatch; sentPresent=",
            !!sent,
            "cookiePresent=",
            !!cookieToken,
          );
        } catch (e) {}
      return sendGenericError(res);
    }

    const ip =
      req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;
    let email = String(req.body.email || "").trim();
    let password = String(req.body.password || "");

    // Basic size checks
    if (!email || !password || email.length > 50 || password.length > 20) {
      return sendGenericError(res);
    }

    // remove operator chars to reduce NoSQL injection risk
    email = email.replace(/[\$\{\}]/g, "");
    // normalize email to lowercase to match storage (prevents case mismatch)
    email = email.toLowerCase();

    // Debug (dev only): show incoming values that affect auth flow
    if (process.env.NODE_ENV !== "production") {
      try {
        console.debug("login: incoming", {
          ip,
          email,
          csrfTokenPresent: !!req.body.csrfToken,
          hasMathCaptcha: !!req.body.mathCaptcha,
        });
      } catch (e) {}
    }

    // Math captcha validation (we use math captcha instead of reCAPTCHA)
    const mathCaptcha = String(req.body.mathCaptcha || "").trim();
    const mathAnswer = String(req.body.mathAnswer || "");
    if (mathCaptcha !== mathAnswer) {
      // Record failed attempt for captcha failure
      rateLimiter.recordFailed("ip", ip);
      if (email) rateLimiter.recordFailed("email", email);
      
      // do not reveal details
      return res
        .status(400)
        .json({ error: "Incorrect math captcha. Please try again." });
    }

    // Check block status (by IP and by email)
    const blockedIp = rateLimiter.isBlocked("ip", ip);
    if (blockedIp.blocked) {
      const message = `Too many failed login attempts (cycle ${blockedIp.currentCycle}). Account locked for ${blockedIp.retryAfterLabel || "3 minutes"} for security.`;
      return res
        .status(429)
        .json({
          error: message,
          retryAfter: blockedIp.retryAfterSeconds || 180,
          currentCycle: blockedIp.currentCycle,
          showPopup: true,
          popupTitle: "Account Temporarily Locked",
          popupMessage: `You cannot log in again for ${blockedIp.retryAfterLabel || "3 minutes"}. This is cycle ${blockedIp.currentCycle} - lockout duration increases with each cycle.`,
        });
    }
    const blockedEmail = rateLimiter.isBlocked("email", email);
    if (blockedEmail.blocked) {
      const message = `Too many failed login attempts (cycle ${blockedEmail.currentCycle}). Account locked for ${blockedEmail.retryAfterLabel || "3 minutes"} for security.`;
      return res
        .status(429)
        .json({
          error: message,
          retryAfter: blockedEmail.retryAfterSeconds || 180,
          currentCycle: blockedEmail.currentCycle,
          showPopup: true,
          popupTitle: "Account Temporarily Locked",
          popupMessage: `You cannot log in again for ${blockedEmail.retryAfterLabel || "3 minutes"}. This is cycle ${blockedEmail.currentCycle} - lockout duration increases with each cycle.`,
        });
    }

    // Lookup user
    const user = await User.findOne({ email });
    if (process.env.NODE_ENV !== "production")
      try {
        console.debug("login: lookup user", { email, found: !!user });
      } catch (e) {}

    // If user not found, do a fake compare to avoid timing attacks
    let match = false;
    if (!user) {
      // compare to fake hash
      match = await bcrypt.compare(password, FAKE_HASH);
      if (process.env.NODE_ENV !== "production")
        try {
          console.debug("login: user not found, fake-compare result=", match);
        } catch (e) {}
    } else {
      match = await user.comparePassword(password);
      if (process.env.NODE_ENV !== "production")
        try {
          console.debug("login: password compare result=", match);
        } catch (e) {}
    }

    if (!match) {
      // record failed attempts
      if (process.env.NODE_ENV !== "production")
        try {
          console.warn("login: authentication failed for", email);
        } catch (e) {}
      rateLimiter.recordFailed("ip", ip);
      rateLimiter.recordFailed("email", email);
      return sendGenericError(res);
    }

    // Success: reset counters
    rateLimiter.reset("ip", ip);
    rateLimiter.reset("email", email);

    // Generate OTP for login
    const otp = generateOTP();
    const expires = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store temporarily
    const emailKey = email.toLowerCase();
    const rememberMe = !!req.body.rememberMe;
    otpStore.set(emailKey, { userId: user._id, otp, expires, type: "login", rememberMe });

    // Send OTP email
    await sendOTPEmail(email, otp, "login");

    res.status(200).json({
      message: "OTP sent to your email. Please verify to complete login.",
      requiresOTP: true,
    });
  } catch (err) {
    next(err);
  }
};

exports.logout = async (req, res) => {
  try {
    const actor = req.user && req.user._id;
    // clear server-side session id so token is no longer valid
    try {
      if (req.user) {
        req.user.currentSessionId = undefined;
        await req.user.save();
      }
    } catch (e) {}
    await audit.logEvent({
      actor,
      target: actor,
      action: "logout",
      module: "auth",
      req,
      details: {},
    });
  } catch (e) {}

  // Destroy express-session if present (secure/session-based login)
  try {
    if (req.session && typeof req.session.destroy === "function") {
      await new Promise((resolve) => req.session.destroy(() => resolve()));
    }
  } catch (e) {}

  res.clearCookie("auth_token", { path: "/" });
  // Clear common session cookie names used by express-session
  res.clearCookie("sid", { path: "/" });
  res.clearCookie("connect.sid", { path: "/" });
  res.json({ message: "Logged out" });
};

exports.verify = async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const token = cookies["auth_token"];
    if (!token) return res.json({ user: null });
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    } catch (e) {
      return res.json({ user: null });
    }
    const user = await User.findById(payload.id).select("-passwordHash");
    if (!user) return res.json({ user: null });
    res.json({ user });
  } catch (err) {
    res.json({ user: null });
  }
};

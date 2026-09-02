const { validationResult } = require("express-validator");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const { isAccountEnabled } = require("../middleware/accountState");
const rateLimiter = require("../middleware/loginRateLimiter");
const mailer = require("../utils/mailer");
const audit = require("../utils/audit");
const trustedDevices = require("../utils/trustedDevices");
const { getSystemConfiguration } = require("../utils/systemConfiguration");
const { hashInvitationToken } = require("../utils/customerAccountInvitation");

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

function logPasswordResetEvent(req, { user, action, outcome, riskLevel, details = {} }) {
  return audit.logEvent({
    actor: null,
    target: user ? user._id : null,
    action,
    module: "auth",
    req,
    entityType: "User",
    entityId: user ? user._id : null,
    actorName: "Unauthenticated requester",
    actorRole: "guest",
    source: "unauthenticated_request",
    outcome,
    riskLevel,
    details,
  });
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
  return crypto.randomInt(100000, 1000000).toString();
}

const REGISTRATION_OTP_TTL_MS = 10 * 60 * 1000;
const REGISTRATION_OTP_RESEND_MS = 60 * 1000;
const REGISTRATION_OTP_MAX_ATTEMPTS = 5;

function normalizeEmailKey(email) {
  return String(email || "")
    .trim()
    .replace(/[\$\{\}]/g, "")
    .toLowerCase();
}

function hashRegistrationOTP(email, otp) {
  const secret = process.env.OTP_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("OTP_SECRET or JWT_SECRET must be configured.");
  }
  return crypto
    .createHmac("sha256", secret)
    .update(`${normalizeEmailKey(email)}:${String(otp)}`)
    .digest("hex");
}

function registrationOTPMatches(expectedHash, email, otp) {
  if (!expectedHash) return false;
  const actual = Buffer.from(hashRegistrationOTP(email, otp), "hex");
  const expected = Buffer.from(String(expectedHash), "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function clearRegistrationVerification(user) {
  user.emailVerificationOtpHash = undefined;
  user.emailVerificationExpires = undefined;
  user.emailVerificationLastSentAt = undefined;
  user.emailVerificationAttempts = undefined;
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

// Helper: generate and store a login OTP for staff step-up authentication.
exports.generateLoginOTP = async function (email, userId, rememberMe = false) {
  const emailKey = String(email || "")
    .replace(/[\$\{\}]/g, "")
    .toLowerCase();
  const otp = generateOTP();
  const expires = Date.now() + 10 * 60 * 1000; // 10 minutes
  otpStore.set(emailKey, { userId, otp, expires, type: "login", rememberMe });
  try {
    const sendResult = await sendOTPEmail(email, otp, "login");
    if (!sendResult) throw new Error("No email transport accepted the message.");
  } catch (e) {
    otpStore.delete(emailKey);
    console.warn("generateLoginOTP: failed to send email", e && e.message);
    throw e;
  }
  return otp;
};

function sendGenericError(res, status = 400) {
  // Generic, non-enumerating error message
  return res
    .status(status)
    .json({ error: "Invalid email or password. Please try again." });
}

function loginRedirectFor(req, user) {
  if (user.role === "admin") return "/admin";
  if (user.role === "secretary") return "/secretary";
  if (user.role === "technician") return "/technician";
  if (user.role === "customer" && req.body.returnTo) {
    try {
      const returnTo = decodeURIComponent(req.body.returnTo);
      if (returnTo.startsWith("/") && !returnTo.startsWith("//")) return returnTo;
    } catch (e) {}
  }
  return "/";
}

async function establishJwtLogin(req, res, user, rememberMe) {
  const sessionId = crypto.randomBytes(24).toString("hex");
  const defaultMaxAge = Number(process.env.SESSION_MAX_AGE_MS) || 30 * 60 * 1000;
  const maxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : defaultMaxAge;

  user.lastLogin = new Date();
  user.currentSessionId = sessionId;
  await user.save();

  const token = jwt.sign(
    { id: user._id, role: user.role, sessionId, rememberMe: !!rememberMe },
    process.env.JWT_SECRET,
    { expiresIn: Math.floor(maxAge / 1000) + "s" },
  );
  res.cookie("auth_token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Strict",
    maxAge,
    path: "/",
  });

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

  return loginRedirectFor(req, user);
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

    const systemConfiguration = await getSystemConfiguration();
    if (!systemConfiguration.application.allowCustomerRegistrations) {
      return res.status(403).json({
        error: "New customer registration is temporarily unavailable. Please contact the business for assistance.",
        registrationDisabled: true,
      });
    }
    const requiresEmailVerification = systemConfiguration.application.requireEmailVerification;

    // Verify math captcha
    const mathCaptcha = String(req.body.mathCaptcha || "").trim();
    const mathAnswer = String(req.body.mathAnswer || "");
    if (mathCaptcha !== mathAnswer) {
      return res
        .status(400)
        .json({ error: "Incorrect math captcha. Please try again." });
    }

    // Basic server-side sanitization and size checks
    let email = normalizeEmailKey(req.body.email);
    const password = String(req.body.password || "");

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

    if (!email || !password || email.length > 254 || password.length > 30) {
      return res
        .status(400)
        .json({ error: "Registration failed. Please check your input." });
    }

    // Enforce the same 8-30 character policy used by the registration form.
    if (
      !/^(?=(?:.*[A-Z]){1})(?!.*[A-Z].*[A-Z])(?!.*!.*!)(?!.*@.*@)(?!.*#.*#)(?!.*\$.*\$)[A-Za-z0-9@!#$]{8,30}$/.test(
        password,
      )
    ) {
      return res.status(400).json({
        error:
          "Password must be 8–30 characters, letters/numbers and may include !,#,$; each may appear at most once and exactly one uppercase letter.",
      });
    }

    const existingUser = await User.findOne({ email }).select(
      "+emailVerificationLastSentAt",
    );
    if (existingUser && existingUser.emailVerified !== false) {
      return res.status(409).json({ error: "Email is already registered." });
    }

    if (requiresEmailVerification && existingUser && existingUser.emailVerificationLastSentAt) {
      const elapsed =
        Date.now() - new Date(existingUser.emailVerificationLastSentAt).getTime();
      if (elapsed < REGISTRATION_OTP_RESEND_MS) {
        return res.status(429).json({
          error: "Please wait before requesting another verification code.",
          requiresVerification: true,
          email,
          retryAfter: Math.ceil((REGISTRATION_OTP_RESEND_MS - elapsed) / 1000),
        });
      }
    }

    const otp = requiresEmailVerification ? generateOTP() : null;
    const now = Date.now();
    const hashedPassword = await bcrypt.hash(password, 12);

    // Refresh an existing unverified registration instead of leaving a
    // duplicate account that can never complete verification.
    const user = existingUser || new User({ email, role: "customer" });
    if (!existingUser) user.accountOrigin = "self_registration";
    if (user.accountStatus === "invited") {
      user.accountStatus = "active";
      user.invitationActivatedAt = new Date(now);
      user.clearAccountInvitation();
    }
    user.passwordHash = hashedPassword;
    user.firstName = firstName;
    user.lastName = lastName;
    user.phone = phone;
    user.address = address;
    user.emailVerified = !requiresEmailVerification;
    user.emailVerifiedAt = requiresEmailVerification ? undefined : new Date(now);
    if (requiresEmailVerification) {
      user.emailVerificationOtpHash = hashRegistrationOTP(email, otp);
      user.emailVerificationExpires = new Date(now + REGISTRATION_OTP_TTL_MS);
      user.emailVerificationLastSentAt = new Date(now);
      user.emailVerificationAttempts = 0;
    } else {
      clearRegistrationVerification(user);
    }

    await user.save();

    // Audit log: record who created the account (actor and target set to the new user id)
    try {
      await audit.logEvent({
        actor: user._id,
        target: user._id,
        action: requiresEmailVerification ? "USER_REGISTRATION_PENDING" : "USER_REGISTER",
        module: "auth",
        req,
        details: { email, role: "customer" },
      });
    } catch (e) {
      console.warn("audit.logEvent failed", e && e.message);
    }

    if (!requiresEmailVerification) {
      return res.status(201).json({
        message: "Account created. You can now sign in.",
        requiresVerification: false,
        redirect: "/login?registered=1",
      });
    }

    try {
      const sendResult = await sendOTPEmail(email, otp, "register");
      if (!sendResult) throw new Error("No email transport accepted the message.");
    } catch (mailError) {
      console.error(
        "register: verification email failed for",
        email,
        mailError && mailError.message,
      );
      return res.status(503).json({
        error:
          "Your account is pending verification, but the email could not be sent. Please use Resend code in a moment.",
        requiresVerification: true,
        email,
      });
    }

    return res.status(202).json({
      message: "We sent a 6-digit verification code to your email.",
      requiresVerification: true,
      email,
      expiresIn: Math.floor(REGISTRATION_OTP_TTL_MS / 1000),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: "Email is already registered." });
    }
    next(err);
  }
};

// Verify register OTP
exports.verifyRegisterOTP = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Invalid verification request." });
    }

    const email = normalizeEmailKey(req.body.email);
    const otp = String(req.body.otp || "").trim();

    if (!email || !otp) {
      return res.status(400).json({ error: "Missing email or OTP." });
    }

    const ip =
      req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;

    // Check rate-limiter before validating OTP
    const blockedIp = rateLimiter.isBlocked("ip", ip);
    if (blockedIp.blocked)
      return res.status(429).json({
        error: `Too many verification attempts. Please try again in ${blockedIp.retryAfterLabel || "a few minutes"}.`,
        retryAfter: Math.ceil(blockedIp.retryAfter / 1000),
      });
    const blockedEmail = rateLimiter.isBlocked("email", email);
    if (blockedEmail.blocked)
      return res.status(429).json({
        error: `Too many verification attempts. Please try again in ${blockedEmail.retryAfterLabel || "a few minutes"}.`,
        retryAfter: Math.ceil(blockedEmail.retryAfter / 1000),
      });

    const user = await User.findOne({ email }).select(
      "+emailVerificationOtpHash +emailVerificationExpires +emailVerificationAttempts",
    );
    if (!user || user.emailVerified !== false) {
      return res.status(400).json({ error: "Invalid or expired OTP." });
    }

    const expired =
      !user.emailVerificationExpires ||
      Date.now() > new Date(user.emailVerificationExpires).getTime();
    const matches =
      !expired &&
      registrationOTPMatches(user.emailVerificationOtpHash, email, otp);

    if (!matches) {
      user.emailVerificationAttempts =
        Number(user.emailVerificationAttempts || 0) + 1;
      await user.save();
      rateLimiter.recordFailed("email", email);
      rateLimiter.recordFailed("ip", ip);

      if (user.emailVerificationAttempts >= REGISTRATION_OTP_MAX_ATTEMPTS) {
        return res.status(429).json({
          error: "Too many verification attempts. Please request a new code.",
        });
      }

      return res.status(400).json({
        error: expired
          ? "This verification code has expired. Please request a new one."
          : "Invalid verification code.",
        canResend: expired,
      });
    }

    user.emailVerified = true;
    user.emailVerifiedAt = new Date();
    if (user.accountStatus === "invited") {
      user.accountStatus = "active";
      user.invitationActivatedAt = new Date();
      user.clearAccountInvitation();
    }
    clearRegistrationVerification(user);
    await user.save();

    rateLimiter.reset("email", email);
    rateLimiter.reset("ip", ip);

    try {
      await audit.logEvent({
        actor: user._id,
        target: user._id,
        action: "USER_EMAIL_VERIFIED",
        module: "auth",
        req,
        details: { email, role: user.role },
      });
    } catch (e) {
      console.warn("audit.logEvent failed", e && e.message);
    }

    return res.status(200).json({
      message: "Email verified. You can now sign in.",
      redirect: "/login?verified=1",
    });
  } catch (err) {
    next(err);
  }
};

// Resend registration OTP (throttled)
exports.resendRegisterOTP = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Invalid verification request." });
    }

    const email = normalizeEmailKey(req.body.email);

    if (!email) {
      return res.status(400).json({ error: "Invalid request." });
    }

    const user = await User.findOne({ email }).select(
      "+emailVerificationLastSentAt",
    );
    if (!user || user.emailVerified !== false) {
      return res
        .status(400)
        .json({ error: "No pending registration for that email." });
    }

    const now = Date.now();
    const lastSent = user.emailVerificationLastSentAt
      ? new Date(user.emailVerificationLastSentAt).getTime()
      : 0;
    if (now - lastSent < REGISTRATION_OTP_RESEND_MS) {
      const retryAfter = Math.ceil(
        (REGISTRATION_OTP_RESEND_MS - (now - lastSent)) / 1000,
      );
      return res.status(429).json({
        error: "Please wait before requesting another code.",
        retryAfter,
      });
    }

    const otp = generateOTP();
    user.emailVerificationOtpHash = hashRegistrationOTP(email, otp);
    user.emailVerificationExpires = new Date(now + REGISTRATION_OTP_TTL_MS);
    user.emailVerificationLastSentAt = new Date(now);
    user.emailVerificationAttempts = 0;
    await user.save();

    const sendResult = await sendOTPEmail(email, otp, "register");
    if (!sendResult) {
      return res.status(503).json({ error: "Email service is unavailable." });
    }

    return res.status(200).json({
      message: "A new verification code was sent to your email.",
      expiresIn: Math.floor(REGISTRATION_OTP_TTL_MS / 1000),
    });
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
    if (!isAccountEnabled(user)) {
      otpStore.delete(emailKey);
      return res.status(400).json({ error: "User not found." });
    }

    let trustedDeviceAdded = false;
    const trustDeviceRequested =
      req.body.trustDevice === true || req.body.trustDevice === "true";
    if (user.role === "technician" && trustDeviceRequested) {
      try {
        await trustedDevices.issue(req, res, user);
        trustedDeviceAdded = true;
        await audit.logEvent({
          actor: user._id,
          target: user._id,
          action: "auth.trusted_device_added",
          module: "auth",
          req,
          entityType: "TrustedDevice",
          actorRole: user.role,
          details: { trustDays: trustedDevices._private.trustDurationMs() / 86400000 },
        });
      } catch (e) {
        console.warn("verifyLoginOTP: unable to trust technician device", e && e.message);
      }
    }

    // Clean up
    otpStore.delete(emailKey);
    const redirect = await establishJwtLogin(req, res, user, stored.rememberMe);

    // If the client expects JSON, return JSON with redirect; otherwise perform server redirect
    const acceptsJson =
      req.headers &&
      req.headers.accept &&
      req.headers.accept.indexOf("application/json") !== -1;
    if (acceptsJson) {
      return res.status(200).json({
        message: "Login successful.",
        redirect,
        trustedDeviceAdded,
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
      void logPasswordResetEvent(req, {
        action: "auth.password_reset_request_blocked",
        outcome: "blocked",
        riskLevel: "critical",
        details: { reason: "per_account_rate_limit", retryAfterSeconds: blocked.retryAfter },
      });
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
      void logPasswordResetEvent(req, {
        action: "auth.password_reset_request_failed",
        outcome: "failure",
        riskLevel: "medium",
        details: { reason: "captcha_failed" },
      });
      return res.status(400).json({ error: "Invalid captcha. Please try again." });
    }

    // Find user by normalized lowercase email
    const user = await User.findOne({ email });
    if (!user) {
      // record attempt for unknown email as well (prevent enumeration)
      recordForgotAttempt(email);
      void logPasswordResetEvent(req, {
        action: "auth.password_reset_requested",
        outcome: "pending",
        riskLevel: "medium",
        details: { accountMatched: false },
      });
      // generic response
      return res.status(200).json({
        message:
          "If an account with that email exists, we have sent a password reset link.",
      });
    }

    const token = user.createPasswordResetToken();
    await user.save();

    void logPasswordResetEvent(req, {
      user,
      action: "auth.password_reset_requested",
      outcome: "pending",
      riskLevel: "medium",
      details: { accountMatched: true },
    });

    // Build reset link
    const resetLink = `${req.protocol}://${req.get("host")}/reset-password?token=${token}`;

    // Send email using mailer utility; fail gracefully and stay generic in response
    try {
      const mailResult = await mailer.sendResetEmail(email, resetLink);
      console.log("[AUTH] sendResetEmail result for", email, mailResult && mailResult.messageId ? "OK" : mailResult);
      if (mailResult && mailResult.messageId) {
        console.log("[AUTH] Reset password email sent successfully to:", email, "MessageID:", mailResult.messageId);
        void logPasswordResetEvent(req, {
          user,
          action: "auth.password_reset_email_sent",
          outcome: "pending",
          riskLevel: "medium",
          details: { deliveryAccepted: true },
        });
      } else if (mailResult === false) {
        console.warn(
          "[AUTH] Reset password email not sent - SMTP not configured for:",
          email,
        );
        void logPasswordResetEvent(req, {
          user,
          action: "auth.password_reset_email_failed",
          outcome: "failure",
          riskLevel: "medium",
          details: { reason: "mail_transport_unavailable" },
        });
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
      void logPasswordResetEvent(req, {
        user,
        action: "auth.password_reset_email_failed",
        outcome: "failure",
        riskLevel: "medium",
        details: { reason: "mail_delivery_error" },
      });
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

    console.log("[AUTH] resetPassword request - email:", email, "token length:", token ? token.length : 0);

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
    ) {
      console.log("[AUTH] resetPassword validation failed - missing or invalid fields");
      await logPasswordResetEvent(req, {
        action: "auth.password_reset_failed",
        outcome: "failure",
        riskLevel: "medium",
        details: { reason: "invalid_request" },
      });
      return res
        .status(400)
        .json({ error: "Please fill in all required fields correctly." });
    }

    // Validate math captcha
    if (!mathCaptcha || mathCaptcha !== mathAnswer) {
      console.log("[AUTH] resetPassword captcha failed");
      await logPasswordResetEvent(req, {
        action: "auth.password_reset_failed",
        outcome: "failure",
        riskLevel: "medium",
        details: { reason: "captcha_failed" },
      });
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
      console.log("[AUTH] resetPassword password complexity failed");
      await logPasswordResetEvent(req, {
        action: "auth.password_reset_failed",
        outcome: "failure",
        riskLevel: "low",
        details: { reason: "password_policy_failed" },
      });
      return res.status(400).json({
        error:
          "Password must be 8-20 characters with 1 uppercase letter and 1 number or symbol.",
      });
    }

    // CSRF double-submit check
    const cookies = parseCookies(req);
    const cookieToken = cookies["XSRF-TOKEN"] || "";
    if (!csrfToken || !cookieToken || csrfToken !== cookieToken) {
      console.log("[AUTH] resetPassword CSRF mismatch - cookie:", !!cookieToken, "body:", !!csrfToken);
      await logPasswordResetEvent(req, {
        action: "auth.password_reset_failed",
        outcome: "blocked",
        riskLevel: "high",
        details: { reason: "csrf_validation_failed" },
      });
      return res
        .status(400)
        .json({ error: "Session expired. Please refresh the page and try again." });
    }

    // Normalize and validate email
    const normalizedEmail = email.replace(/[\$\{\}]/g, "").toLowerCase();

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    // First check if token exists (without email constraint)
    const tokenUser = await User.findOne({
      resetPasswordTokenHash: tokenHash,
    });

    if (!tokenUser) {
      console.log("[AUTH] resetPassword - token not found in database");
      await logPasswordResetEvent(req, {
        action: "auth.password_reset_failed",
        outcome: "blocked",
        riskLevel: "high",
        details: { reason: "invalid_token" },
      });
      return res
        .status(400)
        .json({ error: "Invalid or expired reset link. Please request a new one." });
    }

    // Check if token is expired
    if (!tokenUser.resetPasswordExpires || tokenUser.resetPasswordExpires < Date.now()) {
      console.log("[AUTH] resetPassword - token expired at:", tokenUser.resetPasswordExpires);
      await logPasswordResetEvent(req, {
        user: tokenUser,
        action: "auth.password_reset_failed",
        outcome: "failure",
        riskLevel: "medium",
        details: { reason: "expired_token" },
      });
      return res
        .status(400)
        .json({ error: "Reset link has expired. Please request a new one." });
    }

    // Check if email matches
    if (tokenUser.email !== normalizedEmail) {
      console.log("[AUTH] resetPassword - email mismatch. Expected:", tokenUser.email, "Got:", normalizedEmail);
      await logPasswordResetEvent(req, {
        user: tokenUser,
        action: "auth.password_reset_failed",
        outcome: "blocked",
        riskLevel: "critical",
        details: { reason: "email_token_mismatch" },
      });
      return res
        .status(400)
        .json({ error: "Email does not match the reset request. Please use the email you registered with." });
    }

    const user = tokenUser;

    await user.setPassword(password);
    user.clearPasswordReset();
    // Clear any existing sessions on password reset
    user.currentSessionId = undefined;
    await user.save();

    await logPasswordResetEvent(req, {
      user,
      action: "auth.password_reset_completed",
      outcome: "success",
      riskLevel: "high",
      details: { sessionsRevoked: true },
    });

    // Clear any active auth cookies for safety
    res.clearCookie("auth_token", { path: "/" });

    res.json({ message: "Password reset successful. Please log in." });
  } catch (err) {
    next(err);
  }
};

// Complete a staff-provisioned walk-in customer invitation. The invitation
// token proves email control; the customer chooses the only usable password.
exports.activateInvitedAccount = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Invalid account activation request." });

    const token = String(req.body.token || "");
    const password = String(req.body.password || "");
    const csrfToken = String(req.body.csrfToken || "");
    const cookies = parseCookies(req);
    if (!csrfToken || !cookies["XSRF-TOKEN"] || csrfToken !== cookies["XSRF-TOKEN"]) {
      return res.status(400).json({ error: "Activation session expired. Refresh the page and try again." });
    }
    if (!/^(?=(?:.*[A-Z]){1})(?!.*[A-Z].*[A-Z])(?!.*!.*!)(?!.*@.*@)(?!.*#.*#)(?!.*\$.*\$)[A-Za-z0-9@!#$]{8,30}$/.test(password)) {
      return res.status(400).json({
        error: "Password must be 8–30 characters with exactly one uppercase letter; letters, numbers, !, @, #, and $ are allowed.",
      });
    }

    const user = await User.findOne({
      invitationTokenHash: hashInvitationToken(token),
      accountStatus: "invited",
      emailVerified: false,
    }).select("+invitationTokenHash +invitationExpiresAt");
    if (!user || !user.invitationExpiresAt || user.invitationExpiresAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: "This activation link is invalid or has expired. Ask CALIDRO RACS to resend it." });
    }

    await user.setPassword(password);
    user.emailVerified = true;
    user.emailVerifiedAt = new Date();
    user.accountStatus = "active";
    user.invitationActivatedAt = new Date();
    user.clearAccountInvitation();
    user.currentSessionId = undefined;
    await user.save();

    await audit.logEvent({
      actor: user._id,
      target: user._id,
      action: "CUSTOMER_INVITATION_ACTIVATED",
      module: "auth",
      req,
      entityId: user._id,
      entityType: "User",
      actorRole: "customer",
      actorName: user.email,
      outcome: "success",
      details: { origin: user.accountOrigin, emailVerified: true, sessionsRevoked: true },
    }).catch((error) => console.warn("account activation audit failed", error.message));

    res.clearCookie("auth_token", { path: "/" });
    return res.json({
      message: "Your email is verified and your account is ready.",
      redirect: "/login?activated=1&returnTo=%2Fmy-orders",
    });
  } catch (error) {
    next(error);
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
    if (!email || !password || email.length > 254 || password.length > 128) {
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

    if (user.emailVerified === false) {
      return res.status(403).json({
        error: "Please verify your email before signing in.",
        requiresEmailVerification: true,
        email: user.email,
      });
    }

    if (!isAccountEnabled(user)) {
      return sendGenericError(res);
    }

    // Success: reset counters
    rateLimiter.reset("ip", ip);
    rateLimiter.reset("email", email);

    const rememberMe = !!req.body.rememberMe;
    if (user.role === "technician") {
      try {
        const trusted = await trustedDevices.validateAndRotate(req, res, user);
        if (trusted) {
          const redirect = await establishJwtLogin(req, res, user, rememberMe);
          return res.status(200).json({
            message: "Login successful.",
            redirect,
            trustedDevice: true,
            user: { id: user._id, email: user.email, role: user.role },
          });
        }
      } catch (deviceError) {
        // A device-store failure must require OTP; it must never bypass MFA.
        console.warn(
          "login: trusted-device validation failed",
          user.email,
          deviceError && deviceError.message,
        );
      }
    }

    await exports.generateLoginOTP(email, user._id, rememberMe);

    res.status(200).json({
      message: "OTP sent to your email. Please verify to complete login.",
      requiresOTP: true,
      canTrustDevice: user.role === "technician",
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
      payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
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

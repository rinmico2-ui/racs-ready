/**
 * secureAuthController.js
 * - session-based login/logout with suspicious-login detection
 * - regenerates session on login (prevents session fixation)
 * - logs LoginHistory and issues alerts on new device/IP
 *
 * NOTE: this controller is written to be integrated with express-session
 * middleware (see README/integration notes below).
 */
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const uaParser = require("ua-parser-js");
const geoip = require("geoip-lite");
const { validationResult } = require("express-validator");
const authController = require("./authController");
const User = require("../models/User");
const { isAccountEnabled } = require("../middleware/accountState");
const LoginHistory = require("../models/LoginHistory");
const FailedLoginAttempt = require("../models/FailedLoginAttempt");
const AuthSession = require("../models/AuthSession");
const mailer = require("../utils/mailer");
const trustedDevices = require("../utils/trustedDevices");
const rateLimiter = require("../middleware/loginRateLimiter");

// Configuration / policy (tunable)
const FAILED_WINDOW_MS = Number(process.env.FAILED_WINDOW_MS) || 15 * 60 * 1000; // 15 min
const FAILED_MAX = Number(process.env.FAILED_MAX) || 5;
const LOCK_DURATION_MS = Number(process.env.ACCOUNT_LOCK_MS) || 30 * 60 * 1000; // 30 min

// Helper: parse cookies from request header
function parseCookies(req) {
  const header = req.headers.cookie || "";
  return header
    .split(";")
    .reduce((acc, curr) => {
      const [key, value] = curr.trim().split("=");
      if (key && value) acc[key] = value;
      return acc;
    }, {});
}

// helper to determine if client expects JSON (AJAX)
function wantsJson(req) {
  return !!(
    req.xhr ||
    (req.headers.accept && req.headers.accept.indexOf("application/json") !== -1)
  );
}

// Helper: parse UA and IP
function parseRequestInfo(req) {
  const ua = (req.headers["user-agent"] || "").slice(0, 512);
  const parsed = uaParser(ua);
  const deviceType =
    (parsed && parsed.device && parsed.device.type) || "desktop";
  const browser =
    parsed.browser && parsed.browser.name
      ? parsed.browser.name + " " + (parsed.browser.version || "")
      : "";
  const os =
    parsed.os && parsed.os.name
      ? parsed.os.name + " " + (parsed.os.version || "")
      : "";
  const ip =
    req.ip ||
    req.headers["x-forwarded-for"] ||
    req.connection.remoteAddress ||
    "";
  const geo = geoip.lookup(ip) || {};
  return { ua, deviceType, browser, os, ip, geo };
}

// Suspicious detection: compare to most recent login(s)
async function detectSuspicious(userId, ip, deviceFingerprint, geo) {
  const last = await LoginHistory.find({ userId })
    .sort({ createdAt: -1 })
    .limit(5);
  let newDevice = true;
  let newIp = true;
  let differentCountry = false;
  for (const h of last) {
    if (h.userAgent === deviceFingerprint) newDevice = false;
    if (h.ip === ip) newIp = false;
    if (h.country && geo && geo.country && h.country === geo.country) {
      // same country spotted
    }
  }
  if (
    last.length &&
    last[0].country &&
    geo &&
    geo.country &&
    last[0].country !== geo.country
  )
    differentCountry = true;
  return { newDevice, newIp, differentCountry };
}

async function recordFailedAttempt({ email, ip }) {
  try {
    let rec = await FailedLoginAttempt.findOne({ $or: [{ email }, { ip }] });
    if (!rec) rec = new FailedLoginAttempt({ email, ip, count: 0 });
    await rec.increment(LOCK_DURATION_MS, FAILED_MAX);
    return rec;
  } catch (e) {
    return null;
  }
}

async function clearFailedAttempts({ email, ip }) {
  try {
    await FailedLoginAttempt.deleteMany({ $or: [{ email }, { ip }] });
  } catch (e) {}
}

async function sendSuspiciousLoginEmail(user, details) {
  const subject = "Suspicious sign-in detected for your account";
  const html = `
    <p>Hi ${user.firstName || user.email},</p>
    <p>We detected a sign-in to your account that looks different from your usual activity:</p>
    <ul>
      <li><strong>When:</strong> ${new Date(details.time).toLocaleString()}</li>
      <li><strong>IP / Location:</strong> ${details.ip} ${details.location || ""}</li>
      <li><strong>Device:</strong> ${details.device}</li>
      <li><strong>Browser / OS:</strong> ${details.browser} / ${details.os}</li>
    </ul>
    <p>If this was you, no action is required. If this wasn't you, <a href="${details.secureLink}">secure your account now</a>.</p>
    <p>— Security team</p>
  `;
  const text = `Suspicious sign-in detected for ${user.email} from ${details.ip}. If this wasn't you, visit: ${details.secureLink}`;
  try {
    await mailer.sendMail({ to: user.email, subject, html, text });
  } catch (e) {
    console.warn("Failed to send suspicious email", e && e.message);
  }
}

// Login route (example) — integrates session regeneration + suspicious detection
exports.login = async (req, res, next) => {
  try {
    const validation = validationResult(req);
    if (!validation.isEmpty()) {
      // Record failed attempt for validation failures
      const ip = req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;
      const email = String(req.body.email || "").trim().toLowerCase();
      if (email) rateLimiter.recordFailed("email", email);
      rateLimiter.recordFailed("ip", ip);

      const msg = "Invalid credentials";
      if (!wantsJson(req))
        return res.redirect("/login?error=" + encodeURIComponent(msg));
      return res.status(400).json({ error: msg });
    }

    const {
      email = "",
      password = "",
      mathCaptcha = "",
      mathAnswer = "",
      csrfToken = "",
      rememberMe = false,
    } = req.body || {};

    // Check rate limiter before proceeding
    const ip = req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;
    const normalizedEmail = String(email).trim().toLowerCase();

    const blockedIp = rateLimiter.isBlocked("ip", ip);
    if (blockedIp.blocked) {
      const message = `Too many failed login attempts (cycle ${blockedIp.currentCycle}). Account locked for ${blockedIp.retryAfterLabel || "3 minutes"} for security.`;
      return res.status(429).json({
        error: message,
        retryAfter: blockedIp.retryAfterSeconds || 180,
        currentCycle: blockedIp.currentCycle,
        showPopup: true,
        popupTitle: "Account Temporarily Locked",
        popupMessage: `You cannot log in again for ${blockedIp.retryAfterLabel || "3 minutes"}. This is cycle ${blockedIp.currentCycle} - lockout duration increases with each cycle.`,
      });
    }

    const blockedEmail = rateLimiter.isBlocked("email", normalizedEmail);
    if (blockedEmail.blocked) {
      const message = `Too many failed login attempts (cycle ${blockedEmail.currentCycle}). Account locked for ${blockedEmail.retryAfterLabel || "3 minutes"} for security.`;
      return res.status(429).json({
        error: message,
        retryAfter: blockedEmail.retryAfterSeconds || 180,
        currentCycle: blockedEmail.currentCycle,
        showPopup: true,
        popupTitle: "Account Temporarily Locked",
        popupMessage: `You cannot log in again for ${blockedEmail.retryAfterLabel || "3 minutes"}. This is cycle ${blockedEmail.currentCycle} - lockout duration increases with each cycle.`,
      });
    }

    // server-side validation
    if (!email || !password) {
      // Record failed attempt
      rateLimiter.recordFailed("email", normalizedEmail);
      rateLimiter.recordFailed("ip", ip);

      const msg = "Invalid credentials";
      if (!wantsJson(req)) return res.redirect("/login?error=" + encodeURIComponent(msg));
      return res.status(400).json({ error: msg });
    }

    // CSRF double-submit check
    const cookies = parseCookies(req);
    const cookieToken = cookies["XSRF-TOKEN"] || "";
    if (!csrfToken || !cookieToken || csrfToken !== cookieToken) {
      // Record failed attempt
      rateLimiter.recordFailed("email", normalizedEmail);
      rateLimiter.recordFailed("ip", ip);

      const msg = "Invalid security token";
      if (!wantsJson(req)) return res.redirect("/login?error=" + encodeURIComponent(msg));
      return res.status(400).json({ error: msg });
    }

    if (String(mathCaptcha).trim() !== String(mathAnswer).trim()) {
      // Record failed attempt
      rateLimiter.recordFailed("email", normalizedEmail);
      rateLimiter.recordFailed("ip", ip);

      const msg = "captcha";
      if (!wantsJson(req)) return res.redirect("/login?error=" + encodeURIComponent(msg));
      return res.status(400).json({ error: msg });
    }

    const user = await User.findOne({
      email: String(email).trim().toLowerCase(),
    });
    if (!user) {
      // Record failed attempt with rate limiter
      rateLimiter.recordFailed("email", normalizedEmail);
      rateLimiter.recordFailed("ip", ip);
      const msg = "Invalid email or password";
      if (!wantsJson(req)) return res.redirect("/login?error=" + encodeURIComponent(msg));
      return res.status(400).json({ error: msg });
    }

    // account locked?
    if (user.active === false || user.blocked === true) {
      const msg = "Account locked";
      if (!wantsJson(req)) return res.redirect("/login?error=" + encodeURIComponent(msg));
      return res.status(403).json({ error: msg });
    }

    const match = await user.comparePassword(password);
    if (!match) {
      // Record failed attempt with rate limiter
      rateLimiter.recordFailed("email", normalizedEmail);
      rateLimiter.recordFailed("ip", ip);
      
      const msg = "Invalid email or password";
      if (!wantsJson(req)) return res.redirect("/login?error=" + encodeURIComponent(msg));
      return res.status(400).json({ error: msg });
    }

    if (user.emailVerified === false) {
      return res.status(403).json({
        error: "Please verify your email before signing in.",
        requiresEmailVerification: true,
        email: user.email,
      });
    }

    // successful password auth -> reset rate limiter
    rateLimiter.reset("email", normalizedEmail);
    rateLimiter.reset("ip", ip);

    // parse device/ip
    const info = parseRequestInfo(req);
    const deviceFingerprint = info.ua; // simple fingerprint for demo
    const geo = info.geo || {};

    // detect suspicious
    const suspicious = await detectSuspicious(
      user._id,
      info.ip,
      deviceFingerprint,
      geo,
    );

    const alwaysRequireOtp = user.role === "admin" || user.role === "secretary";
    let technicianRequiresOtp = false;
    if (user.role === "technician") {
      try {
        const trusted = await trustedDevices.validateAndRotate(req, res, user);
        technicianRequiresOtp = !trusted || suspicious.differentCountry;
      } catch (e) {
        console.warn(
          "secureAuth.login: trusted-device validation failed for technician",
          user.email,
          e && e.message,
        );
        technicianRequiresOtp = true;
      }
    }

    if (alwaysRequireOtp || technicianRequiresOtp) {
      try {
        await authController.generateLoginOTP(user.email, user._id, rememberMe);
        return res.status(200).json({
          message: "OTP sent to your email. Please verify to complete login.",
          requiresOTP: true,
          canTrustDevice: user.role === "technician",
        });
      } catch (e) {
        console.warn(
          "secureAuth.login: failed to send required staff OTP",
          user.email,
          e && e.message,
        );
        return res.status(503).json({
          error: "We could not send your verification code. Please try again.",
        });
      }
    }

    // regenerate session (prevent fixation)
    req.session.regenerate((err) => {
      if (err) return next(err);

      (async function finalizeLogin() {
        try {
          req.session.userId = user._id.toString();
          req.session.role = user.role;
          req.session.createdAt = Date.now();
          req.session.lastActivity = Date.now();

          // "Remember Me": extend session cookie to 30 days
          if (rememberMe) {
            const REMEMBER_ME_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
            req.session.cookie.maxAge = REMEMBER_ME_TTL;
            // Touch the session in the store so its TTL is also extended
            req.session.touch?.();
          }

          // Issue a JWT auth_token cookie as well, so the authenticate
          // middleware (JWT-first) recognises the session.  Include the
          // rememberMe flag so token rotation preserves the extended expiry.
          const jwt = require("jsonwebtoken");
          const sessionId = require("crypto").randomBytes(24).toString("hex");
          user.currentSessionId = sessionId;
          await user.save();
          const jwtMaxAge = rememberMe
            ? 30 * 24 * 60 * 60 * 1000
            : Number(process.env.SESSION_MAX_AGE_MS) || 30 * 60 * 1000;
          const jwtToken = jwt.sign(
            { id: user._id, role: user.role, sessionId, rememberMe: !!rememberMe },
            process.env.JWT_SECRET,
            { expiresIn: Math.floor(jwtMaxAge / 1000) + "s" },
          );
          const isProd = process.env.NODE_ENV === "production";
          res.cookie("auth_token", jwtToken, {
            httpOnly: true,
            secure: isProd,
            sameSite: "Strict",
            maxAge: jwtMaxAge,
            path: "/",
          });

          try {
            await AuthSession.create({
              sessionId: req.sessionID,
              userId: user._id,
              ip: info.ip,
              userAgent: info.ua,
            });
          } catch (e) {
            console.warn("secureAuth.login: AuthSession create failed", e && e.message);
          }

          let history = null;
          try {
            history = await LoginHistory.create({
              userId: user._id,
              ip: info.ip,
              country: geo && geo.country,
              city: geo && geo.city,
              userAgent: info.ua,
              deviceType: info.deviceType,
              browser: info.browser,
              os: info.os,
              isNewDevice: suspicious.newDevice,
              isNewIp: suspicious.newIp,
              suspicious:
                suspicious.newDevice ||
                suspicious.newIp ||
                suspicious.differentCountry,
            });
          } catch (e) {
            console.warn(
              "secureAuth.login: LoginHistory create failed",
              e && e.message,
            );
          }

          if (history && history.suspicious) {
            const details = {
              ip: info.ip,
              location: (geo && (geo.city || geo.country)) || "Unknown",
              device: info.deviceType,
              browser: info.browser,
              os: info.os,
              time: history.createdAt,
              secureLink: `${req.protocol}://${req.get("host")}/profile`,
            };
            sendSuspiciousLoginEmail(user, details);
            req.session.untrusted = true;
          }

          let redirect = "/";
          if (user.role === "admin") redirect = "/admin";
          else if (user.role === "secretary") redirect = "/secretary";
          else if (user.role === "technician") redirect = "/technician";
          else if (user.role === "customer") {
            redirect = req.body.returnTo ? decodeURIComponent(req.body.returnTo) : "/";
          }

          return res.json({
            ok: true,
            suspicious: !!(history && history.suspicious),
            role: user.role,
            redirect,
          });
        } catch (finalizeErr) {
          console.error("secureAuth.login: finalizeLogin failed", finalizeErr);
          return res.status(500).json({
            error: "Unable to complete login. Please try again.",
          });
        }
      })();
    });
  } catch (err) {
    next(err);
  }
};

exports.logout = async (req, res) => {
  try {
    const sid = req.sessionID;
    // capture userId before session is destroyed (may not always be present)
    const userId =
      (req.session && req.session.userId) || (req.user && req.user._id);

    // destroy express-session
    req.session.destroy(() => {});

    // revoke server-side session record
    try {
      await AuthSession.updateOne({ sessionId: sid }, { revoked: true });
    } catch (e) {
      console.warn(
        "secureAuth.logout: failed to revoke AuthSession",
        e && e.message,
      );
    }

    // clear user's currentSessionId so JWT/pageAuth no longer validates
    if (userId) {
      try {
        await User.updateOne(
          { _id: userId },
          { $unset: { currentSessionId: 1 } },
        );
      } catch (e) {
        console.warn(
          "secureAuth.logout: failed to clear currentSessionId",
          e && e.message,
        );
      }
    }

    console.log(
      "secureAuth.logout: session ended for",
      userId ? String(userId) : "unknown-user",
      "sid=",
      sid,
    );
  } catch (e) {
    console.warn("secureAuth.logout: unexpected error", e && e.message);
  }

  // clear cookies used for auth (session + JWT)
  res.clearCookie("sid", { path: "/" });
  res.clearCookie("connect.sid", { path: "/" });
  res.clearCookie("auth_token", { path: "/" });
  res.json({ message: "Logged out" });
};

/**
 * Comments / Security Notes (embedded in controller for reviewers)
 * - Passwords are compared with bcrypt (resistant to offline cracking)
 * - Server-side validation and rate-limiting prevents credential stuffing/brute force
 * - Session regeneration on login prevents session fixation attacks
 * - Storing server-side session + short cookie (httpOnly, secure, sameSite) avoids exposure in JS
 * - LoginHistory + detection flags allow rapid detection of account-takeover attempts
 */

"use strict";

const crypto = require("crypto");
const User = require("../models/User");
const { isAccountEnabled } = require("../middleware/accountState");

const COOKIE_NAME = "racs_login_challenge";
const TTL_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const PRIVATE_FIELDS = "+loginOtpHash +loginOtpExpires +loginOtpLastSentAt +loginOtpRememberMe +loginOtpChallengeHash +loginOtpAttempts +loginOtpPasswordVersion";
const CLEAR_FIELDS = Object.fromEntries(PRIVATE_FIELDS.split(" ").map(field => [field.slice(1), 1]));

function digest(purpose, value) {
  const secret = process.env.OTP_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("An OTP signing secret is required.");
  return crypto.createHmac("sha256", secret).update(`${purpose}:${value}`).digest("hex");
}

function otpHash(email, otp) {
  // Keep compatibility with the existing login OTP hash format.
  return digest(email, otp);
}

function passwordVersion(user) {
  return digest("login-password", user.passwordHash || "");
}

function cookie(req, name) {
  if (req.cookies?.[name]) return req.cookies[name];
  const part = String(req.headers?.cookie || "").split(";").find(value => value.trim().startsWith(`${name}=`));
  if (!part) return "";
  try { return decodeURIComponent(part.trim().slice(name.length + 1)); } catch { return ""; }
}

function challengeHash(req) {
  const token = cookie(req, COOKIE_NAME);
  return typeof token === "string" && /^[a-f0-9]{64}$/.test(token) ? digest("login-browser", token) : "";
}

function cookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "Strict", path: "/api/auth" };
}

function clearCookie(res) {
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

function failure(message, statusCode = 400, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

function assertRequest(req) {
  const token = req.body?.csrfToken;
  const expected = cookie(req, "XSRF-TOKEN");
  if (typeof token !== "string" || !token || token.length > 256 || token !== expected) {
    throw failure("Your sign-in request expired. Refresh the page and try again.", 403, { restartLogin: true });
  }
  if (!challengeHash(req)) {
    throw failure("Please enter your email and password before requesting or verifying a code.", 400, { restartLogin: true });
  }
}

function response(delivery, expires, retryAfter = 60) {
  const queued = Boolean(delivery?.queued);
  return {
    deliveryStatus: queued ? "queued" : "accepted",
    message: queued
      ? "Your verification email is queued. Delivery may take a moment. Check your inbox and spam folder; use the newest code."
      : "Your verification email was accepted by the mail provider. Check your inbox and spam folder; use the newest code.",
    expiresAt: expires.toISOString(),
    retryAfter,
  };
}

async function sendPending(user, otp, send) {
  try {
    const delivery = await send(user.email, otp, "login", {
      validUntil: user.loginOtpExpires.toISOString(),
      loginOtp: { userId: String(user._id), hash: user.loginOtpHash },
    });
    if (!delivery) throw new Error("No email transport accepted the message.");
    return response(delivery, user.loginOtpExpires);
  } catch {
    await User.updateOne(
      { _id: user._id, loginOtpHash: user.loginOtpHash },
      { $unset: CLEAR_FIELDS },
    ).catch(() => {});
    throw failure("We could not send your verification email. Please sign in again shortly.", 503, { restartLogin: true });
  }
}

// Called only after the password is verified. MongoDB enforces the cooldown
// across instances, including simultaneous password submissions.
async function begin(user, rememberMe, req, res, send) {
  const now = new Date();
  const token = crypto.randomBytes(32).toString("hex");
  const otp = String(crypto.randomInt(100000, 1000000));
  const pending = {
    loginOtpHash: otpHash(user.email, otp),
    loginOtpExpires: new Date(now.getTime() + TTL_MS),
    loginOtpLastSentAt: now,
    loginOtpRememberMe: Boolean(rememberMe),
    loginOtpChallengeHash: digest("login-browser", token),
    loginOtpAttempts: 0,
    loginOtpPasswordVersion: passwordVersion(user),
  };
  const result = await User.updateOne({
    _id: user._id,
    email: user.email,
    passwordHash: user.passwordHash,
    $or: [{ loginOtpLastSentAt: { $lte: new Date(now.getTime() - COOLDOWN_MS) } }, { loginOtpLastSentAt: null }],
    $nor: [{ loginOtpExpires: { $gt: now }, loginOtpAttempts: { $gte: MAX_ATTEMPTS } }],
  }, { $set: pending });
  if (!result.modifiedCount) {
    const existing = await User.findOne({ _id: user._id }).select(PRIVATE_FIELDS);
    const locked = existing?.loginOtpExpires > now && existing.loginOtpAttempts >= MAX_ATTEMPTS;
    const retryAfter = Math.max(1, Math.ceil(((locked ? existing.loginOtpExpires?.getTime() : (existing?.loginOtpLastSentAt?.getTime() || now.getTime()) + COOLDOWN_MS) - now.getTime()) / 1000));
    if (!locked && existing?.loginOtpExpires > now
      && existing.loginOtpChallengeHash === challengeHash(req)
      && existing.loginOtpPasswordVersion === passwordVersion(user)) {
      return { ...response(null, existing.loginOtpExpires, retryAfter), deliveryStatus: "pending", message: "A verification code was already requested. Check your inbox and spam folder, or wait before resending." };
    }
    throw failure(locked ? "Too many verification attempts. Please wait before signing in again." : "Please wait before requesting another verification email.", 429, { retryAfter });
  }
  const resultBody = await sendPending({ ...pending, _id: user._id, email: user.email }, otp, send);
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(), maxAge: TTL_MS });
  return resultBody;
}

async function resend(req, send) {
  assertRequest(req);
  const email = req.body.email.trim().toLowerCase();
  const now = new Date();
  const pending = await User.findOne({ email, loginOtpChallengeHash: challengeHash(req) }).select(PRIVATE_FIELDS);
  if (!pending || !isAccountEnabled(pending) || pending.emailVerified === false
    || !(pending.loginOtpExpires > now) || pending.loginOtpAttempts >= MAX_ATTEMPTS
    || pending.loginOtpPasswordVersion !== passwordVersion(pending)) {
    throw failure("Your verification request expired. Please sign in again.", 400, { restartLogin: true });
  }
  const retryAfter = Math.ceil(((pending.loginOtpLastSentAt?.getTime() || 0) + COOLDOWN_MS - now.getTime()) / 1000);
  if (retryAfter > 0) throw failure("Please wait before requesting another code.", 429, { retryAfter });
  const otp = String(crypto.randomInt(100000, 1000000));
  const hash = otpHash(email, otp);
  const result = await User.updateOne({
    _id: pending._id,
    passwordHash: pending.passwordHash,
    loginOtpHash: pending.loginOtpHash,
    loginOtpChallengeHash: pending.loginOtpChallengeHash,
    loginOtpExpires: { $gt: now },
    loginOtpLastSentAt: { $lte: new Date(now.getTime() - COOLDOWN_MS) },
    $or: [{ loginOtpAttempts: { $lt: MAX_ATTEMPTS } }, { loginOtpAttempts: null }],
  }, { $set: { loginOtpHash: hash, loginOtpLastSentAt: now } });
  if (!result.modifiedCount) throw failure("Another verification request is being processed. Please wait before trying again.", 429, { retryAfter: 60 });
  // Resending never extends the original deadline or resets failed attempts.
  pending.loginOtpHash = hash;
  return sendPending(pending, otp, send);
}

async function consume(req) {
  assertRequest(req);
  const email = req.body.email.trim().toLowerCase();
  const browserHash = challengeHash(req);
  // Reserve an attempt before comparing the code so parallel guesses share
  // the same persistent five-attempt limit.
  const pending = await User.findOneAndUpdate({
    email,
    loginOtpChallengeHash: browserHash,
    loginOtpExpires: { $gt: new Date() },
    $or: [{ loginOtpAttempts: { $lt: MAX_ATTEMPTS } }, { loginOtpAttempts: null }],
  }, { $inc: { loginOtpAttempts: 1 } }, { returnDocument: "after" }).select(PRIVATE_FIELDS);
  if (!pending || !isAccountEnabled(pending) || pending.emailVerified === false
    || pending.loginOtpPasswordVersion !== passwordVersion(pending)) {
    throw failure("Your verification request expired or reached its attempt limit. Please sign in again.", 400, { restartLogin: true });
  }
  const supplied = otpHash(email, req.body.otp.trim());
  if (typeof pending.loginOtpHash !== "string" || !/^[a-f0-9]{64}$/.test(pending.loginOtpHash)
    || !crypto.timingSafeEqual(Buffer.from(pending.loginOtpHash, "hex"), Buffer.from(supplied, "hex"))) {
    throw failure(pending.loginOtpAttempts >= MAX_ATTEMPTS
      ? "Too many verification attempts. Please wait before signing in again."
      : "The code is incorrect. Use the newest code in your inbox.", 400, { restartLogin: pending.loginOtpAttempts >= MAX_ATTEMPTS });
  }
  const user = await User.findOneAndUpdate({
    _id: pending._id,
    passwordHash: pending.passwordHash,
    loginOtpHash: pending.loginOtpHash,
    loginOtpChallengeHash: browserHash,
    loginOtpExpires: { $gt: new Date() },
  }, { $unset: CLEAR_FIELDS }, { returnDocument: "after" });
  if (!user || !isAccountEnabled(user) || user.emailVerified === false) {
    throw failure("Your verification request expired. Please sign in again.", 400, { restartLogin: true });
  }
  return { user, rememberMe: Boolean(pending.loginOtpRememberMe) };
}

function sendError(res, error) {
  if (!error.statusCode) return false;
  if (error.restartLogin) clearCookie(res);
  if (error.retryAfter) res.set?.("Retry-After", String(error.retryAfter));
  res.status(error.statusCode).json({ error: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}), ...(error.restartLogin ? { restartLogin: true } : {}) });
  return true;
}

module.exports = { begin, resend, consume, clearCookie, sendError, COOKIE_NAME, _private: { otpHash, digest, passwordVersion, challengeHash, CLEAR_FIELDS, MAX_ATTEMPTS } };

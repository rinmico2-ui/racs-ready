"use strict";

const crypto = require("crypto");
const EmailOutbox = require("../models/EmailOutbox");
const logger = require("./logger").create("email-outbox");

const ALGORITHM = "aes-256-gcm";
const MAX_ATTEMPTS = Number(process.env.EMAIL_OUTBOX_MAX_ATTEMPTS) || 5;
const LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let timer = null;
let ticking = false;

function encryptionKey(secret = process.env.EMAIL_OUTBOX_SECRET || process.env.JWT_SECRET) {
  if (!secret) throw new Error("EMAIL_OUTBOX_SECRET or JWT_SECRET is required");
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encryptPayload(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    payloadCiphertext: ciphertext.toString("base64"),
    payloadIv: iv.toString("base64"),
    payloadTag: cipher.getAuthTag().toString("base64"),
    payloadKeyId: keyId(process.env.EMAIL_OUTBOX_SECRET || process.env.JWT_SECRET),
  };
}

function decryptPayload(job) {
  const current = process.env.EMAIL_OUTBOX_SECRET || process.env.JWT_SECRET;
  const previous = process.env.EMAIL_OUTBOX_PREVIOUS_SECRET;
  const until = Date.parse(process.env.EMAIL_OUTBOX_PREVIOUS_SECRET_UNTIL || "");
  const candidates = [current];
  // A previous key is only a temporary reader for jobs queued before rotation.
  if (previous && until > Date.now() && until <= Date.now() + 7 * 86400000) candidates.push(previous);
  for (const secret of candidates) {
    if (job.payloadKeyId && job.payloadKeyId !== keyId(secret)) continue;
    try { return decryptWithKey(job, secret); } catch { /* Try the bounded previous key. */ }
  }
  throw new Error("Unable to decrypt queued email. Check the outbox key rotation settings.");
}

function keyId(secret) {
  return crypto.createHash("sha256").update(`outbox-key-id:${secret}`).digest("hex").slice(0, 24);
}

function decryptWithKey(job, secret) {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    encryptionKey(secret),
    Buffer.from(job.payloadIv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(job.payloadTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(job.payloadCiphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

function recipientHash(to) {
  return crypto.createHash("sha256").update(String(to || "").toLowerCase()).digest("hex");
}

async function enqueueEmail(payload) {
  const normalized = {
    to: payload.to,
    subject: String(payload.subject || "").slice(0, 300),
    html: payload.html || "",
    text: payload.text || "",
    source: String(payload.source || "application").slice(0, 80),
    ...(payload.validUntil ? { validUntil: payload.validUntil } : {}),
    ...(payload.loginOtp ? { loginOtp: payload.loginOtp } : {}),
    ...(payload.bookingReminder ? { bookingReminder: payload.bookingReminder } : {}),
  };
  const encrypted = encryptPayload(normalized);
  const job = await EmailOutbox.create({
    ...encrypted,
    recipientHash: recipientHash(normalized.to),
    source: normalized.source,
    status: "pending",
    nextAttemptAt: new Date(),
  });
  return { queued: true, messageId: `outbox-${job._id}`, provider: "outbox" };
}

async function claimJob() {
  const now = new Date();
  const staleLock = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  return EmailOutbox.findOneAndUpdate(
    {
      $or: [
        { status: "pending", nextAttemptAt: { $lte: now } },
        { status: "processing", lockedAt: { $lte: staleLock } },
      ],
    },
    {
      $set: { status: "processing", lockedAt: now },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  ).select("+payloadCiphertext +payloadIv +payloadTag");
}

function retryDelayMs(attempts) {
  return Math.min(15 * 60 * 1000, 5000 * (2 ** Math.max(0, attempts - 1)));
}

async function cancellationReason(payload, now = Date.now()) {
  if (payload.validUntil && !(Date.parse(payload.validUntil) > now)) return payload.source === 'service-reminder' ? 'Appointment reminder expired before delivery.' : "Verification email expired before delivery.";
  if (payload.source === 'service-reminder' && payload.bookingReminder) {
    const reminder = payload.bookingReminder;
    if (!['customerReminder24hFor', 'customerReminder2hFor'].includes(reminder.marker) ||
        !Number.isFinite(Date.parse(reminder.bookingDate)) || !Number.isFinite(Date.parse(reminder.scheduledFor)) ||
        Date.parse(reminder.scheduledFor) <= now) return 'Appointment reminder is no longer current.';
    const BookingService = require('../models/BookingService');
    const active = await BookingService.exists({ _id: reminder.bookingId, testDataExcludedAt: null,
      status: { $in: ['confirmed', 'scheduled', 'repair_scheduled', 'inspection_scheduled'] },
      bookingDate: new Date(reminder.bookingDate), startTime: reminder.startTime,
      [reminder.marker]: new Date(reminder.scheduledFor) });
    return active ? '' : 'Appointment was rescheduled, cancelled, or is no longer confirmed.';
  }
  if (payload.source !== "login_otp") return "";
  // Old jobs from before browser-bound challenges cannot complete a new login.
  if (!payload.loginOtp?.userId || !payload.loginOtp.hash || !payload.validUntil) return "Login verification request was replaced or expired.";
  const User = require("../models/User");
  const active = await User.exists({
    _id: payload.loginOtp.userId,
    loginOtpHash: payload.loginOtp.hash,
    loginOtpExpires: { $gt: new Date(now) },
    $or: [{ loginOtpAttempts: { $lt: 5 } }, { loginOtpAttempts: null }],
  });
  return active ? "" : "Login verification request was replaced or completed.";
}

async function processOne() {
  const job = await claimJob();
  if (!job) return false;
  try {
    const payload = decryptPayload(job);
    const reason = await cancellationReason(payload);
    if (reason) {
      await EmailOutbox.updateOne({ _id: job._id, status: "processing" }, {
        $set: { status: "cancelled", lockedAt: null, lastError: reason, expiresAt: new Date(Date.now() + RETENTION_MS) },
        $unset: { payloadCiphertext: 1, payloadIv: 1, payloadTag: 1 },
      });
      return true;
    }
    // Lazy import prevents a module cycle while mailer.sendMail delegates new
    // production messages to this outbox.
    const mailer = require("./mailer");
    const delivery = await mailer.deliverMailNow(payload);
    await EmailOutbox.updateOne({ _id: job._id, status: "processing" }, {
      $set: {
        status: "sent",
        sentAt: new Date(),
        provider: delivery.provider,
        providerMessageId: delivery.messageId,
        lockedAt: null,
        expiresAt: new Date(Date.now() + RETENTION_MS),
        lastError: "",
      },
      $unset: { payloadCiphertext: 1, payloadIv: 1, payloadTag: 1 },
    });
  } catch (error) {
    const exhausted = job.attempts >= MAX_ATTEMPTS;
    await EmailOutbox.updateOne({ _id: job._id, status: "processing" }, {
      $set: {
        status: exhausted ? "failed" : "pending",
        lockedAt: null,
        lastError: String(error?.message || error).slice(0, 500),
        nextAttemptAt: new Date(Date.now() + retryDelayMs(job.attempts)),
        ...(exhausted ? { expiresAt: new Date(Date.now() + RETENTION_MS) } : {}),
      },
      ...(exhausted ? { $unset: { payloadCiphertext: 1, payloadIv: 1, payloadTag: 1 } } : {}),
    });
    logger.warn("Email job %s attempt %d failed: %s", job._id, job.attempts, error?.message);
  }
  return true;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const concurrency = Math.min(10, Math.max(1, Number(process.env.EMAIL_OUTBOX_CONCURRENCY) || 2));
    await Promise.all(Array.from({ length: concurrency }, () => processOne()));
  } catch (error) {
    logger.error("Email outbox tick failed: %s", error?.message);
  } finally {
    ticking = false;
  }
}

function startEmailOutboxWorker() {
  if (timer) return;
  const intervalMs = Math.max(500, Number(process.env.EMAIL_OUTBOX_POLL_MS) || 1000);
  timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
}

function stopEmailOutboxWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  enqueueEmail,
  startEmailOutboxWorker,
  stopEmailOutboxWorker,
  _private: { decryptPayload, encryptPayload, recipientHash, retryDelayMs, cancellationReason, processOne },
};

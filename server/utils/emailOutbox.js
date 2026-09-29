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

function encryptionKey() {
  const secret = process.env.EMAIL_OUTBOX_SECRET || process.env.JWT_SECRET;
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
  };
}

function decryptPayload(job) {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    encryptionKey(),
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

async function processOne() {
  const job = await claimJob();
  if (!job) return false;
  try {
    const payload = decryptPayload(job);
    // Lazy import prevents a module cycle while mailer.sendMail delegates new
    // production messages to this outbox.
    const mailer = require("./mailer");
    await mailer.deliverMailNow(payload);
    await EmailOutbox.updateOne({ _id: job._id, status: "processing" }, {
      $set: {
        status: "sent",
        sentAt: new Date(),
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
  _private: { decryptPayload, encryptPayload, recipientHash, retryDelayMs },
};

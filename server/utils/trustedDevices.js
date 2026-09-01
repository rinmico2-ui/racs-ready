const crypto = require("crypto");
const uaParser = require("ua-parser-js");
const TrustedDevice = require("../models/TrustedDevice");

const COOKIE_NAME = "technician_trusted_device";
const DEFAULT_TRUST_DAYS = 30;
const MAX_TRUST_DAYS = 90;
const MAX_ACTIVE_DEVICES = 5;

function trustDurationMs() {
  const configured = Number(process.env.TECHNICIAN_TRUSTED_DEVICE_DAYS);
  const days = Number.isFinite(configured)
    ? Math.min(Math.max(Math.floor(configured), 1), MAX_TRUST_DAYS)
    : DEFAULT_TRUST_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function requestToken(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const header = String((req.headers && req.headers.cookie) || "");
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    if (key === COOKIE_NAME) {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    }
  }
  return "";
}

function requestIp(req) {
  const forwarded = req.headers && req.headers["x-forwarded-for"];
  const value =
    req.ip ||
    (Array.isArray(forwarded) ? forwarded[0] : String(forwarded || "").split(",")[0]) ||
    (req.connection && req.connection.remoteAddress) ||
    "";
  return String(value).trim().slice(0, 128);
}

function requestUserAgent(req) {
  return String((req.headers && req.headers["user-agent"]) || "").slice(0, 512);
}

function deviceLabel(userAgent) {
  const parsed = uaParser(userAgent || "");
  const browser = parsed.browser && parsed.browser.name;
  const os = parsed.os && parsed.os.name;
  const device =
    (parsed.device && (parsed.device.model || parsed.device.type)) || "Device";
  return [device, browser, os].filter(Boolean).join(" / ").slice(0, 160);
}

function cookieOptions(maxAge = trustDurationMs()) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Strict",
    maxAge,
    path: "/",
  };
}

function clearCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Strict",
    path: "/",
  });
}

async function issue(req, res, user) {
  if (!user || user.role !== "technician") return null;
  const token = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + trustDurationMs());
  const userAgent = requestUserAgent(req);
  const existingToken = requestToken(req);
  const existingRecord = existingToken
    ? await TrustedDevice.findOne({
        userId: user._id,
        tokenHash: hashToken(existingToken),
        revokedAt: null,
        expiresAt: { $gt: now },
      }).select("+tokenHash")
    : null;

  let record;
  if (existingRecord) {
    existingRecord.tokenHash = hashToken(token);
    existingRecord.label = deviceLabel(userAgent);
    existingRecord.userAgent = userAgent;
    existingRecord.lastUsedIp = requestIp(req);
    existingRecord.passwordChangedAt = user.lastPasswordChange || undefined;
    existingRecord.lastUsedAt = now;
    existingRecord.expiresAt = expiresAt;
    record = await existingRecord.save();
  } else {
    record = await TrustedDevice.create({
      userId: user._id,
      tokenHash: hashToken(token),
      label: deviceLabel(userAgent),
      userAgent,
      createdIp: requestIp(req),
      lastUsedIp: requestIp(req),
      passwordChangedAt: user.lastPasswordChange || undefined,
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
    });
  }

  const extras = await TrustedDevice.find({
    userId: user._id,
    revokedAt: null,
    expiresAt: { $gt: now },
  })
    .sort({ lastUsedAt: -1 })
    .skip(MAX_ACTIVE_DEVICES)
    .select("_id")
    .lean();
  if (extras.length) {
    await TrustedDevice.updateMany(
      { _id: { $in: extras.map((item) => item._id) } },
      { $set: { revokedAt: now } },
    );
  }

  res.cookie(COOKIE_NAME, token, cookieOptions());
  return record;
}

async function validateAndRotate(req, res, user) {
  if (!user || user.role !== "technician") return false;
  const token = requestToken(req);
  if (!token) return false;

  const now = new Date();
  const currentHash = hashToken(token);
  const record = await TrustedDevice.findOne({
    userId: user._id,
    tokenHash: currentHash,
    revokedAt: null,
    expiresAt: { $gt: now },
  }).select("+tokenHash");

  if (!record) {
    clearCookie(res);
    return false;
  }

  const currentLabel = deviceLabel(requestUserAgent(req));
  if (record.label && currentLabel !== record.label) {
    record.revokedAt = now;
    await record.save();
    clearCookie(res);
    return false;
  }

  const passwordChangedAt = user.lastPasswordChange
    ? new Date(user.lastPasswordChange).getTime()
    : 0;
  const trustedPasswordAt = record.passwordChangedAt
    ? new Date(record.passwordChangedAt).getTime()
    : 0;
  if (passwordChangedAt && trustedPasswordAt < passwordChangedAt) {
    record.revokedAt = now;
    await record.save();
    clearCookie(res);
    return false;
  }

  const rotatedToken = newToken();
  const update = await TrustedDevice.updateOne(
    { _id: record._id, tokenHash: currentHash, revokedAt: null },
    {
      $set: {
        tokenHash: hashToken(rotatedToken),
        lastUsedAt: now,
        lastUsedIp: requestIp(req),
        userAgent: requestUserAgent(req),
      },
    },
  );
  if (!update || update.modifiedCount !== 1) {
    clearCookie(res);
    return false;
  }

  const remaining = Math.max(0, new Date(record.expiresAt).getTime() - now.getTime());
  if (!remaining) {
    clearCookie(res);
    return false;
  }
  res.cookie(COOKIE_NAME, rotatedToken, cookieOptions(remaining));
  return true;
}

async function list(req, user) {
  const currentHash = requestToken(req) ? hashToken(requestToken(req)) : "";
  const records = await TrustedDevice.find({
    userId: user._id,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .select("+tokenHash label createdAt lastUsedAt expiresAt lastUsedIp")
    .sort({ lastUsedAt: -1 })
    .lean();
  return records.map((record) => ({
    id: record._id,
    label: record.label || "Trusted device",
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    lastUsedIp: record.lastUsedIp || "",
    current: Boolean(currentHash && record.tokenHash === currentHash),
  }));
}

async function revoke(req, res, user, deviceId) {
  const record = await TrustedDevice.findOne({
    _id: deviceId,
    userId: user._id,
    revokedAt: null,
  }).select("+tokenHash");
  if (!record) return false;
  const currentToken = requestToken(req);
  if (currentToken && hashToken(currentToken) === record.tokenHash) clearCookie(res);
  record.revokedAt = new Date();
  await record.save();
  return true;
}

async function revokeAll(res, userId) {
  await TrustedDevice.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  if (res) clearCookie(res);
}

module.exports = {
  COOKIE_NAME,
  issue,
  validateAndRotate,
  list,
  revoke,
  revokeAll,
  _private: { hashToken, trustDurationMs, deviceLabel },
};

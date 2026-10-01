"use strict";

const crypto = require("crypto");
const { isIP } = require("node:net");
const { ipKeyGenerator } = require("express-rate-limit");

function userIdOf(req) {
  const value = req?.user?._id || req?.session?.userId;
  return value ? String(value) : "";
}

function normalizedIpKey(req) {
  const candidate = String(req?.ip || "");
  const remote = String(req?.socket?.remoteAddress || "");
  // Invalid forwarding values must not create long or arbitrary counter keys.
  const ip = isIP(candidate) ? candidate : isIP(remote) ? remote : "unknown";
  return `ip:${ipKeyGenerator(ip)}`;
}

function authenticatedOrIpKey(req) {
  const userId = userIdOf(req);
  return userId ? `user:${userId}` : normalizedIpKey(req);
}

function emailOrIpKey(req) {
  const email = String(req?.body?.email || "").trim().toLowerCase();
  if (!email) return normalizedIpKey(req);
  // Keep rate-limit store keys bounded and avoid retaining email addresses in
  // process/store metadata.
  const digest = crypto.createHash("sha256").update(email).digest("hex");
  return `email:${digest}`;
}

function generalApiLimit(req) {
  return userIdOf(req)
    ? Number(process.env.AUTHENTICATED_API_RATE_LIMIT) || 300
    : Number(process.env.ANONYMOUS_API_RATE_LIMIT) || 100;
}

module.exports = {
  authenticatedOrIpKey,
  emailOrIpKey,
  generalApiLimit,
  normalizedIpKey,
  userIdOf,
};

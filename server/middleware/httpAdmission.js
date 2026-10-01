"use strict";

const { normalizedIpKey } = require("../utils/rateLimitIdentity");
const { createBoundedWindow, positiveLimit } = require("../utils/boundedWindow");

function createHttpAdmission(options = {}) {
  const maxActive = positiveLimit(options.maxActive ?? process.env.HTTP_MAX_CONCURRENT_REQUESTS, 128);
  const maxPerIp = positiveLimit(options.maxPerIp ?? process.env.HTTP_MAX_CONCURRENT_PER_IP, 64);
  const maxLargeBodies = positiveLimit(options.maxLargeBodies ?? process.env.HTTP_MAX_LARGE_BODY_REQUESTS, 4);
  const limiter = createBoundedWindow({
    limit: positiveLimit(options.rateLimit ?? process.env.HTTP_PER_IP_RATE_LIMIT, 1200),
    windowMs: 60000,
    maxKeys: positiveLimit(options.maxKeys ?? process.env.HTTP_RATE_LIMIT_MAX_KEYS, 10000),
    now: options.now || Date.now,
  });
  const activeByIp = new Map();
  const rejected = { rate: 0, capacity: 0, payload: 0 };
  let active = 0;
  let largeBodies = 0;

  function reject(req, res, status, reason, error, retryAfter) {
    req.admissionRejected = true;
    rejected[reason] += 1;
    res.setHeader("Cache-Control", "no-store");
    if (retryAfter) res.setHeader("Retry-After", String(retryAfter));
    return res.status(status).json({ error });
  }

  function admission(req, res, next) {
    const ip = normalizedIpKey(req);
    const budget = limiter.consume(ip);
    if (!budget.allowed) return reject(req, res, 429, "rate", "Too many requests. Please wait and try again.", budget.retryAfter);

    const contentLength = Number(req.headers["content-length"] || 0);
    const path = String(req.path || "/").toLowerCase();
    const bodyLimit = /^\/api\/auth(?:\/|$)/.test(path) ? 64 * 1024
      : /^\/api\/chat(?:\/|$)/.test(path) ? 256 * 1024 : null;
    if (bodyLimit && contentLength > bodyLimit) return reject(req, res, 413, "payload", "Request body is too large.");

    // Legacy JSON payment proofs still need a larger parser limit. Admit only
    // a few large or chunked JSON/form bodies together so they cannot all be
    // buffered in memory at once. Multipart files are streamed separately.
    const bufferedBody = /^(?:application\/json|application\/x-www-form-urlencoded)(?:\s*;|$)/i.test(req.headers["content-type"] || "");
    const largeBody = bufferedBody && (contentLength > 256 * 1024 || Boolean(req.headers["transfer-encoding"]));
    const ipActive = activeByIp.get(ip) || 0;
    if (active >= maxActive || ipActive >= maxPerIp || (largeBody && largeBodies >= maxLargeBodies)) {
      return reject(req, res, 503, "capacity", "The service is busy. Please try again in a few seconds.", 3);
    }
    active += 1;
    if (largeBody) largeBodies += 1;
    activeByIp.set(ip, ipActive + 1);
    let released = false;
    function release() {
      if (released) return;
      released = true;
      active -= 1;
      if (largeBody) largeBodies -= 1;
      const remaining = (activeByIp.get(ip) || 1) - 1;
      if (remaining) activeByIp.set(ip, remaining);
      else activeByIp.delete(ip);
    }
    res.once("finish", release);
    res.once("close", release);
    next();
  }
  admission.snapshot = () => ({ active, largeBodies, trackedIps: limiter.size, rejected: { ...rejected } });
  return admission;
}

module.exports = { createHttpAdmission };

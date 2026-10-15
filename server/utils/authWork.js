"use strict";
const { createWorkLimiter } = require("./workLimiter");
const { positiveLimit } = require("./boundedWindow");
const { normalizedIpKey } = require("./rateLimitIdentity");
const work = createWorkLimiter({
  limit: positiveLimit(process.env.AUTH_MAX_CONCURRENT_REQUESTS, 8),
  perKeyLimit: positiveLimit(process.env.AUTH_MAX_CONCURRENT_PER_IP, 4),
});
function limitAuthWork(handler) {
  return (req, res, next) => work.run(normalizedIpKey(req), () => handler(req, res, next)).catch(error => {
    if (error.code !== "WORK_CAPACITY_EXCEEDED") return next(error);
    res.set("Retry-After", "3");
    return res.status(503).json({ error: "Sign-in services are busy. Please try again in a few seconds.", code: "AUTH_CAPACITY_EXCEEDED" });
  });
}
module.exports = { limitAuthWork };

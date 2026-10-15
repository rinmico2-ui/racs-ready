"use strict";
const mongoose = require("mongoose");
const { normalizedIpKey } = require("../utils/rateLimitIdentity");
const { createBoundedWindow, positiveLimit } = require("../utils/boundedWindow");
const { consumeSecurityBudget } = require("../utils/securityRateBudget");
const { createWorkLimiter } = require("../utils/workLimiter");
const audit = require("../utils/audit");

function createAuthAdmission(options = {}) {
  const now = options.now || Date.now;
  const env = options.env || process.env;
  const consume = options.consume || consumeSecurityBudget;
  const rules = {
    signup: [
      { windowMs: 60000, limit: positiveLimit(env.SIGNUP_IP_MINUTE_LIMIT, 5) },
      { windowMs: 900000, limit: positiveLimit(env.SIGNUP_IP_WINDOW_LIMIT, 20) },
    ],
    email: [
      { windowMs: 60000, limit: positiveLimit(env.AUTH_EMAIL_IP_MINUTE_LIMIT, 5) },
      { windowMs: 900000, limit: positiveLimit(env.AUTH_EMAIL_IP_WINDOW_LIMIT, 20) },
    ],
  };
  const local = Object.fromEntries(Object.entries(rules).map(([category, budgets]) => [category,
    budgets.map(rule => createBoundedWindow({ ...rule, maxKeys: 10000, now })),
  ]));
  const logWindow = createBoundedWindow({ limit: 1, windowMs: 60000, maxKeys: 1000, now });
  const logWork = createWorkLimiter({ limit: 2, perKeyLimit: 1 });
  function reject(req, res, category, retryAfter) {
    res.set("Cache-Control", "no-store");
    res.set("Retry-After", String(retryAfter));
    const ip = normalizedIpKey(req);
    if (mongoose.connection.readyState === 1 && logWindow.consume(`${category}:${ip}`).allowed) {
      void logWork.run(ip, () => audit.logEvent({ action: "AUTH_TRAFFIC_BLOCKED", module: "security", riskLevel: "medium", outcome: "blocked", req,
        details: { category, retryAfterSeconds: retryAfter },
      })).catch(() => {});
    }
    return res.status(429).json({ error: category === "signup"
      ? "Too many account creation requests from this network. Please wait before trying again."
      : "Too many email verification requests from this network. Please wait before trying again.",
      code: "AUTH_TRAFFIC_LIMIT", retryAfter,
    });
  }
  return async function authAdmission(req, res, next) {
    const path = String(req.originalUrl || req.path || "").split("?", 1)[0].replace(/\/+$/, "").toLowerCase();
    if (req.method !== "POST") return next();
    const category = ["/api/auth/register", "/api/auth/google/complete-signup"].includes(path) ? "signup"
      : ["/api/auth/forgot-password", "/api/auth/resend-register-otp", "/api/auth/resend-login-otp"].includes(path) ? "email" : null;
    if (!category) return next();
    const key = normalizedIpKey(req);
    for (const limiter of local[category]) {
      const result = limiter.consume(key);
      if (!result.allowed) return reject(req, res, category, result.retryAfter);
    }
    try {
      for (const rule of rules[category]) {
        const result = await consume({ ...rule, category: `auth-${category}-${rule.windowMs}`, key, now: now() });
        if (!result.allowed) return reject(req, res, category, result.retryAfter);
      }
      return next();
    } catch {
      res.set("Retry-After", "5");
      return res.status(503).json({ error: "Account security checks are temporarily unavailable. Please try again shortly.", code: "SECURITY_CHECK_UNAVAILABLE" });
    }
  };
}
module.exports = { createAuthAdmission };

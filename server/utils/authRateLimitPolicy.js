"use strict";

// Only credential-changing or credential-verification endpoints belong in the
// strict authentication-attempt bucket. Session reads, logout, OAuth redirects,
// and operational endpoints must not consume failed-login capacity.
const AUTH_ATTEMPT_ROUTES = new Set([
  "POST /register",
  "POST /verify-register-otp",
  "POST /resend-register-otp",
  "POST /login",
  "POST /verify-login-otp",
  "POST /resend-login-otp",
  "POST /forgot-password",
  "POST /reset-password",
  "POST /activate-invited-account",
  "POST /secure/login",
]);

const SESSION_LIFECYCLE_ROUTES = new Set([
  "GET /api/auth/verify",
  "POST /api/auth/logout",
  "POST /api/auth/secure/logout",
]);

function pathnameOf(req) {
  const raw = String(req?.originalUrl || req?.url || req?.path || "/");
  const pathname = raw.split("?", 1)[0] || "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function authRelativePath(req) {
  let pathname = pathnameOf(req).replace(/\/+$/, "") || "/";
  if (pathname.startsWith("/api/auth")) pathname = pathname.slice("/api/auth".length) || "/";
  else if (pathname.startsWith("/auth")) pathname = pathname.slice("/auth".length) || "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function shouldLimitAuthAttempt(req) {
  const method = String(req?.method || "GET").toUpperCase();
  return AUTH_ATTEMPT_ROUTES.has(`${method} ${authRelativePath(req)}`);
}

function shouldSkipAuthAttemptLimit(req) {
  return !shouldLimitAuthAttempt(req);
}

function shouldSkipGeneralApiLimit(req) {
  const method = String(req?.method || "GET").toUpperCase();
  return SESSION_LIFECYCLE_ROUTES.has(`${method} ${pathnameOf(req).replace(/\/+$/, "") || "/"}`);
}

module.exports = {
  authRelativePath,
  pathnameOf,
  shouldLimitAuthAttempt,
  shouldSkipAuthAttemptLimit,
  shouldSkipGeneralApiLimit,
};

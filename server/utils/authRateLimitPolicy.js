"use strict";

// Only credential-changing or credential-verification endpoints belong in the
// strict authentication-attempt bucket. Session reads, logout, OAuth redirects,
// and operational endpoints must not consume failed-login capacity.
const AUTH_ATTEMPT_ROUTES = new Set([
  "POST /login",
  "POST /verify-login-otp",
  "POST /resend-login-otp",
  "POST /forgot-password",
  "POST /reset-password",
  "POST /activate-invited-account",
  "POST /secure/login",
]);

// Registration has its own limits. Keeping these routes out of the strict
// login bucket prevents unrelated customers on the same NAT/public IP from
// consuming one another's ten-attempt login allowance.
const REGISTRATION_ATTEMPT_ROUTES = new Set([
  "POST /register",
  "POST /verify-register-otp",
  "POST /resend-register-otp",
]);
const REGISTRATION_BURST_ROUTES = new Set([
  "POST /register",
  "POST /google/complete-signup",
]);

const GENERAL_API_LIMIT_EXEMPT_ROUTES = new Set([
  "GET /api/auth/verify",
  "POST /api/auth/logout",
  "POST /api/auth/secure/logout",
  // Login has dedicated per-account and IP limits downstream. The general
  // anonymous API bucket is shared by students behind one school NAT.
  "POST /api/auth/login",
  "POST /api/auth/secure/login",
  "POST /api/auth/verify-login-otp",
  "POST /api/auth/resend-login-otp",
  // Registration has dedicated per-email and signup IP limits downstream.
  "POST /api/auth/register",
  "POST /api/auth/verify-register-otp",
  "POST /api/auth/resend-register-otp",
  "POST /api/auth/google/complete-signup",
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

function shouldLimitRegistrationAttempt(req) {
  const method = String(req?.method || "GET").toUpperCase();
  return REGISTRATION_ATTEMPT_ROUTES.has(`${method} ${authRelativePath(req)}`);
}

function shouldSkipRegistrationAttemptLimit(req) {
  return !shouldLimitRegistrationAttempt(req);
}

function shouldSkipRegistrationBurstLimit(req) {
  // A student should not consume the school-wide signup allowance again when
  // verifying or resending the code for an account already created.
  const method = String(req?.method || "GET").toUpperCase();
  return !REGISTRATION_BURST_ROUTES.has(`${method} ${authRelativePath(req)}`);
}

function shouldSkipGeneralApiLimit(req) {
  const method = String(req?.method || "GET").toUpperCase();
  return GENERAL_API_LIMIT_EXEMPT_ROUTES.has(
    `${method} ${pathnameOf(req).replace(/\/+$/, "") || "/"}`,
  );
}

module.exports = {
  authRelativePath,
  pathnameOf,
  shouldLimitAuthAttempt,
  shouldSkipAuthAttemptLimit,
  shouldLimitRegistrationAttempt,
  shouldSkipRegistrationAttemptLimit,
  shouldSkipRegistrationBurstLimit,
  shouldSkipGeneralApiLimit,
};

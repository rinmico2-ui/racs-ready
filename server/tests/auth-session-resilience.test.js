"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  shouldLimitAuthAttempt,
  shouldSkipAuthAttemptLimit,
  shouldSkipGeneralApiLimit,
} = require("../utils/authRateLimitPolicy");

const read = relativePath => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
const request = (method, originalUrl) => ({ method, originalUrl });

test("strict auth throttling applies only to credential attempts", () => {
  assert.equal(shouldLimitAuthAttempt(request("POST", "/api/auth/login")), true);
  assert.equal(shouldLimitAuthAttempt(request("POST", "/api/auth/verify-login-otp")), true);
  assert.equal(shouldLimitAuthAttempt(request("POST", "/api/auth/reset-password")), true);
  assert.equal(shouldLimitAuthAttempt(request("GET", "/api/auth/verify")), false);
  assert.equal(shouldLimitAuthAttempt(request("GET", "/api/auth/google")), false);
  assert.equal(shouldLimitAuthAttempt(request("GET", "/api/auth/google/callback?code=x")), false);
  assert.equal(shouldLimitAuthAttempt(request("POST", "/api/auth/logout")), false);
  assert.equal(shouldLimitAuthAttempt(request("POST", "/api/auth/technician/location")), false);
  assert.equal(shouldSkipAuthAttemptLimit(request("GET", "/api/auth/verify")), true);
});

test("session verification and logout bypass the general API budget", () => {
  assert.equal(shouldSkipGeneralApiLimit(request("GET", "/api/auth/verify")), true);
  assert.equal(shouldSkipGeneralApiLimit(request("POST", "/api/auth/logout")), true);
  assert.equal(shouldSkipGeneralApiLimit(request("POST", "/api/auth/secure/logout")), true);
  assert.equal(shouldSkipGeneralApiLimit(request("POST", "/api/bookings/create-new")), false);
});

test("booking UI does not convert transient verification failures into logout", () => {
  const services = read("public/js/services-multi.js");
  assert.match(services, /if \(!response\.ok\) return null/);
  assert.match(services, /if \(active === false\) lockBookingAfterLogout\(\)/);
  assert.doesNotMatch(services, /if \(!active\) lockBookingAfterLogout\(\)/);
  assert.match(services, /BOOKING_SESSION_CHECK_CACHE_MS = 5000/);
  assert.match(services, /if \(bookingSessionCheckPromise\) return bookingSessionCheckPromise/);
});

test("customer logout redirects only after a successful server response", () => {
  const navbar = read("public/js/navbar-auth.js");
  const successCheck = navbar.indexOf("if (!response.ok)");
  const logoutEvent = navbar.indexOf('window.dispatchEvent(new Event("racs:logout"))');
  const redirect = navbar.indexOf('window.location.replace("/login?logged_out=1")');
  assert.ok(successCheck > -1 && successCheck < logoutEvent);
  assert.ok(logoutEvent < redirect);
  assert.match(navbar, /logoutBtn\.disabled = false/);
  assert.match(navbar, /Sign out did not finish/);
});

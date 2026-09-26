"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const User = require("../models/User");
const audit = require("../utils/audit");
const router = require("../routes/userRoutes");

const profileRoute = router.stack.find((layer) => layer.route && layer.route.path === "/me/profile");
const updateProfile = profileRoute.route.stack[0].handle;

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("customer profile saves name, phone, and address on the account", async () => {
  const originalFind = User.findById;
  const originalAudit = audit.logEvent;
  const user = {
    _id: "customer-id",
    firstName: "Old",
    lastName: "Name",
    phone: "09170000000",
    email: "customer@example.com",
    address: { province: "Old Province", city: "Old City" },
    async save() { this.saved = true; },
  };
  User.findById = async () => user;
  audit.logEvent = async () => {};
  try {
    const res = response();
    await updateProfile({
      user: { _id: user._id },
      body: {
        firstName: "New",
        lastName: "Customer",
        phone: "09171234567",
        address: {
          province: "Nueva Ecija",
          city: "Cabanatuan",
          barangay: "Sumacab Sur",
          postalCode: "3100",
        },
      },
    }, res, (error) => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(user.saved, true);
    assert.equal(user.address.city, "Cabanatuan");
    assert.equal(res.body.user.address.postalCode, "3100");
    assert.equal(user.email, "customer@example.com");
  } finally {
    User.findById = originalFind;
    audit.logEvent = originalAudit;
  }
});

test("customer profile rejects a malformed address before saving", async () => {
  const res = response();
  await updateProfile({
    user: { _id: "customer-id" },
    body: {
      firstName: "New",
      lastName: "Customer",
      phone: "09171234567",
      address: { province: "Nueva Ecija", city: "Cabanatuan", postalCode: "12345" },
    },
  }, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /ZIP code/);
});

test("customer editor submits to the profile API instead of browser-only storage", () => {
  const script = fs.readFileSync(path.join(__dirname, "../public/js/profile.js"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "../views/pages/profile.ejs"), "utf8");
  assert.match(script, /fetch\("\/api\/users\/me\/profile"/);
  assert.doesNotMatch(script, /localStorage\.setItem\("profile_ui_overrides"/);
  assert.match(page, /id="saveProfileBtn" type="submit" form="customerProfileForm"/);
  assert.match(page, /id="profileEmail"[^>]*readonly/);
});

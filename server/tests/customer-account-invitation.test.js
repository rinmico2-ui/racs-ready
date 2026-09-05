"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const User = require("../models/User");
const audit = require("../utils/audit");
const authController = require("../controllers/authController");
const authRoutes = require("../routes/authRoutes");
const {
  CustomerInvitationError,
  hashInvitationToken,
  normalizeInvitationEmail,
  provisionWalkInCustomer,
} = require("../utils/customerAccountInvitation");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    cleared: [],
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    clearCookie(name, options) { this.cleared.push({ name, options }); return this; },
  };
}

test("walk-in customer email normalization is strict and stable", () => {
  assert.equal(normalizeInvitationEmail(" Customer@Example.COM "), "customer@example.com");
  assert.equal(normalizeInvitationEmail("invalid"), "");
  assert.equal(hashInvitationToken("token"), hashInvitationToken("token"));
  assert.notEqual(hashInvitationToken("token"), "token");
});

test("provisioning refuses silent account creation without customer consent", async () => {
  await assert.rejects(
    provisionWalkInCustomer({ customer: { email: "customer@example.com" }, consent: false }),
    (error) => error instanceof CustomerInvitationError
      && error.code === "CUSTOMER_ACCOUNT_CONSENT_REQUIRED"
      && error.status === 422,
  );
});

test("new walk-in provisioning returns only an activation token, never a password", async () => {
  class FakeUser {
    static findOne() { return Promise.resolve(null); }
    constructor(values) { Object.assign(this, values); }
    async setPassword(value) { this.passwordHash = `hashed:${value.length}`; }
    createAccountInvitationToken() { this.invitationTokenHash = "stored-hash"; return "activation-token"; }
    async save() { this._id = "customer-id"; return this; }
  }
  const result = await provisionWalkInCustomer({
    customer: {
      email: "new.walkin@example.com",
      firstName: "New",
      lastName: "Walkin",
      phone: "09171234567",
      address: { province: "Nueva Ecija", city: "San Leonardo", barangay: "Diversion", postalCode: "3102" },
    },
    consent: true,
    invitedBy: "admin-id",
    UserModel: FakeUser,
  });

  assert.equal(result.created, true);
  assert.equal(result.state, "invited");
  assert.equal(result.activationToken, "activation-token");
  assert.equal(result.user.emailVerified, false);
  assert.equal(result.user.accountStatus, "invited");
  assert.equal(result.user.address.city, "San Leonardo");
  assert.equal(Object.hasOwn(result, "password"), false);
  assert.equal(Object.hasOwn(result, "generatedPassword"), false);
});

test("walk-in provisioning rejects disabled or blocked customer accounts", async () => {
  const blockedCustomer = {
    role: "customer",
    active: true,
    blocked: true,
    emailVerified: true,
  };
  class FakeUser {
    static findOne() { return Promise.resolve(blockedCustomer); }
  }
  await assert.rejects(
    provisionWalkInCustomer({
      customer: { email: "blocked@example.com" },
      consent: true,
      UserModel: FakeUser,
    }),
    (error) => error instanceof CustomerInvitationError
      && error.code === "CUSTOMER_ACCOUNT_UNAVAILABLE"
      && error.status === 409,
  );
});

test("walk-in provisioning completes missing existing-customer details without overwriting profile data", async () => {
  const customer = {
    role: "customer",
    active: true,
    blocked: false,
    emailVerified: true,
    firstName: "Existing",
    lastName: "",
    phone: "",
    address: { province: "Bulacan", city: "", barangay: "", postalCode: "" },
    async save() { this.saved = true; return this; },
  };
  class FakeUser {
    static findOne() { return Promise.resolve(customer); }
  }

  const result = await provisionWalkInCustomer({
    customer: {
      email: "existing@example.com",
      firstName: "Replacement",
      lastName: "Customer",
      phone: "09171234567",
      address: { province: "Pampanga", city: "Malolos", barangay: "Longos", postalCode: "3000" },
    },
    consent: true,
    UserModel: FakeUser,
  });

  assert.equal(result.created, false);
  assert.equal(customer.firstName, "Existing");
  assert.equal(customer.lastName, "Customer");
  assert.equal(customer.phone, "09171234567");
  assert.equal(customer.address.province, "Bulacan");
  assert.equal(customer.address.city, "Malolos");
  assert.equal(customer.saved, true);
});

test("invitation fields are private and tokens expire", () => {
  assert.equal(User.schema.path("invitationTokenHash").options.select, false);
  assert.equal(User.schema.path("invitationExpiresAt").options.select, false);
  const user = new User({
    email: "invited@example.com",
    firstName: "Invited",
    lastName: "Customer",
    phone: "09171234567",
    passwordHash: "unused",
    emailVerified: false,
    accountStatus: "invited",
  });
  const token = user.createAccountInvitationToken();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(user.invitationTokenHash, hashInvitationToken(token));
  assert.ok(user.invitationExpiresAt > new Date());
  assert.doesNotMatch(JSON.stringify(user), new RegExp(token));
});

test("orders retain account-consent evidence without storing invitation credentials", () => {
  const Order = require("../models/Order");
  assert.ok(Order.schema.path("customerAccountAccess.consentedAt"));
  assert.ok(Order.schema.path("customerAccountAccess.capturedBy"));
  assert.ok(Order.schema.path("customerAccountAccess.stateAtCheckout"));
  assert.equal(Order.schema.path("customerAccountAccess.invitationToken"), undefined);
});

test("walk-in appointments retain consent evidence without storing invitation credentials", () => {
  const BookingService = require("../models/BookingService");
  assert.ok(BookingService.schema.path("customerAccountAccess.consentedAt"));
  assert.ok(BookingService.schema.path("customerAccountAccess.capturedBy"));
  assert.ok(BookingService.schema.path("customerAccountAccess.stateAtCheckout"));
  assert.ok(BookingService.schema.path("customerAccountAccess.invitationDelivery"));
  assert.equal(BookingService.schema.path("customerAccountAccess.invitationToken"), undefined);
});

test("walk-in service creation uses the consented invitation contract", () => {
  const routeSource = fs.readFileSync(path.join(__dirname, "../routes/appointmentRoutes.js"), "utf8");
  const walkInRoute = routeSource.match(/router\.post\(\s*"\/walk-in"[\s\S]*?router\.get\("\/:id"/);
  assert.ok(walkInRoute, "expected the walk-in appointment route");
  assert.match(walkInRoute[0], /CUSTOMER_ACCOUNT_CONSENT_REQUIRED/);
  assert.match(walkInRoute[0], /provisionWalkInCustomer/);
  assert.match(walkInRoute[0], /sendWalkInBookingAccountEmail/);
  assert.doesNotMatch(walkInRoute[0], /sendWalkInCredentialsEmail|generatedPassword|resetToken/);
});

test("account activation endpoint is exposed", () => {
  const route = authRoutes.stack.find((layer) => layer.route
    && layer.route.path === "/activate-invited-account"
    && layer.route.methods.post);
  assert.ok(route);
});

test("a valid invitation verifies email and replaces the generated secret", async (t) => {
  const token = "a".repeat(64);
  const user = new User({
    email: "walkin@example.com",
    firstName: "Walkin",
    lastName: "Customer",
    phone: "09171234567",
    passwordHash: "unusable-generated-secret",
    emailVerified: false,
    accountOrigin: "walk_in_order",
    accountStatus: "invited",
    invitationTokenHash: hashInvitationToken(token),
    invitationExpiresAt: new Date(Date.now() + 60_000),
  });
  let chosenPassword = "";
  user.setPassword = async (value) => { chosenPassword = value; user.passwordHash = "customer-selected-hash"; };
  user.save = async () => user;
  t.mock.method(User, "findOne", (filter) => {
    assert.equal(filter.invitationTokenHash, hashInvitationToken(token));
    return { select: async () => user };
  });
  t.mock.method(audit, "logEvent", async () => undefined);

  const req = {
    body: { token, password: "Password1!", csrfToken: "csrf-token-1234567890" },
    headers: { cookie: "XSRF-TOKEN=csrf-token-1234567890" },
    ip: "127.0.0.1",
  };
  const res = responseRecorder();
  let forwarded;
  await authController.activateInvitedAccount(req, res, (error) => { forwarded = error; });

  assert.equal(forwarded, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(chosenPassword, "Password1!");
  assert.equal(user.emailVerified, true);
  assert.equal(user.accountStatus, "active");
  assert.equal(user.invitationTokenHash, undefined);
  assert.match(res.body.redirect, /returnTo=%2Fmy-orders/);
  assert.equal(res.cleared[0].name, "auth_token");
});

test("an expired invitation cannot activate the customer account", async (t) => {
  const token = "b".repeat(64);
  const user = new User({
    email: "expired.walkin@example.com",
    firstName: "Expired",
    lastName: "Invitation",
    phone: "09171234567",
    passwordHash: "unchanged",
    emailVerified: false,
    accountStatus: "invited",
    invitationTokenHash: hashInvitationToken(token),
    invitationExpiresAt: new Date(Date.now() - 1_000),
  });
  t.mock.method(User, "findOne", () => ({ select: async () => user }));
  const req = {
    body: { token, password: "Password1!", csrfToken: "csrf-token-1234567890" },
    headers: { cookie: "XSRF-TOKEN=csrf-token-1234567890" },
  };
  const res = responseRecorder();
  await authController.activateInvitedAccount(req, res, (error) => { throw error; });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /invalid or has expired/i);
  assert.equal(user.emailVerified, false);
  assert.equal(user.passwordHash, "unchanged");
});

test("activation page and checkout scripts render without inline syntax errors", async () => {
  const activationPage = path.join(__dirname, "../views/pages/account-activation.ejs");
  const html = await ejs.renderFile(activationPage, {
    token: "a".repeat(64),
    csrfToken: "csrf-token-1234567890",
  });
  assert.match(html, /accountActivationForm/);
  assert.doesNotMatch(html, /Temporary Password:/i);

  const activationScript = fs.readFileSync(path.join(__dirname, "../public/js/account-activation.js"), "utf8");
  assert.doesNotThrow(() => new Function(activationScript));
});

test("walk-in order tracking exposes technician location only after dispatch", () => {
  const detailSource = fs.readFileSync(path.join(__dirname, "../views/pages/order-details.ejs"), "utf8");
  const serviceSource = fs.readFileSync(path.join(__dirname, "../routes/serviceRoutes.js"), "utf8");
  assert.match(detailSource, /\['out_for_delivery','arrived','installing'\]\.includes\(order\.status\)/);
  const orderStatusBlock = serviceSource.match(/const activeOrderStatuses = \[([\s\S]*?)\];/);
  assert.ok(orderStatusBlock);
  assert.match(orderStatusBlock[1], /out_for_delivery/);
  assert.doesNotMatch(orderStatusBlock[1], /technician_assigned|technician_accepted/);
});

test("admin order operations retain a persistent invitation recovery action", () => {
  const routeSource = fs.readFileSync(path.join(__dirname, "../routes/orderRoutes.js"), "utf8");
  const adminSource = fs.readFileSync(path.join(__dirname, "../public/js/admin-aircon-orders.js"), "utf8");
  assert.match(routeSource, /canManageInvitation: req\.user\.role === "admin"/);
  assert.match(adminSource, /_aoResendCustomerActivation/);
  assert.match(adminSource, /resend-invitation/);
});

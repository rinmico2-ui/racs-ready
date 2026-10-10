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
const changePassword = router.stack.find(layer => layer.route?.path === '/me/password').route.stack.at(-1).handle;
const trustedDevices = require('../utils/trustedDevices');
const { profileNamePolicy, NAME_CHANGE_COOLDOWN_MS } = require('../utils/profileNamePolicy');

test('customer password changes require the current password and revoke sessions after success', async () => {
  const originalFind = User.findById, originalAudit = audit.logEvent, originalRevoke = trustedDevices.revokeAll;
  let saved = 0, passwords = [], revoked = [], sessionDestroyed = false;
  const user = { _id:'customer-id', currentSessionId:'old-session', comparePassword:async value => value === 'OldPass1!',
    setPassword:async value => passwords.push(value),save:async () => saved++ };
  User.findById = async () => user; audit.logEvent = async () => {}; trustedDevices.revokeAll = async (_res,id) => revoked.push(id);
  try {
    let res = response();
    await changePassword({ user:{ _id:user._id },body:{ currentPassword:'WrongPass1!',newPassword:'NewPass2!' } },res,error => { throw error; });
    assert.equal(res.statusCode,400); assert.equal(saved,0); assert.equal(passwords.length,0); assert.equal(revoked.length,0);
    res = response(); const cookies = []; res.clearCookie = name => cookies.push(name);
    await changePassword({ user:{ _id:user._id },body:{ currentPassword:'OldPass1!',newPassword:'NewPass2!' },session:{ destroy(callback) { sessionDestroyed = true; callback(); } } },res,error => { throw error; });
    assert.equal(res.statusCode,200); assert.equal(res.body.requiresLogin,true); assert.deepEqual(passwords,['NewPass2!']);
    assert.equal(saved,1); assert.equal(user.currentSessionId,undefined); assert.deepEqual(revoked,[user._id]); assert.equal(sessionDestroyed,true);
    assert.deepEqual(cookies,['auth_token','sid','connect.sid']);
  } finally { User.findById = originalFind; audit.logEvent = originalAudit; trustedDevices.revokeAll = originalRevoke; }
});

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
  const originalUpdate = User.findOneAndUpdate;
  const originalAudit = audit.logEvent;
  const user = {
    _id: "customer-id",
    role: "customer",
    firstName: "Old",
    lastName: "Name",
    phone: "09170000000",
    email: "customer@example.com",
    address: { province: "Old Province", city: "Old City" },
    async save() { this.saved = true; },
  };
  User.findById = async () => user;
  User.findOneAndUpdate = async (filter, update, options) => {
    assert.equal(filter._id, user._id);
    assert.equal(filter.firstName, "Old");
    assert.equal(filter.lastName, "Name");
    assert.ok(filter.$or);
    assert.equal(options.runValidators, true);
    return Object.assign(user, update.$set);
  };
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
    assert.ok(user.profileNameChangedAt instanceof Date);
    assert.equal(res.body.nameChangePolicy.canChangeName, false);
    assert.equal(user.address.city, "Cabanatuan");
    assert.equal(res.body.user.address.postalCode, "3100");
    assert.equal(user.email, "customer@example.com");
  } finally {
    User.findById = originalFind;
    User.findOneAndUpdate = originalUpdate;
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

test('name-change policy permits legacy accounts and unlocks exactly after 30 days', () => {
  const at = new Date('2026-10-01T00:00:00Z');
  assert.equal(profileNamePolicy({}).canChangeName, true);
  assert.equal(profileNamePolicy({ profileNameChangedAt: at }, new Date(at.getTime() + NAME_CHANGE_COOLDOWN_MS - 1)).canChangeName, false);
  assert.equal(profileNamePolicy({ profileNameChangedAt: at }, new Date(at.getTime() + NAME_CHANGE_COOLDOWN_MS)).canChangeName, true);
});

async function withProfileAccount(account, run) {
  const originalFind = User.findById, originalUpdate = User.findOneAndUpdate, originalAudit = audit.logEvent;
  const writes = [];
  let record = { _id:'customer-id', role:'customer', firstName:'Maria', lastName:'Santos', phone:'09170000000', ...account };
  User.findById = async () => ({ ...record });
  User.findOneAndUpdate = async (filter, update) => {
    writes.push({ filter, update });
    if (filter.firstName && (filter.firstName !== record.firstName || filter.lastName !== record.lastName)) return null;
    if (filter.$or && record.profileNameChangedAt && record.profileNameChangedAt > filter.$or[1].profileNameChangedAt.$lte) return null;
    record = { ...record, ...update.$set };
    return { ...record };
  };
  audit.logEvent = async () => {};
  const request = changes => ({ user:{ _id:record._id }, body:{ firstName:'Maria', lastName:'Santos', phone:'09171234567', ...changes } });
  try { await run({ request, writes, record:() => record }); }
  finally { User.findById=originalFind; User.findOneAndUpdate=originalUpdate; audit.logEvent=originalAudit; }
}

test('customer cannot bypass the name cooldown through the API or spoof its timestamp', async () => {
  await withProfileAccount({ profileNameChangedAt:new Date() }, async ({ request, writes, record }) => {
    const res=response();
    await updateProfile(request({ firstName:'Changed', profileNameChangedAt:null }), res, e=>{throw e;});
    assert.equal(res.statusCode,409);
    assert.equal(res.body.code,'NAME_CHANGE_COOLDOWN');
    assert.equal(res.body.nameChangePolicy.canChangeName,false);
    assert.equal(writes.length,0);
    assert.equal(record().phone,'09170000000');
  });
});

test('contact-only updates are permitted during the cooldown without resetting its clock', async () => {
  const at = new Date();
  await withProfileAccount({ profileNameChangedAt:at }, async ({ request, writes, record }) => {
    const res=response();
    await updateProfile(request({ profileNameChangedAt:null }), res, e=>{throw e;});
    assert.equal(res.statusCode,200);
    assert.deepEqual(writes[0].update.$set, { phone:'09171234567' });
    assert.equal(record().profileNameChangedAt,at);
    assert.equal(res.body.nameChangePolicy.canChangeName,false);
  });
});

test('an expired cooldown permits a fresh name change and restarts the waiting period', async () => {
  await withProfileAccount({ profileNameChangedAt:new Date(Date.now()-NAME_CHANGE_COOLDOWN_MS-1000) }, async ({ request, record }) => {
    const res=response();
    await updateProfile(request({ lastName:'Reyes' }), res, e=>{throw e;});
    assert.equal(res.statusCode,200);
    assert.equal(record().lastName,'Reyes');
    assert.equal(res.body.nameChangePolicy.canChangeName,false);
    assert.ok(record().profileNameChangedAt.getTime()>Date.now()-1000);
  });
});

test('simultaneous name changes consume only one window', async () => {
  await withProfileAccount({}, async ({ request, record }) => {
    const responses = [response(),response()];
    await Promise.all(responses.map((res,i)=>updateProfile(request({ firstName:i?'Second':'First' }),res,e=>{throw e;})));
    assert.deepEqual(responses.map(res=>res.statusCode).sort(),[200,409]);
    assert.equal(record().firstName,'First');
    const rejected = responses.find(res=>res.statusCode===409);
    assert.equal(rejected.body.user.firstName,'First');
    assert.equal(rejected.body.nameChangePolicy.canChangeName,false);
  });
});

test("customer editor submits to the profile API instead of browser-only storage", () => {
  const script = fs.readFileSync(path.join(__dirname, "../public/js/profile.js"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "../views/pages/profile.ejs"), "utf8");
  assert.match(script, /fetch\("\/api\/users\/me\/profile"/);
  assert.doesNotMatch(script, /localStorage\.setItem\("profile_ui_overrides"/);
  assert.match(page, /id="saveProfileBtn" type="submit" form="customerProfileForm"/);
  assert.match(page, /id="profileEmail"[^>]*readonly/);
});

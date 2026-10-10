"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const User = require("../models/User");
const Technician = require("../models/Technician");
const Secretary = require("../models/Secretary");
const audit = require("../utils/audit");
const auth = require("../controllers/authController");
const { isAccountEnabled } = require("../middleware/accountState");
const { hashInvitationToken } = require("../utils/customerAccountInvitation");
const { createController, details, staffDetails } = require("../controllers/technicianAccountController");

const payload = { name: "Juan Dela Cruz", userEmail: " Tech@Gmail.COM ", phone: "0917 123 4567", locationText: "Quezon City" };
const adminId = "507f1f77bcf86cd799439010";
const request = (body = payload, id) => ({ body, params: { id }, user: { _id: adminId, role: "admin" }, protocol: "https", get: () => "racs.example.com" });
function response() {
  return { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; }, set() {}, clearCookie() {} };
}

function fixture(options = {}) {
  let users = new Map(), techs = new Map(), secretaries = new Map();
  let sessions = 0, rollbacks = 0, ended = 0;
  const emails = [], events = [];
  const query = value => ({ session() { return this; }, select() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  const matches = (doc, filter) => Object.entries(filter).every(([key, value]) => value && typeof value === "object" && "$ne" in value ? String(doc[key]) !== String(value.$ne) : String(doc[key]) === String(value));
  class FakeUsers {
    constructor(values) {
      const doc = new User(values);
      doc.save = async () => {
        await doc.validate();
        if (options.userSaveError) throw options.userSaveError;
        if ([...users.values()].some(other => other.email === doc.email && String(other._id) !== String(doc._id))) throw Object.assign(new Error("duplicate"), { code: 11000 });
        users.set(String(doc._id), doc);
        return doc;
      };
      return doc;
    }
    static findOne(filter) { return query([...users.values()].find(doc => matches(doc, filter)) || null); }
    static findById(id) { return query(users.get(String(id)) || null); }
    static exists(filter) { return query([...users.values()].some(doc => matches(doc, filter))); }
  }
  class FakeTechs {
    constructor(values) {
      const doc = new Technician(values);
      doc.save = async () => {
        await doc.validate();
        if (options.techSaveError) throw options.techSaveError;
        techs.set(String(doc._id), doc);
        return doc;
      };
      return doc;
    }
    static findOne(filter) { return query([...techs.values()].find(doc => matches(doc, filter)) || null); }
    static findById(id) { return query(techs.get(String(id)) || null); }
    static exists(filter) { return query([...techs.values()].some(doc => matches(doc, filter))); }
  }
  class FakeSecretaries {
    constructor(values) {
      const doc = new Secretary(values);
      doc.save = async () => {
        await doc.validate();
        if (options.secretarySaveError) throw options.secretarySaveError;
        secretaries.set(String(doc._id), doc);
        return doc;
      };
      return doc;
    }
    static findOne(filter) { return query([...secretaries.values()].find(doc => matches(doc, filter)) || null); }
  }
  const controller = createController({
    User: FakeUsers, Technician: FakeTechs, Secretary: FakeSecretaries,
    startSession: async () => {
      sessions++;
      return {
        async withTransaction(work) {
          const beforeUsers = [...users.values()].map(doc => doc.toObject());
          const beforeTechs = [...techs.values()].map(doc => doc.toObject());
          const beforeSecretaries = [...secretaries.values()].map(doc => doc.toObject());
          try { return await work(this); }
          catch (error) {
            users = new Map(beforeUsers.map(values => { const doc = new FakeUsers(values); return [String(doc._id), doc]; }));
            techs = new Map(beforeTechs.map(values => { const doc = new FakeTechs(values); return [String(doc._id), doc]; }));
            secretaries = new Map(beforeSecretaries.map(values => { const doc = new FakeSecretaries(values); return [String(doc._id), doc]; }));
            rollbacks++;
            throw error;
          }
        },
        async endSession() { ended++; },
      };
    },
    sendMail: async mail => { emails.push(mail); if (options.mailFails) throw new Error("SMTP unavailable"); return options.queued ? { queued: true } : { messageId: "accepted" }; },
    logEvent: async event => { events.push(event); },
  });
  return { controller, emails, events, options, get users() { return [...users.values()]; }, get techs() { return [...techs.values()]; }, get secretaries() { return [...secretaries.values()]; }, get sessions() { return sessions; }, get ended() { return ended; }, get rollbacks() { return rollbacks; },
    async seedUser(values) { const user = new FakeUsers({ firstName: "Existing", lastName: "Person", phone: "09171234567", passwordHash: "existing", ...values }); await user.save(); return user; },
    async seedTech(values) { const tech = new FakeTechs({ name: "Juan Dela Cruz", userEmail: "tech@gmail.com", phone: "09171234567", ...values }); await tech.save(); return tech; },
  };
}

test("technician details require valid email, full name and phone; reject object inputs", () => {
  assert.deepEqual(details(payload), { name: "Juan Dela Cruz", email: "tech@gmail.com", phone: "09171234567", locationText: "Quezon City", firstName: "Juan", lastName: "Dela Cruz" });
  for (const change of [{ userEmail: "invalid" }, { userEmail: "a..b@gmail.com" }, { userEmail: { $ne: null } }, { name: "Juan" }, { name: {} }, { phone: "abc" }, { phone: "123" }, { locationText: "a".repeat(501) }]) assert.throws(() => details({ ...payload, ...change }));
});

test("invalid form input does not start a transaction or create an account", async () => {
  const f = fixture(), res = response();
  await f.controller.create(request({ ...payload, userEmail: "not-email" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(f.sessions, 0);
  assert.equal(f.users.length, 0);
  assert.equal(f.emails.length, 0);
});

test("creating a technician links a real User and sends only a one-time password setup link", async () => {
  const f = fixture(), res = response();
  await f.controller.create(request(), res);
  assert.equal(res.statusCode, 201);
  assert.equal(f.users.length, 1);
  assert.equal(f.techs.length, 1);
  const user = f.users[0], tech = f.techs[0];
  assert.equal(String(tech.user), String(user._id));
  assert.equal(user.role, "technician");
  assert.equal(user.firstName, "Juan");
  assert.equal(user.lastName, "Dela Cruz");
  assert.equal(tech.userEmail, "tech@gmail.com");
  assert.equal(user.emailVerified, false);
  assert.equal(user.accountStatus, "invited");
  assert.equal(isAccountEnabled(user), false);
  assert.equal(await user.comparePassword("Password1!"), false);
  const token = f.emails[0].text.match(/token=([a-f0-9]{64})/)[1];
  assert.equal(user.invitationTokenHash, hashInvitationToken(token));
  assert.ok(user.invitationExpiresAt > new Date());
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(res.body), /passwordHash|generatedPassword|invitationTokenHash/);
  assert.equal(res.body.invitation.delivery, "accepted");
  assert.equal(f.ended, 1);
  assert.equal(f.events[0].action, "technician.account.create");
});

for (const role of ["customer", "admin", "secretary", "technician"]) {
  test(`creation refuses an email already belonging to ${role}`, async () => {
    const f = fixture(), res = response();
    await f.seedUser({ email: "tech@gmail.com", role });
    await f.controller.create(request(), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "TECHNICIAN_EMAIL_EXISTS");
    assert.equal(f.users.length, 1);
    assert.equal(f.techs.length, 0);
    assert.equal(f.emails.length, 0);
  });
}

test("creation refuses a duplicate old technician even without a User", async () => {
  const f = fixture(), res = response();
  await f.seedTech({});
  await f.controller.create(request(), res);
  assert.equal(res.statusCode, 409);
  assert.equal(f.users.length, 0);
  assert.equal(f.techs.length, 1);
});

test("email availability checks both accounts and old roster records", async () => {
  const f = fixture();
  await f.seedTech({});
  for (const [email, available] of [[" Tech@Gmail.COM ", false], ["unused@gmail.com", true]]) {
    const res = response();
    await f.controller.checkEmail({ query: { email } }, res);
    assert.equal(res.body.available, available);
  }
  const res = response();
  await f.controller.checkEmail({ query: { email: { $ne: null } } }, res);
  assert.equal(res.statusCode, 400);
});

test("a failed technician save rolls back the User, and duplicate key races return 409", async () => {
  for (const [error, status] of [[new Error("write failure"), 500], [Object.assign(new Error("unique race"), { code: 11000 }), 409]]) {
    const f = fixture({ techSaveError: error }), res = response();
    await f.controller.create(request(), res);
    assert.equal(res.statusCode, status);
    assert.equal(f.users.length, 0);
    assert.equal(f.techs.length, 0);
    assert.equal(f.rollbacks, 1);
    assert.equal(f.ended, 1);
    assert.equal(f.emails.length, 0);
  }
});

test("a queued email is described as queued and a failed email keeps one recoverable account", async () => {
  for (const options of [{ queued: true }, { mailFails: true }]) {
    const f = fixture(options), res = response();
    await f.controller.create(request(), res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.invitation.delivery, options.queued ? "queued" : "failed");
    assert.equal(f.users.length, 1);
    assert.equal(f.techs.length, 1);
    const duplicate = response();
    await f.controller.create(request(), duplicate);
    assert.equal(duplicate.statusCode, 409);
  }
});

test("sending setup email repairs an old technician without changing the roster id", async () => {
  const f = fixture(), tech = await f.seedTech({}), res = response();
  await f.controller.invite(request({}, String(tech._id)), res);
  assert.equal(res.statusCode, 200);
  assert.equal(f.users.length, 1);
  assert.equal(f.techs.length, 1);
  assert.equal(String(f.techs[0]._id), String(tech._id));
  assert.equal(String(f.techs[0].user), String(f.users[0]._id));
  assert.equal(res.body.accountStatus, "invited");
});

test("legacy setup never takes over an existing customer or another staff account", async () => {
  const f = fixture(), tech = await f.seedTech({}), res = response();
  const old = await f.seedUser({ email: "tech@gmail.com", role: "customer" });
  await f.controller.invite(request({}, String(tech._id)), res);
  assert.equal(res.statusCode, 409);
  assert.equal(f.users.length, 1);
  assert.equal(f.techs[0].user, undefined);
  assert.equal(f.users[0].passwordHash, old.passwordHash);
});

test("resending replaces expired tokens and throttles repeated email clicks", async () => {
  const f = fixture(), created = response();
  await f.controller.create(request(), created);
  const user = f.users[0], tech = f.techs[0], oldHash = user.invitationTokenHash;
  const throttled = response();
  await f.controller.invite(request({}, String(tech._id)), throttled);
  assert.equal(throttled.statusCode, 429);
  f.users[0].invitationLastSentAt = new Date(Date.now() - 61_000);
  f.users[0].invitationExpiresAt = new Date(Date.now() - 1_000);
  const res = response();
  await f.controller.invite(request({}, String(tech._id)), res);
  assert.equal(res.statusCode, 200);
  assert.notEqual(f.users[0].invitationTokenHash, oldHash);
  assert.ok(f.users[0].invitationExpiresAt > new Date());
  assert.equal(f.emails.length, 2);
});

test("ready, archived and blocked accounts cannot receive fresh setup links", async () => {
  for (const changes of [{ emailVerified: true, accountStatus: "active" }, { active: false }, { archivedAt: new Date() }, { blocked: true }]) {
    const f = fixture(), user = await f.seedUser({ email: "tech@gmail.com", role: "technician", emailVerified: false, accountStatus: "invited", ...changes });
    const tech = await f.seedTech({ user: user._id }), res = response();
    await f.controller.invite(request({}, String(tech._id)), res);
    assert.equal(res.statusCode, 409);
    assert.equal(f.emails.length, 0);
  }
});

test("editing keeps User name and phone in sync and prevents changing the verified sign-in email", async () => {
  const f = fixture(), user = await f.seedUser({ email: "tech@gmail.com", role: "technician" });
  const tech = await f.seedTech({ user: user._id }), res = response();
  await f.controller.update(request({ ...payload, name: "New Full Name", phone: "09179999999" }, String(tech._id)), res);
  assert.equal(res.statusCode, 200);
  assert.equal(f.users[0].firstName, "New");
  assert.equal(f.users[0].lastName, "Full Name");
  assert.equal(f.users[0].phone, f.techs[0].phone);
  const refused = response();
  await f.controller.update(request({ ...payload, userEmail: "other@gmail.com" }, String(tech._id)), refused);
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.body.code, "TECHNICIAN_EMAIL_LOCKED");
  assert.equal(f.users[0].email, "tech@gmail.com");
});

test("editing cannot bypass staff archival policy", async () => {
  const f = fixture(), res = response();
  await f.controller.update(request({ ...payload, active: false }, adminId), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "STAFF_LIFECYCLE_ACTION_REQUIRED");
});

test("correcting an unconfirmed email cancels the old invitation and emails the new address", async () => {
  const f = fixture(), created = response();
  await f.controller.create(request(), created);
  const oldHash = f.users[0].invitationTokenHash;
  const res = response();
  await f.controller.update(request({ ...payload, userEmail: "correct@gmail.com" }, String(f.techs[0]._id)), res);
  assert.equal(res.statusCode, 200);
  assert.equal(f.users[0].email, "correct@gmail.com");
  assert.equal(f.techs[0].userEmail, "correct@gmail.com");
  assert.equal(f.users[0].emailVerified, false);
  assert.notEqual(f.users[0].invitationTokenHash, oldHash);
  assert.equal(f.emails[1].to, "correct@gmail.com");
  assert.equal(res.body.invitation.delivery, "accepted");
});

test("correcting an unconfirmed email cannot take an existing account's email", async () => {
  const f = fixture(), created = response();
  await f.controller.create(request(), created);
  const oldHash = f.users[0].invitationTokenHash;
  await f.seedUser({ email: "used@gmail.com", role: "customer" });
  const res = response();
  await f.controller.update(request({ ...payload, userEmail: "used@gmail.com" }, String(f.techs[0]._id)), res);
  assert.equal(res.statusCode, 409);
  assert.equal(f.users[0].email, "tech@gmail.com");
  assert.equal(f.users[0].invitationTokenHash, oldHash);
  assert.equal(f.emails.length, 1);
});

test("technician activation verifies email, consumes the link and directs login to technician workspace", async t => {
  const token = "b".repeat(64);
  const user = new User({ email: "tech@gmail.com", firstName: "Juan", lastName: "Dela Cruz", phone: "09171234567", role: "technician", emailVerified: false, accountStatus: "invited", accountOrigin: "admin", passwordHash: "unusable", invitationTokenHash: hashInvitationToken(token), invitationExpiresAt: new Date(Date.now() + 60_000) });
  user.save = async () => user;
  t.mock.method(User, "findOne", () => ({ select: async () => user }));
  t.mock.method(audit, "logEvent", async () => undefined);
  const req = { body: { token, password: "Password1!", csrfToken: "activation-csrf" }, headers: { cookie: "XSRF-TOKEN=activation-csrf" } }, res = response();
  await auth.activateInvitedAccount(req, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(user.emailVerified, true);
  assert.equal(isAccountEnabled(user), true);
  assert.equal(await user.comparePassword("Password1!"), true);
  assert.equal(user.invitationTokenHash, undefined);
  assert.equal(user.$where.invitationTokenHash, hashInvitationToken(token));
  assert.equal(user.$where.accountStatus, "invited");
  assert.match(res.body.redirect, /returnTo=%2Ftechnician/);
});

test("archived accounts and activation races cannot reactivate or overwrite a password", async t => {
  t.mock.method(audit, "logEvent", async () => undefined);
  for (const changes of [{ active: false }, { archivedAt: new Date() }, { blocked: true }, { invitationExpiresAt: new Date(Date.now() - 1_000) }, { race: true }]) {
    const token = "c".repeat(64);
    const user = new User({ email: "tech@gmail.com", firstName: "Juan", lastName: "Cruz", phone: "09171234567", role: "technician", emailVerified: false, accountStatus: "invited", passwordHash: "unchanged", invitationTokenHash: hashInvitationToken(token), invitationExpiresAt: new Date(Date.now() + 60_000), ...changes });
    user.save = async () => { throw Object.assign(new Error("lost token race"), { name: "DocumentNotFoundError" }); };
    t.mock.method(User, "findOne", () => ({ select: async () => user }));
    const req = { body: { token, password: "Password1!", csrfToken: "activation-csrf" }, headers: { cookie: "XSRF-TOKEN=activation-csrf" } }, res = response();
    await auth.activateInvitedAccount(req, res, error => { throw error; });
    assert.equal(res.statusCode, 400);
    if (!changes.race) assert.equal(user.passwordHash, "unchanged");
  }
});

test("new and existing technician forms explain password setup and expose recovery without sensitive fields", async () => {
  const filename = path.join(__dirname, "../views/pages/admin/Technicians/TechnicianForm.ejs");
  for (const technician of [null, { _id: adminId, name: "Old Technician", userEmail: "old@gmail.com" }, { _id: adminId, name: "New Technician", user: { email: "new@gmail.com", emailVerified: false } }]) {
    const html = await ejs.renderFile(filename, { technician });
    assert.match(html, /id="techEmail"[^>]*required/);
    assert.match(html, /admin-technician-account.js/);
    if (technician) assert.match(html, /Send setup email/);
    else assert.match(html, /choose their own password/);
  }
  const script = fs.readFileSync(path.join(__dirname, "../public/js/admin-technician-account.js"), "utf8");
  assert.doesNotThrow(() => new Function(script));
});

const staffPayload = { role: "technician", firstName: "Juan Miguel", lastName: "Dela Cruz", email: "staff@gmail.com", phone: "09171234567", locationText: "Quezon City" };

test("staff creation accepts only explicit staff roles and validates location before writes", async () => {
  for (const change of [{ role: "admin" }, { role: "customer" }, { role: "" }, { firstName: {} }, { email: "not-email" }, { phone: "" }, { location: { type: "Point", coordinates: [190, 14] } }]) {
    const f = fixture(), res = response();
    await f.controller.createStaff(request({ ...staffPayload, ...change }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(f.sessions, 0);
    assert.equal(f.users.length, 0);
  }
  assert.equal(staffDetails(staffPayload).firstName, "Juan Miguel");
});

for (const role of ["technician", "secretary"]) {
  test(`${role} creation uses the same invited account and password setup contract`, async () => {
    const f = fixture(), res = response();
    await f.controller.createStaff(request({ ...staffPayload, role, password: "Password1!" }), res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.user.role, role);
    assert.equal(f.users[0].firstName, "Juan Miguel");
    assert.equal(f.users[0].lastName, "Dela Cruz");
    assert.equal(f.users[0].accountStatus, "invited");
    assert.equal(isAccountEnabled(f.users[0]), false);
    assert.equal(await f.users[0].comparePassword("Password1!"), false);
    assert.equal(f.techs.length, role === "technician" ? 1 : 0);
    assert.equal(f.secretaries.length, role === "secretary" ? 1 : 0);
    const profile = role === "technician" ? f.techs[0] : f.secretaries[0];
    assert.equal(String(profile.user), String(f.users[0]._id));
    assert.equal(profile.phone, f.users[0].phone);
    assert.match(f.emails[0].subject, new RegExp(role));
    assert.equal(f.events[0].action, "staff.create");
    assert.doesNotMatch(JSON.stringify(res.body), /passwordHash|invitationTokenHash/);
  });

  test(`${role} setup email can be resent by user id without creating another profile`, async () => {
    const f = fixture(), created = response();
    await f.controller.createStaff(request({ ...staffPayload, role }), created);
    f.users[0].invitationLastSentAt = new Date(Date.now() - 61_000);
    const oldHash = f.users[0].invitationTokenHash, res = response();
    await f.controller.inviteStaff(request({}, String(f.users[0]._id)), res);
    assert.equal(res.statusCode, 200);
    assert.notEqual(f.users[0].invitationTokenHash, oldHash);
    assert.equal(f.users.length, 1);
    assert.equal(f.techs.length + f.secretaries.length, 1);
    const limited = response();
    await f.controller.inviteStaff(request({}, String(f.users[0]._id)), limited);
    assert.equal(limited.statusCode, 429);
  });

  test(`${role} email correction cancels the old setup link and keeps the profile linked`, async () => {
    const f = fixture(), created = response();
    await f.controller.createStaff(request({ ...staffPayload, role }), created);
    const oldHash = f.users[0].invitationTokenHash, res = response();
    await f.controller.updateInvitedStaff(request({ firstName: "Corrected Name", email: "correct@gmail.com", phone: "09179999999", role }, String(f.users[0]._id)), res);
    assert.equal(res.statusCode, 200);
    assert.equal(f.users[0].email, "correct@gmail.com");
    assert.notEqual(f.users[0].invitationTokenHash, oldHash);
    assert.equal(f.users[0].firstName, "Corrected Name");
    const profile = role === "technician" ? f.techs[0] : f.secretaries[0];
    assert.equal(profile.phone, "09179999999");
    if (role === "technician") assert.equal(profile.userEmail, "correct@gmail.com");
    assert.equal(f.emails[1].to, "correct@gmail.com");
  });
}

test("a failed secretary profile write rolls back account creation", async () => {
  const f = fixture({ secretarySaveError: new Error("write failure") }), res = response();
  await f.controller.createStaff(request({ ...staffPayload, role: "secretary" }), res);
  assert.equal(res.statusCode, 500);
  assert.equal(f.users.length, 0);
  assert.equal(f.secretaries.length, 0);
  assert.equal(f.emails.length, 0);
  assert.equal(f.rollbacks, 1);
});

test("staff creation preserves valid technician GPS coordinates and ignores hidden secretary location", async () => {
  const f = fixture(), res = response();
  await f.controller.createStaff(request({ ...staffPayload, location: { type: "Point", coordinates: [120.9, 14.5] } }), res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual([...f.techs[0].location.coordinates], [120.9, 14.5]);
  const s = fixture(), sec = response();
  await s.controller.createStaff(request({ ...staffPayload, role: "secretary", location: { invalid: true } }), sec);
  assert.equal(sec.statusCode, 201);
  assert.equal(s.techs.length, 0);
});

test("staff creation refuses a duplicate existing roster email for either role", async () => {
  for (const role of ["technician", "secretary"]) {
    const f = fixture(), res = response();
    await f.seedTech({ userEmail: "staff@gmail.com" });
    await f.controller.createStaff(request({ ...staffPayload, role }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(f.users.length, 0);
  }
});

test("staff resend cannot send invitation links to customer, archived, or ready accounts", async () => {
  for (const values of [{ role: "customer", emailVerified: false, accountStatus: "invited" }, { role: "secretary", emailVerified: true }, { role: "secretary", active: false }, { role: "secretary", blocked: true }, { role: "technician", emailVerified: false, accountStatus: "invited" }]) {
    const f = fixture(), user = await f.seedUser({ email: "staff@gmail.com", emailVerified: false, accountStatus: "invited", ...values }), res = response();
    await f.controller.inviteStaff(request({}, String(user._id)), res);
    assert.ok([404, 409].includes(res.statusCode));
    assert.equal(f.emails.length, 0);
  }
});

test("pending staff role changes and duplicate email corrections are refused", async () => {
  const f = fixture(), created = response();
  await f.controller.createStaff(request({ ...staffPayload, role: "secretary" }), created);
  const id = String(f.users[0]._id);
  await f.seedUser({ email: "used@gmail.com", role: "customer" });
  for (const change of [{ role: "technician" }, { email: "used@gmail.com" }]) {
    const res = response();
    await f.controller.updateInvitedStaff(request(change, id), res);
    assert.ok([400, 409].includes(res.statusCode));
    assert.equal(f.users[0].role, "secretary");
    assert.equal(f.users[0].email, "staff@gmail.com");
  }
});

test("secretary activation verifies ownership and sends login to the secretary workspace", async t => {
  const token = "d".repeat(64);
  const user = new User({ email: "secretary@gmail.com", firstName: "Office", lastName: "Staff", phone: "09171234567", role: "secretary", emailVerified: false, accountStatus: "invited", accountOrigin: "admin", passwordHash: "unusable", invitationTokenHash: hashInvitationToken(token), invitationExpiresAt: new Date(Date.now() + 60_000) });
  user.save = async () => user;
  t.mock.method(User, "findOne", () => ({ select: async () => user }));
  t.mock.method(audit, "logEvent", async () => undefined);
  const req = { body: { token, password: "Password1!", csrfToken: "activation-csrf" }, headers: { cookie: "XSRF-TOKEN=activation-csrf" } }, res = response();
  await auth.activateInvitedAccount(req, res, error => { throw error; });
  assert.equal(isAccountEnabled(user), true);
  assert.match(res.body.redirect, /returnTo=%2Fsecretary$/);
});

test("both staff pages render exactly one shared modal and omit it for read-only staff", async () => {
  for (const [filename, canManage] of [["Staff/StaffList.ejs", "staffCanManage"], ["Technicians/TechnicianList.ejs", "techniciansCanManageAccounts"]]) {
    for (const manage of [true, false]) {
      const html = await ejs.renderFile(path.join(__dirname, "../views/pages/admin/", filename), { [canManage]: manage });
      assert.equal((html.match(/id="addStaffModal"/g) || []).length, manage ? 1 : 0);
      assert.doesNotMatch(html, /id="wizPassword"/);
      if (manage) assert.match(html, /staff-account-modal.js/);
      for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(match[1]));
    }
  }
  const client = fs.readFileSync(path.join(__dirname, "../public/js/staff-account-modal.js"), "utf8");
  assert.doesNotThrow(() => new Function(client));
  const admin = require("../controllers/adminController");
  assert.equal(admin.createStaff, require("../controllers/technicianAccountController").createStaff);
});

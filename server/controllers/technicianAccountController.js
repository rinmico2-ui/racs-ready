"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const Technician = require("../models/Technician");
const Secretary = require("../models/Secretary");
const mailer = require("../utils/mailer");
const audit = require("../utils/audit");
const { normalizeInvitationEmail } = require("../utils/customerAccountInvitation");
const { isEmail } = require("validator");

function fail(message, status = 400, code = "TECHNICIAN_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function details(body) {
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  const email = typeof body.userEmail === "string" ? normalizeInvitationEmail(body.userEmail) : "";
  const phone = typeof body.phone === "string" ? body.phone.trim().replace(/[\s()+-]/g, "") : "";
  const locationText = typeof body.locationText === "string" ? body.locationText.trim() : "";
  if (name.length < 2 || name.length > 201 || !name.includes(" ")) {
    throw fail("Enter the technician's first and last name.");
  }
  if (!email || !isEmail(email)) throw fail("Enter a valid email address.", 400, "TECHNICIAN_EMAIL_INVALID");
  if (!/^\d{10,15}$/.test(phone)) throw fail("Enter a phone number with 10 to 15 digits.");
  if (locationText.length > 500) throw fail("Keep the address within 500 characters.");
  const parts = name.split(" ");
  return { name, email, phone, locationText, firstName: parts.shift(), lastName: parts.join(" ") };
}

function staffDetails(body) {
  if (!["technician", "secretary"].includes(body.role)) throw fail("Choose Technician or Secretary.", 400, "STAFF_ROLE_INVALID");
  const firstName = typeof body.firstName === "string" ? body.firstName.trim().replace(/\s+/g, " ") : "";
  const lastName = typeof body.lastName === "string" ? body.lastName.trim().replace(/\s+/g, " ") : "";
  if (!firstName || !lastName || firstName.length > 100 || lastName.length > 100) throw fail("Enter a first and last name, each within 100 characters.");
  const data = details({ name: `${firstName} ${lastName}`, userEmail: body.email, phone: body.phone, locationText: body.locationText || (typeof body.location === "string" ? body.location : "") });
  Object.assign(data, { firstName, lastName, role: body.role });
  if (body.role === "technician" && body.location && typeof body.location !== "string") {
    const point = body.location;
    if (point.type !== "Point" || !Array.isArray(point.coordinates) || point.coordinates.length !== 2
        || !point.coordinates.every(value => typeof value === "number" && Number.isFinite(value))
        || Math.abs(point.coordinates[0]) > 180 || Math.abs(point.coordinates[1]) > 90) throw fail("Choose a valid work location.");
    data.location = { type: "Point", coordinates: [...point.coordinates] };
  }
  return data;
}

function createController(deps = {}) {
  const Users = deps.User || User;
  const Techs = deps.Technician || Technician;
  const Secretaries = deps.Secretary || Secretary;
  const startSession = deps.startSession || (() => mongoose.startSession());
  const sendMail = deps.sendMail || (payload => mailer.sendMail(payload));
  const logEvent = deps.logEvent || (payload => audit.logEvent(payload));

  async function transaction(work) {
    const session = await startSession();
    try { return await session.withTransaction(() => work(session)); }
    finally { await session.endSession(); }
  }

  async function ensureEmailFree(email, session, ownTech, ownUser) {
    const user = await Users.findOne({ email, ...(ownUser ? { _id: { $ne: ownUser } } : {}) }).session(session);
    const tech = await Techs.findOne({ userEmail: email, ...(ownTech ? { _id: { $ne: ownTech } } : {}) }).session(session);
    if (user || tech) throw fail("This email is already used by another account or technician. Use a different email.", 409, "TECHNICIAN_EMAIL_EXISTS");
  }

  async function makeUser(data, req, session) {
    const user = new Users({
      email: data.email, firstName: data.firstName, lastName: data.lastName,
      phone: data.phone, role: data.role || "technician", active: true,
      emailVerified: false, accountOrigin: "admin", accountStatus: "invited",
      invitationInvitedAt: new Date(), invitationInvitedBy: req.user._id,
      invitationLastSentAt: new Date(),
    });
    // No usable default password. Only the email recipient can set one.
    await user.setPassword(crypto.randomBytes(32).toString("base64url"));
    const token = user.createAccountInvitationToken();
    await user.save({ session });
    return { user, token };
  }

  async function deliver(req, user, token) {
    try {
      const base = String(process.env.APP_BASE_URL || process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
      const url = `${base}/activate-account?token=${encodeURIComponent(token)}`;
      const result = await sendMail({
        to: user.email, subject: `Set up your ${user.role} account | CALIDRO RACS`,
        text: `CALIDRO RACS has created your ${user.role} account. Open this link to confirm your email and choose your password:\n${url}\n\nThe link can be used once and expires at ${user.invitationExpiresAt.toISOString()}. After setup, sign in with ${user.email} and the password you chose. If you did not expect this email, ignore it.`,
        source: `${user.role}_account_invitation`,
      });
      if (!result) throw new Error("Email was not accepted.");
      return { delivery: result.queued ? "queued" : "accepted", email: user.email };
    } catch (_) {
      // Account creation already committed. Return an honest, recoverable result.
      return { delivery: "failed", email: user.email };
    }
  }

  async function record(req, entity, action) {
    await logEvent({ actor: req.user._id, actorRole: "admin", action, module: "auth", entityId: entity._id, entityType: entity.role ? "User" : "Technician", req, outcome: "success" }).catch(() => undefined);
  }

  function respondError(res, error) {
    if (error.code === 11000) return res.status(409).json({ error: "This email or technician account is already in use.", code: "TECHNICIAN_EMAIL_EXISTS" });
    return res.status(error.status || (error.name === "ValidationError" ? 400 : 500)).json({
      error: error.status ? error.message : "Could not save the staff account. Please try again.", code: error.status ? error.code : "TECHNICIAN_SAVE_FAILED",
    });
  }

  return {
    async createStaff(req, res) {
      try {
        const data = staffDetails(req.body || {});
        const result = await transaction(async session => {
          await ensureEmailFree(data.email, session);
          const account = await makeUser(data, req, session);
          const profile = data.role === "technician"
            ? new Techs({ user: account.user._id, name: data.name, userEmail: data.email, phone: data.phone, locationText: data.locationText, ...(data.location ? { location: data.location } : {}), active: true })
            : new Secretaries({ user: account.user._id, phone: data.phone, extension: "", shift: "", notes: "" });
          await profile.save({ session });
          return { ...account, profile };
        });
        const invitation = await deliver(req, result.user, result.token);
        await record(req, result.user, "staff.create");
        return res.status(201).json({ success: true, message: "Staff account created", user: { id: result.user._id, email: result.user.email, role: result.user.role }, technician: data.role === "technician" ? result.profile : null, invitation, accountStatus: "invited" });
      } catch (error) { return respondError(res, error); }
    },

    async inviteStaff(req, res) {
      try {
        if (!mongoose.isValidObjectId(req.params.id)) throw fail("Invalid staff id.");
        const result = await transaction(async session => {
          const user = await Users.findById(req.params.id).select("+invitationTokenHash +invitationExpiresAt").session(session);
          if (!user || !["technician", "secretary"].includes(user.role)) throw fail("Staff account not found.", 404);
          if (user.active === false || user.blocked || user.archivedAt) throw fail("Restore or enable this staff account before sending a setup email.", 409);
          if (user.emailVerified !== false || user.accountStatus !== "invited") throw fail("This account is already set up. Use Forgot password on the sign-in page.", 409);
          if (user.role === "technician") {
            const tech = await Techs.findOne({ user: user._id }).session(session);
            if (!tech || tech.active === false || tech.archivedAt) throw fail("The linked technician record is unavailable.", 409);
          }
          if (user.invitationLastSentAt && Date.now() - new Date(user.invitationLastSentAt).getTime() < 60_000) throw fail("Wait one minute before sending another setup email.", 429);
          user.invitationLastSentAt = new Date();
          const token = user.createAccountInvitationToken();
          await user.save({ session });
          return { user, token };
        });
        const invitation = await deliver(req, result.user, result.token);
        await record(req, result.user, "staff.invitation.resend");
        return res.json({ success: true, invitation, accountStatus: "invited" });
      } catch (error) { return respondError(res, error); }
    },

    async updateInvitedStaff(req, res) {
      try {
        if (!mongoose.isValidObjectId(req.params.id)) throw fail("Invalid staff id.");
        if (req.body.active !== undefined) throw fail("Use the staff archive or restore action to change account status.", 400, "STAFF_LIFECYCLE_ACTION_REQUIRED");
        const result = await transaction(async session => {
          const user = await Users.findById(req.params.id).session(session);
          if (!user || !["technician", "secretary"].includes(user.role)) throw fail("Staff account not found.", 404);
          if (user.active === false || user.blocked || user.archivedAt || user.emailVerified !== false || user.accountStatus !== "invited") throw fail("This account is no longer waiting for setup. Refresh the staff list.", 409);
          if (req.body.role && req.body.role !== user.role) throw fail("Keep the selected role while this account is waiting for setup.", 400);
          const data = staffDetails({ role: user.role, firstName: req.body.firstName ?? user.firstName, lastName: req.body.lastName ?? user.lastName, email: req.body.email ?? user.email, phone: req.body.phone ?? user.phone });
          const profile = user.role === "technician" ? await Techs.findOne({ user: user._id }).session(session) : await Secretaries.findOne({ user: user._id }).session(session);
          if (!profile || profile.active === false || profile.archivedAt) throw fail("The linked staff record is unavailable.", 409);
          await ensureEmailFree(data.email, session, user.role === "technician" ? profile._id : undefined, user._id);
          const changed = data.email !== user.email;
          Object.assign(user, { firstName: data.firstName, lastName: data.lastName, email: data.email, phone: data.phone });
          let token;
          if (changed) {
            user.invitationLastSentAt = new Date();
            user.emailVerificationOtpHash = undefined;
            user.emailVerificationExpires = undefined;
            token = user.createAccountInvitationToken();
          }
          Object.assign(profile, { phone: data.phone, ...(user.role === "technician" ? { name: data.name, userEmail: data.email } : {}) });
          await user.save({ session });
          await profile.save({ session });
          return { user, token };
        });
        const invitation = result.token ? await deliver(req, result.user, result.token) : undefined;
        await record(req, result.user, "staff.edit");
        return res.json({ success: true, message: "Staff updated", modified: 1, ...(invitation ? { invitation } : {}) });
      } catch (error) { return respondError(res, error); }
    },

    async checkEmail(req, res) {
      try {
        const email = typeof req.query.email === "string" ? normalizeInvitationEmail(req.query.email) : "";
        if (!email || !isEmail(email)) throw fail("Enter a valid email address.");
        res.set("Cache-Control", "no-store");
        const [user, tech] = await Promise.all([Users.exists({ email }), Techs.exists({ userEmail: email })]);
        return res.json({ available: !user && !tech });
      } catch (error) { return respondError(res, error); }
    },

    async create(req, res) {
      try {
        const data = details(req.body || {});
        const result = await transaction(async session => {
          await ensureEmailFree(data.email, session);
          const account = await makeUser(data, req, session);
          const tech = new Techs({ user: account.user._id, name: data.name, userEmail: data.email, phone: data.phone, locationText: data.locationText, active: true });
          await tech.save({ session });
          return { ...account, tech };
        });
        const invitation = await deliver(req, result.user, result.token);
        await record(req, result.tech, "technician.account.create");
        return res.status(201).json({ success: true, technician: result.tech, invitation, accountStatus: "invited" });
      } catch (error) { return respondError(res, error); }
    },

    async invite(req, res) {
      try {
        if (!mongoose.isValidObjectId(req.params.id)) throw fail("Invalid technician id.");
        const result = await transaction(async session => {
          const tech = await Techs.findById(req.params.id).session(session);
          if (!tech) throw fail("Technician not found.", 404);
          if (tech.active === false || tech.archivedAt) throw fail("Restore this technician before setting up their account.", 409);
          const data = details({ name: tech.name, userEmail: tech.userEmail, phone: tech.phone, locationText: tech.locationText });
          const user = tech.user ? await Users.findById(tech.user).select("+invitationTokenHash +invitationExpiresAt").session(session) : null;
          if (tech.user && !user) throw fail("The linked account could not be found. Contact the administrator.", 409);
          if (user) {
            if (user.role !== "technician" || user.active === false || user.blocked || user.archivedAt) throw fail("The linked account is unavailable.", 409);
            if (user.emailVerified !== false || user.accountStatus !== "invited") throw fail("This account is already set up. Use Forgot password on the sign-in page to reset its password.", 409);
            if (user.invitationLastSentAt && Date.now() - new Date(user.invitationLastSentAt).getTime() < 60_000) throw fail("Wait one minute before sending another setup email.", 429);
            user.invitationLastSentAt = new Date();
            const token = user.createAccountInvitationToken();
            await user.save({ session });
            return { user, token, tech };
          }
          // Also repairs old roster entries which never had a login account.
          await ensureEmailFree(data.email, session, tech._id);
          const account = await makeUser(data, req, session);
          tech.user = account.user._id;
          tech.userEmail = account.user.email;
          await tech.save({ session });
          return { ...account, tech };
        });
        const invitation = await deliver(req, result.user, result.token);
        await record(req, result.tech, "technician.account.invite");
        return res.json({ success: true, invitation, accountStatus: "invited" });
      } catch (error) { return respondError(res, error); }
    },

    async update(req, res) {
      try {
        if (!mongoose.isValidObjectId(req.params.id)) throw fail("Invalid technician id.");
        if (req.body.active !== undefined) throw fail("Use the staff archive or restore action to change technician status.", 400, "STAFF_LIFECYCLE_ACTION_REQUIRED");
        const data = details(req.body || {});
        const result = await transaction(async session => {
          const current = await Techs.findById(req.params.id).session(session);
          if (!current) throw fail("Technician not found.", 404);
          if (current.active === false || current.archivedAt) throw fail("Restore this technician before editing their profile.", 409, "STAFF_ARCHIVED");
          const user = current.user ? await Users.findById(current.user).session(session) : null;
          if (current.user && !user) throw fail("The linked account could not be found.", 409);
          if (user && (user.role !== "technician" || user.active === false || user.archivedAt)) throw fail("The linked account is unavailable.", 409);
          const emailChanged = user && data.email !== user.email;
          if (emailChanged && (user.emailVerified !== false || user.accountStatus !== "invited")) throw fail("The confirmed sign-in email cannot be changed from this form.", 400, "TECHNICIAN_EMAIL_LOCKED");
          await ensureEmailFree(data.email, session, current._id, user?._id);
          Object.assign(current, { name: data.name, userEmail: data.email, phone: data.phone, locationText: data.locationText });
          let token;
          if (user) {
            Object.assign(user, { firstName: data.firstName, lastName: data.lastName, phone: data.phone });
            if (emailChanged) {
              user.email = data.email;
              user.invitationLastSentAt = new Date();
              user.emailVerificationOtpHash = undefined;
              user.emailVerificationExpires = undefined;
              token = user.createAccountInvitationToken();
            }
            await user.save({ session });
          }
          await current.save({ session });
          return { tech: current, user, token };
        });
        const invitation = result.token ? await deliver(req, result.user, result.token) : undefined;
        await record(req, result.tech, "technician.profile.update");
        return res.json({ success: true, technician: result.tech, ...(invitation ? { invitation } : {}) });
      } catch (error) { return respondError(res, error); }
    },
  };
}

module.exports = { ...createController(), createController, details, staffDetails };

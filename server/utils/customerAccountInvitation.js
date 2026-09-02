"use strict";

const crypto = require("crypto");
const User = require("../models/User");

class CustomerInvitationError extends Error {
  constructor(message, status = 400, code = "CUSTOMER_INVITATION_INVALID") {
    super(message);
    this.name = "CustomerInvitationError";
    this.status = status;
    this.code = code;
  }
}

function normalizeInvitationEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : "";
}

function invitationState(user) {
  if (user.emailVerified !== false) return "active";
  return user.accountStatus === "invited" ? "invited" : "pending_verification";
}

async function provisionWalkInCustomer({
  customer,
  consent,
  invitedBy,
  origin = "walk_in_order",
  session,
  UserModel = User,
}) {
  if (consent !== true) {
    throw new CustomerInvitationError(
      "Confirm the customer's consent to link this order to a customer account and send account emails.",
      422,
      "CUSTOMER_ACCOUNT_CONSENT_REQUIRED",
    );
  }

  const email = normalizeInvitationEmail(customer?.email);
  if (!email) {
    throw new CustomerInvitationError("A valid customer email is required.", 400, "CUSTOMER_EMAIL_REQUIRED");
  }

  const query = UserModel.findOne({ email });
  const existing = session && typeof query.session === "function" ? await query.session(session) : await query;
  if (existing) {
    if (existing.role !== "customer") {
      throw new CustomerInvitationError(
        "That email belongs to a staff account. Use the customer's own email address.",
        409,
        "CUSTOMER_EMAIL_STAFF_CONFLICT",
      );
    }

    let activationToken = null;
    if (existing.emailVerified === false && existing.accountStatus === "invited") {
      existing.invitationConsentAt = existing.invitationConsentAt || new Date();
      existing.invitationInvitedBy = existing.invitationInvitedBy || invitedBy;
      activationToken = existing.createAccountInvitationToken();
      await existing.save({ ...(session ? { session } : {}) });
    }
    return {
      user: existing,
      created: false,
      state: invitationState(existing),
      activationToken,
    };
  }

  const user = new UserModel({
    email,
    firstName: String(customer?.firstName || "Walk-in").trim().slice(0, 100) || "Walk-in",
    lastName: String(customer?.lastName || "Customer").trim().slice(0, 100) || "Customer",
    phone: String(customer?.phone || "").replace(/\D+/g, "").slice(0, 32),
    role: "customer",
    active: true,
    emailVerified: false,
    accountOrigin: origin,
    accountStatus: "invited",
    invitationInvitedAt: new Date(),
    invitationInvitedBy: invitedBy,
    invitationConsentAt: new Date(),
  });
  await user.setPassword(crypto.randomBytes(32).toString("base64url"));
  const activationToken = user.createAccountInvitationToken();
  await user.save({ ...(session ? { session } : {}) });

  return { user, created: true, state: "invited", activationToken };
}

function hashInvitationToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

module.exports = {
  CustomerInvitationError,
  hashInvitationToken,
  invitationState,
  normalizeInvitationEmail,
  provisionWalkInCustomer,
};

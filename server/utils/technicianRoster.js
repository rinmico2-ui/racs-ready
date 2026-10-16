"use strict";

const ACCOUNT_FIELDS = "firstName lastName email phone role active archivedAt blocked emailVerified accountStatus";
const PROFILE_FIELDS = "name user userEmail phone location locationText active archivedAt rating ratingCount availabilityStatus createdAt updatedAt";
const key = value => String(value?._id || value || "");

function rosterEntry(profile, account = profile?.user) {
  const user = account && typeof account === "object" && account.role ? account : null;
  if (user && user.role !== "technician") return null;
  if (!profile && !user) return null;
  // The login account is the same source used by Staff List. A technician
  // profile supplies operational IDs/location, not a second staff identity.
  const source = user || profile;
  const archivedAt = source.archivedAt || null;
  const active = source.active !== false && !archivedAt;
  const name = user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() || profile?.name : profile.name;
  const loginState = !user ? "missing" : archivedAt ? "archived" : !active ? "inactive"
    : user.blocked ? "blocked" : user.emailVerified === false || user.accountStatus === "invited" ? "invited"
    : !profile ? "missing_profile" : "ready";
  const reason = {
    missing: "No linked staff sign-in account", archived: "Staff account is archived", inactive: "Staff account is inactive",
    blocked: "Staff account is blocked", invited: "Waiting for staff account setup", missing_profile: "Set up this staff member's work profile first",
    ready: "",
  }[loginState];
  const safeUser = user ? Object.fromEntries(["_id", ...ACCOUNT_FIELDS.split(" ")].map(field => [field, user[field]])) : null;
  return {
    _id: profile?._id || user._id, technicianId: profile?._id || null, staffId: user?._id || profile._id,
    user: safeUser, name: name || "Technician", firstName: user?.firstName || "", lastName: user?.lastName || "",
    email: user?.email || profile?.userEmail || "", userEmail: user?.email || profile?.userEmail || "",
    phone: user?.phone || profile?.phone || "", active, archivedAt,
    lifecycleState: archivedAt ? "archived" : active ? "active" : "inactive",
    loginState, assignmentEligible: loginState === "ready", assignmentReason: reason,
    location: profile?.location || null, locationText: profile?.locationText || "",
    rating: profile?.rating || 0, ratingCount: profile?.ratingCount || 0,
    availabilityStatus: profile?.availabilityStatus || "Offline", createdAt: profile?.createdAt || user?.createdAt,
    updatedAt: profile?.updatedAt,
  };
}

async function loadTechnicianRoster({ Technician = require("../models/Technician"), User = require("../models/User"),
  includeInactive = false, includeMissingAccounts = false, technicianIds, session } = {}) {
  let query = Technician.find(technicianIds ? { _id: { $in: technicianIds } } : {})
    .populate({ path: "user", select: ACCOUNT_FIELDS,
      transform: (document, reference) => document || (reference ? { _id: reference, role: "missing_account" } : null),
    }).select(PROFILE_FIELDS);
  if (session) query = query.session(session);
  const profiles = await query.lean();
  const rows = profiles.map(profile => rosterEntry(profile)).filter(Boolean);
  if (includeMissingAccounts) {
    const users = await User.find({ role: "technician" }).select(ACCOUNT_FIELDS).lean();
    const linked = new Set(profiles.map(profile => key(profile.user)));
    for (const user of users) if (!linked.has(key(user))) rows.push(rosterEntry(null, user));
  }
  return rows.filter(row => includeInactive || row.active).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { ACCOUNT_FIELDS, PROFILE_FIELDS, rosterEntry, loadTechnicianRoster };

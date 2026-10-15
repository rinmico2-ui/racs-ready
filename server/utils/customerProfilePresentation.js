"use strict";

const { createHash } = require("node:crypto");

// Keep the avatar stable when a customer edits their name or contact details.
// Only palette choices derived from the account ID reach the SVG template.
function customerProfilePresentation(user = {}) {
  user = user || {};
  const address = user.address || {};
  const hasText = value => typeof value === "string" && value.trim().length > 0;
  const groups = [
    { key: "name", title: "Your name", weight: 25, fields: [
      { label: "First name", value: user.firstName, target: "profileFirstName" },
      { label: "Last name", value: user.lastName, target: "profileLastName" },
    ] },
    { key: "contact", title: "Contact details", weight: 25, fields: [
      { label: "Email", value: user.email, target: null },
      { label: "Phone number", value: user.phone, target: "profilePhone" },
    ] },
    { key: "address", title: "Service address", weight: 50, fields: [
      { label: "Province", value: address.province, target: "profile-addressProvince" },
      { label: "City / municipality", value: address.city, target: "profile-addressCity" },
      { label: "Barangay", value: address.barangay, target: "profile-addressBarangay" },
      { label: "ZIP code", value: address.postalCode, target: "profile-addressPostal" },
    ] },
  ].map(group => {
    const missing = group.fields.filter(field => !hasText(field.value));
    return {
      key: group.key, title: group.title, weight: group.weight,
      total: group.fields.length, filled: group.fields.length - missing.length,
      complete: missing.length === 0,
      missingLabels: missing.map(field => field.label),
      target: missing.find(field => field.target)?.target || null,
    };
  });
  const filled = groups.reduce((sum, group) => sum + group.filled, 0);
  const total = groups.reduce((sum, group) => sum + group.total, 0);
  const seed = createHash("sha256").update(String(user._id || user.email || "customer")).digest();
  const palettes = [
    { background: "#e0ecff", body: "#5b78dd", accent: "#c2d1ff", dark: "#243d83" },
    { background: "#e8e2ff", body: "#8b70ce", accent: "#d5c8ff", dark: "#49336f" },
    { background: "#d9f2ed", body: "#45a795", accent: "#9fddd1", dark: "#215b52" },
    { background: "#ffebdb", body: "#db9869", accent: "#f8caa8", dark: "#7c4b30" },
    { background: "#fde3ec", body: "#d6789b", accent: "#f5b8cf", dark: "#783953" },
  ];
  return {
    filled, total, percent: Math.round(filled / total * 100), groups,
    nextTarget: groups.find(group => !group.complete && group.target)?.target || null,
    avatar: { ...palettes[seed[0] % palettes.length], variant: seed[1] % 3, accessory: seed[2] % 3 },
  };
}

module.exports = { customerProfilePresentation };

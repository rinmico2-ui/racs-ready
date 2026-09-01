const ACTIVE_CLAIM_STATUSES = new Set([
  "submitted", "triage", "inspection_scheduled", "inspection_en_route", "inspection_arrived", "inspection_in_progress",
  "inspection_completed", "approved", "partially_approved", "remedy_in_progress", "resolved",
]);

const ADMIN_TRANSITIONS = Object.freeze({
  submitted: ["triage", "inspection_scheduled", "denied"],
  triage: ["inspection_scheduled", "approved", "partially_approved", "denied"],
  inspection_scheduled: ["inspection_en_route", "inspection_in_progress", "triage"],
  inspection_en_route: ["inspection_arrived"],
  inspection_arrived: ["inspection_in_progress"],
  inspection_in_progress: ["inspection_completed"],
  inspection_completed: ["approved", "partially_approved", "denied"],
  approved: ["remedy_in_progress", "resolved"],
  partially_approved: ["remedy_in_progress", "resolved"],
  remedy_in_progress: ["resolved"],
  resolved: ["closed"],
  denied: ["closed"],
});

const TECHNICIAN_TRANSITIONS = Object.freeze({
  inspection_scheduled: ["inspection_en_route"],
  inspection_en_route: ["inspection_arrived"],
  inspection_arrived: ["inspection_in_progress"],
  inspection_in_progress: ["inspection_completed"],
});

function isActiveClaimStatus(status) {
  return ACTIVE_CLAIM_STATUSES.has(String(status || ""));
}

function canTransitionClaim(from, to, actorRole) {
  const map = actorRole === "technician" ? TECHNICIAN_TRANSITIONS : ADMIN_TRANSITIONS;
  return Boolean(map[String(from || "")]?.includes(String(to || "")));
}

function claimPriority({ safetyRisk = false, claimType = "", discoveredAt = new Date() } = {}) {
  if (safetyRisk || claimType === "safety_defect") return "critical";
  const ageHours = (Date.now() - new Date(discoveredAt).getTime()) / 3_600_000;
  return Number.isFinite(ageHours) && ageHours <= 24 ? "high" : "normal";
}

function cleanText(value, max = 3000) {
  return String(value || "").trim().replace(/\0/g, "").slice(0, max);
}

module.exports = {
  ACTIVE_CLAIM_STATUSES,
  ADMIN_TRANSITIONS,
  TECHNICIAN_TRANSITIONS,
  isActiveClaimStatus,
  canTransitionClaim,
  claimPriority,
  cleanText,
};

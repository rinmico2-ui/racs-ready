const mongoose = require("mongoose");
const { escapeRegex } = require("./stringSecurity");

const CATEGORIES = new Set([
  "booking", "order", "payment", "assignment", "project", "expense",
  "auth", "inventory", "settings", "system",
]);
const ACTION_TYPES = new Set([
  "created", "updated", "status_change", "cancelled", "deleted",
  "auth", "security", "action",
]);
const OUTCOMES = new Set(["success", "failure", "pending", "blocked", "unknown"]);
const RISK_LEVELS = new Set(["info", "low", "medium", "high", "critical"]);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function enumFilter(value, allowed, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (!allowed.has(normalized)) throw badRequest(`Invalid ${label} filter`);
  return normalized;
}

function boundedText(value, max, label) {
  const normalized = String(value || "").trim();
  if (normalized.length > max) throw badRequest(`${label} is too long`);
  return normalized;
}

function localDateBoundary(value, endOfDay) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) throw badRequest("Invalid audit date filter");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw badRequest("Invalid audit date filter");
  }
  date.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return date;
}

function normalizeAuditQuery(params = {}) {
  const category = enumFilter(params.category, CATEGORIES, "category");
  const actionType = enumFilter(params.actionType, ACTION_TYPES, "action type");
  const outcome = enumFilter(params.outcome, OUTCOMES, "outcome");
  const riskLevel = enumFilter(params.riskLevel, RISK_LEVELS, "risk level");
  const entityType = boundedText(params.entityType, 80, "Entity type");
  const moduleName = boundedText(params.module, 80, "Module");
  const search = boundedText(params.q, 100, "Search");
  const from = localDateBoundary(params.from, false);
  const to = localDateBoundary(params.to, true);
  if (from && to && from > to) throw badRequest("From date must not be after to date");

  const page = Math.max(1, Math.min(100000, Number.parseInt(params.page, 10) || 1));
  const limit = Math.max(10, Math.min(100, Number.parseInt(params.limit, 10) || 25));
  const sort = params.sort === "createdAt" ? { createdAt: 1 } : { createdAt: -1 };
  const query = {};

  if (category) query.category = category;
  if (actionType) query.actionType = actionType;
  if (outcome) query.outcome = outcome;
  if (riskLevel) query.riskLevel = riskLevel;
  if (entityType) query.entityType = entityType;
  if (moduleName) query.module = moduleName;
  if (params.actor && mongoose.Types.ObjectId.isValid(params.actor)) query.actor = params.actor;
  if (params.referenceId && mongoose.Types.ObjectId.isValid(params.referenceId)) query.entityId = params.referenceId;
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = from;
    if (to) query.createdAt.$lte = to;
  }
  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    query.$or = [
      { action: regex },
      { actorName: regex },
      { actorRole: regex },
      { entityType: regex },
      { module: regex },
      { ip: regex },
      { requestId: regex },
      { requestPath: regex },
    ];
  }

  return { query, page, limit, sort };
}

function csvCell(value) {
  let output = String(value == null ? "" : value);
  if (/^[=+\-@\t\r]/.test(output)) output = `'${output}`;
  return `"${output.replace(/"/g, '""')}"`;
}

module.exports = {
  normalizeAuditQuery,
  csvCell,
  localDateBoundary,
  CATEGORIES,
  ACTION_TYPES,
  OUTCOMES,
  RISK_LEVELS,
};

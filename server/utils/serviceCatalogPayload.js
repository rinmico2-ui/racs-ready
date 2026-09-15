"use strict";

function payloadError(field, expected) {
  const error = new Error(`${field} must be valid ${expected} JSON.`);
  error.status = 400;
  error.code = "INVALID_SERVICE_PAYLOAD";
  return error;
}

function parseJsonField(value, field, expectedType) {
  if (value === undefined) return value;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (_) {
      throw payloadError(field, expectedType);
    }
  }

  const valid = expectedType === "array"
    ? Array.isArray(parsed)
    : parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (!valid) throw payloadError(field, expectedType);
  return parsed;
}

function parseBooleanField(value, field) {
  if (value === undefined || typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  const error = new Error(`${field} must be true or false.`);
  error.status = 400;
  error.code = "INVALID_SERVICE_PAYLOAD";
  throw error;
}

function normalizeServiceCatalogPayload(body, options = {}) {
  const payload = { ...(body || {}) };
  for (const field of options.arrayFields || []) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      payload[field] = parseJsonField(payload[field], field, "array");
    }
  }
  for (const field of options.objectFields || []) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      payload[field] = parseJsonField(payload[field], field, "object");
    }
  }
  for (const field of options.booleanFields || []) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      payload[field] = parseBooleanField(payload[field], field);
    }
  }
  return payload;
}

function normalizeCoreServicePayload(body) {
  return normalizeServiceCatalogPayload(body, {
    arrayFields: ["features", "includedItems", "exclusions", "airconTypes"],
    objectFields: ["warrantyPolicy"],
    booleanFields: ["isAirconService", "active"],
  });
}

function normalizeRepairServicePayload(body) {
  return normalizeServiceCatalogPayload(body, {
    arrayFields: ["airconTypes"],
    objectFields: ["warrantyPolicy"],
    booleanFields: ["isAirconService", "allowTechnicianPricing", "active"],
  });
}

module.exports = {
  normalizeCoreServicePayload,
  normalizeRepairServicePayload,
};

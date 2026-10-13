"use strict";
const { parseHp } = require('../public/js/appliance-services');

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
  const payload = normalizeServiceCatalogPayload(body, {
    arrayFields: ["features", "includedItems", "exclusions", "airconTypes", "hpPricing", "applianceProfiles"],
    objectFields: ["warrantyPolicy"],
    booleanFields: ["isAirconService", "active"],
  });
  const groups = payload.airconTypes || [];
  const types = new Set();
  function invalid(message) { const error = new Error(message); error.status = 400; error.code = 'INVALID_SERVICE_PAYLOAD'; throw error; }
  const appliances = new Set();
  for (const profile of payload.applianceProfiles || []) {
    if (!profile || !['refrigerator', 'freezer'].includes(profile.kind) || appliances.has(profile.kind) || typeof profile.enabled !== 'boolean') invalid('Choose distinct refrigerator or freezer service settings.');
    appliances.add(profile.kind);
    profile.pricingMode = profile.pricingMode || 'fixed';
    if (!['fixed', 'hp'].includes(profile.pricingMode)) invalid('Choose a fixed price or compressor HP pricing.');
    const validPrice = value => value != null && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1000000;
    const validTime = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 10080;
    if (profile.hpPricing != null && !Array.isArray(profile.hpPricing)) invalid('Compressor HP prices must be a list.');
    const seenHp = new Set();
    for (const tier of profile.hpPricing || []) {
      const hp = parseHp(tier?.hp);
      if (!Number.isFinite(hp) || seenHp.has(hp) || !validPrice(tier?.price) || !validTime(tier?.durationMinutes)) invalid('Each compressor HP needs a unique positive size, a price, and a whole work time from 1 to 10080 minutes.');
      tier.hp = hp; seenHp.add(hp);
    }
    if (profile.enabled && profile.pricingMode === 'hp' && !seenHp.size) invalid('Add at least one compressor HP price before enabling this appliance.');
    if (profile.enabled && profile.pricingMode === 'fixed' && (!validPrice(profile.unitPrice) || !validTime(profile.durationMinutes))) invalid('Enabled appliance services need a price and a work time in minutes.');
  }
  for (const group of groups) {
    if (!group || !Array.isArray(group.hpPricing)) invalid('Each aircon type needs a list of HP prices.');
    if (types.has(group.type)) invalid('Each aircon type can appear only once. Add more HP tiers to the existing type.');
    types.add(group.type);
  }
  for (const tiers of [...groups.map(group => group.hpPricing), ...(payload.hpPricing ? [payload.hpPricing] : [])]) {
    const seen = new Set();
    for (const tier of tiers) {
      const hp = Number(tier?.hp), price = Number(tier?.price);
      if (!tier || tier.hp == null || String(tier.hp).trim() === '' || !Number.isFinite(hp) || hp <= 0) invalid('Enter a valid positive HP for every tier.');
      if (tier.price == null || String(tier.price).trim() === '' || !Number.isFinite(price) || price < 0) invalid('Enter a valid price for every HP tier.');
      if (seen.has(hp)) invalid('The same HP cannot have multiple prices for one aircon type.');
      if (tier.durationMinutes != null && (!Number.isInteger(Number(tier.durationMinutes)) || Number(tier.durationMinutes) < 1)) invalid('Service duration must be a positive whole number of minutes.');
      seen.add(hp);
    }
  }
  return payload;
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

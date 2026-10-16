"use strict";

const { normalizeRelocation, assertStandaloneServices } = require('./relocationBookingPolicy');
const A = require("../public/js/appliance-services");
const { resolveCoreServicePricing } = require("./coreServicePricing");

function resolveWalkInCoreSelection(catalog, requested) {
  try {
    const pricing = resolveCoreServicePricing(catalog, requested);
    const result = { ...pricing };
    if (requested.applianceKind) result.applianceKind = requested.applianceKind;
    if (requested.applianceGroupId) result.applianceGroupId = String(requested.applianceGroupId);
    if (A.isRelocation(catalog) && requested.applianceKind) {
      if (requested.relocation?.scope !== "same_property") {
        throw new Error("For another address, use the service booking with both map pins.");
      }
      result.relocation = A.serviceLines([catalog], requested, [String(catalog._id)], result.applianceGroupId, requested.relocation)[0].relocation;
    }
    return result;
  } catch (error) {
    error.status = 400;
    throw error;
  }
}

function pinWalkInRelocations(items, location) {
  assertStandaloneServices(items);
  for (const item of items) {
    if (item.relocation) item.relocation = normalizeRelocation(item.relocation, location, item.quantity);
  }
}

module.exports = { resolveWalkInCoreSelection, pinWalkInRelocations };

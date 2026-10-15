"use strict";

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
        throw new Error("A move to another address needs a relocation quote before a walk-in appointment can be created.");
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
  for (const item of items) {
    if (item.relocation?.scope !== "same_property") continue;
    const lat = Number(location?.lat), lng = Number(location?.lng);
    if (location?.lat == null || location?.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw Object.assign(new Error("Pin the property on the map before creating a nearby relocation appointment."), { status: 400 });
    }
    const property = { lat, lng, address: String(location.address || "") };
    item.relocation.from = { ...item.relocation.from, ...property };
    item.relocation.to = { ...item.relocation.to, ...property };
  }
}

module.exports = { resolveWalkInCoreSelection, pinWalkInRelocations };

"use strict";

function coordinate(value) {
  if (value === null || value === undefined || String(value).trim() === "") return NaN;
  return Number(value);
}

function normalizeServiceLocation(value) {
  const address = String(value?.address || "").trim().slice(0, 500);
  const lat = coordinate(value?.lat ?? value?.coordinates?.coordinates?.[1]);
  const lng = coordinate(value?.lng ?? value?.coordinates?.coordinates?.[0]);
  const pinned = Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= 4.5 && lat <= 21.5 && lng >= 116 && lng <= 127;
  return { address, ...(pinned ? { lat, lng, coordinates: { type: "Point", coordinates: [lng, lat] } } : {}) };
}

function resolveMaintenanceLocation(asset, source) {
  const saved = normalizeServiceLocation(asset?.serviceLocation);
  const address = String(asset?.serviceAddress || saved.address || "").trim();
  if (saved.lat !== undefined && (!address || address.toLowerCase() === saved.address.toLowerCase())) {
    return { ...saved, address: address || saved.address };
  }
  const relocation = (source?.services || []).find(item =>
    item.relocation?.to?.address && asset?.originItemKey?.startsWith(`service-${String(item._id || item.serviceId)}-`));
  const origin = normalizeServiceLocation(relocation?.relocation?.to
    || (asset?.originType === "order" ? source?.delivery : source?.location));
  // A changed address must never inherit the map pin for the old property.
  if (address && origin.address && address.toLowerCase() !== origin.address.toLowerCase()) return { address };
  return { ...origin, address: address || origin.address || String(source?.customer?.address || "").trim() };
}

function requireServiceLocation(value) {
  const location = normalizeServiceLocation(value);
  if (location.address.length < 5 || location.lat === undefined) {
    throw Object.assign(new Error("Choose a suggested address or place a map pin, then enter the full service address."), { status: 400, code: "MAINTENANCE_LOCATION_REQUIRED" });
  }
  return location;
}

module.exports = { normalizeServiceLocation, resolveMaintenanceLocation, requireServiceLocation };

"use strict";

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function positiveQuantity(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isRepairBooking(booking = {}) {
  const serviceType = text(booking.serviceType).toLowerCase();
  const serviceModel = text(booking.serviceModel).toLowerCase();
  const status = text(booking.status).toLowerCase();
  return serviceType === "repair"
    || serviceType === "mixed"
    || serviceModel === "repairservice"
    || Boolean(booking.unitInfo)
    || status.startsWith("repair_")
    || (Array.isArray(booking.services) && booking.services.some(item => text(item?.type).toLowerCase() === "repair"));
}

function repairItem(item = {}, booking = {}, index = 0) {
  const unitInfo = index === 0 && booking.unitInfo ? booking.unitInfo : {};
  const unitType = text(
    item.unitType
      || item.applianceTypeName
      || item.airconTypeName
      || item.unitCategory
      || unitInfo.unitType
      || booking.applianceTypeName
      || booking.applianceType,
  );
  const brand = text(item.brand || unitInfo.brand || booking.brand);
  const model = text(item.model || unitInfo.model);
  const problemDescription = text(
    item.problemDescription
      || item.repairIssue
      || unitInfo.problemDescription
      || booking.issueDescription
      || booking.repairIssues,
  );
  const photos = [
    ...(Array.isArray(item.photos) ? item.photos : []),
    ...(index === 0 && Array.isArray(unitInfo.photos) ? unitInfo.photos : []),
  ].map(text).filter(Boolean).filter((url, photoIndex, all) => all.indexOf(url) === photoIndex);

  return {
    _id: item._id || null,
    name: text(item.name) || [unitType, "Repair"].filter(Boolean).join(" ") || "Repair Service",
    unitType: unitType || "Not recorded",
    brand: brand || "Not recorded",
    model,
    problemDescription: problemDescription || "Not recorded",
    quantity: positiveQuantity(item.quantity, positiveQuantity(booking.quantity)),
    status: text(item.status || booking.status) || "pending",
    phase: text(item.phase),
    schedule: item.schedule || null,
    photos,
    quotation: item.quotation || null,
  };
}

function customerRepairDetails(booking = {}) {
  if (!isRepairBooking(booking)) return null;

  const services = Array.isArray(booking.services) ? booking.services.filter(Boolean) : [];
  const repairServices = services.filter(item => text(item.type).toLowerCase() === "repair");
  const sourceItems = repairServices.length
    ? repairServices
    : (text(booking.serviceType).toLowerCase() === "repair" ? services : []);
  const items = sourceItems.length
    ? sourceItems.map((item, index) => repairItem(item, booking, index))
    : [repairItem({}, booking, 0)];

  return {
    items,
    applianceCount: items.length,
    unitCount: items.reduce((sum, item) => sum + item.quantity, 0),
    primary: items[0],
  };
}

function enrichCustomerBooking(booking = {}) {
  const presented = { ...booking };
  const repairDetails = customerRepairDetails(presented);
  if (repairDetails) presented.customerRepairDetails = repairDetails;
  return presented;
}

module.exports = { customerRepairDetails, enrichCustomerBooking, isRepairBooking };

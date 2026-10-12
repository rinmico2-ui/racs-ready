"use strict";

const { stagesForItem } = require("./relocationChecklist");
const { relocationLocations } = require("./relocationLocation");
const ref = value => String(value?._id || value || "");
const READABLE_STATES = ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress", "waiting_for_customer", "no_show_reported", "completed"];
const CLOSED_STATES = new Set(["cancelled", "rejected", "closed", "completed", "repair_completed", "expired", "repair_declined"]);
const rank = new Map(["in_progress", "on_site", "en_route", "accepted", "waiting_for_customer", "no_show_reported", "pending_acceptance", "completed"].map((status, index) => [status, index]));

function isRelocationService(item) {
  return ["same_property", "custom_quote"].includes(item?.relocation?.scope)
    || /\baircon[\s_-]+relocation\b/i.test(String(item?.name || item?.serviceName || ""))
    || item?.slug === "aircon-relocation";
}

function ownsItem(item, booking, assignment, technicianId) {
  if (ref(assignment.technicianId) !== ref(technicianId) || ref(assignment.bookingId) !== ref(booking._id)) return false;
  if (assignment.serviceType === "repair") return false;
  if (assignment.serviceItemId && ref(assignment.serviceItemId) !== ref(item._id)) return false;
  if (item.technicianId && ref(item.technicianId) !== ref(technicianId)) return false;
  if (item.assignmentId && ref(item.assignmentId) !== ref(assignment._id)) return false;
  const explicitItemOwner = ref(item.assignmentId) === ref(assignment._id) || ref(item.technicianId) === ref(technicianId);
  if (!explicitItemOwner && !(booking.isProject && assignment.serviceType === "project")) {
    if (booking.technicianId && ref(booking.technicianId) !== ref(technicianId)) return false;
    if (booking.assignmentId && ref(booking.assignmentId) !== ref(assignment._id)) return false;
  }
  return true;
}

function assignedRelocationItems(booking, assignments, technicianId) {
  const candidates = (assignments || []).filter(assignment => READABLE_STATES.includes(assignment.status))
    .sort((left, right) => rank.get(left.status) - rank.get(right.status)
      || new Date(right.assignedAt || 0) - new Date(left.assignedAt || 0));
  let services = booking.services || [];
  const virtual = !services.length;
  if (virtual) {
    const name = booking.service?.name || booking.serviceName || candidates.find(assignment => isRelocationService(assignment))?.serviceName;
    if (!isRelocationService({ name })) return [];
    // Represent an older single-service booking without writing on a GET.
    const quantity = Math.max(1, Math.min(40, Math.round(Number(booking.quantity) || 1)));
    const unitPrice = Math.max(0, Number(booking.servicePrice ?? booking.service?.basePrice) || 0);
    services = [{ _id: booking._id, name, serviceId: booking.serviceId || null, type: "core", quantity,
      brand: booking.brand || booking.unitInfo?.brand || "", hp: booking.hp || booking.unitInfo?.hp,
      airconType: booking.applianceType,
      unitPrice, totalPrice: unitPrice * quantity,
      duration: Number(booking.serviceDurationMinutes || 0) / quantity || undefined,
      phase: "core", relocation: { model: booking.unitInfo?.model || "" } }];
  }
  return services.filter(isRelocationService).flatMap(item => {
    const assignment = candidates.find(candidate => ownsItem(item, booking, candidate, technicianId));
    return assignment ? [{ item, assignment, virtual }] : [];
  });
}

function presentRelocationItem({ item, assignment, virtual }, booking) {
  const move = item.relocation || {};
  const { from, to, sameProperty } = relocationLocations(move, booking.location);
  const legacy = !["same_property", "custom_quote"].includes(move.scope);
  const type = item.airconType || item.applianceType || booking.applianceType || "";
  const stages = stagesForItem({ ...item, airconType: type });
  const keys = stages.flatMap(stage => stage.tasks.map(([key]) => `${stage.key}.${key}`));
  const missingDetails = [];
  if (!type) missingDetails.push('Aircon type');
  if (legacy) missingDetails.push('Move type: same property or another address');
  if (!from.address) missingDetails.push('Current address');
  if (sameProperty) {
    if (!from.details?.trim()) missingDetails.push('Current position: room, floor or wall');
    if (!to.details?.trim()) missingDetails.push('New position: room, floor or wall');
  } else {
    if (!to.address) missingDetails.push(legacy ? 'New position or address' : 'New address');
    if (!legacy && from.lat === undefined) missingDetails.push('Current map pin');
    if (!legacy && to.lat === undefined) missingDetails.push('New map pin');
  }
  return { id: item._id, name: item.name, brand: item.brand, model: move.model || item.model,
    serialNumber: move.serialNumber, from, to, sameProperty, legacy,
    scope: move.scope || null, missingDetails, detailsMissing: missingDetails.length > 0,
    airconType: type, airconTypeName: item.airconTypeName || item.applianceTypeName || booking.applianceTypeName || type,
    hp: item.hp || booking.hp || null, quantity: item.quantity || 1, stages,
    assignmentId: assignment._id, assignmentStatus: assignment.status,
    editable: !!item._id && assignment.status === "in_progress" && !CLOSED_STATES.has(booking.status) && !CLOSED_STATES.has(item.status),
    completedTasks: [...new Set(move.completedTasks || [])].filter(task => keys.includes(task)),
    virtual };
}

module.exports = { READABLE_STATES, CLOSED_STATES, isRelocationService, assignedRelocationItems, presentRelocationItem };

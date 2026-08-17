const DIRECT_EDIT_STATUSES = new Set(["pending", "payment_verified", "awaiting_assignment"]);
const STARTED_STATUSES = new Set([
  "on-the-way", "arrived", "in-progress", "inspection_in_progress",
  "repair_in_progress", "completed", "cancelled",
]);

function itemKey(item, index) {
  return String(item?._id || item?.clientId || `index:${index}`);
}

function plainServices(services) {
  return (services || []).map(item => {
    const raw = typeof item?.toObject === "function" ? item.toObject() : item;
    return JSON.parse(JSON.stringify(raw || {}));
  });
}

function bookingServices(booking) {
  if (Array.isArray(booking?.services) && booking.services.length) return plainServices(booking.services);
  return [{
    serviceId: booking?.serviceId,
    name: booking?.service?.name || "Service",
    type: booking?.serviceType || (booking?.serviceModel === "RepairService" ? "repair" : "core"),
    quantity: Number(booking?.quantity || 1),
    unitPrice: Number(booking?.servicePrice || 0),
    totalPrice: Number(booking?.totalPrice || booking?.servicePrice || 0),
    duration: Number(booking?.serviceDurationMinutes || 60),
    brand: booking?.unitInfo?.brand || booking?.brand || "",
    model: booking?.unitInfo?.model || "",
    applianceType: booking?.applianceType || "",
    applianceTypeName: booking?.applianceTypeName || booking?.unitInfo?.unitType || "",
    repairIssue: booking?.issueDescription || booking?.unitInfo?.problemDescription || "",
    problemDescription: booking?.issueDescription || booking?.unitInfo?.problemDescription || "",
    status: booking?.status || "pending",
    phase: booking?.serviceType === "repair" ? "repair_phase_1" : "core",
  }];
}

function mutationPolicy(booking) {
  const parentStatus = String(booking?.status || "pending");
  const itemStarted = (booking?.services || []).some(item => STARTED_STATUSES.has(String(item.status || "")));
  if (STARTED_STATUSES.has(parentStatus) || itemStarted) {
    return { mode: "request", direct: false, reason: "Work has started; admin approval is required." };
  }
  if (DIRECT_EDIT_STATUSES.has(parentStatus) && !booking?.technicianId && !booking?.assignmentId) {
    return { mode: "direct", direct: true, reason: "Booking has not been assigned." };
  }
  return { mode: "request", direct: false, reason: "The booking is assigned or operationally committed." };
}

function summarizeChanges(before, proposed) {
  const beforeRows = plainServices(before);
  const proposedRows = plainServices(proposed);
  const beforeMap = new Map(beforeRows.map((item, index) => [itemKey(item, index), item]));
  const proposedMap = new Map(proposedRows.map((item, index) => [itemKey(item, index), item]));
  let added = 0, edited = 0, removed = 0;
  proposedMap.forEach((item, key) => {
    if (!beforeMap.has(key)) added++;
    else {
      const a = { ...beforeMap.get(key), _id: undefined, statusHistory: undefined };
      const b = { ...item, _id: undefined, statusHistory: undefined };
      if (JSON.stringify(a) !== JSON.stringify(b)) edited++;
    }
  });
  beforeMap.forEach((_, key) => { if (!proposedMap.has(key)) removed++; });
  return { added, edited, removed };
}

function capacityMinutes(services, inspectionDurationMinutes = 90) {
  return (services || []).reduce((sum, item) => {
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const perUnit = item.type === "repair"
      ? inspectionDurationMinutes
      : Math.max(1, Number(item.schedule?.durationMinutes || item.duration || 60));
    return sum + perUnit * quantity;
  }, 0);
}

function aggregateBookingType(services) {
  const types = new Set((services || []).map(item => item.type === "repair" ? "repair" : "core"));
  return types.size > 1 ? "mixed" : (types.values().next().value || "core");
}

const COMMON_TRANSITIONS = {
  pending: ["assigned", "cancelled"],
  assigned: ["accepted", "on_hold", "cancelled"],
  accepted: ["scheduled", "en_route", "inspection_scheduled", "on_hold", "cancelled"],
  scheduled: ["en_route", "on_hold", "cancelled"],
  en_route: ["arrived", "on_hold"],
  on_hold: ["accepted", "in_progress", "inspection_scheduled", "repair_scheduled", "cancelled"],
};

const CORE_TRANSITIONS = {
  ...COMMON_TRANSITIONS,
  arrived: ["in_progress", "on_hold"],
  in_progress: ["completed", "on_hold"],
  completed: [], cancelled: [],
};

const REPAIR_TRANSITIONS = {
  ...COMMON_TRANSITIONS,
  pending: ["assigned", "inspection_scheduled", "cancelled"],
  assigned: ["accepted", "inspection_scheduled", "on_hold", "cancelled"],
  inspection_pending: ["assigned", "inspection_scheduled", "cancelled"],
  inspection_scheduled: ["en_route", "inspection_in_progress", "on_hold", "cancelled"],
  arrived: ["inspection_in_progress", "repair_in_progress", "on_hold"],
  inspection_in_progress: ["inspection_completed", "on_hold"],
  inspection_completed: ["diagnosis_completed"],
  diagnosis_completed: ["parts_check", "awaiting_quotation"],
  parts_check: ["awaiting_quotation", "on_hold"],
  awaiting_quotation: ["awaiting_customer_decision"],
  awaiting_customer_decision: [],
  repair_approved: ["ready_for_repair", "repair_scheduled"],
  ready_for_repair: ["repair_scheduled"],
  repair_scheduled: ["en_route", "repair_in_progress", "on_hold", "cancelled"],
  repair_in_progress: ["payment_pending", "completed", "on_hold"],
  payment_pending: ["completed"],
  completed: [], cancelled: [],
};

function canTransitionServiceItem(item, nextStatus) {
  const current = String(item?.status || (item?.type === "repair" ? "inspection_pending" : "pending"));
  if (current === nextStatus) return true;
  const graph = item?.type === "repair" ? REPAIR_TRANSITIONS : CORE_TRANSITIONS;
  return (graph[current] || []).includes(nextStatus);
}

module.exports = { bookingServices, mutationPolicy, summarizeChanges, capacityMinutes, aggregateBookingType, plainServices, canTransitionServiceItem };

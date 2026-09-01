const mongoose = require("mongoose");
const { buildServicePreparation } = require("./servicePreparation");

const ACTIVE_INSTALLATION_ORDER_STATUSES = [
  "technician_accepted",
  "out_for_delivery",
  "arrived",
  "installing",
];

const RESOLVED_ITEM_STATUSES = new Set([
  "confirmed_available",
  "not_required",
  "assigned_from_stock",
  "procured",
  "rescheduled",
]);

function orderUnitCount(order) {
  return Math.max(1, (order?.items || []).reduce(
    (sum, item) => sum + Math.max(1, Number(item?.quantity) || 1),
    0,
  ));
}

/**
 * Use the same catalog-backed recommendation engine as Core Service
 * installation bookings. The sellable air-conditioning units themselves are
 * intentionally excluded: they belong to the order dispatch contract.
 */
async function buildOrderInstallationPreparation(order, opts = {}) {
  if (!order || order.fulfillmentType !== "delivery_installation") {
    return { serviceName: "Delivery", recommendations: [], catalog: [] };
  }

  const units = (order.items || []).map((item) => ({
    name: `${item.brand || "Air Conditioner"} ${item.modelLine || ""} Installation`.trim(),
    type: "core",
    quantity: Math.max(1, Number(item.quantity) || 1),
    applianceTypeName: item.modelLine || "Air Conditioner",
    hpDescription: item.capacity ? `${item.capacity} ${item.capacityUnit || "HP"}` : "",
  }));
  const bookingShape = {
    serviceType: "core",
    serviceName: "Air Conditioner Installation",
    service: { name: "Air Conditioner Installation" },
    services: units.length ? units : [{ name: "Air Conditioner Installation", type: "core" }],
  };
  return buildServicePreparation(bookingShape, opts);
}

function itemReferencesOrder(item, orderId) {
  return (item?.orderIds || []).some((id) => String(id) === String(orderId));
}

function itemIsUnresolved(item) {
  if (item?.exception?.approved) return false;
  if (item?.checkoutStatus !== "unavailable") return false;
  return !RESOLVED_ITEM_STATUSES.has(item?.resolution?.status);
}

function orderInstallationReadiness(order, kit) {
  if (!order || order.fulfillmentType !== "delivery_installation") {
    return {
      status: "not_required",
      dailyKitId: null,
      requiredItems: [],
      blockers: [],
      confirmedAt: null,
    };
  }

  if (!kit) {
    return {
      status: "pending",
      dailyKitId: null,
      requiredItems: [],
      blockers: ["Daily Preparation has not been generated for this installation."],
      confirmedAt: null,
    };
  }

  const orderId = order._id || order.id;
  const items = (kit.items || []).filter((item) => itemReferencesOrder(item, orderId));
  const deltaItems = (kit.deltaItems || []).filter((item) => itemReferencesOrder(item, orderId));
  const unresolved = items.filter(itemIsUnresolved);
  const undecidedDelta = deltaItems.filter((item) => !RESOLVED_ITEM_STATUSES.has(item?.resolution?.status));
  const blockers = [];

  if (order.technicianId && kit.technicianId && String(order.technicianId) !== String(kit.technicianId)) {
    blockers.push("The Daily Kit belongs to a different technician.");
  }
  if (order.delivery?.preferredDate && kit.workDate) {
    const scheduled = new Date(order.delivery.preferredDate);
    const kitDate = new Date(kit.workDate);
    const dayKey = (value) => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
    if (!Number.isNaN(scheduled.getTime()) && !Number.isNaN(kitDate.getTime()) && dayKey(scheduled) !== dayKey(kitDate)) {
      blockers.push("The Daily Kit does not cover this installation date.");
    }
  }

  for (const item of unresolved) {
    blockers.push(item?.conflict?.message || `${item.name} is unavailable.`);
  }
  if (undecidedDelta.length) {
    blockers.push(`Review newly added Daily Kit items: ${undecidedDelta.map((item) => item.name).join(", ")}.`);
  }
  if (!["confirmed", "in_progress"].includes(kit.status)) {
    blockers.push("Daily Preparation must be confirmed before departure.");
  }
  if (!items.length && !deltaItems.length) {
    blockers.push("No installation requirements are linked to this order yet.");
  }

  const snapshotMap = new Map();
  for (const item of [...items, ...deltaItems]) {
    const allocation = (item.orderAllocations || []).find((row) => String(row.orderId) === String(orderId));
    const key = `${item.category}:${String(item.toolId || item.name).toLowerCase()}`;
    const snapshot = {
      name: item.name,
      category: item.category,
      quantity: Number(allocation?.quantity ?? item.quantity ?? 0),
      unit: item.unit || "pcs",
      status: item.checkoutStatus || "pending",
    };
    const prior = snapshotMap.get(key);
    if (!prior || snapshot.quantity >= prior.quantity) snapshotMap.set(key, snapshot);
  }
  const snapshots = [...snapshotMap.values()];

  return {
    status: blockers.length
      ? (unresolved.length ? "blocked" : "pending")
      : "confirmed",
    dailyKitId: kit._id || null,
    requiredItems: snapshots,
    blockers: [...new Set(blockers)],
    confirmedAt: blockers.length ? null : (kit.confirmedAt || new Date()),
  };
}

function orderDepartureReadiness(order, kit) {
  const blockers = [];
  const dispatchStatus = order?.preparation?.dispatch?.status || "pending";
  if (dispatchStatus !== "ready") {
    blockers.push("The ordered unit has not been marked dispatch-ready by operations.");
  }

  const installation = orderInstallationReadiness(order, kit);
  if (installation.status !== "not_required" && installation.status !== "confirmed") {
    blockers.push(...installation.blockers);
  }

  return {
    ready: blockers.length === 0,
    blockers: [...new Set(blockers)],
    dispatchStatus,
    installation,
  };
}

function objectIds(values) {
  return [...new Set((values || []).filter(Boolean).map(String))]
    .filter(mongoose.isValidObjectId)
    .map((id) => new mongoose.Types.ObjectId(id));
}

module.exports = {
  ACTIVE_INSTALLATION_ORDER_STATUSES,
  RESOLVED_ITEM_STATUSES,
  buildOrderInstallationPreparation,
  itemIsUnresolved,
  itemReferencesOrder,
  objectIds,
  orderDepartureReadiness,
  orderInstallationReadiness,
  orderUnitCount,
};

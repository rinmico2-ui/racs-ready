const mongoose = require("mongoose");

const ORDER_STATUSES = new Set([
  "pending_payment",
  "preparing_unit",
  "ready_for_pickup",
  "technician_assigned",
  "technician_accepted",
  "technician_declined",
  "out_for_delivery",
  "arrived",
  "installing",
  "completed",
  "cancelled",
]);
const PAYMENT_STATUSES = new Set([
  "pending",
  "payment_collected",
  "waiting_for_remittance",
  "remitted",
  "verified",
  "rejected",
  "refunded",
  "paid",
  "failed",
  "partial",
]);
const FULFILLMENT_TYPES = new Set(["delivery_only", "delivery_installation", "customer_pickup"]);
const PAYMENT_METHODS = new Set([
  "cod",
  "gcash",
  "paymongo",
  "other",
  "cash_onsite",
  "gcash_full",
  "gcash_downpayment",
  "cash",
  "downpayment",
]);

function scalar(value, maxLength = 100) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim().slice(0, maxLength) : "";
}

function enumValue(value, allowed) {
  const normalized = scalar(value);
  return allowed.has(normalized) ? normalized : "";
}

function moneyValue(value) {
  const normalized = scalar(value, 30);
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000_000 ? amount : null;
}

function parseOrderReportFilters(source = {}) {
  let minValue = moneyValue(source.minValue);
  let maxValue = moneyValue(source.maxValue);
  if (minValue !== null && maxValue !== null && minValue > maxValue) {
    [minValue, maxValue] = [maxValue, minValue];
  }

  const technicianInput = scalar(source.technician, 40);
  const technician = technicianInput === "unassigned" || mongoose.isValidObjectId(technicianInput)
    ? technicianInput
    : "";
  const filters = {
    q: scalar(source.q, 80),
    status: enumValue(source.status, ORDER_STATUSES),
    paymentStatus: enumValue(source.paymentStatus, PAYMENT_STATUSES),
    fulfillment: enumValue(source.fulfillment, FULFILLMENT_TYPES),
    paymentMethod: enumValue(source.paymentMethod, PAYMENT_METHODS),
    technician,
    brand: scalar(source.brand, 80),
    minValue,
    maxValue,
  };
  filters.activeCount = Object.entries(filters).filter(([key, value]) => key !== "activeCount" && value !== "" && value !== null).length;
  return filters;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildOrderFilter(filters = {}) {
  const clauses = [];
  if (filters.status) clauses.push({ status: filters.status });
  if (filters.paymentStatus) clauses.push({ paymentStatus: filters.paymentStatus });
  if (filters.fulfillment) clauses.push({ fulfillmentType: filters.fulfillment });
  if (filters.paymentMethod) clauses.push({ paymentMethod: filters.paymentMethod });
  if (filters.technician === "unassigned") clauses.push({ technicianId: null });
  else if (filters.technician) {
    clauses.push({ $or: [{ technicianId: filters.technician }, { "technician._id": filters.technician }] });
  }
  if (filters.brand) clauses.push({ "items.brand": new RegExp(`^${escapeRegex(filters.brand)}$`, "i") });
  if (filters.minValue !== null || filters.maxValue !== null) {
    const total = {};
    if (filters.minValue !== null) total.$gte = filters.minValue;
    if (filters.maxValue !== null) total.$lte = filters.maxValue;
    clauses.push({ total });
  }
  if (filters.q) {
    const search = new RegExp(escapeRegex(filters.q), "i");
    clauses.push({
      $or: [
        { orderReference: search },
        { "customer.name": search },
        { "customer.email": search },
        { "customer.phone": search },
        { "items.brand": search },
        { "items.modelLine": search },
      ],
    });
  }
  return combineOrderFilters(...clauses);
}

function combineOrderFilters(...filters) {
  const populated = filters.filter(filter => filter && Object.keys(filter).length);
  if (!populated.length) return {};
  if (populated.length === 1) return populated[0];
  return { $and: populated };
}

function serializableOrderFilters(filters = {}) {
  return {
    q: filters.q || "",
    status: filters.status || "",
    paymentStatus: filters.paymentStatus || "",
    fulfillment: filters.fulfillment || "",
    paymentMethod: filters.paymentMethod || "",
    technician: filters.technician || "",
    brand: filters.brand || "",
    minValue: filters.minValue,
    maxValue: filters.maxValue,
  };
}

module.exports = {
  FULFILLMENT_TYPES,
  ORDER_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  buildOrderFilter,
  combineOrderFilters,
  parseOrderReportFilters,
  serializableOrderFilters,
};

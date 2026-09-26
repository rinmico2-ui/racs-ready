const ProductReturn = require("../models/ProductReturn");
const ProductRefund = require("../models/ProductRefund");
const Payment = require("../models/Payment");
const SiteSetting = require("../models/SiteSetting");

const OPEN_STATUSES = [
  "requested", "under_review", "awaiting_return", "received", "inspected",
  "refund_pending", "refund_approved", "refund_processing", "replacement_pending", "repair_pending",
];

const TRANSITIONS = Object.freeze({
  requested: ["under_review", "rejected", "cancelled"],
  under_review: ["awaiting_return", "rejected"],
  awaiting_return: ["received", "cancelled"],
  received: ["inspected"],
  inspected: ["inspected", "refund_pending", "replacement_pending", "repair_pending", "rejected"],
  refund_pending: ["refund_approved", "rejected"],
  refund_approved: ["refund_processing"],
  refund_processing: ["completed"],
  replacement_pending: ["completed"],
  repair_pending: ["completed"],
});

function money(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function canTransition(from, to) { return Boolean(TRANSITIONS[from]?.includes(to)); }
function itemFor(sourceType, source, index) {
  if (!Number.isInteger(index) || index < 0) return null;
  return source.items?.[index] || null;
}
function itemPrice(sourceType, source, item) {
  const quantity = Math.max(1, Number(item.quantity) || 1);
  const gross = money(Number(item.totalPrice) || Number(item.unitPrice || 0) * quantity);
  const subtotal = Number(source.subtotal) || (source.items || []).reduce((sum, row) => sum + Number(row.totalPrice || 0), 0);
  const discount = Math.max(0, Number(source.discount) || 0);
  const net = subtotal > 0 ? gross * Math.max(0, subtotal - discount) / subtotal : gross;
  return money(net);
}
function sourceTotal(sourceType, source) {
  return Number(sourceType === "order" ? source.total : source.totalAmount) || 0;
}
function purchaseDate(sourceType, source) {
  return sourceType === "order" ? (source.completedAt || source.updatedAt || source.createdAt) : (source.completedAt || source.createdAt);
}
function itemIdentity(sourceType, item) {
  return String(sourceType === "order" ? item.inventoryId : item.toolId);
}
function itemName(sourceType, item) {
  return sourceType === "order"
    ? [item.brand, item.modelLine, item.capacity ? `${item.capacity} ${item.capacityUnit || "HP"}` : ""].filter(Boolean).join(" ")
    : item.itemName;
}
function eligibleUntil(sourceType, source, item, returnDays) {
  const purchased = new Date(purchaseDate(sourceType, source));
  const cutoff = new Date(purchased.getTime() + returnDays * 86400000);
  let coverageType = "return_period";
  if (sourceType === "order") {
    const itemKey = String(item.inventoryId);
    for (const coverage of source.warranty?.coverages || []) {
      if (String(coverage.itemKey) !== itemKey) continue;
      const expiry = new Date(coverage.endDate);
      if (Number.isNaN(expiry.getTime()) || expiry <= cutoff) continue;
      cutoff.setTime(expiry.getTime());
      coverageType = coverage.coverageType === "manufacturer_product" ? "manufacturer_warranty" : "seller_warranty";
    }
  }
  return { date: cutoff, coverageType };
}
function verifiedPayments(payments) {
  return (payments || []).filter(payment => ["verified", "paid", "remitted"].includes(payment.status));
}
function paidAmount(sourceType, source, payments) {
  return sourceType === "walk_in"
    ? money(Math.min(Number(source.totalAmount) || 0, Number(source.amountPaid) || 0))
    : money(verifiedPayments(payments).reduce((sum, payment) => sum + Math.max(0, Number(payment.amount) || 0), 0));
}
function allocationCap(sourceType, source, item, quantity, paid) {
  const total = sourceTotal(sourceType, source);
  const netLine = itemPrice(sourceType, source, item);
  const lineFraction = total > 0 ? Math.min(1, paid / total) : 0;
  return money(Math.min(netLine, netLine * lineFraction) * quantity / Math.max(1, Number(item.quantity) || 1));
}
function refundApprovalLimit(sourceType, source, context, returnRow) {
  const paid = paidAmount(sourceType, source, context.payments);
  const legacy = sourceType === "order" ? (context.payments || []).reduce((sum, payment) =>
    sum + (payment.refundStatus && payment.refundStatus !== "none" ? Math.max(0, Number(payment.refundAmount) || 0) : 0), 0) : 0;
  const other = (context.refunds || []).reduce((sum, refund) => sum + Math.max(0, Number(refund.amount) || 0), 0);
  return money(Math.max(0, Math.min(Number(returnRow.maxRefundable) || 0, paid - legacy - other)));
}
function paymentForRefund(payments, refunds, amount) {
  return verifiedPayments(payments).find(payment => {
    const itemRefunds = (refunds || []).filter(refund => String(refund.originalPaymentId) === String(payment._id));
    const alreadyReserved = itemRefunds.reduce((sum, refund) => sum + Number(refund.amount || 0), 0);
    const legacy = payment.refundStatus && payment.refundStatus !== "none" ? Number(payment.refundAmount || 0) : 0;
    return money(Number(payment.amount || 0) - alreadyReserved - legacy) >= amount;
  }) || null;
}
async function assertNoReturnSerialConflict(serials, session = null) {
  const normalized = (serials || []).map(value => String(value || "").trim()).filter(Boolean);
  if (!normalized.length) return;
  const patterns = normalized.map(value => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
  const query = ProductReturn.exists({ $or: [
    { serialNumbers: { $in: patterns }, status: { $nin: ["rejected", "cancelled"] }, inventoryDisposition: { $ne: "restocked" } },
    { "resolution.replacementSerialNumbers": { $in: patterns } },
  ] });
  if (await (session ? query.session(session) : query)) {
    throw Object.assign(new Error("A serial number belongs to a returned or replacement unit. Choose a different unit."), { status: 409 });
  }
}
function remainingQuantity(sourceType, source, itemIndex, returns) {
  const item = itemFor(sourceType, source, itemIndex);
  if (!item) return 0;
  const reserved = (returns || []).filter(row => row.itemIndex === itemIndex && (
    OPEN_STATUSES.includes(row.status) || (row.status === "completed" && ["refund", "replacement"].includes(row.resolution?.type))
  )).reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  return Math.max(0, Number(item.quantity || 0) - reserved);
}

async function loadContext(sourceType, source, session = null) {
  const returnsQuery = ProductReturn.find({ sourceType, sourceId: source._id });
  const refundsQuery = ProductRefund.find({ sourceType, sourceId: source._id, status: { $in: ["approved", "processing", "completed"] } });
  const paymentsQuery = sourceType === "order" ? Payment.find({ orderId: source._id }) : null;
  const settingQuery = SiteSetting.findOne({ key: "productReturnPolicy" });
  if (session) {
    returnsQuery.session(session); refundsQuery.session(session); settingQuery.session(session);
    paymentsQuery?.session(session);
  }
  const [returns, refunds, payments, setting] = await Promise.all([
    returnsQuery.lean(), refundsQuery.lean(), paymentsQuery ? paymentsQuery.lean() : [], settingQuery.lean(),
  ]);
  const configured = Number(setting?.value?.returnDays);
  return { returns, refunds, payments, returnDays: Number.isInteger(configured) && configured > 0 && configured <= 3650 ? configured : 30 };
}

function evaluateItem(sourceType, source, itemIndex, context, now = new Date()) {
  const item = itemFor(sourceType, source, itemIndex);
  if (!item) return { eligible: false, reason: "Product not found in this sale." };
  const remaining = remainingQuantity(sourceType, source, itemIndex, context.returns);
  const { date, coverageType } = eligibleUntil(sourceType, source, item, context.returnDays);
  const paid = paidAmount(sourceType, source, context.payments);
  const validSale = sourceType === "order" ? source.status === "completed" : source.status === "completed";
  const reason = !validSale ? "This sale must be completed first."
    : paid <= 0 ? "Payment must be confirmed first."
      : remaining <= 0 ? "All units are already in a return request or resolved return."
        : now > date ? "The recorded return or warranty period has ended. Contact the store for help."
          : "";
  return {
    eligible: !reason, reason, remaining, purchased: Number(item.quantity || 0),
    eligibleUntil: date, coverageType, paid, productName: itemName(sourceType, item),
    sku: itemIdentity(sourceType, item), unitPrice: Number(item.unitPrice || 0),
    serialNumbers: item.serialNumbers?.length ? item.serialNumbers
      : (item.serialNumber && Number(item.quantity) === 1 ? [item.serialNumber] : []),
  };
}

module.exports = {
  OPEN_STATUSES, TRANSITIONS, money, canTransition, itemFor, itemPrice, sourceTotal,
  purchaseDate, itemIdentity, itemName, paidAmount, verifiedPayments, allocationCap,
  refundApprovalLimit, paymentForRefund, assertNoReturnSerialConflict, remainingQuantity, loadContext, evaluateItem,
};

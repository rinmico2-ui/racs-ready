require("dotenv").config();
const mongoose = require("mongoose");
const BookingService = require("../models/BookingService");
const Order = require("../models/Order");
const Inventory = require("../models/Inventory");
const HVACProduct = require("../models/HVACProduct");
const { bookingCompletionDate } = require("../utils/warrantyLifecycle");
const { buildBookingWarrantyCoverage, getAftercarePolicy, warrantyRuleForOrder } = require("../utils/aftercarePolicy");
const { buildOrderWarrantySnapshot } = require("../utils/orderWarrantyPolicy");

function preserveLegacyState(snapshot, legacy) {
  const value = legacy?.toObject ? legacy.toObject() : (legacy || {});
  return {
    ...snapshot,
    status: value.status === "claimed" ? "claimed" : snapshot.status,
    claimIssue: value.claimIssue || null,
    claimedAt: value.claimedAt || null,
  };
}

async function backfillBookings(policy) {
  const bookings = await BookingService.find({
    status: { $in: ["completed", "repair_completed", "under_warranty", "warranty_claim", "closed"] },
    "warranty.startDate": { $ne: null },
    $or: [{ "warranty.coverages": { $exists: false } }, { "warranty.coverages.0": { $exists: false } }],
  });
  let updated = 0;
  for (const booking of bookings) {
    const completedAt = bookingCompletionDate(booking);
    if (!completedAt) continue;
    const built = await buildBookingWarrantyCoverage(booking, completedAt, policy);
    if (!built.coverage) continue;
    booking.warranty = preserveLegacyState(built.coverage, booking.warranty);
    await booking.save();
    updated += 1;
  }
  return { scanned: bookings.length, updated };
}

async function productTermsForItem(item) {
  if (item.manufacturerWarranty) return item.manufacturerWarranty;
  if (item.parentHvacId) {
    const product = await HVACProduct.findById(item.parentHvacId).select("specifications.warranty").lean();
    if (product?.specifications?.warranty) return product.specifications.warranty;
  }
  const inventory = await Inventory.findById(item.inventoryId).select("warranty").lean();
  return inventory?.warranty || "";
}

async function backfillOrders(policy) {
  const orders = await Order.find({
    status: "completed",
    completedAt: { $ne: null },
    $or: [{ "warranty.coverages": { $exists: false } }, { "warranty.coverages.0": { $exists: false } }],
  });
  let updated = 0;
  for (const order of orders) {
    for (const item of order.items || []) {
      if (!item.manufacturerWarranty) item.manufacturerWarranty = await productTermsForItem(item);
    }
    const rule = warrantyRuleForOrder(policy);
    const snapshot = buildOrderWarrantySnapshot(order, order.completedAt, rule);
    if (!snapshot) continue;
    order.warranty = preserveLegacyState(snapshot, order.warranty);
    order.markModified("items");
    await order.save();
    updated += 1;
  }
  return { scanned: orders.length, updated };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler");
  const policy = await getAftercarePolicy();
  const booking = await backfillBookings(policy);
  const order = await backfillOrders(policy);
  console.log(JSON.stringify({ booking, order }, null, 2));
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});

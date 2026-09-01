require("dotenv").config();
const mongoose = require("mongoose");
const BookingService = require("../models/BookingService");
const Order = require("../models/Order");
const { bookingAssetSeeds, orderAssetSeeds, syncMaintenanceFromBooking, syncMaintenanceFromOrder } = require("../utils/maintenanceLifecycle");

async function run() {
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler");
  const [bookings, orders] = await Promise.all([
    BookingService.find({ status: { $in: ["completed", "repair_completed"] } }),
    Order.find({ status: "completed" }),
  ]);
  const bookingUnits = bookings.reduce((sum, booking) => sum + bookingAssetSeeds(booking).length, 0);
  const orderUnits = orders.reduce((sum, order) => sum + orderAssetSeeds(order).length, 0);
  console.log(`[maintenance-backfill] ${bookings.length} completed booking(s), ${orders.length} completed order(s), ${bookingUnits + orderUnits} eligible unit(s).`);
  if (!apply) {
    console.log("[maintenance-backfill] Dry run only. Re-run with --apply to create idempotent asset and schedule records.");
    await mongoose.disconnect();
    return;
  }
  for (const booking of bookings) await syncMaintenanceFromBooking(booking);
  for (const order of orders) await syncMaintenanceFromOrder(order);
  console.log("[maintenance-backfill] Backfill complete.");
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error("[maintenance-backfill] Failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});

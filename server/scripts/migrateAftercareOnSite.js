"use strict";

require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const BookingService = require("../models/BookingService");
const Assignment = require("../models/Assignment");
const Payment = require("../models/Payment");
const { manilaDateKey } = require("../utils/maintenanceBooking");

async function main() {
  const apply = process.argv.includes("--apply");
  const all = process.argv.includes("--all");
  const reference = process.argv.find((arg) => arg.startsWith("--reference="))?.slice("--reference=".length);
  if (!all && !reference) throw new Error("Choose --reference=BOOKING_REFERENCE or --all. Add --apply only after reviewing the dry run.");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured.");

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const filter = {
    "maintenance.isMaintenance": true,
    "maintenance.paymentOnSite": { $ne: true },
    paymentNotes: /^Maintenance requested from Aftercare\./,
    paymentStatus: "pending",
    amountPaid: { $in: [0, null] },
    status: { $in: ["pending", "awaiting_assignment"] },
    ...(reference ? { bookingReference: reference } : {}),
  };
  const bookings = await BookingService.find(filter)
    .select("bookingReference bookingDate status totalPrice estimatedFee amountPaid paymentStatus downpaymentAmount balanceAmount")
    .lean();
  console.log(`Found ${bookings.length} unpaid Aftercare booking(s). Mode: ${apply ? "APPLY" : "DRY RUN"}.`);
  let changed = 0;
  for (const booking of bookings) {
    const total = Number(booking.totalPrice ?? booking.estimatedFee);
    const dateKey = booking.bookingDate ? manilaDateKey(new Date(booking.bookingDate)) : "";
    const activeAssignment = await Assignment.exists({ bookingId: booking._id, status: { $nin: ["cancelled", "declined", "expired"] } });
    const anyPayment = await Payment.exists({ bookingId: booking._id });
    const safe = Number.isFinite(total) && total > 0 && dateKey >= manilaDateKey(new Date())
      && !activeAssignment && !anyPayment;
    console.log(`${booking.bookingReference}: ${safe ? "eligible" : "SKIPPED (past date, payment/assignment exists, or invalid total)"}; total ₱${Number.isFinite(total) ? total : "?"}; status ${booking.status}`);
    if (!apply || !safe) continue;
    const nextStatus = booking.status === "pending" ? "awaiting_assignment" : booking.status;
    const result = await BookingService.updateOne(
      { _id: booking._id, ...filter },
      {
        $set: {
          "maintenance.paymentOnSite": true,
          paymentMethod: "cod",
          paymentChannel: "other",
          downpaymentAmount: 0,
          amountPaid: 0,
          balanceAmount: total,
          paymentNotes: "Maintenance requested from Aftercare. Full payment will be collected on site after service.",
          status: nextStatus,
          "services.$[item].status": "awaiting_assignment",
        },
        $unset: { downpaymentPercentage: "" },
        $push: { statusHistory: {
          fromStatus: booking.status,
          toStatus: nextStatus,
          changedByModel: "System",
          changedByName: "Aftercare payment migration",
          reason: "Unpaid Aftercare maintenance changed to full payment on site",
          timestamp: new Date(),
        } },
      },
      { arrayFilters: [{ "item.status": "pending" }] },
    );
    changed += result.modifiedCount || 0;
  }
  console.log(apply ? `Updated ${changed} booking(s).` : "No bookings changed. Add --apply to update eligible records.");
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect().catch(() => {}); });

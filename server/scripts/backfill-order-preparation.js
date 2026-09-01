require("dotenv").config();
const mongoose = require("mongoose");

async function run() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler";
  await mongoose.connect(uri);
  const Order = require("../models/Order");
  const BookingService = require("../models/BookingService");

  const orders = await Order.find({}).select(
    "fulfillmentType status preparation bookingId",
  );
  let updatedOrders = 0;
  let linkedBookings = 0;

  for (const order of orders) {
    const terminal = ["completed", "cancelled"].includes(order.status);
    const alreadyDeparted = ["out_for_delivery", "arrived", "installing", "completed"].includes(order.status);
    order.preparation = order.preparation || {};
    order.preparation.dispatch = {
      ...(order.preparation.dispatch?.toObject?.() || order.preparation.dispatch || {}),
      status: order.fulfillmentType === "customer_pickup"
        ? "not_required"
        : alreadyDeparted
          ? "ready"
          : (order.preparation.dispatch?.status === "ready" ? "ready" : "pending"),
    };
    order.preparation.installation = {
      ...(order.preparation.installation?.toObject?.() || order.preparation.installation || {}),
      status: order.fulfillmentType !== "delivery_installation"
        ? "not_required"
        : order.status === "completed"
          ? "completed"
          : order.status === "cancelled"
            ? "cancelled"
            : terminal
              ? "pending"
              : (order.preparation.installation?.status === "confirmed" ? "confirmed" : "pending"),
    };
    await order.save();
    updatedOrders += 1;

    if (order.bookingId && order.fulfillmentType === "delivery_installation") {
      const result = await BookingService.updateOne(
        { _id: order.bookingId },
        { $set: { sourceOrderId: order._id, serviceType: "core" } },
      );
      linkedBookings += Number(result.modifiedCount || 0);
    }
  }

  console.log(`Backfilled ${updatedOrders} order preparation records and linked ${linkedBookings} installation bookings.`);
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});

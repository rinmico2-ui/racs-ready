require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

mongoose
  .connect(process.env.MONGODB_URI || process.env.MONGO_URI)
  .then(async () => {
    const col = mongoose.connection.db.collection("bookingservices");

    // 1. Clear stale overdue flags on bookings whose schedule is now future
    const r1 = await col.updateMany(
      { autoReschedulePending: true, bookingDate: { $gte: new Date() } },
      { $set: { autoReschedulePending: false } }
    );
    console.log("Cleared stale overdue flags on", r1.modifiedCount, "booking(s)");

    // 2. Auto-apply pending reschedule proposals on awaiting_assignment bookings
    //    (admin committed the schedule without a technician — no confirmation needed)
    const r2 = await col.updateMany(
      {
        status: "awaiting_assignment",
        "proposedReschedule.status": "pending",
        bookingDate: { $gte: new Date() },
      },
      { $set: { "proposedReschedule.status": "accepted" } }
    );
    console.log("Auto-applied pending proposals on", r2.modifiedCount, "awaiting_assignment booking(s)");

    await mongoose.disconnect();
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });

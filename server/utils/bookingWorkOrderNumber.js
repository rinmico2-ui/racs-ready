"use strict";

const { manilaDateParts } = require("./bookingDateTime");

const COUNTER_COLLECTION = "bookingworkordernumbers";
const writeOptions = { session: null, maxTimeMS: 5000 };

function unavailable() {
  return Object.assign(new Error("A repair work-order number could not be reserved. Please try again shortly."), {
    status: 503, code: "WORK_ORDER_NUMBER_UNAVAILABLE",
  });
}

async function nextBookingWorkOrderNumber(Booking, now = new Date()) {
  const parts = manilaDateParts(now);
  if (!parts) throw unavailable();
  const prefix = `WO-${parts.year}-`;
  const key = String(parts.year);
  // Use the booking's own connection. Allocate outside the booking transaction:
  // an aborted booking may leave a gap, but must never release an issued number.
  const counters = Booking.db.collection(COUNTER_COLLECTION);

  async function reconcile() {
    // Counting records is unsafe after deletions and imports. Include ALL saved
    // numbers in this year, regardless of service category or archived status.
    // Only scan when the counter is missing or a restored/imported number clashes.
    const rows = await Booking.collection.aggregate([
      { $match: { workOrderNumber: { $regex: `^${prefix}[0-9]+$` } } },
      { $group: { _id: null, highest: { $max: { $convert: {
        input: { $substrBytes: ["$workOrderNumber", prefix.length, { $subtract: [{ $strLenBytes: "$workOrderNumber" }, prefix.length] }] },
        to: "double", onError: 0, onNull: 0,
      } } } } },
    ], { session: null, maxTimeMS: 5000 }).toArray();
    const highest = Number(rows[0]?.highest || 0);
    if (!Number.isSafeInteger(highest) || highest < 0 || highest >= Number.MAX_SAFE_INTEGER) throw unavailable();
    try {
      await counters.updateOne({ _id: key }, { $max: { value: highest } }, { ...writeOptions, upsert: true });
    } catch (error) {
      // Another process can initialize this year's _id first. $max preserves
      // increments already reserved by that process; never reset the sequence.
      if (error?.code !== 11000 || !error.keyPattern?._id) throw error;
      await counters.updateOne({ _id: key }, { $max: { value: highest } }, writeOptions);
    }
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const counter = await counters.findOneAndUpdate(
      { _id: key }, { $inc: { value: 1 } },
      { ...writeOptions, returnDocument: "after", includeResultMetadata: false },
    );
    if (!counter) {
      await reconcile();
      continue;
    }
    if (!Number.isSafeInteger(counter.value) || counter.value <= 0) throw unavailable();
    const candidate = `${prefix}${String(counter.value).padStart(6, "0")}`;
    const exists = await Booking.collection.findOne(
      { workOrderNumber: candidate }, { projection: { _id: 1 }, session: null, maxTimeMS: 5000 },
    );
    if (!exists) return candidate;
    await reconcile();
  }
  throw unavailable();
}

module.exports = { COUNTER_COLLECTION, nextBookingWorkOrderNumber };

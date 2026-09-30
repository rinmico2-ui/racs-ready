"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Order = require("../models/Order");
const { orderCapacityInterval, orderCapacityEndTime, loadActiveOrderCapacityRows } = require("../utils/orderScheduleCapacity");

test("active delivery orders reserve their entire work, travel and buffer span", () => {
  assert.deepEqual(orderCapacityInterval({
    fulfillmentType: "delivery_installation", timeSlot: "09:00",
    items: [{ quantity: 2 }], routeDurationMin: 40,
  }, 30), { startTime: 540, endTime: 730 });
  assert.deepEqual(orderCapacityInterval({
    fulfillmentType: "delivery_only", timeSlot: "09:00",
    items: [{ quantity: 4 }], routeDurationMin: 40,
  }, 30), { startTime: 540, endTime: 670 });
  assert.deepEqual(orderCapacityInterval({ timeSlot: "" }), { startTime: 0, endTime: 1440 });
  assert.deepEqual(orderCapacityInterval({ fulfillmentType: "delivery_only", timeSlot: "09:00 AM - 12:00 PM", routeDurationMin: 30 }, 30), { startTime: 540, endTime: 720 });
  assert.equal(orderCapacityEndTime({ fulfillmentType: "delivery_only", timeSlot: "09:00", routeDurationMin: 30 }, 30), "11:00");
});

test("unlinked orders count once, linked bookings prevent duplicate capacity counts", async t => {
  const orders = [
    { _id: "order-1", bookingId: null, status: "pending_payment", fulfillmentType: "delivery_installation", delivery: { preferredDate: new Date("2030-01-02T00:00:00Z") }, timeSlot: "09:00", items: [{ quantity: 2 }], routeDurationMin: 40 },
    { _id: "order-2", bookingId: "booking-2", status: "technician_assigned", fulfillmentType: "delivery_installation", delivery: { preferredDate: new Date("2030-01-02T00:00:00Z") }, timeSlot: "10:00" },
    { _id: "order-3", bookingId: null, status: "preparing_unit", fulfillmentType: "delivery_only", delivery: { preferredDate: new Date("2030-01-03T00:00:00Z") }, timeSlot: "11:00" },
  ];
  let query;
  t.mock.method(Order, "find", input => {
    query = input;
    return { select() { return this; }, lean: async () => orders };
  });
  const rows = await loadActiveOrderCapacityRows("2030-01-02", "2030-01-02", {
    activeBookingIds: new Set(["booking-2"]), bufferMinutes: 30,
  });
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0]._id), "order-1");
  assert.equal(rows[0].endTime, 730);
  assert.ok(query.status.$in.includes("pending_payment"));
  assert.ok(query.fulfillmentType.$in.includes("delivery_only"));
  assert.equal((await loadActiveOrderCapacityRows("2030-01-02", "2030-01-02", { excludeOrderId: "order-1", activeBookingIds: new Set(["booking-2"]) })).length, 0);
});

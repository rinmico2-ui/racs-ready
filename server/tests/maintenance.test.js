const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const CustomerAsset = require("../models/CustomerAsset");
const MaintenanceSchedule = require("../models/MaintenanceSchedule");
const BookingService = require("../models/BookingService");
const {
  clampIntervalDays,
  addDays,
  effectiveScheduleStatus,
  bookingAssetSeeds,
  orderAssetSeeds,
} = require("../utils/maintenanceLifecycle");
const { reminderFor } = require("../utils/maintenanceScheduler");
const {
  normalizeAftercarePolicy,
  warrantyRuleForBooking,
  warrantyRuleForOrder,
} = require("../utils/aftercarePolicy");

const customerId = new mongoose.Types.ObjectId();
const sourceId = new mongoose.Types.ObjectId();

test("clamps maintenance intervals to the supported operational range", () => {
  assert.equal(clampIntervalDays(undefined), 90);
  assert.equal(clampIntervalDays(10), 30);
  assert.equal(clampIntervalDays(120.4), 120);
  assert.equal(clampIntervalDays(900), 730);
  assert.equal(addDays(new Date("2026-08-26T00:00:00.000Z"), 90).toISOString(), "2026-11-24T00:00:00.000Z");
});

test("derives due and overdue state without changing terminal lifecycle states", () => {
  const now = new Date("2026-08-26T12:00:00.000Z");
  assert.equal(effectiveScheduleStatus({ status: "upcoming", dueDate: "2026-08-26" }, now), "due");
  assert.equal(effectiveScheduleStatus({ status: "upcoming", dueDate: "2026-08-25" }, now), "overdue");
  assert.equal(effectiveScheduleStatus({ status: "scheduled", dueDate: "2026-08-20" }, now), "scheduled");
  assert.equal(effectiveScheduleStatus({ status: "completed", dueDate: "2026-08-20" }, now), "completed");
});

test("creates one deterministic asset seed for every serviced booking unit", () => {
  const seeds = bookingAssetSeeds({
    _id: sourceId,
    customerId,
    bookingReference: "RACS-20260826-TEST",
    location: { address: "San Leonardo" },
    services: [{ _id: new mongoose.Types.ObjectId(), name: "Aircon Cleaning", quantity: 2, brand: "Carrier", hp: 1.5 }],
  });
  assert.equal(seeds.length, 2);
  assert.notEqual(seeds[0].assetKey, seeds[1].assetKey);
  assert.equal(seeds[0].equipment.brand, "Carrier");
  assert.equal(seeds[1].equipment.unitLabel, "Unit 2");
});

test("creates order assets per HVAC quantity and skips explicitly non-HVAC products", () => {
  const seeds = orderAssetSeeds({
    _id: sourceId,
    userId: customerId,
    orderReference: "ORD-20260826-TEST",
    items: [
      {
        inventoryId: new mongoose.Types.ObjectId(),
        brand: "Daikin",
        modelLine: "D-SMART",
        quantity: 3,
        isHvac: true,
        serialNumbers: ["DS-001", "DS-002", "DS-003"],
      },
      { inventoryId: new mongoose.Types.ObjectId(), modelLine: "Accessory", quantity: 2, isHvac: false },
    ],
  });
  assert.equal(seeds.length, 3);
  assert.equal(new Set(seeds.map((seed) => seed.assetKey)).size, 3);
  assert.deepEqual(seeds.map((seed) => seed.equipment.serialNumber), ["DS-001", "DS-002", "DS-003"]);
});

test("selects each reminder window only once", () => {
  const now = new Date("2026-08-26T08:00:00.000Z");
  assert.equal(reminderFor({ dueDate: "2026-09-20", reminders: {} }, now).field, "thirtyDayAt");
  assert.equal(reminderFor({ dueDate: "2026-09-01", reminders: {} }, now).field, "sevenDayAt");
  assert.equal(reminderFor({ dueDate: "2026-08-26", reminders: {} }, now).field, "dueAt");
  assert.equal(reminderFor({ dueDate: "2026-08-25", reminders: {} }, now).field, "overdueAt");
  assert.equal(reminderFor({ dueDate: "2026-08-25", reminders: { overdueAt: now } }, now), null);
});

test("applies configured reminder windows and switches", () => {
  const now = new Date("2026-08-26T08:00:00.000Z");
  const config = {
    enabled: true,
    firstReminderDays: 14,
    finalReminderDays: 3,
    dueDateEnabled: true,
    overdueEnabled: false,
  };
  assert.equal(reminderFor({ dueDate: "2026-09-08", reminders: {} }, now, config).field, "thirtyDayAt");
  assert.equal(reminderFor({ dueDate: "2026-08-29", reminders: {} }, now, config).field, "sevenDayAt");
  assert.equal(reminderFor({ dueDate: "2026-08-25", reminders: {} }, now, config), null);
  assert.equal(reminderFor({ dueDate: "2026-08-29", reminders: {} }, now, { ...config, enabled: false }), null);
});

test("normalizes booking, order, reminder, and warranty aftercare policy", () => {
  const policy = normalizeAftercarePolicy({
    maintenance: { bookingIntervalDays: 10, orderIntervalDays: 900, bookingsEnabled: false },
    reminders: { firstReminderDays: 21, finalReminderDays: 5 },
    warranty: { serviceBookingDays: 45, repairBookingDays: 60, productOrderDays: 365 },
  });
  assert.equal(policy.maintenance.bookingIntervalDays, 30);
  assert.equal(policy.maintenance.orderIntervalDays, 730);
  assert.equal(policy.maintenance.bookingsEnabled, false);
  assert.equal(policy.reminders.firstReminderDays, 21);
  assert.equal(policy.reminders.finalReminderDays, 5);
  assert.deepEqual(warrantyRuleForBooking(policy, { serviceType: "repair" }), { enabled: true, days: 90, type: "repair_booking" });
  assert.deepEqual(warrantyRuleForBooking(policy, { serviceType: "installation" }), { enabled: true, days: 90, type: "service_booking" });
  assert.deepEqual(warrantyRuleForOrder(policy), { enabled: true, days: 365, type: "product_order" });
});

test("maintenance schemas enforce ownership, lifecycle, and uniqueness indexes", async () => {
  const invalidAsset = new CustomerAsset({ assetKey: "asset", originType: "order", originId: sourceId, originItemKey: "unit-1" });
  await assert.rejects(invalidAsset.validate(), /customerId/);
  const schedule = new MaintenanceSchedule({
    assetId: sourceId,
    customerId,
    cycleKey: "cycle",
    cycleNumber: 1,
    dueDate: new Date(),
    sourceCompletionType: "order",
    intervalDays: 10,
  });
  await assert.rejects(schedule.validate(), /intervalDays/);
  const indexes = MaintenanceSchedule.schema.indexes().map(([fields]) => fields);
  assert.ok(indexes.some((fields) => fields.assetId === 1 && fields.cycleNumber === 1));
  assert.ok(indexes.some((fields) => fields.bookingId === 1));
});

test("maintenance outreach records preserve an auditable customer response", async () => {
  const schedule = new MaintenanceSchedule({
    assetId: sourceId,
    customerId,
    cycleKey: "outreach-cycle",
    cycleNumber: 1,
    dueDate: new Date("2026-11-24T00:00:00.000Z"),
    sourceCompletionType: "booking",
    outreach: {
      status: "callback_requested",
      method: "phone",
      notes: "Customer requested a call tomorrow.",
      nextFollowUpAt: new Date("2026-09-01T02:00:00.000Z"),
      history: [{ status: "callback_requested", method: "phone", notes: "Customer requested a call tomorrow." }],
    },
  });
  await schedule.validate();
  assert.equal(schedule.outreach.history.length, 1);
  schedule.outreach.status = "invalid";
  await assert.rejects(schedule.validate(), /outreach\.status/);
});

test("admin-assisted maintenance uses a standard assignable booking contract", async () => {
  const serviceId = new mongoose.Types.ObjectId();
  const scheduleId = new mongoose.Types.ObjectId();
  const booking = new BookingService({
    customerId,
    serviceId,
    serviceModel: "CoreService",
    serviceType: "core",
    service: { _id: serviceId, name: "Aircon Cleaning", basePrice: 1200 },
    servicePrice: 1200,
    serviceDurationMinutes: 90,
    services: [{ serviceId, name: "Aircon Cleaning", type: "core", quantity: 1, unitPrice: 1200, totalPrice: 1200, duration: 90, status: "awaiting_assignment" }],
    quantity: 1,
    totalPrice: 1200,
    estimatedFee: 1200,
    bookingDate: new Date("2026-11-24T00:00:00.000Z"),
    startTime: "09:00",
    endTime: "10:30",
    status: "awaiting_assignment",
    paymentMethod: "cod",
    paymentStatus: "pending",
    downpaymentPercentage: 10,
    downpaymentAmount: 120,
    balanceAmount: 1200,
    maintenance: { isMaintenance: true, assetId: sourceId, scheduleId, nextRecommendedDays: 90 },
  });
  await booking.validate();
  assert.equal(booking.maintenance.isMaintenance, true);
  assert.equal(booking.status, "awaiting_assignment");
  assert.equal(String(booking.maintenance.scheduleId), String(scheduleId));
});

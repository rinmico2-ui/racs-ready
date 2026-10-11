"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const mongoose = require("mongoose");
const MaintenanceSchedule = require("../models/MaintenanceSchedule");

const source = fs.readFileSync(path.join(__dirname, "../routes/maintenanceRoutes.js"), "utf8");
const customerId = new mongoose.Types.ObjectId();
const assetId = new mongoose.Types.ObjectId();
const scheduleId = new mongoose.Types.ObjectId();

function fixture({ foreign = false, booked = false } = {}) {
  let handler, writes = 0;
  const audits = [];
  const schedule = new MaintenanceSchedule({ _id: scheduleId, customerId: foreign ? new mongoose.Types.ObjectId() : customerId,
    assetId, cycleKey: "response-test", cycleNumber: 1, dueDate: new Date("2027-01-08"),
    status: "upcoming", sourceCompletionType: "order", bookingId: booked ? new mongoose.Types.ObjectId() : null });
  const context = {
    router: { post(...args) { handler = args.at(-1); } }, auth: { requireRole() {} }, mongoose,
    CUSTOMER_RESPONSE_STATUSES: ["booking_started", "callback_requested", "remind_later", "declined"],
    ACTIVE_DUE_STATUSES: ["upcoming", "due", "overdue"], customerId: req => req.user._id,
    MaintenanceSchedule: { findOneAndUpdate(filter, update, options) {
      assert.equal(options.runValidators, true);
      assert.equal(String(filter.customerId), String(customerId));
      assert.equal(filter.bookingId, null);
      return { async populate() {
        if (String(schedule.customerId) !== String(filter.customerId) || schedule.bookingId) return null;
        assert.ok(filter.status.$in.includes(schedule.status));
        for (const [field, value] of Object.entries(update.$set)) schedule.set(field, value);
        schedule.customerResponse.history.push(update.$push["customerResponse.history"]);
        await schedule.validate();
        writes++;
        return schedule;
      } };
    } },
    createNotification() { assert.fail("Not now must not request a staff callback or send a notification"); },
    audit: { async logEvent(event) { audits.push(event); } }, URLSearchParams,
  };
  const start = source.indexOf('router.post("/schedules/:id/respond",');
  const end = source.indexOf('router.get("/schedules/:id/booking-intent",', start);
  vm.runInNewContext(source.slice(start, end), context);
  return { schedule, audits, get writes() { return writes; }, async invoke(body = { status: "declined" }) {
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
    let error;
    await handler({ params: { id: String(scheduleId) }, body, user: { _id: customerId, role: "customer" } }, res, value => { error = value; });
    return { ...res, error };
  } };
}

test("Not now saves a durable customer response and history without cancelling the aircon or booking", async () => {
  const f = fixture();
  const res = await f.invoke({ status: "declined", note: " I will request maintenance later. " });
  assert.equal(res.error, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(f.schedule.customerResponse.status, "declined");
  assert.equal(f.schedule.customerResponse.note, "I will request maintenance later.");
  assert.equal(f.schedule.customerResponse.history.length, 1);
  assert.equal(f.schedule.customerResponse.history[0].status, "declined");
  assert.equal(f.schedule.customerResponse.remindAt, null);
  assert.equal(f.schedule.status, "upcoming");
  assert.equal(f.schedule.bookingId, null);
  assert.equal(String(f.schedule.assetId), String(assetId));
  assert.equal(f.schedule.dueDate.toISOString(), "2027-01-08T00:00:00.000Z");
  assert.equal(f.audits[0].action, "maintenance.customer_response.declined");
});

test("Not now cannot change another customer's cycle or an existing visit", async () => {
  for (const options of [{ foreign: true }, { booked: true }]) {
    const f = fixture(options);
    const res = await f.invoke();
    assert.equal(res.error, undefined);
    assert.equal(res.statusCode, 409);
    assert.equal(f.writes, 0);
    assert.equal(f.schedule.customerResponse.status, "none");
    assert.equal(f.audits.length, 0);
  }
});

test("Not now still allows a later reminder choice", async () => {
  const f = fixture();
  await f.invoke();
  const remindAt = new Date(Date.now() + 86400000).toISOString();
  const res = await f.invoke({ status: "remind_later", remindAt });
  assert.equal(res.error, undefined);
  assert.equal(res.statusCode, 200);
  assert.equal(f.schedule.customerResponse.status, "remind_later");
  assert.equal(f.schedule.customerResponse.remindAt.toISOString(), remindAt);
  assert.deepEqual(f.schedule.customerResponse.history.map(item => item.status), ["declined", "remind_later"]);
});

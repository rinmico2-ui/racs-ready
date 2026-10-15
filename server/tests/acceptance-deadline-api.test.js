"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const mongoose = require("mongoose");
const router = require("../routes/orderRoutes");
const { orderAttentionState } = require("../utils/orderAttention");
const { extendAcceptanceDeadline } = require("../utils/acceptanceDeadline");
const id = "507f191e810c19729de860ea";
const layer = router.stack.find(l => l.route?.path === "/:id/extend-deadline");
async function invoke(changes = {}, options = {}) {
  let write;
  const order = { _id: id, status: "technician_assigned", technicianId: id, technicianAcceptance: { status: "pending" },
    delivery: { preferredDate: "2035-01-02" }, fulfillmentType: "delivery_installation", timeSlot: "09:00", updatedAt: new Date(),
    statusHistory: [{ status: "technician_assigned", timestamp: new Date() }], ...changes };
  const handler = vm.runInNewContext("(" + layer.route.stack.at(-1).handle.toString() + ")", {
    mongoose, orderAttentionState, Order: { findById: async () => order, updateOne: async (filter, update) => { write = { filter, update }; return { modifiedCount: options.stale ? 0 : 1 }; } },
    require: name => name.endsWith("acceptanceDeadline") ? { extendAcceptanceDeadline } : { logEvent: async () => {} },
  });
  const res = { status(code) { this.code = code; return this; }, json(data) { this.body = data; return this; } };
  await handler({ params: { id }, body: { minutes: options.minutes ?? 60 }, user: { _id: id, role: "admin" } }, res);
  return { res, write };
}
test("order acceptance extension preserves the pending-state and version guards", async () => {
  const { res, write } = await invoke();
  assert.equal(res.body.success, true); assert.equal(write.filter.status, "technician_assigned");
  assert.equal(write.filter["technicianAcceptance.status"], "pending"); assert.ok(write.filter.updatedAt);
  assert.equal(write.update.$push, undefined, "extending a deadline must not create a new assignment history entry");
});
test("accepted, expired-schedule, invalid-length and concurrently changed orders cannot be extended", async () => {
  for (const changes of [{ status: "technician_accepted" }, { technicianAcceptance: { status: "accepted" } }, { delivery: { preferredDate: "2020-01-01" } }]) {
    const result = await invoke(changes); assert.equal(result.res.code, 409); assert.equal(result.write, undefined);
  }
  assert.equal((await invoke({}, { minutes: 0 })).res.code, 400);
  assert.equal((await invoke({}, { stale: true })).res.code, 409);
});

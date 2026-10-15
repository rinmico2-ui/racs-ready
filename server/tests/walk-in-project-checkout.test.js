"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const mongoose = require("mongoose");
const policy = require("../utils/orderCheckoutPolicy");
const engine = require("../utils/enterpriseSchedulingEngine");
const projectPolicy = require("../utils/orderInstallationProject");
const router = require("../routes/posRoutes").walkInAirconRouter;
const source = router.stack.find(l => l.route?.path === "/checkout").route.stack.at(-1).handle.toString();
const userId = new mongoose.Types.ObjectId(), productId = new mongoose.Types.ObjectId(), variantId = new mongoose.Types.ObjectId();
function fixture(quantity, options = {}) {
  const writes = [], events = [], customer = { _id: userId, role: "customer", firstName: "Demo", lastName: "Customer", email: "customer@example.test", phone: "09171234567" };
  const Model = kind => class {
    constructor(data) { Object.assign(this, data); this._id ||= new mongoose.Types.ObjectId(); }
    async save() {
      if (kind === "order") this.total = this.items.reduce((sum, i) => sum + i.totalPrice, 0) + this.transportationFee - this.discount;
      if (options.fail === kind) throw Error("Write failed");
      writes.push({ kind, data: this.toObject() });
    }
    toObject() { return { ...this }; }
    static findOne() { return { lean: async () => null, session: async () => null }; }
    static async updateOne() { return {}; }
  };
  const session = { startTransaction: () => events.push("start"), commitTransaction: async () => events.push("commit"), inTransaction: () => !events.includes("commit"), abortTransaction: async () => { events.push("abort"); writes.length = 0; }, endSession: async () => events.push("end") };
  const query = data => ({ populate() { return this; }, lean: async () => data });
  const fakeRequire = name => {
    if (name === "../utils/orderInstallationProject") return projectPolicy;
    if (name === "../models/Project") return Model("project");
    if (name === "../utils/bookingDateTime") return require("../utils/bookingDateTime");
    if (name === "../utils/audit") return { logEvent: async () => {} };
    throw Error("Unexpected dependency: " + name);
  };
  const handler = vm.runInNewContext("(" + source + ")", {
    require: fakeRequire, console: { error() {}, warn() {} },
    mongoose: { Types: mongoose.Types, isValidObjectId: mongoose.isValidObjectId, startSession: async () => session },
    CustomerInvitationError: class extends Error {}, OrderCheckoutError: policy.OrderCheckoutError,
    normalizeInvitationEmail: value => value, normalizedCustomer: value => value,
    posOrderError: (message, status, code) => new policy.OrderCheckoutError(message, status, code),
    paymentMapping: () => ({ source: "gcash", order: "gcash_full", payment: "gcash", gateway: "gcash" }),
    normalizedSerialNumbers: () => [], validateCheckoutItems: policy.validateCheckoutItems, parseDateOnly: policy.parseDateOnly,
    User: { findOne: async () => customer }, Order: Model("order"), Payment: Model("payment"), BookingService: Model("booking"),
    Technician: { findOne: () => { throw Error("A project must not choose one technician"); } },
    HVACProduct: { findOne: () => query({ _id: productId, modelLine: "Split", brand: { name: "Demo Brand" }, variants: [{ _id: variantId, quantity: 40, active: true, capacity: 1, sellingPrice: 20000 }] }), findOneAndUpdate: async () => ({ _id: productId }) },
    getOrderCheckoutSettings: async () => ({ companyLocation: {}, farePerKm: 10 }),
    authoritativeDeliveryQuote: async () => ({ transportationFee: 100, distanceKm: 10, durationMin: 20 }),
    provisionWalkInCustomer: async () => ({ state: "pending_verification", user: customer, created: false }),
    clearReportCache() {},
  });
  const body = { accountConsent: true, checkoutRequestId: "walkin-project-checkout-1234", customer, items: [{ toolId: String(variantId), quantity }], fulfillmentType: "delivery_installation", paymentMethod: "gcash", paymentReference: "AUTH-12345", amountPaid: quantity * 20000 + 100, discount: 0,
    delivery: { address: "Customer installation site", preferredDate: "2035-01-02", coordinates: { lat: 14, lng: 121 } }, projectScheduling: { preferredStartDate: "2035-01-02", preferredCompletionDeadline: "2035-01-10" } };
  const req = { body, user: { _id: userId, role: "admin" }, app: { get: () => null } };
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  return { req, res, writes, events, run: () => handler(req, res) };
}
test("walk-in ten and forty unit installations create linked projects without a single technician or time slot", async t => {
  t.mock.method(engine, "getProjectWindowAvailability", async () => ({ sufficient: true }));
  for (const quantity of [10, 40]) {
    const f = fixture(quantity); await f.run();
    assert.equal(f.res.code, 201, JSON.stringify(f.res.body));
    assert.ok(f.events.includes("commit"));
    const order = f.res.body.order, project = f.writes.find(row => row.kind === "project").data;
    assert.equal(order.isProject, true); assert.equal(order.status, "preparing_unit");
    assert.equal(order.technicianId, null); assert.equal(order.timeSlot, null);
    assert.equal(String(project.sourceOrderId), String(order._id)); assert.equal(project.totalUnits, quantity);
    assert.equal(project.plannedCompletionDate, undefined);
    assert.equal(f.writes.filter(row => row.kind === "payment").length, 1);
    assert.equal(f.writes.find(row => row.kind === "booking").data.estimatedFee, 0);
  }
});
test("walk-in projects reject invalid windows and insufficient capacity before any record or stock write", async t => {
  t.mock.method(engine, "getProjectWindowAvailability", async () => ({ sufficient: false }));
  const insufficient = fixture(10); await insufficient.run();
  assert.equal(insufficient.res.code, 409); assert.equal(insufficient.writes.length, 0); assert.equal(insufficient.events.length, 0);
  const invalid = fixture(10); invalid.req.body.projectScheduling.preferredCompletionDeadline = "2035-01-01"; await invalid.run();
  assert.equal(invalid.res.code, 400); assert.equal(invalid.writes.length, 0);
});
test("failed project writes abort the walk-in order and its payment", async t => {
  t.mock.method(engine, "getProjectWindowAvailability", async () => ({ sufficient: true }));
  const f = fixture(10, { fail: "project" }); await f.run();
  assert.equal(f.res.code, 500); assert.ok(f.events.includes("abort")); assert.ok(!f.events.includes("commit")); assert.equal(f.writes.length, 0);
});

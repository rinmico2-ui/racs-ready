"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const mongoose = require("mongoose");
const { reconcileBookingPayments } = require("../utils/paymentSummary");
const { clampIntervalDays } = require("../utils/maintenanceLifecycle");
const { normalizeServiceLocation } = require("../utils/maintenanceLocation");
const source = fs.readFileSync(path.join(__dirname, "../routes/technicianApi.js"), "utf8");
const lifecycle = fs.readFileSync(path.join(__dirname, "../utils/maintenanceLifecycle.js"), "utf8");
const id = "507f1f77bcf86cd799439011", techId = "507f1f77bcf86cd799439012", bookingId = "507f1f77bcf86cd799439013";
const response = () => ({ statusCode: 200, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; } });

function fixture(options = {}) {
  let handler, stagedPayment, payment, committed = false;
  const events = [], filters = [];
  const assignment = { _id: id, bookingId, technicianId: techId, status: options.notStarted ? "assigned" : "in_progress" };
  const session = { active: false, startTransaction() { this.active = true; events.push("start"); }, inTransaction() { return this.active; },
    async commitTransaction() { committed = true; payment = stagedPayment; this.active = false; events.push("commit"); },
    async abortTransaction() { stagedPayment = undefined; this.active = false; events.push("abort"); }, async endSession() { events.push("end"); } };
  const booking = { _id: bookingId, status: options.cancelled ? "cancelled" : "in_progress", serviceType: "core", paymentMethod: options.cashAfterService ? "cash_after_service" : "cod",
    maintenance: options.cashAfterService ? undefined : { isMaintenance: true, paymentOnSite: true }, totalPrice: 1450, estimatedFee: 1450, downpaymentAmount: 0,
    amountPaid: options.alreadyPaid || options.paidWithoutFlag ? 1450 : 0, balanceAmount: options.alreadyPaid ? 0 : 1450, balanceCollected: Boolean(options.alreadyPaid),
    paymentStatus: options.alreadyPaid ? "waiting_for_remittance" : "pending", statusHistory: [],
    async save(opts) {
      assert.equal(opts.session, session);
      if (options.failSave) throw Object.assign(Error("Transaction write conflict"), { code: 112 });
      events.push("booking");
    } };
  const query = value => ({ session(actual) { assert.equal(actual, session); return this; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  const context = { mongoose: { Types: mongoose.Types, startSession: async () => session },
    Technician: { findOne: async () => ({ _id: techId, name: "Technician" }) },
    require(name) {
      if (name.endsWith("/Assignment")) return { findOne(filter) { filters.push(filter); return query(options.foreign ? null : assignment); } };
      if (name.endsWith("/BookingService")) return { findById: () => query(booking) };
      if (name.endsWith("/Payment")) return { find: () => query(options.payments || (options.alreadyPaid ? [{ amount: 1450, type: "final", status: "waiting_for_remittance" }] : [])),
        async create(rows, opts) { assert.ok(Array.isArray(rows)); assert.equal(opts.session, session); stagedPayment = { _id: id, ...rows[0] }; events.push("payment"); return [stagedPayment]; } };
      if (name.endsWith("/paymentSummary")) return { reconcileBookingPayments };
      if (name.endsWith("/repair-visit-payment")) return require('../public/js/repair-visit-payment');
      throw Error(name);
    }, router: { post(...args) { handler = args.at(-1); } },
  };
  const start = source.indexOf('router.post("/assignments/:id/collect-payment",');
  vm.runInNewContext(source.slice(start, source.indexOf('router.post("/assignments/:id/collect-payment-legacy",', start)), context);
  return { events, filters, booking, get payment() { return payment; }, get committed() { return committed; }, async invoke(body = {}) {
    const res = response(); let error;
    await handler({ params: { id }, user: { _id: id }, body: { amount: 1450, method: "cash", cashReceivedConfirmed: true, ...body } },
      res, e => { error = e; });
    return { ...res, error };
  } };
}

test('cash after service collects the entire bill once and keeps cash awaiting remittance',async()=>{
  const f=fixture({cashAfterService:true}),res=await f.invoke();
  assert.equal(res.error,undefined);assert.equal(res.statusCode,201);
  assert.equal(f.committed,true);assert.equal(f.payment.amount,1450);
  assert.equal(f.payment.method,'cash');assert.equal(f.payment.status,'waiting_for_remittance');
  assert.equal(f.payment.proofUrl,undefined);assert.equal(f.payment.customerSignature,undefined);assert.equal(f.payment.customerPhotoUrl,undefined);
  assert.equal(f.payment.collectedBy,techId);assert.ok(Number.isFinite(Number(f.payment.collectedAt)));
  assert.equal(f.payment.events[0].metadata.cashReceivedConfirmed,true);assert.equal(f.payment.events[0].metadata.amount,1450);
  assert.equal(f.payment.events[0].actor,id);assert.equal(f.payment.events[0].at,f.payment.collectedAt);
  assert.equal(f.booking.amountPaid,1450);assert.equal(f.booking.balanceAmount,0);
  assert.equal(f.booking.downpaymentAmount,0);
});

test('cash after service cannot collect before work starts or silently accept a write conflict',async()=>{
  const early=fixture({cashAfterService:true,notStarted:true});
  assert.equal((await early.invoke()).statusCode,400);assert.equal(early.payment,undefined);
  const failed=fixture({cashAfterService:true,failSave:true});
  assert.equal((await failed.invoke()).statusCode,409);assert.equal(failed.payment,undefined);
  assert.ok(failed.events.includes('abort'));
});

test("the assigned technician records the full maintenance price including travel as a final payment", async () => {
  const f = fixture(), res = await f.invoke();
  assert.equal(res.error, undefined); assert.equal(res.statusCode, 201); assert.equal(f.committed, true);
  assert.equal(f.payment.amount, 1450); assert.equal(f.payment.type, "final"); assert.equal(f.payment.status, "waiting_for_remittance");
  assert.equal(f.booking.balanceAmount, 0); assert.equal(f.booking.balanceCollected, true); assert.equal(f.booking.amountPaid, 1450);
  assert.equal(f.filters[0].technicianId, techId); assert.equal(f.filters[1].bookingId, bookingId);
  assert.deepEqual(f.events, ["start", "payment", "booking", "commit", "end"]);
});

test("another technician, an unstarted assignment, or a cancelled visit cannot collect maintenance payment", async () => {
  for (const [options, status] of [[{ foreign: true }, 404], [{ notStarted: true }, 400], [{ cancelled: true }, 409]]) {
    const f = fixture(options); assert.equal((await f.invoke()).statusCode, status); assert.equal(f.payment, undefined); assert.equal(f.committed, false);
  }
});

test("maintenance payment requires the complete balance, cash confirmation or transfer reference", async () => {
  for (const body of [{ amount: 1200 }, { amount: 100 }, { cashReceivedConfirmed: false }, { method: "gcash", reference: "" },
    { method: "bank", proofUrl: "/receipt" }, { method: "unsupported" }]) {
    const f = fixture(); assert.equal((await f.invoke(body)).statusCode, 400); assert.equal(f.payment, undefined); assert.equal(f.committed, false);
  }
});

test('cash requires explicit technician confirmation even if optional legacy evidence is supplied',async()=>{
  for(const cashReceivedConfirmed of [undefined,false,'true',1]){
    const f=fixture({cashAfterService:true});
    const res=await f.invoke({cashReceivedConfirmed,customerSignature:'Name',proofUrl:'/optional-receipt.jpg'});
    assert.equal(res.statusCode,400);assert.match(res.body.error,/Confirm that you received/);
    assert.equal(f.payment,undefined);assert.equal(f.committed,false);
  }
});

test('new cash collections ignore legacy photo and signature fields',async()=>{
  const f=fixture({cashAfterService:true}),res=await f.invoke({proofUrl:'/optional-receipt.jpg',customerSignature:'Customer',customerPhotoUrl:'/customer.jpg',reference:'OLD-TRANSFER'});
  assert.equal(res.statusCode,201);assert.equal(f.payment.proofUrl,undefined);
  assert.equal(f.payment.customerSignature,undefined);assert.equal(f.payment.customerPhotoUrl,undefined);assert.equal(f.payment.reference,undefined);
  assert.equal(f.payment.status,'waiting_for_remittance');
});

test('GCash and bank collection require a reference without photos or cash confirmation',async()=>{
  for(const method of ['gcash','bank']){
    for(const body of [{reference:''},{reference:'   '},{reference:{}},{reference:123},{reference:undefined}]){
      const f=fixture({cashAfterService:true});
      const res=await f.invoke({method,cashReceivedConfirmed:false,...body});
      assert.equal(res.statusCode,400);assert.equal(f.payment,undefined);
    }
    const f=fixture({cashAfterService:true});
    const res=await f.invoke({method,cashReceivedConfirmed:false,reference:' REF123 '});
    assert.equal(res.statusCode,201);assert.equal(f.payment.method,method);
    assert.equal(f.payment.events[0].metadata.cashReceivedConfirmed,undefined);
    assert.equal(f.payment.reference,'REF123');assert.equal(f.payment.status,'waiting_for_remittance');
    assert.equal(f.payment.proofUrl,undefined);assert.equal(f.payment.customerSignature,undefined);assert.equal(f.payment.customerPhotoUrl,undefined);
  }
});

test("maintenance payment retries do not collect an already recorded final balance again", async () => {
  const f = fixture({ alreadyPaid: true }), res = await f.invoke();
  assert.equal(res.statusCode, 200); assert.equal(res.body.alreadyCollected, true); assert.equal(f.payment, undefined);
});

test("verified full payments and legacy paid amounts do not require a collection flag", async () => {
  for (const options of [{ paidWithoutFlag: true }, { payments: [{ amount: 1450, status: 'verified', type: 'full' }] }]) {
    const f = fixture(options), res = await f.invoke();
    assert.equal(res.error, undefined); assert.equal(res.statusCode, 200); assert.equal(res.body.alreadyCollected, true);
    assert.equal(f.payment, undefined); assert.equal(f.committed, false);
  }
});

test("a partial verified ledger is credited even if the saved paid amount is stale", async () => {
  const f = fixture({ payments: [{ amount: 1000, status: 'verified', type: 'downpayment' }] });
  const res = await f.invoke({ amount: 450 });
  assert.equal(res.error, undefined); assert.equal(res.statusCode, 201); assert.equal(f.payment.amount, 450);
  assert.equal(f.booking.amountPaid, 1450); assert.equal(f.booking.balanceAmount, 0);
});

test("a failed maintenance payment save rolls back its receipt and asks the technician to refresh", async () => {
  const f = fixture({ failSave: true }), res = await f.invoke();
  assert.equal(res.statusCode, 409); assert.match(res.body.error, /Refresh/);
  assert.equal(f.payment, undefined); assert.equal(f.committed, false); assert.ok(f.events.includes("abort"));
});

test("completion closes the linked maintenance cycle and creates its next recommended visit without a new aircon record", async () => {
  const calls = [], completedAt = new Date("2099-01-09"), asset = { _id: id, status: "active" };
  const context = { getAftercarePolicy: async () => ({ maintenance: { bookingsEnabled: true, allowTechnicianRecommendation: true, bookingIntervalDays: 90 } }),
    clampIntervalDays, normalizeServiceLocation,
    MaintenanceSchedule: { async findOneAndUpdate(filter, update) { calls.push({ filter, update }); return { _id: id, status: "completed" }; } },
    CustomerAsset: { async findByIdAndUpdate(assetId, update) { assert.equal(assetId, id); assert.equal(update.lastServiceDate, completedAt); return asset; } },
    async ensureSchedule(value, opts) { assert.equal(value, asset); calls.push(opts); } };
  const begin = lifecycle.indexOf("async function syncMaintenanceFromBooking(");
  vm.runInNewContext(lifecycle.slice(begin, lifecycle.indexOf("async function syncMaintenanceFromOrder", begin)), context);
  const result = await context.syncMaintenanceFromBooking({ _id: bookingId, status: "completed", completedAt,
    maintenance: { assetId: id, scheduleId: id, nextRecommendedDays: 120 } });
  assert.equal(result.length, 1); assert.equal(calls[0].filter.bookingId, bookingId);
  assert.equal(calls[0].update.$set.status, "completed"); assert.equal(calls[1].intervalDays, 120);
  assert.equal(calls[1].baseDate, completedAt);
});

test("a technician cannot read the maintenance history of another technician's booking", async () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/maintenanceRoutes.js"), "utf8");
  let handler, filter;
  const query = value => ({ select() { return this; }, lean: async () => value });
  const context = { mongoose, auth: { requireRole() {} }, Technician: { findOne: () => query({ _id: techId }) },
    BookingService: { findOne(value) { filter = value; return query(null); } }, router: { get(...args) { handler = args.at(-1); } } };
  const begin = routes.indexOf('router.get("/technician/bookings/:bookingId",');
  vm.runInNewContext(routes.slice(begin, routes.indexOf("module.exports", begin)), context);
  const res = response(); await handler({ params: { bookingId }, user: { _id: id } }, res, e => { throw e; });
  assert.equal(res.statusCode, 404); assert.equal(filter.technicianId, techId);
});

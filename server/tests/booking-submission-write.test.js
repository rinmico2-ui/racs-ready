"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { bookingSubmissionIsComplete, persistBookingSubmission } = require("../utils/bookingSubmissionWrite");

function fixture({ standalone = false, transactionError = null, failRelocation = false } = {}) {
  const calls = [];
  const session = {
    async withTransaction(work) {
      calls.push("transaction");
      if (transactionError) throw transactionError;
      await work();
    },
    async endSession() { calls.push("endSession"); },
  };
  const mongoose = {
    connection: { getClient: () => ({ topology: { description: { servers: new Map([
      ["db", { type: standalone ? "Standalone" : "RSPrimary" }],
    ]) } } }) },
    async startSession() { calls.push("startSession"); return session; },
  };
  class BookingService {
    constructor(data) { Object.assign(this, data); }
    async save(options) { calls.push(options?.session ? "booking:transaction" : "booking:standalone"); }
    static async findById() { calls.push("checkBooking"); return null; }
    static async deleteOne() { calls.push("deleteBooking"); }
  }
  class Payment {
    constructor(data) { Object.assign(this, data); }
    async save(options) { calls.push(options?.session ? "payment:transaction" : "payment:standalone"); }
    static async findOne() { return null; }
    static async deleteOne() { calls.push("deletePayment"); }
  }
  const UnitAssistanceRequest = {
    async findOneAndUpdate(_filter, _update, options) {
      calls.push(options.session ? "unit:transaction" : "unit:standalone");
      return { _id: "unit-quote" };
    },
    async updateOne() { calls.push("undoUnit"); },
  };
  const RelocationRequest = {
    async findOneAndUpdate(_filter, _update, options) {
      calls.push(options.session ? "relocation:transaction" : "relocation:standalone");
      return failRelocation ? null : { _id: "relocation-quote" };
    },
    async updateOne() { calls.push("undoRelocation"); },
  };
  return {
    calls,
    options: {
      mongoose, BookingService, Payment, UnitAssistanceRequest, RelocationRequest,
      booking: { _id: "booking-1", toObject: () => ({ _id: "booking-1" }) },
      payment: { toObject: () => ({ _id: "payment-1", bookingId: "booking-1" }) },
      customerId: "customer-1",
      services: [],
    },
  };
}

test("replica-set booking writes remain in one transaction", async () => {
  const { calls, options } = fixture();
  const saved = await persistBookingSubmission(options);
  assert.equal(saved._id, "booking-1");
  assert.deepEqual(calls, ["startSession", "transaction", "booking:transaction", "payment:transaction", "endSession"]);
});

test("standalone booking writes succeed without starting a transaction", async () => {
  const { calls, options } = fixture({ standalone: true });
  await persistBookingSubmission(options);
  assert.deepEqual(calls, ["booking:standalone", "payment:standalone"]);
});

test("a transaction unsupported error falls back to standalone writes", async () => {
  const { calls, options } = fixture({ transactionError: new Error("Transaction numbers are only allowed on a replica set member or mongos") });
  await persistBookingSubmission(options);
  assert.deepEqual(calls, ["startSession", "transaction", "checkBooking", "endSession", "booking:standalone", "payment:standalone"]);
});

test("a failed quote claim reverses standalone booking, payment, and earlier claims", async () => {
  const { calls, options } = fixture({ standalone: true, failRelocation: true });
  options.services = [
    { assistanceRequestId: "unit-quote", unitPrice: 1000, brand: "Carrier", hp: 1, airconType: "split" },
    { unitPrice: 4500, relocation: { scope: "custom_quote", requestId: "relocation-quote" } },
  ];
  await assert.rejects(persistBookingSubmission(options), /relocation quote was already used/);
  assert.deepEqual(calls, [
    "booking:standalone", "payment:standalone", "unit:standalone", "relocation:standalone",
    "undoUnit", "undoRelocation", "deletePayment", "deleteBooking",
  ]);
});

test("a duplicate is confirmed only after its payment and quoted services are linked", async () => {
  let paymentReady = false;
  let unitReady = false;
  const options = {
    booking: { _id: "booking-1", services: [{ assistanceRequestId: "unit-quote" }] },
    submissionId: "submission-1",
    Payment: { exists: async filter => { assert.equal(filter.clientSubmissionId, "booking:submission-1"); return paymentReady; } },
    UnitAssistanceRequest: { exists: async () => unitReady },
    RelocationRequest: { exists: async () => true },
  };
  assert.equal(await bookingSubmissionIsComplete(options), false);
  paymentReady = true;
  assert.equal(await bookingSubmissionIsComplete(options), false);
  unitReady = true;
  assert.equal(await bookingSubmissionIsComplete(options), true);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Booking = require("../models/BookingService");
const { COUNTER_COLLECTION, nextBookingWorkOrderNumber } = require("../utils/bookingWorkOrderNumber");
const { persistBookingSubmission } = require("../utils/bookingSubmissionWrite");
const { manilaDateParts } = require("../utils/bookingDateTime");

const now = new Date("2026-10-17T02:00:00Z");
const repairBooking = overrides => new Booking({ serviceType: "repair", bookingDate: now, downpaymentAmount: 50, ...overrides });

function database(t, { numbers = [], initialCounters = {}, initializationRace = false } = {}) {
  const saved = new Map(numbers.map((number, index) => [String(index), { _id: String(index), workOrderNumber: number }]));
  const values = new Map(Object.entries(initialCounters));
  const calls = { scans: 0, writes: 0, inserts: 0, pending: [] };
  const counters = {
    async findOneAndUpdate(filter, update, options) {
      assert.equal(options.session, null, "number reservations must survive transaction aborts");
      assert.equal(options.returnDocument, "after");
      assert.equal(options.includeResultMetadata, false);
      if (!values.has(filter._id)) return null;
      const value = values.get(filter._id) + update.$inc.value;
      values.set(filter._id, value);
      calls.writes++;
      return { _id: filter._id, value };
    },
    async updateOne(filter, update, options) {
      assert.equal(options.session, null);
      if (initializationRace && options.upsert) {
        initializationRace = false;
        values.set(filter._id, update.$max.value + 1);
        throw Object.assign(new Error("Another instance initialized the counter"), { code: 11000, keyPattern: { _id: 1 } });
      }
      if (values.has(filter._id) || options.upsert) values.set(filter._id, Math.max(values.get(filter._id) || 0, update.$max.value));
      return { acknowledged: true };
    },
  };
  const originalCollection = Booking.db.collection.bind(Booking.db);
  t.mock.method(Booking.db, "collection", name => name === COUNTER_COLLECTION ? counters : originalCollection(name));
  t.mock.method(Booking.collection, "aggregate", (pipeline, options) => {
    assert.equal(options.session, null);
    calls.scans++;
    const matches = new RegExp(pipeline[0].$match.workOrderNumber.$regex);
    const substring = pipeline[1].$group.highest.$max.$convert.input.$substrBytes;
    const values = [...saved.values()].filter(row => matches.test(row.workOrderNumber))
      .map(row => {
        const length = typeof substring[2] === "number" ? substring[2]
          : Buffer.byteLength(row.workOrderNumber) - substring[2].$subtract[1];
        assert.ok(Number.isInteger(length) && length >= 0, "MongoDB $substrBytes requires a nonnegative byte count");
        return Number(row.workOrderNumber.slice(substring[1], substring[1] + length));
      });
    return { toArray: async () => values.length ? [{ highest: Math.max(...values) }] : [] };
  });
  t.mock.method(Booking.collection, "findOne", async (filter, options) => {
    assert.equal(options.session, null);
    return [...saved.values()].find(row => row.workOrderNumber === filter.workOrderNumber) || null;
  });
  t.mock.method(Booking.collection, "insertOne", async (row, options) => {
    calls.inserts++;
    if (row.workOrderNumber && [...saved.values()].some(existing => existing.workOrderNumber === row.workOrderNumber)) {
      throw Object.assign(new Error("Duplicate work-order number"), { code: 11000, keyPattern: { workOrderNumber: 1 } });
    }
    if (options.session) calls.pending.push(row);
    else saved.set(String(row._id), row);
    return { acknowledged: true, insertedId: row._id };
  });
  return { saved, values, counters, calls };
}

test("repair booking uses the highest existing number after cleanup, not the remaining booking count", async t => {
  const year = manilaDateParts(new Date()).year;
  const db = database(t, { numbers: [`WO-${year}-000002`, `WO-${year}-000127`] });
  const booking = repairBooking();
  await booking.save();
  assert.equal(booking.workOrderNumber, `WO-${year}-000128`);
  assert.equal(db.calls.inserts, 1);
  assert.equal(db.saved.size, 3);
});

test("simultaneous allocations from different requests reserve distinct numbers", async t => {
  const db = database(t, { numbers: ["WO-2026-000127"] });
  const numbers = await Promise.all(Array.from({ length: 100 }, () => nextBookingWorkOrderNumber(Booking, now)));
  assert.equal(new Set(numbers).size, 100);
  assert.equal(Math.min(...numbers.map(number => Number(number.split("-").at(-1)))), 128);
  assert.equal(Math.max(...numbers.map(number => Number(number.split("-").at(-1)))), 227);
  assert.equal(db.values.get("2026"), 227);
});

test("a restored stale counter jumps above occupied numbers and archived or imported bookings", async t => {
  const db = database(t, { initialCounters: { "2026": 126 }, numbers: ["WO-2026-000127", "WO-2026-004000", "WO-DEMO-2026-999999"] });
  assert.equal(await nextBookingWorkOrderNumber(Booking, now), "WO-2026-004001");
  assert.equal(db.calls.scans, 1);
});

test("deleting bookings does not reset an established sequence", async t => {
  const db = database(t, { initialCounters: { "2026": 4000 } });
  assert.equal(await nextBookingWorkOrderNumber(Booking, now), "WO-2026-004001");
  db.saved.clear();
  assert.equal(await nextBookingWorkOrderNumber(Booking, now), "WO-2026-004002");
  assert.equal(db.calls.scans, 0, "normal allocations do not rescan the year's history");
});

test("new-year allocation uses Manila time and a separate yearly counter", async t => {
  const db = database(t, { initialCounters: { "2026": 4000 }, numbers: ["WO-2027-000010", "WO-2025-999999"] });
  assert.equal(await nextBookingWorkOrderNumber(Booking, new Date("2026-12-31T16:01:00Z")), "WO-2027-000011");
  assert.equal(db.values.get("2026"), 4000);
});

test("bootstrap upsert races never reset a number already reserved by another instance", async t => {
  database(t, { numbers: ["WO-2026-000127"], initializationRace: true });
  assert.equal(await nextBookingWorkOrderNumber(Booking, now), "WO-2026-000129");
});

test("numeric high-water calculation handles more than six digits and ignores demo reference formats", async t => {
  database(t, { numbers: ["WO-2026-999999", "WO-2026-1000000", "WO-DEMO-2026-9000000", "WO-2026-TEST-9999999"] });
  assert.equal(await nextBookingWorkOrderNumber(Booking, now), "WO-2026-1000001");
});

test("existing reference numbers and core bookings do not allocate new repair numbers", async t => {
  const db = database(t);
  t.mock.method(db.counters, "findOneAndUpdate", async () => { throw new Error("Unexpected sequence allocation"); });
  const old = repairBooking({ workOrderNumber: "WO-2026-000127" });
  const core = repairBooking({ serviceType: "core" });
  await old.save();
  await core.save();
  assert.equal(old.workOrderNumber, "WO-2026-000127");
  assert.equal(core.workOrderNumber, undefined);
  assert.equal(db.calls.inserts, 2);
});

test("sequence failures stop the booking before insertion instead of silently omitting its work-order number", async t => {
  const db = database(t);
  t.mock.method(db.counters, "findOneAndUpdate", async () => { throw new Error("Counter unavailable"); });
  await assert.rejects(repairBooking().save(), /Counter unavailable/);
  assert.equal(db.calls.inserts, 0);
});

test("booking/payment transaction rollback preserves the reserved sequence and retry inserts one booking and payment", async t => {
  const db = database(t);
  let failPayment = true, paid = 0;
  const session = {
    async withTransaction(work) {
      db.calls.pending = [];
      try {
        await work();
        db.calls.pending.forEach(row => db.saved.set(String(row._id), row));
        paid++;
      } finally { db.calls.pending = []; }
    },
    async endSession() {},
    inTransaction() { return true; },
  };
  const mongoose = { connection: { getClient: () => ({ topology: { description: { servers: new Map([["db", { type: "RSPrimary" }]]) } } }) }, startSession: async () => session };
  class Payment {
    constructor(data) { Object.assign(this, data); }
    toObject() { return { _id: this._id, bookingId: this.bookingId }; }
    async save(options) { assert.equal(options.session, session); if (failPayment) throw new Error("Payment unavailable"); }
  }
  const booking = repairBooking();
  const args = { mongoose, BookingService: Booking, Payment, services: [], booking, payment: new Payment({ _id: "payment-1", bookingId: booking._id }) };
  await assert.rejects(persistBookingSubmission(args), /Payment unavailable/);
  assert.equal(db.saved.size, 0);
  assert.equal(paid, 0);
  const reserved = [...db.values.values()][0];
  failPayment = false;
  const saved = await persistBookingSubmission(args);
  assert.equal(Number(saved.workOrderNumber.split("-").at(-1)), reserved + 1);
  assert.equal(db.saved.size, 1);
  assert.equal(paid, 1);
});

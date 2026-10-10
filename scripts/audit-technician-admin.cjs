/* Read-only workflow audit. Executes current handlers with in-memory model
 * doubles. No server, database, accounts, stock, or payments are changed.
 * These are defect reproductions, not passing acceptance tests.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, "server", file), "utf8");
const techSource = read("routes/technicianApi.js");
const adminSource = read("routes/adminApi.js");
const kitSource = read("utils/dailyKitService.js");
const id = () => new mongoose.Types.ObjectId();
const quiet = { log() {}, warn() {}, error() {} };
const query = value => ({ lean: async () => value, select() { return this; }, populate() { return this; }, sort() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
function evaluate(code, context) {
  return vm.runInNewContext(`(${code})`, { console: quiet, Date, URLSearchParams, mongoose, global: {}, ...context });
}
function route(source, method, url, context) {
  const start = source.indexOf(`router.${method}("${url}"`);
  assert.ok(start >= 0, `Missing route ${url}`);
  const callback = source.indexOf("async (req, res", start);
  const end = source.indexOf("\n});", callback);
  assert.ok(callback >= start && end > callback);
  return evaluate(source.slice(callback, end + 2), context);
}
function fn(name, context) {
  const start = kitSource.indexOf(`async function ${name}(`);
  const end = kitSource.indexOf("\n}\n", start) + 2;
  assert.ok(start >= 0 && end > start);
  return evaluate(kitSource.slice(start, end), context);
}
function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function request(body = {}) {
  return { user: { _id: id(), role: "technician", email: "audit@example.test" }, body, params: { id: String(id()), bookingId: String(id()) }, query: {}, app: { get: () => null } };
}
const results = [];
async function scenario(key, description, run) {
  try { results.push({ key, description, reproduced: true, observed: await run() }); }
  catch (error) { results.push({ key, description, reproduced: false, error: error.message }); }
}
(async () => {
  await scenario("A01", "Single-item Notify Admin crashes before saving or notifying", async () => {
    let saved = false;
    const kit = { items: [{ name: "Vacuum pump", checkoutStatus: "unavailable" }], save: async () => { saved = true; } };
    const handler = route(techSource, "post", "/daily-kit/notify-admin-item", {
      Technician: { findOne: async () => ({ _id: id() }) },
      require: () => ({ findOne: async () => kit }),
      dailyKitDayBounds: () => ({ start: new Date(), end: new Date() }),
    });
    const res = response();
    await handler(request({ itemName: "Vacuum pump" }), res);
    assert.equal(res.statusCode, 500); assert.equal(saved, false);
    return { httpStatus: res.statusCode, kitSaved: saved, response: res.body };
  });
  await scenario("A02", "Repeating a daily equipment return adds stock twice", async () => {
    const tool = { quantity: 0, checkedOutQuantity: 1, save: async () => {} };
    const ledger = { status: "checked_out", save: async () => {} };
    const kit = { _id: id(), items: [{ name: "Pump", toolId: id(), category: "equipment", quantity: 1, checkoutStatus: "checked_out" }], save: async () => {} };
    const handler = route(techSource, "post", "/daily-kit/return", {
      Technician: { findOne: async () => ({ _id: id() }) },
      require: name => name.endsWith("DailyKit") ? { findOne: async () => kit }
        : name.endsWith("EquipmentAssignment") ? { find: async () => ledger.status === "checked_out" ? [ledger] : [] }
        : { findById: async () => tool },
    });
    const req = request({ itemName: "Pump" });
    const first = response(); await handler(req, first);
    const second = response(); await handler(req, second);
    assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200); assert.equal(tool.quantity, 2);
    return { issued: 1, stockAfterTwoReturns: tool.quantity, secondHttpStatus: second.statusCode };
  });
  await scenario("A03", "Failed kit confirmation keeps earlier stock deductions; retry deducts again", async () => {
    let stock = 5, saves = 0;
    const firstId = id(), secondId = id();
    const makeKit = () => ({ status: "draft", hasDelta: false, assignmentIds: [id()], orderIds: [], dailyAssignmentIds: [],
      items: [firstId, secondId].map((toolId, index) => ({ name: `Material ${index + 1}`, toolId, category: "consumable", quantity: 1, preparedChecked: true, checkoutStatus: "pending", bookingIds: [] })),
      save: async () => { saves++; } });
    const confirm = fn("confirmDailyKit", {
      dayBounds: () => ({ start: new Date() }), strictManilaDateKey: () => "today", manilaDateKey: () => "today",
      syncDailyKit: async () => makeKit(), checklistItems: kit => kit.items, needsChecklistCheck: () => true,
      Tool: { findOneAndUpdate: async filter => { if (String(filter._id) === String(secondId)) return null; stock--; return {}; } },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(confirm({ technicianId: id(), userId: id(), date: new Date() }), /became unavailable/);
    }
    assert.equal(stock, 3); assert.equal(saves, 0);
    return { initialStock: 5, afterTwoFailedAttempts: stock, savedKitConfirmations: saves };
  });
  await scenario("A04", "Order departure accepts a confirmed kit with unconfirmed additions", async () => {
    const { orderDepartureReadiness } = require(path.join(root, "server/utils/orderPreparation"));
    const orderId = id(), technicianId = id();
    const order = { _id: orderId, technicianId, fulfillmentType: "delivery_installation", preparation: { dispatch: { status: "ready" } } };
    const kit = { _id: id(), technicianId, status: "confirmed", hasDelta: true,
      items: [{ name: "Pump", category: "equipment", checkoutStatus: "checked_out", orderIds: [orderId] }],
      deltaItems: [{ name: "Extra material", category: "consumable", checkoutStatus: "pending", orderIds: [orderId], resolution: { status: "assigned_from_stock" } }] };
    const readiness = orderDepartureReadiness(order, kit);
    assert.equal(readiness.ready, true);
    const emptyDeltaReadiness = orderDepartureReadiness(order, { ...kit, deltaItems: [] });
    assert.equal(emptyDeltaReadiness.ready, true);
    return { hasDelta: true, additionalItemsIssued: false, departureAllowed: readiness.ready, emptyDeltaDepartureAllowed: emptyDeltaReadiness.ready };
  });
  await scenario("A05", "Admin issue list omits unavailable additions to a confirmed kit", async () => {
    let captured;
    const handler = route(adminSource, "get", "/daily-kit/pending-issues", {
      require: name => name.endsWith("DailyKit") ? { find: filter => { captured = filter; return query([]); } } : {},
    });
    const res = response(); await handler(request(), res);
    assert.ok(captured["items.resolution.status"]); assert.equal(JSON.stringify(captured).includes("deltaItems"), false);
    return { issueFilterChecksRegularItems: true, issueFilterChecksAdditionalItems: false, httpStatus: res.statusCode };
  });
  await scenario("A06", "Admin Reschedule Job returns success without changing a booking date", async () => {
    let kitSaved = false, bookingWrites = 0;
    const techId = id();
    const kit = { _id: id(), technicianId: techId, items: [{ name: "Pump", checkoutStatus: "unavailable", bookingIds: [id()] }], save: async () => { kitSaved = true; } };
    const handler = route(adminSource, "patch", "/daily-kit/resolve-item", {
      require: name => name.endsWith("DailyKit") ? { findById: async () => kit }
        : name.endsWith("Technician") ? { findById: async () => null }
        : name.endsWith("BookingService") ? { updateMany: async () => { bookingWrites++; } } : {},
    });
    const res = response(); await handler(request({ kitId: String(kit._id), itemName: "Pump", resolution: "rescheduled" }), res);
    assert.equal(res.body.success, true); assert.equal(bookingWrites, 0); assert.equal(kitSaved, true);
    return { reportsSuccess: true, bookingDateWrites: bookingWrites, savedResolution: kit.items[0].resolution.status };
  });
  await scenario("A07", "Core batch completion finishes a booking without photo or material usage", async () => {
    const technicianId = id(); let assignmentComplete = false;
    const booking = { _id: id(), technicianId, serviceType: "core", status: "in-progress", balanceAmount: 0,
      services: [{ type: "core", status: "in_progress", technicianId }], save: async () => {} };
    const handler = route(techSource, "patch", "/appointments/:id/core-items/batch", {
      canTransitionServiceItem: require(path.join(root, "server/utils/bookingServiceItems")).canTransitionServiceItem,
      configuredBookingWarranty: async () => ({ coverage: null }),
      require: name => name.endsWith("Technician") ? { findOne: async () => ({ _id: technicianId }) }
        : name.endsWith("BookingService") ? { findById: async () => booking }
        : name.endsWith("Assignment") ? { exists: async () => true, findOneAndUpdate: async () => { assignmentComplete = true; } }
        : { syncMaintenanceFromBooking: async () => {} },
    });
    const res = response(); let thrown; await handler(request({ status: "completed" }), res, error => { thrown = error; });
    assert.equal(thrown, undefined); assert.equal(booking.status, "completed"); assert.equal(assignmentComplete, true);
    return { httpStatus: res.statusCode, bookingStatus: booking.status, assignmentComplete, completionPhoto: booking.proofPhoto || null };
  });
  await scenario("A08", "Repair status route completes unpaid work without completion proof", async () => {
    const technicianId = id();
    const booking = { _id: id(), serviceType: "repair", status: "repair_in_progress", balanceAmount: 1000, balanceCollected: false,
      inspection: { completedAt: new Date() }, save: async () => {} };
    const assignment = { _id: id(), status: "in_progress", notes: [], save: async () => {} };
    const handler = route(techSource, "post", "/repairs/:bookingId/status", {
      Technician: { findOne: async () => ({ _id: technicianId, name: "Audit", save: async () => {} }) },
      require: name => name.endsWith("BookingService") ? { findById: () => query(booking) }
        : name.endsWith("Assignment") ? { findOne: () => query(assignment) }
        : name.endsWith("StockReservation") ? { fulfillForBooking: async () => [] }
        : { resolveAvailabilityStatus: async () => "Available" },
    });
    const res = response(); let thrown; await handler(request({ status: "completed" }), res, error => { thrown = error; });
    assert.equal(thrown, undefined); assert.equal(booking.status, "repair_completed"); assert.equal(assignment.status, "completed");
    return { httpStatus: res.statusCode, bookingStatus: booking.status, unpaidBalance: booking.balanceAmount, completionPhoto: booking.proofPhoto || null };
  });
  await scenario("A09", "Order material usage repeated after a failed completion is recorded twice", async () => {
    const orderId = id(); let rows = 0;
    const kit = { items: [{ name: "Tape", category: "consumable", orderIds: [orderId], quantityIssued: 4, quantityUsed: 0, quantityReturned: 0 }], save: async () => {} };
    const record = fn("recordOrderConsumableUsage", {
      dayBounds: () => ({ start: new Date() }), DailyKit: { findOne: async () => kit }, ServiceToolUsage: { create: async () => { rows++; } },
    });
    const args = { technicianId: id(), userId: id(), orderId, date: new Date(), usages: [{ name: "Tape", quantity: 1 }] };
    await record(args); await record(args);
    assert.equal(kit.items[0].quantityUsed, 2); assert.equal(rows, 2);
    return { completionAttemptsWithSameUsage: 2, usageRows: rows, quantityUsed: kit.items[0].quantityUsed };
  });
  await scenario("A10", "Equipment return from Tools leaves the shared kit marked checked out", async () => {
    const technicianId = id(); let kitWrites = 0;
    const assignment = { technicianId, dailyKitId: id(), equipmentId: id(), status: "checked_out", quantity: 1, save: async () => {} };
    const tool = { quantity: 0, checkedOutQuantity: 1, save: async () => {} };
    const handler = route(techSource, "post", "/equipment/:assignmentId/return", {
      loadTechnicianContext: async () => ({ tech: { _id: technicianId }, technicianIds: [String(technicianId)] }),
      EquipmentAssignment: { findById: async () => assignment }, Tool: { findById: async () => tool },
      DailyKit: { updateOne: async () => { kitWrites++; } },
    });
    const req = request({ condition: "good" }); req.params.assignmentId = String(id());
    const res = response(); let thrown; await handler(req, res, error => { thrown = error; });
    assert.equal(thrown, undefined); assert.equal(assignment.status, "returned"); assert.equal(kitWrites, 0);
    return { httpStatus: res.statusCode, custodyStatus: assignment.status, sharedKitWrites: kitWrites };
  });
  await scenario("A11", "Two service collection requests can both record the full final payment", async () => {
    const technicianId = id(), bookingId = id(); let paymentRows = 0;
    const makeBooking = () => ({ _id: bookingId, status: "in-progress", serviceType: "core", balanceAmount: 1000,
      totalPrice: 1000, amountPaid: 0, balanceCollected: false, statusHistory: [], save: async () => {} });
    const handler = route(techSource, "post", "/assignments/:id/collect-payment", {
      Technician: { findOne: async () => ({ _id: technicianId }) },
      require: name => name.endsWith("BookingService") ? { findById: async () => makeBooking() }
        : name.endsWith("Assignment") ? { findOne: async () => ({ bookingId, status: "in_progress" }) }
        : name.endsWith("Payment") ? { find: () => query([]), create: async () => { paymentRows++; return { _id: id() }; } }
        : { reconcileBookingPayments: () => ({ hasLedgerMismatch: false }) },
    });
    const replies = [response(), response()];
    await Promise.all(replies.map(res => handler(request({ amount: 1000, method: "cash", customerSignature: "audit" }), res, error => { throw error; })));
    assert.equal(paymentRows, 2); assert.equal(replies.every(res => res.statusCode === 201), true);
    return { outstandingBalance: 1000, paymentRows, totalRecorded: 2000, httpStatuses: replies.map(res => res.statusCode) };
  });
  await scenario("A12", "Kit refresh drops an admin-assigned replacement tool", async () => {
    const originalId = id(), replacementId = id(), technicianId = id();
    const kit = { _id: id(), status: "draft", items: [{ _id: id(), name: "Pump", toolId: replacementId, category: "equipment", quantity: 1,
      checkoutStatus: "reserved", resolution: { status: "assigned_from_stock" } }], assignmentIds: [], orderIds: [], dailyAssignmentIds: [], save: async () => {} };
    const refresh = fn("syncDailyKit", {
      dayBounds: () => ({ start: new Date(), end: new Date() }), ACTIVE_ASSIGNMENT_STATUSES: ["accepted"], ACTIVE_INSTALLATION_ORDER_STATUSES: ["technician_accepted"],
      uniqueIds: values => values.filter(Boolean), Assignment: { find: () => query([]) }, Order: { find: () => query([]) },
      DailyAssignment: { find: () => query([]) }, BookingService: { find: () => query([]) }, WorkOrder: { find: () => query([]) },
      DailyKit: { findOne: async () => kit }, buildProjectKitRequirements: () => [],
      requirementsFor: async () => [{ name: "Pump", toolId: originalId, category: "equipment", quantity: 1, checkoutStatus: "unavailable" }],
      hydrateAvailability: async rows => rows, retainChecklistState: require(path.join(root, "server/utils/dailyKitService")).retainChecklistState,
      syncOrderPreparationSummaries: async () => {},
    });
    await refresh(technicianId, new Date());
    assert.equal(String(kit.items[0].toolId), String(originalId)); assert.equal(kit.items[0].resolution, undefined);
    return { replacementKept: false, refreshedCheckoutStatus: kit.items[0].checkoutStatus, resolutionKept: false };
  });
  await scenario("A13", "Admin kit update is sent to a user-id room instead of the technician-id room", async () => {
    const technicianId = id(), userId = id(); let sentRoom;
    const kit = { _id: id(), technicianId, items: [{ name: "Pump", checkoutStatus: "unavailable" }], save: async () => {} };
    const handler = route(adminSource, "patch", "/daily-kit/resolve-item", {
      require: name => name.endsWith("DailyKit") ? { findById: async () => kit }
        : name.endsWith("Technician") ? { findById: async () => ({ _id: technicianId, user: userId }) }
        : { createNotification: async () => {} },
    });
    const req = request({ kitId: String(kit._id), itemName: "Pump", resolution: "not_required" });
    req.app.get = () => ({ to: room => ({ emit: () => { sentRoom = room; } }) });
    const res = response(); await handler(req, res);
    assert.equal(sentRoom, "tech:" + userId); assert.notEqual(sentRoom, "tech:" + technicianId);
    const socketSource = read("index.js");
    assert.ok(socketSource.includes('socket.join("tech:" + socket.technicianId)'));
    return { httpStatus: res.statusCode, eventUsesUserId: true, connectedRoomUsesTechnicianId: true, roomsMatch: false };
  });
  const reproduced = results.filter(result => result.reproduced).length;
  const output = JSON.stringify({ scope: "Isolated current-code execution with in-memory model doubles; no live writes", reproduced, scenarios: results }, null, 2) + "\n";
  if (process.argv.includes("--save-evidence")) {
    const directory = path.join(root, "docs", "audits");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "technician-admin-audit-evidence.json"), output);
  }
  process.stdout.write(output);
  // A nonzero exit means the harness needs review, not that production is safe.
  process.exitCode = reproduced === results.length ? 0 : 1;
})();

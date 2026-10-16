"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const policy = require("../utils/relocationWorkOrder");
const checklist = require("../utils/relocationChecklist");
const id = n => `507f1f77bcf86cd7994390${String(n).padStart(2, "0")}`;
const clone = value => JSON.parse(JSON.stringify(value));
const tech = { _id: id(1) };
const assignment = { _id: id(2), bookingId: id(3), technicianId: tech._id, serviceType: "core", serviceName: "Aircon Relocation", status: "in_progress" };
const booking = { _id: id(3), status: "in-progress", bookingReference: "TEST-ONLY", technicianId: tech._id, assignmentId: assignment._id,
  location: { address: "Test property address", lat: 15.3, lng: 120.9 },
  services: [{ _id: id(4), name: "Aircon Relocation", type: "core", brand: "Test brand" }] };

function harness(record = booking, jobs = [assignment], options = {}) {
  let state = clone({ booking: record, assignments: jobs });
  let transaction;
  const calls = { writes: 0, ended: 0, reads: 0 };
  const current = () => transaction || state;
  const query = get => ({ select() { return this; }, session() { return this; }, lean: async () => get() });
  const session = { async withTransaction(work) {
    transaction = clone(state);
    try { await work(); if (options.failCommit) throw new Error("Test commit failure"); state = transaction; }
    finally { transaction = null; }
  }, async endSession() { calls.ended++; } };
  const models = {
    "../models/BookingService": {
      findById() { calls.reads++; return query(() => current().booking); },
      findOneAndUpdate(filter, update) { return query(() => {
        calls.writes++;
        const book = current().booking;
        if (book.status !== filter.status || options.failWrite) return null;
        if (update.$set?.services) {
          if (book.services?.length) return null;
          book.services = clone(update.$set.services);
        } else {
          const item = book.services.find(item => String(item._id) === String(filter.services.$elemMatch._id));
          if (!item || item.relocation?.completedTasks?.includes(filter.services.$elemMatch["relocation.completedTasks"].$ne)) return null;
          item.relocation ||= {};
          item.relocation.completedTasks ||= [];
          item.relocation.taskEvents ||= [];
          item.relocation.completedTasks.push(update.$addToSet["services.$.relocation.completedTasks"]);
          item.relocation.taskEvents.push(clone(update.$push["services.$.relocation.taskEvents"]));
        }
        return book;
      }); },
    },
    "../models/Assignment": {
      find(filter) { return query(() => current().assignments.filter(job =>
        String(job.technicianId) === String(filter.technicianId) && String(job.bookingId) === String(filter.bookingId)
        && (typeof filter.status === "string" ? job.status === filter.status : filter.status.$in.includes(job.status)))); },
      async updateOne(filter) {
        const matches = current().assignments.some(job => job._id === String(filter._id) && job.status === filter.status && job.technicianId === String(filter.technicianId));
        return { matchedCount: options.failLock ? 0 : Number(matches) };
      },
    },
    "../utils/relocationChecklist": checklist,
    "../utils/relocationWorkOrder": policy,
    "../utils/mongoWriteSupport": { isUnsupportedMongoWriteFeature: error => error.code === 20 },
  };
  const source = fs.readFileSync(path.join(__dirname, "../routes/technicianApi.js"), "utf8");
  const start = source.indexOf("router.get('/relocation-work-order/:bookingId'");
  const routes = {};
  vm.runInNewContext(source.slice(start, source.indexOf('// Warranty inspections mirror', start)), {
    router: { get: (url, handler) => routes.get = handler, post: (url, handler) => routes.post = handler },
    require(name) { assert.ok(models[name], name); return models[name]; },
    mongoose: { isValidObjectId: value => /^[a-f\d]{24}$/.test(String(value)), async startSession() { if (options.unsupported) throw Object.assign(new Error("Test unsupported transaction"), { code: 20 }); return session; } },
    loadTechnicianContext: async () => ({ tech }), Date,
  });
  return { calls, state: () => state, async run(method, itemId = id(4), task = "removal.disconnect") {
    const result = { statusCode: 200 };
    const response = { status(code) { result.statusCode = code; return this; }, json(data) { result.data = data; return this; } };
    await routes[method]({ params: { bookingId: id(3), itemId }, user: { _id: id(9) }, body: { task } }, response, error => result.error = error);
    return result;
  } };
}

test("older named relocation items load without scope; saved origin is retained without inventing a destination", async () => {
  const api = harness();
  const result = await api.run("get");
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.items[0].legacy, true);
  assert.equal(result.data.items[0].from.address, booking.location.address);
  assert.equal(result.data.items[0].to.address, "");
  assert.equal(result.data.items[0].detailsMissing, true);
  assert.equal(result.data.items[0].editable, true);
  assert.equal(api.calls.writes, 0);
});

test("new relocation records keep both actual locations and prefer the current assignment over completed history", async () => {
  const modern = clone(booking);
  modern.services[0].airconType = "split";
  modern.services[0].relocation = { scope: "custom_quote", from: { address: "Actual current address", lat: 15.3, lng: 120.9 }, to: { address: "Actual new address", lat: 15.4, lng: 121.0 }, completedTasks: ["removal.disconnect"] };
  const api = harness(modern, [{ ...assignment, _id: id(8), status: "completed" }, assignment]);
  const result = await api.run("get");
  assert.equal(result.data.assignmentStatus, "in_progress");
  assert.equal(result.data.items[0].to.address, "Actual new address");
  assert.equal(result.data.items[0].detailsMissing, false);
  assert.deepEqual(Array.from(result.data.items[0].completedTasks), ["removal.disconnect"]);
});

test("older single-service bookings load read-only without migration; recording a task saves its canonical item", async () => {
  const flat = { ...booking, services: [], service: { name: "Aircon Relocation" }, servicePrice: 2500, brand: "Test brand" };
  const api = harness(flat);
  const view = await api.run("get");
  assert.equal(view.statusCode, 200);
  assert.equal(String(view.data.items[0].id), booking._id);
  assert.equal(view.data.items[0].virtual, true);
  assert.equal(api.state().booking.services.length, 0);
  const saved = await api.run("post", booking._id);
  assert.equal(saved.statusCode, 200);
  assert.equal(api.state().booking.services[0].relocation.completedTasks[0], "removal.disconnect");
  assert.equal(api.state().booking.services[0].totalPrice, 2500);
  assert.equal(api.state().booking.servicePrice, 2500);
  assert.equal(api.state().booking.location.address, flat.location.address);
  assert.equal(api.state().booking.services[0].relocation.scope, undefined);
});

test("legacy checklist writes persist once and retries do not duplicate task events", async () => {
  const api = harness();
  assert.equal((await api.run("post")).statusCode, 200);
  assert.equal((await api.run("post")).statusCode, 200);
  assert.equal(api.state().booking.services[0].relocation.taskEvents.length, 1);
  assert.equal(api.calls.writes, 1);
  assert.equal(api.calls.ended, 2);
});

test("a legacy item keeps per-unit pricing, quantity, total work duration and model without changing parent charges", async () => {
  const flat = { ...booking, services: [], service: { name: "Aircon Relocation" }, servicePrice: 2500,
    quantity: 3, serviceDurationMinutes: 360, totalPrice: 7900, travelFare: 400, amountPaid: 1000, balanceAmount: 6900,
    unitInfo: { model: "Original saved model" } };
  const api = harness(flat);
  await api.run("post", booking._id);
  const saved = api.state().booking;
  const item = saved.services[0];
  assert.equal(item.unitPrice, 2500);
  assert.equal(item.totalPrice, 7500);
  assert.equal(item.quantity, 3);
  assert.equal(item.duration, 120);
  assert.equal(item.relocation.model, "Original saved model");
  for (const field of ["totalPrice", "travelFare", "amountPaid", "balanceAmount", "servicePrice"]) assert.equal(saved[field], flat[field]);
  const BookingService = require("../models/BookingService");
  const document = new BookingService({ ...saved, bookingDate: new Date("2027-01-20"), downpaymentAmount: 1000 });
  await document.validate();
  assert.deepEqual(Array.from(document.services[0].relocation.completedTasks), ["removal.disconnect"]);
});

test("transport remains locked until removal is finished, then can be saved", async () => {
  const api = harness();
  assert.equal((await api.run("post", id(4), "transport.secure")).statusCode, 409);
  assert.equal(api.calls.writes, 0);
  for (const [task] of checklist.RELOCATION_STAGES[0].tasks) assert.equal((await api.run("post", id(4), `removal.${task}`)).statusCode, 200);
  assert.equal((await api.run("post", id(4), "transport.secure")).statusCode, 200);
});

test("another technician's item is not exposed or changed by an unrelated assignment", async () => {
  const other = clone(booking);
  other.services[0].technicianId = id(7);
  other.services[0].assignmentId = id(8);
  const api = harness(other, [{ ...assignment, serviceName: "Aircon Cleaning", serviceItemId: id(6) }]);
  assert.equal((await api.run("get")).statusCode, 404);
  assert.equal((await api.run("post")).statusCode, 409);
  assert.equal(api.calls.writes, 0);
});

test("cancelled, completed and reassigned bookings cannot gain new progress", async () => {
  for (const record of [{ ...booking, status: "cancelled" }, { ...booking, status: "completed" }, { ...booking, technicianId: id(7), assignmentId: id(8) }]) {
    const api = harness(record);
    assert.equal((await api.run("post")).statusCode, 409);
    assert.equal(api.calls.writes, 0);
  }
});

test("missing bookings and non-relocation jobs still return useful errors; pending jobs are viewable", async () => {
  const missing = await harness(null).run("get");
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.data.error, "Booking not found.");
  const cleaning = harness({ ...booking, services: [{ _id: id(4), name: "Aircon Cleaning" }] }, [{ ...assignment, serviceName: "Aircon Cleaning" }]);
  assert.equal((await cleaning.run("get")).statusCode, 404);
  const pending = harness(booking, [{ ...assignment, status: "pending_acceptance" }]);
  const result = await pending.run("get");
  assert.equal(result.statusCode, 200);
  assert.equal(result.data.items[0].editable, false);
});

test("lost claims and failed transactions do not save partial tasks or migrate legacy bookings", async () => {
  for (const options of [{ failLock: true }, { failWrite: true }, { failCommit: true }]) {
    const api = harness({ ...booking, services: [], service: { name: "Aircon Relocation" } }, [assignment], options);
    const result = await api.run("post", booking._id);
    assert.ok(result.statusCode === 409 || result.error);
    assert.equal(api.state().booking.services.length, 0);
    assert.equal(api.calls.ended, 1);
  }
});

test("unsupported transactions give a setup error rather than claiming a task was saved", async () => {
  const result = await harness(booking, [assignment], { unsupported: true }).run("post");
  assert.equal(result.statusCode, 503);
  assert.match(result.data.error, /replica set/);
});

test("scope and service-name identification agree without treating ordinary cleaning as relocation", () => {
  assert.equal(policy.isRelocationService({ name: "Aircon Relocation" }), true);
  assert.equal(policy.isRelocationService({ relocation: { scope: "same_property" } }), true);
  assert.equal(policy.isRelocationService({ name: "Aircon Cleaning" }), false);
});

test("the browser shows missing legacy details and only enables the owned item that is in progress", async () => {
  const result = await harness().run("get");
  const data = clone(result.data);
  data.items.push({ ...clone(data.items[0]), id: id(8), editable: false, assignmentStatus: "accepted" });
  const container = { innerHTML: "", addEventListener() {} };
  const message = { hidden: true, textContent: "", classList: { toggle() {} } };
  const handlers = {};
  const refresh = { addEventListener: (event, handler) => handlers.refresh = handler };
  let reads = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/relocation-work-order.js"), "utf8"), {
    document: { querySelector: () => ({ dataset: { bookingId: booking._id } }), getElementById: name => ({ relocationWorkOrder: container, relocationMessage: message, relocationRefresh: refresh })[name] },
    fetch: async () => { reads++; return { ok: true, json: async () => data }; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(container.innerHTML, /Destination needs confirmation/);
  assert.match(container.innerHTML, /Move type: same property or another address/);
  assert.match(container.innerHTML, /New position or address/);
  assert.doesNotMatch(container.innerHTML, /Some move details/);
  assert.match(container.innerHTML, /Open assigned job/);
  const inputs = [...container.innerHTML.matchAll(/<input[^>]*>/g)].map(match => match[0]);
  const active = inputs.filter(input => input.includes(`data-item="${id(4)}"`) && !input.includes("disabled"));
  const waiting = inputs.filter(input => input.includes(`data-item="${id(8)}"`) && !input.includes("disabled"));
  assert.equal(active.length, 5);
  assert.equal(waiting.length, 0);
  await handlers.refresh();
  assert.equal(reads, 2);
});

test("an unreadable API error leaves a clear message and a working refresh button", async () => {
  const container = { innerHTML: "Loading", addEventListener() {} };
  const message = { hidden: true, textContent: "", classList: { toggle() {} } };
  let refreshHandler;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/relocation-work-order.js"), "utf8"), {
    document: { querySelector: () => ({ dataset: { bookingId: booking._id } }), getElementById: name => ({ relocationWorkOrder: container, relocationMessage: message,
      relocationRefresh: { addEventListener: (event, handler) => refreshHandler = handler } })[name] },
    fetch: async () => ({ ok: false, json: async () => { throw new Error("Test non-JSON response"); } }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(message.hidden, false);
  assert.match(message.textContent, /Refresh and try again/);
  assert.equal(container.innerHTML, "");
  assert.equal(typeof refreshHandler, "function");
});

async function browserMarkup(data) {
  const container = { innerHTML: "", addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/relocation-work-order.js"), "utf8"), {
    document: { querySelector: () => ({ dataset: { bookingId: booking._id } }), getElementById: name => name === "relocationWorkOrder" ? container : null },
    fetch: async () => ({ ok: true, json: async () => data }),
  });
  await new Promise(resolve => setImmediate(resolve));
  return container.innerHTML;
}

test("the customer's same-property choice shows two positions and carries the unit between them", async () => {
  const near = clone(booking);
  near.services[0].airconType = "split";
  near.services[0].relocation = { scope: "same_property", from: { details: "Bedroom wall" }, to: { details: "Living room wall" } };
  const result = await harness(near).run("get");
  assert.deepEqual(Array.from(result.data.items[0].missingDetails), []);
  const html = await browserMarkup(result.data);
  assert.match(html, /Move within the same property/);
  assert.match(html, /Current position/);
  assert.match(html, /New position/);
  assert.match(html, /Bedroom wall/);
  assert.match(html, /Living room wall/);
  assert.match(html, /carry it to the agreed new position on this property/);
  assert.doesNotMatch(html, /Details to confirm with/);
  assert.equal((html.match(/<details class="rw-step" open>/g) || []).length, 1);
});

test("the customer's different-address choice shows the two saved addresses without treating it as a room move", async () => {
  const far = clone(booking);
  far.services[0].airconType = "split";
  far.services[0].relocation = { scope: "different_address", from: { address: "Saved current property", lat: 15.3, lng: 120.9 }, to: { address: "Saved new property", lat: 15.4, lng: 121.0 } };
  const result = await harness(far).run("get");
  assert.deepEqual(Array.from(result.data.items[0].missingDetails), []);
  const html = await browserMarkup(result.data);
  assert.match(html, /Move to another address/);
  assert.match(html, /Saved current property/);
  assert.match(html, /Saved new property/);
  assert.doesNotMatch(html, /New position: room/);
});

test("missing same-property positions are named explicitly even when the property address and pin are saved", async () => {
  const near = clone(booking);
  near.services[0].airconType = "split";
  near.services[0].relocation = { scope: "same_property", from: {}, to: {} };
  const result = await harness(near).run("get");
  assert.deepEqual(Array.from(result.data.items[0].missingDetails), ['Current position: room, floor or wall', 'New position: room, floor or wall']);
});

test("window relocation uses the applicable checklist for stage saves and completion without separate outdoor tasks", async () => {
  const windowBooking = clone(booking);
  windowBooking.services[0].airconType = "window";
  const api = harness(windowBooking);
  const result = await api.run("get");
  const item = result.data.items[0];
  const required = item.stages.flatMap(stage => stage.tasks.map(([key]) => stage.key + '.' + key));
  assert.equal(required.length, 11);
  assert.ok(!required.includes('removal.outdoor_remove'));
  assert.ok(!required.includes('installation.vacuum'));
  assert.equal((await api.run("post", id(4), "removal.outdoor_remove")).statusCode, 409);
  for (const task of required) assert.equal((await api.run("post", id(4), task)).statusCode, 200);
  assert.equal(checklist.allTasksComplete(api.state().booking.services[0]), true);
  const html = await browserMarkup(result.data);
  assert.doesNotMatch(html, /Remove outdoor unit|Mount outdoor unit|Vacuum the pipes/);
  assert.match(html, /0 of 11 tasks/);
});

test("finished stages collapse and the next unfinished stage opens without rewriting prior task history", async () => {
  const progressed = clone(booking);
  progressed.services[0].airconType = "split";
  progressed.services[0].relocation = { completedTasks: checklist.RELOCATION_STAGES[0].tasks.map(([key]) => 'removal.' + key) };
  const result = await harness(progressed).run("get");
  const html = await browserMarkup(result.data);
  assert.match(html, /Step 2 of 4/);
  assert.match(html, /class="rw-step is-complete"/);
  assert.equal(result.data.items[0].completedTasks.length, 5);
  assert.equal((html.match(/<details class="rw-step" open>/g) || []).length, 1);
});

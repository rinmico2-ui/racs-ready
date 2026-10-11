"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Order = require("../models/Order");
const routes = require("../routes/orderRoutes");
const notify = require("../utils/notify");
const audit = require("../utils/audit");
const { orderDepartureReadiness, orderUnitPreparationAttention } = require("../utils/orderPreparation");

const id = "507f191e810c19729de860ea";
const staffId = "507f191e810c19729de860eb";
const techId = "507f191e810c19729de860ec";
const customerId = "507f191e810c19729de860ed";
const dispatchRoute = routes.stack.find(layer => layer.route?.path === "/:id/dispatch-ready").route;
const source = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function order(overrides = {}) {
  return { _id: id, userId: customerId, technicianId: techId, orderReference: "ORD-PREPARE",
    status: "technician_accepted", fulfillmentType: "delivery_installation", paymentStatus: "partial",
    items: [{ quantity: 1 }], total: 5000, balanceAmount: 4000,
    delivery: { preferredDate: "2030-01-02T00:00:00+08:00" },
    preparation: { dispatch: { status: "pending" }, installation: { status: "pending" } }, ...overrides };
}
function fixture(t, current = order(), role = "admin") {
  const events = [], notifications = [], audits = [];
  t.mock.method(Order, "findById", async () => current);
  t.mock.method(Order, "findOneAndUpdate", async (_filter, patch) => {
    current.preparation.dispatch = patch.$set["preparation.dispatch"];
    return current;
  });
  t.mock.method(Order.prototype, "save", () => assert.fail("Do not overwrite the whole order"));
  t.mock.method(notify, "createNotification", async data => { notifications.push(data); return { _id: "notification" }; });
  t.mock.method(audit, "logEvent", async data => { audits.push(data); });
  const io = { to: room => ({ emit(event, payload) { events.push({ room, event, payload }); } }) };
  const req = { params: { id }, body: { note: "Unit, remote and accessories packed" },
    user: { _id: staffId, role, name: "Staff" }, app: { get: () => io } };
  return { current, req, events, notifications, audits };
}
async function confirm(req) {
  const res = response();
  let allowed = false;
  dispatchRoute.stack[1].handle(req, res, () => { allowed = true; });
  if (allowed) await dispatchRoute.stack.at(-1).handle(req, res);
  return res;
}

test("admin and secretary can prepare before or after acceptance without completing the installation kit", async t => {
  for (const role of ["admin", "secretary"]) {
    for (const status of ["preparing_unit", "technician_assigned", "technician_accepted"]) {
      await t.test(`${role}: ${status}`, async t => {
        const f = fixture(t, order({ status, technicianId: status === "preparing_unit" ? null : techId }), role);
        const res = await confirm(f.req);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.order.status, status);
        assert.equal(res.body.order.preparation.dispatch.status, "ready");
        assert.equal(res.body.order.preparation.installation.status, "pending");
        assert.equal(String(res.body.order.preparation.dispatch.readyBy), staffId);
        assert.ok(res.body.order.preparation.dispatch.readyAt instanceof Date);
        assert.equal(res.body.order.preparation.dispatch.note, f.req.body.note);
        assert.equal(f.audits.length, 1);
        assert.equal(f.notifications.length, status === "preparing_unit" ? 0 : 1);
        if (f.notifications.length) {
          assert.equal(f.notifications[0].userId, techId);
          assert.equal(f.notifications[0].role, "technician");
          assert.equal(f.notifications[0].referenceModel, "Order");
          assert.equal(f.notifications[0].link, `/technician/orders?order=${id}`);
          assert.match(f.notifications[0].message, /kit must also be confirmed/);
        }
        const rooms = f.events.map(event => event.room);
        assert.deepEqual(rooms, status === "preparing_unit" ? [`customer:${customerId}`, "admin-room"] : [`customer:${customerId}`, "admin-room", `tech:${techId}`]);
        assert.ok(f.events.every(event => event.event === "order:status-change" && event.payload.preparationUpdated === true));
      });
    }
  }
});

test("technicians and customers cannot confirm physical aircon preparation", async t => {
  for (const role of ["technician", "customer"]) {
    await t.test(role, async t => {
      const f = fixture(t, order(), role);
      t.mock.method(Order, "findById", () => assert.fail("Must reject before reading the order"));
      const res = await confirm(f.req);
      assert.equal(res.statusCode, 403);
      assert.equal(f.notifications.length, 0);
    });
  }
});

test("repeated confirmation preserves the first staff record and sends no duplicate notifications", async t => {
  const f = fixture(t);
  await confirm(f.req);
  const first = f.current.preparation.dispatch;
  f.req.user._id = customerId;
  f.req.body.note = "Second click";
  const res = await confirm(f.req);
  assert.equal(res.body.alreadyReady, true);
  assert.equal(f.current.preparation.dispatch, first);
  assert.equal(first.readyBy, staffId);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.audits.length, 1);
});

test("atomic preparation update preserves concurrent installation changes and cannot overwrite a cancellation", async t => {
  const f = fixture(t);
  t.mock.method(Order, "findOneAndUpdate", async (filter, patch, options) => {
    assert.equal(filter.status, "technician_accepted");
    assert.equal(filter.fulfillmentType, "delivery_installation");
    assert.equal(filter["preparation.dispatch.status"].$ne, "ready");
    assert.deepEqual(Object.keys(patch.$set), ["preparation.dispatch"]);
    assert.equal(options.runValidators, true);
    f.current.status = "cancelled";
    f.current.preparation.installation.status = "confirmed";
    return null;
  });
  const res = await confirm(f.req);
  assert.equal(res.statusCode, 409);
  assert.equal(f.current.status, "cancelled");
  assert.equal(f.current.preparation.installation.status, "confirmed");
  assert.equal(f.notifications.length, 0);
});

test("a concurrent second confirmation is idempotent", async t => {
  const f = fixture(t);
  t.mock.method(Order, "findOneAndUpdate", async () => {
    f.current.preparation.dispatch = { status: "ready", readyBy: customerId };
    return null;
  });
  const res = await confirm(f.req);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alreadyReady, true);
  assert.equal(f.notifications.length, 0);
});

test("pickup and already departed or closed orders cannot use delivery preparation", async t => {
  for (const overrides of [{ fulfillmentType: "customer_pickup" }, ...["out_for_delivery", "arrived", "installing", "completed", "cancelled"].map(status => ({ status }))]) {
    await t.test(JSON.stringify(overrides), async t => {
      const f = fixture(t, order(overrides));
      t.mock.method(Order, "findOneAndUpdate", () => assert.fail("Must not update"));
      const res = await confirm(f.req);
      assert.ok([400, 409].includes(res.statusCode));
      assert.equal(f.notifications.length, 0);
    });
  }
});

test("a failed preparation write never sends a ready notification", async t => {
  const f = fixture(t);
  t.mock.method(Order, "findOneAndUpdate", async () => { throw new Error("Write failed"); });
  const res = await confirm(f.req);
  assert.equal(res.statusCode, 500);
  assert.equal(f.notifications.length, 0);
  assert.equal(f.events.length, 0);
});

test("notification failure does not claim notification delivery or undo saved preparation", async t => {
  const f = fixture(t);
  t.mock.method(notify, "createNotification", async () => null);
  const res = await confirm(f.req);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.technicianNotified, false);
  assert.equal(res.body.order.preparation.dispatch.status, "ready");
});

test("today and tomorrow preparation warnings follow Manila dates across UTC midnight", () => {
  const now = new Date("2030-01-01T17:00:00Z"); // Jan 2, Manila.
  assert.equal(orderUnitPreparationAttention(order(), now).unitPreparationDueLabel, "Today");
  assert.equal(orderUnitPreparationAttention(order({ delivery: { preferredDate: "2030-01-03T00:00:00+08:00" } }), now).unitPreparationDueLabel, "Tomorrow");
  for (const changed of [order({ status: "cancelled" }), order({ status: "out_for_delivery" }), order({ fulfillmentType: "customer_pickup" }), order({ preparation: { dispatch: { status: "ready" } } }), order({ delivery: {} }), order({ delivery: { preferredDate: "invalid" } }), order({ delivery: { preferredDate: "2030-01-04" } })]) {
    assert.equal(orderUnitPreparationAttention(changed, now).unitPreparationDueSoon, false);
  }
});

test("actual departure route rejects unprepared units and unconfirmed kits for staff and technicians", async t => {
  let handler;
  const routeSource = source("routes/orderRoutes.js");
  const start = routeSource.indexOf('router.patch("/:id/status"');
  const end = routeSource.indexOf('\nrouter.', start + 10);
  for (const role of ["admin", "technician"]) {
    for (const unitReady of [false, true]) {
      await t.test(`${role}: ${unitReady ? "kit pending" : "unit pending"}`, async () => {
        const current = order();
        current.preparation.dispatch.status = unitReady ? "ready" : "pending";
        current.save = () => assert.fail("Must not mark En Route");
        const kit = { technicianId: techId, status: unitReady ? "draft" : "confirmed", items: [{ name: "Pump", category: "equipment", orderIds: [id] }], deltaItems: [] };
        vm.runInNewContext(routeSource.slice(start, end), {
          router: { patch(_path, _authenticate, fn) { handler = fn; } }, authenticate: () => {},
          Order: { findById: async () => current }, Technician: { findOne: async () => ({ _id: techId }) },
          orderAttentionState: () => ({ isPastDate: false }), syncDailyKit: async () => kit, orderDepartureReadiness,
        });
        const res = response();
        await handler({ params: { id }, body: { status: "out_for_delivery" }, user: { _id: staffId, role } }, res);
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, "ORDER_PREPARATION_REQUIRED");
        assert.equal(current.status, "technician_accepted");
      });
    }
  }
});

test("technician progress separates staff preparation and kit checks, retaining missed-schedule warnings", () => {
  const view = source("views/pages/technician/technicianorders.ejs");
  const start = view.indexOf("  function orderNeedsScheduleRecovery");
  const end = view.indexOf("  function isTodayOrder", start);
  const context = { ORDER_PROGRESS_ACTIONS: {} };
  vm.runInNewContext(view.slice(start, end), context);
  const current = order();
  assert.match(context.orderPreparationAction(current).t, /Waiting for aircon/);
  current.preparation.dispatch.status = "ready";
  assert.match(context.orderPreparationAction(current).t, /installation kit/);
  current.preparation.installation.status = "confirmed";
  assert.equal(context.orderPreparationAction(current).t, "Ready for delivery");
  current.isPastDate = true;
  current.attentionTitle = "Schedule expired";
  assert.equal(context.orderPreparationAction(current).t, "Schedule expired");
});

test("technician live updates refresh the selected order after dialogs close", () => {
  const view = source("views/pages/technician/technicianorders.ejs");
  const start = view.indexOf("  var orderPreparationRefreshTimer");
  const end = view.indexOf("  fetchOrders().then", start);
  const handlers = {}, fetches = [], scheduled = new Map();
  let nextTimer = 0, dialogOpen = true;
  const context = {
    window: { socket: { on(event, fn) { handlers[event] = fn; } },
      Swal: { isVisible: () => dialogOpen }, fetchOrders: options => fetches.push(options),
      setTimeout(fn) { scheduled.set(++nextTimer, fn); return nextTimer; }, clearTimeout(id) { scheduled.delete(id); } },
    document: { hidden: false, readyState: "complete", addEventListener() {} },
  };
  vm.runInNewContext(view.slice(start, end), context);
  handlers["order:status-change"]();
  function tick() { const [id, fn] = scheduled.entries().next().value; scheduled.delete(id); fn(); }
  tick();
  assert.equal(fetches.length, 0);
  dialogOpen = false;
  tick(); tick();
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].quiet, true);
  assert.equal(typeof handlers["order:assigned"], "function");
  assert.equal(typeof handlers.connect, "function");
});

test("confirmed installation kit refreshes admin and assigned technician after saving, without repeated events", async () => {
  const kitSource = source('utils/dailyKitService.js');
  const start = kitSource.indexOf('async function syncOrderPreparationSummaries');
  const end = kitSource.indexOf('async function syncDailyKit', start);
  const current = order(), calls = [];
  const context = {
    uniqueIds: ids => ids, Order: {
      find: async () => [current],
      findOneAndUpdate: async (filter, patch) => {
        assert.equal(filter.technicianId, techId);
        assert.equal(filter['delivery.preferredDate'], current.delivery.preferredDate);
        assert.deepEqual(Object.keys(patch.$set), ['preparation.installation']);
        current.preparation.installation = patch.$set['preparation.installation'];
        calls.push('save');
        return current;
      },
    },
    orderInstallationReadiness: () => ({ status: 'confirmed', dailyKitId: id, requiredItems: [], blockers: [], confirmedAt: new Date() }),
    global: { io: { to: room => ({ emit(event) { assert.equal(event, 'order:status-change'); calls.push(room); } }) } },
  };
  vm.runInNewContext(kitSource.slice(start, end), context);
  await context.syncOrderPreparationSummaries({}, [id]);
  assert.deepEqual(calls, ['save', 'admin-room', `tech:${techId}`]);
  assert.equal(current.preparation.installation.status, 'confirmed');
  assert.equal(current.preparation.dispatch.status, 'pending');
  calls.length = 0;
  await context.syncOrderPreparationSummaries({}, [id]);
  assert.deepEqual(calls, ['save']);
});

test("admin live preparation updates keep the current order page", () => {
  const adminSource = source('public/js/admin-aircon-orders.js');
  const start = adminSource.indexOf('  let liveOrderRefreshTimer');
  const end = adminSource.indexOf('  setFulfillmentScope(initialScope', start);
  const handlers = {}, pages = [];
  let scheduled;
  const context = {
    window: { RACSOrdersSocket: { on(event, fn) { handlers[event] = fn; } },
      setTimeout(fn) { scheduled = fn; return 1; }, clearTimeout() {} },
    document: { hidden: false, addEventListener() {} },
    currentTab: 'overview', currentPage: 2, viewedOrderId: null,
    loadOverview: page => pages.push(page), loadTab: () => assert.fail('Must retain overview pagination'),
  };
  vm.runInNewContext(adminSource.slice(start, end), context);
  handlers['order:status-change']();
  scheduled();
  assert.deepEqual(pages, [2]);
});

test("installation summary cannot replace newer aircon preparation or a changed assignment", async () => {
  const kitSource = source('utils/dailyKitService.js');
  const start = kitSource.indexOf('async function syncOrderPreparationSummaries');
  const end = kitSource.indexOf('async function syncDailyKit', start);
  const snapshot = order(), saved = order(), events = [];
  const confirmation = { status: 'ready', readyBy: staffId, readyAt: new Date() };
  saved.preparation.dispatch = confirmation;
  let assignmentChanged = false;
  const context = {
    uniqueIds: ids => ids, Order: {
      find: async () => [snapshot],
      findOneAndUpdate: async (filter, patch) => {
        assert.equal(filter.status, snapshot.status);
        assert.equal(filter.technicianId, snapshot.technicianId);
        assert.equal(filter['delivery.preferredDate'], snapshot.delivery.preferredDate);
        if (assignmentChanged) return null;
        saved.preparation.installation = patch.$set['preparation.installation'];
        return saved;
      },
    },
    orderInstallationReadiness: () => ({ status: 'confirmed', requiredItems: [], blockers: [] }),
    global: { io: { to: room => ({ emit() { events.push(room); } }) } },
  };
  vm.runInNewContext(kitSource.slice(start, end), context);
  await context.syncOrderPreparationSummaries({}, [id]);
  assert.equal(saved.preparation.dispatch, confirmation);
  assert.equal(saved.preparation.installation.status, 'confirmed');
  assert.deepEqual(events, ['admin-room', `tech:${techId}`]);
  events.length = 0;
  assignmentChanged = true;
  await context.syncOrderPreparationSummaries({}, [id]);
  assert.equal(events.length, 0);
});

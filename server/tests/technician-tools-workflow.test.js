const test = require("node:test");
const assert = require("node:assert/strict");
const { createService, usageDay } = require("../utils/technicianToolsService");
const mongoose = require("mongoose");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const vm = require("node:vm");

const T = "507f1f77bcf86cd799439011", E = "507f1f77bcf86cd799439012", A = "507f1f77bcf86cd799439013", K = "507f1f77bcf86cd799439014", B = "507f1f77bcf86cd799439015", U = "507f1f77bcf86cd799439016";
const clone = value => structuredClone(value);
function values(row, key) {
  let result = [row];
  for (const part of key.split(".")) result = result.flatMap(value => Array.isArray(value) ? value.map(entry => entry?.[part]) : [value?.[part]]);
  return result.flatMap(value => Array.isArray(value) ? value : [value]);
}
function match(row, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some(item => match(row, item));
    if (key === "$and") return expected.every(item => match(row, item));
    const actual = values(row, key);
    if (expected && typeof expected === "object" && !(expected instanceof Date)) return Object.entries(expected).every(([op, target]) => {
      if (op === "$in") return actual.some(value => target.map(String).includes(String(value)));
      if (op === "$nin") return actual.every(value => !target.map(String).includes(String(value)));
      if (op === "$ne") return actual.every(value => value !== target);
      if (op === "$exists") return actual.some(value => value !== undefined) === target;
      if (op === "$lt") return actual.some(value => value != null && new Date(value) < new Date(target));
      if (op === "$gte") return actual.some(value => value != null && new Date(value) >= new Date(target));
      throw new Error("Unimplemented filter: " + op);
    });
    return actual.some(value => expected == null ? value == null : String(value) === String(expected));
  });
}
function expression(value, row) {
  if (typeof value === "string" && value.startsWith("$")) return row[value.slice(1)];
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const [op, input] = Object.entries(value)[0];
  const args = input.map(item => expression(item, row));
  if (op === "$cond") return args[0] ? args[1] : args[2];
  if (op === "$ifNull") return args[0] ?? args[1];
  if (op === "$add") return args[0] + args[1];
  if (op === "$subtract") return args[0] - args[1];
  if (op === "$max") return Math.max(...args);
  if (op === "$in") return args[1].includes(args[0]);
  if (op === "$gt") return args[0] > args[1];
  if (op === "$lte") return args[0] <= args[1];
  throw new Error("Unimplemented expression: " + op);
}
function fixture() {
  let data = {
    EquipmentAssignment: [{ _id: A, technicianId: T, equipmentId: E, equipmentName: "Vacuum pump", quantity: 2, consumable: false, status: "checked_out", resolutionState: "open", dailyKitId: K, bookingId: B, workDate: new Date("2026-01-01T00:00:00+08:00"), checkedOutAt: new Date("2026-01-01T08:00:00+08:00") }],
    Tool: [{ _id: E, itemName: "Vacuum pump", quantity: 3, checkedOutQuantity: 2, assetCode: "EQ-001", minStockLevel: 1 }],
    DailyKit: [{ _id: K, technicianId: T, items: [{ _id: "row1", category: "equipment", toolId: E, equipmentAssignmentId: A, checkoutStatus: "checked_out", bookingIds: [B] }], deltaItems: [] }],
    BookingService: [{ _id: B, status: "completed" }],
    Assignment: [{ _id: "job1", bookingId: B, technicianId: T }],
    Order: [], DailyAssignment: [], WorkOrder: [], Project: [], Notification: [{ referenceId: A, referenceModel: "EquipmentAssignment", type: "equipment_return_overdue", read: false }], ToolAssignment: [], EquipmentUsageLog: [],
  };
  const writes = [], filters = [];
  let failInventory = false, failKit = false;
  function query(run) { return { session() { return this; }, select() { return this; }, lean() { return Promise.resolve().then(run); }, then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); } }; }
  function set(row, sets) { for (const [key, value] of Object.entries(sets)) { const parts = key.split("."); let parent = row; for (const part of parts.slice(0, -1)) parent = parent[part]; parent[parts.at(-1)] = value; } }
  const models = Object.fromEntries(Object.keys(data).map(name => [name, {
    find(filter) { filters.push({ name, filter }); return query(() => clone(data[name].filter(row => match(row, filter)))); },
    findById(value) { return query(() => clone(data[name].find(row => String(row._id) === String(value)) || null)); },
    exists(filter) { return query(() => data[name].some(row => match(row, filter))); },
    findOneAndUpdate(filter, update) { return query(() => { const row = data[name].find(row => match(row, filter)); if (!row) return null; writes.push(name); set(row, update.$set); return clone(row); }); },
    async updateOne(filter, update) {
      if (name === "Tool" && failInventory) throw new Error("inventory unavailable");
      if (name === "DailyKit" && failKit) throw new Error("kit unavailable");
      const row = data[name].find(row => match(row, filter)); if (!row) return { matchedCount: 0 };
      writes.push(name);
      if (Array.isArray(update)) { const snapshot = clone(row); for (const [key, value] of Object.entries(update[0].$set)) row[key] = expression(value, snapshot); }
      else set(row, update.$set);
      return { matchedCount: 1 };
    },
    async updateMany(filter, update) { for (const row of data[name].filter(row => match(row, filter))) { writes.push(name); set(row, update.$set); } },
    async create(row) { writes.push(name); data[name].push(clone(row)); return row; },
  }]));
  let ended = 0;
  const session = { async withTransaction(fn) { const snapshot = clone(data); try { await fn(); } catch (error) { data = snapshot; throw error; } }, async endSession() { ended++; } };
  const service = createService({ ...models, mongoose: { isValidObjectId: mongoose.isValidObjectId, async startSession() { return session; } } });
  return { service, get data() { return data; }, writes, filters, get ended() { return ended; }, set failInventory(value) { failInventory = value; }, set failKit(value) { failKit = value; } };
}
const input = { assignmentIds: [A], technicianIds: [T], userId: U, condition: "good" };

test("good returns update stock, Daily Kit, job return flag and admin overdue records together", async () => {
  const f = fixture();
  await f.service.returnEquipment(input);
  assert.equal(f.data.Tool[0].quantity, 5);
  assert.equal(f.data.Tool[0].checkedOutQuantity, 0);
  assert.equal(f.data.EquipmentAssignment[0].status, "returned");
  assert.equal(f.data.DailyKit[0].items[0].checkoutStatus, "returned");
  assert.equal(f.data.Assignment[0].equipmentReturned, true);
  assert.equal(f.data.Notification[0].read, true);
  assert.equal(f.ended, 1);
  await assert.rejects(f.service.returnEquipment(input), { status: 409 });
  assert.equal(f.data.Tool[0].quantity, 5, "retry must not restore stock twice");
});

test("failures after a return claim roll back every change", async () => {
  for (const failure of ["failInventory", "failKit"]) {
    const f = fixture(); f[failure] = true;
    await assert.rejects(f.service.returnEquipment(input), /unavailable/);
    assert.equal(f.data.Tool[0].quantity, 3);
    assert.equal(f.data.EquipmentAssignment[0].status, "checked_out");
    assert.equal(f.data.DailyKit[0].items[0].checkoutStatus, "checked_out");
    assert.equal(f.ended, 1);
  }
});

test("ownership, consumables and admin processing locks block returns without stock changes", async () => {
  for (const change of [{ technicianId: U }, { consumable: true }, { resolutionState: "processing" }]) {
    const f = fixture(); Object.assign(f.data.EquipmentAssignment[0], change);
    await assert.rejects(f.service.returnEquipment(input), error => [403, 409].includes(error.status));
    assert.equal(f.writes.length, 0);
  }
});

test("shared equipment cannot be returned while another linked booking remains unfinished", async () => {
  const f = fixture(); f.data.DailyKit[0].items[0].bookingIds.push(U); f.data.BookingService.push({ _id: U, status: "in_progress" });
  await assert.rejects(f.service.returnEquipment(input), { status: 409 });
  assert.equal(f.writes.length, 0);
});

test("a shared return updates the equipment return flag for every covered booking", async () => {
  const f = fixture();
  f.data.DailyKit[0].items[0].bookingIds.push(U);
  f.data.BookingService.push({ _id: U, status: "completed" });
  f.data.Assignment.push({ _id: "job2", bookingId: U, technicianId: T });
  await f.service.returnEquipment(input);
  assert.equal(f.data.Assignment[0].equipmentReturned, true);
  assert.equal(f.data.Assignment[1].equipmentReturned, true);
});

test("orders and today's project assignments also block early returns", async () => {
  for (const [key, model, status] of [["orderIds", "Order", "installing"], ["dailyAssignmentIds", "DailyAssignment", "in_progress"], ["workOrderIds", "WorkOrder", "accepted"]]) {
    const f = fixture(); f.data.DailyKit[0].items[0][key] = [U]; f.data[model].push({ _id: U, status });
    await assert.rejects(f.service.returnEquipment(input), { status: 409 });
    assert.equal(f.data.Tool[0].quantity, 3);
  }
});

test("damage and loss can be reported during work and never add available stock", async () => {
  for (const condition of ["damaged", "lost"]) {
    const f = fixture(); f.data.BookingService[0].status = "in_progress";
    await assert.rejects(f.service.returnEquipment({ ...input, condition }), { status: 400 });
    await f.service.returnEquipment({ ...input, condition, damageDescription: "Motor stopped working" });
    assert.equal(f.data.Tool[0].quantity, 3);
    assert.equal(f.data.Tool[0].assignable, false);
    assert.equal(f.data.DailyKit[0].items[0].checkoutStatus, "damaged");
    assert.equal(f.data.EquipmentAssignment[0].status, condition);
  }
});

test("extra Daily Kit rows and project custody rows stay in sync", async () => {
  for (const custody of [false, true]) {
    const f = fixture(); const row = f.data.DailyKit[0].items.pop();
    f.data.DailyKit[0].deltaItems.push(row);
    if (custody) { f.data.EquipmentAssignment[0].dailyKitId = null; row.equipmentAssignmentId = null; row.custodyAssignmentIds = [A]; }
    await f.service.returnEquipment(input);
    assert.equal(f.data.DailyKit[0].deltaItems[0].checkoutStatus, "returned");
  }
});

test("partial equipment returns leave the shared kit row checked out until the final record returns", async () => {
  const f = fixture(); f.data.EquipmentAssignment.push({ ...f.data.EquipmentAssignment[0], _id: U });
  await f.service.returnEquipment(input);
  assert.equal(f.data.DailyKit[0].items[0].checkoutStatus, "checked_out");
  await f.service.returnEquipment({ ...input, assignmentIds: [U] });
  assert.equal(f.data.DailyKit[0].items[0].checkoutStatus, "returned");
});

test("a failed second return rolls back the entire group rather than leaving a partial stock update", async () => {
  const f = fixture();
  f.data.EquipmentAssignment.push({ ...f.data.EquipmentAssignment[0], _id: U, equipmentId: "507f1f77bcf86cd799439017" });
  await assert.rejects(f.service.returnEquipment({ ...input, assignmentIds: [A, U] }), { status: 409 });
  assert.equal(f.data.Tool[0].quantity, 3);
  assert.equal(f.data.EquipmentAssignment[0].status, "checked_out");
  assert.equal(f.data.EquipmentAssignment[1].status, "checked_out");
  assert.equal(f.data.DailyKit[0].items[0].checkoutStatus, "checked_out");
});

test("a completed project work day can return its tools while the overall project continues", async () => {
  const f = fixture();
  Object.assign(f.data.EquipmentAssignment[0], { projectId: U, dailyAssignmentIds: [U] });
  f.data.Project.push({ _id: U, status: "in_progress" });
  f.data.DailyAssignment.push({ _id: U, status: "completed" });
  await f.service.returnEquipment(input);
  assert.equal(f.data.EquipmentAssignment[0].status, "returned");
});

test("missing linked inventory or Daily Kit records do not free stock or close the checkout", async () => {
  for (const missing of ["Tool", "DailyKit"]) {
    const f = fixture(); f.data[missing] = [];
    await assert.rejects(f.service.returnEquipment(input), { status: 409 });
    assert.equal(f.data.EquipmentAssignment[0].status, "checked_out");
    assert.equal(f.data.Notification[0].read, false);
  }
});

test("a return cannot clear an existing inventory maintenance or damage restriction", async () => {
  for (const assetStatus of ["under_maintenance", "damaged", "retired"]) {
    const f = fixture(); Object.assign(f.data.Tool[0], { assetStatus, assetCondition: "damaged", assignable: false });
    await f.service.returnEquipment(input);
    assert.equal(f.data.Tool[0].assetStatus, assetStatus);
    assert.equal(f.data.Tool[0].assetCondition, "damaged");
    assert.equal(f.data.Tool[0].assignable, false);
    assert.equal(f.data.Tool[0].quantity, 5);
  }
});

test("usage dates are checked in Philippine time, including invalid dates and future dates", () => {
  assert.equal(usageDay("2026-01-02", new Date("2026-01-01T16:10:00Z")).start.toISOString(), "2026-01-01T16:00:00.000Z");
  for (const date of ["2026-02-30", "2026-13-01", "invalid", "2026-01-03"]) assert.throws(() => usageDay(date, new Date("2026-01-01T16:10:00Z")), { status: 400 });
});

test("usage dropdown uses actual issued equipment and removes duplicates", async () => {
  const f = fixture();
  f.data.ToolAssignment.push({ technicianId: T, toolId: E, toolName: "Same pump", itemType: "equipment", assignedDate: new Date("2026-01-01"), returnedDate: null });
  const options = await f.service.usageOptions([T], "2026-01-02");
  assert.equal(options.length, 1);
  assert.equal(options[0]._id, E);
  assert.equal(options[0].name, "Vacuum pump");
});

test("usage logging only accepts equipment held on the selected date and does not change stock", async () => {
  const f = fixture();
  await assert.rejects(f.service.logUsage({ technicianId: T, technicianIds: [T], userId: U, equipmentId: U, date: "2026-01-02" }), { status: 403 });
  f.data.EquipmentAssignment[0].returnedAt = new Date("2026-01-01T16:00:00+08:00");
  f.data.EquipmentAssignment[0].status = "returned";
  await assert.rejects(f.service.logUsage({ technicianId: T, technicianIds: [T], userId: U, equipmentId: E, date: "2026-01-02" }), { status: 403 });
  const row = await f.service.logUsage({ technicianId: T, technicianIds: [T], userId: U, equipmentId: E, date: "2026-01-01", notes: "  Cleaning job  " });
  assert.equal(row.notes, "Cleaning job");
  assert.equal(row.equipmentCode, "EQ-001");
  assert.equal(f.data.Tool[0].quantity, 3);
  assert.equal(f.data.EquipmentUsageLog.length, 1);
});

test("invalid conditions, IDs and long notes do not reach database writes", async () => {
  const f = fixture();
  for (const changes of [{ condition: "broken" }, { assignmentIds: ["bad"] }, { damageDescription: "x".repeat(501) }]) await assert.rejects(f.service.returnEquipment({ ...input, ...changes }), { status: 400 });
  assert.equal(f.writes.length, 0);
});

test("tools view compiles with accessible forms, clear statuses, and an external page script", async () => {
  const file = path.join(__dirname, "../views/pages/technician/tools.ejs");
  const html = await ejs.renderFile(file, {});
  assert.match(html, /My tools/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-labelledby="ttReturnTitle"/);
  assert.match(html, /technician-tools\.js\?v=/);
  assert.doesNotMatch(html, /onclick=|confirm\(|prompt\(|style=/);
  const api = fs.readFileSync(path.join(__dirname, "../routes/technicianApi.js"), "utf8");
  assert.match(api, /technicianToolsService\.returnEquipment/g);
});

function route(method, routePath, service) {
  const api = fs.readFileSync(path.join(__dirname, "../routes/technicianApi.js"), "utf8");
  const start = api.indexOf(`router.${method}("${routePath}",`);
  assert.ok(start >= 0);
  const end = api.indexOf("\n});", start) + 5;
  let handler;
  vm.runInNewContext(api.slice(start, end), { router: { [method]: (_path, fn) => { handler = fn; } }, technicianToolsService: service, loadTechnicianContext: async () => ({ tech: { _id: T }, technicianIds: [T, U] }) });
  return handler;
}

test("the real return route passes the signed-in account scope and returns useful validation errors", async () => {
  let captured;
  const handler = route("post", "/equipment/:assignmentId/return", { async returnEquipment(body) { captured = body; throw Object.assign(new Error("This equipment is still needed."), { status: 409 }); } });
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ params: { assignmentId: A }, user: { _id: U }, body: { condition: "fair", damageDescription: "Wear marks", technicianIds: ["another-account"] } }, res, error => { throw error; });
  assert.equal(res.code, 409);
  assert.equal(res.body.error, "This equipment is still needed.");
  assert.deepEqual(Array.from(captured.technicianIds), [T, U]);
  assert.equal(captured.userId, U);
  assert.equal(captured.assignmentIds[0], A);
});

test("the real usage route cannot take an account identity from the submitted form", async () => {
  let captured;
  const handler = route("post", "/equipment-usage", { async logUsage(body) { captured = body; return { _id: "log" }; } });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ user: { _id: U }, body: { equipmentId: E, date: "2026-01-01", userId: "wrong-user", technicianId: "wrong-technician", technicianIds: ["wrong-technician"] } }, res, error => { throw error; });
  assert.equal(res.code, 201);
  assert.equal(captured.technicianId, T);
  assert.equal(captured.userId, U);
  assert.deepEqual(Array.from(captured.technicianIds), [T, U]);
});

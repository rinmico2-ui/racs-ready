"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Notification = require("../models/Notification");
const router = require("../routes/notifications");
const { notificationInboxFilter } = require("../utils/notificationInbox");

function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some(condition => matches(record, condition));
    if (value && typeof value === "object" && "$in" in value) return value.$in.includes(record[key]);
    if (value && typeof value === "object" && "$ne" in value) return record[key] !== value.$ne;
    return value === null ? record[key] == null : record[key] === value;
  });
}

async function withInbox(run) {
  const records = [
    { _id: "mine", userId: "tech-a", role: null, read: false, title: "Your assignment" },
    { _id: "another", userId: "tech-b", role: "technician", read: false, title: "Another technician's assignment" },
    { _id: "broadcast", userId: null, role: "technician", read: false, title: "Shared technician notice" },
    { _id: "admin-broadcast", userId: null, role: "admin", read: false, title: "Staff review" },
    { _id: "admin-private", userId: "admin-a", role: null, read: false, title: "Admin notice" },
  ];
  const keys = ["find", "countDocuments", "findOneAndUpdate", "updateMany", "deleteMany", "deleteOne"];
  const original = Object.fromEntries(keys.map(key => [key, Notification[key]]));
  Notification.find = filter => ({
    skipCount: 0, limitCount: 20,
    sort() { return this; },
    skip(value) { this.skipCount = value; return this; },
    limit(value) { this.limitCount = value; return this; },
    async lean() { return records.filter(record => matches(record, filter)).slice(this.skipCount, this.skipCount + this.limitCount).map(record => ({ ...record })); },
  });
  Notification.countDocuments = async filter => records.filter(record => matches(record, filter)).length;
  Notification.findOneAndUpdate = async (filter, update) => {
    const record = records.find(item => matches(item, filter));
    if (!record) return null;
    Object.assign(record, update);
    return { ...record };
  };
  Notification.updateMany = async (filter, update) => {
    const targets = records.filter(record => matches(record, filter));
    targets.forEach(record => Object.assign(record, update.$set || update));
    return { modifiedCount: targets.length };
  };
  Notification.deleteMany = async filter => {
    let deletedCount = 0;
    for (let i = records.length - 1; i >= 0; i--) {
      if (matches(records[i], filter)) { records.splice(i, 1); deletedCount++; }
    }
    return { deletedCount };
  };
  Notification.deleteOne = async filter => {
    const index = records.findIndex(record => matches(record, filter));
    if (index < 0) return { deletedCount: 0 };
    records.splice(index, 1);
    return { deletedCount: 1 };
  };
  try { await run(records); }
  finally { for (const key of keys) Notification[key] = original[key]; }
}

async function request(path, method, options = {}) {
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
  const handler = route.stack.at(-1).handle;
  const req = {
    user: { _id: "tech-a", role: "technician" },
    query: {}, params: {}, body: {}, ...options,
  };
  let code = 200;
  let body;
  const res = { status(value) { code = value; return this; }, json(value) { body = value; return this; } };
  await handler(req, res);
  return { code, body };
}

test("technician inboxes are personal; shared admin and secretary notices remain available", () => {
  assert.deepEqual(notificationInboxFilter("tech-a", "technician"), { userId: "tech-a" });
  assert.deepEqual(notificationInboxFilter("admin-a", "admin"), { $or: [{ userId: "admin-a" }, { userId: null, role: "admin" }] });
  assert.deepEqual(notificationInboxFilter("staff-a", "secretary"), { $or: [{ userId: "staff-a" }, { userId: null, role: "secretary" }] });
  assert.throws(() => notificationInboxFilter(null, "technician"), /recipient is required/);
});

test("full modal and unread count exclude another technician and all role-wide notices; query cannot change recipient", async () => {
  await withInbox(async () => {
    const mine = await request("/", "get", { query: { userId: "tech-b", role: "admin", limit: "100" } });
    assert.equal(mine.code, 200);
    assert.deepEqual(mine.body.notifications.map(n => n._id), ["mine"]);
    assert.equal(mine.body.total, 1);
    assert.equal(mine.body.unreadCount, 1);
    const other = await request("/", "get", { user: { _id: "tech-b", role: "technician" } });
    assert.deepEqual(other.body.notifications.map(n => n._id), ["another"]);
    const count = await request("/unread-count", "get");
    assert.equal(count.body.unreadCount, 1);
    const admin = await request("/", "get", { user: { _id: "admin-a", role: "admin" } });
    assert.deepEqual(admin.body.notifications.map(n => n._id), ["admin-broadcast", "admin-private"]);
  });
});

test("single read and delete return 404 for another technician or a shared notice", async () => {
  await withInbox(async records => {
    for (const id of ["another", "broadcast", "admin-private"]) {
      assert.equal((await request("/:id/read", "put", { params: { id } })).code, 404);
      assert.equal((await request("/:id", "delete", { params: { id } })).code, 404);
    }
    assert.equal(records.length, 5);
    assert.ok(records.every(record => !record.read));
    assert.equal((await request("/:id/read", "put", { params: { id: "mine" } })).code, 200);
    assert.equal(records.find(record => record._id === "mine").read, true);
    assert.equal((await request("/:id", "delete", { params: { id: "mine" } })).code, 200);
    assert.equal(records.length, 4);
  });
});

test("bulk selected actions ignore forged IDs for other users and role broadcasts", async () => {
  await withInbox(async records => {
    const body = { ids: ["mine", "another", "broadcast", "admin-private"] };
    assert.equal((await request("/read", "put", { body })).code, 200);
    assert.equal(records.find(record => record._id === "mine").read, true);
    assert.ok(records.filter(record => record._id !== "mine").every(record => !record.read));
    assert.equal((await request("/bulk-delete", "delete", { body })).code, 200);
    assert.deepEqual(records.map(record => record._id), ["another", "broadcast", "admin-broadcast", "admin-private"]);
  });
});

test("mark-all and delete-all only affect the signed-in technician's notifications", async () => {
  await withInbox(async records => {
    assert.equal((await request("/read-all", "put")).code, 200);
    assert.equal(records.find(record => record._id === "mine").read, true);
    assert.ok(records.filter(record => record._id !== "mine").every(record => !record.read));
    assert.equal((await request("/delete-all", "delete")).code, 200);
    assert.deepEqual(records.map(record => record._id), ["another", "broadcast", "admin-broadcast", "admin-private"]);
  });
});

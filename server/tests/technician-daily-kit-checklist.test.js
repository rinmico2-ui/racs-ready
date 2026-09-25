"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const mongoose = require("mongoose");
const DailyKit = require("../models/DailyKit");
const { checklistItems, needsChecklistCheck, retainChecklistState } = require("../utils/dailyKitService");

const read = file => fs.readFileSync(path.join(__dirname, file), "utf8");

test("Daily Kit items persist who checked them and when", () => {
  const userId = new mongoose.Types.ObjectId();
  const kit = new DailyKit({
    technicianId: new mongoose.Types.ObjectId(),
    workDate: new Date(),
    items: [{ name: "Vacuum Pump", category: "equipment", quantity: 1 }],
  });
  assert.equal(kit.items[0].preparedChecked, false);
  kit.items[0].preparedChecked = true;
  kit.items[0].preparedCheckedAt = new Date();
  kit.items[0].preparedCheckedBy = userId;
  const saved = kit.toObject().items[0];
  assert.equal(saved.preparedChecked, true);
  assert.equal(String(saved.preparedCheckedBy), String(userId));
  assert.ok(saved.preparedCheckedAt instanceof Date);
});

test("a normal kit refresh keeps a checkmark and a stable item ID", () => {
  const id = new mongoose.Types.ObjectId();
  const checkedAt = new Date();
  const previous = { _id: id, quantity: 2, checkoutStatus: "pending", preparedChecked: true, preparedCheckedAt: checkedAt };
  const next = { quantity: 2, checkoutStatus: "pending" };
  retainChecklistState(previous, next);
  assert.equal(String(next._id), String(id));
  assert.equal(next.preparedChecked, true);
  assert.equal(next.preparedCheckedAt, checkedAt);
});

test("changed quantity or availability clears an old checkmark", () => {
  const previous = { _id: new mongoose.Types.ObjectId(), quantity: 1, checkoutStatus: "pending", preparedChecked: true };
  for (const next of [{ quantity: 2, checkoutStatus: "pending" }, { quantity: 1, checkoutStatus: "unavailable" }]) {
    retainChecklistState(previous, next);
    assert.equal(next.preparedChecked, false);
    assert.equal(next.preparedCheckedAt, null);
  }
});

test("a confirmed kit checks only new delta items; not-required items are exempt", () => {
  const oldItem = { name: "Old tool" };
  const newItem = { name: "New part" };
  assert.deepEqual(checklistItems({ status: "draft", items: [oldItem] }), [oldItem]);
  assert.deepEqual(checklistItems({ status: "confirmed", hasDelta: true, items: [oldItem], deltaItems: [newItem] }), [newItem]);
  assert.deepEqual(checklistItems({ status: "confirmed", hasDelta: false, items: [oldItem] }), []);
  assert.equal(needsChecklistCheck({ resolution: { status: "not_required" } }), false);
  assert.equal(needsChecklistCheck({ resolution: { status: "rescheduled" } }), false);
  assert.equal(needsChecklistCheck({ resolution: { status: "confirmed_available" } }), true);
  assert.equal(needsChecklistCheck({ resolution: { status: "procured" }, checkoutStatus: "unavailable" }), true);
});

test("the technician UI and server both require checked items before confirmation", () => {
  const view = read("../views/partials/technician-order-daily-kit.ejs");
  const route = read("../routes/technicianApi.js");
  const service = read("../utils/dailyKitService.js");
  assert.match(view, /data-odk-check-item/);
  assert.match(view, /\/api\/technician\/daily-kit\/check-item/);
  assert.match(view, /remaining>0/);
  assert.match(route, /router\.post\("\/daily-kit\/check-item"/);
  assert.match(route, /router\.post\("\/daily-kit-legacy\/confirm"[\s\S]*?confirmDailyKit\(/);
  assert.match(service, /const unchecked = items\.filter\(item => needsChecklistCheck\(item\) && !item\.preparedChecked\)/);
  assert.match(service, /item\.checkoutStatus === "unavailable" &&[\s\S]*?needsChecklistCheck\(item\)/);
  assert.match(service, /strictManilaDateKey\(date\) !== manilaDateKey\(new Date\(\)\)/);
});

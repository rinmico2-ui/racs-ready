"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), "utf8");
}

const assignmentsView = read("../views/pages/technician/assignments.ejs");
const ordersView = read("../views/pages/technician/technicianorders.ejs");
const dailyKitPartial = read("../views/partials/technician-order-daily-kit.ejs");

test("booking assignments and installation orders render the same Daily Preparation component", () => {
  const sharedInclude = /include\('\.\.\/\.\.\/partials\/technician-order-daily-kit'\)/;
  assert.match(assignmentsView, sharedInclude);
  assert.match(ordersView, sharedInclude);
});

test("shared Daily Preparation determines empty state from covered jobs, not physical items", () => {
  assert.match(dailyKitPartial, /if\(!jobs\.length\)return .*label:'No jobs'/);
  assert.match(dailyKitPartial, /if\(!\(kit\.items\|\|\[\]\)\.length\)return .*label:'Ready to confirm'/);
  assert.match(dailyKitPartial, /odkConfirm'\)\.disabled=unavailable\.length>0\|\|!jobs\.length/);
});

test("shared Daily Preparation exposes compatible actions to both technician workflows", () => {
  assert.match(dailyKitPartial, /window\.openOrderDailyKit=window\.openTechnicianDailyKit/);
  assert.match(dailyKitPartial, /window\.openDailyKitModal=window\.openTechnicianDailyKit/);
  assert.match(dailyKitPartial, /window\.refreshOrderDailyKit=window\.refreshTechnicianDailyKit/);
});

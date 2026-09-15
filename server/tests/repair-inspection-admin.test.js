"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("repair admin exposes global and per-appliance inspection pricing", () => {
  const view = read("views/pages/admin/Services/ServiceCategories.ejs");
  const model = read("models/ServiceCategory.js");
  const adminRoutes = read("routes/adminApi.js");

  assert.match(view, /id="defaultInspectionFee"/);
  assert.match(view, /data-field="inspectionFee"/);
  assert.match(model, /inspectionFee:\s*\{\s*type:\s*Number/);
  assert.match(adminRoutes, /service-categories\/inspection-pricing/);
});

test("repair bookings resolve inspection prices from the server catalog", () => {
  const routes = read("routes/bookingRoutesNew.js");
  const standaloneClient = read("public/js/repair-request.js");

  assert.match(routes, /resolveRepairInspectionFees\(parsedServices\)/);
  assert.match(routes, /repairItems\.map\(item => \(\{ \.\.\.item, type: 'repair' \}\)\)/);
  assert.doesNotMatch(routes, /const diagFee = diagnosticFee/);
  assert.doesNotMatch(standaloneClient, /formData\.append\('diagnosticFee'/);
  assert.match(standaloneClient, /id = 'customRepairUnitType'/);
});

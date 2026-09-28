"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { REPAIR_MODEL_MAX_LENGTH, validateRepairModel } = require("../utils/repairModelPolicy");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8").replace(/\r\n/g, "\n");
const view = read("views/pages/services.ejs");
const script = read("public/js/services-multi.js");
const routes = read("routes/bookingRoutesNew.js");
const schema = read("models/BookingService.js");

test("repair model policy accepts legitimate values and enforces the length cap", () => {
  assert.equal(REPAIR_MODEL_MAX_LENGTH, 50);
  assert.deepEqual(validateRepairModel("  42KDPV48 / Rev-A  "), {
    valid: true,
    value: "42KDPV48 / Rev-A"
  });
  assert.equal(validateRepairModel("A".repeat(50)).valid, true);
  assert.equal(validateRepairModel("A".repeat(51)).valid, false);
  assert.match(validateRepairModel("<script>alert(1)</script>").error, /letters, numbers/);
});

test("repair model input exposes its limit and immediate validation feedback", () => {
  assert.match(view, /id="unitModel"[^>]*maxlength="50"[^>]*aria-errormessage="repairModelError"/);
  assert.match(view, /id="repairModelCount">0 \/ 50/);
  assert.match(script, /function syncRepairModelGuidance\(\)[\s\S]*?repairModelValidationMessage/);
  assert.match(script, /function addCurrentRepairItem\(\)[\s\S]*?const modelError = repairModelValidationMessage\(item\.model\)/);
});

test("repair model policy is enforced again by booking routes and the database schema", () => {
  assert.match(routes, /router\.post\('\/create-new'[\s\S]*?validateRepairModel\(service\.model\)/);
  assert.match(routes, /router\.post\('\/create-repair'[\s\S]*?validateRepairModel\(item\.model\)/);
  assert.match(routes, /async function validatedServiceItems[\s\S]*?validateRepairModel\(Object\.hasOwn\(input, "model"\) \? input\.model : prior\?\.model \|\| ""\)/);
  assert.match(schema, /model:\s*\{ type: String, trim: true, maxlength: 50 \}/);
});

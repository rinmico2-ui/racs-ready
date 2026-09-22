"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), "utf8");
}

const dailyKitService = read("../utils/dailyKitService.js");
const technicianApi = read("../routes/technicianApi.js");
const assignmentsView = read("../views/pages/technician/assignments.ejs");

test("repair and mixed Phase-2 work contributes approved quotation parts to the Daily Kit", () => {
  assert.match(dailyKitService, /booking\.serviceType === "repair" \|\| booking\.serviceType === "mixed"/);
  assert.match(dailyKitService, /item\?\.type === "repair" && REPAIR_PART_STATUSES\.includes\(item\.status\)/);
  assert.match(dailyKitService, /const isRepairVisit = hasScheduledRepairWork\(booking\)/);
});

test("all non-project booking departures use one Daily Kit readiness gate", () => {
  assert.match(technicianApi, /newStatus === 'en_route' && assignment\.serviceType !== 'project'/);
  assert.doesNotMatch(technicianApi, /newStatus === 'en_route' && assignment\.serviceType !== 'repair' && assignment\.serviceType !== 'project'/);
  assert.match(technicianApi, /dailyKitDepartureReadiness\(\{ technicianId: tech\._id, assignment \}\)/);
  assert.match(technicianApi, /Accept this repair assignment before preparing the Daily Kit or going En Route/);
  assert.ok((technicianApi.match(/dailyKitDepartureReadiness\(\{ technicianId: tech\._id, assignment \}\)/g) || []).length >= 3,
    "generic departure, repair departure, and repair-part checkout must share the readiness gate");
});

test("late Daily Kit changes block departure until additional preparation is confirmed", () => {
  assert.match(dailyKitService, /if \(kit\.hasDelta && Array\.isArray\(kit\.deltaItems\) && kit\.deltaItems\.length\)/);
  assert.match(dailyKitService, /Prepare the additional items before going En Route/);
  assert.match(dailyKitService, /const coverageChanged = assignments\.some/);
  assert.match(dailyKitService, /\|\| pendingCoverageReview/);
  assert.match(dailyKitService, /A new job was added after your Daily Kit was confirmed/);
  assert.match(assignmentsView, /'DAILY_KIT_JOB_NOT_INCLUDED'/);
  assert.match(assignmentsView, /openDailyKitModal\(\)/);
});

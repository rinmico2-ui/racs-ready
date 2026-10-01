"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/js/enterprise-calendar.js"), "utf8");
const browser = { window: {}, document: {} };
vm.runInNewContext(source, browser);
const { earliestFeasibleProjectEndDate } = browser.window.EnterpriseCalendar;

test("finish dates stay blocked until the available hours cover all work", () => {
  const days = new Map([
    ["2026-10-05", { isWorkingDay: true, capacityHours: 3 }],
    ["2026-10-06", { isWorkingDay: false, capacityHours: 0 }],
    ["2026-10-07", { isWorkingDay: true, capacityHours: 2 }],
    ["2026-10-08", { isWorkingDay: true, capacityHours: 4 }],
  ]);
  assert.equal(earliestFeasibleProjectEndDate("2026-10-05", days, 8), "2026-10-08");
  assert.equal(earliestFeasibleProjectEndDate("2026-10-05", days, 5), "2026-10-07");
  assert.equal(earliestFeasibleProjectEndDate("2026-10-07", days, 8), null);
  assert.equal(earliestFeasibleProjectEndDate("2026-10-05", days, 2), "2026-10-07");
});

test("finish-date calculation uses only capacity after the chosen start", () => {
  const days = new Map([
    ["2026-10-01", { isWorkingDay: true, capacityHours: 8 }],
    ["2026-10-02", { isWorkingDay: true, capacityHours: 1 }],
    ["2026-10-03", { isWorkingDay: true, capacityHours: 3 }],
  ]);
  assert.equal(earliestFeasibleProjectEndDate("2026-10-02", days, 4), "2026-10-03");
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeSystemConfiguration,
  priorityMeetsThreshold,
  isMaintenanceExempt,
} = require("../utils/systemConfiguration");

test("system configuration normalizes public and notification controls", () => {
  const value = normalizeSystemConfiguration({
    application: { allowCustomerRegistrations: false, requireEmailVerification: false },
    notifications: { adminAlertEmail: " ALERTS@EXAMPLE.COM ", criticalEmailAlerts: true, minimumPriority: "high" },
    maintenance: { enabled: true, message: " Planned work " },
  });
  assert.deepEqual(value.application, { allowCustomerRegistrations: false, requireEmailVerification: false });
  assert.equal(value.notifications.adminAlertEmail, "alerts@example.com");
  assert.equal(value.notifications.minimumPriority, "high");
  assert.equal(value.maintenance.message, "Planned work");
});

test("critical notification thresholds are explicit", () => {
  assert.equal(priorityMeetsThreshold("urgent", "high"), true);
  assert.equal(priorityMeetsThreshold("normal", "high"), false);
});

test("maintenance mode always leaves authentication and administrators recoverable", () => {
  assert.equal(isMaintenanceExempt("/login", null), true);
  assert.equal(isMaintenanceExempt("/api/auth/secure/login", null), true);
  assert.equal(isMaintenanceExempt("/api/auth/register", null), false);
  assert.equal(isMaintenanceExempt("/products", "customer"), false);
  assert.equal(isMaintenanceExempt("/admin/settings/system", "admin"), true);
});

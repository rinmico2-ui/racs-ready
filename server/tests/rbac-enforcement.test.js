const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const User = require("../models/User");
const Role = require("../models/Role");
const {
  ALL_PERMISSION_KEYS,
  getEffectivePermissions,
  requirePermission,
  requiredPermissionForRequest,
  allowedPermissionsForRole,
} = require("../middleware/requirePermission");

function request(role, method, originalUrl) {
  return { user: { role }, method, originalUrl };
}

test("permission catalog is unique and contains governed staff workspace capabilities", () => {
  assert.equal(new Set(ALL_PERMISSION_KEYS).size, ALL_PERMISSION_KEYS.length);
  for (const permission of [
    "orders.manage",
    "attendance.self.manage",
    "payroll.self.view",
    "assignments.self.manage",
    "remittances.self.manage",
  ]) {
    assert.ok(ALL_PERMISSION_KEYS.includes(permission), permission);
  }
  assert.ok(allowedPermissionsForRole("secretary").includes("inventory.manage"));
  assert.ok(!allowedPermissionsForRole("secretary").includes("roles.manage"));
  assert.ok(allowedPermissionsForRole("technician").includes("assignments.self.manage"));
  assert.deepEqual(allowedPermissionsForRole("customer"), []);
});

test("explicit empty user override denies all while reset state inherits", async () => {
  const denied = await getEffectivePermissions({
    role: "secretary",
    permissions: [],
    permissionsOverridden: true,
  });
  assert.deepEqual(denied, []);

  const legacyOverride = await getEffectivePermissions({
    role: "secretary",
    permissions: ["customers.view", "not.valid"],
  });
  assert.deepEqual(legacyOverride, ["customers.view"]);
});

test("request policy separates read access from management operations", () => {
  const resolve = (role, method, url) => {
    const req = request(role, method, url);
    return requiredPermissionForRequest(req.user, req);
  };
  assert.equal(resolve("secretary", "GET", "/api/secretary/inventory"), "inventory.view");
  assert.equal(resolve("secretary", "PATCH", "/api/secretary/inventory/123"), "inventory.manage");
  assert.equal(resolve("secretary", "POST", "/api/appointments/123/reschedule-approve"), "appointments.manage");
  assert.equal(resolve("technician", "GET", "/technician/expenses"), "expenses.self.manage");
  assert.equal(resolve("technician", "POST", "/api/technician/assignments/123/accept"), "assignments.self.manage");
  assert.equal(resolve("customer", "POST", "/api/appointments/create"), null);
});

test("permission middleware honors deny-all overrides and admin bypass", async () => {
  const middleware = requirePermission("inventory.manage");
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
  };
  let nextCalled = false;
  await middleware({ user: { role: "secretary", permissions: [], permissionsOverridden: true } }, res, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);
  assert.match(payload.error, /insufficient permissions/i);

  nextCalled = false;
  await middleware({ user: { role: "admin" } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("schemas preserve override intent and optimistic role revisions", () => {
  assert.ok(User.schema.path("permissionsOverridden"));
  assert.equal(Role.schema.path("revision").options.default, 1);
  assert.equal(Role.schema.path("permissionSchemaVersion").options.default, 1);
});

test("role mutations require reasons and record before-after audit context", () => {
  const controller = fs.readFileSync(path.join(__dirname, "../controllers/adminController.js"), "utf8");
  const rolesView = fs.readFileSync(path.join(__dirname, "../views/pages/admin/Roles/Roles.ejs"), "utf8");
  assert.match(controller, /change reason between 8 and 500 characters is required/i);
  assert.match(controller, /before: existing\.permissions/);
  assert.match(controller, /revision: expectedRevision/);
  assert.match(rolesView, /data-role-editable/);
  assert.match(rolesView, /roleChangeReason/);
  assert.match(rolesView, /data-user-override/);
});

const Role = require("../models/Role");
const { ALL_PERMISSION_KEYS } = require("../middleware/requirePermission");
const PERMISSION_SCHEMA_VERSION = 2;

/**
 * Seed default system roles.
 * Idempotent — inserts roles that don't exist, and ensures existing system
 * roles have up-to-date permission lists when the catalog grows.
 * Call on server startup.
 */
async function seedRoles() {
  const defaults = [
    {
      name: "admin",
      label: "Admin",
      description: "Full access to every feature and setting.",
      permissions: [...ALL_PERMISSION_KEYS], // all permissions
      isSystem: true,
      permissionSchemaVersion: PERMISSION_SCHEMA_VERSION,
    },
    {
      name: "secretary",
      label: "Secretary",
      description:
        "Manages appointments, booking requests, customers, and payments.",
      permissions: [
        "dashboard.view",
        "appointments.view",
        "appointments.manage",
        "booking_requests.view",
        "booking_requests.manage",
        "inventory.view",
        "customers.view",
        "customers.manage",
        "accounts.block",
        "accounts.unblock",
        "payments.view",
        "payments.manage",
        "reports.view",
        "staff.view",
        "technicians.view",
        "services.view",
        "orders.view",
        "orders.manage",
        "attendance.self.manage",
        "payroll.self.view",
      ],
      isSystem: true,
      permissionSchemaVersion: PERMISSION_SCHEMA_VERSION,
    },
    {
      name: "technician",
      label: "Technician",
      description: "View own appointments and dashboard.",
      permissions: [
        "dashboard.view",
        "attendance.self.manage",
        "payroll.self.view",
        "assignments.self.view",
        "assignments.self.manage",
        "expenses.self.manage",
        "tools.self.manage",
        "tracking.self.manage",
        "remittances.self.manage",
        "warranties.self.manage",
      ],
      isSystem: true,
      permissionSchemaVersion: PERMISSION_SCHEMA_VERSION,
    },
    {
      name: "customer",
      label: "Customer",
      description: "Regular customer — uses the public-facing booking flow.",
      permissions: [],
      isSystem: true,
      permissionSchemaVersion: PERMISSION_SCHEMA_VERSION,
    },
  ];

  for (const def of defaults) {
    const exists = await Role.findOne({ name: def.name });
    if (!exists) {
      await Role.create(def);
      console.log(`[seedRoles] Created system role: ${def.name}`);
    } else {
      // Apply newly introduced baseline permissions once per catalog version.
      // Subsequent administrator removals are preserved because the role is
      // already marked at the current schema version.
      const currentVersion = Number(exists.permissionSchemaVersion || 1);
      const shouldUpgrade = currentVersion < PERMISSION_SCHEMA_VERSION;
      const required = def.name === "admin" || shouldUpgrade ? def.permissions : [];
      const missing = required.filter((p) => !(exists.permissions || []).includes(p));
      if (missing.length || shouldUpgrade) {
        await Role.updateOne(
          { _id: exists._id },
          {
            ...(missing.length ? { $addToSet: { permissions: { $each: missing } } } : {}),
            $set: {
              permissionSchemaVersion: PERMISSION_SCHEMA_VERSION,
              revision: Number(exists.revision || 1),
            },
          },
        );
        console.log(`[seedRoles] Upgraded ${def.name} role to permission schema v${PERMISSION_SCHEMA_VERSION}`);
      }
    }
  }
}

module.exports = seedRoles;

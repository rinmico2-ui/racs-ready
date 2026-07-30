const Role = require("../models/Role");
const { ALL_PERMISSION_KEYS } = require("../middleware/requirePermission");

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
      ],
      isSystem: true,
    },
    {
      name: "technician",
      label: "Technician",
      description: "View own appointments and dashboard.",
      permissions: ["dashboard.view", "appointments.view"],
      isSystem: true,
    },
    {
      name: "customer",
      label: "Customer",
      description: "Regular customer — uses the public-facing booking flow.",
      permissions: [],
      isSystem: true,
    },
  ];

  for (const def of defaults) {
    const exists = await Role.findOne({ name: def.name });
    if (!exists) {
      await Role.create(def);
      console.log(`[seedRoles] Created system role: ${def.name}`);
    } else {
      // Ensure admin always has the full catalog (new keys added over time)
      if (def.name === "admin") {
        const missing = def.permissions.filter(
          (p) => !(exists.permissions || []).includes(p),
        );
        if (missing.length) {
          await Role.updateOne(
            { _id: exists._id },
            { $addToSet: { permissions: { $each: missing } } },
          );
          console.log(
            `[seedRoles] Added ${missing.length} new permission(s) to admin role`,
          );
        }
      }
    }
  }
}

module.exports = seedRoles;

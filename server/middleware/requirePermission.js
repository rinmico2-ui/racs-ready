const Role = require("../models/Role");

/**
 * Master catalog of every known permission key grouped by resource.
 * This is the single source-of-truth used by the admin UI and validation.
 */
const PERMISSION_CATALOG = [
  {
    group: "Dashboard",
    permissions: [
      { key: "dashboard.view", label: "View Dashboard" },
    ],
  },
  {
    group: "Appointments",
    permissions: [
      { key: "appointments.view", label: "View Appointments" },
      { key: "appointments.manage", label: "Create / Edit / Cancel Appointments" },
    ],
  },
  {
    group: "Booking Requests",
    permissions: [
      { key: "booking_requests.view", label: "View Booking Requests" },
      { key: "booking_requests.manage", label: "Approve / Reject Requests" },
    ],
  },
  {
    group: "Inventory",
    permissions: [
      { key: "inventory.view", label: "View Inventory" },
      { key: "inventory.manage", label: "Add / Edit / Delete Inventory" },
    ],
  },
  {
    group: "Customers",
    permissions: [
      { key: "customers.view", label: "View Customer List" },
      { key: "customers.manage", label: "Edit Customer Details" },
    ],
  },
  {
    group: "Account Management",
    permissions: [
      { key: "accounts.block", label: "Block User Accounts" },
      { key: "accounts.unblock", label: "Unblock User Accounts" },
    ],
  },
  {
    group: "Staff",
    permissions: [
      { key: "staff.view", label: "View Staff List" },
      { key: "staff.manage", label: "Create / Edit / Reset Password" },
    ],
  },
  {
    group: "Technicians",
    permissions: [
      { key: "technicians.view", label: "View Technician List" },
      { key: "technicians.manage", label: "Manage Schedules / Skills" },
    ],
  },
  {
    group: "Services",
    permissions: [
      { key: "services.view", label: "View Service Catalog" },
      { key: "services.manage", label: "Create / Edit Services" },
    ],
  },
  {
    group: "Payments",
    permissions: [
      { key: "payments.view", label: "View Payments" },
      { key: "payments.manage", label: "Manage Payments" },
    ],
  },
  {
    group: "Reports",
    permissions: [
      { key: "reports.view", label: "View Reports" },
    ],
  },
  {
    group: "Settings",
    permissions: [
      { key: "settings.view", label: "View Settings" },
      { key: "settings.manage", label: "Manage Settings" },
    ],
  },
  {
    group: "Roles & Permissions",
    permissions: [
      { key: "roles.view", label: "View Roles & Permissions" },
      { key: "roles.manage", label: "Edit Role Permissions" },
    ],
  },
  {
    group: "Logs",
    permissions: [
      { key: "logs.view", label: "View Activity Logs" },
    ],
  },
];

// Flat list of every valid permission key (for validation)
const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.flatMap((g) =>
  g.permissions.map((p) => p.key),
);

/**
 * Resolve the effective permission set for a user.
 * Priority: user.permissions  ➜  Role.permissions
 */
async function getEffectivePermissions(user) {
  // If the user has explicit per-user overrides, use those
  if (Array.isArray(user.permissions) && user.permissions.length > 0) {
    return user.permissions;
  }
  // Otherwise fall back to the defaults defined on the Role document
  const role = await Role.findOne({ name: user.role }).lean();
  return role ? role.permissions : [];
}

/**
 * Express middleware factory.
 *
 * Usage:
 *   const { requirePermission } = require('../middleware/requirePermission');
 *   router.get('/inventory', requirePermission('inventory.view'), handler);
 *
 * Admin users implicitly have all permissions (superuser bypass).
 */
function requirePermission(permission) {
  return async function _requirePermission(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      // Superuser bypass — admins always pass
      if (req.user.role === "admin") return next();

      const perms = await getEffectivePermissions(req.user);
      if (perms.includes(permission)) return next();

      return res
        .status(403)
        .json({ error: "Forbidden: insufficient permissions" });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  requirePermission,
  getEffectivePermissions,
  PERMISSION_CATALOG,
  ALL_PERMISSION_KEYS,
};

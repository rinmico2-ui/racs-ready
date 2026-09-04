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
    group: "Aircon Orders",
    permissions: [
      { key: "orders.view", label: "View Aircon Orders" },
      { key: "orders.manage", label: "Create / Assign / Fulfill Aircon Orders" },
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
  {
    group: "Personal Workspace",
    permissions: [
      { key: "attendance.self.manage", label: "Use Own Attendance" },
      { key: "payroll.self.view", label: "View Own Payroll" },
      { key: "assignments.self.view", label: "View Own Assignments" },
      { key: "assignments.self.manage", label: "Perform Assigned Work" },
      { key: "expenses.self.manage", label: "Manage Own Expenses" },
      { key: "tools.self.manage", label: "Manage Assigned Tools and Daily Kit" },
      { key: "tracking.self.manage", label: "Share and View Own Tracking" },
      { key: "remittances.self.manage", label: "Submit Own Remittances" },
      { key: "warranties.self.manage", label: "Perform Warranty Inspections" },
    ],
  },
];

// Flat list of every valid permission key (for validation)
const ALL_PERMISSION_KEYS = PERMISSION_CATALOG.flatMap((g) =>
  g.permissions.map((p) => p.key),
);

const SECRETARY_PERMISSION_KEYS = [
  "dashboard.view",
  "appointments.view", "appointments.manage",
  "booking_requests.view", "booking_requests.manage",
  "inventory.view", "inventory.manage",
  "customers.view", "customers.manage",
  "accounts.block", "accounts.unblock",
  "staff.view",
  "technicians.view", "technicians.manage",
  "services.view", "services.manage",
  "payments.view", "payments.manage",
  "orders.view", "orders.manage",
  "reports.view",
  "attendance.self.manage", "payroll.self.view",
];

const TECHNICIAN_PERMISSION_KEYS = [
  "dashboard.view",
  "attendance.self.manage", "payroll.self.view",
  "assignments.self.view", "assignments.self.manage",
  "expenses.self.manage", "tools.self.manage", "tracking.self.manage",
  "remittances.self.manage", "warranties.self.manage",
];

function allowedPermissionsForRole(roleName) {
  if (roleName === "admin") return [...ALL_PERMISSION_KEYS];
  if (roleName === "secretary") return [...SECRETARY_PERMISSION_KEYS];
  if (roleName === "technician") return [...TECHNICIAN_PERMISSION_KEYS];
  return [];
}

/**
 * Resolve the effective permission set for a user.
 * Priority: user.permissions  ➜  Role.permissions
 */
async function getEffectivePermissions(user) {
  if (!user) return [];
  if (user.role === "admin") return [...ALL_PERMISSION_KEYS];

  // An explicit empty override intentionally denies every configurable
  // permission. Legacy non-empty arrays are also treated as overrides.
  if (
    user.permissionsOverridden === true ||
    (Array.isArray(user.permissions) && user.permissions.length > 0)
  ) {
    const allowed = allowedPermissionsForRole(user.role);
    return Array.from(new Set((user.permissions || []).filter((key) => allowed.includes(key))));
  }
  // Otherwise fall back to the defaults defined on the Role document
  const role = await Role.findOne({ name: user.role }).lean();
  const allowed = allowedPermissionsForRole(user.role);
  return role ? Array.from(new Set((role.permissions || []).filter((key) => allowed.includes(key)))) : [];
}

async function hasPermission(user, permission) {
  if (!permission) return true;
  if (!user) return false;
  if (user.role === "admin") return true;
  const permissions = await getEffectivePermissions(user);
  return permissions.includes(permission);
}

function requestPath(req) {
  return String(req.originalUrl || req.url || "").split("?")[0].replace(/\/+$/, "") || "/";
}

function isReadRequest(req) {
  return ["GET", "HEAD", "OPTIONS"].includes(String(req.method || "GET").toUpperCase());
}

/**
 * Resolve protected staff requests to one permission key. Unmapped customer
 * and public routes remain governed by their existing ownership/role rules.
 */
function requiredPermissionForRequest(user, req) {
  if (!user || user.role === "admin" || user.role === "customer") return null;
  const path = requestPath(req);
  const read = isReadRequest(req);

  if (user.role === "secretary") {
    if (path === "/secretary" || path.startsWith("/secretary/overview")) return "dashboard.view";
    if (path.startsWith("/secretary/profile") || path.startsWith("/secretary/settings")) return null;
    if (path.startsWith("/secretary/attendance")) return "attendance.self.manage";
    if (path.startsWith("/secretary/payroll")) return "payroll.self.view";
    if (path.startsWith("/secretary/reports")) return "reports.view";
    if (path.startsWith("/secretary/payments")) return "payments.view";
    if (path.startsWith("/secretary/inventory")) return "inventory.view";
    if (path.startsWith("/secretary/services")) return "services.view";
    if (path.startsWith("/secretary/service-tracking")) return "appointments.view";
    if (path.startsWith("/secretary/appointments/booking-requests")) return "booking_requests.view";
    if (path.startsWith("/secretary/appointments/walk-in") || path.startsWith("/secretary/pointofsale")) return "appointments.manage";
    if (path.startsWith("/secretary/appointments") || path.startsWith("/secretary/calendar")) return "appointments.view";

    if (path.startsWith("/api/secretary/attendance")) return "attendance.self.manage";
    if (path.startsWith("/api/secretary/analytics")) return "dashboard.view";
    if (path.startsWith("/api/secretary/reports")) return "reports.view";
    if (path.startsWith("/api/secretary/payments")) return read ? "payments.view" : "payments.manage";
    if (path.startsWith("/api/secretary/customers")) return read ? "customers.view" : "customers.manage";
    if (path.startsWith("/api/secretary/technician-schedules") || path.startsWith("/api/secretary/dayoffs")) return read ? "technicians.view" : "technicians.manage";
    if (path.startsWith("/api/secretary/technicians")) return "technicians.view";
    if (path.startsWith("/api/secretary/staff")) return "staff.view";
    if (path.startsWith("/api/secretary/core-services") || path.startsWith("/api/secretary/repair-services")) return read ? "services.view" : "services.manage";
    if (path.startsWith("/api/secretary/service-categories") || path.startsWith("/api/secretary/service-types")) return "services.view";
    if (path.startsWith("/api/secretary/service-tracking")) return "appointments.view";
    if (path.startsWith("/api/secretary/inventory") || path.startsWith("/api/secretary/hvac") || path.startsWith("/api/secretary/tools") || path.startsWith("/api/secretary/tool-usage")) return read ? "inventory.view" : "inventory.manage";
    if (path.startsWith("/api/secretary/purchases")) return "inventory.view";

    if (path.startsWith("/api/appointments") || path.startsWith("/appointments")) return read ? "appointments.view" : "appointments.manage";
    if (path.startsWith("/api/orders") || path.startsWith("/api/walk-in-aircon") || path.startsWith("/api/pos")) return read ? "orders.view" : "orders.manage";
    if (path.startsWith("/api/users")) return read ? "customers.view" : "customers.manage";
    if (path.startsWith("/api/services") || path.startsWith("/api/schedule") || path.startsWith("/api/bookings") || path.startsWith("/api/booking-flow")) return read ? "appointments.view" : "appointments.manage";
    if (path.startsWith("/api/payroll")) return "payroll.self.view";
    return null;
  }

  if (user.role === "technician") {
    if (path === "/technician" || path.startsWith("/technician/analytics")) return "dashboard.view";
    if (path.startsWith("/technician/profile")) return null;
    if (path.startsWith("/technician/attendance")) return "attendance.self.manage";
    if (path.startsWith("/technician/payroll")) return "payroll.self.view";
    if (path.startsWith("/technician/expenses")) return "expenses.self.manage";
    if (path.startsWith("/technician/tools")) return "tools.self.manage";
    if (path.startsWith("/technician/tracking")) return "tracking.self.manage";
    if (path.startsWith("/technician/remittances")) return "remittances.self.manage";
    if (path.startsWith("/technician/warranty-claims")) return "warranties.self.manage";
    if (path.startsWith("/technician/orders") || path.startsWith("/technician/assignments") || path.startsWith("/technician/schedule") || path.startsWith("/technician/projects")) return "assignments.self.view";

    if (path.startsWith("/api/technician/attendance") || path.startsWith("/api/technician/leave-requests") || path.startsWith("/api/technician/availability")) return "attendance.self.manage";
    if (path.startsWith("/api/technician/remittances")) return "remittances.self.manage";
    if (path.startsWith("/api/technician/expenses")) return "expenses.self.manage";
    if (path.startsWith("/api/technician/tracking")) return "tracking.self.manage";
    if (path.startsWith("/api/technician/warranty-claims")) return "warranties.self.manage";
    if (path.startsWith("/api/technician/tools") || path.startsWith("/api/technician/tool-usage") || path.startsWith("/api/technician/equipment") || path.startsWith("/api/technician/equipment-usage") || path.startsWith("/api/technician/daily-kit")) return "tools.self.manage";
    if (path.startsWith("/api/technician/dashboard") || path.startsWith("/api/technician/kpis") || path.startsWith("/api/technician/notifications") || path.startsWith("/api/technician/badge-counts")) return "dashboard.view";
    if (path.startsWith("/api/technician")) return read ? "assignments.self.view" : "assignments.self.manage";
    if (path.startsWith("/api/orders") || path.startsWith("/api/appointments")) return read ? "assignments.self.view" : "assignments.self.manage";
    if (path.startsWith("/api/payroll")) return "payroll.self.view";
  }
  return null;
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
  hasPermission,
  requiredPermissionForRequest,
  allowedPermissionsForRole,
  PERMISSION_CATALOG,
  ALL_PERMISSION_KEYS,
};

const STAFF_RETENTION_POLICY = Object.freeze({
  version: "1.0",
  archiveMode: "soft_delete",
  automaticHardDelete: false,
  archiveReasonRequired: true,
  historicalWork: "retained",
  payrollRecords: "retained",
  auditRecords: "retained",
  staffProfiles: "retained",
  emailDeliveryLogsDays: 90,
});

const TERMINAL_ASSIGNMENT_STATUSES = [
  "completed",
  "cancelled",
  "declined",
  "expired",
  "no_show",
];
const TERMINAL_BOOKING_STATUSES = [
  "rejected",
  "completed",
  "cancelled",
  "no-show",
  "repair_declined",
  "repair_completed",
  "under_warranty",
  "warranty_claim",
  "closed",
];
const TERMINAL_SERVICE_STATUSES = ["completed", "cancelled", "repair_declined"];
const TERMINAL_ORDER_STATUSES = ["completed", "cancelled"];
const TERMINAL_PROJECT_STATUSES = ["completed", "closed", "cancelled"];

function normalizeArchiveReason(value) {
  const reason = String(value || "").trim().replace(/\s+/g, " ");
  if (reason.length < 10 || reason.length > 500) {
    const error = new Error("Archive reason must be between 10 and 500 characters.");
    error.statusCode = 400;
    error.code = "INVALID_ARCHIVE_REASON";
    throw error;
  }
  return reason;
}

function staffLifecycleState(record) {
  if (record && record.archivedAt) return "archived";
  if (record && record.active === false) return "inactive";
  return "active";
}

async function findStaffArchiveBlockers(technicianId, modelOverrides = {}) {
  if (!technicianId) return { total: 0, items: [] };

  // Lazy loading avoids model cycles and allows policy tests to inject small fakes.
  const Assignment = modelOverrides.Assignment || require("../models/Assignment");
  const BookingService = modelOverrides.BookingService || require("../models/BookingService");
  const Order = modelOverrides.Order || require("../models/Order");
  const Project = modelOverrides.Project || require("../models/Project");

  const [assignments, bookings, orders, projects] = await Promise.all([
    Assignment.countDocuments({
      technicianId,
      status: { $nin: TERMINAL_ASSIGNMENT_STATUSES },
    }),
    BookingService.countDocuments({
      $or: [
        { technicianId, status: { $nin: TERMINAL_BOOKING_STATUSES } },
        { "technician._id": technicianId, status: { $nin: TERMINAL_BOOKING_STATUSES } },
        {
          services: {
            $elemMatch: {
              technicianId,
              status: { $nin: TERMINAL_SERVICE_STATUSES },
            },
          },
        },
      ],
    }),
    Order.countDocuments({
      $or: [{ technicianId }, { "technician._id": technicianId }],
      status: { $nin: TERMINAL_ORDER_STATUSES },
    }),
    Project.countDocuments({
      $or: [
        { leadTechnicianId: technicianId },
        { "assignedTechnicians._id": technicianId },
        { "teamStatus._id": technicianId },
      ],
      status: { $nin: TERMINAL_PROJECT_STATUSES },
    }),
  ]);

  const items = [
    { type: "assignments", label: "open assignments", count: assignments },
    { type: "bookings", label: "active bookings", count: bookings },
    { type: "orders", label: "active delivery or installation orders", count: orders },
    { type: "projects", label: "active projects", count: projects },
  ].filter((item) => item.count > 0);

  return {
    total: items.reduce((sum, item) => sum + item.count, 0),
    items,
  };
}

module.exports = {
  STAFF_RETENTION_POLICY,
  TERMINAL_ASSIGNMENT_STATUSES,
  TERMINAL_BOOKING_STATUSES,
  TERMINAL_SERVICE_STATUSES,
  TERMINAL_ORDER_STATUSES,
  TERMINAL_PROJECT_STATUSES,
  normalizeArchiveReason,
  staffLifecycleState,
  findStaffArchiveBlockers,
};

const BookingService = require("../models/BookingService");
const EquipmentAssignment = require("../models/EquipmentAssignment");
const LeaveRequest = require("../models/LeaveRequest");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const Technician = require("../models/Technician");
const TechnicianAttendance = require("../models/TechnicianAttendance");
const { bookingReviewState } = require("./bookingReview");
const { equipmentReturnState } = require("./equipmentReturnPolicy");
const { orderAttentionState, REVIEWABLE_ORDER_STATUSES } = require("./orderAttention");
const { RECEIVED_PAYMENT_STATUSES } = require("./paymentSummary");

const TERMINAL_BOOKING_STATUSES = [
  "completed", "cancelled", "rejected", "expired", "no-show", "closed",
  "repair_completed", "repair_declined",
];
const TERMINAL_ORDER_STATUSES = ["completed", "cancelled"];

function localBounds(now = new Date()) {
  const current = new Date(now);
  const startOfDay = new Date(current);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(current);
  endOfDay.setHours(23, 59, 59, 999);
  const startOfMonth = new Date(current.getFullYear(), current.getMonth(), 1);
  return { current, startOfDay, endOfDay, startOfMonth };
}

function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function within(value, start, end) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date >= start && date <= end;
}

function paymentEventAt(payment) {
  return payment.collectedAt || payment.verifiedAt || payment.completedAt || payment.submittedAt || null;
}

function summarizeCollections(payments, bounds) {
  const accepted = new Set(RECEIVED_PAYMENT_STATUSES);
  const rows = (payments || []).filter(payment => accepted.has(payment.status));
  const summarize = (start, end) => {
    const cohort = rows.filter(payment => within(paymentEventAt(payment), start, end));
    const gross = cohort.reduce((sum, payment) => sum + money(payment.amount), 0);
    const refunds = (payments || []).filter(payment => within(payment.refundedAt, start, end))
      .reduce((sum, payment) => sum + money(payment.refundAmount), 0);
    // Net is cash movement, so it may legitimately be negative on a day where
    // refunds exceed new collections. Clamping would conceal treasury outflow.
    return { gross, refunds, net: gross - refunds, transactions: cohort.length };
  };
  return {
    today: summarize(bounds.startOfDay, bounds.endOfDay),
    month: summarize(bounds.startOfMonth, bounds.endOfDay),
  };
}

function summarizeAttendance(technicians, attendanceRecords, leaves) {
  const attendanceByTech = new Map((attendanceRecords || []).map(row => [String(row.technicianId), row]));
  const leaveByTech = new Map((leaves || []).map(row => [String(row.technicianId), row]));
  const summary = {
    headcount: (technicians || []).length,
    present: 0,
    late: 0,
    absent: 0,
    onLeave: 0,
    checkedOut: 0,
    unverified: 0,
    incomplete: 0,
    exceptions: [],
  };

  for (const technician of technicians || []) {
    const id = String(technician._id);
    const record = attendanceByTech.get(id);
    const leave = leaveByTech.get(id);
    const name = technician.name || "Technician";
    if (leave) {
      summary.onLeave += 1;
      continue;
    }
    if (!record || !["Present", "Late"].includes(record.status)) {
      summary.absent += 1;
      summary.exceptions.push({ technicianId: id, name, issue: "No valid check-in", tone: "danger" });
      continue;
    }
    if (record.status === "Late") summary.late += 1;
    else summary.present += 1;
    if (record.checkOutTime) summary.checkedOut += 1;
    if (record.method === "qr_scan" && !record.qrVerified) {
      summary.unverified += 1;
      summary.exceptions.push({ technicianId: id, name, issue: "QR attendance is unverified", tone: "warning" });
    }
    if (!record.checkInTime || (record.checkOutTime && new Date(record.checkOutTime) < new Date(record.checkInTime || 0))) {
      summary.incomplete += 1;
      summary.exceptions.push({ technicianId: id, name, issue: "Incomplete attendance record", tone: "warning" });
    }
  }
  summary.exceptions = summary.exceptions.slice(0, 5);
  return summary;
}

function summarizeEquipment(assignments, now) {
  const rows = (assignments || []).filter(assignment => !assignment.consumable).map(assignment => ({
    assignment,
    state: equipmentReturnState(assignment, now),
  }));
  const overdue = rows.filter(row => row.state.overdue);
  const dueToday = rows.filter(row => row.state.state === "due_today");
  const technicianIds = new Set(overdue.map(row => String(row.assignment.technicianId?._id || row.assignment.technicianId)));
  return {
    checkedOut: rows.length,
    dueToday: dueToday.length,
    overdue: overdue.length,
    overdueUnits: overdue.reduce((sum, row) => sum + Math.max(1, Number(row.assignment.quantity) || 1), 0),
    techniciansWithOverdue: technicianIds.size,
    oldestOverdueHours: overdue.length
      ? Math.max(...overdue.map(row => Math.floor(row.state.overdueMinutes / 60)))
      : 0,
    recentOverdue: overdue
      .sort((a, b) => b.state.overdueMinutes - a.state.overdueMinutes)
      .slice(0, 5)
      .map(row => ({
        id: String(row.assignment._id),
        equipment: row.assignment.equipmentName,
        quantity: Math.max(1, Number(row.assignment.quantity) || 1),
        technician: row.assignment.technicianId?.name || "Technician",
        expectedReturnAt: row.state.expectedReturnAt,
        overdueHours: Math.floor(row.state.overdueMinutes / 60),
      })),
  };
}

function groupCount(rows) {
  return (rows || []).reduce((map, row) => {
    map[row._id || "unknown"] = Number(row.count || 0);
    return map;
  }, {});
}

function buildSnapshot(source, now = new Date()) {
  const bounds = localBounds(now);
  const linkedOrderBookingIds = new Set((source.linkedOrderBookingIds || []).map(String));
  const bookingReviewRows = (source.bookingReviewRows || []).filter(
    booking => !booking.sourceOrderId && !linkedOrderBookingIds.has(String(booking._id)),
  );
  const overdueBookings = bookingReviewRows.filter(booking => bookingReviewState(booking, bounds.current).isReviewOverdue);
  const orderReviewRows = source.orderReviewRows || [];
  const overdueOrders = orderReviewRows.filter(order => orderAttentionState(order, bounds.current).isPastDate);
  const actionableOrders = orderReviewRows.filter(order =>
    ["pending_payment", "technician_declined"].includes(order.status)
    || (order.rescheduleRequest?.status === "pending" && order.rescheduleRequest?.requested)
    || orderAttentionState(order, bounds.current).isPastDate
  );
  const equipment = summarizeEquipment(source.equipmentRows, bounds.current);
  const attendance = summarizeAttendance(source.technicians, source.attendanceRecords, source.leaves);
  const collections = summarizeCollections(source.paymentRows, bounds);
  const bookingPipeline = groupCount(source.bookingPipeline);
  const orderPipeline = groupCount(source.orderPipeline);
  const remittance = groupCount(source.remittanceCounts);
  const overdueRecoveries = source.overdueRecoveries || [];
  const remittanceAmounts = (source.remittanceCounts || []).reduce((map, row) => {
    map[row._id || "unknown"] = money(row.amount);
    return map;
  }, {});
  const cancellations = source.cancellations?.[0] || {};

  const activeBookings = Object.entries(bookingPipeline)
    .filter(([status]) => !TERMINAL_BOOKING_STATUSES.includes(status))
    .reduce((sum, [, count]) => sum + count, 0);
  const activeOrders = Object.entries(orderPipeline)
    .filter(([status]) => !TERMINAL_ORDER_STATUSES.includes(status))
    .reduce((sum, [, count]) => sum + count, 0);
  const reviewTotal = bookingReviewRows.length + actionableOrders.length + Number(source.noShowPending || 0);
  const overdueReviewTotal = overdueBookings.length + overdueOrders.length;
  const remittanceActionCount = Number(remittance.waiting_for_remittance || 0)
    + Number(remittance.remitted || 0) + Number(remittance.rejected || 0) + Number(remittance.unaccounted || 0);

  const priorities = [
    overdueBookings.length && { tone: "danger", label: `${overdueBookings.length} overdue booking review${overdueBookings.length === 1 ? "" : "s"}`, href: "/admin/operations/resolution-center?source=booking" },
    overdueOrders.length && { tone: "danger", label: `${overdueOrders.length} overdue order review${overdueOrders.length === 1 ? "" : "s"}`, href: "/admin/inventory/aircon-orders" },
    equipment.overdue && { tone: "danger", label: `${equipment.overdue} overdue equipment return${equipment.overdue === 1 ? "" : "s"}`, href: "/admin/inventory/equipment-returns?state=overdue" },
    remittance.waiting_for_remittance && { tone: "warning", label: `${remittance.waiting_for_remittance} collection${remittance.waiting_for_remittance === 1 ? "" : "s"} still held by technicians`, href: "/admin/payments/remittance?status=waiting_for_remittance" },
    remittance.remitted && { tone: "warning", label: `${remittance.remitted} remittance${remittance.remitted === 1 ? "" : "s"} awaiting admin verification`, href: "/admin/payments/remittance?status=remitted" },
    remittance.unaccounted && { tone: "danger", label: `${remittance.unaccounted} unaccounted payment${remittance.unaccounted === 1 ? "" : "s"} — violation issued`, href: "/admin/payments/remittance?status=unaccounted" },
    overdueRecoveries.length && { tone: "danger", label: `${overdueRecoveries.length} recovery payment${overdueRecoveries.length === 1 ? "" : "s"} overdue — follow-up past due`, href: "/admin/payments/remittance?status=waiting_for_remittance" },
    attendance.absent && { tone: "warning", label: `${attendance.absent} active technician${attendance.absent === 1 ? "" : "s"} without a valid check-in`, href: "/admin/staff/attendance" },
  ].filter(Boolean);

  return {
    asOf: bounds.current.toISOString(),
    work: {
      bookings: {
        today: Number(source.bookingsToday || 0),
        createdToday: Number(source.bookingsCreatedToday || 0),
        active: activeBookings,
        completedToday: Number(source.bookingsCompletedToday || 0),
      },
      orders: {
        dueToday: Number(source.ordersDueToday || 0),
        createdToday: Number(source.ordersCreatedToday || 0),
        active: activeOrders,
        completedToday: Number(source.ordersCompletedToday || 0),
      },
    },
    review: {
      total: reviewTotal,
      overdue: overdueReviewTotal,
      bookings: bookingReviewRows.length,
      bookingOverdue: overdueBookings.length,
      orders: actionableOrders.length,
      orderOverdue: overdueOrders.length,
      noShow: Number(source.noShowPending || 0),
    },
    cancellations: {
      jobs: Number(cancellations.jobs || 0),
      events: Number(cancellations.events || 0),
      escalated: Number(cancellations.escalated || 0),
    },
    collections,
    equipment,
    remittance: {
      awaitingTechnician: Number(remittance.waiting_for_remittance || 0),
      awaitingTechnicianAmount: money(remittanceAmounts.waiting_for_remittance),
      awaitingAdmin: Number(remittance.remitted || 0),
      awaitingAdminAmount: money(remittanceAmounts.remitted),
      rejected: Number(remittance.rejected || 0),
      unaccounted: Number(remittance.unaccounted || 0),
      unaccountedAmount: money(remittanceAmounts.unaccounted),
      overdueRecoveries: overdueRecoveries.length,
      actionCount: remittanceActionCount,
      recent: source.recentRemittances || [],
    },
    attendance,
    priorities,
  };
}

async function buildAdminOperationsDashboard(now = new Date()) {
  const bounds = localBounds(now);
  const day = { $gte: bounds.startOfDay, $lte: bounds.endOfDay };
  const linkedOrderBookingIds = await Order.distinct("bookingId", { bookingId: { $ne: null } });
  const independentBookingFilter = {
    sourceOrderId: null,
    _id: { $nin: linkedOrderBookingIds },
  };
  const paymentDateQuery = {
    $or: ["collectedAt", "verifiedAt", "completedAt", "submittedAt", "refundedAt"].map(field => ({ [field]: { $gte: bounds.startOfMonth } })),
  };
  const cancellationPipeline = [
    { $match: { $or: [{ reassignmentCount: { $gt: 0 } }, { "cancellationHistory.0": { $exists: true } }] } },
    { $project: { events: { $size: { $ifNull: ["$cancellationHistory", []] } }, escalated: { $cond: [{ $or: ["$escalated", { $gte: ["$reassignmentCount", 3] }] }, 1, 0] } } },
    { $group: { _id: null, jobs: { $sum: 1 }, events: { $sum: "$events" }, escalated: { $sum: "$escalated" } } },
  ];

  const [
    bookingPipeline, orderPipeline, bookingsToday, bookingsCreatedToday,
    bookingsCompletedToday, ordersDueToday, ordersCreatedToday, ordersCompletedToday,
    bookingReviewRows, orderReviewRows, noShowPending,
    cancellations, paymentRows, remittanceCounts, recentRemittanceDocs,
    equipmentRows, technicians, attendanceRecords, leaves, overdueRecoveries,
  ] = await Promise.all([
    BookingService.aggregate([{ $match: independentBookingFilter }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    BookingService.countDocuments({
      ...independentBookingFilter,
      bookingDate: day,
      status: { $nin: ["cancelled", "rejected", "expired", "no-show", "closed", "repair_declined"] },
    }),
    BookingService.countDocuments({ ...independentBookingFilter, createdAt: day }),
    BookingService.countDocuments({ ...independentBookingFilter, status: { $in: ["completed", "repair_completed"] }, completedAt: day }),
    Order.countDocuments({ status: { $ne: "cancelled" }, $or: [{ "delivery.preferredDate": day }, { pickupDate: day }] }),
    Order.countDocuments({ createdAt: day }),
    Order.countDocuments({ status: "completed", completedAt: day }),
    BookingService.find({ ...independentBookingFilter, status: "pending" }).select("bookingDate preferredDate endTime selectedTimeLabel preferredTime startTime serviceDurationMinutes sourceOrderId").lean(),
    Order.find({
      $or: [
        { status: { $in: [...REVIEWABLE_ORDER_STATUSES] } },
        { "rescheduleRequest.requested": true, "rescheduleRequest.status": "pending" },
      ],
    }).select("status fulfillmentType pickupDate delivery.preferredDate timeSlot rescheduleRequest").lean(),
    BookingService.countDocuments({ status: { $in: ["no-show-reported", "no-show"] }, "noShowReport.reviewStatus": { $nin: ["confirmed", "rescheduled", "cancelled"] } }),
    BookingService.aggregate(cancellationPipeline),
    Payment.find({ status: { $in: [...RECEIVED_PAYMENT_STATUSES] }, ...paymentDateQuery })
      .select("amount status collectedAt verifiedAt completedAt submittedAt refundedAt refundAmount").lean(),
    Payment.aggregate([
      { $match: { $or: [{ status: { $in: ["waiting_for_remittance", "remitted", "rejected"] } }, { status: "unaccounted", resolvedAt: null }] } },
      { $group: { _id: "$status", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
    ]),
    Payment.find({ $or: [{ status: { $in: ["waiting_for_remittance", "remitted", "rejected"] } }, { status: "unaccounted", resolvedAt: null }] })
      .populate("bookingId", "bookingReference customer.name")
      .populate("orderId", "orderReference customer.name")
      .populate("collectedBy", "name")
      .sort({ collectedAt: -1, submittedAt: -1 }).limit(5).lean(),
    EquipmentAssignment.find({ status: { $in: ["checked_out", "in_use"] }, consumable: { $ne: true } })
      .populate("technicianId", "name").select("equipmentName quantity technicianId expectedReturnAt workDate checkedOutAt createdAt status consumable").lean(),
    Technician.find({ active: { $ne: false } }).select("name").lean(),
    TechnicianAttendance.find({ date: day }).lean(),
    LeaveRequest.find({ status: "approved", startDate: { $lte: bounds.endOfDay }, endDate: { $gte: bounds.startOfDay } }).select("technicianId reason").lean(),
    // Overdue recoveries: payments with recovery follow-up date past due
    Payment.find({ status: "waiting_for_remittance", resolutionType: "recovery", recoveryFollowUpDate: { $lt: now } })
      .populate("bookingId", "bookingReference customer.name")
      .populate("orderId", "orderReference customer.name")
      .populate("collectedBy", "name")
      .sort({ recoveryFollowUpDate: 1 }).lean(),
  ]);

  const recentRemittances = recentRemittanceDocs.map(payment => ({
    id: String(payment._id),
    reference: payment.bookingId?.bookingReference || payment.orderId?.orderReference || `PAY-${String(payment._id).slice(-8).toUpperCase()}`,
    customer: payment.bookingId?.customer?.name || payment.orderId?.customer?.name || "Customer",
    technician: payment.collectedBy?.name || payment.collectedByName || "Technician",
    status: payment.status,
    amount: money(payment.amount),
    collectedAt: payment.collectedAt || payment.submittedAt,
  }));

  return buildSnapshot({
    bookingPipeline, orderPipeline, bookingsToday, bookingsCreatedToday,
    bookingsCompletedToday, ordersDueToday, ordersCreatedToday, ordersCompletedToday,
    bookingReviewRows, orderReviewRows, linkedOrderBookingIds, noShowPending,
    cancellations, paymentRows, remittanceCounts, recentRemittances,
    equipmentRows, technicians, attendanceRecords, leaves, overdueRecoveries,
  }, now);
}

module.exports = {
  buildAdminOperationsDashboard,
  buildSnapshot,
  localBounds,
  paymentEventAt,
  summarizeAttendance,
  summarizeCollections,
  summarizeEquipment,
};

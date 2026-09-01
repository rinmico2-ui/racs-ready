const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    // Who receives this notification
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    role: {
      type: String,
      enum: ["admin", "secretary", "technician"],
      default: "admin",
      index: true,
    },

    // Notification content
    type: {
      type: String,
      enum: [
        "booking_created",
        "booking_confirmed",
        "booking_cancelled",
        "booking_completed",
        "booking_expired",
        "payment_received",
        "payment_verified",
        "assignment_new",
        "assignment_accepted",
        "assignment_declined",
        "expense_submitted",
        "expense_approved",
        "expense_rejected",
        "leave_requested",
        "leave_approved",
        "leave_rejected",
        "review_submitted",
        "system",
        "booking_delay",
        "booking_delay_tech",
        "booking_delay_customer",
        "booking_overdue_reschedule",
        "booking_verify_reminder",
        "service_delay",
        "project_verified",
        "project_plan_confirmed",
        "project_lead_participation_accepted",
        "project_team_assigned",
        "project_lead_accepted",
        "project_lead_declined",
        "project_member_ack",
        "project_member_declined",
        "project_risk",
        "project_progress",
        "project_status_update",
        "project_all_units_done",
        "project_inspection_submitted",
        "project_quotation_approved",
        "project_quotation_rejected",
        "project_issue",
        "project_payment",
        "daily_acceptance_required",
        "daily_acceptance_confirmed",
        "daily_acceptance_declined",
        "assignment_update",
        "booking_change_requested",
        "booking_change_approved",
        "booking_change_rejected",
        "booking_schedule_proposed",
        "booking_update_acknowledgement",
        "payroll_approved",
        "payroll_paid",
        "daily_kit_issue",
        "booking_no_show",
        "booking_waiting_customer",
        "booking_no_show_report",
        "maintenance_due_soon",
        "maintenance_due",
        "maintenance_overdue",
        "maintenance_scheduled",
        "maintenance_completed",
        "equipment_return_reminder",
        "equipment_return_overdue",
        "equipment_return_resolved",
      ],
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    message: { type: String, required: true },

    // Reference to the related document
    referenceId: { type: mongoose.Schema.Types.ObjectId },
    referenceModel: {
      type: String,
      enum: [
        "BookingService",
        "Assignment",
        "Expense",
        "LeaveRequest",
        "Review",
        "User",
        "Project",
        "Payment",
        "WorkOrder",
        "ProjectIssue",
        "CustomerAsset",
        "MaintenanceSchedule",
        "Payroll",
        "EquipmentAssignment",
      ],
    },

    // Link to navigate to when clicked
    link: { type: String, default: "" },

    // Read status
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date },

    // Priority
    priority: {
      type: String,
      enum: ["low", "normal", "high", "urgent"],
      default: "normal",
    },
  },
  { timestamps: true }
);

// Compound index for efficient queries
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ role: 1, read: 1, createdAt: -1 });

// Static: mark as read
notificationSchema.statics.markRead = async function (id) {
  return this.findByIdAndUpdate(
    id,
    { read: true, readAt: new Date() },
    { returnDocument: "after" }
  );
};

// Static: mark all as read for a user or role
notificationSchema.statics.markAllRead = async function (filter = {}) {
  return this.updateMany(
    { ...filter, read: false },
    { read: true, readAt: new Date() }
  );
};

// Static: get unread count
notificationSchema.statics.unreadCount = async function (filter = {}) {
  return this.countDocuments({ ...filter, read: false });
};

// Static: delete notifications by filter
notificationSchema.statics.deleteAll = async function (filter = {}) {
  return this.deleteMany(filter);
};

// Static: mark multiple as read by ids
notificationSchema.statics.markReadMany = async function (ids, userId, role) {
  return this.updateMany(
    { _id: { $in: ids }, read: false, $or: [{ userId }, { userId: null, role }] },
    { read: true, readAt: new Date() }
  );
};

// Static: delete multiple by ids
notificationSchema.statics.deleteManyByIds = async function (ids, userId, role) {
  return this.deleteMany({
    _id: { $in: ids },
    $or: [{ userId }, { userId: null, role }],
  });
};

module.exports = mongoose.model("Notification", notificationSchema);

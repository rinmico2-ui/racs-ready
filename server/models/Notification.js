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
        "assignment_accepted",
        "assignment_declined",
        "assignment_expired",
        "assignment_new",
        "assignment_released",
        "assignment_update",
        "booking_cancelled",
        "booking_change_approved",
        "booking_change_rejected",
        "booking_change_requested",
        "booking_completed",
        "booking_confirmed",
        "booking_created",
        "booking_delay",
        "booking_delay_customer",
        "booking_delay_tech",
        "booking_assignment_delayed",
        "booking_expired",
        "booking_no_show",
        "booking_no_show_report",
        "booking_overdue_reschedule",
        "booking_reschedule_accepted",
        "booking_reschedule_confirmed",
        "booking_reschedule_request",
        "booking_rescheduled",
        "booking_schedule_proposed",
        "booking_update_acknowledgement",
        "booking_verify_reminder",
        "booking_waiting_customer",
        "cost_updated",
        "daily_acceptance_confirmed",
        "daily_acceptance_declined",
        "daily_acceptance_required",
        "daily_kit_issue",
        "equipment_return_overdue",
        "equipment_return_reminder",
        "equipment_return_resolved",
        "expense_approved",
        "expense_rejected",
        "expense_submitted",
        "leave_approved",
        "leave_rejected",
        "leave_requested",
        "maintenance_completed",
        "maintenance_due",
        "maintenance_due_soon",
        "maintenance_overdue",
        "maintenance_scheduled",
        "order_rescheduled",
        "parts_request",
        "parts_reserved",
        "payment_collected",
        "payment_received",
        "payment_remitted",
        "payment_verified",
        "payroll_approved",
        "payroll_paid",
        "project_all_units_done",
        "project_inspection_submitted",
        "project_issue",
        "project_lead_accepted",
        "project_lead_declined",
        "project_lead_participation_accepted",
        "project_member_ack",
        "project_member_declined",
        "project_payment",
        "project_plan_confirmed",
        "project_progress",
        "project_quotation_approved",
        "project_quotation_rejected",
        "project_risk",
        "project_schedule_update",
        "project_status_update",
        "project_team_assigned",
        "project_verified",
        "remittance_flag",
        "remittance_override",
        "remittance_recovery",
        "remittance_reject",
        "remittance_verify",
        "resource_issue",
        "review_submitted",
        "service_added",
        "service_delay",
        "system",
        "warranty_claim_decided",
        "warranty_claim_submitted",
        "warranty_inspection_assigned",
        "warranty_inspection_completed",
        "warranty_inspection_scheduled",
        "warranty_inspection_update",
      ],
      required: true,
      trim: true,
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

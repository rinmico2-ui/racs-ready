const mongoose = require("mongoose");

const maintenanceScheduleSchema = new mongoose.Schema(
  {
    assetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerAsset",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    cycleKey: { type: String, required: true, unique: true, index: true },
    cycleNumber: { type: Number, min: 1, required: true },
    intervalDays: { type: Number, min: 30, max: 730, default: 90 },
    dueDate: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ["upcoming", "due", "overdue", "scheduled", "completed", "paused", "cancelled"],
      default: "upcoming",
      index: true,
    },
    sourceCompletionType: {
      type: String,
      enum: ["booking", "order", "installation_date", "admin"],
      required: true,
    },
    sourceCompletionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // The partial unique index below is the single source of truth. Declaring
    // index: true here as well makes Mongoose build a second, non-unique index
    // and emits a duplicate-schema-index warning at startup.
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingService", default: null },
    completedByBookingId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingService", default: null },
    completedAt: { type: Date, default: null },
    recommendation: {
      notes: { type: String, trim: true, maxlength: 1000, default: "" },
      recommendedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
      recommendedByName: { type: String, trim: true, default: "" },
    },
    reminders: {
      thirtyDayAt: { type: Date, default: null },
      sevenDayAt: { type: Date, default: null },
      dueAt: { type: Date, default: null },
      overdueAt: { type: Date, default: null },
    },
    outreach: {
      status: {
        type: String,
        enum: ["not_contacted", "contacted", "interested", "callback_requested", "declined", "unreachable"],
        default: "not_contacted",
        index: true,
      },
      lastContactedAt: { type: Date, default: null },
      nextFollowUpAt: { type: Date, default: null },
      method: {
        type: String,
        enum: ["", "phone", "email", "sms", "in_person", "other"],
        default: "",
      },
      notes: { type: String, trim: true, maxlength: 1000, default: "" },
      history: [{
        status: { type: String, required: true },
        method: { type: String, default: "" },
        notes: { type: String, trim: true, maxlength: 1000, default: "" },
        nextFollowUpAt: { type: Date, default: null },
        changedAt: { type: Date, default: Date.now },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        changedByName: { type: String, trim: true, default: "Administrator" },
      }],
    },
    pausedAt: { type: Date, default: null },
    pausedReason: { type: String, trim: true, maxlength: 500, default: "" },
    history: [{
      status: { type: String, trim: true },
      changedAt: { type: Date, default: Date.now },
      changedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
      changedByName: { type: String, trim: true, default: "System" },
      reason: { type: String, trim: true, maxlength: 500, default: "" },
    }],
  },
  { timestamps: true },
);

maintenanceScheduleSchema.index({ customerId: 1, status: 1, dueDate: 1 });
maintenanceScheduleSchema.index({ assetId: 1, cycleNumber: 1 }, { unique: true });
maintenanceScheduleSchema.index(
  { bookingId: 1 },
  { unique: true, partialFilterExpression: { bookingId: { $type: "objectId" } } },
);

module.exports = mongoose.model("MaintenanceSchedule", maintenanceScheduleSchema);

const mongoose = require("mongoose");

const EQ_STATUSES = ["reserved", "checked_out", "in_use", "returned", "consumed", "damaged", "lost"];

const equipmentAssignmentSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Project",
    required: function () { return !this.bookingId && !this.dailyKitId; },
    index: true,
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "BookingService",
    index: true,
  },
  orderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Order", index: true }],
  dailyKitId: { type: mongoose.Schema.Types.ObjectId, ref: "DailyKit", index: true },
  serviceItemId: { type: mongoose.Schema.Types.ObjectId, index: true },
  bookingReference: { type: String, trim: true },
  technicianId: { type: mongoose.Schema.Types.ObjectId, ref: "Technician", required: true, index: true },
  workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" },

  workDate: { type: Date, required: true },

  equipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", required: true },
  equipmentName: { type: String, required: true },
  equipmentCode: { type: String },

  quantity: { type: Number, default: 1, min: 1 },
  consumable: { type: Boolean, default: false },
  consumableUsed: { type: Number, default: 0 },

  status: { type: String, enum: EQ_STATUSES, default: "reserved" },

  condition: { type: String, trim: true },
  damageDescription: { type: String, trim: true },
  damagePhoto: { type: String },

  issuedBy: { type: String },
  issuedAt: { type: Date },
  checkedOutAt: { type: Date },
  checkedOutBy: { type: mongoose.Schema.Types.ObjectId },
  expectedReturnAt: { type: Date, index: true },
  lastReminderAt: { type: Date },
  reminderCount: { type: Number, default: 0, min: 0 },
  reminderHistory: [{
    sentAt: { type: Date, default: Date.now },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  }],
  overdueAdminNotifiedAt: { type: Date },
  returnedAt: { type: Date },
  returnedTo: { type: String },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  resolutionNotes: { type: String, trim: true, maxlength: 500 },
  resolutionState: { type: String, enum: ["open", "processing", "resolved"], default: "open", index: true },
  resolutionToken: { type: String, select: false },
  resolutionStartedAt: { type: Date },

  notes: { type: String, trim: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
});

equipmentAssignmentSchema.pre("save", function () {
  this.updatedAt = new Date();
  if (["checked_out", "in_use"].includes(this.status) && !this.expectedReturnAt) {
    const { expectedReturnForWorkDate } = require("../utils/equipmentReturnPolicy");
    this.expectedReturnAt = expectedReturnForWorkDate(this.workDate || this.checkedOutAt, null, 0);
  }
  if (["returned", "damaged", "lost"].includes(this.status)) this.resolutionState = "resolved";
});

equipmentAssignmentSchema.post("save", async function (document) {
  if (!["returned", "damaged", "lost"].includes(document.status)) return;
  try {
    const Notification = require("./Notification");
    await Notification.updateMany(
      { referenceModel: "EquipmentAssignment", referenceId: document._id, type: "equipment_return_overdue", read: false },
      { $set: { read: true, readAt: new Date() } },
    );
  } catch (error) {
    console.warn("[equipment-returns] Could not close resolved overdue notification:", error.message);
  }
});

equipmentAssignmentSchema.index({ projectId: 1, technicianId: 1, workDate: 1 });
equipmentAssignmentSchema.index({ bookingId: 1, serviceItemId: 1, workDate: 1 });
equipmentAssignmentSchema.index({ orderIds: 1, workDate: 1 });
equipmentAssignmentSchema.index({ status: 1, expectedReturnAt: 1 });
equipmentAssignmentSchema.index({ technicianId: 1, status: 1 });

module.exports = mongoose.model("EquipmentAssignment", equipmentAssignmentSchema);

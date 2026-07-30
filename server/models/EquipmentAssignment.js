const mongoose = require("mongoose");

const EQ_STATUSES = ["reserved", "checked_out", "in_use", "returned", "damaged", "lost"];

const equipmentAssignmentSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Project",
    required: function () { return !this.bookingId; },
    index: true,
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "BookingService",
    index: true,
  },
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
  returnedAt: { type: Date },
  returnedTo: { type: String },

  notes: { type: String, trim: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date },
});

equipmentAssignmentSchema.pre("save", function () {
  this.updatedAt = new Date();
});

equipmentAssignmentSchema.index({ projectId: 1, technicianId: 1, workDate: 1 });

module.exports = mongoose.model("EquipmentAssignment", equipmentAssignmentSchema);

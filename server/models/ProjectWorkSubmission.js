const mongoose = require("mongoose");

const projectWorkSubmissionSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
      required: true,
      index: true,
    },
    submittedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    clientSubmissionId: { type: String, required: true, trim: true, maxlength: 100 },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    proof: {
      url: { type: String, required: true, trim: true },
      originalName: { type: String, trim: true },
      mimeType: { type: String, trim: true },
      size: { type: Number, min: 0 },
    },
    workOrders: [{
      workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", required: true },
      workOrderNumber: { type: String, trim: true },
      title: { type: String, trim: true },
      completedUnits: { type: Number, required: true, min: 1 },
      unitKeys: [{ type: String, trim: true }],
    }],
    consumablesDeclaredNone: { type: Boolean, default: false },
    consumables: [{
      equipmentAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: "EquipmentAssignment", required: true },
      toolId: { type: mongoose.Schema.Types.ObjectId, ref: "Tool", required: true },
      itemName: { type: String, required: true, trim: true },
      unit: { type: String, trim: true, default: "pcs" },
      quantityUsed: { type: Number, required: true, min: 0.001 },
      quantityIssued: { type: Number, required: true, min: 0 },
      cumulativeQuantityUsed: { type: Number, required: true, min: 0 },
    }],
  },
  { timestamps: true },
);

projectWorkSubmissionSchema.index(
  { projectId: 1, technicianId: 1, clientSubmissionId: 1 },
  { unique: true },
);
projectWorkSubmissionSchema.index({ projectId: 1, createdAt: -1 });

module.exports = mongoose.model("ProjectWorkSubmission", projectWorkSubmissionSchema);

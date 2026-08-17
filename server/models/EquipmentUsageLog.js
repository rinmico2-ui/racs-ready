const mongoose = require("mongoose");

const equipmentUsageLogSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
      required: true,
      index: true,
    },
    equipmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tool",
      required: true,
    },
    equipmentName: { type: String, required: true, trim: true },
    equipmentCode: { type: String, default: "" },
    date: { type: Date, required: true, index: true },
    notes: { type: String, trim: true, maxlength: 500, default: "" },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

equipmentUsageLogSchema.index({ technicianId: 1, date: -1 });

module.exports = mongoose.model("EquipmentUsageLog", equipmentUsageLogSchema);

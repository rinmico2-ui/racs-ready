const mongoose = require("mongoose");

const customerAssetSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    assetKey: { type: String, required: true, unique: true, index: true },
    originType: {
      type: String,
      enum: ["booking", "order"],
      required: true,
      index: true,
    },
    originId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    originReference: { type: String, trim: true, default: "" },
    originItemKey: { type: String, trim: true, required: true },
    equipment: {
      category: { type: String, trim: true, default: "Air Conditioning" },
      applianceType: { type: String, trim: true, default: "" },
      applianceTypeName: { type: String, trim: true, default: "" },
      brand: { type: String, trim: true, default: "" },
      model: { type: String, trim: true, default: "" },
      capacity: { type: String, trim: true, default: "" },
      capacityUnit: { type: String, trim: true, default: "HP" },
      serialNumber: { type: String, trim: true, default: "" },
      unitLabel: { type: String, trim: true, default: "Unit 1" },
    },
    serviceAddress: { type: String, trim: true, default: "" },
    installationDate: { type: Date, default: null },
    lastServiceDate: { type: Date, default: null },
    maintenanceIntervalDays: { type: Number, min: 30, max: 730, default: 90 },
    status: {
      type: String,
      enum: ["active", "installation_date_required", "paused", "retired"],
      default: "active",
      index: true,
    },
    latestScheduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MaintenanceSchedule",
      default: null,
    },
    notes: { type: String, trim: true, maxlength: 1000, default: "" },
  },
  { timestamps: true },
);

customerAssetSchema.index({ customerId: 1, status: 1, updatedAt: -1 });
customerAssetSchema.index({ originType: 1, originId: 1, originItemKey: 1 }, { unique: true });

module.exports = mongoose.model("CustomerAsset", customerAssetSchema);

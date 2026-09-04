const mongoose = require("mongoose");

/**
 * Daily time record for secretary employees.
 *
 * Technician attendance intentionally remains in TechnicianAttendance because
 * that record also drives field availability, remittance, and expense rules.
 * Secretary attendance is a timekeeping record only and is keyed by User.
 */
const secretaryAttendanceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["Absent", "Present", "Late", "On Leave", "Sick Leave"],
      default: "Absent",
    },
    checkInTime: { type: Date, default: null },
    checkOutTime: { type: Date, default: null },
    qrVerified: { type: Boolean, default: false },
    method: {
      type: String,
      enum: ["qr_scan", "manual"],
      default: "qr_scan",
    },
    token: { type: String },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    remarks: { type: String, trim: true, maxlength: 500 },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

secretaryAttendanceSchema.index({ userId: 1, date: 1 }, { unique: true });
secretaryAttendanceSchema.index({ date: -1, status: 1 });

secretaryAttendanceSchema.virtual("isActive").get(function () {
  return ["Present", "Late"].includes(this.status) && this.checkInTime && !this.checkOutTime;
});

module.exports = mongoose.model("SecretaryAttendance", secretaryAttendanceSchema);

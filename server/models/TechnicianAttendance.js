const mongoose = require("mongoose");

const attendanceEvidenceSchema = new mongoose.Schema(
  {
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    accuracyMeters: { type: Number, min: 0 },
    capturedAt: Date,
    receivedAt: Date,
    distanceFromCompanyMeters: { type: Number, min: 0 },
    geofenceRadiusMeters: { type: Number, min: 0 },
    withinCompanyGeofence: Boolean,
    verifiedGeofenceType: { type: String, enum: ["company", "worksite"] },
    verifiedGeofenceId: { type: String, maxlength: 64 },
    verifiedGeofenceLabel: { type: String, maxlength: 160 },
    distanceFromVerifiedSiteMeters: { type: Number, min: 0 },
    trustedDeviceVerified: { type: Boolean, default: false },
    ipAddress: { type: String, maxlength: 128 },
    userAgent: { type: String, maxlength: 512 },
    qrChallengeId: { type: String, maxlength: 64 },
    qrIssuedAt: Date,
    qrExpiresAt: Date,
  },
  { _id: false },
);

/**
 * Daily attendance record for each technician.
 * Created when a technician scans the daily QR code
 * or when an admin manually records attendance.
 */
const technicianAttendanceSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },

    // normalized to midnight
    // one record per technician per day
    date: {
      type: Date,
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: [
        "Absent",
        "Present",
        "Late",
        "On Leave",
        "Sick Leave",
      ],
      default: "Absent",
    },

    /**
     * Time technician successfully scanned
     * attendance QR code.
     */
    checkInTime: {
      type: Date,
      default: null,
    },

    /**
     * Time technician officially leaves work.
     * Replaces the need for "Half Day".
     */
    checkOutTime: {
      type: Date,
      default: null,
    },

    noExpensesTodayConfirmed: { type: Boolean, default: false },
    noExpensesTodayConfirmedAt: { type: Date, default: null },

    /**
     * Whether attendance was verified
     * through QR code.
     */
    qrVerified: {
      type: Boolean,
      default: false,
    },

    /**
     * How attendance was recorded.
     */
    method: {
      type: String,
      enum: ["qr_scan", "manual"],
      default: "qr_scan",
    },

    /**
     * Daily QR token used during scan.
     * Useful for auditing.
     */
    token: { type: String, select: false },

    // v1 = legacy/manual record, v2 = trusted-device + signed QR + GPS evidence
    securityVersion: { type: Number, default: 1 },
    checkInEvidence: { type: attendanceEvidenceSchema, default: undefined },
    checkOutEvidence: { type: attendanceEvidenceSchema, default: undefined },

    /**
     * Admin who performed override.
     */
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    /**
     * Optional admin remarks.
     */
    remarks: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

/**
 * One attendance record per technician per day.
 */
technicianAttendanceSchema.index(
  { technicianId: 1, date: 1 },
  { unique: true }
);

/**
 * Virtual field:
 * Determines whether technician
 * is still considered active today.
 */
technicianAttendanceSchema.virtual("isActive").get(function () {
  return (
    ["Present", "Late"].includes(this.status) &&
    this.checkInTime &&
    !this.checkOutTime
  );
});

module.exports = mongoose.model(
  "TechnicianAttendance",
  technicianAttendanceSchema
);

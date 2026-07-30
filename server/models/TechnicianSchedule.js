const mongoose = require("mongoose");

// TechnicianSchedule is kept as a lightweight reference to Technician.
// Scheduling data (workingDays/restDates) is stored on the `Technician` document
// to avoid duplication. This model preserves the old collection name/shape
// so older migration scripts and any external tooling still work.
const technicianScheduleSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
      required: true,
    },
    workingDays: [
      {
        dayOfWeek: { type: Number, required: true }, // 0=Sun
        startMinutes: { type: Number, default: 8 * 60 },
        endMinutes: { type: Number, default: 19 * 60 }, // 7:00 PM (includes overtime)
      },
    ],

    // store weekdays explicitly marked as non-working (0=Sun…6=Sat). this
    // complements `workingDays` and makes it easy to query by rule without
    // computing the inverse on every read.
    nonWorkingWeekdays: [
      {
        dayOfWeek: { type: Number, min: 0, max: 6 },
      },
    ],

    restDates: [
      {
        date: { type: Date, index: true },
        reason: { type: String, trim: true, maxlength: 200 },
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// virtual populate: allow retrieving the schedule from the Technician document
technicianScheduleSchema.virtual("technician", {
  ref: "Technician",
  localField: "technicianId",
  foreignField: "_id",
  justOne: true,
});

// ensure a single schedule per technician at the DB level
technicianScheduleSchema.index(
  { technicianId: 1 },
  { unique: true, sparse: true },
);

module.exports = mongoose.model("TechnicianSchedule", technicianScheduleSchema);

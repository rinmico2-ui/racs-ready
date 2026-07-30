const mongoose = require("mongoose");

const leaveRequestSchema = new mongoose.Schema({
  technicianId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Technician",
    required: true,
  },
  // snapshot of technician info at request time
  technician: {
    name:  String,
    email: String,
    phone: String,
  },
  // date range being requested (single day: startDate === endDate)
  startDate: { type: Date, required: true },
  endDate:   { type: Date, required: true },
  reason:    { type: String, trim: true, maxlength: 500 },
  status: {
    type:    String,
    enum:    ["pending", "approved", "rejected"],
    default: "pending",
  },
  adminNote:  { type: String, trim: true, maxlength: 500 }, // admin note on review
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  reviewedAt: { type: Date },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date },
});

leaveRequestSchema.pre("save", async function () {
  this.updatedAt = new Date();
});

// virtual: human-readable date range label
leaveRequestSchema.virtual("dateLabel").get(function () {
  const opts = { year: "numeric", month: "short", day: "numeric" };
  const s = this.startDate ? this.startDate.toLocaleDateString("en-PH", opts) : "";
  const e = this.endDate   ? this.endDate.toLocaleDateString("en-PH", opts)   : "";
  if (!e || s === e) return s;
  return `${s} – ${e}`;
});

module.exports = mongoose.model("LeaveRequest", leaveRequestSchema);

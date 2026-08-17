const mongoose = require("mongoose");

const employeeCompensationSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    payType: {
      type: String,
      enum: ["daily", "hourly", "monthly"],
      required: true,
    },
    baseRate: {
      type: Number,
      required: true,
      min: 0,
      max: 10000000,
    },
    overtimeRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100000,
    },
    effectiveFrom: {
      type: Date,
      required: true,
      index: true,
    },
    effectiveTo: {
      type: Date,
      default: null,
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

employeeCompensationSchema.index({ employee: 1, effectiveFrom: 1 }, { unique: true, partialFilterExpression: { active: true } });
employeeCompensationSchema.index({ employee: 1, active: 1 });

module.exports = mongoose.model("EmployeeCompensation", employeeCompensationSchema);

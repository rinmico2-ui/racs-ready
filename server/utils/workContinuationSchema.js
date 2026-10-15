"use strict";
module.exports = function workContinuationSchema(mongoose) {
  const visit = new mongoose.Schema({
    date: Date, startTime: String, endTime: String, technicianId: mongoose.Schema.Types.ObjectId,
    endedAt: Date, previousStatus: String, reason: String, remainingWork: String, remainingMinutes: Number,
    arrivalProofUrl: String, startProofUrl: String,
  }, { _id: false });
  return new mongoose.Schema({
    status: { type: String, enum: ["pending", "scheduled", "resumed"] },
    requestId: String, requestedBy: mongoose.Schema.Types.ObjectId, requestedAt: Date,
    reason: { type: String, maxlength: 500 }, remainingWork: { type: String, maxlength: 1500 },
    remainingMinutes: { type: Number, min: 15, max: 480 }, previousStatus: String,
    scheduledDate: Date, startTime: String, endTime: String, decidedBy: mongoose.Schema.Types.ObjectId, decidedAt: Date,
    history: { type: [visit], default: [] },
  }, { _id: false });
};

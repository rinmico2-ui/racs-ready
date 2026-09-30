"use strict";

const MaintenanceSchedule = require("../models/MaintenanceSchedule");
const { getAftercarePolicy } = require("./aftercarePolicy");
const ACTIVE = ["upcoming", "due", "overdue"];

function summaryPipeline(filter, now, firstReminderDays) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const cutoff = new Date(now.getTime() + firstReminderDays * 86400000);
  const response = { $and: [
    { $in: ["$effectiveStatus", ACTIVE] },
    { $in: ["$customerResponse.status", ["booking_started", "callback_requested"]] },
    { $eq: [{ $ifNull: ["$customerResponse.acknowledgedAt", null] }, null] },
  ] };
  const count = expression => ({ $sum: { $cond: [expression, 1, 0] } });
  const group = { _id: null };
  for (const status of [...ACTIVE, "scheduled", "completed", "paused"]) {
    group[status] = count({ $eq: ["$effectiveStatus", status] });
  }
  group.dueSoon = count({ $and: [
    { $eq: ["$effectiveStatus", "upcoming"] },
    { $gte: ["$dueDate", now] }, { $lte: ["$dueDate", cutoff] },
  ] });
  group.responses = count(response);
  group.actionable = count({ $or: [{ $in: ["$effectiveStatus", ["due", "overdue"]] }, response] });
  return [
    { $match: filter },
    { $set: { effectiveStatus: { $cond: [
      { $and: [{ $in: ["$status", ACTIVE] }, { $ne: [{ $ifNull: ["$dueDate", null] }, null] }] },
      { $switch: { branches: [
        { case: { $lt: ["$dueDate", today] }, then: "overdue" },
        { case: { $lt: ["$dueDate", tomorrow] }, then: "due" },
      ], default: "upcoming" } },
      "$status",
    ] } } },
    { $group: group },
    { $project: { _id: 0 } },
  ];
}

async function maintenanceSummary(filter = {}, now = new Date()) {
  const policy = await getAftercarePolicy();
  const rows = await MaintenanceSchedule.aggregate(summaryPipeline(filter, now, policy.reminders.firstReminderDays));
  return rows[0] || { upcoming: 0, due: 0, overdue: 0, scheduled: 0, completed: 0, paused: 0, dueSoon: 0, responses: 0, actionable: 0 };
}

module.exports = { maintenanceSummary, summaryPipeline };

"use strict";
const DailyAssignment = require("../models/DailyAssignment");
const DailyKit = require("../models/DailyKit");
const WorkOrder = require("../models/WorkOrder");
const Technician = require("../models/Technician");
const kits = require("./dailyKitService");
const { manilaDateKey } = require("./bookingDateTime");

async function projectDailyPreparation(projectId, { date = new Date(), technicianIds = null, synchronize = false, viewerTechnicianId = null } = {}) {
  const { start, end } = kits.dayBounds(date);
  const filter = { projectId, date: { $gte: start, $lt: end }, planningOnly: { $ne: true }, status: { $in: ["pending", "in_progress"] } };
  if (technicianIds?.length) filter.technicianId = { $in: technicianIds };
  let rows = await DailyAssignment.find(filter).select("_id technicianId workOrderId").lean();
  const workOrders = rows.length ? await WorkOrder.find({ _id: { $in: rows.map(row => row.workOrderId) }, projectId,
    status: { $nin: ["cancelled", "completed", "declined", "rescheduled"] } }).select("_id").lean() : [];
  const active = new Set(workOrders.map(order => String(order._id)));
  rows = rows.filter(row => active.has(String(row.workOrderId)));
  const ids = [...new Set(rows.map(row => String(row.technicianId)))];
  const dateKey = manilaDateKey(start);
  if (!ids.length) return { ready: false, scheduled: false, date: dateKey, code: "PROJECT_WORK_NOT_SCHEDULED",
    error: "No committed project work is scheduled for this day. Ask the office to confirm the project schedule.", crew: [] };
  const technicians = await Technician.find({ _id: { $in: ids } }).select("_id name").lean();
  const names = new Map(technicians.map(tech => [String(tech._id), tech.name || "Technician"]));
  const stored = synchronize ? [] : await DailyKit.find({ technicianId: { $in: ids }, workDate: { $gte: start, $lt: end } }).lean();
  const byTech = new Map(stored.map(kit => [String(kit.technicianId), kit]));
  const crew = [];
  for (const technicianId of ids) {
    // Checkout transactions remain sequential: crew members share inventory.
    const kit = synchronize ? await kits.syncDailyKit(technicianId, dateKey) : byTech.get(technicianId);
    let result = kits.dailyKitReadiness(kit);
    const covered = new Set((kit?.dailyAssignmentIds || []).map(String));
    if (result.ready && rows.some(row => String(row.technicianId) === technicianId && !covered.has(String(row._id)))) {
      result = { ready: false, code: "DAILY_KIT_JOB_NOT_INCLUDED", error: "Today's project work was added after your kit was prepared. Review and confirm the updated Daily Preparation." };
    }
    crew.push({ technicianId, name: names.get(technicianId) || "Technician", ready: result.ready,
      code: result.code || null, error: result.ready ? null : result.error, kitStatus: kit?.status || "not_generated",
      isViewer: String(viewerTechnicianId || "") === technicianId });
  }
  const blocked = crew.filter(member => !member.ready);
  return { ready: blocked.length === 0, scheduled: true, date: dateKey, crew,
    code: blocked.length ? "DAILY_KIT_REQUIRED" : null,
    error: blocked.length ? `Daily Preparation is incomplete for ${blocked.map(member => member.name).join(", ")}. Each scheduled technician must confirm their shared kit before the crew leaves.` : null };
}
module.exports = { projectDailyPreparation };

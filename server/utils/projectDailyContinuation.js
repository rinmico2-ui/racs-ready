"use strict";
const { manilaDateKey } = require("./bookingDateTime");
const { dayBounds } = require("./dailyKitService");
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

function nextProjectWork(project, orders, allocations, now = new Date()) {
  const today = manilaDateKey(now);
  const active = orders.filter(order => !["completed", "cancelled", "declined"].includes(order.status) && Number(order.completedUnitCount || 0) < Number(order.unitCount || 0));
  const future = allocations.filter(row => !row.planningOnly && ["pending", "in_progress"].includes(row.status) && manilaDateKey(row.date) > today && active.some(order => String(order._id) === String(row.workOrderId)));
  const missing = active.some(order => {
    const rows = future.filter(row => String(row.workOrderId) === String(order._id));
    const units = (order.units || []).filter(unit => !["completed", "cancelled"].includes(unit.status));
    if (units.length) {
      const planned = new Set(rows.flatMap(row => row.unitKeys || []));
      return units.some(unit => !planned.has(unit.unitKey));
    }
    return rows.reduce((sum, row) => sum + Number(row.targetUnits || 0), 0) < Number(order.unitCount || 0) - Number(order.completedUnitCount || 0);
  });
  const date = future.map(row => row.date).sort((a, b) => new Date(a) - new Date(b))[0] || null;
  const technicianIds = [...new Set(future.filter(row => manilaDateKey(row.date) === manilaDateKey(date)).map(row => String(row.technicianId)))];
  return { date, technicianIds, scheduleRequired: active.length > 0 && (!date || missing), unfinished: active.length > 0 };
}

function dailyConfirmation(project, next) {
  return { required: next.unfinished, date: next.date, scheduleRequired: next.scheduleRequired,
    leadAccepted: false, leadAcceptedAt: null, declined: [],
    membersAccepted: (project.assignedTechnicians || []).filter(member => String(member._id) !== String(project.leadTechnicianId) && next.technicianIds.includes(String(member._id)))
      .map(member => ({ _id: member._id, name: member.name || "Technician", accepted: false, acceptedAt: null })) };
}

async function endProjectDay({ mongoose = require("mongoose"), Project = require("../models/Project"), WorkOrder = require("../models/WorkOrder"), DailyAssignment = require("../models/DailyAssignment"), projectId, leadId, now = new Date(), write = require('./atomicWorkflowChanges').atomicWorkflowChanges, lock = require('./operationLock').withOperationLock }) {
    return lock(`project-workday:${projectId}`, async () => {
      const project = await Project.findById(projectId).lean();
      if (!project || String(project.leadTechnicianId) !== String(leadId)) throw fail("Only the current project lead can end the workday.", 403);
      if (!["ready", "in_progress", "on_hold"].includes(project.status)) throw fail("This project is not open for daily work.");
      const { start, end } = dayBounds(now);
      const daily = await DailyAssignment.find({ projectId, date: { $gte: start, $lt: end }, planningOnly: { $ne: true } }).lean();
      if (!daily.length) throw fail("No committed project work is scheduled today.");
      if (daily.every(row => ['completed', 'skipped'].includes(row.status)) && daily.some(row => row.dayEndedAt)) return { project, duplicate: true, date: project.dailyAcceptance?.date, scheduleRequired: project.dailyAcceptance?.scheduleRequired };
      // Closing a workday does not complete its appliances or increase progress.
      const changes = daily.filter(row => ['pending', 'in_progress'].includes(row.status) || (row.status === 'completed' && !row.dayEndedAt))
        .map(row => ({ Model: DailyAssignment, before: row, set: row.status === 'completed' ? { dayEndedAt: now } : { status: 'completed', completedAt: now, dayEndedAt: now } }));
      const orders = await WorkOrder.find({ projectId, status: { $nin: ["completed", "cancelled", "declined"] } }).lean();
      for (const order of orders) {
        if (daily.some(row => String(row.workOrderId) === String(order._id)) && Number(order.completedUnitCount || 0) < Number(order.unitCount || 0) && ["en_route", "arrived", "in_progress", "partially_completed"].includes(order.status)) {
          changes.push({ Model: WorkOrder, before: order, set: { status: 'accepted' } });
        }
      }
      const future = await DailyAssignment.find({ projectId, date: { $gte: end }, planningOnly: { $ne: true }, status: { $in: ["pending", "in_progress"] } }).lean();
      const next = nextProjectWork(project, orders, future, now);
      changes.push({ Model: Project, before: project, set: { dailyAcceptance: dailyConfirmation(project, next) } });
      const results = await write(changes, mongoose);
      return { project: results[results.length - 1], ...next };
    });
}

async function confirmProjectDay({ projectId, technicianId, accept, reason = "", Project = require("../models/Project"), DailyAssignment = require("../models/DailyAssignment") }) {
  const project = await Project.findById(projectId).lean();
  if (!project) throw fail("Project not found.", 404);
  const isLead = String(project.leadTechnicianId) === String(technicianId);
  if (!isLead && !(project.assignedTechnicians || []).some(member => String(member._id) === String(technicianId))) throw fail("You are not assigned to this project.", 403);
  const daily = project.dailyAcceptance;
  if (!daily?.required) throw fail("No daily confirmation is pending.");
  if (!isLead && !daily.membersAccepted?.some(member => String(member._id) === String(technicianId))) throw fail("You are not scheduled on this workday.", 403);
  if (accept && (daily.scheduleRequired || !daily.date)) throw fail("Operations must confirm the remaining work schedule before the crew can continue.");
  if (accept && daily.declined?.length) throw fail("A crew member is unavailable. Operations must resolve staffing and recheck the schedule.");
  const workday = daily.date ? dayBounds(daily.date) : null;
  if (accept && !await DailyAssignment.exists({ projectId, ...(!isLead ? { technicianId } : {}), date: { $gte: workday.start, $lt: workday.end }, planningOnly: { $ne: true }, status: { $in: ["pending", "in_progress"] } })) throw fail("No committed allocation exists on this workday. Ask Operations to review the team.");
  const filter = { _id: projectId, "dailyAcceptance.required": true, "dailyAcceptance.date": daily.date,
    ...(isLead ? { leadTechnicianId: technicianId } : { "assignedTechnicians._id": technicianId }) };
  const update = accept
    ? { $set: isLead ? { "dailyAcceptance.leadAccepted": true, "dailyAcceptance.leadAcceptedAt": new Date() } : { "dailyAcceptance.membersAccepted.$[member].accepted": true, "dailyAcceptance.membersAccepted.$[member].acceptedAt": new Date() } }
    : { $set: { "dailyAcceptance.required": true }, $push: { "dailyAcceptance.declined": { _id: technicianId, name: (project.assignedTechnicians || []).find(member => String(member._id) === String(technicianId))?.name || 'Technician', reason, declinedAt: new Date() } } };
  if (accept) filter["dailyAcceptance.declined.0"] = { $exists: false };
  else filter['dailyAcceptance.declined._id'] = { $ne: technicianId };
  const updated = await Project.findOneAndUpdate(filter, update, { returnDocument: "after", ...(!isLead && accept ? { arrayFilters: [{ "member._id": technicianId }] } : {}) });
  if (!updated) throw fail("The crew or workday changed. Refresh before confirming.");
  let allConfirmed = false;
  if (accept) {
    const closed = await Project.findOneAndUpdate({ _id: projectId, "dailyAcceptance.date": daily.date, "dailyAcceptance.required": true,
      "dailyAcceptance.leadAccepted": true, "dailyAcceptance.membersAccepted": { $not: { $elemMatch: { accepted: false } } }, "dailyAcceptance.declined.0": { $exists: false } },
    { $set: { "dailyAcceptance.required": false } }, { returnDocument: "after" });
    allConfirmed = Boolean(closed);
  }
  return { project: updated, allConfirmed };
}
module.exports = { nextProjectWork, dailyConfirmation, endProjectDay, confirmProjectDay };

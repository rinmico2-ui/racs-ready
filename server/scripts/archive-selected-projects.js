"use strict";

// One-time, exact-ID cleanup requested on 2026-10-12. Defaults to a dry run.
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { manilaDateKey } = require("../utils/bookingDateTime");
const Project = require("../models/Project");
const Booking = require("../models/BookingService");
const WorkOrder = require("../models/WorkOrder");
const DailyAssignment = require("../models/DailyAssignment");
const Assignment = require("../models/Assignment");
const Material = require("../models/ProjectMaterial");
const EquipmentAssignment = require("../models/EquipmentAssignment");
const Payment = require("../models/Payment");
const Order = require("../models/Order");
const Tool = require("../models/Tool");
const ActivityLog = require("../models/ActivityLog");

const TARGETS = [
  ["6aca41db85bff4ddea7fe2a9", "Joshua Javier", "Dismantling & Reinstall", 40, 115.6, "2026-10-27"],
  ["6abd36aedfc76a18c59d863d", "testET test", "Aircon Installation, Aircon Installation", 40, 80, "2026-10-11"],
  ["6abd01fe6a718e6a5f9775b9", "Joshua Javier", "Aircon Installation", 40, 99.5, "2026-10-18"],
  ["6abbce1556a72e4d3569d8c8", "Joshua Javier", "Aircon Installation", 40, 236.5, "2026-10-20"],
  ["6abbcb8c56a72e4d3569d7ea", "Joshua Javier", "Aircon Cleaning", 40, 41, "2026-10-24"],
  ["6abb2de5f7df0425e37e8b67", "Joshua Javier", "Aircon Installation", 40, 189.5, "2026-10-22"],
  ["6abb2e34f7df0425e37e8ba2", "Joshua Javier", "Aircon Installation", 40, 189.5, "2026-10-22"],
  ["6aba7123100b0318b06ced16", "Joshua Javier", "Aircon Installation", 40, 108.3, "2026-10-13"],
  ["6aba66b6ee8661c8a2effdc8", "testET test", "Aircon Installation", 40, 101.8, "2026-10-02"],
  ["6a8b23914428281e837a8d99", "testET test", "Aircon Installation", 11, 16.5, "2026-09-07"],
];
const REASON = "Removed the ten listed large-scale projects at the system owner's request on October 12, 2026.";

function assertExactProjects(projects) {
  if (projects.length !== TARGETS.length) throw new Error("The exact ten projects were not found; no changes made.");
  for (const [id, name, service, units, hours, date] of TARGETS) {
    const project = projects.find(row => String(row._id) === id);
    const approved = project?.scheduleGovernance?.currentApprovedCompletionDate || project?.preferredCompletionDeadline || project?.plannedCompletionDate;
    if (!project || project.customer?.name !== name || project.service?.name !== service
      || project.totalUnits !== units || Math.round(project.estimatedTotalHours * 10) !== Math.round(hours * 10)
      || manilaDateKey(approved) !== date || Number(project.completedUnits || 0) !== 0
      || !["pending_project_scheduling", "accepted", "ready", "cancelled"].includes(project.status)) {
      throw new Error(`Project ${id} no longer matches the requested removal; no changes made.`);
    }
  }
}

async function snapshot(session) {
  const ids = TARGETS.map(row => new mongoose.Types.ObjectId(row[0]));
  const projects = await Project.collection.find({ _id: { $in: ids } }, { session }).toArray();
  assertExactProjects(projects);
  const bookingIds = projects.map(row => row.bookingId).filter(Boolean);
  const linked = { $or: [{ projectId: { $in: ids } }, { bookingId: { $in: bookingIds } }] };
  const collections = {
    projects,
    bookings: await Booking.collection.find({ _id: { $in: bookingIds } }, { session }).toArray(),
    workOrders: await WorkOrder.collection.find({ projectId: { $in: ids } }, { session }).toArray(),
    dailyAssignments: await DailyAssignment.collection.find({ projectId: { $in: ids } }, { session }).toArray(),
    assignments: await Assignment.collection.find(linked, { session }).toArray(),
    materials: await Material.collection.find({ projectId: { $in: ids } }, { session }).toArray(),
    equipment: await EquipmentAssignment.collection.find({ $or: [...linked.$or, { projectIds: { $in: ids } }] }, { session }).toArray(),
    payments: await Payment.collection.find(linked, { session }).toArray(),
    orders: await Order.collection.find({ bookingId: { $in: bookingIds } }, { session }).toArray(),
  };
  if (collections.orders.length) throw new Error("An aircon order is linked; use its cancellation/refund workflow instead.");
  if (collections.payments.some(row => row.status !== "pending")) throw new Error("A payment requires financial review; cleanup stopped.");
  if (collections.workOrders.some(row => Number(row.completedUnitCount || 0) > 0 || ["in_progress", "completed"].includes(row.status))
    || collections.dailyAssignments.some(row => Number(row.completedUnits || 0) > 0 || row.status === "in_progress")
    || collections.assignments.some(row => ["en_route", "on_site", "in_progress", "completed"].includes(row.status))
    || collections.bookings.some(row => ["on-the-way", "arrived", "in-progress", "completed", "repair_completed"].includes(row.status))) {
    throw new Error("Work has already started; cleanup stopped.");
  }
  const toolIds = [...new Set(collections.materials.filter(row => row.source === "inventory" && row.sourceId).map(row => String(row.sourceId)))].map(id => new mongoose.Types.ObjectId(id));
  collections.tools = await Tool.collection.find({ _id: { $in: toolIds } }, { session }).toArray();
  return collections;
}

async function archiveSelectedProjects({ apply = false } = {}) {
  const initial = await snapshot();
  const summary = { projects: initial.projects.length, linkedBookings: initial.bookings.length,
    workOrders: initial.workOrders.length, collectedMaterialRecordsRetained: initial.materials.filter(row => row.pickedUp).length,
    uncollectedReservations: initial.materials.filter(row => row.status === "reserved" && !row.pickedUp).length,
    equipmentRecords: initial.equipment.map(row => ({ id: String(row._id), status: row.status, sharedKit: Boolean(row.dailyKitId) })) };
  if (!apply) return { mode: "dry-run", ...summary };
  if (initial.projects.every(row => row.archivedAt && row.status === "cancelled")) return { mode: "already-archived", ...summary };
  const backupDir = path.resolve(__dirname, "../../temp");
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `selected-projects-before-archive-${Date.now()}.json`);
  // EJSON preserves ObjectIds, Dates and other BSON types for recovery.
  fs.writeFileSync(backup, mongoose.mongo.BSON.EJSON.stringify(initial, null, 2), { flag: "wx", mode: 0o600 });
  const session = await mongoose.startSession();
  let warnings;
  try {
    await session.withTransaction(async () => {
      const data = await snapshot(session);
      const at = new Date();
      warnings = [];
      for (const project of data.projects) {
        if (project.archivedAt) continue;
        await Project.collection.updateOne({ _id: project._id, status: project.status }, { $set: {
          status: "cancelled", archivedAt: at, archiveReason: REASON, updatedAt: at, reservedTechnicians: 0, dailyRequiredTechnicians: 0,
        } }, { session });
        await ActivityLog.collection.insertOne({ actor: null, action: "project.archived", module: "projects", category: "project",
          entityType: "Project", entityId: project._id, actionType: "cancelled", actorName: "System owner requested cleanup",
          source: "system", outcome: "success", createdAt: at, updatedAt: at,
          details: { reason: REASON, previousStatus: project.status, backup: path.basename(backup) },
        }, { session });
      }
      for (const booking of data.bookings) {
        if (booking.status === "cancelled") continue;
        const services = (booking.services || []).map(row => ({ ...row, status: "cancelled" }));
        await Booking.collection.updateOne({ _id: booking._id }, {
          $set: { status: "cancelled", cancellationReason: REASON, cancelledAt: at, updatedAt: at,
            autoReschedulePending: false, services },
          $push: { statusHistory: { fromStatus: booking.status || "pending_project_scheduling", toStatus: "cancelled",
            changedByModel: "System", changedByName: "System owner requested cleanup", changedAt: at, reason: REASON } },
        }, { session });
      }
      const ids = data.projects.map(row => row._id);
      await WorkOrder.collection.updateMany({ projectId: { $in: ids }, status: { $nin: ["completed", "cancelled"] } },
        { $set: { status: "cancelled", cancelledAt: at, cancellationReason: REASON, updatedAt: at } }, { session });
      await DailyAssignment.collection.updateMany({ projectId: { $in: ids }, status: { $nin: ["completed", "skipped"] } },
        { $set: { status: "skipped", notes: REASON, updatedAt: at } }, { session });
      await Assignment.collection.updateMany({ _id: { $in: data.assignments.map(row => row._id) }, status: { $nin: ["completed", "cancelled"] } },
        { $set: { status: "cancelled", cancelledAt: at }, $push: { notes: { text: REASON, byName: "System owner requested cleanup", createdAt: at } } }, { session });
      const released = new Map();
      for (const material of data.materials.filter(row => row.status === "reserved" && !row.pickedUp)) {
        await Material.collection.updateOne({ _id: material._id, status: "reserved", pickedUp: { $ne: true } },
          { $set: { status: "cancelled", cancelledAt: at, cancellationReason: REASON } }, { session });
        if (material.source === "inventory" && material.sourceId) {
          const id = String(material.sourceId);
          released.set(id, (released.get(id) || 0) + material.quantity);
        }
      }
      // Preserve other technicians' reservations. Never globally recompute the
      // ledger from project materials alone: Daily Kits share that counter.
      for (const [id, quantity] of released) {
        const result = await Tool.collection.updateOne({ _id: new mongoose.Types.ObjectId(id), reservedQuantity: { $gte: quantity } },
          { $inc: { reservedQuantity: -quantity } }, { session });
        if (result.matchedCount !== 1) warnings.push(`Tool ${id}: reservation count needs review; quantity was not changed.`);
      }
      const targetIds = new Set(ids.map(String));
      for (const record of data.equipment.filter(row => row.status === "reserved" && !row.dailyKitId && !row.checkedOutAt
        && (!row.projectId || targetIds.has(String(row.projectId)))
        && (row.projectIds || []).every(id => targetIds.has(String(id))))) {
        await EquipmentAssignment.collection.updateOne({ _id: record._id, status: "reserved" },
          { $set: { status: "released", releasedAt: at, releaseReason: REASON, resolutionState: "resolved" } }, { session });
      }
      // Payments and collected material/equipment records are retained.
    });
  } finally { await session.endSession(); }
  const remaining = await Project.countDocuments({ _id: { $in: TARGETS.map(row => row[0]) }, archivedAt: null });
  if (remaining) throw new Error("Some requested projects are still visible; inspect the backup before retrying.");
  return { mode: "archived", ...summary, remainingVisible: remaining, backup, warnings };
}

if (require.main === module) {
  require("dotenv").config({ quiet: true });
  (async () => {
    try {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000, autoIndex: false, autoCreate: false });
      console.log(JSON.stringify(await archiveSelectedProjects({ apply: process.argv.includes("--apply") }), null, 2));
    } catch (error) { console.error(error.name, error.code || "", error.message); process.exitCode = 1; }
    finally { await mongoose.disconnect(); }
  })();
}

module.exports = { TARGETS, assertExactProjects, archiveSelectedProjects };

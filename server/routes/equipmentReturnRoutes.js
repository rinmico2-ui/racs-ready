const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const EquipmentAssignment = require("../models/EquipmentAssignment");
const Assignment = require("../models/Assignment");
const DailyKit = require("../models/DailyKit");
const Technician = require("../models/Technician");
const Tool = require("../models/Tool");
const Notification = require("../models/Notification");
const audit = require("../utils/audit");
const { authenticate, requireRole } = require("../middleware/authenticate");
const { createNotification } = require("../utils/notify");
const { escapeRegex } = require("../utils/stringSecurity");
const { equipmentReturnState } = require("../utils/equipmentReturnPolicy");

const router = express.Router();
const ACTIVE_STATUSES = ["checked_out", "in_use"];
const REMINDER_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const MAX_BULK_SELECTION = 500;

router.use(authenticate);

function dayBounds(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function activeFilter() {
  return { consumable: { $ne: true }, status: { $in: ACTIVE_STATUSES } };
}

function overdueClause(now = new Date()) {
  const { start } = dayBounds(now);
  return {
    $or: [
      { expectedReturnAt: { $lt: now } },
      { $and: [{ expectedReturnAt: null }, { workDate: { $lt: start } }] },
    ],
  };
}

function dueTodayClause(now = new Date()) {
  const { start, end } = dayBounds(now);
  return {
    $or: [
      { expectedReturnAt: { $gte: now, $lt: end } },
      { $and: [{ expectedReturnAt: null }, { workDate: { $gte: start, $lt: end } }] },
    ],
  };
}

async function returnSummary(now = new Date()) {
  const base = activeFilter();
  const [checkedOut, overdue, dueToday, remindersSent] = await Promise.all([
    EquipmentAssignment.countDocuments(base),
    EquipmentAssignment.countDocuments({ ...base, ...overdueClause(now) }),
    EquipmentAssignment.countDocuments({ ...base, ...dueTodayClause(now) }),
    EquipmentAssignment.countDocuments({ ...base, reminderCount: { $gt: 0 } }),
  ]);
  return { checkedOut, overdue, dueToday, remindersSent, actionable: overdue };
}

router.get("/equipment-returns/summary", requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    return res.json(await returnSummary());
  } catch (error) {
    console.error("[equipment-returns] summary failed:", error);
    return res.status(500).json({ error: "Failed to load equipment return summary" });
  }
});

router.get("/equipment-returns", requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const now = new Date();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 25));
    const state = ["open", "overdue", "due_today"].includes(req.query.state) ? req.query.state : "open";
    const clauses = [activeFilter()];
    if (state === "overdue") clauses.push(overdueClause(now));
    if (state === "due_today") clauses.push(dueTodayClause(now));

    const search = escapeRegex(req.query.search, 80);
    if (search) {
      const regex = new RegExp(search, "i");
      const technicians = await Technician.find({ $or: [{ name: regex }, { phone: regex }, { userEmail: regex }] })
        .select("_id").limit(100).lean();
      clauses.push({
        $or: [
          { equipmentName: regex },
          { equipmentCode: regex },
          { bookingReference: regex },
          { technicianId: { $in: technicians.map((technician) => technician._id) } },
        ],
      });
    }

    const filter = clauses.length === 1 ? clauses[0] : { $and: clauses };
    if (req.query.idsOnly === "true") {
      const [matches, total] = await Promise.all([
        EquipmentAssignment.find(filter)
          .select("_id")
          .sort({ expectedReturnAt: 1, workDate: 1, checkedOutAt: 1 })
          .limit(MAX_BULK_SELECTION)
          .lean(),
        EquipmentAssignment.countDocuments(filter),
      ]);
      return res.json({
        ids: matches.map((item) => String(item._id)),
        total,
        selectionLimit: MAX_BULK_SELECTION,
        truncated: total > MAX_BULK_SELECTION,
      });
    }

    const [items, total, summary] = await Promise.all([
      EquipmentAssignment.find(filter)
        .populate("technicianId", "name phone userEmail")
        .populate("bookingId", "bookingReference customer service services status bookingDate startTime endTime")
        .populate("projectId", "customer service status isLargeScale bookingId")
        .populate("equipmentId", "itemName barcode assetCode quantity checkedOutQuantity assetStatus")
        .sort({ expectedReturnAt: 1, workDate: 1, checkedOutAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      EquipmentAssignment.countDocuments(filter),
      returnSummary(now),
    ]);

    const assignments = items.map((item) => {
      const returnState = equipmentReturnState(item, now);
      return { ...item, returnState: returnState.state, overdueMinutes: returnState.overdueMinutes, effectiveExpectedReturnAt: returnState.expectedReturnAt };
    });
    return res.json({ assignments, summary, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error("[equipment-returns] list failed:", error);
    return res.status(500).json({ error: "Failed to load equipment returns" });
  }
});

router.post("/equipment-returns/:id/remind", requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid equipment assignment id" });
    const assignment = await EquipmentAssignment.findOne({ _id: req.params.id, consumable: { $ne: true }, status: { $in: ACTIVE_STATUSES } })
      .populate("technicianId", "name");
    if (!assignment) return res.status(404).json({ error: "Outstanding equipment assignment not found" });
    if (!assignment.technicianId) return res.status(409).json({ error: "The assigned technician record is no longer available" });
    const now = new Date();
    if (assignment.lastReminderAt && now - assignment.lastReminderAt < REMINDER_COOLDOWN_MS) {
      return res.status(429).json({ error: "A reminder was sent recently", nextReminderAt: new Date(assignment.lastReminderAt.getTime() + REMINDER_COOLDOWN_MS) });
    }
    const state = equipmentReturnState(assignment, now);
    const technicianName = assignment.technicianId?.name || "Technician";
    const notification = await createNotification({
      type: "equipment_return_reminder",
      title: state.overdue ? "Equipment Return Overdue" : "Equipment Return Reminder",
      message: `${assignment.equipmentName} (${assignment.quantity || 1}) for ${assignment.bookingReference || "assigned job"} must be returned to inventory.`,
      userId: assignment.technicianId?._id || assignment.technicianId,
      role: "technician",
      referenceId: assignment._id,
      referenceModel: "EquipmentAssignment",
      link: "/technician/assignments",
      priority: state.overdue ? "urgent" : "high",
      io: req.app.get("io") || global.io,
    });
    if (!notification) return res.status(503).json({ error: "Reminder could not be delivered" });
    assignment.lastReminderAt = now;
    assignment.reminderCount = (assignment.reminderCount || 0) + 1;
    assignment.reminderHistory.push({ sentAt: now, sentBy: req.user?._id });
    await assignment.save();
    await audit.logEvent({ actor: req.user?._id, target: assignment._id, action: "inventory.equipment_return.reminder", module: "inventory", req, details: { referenceModel: "EquipmentAssignment", technicianName, equipmentName: assignment.equipmentName } });
    return res.json({ success: true, message: `Reminder sent to ${technicianName}`, lastReminderAt: now, reminderCount: assignment.reminderCount });
  } catch (error) {
    console.error("[equipment-returns] reminder failed:", error);
    return res.status(500).json({ error: "Failed to send return reminder" });
  }
});

router.post("/equipment-returns/:id/deadline", requireRole(["admin"]), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid equipment assignment id" });
    const expectedReturnAt = new Date(req.body.expectedReturnAt);
    if (Number.isNaN(expectedReturnAt.getTime()) || expectedReturnAt <= new Date()) return res.status(400).json({ error: "Expected return must be a valid future date and time" });
    const notes = String(req.body.notes || "").trim().slice(0, 500);
    if (!notes) return res.status(400).json({ error: "Enter a reason for changing the deadline" });
    const assignment = await EquipmentAssignment.findOneAndUpdate(
      { _id: req.params.id, consumable: { $ne: true }, status: { $in: ACTIVE_STATUSES } },
      { $set: { expectedReturnAt, resolutionNotes: notes, overdueAdminNotifiedAt: null } },
      { returnDocument: "after", runValidators: true },
    );
    if (!assignment) return res.status(404).json({ error: "Outstanding equipment assignment not found" });
    await audit.logEvent({ actor: req.user?._id, target: assignment._id, action: "inventory.equipment_return.deadline_update", module: "inventory", req, details: { referenceModel: "EquipmentAssignment", expectedReturnAt, reason: notes } });
    return res.json({ success: true, expectedReturnAt });
  } catch (error) {
    console.error("[equipment-returns] deadline update failed:", error);
    return res.status(500).json({ error: "Failed to update expected return" });
  }
});

router.post("/equipment-returns/:id/resolve", requireRole(["admin"]), async (req, res) => {
  const token = crypto.randomUUID();
  let locked = null;
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid equipment assignment id" });
    const condition = String(req.body.condition || "").toLowerCase();
    if (!["good", "fair", "damaged", "lost"].includes(condition)) return res.status(400).json({ error: "Select a valid return condition" });
    const notes = String(req.body.notes || "").trim().slice(0, 500);
    if (["damaged", "lost"].includes(condition) && !notes) return res.status(400).json({ error: "Notes are required for damaged or lost equipment" });

    locked = await EquipmentAssignment.findOneAndUpdate(
      { _id: req.params.id, consumable: { $ne: true }, status: { $in: ACTIVE_STATUSES }, $or: [{ resolutionState: "open" }, { resolutionState: { $exists: false } }, { resolutionState: null }] },
      { $set: { resolutionState: "processing", resolutionStartedAt: new Date(), resolutionToken: token } },
      { returnDocument: "after" },
    ).select("+resolutionToken");
    if (!locked) return res.status(409).json({ error: "This equipment was already resolved or is being processed" });

    const quantity = Math.max(1, Number(locked.quantity) || 1);
    if (condition === "good" || condition === "fair") {
      const nextCheckedOut = { $max: [0, { $subtract: [{ $ifNull: ["$checkedOutQuantity", 0] }, quantity] }] };
      const nextQuantity = { $add: [{ $ifNull: ["$quantity", 0] }, quantity] };
      const inventoryResult = await Tool.updateOne({ _id: locked.equipmentId }, [{ $set: {
        quantity: nextQuantity,
        checkedOutQuantity: nextCheckedOut,
        assetCondition: condition,
        assetStatus: { $cond: [{ $gt: [nextCheckedOut, 0] }, "checked_out", "available"] },
        assignable: true,
        status: { $cond: [{ $lte: [nextQuantity, 0] }, "out_of_stock", { $cond: [{ $lte: [nextQuantity, { $ifNull: ["$minStockLevel", 0] }] }, "low_stock", "in_stock"] }] },
      } }], { updatePipeline: true });
      if (!inventoryResult.matchedCount) throw new Error("The linked inventory asset no longer exists");
    } else {
      const inventoryResult = await Tool.updateOne({ _id: locked.equipmentId }, [{ $set: {
        checkedOutQuantity: { $max: [0, { $subtract: [{ $ifNull: ["$checkedOutQuantity", 0] }, quantity] }] },
        assetCondition: "damaged",
        assetStatus: condition === "damaged" ? "damaged" : "retired",
        assignable: false,
      } }], { updatePipeline: true });
      if (!inventoryResult.matchedCount) throw new Error("The linked inventory asset no longer exists");
    }

    const returnedAt = new Date();
    const status = ["good", "fair"].includes(condition) ? "returned" : condition;
    const assignment = await EquipmentAssignment.findOneAndUpdate(
      { _id: locked._id, resolutionState: "processing", resolutionToken: token },
      { $set: { status, condition, damageDescription: ["damaged", "lost"].includes(condition) ? notes : locked.damageDescription, returnedAt, returnedTo: req.user?.name || String(req.user?._id || "Admin"), resolvedBy: req.user?._id, resolutionNotes: notes, resolutionState: "resolved" }, $unset: { resolutionToken: 1, resolutionStartedAt: 1 } },
      { returnDocument: "after" },
    );
    if (!assignment) throw new Error("Resolution lock was lost");

    const lifecycleUpdates = [];
    lifecycleUpdates.push(Notification.updateMany(
      { referenceModel: "EquipmentAssignment", referenceId: assignment._id, type: "equipment_return_overdue", read: false },
      { $set: { read: true, readAt: returnedAt } },
    ));
    if (assignment.dailyKitId) {
      lifecycleUpdates.push(DailyKit.updateOne(
        { _id: assignment.dailyKitId, "items.equipmentAssignmentId": assignment._id },
        { $set: { "items.$.checkoutStatus": ["good", "fair"].includes(condition) ? "returned" : "exception", "items.$.returnedAt": returnedAt } },
      ));
    }
    if (assignment.bookingId) {
      const remainingForJob = await EquipmentAssignment.countDocuments({
        bookingId: assignment.bookingId,
        technicianId: assignment.technicianId,
        consumable: { $ne: true },
        status: { $in: ACTIVE_STATUSES },
      });
      if (remainingForJob === 0) {
        lifecycleUpdates.push(Assignment.updateMany(
          { bookingId: assignment.bookingId, technicianId: assignment.technicianId },
          { $set: { equipmentReturned: true, equipmentReturnedAt: returnedAt } },
        ));
      }
    }

    await Promise.all([
      ...lifecycleUpdates,
      audit.logEvent({ actor: req.user?._id, target: assignment._id, action: `inventory.equipment_return.${status}`, module: "inventory", req, details: { referenceModel: "EquipmentAssignment", equipmentName: assignment.equipmentName, quantity, condition, notes } }),
      createNotification({ type: "equipment_return_resolved", title: condition === "lost" ? "Equipment Marked Lost" : "Equipment Return Recorded", message: `${assignment.equipmentName} was recorded as ${condition} by inventory administration.`, userId: assignment.technicianId, role: "technician", referenceId: assignment._id, referenceModel: "EquipmentAssignment", link: "/technician/assignments", priority: ["damaged", "lost"].includes(condition) ? "high" : "normal", io: req.app.get("io") || global.io }),
    ]);
    return res.json({ success: true, message: "Equipment return recorded", assignment });
  } catch (error) {
    if (locked) await EquipmentAssignment.updateOne({ _id: locked._id, resolutionState: "processing", resolutionToken: token }, { $set: { resolutionState: "open" }, $unset: { resolutionToken: 1, resolutionStartedAt: 1 } }).catch(() => {});
    console.error("[equipment-returns] resolution failed:", error);
    return res.status(500).json({ error: "Failed to record equipment return" });
  }
});

module.exports = router;
module.exports.returnSummary = returnSummary;
module.exports.overdueClause = overdueClause;

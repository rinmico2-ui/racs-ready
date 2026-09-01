const EquipmentAssignment = require("../models/EquipmentAssignment");
const { createNotification } = require("./notify");

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function overdueFilter(now = new Date()) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return {
    consumable: { $ne: true },
    status: { $in: ["checked_out", "in_use"] },
    overdueAdminNotifiedAt: null,
    $or: [
      { expectedReturnAt: { $lt: now } },
      { expectedReturnAt: null, workDate: { $lt: startOfToday } },
    ],
  };
}

async function checkOverdueEquipmentReturns(now = new Date()) {
  const candidates = await EquipmentAssignment.find(overdueFilter(now))
    .select("_id equipmentName quantity technicianId bookingReference")
    .populate("technicianId", "name")
    .limit(200)
    .lean();
  let notified = 0;
  for (const candidate of candidates) {
    const claimed = await EquipmentAssignment.findOneAndUpdate(
      { _id: candidate._id, overdueAdminNotifiedAt: null, status: { $in: ["checked_out", "in_use"] } },
      { $set: { overdueAdminNotifiedAt: now } },
      { returnDocument: "after" },
    );
    if (!claimed) continue;
    const technicianName = candidate.technicianId?.name || "an assigned technician";
    const notification = await createNotification({
      type: "equipment_return_overdue",
      title: "Equipment Return Overdue",
      message: `${candidate.equipmentName} (${candidate.quantity || 1}) assigned to ${technicianName} for ${candidate.bookingReference || "a service job"} has not been returned.`,
      role: "admin",
      referenceId: candidate._id,
      referenceModel: "EquipmentAssignment",
      link: "/admin/inventory/equipment-returns?state=overdue",
      priority: "urgent",
      io: global.io,
    });
    if (!notification) {
      await EquipmentAssignment.updateOne({ _id: candidate._id, overdueAdminNotifiedAt: now }, { $unset: { overdueAdminNotifiedAt: 1 } });
      continue;
    }
    notified += 1;
  }
  return notified;
}

function startEquipmentReturnScheduler() {
  console.log("[equipment-return-monitor] Starting overdue equipment monitor (every hour)");
  setTimeout(() => checkOverdueEquipmentReturns().catch((error) => {
    console.error("[equipment-return-monitor] Initial check failed:", error.message);
  }), 60 * 1000);
  setInterval(() => checkOverdueEquipmentReturns().catch((error) => {
    console.error("[equipment-return-monitor] Check failed:", error.message);
  }), CHECK_INTERVAL_MS);
}

module.exports = { overdueFilter, checkOverdueEquipmentReturns, startEquipmentReturnScheduler };

const { DATA_RETENTION_POLICY } = require("../utils/dataLifecycle");

function record(id, type, label, secondary, state, at, reason, restoreUrl = null) {
  return {
    id: String(id),
    type,
    label: label || "Untitled record",
    secondary: secondary || "",
    state,
    at: at || null,
    reason: reason || "Legacy record — no lifecycle reason was captured",
    restorable: Boolean(restoreUrl),
    restoreUrl,
  };
}

exports.listArchive = async (_req, res, next) => {
  try {
    const User = require("../models/User");
    const Technician = require("../models/Technician");
    const HVACProduct = require("../models/HVACProduct");
    const Inventory = require("../models/Inventory");
    const Tool = require("../models/Tool");
    const ServiceCategory = require("../models/ServiceCategory");
    const NonWorkingDay = require("../models/NonWorkingDay");
    const ServiceToolUsage = require("../models/ServiceToolUsage");
    const ProjectMaterial = require("../models/ProjectMaterial");
    const EquipmentAssignment = require("../models/EquipmentAssignment");
    const BookingService = require("../models/BookingService");
    const Rating = require("../models/Rating");

    const safe = (promise) => promise.catch(() => []);
    const [staff, legacyTechnicians, hvac, inventory, tools, categories, dayoffs, usages, materials, equipment, bookings, ratings] = await Promise.all([
      safe(User.find({ role: { $in: ["secretary", "technician"] }, $or: [{ active: false }, { archivedAt: { $ne: null } }] }).select("firstName lastName email archivedAt archiveReason updatedAt").sort({ archivedAt: -1, updatedAt: -1 }).limit(100).lean()),
      safe(Technician.find({ $and: [{ $or: [{ active: false }, { archivedAt: { $ne: null } }] }, { $or: [{ user: null }, { user: { $exists: false } }] }] }).select("name userEmail archivedAt archiveReason updatedAt").sort({ archivedAt: -1, updatedAt: -1 }).limit(100).lean()),
      safe(HVACProduct.find({ active: false }).select("modelLine archivedAt archiveReason updatedAt").sort({ archivedAt: -1, updatedAt: -1 }).limit(100).lean()),
      safe(Inventory.find({ active: false }).select("modelLine capacity capacityUnit archivedAt archiveReason updatedAt").sort({ archivedAt: -1, updatedAt: -1 }).limit(100).lean()),
      safe(Tool.find({ active: false }).select("itemName category archivedAt archiveReason updatedAt").sort({ archivedAt: -1, updatedAt: -1 }).limit(100).lean()),
      safe(ServiceCategory.find({ active: false }).select("name slug archivedAt archiveReason updatedAt").sort({ archivedAt: -1, updatedAt: -1 }).limit(100).lean()),
      safe(NonWorkingDay.find({ active: false }).select("date note reason archivedAt archiveReason").sort({ archivedAt: -1, date: -1 }).limit(100).lean()),
      safe(ServiceToolUsage.find({ lifecycleStatus: "voided" }).select("itemName quantityUsed unit bookingId voidedAt voidReason inventoryRestored").sort({ voidedAt: -1 }).limit(100).lean()),
      safe(ProjectMaterial.find({ status: "cancelled" }).select("itemName quantity unit projectId cancelledAt cancellationReason").sort({ cancelledAt: -1 }).limit(100).lean()),
      safe(EquipmentAssignment.find({ status: "released" }).select("equipmentName quantity bookingId projectId releasedAt releaseReason").sort({ releasedAt: -1 }).limit(100).lean()),
      safe(BookingService.find({ status: "cancelled" }).select("bookingReference service.name customer.name cancelledAt cancellationReason updatedAt").sort({ cancelledAt: -1, updatedAt: -1 }).limit(100).lean()),
      safe(Rating.find({ moderationStatus: { $in: ["hidden", "flagged"] } }).select("comment targetType targetId moderationStatus moderatedAt moderationReason").sort({ moderatedAt: -1 }).limit(100).lean()),
    ]);

    const groups = [
      {
        key: "staff",
        label: "Archived staff",
        records: [
          ...staff.map((x) => record(x._id, "Staff", [x.firstName, x.lastName].filter(Boolean).join(" ") || x.email, x.email, x.archivedAt ? "archived" : "legacy inactive", x.archivedAt || x.updatedAt, x.archiveReason, `/api/admin/staff/${x._id}/restore`)),
          ...legacyTechnicians.map((x) => record(x._id, "Legacy technician", x.name, x.userEmail, x.archivedAt ? "archived" : "legacy inactive", x.archivedAt || x.updatedAt, x.archiveReason, `/api/admin/staff/${x._id}/restore`)),
        ],
      },
      { key: "catalogue", label: "Archived catalogue", records: [
        ...hvac.map((x) => record(x._id, "HVAC product", x.modelLine, "Aircon catalogue", "archived", x.archivedAt || x.updatedAt, x.archiveReason, `/api/admin/hvac/${x._id}/restore`)),
        ...inventory.map((x) => record(x._id, "Inventory product", x.modelLine, `${x.capacity || ""} ${x.capacityUnit || ""}`.trim(), "archived", x.archivedAt || x.updatedAt, x.archiveReason, `/api/admin/inventory/${x._id}/restore`)),
        ...tools.map((x) => record(x._id, "Tool or material", x.itemName, x.category, "archived", x.archivedAt || x.updatedAt, x.archiveReason, `/api/admin/tools/${x._id}/restore`)),
        ...categories.map((x) => record(x._id, "Service category", x.name, x.slug, "archived", x.archivedAt || x.updatedAt, x.archiveReason, `/api/admin/service-categories/${x._id}/restore`)),
      ] },
      { key: "scheduling", label: "Scheduling history", records: [
        ...dayoffs.map((x) => record(x._id, "Non-working day", x.note || x.reason || "Non-working day", x.date ? new Date(x.date).toLocaleDateString("en-PH") : "", "archived", x.archivedAt, x.archiveReason, `/api/admin/dayoffs/${x._id}/restore`)),
        ...equipment.map((x) => record(x._id, "Equipment reservation", x.equipmentName, x.bookingId ? `Booking ${x.bookingId}` : `Project ${x.projectId || ""}`, "released", x.releasedAt, x.releaseReason)),
      ] },
      { key: "operations", label: "Retained operational history", records: [
        ...bookings.map((x) => record(x._id, "Booking", x.bookingReference, x.service?.name || x.customer?.name, "cancelled", x.cancelledAt || x.updatedAt, x.cancellationReason)),
        ...materials.map((x) => record(x._id, "Project material", x.itemName, `${x.quantity || 0} ${x.unit || ""}`.trim(), "cancelled", x.cancelledAt, x.cancellationReason)),
        ...usages.map((x) => record(x._id, "Tool usage", x.itemName, `${x.quantityUsed || 0} ${x.unit || ""}${x.inventoryRestored ? " · stock restored" : ""}`, "voided", x.voidedAt, x.voidReason)),
      ] },
      { key: "moderation", label: "Moderated reviews", records: ratings.map((x) => record(x._id, "Customer review", String(x.comment || "No written comment").slice(0, 100), x.targetType, x.moderationStatus, x.moderatedAt, x.moderationReason)) },
    ];

    groups.forEach((group) => { group.count = group.records.length; });
    res.json({ policy: DATA_RETENTION_POLICY, total: groups.reduce((sum, group) => sum + group.count, 0), groups });
  } catch (error) {
    next(error);
  }
};

const mongoose = require("mongoose");
const CustomerAsset = require("../models/CustomerAsset");
const MaintenanceSchedule = require("../models/MaintenanceSchedule");
const { getAftercarePolicy } = require("./aftercarePolicy");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_DAYS = 90;

function clampIntervalDays(value, fallback = DEFAULT_INTERVAL_DAYS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(730, Math.max(30, Math.round(parsed)));
}

function addDays(date, days) {
  return new Date(new Date(date).getTime() + clampIntervalDays(days) * DAY_MS);
}

function effectiveScheduleStatus(schedule, now = new Date()) {
  const current = String(schedule?.status || "upcoming");
  if (["scheduled", "completed", "paused", "cancelled"].includes(current)) return current;
  const due = new Date(schedule?.dueDate);
  if (Number.isNaN(due.getTime())) return current;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(due);
  dueDay.setHours(0, 0, 0, 0);
  if (dueDay < today) return "overdue";
  if (dueDay.getTime() === today.getTime()) return "due";
  return "upcoming";
}

function customerIdOf(record) {
  return record?.customerId?._id || record?.customerId || record?.customer?._id || null;
}

function bookingAssetSeeds(booking) {
  const customerId = customerIdOf(booking);
  if (!customerId) return [];
  const serviceItems = Array.isArray(booking.services) && booking.services.length
    ? booking.services
    : [{
        _id: booking.serviceId || "primary",
        name: booking.service?.name,
        quantity: booking.quantity || 1,
        brand: booking.brand,
        model: booking.unitInfo?.model,
        applianceType: booking.applianceType || booking.unitInfo?.unitType,
        applianceTypeName: booking.applianceTypeName || booking.unitInfo?.unitType,
        hp: booking.hp || booking.unitInfo?.hp,
        hpDescription: booking.hpDescription || booking.unitInfo?.hpDescription,
      }];
  const seeds = [];
  serviceItems.forEach((item, itemIndex) => {
    const quantity = Math.max(1, Math.min(40, Number(item.quantity) || 1));
    for (let unitIndex = 1; unitIndex <= quantity; unitIndex += 1) {
      const itemKey = `service-${String(item._id || item.serviceId || itemIndex)}-unit-${unitIndex}`;
      seeds.push({
        customerId,
        assetKey: `booking:${booking._id}:${itemKey}`,
        originType: "booking",
        originId: booking._id,
        originReference: booking.bookingReference || "",
        originItemKey: itemKey,
        equipment: {
          category: item.name || booking.service?.name || "Air Conditioning",
          applianceType: item.applianceType || item.airconType || booking.applianceType || "",
          applianceTypeName: item.applianceTypeName || item.airconTypeName || booking.applianceTypeName || "",
          brand: item.brand || booking.brand || booking.unitInfo?.brand || "",
          model: item.model || booking.unitInfo?.model || "",
          capacity: String(item.hp || booking.hp || booking.unitInfo?.hp || ""),
          capacityUnit: "HP",
          unitLabel: item.units?.[unitIndex - 1]?.label || `Unit ${unitIndex}`,
        },
        serviceAddress: booking.location?.address || booking.customer?.address || "",
      });
    }
  });
  return seeds;
}

function orderAssetSeeds(order) {
  const customerId = customerIdOf(order) || order?.userId?._id || order?.userId;
  if (!customerId) return [];
  const seeds = [];
  (order.items || []).forEach((item, itemIndex) => {
    const maintainable = item.isHvac !== false || Boolean(item.parentHvacId) || Boolean(item.capacity);
    if (!maintainable) return;
    const quantity = Math.max(1, Math.min(40, Number(item.quantity) || 1));
    for (let unitIndex = 1; unitIndex <= quantity; unitIndex += 1) {
      const itemKey = `item-${String(item.inventoryId || itemIndex)}-unit-${unitIndex}`;
      seeds.push({
        customerId,
        assetKey: `order:${order._id}:${itemKey}`,
        originType: "order",
        originId: order._id,
        originReference: order.orderReference || "",
        originItemKey: itemKey,
        equipment: {
          category: "Air Conditioning",
          applianceType: "air_conditioner",
          applianceTypeName: "Air Conditioner",
          brand: item.brand || "",
          model: item.modelLine || "",
          capacity: String(item.capacity || ""),
          capacityUnit: item.capacityUnit || "HP",
          serialNumber: String(item.serialNumbers?.[unitIndex - 1] || "").trim(),
          unitLabel: `Unit ${unitIndex}`,
        },
        serviceAddress: order.delivery?.address || "",
      });
    }
  });
  return seeds;
}

async function ensureSchedule(asset, { baseDate, intervalDays, sourceType, sourceId, recommendation } = {}) {
  if (!baseDate || asset.status !== "active") return null;
  const interval = clampIntervalDays(intervalDays || asset.maintenanceIntervalDays);
  const sourceKey = sourceId ? String(sourceId) : new Date(baseDate).toISOString().slice(0, 10);
  const cycleKey = `${asset._id}:${sourceType}:${sourceKey}`;
  const existing = await MaintenanceSchedule.findOne({ cycleKey });
  if (existing) {
    if (String(asset.latestScheduleId || "") !== String(existing._id)) {
      await CustomerAsset.updateOne({ _id: asset._id }, { $set: { latestScheduleId: existing._id } });
    }
    return existing;
  }
  const lastCycle = await MaintenanceSchedule.findOne({ assetId: asset._id }).sort({ cycleNumber: -1 }).select("cycleNumber").lean();
  try {
    const schedule = await MaintenanceSchedule.create({
      assetId: asset._id,
      customerId: asset.customerId,
      cycleKey,
      cycleNumber: Number(lastCycle?.cycleNumber || 0) + 1,
      intervalDays: interval,
      dueDate: addDays(baseDate, interval),
      status: "upcoming",
      sourceCompletionType: sourceType,
      sourceCompletionId: mongoose.isValidObjectId(sourceId) ? sourceId : null,
      recommendation: recommendation || {},
      history: [{ status: "upcoming", reason: "Maintenance cycle created" }],
    });
    await CustomerAsset.findByIdAndUpdate(asset._id, {
      latestScheduleId: schedule._id,
      maintenanceIntervalDays: interval,
    });
    return schedule;
  } catch (error) {
    if (error?.code === 11000) return MaintenanceSchedule.findOne({ cycleKey });
    throw error;
  }
}

async function upsertAsset(seed, values) {
  return CustomerAsset.findOneAndUpdate(
    { assetKey: seed.assetKey },
    {
      $set: {
        equipment: seed.equipment,
        serviceAddress: seed.serviceAddress,
      },
      $setOnInsert: {
        customerId: seed.customerId,
        assetKey: seed.assetKey,
        originType: seed.originType,
        originId: seed.originId,
        originReference: seed.originReference,
        originItemKey: seed.originItemKey,
        lastServiceDate: values.lastServiceDate || null,
        installationDate: values.installationDate || null,
        maintenanceIntervalDays: values.intervalDays,
        status: values.status,
      },
    },
    { returnDocument: "after", upsert: true, runValidators: true },
  );
}

async function syncMaintenanceFromBooking(booking, options = {}) {
  if (!booking || !["completed", "repair_completed"].includes(String(booking.status))) return [];
  const policy = options.policy || await getAftercarePolicy();
  const maintenanceRule = policy.maintenance;
  const completedAt = booking.completedAt || booking.repairCompletion?.completedAt || new Date();
  const recommendedInterval = maintenanceRule.allowTechnicianRecommendation
    ? options.intervalDays
    : null;
  const intervalDays = clampIntervalDays(recommendedInterval || maintenanceRule.bookingIntervalDays);
  const recommendation = {
    notes: String(options.notes || booking.maintenance?.nextRecommendationNotes || "").slice(0, 1000),
    recommendedBy: options.recommendedBy || null,
    recommendedByName: String(options.recommendedByName || "").slice(0, 200),
  };

  if (booking.maintenance?.assetId && booking.maintenance?.scheduleId) {
    const schedule = await MaintenanceSchedule.findOneAndUpdate(
      { _id: booking.maintenance.scheduleId, bookingId: booking._id, status: { $ne: "completed" } },
      {
        $set: { status: "completed", completedAt, completedByBookingId: booking._id },
        $push: { history: { status: "completed", reason: "Maintenance booking completed" } },
      },
      { returnDocument: "after" },
    );
    const asset = await CustomerAsset.findByIdAndUpdate(
      booking.maintenance.assetId,
      { lastServiceDate: completedAt, maintenanceIntervalDays: intervalDays, status: "active" },
      { returnDocument: "after" },
    );
    if (asset && maintenanceRule.bookingsEnabled) {
      await ensureSchedule(asset, { baseDate: completedAt, intervalDays, sourceType: "booking", sourceId: booking._id, recommendation });
    }
    return asset ? [asset] : [];
  }

  if (!maintenanceRule.bookingsEnabled) return [];

  const assets = [];
  for (const seed of bookingAssetSeeds(booking)) {
    const asset = await upsertAsset(seed, {
      lastServiceDate: completedAt,
      installationDate: null,
      intervalDays,
      status: "active",
    });
    await ensureSchedule(asset, { baseDate: completedAt, intervalDays, sourceType: "booking", sourceId: booking._id, recommendation });
    assets.push(asset);
  }
  return assets;
}

async function syncMaintenanceFromOrder(order, options = {}) {
  if (!order || String(order.status) !== "completed") return [];
  const policy = options.policy || await getAftercarePolicy();
  if (!policy.maintenance.ordersEnabled) return [];
  const installed = order.fulfillmentType === "delivery_installation";
  const completedAt = order.completedAt || new Date();
  const intervalDays = clampIntervalDays(options.intervalDays || policy.maintenance.orderIntervalDays);
  const assets = [];
  for (const seed of orderAssetSeeds(order)) {
    const asset = await upsertAsset(seed, {
      lastServiceDate: installed ? completedAt : null,
      installationDate: installed ? completedAt : null,
      intervalDays,
      status: installed ? "active" : "installation_date_required",
    });
    if (installed) await ensureSchedule(asset, { baseDate: completedAt, intervalDays, sourceType: "order", sourceId: order._id });
    assets.push(asset);
  }
  return assets;
}

async function linkScheduleToBooking({ scheduleId, bookingId, customerId, session = null }) {
  const schedule = await MaintenanceSchedule.findOneAndUpdate(
    {
      _id: scheduleId,
      customerId,
      status: { $in: ["upcoming", "due", "overdue"] },
      bookingId: null,
    },
    {
      $set: { bookingId, status: "scheduled" },
      $push: { history: { status: "scheduled", changedBy: customerId, changedByName: "Customer", reason: "Customer created maintenance booking" } },
    },
    { returnDocument: "after", ...(session ? { session } : {}) },
  ).populate("assetId");
  if (!schedule) {
    const error = new Error("This maintenance cycle is already booked or no longer available.");
    error.status = 409;
    throw error;
  }
  return schedule;
}

module.exports = {
  DEFAULT_INTERVAL_DAYS,
  clampIntervalDays,
  addDays,
  effectiveScheduleStatus,
  bookingAssetSeeds,
  orderAssetSeeds,
  ensureSchedule,
  syncMaintenanceFromBooking,
  syncMaintenanceFromOrder,
  linkScheduleToBooking,
};

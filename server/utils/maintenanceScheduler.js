const MaintenanceSchedule = require("../models/MaintenanceSchedule");
const BookingService = require("../models/BookingService");
const CustomerAsset = require("../models/CustomerAsset");
const Order = require("../models/Order");
const { createNotification } = require("./notify");
const { sendEmail } = require("./mailer");
const {
  effectiveScheduleStatus,
  syncMaintenanceFromBooking,
  syncMaintenanceFromOrder,
} = require("./maintenanceLifecycle");
const { DEFAULT_AFTERCARE_POLICY, getAftercarePolicy } = require("./aftercarePolicy");

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function safeEmailText(value) {
  return String(value || "").replace(/[<>\r\n]/g, " ").replace(/&/g, "and").trim();
}

function reminderFor(schedule, now = new Date(), config = DEFAULT_AFTERCARE_POLICY.reminders) {
  if (!config.enabled) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const due = new Date(schedule.dueDate);
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due - today) / DAY_MS);
  if (days < 0 && config.overdueEnabled && !schedule.reminders?.overdueAt) return { field: "overdueAt", type: "maintenance_overdue", label: "overdue", priority: "high" };
  if (days === 0 && config.dueDateEnabled && !schedule.reminders?.dueAt) return { field: "dueAt", type: "maintenance_due", label: "due today", priority: "high" };
  if (days > 0 && days <= config.finalReminderDays && !schedule.reminders?.sevenDayAt) return { field: "sevenDayAt", type: "maintenance_due_soon", label: `due in ${days} day(s)`, priority: "normal" };
  if (days > config.finalReminderDays && days <= config.firstReminderDays && !schedule.reminders?.thirtyDayAt) return { field: "thirtyDayAt", type: "maintenance_due_soon", label: `due in ${days} day(s)`, priority: "normal" };
  return null;
}

async function checkMaintenanceReminders(now = new Date()) {
  await reconcileMissingAftercare(now);
  await reconcileMaintenanceBookings(now);
  let sent = await checkCustomerResponseReminders(now);
  const policy = await getAftercarePolicy();
  if (!policy.reminders.enabled) return sent;
  const schedules = await MaintenanceSchedule.find({
    status: { $in: ["upcoming", "due", "overdue"] },
    dueDate: { $lte: new Date(now.getTime() + policy.reminders.firstReminderDays * DAY_MS) },
  })
    .populate("assetId", "equipment originReference")
    .populate("customerId", "firstName lastName name email");

  for (const schedule of schedules) {
    const effective = effectiveScheduleStatus(schedule, now);
    const reminder = reminderFor(schedule, now, policy.reminders);
    if (!reminder) {
      if (schedule.status !== effective) await MaintenanceSchedule.updateOne({ _id: schedule._id }, { $set: { status: effective } });
      continue;
    }
    const fieldPath = `reminders.${reminder.field}`;
    const claimed = await MaintenanceSchedule.findOneAndUpdate(
      { _id: schedule._id, status: { $in: ["upcoming", "due", "overdue"] }, [fieldPath]: null },
      { $set: { [fieldPath]: now, status: effective } },
      { returnDocument: "after" },
    );
    if (!claimed) continue;

    const equipment = schedule.assetId?.equipment || {};
    const unit = [equipment.brand, equipment.model, equipment.capacity ? `${equipment.capacity} ${equipment.capacityUnit || "HP"}` : ""].filter(Boolean).join(" ") || "air-conditioning unit";
    const customerId = schedule.customerId?._id || schedule.customerId;
    const customerNotification = await createNotification({
      type: reminder.type,
      title: reminder.type === "maintenance_overdue" ? "Maintenance Overdue" : "Maintenance Reminder",
      message: `${unit} is ${reminder.label}. Review the recommended maintenance schedule.`,
      userId: customerId,
      referenceId: schedule._id,
      referenceModel: "MaintenanceSchedule",
      link: "/aftercare",
      priority: reminder.priority,
      io: global.io,
    });
    if (!customerNotification) {
      await MaintenanceSchedule.updateOne({ _id: schedule._id, [fieldPath]: now }, { $set: { [fieldPath]: null } });
      continue;
    }
    await MaintenanceSchedule.updateOne(
      { _id: schedule._id, [fieldPath]: now },
      { $push: { history: { status: effective, changedByName: "Maintenance Monitor", reason: `Reminder sent: ${reminder.label}` } } },
    );
    if (schedule.customerId?.email) {
      const customerName = safeEmailText(schedule.customerId.name || [schedule.customerId.firstName, schedule.customerId.lastName].filter(Boolean).join(" ") || "Customer");
      const emailUnit = safeEmailText(unit);
      const baseUrl = String(process.env.APP_BASE_URL || process.env.APP_URL || "").replace(/\/$/, "");
      sendEmail(
        schedule.customerId.email,
        `Maintenance reminder - ${emailUnit}`,
        `Hi ${customerName},\nYour ${emailUnit} is ${reminder.label}.\nReview your aftercare schedule${baseUrl ? `: ${baseUrl}/aftercare` : " in your CALIDRO RACS account"}.`,
      ).catch((error) => console.warn("[maintenance-monitor] Customer reminder email failed:", error.message));
    }
    if (reminder.type === "maintenance_overdue" && policy.reminders.notifyAdminWhenOverdue) {
      await createNotification({
        type: "maintenance_overdue",
        title: "Customer Maintenance Overdue",
        message: `${unit} from ${schedule.assetId?.originReference || "a customer record"} is overdue for maintenance.`,
        role: "admin",
        referenceId: schedule._id,
        referenceModel: "MaintenanceSchedule",
        link: "/admin/maintenance?status=overdue",
        priority: "high",
        io: global.io,
      });
    }
    sent += 1;
  }
  return sent;
}

async function checkCustomerResponseReminders(now = new Date()) {
  const schedules = await MaintenanceSchedule.find({
    status: { $in: ["upcoming", "due", "overdue"] },
    "customerResponse.status": "remind_later",
    "customerResponse.remindAt": { $lte: now },
    "customerResponse.reminderSentAt": null,
  })
    .populate("assetId", "equipment")
    .populate("customerId", "firstName lastName name email");
  let sent = 0;
  for (const schedule of schedules) {
    const claimed = await MaintenanceSchedule.findOneAndUpdate(
      { _id: schedule._id, status: { $in: ["upcoming", "due", "overdue"] }, "customerResponse.status": "remind_later", "customerResponse.reminderSentAt": null },
      { $set: { "customerResponse.reminderSentAt": now } },
      { returnDocument: "after" },
    );
    if (!claimed) continue;
    const equipment = schedule.assetId?.equipment || {};
    const unit = [equipment.brand, equipment.model].filter(Boolean).join(" ") || equipment.applianceTypeName || "equipment";
    const customerId = schedule.customerId?._id || schedule.customerId;
    const notification = await createNotification({
      type: "maintenance_due_soon",
      title: "Your Aftercare Reminder",
      message: `You asked us to remind you about maintenance for ${unit}. You can book now or request a callback.`,
      userId: customerId,
      referenceId: schedule._id,
      referenceModel: "MaintenanceSchedule",
      link: "/aftercare",
      priority: "normal",
      io: global.io,
    });
    if (!notification) {
      await MaintenanceSchedule.updateOne({ _id: schedule._id, "customerResponse.reminderSentAt": now }, { $set: { "customerResponse.reminderSentAt": null } });
      continue;
    }
    if (schedule.customerId?.email) {
      const emailUnit = safeEmailText(unit);
      const baseUrl = String(process.env.APP_BASE_URL || process.env.APP_URL || "").replace(/\/$/, "");
      sendEmail(
        schedule.customerId.email,
        `Your requested aftercare reminder - ${emailUnit}`,
        `Your requested reminder for ${emailUnit} is ready.\nBook maintenance or request a callback${baseUrl ? `: ${baseUrl}/aftercare` : " from your CALIDRO RACS account"}.`,
      ).catch((error) => console.warn("[maintenance-monitor] Requested reminder email failed:", error.message));
    }
    sent += 1;
  }
  return sent;
}

async function reconcileMissingAftercare(now = new Date()) {
  const cutoff = new Date(now.getTime() - 30 * DAY_MS);
  const [bookings, orders] = await Promise.all([
    BookingService.find({
      status: { $in: ["completed", "repair_completed"] },
      customerId: { $ne: null },
      $or: [
        { completedAt: { $gte: cutoff } },
        { "repairCompletion.completedAt": { $gte: cutoff } },
        { updatedAt: { $gte: cutoff } },
      ],
    }).sort({ updatedAt: -1 }).limit(250),
    Order.find({
      status: "completed",
      userId: { $ne: null },
      $or: [{ completedAt: { $gte: cutoff } }, { updatedAt: { $gte: cutoff } }],
    }).sort({ updatedAt: -1 }).limit(250),
  ]);
  const [orderAssetIds, completedBookingScheduleIds] = await Promise.all([
    CustomerAsset.distinct("originId", { originType: "order", originId: { $in: orders.map((order) => order._id) } }),
    MaintenanceSchedule.distinct("sourceCompletionId", {
      sourceCompletionType: "booking",
      sourceCompletionId: { $in: bookings.map((booking) => booking._id) },
    }),
  ]);
  const orderAssets = new Set(orderAssetIds.map(String));
  const completedBookingSchedules = new Set(completedBookingScheduleIds.map(String));
  let recovered = 0;
  for (const booking of bookings) {
    if (completedBookingSchedules.has(String(booking._id))) continue;
    try {
      const assets = await syncMaintenanceFromBooking(booking);
      if (assets.length) recovered += 1;
    } catch (error) {
      console.error(`[maintenance-monitor] Failed to recover booking ${booking._id}:`, error.message);
    }
  }
  for (const order of orders) {
    if (orderAssets.has(String(order._id))) continue;
    try {
      const assets = await syncMaintenanceFromOrder(order);
      if (assets.length) recovered += 1;
    } catch (error) {
      console.error(`[maintenance-monitor] Failed to recover order ${order._id}:`, error.message);
    }
  }
  return recovered;
}

async function reconcileMaintenanceBookings(now = new Date()) {
  const schedules = await MaintenanceSchedule.find({ status: "scheduled", bookingId: { $ne: null } })
    .populate("bookingId");
  for (const schedule of schedules) {
    const booking = schedule.bookingId;
    if (booking && ["completed", "repair_completed"].includes(String(booking.status))) {
      await syncMaintenanceFromBooking(booking);
      continue;
    }
    if (!booking || ["cancelled", "repair_declined"].includes(String(booking.status))) {
      const status = effectiveScheduleStatus({ dueDate: schedule.dueDate, status: "upcoming" }, now);
      schedule.bookingId = null;
      schedule.status = status;
      schedule.history.push({ status, changedByName: "Maintenance Monitor", reason: "Linked booking was cancelled; maintenance cycle reopened" });
      await schedule.save();
    }
  }
}

function startMaintenanceScheduler() {
  console.log("[maintenance-monitor] Starting preventive-maintenance reminder monitor (every 6 hours)");
  setTimeout(() => checkMaintenanceReminders().catch((error) => {
    console.error("[maintenance-monitor] Initial check failed:", error.message);
  }), 45 * 1000);
  setInterval(() => checkMaintenanceReminders().catch((error) => {
    console.error("[maintenance-monitor] Check failed:", error.message);
  }), CHECK_INTERVAL_MS);
}

module.exports = {
  reminderFor,
  reconcileMaintenanceBookings,
  reconcileMissingAftercare,
  checkCustomerResponseReminders,
  checkMaintenanceReminders,
  startMaintenanceScheduler,
};

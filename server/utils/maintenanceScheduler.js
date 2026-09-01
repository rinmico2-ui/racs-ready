const MaintenanceSchedule = require("../models/MaintenanceSchedule");
const { createNotification } = require("./notify");
const { effectiveScheduleStatus, syncMaintenanceFromBooking } = require("./maintenanceLifecycle");
const { DEFAULT_AFTERCARE_POLICY, getAftercarePolicy } = require("./aftercarePolicy");

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  await reconcileMaintenanceBookings(now);
  const policy = await getAftercarePolicy();
  if (!policy.reminders.enabled) return 0;
  const schedules = await MaintenanceSchedule.find({
    status: { $in: ["upcoming", "due", "overdue"] },
    dueDate: { $lte: new Date(now.getTime() + policy.reminders.firstReminderDays * DAY_MS) },
  }).populate("assetId", "equipment originReference");

  let sent = 0;
  for (const schedule of schedules) {
    const effective = effectiveScheduleStatus(schedule, now);
    if (schedule.status !== effective) schedule.status = effective;
    const reminder = reminderFor(schedule, now, policy.reminders);
    if (!reminder) {
      if (schedule.isModified("status")) await schedule.save();
      continue;
    }
    schedule.reminders = schedule.reminders || {};
    schedule.reminders[reminder.field] = now;
    schedule.history.push({ status: effective, changedByName: "Maintenance Monitor", reason: `Reminder sent: ${reminder.label}` });
    await schedule.save();

    const equipment = schedule.assetId?.equipment || {};
    const unit = [equipment.brand, equipment.model, equipment.capacity ? `${equipment.capacity} ${equipment.capacityUnit || "HP"}` : ""].filter(Boolean).join(" ") || "air-conditioning unit";
    const customerNotification = await createNotification({
      type: reminder.type,
      title: reminder.type === "maintenance_overdue" ? "Maintenance Overdue" : "Maintenance Reminder",
      message: `${unit} is ${reminder.label}. Review the recommended maintenance schedule.`,
      userId: schedule.customerId,
      referenceId: schedule._id,
      referenceModel: "MaintenanceSchedule",
      link: "/maintenance",
      priority: reminder.priority,
      io: global.io,
    });
    if (!customerNotification) {
      schedule.reminders[reminder.field] = null;
      await schedule.save();
      continue;
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

module.exports = { reminderFor, reconcileMaintenanceBookings, checkMaintenanceReminders, startMaintenanceScheduler };

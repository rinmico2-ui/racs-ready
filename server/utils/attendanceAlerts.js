"use strict";

const { attendanceDay } = require("./attendanceTime");
const { loadStaffAttendanceRoster } = require("./staffAttendanceRoster");
const Notification = require("../models/Notification");
const INTERVAL_MS = 5 * 60 * 1000;
let started = false;
let running = false;

async function checkAttendanceAlerts({ now = new Date(), loadRoster = loadStaffAttendanceRoster, notificationModel = Notification, io = global._io } = {}) {
  const today = attendanceDay(now);
  const dates = [today.key, attendanceDay(new Date(today.start.getTime() - 1)).key];
  let inserted = 0;
  for (const date of dates) {
    const rows = await loadRoster({ date, now });
    for (const staff of rows) {
      if (!staff.issue) continue;
      const isCheckOut = staff.issue === "missing_checkout";
      const type = isCheckOut ? "attendance_missing_checkout" : "attendance_missing_checkin";
      const title = isCheckOut ? "Check-out not recorded" : "Check-in not recorded";
      const label = `${staff.name} (${staff.role})`;
      const recipients = [{ role: "admin", userId: null, link: `/admin/staff/attendance?date=${date}`, message: `${label} has not ${isCheckOut ? "checked out after the saved shift" : "checked in by the check-in cutoff"} for ${date}. Review the daily attendance list.` }];
      if (staff.userId) recipients.push({ role: null, userId: staff.userId, link: `/${staff.role}/attendance`, message: `Your ${isCheckOut ? "check-out" : "check-in"} for ${date} is not recorded. ${date === today.key ? (isCheckOut ? "Check out when your work is finished, or contact the admin if the record needs correction." : "Check in using the attendance page, or contact the admin if the record needs correction.") : "Contact the admin to review this earlier attendance record."}` });
      for (const recipient of recipients) {
        const attendanceAlertKey = `${date}:${staff.staffType}:${staff.staffId}:${staff.issue}:${recipient.role || recipient.userId}`;
        const data = { ...recipient, attendanceAlertKey, type, title, priority: "high", read: false };
        let result;
        try {
          result = await notificationModel.updateOne({ attendanceAlertKey }, { $setOnInsert: data }, { upsert: true });
        } catch (error) {
          if (error.code === 11000) continue;
          throw error;
        }
        if (!result.upsertedCount) continue;
        inserted++;
        try {
          if (io) io.to(recipient.userId ? `user:${recipient.userId}` : "admin-room").emit("notification:new", { _id: result.upsertedId, type, title, message: recipient.message, link: recipient.link, priority: "high", createdAt: now });
        } catch (_) { /* The saved notification remains available through polling. */ }
      }
    }
  }
  return inserted;
}

function startAttendanceAlerts() {
  if (started) return;
  started = true;
  let indexReady = false;
  async function cycle() {
    if (running) return;
    running = true;
    try {
      if (!indexReady) {
        await Notification.collection.createIndex({ attendanceAlertKey: 1 }, { name: "attendanceAlertKey_unique", unique: true, sparse: true });
        indexReady = true;
      }
      await checkAttendanceAlerts();
    } catch (error) {
      console.warn("[attendance] Could not check missing time records:", error.code || error.name);
    } finally { running = false; }
  }
  setTimeout(cycle, 15000).unref();
  setInterval(cycle, INTERVAL_MS).unref();
}

module.exports = { checkAttendanceAlerts, startAttendanceAlerts };

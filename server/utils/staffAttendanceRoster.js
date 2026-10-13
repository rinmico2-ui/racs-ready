"use strict";

const { attendanceDay } = require("./attendanceTime");
const MINUTE_MS = 60000;

function requestedAttendanceDay(value, now = new Date()) {
  if (!value) return attendanceDay(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw Object.assign(new Error("Choose a valid attendance date."), { status: 400 });
  let day;
  try { day = attendanceDay(new Date(`${value}T12:00:00+08:00`)); }
  catch (_) { throw Object.assign(new Error("Choose a valid attendance date."), { status: 400 }); }
  if (day.key !== value) throw Object.assign(new Error("Choose a valid attendance date."), { status: 400 });
  return day;
}

function staffDayState({ day, now, record, schedule, shift, leave, holiday }) {
  const weekday = new Date(`${day.key}T12:00:00+08:00`).getUTCDay();
  const working = schedule?.workingDays?.find(item => item.dayOfWeek === weekday);
  const rest = schedule?.restDates?.some(item => attendanceDay(item.date).key === day.key)
    || schedule?.nonWorkingWeekdays?.some(item => item.dayOfWeek === weekday);
  let start = working?.startMinutes ?? 480;
  let end = working?.endMinutes ?? 1080;
  const shiftMatch = String(shift || "").trim().match(/^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/);
  if (shiftMatch) { start = Number(shiftMatch[1]) * 60 + Number(shiftMatch[2]); end = Number(shiftMatch[3]) * 60 + Number(shiftMatch[4]); }
  const startsAt = new Date(day.start.getTime() + start * MINUTE_MS);
  const checkInDueAt = new Date(day.start.getTime() + Math.max(540, start) * MINUTE_MS);
  const checkOutDueAt = new Date(day.start.getTime() + (end <= start ? end + 1440 : end) * MINUTE_MS);
  const onLeave = !!leave || ["On Leave", "Sick Leave"].includes(record?.status);
  const scheduled = !rest && (schedule ? !!working : weekday !== 0);
  const expected = !onLeave && !holiday && scheduled;
  const checkedIn = !!record?.checkInTime;
  const checkedOut = !!record?.checkOutTime;
  const missingCheckIn = expected && !checkedIn && now >= checkInDueAt;
  // A worked rest day still needs a check-out. A reminder never ends the shift.
  const missingCheckOut = !onLeave && checkedIn && !checkedOut && now >= checkOutDueAt;
  let attendanceStatus = checkedOut ? "Checked Out" : record?.status || (missingCheckIn ? "Absent" : "Not checked in");
  if (onLeave) attendanceStatus = record?.status === "Sick Leave" || /sick/i.test(leave?.reason || "") ? "Sick Leave" : "On Leave";
  else if (!checkedIn && !expected) attendanceStatus = holiday ? "Holiday" : "Rest day";
  return {
    attendanceStatus, expected, missingCheckIn, missingCheckOut,
    checkInState: checkedIn ? "Checked in" : expected ? "Not checked in" : "Not required",
    checkOutState: checkedOut ? "Checked out" : checkedIn ? "Not checked out" : expected ? "Waiting for check-in" : "Not required",
    startsAt, checkInDueAt, checkOutDueAt,
    issue: missingCheckOut ? "missing_checkout" : missingCheckIn ? "missing_checkin" : null,
  };
}

function defaultModels() {
  return Object.fromEntries(["Technician", "User", "TechnicianAttendance", "SecretaryAttendance", "LeaveRequest", "TechnicianSchedule", "Secretary", "NonWorkingDay"].map(name => [name, require(`../models/${name}`)]));
}

function existedOnAttendanceDay(staff, day) {
  // Imported profiles can contain {} instead of a BSON date. Do not let a
  // database date comparison silently remove them from the daily roster.
  const value = staff.createdAt;
  let createdAt = value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!createdAt || !Number.isFinite(createdAt.getTime())) {
    const id = String(staff._id || "");
    createdAt = /^[a-f\d]{24}$/i.test(id) ? new Date(parseInt(id.slice(0, 8), 16) * 1000) : null;
  }
  return !createdAt || createdAt <= day.end;
}

async function loadStaffAttendanceRoster({ date, now = new Date(), models = defaultModels() } = {}) {
  const day = requestedAttendanceDay(date, now);
  const window = { $gte: day.start, $lte: day.end };
  const [technicians, secretaries, techRecords, secretaryRecords, leaves, schedules, secretaryProfiles, holidays] = await Promise.all([
    models.Technician.find({ active: { $ne: false }, archivedAt: null })
      .select("name userEmail email firstName lastName user availabilityStatus createdAt")
      .populate("user", "firstName lastName email active archivedAt role").lean(),
    models.User.find({ role: "secretary", active: { $ne: false }, archivedAt: null })
      .select("firstName lastName email createdAt").lean(),
    models.TechnicianAttendance.find({ date: window }).select("technicianId userId status checkInTime checkOutTime method updatedBy securityVersion checkInEvidence.distanceFromCompanyMeters checkInEvidence.accuracyMeters").lean(),
    models.SecretaryAttendance.find({ date: window }).select("userId status checkInTime checkOutTime method updatedBy qrChallengeId").lean(),
    models.LeaveRequest.find({ status: "approved", startDate: { $lte: day.end }, endDate: { $gte: day.start } }).select("technicianId reason").lean(),
    models.TechnicianSchedule.find({}).select("technicianId workingDays nonWorkingWeekdays restDates").lean(),
    models.Secretary.find({}).select("user shift").lean(),
    models.NonWorkingDay.find({ date: window, active: { $ne: false }, archivedAt: null, service: null }).select("date").lean(),
  ]);
  const index = (records, field) => new Map(records.map(record => [String(record[field]), record]));
  const techMap = index(techRecords, "technicianId"), secretaryMap = index(secretaryRecords, "userId");
  const leaveMap = index(leaves, "technicianId"), scheduleMap = index(schedules, "technicianId"), shiftMap = index(secretaryProfiles, "user");
  const today = attendanceDay(now).key;
  const rows = [];
  function add(staff, record, state) {
    const inAtWork = record?.checkInTime && !record.checkOutTime && ["Present", "Late"].includes(record.status) && !["On Leave", "Sick Leave"].includes(state.attendanceStatus);
    rows.push({
      ...staff, ...state, date: day.key, canEdit: day.key === today,
      availabilityStatus: staff.role !== "technician" || day.key !== today ? null : inAtWork ? (staff.availabilityStatus === "Offline" ? "Available" : staff.availabilityStatus) : "Offline",
      checkInTime: record?.checkInTime || null, checkOutTime: record?.checkOutTime || null,
      method: record?.method || null, updatedBy: record?.updatedBy || null,
      verificationLevel: !record ? null : record.method === "manual" ? "manual" : Number(record.securityVersion) >= 2 ? "layered" : record.qrChallengeId ? "signed" : "legacy",
      checkInDistanceMeters: record?.checkInEvidence?.distanceFromCompanyMeters ?? null,
      checkInAccuracyMeters: record?.checkInEvidence?.accuracyMeters ?? null,
    });
  }
  for (const tech of technicians) {
    if (!existedOnAttendanceDay(tech, day)) continue;
    if (tech.user?.active === false || tech.user?.archivedAt || tech.user?.role && tech.user.role !== "technician") continue;
    const record = techMap.get(String(tech._id));
    add({ staffId: tech._id, technicianId: tech._id, userId: tech.user?._id || null, staffType: "technician", role: "technician", name: tech.name || `${tech.user?.firstName || ""} ${tech.user?.lastName || ""}`.trim(), email: tech.userEmail || tech.email || tech.user?.email || "", availabilityStatus: tech.availabilityStatus }, record,
      staffDayState({ day, now, record, schedule: scheduleMap.get(String(tech._id)), leave: leaveMap.get(String(tech._id)), holiday: holidays.length > 0 }));
  }
  for (const secretary of secretaries) {
    if (!existedOnAttendanceDay(secretary, day)) continue;
    const record = secretaryMap.get(String(secretary._id));
    add({ staffId: secretary._id, technicianId: null, userId: secretary._id, staffType: "secretary", role: "secretary", name: `${secretary.firstName || ""} ${secretary.lastName || ""}`.trim(), email: secretary.email || "" }, record,
      staffDayState({ day, now, record, shift: shiftMap.get(String(secretary._id))?.shift, holiday: holidays.length > 0 }));
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { requestedAttendanceDay, staffDayState, existedOnAttendanceDay, loadStaffAttendanceRoster };

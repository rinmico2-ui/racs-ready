"use strict";
// Read-only comparison. No application startup, models, indexes or writes.
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const { attendanceDay } = require("../utils/attendanceTime");
const { staffDayState, existedOnAttendanceDay, loadStaffAttendanceRoster } = require("../utils/staffAttendanceRoster");
const { buildMongoConnectionUri, disableRetryableWritesForDirectConnection } = require("../utils/mongoConnection");

(async () => {
  const configured = buildMongoConnectionUri(process.env.MONGODB_URI, { directHosts: process.env.MONGODB_DIRECT_HOSTS, replicaSet: process.env.MONGODB_REPLICA_SET, authSource: process.env.MONGODB_AUTH_SOURCE });
  const connection = mongoose.createConnection(disableRetryableWritesForDirectConnection(configured.uri), { autoIndex: false, autoCreate: false, maxPoolSize: 2, minPoolSize: 0, serverSelectionTimeoutMS: 8000, retryWrites: false });
  try {
    await connection.asPromise();
    const day = process.argv[2] ? attendanceDay(new Date(`${process.argv[2]}T12:00:00+08:00`)) : attendanceDay(new Date());
    const exactFilter = { active: { $ne: false }, archivedAt: null, $or: [{ createdAt: { $lte: day.end } }, { createdAt: { $exists: false } }] };
    const exactMatches = await connection.db.collection("technicians").find(exactFilter, { projection: { name: 1 } }).toArray();
    const dateTypes = await connection.db.collection("technicians").aggregate([
      { $match: { active: true } },
      { $project: { name: 1, createdAt: 1, createdAtType: { $type: "$createdAt" } } },
    ]).toArray();
    const technicians = await connection.db.collection("technicians").find({ active: true }, { projection: { name: 1, user: 1, archivedAt: 1, createdAt: 1 } }).toArray();
    const ids = technicians.map(tech => tech.user).filter(Boolean);
    const users = ids.length ? await connection.db.collection("users").find({ _id: { $in: ids } }, { projection: { role: 1, active: 1, archivedAt: 1 } }).toArray() : [];
    const accounts = new Map(users.map(user => [String(user._id), user]));
    const included = [];
    const excluded = [];
    for (const tech of technicians) {
      const user = accounts.get(String(tech.user));
      const reasons = [];
      if (tech.archivedAt) reasons.push("technician archived");
      if (!existedOnAttendanceDay(tech, day)) reasons.push("profile created after selected work date");
      if (user?.active === false) reasons.push("linked account inactive");
      if (user?.archivedAt) reasons.push("linked account archived");
      if (user?.role && user.role !== "technician") reasons.push("linked account has another role");
      (reasons.length ? excluded : included).push({ name: tech.name, reasons });
    }
    const secretaries = (await connection.db.collection("users").find({ role: "secretary", active: { $ne: false }, archivedAt: null }, { projection: { firstName: 1, lastName: 1, createdAt: 1 } }).toArray()).filter(staff => existedOnAttendanceDay(staff, day));
    // Run the actual API roster service on an isolated connection. Disable
    // model initialization writes explicitly; this diagnostic only reads.
    const models = {};
    for (const name of ["Technician", "User", "TechnicianAttendance", "SecretaryAttendance", "LeaveRequest", "TechnicianSchedule", "Secretary", "NonWorkingDay"]) {
      const source = require(`../models/${name}`);
      const schema = source.schema.clone();
      schema.set("autoCreate", false);
      schema.set("autoIndex", false);
      models[name] = connection.model(name, schema, source.collection.name);
    }
    const apiRows = await loadStaffAttendanceRoster({ date: day.key, models });
    console.log(JSON.stringify({ actualRosterService: { technicians: apiRows.filter(row => row.role === "technician").length, secretaries: apiRows.filter(row => row.role === "secretary").length, technicianNames: apiRows.filter(row => row.role === "technician").map(row => row.name) } }, null, 2));
    const all = [...included.map(tech => ({ name: tech.name, role: "technician" })), ...secretaries.map(user => ({ name: `${user.firstName || ''} ${user.lastName || ''}`.trim(), role: "secretary" }))].sort((a, b) => a.name.localeCompare(b.name));
    const [records, schedules, leaves, holidays] = await Promise.all([
      connection.db.collection('technicianattendances').find({ date: { $gte: day.start, $lte: day.end } }, { projection: { technicianId: 1, status: 1, checkInTime: 1, checkOutTime: 1 } }).toArray(),
      connection.db.collection('technicianschedules').find({}, { projection: { technicianId: 1, workingDays: 1, nonWorkingWeekdays: 1, restDates: 1 } }).toArray(),
      connection.db.collection('leaverequests').find({ status: 'approved', startDate: { $lte: day.end }, endDate: { $gte: day.start } }, { projection: { technicianId: 1, reason: 1 } }).toArray(),
      connection.db.collection('nonworkingdays').countDocuments({ date: { $gte: day.start, $lte: day.end }, active: { $ne: false }, archivedAt: null, service: null }),
    ]);
    const technicianStates = technicians.filter(tech => included.some(item => item.name === tech.name)).map(tech => {
      const sameTech = item => String(item.technicianId) === String(tech._id);
      const state = staffDayState({ day, now: day.end, record: records.find(sameTech), schedule: schedules.find(sameTech), leave: leaves.find(sameTech), holiday: holidays > 0 });
      return { name: tech.name, status: state.attendanceStatus };
    });
    console.log(JSON.stringify({ workDate: day.key, directoryTechnicians: technicians.length, databaseFilterTechnicians: exactMatches.length, databaseFilterNames: exactMatches.map(item => item.name), dateTypes, eligibleAfterDateNormalization: included.length, secretaries: secretaries.length, excluded, technicianStates, pages: Array.from({ length: Math.ceil(all.length / 10) }, (_, page) => ({ page: page + 1, technicians: all.slice(page * 10, page * 10 + 10).filter(row => row.role === "technician").length, staff: all.slice(page * 10, page * 10 + 10) })) }, null, 2));
  } catch (error) { process.exitCode = 1; console.error("Roster diagnostic failed:", error.code || error.name); }
  finally { await connection.close().catch(() => {}); }
})();

"use strict";
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const { manilaDateTime, manilaDateKey } = require("../utils/bookingDateTime");
const { assignmentWorkDecision, technicianAssignmentScope } = require("../utils/technicianWorkSync");
const { buildMongoConnectionUri, disableRetryableWritesForDirectConnection } = require("../utils/mongoConnection");
(async () => {
  const configured = buildMongoConnectionUri(process.env.MONGODB_URI, { directHosts: process.env.MONGODB_DIRECT_HOSTS, replicaSet: process.env.MONGODB_REPLICA_SET, authSource: process.env.MONGODB_AUTH_SOURCE });
  const connection = mongoose.createConnection(disableRetryableWritesForDirectConnection(configured.uri), { autoIndex: false, autoCreate: false, maxPoolSize: 2, minPoolSize: 0, serverSelectionTimeoutMS: 8000, retryWrites: false });
  try {
    await connection.asPromise();
    const date = process.argv[2] || manilaDateKey(new Date());
    const rows = await connection.db.collection("assignments").find({ bookingDate: { $gte: manilaDateTime(date, 0), $lte: manilaDateTime(date, 1440, -1) }, status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress", "waiting_for_customer"] } }, { projection: { bookingId: 1, technicianId: 1, serviceItemId: 1, serviceType: 1, status: 1, bookingDate: 1, startTime: 1 } }).toArray();
    const bookings = await connection.db.collection("bookingservices").find({ _id: { $in: rows.map(row => row.bookingId) } }, { projection: { bookingReference: 1, status: 1, archivedAt: 1, isProject: 1, sourceOrderId: 1, technicianId: 1, assignmentId: 1, bookingDate: 1, startTime: 1, repairSchedule: 1, "services._id": 1, "services.status": 1, "services.technicianId": 1, "services.assignmentId": 1, "services.schedule": 1 } }).toArray();
    const map = new Map(bookings.map(row => [String(row._id), row]));
    const isolatedModels = {};
    for (const name of ["Assignment", "BookingService"]) {
      const source = require(`../models/${name}`);
      const schema = source.schema.clone(); schema.set("autoIndex", false); schema.set("autoCreate", false);
      isolatedModels[name] = connection.model(name, schema, source.collection.name);
    }
    let validated = 0;
    for (const technicianId of [...new Map(rows.map(row => [String(row.technicianId), row.technicianId])).values()]) {
      const scope = await technicianAssignmentScope(technicianId, { Assignments: isolatedModels.Assignment, Bookings: isolatedModels.BookingService });
      validated += await isolatedModels.Assignment.countDocuments({ ...scope, bookingDate: { $gte: manilaDateTime(date, 0), $lte: manilaDateTime(date, 1440, -1) }, status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress", "waiting_for_customer"] } });
    }
    console.log(JSON.stringify({ actualWorkScopeService: { date, activeAssignmentRecords: rows.length, validActiveVisits: validated, staleVisitsExcluded: rows.length - validated } }, null, 2));
    console.log(JSON.stringify({ date, activeAssignmentRecords: rows.length, rows: rows.map(row => {
      const booking = map.get(String(row.bookingId));
      return { reference: booking?.bookingReference, assignmentStatus: row.status, bookingStatus: booking?.status, assignmentTime: row.startTime, bookingDate: booking?.bookingDate, decision: assignmentWorkDecision(row, booking) };
    }) }, null, 2));
  } catch (error) { process.exitCode = 1; console.error("Work diagnostic failed:", error.code || error.name); }
  finally { await connection.close().catch(() => {}); }
})();

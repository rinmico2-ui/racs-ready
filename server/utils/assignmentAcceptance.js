"use strict";

const mongoose = require("mongoose");
const Assignment = require("../models/Assignment");
const BookingService = require("../models/BookingService");
const Project = require("../models/Project");
const { isUnsupportedMongoWriteFeature } = require("./mongoWriteSupport");

const ACCEPTED_STATES = new Set(["accepted", "en_route", "on_site", "in_progress", "completed",
  "waiting_for_customer", "no_show_reported"]);
const ACCEPTABLE_BOOKING_STATES = new Set(["assigned", "scheduled", "confirmed", "accepted",
  "awaiting_assignment", "payment_verified", "pending_inspection", "inspection_scheduled",
  "repair_approved", "waiting_parts", "parts_reserved", "ready_for_repair", "repair_scheduled", "pending_project_scheduling"]);
const EARLY_ITEM_STATES = new Set(["pending", "inspection_pending", "awaiting_assignment", "assigned", "scheduled", "accepted"]);
const ref = value => String(value?._id || value || "");
const problem = (message, code, status = 409) => Object.assign(new Error(message), { code, status });

function bookingAcceptancePatch(booking, assignment, technician) {
  const repair = assignment.serviceType === "repair";
  const project = assignment.serviceType === "project" || booking.isProject;
  const set = {};
  if (repair && !assignment.serviceItemId) {
    if (["assigned", "pending_inspection"].includes(booking.status)) set.status = "inspection_scheduled";
  } else if (!repair && !project && !assignment.serviceItemId && ["assigned", "scheduled", "accepted", "awaiting_assignment", "payment_verified"].includes(booking.status)) {
    set.status = "confirmed";
  }
  for (const [index, item] of (booking.services || []).entries()) {
    if (project) continue;
    if (assignment.serviceItemId && ref(item._id) !== ref(assignment.serviceItemId)) continue;
    // Do not reassign another technician's individual service item.
    if (item.technicianId && ref(item.technicianId) !== ref(technician._id)) continue;
    if (item.assignmentId && ref(item.assignmentId) !== ref(assignment._id)) continue;
    if (repair && item.type !== "repair") continue;
    if (!EARLY_ITEM_STATES.has(item.status)) continue;
    const key = `services.${index}`;
    set[`${key}.technicianId`] = technician._id;
    set[`${key}.technicianName`] = technician.name;
    set[`${key}.assignmentId`] = assignment._id;
    const repairPhaseTwo = item.phase === "repair_phase_2" || item.schedule?.kind === "repair";
    const next = repair ? (repairPhaseTwo ? "repair_scheduled" : "inspection_scheduled") : "accepted";
    if (item.status !== next) set[`${key}.status`] = next;
    if (repair && !repairPhaseTwo) set[`${key}.phase`] = "repair_phase_1";
  }
  const note = `[Technician Accepted] ${technician.name} accepted the ${repair ? "repair " : ""}assignment`;
  if (!String(booking.notes || "").includes(note)) set.notes = [booking.notes, note].filter(Boolean).join("\n");
  return set;
}

async function acceptAssignment({ assignmentId, technician, user, isScheduleMissed,
  database = mongoose, Assignments = Assignment, Bookings = BookingService, Projects = Project, now = new Date() }) {
  let session, result;
  try {
    session = await database.startSession();
    await session.withTransaction(async () => {
      const assignment = await Assignments.findOne({ _id: assignmentId, technicianId: technician._id }).session(session);
      if (!assignment) throw problem("Assignment not found.", "ASSIGNMENT_NOT_FOUND", 404);
      const alreadyAccepted = ACCEPTED_STATES.has(assignment.status);
      if (!alreadyAccepted && assignment.status !== "pending_acceptance") {
        throw problem("This assignment changed or is no longer waiting for acceptance. Refresh your jobs.", "ASSIGNMENT_CHANGED");
      }
      if (!alreadyAccepted && isScheduleMissed(assignment)) {
        throw problem("The scheduled time has passed. Staff must set a new schedule before you accept.", "SCHEDULE_MISSED");
      }
      let booking = await Bookings.findById(assignment.bookingId).session(session);
      if (!booking) throw problem("The booking for this assignment could not be found. Contact staff.", "BOOKING_NOT_FOUND", 404);
      const projectAssignment = assignment.serviceType === "project" || booking.isProject;
      const projectMembership = projectAssignment && await Projects.findOne({ bookingId: booking._id,
        "assignedTechnicians._id": technician._id, status: { $nin: ["cancelled", "closed", "completed"] },
      }).session(session);
      if (projectAssignment && !projectMembership) throw problem("You are no longer on this project's team. Refresh your jobs.", "ASSIGNMENT_CHANGED");
      const ownsItem = (booking.serviceType === "mixed" || assignment.serviceItemId) && (booking.services || []).some(item =>
        (!assignment.serviceItemId || ref(item._id) === ref(assignment.serviceItemId))
        && ref(item.technicianId) === ref(technician._id) && ref(item.assignmentId) === ref(assignment._id));
      if (assignment.serviceItemId && !ownsItem) throw problem("This service item has been reassigned. Refresh your jobs.", "ASSIGNMENT_CHANGED");
      if (!projectMembership && ((booking.technicianId && ref(booking.technicianId) !== ref(technician._id) && !ownsItem)
        || (booking.assignmentId && ref(booking.assignmentId) !== ref(assignment._id) && !ownsItem))) {
        throw problem("This booking has been reassigned. Refresh your jobs.", "ASSIGNMENT_CHANGED");
      }
      if (["cancelled", "rejected", "closed", "repair_declined", "expired"].includes(booking.status)) {
        throw problem("This booking is no longer available for acceptance. Refresh your jobs.", "BOOKING_UNAVAILABLE");
      }
      if (booking.sourceOrderId) throw problem("Accept delivery and installation work from My Orders.", "ORDER_WORKFLOW_REQUIRED");
      if (!alreadyAccepted && ["completed", "repair_completed"].includes(booking.status)) {
        throw problem("The booking is already completed. Refresh your jobs.", "BOOKING_CHANGED");
      }
      if (!alreadyAccepted && !ownsItem && !ACCEPTABLE_BOOKING_STATES.has(booking.status)) {
        throw problem("The booking changed. Ask staff to check its assignment before accepting.", "BOOKING_CHANGED");
      }
      // Recover an earlier partial acceptance while the booking is still in an
      // early stage. Never move an already progressing job back to confirmed.
      if ((ACCEPTABLE_BOOKING_STATES.has(booking.status) || ownsItem)
        && !["completed", "repair_completed"].includes(booking.status)
        && ["pending_acceptance", "accepted"].includes(assignment.status)) {
        const set = bookingAcceptancePatch(booking, assignment, technician);
        if (Object.keys(set).length) {
          booking = await Bookings.findOneAndUpdate({ _id: booking._id, status: booking.status,
            technicianId: booking.technicianId || null, assignmentId: booking.assignmentId || null,
          }, { $set: set }, { session, new: true, runValidators: true });
          if (!booking) throw problem("The booking changed. Refresh your jobs before accepting.", "BOOKING_CHANGED");
        }
      }
      let accepted = assignment;
      if (!alreadyAccepted) {
        accepted = await Assignments.findOneAndUpdate({ _id: assignment._id, technicianId: technician._id,
          status: "pending_acceptance", bookingId: assignment.bookingId,
        }, { $set: { status: "accepted", acceptedAt: now, resourcesReserved: false,
          preparationStatus: "pending", preparationIssue: "" },
          $push: { notes: { text: "Assignment accepted by technician", by: user._id, byName: technician.name, createdAt: now } },
        }, { session, new: true, runValidators: true });
        if (!accepted) throw problem("The assignment changed. Refresh your jobs before accepting.", "ASSIGNMENT_CHANGED");
      }
      result = { assignment: accepted, booking, alreadyAccepted };
    });
    return result;
  } catch (error) {
    if (isUnsupportedMongoWriteFeature(error)) {
      throw problem("Assignment acceptance is unavailable because the database does not support transactions. Ask the server administrator to check the replica set.", "ASSIGNMENT_DATABASE_SETUP_REQUIRED", 503);
    }
    throw error;
  } finally {
    if (session) await session.endSession().catch(() => {});
  }
}

module.exports = { acceptAssignment, bookingAcceptancePatch };

"use strict";

const mongoose = require("mongoose");
const Project = require("../models/Project");
const { capacityMinutes } = require("./bookingServiceItems");

function parseProjectWindow(input) {
  const dateKey = value => value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
    : String(value || "").slice(0, 10);
  const startKey = dateKey(input?.date);
  const endKey = dateKey(input?.endDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startKey) || !/^\d{4}-\d{2}-\d{2}$/.test(endKey)) {
    throw Object.assign(new Error("Choose a start date and an end date for the project."), { status: 400 });
  }
  const startDate = new Date(`${startKey}T00:00:00`);
  const endDate = new Date(`${endKey}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) ||
      startDate.getFullYear() !== Number(startKey.slice(0, 4)) ||
      startDate.getMonth() + 1 !== Number(startKey.slice(5, 7)) ||
      startDate.getDate() !== Number(startKey.slice(8, 10)) ||
      endDate.getFullYear() !== Number(endKey.slice(0, 4)) ||
      endDate.getMonth() + 1 !== Number(endKey.slice(5, 7)) ||
      endDate.getDate() !== Number(endKey.slice(8, 10)) ||
      endDate < startDate) {
    throw Object.assign(new Error("Choose a valid project date range."), { status: 400 });
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (startDate <= today) {
    throw Object.assign(new Error("Choose a project start date after today."), { status: 400 });
  }
  return { startDate, endDate, startKey, endKey };
}

function prepareProjectServiceChange(booking, { startDate, endDate, plannedCompletionDate, inspectionDurationMinutes }) {
  const totalUnits = booking.services.reduce((sum, item) => sum + Number(item.quantity), 0);
  const totalMinutes = capacityMinutes(booking.services, inspectionDurationMinutes);
  const estimatedTotalHours = Math.max(1, Math.round(totalMinutes / 6) / 10);

  booking.quantity = totalUnits;
  booking.isProject = true;
  booking.status = "pending_project_scheduling";
  booking.bookingDate = startDate;
  booking.startTime = undefined;
  booking.endTime = undefined;
  booking.selectedTimeLabel = undefined;
  booking.projectScheduling = {
    preferredStartDate: startDate,
    preferredCompletionDeadline: endDate,
    estimatedTotalHours,
  };
  for (const item of booking.services) {
    item.schedule = {
      date: startDate,
      durationMinutes: Number(item.duration || item.schedule?.durationMinutes) || inspectionDurationMinutes,
      kind: item.type === "repair" ? "inspection" : "service",
    };
  }

  const unitGroups = booking.services.map((item, groupIndex) => {
    const quantity = Number(item.quantity);
    return {
      groupIndex,
      serviceId: item.serviceId || undefined,
      serviceName: item.name || "Service",
      serviceType: item.type || "core",
      unitType: item.unitType || item.airconTypeName || item.applianceTypeName || item.name || "Unit",
      brand: item.brand || "",
      model: item.model || "",
      applianceType: item.applianceType || item.airconType || "",
      applianceTypeName: item.applianceTypeName || item.airconTypeName || "",
      hp: item.hp || undefined,
      hpDescription: item.hpDescription || "",
      problemDescription: item.problemDescription || item.repairIssue || "",
      repairIssue: item.repairIssue || item.problemDescription || "",
      quantity,
      unitPrice: Number(item.unitPrice) || 0,
      totalPrice: Number(item.totalPrice) || 0,
      duration: Number(item.duration) || inspectionDurationMinutes,
      units: Array.from({ length: quantity }, (_, index) => ({
        unitIndex: index + 1,
        label: `${item.name || "Unit"} #${index + 1}`,
        status: "pending",
      })),
    };
  });

  return {
    bookingId: booking._id,
    customerId: booking.customerId,
    customer: {
      _id: booking.customerId,
      name: booking.customer?.name || "",
      email: booking.customer?.email || "",
      phone: booking.customer?.phone || "",
      address: booking.location?.address || booking.customer?.address || "",
    },
    service: {
      name: booking.services.map(item => item.name || "Service").join(", "),
      category: booking.serviceType,
    },
    status: "pending_project_scheduling",
    isLargeScale: true,
    projectPhase: booking.serviceType === "repair" ? "assessment" : "execution",
    totalUnits,
    quantity: totalUnits,
    estimatedTotalHours,
    estimatedDurationPerUnit: estimatedTotalHours / totalUnits,
    preferredStartDate: startDate,
    preferredCompletionDeadline: endDate,
    plannedStartDate: startDate,
    plannedCompletionDate: plannedCompletionDate || endDate,
    reservedTechnicians: 1,
    location: booking.location || undefined,
    unitGroups,
  };
}

function prepareStandardServiceChange(booking, { date, startTime, endTime, inspectionDurationMinutes }) {
  booking.quantity = booking.services.reduce((sum, item) => sum + Number(item.quantity), 0);
  booking.serviceDurationMinutes = capacityMinutes(booking.services, inspectionDurationMinutes);
  booking.isProject = false;
  booking.projectScheduling = undefined;
  if (booking.status === "pending_project_scheduling") booking.status = booking.paymentVerifiedAt ? "payment_verified" : "pending";
  booking.bookingDate = date;
  booking.startTime = startTime;
  booking.endTime = endTime;
  booking.selectedTimeLabel = startTime;
  for (const item of booking.services) {
    item.schedule = {
      date,
      startTime,
      endTime,
      durationMinutes: Number(item.duration || item.schedule?.durationMinutes) || inspectionDurationMinutes,
      kind: item.type === "repair" ? "inspection" : "service",
    };
  }
}

async function saveStandardServiceChange(booking, options) {
  const startedStatuses = new Set(["on-the-way", "arrived", "in-progress", "inspection_in_progress", "repair_in_progress", "completed", "cancelled"]);
  if (startedStatuses.has(booking.status) || booking.technicianId || booking.assignmentId ||
      booking.services.some(item => startedStatuses.has(item.status) || item.assignmentId)) {
    throw Object.assign(new Error("This project already has assigned or started work. Contact the operations team to change it."), { status: 409 });
  }
  const project = await Project.findOne({ bookingId: booking._id, status: { $ne: "cancelled" } });
  if (project && project.status !== "pending_project_scheduling") {
    throw Object.assign(new Error("This project is already underway. Its schedule must be changed by the operations team."), { status: 409 });
  }
  if (project?.status === "pending_project_scheduling") {
    const WorkOrder = require("../models/WorkOrder");
    const DailyAssignment = require("../models/DailyAssignment");
    if (await WorkOrder.exists({ projectId: project._id }) || await DailyAssignment.exists({ projectId: project._id })) {
      throw Object.assign(new Error("This project already has a work plan. Contact the operations team to change it."), { status: 409 });
    }
  }
  prepareStandardServiceChange(booking, options);
  if (!project) return booking.save();

  // Release the project reservation before saving the appointment. Restore it
  // if the booking write fails so the two records do not disagree.
  const reservedTechnicians = project.reservedTechnicians;
  project.status = "cancelled";
  project.reservedTechnicians = 0;
  await project.save();
  try {
    await booking.save();
  } catch (error) {
    project.status = "pending_project_scheduling";
    project.reservedTechnicians = reservedTechnicians;
    await project.save();
    throw error;
  }
}

async function saveProjectServiceChange(booking, options) {
  const projectData = prepareProjectServiceChange(booking, options);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const existingProject = await Project.findOne({ bookingId: booking._id }).session(session);
      if (existingProject && !["pending_project_scheduling", "cancelled"].includes(existingProject.status)) {
        throw Object.assign(new Error("This project is already underway. Its schedule must be changed by the operations team."), { status: 409 });
      }
      await booking.save({ session });
      await Project.findOneAndUpdate(
        { bookingId: booking._id },
        { $set: projectData },
        { upsert: true, returnDocument: "after", session },
      );
    });
  } finally {
    await session.endSession();
  }
}

module.exports = { parseProjectWindow, prepareProjectServiceChange, saveProjectServiceChange, prepareStandardServiceChange, saveStandardServiceChange };

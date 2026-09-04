const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const router = express.Router();
const auth = require("../middleware/authenticate");

// All project data is operational and requires a current, enabled account.
router.use(auth.authenticate);

router.use("/projects/:id", async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next();
  }
  if (req.user.role === "customer") {
    return res.status(403).json({ error: "Project operations are restricted to staff" });
  }
  if (req.user.role !== "technician") return next();
  try {
    const technician = await Technician.findOne({ user: req.user._id }).select("_id").lean();
    if (!technician) return res.status(403).json({ error: "Technician profile not found" });
    const project = await Project.exists({
      _id: req.params.id,
      $or: [
        { "assignedTechnicians._id": technician._id },
        { leadTechnicianId: technician._id },
      ],
    });
    if (!project) return res.status(403).json({ error: "This project is not assigned to you" });
    req.technician = technician;
    return next();
  } catch (err) {
    return next(err);
  }
});
const Project = require("../models/Project");
const WorkOrder = require("../models/WorkOrder");
const DailyAssignment = require("../models/DailyAssignment");
const ProjectMaterial = require("../models/ProjectMaterial");
const Tool = require("../models/Tool");
const BookingService = require("../models/BookingService");
const Technician = require("../models/Technician");
const Assignment = require("../models/Assignment");
const Payment = require("../models/Payment");
const Expense = require("../models/Expense");
const ProjectIssue = require("../models/ProjectIssue");
const PartsRequest = require("../models/PartsRequest");
const ProjectResourcePurchase = require("../models/ProjectResourcePurchase");
const StockAdjustment = require("../models/StockAdjustment");
const ServiceToolUsage = require("../models/ServiceToolUsage");
const EquipmentAssignment = require("../models/EquipmentAssignment");
const DailyKit = require("../models/DailyKit");
const ProjectWorkSubmission = require("../models/ProjectWorkSubmission");
const { evaluateProjectResources, cleanType, VALID_RULES, VALID_STATES } = require("../utils/projectResourcePlanning");
const { projectUnits, validateWorkOrderPlan, resourcesForWorkOrder, hasCycle } = require("../utils/projectWorkOrderPlanning");
const { generateProjectSchedule, validateProjectSchedule, normalizeWorkingDays } = require("../utils/enterpriseProjectScheduling");
const User = require("../models/User");
const { createNotification } = require("../utils/notify");
const schedulingEngine = require("../utils/enterpriseSchedulingEngine");
const {
  calculateTotalEstimatedDuration,
  isLargeProject,
  getCompanyCapacity,
  getProjectThresholdHours,
  invalidateProjectThresholdCache,
} = schedulingEngine;
const { buildAllocationCalendar, getTechnicianScheduleConflicts } = require("../utils/projectAllocation");
const { ensureDailyAssignments, completeDay, nextWorkingDay } = require("../utils/dailyAssignment");
const { BookingStatus } = require("../models/BookingStatus");
const audit = require("../utils/audit");
const { calculateProjectCustomerPricing } = require("../utils/projectPricing");
const { normalizeProjectWorkSubmission } = require("../utils/projectWorkSubmission");
const { imageExtensionFor, isAllowedImage } = require("../utils/uploadSecurity");
const {
  mergeDailySummaries,
  normalizeRecoveryRequest,
  riskStatus: recoveryRiskStatus,
} = require("../utils/projectScheduleRecovery");
const { deriveProjectScheduleHealth, summarizeScheduleHealth } = require("../utils/projectScheduleHealth");
const { addProjectItemsToDailyKit, syncDailyKit } = require("../utils/dailyKitService");

function escapeRecoveryHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function recoveryDateLabel(value) {
  return value ? new Date(value).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric" }) : "Not set";
}

async function notifyCustomerOfRecovery(project, revision, req) {
  if (!revision.customerNotification?.requested) return { status: "not_requested", inAppSent: false, emailSent: false };
  const account = project.customerId
    ? await User.findById(project.customerId).select("_id email firstName lastName").lean().catch(() => null)
    : null;
  const userId = account?._id || null;
  const email = String(project.customer?.email || account?.email || "").trim();
  const customerName = project.customer?.name || [account?.firstName, account?.lastName].filter(Boolean).join(" ") || "Customer";
  const serviceName = project.service?.name || "Project";
  const extension = revision.action === "extension";
  const message = extension
    ? `Your project completion date has been revised from ${recoveryDateLabel(revision.previousApprovedCompletionDate)} to ${recoveryDateLabel(revision.revisedApprovedCompletionDate)}. Reason: ${revision.reason}`
    : `A recovery schedule has been approved for your project. The committed completion date remains ${recoveryDateLabel(revision.revisedApprovedCompletionDate)}. Reason: ${revision.reason}`;
  let inAppSent = false;
  let emailSent = false;
  const errors = [];
  if (userId) {
    try {
      const notification = await createNotification({
        type: "project_schedule_update",
        title: extension ? "Project completion date updated" : "Project recovery plan approved",
        message,
        userId,
        referenceId: project._id,
        referenceModel: "Project",
        link: "/book-history",
        priority: "high",
        io: req.app.get("io") || global.io || null,
      });
      inAppSent = Boolean(notification);
    } catch (error) { errors.push(`In-app: ${error.message}`); }
  }
  if (email) {
    try {
      const mailer = require("../utils/mailer");
      const rows = [
        ["Project", serviceName],
        ["Previous commitment", recoveryDateLabel(revision.previousApprovedCompletionDate)],
        [extension ? "Approved extension" : "Commitment retained", recoveryDateLabel(revision.revisedApprovedCompletionDate)],
        ["Current forecast", recoveryDateLabel(revision.forecastAfter)],
        ["Reason", revision.reason],
      ];
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto"><h2 style="color:#1e293b">${extension ? "Project Schedule Extension" : "Project Recovery Plan"}</h2><p>Hi ${escapeRecoveryHtml(customerName)},</p><p>${escapeRecoveryHtml(message)}</p><table style="width:100%;border-collapse:collapse">${rows.map(([key, value]) => `<tr><td style="padding:7px 10px;background:#f1f5f9;color:#475569;width:38%">${escapeRecoveryHtml(key)}</td><td style="padding:7px 10px;color:#1e293b;font-weight:600">${escapeRecoveryHtml(value)}</td></tr>`).join("")}</table><p style="color:#64748b;font-size:12px;margin-top:18px">Your completed work and prior records remain unchanged. Contact our team if you have questions.</p></div>`;
      await mailer.sendMail({ to: email, subject: `${extension ? "Project extension approved" : "Project recovery plan approved"} — ${serviceName}`, html, text: `${message}\nCurrent forecast: ${recoveryDateLabel(revision.forecastAfter)}` });
      emailSent = true;
    } catch (error) { errors.push(`Email: ${error.message}`); }
  }
  const status = inAppSent && emailSent ? "sent" : (inAppSent || emailSent) ? "partial" : "failed";
  return { status, inAppSent, emailSent, sentAt: (inAppSent || emailSent) ? new Date() : null, error: errors.join("; ").slice(0, 500) };
}

// Work-order URLs do not contain a project id, so the project middleware above
// cannot protect them. Resolve the parent project once and enforce crew
// membership before any technician can read or mutate a work order.
router.use("/work-orders/:id", async (req, res, next) => {
  if (req.user.role !== "technician" || !mongoose.Types.ObjectId.isValid(req.params.id)) return next();
  try {
    const technician = await Technician.findOne({ user: req.user._id }).select("_id name user").lean();
    if (!technician) return res.status(403).json({ error: "Technician profile not found" });
    const workOrder = await WorkOrder.findById(req.params.id).select("projectId").lean();
    if (!workOrder) return next();
    const assigned = await Project.exists({
      _id: workOrder.projectId,
      $or: [
        { "assignedTechnicians._id": technician._id },
        { leadTechnicianId: technician._id },
      ],
    });
    if (!assigned) return res.status(403).json({ error: "This work order is not assigned to you" });
    req.technician = req.technician || technician;
    return next();
  } catch (error) {
    return next(error);
  }
});

const workSubmissionUploadDir = path.join(__dirname, "../public/uploads/project-work-submissions");
if (!fs.existsSync(workSubmissionUploadDir)) fs.mkdirSync(workSubmissionUploadDir, { recursive: true });

const workSubmissionUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, workSubmissionUploadDir),
    filename: (_req, file, cb) => {
      const extensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
      cb(null, `submission-${Date.now()}-${Math.round(Math.random() * 1e9)}${extensions[file.mimetype] || ".jpg"}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)),
}).single("proofPhoto");

async function removeSubmissionUpload(file) {
  if (!file?.path) return;
  await fs.promises.unlink(file.path).catch(() => {});
}

async function syncPlannedResourcesToWorkOrders(project) {
  const snapshot = typeof project.toObject === "function" ? project.toObject() : project;
  const orders = await WorkOrder.find({ projectId: snapshot._id, status: { $ne: "cancelled" } });
  for (const order of orders) {
    order.resourceRequirements = resourcesForWorkOrder(snapshot, order.toObject());
    await order.save();
  }
}

function scheduleDayKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Step 4 is the scheduling authority. This guarded repair handles projects
// previously overwritten by the retired legacy 2-units/day generator.
async function reconcileCommittedSchedule(project) {
  if (project?.schedulePlan?.status !== "confirmed") return { repaired: false };
  const baseline = (project.schedulePlan.dailySummary || []).flatMap(day => day.allocations || []);
  if (!baseline.length) return { repaired: false };
  const current = await DailyAssignment.find({ projectId: project._id, status: { $ne: "skipped" } }).lean();
  const signature = row => `${String(row.workOrderId)}|${String(row.technicianId)}|${scheduleDayKey(row.date)}|${row.startTime || ""}|${row.endTime || ""}|${Number(row.targetUnits || 0)}`;
  const currentSignatures = new Set(current.map(signature));
  const drifted = current.length !== baseline.length || baseline.some(row => !currentSignatures.has(signature(row)));
  if (!drifted) return { repaired: false };
  if (current.some(row => Number(row.completedUnits || 0) > 0)) return { repaired: false, skipped: "execution_progress_exists" };

  await DailyAssignment.deleteMany({ projectId: project._id });
  await DailyAssignment.insertMany(baseline.map(row => ({
    projectId: project._id, workOrderId: row.workOrderId, technicianId: row.technicianId,
    date: row.date, startTime: row.startTime, endTime: row.endTime,
    allocatedMinutes: Number(row.allocatedMinutes || 0), targetUnits: Number(row.targetUnits || 0),
    completedUnits: 0, unitKeys: row.unitKeys || [], generatedBy: "system", planningOnly: false, status: "pending",
  })));
  const orders = await WorkOrder.find({ projectId: project._id, status: { $ne: "cancelled" } });
  for (const order of orders) {
    const rows = baseline.filter(row => String(row.workOrderId) === String(order._id)).sort((a,b) => new Date(a.date)-new Date(b.date) || String(a.startTime||"").localeCompare(String(b.startTime||"")));
    if (!rows.length) continue;
    order.scheduledDate = rows[0].date; order.scheduledEndDate = rows[rows.length-1].date;
    order.startTime = rows[0].startTime; order.endTime = rows[rows.length-1].endTime;
    await order.save();
  }
  return { repaired: true, assignments: baseline.length };
}

// Older aggregate submissions updated completedUnitCount without updating the
// tracked unit rows. Repair that mismatch so the unit checklist is truthful.
async function reconcileTrackedUnitProgress(workOrders) {
  const updates = [];
  for (const order of workOrders || []) {
    if (!(order.units || []).length) continue;
    const target = Math.max(0, Math.min(Number(order.completedUnitCount || 0), order.units.length));
    const currentlyComplete = order.units.filter(unit => unit.status === "completed").length;
    if (currentlyComplete >= target) continue;
    let needed = target - currentlyComplete;
    for (const unit of order.units) {
      if (needed <= 0) break;
      if (["completed", "cancelled"].includes(unit.status)) continue;
      unit.status = "completed";
      unit.completedAt = unit.completedAt || order.actualCompletionDate || order.updatedAt || null;
      needed -= 1;
    }
    updates.push({
      updateOne: { filter: { _id: order._id }, update: { $set: { units: order.units } } },
    });
  }
  if (updates.length) await WorkOrder.bulkWrite(updates);
  return workOrders;
}

async function rebalanceFutureUnitTargets(workOrder) {
  const tomorrow = new Date(); tomorrow.setHours(0, 0, 0, 0); tomorrow.setDate(tomorrow.getDate() + 1);
  const rows = await DailyAssignment.find({
    workOrderId: workOrder._id,
    date: { $gte: tomorrow },
    status: { $ne: "completed" },
  }).sort({ date: 1, startTime: 1, createdAt: 1 });
  if (!rows.length) return;

  let remaining = Math.max(0, Number(workOrder.unitCount || 0) - Number(workOrder.completedUnitCount || 0));
  for (const row of rows) {
    const planned = Math.max(0, Number(row.targetUnits || 0));
    const nextTarget = Math.min(planned, remaining);
    const nextStatus = nextTarget > 0 ? (row.status === "in_progress" ? "in_progress" : "pending") : "skipped";
    const changed = Number(row.targetUnits || 0) !== nextTarget || row.status !== nextStatus;
    row.targetUnits = nextTarget;
    row.status = nextStatus;
    remaining -= nextTarget;
    if (changed) await row.save();
  }
  // If an older schedule did not contain enough future capacity, preserve the
  // remaining target on the earliest continuation row instead of losing it.
  if (remaining > 0 && rows.length) {
    rows[0].targetUnits += remaining;
    rows[0].status = "pending";
    await rows[0].save();
  }
}

async function ensureDailyAssignmentsIfLegacy(workOrderId) {
  const order = await WorkOrder.findById(workOrderId).select("projectId").lean();
  if (!order) return null;
  const project = await Project.findById(order.projectId).select("schedulePlan.status").lean();
  if (["ready", "confirmed"].includes(project?.schedulePlan?.status)) return null;
  return ensureDailyAssignments(workOrderId);
}

async function releaseUnblockedWorkOrders(projectId) {
  const project = await Project.findById(projectId).select("status").lean();
  if (!project || !["ready", "in_progress"].includes(project.status)) return [];
  const pending = await WorkOrder.find({ projectId, status: "pending", planningStatus: { $ne: "released" } });
  const released = [];
  for (const order of pending) {
    const blockers = order.dependencies?.length
      ? await WorkOrder.countDocuments({ _id: { $in: order.dependencies }, status: { $ne: "completed" } })
      : 0;
    if (blockers) continue;
    order.status = "assigned"; order.planningStatus = "released"; order.assignmentProvisional = false;
    order.activity.push({ action: "work_order_released", actorName: "System", details: { dependenciesSatisfied: true } });
    await order.save(); released.push(order);
  }
  return released;
}

async function getProjectCompletionReadiness(project) {
  const workOrders = await WorkOrder.find({ projectId: project._id, status: { $ne: "cancelled" } }).lean();
  const submissions = project.isLargeScale
    ? await ProjectWorkSubmission.find({ projectId: project._id }).select("workOrders proof consumables consumablesDeclaredNone").lean()
    : [];
  const evidenceByOrder = new Map();
  for (const submission of submissions) {
    for (const line of submission.workOrders || []) {
      const key = String(line.workOrderId);
      const covered = evidenceByOrder.get(key) || new Set();
      (line.unitKeys || []).forEach(unitKey => covered.add(String(unitKey)));
      evidenceByOrder.set(key, covered);
    }
  }

  let missingEvidenceCount = 0;
  for (const order of workOrders) {
    if (!project.isLargeScale) continue;
    const covered = evidenceByOrder.get(String(order._id)) || new Set();
    missingEvidenceCount += (order.units || []).filter(unit => unit.status === "completed" && !covered.has(String(unit.unitKey))).length;
  }

  const workOrdersComplete = workOrders.length > 0 && workOrders.every(order => {
    const executableUnits = (order.units || []).filter(unit => unit.status !== "cancelled").length || Number(order.unitCount || 0);
    return order.status === "completed" && Number(order.completedUnitCount || 0) >= executableUnits;
  });
  const [openIssueCount, pendingExpenseCount, outstandingEquipmentCount] = await Promise.all([
    ProjectIssue.countDocuments({ projectId: project._id, status: { $in: ["open", "in_progress"] } }),
    Expense.countDocuments({ projectId: project._id, status: "pending" }),
    EquipmentAssignment.countDocuments({ projectId: project._id, status: { $in: ["checked_out", "in_use"] } }),
  ]);
  const evidenceComplete = !project.isLargeScale || (submissions.length > 0 && missingEvidenceCount === 0);
  const paymentStatus = String(project.payment?.paymentStatus || "unpaid");
  const paymentVerified = ["verified", "paid"].includes(paymentStatus);
  const blockers = [];
  if (!workOrdersComplete) blockers.push("all work orders must be reviewed and submitted by the lead");
  if (!evidenceComplete) blockers.push(`${missingEvidenceCount || "some"} completed unit(s) are missing proof-backed submissions`);
  if (!paymentVerified) blockers.push("final payment must be verified");
  if (openIssueCount) blockers.push(`${openIssueCount} project issue(s) are still open`);
  if (pendingExpenseCount) blockers.push(`${pendingExpenseCount} expense(s) still await a decision`);
  if (outstandingEquipmentCount) blockers.push(`${outstandingEquipmentCount} issued resource(s) need return or usage reconciliation`);

  return {
    workOrdersComplete,
    evidenceComplete,
    submissionCount: submissions.length,
    missingEvidenceCount,
    paymentVerified,
    paymentStatus,
    openIssueCount,
    pendingExpenseCount,
    outstandingEquipmentCount,
    canClose: blockers.length === 0,
    blockers,
  };
}

router.get("/projects/dashboard", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const stats = await Project.getDashboardStats();

    const scheduleHealthProjects = await Project.find({
      status: { $in: ["pending_project_scheduling", "accepted", "planning", "ready", "in_progress", "on_hold"] },
    }).select("status totalUnits completedUnits plannedStartDate plannedCompletionDate preferredStartDate preferredCompletionDeadline schedulePlan scheduleGovernance").lean();
    stats.scheduleHealth = summarizeScheduleHealth(scheduleHealthProjects, new Date());

    const recentProjects = await Project.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const pendingProjects = await Project.countDocuments({
      status: { $in: ["pending_project_scheduling", "accepted"] },
    });
    const pendingVerification = await Project.countDocuments({
      status: "pending_project_scheduling",
      isLargeScale: true,
    });

    res.json({
      stats,
      pendingProjects,
      pendingVerification,
      recentProjects,
    });
  } catch (error) {
    console.error("Error fetching project dashboard:", error);
    res.status(500).json({ error: "Failed to fetch project dashboard" });
  }
});

router.get("/projects", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    let { status, search, serviceType, scheduleHealth, page = 1, limit = 20, sort = "-createdAt" } = req.query;
    page = parseInt(page);
    limit = Math.min(parseInt(limit) || 20, 100);

    let query = {};
    if (status) {
      const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
      if (statuses.length > 1) {
        query.status = { $in: statuses };
      } else {
        query.status = status;
      }
    }

    if (search) {
      const searchRegex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [
        { "customer.name": searchRegex },
        { "service.name": searchRegex },
        { notes: searchRegex },
      ];
    }

    if (serviceType === "repair") {
      query["repair.serviceType"] = "repair";
    } else if (serviceType === "core") {
      query.$and = query.$and || [];
      query.$and.push({ $or: [
        { "repair.serviceType": "core" },
        { "repair.serviceType": { $exists: false } },
        { "repair.serviceType": null },
      ] });
    }

    const supportedHealthFilters = new Set(["past_due", "behind_schedule", "at_risk", "on_track", "unscheduled", "not_started"]);
    const healthFilter = supportedHealthFilters.has(scheduleHealth) ? scheduleHealth : "";

    if (healthFilter) {
      const matchingProjects = (await Project.find(query).sort(sort).lean())
        .map(project => ({ ...project, scheduleHealth: deriveProjectScheduleHealth(project, new Date()) }))
        .filter(project => project.scheduleHealth.code === healthFilter);
      const total = matchingProjects.length;
      const projects = matchingProjects.slice((page - 1) * limit, page * limit);
      return res.json({
        projects,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      });
    }

    const total = await Project.countDocuments(query);
    const projects = (await Project.find(query)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean())
      .map(project => ({ ...project, scheduleHealth: deriveProjectScheduleHealth(project, new Date()) }));

    res.json({
      projects,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error listing projects:", error);
    res.status(500).json({ error: "Failed to list projects" });
  }
});

router.get("/projects/:id", auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const project = await Project.findById(id).lean();
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const workOrders = await WorkOrder.find({ projectId: id })
      .sort({ sortOrder: 1, scheduledDate: 1 })
      .lean();

    const materials = await ProjectMaterial.find({ projectId: id }).lean();

    const booking = await BookingService.findById(project.bookingId).lean();
    const workSubmissions = await ProjectWorkSubmission.find({ projectId: id })
      .populate("technicianId", "name")
      .sort({ createdAt: -1 })
      .lean();
    const completionReadiness = await getProjectCompletionReadiness(project);

    // Recalculate team-, scope-, work-order-, and date-dependent requirements
    // whenever the Planning Studio reloads.
    if (project.planningDraft?.resources?.length && !project.planningDraft?.baselineLocked) {
      const evaluated = await evaluateProjectResources(project, project.planningDraft.resources);
      project.planningDraft.resources = evaluated.resources;
      project.planningDraft.readiness = evaluated.readiness;
      await Project.updateOne({ _id: id, "planningDraft.baselineLocked": { $ne: true } }, {
        $set: { "planningDraft.resources": evaluated.resources, "planningDraft.readiness": evaluated.readiness, "planningDraft.updatedAt": new Date() },
      }).catch(() => {});
    }

    res.json({ project, workOrders, materials, booking, workSubmissions, completionReadiness });
  } catch (error) {
    console.error("Error fetching project:", error);
    res.status(500).json({ error: "Failed to fetch project" });
  }
});

/**
 * POST /api/projects/:id/notify-customer
 * Push a status update to the project's customer (in-app + email).
 * Body (optional): { message?: string } — custom note appended to the
 * status-aware summary. Guarded by a 60s anti-spam throttle.
 */
router.post("/projects/:id/notify-customer", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    const customMessage = String(req.body?.message || "").trim().slice(0, 500);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const project = await Project.findById(id).lean();
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    // ── Resolve the customer's contacts (snapshot → booking → account) ────
    let customerName = project.customer?.name || "";
    let email = project.customer?.email || "";
    let phone = project.customer?.phone || "";
    let userId = null;

    if ((!email || !customerName) && project.bookingId) {
      const booking = await BookingService.findById(project.bookingId)
        .select("customer email phone")
        .lean()
        .catch(() => null);
      if (booking) {
        email = email || booking.customer?.email || booking.email || "";
        phone = phone || booking.customer?.phone || booking.phone || "";
        customerName = customerName || booking.customer?.name || "";
      }
    }
    if (!userId && project.customerId) {
      // customerId may reference the User account directly
      const acct = await User.findById(project.customerId).select("_id email").lean().catch(() => null);
      if (acct) {
        userId = acct._id;
        email = email || acct.email || "";
      }
    }

    if (!email && !userId) {
      return res.status(400).json({ error: "No customer contact on file for this project." });
    }

    // ── Anti-spam throttle ─────────────────────────────────────────────────
    const THROTTLE_MS = 60 * 1000;
    const lastSent = project.lastCustomerNotifiedAt ? new Date(project.lastCustomerNotifiedAt).getTime() : 0;
    if (Date.now() - lastSent < THROTTLE_MS) {
      return res.status(429).json({
        error: "A customer notification was just sent. Please wait a minute before sending another.",
        retryAfterSeconds: Math.ceil((THROTTLE_MS - (Date.now() - lastSent)) / 1000),
      });
    }

    // ── Status-aware summary (same progress math as updateProjectProgress) ─
    const workOrders = await WorkOrder.find({ projectId: id }).select("unitCount completedUnitCount status").lean();
    const activeOrders = workOrders.filter((wo) => wo.status !== "cancelled");
    const completedUnits = activeOrders.reduce((sum, wo) => sum + Number(wo.completedUnitCount || 0), 0);
    const totalUnits = Math.max(Number(project.totalUnits) || 0, activeOrders.reduce((sum, wo) => sum + Number(wo.unitCount || 0), 0));
    const doneWO = activeOrders.filter((wo) => wo.status === "completed").length;

    const STATUS_COPY = {
      pending_project_scheduling: "Your project request has been received and is awaiting scheduling review.",
      accepted: "Your project has been accepted and is being prepared.",
      planning: "Our team is planning your project — assigning crew, materials and schedule.",
      ready: "Your project is fully scheduled. Work will begin on the planned start date.",
      in_progress: `Work is underway — ${completedUnits} of ${totalUnits} unit(s) completed.`,
      completed: "All work on your project is complete. Thank you for choosing us!",
      closed: "This project has been closed. Thank you for choosing us!",
      cancelled: "This project has been cancelled. Please contact us if you have questions.",
      on_hold: "Your project is temporarily on hold. We will update you as soon as it resumes.",
    };
    const statusLine = STATUS_COPY[project.status] || `Project status: ${String(project.status).replace(/_/g, " ")}.`;
    const serviceName = project.service?.name || "Large-Scale Project";
    const refLabel = project.projectCode || (project.bookingId ? `#${String(project.bookingId).slice(-8).toUpperCase()}` : `#${id.slice(-8).toUpperCase()}`);

    const fullMessage =
      `${statusLine}` +
      (doneWO > 0 ? ` (${doneWO}/${activeOrders.length} work order${activeOrders.length > 1 ? "s" : ""} finished.)` : "") +
      (customMessage ? ` Note from our team: ${customMessage}` : "");

    // ── Channel 1: in-app notification ─────────────────────────────────────
    let inAppSent = false;
    if (userId) {
      const notification = await createNotification({
        type: "project_status_update",
        title: `Project Update — ${serviceName}`,
        message: fullMessage,
        userId,
        referenceId: project._id,
        referenceModel: "Project",
        link: "/book-history",
        priority: project.status === "completed" ? "high" : "normal",
        io: req.app.get("io") || global.io || null,
      });
      inAppSent = !!notification;
    }

    // ── Channel 2: email ───────────────────────────────────────────────────
    let emailSent = false;
    if (email) {
      try {
        const mailer = require("../utils/mailer");
        const rows = [
          ["Project", `${serviceName} (${refLabel})`],
          ["Status", String(project.status).replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())],
          totalUnits > 0 ? ["Units Completed", `${completedUnits} / ${totalUnits}`] : null,
          project.plannedStartDate ? ["Planned Start", new Date(project.plannedStartDate).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric" })] : null,
          project.plannedCompletionDate ? ["Target Completion", new Date(project.plannedCompletionDate).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric" })] : null,
        ].filter(Boolean);
        const html =
          '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;">' +
          '<h2 style="color:#1e293b;font-size:18px;">Project Update — CALIDRO RACS</h2>' +
          `<p style="color:#334155;font-size:14px;">Hi ${customerName || "Customer"}, here is the latest update on your project:</p>` +
          '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
          rows.map(([k, v]) => `<tr><td style="padding:6px 10px;background:#f1f5f9;color:#475569;width:38%;">${k}</td><td style="padding:6px 10px;color:#1e293b;font-weight:600;">${v}</td></tr>`).join("") +
          "</table>" +
          `<p style="color:#334155;font-size:14px;margin-top:14px;">${fullMessage}</p>` +
          '<p style="color:#94a3b8;font-size:12px;margin-top:20px;">You can also track this project under your booking history.</p>' +
          "</div>";
        const text = [
          `Project Update — CALIDRO RACS`,
          `Hi ${customerName || "Customer"}, here is the latest update on your project:`,
          ...rows.map(([k, v]) => `${k}: ${v}`),
          fullMessage,
        ].join("\n");
        // sendEmail() wraps plain text in <p> tags — use sendMail directly
        // since this notification carries structured HTML.
        await mailer.sendMail({ to: email, subject: `Project Update — ${serviceName} (${refLabel})`, html, text });
        emailSent = true;
      } catch (mailErr) {
        console.error("[projects] notify-customer email failed:", mailErr.message);
      }
    }

    if (!inAppSent && !emailSent) {
      return res.status(502).json({ error: "Could not reach the customer through any channel. Please try again." });
    }

    await Project.findByIdAndUpdate(id, { lastCustomerNotifiedAt: new Date() }).catch(() => {});
    audit.logEvent({
      actor: req.user._id,
      actorRole: req.user.role || "",
      action: "project.notify_customer",
      module: "projects",
      req,
      entityType: "Project",
      entityId: project._id,
      details: { status: project.status, inAppSent, emailSent, email },
    }).catch(() => {});

    return res.json({
      success: true,
      message: inAppSent && emailSent ? "Customer notified via in-app and email." : inAppSent ? "Customer notified via in-app." : "Customer notified via email.",
      channels: { inApp: inAppSent, email: emailSent },
      email,
    });
  } catch (error) {
    console.error("Error notifying customer:", error);
    res.status(500).json({ error: "Failed to notify customer" });
  }
});

router.put("/projects/:id/status", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNotes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const validStatuses = [
      "pending_project_scheduling",
      "accepted",
      "planning",
      "ready",
      "in_progress",
      "completed",
      "closed",
      "cancelled",
      "on_hold",
    ];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    }

    const project = await Project.findById(id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (project.isLargeScale && ["accepted", "planning", "ready", "in_progress"].includes(status) && !project.verifiedAt) {
      return res.status(409).json({ error: "Verify this large-scale project before moving it into planning." });
    }
    const allowedTransitions = {
      pending_project_scheduling: ["on_hold", "cancelled"],
      accepted: ["planning", "ready", "on_hold", "cancelled"],
      planning: ["ready", "on_hold", "cancelled"],
      ready: ["planning", "on_hold", "cancelled"],
      in_progress: ["on_hold", "cancelled"],
      on_hold: ["planning", "cancelled"],
      completed: ["closed"],
      closed: [],
      cancelled: [],
    };
    if (status !== project.status && !(allowedTransitions[project.status] || []).includes(status)) {
      return res.status(409).json({
        error: `Project cannot move from "${project.status}" to "${status}" through the admin status control.`,
      });
    }
    if (status === "in_progress") {
      return res.status(409).json({ error: "Only the assigned lead technician can start a Ready project." });
    }
    if (status === "completed") {
      return res.status(409).json({ error: "Project completion must be finalized by the lead after proof-backed work-order review and payment settlement." });
    }
    if (status === "closed") {
      const readiness = await getProjectCompletionReadiness(project);
      if (!readiness.canClose) {
        return res.status(409).json({
          error: `Project cannot be closed: ${readiness.blockers.join(", ")}.`,
          completionReadiness: readiness,
        });
      }
    }
    project.status = status;
    if (adminNotes !== undefined) project.adminNotes = adminNotes;
    if (status === "in_progress" && !project.actualStartDate) {
      project.actualStartDate = new Date();
    }
    if (status === "in_progress" && project.isLargeScale && !project.projectPhase) {
      project.projectPhase = "assessment";
    }
    if (status === "completed") {
      project.actualCompletionDate = new Date();
    }
    if (status === "closed") {
      if (!project.actualCompletionDate) project.actualCompletionDate = new Date();
      project.closedAt = new Date();
    }
    // "Project Ready" gate: require the core planning outputs before the
    // project can move to the waiting (Ready) stage where techs receive it.
    if (status === "ready") {
      // The scheduling card stores the window as preferredStartDate /
      // preferredCompletionDeadline; fall back to those so the gate passes.
      const hasSchedule = project.plannedStartDate || project.preferredStartDate;
      if (!project.plannedStartDate && project.preferredStartDate) {
        project.plannedStartDate = project.preferredStartDate;
      }
      if (!project.plannedCompletionDate && project.preferredCompletionDeadline) {
        project.plannedCompletionDate = project.preferredCompletionDeadline;
      }
      const missing = [];
      if (!project.assignedTechnicians || project.assignedTechnicians.length === 0) missing.push("assign a team");
      // Team acceptance gate: all assigned technicians must accept
      const teamSt = project.teamStatus || [];
      const unaccepted = (project.assignedTechnicians || []).filter(t => {
        const tid = (t._id || t.id || '').toString();
        const ts = teamSt.find(s => (s._id || s.technicianId || '').toString() === tid);
        return !ts || ts.status !== 'acknowledged';
      });
      if (unaccepted.length > 0) {
        missing.push("team member acceptance — " + unaccepted.map(t => t.name || 'a tech').join(', ') + " have not accepted");
      }
      if (!hasSchedule) missing.push("set a project schedule");
      const workOrderCount = await WorkOrder.countDocuments({ projectId: project._id });
      if (workOrderCount === 0) missing.push("generate work orders");
      const bookingForPlan = project.bookingId ? await BookingService.findById(project.bookingId).lean() : null;
      const planningOrders = await WorkOrder.find({ projectId: project._id, status: { $ne: "cancelled" } });
      for (const order of planningOrders) {
        order.resourceRequirements = resourcesForWorkOrder(project.toObject(), order.toObject());
        await order.save();
      }
      const workOrderReadiness = await validateWorkOrderPlan(project.toObject(), bookingForPlan);
      if (!workOrderReadiness.ready) missing.push(...workOrderReadiness.errors);
      if (!project.schedulePlan || project.schedulePlan.status !== "ready") missing.push("generate a conflict-free project schedule");
      else {
        const scheduleValidation = await validateProjectSchedule(project.toObject());
        if (!scheduleValidation.valid) missing.push(...scheduleValidation.conflicts.filter(row => row.blocking).map(row => row.message));
      }
      // Batch coverage: every work order must belong to the assigned crew.
      // Units are claimed at execution time, not pre-assigned per technician.
      const cov = await WorkOrder.computeCoveredUnits(project._id);
      if (cov.unassignedWos > 0) missing.push("assign the project team to every work order");
      else if (cov.covered < cov.total) missing.push(`cover all ${cov.total} units with work-order batches`);

      // Recalculate the draft against the accepted team, current work orders,
      // schedule dates, inventory reservations, and equipment assignments.
      const evaluatedPlan = await evaluateProjectResources(project.toObject(), project.planningDraft?.resources || []);
      project.planningDraft.resources = evaluatedPlan.resources;
      project.planningDraft.readiness = evaluatedPlan.readiness;
      const activeResources = evaluatedPlan.resources.filter(resource => !["rejected", "optional"].includes(resource.recommendationState));
      const unreviewed = evaluatedPlan.resources.filter(resource => resource.recommendationState === "recommended");
      if (!activeResources.length) missing.push("review and accept at least one planned resource");
      if (unreviewed.length) missing.push(`review ${unreviewed.length} AI resource recommendation(s)`);
      if (evaluatedPlan.readiness.blockers.length) missing.push(...evaluatedPlan.readiness.blockers);
      
      if (missing.length) {
        return res.status(409).json({
          error: "Project is not ready yet. Complete: " + missing.join(", ") + ".",
          missing,
          coverage: cov,
        });
      }

      // Step 6 is the only resource commit point. Approved requirements are
      // converted to the existing reservation ledger exactly once.
      const existingReservations = await ProjectMaterial.find({ projectId: project._id, status: { $in: ["reserved", "fulfilled"] } }).lean();
      const reservedKeys = new Set(existingReservations.map(row => `${String(row.sourceId || "")}:${row.itemName.toLowerCase()}:${row.type}`));
      const touchedToolIds = new Set();
      for (const resource of activeResources) {
        const key = `${String(resource.toolId || "")}:${resource.itemName.toLowerCase()}:${resource.type}`;
        if (reservedKeys.has(key)) continue;
        await ProjectMaterial.create({
          projectId: project._id, type: cleanType(resource.type),
          scope: resource.type === "equipment" && resource.scope === "assigned" ? "assigned" : "shared",
          itemName: resource.itemName, quantity: resource.quantity, unit: resource.unit || "pcs",
          unitPrice: resource.type === "equipment" ? 0 : Number(resource.purchaseCost || 0),
          status: "reserved", notes: `Approved planning baseline: ${resource.reason || "project requirement"}`,
          source: resource.toolId ? "inventory" : "other", sourceId: resource.toolId || null,
        });
        if (resource.toolId) touchedToolIds.add(String(resource.toolId));
      }
      for (const toolId of touchedToolIds) await Tool.recomputeReserved(toolId);
      for (const resource of project.planningDraft.resources) {
        if (!["rejected", "optional"].includes(resource.recommendationState)) {
          resource.recommendationState = "confirmed";
          resource.readinessStatus = "confirmed";
        }
      }
      project.planningDraft.resourceHistory = project.planningDraft.resourceHistory || [];
      project.planningDraft.resourceHistory.push({ action: "planning_baseline_confirmed", after: { resourceCount: activeResources.length }, changedAt: new Date(), changedBy: req.user._id });
      project.planningDraft.baselineLocked = true;
      project.planningDraft.confirmedAt = new Date();
      project.planningDraft.confirmedBy = req.user._id;
      project.schedulePlan.status = "confirmed";
      project.schedulePlan.confirmedAt = new Date();
      project.scheduleLocked = true;
      const approvedCompletion = project.schedulePlan.targetEndDate || project.preferredCompletionDeadline || project.plannedCompletionDate;
      if (approvedCompletion) {
        project.scheduleGovernance.originalBaselineCompletionDate = project.scheduleGovernance.originalBaselineCompletionDate || approvedCompletion;
        project.scheduleGovernance.currentApprovedCompletionDate = project.scheduleGovernance.currentApprovedCompletionDate || approvedCompletion;
        project.scheduleGovernance.currentForecastCompletionDate = project.schedulePlan.estimatedEndDate || project.plannedCompletionDate || approvedCompletion;
        project.scheduleGovernance.riskStatus = recoveryRiskStatus(project.scheduleGovernance.currentForecastCompletionDate, project.scheduleGovernance.currentApprovedCompletionDate);
        project.scheduleGovernance.lastAssessedAt = new Date();
      }
      await DailyAssignment.updateMany({ projectId: project._id, planningOnly: true }, { $set: { planningOnly: false, status: "pending" } });
    }

    // Hand the work to the team: once the project is Ready (or Active) the
    // auto-generated work orders are released to the assigned technicians so
    // they appear in the lead's "Large-Scale Projects" tab on My Work.
    if ((status === "ready" || status === "in_progress")) {
      // Only dependency-free packages are released immediately. Dependant
      // packages remain scheduled drafts until their prerequisites complete.
      await WorkOrder.updateMany({ projectId: project._id, status: "pending", dependencies: { $not: { $size: 0 } } }, { $set: { assignmentProvisional: false } });
    }
    await project.save();
    if (status === "ready" || status === "in_progress") await releaseUnblockedWorkOrders(project._id);

    if (status === "ready") {
      const io = req.app.get("io");
      await createNotification({
        type: "project_plan_confirmed", title: "Project Plan Confirmed",
        message: `The plan for ${project.customer?.name || "a large-scale project"} is confirmed and work orders are released.`,
        role: "technician", referenceId: project._id, referenceModel: "Project",
        link: "/technician/assignments", io,
      }).catch(() => {});
    }

    if (project.bookingId) {
      const bookingStatusMap = {
        pending_project_scheduling: "pending_project_scheduling",
        accepted: "pending_project_scheduling",
        planning: "pending_project_scheduling",
        ready: "pending_project_scheduling",
        in_progress: "in-progress",
        completed: "completed",
        closed: "completed",
        cancelled: "cancelled",
        on_hold: "pending_project_scheduling",
      };
      if (bookingStatusMap[status]) {
        await BookingService.findByIdAndUpdate(project.bookingId, {
          status: bookingStatusMap[status],
        });
      }
    }

    // ── Cascade: complete Assignment records when project is completed/cancelled ──
    if (status === "completed" || status === "cancelled") {
      const assignmentTechIds = (project.assignedTechnicians || []).map(t => t._id).filter(Boolean);
      if (assignmentTechIds.length > 0) {
        await Assignment.updateMany(
          {
            $or: [
              { projectId: project._id },
              ...(project.bookingId ? [{ bookingId: project.bookingId }] : []),
            ],
            technicianId: { $in: assignmentTechIds },
            status: { $nin: ["completed", "cancelled"] },
          },
          { $set: { status: status === "completed" ? "completed" : "cancelled", completedAt: new Date() } }
        ).catch(() => {});
      }
    }

    await audit.logEvent({
      actor: req.user._id,
      target: project._id,
      action: "project.status_update",
      module: "admin",
      req,
      details: { status, adminNotes },
    }).catch(() => {});

    res.json({ project });
  } catch (error) {
    console.error("Error updating project status:", error);
    res.status(500).json({ error: "Failed to update project status" });
  }
});

/**
 * POST /api/projects/:id/verify
 * Admin verifies/accepts a LARGE-SCALE project (checks details & payment) before
 * it can proceed to planning. Mirrors the booking verify-payment / order accept flow.
 * Only large-scale projects in "pending_project_scheduling" are gated here.
 */
router.post("/projects/:id/verify", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    if (!project.isLargeScale || Number(project.totalUnits || 0) < schedulingEngine.LARGE_SCALE_MIN_UNITS) {
      return res.status(409).json({ error: "Only bookings with 8 to 40 units use the large-scale project verification flow." });
    }

    if (project.status !== "pending_project_scheduling") {
      return res.status(400).json({
        error: `Cannot verify a project in "${project.status}" status. Verification is only allowed while pending review.`,
      });
    }

    project.status = "accepted";
    project.verifiedBy = req.user._id;
    project.verifiedAt = new Date();
    if (req.body.adminNotes !== undefined) project.adminNotes = req.body.adminNotes;
    await project.save();

    // Keep the linked booking in the pending_project_scheduling bridge state.
    if (project.bookingId) {
      await BookingService.findByIdAndUpdate(project.bookingId, {
        status: "pending_project_scheduling",
      });
    }

    await audit.logEvent({
      actor: req.user._id,
      target: project._id,
      action: "project.verify",
      module: "admin",
      req,
      details: { status: "accepted", isLargeScale: true },
    }).catch(() => {});

    const io = req.app.get("io");
    await createNotification({
      type: "project_verified",
      title: "Large-Scale Project Verified",
      message: `Project for ${project.customer?.name || "customer"} was verified and accepted. Proceed to planning.`,
      role: "admin",
      referenceId: project._id,
      referenceModel: "Project",
      link: `/admin/projects/${project._id}`,
      io,
    }).catch(() => {});

    res.json({ project });
  } catch (error) {
    console.error("Error verifying project:", error);
    res.status(500).json({ error: "Failed to verify project" });
  }
});

/**
 * PUT /api/projects/:id/submit-inspection
 * Lead technician submits the site inspection report + quotation.
 * Transitions the project from assessment → quotation_review.
 */
router.put("/projects/:id/submit-inspection", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.isLargeScale) return res.status(400).json({ error: "Only large-scale projects use this flow" });
    if (project.projectPhase !== "assessment") {
      return res.status(400).json({ error: `Inspection can only be submitted during assessment phase (current: ${project.projectPhase})` });
    }
    if (!project.leadTechnicianId || project.leadTechnicianId.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Only the lead technician can submit the inspection report" });
    }

    const { notes, findings, photos, quotationItems, totalAmount, unitGroupInspections } = req.body || {};
    if (!["arrived", "completed"].includes(project.assessmentVisit?.status)) {
      return res.status(409).json({ error: "Record arrival at the customer site before submitting the inspection." });
    }
    if (!String(findings || "").trim()) {
      return res.status(400).json({ error: "Inspection findings are required." });
    }

    project.inspectionReport = {
      submittedAt: new Date(),
      notes: notes || "",
      findings: findings || "",
      photos: Array.isArray(photos) ? photos : [],
    };

    // ── Per-Unit-Group Inspection Data ─────────────────────────────────
    // When unitGroupInspections[] is provided, update each group's
    // inspection and quotation data independently.
    if (Array.isArray(unitGroupInspections) && unitGroupInspections.length > 0 && Array.isArray(project.unitGroups)) {
      for (const ugi of unitGroupInspections) {
        const groupIdx = Number(ugi.groupIndex);
        const group = project.unitGroups.find(g => g.groupIndex === groupIdx);
        if (!group) continue;

        // Update group inspection
        if (ugi.inspection) {
          group.inspection = {
            findings: ugi.inspection.findings || '',
            severity: ugi.inspection.severity || '',
            damagedParts: Array.isArray(ugi.inspection.damagedParts) ? ugi.inspection.damagedParts : [],
            recommendedAction: ugi.inspection.recommendedAction || '',
            technicianName: tech.name || '',
            completedAt: new Date(),
            photos: Array.isArray(ugi.inspection.photos) ? ugi.inspection.photos : [],
            notes: ugi.inspection.notes || '',
          };
        }

        // Update group quotation (only repair parts and consumables are billable)
        if (ugi.quotation) {
          const rawParts = Array.isArray(ugi.quotation.parts) ? ugi.quotation.parts : [];
          const toolIds = rawParts
            .filter(p => p.toolId && mongoose.Types.ObjectId.isValid(p.toolId))
            .map(p => p.toolId);
          const tools = toolIds.length ? await Tool.find({ _id: { $in: toolIds } }).select('type').lean() : [];
          const typeMap = new Map(tools.map(t => [String(t._id), t.type === 'tool' ? 'equipment' : (t.type || 'part')]));
          const groupParts = rawParts
            .filter(p => {
              if (!p.toolId) return true; // manual line items stay
              const t = typeMap.get(String(p.toolId));
              return t !== 'equipment';
            })
            .map(p => ({
              name: p.name || '',
              cost: Number(p.cost) || 0,
              quantity: Number(p.quantity) || 1,
              toolId: p.toolId || null,
              itemType: p.toolId ? (typeMap.get(String(p.toolId)) || 'part') : 'part',
              currentStock: 0,
              stockStatus: 'pending_check',
            }));
          group.quotation = {
            parts: groupParts,
            laborCost: Number(ugi.quotation.laborCost) || 0,
            laborCategory: ugi.quotation.laborCategory || 'standard',
            totalCost: Number(ugi.quotation.totalCost) || groupParts.reduce((s, p) => s + (p.cost * p.quantity), 0) + (Number(ugi.quotation.laborCost) || 0),
            notes: ugi.quotation.notes || '',
          };
        }

        // Update group diagnosis if provided
        if (ugi.diagnosis) {
          group.diagnosis = {
            summary: ugi.diagnosis.summary || '',
            confirmedDiagnoses: Array.isArray(ugi.diagnosis.confirmedDiagnoses) ? ugi.diagnosis.confirmedDiagnoses : [],
            laborCategory: ugi.diagnosis.laborCategory || 'standard',
            laborDuration: ugi.diagnosis.laborDuration || '',
            technicianName: tech.name || '',
            completedAt: new Date(),
          };
        }

        // Mark inspected units within the group
        if (Array.isArray(ugi.inspectedUnitIndices)) {
          for (const idx of ugi.inspectedUnitIndices) {
            const unit = group.units.find(u => u.unitIndex === idx);
            if (unit) {
              unit.status = 'inspected';
            }
          }
          group.inspectedUnits = group.units.filter(u => u.status === 'inspected' || u.status === 'completed').length;
        }
      }
    }

    // Build quotation review entry (combined from all groups or from top-level items)
    let items = [];
    let combinedTotal = 0;

    if (Array.isArray(project.unitGroups) && project.unitGroups.length > 0) {
      // Build quotation items from unitGroups
      for (const group of project.unitGroups) {
        if (group.quotation && group.quotation.totalCost > 0) {
          items.push({
            description: `${group.quantity}× ${group.unitType}${group.brand ? ' (' + group.brand + ')' : ''}`,
            quantity: group.quantity,
            unitPrice: Math.round((group.quotation.totalCost / group.quantity) * 100) / 100,
            total: group.quotation.totalCost,
            groupIndex: group.groupIndex,
          });
          combinedTotal += group.quotation.totalCost;
        }
      }
    }

    // Fall back to top-level quotationItems if no group-level data
    if (items.length === 0 && Array.isArray(quotationItems)) {
      items = quotationItems.map(item => ({
        description: item.description || "",
        quantity: Number(item.quantity) || 1,
        unitPrice: Number(item.unitPrice) || 0,
        total: (Number(item.quantity) || 1) * (Number(item.unitPrice) || 0),
      }));
      combinedTotal = items.reduce((s, i) => s + i.total, 0);
    }

    project.quotationReview = {
      totalAmount: Number(totalAmount) || combinedTotal || items.reduce((s, i) => s + i.total, 0),
      items,
      notes: notes || "",
      status: "pending",
    };
    project.projectPhase = "quotation_review";
    project.assessmentVisit = {
      ...(project.assessmentVisit?.toObject ? project.assessmentVisit.toObject() : project.assessmentVisit || {}),
      status: "completed",
      completedAt: new Date(),
      technicianId: tech._id,
    };
    await project.save();

    emitProjectPhase(req, project, "quotation_review");

    await createNotification({
      type: "project_inspection_submitted",
      title: "Inspection Report Submitted",
      message: `Lead ${tech.name} submitted the site inspection and quotation for project ${project._id}. Review and approve to begin execution.`,
      role: "admin",
      referenceId: project._id, referenceModel: "Project",
      link: `/admin/projects/${project._id}`,
      io: req.app.get("io"),
    }).catch(() => {});

    res.json({ project, phase: "quotation_review", message: "Inspection submitted — awaiting admin review" });
  } catch (error) {
    console.error("Error submitting inspection:", error);
    res.status(500).json({ error: "Failed to submit inspection" });
  }
});

/**
 * PUT /api/projects/:id/review-quotation
 * Admin approves or rejects the lead's quotation.
 * On approve: phase transitions to "execution" — the team can now mobilize for repair work.
 * On reject: phase goes back to "assessment" with a rejection reason.
 */
router.put("/projects/:id/review-quotation", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.isLargeScale) return res.status(400).json({ error: "Only large-scale projects use this flow" });
    if (project.projectPhase !== "quotation_review") {
      return res.status(400).json({ error: `Quotation can only be reviewed during quotation_review phase (current: ${project.projectPhase})` });
    }

    const { action, rejectionReason, notes } = req.body || {};
    if (action !== "approve" && action !== "reject") {
      return res.status(400).json({ error: 'Action must be "approve" or "reject"' });
    }
    if (action === "reject" && !String(rejectionReason || "").trim()) {
      return res.status(400).json({ error: "A rejection reason is required so the lead knows what to revise." });
    }

    if (action === "approve") {
      project.quotationReview = {
        ...project.quotationReview.toObject ? project.quotationReview.toObject() : project.quotationReview,
        status: "approved",
        reviewedAt: new Date(),
        reviewedBy: req.user._id,
        notes: notes || project.quotationReview.notes || "",
      };
      project.projectPhase = "execution";

      await createNotification({
        type: "project_quotation_approved",
        title: "Quotation Approved — Execution Ready",
        message: `The quotation for project ${project._id} was approved. The team can now mobilize for repair work.`,
        role: "technician",
        referenceId: project._id, referenceModel: "Project",
        link: "/technician/assignments",
        io: req.app.get("io"),
      }).catch(() => {});
    } else {
      project.quotationReview = {
        ...project.quotationReview.toObject ? project.quotationReview.toObject() : project.quotationReview,
        status: "rejected",
        reviewedAt: new Date(),
        reviewedBy: req.user._id,
        rejectionReason: rejectionReason || "",
        notes: notes || "",
      };
      project.projectPhase = "assessment";

      await createNotification({
        type: "project_quotation_rejected",
        title: "Quotation Needs Revision",
        message: `Lead, the quotation for project ${project._id} was rejected: ${rejectionReason || "Please revise and resubmit."}`,
        role: "technician",
        referenceId: project._id, referenceModel: "Project",
        link: "/technician/assignments",
        io: req.app.get("io"),
      }).catch(() => {});
    }

    await project.save();
    emitProjectPhase(req, project, project.projectPhase);

    res.json({ project, phase: project.projectPhase, message: action === "approve" ? "Quotation approved — execution phase started" : "Quotation rejected — returned to assessment" });
  } catch (error) {
    console.error("Error reviewing quotation:", error);
    res.status(500).json({ error: "Failed to review quotation" });
  }
});

router.put("/projects/:id", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const allowedFields = [
      "preferredStartDate", "preferredWorkingDays", "preferredWorkingHours",
      "preferredCompletionDeadline", "notes", "adminNotes", "projectManager",
      "actualStartDate", "actualCompletionDate",
    ];

    const project = await Project.findById(id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const scheduleFields = ["preferredStartDate", "preferredWorkingDays", "preferredWorkingHours", "preferredCompletionDeadline"];
    const changesSchedule = scheduleFields.some(field => req.body[field] !== undefined);
    const governedSchedule = project.schedulePlan?.status === "confirmed"
      || project.scheduleLocked
      || ["ready", "in_progress", "on_hold"].includes(project.status);
    if (changesSchedule && governedSchedule) {
      return res.status(409).json({
        code: "PROJECT_RECOVERY_REQUIRED",
        error: "This project schedule is approved and locked. Use the Recovery Plan workflow to revise future work or approve an extension.",
      });
    }

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        project[field] = req.body[field];
      }
    }

    await project.save();

    res.json({ project });
  } catch (error) {
    console.error("Error updating project:", error);
    res.status(500).json({ error: "Failed to update project" });
  }
});

// Update only the lead technician of a project (keeps the assigned team intact).
router.put("/projects/:id/lead", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { leadTechnicianId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    if (!mongoose.Types.ObjectId.isValid(leadTechnicianId)) return res.status(400).json({ error: "Invalid lead technician id" });

    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const onTeam = (project.assignedTechnicians || []).some((t) => t._id && t._id.toString() === leadTechnicianId.toString());
    if (!onTeam) return res.status(400).json({ error: "The lead must be one of the assigned technicians" });

    project.leadTechnicianId = leadTechnicianId;
    await project.save();

    const lead = (project.assignedTechnicians || []).find((t) => t._id && t._id.toString() === leadTechnicianId.toString());
    res.json({ project, message: `Lead updated to ${lead ? lead.name : "technician"}` });
  } catch (error) {
    console.error("Error updating lead:", error);
    res.status(500).json({ error: "Failed to update lead" });
  }
});

// Record / update the project's proof of payment.
router.put("/projects/:id/payment", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const { amountPaid, balanceAmount, totalAmount, paymentMethod, paymentStatus, proofUrl, proofNote } = req.body || {};
    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const pay = project.payment || {};
    if (amountPaid !== undefined) pay.amountPaid = Number(amountPaid) || 0;
    if (balanceAmount !== undefined) pay.balanceAmount = Number(balanceAmount) || 0;
    if (totalAmount !== undefined) pay.totalAmount = Number(totalAmount) || 0;
    if (paymentMethod !== undefined) pay.paymentMethod = String(paymentMethod || "").trim();
    if (paymentStatus !== undefined) pay.paymentStatus = ["unpaid", "partial", "paid", "refunded"].includes(paymentStatus) ? paymentStatus : pay.paymentStatus;
    if (proofUrl !== undefined) pay.proofUrl = String(proofUrl || "").trim();
    if (proofNote !== undefined) pay.proofNote = String(proofNote || "").trim();
    pay.recordedBy = req.user._id;
    pay.recordedAt = new Date();
    if (pay.amountPaid > 0) pay.paidAt = pay.paidAt || new Date();
    project.payment = pay;
    await project.save();
    res.json({ project, message: "Proof of payment saved" });
  } catch (error) {
    console.error("Error saving payment:", error);
    res.status(500).json({ error: "Failed to save payment" });
  }
});

router.post("/projects/:id/team", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { technicianIds, leadTechnicianId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    if (!Array.isArray(technicianIds) || technicianIds.length === 0) {
      return res.status(400).json({ error: "technicianIds must be a non-empty array" });
    }

    const project = await Project.findById(id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (project.isLargeScale && !project.verifiedAt) {
      return res.status(409).json({ error: "Verify the large-scale project before assigning its delivery team." });
    }
    if (!["accepted", "planning", "ready"].includes(project.status)) {
      return res.status(409).json({ error: `A team cannot be assigned while the project is "${project.status}".` });
    }

    const uniqueTechnicianIds = [...new Set(technicianIds.map(String))];
    if (uniqueTechnicianIds.some((techId) => !mongoose.Types.ObjectId.isValid(techId))) {
      return res.status(400).json({ error: "One or more technician ids are invalid" });
    }
    if (uniqueTechnicianIds.length !== technicianIds.length) {
      return res.status(400).json({ error: "Duplicate technicians are not allowed" });
    }
    if (leadTechnicianId && !uniqueTechnicianIds.includes(String(leadTechnicianId))) {
      return res.status(400).json({ error: "The lead technician must be part of the assigned team" });
    }

    const technicians = await Technician.find({
      _id: { $in: uniqueTechnicianIds },
      active: { $ne: false },
    }).lean();
    if (technicians.length !== uniqueTechnicianIds.length) {
      return res.status(400).json({ error: "Every selected technician must exist and be active" });
    }

    // Remove technicians no longer selected, then add the new ones.
    const incomingIds = technicians.map((t) => t._id.toString());
    const removed = project.assignedTechnicians.filter(
      (t) => !incomingIds.includes(t._id.toString())
    );
    for (const r of removed) {
      if (r.assignmentId) {
        await Assignment.findByIdAndUpdate(r.assignmentId, {
          status: "cancelled",
          cancelledAt: new Date(),
          projectId: project._id,
        }).catch(() => {});
      }
    }

    const assigned = [];
    for (const tech of technicians) {
      const existing = project.assignedTechnicians.find(
        (t) => t._id.toString() === tech._id.toString()
      );
      if (existing && existing.assignmentId) {
        const existingAssignment = await Assignment.findById(existing.assignmentId);
        if (existingAssignment) {
          existingAssignment.projectId = project._id;
          if (["declined", "expired", "cancelled"].includes(existingAssignment.status)) {
            existingAssignment.status = "pending_acceptance";
            existingAssignment.assignedAt = new Date();
            existingAssignment.acceptanceDeadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
            existingAssignment.declinedAt = undefined;
            existingAssignment.declineReason = undefined;
            existingAssignment.cancelledAt = undefined;
            existingAssignment.expiredAt = undefined;
            existingAssignment.expiredReason = undefined;
          }
          await existingAssignment.save();
        }
        assigned.push(existing);
        continue;
      }

      const slaDeadline = new Date();
      slaDeadline.setDate(slaDeadline.getDate() + 14);

      const assignment = new Assignment({
        bookingId: project.bookingId,
        projectId: project._id,
        technicianId: tech._id,
        customerName: project.customer?.name || "",
        customerPhone: project.customer?.phone || "",
        customerEmail: project.customer?.email || "",
        serviceName: project.service?.name || "Project",
        serviceType: "project",
        servicePrice: 0,
        bookingDate: project.preferredStartDate || project.createdAt,
        startTime: project.preferredWorkingHours?.start || "",
        endTime: project.preferredWorkingHours?.end || "",
        address: project.location?.address || project.customer?.address || "",
        priority: "normal",
        slaDeadline,
        estimatedFee: 0,
        status: "pending_acceptance",
      });
      await assignment.save();

      const entry = {
        _id: tech._id,
        name: tech.name || `${tech.firstName || ""} ${tech.lastName || ""}`.trim(),
        phone: tech.phone || tech.mobile || "",
        email: tech.email || "",
        assignmentId: assignment._id,
      };
      assigned.push(entry);

      // Notify the technician
      const { createNotification } = require("../utils/notify");
      const io = req.app.get("io");
      await createNotification({
        type: "assignment_new",
        title: "New Project Assignment",
        message: `You have been assigned to the project for ${project.customer?.name || "a customer"} (${project.service?.name || "service"}).`,
        userId: tech._id,
        role: "technician",
        referenceId: assignment._id,
        referenceModel: "Assignment",
        link: "/technician/assignments",
        priority: "high",
        io,
      }).catch(() => {});

      if (io) {
        io.to(`tech:${tech._id}`).emit("assignment:new", {
          bookingId: project.bookingId,
          serviceName: project.service?.name,
          customerName: project.customer?.name,
          bookingDate: project.preferredStartDate || project.createdAt,
          priority: "high",
          isProject: true,
        });
      }
    }

    project.assignedTechnicians = assigned;
    project.totalAssignedTechnicians = assigned.length;
    // Capacity reservation: assigned techs reserve that many per working day.
    project.reservedTechnicians = assigned.length;
    // Set lead technician (must be one of the assigned techs)
    if (leadTechnicianId && assigned.some(t => t._id.toString() === String(leadTechnicianId))) {
      project.leadTechnicianId = leadTechnicianId;
    } else if (assigned.length > 0) {
      project.leadTechnicianId = assigned[0]._id;
    } else {
      project.leadTechnicianId = undefined;
    }
    // ── Initialize team acceptance roster ─────────────────────────────────────
    // When the admin assigns a team, pre-populate teamStatus so the admin can
    // track which technicians have accepted/declined. Every crew member,
    // including the lead, explicitly accepts participation before Step 6.
    project.teamStatus = assigned.map((t) => ({
      _id: t._id,
      name: t.name || "Technician",
      status: "notified",
      notifiedAt: new Date(),
      acknowledgedAt: undefined,
    }));

    // A project team is the work-order assignee. Keep every unreleased batch
    // in sync when the roster changes instead of forcing per-WO assignment.
    const workOrderTeam = assigned.map(t => ({
      _id: t._id, name: t.name, phone: t.phone, assignedUnits: 0,
    }));
    await WorkOrder.updateMany(
      { projectId: project._id, status: { $nin: ["completed", "cancelled"] } },
      { $set: {
        assignedTechnicians: workOrderTeam,
        suggestedTechnicians: workOrderTeam,
        requiredTechnicianCount: Math.max(1, Math.min(assigned.length || 1, Number(project.dailyRequiredTechnicians || assigned.length || 1))),
        assignmentProvisional: project.status !== "ready",
      } }
    );

    // Large-scale projects must be verified/accepted before planning.
    if (project.status === "pending_project_scheduling" && !project.isLargeScale) {
      project.status = "planning";
    }
    // Team assignment does not lock planning. The schedule is locked only by
    // Step 6, after readiness checks and explicit plan confirmation.
    if (assigned.length > 0 && (project.plannedStartDate || project.preferredStartDate)) {
      project.plannedStartDate = project.plannedStartDate || project.preferredStartDate;
    }
    if (project.schedulePlan?.status !== "confirmed") project.scheduleLocked = false;

    // ── Daily allocation check ───────────────────────────────────────────────
    // Build the schedule AROUND existing commitments. If the assigned team
    // cannot cover the required daily reservation on any working day, return
    // a structured conflict list with rule-based suggestions. We NEVER
    // auto-cancel or move an existing booking.
    let conflicts = [];
    try {
      const cal = await buildAllocationCalendar(project._id, {
        candidateTechIds: assigned.map((t) => t._id),
      });
      conflicts = cal.conflicts || [];
    } catch (calErr) {
      console.warn("Allocation calendar check skipped:", calErr.message);
    }

    if (conflicts.length > 0) {
      // Do not silently over-commit. Save the team but flag the conflict
      // so the admin can resolve it (add tech / extend / reschedule).
      await project.save();
      return res.status(409).json({
        conflict: true,
        project,
        technicians,
        conflicts,
        message:
          "Team assigned, but the schedule has daily capacity conflicts. " +
          "Standard bookings are protected — resolve using the suggested options.",
      });
    }

    await project.save();

    // ── Real-time: notify admin that team was assigned (triggers UI refresh) ──
    const ioTeam = req.app.get("io");
    if (ioTeam) {
      ioTeam.to("admin-room").emit("project:team-status", {
        projectId: project._id,
        teamStatus: project.teamStatus,
        assignedCount: assigned.length,
      });
    }

    await audit.logEvent({
      actor: req.user._id,
      target: project._id,
      action: "project.team_assigned",
      module: "admin",
      req,
      details: { technicianIds, technicianNames: technicians.map((t) => t.name) },
    }).catch(() => {});

    res.json({
      project,
      technicians,
      conflicts: [],
      message: `${assigned.length} technician(s) assigned to project team`,
    });
  } catch (error) {
    console.error("Error assigning project team:", error);
    res.status(500).json({ error: "Failed to assign project team" });
  }
});

router.get("/projects/:id/eligible-technicians", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const project = await Project.findById(id).lean();
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const technicians = await Technician.find({ active: { $ne: false } })
      .select("name phone email rating availabilityStatus")
      .lean();

    // ── Availability during the project's date span ───────────────────────
    // The assignment team should see, per technician, whether they are free
    // across the project's planned working days. We check three conflict
    // sources: (1) another project already reserving them on overlapping
    // dates, (2) approved leave covering any project day, (3) fixed
    // standard bookings already on those working days.
    const BookingService = require("../models/BookingService");
    const LeaveRequest = require("../models/LeaveRequest");
    const spanStart = project.plannedStartDate || project.preferredStartDate;
    const spanEnd = project.plannedCompletionDate || project.preferredCompletionDeadline;
    const projectDays = [];
    if (spanStart && spanEnd) {
      const cur = new Date(spanStart);
      cur.setHours(0, 0, 0, 0);
      const end = new Date(spanEnd);
      end.setHours(23, 59, 59, 999);
      while (cur <= end) {
        const dow = cur.getDay();
        // Company working weekdays (Mon/Wed/Thu/Fri) — mirrors scheduleRoutes.
        if ([1, 3, 4, 5].includes(dow)) projectDays.push(new Date(cur));
        cur.setDate(cur.getDate() + 1);
      }
    }

    const BOOKING_ACTIVE = ["pending", "payment_verified", "awaiting_assignment", "assigned", "pending_reassignment", "confirmed", "scheduled", "on-the-way", "arrived", "in-progress"];

    for (const t of technicians) {
      t.availableDuringProject = true;
      t.conflictReason = "";
      if (projectDays.length === 0) continue; // no planned span → can't assess

      const dayStart = projectDays[0];
      const dayEnd = projectDays[projectDays.length - 1];
      dayEnd.setHours(23, 59, 59, 999);

      // (1) Other projects reserving this tech on overlapping dates.
      const clashProject = await Project.findOne({
        _id: { $ne: project._id },
        status: { $in: ["planning", "in_progress", "on_hold", "accepted"] },
        $or: [
          { plannedStartDate: { $lte: dayEnd }, plannedCompletionDate: { $gte: dayStart } },
          { preferredStartDate: { $lte: dayEnd }, preferredCompletionDeadline: { $gte: dayStart } },
        ],
        "assignedTechnicians._id": t._id,
      }).lean();
      if (clashProject) {
        t.availableDuringProject = false;
        t.conflictReason = "Reserved by another project on overlapping dates";
        continue;
      }

      // (2) Approved leave covering any project day.
      const leave = await LeaveRequest.findOne({
        technicianId: t._id,
        status: "approved",
        startDate: { $lte: dayEnd },
        endDate: { $gte: dayStart },
      }).lean();
      if (leave) {
        t.availableDuringProject = false;
        t.conflictReason = "On approved leave during the project span";
        continue;
      }

      // (3) Fixed standard bookings already on project working days.
      const dayRanges = projectDays.map((d) => {
        const s = new Date(d); s.setHours(0, 0, 0, 0);
        const e = new Date(d); e.setHours(23, 59, 59, 999);
        return { $gte: s, $lte: e };
      });
      const busyBookings = await BookingService.countDocuments({
        technicianId: t._id,
        $or: dayRanges.map((r) => ({ bookingDate: r })),
        status: { $in: BOOKING_ACTIVE },
      });
      if (busyBookings > 0) {
        t.availableDuringProject = false;
        t.conflictReason = `${busyBookings} fixed booking(s) on project working day(s)`;
        continue;
      }
    }

    res.json({ technicians, projectSpan: spanStart && spanEnd ? { start: spanStart, end: spanEnd, workingDays: projectDays.length } : null });
  } catch (error) {
    console.error("Error fetching eligible technicians:", error);
    res.status(500).json({ error: "Failed to fetch eligible technicians" });
  }
});

/**
 * GET /api/projects/:id/allocation-calendar
 * Builds the DAILY resource-allocation calendar for a project: per working
 * day, company capacity vs. technicians already committed to standard
 * bookings / approved leave / other projects, plus a per-tech day matrix.
 * This is how the system schedules AROUND existing commitments.
 */
router.get("/projects/:id/allocation-calendar", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }
    const calendar = await buildAllocationCalendar(id);
    res.json(calendar);
  } catch (error) {
    console.error("Error building allocation calendar:", error);
    res.status(500).json({ error: "Failed to build allocation calendar" });
  }
});

/**
 * GET /api/projects/:id/technician-conflicts
 * Returns each assigned technician's busy dates across the project's customer
 * window (standard bookings, approved leave, reservations on other projects)
 * so the admin schedule modal can flag double-booking before saving.
 */
router.get("/projects/:id/technician-conflicts", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }
    const conflicts = await getTechnicianScheduleConflicts(id);
    res.json(conflicts);
  } catch (error) {
    console.error("Error building technician conflicts:", error);
    res.status(500).json({ error: "Failed to build technician conflicts" });
  }
});

/**
 * GET /api/projects/:id/schedule-calendar
 * Calendar-ready payload for the admin schedule wizard: the per-day allocation
 * matrix (technician availability) plus each work order's current scheduled date.
 */
router.get("/projects/:id/schedule-calendar", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }
    const calendar = await buildAllocationCalendar(id);
    const wos = await WorkOrder.find({ projectId: id }).select("_id title section assignedTechnicians scheduledDate sortOrder status").lean();
    // Local-calendar key (server timezone) — toISOString().slice(0,10)
    // shifts local-midnight dates one day back under UTC+8 (PH).
    const localKey = (value) => {
      const d = value ? new Date(value) : null;
      if (!d || isNaN(d.getTime())) return "";
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const workOrders = wos
      .map((w) => ({
        _id: String(w._id),
        title: w.title || w.section || "Work Order",
        section: w.section || "",
        technicianId: w.assignedTechnicians && w.assignedTechnicians[0] ? String(w.assignedTechnicians[0]._id || w.assignedTechnicians[0]) : "",
        technicianName: w.assignedTechnicians && w.assignedTechnicians[0] ? (w.assignedTechnicians[0].name || "Unassigned") : "Unassigned",
        scheduledDate: localKey(w.scheduledDate),
        sortOrder: w.sortOrder || 0,
        status: w.status,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
    res.json({ calendar, workOrders });
  } catch (error) {
    console.error("Error building schedule calendar:", error);
    res.status(500).json({ error: "Failed to build schedule calendar" });
  }
});

const projectScheduler = require("../utils/projectScheduler");

/**
 * GET /api/projects/:id/schedule-preview
 * Read-only per-day assignment preview built by the auto-scheduler, WITHOUT
 * persisting. Shows which technicians are assigned to the project each working
 * day and any conflicts. Admin confirms with POST /generate-schedule.
 */
router.get("/projects/:id/schedule-preview", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await Project.findById(id).lean();
    if (!project) return res.status(404).json({ error: "Project not found" });
    const avail = await projectScheduler.buildDailyAvailability(project);
    if (!avail) return res.json({ schedule: [], conflicts: [], message: "No valid working span" });
    res.json({
      dailyRequired: avail.dailyRequired,
      teamSize: avail.team.length,
      workingDays: avail.workingDays.length,
      preview: Object.values(avail.matrix).map((m) => ({
        date: m.date,
        technicians: m.available,
        shortfall: m.shortfall,
        conflicts: m.conflicts,
      })),
    });
  } catch (error) {
    console.error("Error building schedule preview:", error);
    res.status(500).json({ error: "Failed to build schedule preview" });
  }
});

router.post("/projects/:id/schedule-preview", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const avail = await projectScheduler.buildDailyAvailability(project.toObject());
    const preview = avail ? Object.values(avail.matrix).map(row => ({ date: row.date, technicians: row.available, shortfall: row.shortfall || 0, conflicts: row.conflicts || [] })) : [];
    project.planningDraft = project.planningDraft || {};
    project.planningDraft.schedulePreview = preview;
    project.planningDraft.updatedAt = new Date();
    project.planningDraft.updatedBy = req.user._id;
    await project.save();
    res.json({ preview, workingDays: preview.length, message: "Provisional schedule saved for planning review." });
  } catch (error) {
    console.error("Error saving schedule preview:", error);
    res.status(500).json({ error: error.message || "Failed to save schedule preview" });
  }
});

/**
 * POST /api/projects/:id/generate-schedule
 * One-click auto-schedule: assigns available technicians to each working day
 * and creates their daily assignments. Never overwrites confirmed bookings.
 */
router.post("/projects/:id/generate-schedule", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.schedulePlan?.status === "confirmed") return res.status(409).json({ error: "The confirmed project schedule is locked." });
    const booking = project.bookingId ? await BookingService.findById(project.bookingId).lean() : null;
    const readiness = await validateWorkOrderPlan(project.toObject(), booking);
    if (!readiness.ready) return res.status(409).json({ error: `Work Orders are not ready: ${readiness.errors.join("; ")}`, readiness });
    const scheduleOptions = { ...(req.body || {}) };
    if (req.body?.workOrderOverrides) scheduleOptions.workOrderOverrides = { ...(project.schedulePlan?.manualOverrides || {}), ...req.body.workOrderOverrides };
    const result = await generateProjectSchedule(project.toObject(), scheduleOptions);
    if (req.body?.workOrderOverrides && result.status === "blocked") {
      const adjustedIds = new Set(Object.keys(req.body.workOrderOverrides));
      const adjustmentConflicts = result.conflicts.filter(row => row.blocking && (!row.workOrderId || adjustedIds.has(String(row.workOrderId))));
      if (adjustmentConflicts.length) return res.status(409).json({ error: `Cannot apply the manual adjustment: ${adjustmentConflicts.map(row => row.message).join("; ")}`, conflicts: result.conflicts });
    }
    await DailyAssignment.deleteMany({ projectId: project._id, generatedBy: "system", status: { $in: ["pending", "in_progress"] } });
    if (result.allocations.length) await DailyAssignment.insertMany(result.allocations);
    const orders = await WorkOrder.find({ projectId: project._id, status: { $ne: "cancelled" } });
    for (const order of orders) {
      const rows = result.allocations.filter(row => String(row.workOrderId) === String(order._id)).sort((a,b)=>new Date(a.date)-new Date(b.date));
      order.assignedTechnicians = (project.assignedTechnicians || []).map(member => ({
        _id: member._id, name: member.name, phone: member.phone, assignedUnits: 0,
      }));
      order.scheduledDate = rows[0]?.date || null;
      order.scheduledEndDate = rows[rows.length-1]?.date || null;
      order.startTime = rows[0]?.startTime || null;
      order.endTime = rows[rows.length-1]?.endTime || null;
      order.planningStatus = rows.length ? "scheduled" : "draft";
      order.scheduleConflicts = result.conflicts.filter(conflict => String(conflict.workOrderId || "") === String(order._id));
      order.activity.push({ action: "schedule_generated", actorId: req.user._id, actorName: req.user.name || req.user.email || req.user.role, details: { days: [...new Set(rows.map(row=>dayKeyForRoute(row.date)))], status: result.status } });
      await order.save();
    }
    project.plannedStartDate = result.startDate;
    project.plannedCompletionDate = result.estimatedEndDate;
    project.schedulePlan = {
      status: result.status, startDate: result.startDate, estimatedEndDate: result.estimatedEndDate,
      targetEndDate: req.body?.targetEndDate || project.preferredCompletionDeadline || null,
      executionEndDate: result.executionEndDate, workingDays: result.workingDays,
      workingHours: result.workingHours, bufferDays: result.bufferDays,
      qualityScore: result.qualityScore, conflicts: result.conflicts,
      dailySummary: result.dailySummary, generatedAt: new Date(), generatedBy: req.user._id,
      manualOverrides: scheduleOptions.workOrderOverrides || {},
    };
    project.scheduleLocked = false;
    await project.save();
    await audit.logEvent({ actor:req.user._id,target:project._id,action:"project.schedule_generated",module:"projects",req,details:{referenceModel:"Project",referenceId:project._id,status:result.status,qualityScore:result.qualityScore,conflicts:result.conflicts.length} });
    res.json({ ...result, message: result.status === "ready" ? `Schedule ready across ${result.dailySummary.length} working day(s).` : `Schedule generated with ${result.conflicts.length} blocking conflict(s).` });
  } catch (error) {
    console.error("Error generating schedule:", error);
    res.status(500).json({ error: error.message || "Failed to generate schedule" });
  }
});

function dayKeyForRoute(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

router.put("/projects/:id/schedule-settings", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.schedulePlan?.status === "confirmed") return res.status(409).json({ error: "The confirmed schedule is locked." });
    const startDate = req.body.startDate ? new Date(req.body.startDate) : project.preferredStartDate;
    if (!startDate || Number.isNaN(startDate.getTime())) return res.status(400).json({ error: "Valid project start date is required." });
    const targetEndDate = req.body.targetEndDate ? new Date(req.body.targetEndDate) : null;
    if (targetEndDate && targetEndDate < startDate) return res.status(400).json({ error: "Target end date cannot be before project start." });
    const workingDays = normalizeWorkingDays(req.body.workingDays, []);
    if (!workingDays.length) return res.status(400).json({ error: "Select at least one working day." });
    project.preferredStartDate = startDate; project.preferredCompletionDeadline = targetEndDate;
    project.preferredWorkingDays = workingDays.map(String);
    project.preferredWorkingHours = { start:req.body.startTime || "09:00", end:req.body.endTime || "17:00" };
    project.schedulePlan = { ...(project.schedulePlan?.toObject?.() || project.schedulePlan || {}), status:"not_generated", startDate, targetEndDate, workingDays, workingHours:project.preferredWorkingHours, bufferDays:Math.max(0,Math.min(10,Number(req.body.bufferDays)||0)), conflicts:[], dailySummary:[], qualityScore:0, manualOverrides:{} };
    await project.save();
    res.json({ schedulePlan:project.schedulePlan,message:"Scheduling parameters saved. Generate a new preview to calculate the end date." });
  } catch(error){res.status(500).json({error:error.message||"Failed to save schedule settings"});}
});

async function buildRecoveryProposal(project, body) {
  const request = normalizeRecoveryRequest(body, project);
  const result = await generateProjectSchedule(project.toObject ? project.toObject() : project, {
    startDate: request.recoveryStartDate,
    targetEndDate: request.revisedCompletionDate,
    workingDays: request.workingDays,
    startTime: request.startTime,
    endTime: request.endTime,
    bufferDays: project.schedulePlan?.bufferDays || 0,
    remainingOnly: true,
    planningOnly: false,
  });
  const affectedWorkOrderIds = [...new Set((result.allocations || []).map(row => String(row.workOrderId)))];
  return { request, result, affectedWorkOrderIds };
}

/** Preview a recovery against live technician, booking, leave, and equipment capacity. */
router.post("/projects/:id/recovery-plan/preview", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid project id." });
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found." });
    if (!["ready", "in_progress", "on_hold"].includes(project.status)) return res.status(409).json({ error: "Recovery planning is available only for ready, active, or on-hold projects." });
    if (req.body?.mode === "extend" && req.user.role !== "admin") return res.status(403).json({ error: "Only an administrator can approve a completion-date extension." });
    const proposal = await buildRecoveryProposal(project, req.body || {});
    const blockingConflicts = (proposal.result.conflicts || []).filter(conflict => conflict.blocking);
    return res.json({
      viable: blockingConflicts.length === 0 && proposal.result.status === "ready",
      mode: proposal.request.mode,
      originalBaselineCompletionDate: proposal.request.originalBaselineCompletionDate,
      previousApprovedCompletionDate: proposal.request.previousApprovedCompletionDate,
      revisedApprovedCompletionDate: proposal.request.revisedCompletionDate,
      forecastBefore: proposal.request.forecastBefore,
      forecastAfter: proposal.result.estimatedEndDate,
      executionEndDate: proposal.result.executionEndDate,
      affectedWorkOrders: proposal.affectedWorkOrderIds.length,
      workingDays: proposal.result.dailySummary?.length || 0,
      qualityScore: proposal.result.qualityScore,
      conflicts: proposal.result.conflicts || [],
      message: blockingConflicts.length
        ? `The proposal has ${blockingConflicts.length} blocking conflict(s). Resolve them before approval.`
        : "The recovery proposal is conflict-free and ready for approval.",
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "Failed to preview the recovery plan." });
  }
});

/**
 * Apply a governed recovery revision. Historical/completed daily assignments
 * remain immutable; only unfinished assignments on or after the recovery date
 * are replaced by the validated proposal.
 */
router.post("/projects/:id/recovery-plan", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  let session;
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid project id." });
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found." });
    if (!["ready", "in_progress", "on_hold"].includes(project.status)) return res.status(409).json({ error: "Recovery planning is available only for ready, active, or on-hold projects." });
    if (req.body?.mode === "extend" && req.user.role !== "admin") return res.status(403).json({ error: "Only an administrator can approve a completion-date extension." });

    const proposal = await buildRecoveryProposal(project, req.body || {});
    const blockingConflicts = (proposal.result.conflicts || []).filter(conflict => conflict.blocking);
    if (blockingConflicts.length || proposal.result.status !== "ready") {
      return res.status(409).json({ error: "This recovery plan still has blocking schedule conflicts.", conflicts: proposal.result.conflicts || [], forecastAfter: proposal.result.estimatedEndDate });
    }

    const now = new Date();
    const initialVersion = project.__v;
    let historyId = null;
    let revisionSnapshot = null;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const lockedProject = await Project.findOne({ _id: project._id, __v: initialVersion }).session(session);
      if (!lockedProject) throw Object.assign(new Error("The project changed while the recovery plan was being reviewed. Refresh and preview it again."), { status: 409 });

      await DailyAssignment.deleteMany({
        projectId: lockedProject._id,
        date: { $gte: proposal.request.recoveryStartDate },
        status: { $ne: "completed" },
      }).session(session);
      if (proposal.result.allocations.length) await DailyAssignment.insertMany(proposal.result.allocations, { session });

      const workOrders = await WorkOrder.find({ projectId: lockedProject._id, status: { $ne: "cancelled" } }).session(session);
      for (const order of workOrders) {
        if (order.status === "completed" || Number(order.completedUnitCount || 0) >= Number(order.unitCount || 0)) continue;
        const rows = proposal.result.allocations
          .filter(row => String(row.workOrderId) === String(order._id))
          .sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.startTime || "").localeCompare(String(b.startTime || "")));
        if (!rows.length) continue;
        const before = { scheduledDate: order.scheduledDate, scheduledEndDate: order.scheduledEndDate, startTime: order.startTime, endTime: order.endTime };
        if (!Number(order.completedUnitCount || 0)) order.scheduledDate = rows[0].date;
        order.scheduledEndDate = rows[rows.length - 1].date;
        order.startTime = rows[0].startTime;
        order.endTime = rows[rows.length - 1].endTime;
        order.planningStatus = "released";
        order.scheduleConflicts = [];
        order.activity.push({
          action: proposal.request.mode === "extend" ? "schedule_extended" : "schedule_recovered",
          actorId: req.user._id,
          actorName: req.user.name || req.user.email || req.user.role,
          reason: proposal.request.reason,
          details: { before, recoveryStartDate: proposal.request.recoveryStartDate, scheduledEndDate: order.scheduledEndDate },
        });
        await order.save({ session });
      }

      const governance = lockedProject.scheduleGovernance || {};
      const revisionNumber = Math.max(0, Number(governance.revisionNumber || 0)) + 1;
      const previousDailySummary = lockedProject.schedulePlan?.dailySummary || [];
      lockedProject.schedulePlan = {
        ...(lockedProject.schedulePlan?.toObject?.() || lockedProject.schedulePlan || {}),
        status: "confirmed",
        startDate: lockedProject.schedulePlan?.startDate || lockedProject.plannedStartDate || lockedProject.preferredStartDate,
        estimatedEndDate: proposal.result.estimatedEndDate,
        targetEndDate: proposal.request.revisedCompletionDate,
        executionEndDate: proposal.result.executionEndDate,
        workingDays: proposal.result.workingDays,
        workingHours: proposal.result.workingHours,
        conflicts: proposal.result.conflicts || [],
        qualityScore: proposal.result.qualityScore,
        dailySummary: mergeDailySummaries(previousDailySummary, proposal.result.dailySummary, proposal.request.recoveryStartDate),
        generatedAt: now,
        generatedBy: req.user._id,
        confirmedAt: now,
      };
      lockedProject.scheduleLocked = true;
      lockedProject.plannedCompletionDate = proposal.result.estimatedEndDate;
      if (proposal.request.mode === "extend") lockedProject.preferredCompletionDeadline = proposal.request.revisedCompletionDate;
      lockedProject.preferredWorkingDays = proposal.request.workingDays.map(String);
      lockedProject.preferredWorkingHours = { start: proposal.request.startTime, end: proposal.request.endTime };
      lockedProject.scheduleGovernance.originalBaselineCompletionDate = governance.originalBaselineCompletionDate || proposal.request.originalBaselineCompletionDate;
      lockedProject.scheduleGovernance.currentApprovedCompletionDate = proposal.request.revisedCompletionDate;
      lockedProject.scheduleGovernance.currentForecastCompletionDate = proposal.result.estimatedEndDate;
      lockedProject.scheduleGovernance.riskStatus = recoveryRiskStatus(proposal.result.estimatedEndDate, proposal.request.revisedCompletionDate);
      lockedProject.scheduleGovernance.revisionNumber = revisionNumber;
      lockedProject.scheduleGovernance.lastAssessedAt = now;
      lockedProject.scheduleGovernance.lastRecoveryAt = now;
      lockedProject.scheduleGovernance.history.push({
        revisionNumber,
        action: proposal.request.mode === "extend" ? "extension" : "recovery",
        reasonCategory: proposal.request.reasonCategory,
        reason: proposal.request.reason,
        impactSummary: proposal.request.impactSummary,
        originalBaselineCompletionDate: proposal.request.originalBaselineCompletionDate,
        previousApprovedCompletionDate: proposal.request.previousApprovedCompletionDate,
        revisedApprovedCompletionDate: proposal.request.revisedCompletionDate,
        forecastBefore: proposal.request.forecastBefore,
        forecastAfter: proposal.result.estimatedEndDate,
        recoveryStartDate: proposal.request.recoveryStartDate,
        affectedWorkOrderIds: proposal.affectedWorkOrderIds,
        approvedBy: req.user._id,
        approvedByName: req.user.name || req.user.email || "Administrator",
        approvedAt: now,
        customerNotification: { requested: proposal.request.notifyCustomer, status: proposal.request.notifyCustomer ? "pending" : "not_requested" },
      });
      await lockedProject.save({ session });
      const entry = lockedProject.scheduleGovernance.history[lockedProject.scheduleGovernance.history.length - 1];
      historyId = entry._id;
      revisionSnapshot = entry.toObject ? entry.toObject() : entry;
    });

    const refreshedProject = await Project.findById(project._id);
    let customerNotification = { status: "not_requested", inAppSent: false, emailSent: false };
    if (refreshedProject && revisionSnapshot) customerNotification = await notifyCustomerOfRecovery(refreshedProject, revisionSnapshot, req);
    if (historyId) {
      const notificationSet = {
        "scheduleGovernance.history.$.customerNotification.status": customerNotification.status,
        "scheduleGovernance.history.$.customerNotification.inAppSent": Boolean(customerNotification.inAppSent),
        "scheduleGovernance.history.$.customerNotification.emailSent": Boolean(customerNotification.emailSent),
        "scheduleGovernance.history.$.customerNotification.sentAt": customerNotification.sentAt || null,
        "scheduleGovernance.history.$.customerNotification.error": customerNotification.error || "",
      };
      if (["sent", "partial"].includes(customerNotification.status)) notificationSet.lastCustomerNotifiedAt = customerNotification.sentAt || new Date();
      await Project.updateOne({ _id: project._id, "scheduleGovernance.history._id": historyId }, { $set: notificationSet });
    }
    await audit.logEvent({
      actor: req.user._id,
      actorRole: req.user.role,
      target: project._id,
      action: proposal.request.mode === "extend" ? "project.schedule_extension.approved" : "project.schedule_recovery.approved",
      module: "projects",
      req,
      details: {
        revisionNumber: revisionSnapshot?.revisionNumber,
        originalBaselineCompletionDate: proposal.request.originalBaselineCompletionDate,
        previousApprovedCompletionDate: proposal.request.previousApprovedCompletionDate,
        revisedApprovedCompletionDate: proposal.request.revisedCompletionDate,
        forecastAfter: proposal.result.estimatedEndDate,
        affectedWorkOrders: proposal.affectedWorkOrderIds,
        customerNotification,
      },
    }).catch(() => {});
    return res.json({
      success: true,
      message: proposal.request.mode === "extend" ? "Schedule extension approved and future work rescheduled." : "Recovery schedule approved without changing the committed completion date.",
      revisionNumber: revisionSnapshot?.revisionNumber,
      forecastAfter: proposal.result.estimatedEndDate,
      approvedCompletionDate: proposal.request.revisedCompletionDate,
      affectedWorkOrders: proposal.affectedWorkOrderIds.length,
      customerNotification,
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || "Failed to approve the recovery plan." });
  } finally {
    if (session) await session.endSession().catch(() => {});
  }
});

router.get("/projects/:id/schedule-plan", auth.requireRole(["admin", "secretary"]), async (req,res)=>{
  try{
    const project=await Project.findById(req.params.id).lean();if(!project)return res.status(404).json({error:"Project not found"});
    const assignments=await DailyAssignment.find({projectId:project._id}).sort({date:1,startTime:1}).lean();
    const orders=await WorkOrder.find({projectId:project._id,status:{$ne:"cancelled"}}).sort({sortOrder:1}).lean();
    res.json({schedulePlan:project.schedulePlan||{},assignments,workOrders:orders});
  }catch(error){res.status(500).json({error:"Failed to load schedule plan"});}
});

router.post("/projects/:id/schedule-readiness", auth.requireRole(["admin", "secretary"]), async(req,res)=>{
  try{const project=await Project.findById(req.params.id);if(!project)return res.status(404).json({error:"Project not found"});const result=await validateProjectSchedule(project.toObject());project.schedulePlan.status=result.status;project.schedulePlan.qualityScore=result.qualityScore;project.schedulePlan.conflicts=result.conflicts;project.schedulePlan.dailySummary=result.dailySummary;await project.save();res.json({readiness:result});}catch(error){res.status(500).json({error:error.message||"Failed to validate schedule"});}
});

router.put("/work-orders/:id/schedule", auth.requireRole(["admin", "secretary"]), async(req,res)=>{
  try{
    const order=await WorkOrder.findById(req.params.id);if(!order)return res.status(404).json({error:"Work order not found"});
    const project=await Project.findById(order.projectId);if(project.schedulePlan?.status==="confirmed")return res.status(409).json({error:"The confirmed schedule is locked."});
    const before={scheduledDate:order.scheduledDate,scheduledEndDate:order.scheduledEndDate,startTime:order.startTime,endTime:order.endTime,assignedTechnicians:order.assignedTechnicians};
    if(req.body.scheduledDate)order.scheduledDate=new Date(req.body.scheduledDate);if(req.body.scheduledEndDate)order.scheduledEndDate=new Date(req.body.scheduledEndDate);
    if(req.body.startTime)order.startTime=req.body.startTime;if(req.body.endTime)order.endTime=req.body.endTime;
    if(Array.isArray(req.body.assignedTechnicians))order.assignedTechnicians=req.body.assignedTechnicians;
    order.planningStatus="scheduled";await order.save();
    const validation=await validateProjectSchedule(project.toObject());
    const conflict=validation.conflicts.find(row=>String(row.workOrderId||"")===String(order._id)&&row.blocking);
    if(conflict){Object.assign(order,before);await order.save();return res.status(409).json({error:`Cannot save schedule: ${conflict.message}`,conflicts:validation.conflicts});}
    project.schedulePlan.status="ready";project.schedulePlan.conflicts=validation.conflicts;project.schedulePlan.qualityScore=validation.qualityScore;project.schedulePlan.dailySummary=validation.dailySummary;await project.save();
    order.activity.push({action:"schedule_changed",actorId:req.user._id,actorName:req.user.name||req.user.email||req.user.role,reason:req.body.reason||"Manual schedule adjustment",details:{before,after:{scheduledDate:order.scheduledDate,scheduledEndDate:order.scheduledEndDate,startTime:order.startTime,endTime:order.endTime}}});await order.save();
    res.json({workOrder:order,readiness:validation,message:"Schedule updated and revalidated."});
  }catch(error){res.status(500).json({error:error.message||"Failed to adjust schedule"});}
});

/**
 * POST /api/projects/:id/generate-work-orders
 * Split the project's total units into work orders.
 * body: { mode: 'building'|'floor'|'quantity'|'manual', count, sections, manual }
 */
router.post("/projects/:id/generate-work-orders", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const result = await projectScheduler.generateWorkOrders(id, req.body || {});
    await audit.logEvent({ actor: req.user._id, target: id, action: req.body?.regenerate ? "project.work_orders_regenerated" : "project.work_orders_generated", module: "projects", req, details: { referenceModel: "Project", referenceId: id, created: result.workOrders?.length || 0, preserved: result.preserved || 0, readiness: result.readiness } });
    res.json(result);
  } catch (error) {
    console.error("Error generating work orders:", error);
    res.status(500).json({ error: error.message || "Failed to generate work orders" });
  }
});

/**
 * GET /api/projects/:id/suggest-resources
 * Rule-based equipment & material recommendations for the project.
 */
router.get("/projects/:id/suggest-resources", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const result = await projectScheduler.suggestResources(id);
    const project = await Project.findById(id).lean();
    const prepared = (result.recommendations || []).map(item => ({
      ...item,
      source: "ai",
      recommendationState: item.type === "part" && !/required by repair quotation/i.test(item.reason || "") ? "optional" : "recommended",
      requirementRule: item.requirementRule || (item.scope === "shared" ? "shared" : "fixed"),
      baseQuantity: item.baseQuantity || item.quantity || 1,
      originalQuantity: item.quantity || 1,
      confidence: item.confidence || (item.type === "part" ? "medium" : "high"),
    }));
    const evaluated = await evaluateProjectResources(project, prepared);
    res.json({ ...result, recommendations: evaluated.resources, readiness: evaluated.readiness, context: evaluated.context });
  } catch (error) {
    console.error("Error suggesting resources:", error);
    res.status(500).json({ error: "Failed to suggest resources" });
  }
});

router.post("/projects/:id/plan-resources", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 100) : [];
    const evaluated = await evaluateProjectResources(project.toObject(), items);
    project.planningDraft = project.planningDraft || {};
    project.planningDraft.resourceHistory = project.planningDraft.resourceHistory || [];
    project.planningDraft.resources = evaluated.resources.map(item => ({
      toolId: mongoose.Types.ObjectId.isValid(item.toolId) ? item.toolId : null,
      itemName: String(item.itemName || "Resource").slice(0, 200), type: String(item.type || "equipment").slice(0, 30),
      scope: String(item.scope || "shared").slice(0, 30), quantity: Math.max(1, Number(item.quantity) || 1),
      unit: String(item.unit || "pcs").slice(0, 30), reason: String(item.reason || "").slice(0, 500), available: Math.max(0, Number(item.available) || 0),
      owned: item.owned, assignedElsewhere: item.assignedElsewhere, shortage: item.shortage,
      readinessStatus: item.readinessStatus, source: item.source || "ai",
      recommendationState: item.recommendationState || "recommended",
      requirementRule: item.requirementRule, baseQuantity: item.baseQuantity,
      originalQuantity: item.originalQuantity, confidence: item.confidence || "medium",
      affectedWorkOrderIds: item.affectedWorkOrderIds || [], affectedWorkOrders: item.affectedWorkOrders || [],
      purchaseCost: item.purchaseCost, sellingPrice: item.sellingPrice, estimatedCost: item.estimatedCost,
    }));
    project.planningDraft.readiness = evaluated.readiness;
    project.planningDraft.resourceHistory.push({ action: "ai_plan_created", after: { count: evaluated.resources.length }, changedAt: new Date(), changedBy: req.user._id });
    project.planningDraft.updatedAt = new Date(); project.planningDraft.updatedBy = req.user._id;
    await project.save();
    await syncPlannedResourcesToWorkOrders(project);
    await audit.logEvent({ actor: req.user._id, target: project._id, action: "project.resource_plan_created", module: "projects", req, details: { referenceModel: "Project", referenceId: project._id, count: evaluated.resources.length } });
    res.json({ resources: project.planningDraft.resources, message: `${project.planningDraft.resources.length} resource(s) added to the plan without reserving inventory.` });
  } catch (error) {
    console.error("Failed to save planned resources:", error);
    res.status(500).json({ error: "Failed to save planned resources" });
  }
});

router.get("/projects/:id/resource-plan", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const evaluated = await evaluateProjectResources(project.toObject(), project.planningDraft?.resources || []);
    project.planningDraft.resources = evaluated.resources;
    project.planningDraft.readiness = evaluated.readiness;
    project.planningDraft.updatedAt = new Date();
    await project.save();
    await syncPlannedResourcesToWorkOrders(project);
    const [purchases, suppliers] = await Promise.all([
      ProjectResourcePurchase.find({ projectId: project._id, status: { $ne: "cancelled" } }).sort({ createdAt: -1 }).lean(),
      Tool.distinct("supplier", { supplier: { $nin: [null, ""] }, active: { $ne: false } }),
    ]);
    res.json({ ...evaluated, purchases, suppliers: suppliers.filter(Boolean).sort(), history: project.planningDraft.resourceHistory || [], baselineLocked: Boolean(project.planningDraft.baselineLocked) });
  } catch (error) {
    console.error("Failed to evaluate resource plan:", error);
    res.status(500).json({ error: "Failed to evaluate resource plan" });
  }
});

router.post("/projects/:id/resources/accept-available", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.planningDraft?.baselineLocked) return res.status(409).json({ error: "The confirmed planning baseline is locked." });
    project.planningDraft.resourceHistory = project.planningDraft.resourceHistory || [];
    const evaluated = await evaluateProjectResources(project.toObject(), project.planningDraft?.resources || []);
    let accepted = 0;
    for (const resource of evaluated.resources) {
      if (resource.recommendationState === "recommended" && resource.type !== "part" && Number(resource.available || 0) >= Number(resource.quantity || 0)) {
        resource.recommendationState = "planned";
        resource.readinessStatus = "available";
        resource.changedAt = new Date(); resource.changedBy = req.user._id;
        project.planningDraft.resourceHistory.push({ resourceId: resource._id, itemName: resource.itemName, action: "bulk_available_accepted", after: { quantity: resource.quantity, available: resource.available }, changedAt: new Date(), changedBy: req.user._id });
        accepted += 1;
      }
    }
    const refreshed = await evaluateProjectResources(project.toObject(), evaluated.resources);
    project.planningDraft.resources = refreshed.resources; project.planningDraft.readiness = refreshed.readiness;
    project.planningDraft.updatedAt = new Date(); project.planningDraft.updatedBy = req.user._id;
    await project.save(); await syncPlannedResourcesToWorkOrders(project);
    await audit.logEvent({ actor:req.user._id,target:project._id,action:"project.resources_bulk_accepted",module:"projects",req,details:{referenceModel:"Project",referenceId:project._id,accepted} });
    res.json({ accepted, resources: project.planningDraft.resources, readiness: project.planningDraft.readiness, message: `${accepted} available resource(s) accepted.` });
  } catch (error) {
    console.error("Bulk resource acceptance failed:", error);
    res.status(500).json({ error: error.message || "Failed to accept available resources" });
  }
});

router.post("/projects/:id/resources/:resourceId/purchase", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.planningDraft?.baselineLocked) return res.status(409).json({ error: "The confirmed planning baseline is locked." });
    project.planningDraft.resourceHistory = project.planningDraft.resourceHistory || [];
    const resource = project.planningDraft?.resources?.id(req.params.resourceId);
    if (!resource) return res.status(404).json({ error: "Planned resource not found" });
    if (resource.purchaseRecordId) {
      const activePurchase = await ProjectResourcePurchase.findOne({ _id: resource.purchaseRecordId, status: { $in: ["ordered", "partially_received"] } });
      if (activePurchase) return res.status(409).json({ error: `Receive or cancel the existing purchase first (${activePurchase.orderedQuantity - activePurchase.receivedQuantity} remaining).` });
    }
    const quantity = Math.max(1, Number(req.body.quantity) || 0);
    const supplier = String(req.body.supplier || "").trim();
    const unitPurchaseCost = Math.max(0, Number(req.body.unitPurchaseCost) || 0);
    const expectedDelivery = new Date(req.body.expectedDelivery);
    if (!supplier) return res.status(400).json({ error: "Supplier is required." });
    if (Number.isNaN(expectedDelivery.getTime())) return res.status(400).json({ error: "Expected delivery date is required." });
    let tool = resource.toolId ? await Tool.findById(resource.toolId) : null;
    if (!tool) {
      tool = await Tool.create({ itemName: resource.itemName, unit: resource.unit || "pcs", quantity: 0, costPrice: unitPurchaseCost, type: resource.type, itemType: resource.type, inventoryClass: resource.type === "equipment" ? "operational_asset" : "merchandise", supplier, status: "out_of_stock" });
      resource.toolId = tool._id;
    }
    const purchase = await ProjectResourcePurchase.create({ projectId: project._id, resourceId: resource._id, toolId: tool._id, itemName: resource.itemName, resourceType: resource.type, orderedQuantity: quantity, supplier, unitPurchaseCost, expectedDelivery, acquisitionMode: req.body.acquisitionMode || "purchase", createdBy: req.user._id });
    resource.purchaseRecordId = purchase._id; resource.purchaseStatus = purchase.status; resource.orderedQuantity = quantity; resource.receivedQuantity = 0; resource.supplier = supplier; resource.expectedDelivery = expectedDelivery; resource.unitPurchaseCost = unitPurchaseCost;
    if (resource.recommendationState === "recommended") resource.recommendationState = "planned";
    project.planningDraft.resourceHistory.push({ resourceId: resource._id, itemName: resource.itemName, action: "direct_purchase_created", after: { purchaseId: purchase._id, quantity, supplier, expectedDelivery }, changedAt: new Date(), changedBy: req.user._id });
    const evaluated = await evaluateProjectResources(project.toObject(), project.planningDraft.resources);
    project.planningDraft.resources = evaluated.resources; project.planningDraft.readiness = evaluated.readiness;
    await project.save(); await syncPlannedResourcesToWorkOrders(project);
    await audit.logEvent({ actor:req.user._id,target:project._id,action:"project.resource_purchase_created",module:"projects",req,details:{referenceModel:"Project",referenceId:project._id,purchaseId:purchase._id,itemName:resource.itemName,quantity,supplier,expectedDelivery} });
    res.json({ purchase, message: `Purchase recorded for ${quantity} ${resource.unit || "pcs"}. Inventory will update only when items are received.` });
  } catch (error) {
    console.error("Direct resource purchase failed:", error);
    res.status(500).json({ error: error.message || "Failed to record purchase" });
  }
});

router.post("/projects/:id/resources/:resourceId/receive", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    project.planningDraft.resourceHistory = project.planningDraft.resourceHistory || [];
    const resource = project.planningDraft?.resources?.id(req.params.resourceId);
    if (!resource?.purchaseRecordId) return res.status(404).json({ error: "No active purchase found for this resource." });
    const purchase = await ProjectResourcePurchase.findById(resource.purchaseRecordId);
    if (!purchase || purchase.status === "cancelled") return res.status(404).json({ error: "Purchase record not found." });
    const remaining = Math.max(0, purchase.orderedQuantity - purchase.receivedQuantity);
    const quantity = Math.max(0, Number(req.body.quantity) || 0);
    if (!quantity || quantity > remaining) return res.status(400).json({ error: `Receive a quantity between 1 and ${remaining}.` });
    const result = await StockAdjustment.record({ toolId: purchase.toolId, type: "stock_in", delta: quantity, adjustedBy: req.user._id, reason: "purchase", notes: `Project ${project._id} purchase from ${purchase.supplier}; resource ${resource.itemName}` });
    purchase.receivedQuantity += quantity;
    purchase.status = purchase.receivedQuantity >= purchase.orderedQuantity ? "received" : "partially_received";
    purchase.receipts.push({ quantity, receivedAt: new Date(), receivedBy: req.user._id, stockAdjustmentId: result.adjustment._id });
    await purchase.save();
    resource.purchaseStatus = purchase.status; resource.receivedQuantity = purchase.receivedQuantity;
    project.planningDraft.resourceHistory.push({ resourceId: resource._id, itemName: resource.itemName, action: "purchase_received", after: { quantity, totalReceived: purchase.receivedQuantity, status: purchase.status, stockAdjustmentId: result.adjustment._id }, changedAt: new Date(), changedBy: req.user._id });
    const evaluated = await evaluateProjectResources(project.toObject(), project.planningDraft.resources);
    project.planningDraft.resources = evaluated.resources; project.planningDraft.readiness = evaluated.readiness;
    await project.save(); await syncPlannedResourcesToWorkOrders(project);
    await audit.logEvent({ actor:req.user._id,target:project._id,action:"project.resource_purchase_received",module:"projects",req,details:{referenceModel:"Project",referenceId:project._id,purchaseId:purchase._id,itemName:resource.itemName,quantity,totalReceived:purchase.receivedQuantity,stockAdjustmentId:result.adjustment._id} });
    res.json({ purchase, readiness: evaluated.readiness, message: `${quantity} ${resource.unit || "pcs"} received and added to inventory.` });
  } catch (error) {
    console.error("Resource receiving failed:", error);
    res.status(500).json({ error: error.message || "Failed to receive purchased resource" });
  }
});

router.post("/projects/:id/resources", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.planningDraft?.baselineLocked) return res.status(409).json({ error: "The confirmed planning baseline is locked." });
    project.planningDraft.resourceHistory = project.planningDraft.resourceHistory || [];
    const item = req.body || {};
    if (!String(item.itemName || "").trim()) return res.status(400).json({ error: "Resource name is required" });
    const rule = VALID_RULES.includes(item.requirementRule) ? item.requirementRule : "fixed";
    const evaluated = await evaluateProjectResources(project.toObject(), [{
      ...item, itemName: String(item.itemName).trim().slice(0, 200), type: cleanType(item.type),
      quantity: Math.max(1, Number(item.quantity) || 1), baseQuantity: Math.max(0.01, Number(item.baseQuantity || item.quantity) || 1),
      requirementRule: rule, source: "manual", recommendationState: item.recommendationState === "optional" ? "optional" : "planned",
    }]);
    project.planningDraft.resources.push(evaluated.resources[0]);
    const created = project.planningDraft.resources[project.planningDraft.resources.length - 1];
    project.planningDraft.resourceHistory.push({ resourceId: created._id, itemName: created.itemName, action: "resource_added", after: created.toObject(), reason: item.reason || "", changedAt: new Date(), changedBy: req.user._id });
    const full = await evaluateProjectResources(project.toObject(), project.planningDraft.resources);
    project.planningDraft.resources = full.resources; project.planningDraft.readiness = full.readiness;
    project.planningDraft.updatedAt = new Date(); project.planningDraft.updatedBy = req.user._id;
    await project.save();
    await syncPlannedResourcesToWorkOrders(project);
    await audit.logEvent({ actor: req.user._id, target: project._id, action: "project.resource_added", module: "projects", req, details: { referenceModel: "Project", referenceId: project._id, itemName: created.itemName } });
    res.json({ resources: project.planningDraft.resources, readiness: project.planningDraft.readiness, message: "Resource added to the planning preview." });
  } catch (error) {
    console.error("Failed to add planned resource:", error);
    res.status(500).json({ error: error.message || "Failed to add resource" });
  }
});

router.put("/projects/:id/resources/:resourceId", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (project.planningDraft?.baselineLocked) return res.status(409).json({ error: "The confirmed planning baseline is locked." });
    project.planningDraft.resourceHistory = project.planningDraft.resourceHistory || [];
    const resource = project.planningDraft?.resources?.id(req.params.resourceId);
    if (!resource) return res.status(404).json({ error: "Planned resource not found" });
    const before = resource.toObject();
    const body = req.body || {};
    if (body.quantity != null) {
      resource.quantity = Math.max(1, Number(body.quantity) || 1);
      resource.baseQuantity = resource.quantity;
      // A direct total-quantity override becomes a fixed planning quantity;
      // otherwise a per-unit/per-tech rule would multiply the edited total.
      if (!body.requirementRule) resource.requirementRule = "fixed";
    }
    if (body.requirementRule && VALID_RULES.includes(body.requirementRule)) resource.requirementRule = body.requirementRule;
    if (body.recommendationState && VALID_STATES.includes(body.recommendationState)) resource.recommendationState = body.recommendationState;
    if (body.reason != null) resource.reason = String(body.reason).slice(0, 500);
    if (Array.isArray(body.affectedWorkOrderIds)) resource.affectedWorkOrderIds = body.affectedWorkOrderIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    resource.adjustmentReason = String(body.adjustmentReason || body.reason || "").slice(0, 500);
    resource.changedAt = new Date(); resource.changedBy = req.user._id;
    const action = resource.recommendationState === "rejected" ? "recommendation_rejected" : resource.recommendationState === "optional" ? "recommendation_optional" : before.recommendationState === "recommended" ? "recommendation_accepted" : "resource_updated";
    project.planningDraft.resourceHistory.push({ resourceId: resource._id, itemName: resource.itemName, action, before, after: resource.toObject(), reason: resource.adjustmentReason, changedAt: new Date(), changedBy: req.user._id });
    const evaluated = await evaluateProjectResources(project.toObject(), project.planningDraft.resources);
    project.planningDraft.resources = evaluated.resources; project.planningDraft.readiness = evaluated.readiness;
    project.planningDraft.updatedAt = new Date(); project.planningDraft.updatedBy = req.user._id;
    await project.save();
    await syncPlannedResourcesToWorkOrders(project);
    await audit.logEvent({ actor: req.user._id, target: project._id, action: `project.${action}`, module: "projects", req, details: { referenceModel: "Project", referenceId: project._id, itemName: resource.itemName, before, after: resource.toObject() } });
    res.json({ resources: project.planningDraft.resources, readiness: project.planningDraft.readiness, message: "Resource plan updated." });
  } catch (error) {
    console.error("Failed to update planned resource:", error);
    res.status(500).json({ error: error.message || "Failed to update resource" });
  }
});

router.post("/projects/:id/resource-readiness", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const evaluated = await evaluateProjectResources(project.toObject(), project.planningDraft?.resources || []);
    project.planningDraft.resources = evaluated.resources; project.planningDraft.readiness = evaluated.readiness;
    project.planningDraft.updatedAt = new Date(); project.planningDraft.updatedBy = req.user._id;
    await project.save();
    res.json(evaluated);
  } catch (error) {
    console.error("Resource readiness failed:", error);
    res.status(500).json({ error: "Failed to check resource readiness" });
  }
});

router.post("/projects/:id/resources/:resourceId/procurement", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  res.status(410).json({ error: "The approval-request workflow was retired. Use direct Purchase / Rent / Acquire from Resource Planning." });
});

/**
 * POST /api/projects/:id/reserve-suggested
 * Reserve the suggested resources (or a chosen subset) on the project.
 * body: { items: [{ itemName, type, quantity, unit, scope, reason }] }
 */
router.post("/projects/:id/reserve-suggested", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (["pending_project_scheduling", "accepted", "planning"].includes(project.status)) {
      return res.status(409).json({ error: "Step 2 is planning-only. Review the draft and use Confirm Project Plan in Step 6 to reserve approved resources." });
    }
    const teamStatus = project.teamStatus || [];
    const pendingTeam = (project.assignedTechnicians || []).filter(member => !teamStatus.some(row => String(row._id) === String(member._id) && row.status === "acknowledged"));
    if (pendingTeam.length) return res.status(409).json({ error: "Required team acceptance is needed before physical resources can be reserved." });
    const items = (req.body && req.body.items) || [];
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "No items provided" });
    
    // Check stock availability before reserving
    const stockWarnings = [];
    for (const it of items) {
      if (it.toolId) {
        const tool = await Tool.findById(it.toolId).lean();
        if (tool && (tool.quantity || 0) < (it.quantity || 0)) {
          stockWarnings.push({ itemName: it.itemName, available: tool.quantity || 0, requested: it.quantity || 0 });
        }
      }
    }
    
    const created = [];
    for (const it of items) {
      const itemType = it.type === "tool" ? "equipment" : (["part", "equipment", "consumable"].includes(it.type) ? it.type : "equipment");
      const m = await ProjectMaterial.create({
        projectId: id,
        type: itemType,
        scope: itemType === "part" || itemType === "consumable" ? "shared" : (it.scope || "shared"),
        itemName: it.itemName,
        quantity: it.quantity || 1,
        unit: it.unit || "pcs",
        status: "reserved",
        notes: it.reason || "",
      });
      created.push(m);
    }
    if (project.planningDraft?.resources?.length) {
      project.planningDraft.resources = [];
      project.planningDraft.updatedAt = new Date();
      project.planningDraft.updatedBy = req.user._id;
      await project.save();
    }
    res.json({ materials: created, message: `${created.length} resource(s) reserved`, stockWarnings });
  } catch (error) {
    console.error("Error reserving suggested resources:", error);
    res.status(500).json({ error: "Failed to reserve resources" });
  }
});

/**
 * PUT /api/projects/:id/daily-requirement
 * Set the per-day technician requirement used by the auto-scheduler.
 * body: { dailyRequiredTechnicians: Number }
 */
router.put("/projects/:id/daily-requirement", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const n = parseInt(req.body && req.body.dailyRequiredTechnicians);
    if (!n || n < 1) return res.status(400).json({ error: "Invalid requirement" });
    project.dailyRequiredTechnicians = n;
    await project.save();
    res.json({ project });
  } catch (error) {
    console.error("Error setting daily requirement:", error);
    res.status(500).json({ error: "Failed to set daily requirement" });
  }
});

router.post("/projects/:id/work-orders", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const project = await Project.findById(id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const { workOrders } = req.body;
    if (!Array.isArray(workOrders) || workOrders.length === 0) {
      return res.status(400).json({ error: "workOrders must be a non-empty array" });
    }

    const booking = project.bookingId ? await BookingService.findById(project.bookingId).lean() : null;
    const scopeUnits = projectUnits(project.toObject(), booking);
    const existingOrders = await WorkOrder.find({ projectId: id, status: { $ne: "cancelled" } }).select("units workOrderNumber").lean();
    const usedKeys = new Set(existingOrders.flatMap(order => (order.units || []).map(unit => unit.unitKey)));
    const availableUnits = scopeUnits.filter(unit => !usedKeys.has(unit.unitKey));
    let unitCursor = 0;
    let sequence = Math.max(0, ...existingOrders.map(order => Number(String(order.workOrderNumber || "").match(/(\d+)$/)?.[1] || 0)));
    const createdOrders = [];
    for (const wo of workOrders) {
      const requestedUnits = Math.max(1, Number(wo.unitCount) || 1);
      const selectedUnits = Array.isArray(wo.units) && wo.units.length
        ? wo.units
        : availableUnits.slice(unitCursor, unitCursor + requestedUnits);
      unitCursor += selectedUnits.length;
      if (!selectedUnits.length) return res.status(409).json({ error: "No uncovered project units remain for this work order." });
      sequence += 1;
      const assigned = (project.assignedTechnicians || []).map(t => ({
        _id: t._id, name: t.name, phone: t.phone, assignedUnits: 0,
      }));
      const order = await WorkOrder.create({
        projectId: id,
        bookingId: project.bookingId,
        workOrderNumber: `WO-${String(sequence).padStart(3, "0")}`,
        planningStatus: wo.scheduledDate ? "scheduled" : "draft",
        assignmentProvisional: true,
        title: wo.title || "",
        description: wo.description || "",
        section: wo.section || "",
        location: wo.location || { label: wo.section || project.location?.address || booking?.location?.address || "Customer site", address: project.location?.address || booking?.location?.address || "" },
        serviceType: wo.serviceType || selectedUnits[0]?.serviceType || "core",
        workflowType: wo.serviceType || selectedUnits[0]?.serviceType || "core",
        serviceName: wo.serviceName || selectedUnits[0]?.serviceName || project.service?.name || "HVAC Service",
        units: selectedUnits,
        unitCount: selectedUnits.length,
        estimatedHours: wo.estimatedHours || 0,
        requiredTechnicianCount: Math.max(1, Math.min(assigned.length || 1, Number(project.dailyRequiredTechnicians || assigned.length || 1))),
        assignedTechnicians: assigned,
        suggestedTechnicians: assigned,
        scheduledDate: wo.scheduledDate || null,
        startTime: wo.startTime || null,
        endTime: wo.endTime || null,
        priority: wo.priority || "normal",
        sortOrder: wo.sortOrder || 0,
        checklist: Array.isArray(wo.checklist) && wo.checklist.length
          ? wo.checklist
          : [
              { label: "Initial inspection", completed: false },
              { label: "Execute service", completed: false },
              { label: "Final quality check", completed: false },
            ],
        activity: [{ action: "work_order_created", actorId: req.user._id, actorName: req.user.name || req.user.email || req.user.role, details: { generationMode: "manual" } }],
      });
      order.resourceRequirements = resourcesForWorkOrder(project.toObject(), order.toObject());
      await order.save();
      createdOrders.push(order);
    }

    project.totalWorkOrders += createdOrders.length;
    // Large-scale projects must be verified/accepted before planning.
    if (project.status === "pending_project_scheduling" && !project.isLargeScale) {
      project.status = "planning";
    }
    await project.save();

    // Generate daily assignment plans for orders that already have a tech + date.
    for (const order of createdOrders) {
      if ((order.assignedTechnicians || []).length && order.scheduledDate) {
        ensureDailyAssignmentsIfLegacy(order._id).catch(() => {});
      }
    }

    res.json({
      workOrders: createdOrders,
      project,
      message: `${createdOrders.length} work order(s) created`,
    });
  } catch (error) {
    console.error("Error creating work orders:", error);
    res.status(500).json({ error: "Failed to create work orders" });
  }
});

router.put("/work-orders/:id", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid work order id" });
    }

    const existing = await WorkOrder.findById(id);
    if (!existing) return res.status(404).json({ error: "Work order not found" });
    const structuralFields = ["title", "description", "section", "location", "serviceType", "serviceName", "workflowType", "units", "unitCount", "estimatedHours", "assignedTechnicians", "suggestedTechnicians", "dependencies", "priority"];
    if (existing.planningStatus === "released" && structuralFields.some(field => req.body[field] !== undefined)) {
      return res.status(409).json({ error: "Released work-order scope cannot be destructively edited. Cancel or create a follow-up work order." });
    }

    const allowedFields = [
      "title", "description", "section", "unitCount", "estimatedHours",
      "status", "assignedTechnicians", "scheduledDate", "startTime", "endTime",
      "actualStartDate", "actualCompletionDate", "notes", "technicianNotes",
      "priority", "sortOrder", "checklist", "completedUnitCount", "location",
      "serviceType", "serviceName", "workflowType", "units", "suggestedTechnicians",
      "dependencies", "planningStatus",
    ];

    const updateData = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }

    if (req.body.scheduledDate) updateData.planningStatus = "scheduled";
    if (Array.isArray(req.body.assignedTechnicians) && existing.planningStatus !== "released") updateData.assignmentProvisional = true;
    const changedFields = Object.keys(updateData);
    const workOrder = await WorkOrder.findByIdAndUpdate(id, {
      $set: updateData,
      $push: { activity: { action: "work_order_edited", actorId: req.user._id, actorName: req.user.name || req.user.email || req.user.role, reason: req.body.changeReason || "", details: { fields: changedFields } } },
    }, { returnDocument: "after" });
    if (!workOrder) {
      return res.status(404).json({ error: "Work order not found" });
    }

    // If the schedule or assignment changed, regenerate the daily plan.
    if (req.body.scheduledDate !== undefined || req.body.assignedTechnicians !== undefined) {
      if ((workOrder.assignedTechnicians || []).length && workOrder.scheduledDate) {
        ensureDailyAssignmentsIfLegacy(workOrder._id).catch(() => {});
      }
    }

    if (req.body.completedUnitCount !== undefined && workOrder.units?.length) {
      const targetComplete = Math.min(Number(req.body.completedUnitCount) || 0, workOrder.units.length);
      workOrder.units.forEach((unit, index) => {
        if (unit.status === "cancelled") return;
        unit.status = index < targetComplete ? "completed" : "pending";
        unit.completedAt = index < targetComplete ? (unit.completedAt || new Date()) : null;
      });
    }
    if (workOrder.status === "completed" && !workOrder.actualCompletionDate) {
      if (Number(workOrder.completedUnitCount || 0) < Number(workOrder.unitCount || 0)) {
        workOrder.status = "partially_completed";
      } else {
        workOrder.actualCompletionDate = new Date();
      }
      await workOrder.save();
    }

    if (req.body.dependencies !== undefined) {
      const siblings = await WorkOrder.find({ projectId: workOrder.projectId }).lean();
      if (hasCycle(siblings)) {
        await WorkOrder.findByIdAndUpdate(id, { dependencies: existing.dependencies || [] });
        return res.status(409).json({ error: "This dependency would create a circular work-order chain." });
      }
    }

    await updateProjectProgress(workOrder.projectId);

    res.json({ workOrder });
  } catch (error) {
    console.error("Error updating work order:", error);
    res.status(500).json({ error: "Failed to update work order" });
  }
});

router.get("/work-orders/:id", auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid work order id" });
    }

    const workOrder = await WorkOrder.findById(id).lean();
    if (!workOrder) {
      return res.status(404).json({ error: "Work order not found" });
    }

    const project = await Project.findById(workOrder.projectId).lean();

    res.json({ workOrder, project });
  } catch (error) {
    console.error("Error fetching work order:", error);
    res.status(500).json({ error: "Failed to fetch work order" });
  }
});

// ── Daily Assignment plan (enterprise: WO scope split into daily targets) ──
// Admin generates / repairs the daily plan for a work order.
router.post("/work-orders/:id/generate-daily", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid work order id" });
    const plan = await ensureDailyAssignments(id, { dailyRate: req.body.dailyRate });
    res.json({ assignments: plan.assignments, remaining: plan.remaining, daysUsed: plan.daysUsed });
  } catch (error) {
    console.error("Error generating daily plan:", error);
    res.status(500).json({ error: "Failed to generate daily plan" });
  }
});

// Technician / admin views the daily plan for a work order (today + upcoming).
router.get("/work-orders/:id/daily-plan", auth.authenticate, auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid work order id" });
    const DailyAssignment = require("../models/DailyAssignment");
    const wo = await WorkOrder.findById(id).lean();
    if (!wo) return res.status(404).json({ error: "Work order not found" });
    // Return the CALLING technician's daily assignment (not just the primary tech).
    const me = await Technician.findOne({ user: req.user._id }).lean().catch(() => null);
    const techId = me ? me._id : ((wo.assignedTechnicians && wo.assignedTechnicians[0] && (wo.assignedTechnicians[0]._id || wo.assignedTechnicians[0])) || null);
    const todayKey = new Date(); todayKey.setHours(0,0,0,0);
    const assignments = await DailyAssignment.find({ workOrderId: id }).sort({ date: 1 }).lean();
    const today = techId ? assignments.find(a => String(a.technicianId) === String(techId) && new Date(a.date).toDateString() === todayKey.toDateString()) || null : null;
    res.json({
      workOrder: { _id: wo._id, title: wo.title, section: wo.section, unitCount: wo.unitCount, completedUnitCount: wo.completedUnitCount, status: wo.status },
      today,
      upcoming: assignments.filter(a => new Date(a.date) >= todayKey && (!today || new Date(a.date).toDateString() !== todayKey.toDateString())),
      all: assignments,
    });
  } catch (error) {
    console.error("Error fetching daily plan:", error);
    res.status(500).json({ error: "Failed to fetch daily plan" });
  }
});

// Technician records end-of-day completion for a work order.
router.post("/work-orders/:id/daily-complete", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    const { completedUnits, date } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid work order id" });
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });
    const workOrder = await WorkOrder.findById(id).select("projectId").lean();
    if (!workOrder) return res.status(404).json({ error: "Work order not found" });
    const project = await Project.findById(workOrder.projectId).select("isLargeScale").lean();
    if (project?.isLargeScale) {
      return res.status(409).json({
        error: "Large-scale progress requires a proof photo and consumable declaration per submission.",
        code: "PROJECT_WORK_SUBMISSION_REQUIRED",
      });
    }
    const result = await completeDay(id, tech._id, date || new Date(), completedUnits);
    if (result.behindSchedule) {
      // Notify admin that the project risks falling behind.
      await createNotification({
        type: "project_risk",
        title: "Project schedule risk",
        message: result.riskNote,
        userId: null, role: "admin",
        referenceId: result.workOrder.projectId,
        referenceModel: "Project",
        link: "/admin/projects/" + result.workOrder.projectId,
        priority: "high",
        io: req.app.get("io"),
      }).catch(() => {});
    }
    await updateProjectProgress(result.workOrder.projectId).catch(() => {});
    res.json(result);
  } catch (error) {
    console.error("Error completing day:", error);
    res.status(500).json({ error: "Failed to record day" });
  }
});

router.get("/projects/:id/work-orders", auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const workOrders = await WorkOrder.find({ projectId: id })
      .sort({ sortOrder: 1, scheduledDate: 1 })
      .lean();

    res.json({ workOrders });
  } catch (error) {
    console.error("Error listing work orders:", error);
    res.status(500).json({ error: "Failed to list work orders" });
  }
});

router.get("/projects/:id/work-order-readiness", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const booking = project.bookingId ? await BookingService.findById(project.bookingId).lean() : null;
    const orders = await WorkOrder.find({ projectId: project._id, status: { $ne: "cancelled" } });
    for (const order of orders) {
      order.resourceRequirements = resourcesForWorkOrder(project.toObject(), order.toObject());
      if (order.planningStatus === "draft" && order.scheduledDate) order.planningStatus = "scheduled";
      await order.save();
    }
    const readiness = await validateWorkOrderPlan(project.toObject(), booking);
    res.json({ readiness });
  } catch (error) {
    console.error("Work-order readiness failed:", error);
    res.status(500).json({ error: error.message || "Failed to validate work orders" });
  }
});

router.post("/work-orders/:id/split", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const order = await WorkOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Work order not found" });
    if (order.status !== "pending" || order.planningStatus === "released") return res.status(409).json({ error: "Only draft work orders can be split." });
    if (!order.units?.length || order.units.length < 2) return res.status(409).json({ error: "This work order needs at least two tracked units to split." });
    const splitAt = Math.max(1, Math.min(order.units.length - 1, Number(req.body.splitAt) || Math.ceil(order.units.length / 2)));
    const movedUnits = order.units.slice(splitAt).map(unit => unit.toObject());
    order.units = order.units.slice(0, splitAt);
    order.unitCount = order.units.length;
    order.estimatedHours = Number((Number(order.estimatedHours || 0) * order.unitCount / (order.unitCount + movedUnits.length)).toFixed(1));
    order.activity.push({ action: "work_order_split", actorId: req.user._id, actorName: req.user.name || req.user.email || req.user.role, details: { movedUnits: movedUnits.map(unit => unit.unitKey) } });
    await order.save();
    const siblings = await WorkOrder.find({ projectId: order.projectId }).select("workOrderNumber").lean();
    const next = Math.max(0, ...siblings.map(row => Number(String(row.workOrderNumber || "").match(/(\d+)$/)?.[1] || 0))) + 1;
    const clone = order.toObject();
    delete clone._id; delete clone.createdAt; delete clone.updatedAt;
    clone.workOrderNumber = `WO-${String(next).padStart(3, "0")}`;
    clone.title = `${order.title} — Split`;
    clone.units = movedUnits; clone.unitCount = movedUnits.length; clone.completedUnitCount = 0;
    clone.estimatedHours = Math.max(0.5, Number((Number(req.body.estimatedHours) || movedUnits.length * (Number(order.estimatedHours || 1) / Math.max(1, order.unitCount))).toFixed(1)));
    clone.activity = [{ action: "work_order_created_from_split", actorId: req.user._id, actorName: req.user.name || req.user.email || req.user.role, details: { sourceWorkOrderId: order._id } }];
    const created = await WorkOrder.create(clone);
    const project = await Project.findById(order.projectId).lean();
    if (project) {
      order.resourceRequirements = resourcesForWorkOrder(project, order.toObject());
      created.resourceRequirements = resourcesForWorkOrder(project, created.toObject());
      await Promise.all([order.save(), created.save()]);
    }
    await updateProjectProgress(order.projectId);
    await audit.logEvent({ actor: req.user._id, target: order.projectId, action: "project.work_order_split", module: "projects", req, details: { referenceModel: "WorkOrder", referenceId: order._id, createdId: created._id } });
    res.json({ workOrders: [order, created], message: `${order.workOrderNumber} split into two draft work orders.` });
  } catch (error) {
    console.error("Failed to split work order:", error);
    res.status(500).json({ error: error.message || "Failed to split work order" });
  }
});

router.post("/projects/:id/work-orders/merge", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.workOrderIds) ? req.body.workOrderIds.filter(mongoose.Types.ObjectId.isValid) : [];
    if (ids.length < 2) return res.status(400).json({ error: "Select at least two work orders to merge." });
    const orders = await WorkOrder.find({ _id: { $in: ids }, projectId: req.params.id });
    if (orders.length !== ids.length) return res.status(404).json({ error: "One or more work orders were not found." });
    if (orders.some(order => order.status !== "pending" || order.planningStatus === "released")) return res.status(409).json({ error: "Only draft work orders can be merged." });
    if (new Set(orders.map(order => order.serviceType)).size > 1) return res.status(409).json({ error: "Core and Repair work orders cannot be merged." });
    const primary = orders[0];
    const unitMap = new Map(orders.flatMap(order => order.units || []).map(unit => [unit.unitKey, unit.toObject()]));
    primary.units = [...unitMap.values()]; primary.unitCount = primary.units.length;
    primary.estimatedHours = Number(orders.reduce((sum, order) => sum + Number(order.estimatedHours || 0), 0).toFixed(1));
    primary.title = req.body.title || primary.title;
    primary.activity.push({ action: "work_orders_merged", actorId: req.user._id, actorName: req.user.name || req.user.email || req.user.role, details: { mergedIds: orders.slice(1).map(order => order._id) } });
    const project = await Project.findById(primary.projectId).lean();
    if (project) primary.resourceRequirements = resourcesForWorkOrder(project, primary.toObject());
    await primary.save();
    await WorkOrder.deleteMany({ _id: { $in: orders.slice(1).map(order => order._id) } });
    await updateProjectProgress(primary.projectId);
    await audit.logEvent({ actor: req.user._id, target: req.params.id, action: "project.work_orders_merged", module: "projects", req, details: { referenceModel: "WorkOrder", referenceId: primary._id, mergedIds: ids } });
    res.json({ workOrder: primary, message: `${orders.length} draft work orders merged.` });
  } catch (error) {
    console.error("Failed to merge work orders:", error);
    res.status(500).json({ error: error.message || "Failed to merge work orders" });
  }
});

router.post("/work-orders/:id/move-units", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const source = await WorkOrder.findById(req.params.id);
    const target = await WorkOrder.findById(req.body.targetWorkOrderId);
    if (!source || !target || String(source.projectId) !== String(target.projectId)) return res.status(404).json({ error: "Source or target work order not found in this project." });
    if (target.status !== "pending" || target.planningStatus === "released") return res.status(409).json({ error: "Units can only be moved into a draft work order." });
    if (!["pending", "partially_completed", "on_hold"].includes(source.status)) return res.status(409).json({ error: "Units cannot be moved from this work-order state." });
    if (source.serviceType !== target.serviceType) return res.status(409).json({ error: "Units cannot move between Core and Repair workflows." });
    const requestedKeys = Array.isArray(req.body.unitKeys) ? new Set(req.body.unitKeys.map(String)) : null;
    const movable = source.units.filter(unit => unit.status !== "completed" && unit.status !== "cancelled" && (!requestedKeys || requestedKeys.has(unit.unitKey)));
    const count = Math.max(1, Number(req.body.count) || movable.length);
    const moving = movable.slice(-count);
    if (!moving.length) return res.status(409).json({ error: "No incomplete units are available to move." });
    if (moving.length >= source.units.length) return res.status(409).json({ error: "Move fewer units so the source work order retains scope, or merge/delete the draft instead." });
    const movingKeys = new Set(moving.map(unit => unit.unitKey));
    source.units = source.units.filter(unit => !movingKeys.has(unit.unitKey));
    target.units.push(...moving.map(unit => unit.toObject()));
    source.unitCount = source.units.length; target.unitCount = target.units.length;
    source.activity.push({ action: "units_moved_out", actorId: req.user._id, actorName: req.user.name || req.user.email || req.user.role, details: { targetWorkOrderId: target._id, unitKeys: [...movingKeys] } });
    target.activity.push({ action: "units_moved_in", actorId: req.user._id, actorName: req.user.name || req.user.email || req.user.role, details: { sourceWorkOrderId: source._id, unitKeys: [...movingKeys] } });
    const project = await Project.findById(source.projectId).lean();
    if (project) {
      source.resourceRequirements = resourcesForWorkOrder(project, source.toObject());
      target.resourceRequirements = resourcesForWorkOrder(project, target.toObject());
    }
    await Promise.all([source.save(), target.save()]);
    await updateProjectProgress(source.projectId);
    await audit.logEvent({ actor: req.user._id, target: source.projectId, action: "project.work_order_units_moved", module: "projects", req, details: { referenceModel: "WorkOrder", referenceId: source._id, targetId: target._id, unitKeys: [...movingKeys] } });
    res.json({ source, target, message: `${moving.length} unit(s) moved to ${target.workOrderNumber || target.title}.` });
  } catch (error) {
    console.error("Failed to move work-order units:", error);
    res.status(500).json({ error: error.message || "Failed to move units" });
  }
});

router.post("/work-orders/:id/cancel", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const reason = String(req.body.reason || "").trim();
    if (!reason) return res.status(400).json({ error: "Cancellation reason is required." });
    const order = await WorkOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Work order not found" });
    if (order.status === "completed") return res.status(409).json({ error: "Completed work orders cannot be cancelled." });
    order.status = "cancelled"; order.cancellationReason = reason; order.cancelledBy = req.user._id; order.cancelledAt = new Date();
    order.activity.push({ action: "work_order_cancelled", actorId: req.user._id, actorName: req.user.name || req.user.email || req.user.role, reason });
    await order.save();
    await updateProjectProgress(order.projectId);
    res.json({ workOrder: order, message: "Work order cancelled and retained in project history." });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to cancel work order" });
  }
});

router.delete("/work-orders/:id", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid work order id" });
    }

    const existing = await WorkOrder.findById(id);
    if (!existing) return res.status(404).json({ error: "Work order not found" });
    if (existing.status !== "pending" || existing.planningStatus === "released") {
      return res.status(409).json({ error: "Only draft work orders can be deleted. Cancel released or scheduled work instead." });
    }
    const workOrder = await WorkOrder.findByIdAndDelete(id);
    if (!workOrder) {
      return res.status(404).json({ error: "Work order not found" });
    }

    await updateProjectProgress(workOrder.projectId);

    res.json({ message: "Work order deleted" });
  } catch (error) {
    console.error("Error deleting work order:", error);
    res.status(500).json({ error: "Failed to delete work order" });
  }
});

router.post("/projects/:id/materials", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const project = await Project.findById(id);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (["pending_project_scheduling", "accepted", "planning"].includes(project.status)) {
      return res.status(409).json({ error: "Resources cannot be reserved during planning. Add them to the Step 2 resource plan, then confirm the complete plan in Step 6." });
    }
    const teamStatus = project.teamStatus || [];
    const pendingTeam = (project.assignedTechnicians || []).filter(member => !teamStatus.some(row => String(row._id) === String(member._id) && row.status === "acknowledged"));
    if (pendingTeam.length) {
      return res.status(409).json({ error: "Resources may be planned now, but physical reservation requires all assigned team members to accept." });
    }

    const { materials } = req.body;
    if (!Array.isArray(materials) || materials.length === 0) {
      return res.status(400).json({ error: "materials must be a non-empty array" });
    }

    const Tool = require("../models/Tool");

    // ── Availability guard: soft-check — save what we can, warn about conflicts ──
    const byTool = new Map();
    for (const mat of materials) {
      if (mat.source === "inventory" && mat.sourceId) {
        const key = String(mat.sourceId);
        byTool.set(key, (byTool.get(key) || 0) + (Number(mat.quantity) || 1));
      }
    }

    const stockConflicts = []; // items that could not be saved due to stock
    const blockedSourceIds = new Set();

    if (byTool.size) {
      const toolIds = [...byTool.keys()];
      const tools = await Tool.find({ _id: { $in: toolIds } }).lean();
      const toolMap = new Map(tools.map((t) => [t._id.toString(), t]));
      const prior = await ProjectMaterial.aggregate([
        { $match: { source: "inventory", sourceId: { $in: toolIds.map((x) => new mongoose.Types.ObjectId(x)) }, status: { $in: ["reserved", "fulfilled"] }, projectId: { $ne: new mongoose.Types.ObjectId(id) } } },
        { $group: { _id: "$sourceId", total: { $sum: "$quantity" } } },
      ]);
      const priorMap = new Map(prior.map((p) => [p._id.toString(), p.total]));
      for (const [toolId, want] of byTool) {
        const tool = toolMap.get(toolId);
        if (!tool) continue;
        const stock = tool.quantity || 0;
        const alreadyReserved = priorMap.get(toolId) || 0;
        const available = stock - alreadyReserved;
        if (want > available) {
          stockConflicts.push({
            item: tool.itemName,
            itemName: tool.itemName,
            stock,
            reservedByOthers: alreadyReserved,
            available: Math.max(0, available),
            want,
          });
          blockedSourceIds.add(toolId);
        }
      }
      // Update reservation ledger for tools that ARE being saved
      for (const toolId of byTool.keys()) {
        if (!blockedSourceIds.has(toolId)) {
          await Tool.recomputeReserved(toolId);
        }
      }
    }

    const createdMaterials = [];
    const skippedMaterials = [];
    for (const mat of materials) {
      const isBlocked = mat.source === "inventory" && mat.sourceId && blockedSourceIds.has(String(mat.sourceId));
      if (isBlocked) {
        skippedMaterials.push(mat);
        continue;
      }
      const itemType = mat.type === "tool" ? "equipment" : (["part", "equipment", "consumable"].includes(mat.type) ? mat.type : "equipment");
      const material = await ProjectMaterial.create({
        projectId: id,
        workOrderId: mat.workOrderId || null,
        type: itemType,
        scope: itemType === "part" || itemType === "consumable" ? "shared" : (["shared", "assigned"].includes(mat.scope) ? mat.scope : "shared"),
        itemName: mat.itemName,
        quantity: mat.quantity || 1,
        unit: mat.unit || "pcs",
        unitPrice: mat.unitPrice || 0,
        notes: mat.notes || "",
        source: mat.source || "other",
        sourceId: mat.sourceId || null,
      });
      createdMaterials.push(material);
    }

    if (stockConflicts.length > 0 && createdMaterials.length === 0) {
      // Everything was blocked — return 409 with first conflict info for backwards compat
      const first = stockConflicts[0];
      return res.status(409).json({
        error: `Not enough "${first.item}" available. In stock: ${first.stock}, already reserved by other jobs: ${first.reservedByOthers}, so only ${first.available} free for this project.`,
        item: first.item,
        stock: first.stock,
        reservedByOthers: first.reservedByOthers,
        available: first.available,
        want: first.want,
        details: stockConflicts,
      });
    }

    res.json({
      materials: createdMaterials,
      message: createdMaterials.length > 0
        ? `${createdMaterials.length} material(s) reserved${stockConflicts.length > 0 ? ` (${stockConflicts.length} item(s) skipped due to insufficient stock)` : ""}`
        : "No materials reserved",
      stockConflicts: stockConflicts.length > 0 ? stockConflicts : undefined,
    });
  } catch (error) {
    console.error("Error adding materials:", error);
    res.status(500).json({ error: "Failed to add materials" });
  }
});


router.get("/projects/:id/materials", auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const materials = await ProjectMaterial.find({ projectId: id }).lean();
    const summary = await ProjectMaterial.getProjectSummary(id);

    res.json({ materials, summary });
  } catch (error) {
    console.error("Error listing materials:", error);
    res.status(500).json({ error: "Error listing materials" });
  }
});

// Remove a reserved project material. Recomputes the affected catalog
// tool's reservation ledger so its stock becomes available again.
router.delete("/projects/:id/materials/:mid", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id, mid } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(mid)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const material = await ProjectMaterial.findOne({ _id: mid, projectId: id });
    if (!material) return res.status(404).json({ error: "Material not found" });
    const sourceId = material.sourceId;
    await material.deleteOne();
    if (material.source === "inventory" && sourceId) {
      const Tool = require("../models/Tool");
      await Tool.recomputeReserved(String(sourceId));
    }
    res.json({ message: "Material removed", material });
  } catch (error) {
    console.error("Error removing material:", error);
    res.status(500).json({ error: "Failed to remove material" });
  }
});

// Resolve the Technician profile id for the currently authenticated user (if technician).
async function resolveTechnicianId(user) {
  if (!user) return null;
  const tech = await Technician.findOne({ user: user._id }).lean();
  return tech ? tech._id : null;
}

async function requireTechnicianProjectMember(user, projectId) {
  const technician = await Technician.findOne({ user: user._id }).select("_id name user").lean();
  if (!technician) throw Object.assign(new Error("Technician profile not found"), { status: 404 });
  const project = await Project.findOne({
    _id: projectId,
    $or: [
      { "assignedTechnicians._id": technician._id },
      { leadTechnicianId: technician._id },
    ],
  }).select("_id customer service leadTechnicianId assignedTechnicians").lean();
  if (!project) throw Object.assign(new Error("You are not assigned to this project"), { status: 403 });
  return { technician, project };
}

// Lead technician (or admin) assigns a reserved equipment item to a technician.
router.put("/projects/:id/materials/:mid/assign", auth.authenticate, auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const { id, mid } = req.params;
    const { technicianId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(mid)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    // Technicians may only assign within projects where they are the lead or a member.
    const callerTechId = await resolveTechnicianId(req.user);
    const isStaff = ["admin", "secretary"].includes(req.user.role);
    const isLead = project.leadTechnicianId && callerTechId && project.leadTechnicianId.toString() === callerTechId.toString();
    const isMember = (project.assignedTechnicians || []).some((t) => callerTechId && t._id && t._id.toString() === callerTechId.toString());
    if (!isStaff && !isLead && !isMember) {
      return res.status(403).json({ error: "Not authorized for this project" });
    }

    if (!technicianId || !mongoose.Types.ObjectId.isValid(technicianId)) {
      return res.status(400).json({ error: "technicianId is required" });
    }
    const validMember = (project.assignedTechnicians || []).some((t) => t._id && t._id.toString() === technicianId);
    if (!validMember) {
      return res.status(400).json({ error: "Technician must be part of the assigned team" });
    }

    const material = await ProjectMaterial.findOneAndUpdate(
      { _id: mid, projectId: id },
      { assignedToTechnicianId: technicianId, assignedBy: req.user._id, assignedAt: new Date(), scope: "assigned" },
      { returnDocument: "after" },
    );
    if (!material) return res.status(404).json({ error: "Resource not found" });

    await audit.logEvent({
      actor: req.user._id,
      target: project._id,
      action: "project.equipment_assigned",
      module: "admin",
      req,
      details: { materialId: mid, technicianId },
    }).catch(() => {});

    res.json({ material });
  } catch (error) {
    console.error("Error assigning equipment:", error);
    res.status(500).json({ error: "Failed to assign equipment" });
  }
});

// Technician confirms they have picked up the assigned equipment.
router.put("/projects/:id/materials/:mid/confirm-pickup", auth.authenticate, auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const { id, mid } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(mid)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const material = await ProjectMaterial.findById(mid);
    if (!material || material.projectId.toString() !== id) {
      return res.status(404).json({ error: "Resource not found" });
    }

    const callerTechId = await resolveTechnicianId(req.user);
    const isStaff = ["admin", "secretary"].includes(req.user.role);
    const isOwner = callerTechId && material.assignedToTechnicianId && material.assignedToTechnicianId.toString() === callerTechId.toString();
    if (!isStaff && !isOwner) {
      return res.status(403).json({ error: "Only the assigned technician or staff can confirm pickup" });
    }

    material.pickedUp = true;
    material.pickedUpAt = new Date();
    material.pickedUpBy = callerTechId || req.user._id;
    await material.save();

    res.json({ material });
  } catch (error) {
    console.error("Error confirming pickup:", error);
    res.status(500).json({ error: "Failed to confirm pickup" });
  }
});

// POST /api/projects/:id/upload-payment-proof
// Mirrors the customer/technician proof-of-payment image upload: saves the
// receipt screenshot to disk and returns its URL so it can be stored on the
// project's `payment.proofUrl` field (real image, not just a text reference).
const paymentProofUploadDir = path.join(__dirname, "../public/uploads/project-payment-proofs");
if (!fs.existsSync(paymentProofUploadDir)) fs.mkdirSync(paymentProofUploadDir, { recursive: true });

const paymentProofUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, paymentProofUploadDir),
    filename: (req, file, cb) => cb(null, "payproof-" + Date.now() + "-" + Math.round(Math.random() * 1e9) + imageExtensionFor(file)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, isAllowedImage(file)),
}).single("proofPhoto");

router.post("/projects/:id/upload-payment-proof", auth.authenticate, auth.requireRole(["admin", "secretary", "technician"]), (req, res) => {
  paymentProofUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Upload failed: " + err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (req.user.role === "technician") {
      const ctx = await requireProjectLead(req, res);
      if (!ctx) {
        fs.unlink(req.file.path, () => {});
        return;
      }
    }
    res.json({ url: "/uploads/project-payment-proofs/" + req.file.filename });
  });
});

// POST /api/projects/:id/upload-completion-proof
// Upload a completion photo (proof of finished work) after payment is collected.
const completionProofUploadDir = path.join(__dirname, "../public/uploads/project-completion-proofs");
if (!fs.existsSync(completionProofUploadDir)) fs.mkdirSync(completionProofUploadDir, { recursive: true });

const completionProofUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, completionProofUploadDir),
    filename: (req, file, cb) => cb(null, "comproof-" + Date.now() + "-" + Math.round(Math.random() * 1e9) + imageExtensionFor(file)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, isAllowedImage(file)),
}).single("completionPhoto");

router.post("/projects/:id/upload-completion-proof", auth.authenticate, auth.requireRole("technician"), (req, res) => {
  completionProofUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Upload failed: " + err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const url = "/uploads/project-completion-proofs/" + req.file.filename;
    try {
      const ctx = await requireProjectLead(req, res);
      if (!ctx) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return;
      }
      const readiness = await getProjectCompletionReadiness(ctx.project);
      if (!readiness.workOrdersComplete || !readiness.evidenceComplete) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(409).json({ error: "Finish lead review of every proof-backed work order before uploading final completion evidence." });
      }
      await Project.findByIdAndUpdate(req.params.id, { "payment.completionProofUrl": url });
      return res.json({ url });
    } catch (error) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(500).json({ error: "Failed to save completion proof" });
    }
  });
});

router.get("/technician/projects", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const techUser = req.user;
    const technician = await Technician.findOne({ user: techUser._id }).lean();
    if (!technician) {
      return res.status(404).json({ error: "Technician profile not found" });
    }

    // Find projects in two ways:
    // 1) Via work orders assigned to this technician (active statuses)
    const workOrders = await WorkOrder.find({
      "assignedTechnicians._id": technician._id,
      status: { $in: ["assigned", "accepted", "en_route", "arrived", "in_progress", "partially_completed", "awaiting_review", "on_hold"] },
    })
      .sort({ scheduledDate: 1 })
      .lean();

    const woProjectIds = [...new Set(workOrders.map((wo) => wo.projectId.toString()))];

    // 2) Directly from projects where this technician is assigned (even without work orders yet)
    const directProjects = await Project.find({
      status: { $nin: ["completed", "closed", "cancelled"] },
      $or: [
        { "assignedTechnicians._id": technician._id },
        { leadTechnicianId: technician._id },
      ],
    }).lean();

    const directProjectIds = directProjects.map(p => p._id.toString());

    // 3) Via Assignments — technician has an assignment for a booking that
    //    has been converted to a project, but hasn't been added to
    //    Project.assignedTechnicians yet.
    const Assignment = require("../models/Assignment");
    const assignmentBookingIds = await Assignment.find({
      technicianId: technician._id,
    }).distinct("bookingId");
    const assignmentProjects = assignmentBookingIds.length
      ? await Project.find({
          bookingId: { $in: assignmentBookingIds },
          status: { $nin: ["completed", "closed", "cancelled"] },
        }).lean()
      : [];
    const assignmentProjectIds = assignmentProjects
      .filter(p => !directProjectIds.includes(p._id.toString()))
      .map(p => p._id.toString());

    // Merge all sources of project IDs
    const allProjectIds = [...new Set([...woProjectIds, ...directProjectIds, ...assignmentProjectIds])];

    const projects = await Project.find({
      _id: { $in: allProjectIds },
    }).lean();

    const projectMap = {};
    for (const p of projects) {
      projectMap[p._id.toString()] = p;
    }

    // Group work orders by project so each technician sees one project card
    // (lead gets the team dashboard; members get a simpler card).
    const grouped = {};
    for (const wo of workOrders) {
      const pid = wo.projectId.toString();
      (grouped[pid] = grouped[pid] || []).push(wo);
    }

    // Also include projects found directly (no work orders assigned yet)
    for (const pid of allProjectIds) {
      if (!grouped[pid]) grouped[pid] = [];
    }

    const assignments = [];
    for (const pid of Object.keys(grouped)) {
      const project = projectMap[pid];
      if (!project) continue;
      const wos = grouped[pid];

      // Self-heal schedules created before Step 4 became authoritative. This
      // runs only when the confirmed baseline differs and no work is completed.
      await reconcileCommittedSchedule(project).catch(error => console.warn("Committed schedule reconciliation skipped:", error.message));

      // All work orders on the project (so the lead's "Today's Team" board can
      // reflect every member's live status, not just the caller's own WOs).
      const allWos = await WorkOrder.find({ projectId: project._id })
        .sort({ scheduledDate: 1 })
        .lean()
        .catch(() => wos);
      await reconcileTrackedUnitProgress(allWos).catch(error => console.warn("Tracked unit reconciliation skipped:", error.message));
      for (const order of allWos) {
        await rebalanceFutureUnitTargets(order).catch(error => console.warn("Future target reconciliation skipped:", error.message));
      }

      // Per-member current status for the lead's "Today's Team" board.
      // Derived from each member's latest work-order status on this project.
      const teamBoard = [];
      const DailyAssignment = require("../models/DailyAssignment");
      const todayKey = new Date(); todayKey.setHours(0, 0, 0, 0);
      const tomorrowKey = new Date(todayKey); tomorrowKey.setDate(tomorrowKey.getDate() + 1);
      // Load the allocation ledger once and aggregate from it. Exact Date
      // equality is unsafe when older rows were saved with a UTC offset.
      const projectDailyAssignments = await DailyAssignment.find({
        projectId: project._id,
        status: { $ne: "skipped" },
      }).lean().catch(() => []);
      const isTodayAssignment = row => {
        const date = new Date(row.date);
        return date >= todayKey && date < tomorrowKey;
      };
      for (const t of (project.assignedTechnicians || [])) {
        const memberWos = allWos.filter((w) =>
          (w.assignedTechnicians || []).some((a) => (a._id || a).toString() === t._id.toString())
        );
        let liveStatus = "assigned";
        if (memberWos.length) {
          const order = { en_route: 4, arrived: 3, in_progress: 2, accepted: 1, assigned: 0 };
          liveStatus = memberWos
            .map((w) => w.status)
            .sort((a, b) => (order[b] || 0) - (order[a] || 0))[0] || "assigned";
        }
        // Today's target and completed for this member (from DailyAssignment).
        const memberAllocations = projectDailyAssignments.filter(row => String(row.technicianId) === String(t._id));
        const todayRows = memberAllocations.filter(isTodayAssignment);
        const todayTarget = todayRows.reduce((s, d) => s + Number(d.targetUnits || 0), 0);
        const todayDone = todayRows.reduce((s, d) => s + Number(d.completedUnits || 0), 0);
        // Scheduled unit allocations are authoritative. Fall back to the WO
        // assignment shares only for legacy projects without daily rows.
        const scheduledTotal = memberAllocations.reduce((s, d) => s + Number(d.targetUnits || 0), 0);
        const assignedFallback = memberWos.reduce((sum, wo) => {
          const share = (wo.assignedTechnicians || []).find(member => String(member._id || member) === String(t._id));
          return sum + Number(share?.assignedUnits || 0);
        }, 0);
        const memberTotalUnits = scheduledTotal || assignedFallback;
        const memberDoneUnits = memberAllocations.length
          ? memberAllocations.reduce((s, d) => s + Number(d.completedUnits || 0), 0)
          : 0;
        teamBoard.push({
          _id: t._id,
          name: t.name || "Technician",
          status: liveStatus,
          todayTarget,
          todayDone,
          memberTotalUnits,
          memberDoneUnits,
          acknowledge: (project.teamStatus || []).find((x) => x._id && x._id.toString() === t._id.toString())?.status || "notified",
        });
      }

      // Work order details with daily plan targets for the lead's drawer.
      const workOrderDetails = [];
      for (const wo of allWos) {
        const allWoAssignments = projectDailyAssignments
          .filter(row => String(row.workOrderId) === String(wo._id))
          .sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.startTime || "").localeCompare(String(b.startTime || "")));
        const woDa = projectDailyAssignments.filter(row => String(row.workOrderId) === String(wo._id) && isTodayAssignment(row));
        const woTarget = woDa.reduce((s, d) => s + (d.targetUnits || 0), 0);
        const woDone = woDa.reduce((s, d) => s + (d.completedUnits || 0), 0);
        const woRemaining = Math.max(0, (wo.unitCount || 0) - (wo.completedUnitCount || 0));
        const woPct = (wo.unitCount || 0) > 0 ? Math.round(((wo.completedUnitCount || 0) / wo.unitCount) * 100) : 0;
        const legacyScheduledToday = !projectDailyAssignments.length && wo.scheduledDate &&
          new Date(wo.scheduledDate) < tomorrowKey && (!wo.scheduledEndDate || new Date(wo.scheduledEndDate) >= todayKey);
        const batchDays = new Map();
        for (const row of allWoAssignments) {
          const key = `${scheduleDayKey(row.date)}|${row.startTime || ""}|${row.endTime || ""}`;
          const day = batchDays.get(key) || { date: row.date, startTime: row.startTime, endTime: row.endTime, targetUnits: 0, completedUnits: 0 };
          day.targetUnits += Number(row.targetUnits || 0);
          day.completedUnits += Number(row.completedUnits || 0);
          batchDays.set(key, day);
        }
        workOrderDetails.push({
          _id: wo._id,
          title: wo.title || wo.section || 'Work Order',
          section: wo.section || '',
          status: wo.status || 'pending',
          planningStatus: wo.planningStatus || 'draft',
          unitCount: wo.unitCount || 0,
          completedUnitCount: wo.completedUnitCount || 0,
          remaining: woRemaining,
          estimatedHours: wo.estimatedHours || 0,
          scheduledDate: wo.scheduledDate || null,
          scheduledEndDate: wo.scheduledEndDate || null,
          startTime: wo.startTime || null,
          endTime: wo.endTime || null,
          dailyAllocations: allWoAssignments.map(row => ({
            date: row.date, startTime: row.startTime, endTime: row.endTime,
            targetUnits: Number(row.targetUnits || 0), completedUnits: Number(row.completedUnits || 0),
            unitKeys: row.unitKeys || [], technicianId: row.technicianId,
            technicianName: (project.assignedTechnicians || []).find(member => String(member._id) === String(row.technicianId))?.name || "Technician",
          })),
          dailySchedule: [...batchDays.values()],
          todayTarget: woTarget,
          todayDone: woDone,
          isScheduledToday: woDa.length > 0 || Boolean(legacyScheduledToday),
          completionPct: woPct,
          assignedTechnicians: (project.assignedTechnicians || []).map(at => ({ _id: at._id, name: at.name || 'Technician' })),
          checklist: (wo.checklist || []).map(ci => ({
            label: ci.label || '',
            completed: !!ci.completed,
            completedAt: ci.completedAt || null,
            completedBy: ci.completedBy || null,
          })),
          units: (wo.units || []).map(unit => ({
            unitKey: unit.unitKey, label: unit.label || unit.unitKey,
            applianceType: unit.applianceType || '', brand: unit.brand || '', model: unit.model || '',
            location: unit.location || '', status: unit.status || 'pending', notes: unit.notes || '',
            completedAt: unit.completedAt || null, completedBy: unit.completedBy || null,
          })),
        });
      }

      // Project-level schedule window.
      const projectSchedule = {
        plannedStartDate: project.plannedStartDate || project.preferredStartDate || null,
        plannedCompletionDate: project.plannedCompletionDate || project.preferredCompletionDeadline || null,
      };

      const isLead = project.leadTechnicianId && technician._id.toString() === project.leadTechnicianId.toString();

      // Lead dashboard extras: reserved equipment, open issues, material requests.
      let equipment = [];
      let issues = [];
      let materialRequests = [];
      let workSubmissions = [];
      try {
        equipment = await ProjectMaterial.find({ projectId: project._id }).lean();
        issues = await ProjectIssue.find({ projectId: project._id, status: { $ne: "resolved" } }).lean();
        materialRequests = await ProjectIssue.find({ projectId: project._id, category: "inventory", status: { $ne: "resolved" } }).lean();
        workSubmissions = await ProjectWorkSubmission.find({ projectId: project._id })
          .populate("technicianId", "name")
          .sort({ createdAt: -1 })
          .limit(20)
          .lean();
      } catch (_) {}

      // Crew-wide phase (drives the lead's single mobilize flow) + team gate.
      const phase = deriveProjectPhase(allWos, project);
      const allAccepted = teamAllAccepted(project);
      const leadTeamEntry = (project.teamStatus || []).find(row => String(row._id) === String(technician._id));
      const leadParticipationAccepted = leadTeamEntry?.status === "acknowledged";
      const verifiedForParticipation = !project.isLargeScale || Boolean(project.verifiedAt);
      const participationOpen = ["pending_project_scheduling", "accepted", "planning"].includes(project.status);
      const startOpen = project.status === "ready" && allAccepted;
      const canLeadAccept = Boolean(isLead && !project.leadAcceptedAt && verifiedForParticipation && ((!leadParticipationAccepted && participationOpen) || (leadParticipationAccepted && startOpen)));
      let leadAcceptanceBlocker = null;
      if (isLead && !project.leadAcceptedAt && !canLeadAccept) {
        if (project.isLargeScale && !project.verifiedAt) leadAcceptanceBlocker = "Waiting for admin verification";
        else if (leadParticipationAccepted && ["pending_project_scheduling", "accepted", "planning"].includes(project.status)) leadAcceptanceBlocker = "Participation accepted — waiting for admin to confirm the final project plan";
        else if (project.status === "ready" && !allAccepted) leadAcceptanceBlocker = "Waiting for every assigned team member to accept participation";
        else leadAcceptanceBlocker = `Project is ${String(project.status || "not ready").replace(/_/g, " ")}`;
      }

      // My daily quota (today) for the calling technician across their WOs.
      // Work orders belong to the project crew. Every team member sees the
      // same batch queue; individual accountability lives on unit.completedBy.
      const myWos = allWos.filter(w => w.status !== "cancelled");
      let myTodayTarget = 0, myTodayDone = 0;
      if (myWos.length) {
        const das = projectDailyAssignments.filter(row => String(row.technicianId) === String(technician._id) && isTodayAssignment(row));
        myTodayTarget = das.reduce((s, d) => s + (d.targetUnits || 0), 0);
        myTodayDone = das.reduce((s, d) => s + (d.completedUnits || 0), 0);
      }
      const myAllocationRows = projectDailyAssignments.filter(row => String(row.technicianId) === String(technician._id));
      const myTotalUnits = myAllocationRows.reduce((s, row) => s + Number(row.targetUnits || 0), 0) || myWos.reduce((sum, wo) => { const share=(wo.assignedTechnicians||[]).find(member=>String(member._id||member)===String(technician._id)); return sum+Number(share?.assignedUnits||0); },0);
      const myDoneUnits = myAllocationRows.reduce((s, row) => s + Number(row.completedUnits || 0), 0);

      // Overall project unit progress + all-done flag (for lead's collect flow).
      const projTotalUnits = allWos.reduce((s, w) => s + (w.unitCount || 0), 0);
      const projDoneUnits = allWos.reduce((s, w) => s + (w.completedUnitCount || 0), 0);

      assignments.push({
        project,
        workOrders: wos,
        myWorkOrders: myWos,
        isLead,
        leadAccepted: !!project.leadAcceptedAt,
        leadParticipationAccepted,
        canLeadAccept,
        leadAcceptanceBlocker,
        leadDeclinedReason: project.leadDeclinedReason || null,
        teamBoard,
        workOrderDetails,
        projectSchedule,
        equipment,
        issues,
        materialRequests,
        workSubmissions,
        phase,
        allAccepted,
        dailyAcceptance: project.dailyAcceptance || null,
        customer: {
          name: project.customer?.name || null,
          phone: project.customer?.phone || null,
          address: project.customer?.address || project.location?.address || null,
          lat: project.location?.lat != null ? project.location.lat : null,
          lng: project.location?.lng != null ? project.location.lng : null,
        },
        serviceName: project.service?.name || null,
        serviceCategory: project.service?.category || null,
        myQuota: { targetToday: myTodayTarget, doneToday: myTodayDone, totalUnits: myTotalUnits, doneUnits: myDoneUnits },
        projectUnits: {
          total: projTotalUnits,
          done: projDoneUnits,
          allDone: projTotalUnits > 0 && projDoneUnits >= projTotalUnits,
          allSubmitted: allWos.length > 0 && allWos.filter(w => w.status !== "cancelled").every(w => w.status === "completed"),
        },
        paymentStatus: (project.payment && project.payment.paymentStatus) || "unpaid",
      });
    }

    res.json({ assignments, me: technician._id });
  } catch (error) {
    console.error("Error fetching technician projects:", error);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

/**
 * Lead Technician accepts the commercial project assignment.
 * On accept the project moves to in_progress and every assigned member is
 * notified (members only acknowledge — they do not individually accept).
 */
router.post("/projects/:id/lead-accept", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });
    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.leadTechnicianId || project.leadTechnicianId.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Only the assigned lead technician can accept this project" });
    }
    // Acceptance is idempotent. A retry or double-click after the successful
    // transition must return the current state instead of a misleading 409.
    if (project.leadAcceptedAt && project.status === "in_progress") {
      await reconcileCommittedSchedule(project).catch(error => console.warn("Committed schedule reconciliation skipped:", error.message));
      return res.json({ success: true, alreadyAccepted: true, project });
    }
    if (project.isLargeScale && !project.verifiedAt) {
      return res.status(409).json({ error: "Admin must verify this large-scale project before the lead can accept participation." });
    }

    // Participation acceptance happens before final planning confirmation.
    // It only updates the team roster; it never starts work or releases WOs.
    if (["pending_project_scheduling", "accepted", "planning"].includes(project.status)) {
      const teamStatus = project.teamStatus || [];
      let entry = teamStatus.find(row => String(row._id) === String(tech._id));
      if (!entry) {
        entry = { _id: tech._id, name: tech.name, status: "acknowledged", acknowledgedAt: new Date() };
        teamStatus.push(entry);
      } else {
        entry.status = "acknowledged";
        entry.acknowledgedAt = new Date();
        entry.declinedReason = undefined;
      }
      project.teamStatus = teamStatus;
      project.leadDeclinedReason = undefined;
      await project.save();

      const io = req.app.get("io");
      await createNotification({
        type: "project_lead_participation_accepted", title: "Lead accepted project participation",
        message: `${tech.name} accepted the team assignment for ${project.customer?.name || "the project"}. Final planning confirmation is still pending.`,
        role: "admin", referenceId: project._id, referenceModel: "Project",
        link: `/admin/projects/${project._id}`, priority: "normal", io,
      }).catch(() => {});
      if (io) io.to("admin-room").emit("project:team-status", { projectId: project._id, teamStatus: project.teamStatus });
      return res.json({ success: true, participationAccepted: true, awaitingFinalPlan: true, project, message: "Participation accepted. Waiting for final project-plan confirmation." });
    }
    if (project.status !== "ready") {
      return res.status(409).json({ error: `Project cannot start from "${project.status}".` });
    }
    if (!teamAllAccepted(project)) {
      return res.status(409).json({ error: "Every assigned team member must accept participation before the project can start." });
    }

    project.status = "in_progress";
    if (!project.actualStartDate) project.actualStartDate = new Date();
    project.leadAcceptedAt = new Date();
    project.leadDeclinedReason = undefined;
    // Build the team acknowledgement roster from the assigned team.
    project.teamStatus = (project.assignedTechnicians || []).map((t) => {
      const prior = (project.teamStatus || []).find(row => String(row._id) === String(t._id));
      const isLead = String(t._id) === String(tech._id);
      return {
        _id: t._id,
        name: t.name || "Technician",
        status: isLead ? "acknowledged" : (prior?.status || "notified"),
        acknowledgedAt: isLead ? new Date() : prior?.acknowledgedAt,
        declinedReason: prior?.declinedReason,
      };
    });
    await project.save();

    // ── Cascade: update BookingService status to in-progress ──
    if (project.bookingId) {
      await BookingService.findByIdAndUpdate(project.bookingId, { status: "in-progress" }).catch(() => {});
    }

    // Step 4 already created the authoritative Work Orders and daily schedule.
    // Starting the project only releases those records; it must never generate
    // a second schedule or redistribute units.
    await reconcileCommittedSchedule(project).catch(error => console.warn("Committed schedule reconciliation skipped:", error.message));
    await releaseUnblockedWorkOrders(project._id);

    // Notify all assigned members (except the lead) to accept / decline.
    const io = req.app.get("io");
    const startDate = project.plannedStartDate || project.preferredStartDate;
    const endDate = project.plannedCompletionDate || project.preferredCompletionDeadline;
    const fmtRange = (a, b) => {
      const f = (d) => d ? new Date(d).toLocaleDateString("en-PH", { month: "short", day: "numeric" }) : "TBD";
      return `${f(a)} – ${f(b)}`;
    };
    const projName = project.customer?.name || project.service?.name || "a commercial project";
    for (const t of project.assignedTechnicians) {
      if (t._id.toString() === tech._id.toString()) continue;
      await createNotification({
        type: "project_team_assigned",
        title: "New Commercial Project — accept or decline",
        message: `Lead: ${tech.name}. Project: ${projName}. Duration: ${fmtRange(startDate, endDate)}. Role: Service Technician. Open My Work to Accept or Decline.`,
        userId: t._id,
        role: "technician",
        referenceId: project._id,
        referenceModel: "Project",
        link: "/technician/assignments",
        priority: "high",
        io,
      }).catch(() => {});
      if (io) io.to(`tech:${t._id}`).emit("project:team_assigned", { projectId: project._id, lead: tech.name, project: projName, duration: fmtRange(startDate, endDate) });
    }
    // Notify admin that the lead accepted and work begins.
    await createNotification({
      type: "project_lead_accepted",
      title: "Lead accepted project",
      message: `${tech.name} accepted the project for ${project.customer?.name || "a customer"}. Work begins — waiting for team acknowledgement.`,
      role: "admin",
      referenceId: project._id,
      referenceModel: "Project",
      link: `/admin/projects/${project._id}`,
      priority: "normal",
      io,
    }).catch(() => {});

    res.json({ project });
  } catch (error) {
    console.error("Error accepting project:", error);
    res.status(500).json({ error: "Failed to accept project" });
  }
});

/**
 * Lead Technician declines the commercial project assignment (with reason).
 * Admin is notified and can reassign the lead.
 */
router.post("/projects/:id/lead-decline", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });
    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.leadTechnicianId || project.leadTechnicianId.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Only the assigned lead technician can decline this project" });
    }
    if (project.status !== "ready" && project.status !== "planning") {
      return res.status(400).json({ error: `Project cannot be declined from "${project.status}" status` });
    }
    project.leadDeclinedReason = reason || "No reason provided";
    const io = req.app.get("io");
    await createNotification({
      type: "project_lead_declined",
      title: "Lead declined project",
      message: `${tech.name} declined the project for ${project.customer?.name || "a customer"}. Reason: ${project.leadDeclinedReason}. Please reassign the lead.`,
      role: "admin",
      referenceId: project._id,
      referenceModel: "Project",
      link: `/admin/projects/${project._id}`,
      priority: "high",
      io,
    }).catch(() => {});
    await project.save();
    res.json({ project, message: "Project declined — admin notified" });
  } catch (error) {
    console.error("Error declining project:", error);
    res.status(500).json({ error: "Failed to decline project" });
  }
});

/**
 * Assigned member acknowledges the project assignment ("Got it").
 * Members do not approve/reject — they simply confirm receipt.
 */
router.post("/projects/:id/acknowledge", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });
    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const onTeam = (project.assignedTechnicians || []).some((t) => t._id.toString() === tech._id.toString());
    if (!onTeam) return res.status(403).json({ error: "You are not assigned to this project" });

    const teamStatus = project.teamStatus || [];
    let entry = teamStatus.find((t) => t._id && t._id.toString() === tech._id.toString());
    if (!entry) {
      entry = { _id: tech._id, name: tech.name, status: "acknowledged", acknowledgedAt: new Date() };
      teamStatus.push(entry);
    } else {
      entry.status = "acknowledged";
      entry.acknowledgedAt = new Date();
    }
    project.teamStatus = teamStatus;
    await project.save();

    // Notify the lead that this member acknowledged.
    if (project.leadTechnicianId && project.leadTechnicianId.toString() !== tech._id.toString()) {
      const io = req.app.get("io");
      await createNotification({
        type: "project_member_ack",
        title: "Team member acknowledged",
        message: `${tech.name} acknowledged the assignment for ${project.customer?.name || "the project"}.`,
        userId: project.leadTechnicianId,
        role: "technician",
        referenceId: project._id,
        referenceModel: "Project",
        link: "/technician/assignments",
        priority: "normal",
        io,
      }).catch(() => {});
    }
    res.json({ project });
  } catch (error) {
    console.error("Error acknowledging project:", error);
    res.status(500).json({ error: "Failed to acknowledge project" });
  }
});

/**
 * Assigned member ACCEPTS the commercial project assignment.
 * Members explicitly accept (or decline) — the admin-assigned team confirms
 * participation. Notifying the lead keeps them informed of team confirmation.
 */
router.post("/projects/:id/member-accept", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });
    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const onTeam = (project.assignedTechnicians || []).some((t) => t._id.toString() === tech._id.toString());
    if (!onTeam) return res.status(403).json({ error: "You are not assigned to this project" });
    if (project.leadTechnicianId && project.leadTechnicianId.toString() === tech._id.toString()) {
      return res.status(400).json({ error: "The lead accepts from the lead assignment card, not here." });
    }

    const teamStatus = project.teamStatus || [];
    let entry = teamStatus.find((t) => t._id && t._id.toString() === tech._id.toString());
    if (!entry) {
      entry = { _id: tech._id, name: tech.name, status: "acknowledged", acknowledgedAt: new Date(), declinedReason: "" };
      teamStatus.push(entry);
    } else {
      entry.status = "acknowledged";
      entry.acknowledgedAt = new Date();
      entry.declinedReason = "";
    }
    project.teamStatus = teamStatus;
    await project.save();

    const io = req.app.get("io");
    if (io) io.to("admin-room").emit("project:team-status", { projectId: project._id, teamStatus: project.teamStatus });
    if (project.leadTechnicianId && project.leadTechnicianId.toString() !== tech._id.toString()) {
      await createNotification({
        type: "project_member_ack",
        title: "Team member accepted",
        message: `${tech.name} accepted the assignment for ${project.customer?.name || "the project"}.`,
        userId: project.leadTechnicianId,
        role: "technician",
        referenceId: project._id,
        referenceModel: "Project",
        link: "/technician/assignments",
        priority: "normal",
        io,
      }).catch(() => {});
    }
    res.json({ project });
  } catch (error) {
    console.error("Error accepting project assignment:", error);
    res.status(500).json({ error: "Failed to accept project assignment" });
  }
});

/**
 * Assigned member reports a conflict and cannot participate (leave / double-booked).
 * This is the only path for a member to opt out — the default is "Got it".
 * Admin and the lead are notified so the admin can replace the member.
 */
router.post("/projects/:id/member-decline", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });
    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const onTeam = (project.assignedTechnicians || []).some((t) => t._id.toString() === tech._id.toString());
    if (!onTeam) return res.status(403).json({ error: "You are not assigned to this project" });
    if (project.leadTechnicianId && project.leadTechnicianId.toString() === tech._id.toString()) {
      return res.status(400).json({ error: "The lead cannot use this — use Decline instead." });
    }

    // Mark the member as declined in the team roster.
    const teamStatus = project.teamStatus || [];
    let entry = teamStatus.find((t) => t._id && t._id.toString() === tech._id.toString());
    if (!entry) {
      entry = { _id: tech._id, name: tech.name, status: "declined", declinedReason: reason || "", acknowledgedAt: undefined };
      teamStatus.push(entry);
    } else {
      entry.status = "declined";
      entry.declinedReason = reason || "";
      entry.acknowledgedAt = undefined;
    }
    project.teamStatus = teamStatus;
    await project.save();

    const io = req.app.get("io");
    const leadName = (project.assignedTechnicians || []).find((t) => project.leadTechnicianId && t._id.toString() === project.leadTechnicianId.toString());
    const reasonText = reason || "No reason provided";
    // Notify admin (high priority) — admin replaces the member.
    await createNotification({
      type: "project_member_declined",
      title: "Team member cannot participate",
      message: `${tech.name} reported a conflict and cannot join "${project.customer?.name || "the project"}"${leadName ? " (Lead: " + leadName.name + ")" : ""}. Reason: ${reasonText}. Please replace the member.`,
      role: "admin",
      referenceId: project._id,
      referenceModel: "Project",
      link: `/admin/projects/${project._id}`,
      priority: "high",
      io,
    }).catch(() => {});
    // Notify the lead too.
    if (project.leadTechnicianId) {
      await createNotification({
        type: "project_member_declined",
        title: "Team member dropped out",
        message: `${tech.name} cannot participate (${reasonText}). Admin has been notified to find a replacement.`,
        userId: project.leadTechnicianId,
        role: "technician",
        referenceId: project._id,
        referenceModel: "Project",
        link: "/technician/assignments",
        priority: "normal",
        io,
      }).catch(() => {});
    }

    res.json({ project, message: "Conflict reported — admin notified" });
  } catch (error) {
    console.error("Error reporting member conflict:", error);
    res.status(500).json({ error: "Failed to report conflict" });
  }
});

// Technician marks their equipment ready for a work order (moves assigned → accepted).
router.put("/work-orders/:id/equipment-ready", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid work order id" });
    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ error: "Work order not found" });
    if (workOrder.status !== "assigned") return res.status(400).json({ error: `Equipment can only be marked ready from "assigned" (current: ${workOrder.status})` });
    if (workOrder.planningStatus !== "released" || workOrder.status !== "assigned") {
      return res.status(409).json({ error: "Only released work orders assigned to the field team can be accepted." });
    }
    if (workOrder.dependencies?.length) {
      const incompleteDependencies = await WorkOrder.find({ _id: { $in: workOrder.dependencies }, status: { $ne: "completed" } }).select("workOrderNumber title").lean();
      if (incompleteDependencies.length) return res.status(409).json({ error: `Prerequisite work must finish first: ${incompleteDependencies.map(order => order.workOrderNumber || order.title).join(", ")}.` });
    }
    workOrder.status = "accepted";
    workOrder.activity.push({ action: "technician_accepted", actorId: req.user._id, actorName: req.user.name || req.user.email || "Technician" });
    await workOrder.save();
    res.json({ workOrder, message: "Equipment ready" });
  } catch (error) {
    console.error("Error marking equipment ready:", error);
    res.status(500).json({ error: "Failed to mark equipment ready" });
  }
});

router.put("/work-orders/:id/checklist", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    const { checklist } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid work order id" });
    }

    if (!Array.isArray(checklist)) {
      return res.status(400).json({ error: "checklist must be an array" });
    }

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) {
      return res.status(404).json({ error: "Work order not found" });
    }

    // ── Membership guard ───────────────────────────────────────────────────
    // Previously ANY technician could rewrite ANY work order's checklist.
    // Restrict to this WO's crew, the project team, or the project lead.
    const techUser = req.user;
    const technician = await Technician.findOne({ user: techUser._id }).lean();
    const techIdStr = String(technician?._id || "");
    const project = await Project.findById(workOrder.projectId)
      .select("assignedTechnicians leadTechnicianId")
      .lean();
    const woCrewIds = (workOrder.assignedTechnicians || []).map((t) =>
      String(typeof t === "object" && t !== null ? (t._id || t) : t),
    );
    const teamIds = (project?.assignedTechnicians || []).map((t) =>
      String(typeof t === "object" && t !== null ? (t._id || t) : t),
    );
    const isLead = project && String(project.leadTechnicianId || "") === techIdStr;
    if (!technician || (!woCrewIds.includes(techIdStr) && !teamIds.includes(techIdStr) && !isLead)) {
      return res.status(403).json({ error: "You are not part of this project's crew." });
    }

    // Sanitize to the WorkOrder.checklist subdoc contract ({label,completed})
    // and cap size so a bad client can't bloat the document.
    workOrder.checklist = checklist
      .slice(0, 50)
      .map((item) => ({
        label: String(item?.label ?? item?.text ?? "").trim().slice(0, 300),
        completed: !!item?.completed,
        completedAt: item?.completed ? (item.completedAt || new Date()) : null,
        completedBy: item?.completed ? (item.completedBy || technician.name || techUser.name) : null,
      }))
      .filter((item) => item.label);

    await workOrder.save();

    res.json({ workOrder });
  } catch (error) {
    console.error("Error updating checklist:", error);
    res.status(500).json({ error: "Failed to update checklist" });
  }
});

router.put("/work-orders/:id/accept", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid work order id" });
    }

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) {
      return res.status(404).json({ error: "Work order not found" });
    }

    workOrder.status = "accepted";
    await workOrder.save();

    res.json({ workOrder, message: "Work order accepted" });
  } catch (error) {
    console.error("Error accepting work order:", error);
    res.status(500).json({ error: "Failed to accept work order" });
  }
});

router.put("/work-orders/:id/decline", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid work order id" });
    }
    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ error: "Work order not found" });
    if (!["assigned", "accepted"].includes(workOrder.status)) {
      return res.status(400).json({ error: `Cannot decline a work order that is ${workOrder.status}` });
    }
    workOrder.status = "declined";
    workOrder.declinedReason = reason ? String(reason).slice(0, 500) : "";
    await workOrder.save();

    const io = req.app.get("io");
    if (io) {
      io.to("admin-room").emit("project:wo-status", {
        workOrderId: workOrder._id,
        projectId: workOrder.projectId,
        status: "declined",
        reason: workOrder.declinedReason,
        ts: new Date(),
      });
    }
    res.json({ workOrder, message: "Work order declined" });
  } catch (error) {
    console.error("Error declining work order:", error);
    res.status(500).json({ error: "Failed to decline work order" });
  }
});

router.put("/work-orders/:id/progress", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    const { completedUnitCount, status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid work order id" });
    }

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) {
      return res.status(404).json({ error: "Work order not found" });
    }
    const project = await Project.findById(workOrder.projectId).select("isLargeScale").lean();
    if (project?.isLargeScale) {
      return res.status(409).json({
        error: "Large-scale progress requires a proof photo and consumable declaration per submission.",
        code: "PROJECT_WORK_SUBMISSION_REQUIRED",
      });
    }

    if (completedUnitCount !== undefined) {
      workOrder.completedUnitCount = Math.min(completedUnitCount, workOrder.unitCount);
      if (workOrder.units?.length) {
        workOrder.units.forEach((unit, index) => {
          if (index < workOrder.completedUnitCount && unit.status !== "cancelled") {
            unit.status = "completed";
            unit.completedAt = unit.completedAt || new Date();
          }
        });
      }
    }
    if (status) {
      workOrder.status = status;
    }
    if (status === "in_progress" && !workOrder.actualStartDate) {
      workOrder.actualStartDate = new Date();
    }
    if (workOrder.completedUnitCount >= workOrder.unitCount) {
      workOrder.status = "awaiting_review";
      workOrder.completedUnitCount = workOrder.unitCount;
      workOrder.actualCompletionDate = null;
    } else if (workOrder.completedUnitCount > 0) {
      workOrder.status = "partially_completed";
      workOrder.actualCompletionDate = null;
    }

    workOrder.activity.push({ action: workOrder.status === "awaiting_review" ? "units_completed" : "progress_updated", actorId: req.user._id, actorName: req.user.name || req.user.email || "Technician", details: { completedUnitCount: workOrder.completedUnitCount, totalUnits: workOrder.unitCount } });

    await workOrder.save();
    await updateProjectProgress(workOrder.projectId);

    res.json({ workOrder });
  } catch (error) {
    console.error("Error updating work order progress:", error);
    res.status(500).json({ error: "Failed to update progress" });
  }
});

// ── Work Order field lifecycle (En Route / Arrived / Start) ─────────────────
// Consumables available to the calling technician for the next project work
// submission. Only physically issued stock can be reported as used.
router.get("/projects/:id/submission-consumables", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid project id" });
    const technician = await Technician.findOne({ user: req.user._id }).lean();
    if (!technician) return res.status(404).json({ error: "Technician profile not found" });
    const project = await Project.findById(req.params.id).select("isLargeScale assignedTechnicians").lean();
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.isLargeScale) return res.status(409).json({ error: "Work submissions are only available for large-scale projects." });
    const isCrewMember = (project.assignedTechnicians || []).some(member => String(member._id) === String(technician._id));
    if (!isCrewMember) return res.status(403).json({ error: "You are not on this project team." });

    const assignments = await EquipmentAssignment.find({
      $or: [{ projectId: project._id }, { projectIds: project._id }],
      technicianId: technician._id,
      consumable: true,
      status: { $in: ["checked_out", "in_use"] },
    }).populate("equipmentId", "itemName unit").sort({ workDate: 1, equipmentName: 1 }).lean();
    const consumables = assignments.map(item => ({
      assignmentId: item._id,
      toolId: item.equipmentId?._id || item.equipmentId,
      itemName: item.equipmentName || item.equipmentId?.itemName || "Consumable",
      unit: item.equipmentId?.unit || "pcs",
      quantityIssued: Number(item.quantity || 0),
      quantityUsed: Number(item.consumableUsed || 0),
      quantityRemaining: Math.max(0, Number(item.quantity || 0) - Number(item.consumableUsed || 0) - Number(item.consumableReturned || 0)),
      workDate: item.workDate,
    })).filter(item => item.quantityRemaining > 0);
    res.json({ consumables });
  } catch (error) {
    console.error("Failed to load submission consumables:", error);
    res.status(500).json({ error: "Failed to load issued consumables" });
  }
});

// One immutable evidence record covers one technician action, even when the
// completed units span several work orders. Unit progress, inventory usage and
// the submission ledger commit together in a MongoDB transaction.
router.post("/projects/:id/work-submissions", auth.authenticate, auth.requireRole("technician"), (req, res) => {
  workSubmissionUpload(req, res, async (uploadError) => {
    let committed = false;
    let session;
    try {
      if (uploadError) return res.status(400).json({ error: `Proof upload failed: ${uploadError.message}` });
      if (!req.file) return res.status(400).json({ error: "A JPEG, PNG or WebP proof photo is required for every submission." });
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw Object.assign(new Error("Invalid project id"), { status: 400 });

      const payload = normalizeProjectWorkSubmission(req.body);
      if (payload.workOrders.some(row => !mongoose.Types.ObjectId.isValid(row.workOrderId))
        || payload.consumables.some(row => !mongoose.Types.ObjectId.isValid(row.assignmentId))) {
        throw Object.assign(new Error("The submission contains an invalid record id."), { status: 400 });
      }
      const technician = await Technician.findOne({ user: req.user._id }).lean();
      if (!technician) throw Object.assign(new Error("Technician profile not found"), { status: 404 });

      const duplicate = await ProjectWorkSubmission.findOne({
        projectId: req.params.id,
        technicianId: technician._id,
        clientSubmissionId: payload.clientSubmissionId,
      }).lean();
      if (duplicate) {
        await removeSubmissionUpload(req.file);
        return res.json({ submission: duplicate, duplicate: true, message: "This work submission was already recorded." });
      }

      const proofUrl = `/uploads/project-work-submissions/${req.file.filename}`;
      let createdSubmission;
      let committedLines = [];
      session = await mongoose.startSession();
      await session.withTransaction(async () => {
        const project = await Project.findById(req.params.id).session(session);
        if (!project) throw Object.assign(new Error("Project not found"), { status: 404 });
        if (!project.isLargeScale) throw Object.assign(new Error("Work submissions are only available for large-scale projects."), { status: 409 });
        if (!(project.assignedTechnicians || []).some(member => String(member._id) === String(technician._id))) {
          throw Object.assign(new Error("You are not on this project team."), { status: 403 });
        }
        if (project.status !== "in_progress") {
          throw Object.assign(new Error("The project must be active before work can be submitted."), { status: 409 });
        }
        if (project.projectPhase && project.projectPhase !== "execution") {
          throw Object.assign(new Error("Work completion is locked until assessment and quotation review are finished."), { status: 409 });
        }

        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
        const todayRows = await DailyAssignment.find({
          projectId: project._id,
          date: { $gte: dayStart, $lt: dayEnd },
          planningOnly: false,
          status: { $ne: "skipped" },
        }).select("workOrderId").session(session).lean();
        const todayWorkOrderIds = [...new Set(todayRows.map(row => String(row.workOrderId)))];
        const startedToday = todayWorkOrderIds.length
          ? await WorkOrder.countDocuments({
              _id: { $in: todayWorkOrderIds },
              projectId: project._id,
              status: { $in: ["in_progress", "partially_completed", "awaiting_review"] },
            }).session(session)
          : 0;
        if (!startedToday) throw Object.assign(new Error("The team lead must start today's project work before units can be submitted."), { status: 409 });

        const requestedIds = payload.workOrders.map(row => row.workOrderId);
        const workOrders = await WorkOrder.find({ _id: { $in: requestedIds }, projectId: project._id }).session(session);
        if (workOrders.length !== requestedIds.length) {
          throw Object.assign(new Error("One or more work orders do not belong to this project."), { status: 400 });
        }
        const byWorkOrderId = new Map(workOrders.map(order => [String(order._id), order]));
        const now = new Date();
        committedLines = payload.workOrders.map(line => {
          const workOrder = byWorkOrderId.get(line.workOrderId);
          if (workOrder.planningStatus !== "released") {
            throw Object.assign(new Error(`${workOrder.workOrderNumber || workOrder.title || "Work order"} has not been released for execution.`), { status: 409 });
          }
          if (!["assigned", "accepted", "en_route", "arrived", "in_progress", "partially_completed"].includes(workOrder.status)) {
            throw Object.assign(new Error(`${workOrder.workOrderNumber || workOrder.title || "Work order"} is not open for unit submission.`), { status: 409 });
          }
          const available = (workOrder.units || []).filter(unit => !["completed", "cancelled"].includes(unit.status));
          if (line.completedUnits > available.length) {
            throw Object.assign(new Error(`Only ${available.length} tracked unit(s) remain on ${workOrder.workOrderNumber || workOrder.title || "this work order"}.`), { status: 409 });
          }
          return { line, workOrder, selected: available.slice(0, line.completedUnits), now };
        });

        const consumableRecords = [];
        if (payload.consumables.length) {
          const assignmentIds = payload.consumables.map(row => row.assignmentId);
          const assignments = await EquipmentAssignment.find({
            _id: { $in: assignmentIds },
            $or: [{ projectId: project._id }, { projectIds: project._id }],
            technicianId: technician._id,
            consumable: true,
            status: { $in: ["checked_out", "in_use"] },
          }).session(session);
          if (assignments.length !== assignmentIds.length) {
            throw Object.assign(new Error("One or more consumables were not issued to you for this project."), { status: 400 });
          }
          const byAssignmentId = new Map(assignments.map(item => [String(item._id), item]));
          for (const line of payload.consumables) {
            const assignment = byAssignmentId.get(line.assignmentId);
            const issued = Number(assignment.quantity || 0);
            const usedBefore = Number(assignment.consumableUsed || 0);
            const remaining = Math.max(0, issued - usedBefore - Number(assignment.consumableReturned || 0));
            if (line.quantityUsed > remaining) {
              throw Object.assign(new Error(`${assignment.equipmentName}: only ${remaining} of ${issued} issued remain unreported.`), { status: 409 });
            }
            const tool = await Tool.findById(assignment.equipmentId).session(session);
            if (!tool) throw Object.assign(new Error(`${assignment.equipmentName} is no longer linked to inventory.`), { status: 409 });
            const issuedByDailyKit = Boolean(assignment.dailyKitId);
            if (!issuedByDailyKit) {
              if (Number(tool.quantity || 0) < line.quantityUsed) {
                throw Object.assign(new Error(`${assignment.equipmentName}: inventory has only ${Number(tool.quantity || 0)} remaining.`), { status: 409 });
              }
              const quantityBefore = Number(tool.quantity || 0);
              tool.quantity = quantityBefore - line.quantityUsed;
              tool.reservedQuantity = Math.max(0, Number(tool.reservedQuantity || 0) - line.quantityUsed);
              await tool.save({ session });
              await StockAdjustment.create([{
                toolId: tool._id,
                type: "job_usage",
                quantityBefore,
                quantityAfter: Number(tool.quantity),
                delta: -line.quantityUsed,
                notes: `Large-scale project work submission for ${project._id}`,
                referenceId: project.bookingId || undefined,
                adjustedBy: req.user._id,
              }], { session });
            }
            const cumulativeQuantityUsed = usedBefore + line.quantityUsed;
            assignment.consumableUsed = cumulativeQuantityUsed;
            assignment.status = cumulativeQuantityUsed >= issued ? "consumed" : "in_use";
            await assignment.save({ session });
            if (issuedByDailyKit) {
              const kit = await DailyKit.findById(assignment.dailyKitId).session(session);
              const kitItem = kit?.items?.find(item =>
                String(item.equipmentAssignmentId || "") === String(assignment._id) ||
                (String(item.toolId || "") === String(assignment.equipmentId) && (item.projectIds || []).some(id => String(id) === String(project._id)))
              );
              if (!kitItem) throw Object.assign(new Error(`${assignment.equipmentName} is no longer linked to the shared Daily Kit.`), { status: 409 });
              const kitRemaining = Number(kitItem.quantityIssued || 0) - Number(kitItem.quantityUsed || 0) - Number(kitItem.quantityReturned || 0);
              if (line.quantityUsed > kitRemaining) throw Object.assign(new Error(`${assignment.equipmentName}: only ${kitRemaining} remain in the shared Daily Kit.`), { status: 409 });
              kitItem.quantityUsed = Number(kitItem.quantityUsed || 0) + line.quantityUsed;
              await kit.save({ session });
              await ServiceToolUsage.create([{
                projectId: project._id,
                workOrderId: assignment.workOrderId || undefined,
                dailyAssignmentId: assignment.dailyAssignmentIds?.[0] || undefined,
                technicianId: technician._id,
                toolItemId: tool._id,
                inventoryItemId: tool._id,
                itemName: assignment.equipmentName || tool.itemName,
                itemType: "consumable",
                unit: tool.unit || "pcs",
                quantityUsed: line.quantityUsed,
                unitPrice: Number(tool.costPrice || 0),
                deductedFromInventory: true,
                notes: "Actual project usage from shared Daily Kit issuance",
                recordedBy: req.user._id,
              }], { session });
            }
            consumableRecords.push({
              equipmentAssignmentId: assignment._id,
              toolId: tool._id,
              itemName: assignment.equipmentName || tool.itemName,
              unit: tool.unit || "pcs",
              quantityUsed: line.quantityUsed,
              quantityIssued: issued,
              cumulativeQuantityUsed,
            });
          }
        }

        [createdSubmission] = await ProjectWorkSubmission.create([{
          projectId: project._id,
          technicianId: technician._id,
          submittedByUserId: req.user._id,
          clientSubmissionId: payload.clientSubmissionId,
          notes: payload.notes,
          proof: { url: proofUrl, originalName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size },
          workOrders: committedLines.map(({ line, workOrder, selected }) => ({
            workOrderId: workOrder._id,
            workOrderNumber: workOrder.workOrderNumber,
            title: workOrder.title || workOrder.section,
            completedUnits: line.completedUnits,
            unitKeys: selected.map(unit => unit.unitKey),
          })),
          consumablesDeclaredNone: payload.consumablesDeclaredNone,
          consumables: consumableRecords,
        }], { session });

        for (const { line, workOrder, selected } of committedLines) {
          selected.forEach(unit => {
            unit.status = "completed";
            unit.completedAt = now;
            unit.completedBy = technician._id;
            if (payload.notes) unit.notes = payload.notes;
          });
          workOrder.completedUnitCount = (workOrder.units || []).filter(unit => unit.status === "completed").length;
          const executableTotal = (workOrder.units || []).filter(unit => unit.status !== "cancelled").length;
          workOrder.status = workOrder.completedUnitCount >= executableTotal ? "awaiting_review" : "partially_completed";
          workOrder.actualCompletionDate = null;
          workOrder.activity.push({
            action: "units_submitted_with_evidence",
            actorId: req.user._id,
            actorName: technician.name || req.user.name || "Technician",
            details: {
              submissionId: createdSubmission._id,
              completedUnits: line.completedUnits,
              unitKeys: selected.map(unit => unit.unitKey),
              proofUrl,
              consumables: consumableRecords.map(item => ({ itemName: item.itemName, quantityUsed: item.quantityUsed, unit: item.unit })),
              notes: payload.notes,
            },
            timestamp: now,
          });
          await workOrder.save({ session });
        }
      });
      committed = true;

      for (const { line, workOrder } of committedLines) {
        const day = new Date(); day.setHours(0, 0, 0, 0);
        await DailyAssignment.findOneAndUpdate(
          { projectId: req.params.id, workOrderId: workOrder._id, technicianId: technician._id, date: day },
          { $inc: { completedUnits: line.completedUnits }, $set: { planningOnly: false }, $setOnInsert: { targetUnits: 0, generatedBy: "system" } },
          { upsert: true, returnDocument: "after", runValidators: true },
        ).catch(error => console.warn("Submission daily summary refresh skipped:", error.message));
        await rebalanceFutureUnitTargets(workOrder).catch(error => console.warn("Future target reconciliation skipped:", error.message));
      }
      await updateProjectProgress(req.params.id).catch(error => console.warn("Project progress refresh skipped:", error.message));
      return res.status(201).json({
        submission: createdSubmission,
        completedUnits: committedLines.reduce((sum, item) => sum + item.line.completedUnits, 0),
        message: "Work, proof and consumable usage submitted successfully.",
      });
    } catch (error) {
      if (!committed) await removeSubmissionUpload(req.file);
      if (error?.code === 11000) return res.status(409).json({ error: "This submission id has already been used. Refresh and try again." });
      console.error("Failed to create project work submission:", error);
      return res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to submit project work" });
    } finally {
      if (session) await session.endSession().catch(() => {});
    }
  });
});

router.post("/work-orders/:id/submit-units", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: "Invalid work order id" });
    }
    const requested = Number(req.body.completedUnits);
    if (!Number.isInteger(requested) || requested < 1) {
      return res.status(400).json({ error: "Done units must be a whole number greater than zero." });
    }
    const technician = await Technician.findOne({ user: req.user._id }).lean();
    if (!technician) return res.status(404).json({ error: "Technician profile not found" });

    let updatedWorkOrder = null;
    let completedUnits = [];
    for (let attempt = 0; attempt < 3 && !updatedWorkOrder; attempt += 1) {
      const workOrder = await WorkOrder.findById(req.params.id).lean();
      if (!workOrder) return res.status(404).json({ error: "Work order not found" });
      const project = await Project.findById(workOrder.projectId).select("assignedTechnicians status projectPhase isLargeScale").lean();
      if (project?.isLargeScale) {
        return res.status(409).json({
          error: "Large-scale progress requires a proof photo and consumable declaration per submission.",
          code: "PROJECT_WORK_SUBMISSION_REQUIRED",
        });
      }
      const isCrewMember = (project?.assignedTechnicians || []).some(member => String(member._id) === String(technician._id));
      if (!isCrewMember) return res.status(403).json({ error: "You are not on this project team." });
      if (!["assigned", "accepted", "en_route", "arrived", "in_progress", "partially_completed"].includes(workOrder.status)) {
        return res.status(409).json({ error: "The team lead must start this work order before units can be submitted." });
      }
      // Once today's project work is started, the crew may work ahead. The
      // daily allocation is a target; real unfinished unit rows are the limit.
      const activeToday = await scheduledWorkOrdersForDay(project._id, ["in_progress", "partially_completed", "awaiting_review"]);
      if (!activeToday.length) {
        return res.status(409).json({ error: "The team lead must start today's project work before units can be submitted." });
      }

      const available = (workOrder.units || [])
        .map((unit, index) => ({ unit, index }))
        .filter(({ unit }) => unit.status !== "completed" && unit.status !== "cancelled");
      if (requested > available.length) {
        return res.status(409).json({ error: `Only ${available.length} tracked unit(s) remain on this work order.` });
      }

      const now = new Date();
      const selected = available.slice(0, requested);
      const alreadyCompleted = (workOrder.units || []).filter(unit => unit.status === "completed").length;
      const nextCompleted = alreadyCompleted + selected.length;
      const executableTotal = (workOrder.units || []).filter(unit => unit.status !== "cancelled").length;
      const set = {
        completedUnitCount: nextCompleted,
        status: nextCompleted >= executableTotal ? "awaiting_review" : "partially_completed",
        actualCompletionDate: null,
      };
      const notes = String(req.body.notes || "").trim().slice(0, 1000);
      selected.forEach(({ index }) => {
        set[`units.${index}.status`] = "completed";
        set[`units.${index}.completedAt`] = now;
        set[`units.${index}.completedBy`] = technician._id;
        if (notes) set[`units.${index}.notes`] = notes;
      });
      updatedWorkOrder = await WorkOrder.findOneAndUpdate(
        { _id: workOrder._id, __v: workOrder.__v },
        {
          $set: set,
          $inc: { __v: 1 },
          $push: { activity: {
            action: "units_submitted",
            actorId: req.user._id,
            actorName: technician.name || req.user.name || "Technician",
            details: { completedUnits: selected.length, unitKeys: selected.map(({ unit }) => unit.unitKey), notes },
            timestamp: now,
          } },
        },
        { returnDocument: "after", runValidators: true }
      );
      if (updatedWorkOrder) completedUnits = selected.map(({ unit }) => unit.label || unit.unitKey);
    }
    if (!updatedWorkOrder) {
      return res.status(409).json({ error: "Unit progress changed while you were submitting. Please review and try again." });
    }

    // Unit rows above are the source of truth. Summary maintenance is isolated
    // so a secondary failure never reports a committed submission as failed and
    // causes the technician to accidentally submit another batch on retry.
    try {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      const daily = await DailyAssignment.findOneAndUpdate(
        { projectId: updatedWorkOrder.projectId, workOrderId: updatedWorkOrder._id, technicianId: technician._id, date: day },
        {
          $inc: { completedUnits: requested },
          $set: { planningOnly: false },
          $setOnInsert: { targetUnits: 0, generatedBy: "system" },
        },
        { upsert: true, returnDocument: "after", runValidators: true }
      );
      daily.status = Number(daily.completedUnits || 0) >= Number(daily.targetUnits || 0) ? "completed" : "in_progress";
      daily.completedAt = daily.status === "completed" ? new Date() : null;
      await daily.save();
    } catch (summaryError) {
      console.warn("Daily unit summary refresh skipped:", summaryError.message);
    }
    await rebalanceFutureUnitTargets(updatedWorkOrder).catch(error => console.warn("Future target reconciliation skipped:", error.message));
    await updateProjectProgress(updatedWorkOrder.projectId).catch(error => console.warn("Project progress refresh skipped:", error.message));
    res.json({ workOrder: updatedWorkOrder, completedUnits, message: `${requested} done unit${requested === 1 ? "" : "s"} submitted.` });
  } catch (error) {
    console.error("Failed to submit completed units:", error);
    res.status(500).json({ error: error.message || "Failed to submit completed units" });
  }
});

router.put("/work-orders/:id/units/:unitKey", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const workOrder = await WorkOrder.findById(req.params.id);
    if (!workOrder) return res.status(404).json({ error: "Work order not found" });
    if (workOrder.planningStatus !== "released") return res.status(409).json({ error: "Draft units cannot be executed." });
    const technician = await Technician.findOne({ user: req.user._id }).lean();
    const project = await Project.findById(workOrder.projectId).select("assignedTechnicians leadTechnicianId isLargeScale").lean();
    const isCrewMember = technician && (project?.assignedTechnicians || []).some(member => String(member._id) === String(technician._id));
    if (!isCrewMember) return res.status(403).json({ error: "You are not on this project team." });
    if (!["in_progress", "partially_completed", "awaiting_review"].includes(workOrder.status)) {
      return res.status(409).json({ error: "The team lead must start this work order before units can be updated." });
    }
    const todayOrders = await scheduledWorkOrdersForDay(project._id, ["in_progress", "partially_completed", "awaiting_review"]);
    if (!todayOrders.some(order => String(order._id) === String(workOrder._id))) {
      return res.status(409).json({ error: "This work order is not scheduled for today." });
    }
    const unit = workOrder.units.find(row => row.unitKey === req.params.unitKey);
    if (!unit) return res.status(404).json({ error: "Tracked unit not found" });
    const nextStatus = ["pending", "in_progress", "completed", "on_hold"].includes(req.body.status) ? req.body.status : "completed";
    if (project.isLargeScale && (nextStatus === "completed" || unit.status === "completed")) {
      return res.status(409).json({
        error: "Large-scale unit completion must be recorded with proof and a consumable declaration.",
        code: "PROJECT_WORK_SUBMISSION_REQUIRED",
      });
    }
    const wasCompleted = unit.status === "completed";
    unit.status = nextStatus; unit.notes = String(req.body.notes || unit.notes || "").slice(0, 1000);
    if (nextStatus === "completed") { unit.completedAt = new Date(); unit.completedBy = technician._id; }
    else { unit.completedAt = null; unit.completedBy = null; }
    const complete = workOrder.units.filter(row => row.status === "completed").length;
    workOrder.completedUnitCount = complete;
    workOrder.status = complete >= workOrder.unitCount ? "awaiting_review" : complete > 0 ? "partially_completed" : nextStatus === "on_hold" ? "on_hold" : "in_progress";
    workOrder.actualCompletionDate = null;
    workOrder.activity.push({ action: "unit_status_changed", actorId: req.user._id, actorName: technician.name, details: { unitKey: unit.unitKey, status: nextStatus } });
    await workOrder.save();
    await rebalanceFutureUnitTargets(workOrder);
    const completionDelta = (nextStatus === "completed" ? 1 : 0) - (wasCompleted ? 1 : 0);
    if (completionDelta) {
      const day = new Date(); day.setHours(0, 0, 0, 0);
      const daily = await DailyAssignment.findOneAndUpdate(
        { projectId: project._id, workOrderId: workOrder._id, technicianId: technician._id, date: day },
        {
          $inc: { completedUnits: completionDelta },
          $set: { status: nextStatus === "completed" ? "completed" : "in_progress", completedAt: nextStatus === "completed" ? new Date() : null, planningOnly: false },
          $setOnInsert: { targetUnits: 0, generatedBy: "system" },
        },
        { upsert: true, returnDocument: "after" }
      );
      if (daily.completedUnits < 0) { daily.completedUnits = 0; await daily.save(); }
    }
    await updateProjectProgress(workOrder.projectId);
    res.json({ workOrder, unit, message: `${unit.label || unit.unitKey} marked ${nextStatus.replace(/_/g, " ")}.` });
  } catch (error) {
    console.error("Failed to update work-order unit:", error);
    res.status(500).json({ error: error.message || "Failed to update unit" });
  }
});

// The crew completes unit tasks; only the project lead closes the batch after
// reviewing the unit records, notes, and evidence.
router.post("/work-orders/:id/submit", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid work order id" });
    const technician = await Technician.findOne({ user: req.user._id }).lean();
    if (!technician) return res.status(404).json({ error: "Technician profile not found" });
    const workOrder = await WorkOrder.findById(req.params.id);
    if (!workOrder) return res.status(404).json({ error: "Work order not found" });
    const project = await Project.findById(workOrder.projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.leadTechnicianId || String(project.leadTechnicianId) !== String(technician._id)) {
      return res.status(403).json({ error: "Only the project lead can submit this work order." });
    }
    const trackedUnits = workOrder.units || [];
    const incomplete = trackedUnits.filter(unit => !["completed", "cancelled"].includes(unit.status));
    const completed = trackedUnits.length
      ? trackedUnits.filter(unit => unit.status === "completed").length
      : Number(workOrder.completedUnitCount || 0);
    if (incomplete.length || completed < Number(workOrder.unitCount || 0)) {
      return res.status(409).json({ error: `${incomplete.length || Math.max(0, Number(workOrder.unitCount || 0) - completed)} unit(s) still need completion.` });
    }
    if (project.isLargeScale) {
      const evidence = await ProjectWorkSubmission.find({
        projectId: project._id,
        "workOrders.workOrderId": workOrder._id,
      }).select("workOrders").lean();
      const evidencedUnitKeys = new Set(evidence.flatMap(submission =>
        (submission.workOrders || [])
          .filter(line => String(line.workOrderId) === String(workOrder._id))
          .flatMap(line => line.unitKeys || [])
      ));
      const missingEvidence = trackedUnits.filter(unit => unit.status === "completed" && !evidencedUnitKeys.has(unit.unitKey));
      if (missingEvidence.length) {
        return res.status(409).json({
          error: `${missingEvidence.length} completed unit(s) do not have a proof-backed work submission.`,
          code: "PROJECT_WORK_SUBMISSION_REQUIRED",
        });
      }
    }
    workOrder.completedUnitCount = workOrder.unitCount;
    workOrder.status = "completed";
    workOrder.submittedAt = new Date();
    workOrder.submittedBy = technician._id;
    workOrder.submissionNotes = String(req.body?.notes || "").slice(0, 1000);
    workOrder.actualCompletionDate = new Date();
    workOrder.activity.push({ action: "work_order_submitted", actorId: req.user._id, actorName: technician.name, details: { completedUnits: workOrder.unitCount } });
    await workOrder.save();
    await releaseUnblockedWorkOrders(project._id);
    await updateProjectProgress(project._id);
    const remainingBatches = await WorkOrder.countDocuments({ projectId: project._id, status: { $nin: ["completed", "cancelled"] } });
    let continueTomorrow = false;
    if (remainingBatches > 0) {
      const activeToday = await scheduledWorkOrdersForDay(project._id, ["assigned", "accepted", "en_route", "arrived", "in_progress", "partially_completed", "awaiting_review"]);
      if (!activeToday.length) {
        await openNextDayAcceptance(req, project);
        continueTomorrow = true;
      }
    }
    res.json({
      workOrder,
      continueTomorrow,
      message: continueTomorrow
        ? "Work order submitted. Confirm availability to continue on the next workday."
        : "Work order reviewed and submitted.",
    });
  } catch (error) {
    console.error("Failed to submit work order:", error);
    res.status(500).json({ error: error.message || "Failed to submit work order" });
  }
});

function woTransition(allowedFrom, newStatus, tsField) {
  return async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid work order id" });
      }
      const workOrder = await WorkOrder.findById(id);
      if (!workOrder) return res.status(404).json({ error: "Work order not found" });
      const technician = await Technician.findOne({ user: req.user._id }).select("_id").lean();
      const projectForAccess = await Project.findById(workOrder.projectId).select("assignedTechnicians leadTechnicianId status").lean();
      const onTeam = technician && (projectForAccess?.assignedTechnicians || []).some(member => String(member._id) === String(technician._id));
      if (!onTeam) return res.status(403).json({ error: "You are not on this project team." });
      if (allowedFrom && !allowedFrom.includes(workOrder.status)) {
        return res.status(400).json({ error: `Cannot transition from ${workOrder.status}` });
      }

      // Block en-route / arrived / start if admin planning is not complete on the parent project.
      if (workOrder.projectId && ["en_route", "arrived", "in_progress"].includes(newStatus)) {
        const proj = projectForAccess;
        if (proj && ["pending_project_scheduling", "planning", "pending", "assigned"].includes(proj.status)) {
          return res.status(400).json({ error: "Admin planning is not yet complete — cannot proceed" });
        }
        await assertProjectDailyKitsReady(workOrder.projectId, [technician._id]);
      }
      workOrder.status = newStatus;
      if (tsField) workOrder[tsField] = new Date();
      if (newStatus === "in_progress" && !workOrder.actualStartDate) {
        workOrder.actualStartDate = new Date();
      }
      workOrder.activity.push({ action: `work_${newStatus}`, actorId: req.user._id, actorName: req.user.name || req.user.email || "Technician" });
      await workOrder.save();
      await updateProjectProgress(workOrder.projectId);

      const io = req.app.get("io");
      if (io) {
        io.to("admin-room").emit("project:wo-status", {
          workOrderId: workOrder._id,
          projectId: workOrder.projectId,
          status: newStatus,
          ts: workOrder[tsField] || new Date(),
        });
        // Notify the lead technician live so "Today's Team" reflects the update.
        const project = await Project.findById(workOrder.projectId).lean().catch(() => null);
        if (project && project.leadTechnicianId) {
          const tech = await Technician.findOne({ user: req.user._id }).lean().catch(() => null);
          io.to(`tech:${project.leadTechnicianId}`).emit("project:team-status", {
            projectId: workOrder.projectId,
            workOrderId: workOrder._id,
            technicianId: tech ? tech._id : null,
            technicianName: tech ? tech.name : null,
            status: newStatus,
            ts: new Date(),
          });
        }
      }
      res.json({ workOrder });
    } catch (error) {
      console.error(`Error on work order ${newStatus}:`, error);
      res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to update work order", code: error.code });
    }
  };
}

router.put("/work-orders/:id/en-route", auth.authenticate, auth.requireRole("technician"), woTransition(["accepted", "arrived"], "en_route", "enRouteAt"));
router.put("/work-orders/:id/arrived", auth.authenticate, auth.requireRole("technician"), woTransition(["en_route", "accepted"], "arrived", "arrivedAt"));
router.put("/work-orders/:id/start", auth.authenticate, auth.requireRole("technician"), woTransition(["arrived", "accepted"], "in_progress", "startedAt"));

// ── Lead-driven project mobilization ────────────────────────────────────────
// In large-scale projects the LEAD technician mobilizes the whole crew: one
// En Route / Arrived / Start Work action moves every active work order on the
// project. Members then only submit their finished units for the day. This
// keeps the technician UI focused on "today's work" rather than raw WOs.

// Derive the project's crew-wide daily phase from its active work orders.
function deriveProjectPhase(workOrders, project) {
  // Large-scale project phase gates (assessment → quotation_review → execution)
  if (project && project.isLargeScale && project.projectPhase) {
    if (project.projectPhase === "assessment") {
      if (project.assessmentVisit?.status === "en_route") return "assessment_en_route";
      if (["arrived", "completed"].includes(project.assessmentVisit?.status)) return "assessment_arrived";
      return "assessment";
    }
    if (project.projectPhase === "quotation_review") return "quotation_review";
    // execution phase: fall through to work-order-based phase logic
    if (project.projectPhase === "execution") {
      // If daily acceptance is required, the project is in daily_acceptance phase.
      if (project.dailyAcceptance && project.dailyAcceptance.required) {
        return "daily_acceptance";
      }
      const active = (workOrders || []).filter((w) => w.status !== "completed" && w.status !== "cancelled" && w.status !== "declined");
      if (active.length === 0) return "completed";
      const statuses = active.map((w) => w.status);
      if (statuses.some((s) => ["partially_completed", "awaiting_review"].includes(s))) return "in_progress";
      if (statuses.every((s) => s === "in_progress")) return "in_progress";
      if (statuses.some((s) => s === "in_progress")) return "in_progress";
      if (statuses.every((s) => s === "arrived")) return "arrived";
      if (statuses.some((s) => s === "arrived")) return "arrived";
      if (statuses.some((s) => s === "en_route")) return "en_route";
      return "ready";
    }
  }
  // Non-large-scale or no projectPhase set: use legacy logic
  if (project && project.dailyAcceptance && project.dailyAcceptance.required) {
    return "daily_acceptance";
  }
  const active = (workOrders || []).filter((w) => w.status !== "completed" && w.status !== "cancelled" && w.status !== "declined");
  if (active.length === 0) {
    if (project && (project.status === "pending_project_scheduling" || project.status === "planning")) return "ready";
    return "completed";
  }
  const statuses = active.map((w) => w.status);
  if (statuses.some((s) => ["partially_completed", "awaiting_review"].includes(s))) return "in_progress";
  if (statuses.every((s) => s === "in_progress")) return "in_progress";
  if (statuses.some((s) => s === "in_progress")) return "in_progress";
  if (statuses.every((s) => s === "arrived")) return "arrived";
  if (statuses.some((s) => s === "arrived")) return "arrived";
  if (statuses.some((s) => s === "en_route")) return "en_route";
  return "ready";
}

async function requireProjectLead(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) { res.status(400).json({ error: "Invalid project id" }); return null; }
  const tech = await Technician.findOne({ user: req.user._id }).lean();
  if (!tech) { res.status(404).json({ error: "Technician profile not found" }); return null; }
  const project = await Project.findById(id);
  if (!project) { res.status(404).json({ error: "Project not found" }); return null; }
  if (!project.leadTechnicianId || project.leadTechnicianId.toString() !== tech._id.toString()) {
    res.status(403).json({ error: "Only the lead technician can mobilize the team" }); return null;
  }
  return { tech, project };
}

// Confirm the whole team has accepted before the lead can mobilize.
function teamAllAccepted(project) {
  const roster = project.teamStatus || [];
  const members = roster.filter((t) => project.leadTechnicianId && t._id && t._id.toString() !== project.leadTechnicianId.toString());
  if (members.length === 0) return true; // solo lead
  return members.every((m) => m.status === "acknowledged");
}

function emitProjectPhase(req, project, phase) {
  const io = req.app.get("io");
  if (!io) return;
  const payload = { projectId: project._id, phase, ts: new Date() };
  io.to("admin-room").emit("project:phase", payload);
  for (const t of (project.assignedTechnicians || [])) {
    io.to(`tech:${t._id}`).emit("project:phase", payload);
    io.to(`tech:${t._id}`).emit("project:team-status", payload);
  }
}

async function scheduledWorkOrdersForDay(projectId, statuses, value = new Date()) {
  const start = new Date(value); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const rows = await DailyAssignment.find({
    projectId, date: { $gte: start, $lt: end }, planningOnly: false, status: { $ne: "skipped" },
  }).select("workOrderId").lean();
  const ids = [...new Set(rows.map(row => String(row.workOrderId)))];
  if (ids.length) return WorkOrder.find({ _id: { $in: ids }, projectId, status: { $in: statuses } });

  const scheduled = await WorkOrder.find({
    projectId, status: { $in: statuses }, scheduledDate: { $lt: end },
    $or: [{ scheduledEndDate: null }, { scheduledEndDate: { $exists: false } }, { scheduledEndDate: { $gte: start } }],
  });
  if (scheduled.length) return scheduled;

  // Compatibility for projects created before daily schedule records existed.
  const hasAnyPlan = await DailyAssignment.exists({ projectId });
  return hasAnyPlan ? [] : WorkOrder.find({ projectId, status: { $in: statuses } });
}

async function assertProjectDailyKitsReady(projectId, technicianIds = null, value = new Date()) {
  const start = new Date(value); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const filter = {
    projectId,
    date: { $gte: start, $lt: end },
    planningOnly: { $ne: true },
    status: { $in: ["pending", "in_progress"] },
  };
  if (technicianIds?.length) filter.technicianId = { $in: technicianIds };
  const rows = await DailyAssignment.find(filter).select("technicianId").lean();
  const ids = [...new Set(rows.map(row => String(row.technicianId)))];
  if (!ids.length) return;

  const notReady = [];
  for (const technicianId of ids) {
    const kit = await syncDailyKit(technicianId, start);
    const unresolvedDelta = kit.hasDelta && (kit.deltaItems || []).some(item =>
      !item.resolution?.status && !item.exception?.approved
    );
    if (!["confirmed", "in_progress"].includes(kit.status) || unresolvedDelta) notReady.push(technicianId);
  }
  if (!notReady.length) return;
  const technicians = await Technician.find({ _id: { $in: notReady } }).select("name").lean();
  const names = technicians.map(row => row.name).filter(Boolean);
  throw Object.assign(new Error(`Daily Preparation is incomplete for ${names.join(", ") || `${notReady.length} technician(s)`}. Confirm the shared kit before mobilizing.`), {
    status: 409,
    code: "DAILY_KIT_REQUIRED",
  });
}

async function openNextDayAcceptance(req, project) {
  const nextDate = nextWorkingDay(new Date());
  project.dailyAcceptance = {
    required: true,
    date: nextDate,
    leadAccepted: false,
    leadAcceptedAt: null,
    membersAccepted: (project.assignedTechnicians || [])
      .filter(member => project.leadTechnicianId && String(member._id) !== String(project.leadTechnicianId))
      .map(member => ({ _id: member._id, name: member.name || "Technician", accepted: false, acceptedAt: null })),
    declined: [],
  };
  await project.save();

  const io = req.app.get("io");
  const projectName = project.customer?.name || project.service?.name || "your project";
  for (const member of (project.assignedTechnicians || [])) {
    await createNotification({
      type: "daily_acceptance_required",
      title: "Daily check-in required",
      message: `Today's work ended for "${projectName}". Confirm that you can continue on the next scheduled workday.`,
      userId: member._id,
      role: "technician",
      referenceId: project._id,
      referenceModel: "Project",
      link: "/technician/assignments",
      priority: "high",
      io,
    }).catch(() => {});
    if (io) io.to(`tech:${member._id}`).emit("project:daily_acceptance", { projectId: project._id, date: nextDate });
  }
  emitProjectPhase(req, project, "daily_acceptance");
  return nextDate;
}

// Lead: mobilize the crew (En Route). Requires the full team to have accepted
// AND daily acceptance must be complete (if required).
router.put("/projects/:id/mobilize/en-route", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const { project } = ctx;
    if (!project.leadAcceptedAt) return res.status(400).json({ error: "Accept the project first" });
    if (!teamAllAccepted(project)) return res.status(400).json({ error: "Waiting for all team members to accept" });
    if (project.isLargeScale && project.projectPhase === "assessment") {
      if (!["pending", undefined].includes(project.assessmentVisit?.status)) {
        return res.status(409).json({ error: "The assessment visit is already in progress." });
      }
      project.assessmentVisit = {
        status: "en_route",
        enRouteAt: new Date(),
        technicianId: ctx.tech._id,
      };
      await project.save();
      emitProjectPhase(req, project, "assessment_en_route");
      return res.json({ phase: "assessment_en_route", message: "Lead technician is en route for site assessment" });
    }
    // Large-scale: team cannot mobilize for repair work until quotation is approved
    if (project.isLargeScale && project.projectPhase !== "execution") {
      if (project.projectPhase === "assessment") return res.status(400).json({ error: "Site inspection must be completed and quotation approved before the team can mobilize for repair work", phase: "assessment" });
      if (project.projectPhase === "quotation_review") return res.status(400).json({ error: "Quotation is under admin review — await approval before mobilizing", phase: "quotation_review" });
    }
    // Block mobilization if daily acceptance is still pending.
    if (project.dailyAcceptance && project.dailyAcceptance.required) {
      return res.status(400).json({ error: "Waiting for daily team confirmation — ask members to confirm availability", dailyAcceptance: true });
    }
    const wos = await scheduledWorkOrdersForDay(project._id, ["assigned", "accepted", "arrived", "partially_completed"]);
    if (wos.length === 0) return res.status(400).json({ error: "No active work to mobilize today" });
    await assertProjectDailyKitsReady(project._id);
    for (const w of wos) { w.status = "en_route"; w.enRouteAt = new Date(); await w.save(); }
    emitProjectPhase(req, project, "en_route");
    res.json({ phase: "en_route", message: "Team is en route" });
  } catch (e) {
    console.error("mobilize en-route error:", e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Failed to mobilize team", code: e.code });
  }
});

// Lead: mark the crew arrived on site.
router.put("/projects/:id/mobilize/arrived", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const { project } = ctx;
    if (project.isLargeScale && project.projectPhase === "assessment") {
      if (project.assessmentVisit?.status !== "en_route") {
        return res.status(409).json({ error: "Mark the assessment visit en route before recording arrival." });
      }
      project.assessmentVisit.status = "arrived";
      project.assessmentVisit.arrivedAt = new Date();
      project.assessmentVisit.technicianId = ctx.tech._id;
      await project.save();
      emitProjectPhase(req, project, "assessment_arrived");
      return res.json({ phase: "assessment_arrived", message: "Lead technician arrived for site assessment" });
    }
    const wos = await scheduledWorkOrdersForDay(project._id, ["en_route", "accepted"]);
    if (wos.length === 0) return res.status(400).json({ error: "Team must be en route first" });
    for (const w of wos) { w.status = "arrived"; w.arrivedAt = new Date(); await w.save(); }
    emitProjectPhase(req, project, "arrived");
    res.json({ phase: "arrived", message: "Team arrived on site" });
  } catch (e) {
    console.error("mobilize arrived error:", e);
    res.status(500).json({ error: "Failed to update team status" });
  }
});

// Lead: start today's work for the crew. Unlocks unit submission for everyone.
router.put("/projects/:id/mobilize/start", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const { project } = ctx;
    const wos = await scheduledWorkOrdersForDay(project._id, ["arrived", "accepted"]);
    if (wos.length === 0) return res.status(400).json({ error: "Team must arrive on site first" });
    for (const w of wos) { w.status = "in_progress"; w.startedAt = new Date(); if (!w.actualStartDate) w.actualStartDate = new Date(); await w.save(); }
    if (project.status !== "in_progress") { project.status = "in_progress"; if (!project.actualStartDate) project.actualStartDate = new Date(); await project.save(); }
    // ── Cascade: ensure BookingService reflects in-progress ──
    if (project.bookingId) {
      await BookingService.findByIdAndUpdate(project.bookingId, { status: "in-progress" }).catch(() => {});
    }
    // Notify members that today's work has started so their quota panel unlocks.
    for (const t of (project.assignedTechnicians || [])) {
      if (project.leadTechnicianId && t._id.toString() === project.leadTechnicianId.toString()) continue;
      await createNotification({
        type: "assignment_update", title: "Work started on site",
        message: `Today's work for "${project.customer?.name || project.service?.name || "your project"}" has started. Submit your finished units as you go.`,
        userId: t._id, role: "technician", referenceId: project._id, referenceModel: "Project",
        link: "/technician/assignments", priority: "normal", io: req.app.get("io"),
      }).catch(() => {});
    }
    emitProjectPhase(req, project, "in_progress");
    res.json({ phase: "in_progress", message: "Work started" });
  } catch (e) {
    console.error("mobilize start error:", e);
    res.status(500).json({ error: "Failed to start work" });
  }
});

// Lead: mark "No Show" — crew arrived but cannot start work today.
// Resets work orders to accepted and notifies admin.
router.put("/projects/:id/mobilize/no-show", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const { project } = ctx;
    const { reason } = req.body || {};
    const wos = await scheduledWorkOrdersForDay(project._id, ["en_route", "arrived", "accepted"]);
    if (wos.length === 0) return res.status(400).json({ error: "No active work orders to mark" });

    for (const w of wos) {
      w.status = "accepted";
      w.declinedReason = reason || "No Show — unable to start work";
      await w.save();
    }

    // Notify admin about no-show
    const admins = await User.find({ role: "admin", active: true }).select("_id");
    for (const admin of admins) {
      await createNotification({
        type: "project_issue",
        title: "Project — No Show",
        message: `Lead technician ${req.user.name || req.user.email} reported No Show on "${project.customer?.name || project.service?.name || "project"}". Reason: ${reason || "Not specified"}`,
        userId: admin._id, role: "admin", referenceId: project._id, referenceModel: "Project",
        link: "/admin/projects", priority: "high", io: req.app.get("io"),
      }).catch(() => {});
    }

    emitProjectPhase(req, project, "ready");
    res.json({ phase: "ready", message: "Marked as No Show — work orders reset" });
  } catch (e) {
    console.error("mobilize no-show error:", e);
    res.status(500).json({ error: "Failed to mark no-show" });
  }
});

// Lead: end today's on-site day for the crew (reset to next working day).
// Any work order still in progress and with units remaining goes back to
// "accepted" so tomorrow the lead mobilizes again (En Route → … loop).
// After ending the day, the project enters daily re-acceptance: lead and
// members must explicitly continue or decline before the next mobilization.
router.put("/projects/:id/mobilize/end-day", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const { project } = ctx;
    const wos = await scheduledWorkOrdersForDay(project._id, ["in_progress", "partially_completed", "arrived", "en_route", "awaiting_review"]);
    for (const w of wos) {
      const remaining = (w.unitCount || 0) - (w.completedUnitCount || 0);
      if (remaining > 0) { w.status = "accepted"; await w.save(); }
    }

    // Set up daily re-acceptance for the next working day.
    const tomorrow = nextWorkingDay(new Date());
    project.dailyAcceptance = {
      required: true,
      date: tomorrow,
      leadAccepted: false,
      leadAcceptedAt: null,
      membersAccepted: (project.assignedTechnicians || [])
        .filter(t => project.leadTechnicianId && t._id.toString() !== project.leadTechnicianId.toString())
        .map(t => ({ _id: t._id, name: t.name || "Technician", accepted: false, acceptedAt: null })),
      declined: [],
    };
    await project.save();

    // Notify all team members that daily acceptance is required.
    const io = req.app.get("io");
    const projName = project.customer?.name || project.service?.name || "your project";
    for (const t of (project.assignedTechnicians || [])) {
      await createNotification({
        type: "daily_acceptance_required",
        title: "Daily check-in required",
        message: `Day ended for "${projName}". Confirm you're available for tomorrow's work or decline with a reason.`,
        userId: t._id, role: "technician", referenceId: project._id, referenceModel: "Project",
        link: "/technician/assignments", priority: "high", io,
      }).catch(() => {});
      if (io) io.to(`tech:${t._id}`).emit("project:daily_acceptance", { projectId: project._id });
    }

    emitProjectPhase(req, project, "daily_acceptance");
    res.json({ phase: "daily_acceptance", message: "Day ended — waiting for team to confirm availability for tomorrow" });
  } catch (e) {
    console.error("mobilize end-day error:", e);
    res.status(500).json({ error: "Failed to end day" });
  }
});

// ── Daily re-acceptance: Lead confirms availability for next working day ─────
router.post("/projects/:id/daily-accept", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });
    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.dailyAcceptance || !project.dailyAcceptance.required) {
      return res.status(400).json({ error: "No daily acceptance in progress" });
    }

    const isLead = project.leadTechnicianId && project.leadTechnicianId.toString() === tech._id.toString();

    if (isLead) {
      project.dailyAcceptance.leadAccepted = true;
      project.dailyAcceptance.leadAcceptedAt = new Date();
    } else {
      const member = (project.dailyAcceptance.membersAccepted || []).find(
        m => m._id && m._id.toString() === tech._id.toString()
      );
      if (member) {
        member.accepted = true;
        member.acceptedAt = new Date();
      } else {
        return res.status(400).json({ error: "You are not assigned to this project" });
      }
    }
    await project.save();

    // Check if everyone has accepted.
    const allMembersAccepted = (project.dailyAcceptance.membersAccepted || []).every(m => m.accepted);
    const leadAccepted = project.dailyAcceptance.leadAccepted;
    const allAccepted = leadAccepted && allMembersAccepted;

    if (allAccepted) {
      // Everyone confirmed — clear daily acceptance and set phase to ready.
      project.dailyAcceptance.required = false;
      await project.save();

      // Notify all team members that everyone confirmed.
      const io = req.app.get("io");
      for (const t of (project.assignedTechnicians || [])) {
        await createNotification({
          type: "daily_acceptance_confirmed",
          title: "Team confirmed — ready to mobilize",
          message: `All team members confirmed availability for "${project.customer?.name || project.service?.name || 'your project'}". The lead can now mobilize the crew.`,
          userId: t._id, role: "technician", referenceId: project._id, referenceModel: "Project",
          link: "/technician/assignments", priority: "normal", io,
        }).catch(() => {});
        if (io) io.to(`tech:${t._id}`).emit("project:daily_ready", { projectId: project._id });
      }

      return res.json({ phase: "ready", message: "All team confirmed — ready to mobilize", allConfirmed: true });
    }

    res.json({ phase: "daily_acceptance", message: isLead ? "Lead confirmed — waiting for members" : "Confirmed — waiting for lead and other members", allConfirmed: false });
  } catch (e) {
    console.error("daily-accept error:", e);
    res.status(500).json({ error: "Failed to accept" });
  }
});

// ── Daily re-acceptance: Technician declines next day (with reason) ──────────
router.post("/projects/:id/daily-decline", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });
    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.dailyAcceptance || !project.dailyAcceptance.required) {
      return res.status(400).json({ error: "No daily acceptance in progress" });
    }

    // Record the decline.
    project.dailyAcceptance.declined = project.dailyAcceptance.declined || [];
    project.dailyAcceptance.declined.push({
      _id: tech._id,
      name: tech.name || "Technician",
      reason: reason || "No reason provided",
      declinedAt: new Date(),
    });
    project.dailyAcceptance.required = false;
    await project.save();

    // Notify admin about the decline.
    const io = req.app.get("io");
    await createNotification({
      type: "daily_acceptance_declined",
      title: "Technician declined next day",
      message: `${tech.name} declined to continue "${project.customer?.name || project.service?.name || 'your project'}" for tomorrow. Reason: ${reason || 'No reason provided'}. Replacement may be needed.`,
      role: "admin", referenceId: project._id, referenceModel: "Project",
      link: `/admin/projects/${project._id}`, priority: "high", io,
    }).catch(() => {});

    // Notify the lead.
    if (project.leadTechnicianId) {
      await createNotification({
        type: "daily_acceptance_declined",
        title: "Team member declined tomorrow",
        message: `${tech.name} cannot continue tomorrow. Reason: ${reason || 'No reason provided'}. You may need a replacement.`,
        userId: project.leadTechnicianId, role: "technician", referenceId: project._id, referenceModel: "Project",
        link: "/technician/assignments", priority: "high", io,
      }).catch(() => {});
    }

    // Emit socket event so the UI refreshes.
    if (io) io.to(`tech:${tech._id}`).emit("project:daily_declined", { projectId: project._id });

    res.json({ phase: "daily_declined", message: "Declined — admin and lead have been notified" });
  } catch (e) {
    console.error("daily-decline error:", e);
    res.status(500).json({ error: "Failed to decline" });
  }
});

// ── Project completion payment (lead collects once all units are done) ───────
// Auto-counts the working days the crew was active (distinct DailyAssignment
// dates with completed units) and prefills labor/day, travel/day, service fee
// from the project. The lead can override any figure before collecting.
async function buildProjectPaymentSummary(project) {
  const DailyAssignment = require("../models/DailyAssignment");
  const SiteSetting = require("../models/SiteSetting");
  const BookingService = require("../models/BookingService");
  const wos = await WorkOrder.find({ projectId: project._id }).lean();
  const totalUnits = wos.reduce((s, w) => s + (w.unitCount || 0), 0);
  const completedUnits = wos.reduce((s, w) => s + (w.completedUnitCount || 0), 0);
  const crewSize = Math.max(1, (project.assignedTechnicians || []).length);
  const hpU = project.estimatedDurationPerUnit || 1;
  const dailyHrs = project.preferredWorkingHours?.end
    ? Math.max(1, parseInt(project.preferredWorkingHours.end) - parseInt(project.preferredWorkingHours.start))
    : 8;
  const unitsPerTechPerDay = Math.floor(dailyHrs / hpU);

  // Distinct working days on which any unit was actually completed.
  const das = await DailyAssignment.find({ projectId: project._id, completedUnits: { $gt: 0 } }).lean().catch(() => []);
  const dayKeys = new Set(das.map((d) => new Date(d.date).toDateString()));
  let daysWorked = dayKeys.size;
  if (daysWorked === 0 && project.actualStartDate) {
    const { workingDaysBetween } = require("../utils/dailyAssignment");
    daysWorked = Math.max(1, workingDaysBetween(project.actualStartDate, new Date()));
  }
  daysWorked = Math.max(1, daysWorked);

  // Load admin default rates from SiteSetting.
  const [laborSetting, repairStdSetting, repairCpxSetting, repairMajSetting] = await Promise.all([
    SiteSetting.findOne({ key: "projectLaborRatePerDay" }).lean().catch(() => null),
    SiteSetting.findOne({ key: "repairLaborStandard" }).lean().catch(() => null),
    SiteSetting.findOne({ key: "repairLaborComplex" }).lean().catch(() => null),
    SiteSetting.findOne({ key: "repairLaborMajor" }).lean().catch(() => null),
  ]);
  const adminLaborRate = laborSetting && typeof laborSetting.value === "number" ? laborSetting.value : 0;
  const repairRates = {
    standard: repairStdSetting && typeof repairStdSetting.value === "number" ? repairStdSetting.value : 0,
    complex: repairCpxSetting && typeof repairCpxSetting.value === "number" ? repairCpxSetting.value : 0,
    major: repairMajSetting && typeof repairMajSetting.value === "number" ? repairMajSetting.value : 0,
  };

  // Pull travel fare and service type from the linked booking.
  let travelFare = 0;
  let serviceType = "core";
  let laborCategory = "standard";
  if (project.bookingId) {
    const booking = await BookingService.findById(project.bookingId).lean().catch(() => null);
    if (booking) {
      travelFare = booking.travelFare || 0;
      serviceType = booking.serviceType || "core";
      laborCategory = booking.quotation?.laborCategory || "standard";
    }
  }

  // Calculate labor based on service type.
  const pmt = project.payment || {};
  let laborRatePerDay = 0;
  let laborTotal = 0;
  let laborType = "core"; // for display in modal
  let partsCost = 0;

  if (serviceType === "repair") {
    // Repair: labor = complexity rate × working days (no crew multiplier)
    laborType = "repair";
    laborRatePerDay = repairRates[laborCategory] || repairRates.standard || 0;
    laborTotal = laborRatePerDay * daysWorked;
    // Parts cost from project repair data (use partsUsed if available, else quotation)
    const repairData = project.repair || {};
    const usedParts = repairData.partsUsed || [];
    const quotParts = (repairData.quotation?.parts || []);
    if (usedParts.length > 0) {
      partsCost = usedParts.reduce((s, p) => s + (Number(p.unitCost) || 0) * (Number(p.quantity) || 1), 0);
    } else if (quotParts.length > 0) {
      partsCost = quotParts.reduce((s, p) => (s + (Number(p.cost) || 0) * (Number(p.quantity) || 1)), 0);
    }
  } else {
    // Core: labor = rate × crew size × working days
    laborType = "core";
    laborRatePerDay = pmt.laborRatePerDay || adminLaborRate;
    laborTotal = laborRatePerDay * crewSize * daysWorked;
  }

  const serviceFee = pmt.serviceFee || (project.payment && project.payment.totalAmount) || 0;
  const alreadyPaid = pmt.amountPaid || 0;
  const total = laborTotal + travelFare + serviceFee + partsCost;
  const balance = Math.max(0, total - alreadyPaid);

  return {
    totalUnits, completedUnits, crewSize, daysWorked, unitsPerTechPerDay,
    laborRatePerDay, laborTotal, laborType, laborCategory,
    travelFare, serviceFee, serviceType, partsCost,
    total, alreadyPaid, balance,
    allDone: totalUnits > 0 && completedUnits >= totalUnits,
    customerName: project.customer?.name || project.service?.name || "Customer",
  };
}

// Customer collection must use a price the customer actually saw or approved.
// Crew size and elapsed workdays are operational metrics, not billable inputs.
async function buildAuthoritativeProjectPaymentSummary(project, session = null) {
  const moneyValue = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const workOrderQuery = WorkOrder.find({ projectId: project._id });
  const dailyQuery = DailyAssignment.find({ projectId: project._id, completedUnits: { $gt: 0 } });
  const bookingQuery = project.bookingId ? BookingService.findById(project.bookingId) : null;
  if (session) {
    workOrderQuery.session(session);
    dailyQuery.session(session);
    if (bookingQuery) bookingQuery.session(session);
  }
  const [workOrders, dailyRows, booking] = await Promise.all([
    workOrderQuery.lean(),
    dailyQuery.lean(),
    bookingQuery ? bookingQuery.lean() : null,
  ]);
  const pricing = calculateProjectCustomerPricing({ project, booking, workOrders, dailyRows });
  const projectCrewSize = Math.max(1, (project.assignedTechnicians || []).length);
  const activeWorkOrders = workOrders.filter(order => order.status !== "cancelled");
  const allSubmitted = activeWorkOrders.length > 0 && activeWorkOrders.every(order => order.status === "completed");
  return {
    ...pricing,
    crewSize: projectCrewSize,
    laborCategory: booking?.quotation?.laborCategory || "standard",
    pricingMessage: pricing.pricingReady
      ? "Locked to the approved unit pricing and actual productive site visits."
      : "No approved customer price is stored. An admin must set the project total before payment can be collected.",
    allDone: pricing.totalUnits > 0 && pricing.completedUnits >= pricing.totalUnits,
    allSubmitted,
    customerName: project.customer?.name || project.service?.name || "Customer",
  };

  /* Legacy calculation retained below temporarily for migration comparison.
     The return above is the sole customer-facing pricing path. */
  const totalUnits = workOrders.reduce((sum, order) => sum + Number(order.unitCount || 0), 0);
  const completedUnits = workOrders.reduce((sum, order) => sum + Number(order.completedUnitCount || 0), 0);
  const crewSize = Math.max(1, (project.assignedTechnicians || []).length);
  const daysWorked = Math.max(1, new Set(dailyRows.map(row => new Date(row.date).toDateString())).size);
  const serviceType = booking?.serviceType || project.repair?.serviceType || "core";
  const travelFare = moneyValue(booking?.travelFare);
  const payment = project.payment || {};
  let total = 0;
  let pricingSource = "";

  // Existing project totals are grand totals. Never reuse one as a line item
  // and then add labor/travel on top of it.
  if (moneyValue(payment.totalAmount)) {
    total = moneyValue(payment.totalAmount);
    pricingSource = "Approved project total";
  } else {
    const approvedProjectQuote = project.quotationReview?.status === "approved"
      ? moneyValue(project.quotationReview.totalAmount)
      : 0;
    if (approvedProjectQuote) {
      total = approvedProjectQuote + travelFare;
      pricingSource = "Approved project quotation";
    } else if (serviceType === "repair" || serviceType === "mixed") {
      const projectRepairQuote = project.repair?.quotation?.approvedAt
        ? moneyValue(project.repair.quotation.totalCost)
        : 0;
      const bookingRepairQuote = booking?.approval?.status === "approved"
        ? moneyValue(booking.quotation?.totalCost)
        : 0;
      const repairQuote = projectRepairQuote || bookingRepairQuote;
      if (repairQuote) {
        total = repairQuote + travelFare;
        pricingSource = "Approved repair quotation";
      }
    } else if (booking) {
      // estimatedFee is the checkout amount and includes travel. The model also
      // normalizes multi-service totalPrice with travel included.
      const checkoutTotal = moneyValue(booking.estimatedFee);
      const bookingTotal = moneyValue(booking.totalPrice);
      const itemTotal = (booking.services || []).reduce((sum, item) => {
        const quantity = Math.max(1, Number(item.quantity) || 1);
        const lineTotal = moneyValue(item.totalPrice)
          || moneyValue(item.unitPrice) * quantity;
        return sum + lineTotal;
      }, 0);
      const singleServiceTotal = moneyValue(booking.servicePrice || booking.service?.basePrice)
        * Math.max(1, Number(booking.quantity || project.totalUnits) || 1);
      if (checkoutTotal) {
        total = checkoutTotal;
        pricingSource = "Customer booking total";
      } else if (bookingTotal) {
        total = bookingTotal + (booking.isMultiService ? 0 : travelFare);
        pricingSource = "Stored booking total";
      } else if (itemTotal || singleServiceTotal) {
        total = (itemTotal || singleServiceTotal) + travelFare;
        pricingSource = "Booked service pricing";
      }
    }
  }

  const serviceCharge = Math.max(0, total - Math.min(total, travelFare));
  const alreadyPaid = Math.max(moneyValue(payment.amountPaid), moneyValue(booking?.amountPaid));
  const balance = Math.max(0, total - alreadyPaid);
  const pricingReady = total > 0 && (serviceCharge > 0 || serviceType === "repair" || serviceType === "mixed");
  return {
    totalUnits,
    completedUnits,
    crewSize,
    daysWorked,
    serviceType,
    travelFare,
    serviceCharge,
    total,
    alreadyPaid,
    balance,
    pricingReady,
    pricingSource,
    pricingMessage: pricingReady
      ? "Locked to the customer-approved booking or quotation."
      : "No approved customer price is stored. An admin must set the project total before payment can be collected.",
    allDone: totalUnits > 0 && completedUnits >= totalUnits,
    customerName: project.customer?.name || project.service?.name || "Customer",
  };
}

router.get("/projects/:id/payment-summary", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const summary = await buildAuthoritativeProjectPaymentSummary(ctx.project);
    res.json(summary);
  } catch (e) {
    console.error("payment-summary error:", e);
    res.status(500).json({ error: "Failed to build payment summary" });
  }
});

router.post("/projects/:id/collect-payment", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const { project } = ctx;
    const b = req.body || {};
    const clientSubmissionId = String(b.clientSubmissionId || "").trim();
    if (!clientSubmissionId || clientSubmissionId.length > 100) {
      return res.status(400).json({ error: "A valid client submission id is required." });
    }
    const existingPayment = await Payment.findOne({ projectId: project._id, clientSubmissionId }).lean();
    if (existingPayment) {
      return res.json({ message: "Payment was already recorded", replayed: true, payment: existingPayment });
    }
    const summary = await buildAuthoritativeProjectPaymentSummary(project);
    if (!summary.allDone) return res.status(400).json({ error: "All units must be completed before collecting payment" });
    if (!summary.allSubmitted) return res.status(409).json({ error: "The lead must review and submit every completed work order before collecting payment." });
    if (!summary.pricingReady) return res.status(409).json({ error: summary.pricingMessage });
    if (summary.balance <= 0) return res.status(409).json({ error: "This project has no outstanding balance." });

    const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
    const daysWorked = summary.daysWorked;
    const crewSize = summary.crewSize;
    const laborRatePerDay = 0;
    const serviceFee = summary.serviceCharge;
    const additionalCharges = 0;
    const travelFare = summary.travelFare; // from booking, read-only
    const laborType = summary.laborType; // "core" or "repair"
    const partsCost = 0;
    let laborTotal;
    if (laborType === "repair") {
      laborTotal = laborRatePerDay * daysWorked; // repair: rate × days (no crew multiplier)
    } else {
      laborTotal = laborRatePerDay * crewSize * daysWorked; // core: rate × crew × days
    }
    const total = summary.total;
    const amount = num(b.amount, summary.balance);
    if (amount <= 0) return res.status(400).json({ error: "Enter an amount greater than zero." });
    if (amount > summary.balance) return res.status(400).json({ error: `Amount cannot exceed the ₱${summary.balance.toLocaleString()} balance.` });
    const method = (b.paymentMethod || "cash").toString().slice(0, 40);
    if (!["cash", "gcash", "bank"].includes(method)) return res.status(400).json({ error: "Invalid payment method" });
    if (!b.customerSignature) return res.status(400).json({ error: "Customer signature is required" });
    if (["gcash", "bank"].includes(method) && (!b.reference || !b.proofUrl)) return res.status(400).json({ error: "Reference number and receipt screenshot are required" });

    const amountPaid = summary.alreadyPaid + amount;
    const balanceAmount = Math.max(0, total - amountPaid);
    const paymentSession = await mongoose.startSession();
    try {
      await paymentSession.withTransaction(async () => {
    project.$session(paymentSession);
    project.payment = {
      ...(project.payment || {}),
      totalAmount: total,
      amountPaid,
      balanceAmount,
      paymentMethod: method,
      paymentStatus: balanceAmount <= 0 ? "waiting_for_remittance" : "partial",
      laborRatePerDay,
      serviceFee,
      daysWorked,
      crewSize,
      additionalCharges,
      proofNote: b.remarks ? String(b.remarks).slice(0, 1000) : (project.payment && project.payment.proofNote),
      paidAt: new Date(),
      recordedBy: req.user._id,
      recordedAt: new Date(),
    };
    if (balanceAmount <= 0) { project.status = "completed"; if (!project.actualCompletionDate) project.actualCompletionDate = new Date(); }
    await project.save();

    // ── Cascade: update BookingService status ──
    if (project.bookingId) {
      const bsUpdate = balanceAmount <= 0 ? "completed" : "in-progress";
      await BookingService.findByIdAndUpdate(project.bookingId, {
        status: bsUpdate,
        amountPaid,
        balanceAmount,
        paymentStatus: balanceAmount <= 0 ? "waiting_for_remittance" : "partial",
        balanceCollected: balanceAmount <= 0,
        balanceCollectedAt: balanceAmount <= 0 ? new Date() : null,
        balanceCollectedBy: ctx.tech._id,
      }, { session: paymentSession });
    }

    // ── Cascade: create standalone Payment record ──
    if (amount > 0) {
      await Payment.create([{
        bookingId: project.bookingId || undefined,
        projectId: project._id,
        clientSubmissionId,
        amount,
        method,
        type: balanceAmount <= 0 ? "final" : "downpayment",
        gateway: method === "cash" ? "cod" : method,
        status: "waiting_for_remittance",
        reference: b.reference || `Project ${project._id}`,
        proofUrl: b.proofUrl || undefined,
        customerSignature: b.customerSignature,
        collectedBy: ctx.tech._id,
        collectedByName: ctx.tech.name,
        collectedAt: new Date(),
        collectionLocation: b.location || undefined,
        events: [{ status: "payment_collected", actor: req.user._id, actorName: ctx.tech.name, actorRole: "technician", at: new Date() }, { status: "waiting_for_remittance", actor: req.user._id, actorName: ctx.tech.name, actorRole: "technician", at: new Date() }],
        notes: `Collected by ${ctx.tech.name || "lead"}. ${b.remarks || ""}`.trim(),
        submittedAt: new Date(),
      }], { session: paymentSession });
    }

    // ── Cascade: complete Assignment records for project team ──
    if (balanceAmount <= 0) {
      const assignmentIds = (project.assignedTechnicians || []).map(t => t._id).filter(Boolean);
      if (assignmentIds.length > 0) {
        await Assignment.updateMany(
          {
            $or: [
              { projectId: project._id },
              ...(project.bookingId ? [{ bookingId: project.bookingId }] : []),
            ],
            technicianId: { $in: assignmentIds },
            status: { $nin: ["completed", "cancelled"] },
          },
          { $set: { status: "completed", completedAt: new Date() } },
          { session: paymentSession },
        );
      }
    }
      });
    } finally {
      project.$session(null);
      await paymentSession.endSession();
    }

    // Notify admin to generate the final invoice.
    await createNotification({
      type: "project_payment", title: "Project payment collected",
      message: `${ctx.tech.name || "Lead technician"} collected ₱${amount.toLocaleString()} for "${summary.customerName}". Ready for final invoice.`,
      userId: null, role: "admin", referenceId: project._id, referenceModel: "Project",
      link: "/admin/projects/" + project._id, priority: "high", io: req.app.get("io"),
    }).catch(() => {});

    res.json({
      message: "Payment recorded", payment: project.payment,
      breakdown: { daysWorked, crewSize, laborRatePerDay, laborTotal, travelFare, serviceFee, additionalCharges, partsCost, total, amount, balanceAmount },
    });
  } catch (e) {
    console.error("collect-payment error:", e);
    res.status(500).json({ error: "Failed to record payment" });
  }
});

// Fully prepaid projects have no balance to collect. The lead still needs a
// canonical completion action after reviewing every proof-backed work order.
router.post("/projects/:id/complete", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const { project, tech } = ctx;
    if (project.status === "completed") return res.json({ project, alreadyCompleted: true });
    if (project.status !== "in_progress") return res.status(409).json({ error: "Only an active project can be completed." });
    const summary = await buildAuthoritativeProjectPaymentSummary(project);
    if (!summary.pricingReady) return res.status(409).json({ error: summary.pricingMessage });
    if (!summary.allDone || !summary.allSubmitted) {
      return res.status(409).json({ error: "Review and submit every proof-backed work order before completing the project." });
    }
    if (summary.balance > 0) return res.status(409).json({ error: "Collect the outstanding customer balance before completing the project." });

    const completionSession = await mongoose.startSession();
    try {
      await completionSession.withTransaction(async () => {
    project.$session(completionSession);
    project.status = "completed";
    project.actualCompletionDate = project.actualCompletionDate || new Date();
    project.payment = {
      ...(project.payment || {}),
      totalAmount: summary.total,
      amountPaid: summary.alreadyPaid,
      balanceAmount: 0,
      paymentStatus: ["verified", "paid"].includes(project.payment?.paymentStatus)
        ? project.payment.paymentStatus
        : "paid",
      recordedBy: req.user._id,
      recordedAt: new Date(),
    };
    await project.save();
    if (project.bookingId) {
      await BookingService.findByIdAndUpdate(project.bookingId, {
        status: "completed",
        balanceAmount: 0,
        balanceCollected: true,
        balanceCollectedAt: new Date(),
        balanceCollectedBy: tech._id,
      }, { session: completionSession });
    }
    const technicianIds = (project.assignedTechnicians || []).map(member => member._id).filter(Boolean);
    if (technicianIds.length) {
      await Assignment.updateMany(
        {
          $or: [
            { projectId: project._id },
            ...(project.bookingId ? [{ bookingId: project.bookingId }] : []),
          ],
          technicianId: { $in: technicianIds },
          status: { $nin: ["completed", "cancelled"] },
        },
        { $set: { status: "completed", completedAt: new Date() } },
        { session: completionSession },
      );
    }
      });
    } finally {
      project.$session(null);
      await completionSession.endSession();
    }
    await createNotification({
      type: "project_status_update",
      title: "Project work completed",
      message: `${tech.name || "The project lead"} completed the prepaid project for ${summary.customerName}. Review operational closeout before archiving.`,
      role: "admin",
      referenceId: project._id,
      referenceModel: "Project",
      link: `/admin/projects/${project._id}`,
      priority: "high",
      io: req.app.get("io"),
    });
    return res.json({ project, message: "Project completed and sent to admin for closeout review." });
  } catch (error) {
    console.error("project complete error:", error);
    return res.status(500).json({ error: "Failed to complete project" });
  }
});

// ── Repair Project: Get repair summary ──────────────────────────────────────
router.get("/projects/:id/repair-summary", auth.authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await Project.findById(id).lean();
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.repair || project.repair.serviceType !== "repair") {
      return res.status(400).json({ error: "This is not a repair project" });
    }
    res.json({
      repair: project.repair,
      project: {
        _id: project._id,
        projectPhase: project.projectPhase,
        unitGroups: project.unitGroups || [],
      },
    });
  } catch (e) {
    console.error("repair-summary error:", e);
    res.status(500).json({ error: "Failed to load repair summary" });
  }
});

// ── Repair Project: Record parts used (lead-only) ──────────────────────────
router.post("/projects/:id/record-parts-used", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const { project, tech } = ctx;
    if (!project.repair || project.repair.serviceType !== "repair") {
      return res.status(400).json({ error: "This is not a repair project" });
    }
    const clientSubmissionId = String(req.body.clientSubmissionId || "").trim();
    if (!clientSubmissionId || clientSubmissionId.length > 100) {
      return res.status(400).json({ error: "A valid client submission id is required." });
    }
    if ((project.repair.partsUsageSubmissionIds || []).includes(clientSubmissionId)) {
      return res.json({ message: "Parts were already recorded", replayed: true, partsUsed: project.repair.partsUsed || [] });
    }
    if (project.projectPhase !== "execution" || project.status !== "in_progress") {
      return res.status(409).json({ error: "Parts can only be recorded while approved repair work is in progress." });
    }
    const rawParts = Array.isArray(req.body.parts) ? req.body.parts : [];
    if (!rawParts.length || rawParts.length > 50) {
      return res.status(400).json({ error: "Submit between 1 and 50 part lines." });
    }
    const parts = rawParts.map((part) => ({
      name: String(part.name || "").trim().slice(0, 200),
      quantity: Number(part.quantity),
      unitCost: Number(part.unitCost || 0),
      toolId: part.toolId ? String(part.toolId) : null,
    }));
    if (parts.some((part) => !part.name || !Number.isInteger(part.quantity) || part.quantity <= 0 || part.quantity > 10000 || !Number.isFinite(part.unitCost) || part.unitCost < 0)) {
      return res.status(400).json({ error: "Every part requires a name, a positive whole-number quantity, and a non-negative unit cost." });
    }
    const linkedIds = parts.filter((part) => part.toolId).map((part) => part.toolId);
    if (linkedIds.some((id) => !mongoose.Types.ObjectId.isValid(id)) || new Set(linkedIds).size !== linkedIds.length) {
      return res.status(400).json({ error: "Inventory-linked parts must use valid, unique item ids." });
    }

    let savedProject;
    let replayed = false;
    await session.withTransaction(async () => {
      const lockedProject = await Project.findById(project._id).session(session);
      if ((lockedProject.repair?.partsUsageSubmissionIds || []).includes(clientSubmissionId)) {
        savedProject = lockedProject;
        replayed = true;
        return;
      }
      const inventory = linkedIds.length
        ? await Tool.find({ _id: { $in: linkedIds } }).session(session)
        : [];
      if (inventory.length !== linkedIds.length) {
        throw Object.assign(new Error("One or more linked inventory items no longer exist."), { status: 409 });
      }
      const byId = new Map(inventory.map((item) => [String(item._id), item]));
      const recorded = [];
      for (const part of parts) {
        let itemType = "part";
        let name = part.name;
        if (part.toolId) {
          const item = byId.get(part.toolId);
          itemType = item.type === "tool" ? "equipment" : (item.type || "part");
          if (itemType === "equipment") {
            throw Object.assign(new Error(`${item.itemName} is equipment and cannot be consumed as a repair part.`), { status: 400 });
          }
          if (Number(item.quantity || 0) < part.quantity) {
            throw Object.assign(new Error(`${item.itemName} has only ${Number(item.quantity || 0)} available.`), { status: 409 });
          }
          const quantityBefore = Number(item.quantity || 0);
          item.quantity = quantityBefore - part.quantity;
          item.status = item.quantity <= 0 ? "out_of_stock" : (item.quantity <= Number(item.minStockLevel || 0) ? "low_stock" : "in_stock");
          await item.save({ session });
          await StockAdjustment.create([{
            toolId: item._id,
            type: "job_usage",
            quantityBefore,
            quantityAfter: item.quantity,
            delta: -part.quantity,
            reason: "repair_used",
            notes: `Repair parts used on large-scale project ${project._id}`,
            referenceId: project.bookingId || undefined,
            adjustedBy: req.user._id,
          }], { session });
          name = item.itemName;
        }
        recorded.push({
          name,
          quantity: part.quantity,
          unitCost: part.unitCost,
          toolId: part.toolId || undefined,
          itemType,
          usedBy: tech._id,
          usedAt: new Date(),
        });
      }
      lockedProject.repair.partsUsed.push(...recorded);
      lockedProject.repair.partsUsageSubmissionIds.push(clientSubmissionId);
      await lockedProject.save({ session });
      savedProject = lockedProject;
    });
    res.json({
      message: replayed ? "Parts were already recorded" : "Parts recorded",
      replayed,
      partsUsed: savedProject.repair.partsUsed,
    });
  } catch (e) {
    console.error("record-parts-used error:", e);
    res.status(e.status || 500).json({ error: e.status ? e.message : "Failed to record parts" });
  } finally {
    await session.endSession();
  }
});

// ── Repair Project: Reserve quotation parts from inventory (admin) ──────────
router.post("/projects/:id/reserve-parts", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.repair || project.repair.serviceType !== "repair") {
      return res.status(400).json({ error: "This is not a repair project" });
    }
    const StockReservation = require("../models/StockReservation");
    const Tool = require("../models/Tool");
    const parts = project.repair.quotation?.parts || [];

    // Try auto-linking toolId by part name if not set (only repair parts / consumables)
    for (const p of parts) {
      if (!p.toolId && p.name) {
        const toolMatch = await Tool.findOne({
          itemName: new RegExp(`^${p.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
          type: { $in: ['part', 'consumable'] }
        });
        if (toolMatch) p.toolId = toolMatch._id;
      }
    }

    // Make sure no equipment items leak into the parts reservation
    const linkedToolIds = parts.filter(p => p.toolId).map(p => p.toolId);
    const linkedTools = linkedToolIds.length ? await Tool.find({ _id: { $in: linkedToolIds } }).select('type').lean() : [];
    const typeMap = new Map(linkedTools.map(t => [String(t._id), t.type === 'tool' ? 'equipment' : (t.type || 'part')]));
    for (const p of parts) {
      if (p.toolId && typeMap.get(String(p.toolId)) === 'equipment') p.toolId = null;
    }

    const partsWithToolId = parts.filter(p => p.toolId);
    const unlinkedParts = parts.filter(p => !p.toolId);

    if (partsWithToolId.length === 0) {
      const firstUnlinked = unlinkedParts[0]?.name || '';
      return res.status(400).json({
        error: `No parts in catalog match quotation item(s)${firstUnlinked ? `: "${firstUnlinked}"` : ''}. Please add them to inventory first.`,
        unlinkedParts: unlinkedParts.map(p => p.name),
        procurePart: firstUnlinked,
      });
    }
    const result = await StockReservation.reserveForBooking({
      bookingId: project.bookingId,
      parts: partsWithToolId.map(p => ({ toolId: p.toolId, name: p.name, quantity: p.quantity, unitPrice: p.cost })),
      reservedBy: req.user._id,
    });
    // Update stock status on each part
    for (const part of project.repair.quotation.parts) {
      if (part.toolId) {
        try {
          const tool = await Tool.findById(part.toolId).lean();
          if (tool) {
            part.currentStock = tool.availableQuantity || tool.quantity || 0;
            part.stockStatus = part.currentStock >= part.quantity ? 'in_stock'
              : part.currentStock > 0 ? 'low_stock' : 'out_of_stock';
          }
        } catch (_) {}
      }
    }
    await project.save();
    res.json({ message: "Parts reserved", reservations: result.reservations, insufficientStock: result.insufficientStock, quotation: project.repair.quotation });
  } catch (e) {
    console.error("reserve-parts error:", e);
    res.status(500).json({ error: "Failed to reserve parts" });
  }
});

// ── Admin: reassign a work order to a different technician ──────────────────
router.put("/work-orders/:id/reassign", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { technicianId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(technicianId)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ error: "Work order not found" });
    const tech = await Technician.findById(technicianId).lean();
    if (!tech) return res.status(404).json({ error: "Technician not found" });

    workOrder.assignedTechnicians = [{
      _id: tech._id,
      name: tech.name || `${tech.firstName || ""} ${tech.lastName || ""}`.trim(),
      phone: tech.phone || tech.mobile || "",
      assignedUnits: workOrder.unitCount || 0,
    }];
    // Reset to assigned so the new tech must accept
    workOrder.status = "assigned";
    await workOrder.save();
    if (workOrder.scheduledDate) ensureDailyAssignmentsIfLegacy(workOrder._id).catch(() => {});

    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    await createNotification({
      type: "assignment_new",
      title: "Work Order Reassigned",
      message: `You have been assigned work order "${workOrder.title || workOrder.section || "task"}".`,
      userId: tech._id,
      role: "technician",
      referenceId: workOrder._id,
      referenceModel: "WorkOrder",
      link: "/technician/assignments",
      priority: "high",
      io,
    }).catch(() => {});
    if (io) io.to(`tech:${tech._id}`).emit("assignment:new", { workOrderId: workOrder._id, isProject: true });

    res.json({ workOrder });
  } catch (error) {
    console.error("Error reassigning work order:", error);
    res.status(500).json({ error: "Failed to reassign work order" });
  }
});

// ── Project Issues (technician submit → admin/lead receive instantly) ───────
router.post("/issues", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { projectId, workOrderId, category, title, description, photos, voiceNote } = req.body;
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({ error: "Invalid project id" });
    }
    const { technician, project } = await requireTechnicianProjectMember(req.user, projectId);
    if (workOrderId) {
      if (!mongoose.Types.ObjectId.isValid(workOrderId)) return res.status(400).json({ error: "Invalid work order id" });
      const belongsToProject = await WorkOrder.exists({ _id: workOrderId, projectId });
      if (!belongsToProject) return res.status(400).json({ error: "Work order does not belong to this project" });
    }
    const issue = new ProjectIssue({
      projectId,
      workOrderId: workOrderId && mongoose.Types.ObjectId.isValid(workOrderId) ? workOrderId : null,
      reportedBy: { _id: technician._id, name: technician.name || req.user.name || "Technician" },
      category: category || "other",
      title: title || "",
      description: description || "",
      photos: Array.isArray(photos) ? photos : [],
      voiceNote: voiceNote || null,
      status: "open",
    });
    await issue.save();

    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    await createNotification({
      type: "project_issue",
      title: "New Project Issue",
      message: `${issue.reportedBy.name} reported a ${issue.category} issue${project ? ` on ${project.customer?.name || "a project"}` : ""}.`,
      role: "admin",
      referenceId: issue._id,
      referenceModel: "ProjectIssue",
      link: `/admin/projects/${projectId}`,
      priority: "high",
      io,
    }).catch(() => {});
    if (io) io.to("admin-room").emit("project:issue", { issueId: issue._id, projectId, category: issue.category, title: issue.title });

    res.status(201).json({ issue });
  } catch (error) {
    console.error("Error submitting project issue:", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to submit issue" });
  }
});

router.get("/projects/:id/issues", auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const issues = await ProjectIssue.find({ projectId: id }).sort({ createdAt: -1 }).lean();
    res.json({ issues });
  } catch (error) {
    console.error("Error fetching project issues:", error);
    res.status(500).json({ error: "Failed to fetch issues" });
  }
});

router.put("/issues/:id/resolve", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { resolutionNote } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid issue id" });
    const issue = await ProjectIssue.findById(id);
    if (!issue) return res.status(404).json({ error: "Issue not found" });
    issue.status = "resolved";
    issue.resolutionNote = resolutionNote || "";
    issue.resolvedBy = req.user._id;
    issue.resolvedAt = new Date();
    await issue.save();
    res.json({ issue });
  } catch (error) {
    console.error("Error resolving issue:", error);
    res.status(500).json({ error: "Failed to resolve issue" });
  }
});

// ── Project Expenses (technician submits against project/WO; admin approves) ─
router.post("/expenses", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { projectId, workOrderId, type, amount, description, fuelLiters, pricePerLiter, odometerReading, gasStation, receiptImage, expenseDate } = req.body;
    if (!mongoose.Types.ObjectId.isValid(projectId)) return res.status(400).json({ error: "Invalid project id" });
    if (!type || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || !String(description || "").trim()) return res.status(400).json({ error: "type, a positive amount, and description are required" });
    const { technician } = await requireTechnicianProjectMember(req.user, projectId);
    if (workOrderId) {
      if (!mongoose.Types.ObjectId.isValid(workOrderId)) return res.status(400).json({ error: "Invalid work order id" });
      const belongsToProject = await WorkOrder.exists({ _id: workOrderId, projectId });
      if (!belongsToProject) return res.status(400).json({ error: "Work order does not belong to this project" });
    }
    const expense = new Expense({
      technicianId: technician._id,
      technicianName: technician.name || req.user.name || "Technician",
      projectId,
      workOrderId: workOrderId && mongoose.Types.ObjectId.isValid(workOrderId) ? workOrderId : null,
      type,
      amount: Number(amount),
      description: String(description).trim(),
      fuelLiters: fuelLiters || 0,
      pricePerLiter: pricePerLiter || 0,
      odometerReading: odometerReading || 0,
      gasStation: gasStation || "",
      receiptImage: receiptImage || null,
      expenseDate: expenseDate ? new Date(expenseDate) : new Date(),
      status: "pending",
    });
    await expense.save();

    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    await createNotification({
      type: "expense_submitted",
      title: "Project Expense Submitted",
      message: `${expense.technicianName} submitted a ${type} expense of ₱${amount} for a project.`,
      role: "admin",
      referenceId: expense._id,
      referenceModel: "Expense",
      link: `/admin/projects/${projectId}`,
      priority: "normal",
      io,
    }).catch(() => {});
    if (io) io.to("admin-room").emit("expense:submitted", { expenseId: expense._id, projectId, type, amount });

    res.status(201).json({ expense });
  } catch (error) {
    console.error("Error submitting project expense:", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to submit expense" });
  }
});

router.get("/projects/:id/expenses", auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const expenses = await Expense.find({ projectId: id }).sort({ expenseDate: -1 }).lean();
    const summary = expenses.reduce((acc, e) => {
      if (e.status === "approved") acc.approvedTotal += e.amount;
      else if (e.status === "pending") acc.pendingTotal += e.amount;
      acc.count += 1;
      return acc;
    }, { approvedTotal: 0, pendingTotal: 0, count: 0 });
    res.json({ expenses, summary });
  } catch (error) {
    console.error("Error fetching project expenses:", error);
    res.status(500).json({ error: "Failed to fetch expenses" });
  }
});

router.put("/expenses/:id/approve", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { decision, rejectionReason } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid expense id" });
    const expense = await Expense.findById(id);
    if (!expense) return res.status(404).json({ error: "Expense not found" });
    expense.status = decision === "reject" ? "rejected" : "approved";
    expense.approvedBy = req.user._id;
    expense.approvedAt = new Date();
    if (expense.status === "rejected") expense.rejectionReason = rejectionReason || "";
    await expense.save();

    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    const technician = await Technician.findById(expense.technicianId).select("user").lean();
    await createNotification({
      type: expense.status === "approved" ? "expense_approved" : "expense_rejected",
      title: expense.status === "approved" ? "Expense Approved" : "Expense Rejected",
      message: expense.status === "approved" ? `Your ${expense.type} expense was approved.` : `Your ${expense.type} expense was rejected.`,
      userId: technician?.user || null,
      role: technician?.user ? null : "technician",
      referenceId: expense._id,
      referenceModel: "Expense",
      priority: "normal",
      io,
    }).catch(() => {});

    res.json({ expense });
  } catch (error) {
    console.error("Error approving expense:", error);
    res.status(500).json({ error: "Failed to approve expense" });
  }
});

router.get("/scheduling/config", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const threshold = await getProjectThresholdHours();
    res.json({
      largeProjectThresholdHours: threshold,
      appointmentWindows: [
        { label: "8:00 AM Window", start: "08:00", end: "10:30" },
        { label: "11:00 AM Window", start: "11:00", end: "13:30" },
        { label: "1:00 PM Window", start: "13:00", end: "16:00" },
      ],
    });
  } catch (error) {
    console.error("Error fetching scheduling config:", error);
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

router.put("/scheduling/config", auth.requireRole(["admin"]), async (req, res) => {
  try {
    const { largeProjectThresholdHours } = req.body;
    const SiteSetting = require("../models/SiteSetting");

    if (largeProjectThresholdHours !== undefined) {
      const val = Number(largeProjectThresholdHours);
      if (!Number.isFinite(val) || val < 1) {
        return res.status(400).json({ error: "largeProjectThresholdHours must be a positive number" });
      }
      await SiteSetting.findOneAndUpdate(
        { key: "largeProjectThresholdHours" },
        { value: String(val) },
        { upsert: true }
      );
      invalidateProjectThresholdCache();
    }

    res.json({ message: "Scheduling configuration updated" });
  } catch (error) {
    console.error("Error updating scheduling config:", error);
    res.status(500).json({ error: "Failed to update config" });
  }
});

async function updateProjectProgress(projectId) {
  try {
    const workOrders = await WorkOrder.find({ projectId }).lean();
    const activeOrders = workOrders.filter((wo) => wo.status !== "cancelled");
    const totalWO = activeOrders.length;
    const completedWO = activeOrders.filter((wo) => wo.status === "completed").length;
    const completedUnits = activeOrders.reduce((sum, wo) => sum + (wo.completedUnitCount || 0), 0);
    const assignedTechs = new Set();
    workOrders.forEach((wo) => {
      (wo.assignedTechnicians || []).forEach((t) => assignedTechs.add(String(t._id)));
    });

    const update = {
      totalWorkOrders: totalWO,
      completedWorkOrders: completedWO,
      completedUnits,
      totalAssignedTechnicians: assignedTechs.size,
    };

    if (completedWO === totalWO && totalWO > 0) {
      update.status = "completed";
      update.actualCompletionDate = new Date();
    } else if (completedWO > 0 || workOrders.some((wo) => wo.status === "in_progress")) {
      update.status = "in_progress";
    } else if (totalWO > 0) {
      update.status = "planning";
    }

    // Never downgrade a verified/accepted large-scale project back to planning
    // via work-order progress (it should only move forward from "accepted").
    const proj = await Project.findById(projectId).lean();
    if (proj && ["accepted", "ready", "in_progress", "on_hold"].includes(proj.status)) {
      delete update.status;
    }

    await Project.findByIdAndUpdate(projectId, update);
    if (completedWO > 0) await releaseUnblockedWorkOrders(projectId);

    // ── Cascade: when project completes, update BookingService + Assignments ──
    if (update.status === "completed" && proj) {
      // Update linked BookingService status
      if (proj.bookingId) {
        await BookingService.findByIdAndUpdate(proj.bookingId, { status: "completed" }).catch(() => {});
      }
      // Complete Assignment records for all project team members
      const assignmentTechIds = (proj.assignedTechnicians || []).map(t => t._id).filter(Boolean);
      if (assignmentTechIds.length > 0) {
        await Assignment.updateMany(
          {
            $or: [
              { projectId },
              ...(proj.bookingId ? [{ bookingId: proj.bookingId }] : []),
            ],
            technicianId: { $in: assignmentTechIds },
            status: { $nin: ["completed", "cancelled"] },
          },
          { $set: { status: "completed", completedAt: new Date() } }
        ).catch(() => {});
      }
    }

    // ── Notify lead tech when all units are done (large-scale projects) ──
    // `totalUnits` used to be an undeclared identifier here — the
    // ReferenceError was silently swallowed and leads never received the
    // "collect payment" prompt. Scope = authoritative project total, widened
    // to WO coverage when the two drift apart (same policy as the payment
    // summary path at buildAuthoritativeProjectPaymentSummary).
    if (proj && proj.isLargeScale && proj.status !== "cancelled") {
      const woTotalUnits = activeOrders.reduce((sum, wo) => sum + Number(wo.unitCount || 0), 0);
      const scopedTotalUnits = Math.max(Number(proj.totalUnits) || 0, woTotalUnits);
      const alreadyNotified = !!proj._allUnitsNotified;
      if (!alreadyNotified && scopedTotalUnits > 0 && completedUnits >= scopedTotalUnits) {
        const leadId = proj.leadTechnicianId;
        if (leadId) {
          const customerName = proj.customer?.name || proj.service?.name || "project";
          const io = global.io || null;
          // createNotification resolves to null (never throws) on failure —
          // only latch _allUnitsNotified when the notification actually
          // persisted, so transient DB issues self-heal on the next sync.
          const notification = await createNotification({
            type: "project_all_units_done",
            title: "All units completed",
            message: `All ${scopedTotalUnits} unit(s) for "${customerName}" are complete. You can now collect payment.`,
            userId: leadId,
            referenceId: projectId,
            referenceModel: "Project",
            link: "/technician/assignments",
            priority: "high",
            io,
          });
          if (notification) {
            await Project.findByIdAndUpdate(projectId, { _allUnitsNotified: true }).catch(() => {});
          }
        }
      }
    }
  } catch (e) {
    console.error("Error updating project progress:", e);
  }
}

// ════════════════════════════════════════════════════════════════════
// EQUIPMENT CHECKOUT / CHECK-IN
// ════════════════════════════════════════════════════════════════════
// GET /api/projects/:id/equipment — list all equipment assignments for this project
router.get("/projects/:id/equipment", auth.authenticate, auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const assignments = await EquipmentAssignment.find({
      $or: [{ projectId: id }, { projectIds: id }],
    }).sort({ workDate: -1 }).lean();
    // Group by technician+date for the frontend
    const groups = {};
    assignments.forEach(a => {
      const key = `${a.technicianId}_${new Date(a.workDate).toDateString()}`;
      if (!groups[key]) groups[key] = { technicianId: a.technicianId, workDate: a.workDate, items: [] };
      groups[key].items.push(a);
    });
    res.json({ assignments, groups: Object.values(groups) });
  } catch (error) {
    console.error("Error fetching equipment:", error);
    res.status(500).json({ error: "Failed to fetch equipment" });
  }
});

// POST /api/projects/:id/equipment/request — technician requests equipment for today
router.post("/projects/:id/equipment/request", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const { items } = req.body; // [{ equipmentId, equipmentName, equipmentCode, quantity, consumable }]
    if (!items || !items.length) return res.status(400).json({ error: "No items requested" });

    const tech = await mongoose.model("Technician").findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const kit = await addProjectItemsToDailyKit({
      technicianId: tech._id,
      projectId: id,
      date: today,
      items,
    });
    res.json({
      message: `${items.length} item(s) added to the shared Daily Preparation`,
      dailyKitId: kit._id,
      kitStatus: kit.status,
      hasDelta: kit.hasDelta,
    });
  } catch (error) {
    console.error("Error requesting equipment:", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to request equipment" });
  }
});

// PUT /api/projects/:id/equipment/issue — admin issues/checks out equipment
router.put("/projects/:id/equipment/issue", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { assignmentIds, issuedBy } = req.body;
    if (!assignmentIds || !assignmentIds.length) return res.status(400).json({ error: "No assignments specified" });

    const now = new Date();
    const reservations = await EquipmentAssignment.find({
      _id: { $in: assignmentIds },
      $or: [{ projectId: id }, { projectIds: id }],
      status: "reserved",
      dailyKitId: null,
    });
    const updated = [];
    for (const assignment of reservations) {
      const tool = await Tool.findOneAndUpdate({
        _id: assignment.equipmentId,
        quantity: { $gte: assignment.quantity },
        assignable: { $ne: false },
        assetStatus: { $nin: ["under_maintenance", "damaged", "retired"] },
      }, {
        $inc: assignment.consumable
          ? { quantity: -assignment.quantity }
          : { quantity: -assignment.quantity, checkedOutQuantity: assignment.quantity },
        ...(!assignment.consumable ? { $set: { assetStatus: "checked_out" } } : {}),
      }, { returnDocument: "after" });
      if (!tool) continue;
      assignment.status = assignment.consumable ? "consumed" : "checked_out";
      assignment.issuedBy = issuedBy || "Admin";
      assignment.issuedAt = now;
      await assignment.save();
      updated.push(assignment.toObject());
    }
    res.json({ message: `${updated.length} item(s) issued`, assignments: updated });
  } catch (error) {
    console.error("Error issuing equipment:", error);
    res.status(500).json({ error: "Failed to issue equipment" });
  }
});

// PUT /api/projects/:id/equipment/return — technician returns equipment
router.put("/projects/:id/equipment/return", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    const { assignmentIds, condition } = req.body;
    if (!assignmentIds || !assignmentIds.length) return res.status(400).json({ error: "No assignments specified" });

    const now = new Date();
    const assignments = await EquipmentAssignment.find({
      _id: { $in: assignmentIds },
      $or: [{ projectId: id }, { projectIds: id }],
      technicianId: req.technician?._id || { $exists: true },
      status: { $in: ["checked_out", "in_use"] },
    });
    const managedIds = assignments.map(item => item._id);
    const referencedByKit = managedIds.length && await DailyKit.exists({
      technicianId: req.technician?._id,
      status: { $in: ["confirmed", "in_progress"] },
      $or: [
        { "items.equipmentAssignmentId": { $in: managedIds } },
        { "items.custodyAssignmentIds": { $in: managedIds } },
      ],
    });
    if (assignments.some(item => item.dailyKitId) || referencedByKit) {
      return res.status(409).json({ error: "Shared Daily Kit equipment must be returned from Daily Preparation after all scheduled jobs are finished." });
    }
    const updated = [];
    for (const assignment of assignments) {
      if (!assignment.consumable) {
        const tool = await Tool.findById(assignment.equipmentId);
        if (tool) {
          tool.quantity = Number(tool.quantity || 0) + assignment.quantity;
          tool.checkedOutQuantity = Math.max(0, Number(tool.checkedOutQuantity || 0) - assignment.quantity);
          tool.assetStatus = tool.checkedOutQuantity > 0 ? "checked_out" : "available";
          await tool.save();
        }
      }
      assignment.status = "returned";
      assignment.condition = condition || "good";
      assignment.returnedAt = now;
      await assignment.save();
      updated.push(assignment.toObject());
    }
    res.json({ message: `${updated.length} item(s) returned`, assignments: updated });
  } catch (error) {
    console.error("Error returning equipment:", error);
    res.status(500).json({ error: "Failed to return equipment" });
  }
});

// PUT /api/projects/:id/equipment/damage — report damaged equipment
router.put("/projects/:id/equipment/damage", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const { id } = req.params;
    const { assignmentId, description } = req.body;
    if (!assignmentId) return res.status(400).json({ error: "No assignment specified" });

    const updated = await EquipmentAssignment.findOneAndUpdate(
      { _id: assignmentId, $or: [{ projectId: id }, { projectIds: id }], technicianId: req.technician?._id },
      { $set: { status: "damaged", damageDescription: description || "", condition: "damaged" } },
      { returnDocument: "after" }
    );
    if (!updated) return res.status(404).json({ error: "Equipment assignment not found" });
    const damagedTool = await Tool.findById(updated.equipmentId);
    if (damagedTool) {
      damagedTool.checkedOutQuantity = Math.max(0, Number(damagedTool.checkedOutQuantity || 0) - Number(updated.quantity || 1));
      damagedTool.assetStatus = "damaged";
      damagedTool.assetCondition = "damaged";
      await damagedTool.save();
    }
    const kitItemMatch = updated.dailyKitId
      ? { _id: updated.dailyKitId, "items.equipmentAssignmentId": updated._id }
      : { technicianId: updated.technicianId, "items.custodyAssignmentIds": updated._id };
    await DailyKit.updateOne(kitItemMatch, { $set: { "items.$.checkoutStatus": "damaged" } });
    res.json({ message: "Damage reported", assignment: updated });
  } catch (error) {
    console.error("Error reporting damage:", error);
    res.status(500).json({ error: "Failed to report damage" });
  }
});

// GET /api/technician/equipment/today — calling technician's equipment for today
router.get("/technician/equipment/today", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const tech = await mongoose.model("Technician").findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

    const items = await EquipmentAssignment.find({
      technicianId: tech._id,
      workDate: { $gte: today, $lt: tomorrow },
    }).populate("projectId", "customer.name service.name isLargeScale")
      .populate("projectIds", "customer.name service.name isLargeScale")
      .sort({ createdAt: -1 }).lean();
    const kit = await DailyKit.findOne({ technicianId: tech._id, workDate: { $gte: today, $lt: tomorrow } })
      .select("items.equipmentAssignmentId items.custodyAssignmentIds status")
      .lean();
    const managedIds = new Set((kit?.items || []).flatMap(item => [
      item.equipmentAssignmentId,
      ...(item.custodyAssignmentIds || []),
    ]).filter(Boolean).map(String));
    for (const item of items) item.managedByDailyKit = Boolean(item.dailyKitId || managedIds.has(String(item._id)));

    res.json({ items, technician: { _id: tech._id, name: tech.name } });
  } catch (error) {
    console.error("Error fetching today equipment:", error);
    res.status(500).json({ error: "Failed to fetch equipment" });
  }
});

// GET /api/projects/:id/equipment/available-tools — list inventory tools not already reserved for this project today
router.get("/projects/:id/equipment/available-tools", auth.authenticate, auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const rows = await Tool.find({
      active: { $ne: false },
      status: { $in: ["in_stock", "low_stock"] },
      quantity: { $gt: 0 },
      assetStatus: { $nin: ["under_maintenance", "damaged", "retired"] },
    }).select("itemName assetCode barcode category type unit quantity reservedQuantity assignable inventoryClass").sort({ itemName: 1 }).lean();
    const tools = rows.filter(tool => tool.type === "consumable" || tool.type === "part" || (Tool.effectiveInventoryClass(tool) === "operational_asset" && tool.assignable !== false))
      .map(tool => ({
        _id: tool._id,
        name: tool.itemName,
        code: tool.assetCode || tool.barcode || "",
        category: tool.type === "consumable" ? "Consumable" : tool.type === "part" ? "Part" : "Equipment",
        unit: tool.unit || "pcs",
        available: Math.max(0, Number(tool.quantity || 0) - Number(tool.reservedQuantity || 0)),
      })).filter(tool => tool.available > 0);
    res.json({ tools });
  } catch (error) {
    console.error("Error fetching available tools:", error);
    res.status(500).json({ error: "Failed to fetch tools" });
  }
});

/**
 * POST /api/projects/validate-range
 *
 * Validates that a proposed project date range has sufficient technician
 * capacity across ALL working days in the range. Accessible to customers
 * during booking flow and to admin/secretary during scheduling.
 *
 * Body:
 *   startDate (string, YYYY-MM-DD) - Proposed start date
 *   endDate (string, YYYY-MM-DD) - Proposed completion date
 *   requiredTechnicians (number, default 1) - How many techs the project needs per day
 *   excludeProjectId (string, optional) - Project ID to exclude (for reschedule)
 *   serviceModel (string, optional) - "CoreService" | "RepairService"
 *
 * Response:
 *   { valid, available, message, dailyBreakdown[], nextAvailableRange }
 *
 *   When invalid, the message explains which day(s) lack capacity and
 *   suggests the next available date range.
 */
router.post("/projects/validate-range", auth.authenticate, async (req, res) => {
  try {
    const { startDate, endDate, requiredTechnicians, excludeProjectId, serviceModel } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ valid: false, available: false, message: "Start date and end date are required." });
    }

    const result = await schedulingEngine.validateProjectDateRange({
      startDate,
      endDate,
      requiredTechnicians: Number(requiredTechnicians) || 1,
      excludeProjectId: excludeProjectId || null,
      serviceModel: serviceModel || "CoreService",
    });

    return res.json(result);
  } catch (error) {
    console.error("Error validating project date range:", error);
    return res.status(500).json({ valid: false, available: false, message: "Failed to validate date range." });
  }
});

/**
 * POST /api/projects/window-availability
 *
 * Large-scale project preferred-window analysis. Treats the customer's
 * [startDate, endDate] range as a PREFERRED WINDOW (not a continuous
 * schedule): per-day technician availability is returned for calendar
 * rendering, and when requiredHours is provided a capacity verdict is
 * computed by comparing required labor hours against the sum of available
 * technician-hours across all workable dates inside the window.
 *
 * Body:
 *   startDate (string, YYYY-MM-DD) - Preferred start date
 *   endDate (string, YYYY-MM-DD) - Latest acceptable completion date
 *   requiredHours (number, optional) - Total estimated labor hours; when
 *     omitted the endpoint acts as a pure availability map.
 *   totalUnits (number, optional) - Units of work for the per-day unit preview
 *
 * Response:
 *   { totalActiveTechnicians, dailyHours, days[], totals{}, sufficient?,
 *     requiredHours?, minimumRequiredDays?, estimatedCompletionDate?,
 *     earliestCompletionDate?, draftSchedule[]? }
 */
router.post("/projects/window-availability", auth.authenticate, async (req, res) => {
  try {
    const { startDate, endDate, requiredHours, totalUnits } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "Start date and end date are required." });
    }

    const result = await schedulingEngine.getProjectWindowAvailability({
      startDate,
      endDate,
      requiredHours: requiredHours != null ? Number(requiredHours) : null,
      totalUnits: totalUnits != null ? Number(totalUnits) : null,
    });

    if (result && result.error) {
      return res.status(400).json({ error: result.error });
    }

    return res.json(result);
  } catch (error) {
    console.error("Error computing project window availability:", error);
    return res.status(500).json({ error: "Failed to compute project window availability." });
  }
});

/**
 * POST /api/projects/reserve-capacity
 *
 * Immediately reserves technician capacity for a pending project booking.
 * Called when a customer submits a project booking to prevent double-booking
 * while the request is awaiting admin scheduling.
 *
 * Body:
 *   bookingId (string) - The BookingService ID
 *   startDate (string, YYYY-MM-DD)
 *   endDate (string, YYYY-MM-DD)
 *   reservedTechnicians (number, default 1)
 *
 * Response:
 *   { reserved: boolean, reservedTechnicians: number }
 */
router.post("/projects/reserve-capacity", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { bookingId, startDate, endDate, reservedTechnicians } = req.body;

    if (!bookingId || !startDate || !endDate) {
      return res.status(400).json({ reserved: false, message: "bookingId, startDate, and endDate are required." });
    }

    const result = await schedulingEngine.reserveProjectCapacity({
      bookingId,
      startDate,
      endDate,
      reservedTechnicians: Number(reservedTechnicians) || 1,
    });

    return res.json(result);
  } catch (error) {
    console.error("Error reserving project capacity:", error);
    return res.status(500).json({ reserved: false, message: "Failed to reserve capacity." });
  }
});

module.exports = router;

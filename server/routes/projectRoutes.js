const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const router = express.Router();
const auth = require("../middleware/authenticate");
const Project = require("../models/Project");
const WorkOrder = require("../models/WorkOrder");
const ProjectMaterial = require("../models/ProjectMaterial");
const BookingService = require("../models/BookingService");
const Technician = require("../models/Technician");
const Assignment = require("../models/Assignment");
const Payment = require("../models/Payment");
const Expense = require("../models/Expense");
const ProjectIssue = require("../models/ProjectIssue");
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
const { ensureDailyAssignments, completeDay } = require("../utils/dailyAssignment");
const { BookingStatus } = require("../models/BookingStatus");
const audit = require("../utils/audit");

router.get("/projects/dashboard", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const stats = await Project.getDashboardStats();

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
    let { status, search, page = 1, limit = 20, sort = "-createdAt" } = req.query;
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

    const total = await Project.countDocuments(query);
    const projects = await Project.find(query)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

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

    res.json({ project, workOrders, materials, booking });
  } catch (error) {
    console.error("Error fetching project:", error);
    res.status(500).json({ error: "Failed to fetch project" });
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
      if ((project.totalWorkOrders || 0) === 0) missing.push("generate work orders");
      // Unit coverage: every work order's quantity must be assigned to a
      // technician so the project's total units are fully covered.
      const cov = await WorkOrder.computeCoveredUnits(project._id);
      if (cov.unassignedWos > 0) missing.push("assign technicians to every work order");
      else if (cov.covered < cov.total) missing.push(`cover all ${cov.total} units (only ${cov.covered} assigned)`);
      
      // Stock validation: check reserved resources are actually available
      const reservedMaterials = await ProjectMaterial.find({ projectId: project._id }).lean();
      const outOfStock = [];
      for (const mat of reservedMaterials) {
        if (mat.toolId) {
          const tool = await Tool.findById(mat.toolId).lean();
          if (tool && (tool.quantity || 0) < (mat.quantity || 0)) {
            outOfStock.push({ itemName: mat.itemName, available: tool.quantity || 0, reserved: mat.quantity || 0 });
          }
        }
      }
      if (outOfStock.length > 0) {
        const stockItems = outOfStock.map(s => `"${s.itemName}" (has ${s.available}, need ${s.reserved})`).join(", ");
        missing.push(`resolve stock shortages: ${stockItems}`);
      }
      
      if (missing.length) {
        return res.status(409).json({
          error: "Project is not ready yet. Complete: " + missing.join(", ") + ".",
          missing,
          coverage: cov,
        });
      }
    }

    // Hand the work to the team: once the project is Ready (or Active) the
    // auto-generated work orders are released to the assigned technicians so
    // they appear in the lead's "Large-Scale Projects" tab on My Work.
    if ((status === "ready" || status === "in_progress")) {
      await WorkOrder.updateMany(
        { projectId: project._id, status: "pending" },
        { $set: { status: "assigned" } }
      );
    }
    await project.save();

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
          { projectId: project._id, technicianId: { $in: assignmentTechIds }, status: { $nin: ["completed", "cancelled"] } },
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

        // Update group quotation
        if (ugi.quotation) {
          const groupParts = Array.isArray(ugi.quotation.parts) ? ugi.quotation.parts.map(p => ({
            name: p.name || '',
            cost: Number(p.cost) || 0,
            quantity: Number(p.quantity) || 1,
            toolId: p.toolId || null,
            currentStock: 0,
            stockStatus: 'pending_check',
          })) : [];
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
      "actualStartDate", "actualCompletionDate", "status",
    ];

    const updateData = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }

    const project = await Project.findByIdAndUpdate(id, updateData, { new: true });
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

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

    const technicians = await Technician.find({
      _id: { $in: technicianIds },
      active: { $ne: false },
    }).lean();

    // Remove technicians no longer selected, then add the new ones.
    const incomingIds = technicians.map((t) => t._id.toString());
    const removed = project.assignedTechnicians.filter(
      (t) => !incomingIds.includes(t._id.toString())
    );
    for (const r of removed) {
      if (r.assignmentId) {
        await Assignment.findByIdAndDelete(r.assignmentId).catch(() => {});
      }
    }

    const assigned = [];
    for (const tech of technicians) {
      const existing = project.assignedTechnicians.find(
        (t) => t._id.toString() === tech._id.toString()
      );
      if (existing && existing.assignmentId) {
        assigned.push(existing);
        continue;
      }

      const slaDeadline = new Date();
      slaDeadline.setDate(slaDeadline.getDate() + 14);

      const assignment = new Assignment({
        bookingId: project.bookingId,
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
    // track which technicians have accepted/declined.  The lead is auto-accepted
    // (planning steps unlock immediately for the admin); other members start as
    // "notified" and must manually accept before planning proceeds.
    const leadIdStr = project.leadTechnicianId ? project.leadTechnicianId.toString() : null;
    project.teamStatus = assigned.map((t) => ({
      _id: t._id,
      name: t.name || "Technician",
      status: t._id.toString() === leadIdStr ? "acknowledged" : "notified",
      notifiedAt: new Date(),
      acknowledgedAt: t._id.toString() === leadIdStr ? new Date() : undefined,
    }));

    // Large-scale projects must be verified/accepted before planning.
    if (project.status === "pending_project_scheduling" && !project.isLargeScale) {
      project.status = "planning";
    }
    // Lock the planned span once the team is assigned and a start date exists.
    if (assigned.length > 0 && (project.plannedStartDate || project.preferredStartDate)) {
      project.plannedStartDate = project.plannedStartDate || project.preferredStartDate;
      project.scheduleLocked = true;
    }

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
    const workOrders = wos
      .map((w) => ({
        _id: String(w._id),
        title: w.title || w.section || "Work Order",
        section: w.section || "",
        technicianId: w.assignedTechnicians && w.assignedTechnicians[0] ? String(w.assignedTechnicians[0]._id || w.assignedTechnicians[0]) : "",
        technicianName: w.assignedTechnicians && w.assignedTechnicians[0] ? (w.assignedTechnicians[0].name || "Unassigned") : "Unassigned",
        scheduledDate: w.scheduledDate ? new Date(w.scheduledDate).toISOString().slice(0, 10) : "",
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

/**
 * POST /api/projects/:id/generate-schedule
 * One-click auto-schedule: assigns available technicians to each working day
 * and creates their daily assignments. Never overwrites confirmed bookings.
 */
router.post("/projects/:id/generate-schedule", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const result = await projectScheduler.generateSchedule(id);
    res.json(result);
  } catch (error) {
    console.error("Error generating schedule:", error);
    res.status(500).json({ error: error.message || "Failed to generate schedule" });
  }
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
    res.json(result);
  } catch (error) {
    console.error("Error suggesting resources:", error);
    res.status(500).json({ error: "Failed to suggest resources" });
  }
});

/**
 * POST /api/projects/:id/reserve-suggested
 * Reserve the suggested resources (or a chosen subset) on the project.
 * body: { items: [{ itemName, type, quantity, unit, scope, reason }] }
 */
const Tool = require("../models/Tool");

router.post("/projects/:id/reserve-suggested", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
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
      const m = await ProjectMaterial.create({
        projectId: id,
        type: it.type || "equipment",
        scope: it.scope || "shared",
        itemName: it.itemName,
        quantity: it.quantity || 1,
        unit: it.unit || "pcs",
        status: "reserved",
        notes: it.reason || "",
      });
      created.push(m);
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

    const createdOrders = [];
    for (const wo of workOrders) {
      const assigned = Array.isArray(wo.assignedTechnicians)
        ? wo.assignedTechnicians.map((t) => ({
            _id: t._id, name: t.name, phone: t.phone,
            assignedUnits: t.assignedUnits != null ? t.assignedUnits : (wo.assignedTechnicians.length === 1 ? (wo.unitCount || 0) : 0),
          }))
        : [];
      const order = await WorkOrder.create({
        projectId: id,
        bookingId: project.bookingId,
        title: wo.title || "",
        description: wo.description || "",
        section: wo.section || "",
        unitCount: wo.unitCount || 0,
        estimatedHours: wo.estimatedHours || 0,
        assignedTechnicians: assigned,
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
      });
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
        ensureDailyAssignments(order._id).catch(() => {});
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

router.put("/work-orders/:id", auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid work order id" });
    }

    const allowedFields = [
      "title", "description", "section", "unitCount", "estimatedHours",
      "status", "assignedTechnicians", "scheduledDate", "startTime", "endTime",
      "actualStartDate", "actualCompletionDate", "notes", "technicianNotes",
      "priority", "sortOrder", "checklist", "completedUnitCount",
    ];

    const updateData = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }

    const workOrder = await WorkOrder.findByIdAndUpdate(id, updateData, { new: true });
    if (!workOrder) {
      return res.status(404).json({ error: "Work order not found" });
    }

    // If the schedule or assignment changed, regenerate the daily plan.
    if (req.body.scheduledDate !== undefined || req.body.assignedTechnicians !== undefined) {
      if ((workOrder.assignedTechnicians || []).length && workOrder.scheduledDate) {
        ensureDailyAssignments(workOrder._id).catch(() => {});
      }
    }

    if (workOrder.status === "completed" && !workOrder.actualCompletionDate) {
      workOrder.actualCompletionDate = new Date();
      workOrder.completedUnitCount = workOrder.unitCount;
      await workOrder.save();
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
    const result = await completeDay(id, tech._id, date || new Date(), completedUnits);
    if (result.behindSchedule) {
      // Notify admin that the project risks falling behind.
      const project = await Project.findById(result.workOrder.projectId).lean().catch(() => null);
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

router.delete("/work-orders/:id", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid work order id" });
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
      const material = await ProjectMaterial.create({
        projectId: id,
        workOrderId: mat.workOrderId || null,
        type: ["part", "equipment", "tool"].includes(mat.type) ? mat.type : "equipment",
        scope: mat.type === "part" ? "shared" : (["shared", "assigned"].includes(mat.scope) ? mat.scope : "shared"),
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
      { new: true },
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
    filename: (req, file, cb) => cb(null, "payproof-" + Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype));
  },
}).single("proofPhoto");

router.post("/projects/:id/upload-payment-proof", auth.authenticate, auth.requireRole(["admin", "secretary", "technician"]), (req, res) => {
  paymentProofUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: "Upload failed: " + err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
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
    filename: (req, file, cb) => cb(null, "comproof-" + Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype));
  },
}).single("completionPhoto");

router.post("/projects/:id/upload-completion-proof", auth.authenticate, auth.requireRole("technician"), (req, res) => {
  completionProofUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Upload failed: " + err.message });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const url = "/uploads/project-completion-proofs/" + req.file.filename;
    try {
      await Project.findByIdAndUpdate(req.params.id, { "payment.completionProofUrl": url });
    } catch (e) { /* best-effort */ }
    res.json({ url });
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
      status: { $in: ["pending", "assigned", "accepted", "en_route", "arrived", "in_progress"] },
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

      // All work orders on the project (so the lead's "Today's Team" board can
      // reflect every member's live status, not just the caller's own WOs).
      const allWos = await WorkOrder.find({ projectId: project._id })
        .sort({ scheduledDate: 1 })
        .lean()
        .catch(() => wos);

      // Per-member current status for the lead's "Today's Team" board.
      // Derived from each member's latest work-order status on this project.
      const teamBoard = [];
      const DailyAssignment = require("../models/DailyAssignment");
      const todayKey = new Date(); todayKey.setHours(0, 0, 0, 0);
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
        let todayTarget = 0, todayDone = 0;
        if (memberWos.length) {
          const da = await DailyAssignment.find({
            workOrderId: { $in: memberWos.map((w) => w._id) },
            technicianId: t._id,
            date: todayKey,
          }).lean().catch(() => []);
          todayTarget = da.reduce((s, d) => s + (d.targetUnits || 0), 0);
          todayDone = da.reduce((s, d) => s + (d.completedUnits || 0), 0);
        }
        // Total units assigned and completed across all WOs for this member.
        const memberTotalUnits = memberWos.reduce((s, w) => s + (w.unitCount || 0), 0);
        const memberDoneUnits = memberWos.reduce((s, w) => s + (w.completedUnitCount || 0), 0);
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
        const woDa = await DailyAssignment.find({
          workOrderId: wo._id,
          date: todayKey,
        }).lean().catch(() => []);
        const woTarget = woDa.reduce((s, d) => s + (d.targetUnits || 0), 0);
        const woDone = woDa.reduce((s, d) => s + (d.completedUnits || 0), 0);
        const woRemaining = Math.max(0, (wo.unitCount || 0) - (wo.completedUnitCount || 0));
        const woPct = (wo.unitCount || 0) > 0 ? Math.round(((wo.completedUnitCount || 0) / wo.unitCount) * 100) : 0;
        workOrderDetails.push({
          _id: wo._id,
          title: wo.title || wo.section || 'Work Order',
          section: wo.section || '',
          status: wo.status || 'pending',
          unitCount: wo.unitCount || 0,
          completedUnitCount: wo.completedUnitCount || 0,
          remaining: woRemaining,
          estimatedHours: wo.estimatedHours || 0,
          scheduledDate: wo.scheduledDate || null,
          startTime: wo.startTime || null,
          endTime: wo.endTime || null,
          todayTarget: woTarget,
          todayDone: woDone,
          completionPct: woPct,
          assignedTechnicians: (wo.assignedTechnicians || []).map(at => ({ _id: at._id, name: at.name || 'Technician' })),
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
      try {
        equipment = await ProjectMaterial.find({ projectId: project._id }).lean();
        issues = await ProjectIssue.find({ projectId: project._id, status: { $ne: "resolved" } }).lean();
        materialRequests = await ProjectIssue.find({ projectId: project._id, category: "inventory", status: { $ne: "resolved" } }).lean();
      } catch (_) {}

      // Crew-wide phase (drives the lead's single mobilize flow) + team gate.
      const phase = deriveProjectPhase(allWos, project);
      const allAccepted = teamAllAccepted(project);

      // My daily quota (today) for the calling technician across their WOs.
      const myWos = allWos.filter((w) =>
        (w.assignedTechnicians || []).some((a) => (a._id || a).toString() === technician._id.toString())
      );
      let myTodayTarget = 0, myTodayDone = 0;
      if (myWos.length) {
        const das = await DailyAssignment.find({
          workOrderId: { $in: myWos.map((w) => w._id) },
          technicianId: technician._id,
          date: todayKey,
        }).lean().catch(() => []);
        myTodayTarget = das.reduce((s, d) => s + (d.targetUnits || 0), 0);
        myTodayDone = das.reduce((s, d) => s + (d.completedUnits || 0), 0);
      }
      const myTotalUnits = myWos.reduce((s, w) => s + (w.unitCount || 0), 0);
      const myDoneUnits = myWos.reduce((s, w) => s + (w.completedUnitCount || 0), 0);

      // Overall project unit progress + all-done flag (for lead's collect flow).
      const projTotalUnits = allWos.reduce((s, w) => s + (w.unitCount || 0), 0);
      const projDoneUnits = allWos.reduce((s, w) => s + (w.completedUnitCount || 0), 0);

      assignments.push({
        project,
        workOrders: wos,
        myWorkOrders: myWos,
        isLead,
        leadAccepted: !!project.leadAcceptedAt,
        leadDeclinedReason: project.leadDeclinedReason || null,
        teamBoard,
        workOrderDetails,
        projectSchedule,
        equipment,
        issues,
        materialRequests,
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
        projectUnits: { total: projTotalUnits, done: projDoneUnits, allDone: projTotalUnits > 0 && projDoneUnits >= projTotalUnits },
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
    const ACCEPTABLE_STATUSES = ["ready", "planning", "pending_project_scheduling", "assigned", "accepted", "pending"];
    if (!ACCEPTABLE_STATUSES.includes(project.status)) {
      return res.status(400).json({ error: `Project cannot be accepted from "${project.status}" status` });
    }

    project.status = "in_progress";
    if (!project.actualStartDate) project.actualStartDate = new Date();
    project.leadAcceptedAt = new Date();
    project.leadDeclinedReason = undefined;
    // Build the team acknowledgement roster from the assigned team.
    project.teamStatus = (project.assignedTechnicians || []).map((t) => ({
      _id: t._id,
      name: t.name || "Technician",
      status: t._id.toString() === tech._id.toString() ? "acknowledged" : "notified",
      acknowledgedAt: t._id.toString() === tech._id.toString() ? new Date() : undefined,
    }));
    await project.save();

    // ── Cascade: update BookingService status to in-progress ──
    if (project.bookingId) {
      await BookingService.findByIdAndUpdate(project.bookingId, { status: "in-progress" }).catch(() => {});
    }

    // Auto-generate the work orders (if not already) and the daily schedule so
    // the team immediately receives assignments once they accept. The whole
    // team is assigned to every work order (joint on-site effort).
    try {
      const existingWos = await WorkOrder.countDocuments({ projectId: project._id });
      if (existingWos === 0 && (project.totalUnits || project.quantity)) {
        await projectScheduler.generateWorkOrders(project._id, {});
      }
      // Regenerate work orders if any are missing a team assignment.
      const orphanWos = await WorkOrder.find({ projectId: project._id, $or: [{ assignedTechnicians: { $size: 0 } }, { assignedTechnicians: { $exists: false } }] }).lean();
      if (orphanWos.length > 0) {
        await WorkOrder.deleteMany({ projectId: project._id });
        await projectScheduler.generateWorkOrders(project._id, {});
      }
      await projectScheduler.generateSchedule(project._id);
      // Mark generated work orders as "assigned" so the team can see and act
      // on their daily assignments immediately after the lead accepts.
      await WorkOrder.updateMany(
        { projectId: project._id, status: "pending" },
        { $set: { status: "assigned" } }
      );
    } catch (schedErr) {
      console.error("Auto-schedule on lead accept failed:", schedErr.message);
    }

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
    workOrder.status = "accepted";
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

    const techUser = req.user;
    const technician = await Technician.findOne({ user: techUser._id }).lean();

    workOrder.checklist = checklist.map((item) => ({
      ...item,
      completedAt: item.completed ? (item.completedAt || new Date()) : null,
      completedBy: item.completed ? (item.completedBy || technician?.name || techUser.name) : null,
    }));

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

    if (completedUnitCount !== undefined) {
      workOrder.completedUnitCount = Math.min(completedUnitCount, workOrder.unitCount);
    }
    if (status) {
      workOrder.status = status;
    }
    if (status === "in_progress" && !workOrder.actualStartDate) {
      workOrder.actualStartDate = new Date();
    }
    if (status === "completed" || workOrder.completedUnitCount >= workOrder.unitCount) {
      workOrder.status = "completed";
      workOrder.completedUnitCount = workOrder.unitCount;
      workOrder.actualCompletionDate = new Date();
    }

    await workOrder.save();
    await updateProjectProgress(workOrder.projectId);

    res.json({ workOrder });
  } catch (error) {
    console.error("Error updating work order progress:", error);
    res.status(500).json({ error: "Failed to update progress" });
  }
});

// ── Work Order field lifecycle (En Route / Arrived / Start) ─────────────────
function woTransition(allowedFrom, newStatus, tsField) {
  return async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid work order id" });
      }
      const workOrder = await WorkOrder.findById(id);
      if (!workOrder) return res.status(404).json({ error: "Work order not found" });
      if (allowedFrom && !allowedFrom.includes(workOrder.status)) {
        return res.status(400).json({ error: `Cannot transition from ${workOrder.status}` });
      }

      // Block en-route / arrived / start if admin planning is not complete on the parent project.
      if (workOrder.projectId && ["en_route", "arrived", "in_progress"].includes(newStatus)) {
        const proj = await Project.findById(workOrder.projectId).lean().catch(() => null);
        if (proj && ["pending_project_scheduling", "planning", "pending", "assigned"].includes(proj.status)) {
          return res.status(400).json({ error: "Admin planning is not yet complete — cannot proceed" });
        }
      }
      workOrder.status = newStatus;
      if (tsField) workOrder[tsField] = new Date();
      if (newStatus === "in_progress" && !workOrder.actualStartDate) {
        workOrder.actualStartDate = new Date();
      }
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
      res.status(500).json({ error: "Failed to update work order" });
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
    if (project.projectPhase === "assessment") return "assessment";
    if (project.projectPhase === "quotation_review") return "quotation_review";
    // execution phase: fall through to work-order-based phase logic
    if (project.projectPhase === "execution") {
      // If daily acceptance is required, the project is in daily_acceptance phase.
      if (project.dailyAcceptance && project.dailyAcceptance.required) {
        return "daily_acceptance";
      }
      const active = (workOrders || []).filter((w) => w.status !== "completed" && w.status !== "cancelled" && w.status !== "declined");
      if (active.length === 0) return "execution";
      const statuses = active.map((w) => w.status);
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

// Lead: mobilize the crew (En Route). Requires the full team to have accepted
// AND daily acceptance must be complete (if required).
router.put("/projects/:id/mobilize/en-route", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const { project } = ctx;
    if (!project.leadAcceptedAt) return res.status(400).json({ error: "Accept the project first" });
    if (!teamAllAccepted(project)) return res.status(400).json({ error: "Waiting for all team members to accept" });
    // Large-scale: team cannot mobilize for repair work until quotation is approved
    if (project.isLargeScale && project.projectPhase !== "execution") {
      if (project.projectPhase === "assessment") return res.status(400).json({ error: "Site inspection must be completed and quotation approved before the team can mobilize for repair work", phase: "assessment" });
      if (project.projectPhase === "quotation_review") return res.status(400).json({ error: "Quotation is under admin review — await approval before mobilizing", phase: "quotation_review" });
    }
    // Block mobilization if daily acceptance is still pending.
    if (project.dailyAcceptance && project.dailyAcceptance.required) {
      return res.status(400).json({ error: "Waiting for daily team confirmation — ask members to confirm availability", dailyAcceptance: true });
    }
    const wos = await WorkOrder.find({ projectId: project._id, status: { $in: ["assigned", "accepted", "arrived"] } });
    if (wos.length === 0) return res.status(400).json({ error: "No active work to mobilize today" });
    for (const w of wos) { w.status = "en_route"; w.enRouteAt = new Date(); await w.save(); }
    emitProjectPhase(req, project, "en_route");
    res.json({ phase: "en_route", message: "Team is en route" });
  } catch (e) {
    console.error("mobilize en-route error:", e);
    res.status(500).json({ error: "Failed to mobilize team" });
  }
});

// Lead: mark the crew arrived on site.
router.put("/projects/:id/mobilize/arrived", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const { project } = ctx;
    const wos = await WorkOrder.find({ projectId: project._id, status: { $in: ["en_route", "accepted"] } });
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
    const wos = await WorkOrder.find({ projectId: project._id, status: { $in: ["arrived", "accepted"] } });
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
    const wos = await WorkOrder.find({ projectId: project._id, status: { $in: ["en_route", "arrived", "accepted"] } });
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
    const wos = await WorkOrder.find({ projectId: project._id, status: { $in: ["in_progress", "arrived", "en_route"] } });
    for (const w of wos) {
      const remaining = (w.unitCount || 0) - (w.completedUnitCount || 0);
      if (remaining > 0) { w.status = "accepted"; await w.save(); }
    }

    // Set up daily re-acceptance for the next working day.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
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

router.get("/projects/:id/payment-summary", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const summary = await buildProjectPaymentSummary(ctx.project);
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
    const summary = await buildProjectPaymentSummary(project);
    if (!summary.allDone) return res.status(400).json({ error: "All units must be completed before collecting payment" });

    const b = req.body || {};
    const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
    const daysWorked = Math.max(1, Math.round(num(b.daysWorked, summary.daysWorked)));
    const crewSize = Math.max(1, Math.round(num(b.crewSize, summary.crewSize)));
    const laborRatePerDay = num(b.laborRatePerDay, summary.laborRatePerDay);
    const serviceFee = num(b.serviceFee, summary.serviceFee);
    const additionalCharges = num(b.additionalCharges, 0);
    const travelFare = summary.travelFare; // from booking, read-only
    const laborType = summary.laborType; // "core" or "repair"
    const partsCost = summary.partsCost || 0;
    let laborTotal;
    if (laborType === "repair") {
      laborTotal = laborRatePerDay * daysWorked; // repair: rate × days (no crew multiplier)
    } else {
      laborTotal = laborRatePerDay * crewSize * daysWorked; // core: rate × crew × days
    }
    const total = laborTotal + travelFare + serviceFee + additionalCharges + partsCost;
    const amount = num(b.amount, total);
    const method = (b.paymentMethod || "cash").toString().slice(0, 40);

    const prevPaid = (project.payment && project.payment.amountPaid) || 0;
    const amountPaid = prevPaid + amount;
    const balanceAmount = Math.max(0, total - amountPaid);
    project.payment = {
      ...(project.payment || {}),
      totalAmount: total,
      amountPaid,
      balanceAmount,
      paymentMethod: method,
      paymentStatus: balanceAmount <= 0 ? "paid" : "partial",
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
      await BookingService.findByIdAndUpdate(project.bookingId, { status: bsUpdate }).catch(() => {});
    }

    // ── Cascade: create standalone Payment record ──
    if (amount > 0) {
      await Payment.create({
        bookingId: project.bookingId || undefined,
        projectId: project._id,
        amount,
        method: method === "gcash" ? "gcash" : "cod",
        type: balanceAmount <= 0 ? "final" : "downpayment",
        gateway: method === "gcash" ? "gcash" : "cod",
        status: "paid",
        reference: `Project ${project._id}`,
        notes: `Collected by ${ctx.tech.name || "lead"}. ${b.remarks || ""}`.trim(),
        submittedAt: new Date(),
        verifiedAt: new Date(),
        completedAt: new Date(),
      }).catch(() => {});
    }

    // ── Cascade: complete Assignment records for project team ──
    if (balanceAmount <= 0) {
      const assignmentIds = (project.assignedTechnicians || []).map(t => t._id).filter(Boolean);
      if (assignmentIds.length > 0) {
        await Assignment.updateMany(
          { projectId: project._id, technicianId: { $in: assignmentIds }, status: { $nin: ["completed", "cancelled"] } },
          { $set: { status: "completed", completedAt: new Date() } }
        ).catch(() => {});
      }
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
    res.json({ repair: project.repair });
  } catch (e) {
    console.error("repair-summary error:", e);
    res.status(500).json({ error: "Failed to load repair summary" });
  }
});

// ── Repair Project: Record parts used (lead-only) ──────────────────────────
router.post("/projects/:id/record-parts-used", auth.authenticate, auth.requireRole("technician"), async (req, res) => {
  try {
    const ctx = await requireProjectLead(req, res); if (!ctx) return;
    const { project } = ctx;
    if (!project.repair || project.repair.serviceType !== "repair") {
      return res.status(400).json({ error: "This is not a repair project" });
    }
    const Tool = require("../models/Tool");
    const parts = req.body.parts || [];
    const recorded = [];
    for (const p of parts) {
      if (!p.name || !p.quantity) continue;
      const entry = {
        name: p.name,
        quantity: Number(p.quantity) || 1,
        unitCost: Number(p.unitCost) || 0,
        toolId: p.toolId || undefined,
        usedBy: req.user._id,
        usedAt: new Date(),
      };
      recorded.push(entry);
      // Deduct from Tool inventory if toolId provided
      if (entry.toolId) {
        try {
          await Tool.findByIdAndUpdate(entry.toolId, { $inc: { quantity: -entry.quantity } }).catch(() => {});
        } catch (_) {}
      }
    }
    project.repair.partsUsed = (project.repair.partsUsed || []).concat(recorded);
    await project.save();
    res.json({ message: "Parts recorded", partsUsed: project.repair.partsUsed });
  } catch (e) {
    console.error("record-parts-used error:", e);
    res.status(500).json({ error: "Failed to record parts" });
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

    // Try auto-linking toolId by part name if not set
    for (const p of parts) {
      if (!p.toolId && p.name) {
        const toolMatch = await Tool.findOne({ itemName: new RegExp(`^${p.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
        if (toolMatch) p.toolId = toolMatch._id;
      }
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
    if (workOrder.scheduledDate) ensureDailyAssignments(workOrder._id).catch(() => {});

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
    const issue = new ProjectIssue({
      projectId,
      workOrderId: workOrderId && mongoose.Types.ObjectId.isValid(workOrderId) ? workOrderId : null,
      reportedBy: { _id: req.user._id, name: req.user.name || req.user.email || "Technician" },
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
    const project = await Project.findById(projectId).lean();
    await createNotification({
      type: "project_issue",
      title: "New Project Issue",
      message: `${issue.reportedBy.name} reported a ${issue.category} issue${project ? ` on ${project.customer?.name || "a project"}` : ""}.`,
      userId: req.user._id,
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
    res.status(500).json({ error: "Failed to submit issue" });
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
    if (!type || !amount || !description) return res.status(400).json({ error: "type, amount and description are required" });
    const expense = new Expense({
      technicianId: req.user._id,
      technicianName: req.user.name || req.user.email || "Technician",
      projectId,
      workOrderId: workOrderId && mongoose.Types.ObjectId.isValid(workOrderId) ? workOrderId : null,
      type,
      amount,
      description,
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
      userId: req.user._id,
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
    res.status(500).json({ error: "Failed to submit expense" });
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
    await createNotification({
      type: expense.status === "approved" ? "expense_approved" : "expense_rejected",
      title: expense.status === "approved" ? "Expense Approved" : "Expense Rejected",
      message: expense.status === "approved" ? `Your ${expense.type} expense was approved.` : `Your ${expense.type} expense was rejected.`,
      userId: expense.technicianId,
      role: "technician",
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
    const totalWO = workOrders.length;
    const completedWO = workOrders.filter((wo) => wo.status === "completed").length;
    const totalUnits = workOrders.reduce((sum, wo) => sum + (wo.unitCount || 0), 0);
    const completedUnits = workOrders.reduce((sum, wo) => sum + (wo.completedUnitCount || 0), 0);
    const assignedTechs = new Set();
    workOrders.forEach((wo) => {
      (wo.assignedTechnicians || []).forEach((t) => assignedTechs.add(String(t._id)));
    });

    const update = {
      totalWorkOrders: totalWO,
      completedWorkOrders: completedWO,
      totalUnits,
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
    if (proj && proj.isLargeScale && proj.status === "accepted") {
      delete update.status;
    }

    await Project.findByIdAndUpdate(projectId, update);

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
          { projectId: projectId, technicianId: { $in: assignmentTechIds }, status: { $nin: ["completed", "cancelled"] } },
          { $set: { status: "completed", completedAt: new Date() } }
        ).catch(() => {});
      }
    }

    // ── Notify lead tech when all units are done (large-scale projects) ──
    if (proj && proj.isLargeScale && totalUnits > 0 && completedUnits >= totalUnits) {
      const alreadyNotified = proj._allUnitsNotified;
      if (!alreadyNotified) {
        const leadId = proj.leadTechnicianId;
        if (leadId) {
          const customerName = proj.customer?.name || proj.service?.name || "project";
          await createNotification({
            type: "project_all_units_done",
            title: "All units completed",
            message: `All ${totalUnits} unit(s) for "${customerName}" are complete. You can now collect payment.`,
            userId: leadId,
            referenceId: projectId,
            referenceModel: "Project",
            link: "/technician/assignments",
            priority: "high",
          }).catch(() => {});
          await Project.findByIdAndUpdate(projectId, { _allUnitsNotified: true }).catch(() => {});
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
const EquipmentAssignment = require("../models/EquipmentAssignment");

// GET /api/projects/:id/equipment — list all equipment assignments for this project
router.get("/projects/:id/equipment", auth.authenticate, auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid project id" });
    const assignments = await EquipmentAssignment.find({ projectId: id }).sort({ workDate: -1 }).lean();
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
    // Remove any previous pending requests for today
    await EquipmentAssignment.deleteMany({ projectId: id, technicianId: tech._id, workDate: today, status: "reserved" });

    const created = [];
    for (const item of items) {
      const eq = await EquipmentAssignment.create({
        projectId: id,
        technicianId: tech._id,
        workDate: today,
        equipmentId: item.equipmentId,
        equipmentName: item.equipmentName,
        equipmentCode: item.equipmentCode,
        quantity: item.quantity || 1,
        consumable: !!item.consumable,
        status: "reserved",
      });
      created.push(eq);
    }
    res.json({ message: `${created.length} item(s) requested`, assignments: created });
  } catch (error) {
    console.error("Error requesting equipment:", error);
    res.status(500).json({ error: "Failed to request equipment" });
  }
});

// PUT /api/projects/:id/equipment/issue — admin issues/checks out equipment
router.put("/projects/:id/equipment/issue", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { assignmentIds, issuedBy } = req.body;
    if (!assignmentIds || !assignmentIds.length) return res.status(400).json({ error: "No assignments specified" });

    const now = new Date();
    await EquipmentAssignment.updateMany(
      { _id: { $in: assignmentIds }, projectId: id, status: "reserved" },
      { $set: { status: "checked_out", issuedBy: issuedBy || "Admin", issuedAt: now } }
    );
    const updated = await EquipmentAssignment.find({ _id: { $in: assignmentIds } }).lean();
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
    await EquipmentAssignment.updateMany(
      { _id: { $in: assignmentIds }, projectId: id, technicianId: { $exists: true } },
      { $set: { status: "returned", condition: condition || "good", returnedAt: now } }
    );
    const updated = await EquipmentAssignment.find({ _id: { $in: assignmentIds } }).lean();
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
      { _id: assignmentId, projectId: id },
      { $set: { status: "damaged", damageDescription: description || "", condition: "damaged" } },
      { returnDocument: "after" }
    );
    if (!updated) return res.status(404).json({ error: "Equipment assignment not found" });
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
    }).populate("projectId", "customer.name service.name isLargeScale").sort({ createdAt: -1 }).lean();

    res.json({ items, technician: { _id: tech._id, name: tech.name } });
  } catch (error) {
    console.error("Error fetching today equipment:", error);
    res.status(500).json({ error: "Failed to fetch equipment" });
  }
});

// GET /api/projects/:id/equipment/available-tools — list inventory tools not already reserved for this project today
router.get("/projects/:id/equipment/available-tools", auth.authenticate, auth.requireRole(["admin", "secretary", "technician"]), async (req, res) => {
  try {
    const tools = await Tool.find({ status: "available" }).select("name code category brand").lean();
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

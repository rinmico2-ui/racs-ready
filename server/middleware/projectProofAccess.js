"use strict";
const Payment = require("../models/Payment");
const Project = require("../models/Project");
const ProjectWorkSubmission = require("../models/ProjectWorkSubmission");
const Technician = require("../models/Technician");
const { hasPermission } = require("./requirePermission");

function proofPath(req) {
  try {
    const path = decodeURIComponent(new URL(req.originalUrl, "http://local").pathname);
    return /^\/uploads\/(remittance-proofs|project-work-submissions|project-completion-proofs)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path)
      && !path.includes("..") ? path : "";
  } catch { return ""; }
}
async function technicianId(userId) {
  const technician = await Technician.findOne({ user: userId }).select("_id").maxTimeMS(1500).lean();
  return technician ? String(technician._id) : "";
}
async function requireProofAccess(req, res, next) {
  try {
    const url = proofPath(req);
    if (!url) return res.status(404).end();
    const user = req.user;
    const remittance = url.startsWith("/uploads/remittance-proofs/");
    if (["admin", "secretary"].includes(user?.role)) {
      const permission = remittance ? "payments.view" : "appointments.view";
      if (await hasPermission(user, permission)) return next();
      return res.status(403).json({ error: "You do not have permission to view this file." });
    }
    const userId = String(user?._id || "");
    let permitted = false;
    if (remittance) {
      const payment = await Payment.findOne({ remittanceProofUrl: url })
        .select("collectedBy remittedBy remittedByTechnician").maxTimeMS(1500).lean();
      if (!payment) return res.status(404).end();
      if (user?.role === "technician" && await hasPermission(user, "remittances.self.manage")) {
        const id = await technicianId(userId);
        permitted = String(payment.remittedBy || "") === userId
          || (id && [payment.collectedBy, payment.remittedByTechnician].some(value => String(value || "") === id));
      }
    } else {
      let submission;
      let project;
      if (url.startsWith("/uploads/project-work-submissions/")) {
        submission = await ProjectWorkSubmission.findOne({ "proof.url": url })
          .select("projectId submittedByUserId technicianId").maxTimeMS(1500).lean();
        if (submission) project = await Project.findById(submission.projectId)
          .select("customerId customer._id assignedTechnicians leadTechnicianId").maxTimeMS(1500).lean();
      } else {
        project = await Project.findOne({ "payment.completionProofUrl": url })
          .select("customerId customer._id assignedTechnicians leadTechnicianId").maxTimeMS(1500).lean();
      }
      if (!project) return res.status(404).end();
      if (user?.role === "customer") permitted = String(project.customerId || project.customer?._id || "") === userId;
      if (user?.role === "technician" && await hasPermission(user, "assignments.self.view")) {
        const id = await technicianId(userId);
        permitted = String(submission?.submittedByUserId || "") === userId
          || (id && (String(project.leadTechnicianId || "") === id
            || (project.assignedTechnicians || []).some(value => String(value._id || value) === id)));
      }
    }
    if (!permitted) return res.status(403).json({ error: "You do not have permission to view this file." });
    res.set("Cache-Control", "private, no-store");
    return next();
  } catch (error) { return next(error); }
}
module.exports = { requireProofAccess, proofPath };

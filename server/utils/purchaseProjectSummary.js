"use strict";

// One indexed lookup for the whole customer order list; expose operational
// progress without returning inventory costs, internal notes or resource plans.
async function attachPurchaseProjectSummaries(orders) {
  const projects = orders.filter(order => order.isProject && order.projectId);
  if (!projects.length) return;
  const rows = await require('../models/Project').find({ sourceOrderId: { $in: projects.map(order => order._id) } })
    .select('_id sourceOrderId status totalUnits completedUnits scheduleLocked plannedStartDate plannedCompletionDate schedulePlan.status').lean();
  const byOrder = new Map(rows.map(project => [String(project.sourceOrderId), project]));
  for (const order of projects) {
    const project = byOrder.get(String(order._id));
    if (!project || String(project._id) !== String(order.projectId)) continue;
    order.projectSummary = { status: project.status, totalUnits: project.totalUnits, completedUnits: project.completedUnits || 0,
      confirmed: project.scheduleLocked === true && project.schedulePlan?.status === 'confirmed',
      startDate: project.plannedStartDate, endDate: project.plannedCompletionDate };
  }
}

module.exports = { attachPurchaseProjectSummaries };

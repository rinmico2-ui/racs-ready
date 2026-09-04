const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const DailyKit = require("../models/DailyKit");
const { allocateInteger, buildProjectKitRequirements } = require("../utils/projectDailyKitPlanning");

const ids = {
  project: "507f1f77bcf86cd799439001",
  order: "507f1f77bcf86cd799439002",
  tech1: "507f1f77bcf86cd799439003",
  tech2: "507f1f77bcf86cd799439004",
  day1a: "507f1f77bcf86cd799439005",
  day1b: "507f1f77bcf86cd799439006",
  day2: "507f1f77bcf86cd799439007",
  tool1: "507f1f77bcf86cd799439008",
  tool2: "507f1f77bcf86cd799439009",
};

const rows = [
  { _id: ids.day1a, projectId: ids.project, workOrderId: ids.order, technicianId: ids.tech1, date: "2026-09-03", targetUnits: 2 },
  { _id: ids.day1b, projectId: ids.project, workOrderId: ids.order, technicianId: ids.tech2, date: "2026-09-03", targetUnits: 3 },
  { _id: ids.day2, projectId: ids.project, workOrderId: ids.order, technicianId: ids.tech1, date: "2026-09-04", targetUnits: 5 },
];

const workOrders = [{
  _id: ids.order,
  resourceRequirements: [
    { toolId: ids.tool1, itemName: "Extension Ladder", type: "equipment", quantity: 1, unit: "pcs" },
    { toolId: ids.tool2, itemName: "Coil Cleaner", type: "consumable", quantity: 10, unit: "L" },
  ],
}];

test("largest-remainder allocation preserves the exact requested quantity", () => {
  const allocation = allocateInteger(10, rows, row => row.targetUnits);
  assert.deepEqual([...allocation.values()], [2, 3, 5]);
  assert.equal([...allocation.values()].reduce((sum, quantity) => sum + quantity, 0), 10);
});

test("one reusable project asset is assigned to one deterministic daily carrier", () => {
  const requirements = buildProjectKitRequirements({
    targetAssignments: rows.slice(0, 2),
    allAssignments: rows,
    workOrders,
  });
  const ladders = requirements.filter(row => row.name === "Extension Ladder");
  assert.equal(ladders.length, 1);
  assert.equal(String(ladders[0].dailyAssignmentId), ids.day1a);
  assert.equal(ladders[0].quantity, 1);
});

test("project consumables are apportioned across the full schedule, not reissued in full each day", () => {
  const requirements = buildProjectKitRequirements({
    targetAssignments: rows,
    allAssignments: rows,
    workOrders,
  }).filter(row => row.name === "Coil Cleaner");
  assert.deepEqual(requirements.map(row => row.quantity), [2, 3, 5]);
  assert.equal(requirements.reduce((sum, row) => sum + row.quantity, 0), 10);
});

test("Daily Kit accepts explicit project provenance and existing custody status", async () => {
  const kit = new DailyKit({
    technicianId: new mongoose.Types.ObjectId(ids.tech1),
    workDate: new Date("2026-09-03"),
    projectIds: [ids.project],
    workOrderIds: [ids.order],
    dailyAssignmentIds: [ids.day1a],
    items: [{
      name: "Extension Ladder",
      quantity: 1,
      category: "equipment",
      checkoutStatus: "in_custody",
      projectIds: [ids.project],
      workOrderIds: [ids.order],
      dailyAssignmentIds: [ids.day1a],
      projectAllocations: [{ projectId: ids.project, workOrderId: ids.order, dailyAssignmentId: ids.day1a, quantity: 1 }],
    }],
  });
  await assert.doesNotReject(kit.validate());
});

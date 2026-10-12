"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TARGETS, assertExactProjects } = require("../scripts/archive-selected-projects");
const Project = require("../models/Project");
const routes = require("../routes/projectRoutes");

function matchingProjects() {
  return TARGETS.map(([id, name, service, units, hours, date]) => ({ _id: id, customer: { name },
    service: { name: service }, totalUnits: units, estimatedTotalHours: hours, completedUnits: 0,
    status: "pending_project_scheduling", preferredCompletionDeadline: new Date(`${date}T00:00:00+08:00`) }));
}

test("cleanup accepts only the ten exact projects, including their Philippine completion dates", () => {
  assert.doesNotThrow(() => assertExactProjects(matchingProjects()));
  assert.equal(new Set(TARGETS.map(row => row[0])).size, 10);
});

test("cleanup rejects a missing project or a changed identity, scope, approved date or started project", () => {
  assert.throws(() => assertExactProjects(matchingProjects().slice(1)));
  for (const patch of [{ totalUnits: 39 }, { estimatedTotalHours: 200 }, { customer: { name: "Another customer" } },
    { service: { name: "Another service" } }, { completedUnits: 1 }, { status: "in_progress" },
    { preferredCompletionDeadline: new Date("2026-12-01T00:00:00+08:00") }]) {
    const rows = matchingProjects();
    Object.assign(rows[0], patch);
    assert.throws(() => assertExactProjects(rows));
  }
});

test("already cancelled archived records can be verified again without broadening the target set", () => {
  assert.doesNotThrow(() => assertExactProjects(matchingProjects().map(row => ({ ...row, status: "cancelled", archivedAt: new Date() }))));
});

test("project list and health-filter queries exclude archived projects", async t => {
  const handler = routes.stack.find(layer => layer.route?.path === "/projects" && layer.route.methods.get).route.stack.at(-1).handle;
  const filters = [];
  t.mock.method(Project, "find", filter => { filters.push(filter); return {
    sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => [],
  }; });
  t.mock.method(Project, "countDocuments", async filter => { filters.push(filter); return 0; });
  for (const query of [{}, { status: "cancelled" }, { scheduleHealth: "past_due" }]) {
    let output;
    await handler({ query }, { json(value) { output = value; } });
    assert.equal(output.pagination.total, 0);
  }
  assert.ok(filters.length >= 5);
  assert.ok(filters.every(filter => filter.archivedAt === null));
});

test("dashboard totals and trends exclude archived rows before aggregation", async t => {
  const pipelines = [];
  t.mock.method(Project, "aggregate", async pipeline => {
    pipelines.push(pipeline);
    return pipeline.some(stage => stage.$facet) ? [{ planning: [], ready: [], inProgress: [], pendingScheduling: [],
      accepted: [], completed: [], closed: [], onHold: [], cancelled: [], totalUnitsCompleted: [] }] : [];
  });
  const result = await Project.getDashboardStats();
  assert.equal(result.cancelled, 0);
  assert.equal(pipelines.length, 2);
  for (const pipeline of pipelines) assert.deepEqual(pipeline[0], { $match: { archivedAt: null } });
});

test("cancelled archived projects reserve no technician capacity", () => {
  const row = { ...matchingProjects()[0], status: "cancelled", archivedAt: new Date(), reservedTechnicians: 2 };
  assert.equal(Project.reservedTechniciansOn(row, new Date("2026-10-27T08:00:00+08:00")), 0);
});

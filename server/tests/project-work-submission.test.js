const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeProjectWorkSubmission } = require("../utils/projectWorkSubmission");

function validBody(overrides = {}) {
  return {
    clientSubmissionId: "submission-123",
    workOrders: JSON.stringify([{ workOrderId: "507f1f77bcf86cd799439011", completedUnits: 2 }]),
    consumables: JSON.stringify([{ assignmentId: "507f1f77bcf86cd799439012", quantityUsed: 1.25 }]),
    consumablesDeclaredNone: "false",
    notes: "Units tested",
    ...overrides,
  };
}

test("normalizes a multipart project work submission", () => {
  const result = normalizeProjectWorkSubmission(validBody());
  assert.deepEqual(result.workOrders, [{ workOrderId: "507f1f77bcf86cd799439011", completedUnits: 2 }]);
  assert.deepEqual(result.consumables, [{ assignmentId: "507f1f77bcf86cd799439012", quantityUsed: 1.25 }]);
  assert.equal(result.consumablesDeclaredNone, false);
  assert.equal(result.notes, "Units tested");
});

test("allows an explicit no-consumables declaration", () => {
  const result = normalizeProjectWorkSubmission(validBody({
    consumables: "[]",
    consumablesDeclaredNone: "true",
  }));
  assert.deepEqual(result.consumables, []);
  assert.equal(result.consumablesDeclaredNone, true);
});

test("rejects an implicit empty consumables list", () => {
  assert.throws(
    () => normalizeProjectWorkSubmission(validBody({ consumables: "[]" })),
    /explicitly confirm that none were used/,
  );
});

test("rejects duplicate work-order and consumable lines", () => {
  const duplicateWorkOrder = { workOrderId: "507f1f77bcf86cd799439011", completedUnits: 1 };
  assert.throws(
    () => normalizeProjectWorkSubmission(validBody({ workOrders: JSON.stringify([duplicateWorkOrder, duplicateWorkOrder]) })),
    /only appear once/,
  );

  const duplicateConsumable = { assignmentId: "507f1f77bcf86cd799439012", quantityUsed: 1 };
  assert.throws(
    () => normalizeProjectWorkSubmission(validBody({ consumables: JSON.stringify([duplicateConsumable, duplicateConsumable]) })),
    /only appear once/,
  );
});

test("rejects invalid completed-unit and consumable quantities", () => {
  assert.throws(
    () => normalizeProjectWorkSubmission(validBody({
      workOrders: JSON.stringify([{ workOrderId: "507f1f77bcf86cd799439011", completedUnits: 1.5 }]),
    })),
    /whole numbers/,
  );
  assert.throws(
    () => normalizeProjectWorkSubmission(validBody({
      consumables: JSON.stringify([{ assignmentId: "507f1f77bcf86cd799439012", quantityUsed: 0 }]),
    })),
    /greater than zero/,
  );
});

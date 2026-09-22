const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const orderRoutes = source("routes/orderRoutes.js");
const technicianApi = source("routes/technicianApi.js");
const projectRoutes = source("routes/projectRoutes.js");
const assignmentsView = source("views/pages/technician/assignments.ejs");
const orderView = source("views/pages/technician/technicianorders.ejs");
const dailyKitService = source("utils/dailyKitService.js");

test("order handover requires the exact final balance before completion", () => {
  assert.match(orderRoutes, /money\(value\) !== amountDue/);
  assert.match(orderRoutes, /code: "ORDER_FINAL_AMOUNT_MISMATCH"/);
  assert.match(orderRoutes, /status === "completed" && FINAL_COLLECTION_PAYMENT_METHODS\.has\(order\.paymentMethod\)/);
  assert.match(orderRoutes, /code: "ORDER_BALANCE_REQUIRED"/);
  assert.match(orderRoutes, /balanceAmount: 0/);
  assert.match(orderRoutes, /__v: order\.__v/);
  assert.match(orderView, /Number\(order\.balanceAmount \?\? order\.total \?\? 0\) > 0/);
  assert.match(orderView, /readonly/);
});

test("proof completion commits consumables with the booking instead of consuming in advance", () => {
  assert.doesNotMatch(assignmentsView, /fetch\('\/api\/technician\/daily-kit\/consume'/);
  assert.match(assignmentsView, /formData\.append\('consumables', JSON\.stringify\(consumables\)\)/);
  assert.match(technicianApi, /completionSession\.startTransaction\(\)/);
  assert.match(technicianApi, /recordBookingConsumableUsage\(\{/);
  assert.match(technicianApi, /completionSession\.commitTransaction\(\)/);
  assert.match(technicianApi, /deleteCompletionProof\(storedProof\.fileId\)/);
  assert.match(dailyKitService, /Record consumable usage for:/);
  assert.match(dailyKitService, /assignmentId,[\s\S]*bookingId,[\s\S]*quantityUsed: usage\.quantity/);
});

test("large-scale work orders cannot skip travel and arrival stages", () => {
  assert.match(projectRoutes, /woTransition\(\["accepted", "partially_completed"\], "en_route"/);
  assert.match(projectRoutes, /woTransition\(\["en_route"\], "arrived"/);
  assert.match(projectRoutes, /woTransition\(\["arrived"\], "in_progress"/);
  assert.match(projectRoutes, /scheduledWorkOrdersForDay\(project\._id, \["en_route"\]\)/);
  assert.match(projectRoutes, /scheduledWorkOrdersForDay\(project\._id, \["arrived"\]\)/);
  assert.doesNotMatch(projectRoutes, /woTransition\(\["en_route", "accepted"\], "arrived"/);
  assert.doesNotMatch(projectRoutes, /woTransition\(\["arrived", "accepted"\], "in_progress"/);
});

test("expired assignments cannot retain booking or project access", () => {
  assert.match(technicianApi, /status: \{ \$nin: \["declined", "cancelled", "expired"\] \}/);
  assert.match(technicianApi, /status: \{ \$in: \["declined", "cancelled", "expired"\] \}/);
  assert.match(projectRoutes, /status: \{ \$in: \["pending_acceptance", "accepted", "en_route", "on_site", "waiting_for_customer", "in_progress"\] \}/);
});

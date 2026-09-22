"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("booking history uses server pagination and preserves authoritative zero payment values", () => {
  const script = read("public/js/book-history.js");
  assert.doesNotMatch(script, /appointments\?limit=1000/);
  assert.match(script, /payload\.pagination\?\.total/);
  assert.match(script, /b\.balanceAmount \?\?/);
  assert.match(script, /b\.amountPaid \?\?/);
});

test("repair completion statuses expose the rating workflow", () => {
  const script = read("public/js/book-history.js");
  const ratableStatusChecks = script.match(/\["completed", "repair_completed", "closed"\]\.includes\(b\.status\)/g) || [];
  assert.ok(ratableStatusChecks.length >= 2);
});

test("booking deep links resolve references and use the real detail modal id", () => {
  const script = read("public/js/book-history.js");
  assert.match(script, /item\.bookingReference/);
  assert.match(script, /getElementById\('bhDetailModal'\)/);
  assert.doesNotMatch(script, /getElementById\('detailModal'\)/);
});

test("appointments router has one registered list and detail route", () => {
  const routes = read("routes/appointmentRoutes.js");
  assert.equal((routes.match(/router\.get\("\/", auth\.authenticate/g) || []).length, 1);
  assert.equal((routes.match(/router\.get\("\/:id", auth\.authenticate/g) || []).length, 1);
  assert.match(routes, /ratingController\.rateBooking/);
});

test("project rescheduling accepts a date-only customer preference", () => {
  const routes = read("routes/appointmentRoutes.js");
  const script = read("public/js/book-history.js");
  assert.match(routes, /!isProjectRequest && !finalTime/);
  assert.match(routes, /PENDING_PROJECT_SCHEDULING/);
  assert.match(script, /!isProject && !selectedRescheduleTime/);
  assert.match(script, /!isProject && !selectedRescheduleTime\)/);
});

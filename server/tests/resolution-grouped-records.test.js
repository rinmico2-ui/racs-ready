"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { groupResolutionCases, filterResolutionCases, summarizeResolutionCases } = require("../utils/resolutionCenter");
const base = { id: "booking-1", sourceType: "booking", reference: "BOOK-1", severity: "high", isPastDate: true };

test("grouping retains every open issue and the highest priority without duplicating an issue", () => {
  const rows = [
    { ...base, issueType: "no_technician", reason: "No technician", canReassign: false },
    { ...base, issueType: "past_date", reason: "Date passed", requiresReschedule: true },
    { ...base, issueType: "schedule_conflict", reason: "Overlapping visits", severity: "critical" },
    { ...base, issueType: "past_date", reason: "Date passed", requiresReschedule: true },
  ];
  const [record] = groupResolutionCases(rows);
  assert.equal(record.issueType, "past_date");
  assert.equal(record.severity, "critical");
  assert.equal(record.issues.length, 3);
  assert.deepEqual(summarizeResolutionCases(rows), { total: 1, pastDue: 1,
    byIssue: { past_date: 1, schedule_conflict: 1, no_technician: 1 }, bySource: { booking: 1, order: 0 }, bySeverity: { critical: 1 } });
  assert.deepEqual(groupResolutionCases([record]), [record], "already grouped records stay stable");
  assert.equal(rows.length, 4, "raw records are not modified or deleted");
});

test("records with different IDs or sources are never merged just because references match", () => {
  const rows = [
    { ...base, issueType: "past_date" },
    { ...base, id: "booking-2", issueType: "past_date" },
    { ...base, sourceType: "order", issueType: "assignment_overdue" },
  ];
  assert.equal(groupResolutionCases(rows).length, 3);
});

test("filtering and searching keep a secondary issue available with its own actions", () => {
  const records = groupResolutionCases([
    { ...base, issueType: "past_date", reason: "Date passed", canReassign: false },
    { ...base, issueType: "technician_issue", reason: "Technician declined due to transport", canReassign: true },
  ]);
  const [filtered] = filterResolutionCases(records, { issue: "technician_issue", q: "transport" });
  assert.equal(filtered.issueType, "technician_issue");
  assert.equal(filtered.canReassign, true);
  assert.equal(filtered.issues.length, 2);
  assert.equal(records[0].issueType, "past_date");
});

test("no-show review stays the primary workflow when another issue is present", () => {
  const [record] = groupResolutionCases([
    { ...base, issueType: "incomplete", severity: "critical" },
    { ...base, issueType: "no_show", severity: "high", noShowReport: { arrivalProofUrl: "/proof.jpg" }, allowedActions: ["view", "reschedule"] },
  ]);
  assert.equal(record.issueType, "no_show");
  assert.equal(record.noShowReport.arrivalProofUrl, "/proof.jpg");
  assert.equal(record.severity, "critical");
});

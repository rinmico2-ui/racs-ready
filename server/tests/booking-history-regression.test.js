"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = relativePath => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("booking history locks seven data columns to seven matching headings", () => {
  const view = read("views/pages/book-history.ejs");
  const script = read("public/js/book-history.js");

  assert.equal((view.match(/<col class="bh-col-/g) || []).length, 7);
  for (const label of ["Booking", "Service", "Date / Time", "Status", "Location", "Rating", "Actions"]) {
    assert.match(script, new RegExp(`data-label="${label.replace("/", "\\/")}"`));
  }
  assert.match(view, /table-layout:\s*fixed/);
});

test("booking-history rows expose only View Details and keep operations in the modal", () => {
  const view = read("views/pages/book-history.ejs");
  const script = read("public/js/book-history.js");
  const actionCell = script.match(/<td data-label="Actions"[\s\S]*?<\/td>/)?.[0] || "";

  assert.match(actionCell, /bh-view-details-btn/);
  assert.match(actionCell, /View Details/);
  assert.equal((actionCell.match(/<button/g) || []).length, 1);
  for (const removedRowAction of ["bh-download", "bh-reschedule", "bh-cancel", "bh-schedule-later", "bh-edit-services"]) {
    assert.doesNotMatch(actionCell, new RegExp(removedRowAction));
  }
  assert.match(script, /class="bh-modal-action-grid"/);
  for (const modalAction of ["edit-services", "reschedule", "cancel", "schedule-repair"]) {
    assert.match(script, new RegExp(`actionButton\\(\\s*'${modalAction}'`));
    assert.match(script, new RegExp(`action === '${modalAction}'`));
  }
  assert.match(script, /Book Again/);
  assert.match(script, /View Maintenance/);
  assert.match(view, /id="bh-download-pdf"/);
  assert.match(view, /\/js\/book-history\.js\?v=/);
});

test("booking-history keeps status, location, filters, and schedule actions readable", () => {
  const view = read("views/pages/book-history.ejs");
  const script = read("public/js/book-history.js");
  const statusSelect = view.match(/<select id="bh-status"[\s\S]*?<\/select>/)?.[0] || "";

  assert.equal((statusSelect.match(/<option/g) || []).length, 7);
  assert.doesNotMatch(statusSelect, /<optgroup/);
  for (const stage of ["All bookings", "Pending confirmation", "Scheduled", "In progress", "Needs attention", "Completed", "Cancelled"]) {
    assert.match(statusSelect, new RegExp(`>${stage}<`));
  }
  assert.match(script, /data-label="Status" class="bh-status-cell"/);
  assert.match(view, /\.bh-status-cell \{ overflow: hidden; \}/);
  assert.match(view, /\.bh-col-status \{ width: 17%; \}/);
  assert.match(view, /\.bh-col-location \{ width: 19%; \}/);
  assert.match(script, /class="bh-reschedule-actions"/);
  assert.match(script, /bh-reschedule-cancel/);
  assert.match(view, /\.bh-reschedule-actions[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test("booking-history sorting is server-side, stable, and allowlisted", () => {
  const view = read("views/pages/book-history.ejs");
  const script = read("public/js/book-history.js");
  const routes = read("routes/appointmentRoutes.js");
  const sortSelect = view.match(/<select id="bh-sort"[\s\S]*?<\/select>/)?.[0] || "";

  for (const sort of ["created_desc", "created_asc", "date_asc", "date_desc"]) {
    assert.match(sortSelect, new RegExp(`value="${sort}"`));
  }
  assert.match(script, /sort: document\.getElementById\("bh-sort"\)/);
  assert.match(script, /params\.set\("sort", sort\)/);
  assert.match(script, /el\.sort\.addEventListener\("change", applyFilters\)/);
  assert.match(routes, /const bookingSorts = \{/);
  assert.match(routes, /\.sort\(selectedSort\)/);
  assert.match(routes, /\|\| bookingSorts\.created_desc/);
});

test("edit booking shares the service page builders while keeping its quantity controls scoped", () => {
  const script = read("public/js/book-history.js");
  const shared = read("public/js/core-appliance-booking.js");
  assert.match(script, /window\.CoreApplianceBooking\.create\(\)/);
  assert.match(script, /window\.RepairApplianceBooking\.create\(\)/);
  assert.match(script, /class="bh-item-qty-input"[^>]*inputmode="numeric"/);
  assert.doesNotMatch(script, /class="bh-item-qty-input"[^>]*readonly/);
  assert.match(script, /input\.addEventListener\('input', \(\) => commitTypedQuantity\(false\)\)/);
  assert.match(shared, /\['Appliance', 'Details', 'Services'\]/);
  assert.match(shared, /node\.id = host\.id \+ '-' \+ original/);
});

test("edit booking uses current catalog prices and leaves unidentified additions for staff review", () => {
  const script = read("public/js/book-history.js");
  const routes = read("routes/bookingRoutesNew.js");
  assert.match(script, /existingBookingId: bookingId/);
  assert.match(script, /Finish adding the appliance or cancel its changes/);
  assert.match(script, /defaultInspectionFee: defaultRepairInspectionFee/);
  assert.match(routes, /categoryRepairContexts[\s\S]*?resolveRepairInspectionFees/);
  assert.match(routes, /serviceId: null,[\s\S]*?phase: prior\?\.phase \|\| "repair_phase_1"/);
  assert.match(script, /proposedServices|service-change-requests/);
  assert.doesNotMatch(script, /id="bhCustomUnitType"/);
});

test("edit booking uses one guarded loader and cleans orphaned modal backdrops", () => {
  const view = read("views/pages/book-history.ejs");
  const script = read("public/js/book-history.js");

  assert.match(script, /let bookingEditorOpening = false/);
  assert.match(script, /function requestBookingEditor\(bookingId, focusTab, trigger\)[\s\S]*?if \(bookingEditorOpening\) return;[\s\S]*?setBookingEditorLoading\(true/);
  assert.match(script, /action === 'edit-services'[\s\S]*?requestBookingEditor\(b\._id, 'services', button\)/);
  assert.match(script, /function removeOrphanedModalArtifacts\(\)[\s\S]*?if \(document\.querySelector\('\.modal\.show'\)\) return;[\s\S]*?\.modal-backdrop/);
  assert.match(script, /BOOKING_EDITOR_CATALOG_TTL_MS = 5 \* 60 \* 1000/);
  assert.match(script, /Booking editor catalog prefetch failed/);
  assert.match(view, /\.bh-editor-loader\[hidden\]/);
  assert.match(view, /@keyframes bhEditorSpin/);
});

test("reschedule dialogs use accessible Bootstrap structure and bounded reasons", () => {
  const view = read("views/pages/book-history.ejs");
  const script = read("public/js/book-history.js");
  const calendar = read("public/js/enterprise-calendar.js");
  const bookingModel = read("models/BookingService.js");
  const appointments = read("routes/appointmentRoutes.js");
  const bookings = read("routes/bookingRoutesNew.js");

  assert.match(view, /class="modal-content bh-modal-content"/);
  assert.match(view, /id="bhRescheduleReason"[^>]+maxlength="500"/);
  assert.match(view, /id="bhReschedulePickerRoot"/);
  assert.match(view, /id="bhRescheduleNextSummary"/);
  assert.doesNotMatch(view, /Live company availability/);
  assert.match(script, /root: pickerRoot/);
  assert.match(script, /syncGlobalState: false/);
  assert.match(script, /EnterpriseCalendar\.formatDateKey/);
  assert.match(calendar, /function getElement\(id\)/);
  assert.match(calendar, /_syncGlobalState = opts\.syncGlobalState !== false/);
  assert.match(script, /EnterpriseCalendar\.validateSelectedSlot\(\)/);
  assert.match(bookingModel, /requestedEndDate: \{ type: String \}/);
  assert.match(appointments, /Reschedule reason must be 500 characters or fewer/);
  assert.match(appointments, /normalizeLifecycleReason/);
  const { normalizeLifecycleReason } = require("../utils/dataLifecycle");
  assert.throws(() => normalizeLifecycleReason("", "Cancellation"), error => error.status === 400);
  assert.match(bookings, /Reason for change must be 1000 characters or fewer/);
});

test("booking history starts promptly and keeps list queries lightweight", () => {
  const view = read("views/pages/book-history.ejs");
  const script = read("public/js/book-history.js");
  const appointments = read("routes/appointmentRoutes.js");
  const bookingModel = read("models/BookingService.js");

  assert.match(view, /id="bh-flatpickr-script" async/);
  assert.match(view, /rel="preload" as="style"[^>]+flatpickr/);
  assert.match(script, /initializeBookingHistory\(\);/);
  assert.match(script, /new AbortController\(\)/);
  assert.match(script, /signal: bookingListRequest\.signal/);
  assert.match(appointments, /CUSTOMER_HISTORY_EXCLUDED_FIELDS/);
  assert.match(appointments, /"-paymentProof"/);
  assert.match(appointments, /bookingListQuery\.select\(CUSTOMER_HISTORY_EXCLUDED_FIELDS\)/);
  assert.match(bookingModel, /customerId: 1, bookingDate: -1, createdAt: -1/);
  assert.match(bookingModel, /customerId: 1, status: 1, bookingDate: -1, createdAt: -1/);
});


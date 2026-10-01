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
  assert.match(view, /id="bh-download-json"/);
  assert.match(view, /project-date-guide-v12/);
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

test("edit booking quantity controls are item-scoped and have no duplicate HP ids", () => {
  const view = read("views/pages/book-history.ejs");
  const script = read("public/js/book-history.js");

  assert.match(script, /data-hp-qty-minus/);
  assert.match(script, /data-hp-qty-plus/);
  assert.match(script, /bh-item-qty-minus/);
  assert.match(script, /bh-item-qty-plus/);
  assert.doesNotMatch(script, /id="bhHpQty(?:Minus|Plus|Input)"/);
  assert.match(script, /Math\.max\(1, Math\.min\(40,/);
  assert.match(script, /const maxQuantityFor = index => maxBookingUnits - selectedUnits\(\)/);
  assert.match(script, /otherInput\.max = String\(maxQuantityFor\(otherIndex\)\)/);
  assert.match(script, /const maxHpQuantityFor = index => remainingUnits\(\) - selectedHpUnits\(\)/);
  assert.match(script, /type="checkbox" aria-label="Select/);
  assert.doesNotMatch(script, /type="radio" name="bhHpOption"/);
  assert.match(script, /class="bh-editor-workspace"/);
  assert.match(script, /class="bh-editor-cart"/);
  assert.match(script, /id="bhEditorCartTotalValue"/);
  assert.match(script, /data-bh-cfg-step="1"/);
  assert.match(script, /id="bhCfgBrandSection"/);
  assert.match(script, /id="bhCfgTypeSection"/);
  assert.match(script, /id="bhHpOptionsSection"/);
  assert.match(script, /function showBrandStep\(\)/);
  assert.match(script, /function showTypeStep\(\)/);
  assert.match(script, /function showHpStep\(\)/);
  assert.match(view, /#bhBookingEditorModal \.bh-service-catalog-card/);
  assert.match(view, /#bhHpModal \.bh-cfg-wizard/);
});

test("edit-booking quantities support typing as well as plus and minus", () => {
  const view = read("views/pages/book-history.ejs");
  const script = read("public/js/book-history.js");

  assert.match(script, /class="bh-item-qty-input"[^>]*inputmode="numeric"/);
  assert.doesNotMatch(script, /class="bh-item-qty-input"[^>]*readonly/);
  assert.doesNotMatch(script, /id="bhSimpleQty"[^>]*readonly/);
  assert.doesNotMatch(script, /data-hp-qty-input="\$\{i\}"[^>]*readonly/);
  assert.match(script, /input\.addEventListener\('input', \(\) => commitTypedQuantity\(false\)\)/);
  assert.match(script, /quantityInput\.addEventListener\('input', \(\) => syncQuantity\(false\)\)/);
  assert.match(script, /input\.addEventListener\('input', \(\) => syncTypedHpQuantity\(false\)\)/);
  assert.match(script, /Math\.trunc\(Number\(raw\)\)/);
  assert.match(view, /\.bh-editor-stepper input:focus/);
});

test("edit-booking repair fields guide focus to the next completed step", () => {
  const view = read("views/pages/book-history.ejs");
  const script = read("public/js/book-history.js");

  assert.match(script, /function advanceRepairEditor\(step, targetSelector\)/);
  assert.match(script, /renderUnitChips\(\)[\s\S]*?advanceRepairEditor\(3, "#bhRepairBrand"\)/);
  assert.match(script, /repairBrandInput\.addEventListener\("keydown"[\s\S]*?"#bhRepairModel"/);
  assert.match(script, /repairModelInput\.addEventListener\("keydown"[\s\S]*?"#bhRepairQty"/);
  assert.match(script, /repairQuantityInput\.addEventListener\("keydown"[\s\S]*?bhRepairDetailsNext/);
  assert.match(script, /bhRepairDetailsNext'\)\.onclick[\s\S]*?advanceRepairEditor\(4, '#bhSymptomChips \.bh-symptom'\)/);
  assert.match(script, /renderSymptomChips\(\)[\s\S]*?advanceRepairEditor\(4, "#bhRepairProblem"\)/);
  assert.doesNotMatch(script, /id="bhRepairSelect"/);
  assert.match(script, /function selectedRepairPricing\(\)/);
  assert.match(script, /serviceId: null, name: `\$\{unitLabel\} Repair`/);
  assert.match(view, /bh-repair-step-current/);
  assert.match(view, /project-date-guide-v12/);
});

test("edit booking mirrors the booking-page service picker", () => {
  const view = read("views/pages/book-history.ejs");
  const script = read("public/js/book-history.js");
  const routes = read("routes/bookingRoutesNew.js");
  const serviceRoutes = read("routes/serviceRoutes.js");
  const bookingModel = read("models/BookingService.js");

  assert.match(script, /CORE_SERVICES_PER_PAGE = 4/);
  assert.match(script, /id="bhCorePager"/);
  assert.match(script, /id="bhUnitPager"/);
  assert.match(script, /selectedCategory\.unitTypes\.slice\(repairUnitPage \* 4, \(repairUnitPage \+ 1\) \* 4\)/);
  assert.match(script, /class="bh-repair-progress"/);
  assert.match(script, /data-bh-repair-nav="1"/);
  assert.match(script, /Which appliance needs repair\?/);
  assert.match(script, /id="bhCustomUnitType"/);
  assert.match(script, /customUnitNext\.onclick = \(\) =>/);
  assert.match(script, /advanceRepairEditor\(2, selectedCategory\?\.isCustom && !selectedCategory\.unitTypes\?\.length \? "#bhCustomUnitType"/);
  assert.match(view, /\.bh-editor-service-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
  assert.match(view, /\.bh-repair-category\.is-selected/);
  assert.match(view, /\.bh-custom-unit-row/);
  assert.match(serviceRoutes, /return res\.json\(\{ categories, defaultInspectionFee \}\)/);
  assert.match(routes, /categoryRepairContexts[\s\S]*?resolveRepairInspectionFees/);
  assert.match(routes, /serviceId: null,[\s\S]*?phase: "repair_phase_1"/);
  assert.match(bookingModel, /unitType: \{ type: String, trim: true, maxlength: 80 \}/);
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
  assert.match(appointments, /A cancellation reason is required/);
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


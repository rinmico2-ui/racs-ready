"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const templatePath = path.join(__dirname, "..", "views", "pages", "admin", "Reports", "ServiceReport.ejs");
const template = fs.readFileSync(templatePath, "utf8");
const pageRoutes = fs.readFileSync(
  path.join(__dirname, "..", "routes", "pages.js"),
  "utf8",
);
const serviceRoute = pageRoutes.slice(
  pageRoutes.indexOf('"/admin/reports/service"'),
  pageRoutes.indexOf('"/admin/reports/inventory"'),
);

test("service report renders with an empty analytics result and valid browser JavaScript", () => {
  const html = ejs.render(template, { analytics: null, reportError: null });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});

test("service report opens a lightweight shell and hydrates expensive analytics", () => {
  const html = ejs.render(template, { analytics: null, reportError: null, deferredAnalytics: true });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
  assert.match(html, /id="serviceReportDataState"/);
  assert.match(html, /class="sr-shell is-loading"/);
  assert.match(html, /fetch\(endpoint/);
  assert.match(serviceRoute, /"\/admin\/reports\/service\/data"/);
  assert.match(serviceRoute, /analytics:\s*null,[\s\S]*?deferredAnalytics:\s*true/);
  assert.match(serviceRoute, /layout:\s*false/);
  assert.match(serviceRoute, /\.select\("-statusHistory/);
  assert.match(serviceRoute, /Technician\.find\(\{\}\)\.select\("name userEmail specialization active"\)/);
});

test("service report presents a focused four-KPI executive summary", () => {
  assert.equal((template.match(/<article class="sr-kpi(?:\s|\")/g) || []).length, 4);
  for (const label of [
    "Completed services",
    "Completion rate",
    "Completed-service value",
    "Service contribution",
  ]) {
    assert.match(template, new RegExp(label));
  }
  assert.match(template, /Provisional/);
  assert.doesNotMatch(template, /Enterprise Service Controls/);
});

test("service report uses progressive disclosure instead of an analytics wall", () => {
  assert.equal((template.match(/<canvas id=/g) || []).length, 3);
  for (const tab of ["Overview", "Performance", "Cost &amp; contribution", "Quality", "Records"]) {
    assert.match(template, new RegExp(">" + tab + "<"));
  }
  assert.match(template, /Report photos/);
  assert.match(template, /<details class="sr-more-filters"/);
  assert.match(template, /Needs attention/);
  assert.match(template, /Top services/);
});

test("service report keeps booked and completed value definitions distinct", () => {
  assert.match(template, /this is not completed revenue/);
  assert.match(template, /Value from services whose lifecycle is recognized as completed/);
  assert.match(template, /Service contribution/);
  assert.match(template, /Missing records can overstate contribution/);
  assert.match(template, /\^\[=\+\\-@\\t\\r\]/);
});

test("advanced service filters are visible, retained, and applied server-side", () => {
  const filters = [
    "status",
    "service",
    "technician",
    "assignment",
    "priority",
    "appliance",
    "brand",
    "area",
    "scale",
    "payment",
    "valueBand",
    "sla",
    "warranty",
    "search",
  ];
  for (const filter of filters) {
    assert.match(template, new RegExp(`name="${filter}"`), `${filter} must be available in the filter drawer`);
    assert.match(pageRoutes, new RegExp(`req\\.query\\.${filter}`), `${filter} must be accepted by the report route`);
    assert.match(pageRoutes, new RegExp(`filterContext\\.${filter}`), `${filter} must affect the report cohort`);
  }
  assert.match(template, /activeAdvancedFilters/);
  assert.match(template, /<details class="sr-more-filters" open>/);
  assert.match(template, /14 available/);
  for (const group of ["Workflow", "Service &amp; location", "Commercial"]) {
    assert.match(template, new RegExp(group));
  }
  assert.match(serviceRoute, /bookings = bookings\.filter/);
});

test("filtered reports avoid obsolete and duplicate database reads", () => {
  assert.match(serviceRoute, /const \[bookingRows, technicians\] = await Promise\.all/);
  assert.match(serviceRoute, /includeSourceRows: true/);
  assert.match(serviceRoute, /serviceCostAnalytics\.sourceRows\?\.reports/);
  assert.doesNotMatch(serviceRoute, /require\("\.\.\/models\/Order"\)/);
  assert.doesNotMatch(serviceRoute, /require\("\.\.\/models\/TechnicianAttendance"\)/);
  assert.doesNotMatch(serviceRoute, /BookingService\.aggregate/);
  assert.match(template, /Updating…/);
  assert.match(template, /aria-busy/);
});

test("service analytics shows filtered report photos with accessible full-size previews", () => {
  const html = ejs.render(template, {
    reportError: null,
    analytics: {
      photoEvidenceReports: [{
        reference: "BOOK-1042",
        customer: "Sample Customer",
        service: "Aircon Cleaning",
        technician: "Sample Technician",
        reportStatus: "approved",
        date: "2026-09-15T08:00:00.000Z",
        findings: "Dirty evaporator coil",
        actionsTaken: "Cleaned and tested the unit",
        photos: [
          { url: "/uploads/service-reports/before.webp", label: "Service report" },
          { url: "/uploads/proof-of-completion/after.webp", label: "Completion proof" },
        ],
      }],
    },
  });

  assert.match(html, /id="photos-tab"/);
  assert.match(html, /id="photos-pane"/);
  assert.match(html, /Service report photos/);
  assert.match(html, /src="\/uploads\/service-reports\/before\.webp"/);
  assert.match(html, /data-evidence-photo/);
  assert.match(html, /id="serviceEvidenceModal"/);
  assert.match(html, /loading="lazy"/);
  assert.match(serviceRoute, /"\/admin\/reports\/service\/photos"/);
  assert.match(serviceRoute, /bookingReports\.forEach\(report => addPhotoCandidates\(candidates, report\.photos/);
  assert.match(serviceRoute, /addPhotoCandidates\(candidates, booking\.proofPhoto, "Completion proof"\)/);
  assert.match(serviceRoute, /\.select\("bookingId technicianId customerName serviceName status findings actionsTaken submittedAt updatedAt createdAt photos"\)/);
  assert.match(template, /function loadPhotoEvidence\(\)/);
  assert.match(template, /data-booking-ids/);
});

test("service overview excludes image payloads and caches the rendered fragment", () => {
  assert.match(serviceRoute, /-proofPhoto -afterPhotos -inspection\.photos -unitInfo\.photos/);
  assert.match(serviceRoute, /readServiceReportFragment\(req\.query\)/);
  assert.match(serviceRoute, /writeServiceReportFragment\(cachedFragment\.key, html\)/);
  assert.match(serviceRoute, /photoEvidenceDeferred: photoEvidenceBookingIds\.length > 0/);
});

test("deferred photo evidence renders a valid on-demand state", () => {
  const html = ejs.render(template, {
    analytics: {
      photoEvidenceDeferred: true,
      photoEvidenceBookingIds: ["507f1f77bcf86cd799439011"],
    },
    reportError: null,
    deferredAnalytics: false,
  }, { filename: templatePath });

  assert.match(html, /id="servicePhotoEvidenceContent"/);
  assert.match(html, /Photos load only when needed/);
  assert.match(html, /507f1f77bcf86cd799439011/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});

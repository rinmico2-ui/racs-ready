"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const servicesScript = fs.readFileSync(
  path.join(__dirname, "../public/js/services-multi.js"),
  "utf8",
);
const servicesView = fs.readFileSync(
  path.join(__dirname, "../views/pages/services.ejs"),
  "utf8",
);
const mobileStyles = fs.readFileSync(
  path.join(__dirname, "../public/css/services-mobile-ux.css"),
  "utf8",
);

test("core services use a calm single-column phone grid", () => {
  assert.match(
    servicesScript,
    /type === 'core'[\s\S]*?'col-12 col-md-4 core-service-column'/,
  );
  assert.match(mobileStyles, /#coreServiceCards > \.core-service-column[\s\S]*?flex:\s*0 0 100%/);
});

test("mobile core-service cards remain readable and touch friendly", () => {
  assert.match(mobileStyles, /#coreServiceCards \.service-card-media[\s\S]*?aspect-ratio:\s*16 \/ 9/);
  assert.match(mobileStyles, /#coreServiceCards \.card-title[\s\S]*?font-size:\s*1rem/);
  assert.match(mobileStyles, /#coreServiceCards \.add-service-btn[\s\S]*?min-height:\s*48px/);
  assert.match(mobileStyles, /\.ent-booking-container\s*\{[^}]*padding-inline:\s*1rem/);
});

test("mobile booking progress fits without a horizontal scroller", () => {
  assert.match(mobileStyles, /\.ent-hero, \.ent-hero \*, \.ent-page-body, \.ent-page-body \*\s*\{[^}]*box-sizing:\s*border-box/);
  assert.match(mobileStyles, /\.ent-booking-container, \.booking-layout, \.booking-body, \.ent-stepper, \.ent-step-card\s*\{[^}]*max-width:\s*100%/);
  assert.match(mobileStyles, /\.ent-tr\s*\{[^}]*grid-template-columns:\s*repeat\(6/);
  assert.match(mobileStyles, /\.ent-n\s*\{[^}]*min-height:\s*44px/);
  assert.match(mobileStyles, /\.ent-step-body \.form-control[\s\S]*?min-height:\s*48px/);
  assert.match(servicesView, /services-mobile-ux\.css\?v=20260911-service-added-check/);
});

test("mobile service configuration keeps type and HP choices compact", () => {
  assert.match(servicesScript, /typesContainer\.className = 'row g-2 g-md-3 mb-4 cfg-type-grid'/);
  assert.match(servicesScript, /g-0 g-md-3 cfg-hp-card-layout/);
  assert.match(mobileStyles, /\.cfg-type-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
  assert.match(mobileStyles, /\.aircon-type-card\s*\{[^}]*min-height:\s*88px/);
  assert.match(mobileStyles, /\.cfg-hp-card-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 124px/);
  assert.match(mobileStyles, /\.cfg-hp-card-controls \.quantity-increase\s*\{[^}]*min-width:\s*44px/);
  assert.match(mobileStyles, /\.cfg-footer\s*\{[^}]*display:\s*grid !important/);
});

test("mobile configuration progress is a slim three-step strip", () => {
  assert.match(mobileStyles, /\.cfg-wizard\s*\{[^}]*grid-template-columns:\s*repeat\(3/);
  assert.match(mobileStyles, /\.cfg-dot\s*\{[^}]*width:\s*22px;[^}]*height:\s*22px/);
  assert.match(mobileStyles, /\.cfg-step-s\s*\{[^}]*font-size:\s*\.65rem/);
  assert.match(mobileStyles, /\.cfg-line\s*\{[^}]*display:\s*none/);
});

test("configuration modal keeps one shell size across all three steps", () => {
  assert.match(mobileStyles, /#quantitySelectionModal \.modal-dialog\s*\{[^}]*width:\s*min\(700px, calc\(100vw - 1rem\)\) !important;[^}]*height:\s*min\(680px, calc\(100dvh - 1rem\)\) !important/);
  assert.match(mobileStyles, /#quantitySelectionModal \.modal-content\s*\{[^}]*width:\s*100% !important;[^}]*height:\s*100% !important/);
  assert.match(mobileStyles, /#quantitySelectionModal \.modal-body\s*\{[^}]*flex:\s*1 1 auto;[^}]*max-height:\s*none !important/);
  assert.match(mobileStyles, /#quantitySelectionModal \.modal-body\s*\{[^}]*scrollbar-gutter:\s*stable/);
  assert.match(mobileStyles, /#quantitySelectionModal \.cfg-header,[\s\S]*?#quantitySelectionModal \.cfg-footer\s*\{\s*flex:\s*0 0 auto/);
  assert.match(servicesScript, /width: min\(700px, calc\(100vw - 1rem\)\) !important;[\s\S]*?height: min\(680px, calc\(100dvh - 1rem\)\) !important;/);
  assert.match(servicesScript, /function showEnterpriseModal\(modalElement\)[\s\S]*?width: min\(700px, calc\(100vw - 1rem\)\) !important;[\s\S]*?height: min\(680px, calc\(100dvh - 1rem\)\) !important;/);
});

test("service-added confirmation stays compact and touch friendly", () => {
  assert.match(mobileStyles, /\.swal2-popup\.service-booking-alert\.service-added-alert[^}]*\{[^}]*width:\s*min\(25rem, calc\(100vw - 1\.25rem\)\) !important/);
  assert.match(mobileStyles, /\.swal2-popup\.service-added-alert[^}]*\.swal2-icon\s*\{[^}]*width:\s*3rem !important/);
  assert.match(mobileStyles, /\.swal2-popup\.service-added-alert \.service-added-check\s*\{[^}]*font-weight:\s*800/);
  assert.match(mobileStyles, /\.swal2-popup\.service-added-alert[^}]*\.swal2-confirm\s*\{[^}]*min-height:\s*44px !important/);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const CoreService = require("../models/CoreService");
const { normalizeCoreServicePayload } = require("../utils/serviceCatalogPayload");

test("multipart core-service edits restore structured fields and booleans", async () => {
  const payload = normalizeCoreServicePayload({
    name: "Premium Cleaning",
    slug: "premium-cleaning",
    category: "Cleaning",
    features: '["Coil cleaning","Drain flushing"]',
    includedItems: '["Labor","Cleaning solution"]',
    exclusions: '["Replacement parts"]',
    isAirconService: "true",
    active: "false",
    airconTypes: '[{"type":"split","name":"Split Type","hpPricing":[{"hp":1.5,"price":1800,"durationMinutes":90}]},{"type":"floor_standing","name":"Floor Standing","description":"Floor-standing aircon unit","hpPricing":[{"hp":3,"price":8000,"durationMinutes":300}]}]',
    warrantyPolicy: '{"enabled":true,"coverageType":"workmanship","workmanshipDays":180}',
  });

  assert.deepEqual(payload.features, ["Coil cleaning", "Drain flushing"]);
  assert.equal(payload.isAirconService, true);
  assert.equal(payload.active, false);
  assert.equal(payload.airconTypes[0].hpPricing[0].price, 1800);
  assert.equal(payload.airconTypes[1].type, "floor_standing");
  assert.equal(payload.airconTypes[1].hpPricing[0].durationMinutes, 300);
  assert.equal(payload.warrantyPolicy.workmanshipDays, 180);

  const service = new CoreService(payload);
  await service.validate();
  assert.equal(service.features.length, 2);
  assert.equal(service.airconTypes[0].hpPricing[0].durationMinutes, 90);
  assert.equal(service.airconTypes[1].type, "floor_standing");
});

test("malformed structured edit fields return a client error", () => {
  assert.throws(
    () => normalizeCoreServicePayload({ airconTypes: "not-json" }),
    error => error.status === 400 && error.code === "INVALID_SERVICE_PAYLOAD",
  );
  assert.throws(
    () => normalizeCoreServicePayload({ active: "sometimes" }),
    error => error.status === 400 && error.code === "INVALID_SERVICE_PAYLOAD",
  );
});

test("core-service editor prevents duplicate saves and reports API errors", () => {
  const template = fs.readFileSync(
    path.join(__dirname, "../views/pages/admin/Services/CoreServices.ejs"),
    "utf8",
  );
  assert.match(template, /if \(form\.dataset\.saving === 'true'\) return/);
  assert.match(template, /credentials: 'same-origin'/);
  assert.match(template, /if \(!r\.ok\) throw new Error\(response\.error/);
  assert.match(template, /Modal\.getOrCreateInstance\(document\.getElementById\('saveSuccessModal'\)\)/);
  assert.match(template, /option value="floor_standing"/);

  const controller = fs.readFileSync(
    path.join(__dirname, "../controllers/adminController.js"),
    "utf8",
  );
  assert.ok((controller.match(/normalizeCoreServicePayload\(req\.body\)/g) || []).length >= 2);
  assert.match(controller, /updates\.updatedAt = new Date\(\);[\s\S]*?CoreService\.findByIdAndUpdate/);
});

test("core-service editor keeps the save footer visible while its body scrolls", () => {
  const template = fs.readFileSync(
    path.join(__dirname, "../views/pages/admin/Services/CoreServices.ejs"),
    "utf8",
  );

  assert.match(template, /#coreServiceModal \.modal-dialog \{[\s\S]*?height: calc\(100dvh - 2rem\)/);
  assert.match(template, /#coreServiceModal \.modal-content \{[\s\S]*?flex-direction: column;[\s\S]*?height: 100%/);
  assert.match(template, /#coreServiceModal \.modal-body \{[\s\S]*?min-height: 0;[\s\S]*?overflow-y: auto/);
  assert.match(template, /#coreServiceModal \.modal-footer \{[\s\S]*?flex: 0 0 auto/);
  assert.match(template, /class="modal-footer core-modal-footer bg-light border-top-0"/);
  assert.match(template, /<div class="col-12 col-md-6">\s*<div class="card border-0 shadow-sm">[\s\S]*?bi-cash-coin text-success/);
  assert.match(template, /id="coreServiceSaveBtn"/);
});

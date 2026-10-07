"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const mongoose = require("mongoose");
const ejs = require("ejs");
const CoreService = require("../models/CoreService");
const ServiceCategory = require("../models/ServiceCategory");
const admin = require("../controllers/adminController");
const serviceCategories = require("../controllers/serviceCategoryController");
const audit = require("../utils/audit");

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("archiving and restoring a core service retains its record and lifecycle history", async () => {
  const service = new CoreService({ name: "Aircon Cleaning", slug: "aircon-cleaning-test", category: "Cleaning", active: true });
  const actor = new mongoose.Types.ObjectId();
  const originalFind = CoreService.findById;
  const originalAudit = audit.logEvent;
  let saves = 0;
  const actions = [];
  CoreService.findById = async () => service;
  service.save = async () => { saves += 1; return service; };
  audit.logEvent = async event => { actions.push(event.action); };
  try {
    const req = { params: { id: String(service._id) }, body: { reason: "No longer offered for new bookings" }, user: { _id: actor } };
    const archived = response();
    await admin.archiveCoreService(req, archived, error => { throw error; });
    assert.equal(archived.statusCode, 200);
    assert.equal(service.active, false);
    assert.ok(service.archivedAt instanceof Date);
    assert.equal(service.archiveReason, req.body.reason);
    assert.equal(service.lifecycleHistory[0].action, "archived");

    const restored = response();
    await admin.restoreCoreService({ ...req, body: { reason: "Restored to the core service catalogue" } }, restored, error => { throw error; });
    assert.equal(restored.statusCode, 200);
    assert.equal(service.active, true);
    assert.equal(service.archivedAt, null);
    assert.equal(service.lifecycleHistory[1].action, "restored");
    assert.equal(saves, 2);
    assert.deepEqual(actions, ["coreService.archive", "coreService.restore"]);
  } finally {
    CoreService.findById = originalFind;
    audit.logEvent = originalAudit;
  }
});

test("archive requires a meaningful reason and cannot restore an active service", async () => {
  const service = new CoreService({ name: "Aircon Cleaning", slug: "aircon-cleaning-test-2", category: "Cleaning", active: true });
  const originalFind = CoreService.findById;
  CoreService.findById = async () => service;
  try {
    const req = { params: { id: String(service._id) }, body: { reason: "short" }, user: { _id: new mongoose.Types.ObjectId() } };
    const archiveResult = response();
    await admin.archiveCoreService(req, archiveResult, error => { throw error; });
    assert.equal(archiveResult.statusCode, 400);
    assert.equal(service.active, true);

    const restoreResult = response();
    await admin.restoreCoreService(req, restoreResult, error => { throw error; });
    assert.equal(restoreResult.statusCode, 409);
  } finally {
    CoreService.findById = originalFind;
  }
});

test("repair categories archive and restore without deleting their unit types", async () => {
  const category = new ServiceCategory({
    name: "Aircon Repair Test", slug: "aircon-repair-test", active: true,
    unitTypes: [{ value: "split", label: "Split Type" }],
  });
  const originalFind = ServiceCategory.findById;
  ServiceCategory.findById = async () => category;
  category.save = async () => category;
  const req = { params: { id: String(category._id) }, user: { _id: new mongoose.Types.ObjectId() } };
  try {
    const archived = response();
    await serviceCategories.deactivate({ ...req, body: { reason: "No longer accepting this repair type" } }, archived);
    assert.equal(archived.statusCode, 200);
    assert.equal(category.active, false);
    assert.ok(category.archivedAt);
    assert.equal(category.unitTypes[0].value, "split");

    const restored = response();
    await serviceCategories.restore({ ...req, body: { reason: "Service available for repairs again" } }, restored);
    assert.equal(restored.statusCode, 200);
    assert.equal(category.active, true);
    assert.equal(category.archivedAt, null);
    assert.equal(category.lifecycleHistory.length, 2);
  } finally {
    ServiceCategory.findById = originalFind;
  }
});

test("service pages expose archived filters and valid interaction scripts", async () => {
  const root = path.join(__dirname, "../views/pages/admin/Services");
  const service = { _id: new mongoose.Types.ObjectId(), name: "Old service", slug: "old-service", category: "Cleaning", active: false, archivedAt: new Date(), features: [], includedItems: [] };
  const coreHtml = await ejs.renderFile(path.join(root, "CoreServices.ejs"), { coreServices: [service], coreServicesApiBase: "/api/admin/core-services" });
  assert.match(coreHtml, /Archived \(1\)/);
  assert.match(coreHtml, /data-action="restore"/);
  assert.match(coreHtml, /data-status="archived"/);
  const readOnlyCoreHtml = await ejs.renderFile(path.join(root, "CoreServices.ejs"), {
    coreServices: [service], coreServicesApiBase: "/api/secretary/core-services", coreServicesCanManage: false,
  });
  assert.doesNotMatch(readOnlyCoreHtml, /data-action="restore"/);
  assert.doesNotMatch(readOnlyCoreHtml, /class="btn btn-light btn-sm fw-semibold new-core-service"/);
  const categoryHtml = await ejs.renderFile(path.join(root, "ServiceCategories.ejs"), {
    serviceCategories: [{ _id: new mongoose.Types.ObjectId(), name: "Old repair", slug: "old-repair", icon: "bi-grid", iconColor: "blue", unitTypes: [], active: false, isCustom: false }],
    serviceCategoriesApiBase: "/api/admin/service-categories", serviceCategoriesCorePath: "/admin/services/core", serviceCategoriesCanManage: true,
  });
  assert.match(categoryHtml, /Archived \(1\)/);
  assert.match(categoryHtml, /Restore category/);
  for (const html of [coreHtml, categoryHtml]) {
    for (const script of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean)) {
      assert.doesNotThrow(() => new vm.Script(script));
    }
  }
  const appointments = fs.readFileSync(path.join(__dirname, "../routes/appointmentRoutes.js"), "utf8");
  assert.match(appointments, /CoreService\.findOne\(\{ _id: serviceItem\.serviceId, active: true \}\)/);
  const secretaryRoutes = fs.readFileSync(path.join(__dirname, "../routes/secretaryApi.js"), "utf8");
  assert.match(secretaryRoutes, /router\.post\("\/service-categories\/:id\/restore", serviceCategories\.restore\)/);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");
const { listArchive } = require("../controllers/archiveController");

const modelNames = [
  "User", "Technician", "HVACProduct", "Inventory", "Tool", "ServiceCategory",
  "CoreService", "NonWorkingDay", "ServiceToolUsage", "ProjectMaterial",
  "EquipmentAssignment", "BookingService", "Rating",
];

test("the Archive Center places archived core and repair services in one section", async () => {
  const models = modelNames.map(name => require("../models/" + name));
  const originals = models.map(model => model.find);
  models.forEach((model, index) => {
    const name = modelNames[index];
    model.find = () => ({
      select() { return this; }, sort() { return this; }, limit() { return this; },
      lean() {
        if (name === "CoreService") return Promise.resolve([{ _id: "core-1", name: "Aircon Cleaning", slug: "aircon-cleaning", archivedAt: new Date("2026-01-01"), archiveReason: "No longer offered" }]);
        if (name === "ServiceCategory") return Promise.resolve([{ _id: "repair-1", name: "Washer Repair", slug: "washer-repair", archivedAt: new Date("2026-01-02"), archiveReason: "No longer offered" }]);
        return Promise.resolve([]);
      },
    });
  });
  try {
    const response = { json(body) { this.body = body; } };
    await listArchive({}, response, error => { throw error; });
    const services = response.body.groups.find(group => group.key === "services");
    const catalogue = response.body.groups.find(group => group.key === "catalogue");
    assert.equal(services.count, 2);
    assert.deepEqual(services.records.map(record => record.type), ["Core service", "Repair category"]);
    assert.deepEqual(services.records.map(record => record.restoreUrl), [
      "/api/admin/core-services/core-1/restore",
      "/api/admin/service-categories/repair-1/restore",
    ]);
    assert.equal(catalogue.count, 0);
    assert.equal(response.body.total, 2);
    assert.deepEqual(response.body.warnings, []);
  } finally {
    models.forEach((model, index) => { model.find = originals[index]; });
  }
});

test("all portal layouts load the shared typeface and service archives link to the center", async () => {
  const views = path.join(__dirname, "../views");
  for (const layout of ["main", "admin", "secretary", "technician", "auth", "public-action"]) {
    const source = fs.readFileSync(path.join(views, "layouts", layout + ".ejs"), "utf8");
    assert.match(source, /enterprise-typography\.css/);
    assert.match(source, /family=Inter/);
  }
  const core = await ejs.renderFile(path.join(views, "pages/admin/Services/CoreServices.ejs"), { coreServices: [], coreServicesApiBase: "/api/admin/core-services" });
  const repair = await ejs.renderFile(path.join(views, "pages/admin/Services/ServiceCategories.ejs"), { serviceCategories: [], serviceCategoriesApiBase: "/api/admin/service-categories" });
  for (const html of [core, repair]) assert.match(html, /href="\/admin\/archive\?group=services"/);
  const archive = fs.readFileSync(path.join(views, "pages/admin/ArchiveCenter.ejs"), "utf8");
  assert.match(archive, /archiveServices/);
  assert.match(archive, /initialGroup/);
});

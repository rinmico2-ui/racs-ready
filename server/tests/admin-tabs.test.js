"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverRoot = path.join(__dirname, "..");

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

test("every static admin and secretary Bootstrap tab points to an existing pane", () => {
  const viewRoots = ["admin", "secretary"].map(name => path.join(serverRoot, "views/pages", name));
  const files = viewRoots.flatMap(walk).filter(file => file.endsWith(".ejs"));
  let triggerCount = 0;

  files.forEach(file => {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/<[^>]+data-bs-toggle=["'](?:tab|pill)["'][^>]*>/gi)) {
      triggerCount += 1;
      const target = match[0].match(/data-bs-target=["']#([^"']+)["']/i);
      assert.ok(target, `${path.relative(serverRoot, file)} has a tab without data-bs-target`);
      assert.match(source, new RegExp(`id=["']${target[1]}["']`), `${path.relative(serverRoot, file)} is missing #${target[1]}`);
    }
  });

  assert.ok(triggerCount >= 20, "expected the shared controller to cover the admin tab inventory");
});

test("shared admin tabs work without Bootstrap and preserve lifecycle hooks", () => {
  const source = fs.readFileSync(path.join(serverRoot, "public/js/admin.js"), "utf8");
  assert.match(source, /var adminTabSelector = '\[data-bs-toggle="tab"\], \[data-bs-toggle="pill"\]'/);
  assert.match(source, /pane\.hidden = !selected/);
  assert.match(source, /dispatchAdminTabEvent\(trigger, "shown\.bs\.tab"/);
  assert.match(source, /window\.AdminTabs = \{ show: showAdminTab \}/);
  assert.match(source, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
});

test("shared navbar dropdown has a dependency-safe accessible fallback", () => {
  const source = fs.readFileSync(path.join(serverRoot, "public/js/admin.js"), "utf8");
  const navbar = fs.readFileSync(path.join(serverRoot, "views/partials/admin-navbar.ejs"), "utf8");

  assert.match(navbar, /data-bs-toggle="dropdown"/);
  assert.match(source, /function setAdminDropdown\(trigger, open, options\)/);
  assert.match(source, /if \(window\.bootstrap && bootstrap\.Dropdown\) return/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /event\.key !== 'ArrowDown'/);
});

test("programmatic workflow tab changes have a dependency-safe fallback", () => {
  const orderScript = fs.readFileSync(path.join(serverRoot, "public/js/admin-aircon-orders.js"), "utf8");
  const unified = fs.readFileSync(path.join(serverRoot, "views/pages/admin/Appointments/AppointmentsUnified.ejs"), "utf8");
  const service = fs.readFileSync(path.join(serverRoot, "views/pages/admin/Reports/ServiceReport.ejs"), "utf8");

  assert.match(orderScript, /else if \(window\.AdminTabs\) window\.AdminTabs\.show\(overviewButton\)/);
  assert.match(unified, /else if\(window\.AdminTabs\)window\.AdminTabs\.show\(queueTabBtn\)/);
  assert.match(service, /else if \(trigger && window\.AdminTabs\) window\.AdminTabs\.show\(trigger/);
});

test("aircon order pickup workspace initializes without the Bootstrap modal bundle", () => {
  const orderScript = fs.readFileSync(path.join(serverRoot, "public/js/admin-aircon-orders.js"), "utf8");
  const template = fs.readFileSync(path.join(serverRoot, "views/pages/admin/Inventory/AirconOrders.ejs"), "utf8");

  assert.match(orderScript, /function orderModal\(element\)/);
  assert.match(orderScript, /if \(window\.bootstrap && bootstrap\.Modal\)/);
  assert.doesNotMatch(orderScript, /new bootstrap\.Modal/);
  assert.match(orderScript, /button\.addEventListener\("click", \(\) => setFulfillmentScope\(button\.dataset\.orderScope\)\)/);
  assert.match(orderScript, /case "pickup":\s+loadPickupTab\(\)/);
  assert.match(template, /admin-aircon-orders\.js\?v=20261010-resolution-record-link/);
});

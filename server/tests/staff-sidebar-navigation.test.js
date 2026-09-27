"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");

const views = path.join(__dirname, "../views");
const secretaryPath = path.join(views, "partials/secretary-sidebar.ejs");
const technicianPath = path.join(views, "partials/technician-sidebar.ejs");

const secretaryPermissions = [
  "dashboard.view", "appointments.view", "appointments.manage", "orders.view", "orders.manage",
  "services.view", "inventory.view", "customers.view", "technicians.view", "staff.view",
  "attendance.self.manage", "payments.view", "payroll.self.view", "reports.view",
];
const technicianPermissions = [
  "dashboard.view", "assignments.self.view", "warranties.self.manage", "remittances.self.manage",
  "attendance.self.manage", "payroll.self.view", "expenses.self.manage", "tools.self.manage",
  "tracking.self.manage",
];

function scriptsCompile(html) {
  for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1]) assert.doesNotThrow(() => new vm.Script(match[1]));
  }
}

test("secretary sidebar uses the modern semantic shell and route-aware groups", async () => {
  const html = await ejs.renderFile(secretaryPath, {
    currentPath: "/secretary/payments",
    user: { role: "secretary", name: "Secretary User" },
    effectivePermissions: secretaryPermissions,
  });

  assert.match(html, /class="sidebar admin-modern-sidebar secretary-modern-sidebar"/);
  assert.match(html, /<nav class="sidebar-navigation" aria-label="Secretary navigation">/);
  assert.doesNotMatch(html, /<ul class="sidebar-nav[^>]*>\s*<div/);
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.match(html, /class="collapse show" id="secretary-finance-collapse"/);
  assert.match(html, /data-bs-target="#secretary-finance-collapse"[^>]+aria-expanded="true"/);
  assert.match(html, /data-admin-sidebar-close/);
  assert.match(html, /href="\/secretary\/profile"/);
  assert.doesNotMatch(html, /href="\/admin\//);
  scriptsCompile(html);
});

test("technician sidebar uses the same modern shell without losing scoped tools", async () => {
  const html = await ejs.renderFile(technicianPath, {
    currentPath: "/technician/orders",
    technician: { name: "Technician User", availabilityStatus: "Available" },
    effectivePermissions: technicianPermissions,
  });

  assert.match(html, /class="sidebar admin-modern-sidebar technician-modern-sidebar"/);
  assert.match(html, /<nav class="sidebar-navigation" aria-label="Technician navigation">/);
  assert.doesNotMatch(html, /<ul class="sidebar-nav[^>]*>\s*<div/);
  assert.doesNotMatch(html, /<style[\s>]/i);
  for (const route of ["assignments", "orders", "calendar", "warranty-claims", "remittances", "attendance", "payroll", "expenses", "tools", "tracking", "analytics", "profile"]) {
    assert.match(html, new RegExp(`href="/technician/${route}"`));
  }
  assert.match(html, /data-admin-sidebar-close/);
  assert.match(html, /fetch\('\/api\/technician\/badge-counts'/);
  scriptsCompile(html);
});

test("staff layouts cache-bust the shared modern sidebar assets", () => {
  for (const layoutName of ["secretary.ejs", "technician.ejs"]) {
    const layout = fs.readFileSync(path.join(views, "layouts", layoutName), "utf8");
    assert.match(layout, /\/css\/sidebaradmin\.css\?v=20260927-modern-nav/);
    assert.match(layout, /\/js\/admin\.js\?v=20260927-shell-components/);
  }
});


"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");

const sidebarPath = path.join(__dirname, "../views/partials/admin-sidebar.ejs");
const sidebarSource = fs.readFileSync(sidebarPath, "utf8");

async function renderSidebar(currentPath) {
  return ejs.renderFile(sidebarPath, {
    currentPath,
    user: { role: "admin", name: "Admin User" },
  });
}

test("admin sidebar uses a compact semantic navigation hierarchy", async () => {
  const html = await renderSidebar("/admin");

  assert.match(html, /class="sidebar admin-modern-sidebar"/);
  assert.match(html, /<nav class="sidebar-navigation" aria-label="Admin navigation">/);
  assert.doesNotMatch(html, /<ul class="sidebar-nav[^>]*>\s*<div/);
  assert.doesNotMatch(sidebarSource, /<style[\s>]/i);

  for (const section of ["Workspace", "Operations", "Administration"]) {
    assert.match(html, new RegExp(`class="section-label">${section}<`));
  }
  for (const group of ["Work", "Service Catalog", "Inventory", "People", "Finance", "Analytics", "System"]) {
    assert.match(html, new RegExp(`<span class="nav-label">${group}</span>`));
  }
  assert.match(html, /data-admin-sidebar-close/);
  assert.match(html, /<strong class="footer-name">Admin User<\/strong>/);
});

test("admin sidebar opens the group that owns the current route", async () => {
  const cases = [
    ["/admin/appointments/walk-in", "appointment-mgmt-collapse"],
    ["/admin/services/core", "services-collapse"],
    ["/admin/inventory/technician-tools", "inventory-collapse"],
    ["/admin/customers/list", "people-collapse"],
    ["/admin/payments/remittance", "finance-collapse"],
    ["/admin/reports/revenue", "analytics-collapse"],
    ["/admin/audit-trail", "settings-collapse"],
  ];

  for (const [currentPath, collapseId] of cases) {
    const html = await renderSidebar(currentPath);
    assert.match(html, new RegExp(`class="collapse show" id="${collapseId}"`), currentPath);
    assert.match(html, new RegExp(`data-bs-target="#${collapseId}"[^>]+aria-expanded="true"`), currentPath);
  }
});

test("admin sidebar scripts and mobile controls remain valid", async () => {
  const html = await renderSidebar("/admin/appointments");
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter(Boolean);

  for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script));

  const adminScript = fs.readFileSync(path.join(__dirname, "../public/js/admin.js"), "utf8");
  const adminCss = fs.readFileSync(path.join(__dirname, "../public/css/sidebaradmin.css"), "utf8");
  const mobileCss = fs.readFileSync(path.join(__dirname, "../public/css/admin-mobile-navigation.css"), "utf8");
  const layout = fs.readFileSync(path.join(__dirname, "../views/layouts/admin.ejs"), "utf8");
  assert.match(adminScript, /querySelector\("\[data-admin-sidebar-close\]"\)/);
  assert.match(adminScript, /event\.key === "Escape"/);
  assert.match(adminScript, /toggleSidebarCollapseWithoutBootstrap/);
  assert.match(adminScript, /if \(window\.bootstrap && bootstrap\.Collapse\) return/);
  assert.match(adminScript, /btn\.setAttribute\("aria-expanded", expanded \? "true" : "false"\)/);
  assert.match(adminScript, /function showAdminTab\(trigger, options\)/);
  assert.match(adminScript, /dispatchAdminTabEvent\(trigger, "shown\.bs\.tab"/);
  assert.match(adminScript, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(adminCss, /ADMIN SIDEBAR 2026/);
  assert.match(adminCss, /@media \(max-width: 767px\)[\s\S]*?\.sidebar-mobile-close/);
  assert.match(adminScript, /function setMobileSidebarOpen\(open, options\)/);
  assert.match(adminScript, /sidebar\.setAttribute\("inert", ""\)/);
  assert.match(adminScript, /event\.key !== "Tab"/);
  assert.match(mobileCss, /\.admin-sidebar\.open[\s\S]*?transform:\s*translateX\(0\)/);
  assert.match(mobileCss, /body\.admin-layout\.admin-nav-open/);
  assert.match(layout, /\/css\/sidebaradmin\.css\?v=20260927-modern-nav/);
  assert.match(mobileCss, /#sidebarToggle\.admin-menu-trigger\s*\{\s*display:\s*none\s*!important/);
  assert.match(layout, /\/css\/admin-mobile-navigation\.css\?v=20260928-2/);
  assert.match(layout, /id="adminSidebarBackdrop"/);
  assert.match(layout, /\/js\/admin\.js\?v=20260928-mobile-drawer/);
});


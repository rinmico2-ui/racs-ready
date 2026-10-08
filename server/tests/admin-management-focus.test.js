'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('dashboard decisions reuse the authorized report and load after the section enters view', () => {
  const js = fs.readFileSync(path.join(__dirname, '../public/js/admin-management-focus.js'), 'utf8');
  assert.match(js, /\/api\/admin\/reports\/decisions\?range=month/);
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /textContent = item\.evidence/);
  assert.doesNotThrow(() => new Function(js));
});

test('dashboard financial summary uses the authoritative report snapshot and recorded stock costs', () => {
  const controller = fs.readFileSync(path.join(__dirname, '../controllers/adminController.js'), 'utf8');
  const section = controller.slice(controller.indexOf('exports.analyticsSummary ='), controller.indexOf('// ── Enterprise: Customer Ratings'));
  assert.match(section, /buildRevenueDashboardSnapshot/);
  assert.match(section, /financialDataAvailable: true/);
  assert.doesNotMatch(section, /todayPayments \+ todayBookings/);
  assert.match(section, /variant\.costPrice \* variant\.quantity/);
  assert.match(section, /Inventory\.countDocuments\(lowStockFilter\)/);
});

test('dashboard trends have populated chart paths and honest comparison baselines', () => {
  const js = fs.readFileSync(path.join(__dirname, '../public/js/admin-dashboard.js'), 'utf8');
  const template = fs.readFileSync(path.join(__dirname, '../views/pages/admin/admin-dashboard.ejs'), 'utf8');
  assert.match(js, /\$\('chartRevenueTrend'\)/);
  assert.match(js, /d\.revenueTrend7 \|\| \[\]/);
  assert.match(js, /financialDataAvailable === false/);
  assert.match(js, /'No baseline'/);
  assert.match(template, /Recent days this month/);
  assert.match(template, /Highest-Value Aircon Stock/);
  assert.doesNotThrow(() => new Function(js));
});

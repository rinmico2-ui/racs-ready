'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { parsePeriod, demandLabel, serviceDemandLabel, decision, productDecision, mergeProductRows } = require('../utils/decisionIntelligence');
const { evaluateCustomer, validatePolicy } = require('../utils/loyaltyAnalytics');

test('period parser validates dates and caps expensive ranges', () => {
  const now = new Date('2026-10-08T12:00:00');
  const month = parsePeriod({ range: 'month' }, now);
  assert.equal(month.start.toISOString(), '2026-09-30T16:00:00.000Z');
  assert.equal(month.end.getTime(), now.getTime());
  assert.throws(() => parsePeriod({ range: 'custom', from: '2026-11-01', to: '2026-10-01' }, now));
  assert.throws(() => parsePeriod({ range: 'custom', from: '2026-02-30', to: '2026-10-01' }, now));
  assert.throws(() => parsePeriod({ range: 'custom', from: '2020-01-01', to: '2026-10-01' }, now));
});

test('demand and management recommendations require evidence', () => {
  assert.equal(demandLabel(0, 100, 30), 'No demand');
  assert.equal(demandLabel(4, 8, 30), 'Insufficient data');
  assert.equal(demandLabel(22, 100, 30), 'High demand');
  assert.equal(demandLabel(2, 100, 30), 'Low demand');
  assert.equal(serviceDemandLabel({ bookings: 20, completed: 15, completedValue: 50000, recentBookings: 12 }, { bookings: 100, value: 150000 }, 30), 'High demand');
  assert.equal(serviceDemandLabel({ bookings: 20, completed: 0, completedValue: 0, recentBookings: 12 }, { bookings: 100, value: 150000 }, 30), 'Low demand');
  assert.equal(serviceDemandLabel({ bookings: 0, completed: 0, completedValue: 0, recentBookings: 0 }, { bookings: 4, value: 0 }, 7), 'Insufficient data');
  assert.equal(decision({ demand: 'High demand', costCoverage: 0, margin: 0 }), 'Review capacity and cost data');
  assert.equal(decision({ demand: 'High demand', costCoverage: 1, margin: 10 }), 'Review pricing');
  assert.equal(decision({ demand: 'Low demand', costCoverage: 1, margin: 30 }), 'Consider promotion');
});

test('loyalty tiers use configured quotas and reject unsafe values', () => {
  const policy = validatePolicy({ metric: 'completedBookings', tiers: [
    { threshold: 2, discountPercent: 2 },
    { threshold: 5, discountPercent: 5 },
    { threshold: 10, discountPercent: 8 },
  ] });
  assert.equal(evaluateCustomer({ completedBookings: 5 }, policy).tier, 'Silver');
  assert.equal(evaluateCustomer({ completedBookings: 1 }, policy).progress.nextTier, 'Bronze');
  assert.equal(evaluateCustomer({ completedBookings: 10 }, policy).tier, 'Gold');
  assert.throws(() => validatePolicy({ metric: 'completedBookings', tiers: [
    { threshold: 5, discountPercent: 1 }, { threshold: 4, discountPercent: 2 }, { threshold: 10, discountPercent: 3 },
  ] }));
});

test('product advice uses observed demand and stock cover without treating usage as revenue', () => {
  const part = { demand: 'High demand', stock: 2, reorder: 3, stockCoverDays: 5, margin: null, costCoverage: 0, days: 30, units: 0, consumed: 12, type: 'consumable' };
  assert.equal(productDecision(part), 'Restock now');
  assert.equal(productDecision({ ...part, stock: 20, stockCoverDays: 50 }), 'Monitor');
  assert.equal(productDecision({ ...part, demand: 'Low demand', stock: 20, stockCoverDays: 80, consumed: 2 }), 'Hold purchasing');
  assert.equal(productDecision({ ...part, demand: 'Low demand', stock: 20, stockCoverDays: 80, consumed: 2, margin: 30 }), 'Promote before restocking');
  assert.equal(productDecision({ ...part, demand: 'High demand', stock: null, stockCoverDays: null, consumed: 0, units: 5, costCoverage: 1, margin: 10 }), 'Review margin');
  assert.equal(productDecision({ ...part, days: 7 }), 'Continue monitoring');
});

test('the same SKU sold online and at the counter has one stock decision', () => {
  const rows = mergeProductRows([
    { id: 'sku-1', source: 'order', units: 2, revenue: 1000, gross: 1100, discounts: 100, contribution: 400, costCoverage: 1, consumed: 0, completedServices: 0, lastSale: new Date('2026-10-01'), lastMovement: null, stock: 3, reorder: 2 },
    { id: 'sku-1', source: 'pos', units: 1, revenue: 500, gross: 500, discounts: 0, contribution: 200, costCoverage: 1, consumed: 0, completedServices: 0, lastSale: new Date('2026-10-05'), lastMovement: null, stock: 3, reorder: 2 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'mixed');
  assert.equal(rows[0].units, 3);
  assert.equal(rows[0].revenue, 1500);
  assert.equal(rows[0].contribution, 600);
  assert.equal(rows[0].lastSale.toISOString(), '2026-10-05T00:00:00.000Z');
});

test('decision intelligence shares authorized reads and reserves policy writes for admins', async () => {
  const root = path.join(__dirname, '..');
  const pages = fs.readFileSync(path.join(root, 'routes/pages.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'routes/adminApi.js'), 'utf8');
  const secretaryAllowlist = fs.readFileSync(path.join(root, 'utils/secretaryReportAccess.js'), 'utf8');
  assert.match(pages, /\/secretary\/reports\/decisions.*requireRole\(\['admin', 'secretary'\]\)/);
  assert.match(api, /router\.get\('\/reports\/decisions'[\s\S]*?\['admin', 'secretary'\]/);
  assert.match(api, /router\.put\('\/reports\/decisions\/loyalty-policy'[\s\S]*?req\.user\.role !== 'admin'/);
  assert.match(secretaryAllowlist, /GET \/reports\/decisions/);
  assert.doesNotMatch(secretaryAllowlist, /PUT \/reports\/decisions\/loyalty-policy/);
  const html = await ejs.renderFile(path.join(root, 'views/pages/admin/Reports/DecisionIntelligence.ejs'), {});
  assert.match(html, /Which services and unit configurations are booked/);
  assert.match(html, /Most requested/);
  assert.match(html, /No requests/);
  assert.match(html, /Provisional contribution/);
  assert.match(html, /Units sold/);
  assert.match(html, /Last recorded sale/);
  assert.match(html, /No sales/);
  assert.match(html, /Reconnect after 90 days/);
  assert.match(html, /Service use/);
  const secretary = await ejs.renderFile(path.join(root, 'views/pages/admin/Reports/DecisionIntelligence.ejs'), { user: { role: 'secretary' } });
  assert.match(secretary, /data-decision-role="secretary"/);
  assert.doesNotMatch(secretary, /diPolicyForm/);
});

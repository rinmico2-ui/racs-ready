'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { leastSoldProducts, leastBookedServices, servicePortfolioDecision } = require('../utils/reportRankings');

test('least sold products rank units before revenue and preserve the full filtered cohort', () => {
  const sold = [
    { name: 'A', quantity: 8, revenue: 100 },
    { name: 'B', quantity: 1, revenue: 500 },
    { name: 'C', quantity: 1, revenue: 200 },
    { name: 'No sale', quantity: 0, revenue: 0 },
  ];
  assert.deepEqual(leastSoldProducts(sold).map(row => row.name), ['C', 'B', 'A']);
  assert.deepEqual(leastSoldProducts(sold.filter(row => row.name !== 'B'), 1).map(row => row.name), ['C']);
  assert.equal(sold[0].name, 'A');
});

test('least booked services rank distinct bookings before completed count and value', () => {
  const services = [
    { name: 'Cleaning', bookings: 12, completed: 10, revenue: 12000 },
    { name: 'Relocation', bookings: 2, completed: 1, revenue: 6000 },
    { name: 'Recharging', bookings: 2, completed: 2, revenue: 2000 },
  ];
  assert.deepEqual(leastBookedServices(services).map(row => row.name), ['Relocation', 'Recharging', 'Cleaning']);
});

test('service recommendations respond to demand, completion, recent drop, and sample size', () => {
  const scope = { periodDays: 60, portfolioBookings: 30 };
  assert.equal(servicePortfolioDecision({ bookings: 8, completed: 3 }, scope).label, 'Review delivery pipeline');
  assert.equal(servicePortfolioDecision({ bookings: 6, completed: 5, priorBookings: 6, recentBookings: 0 }, scope).label, 'Investigate demand drop');
  assert.equal(servicePortfolioDecision({ bookings: 9, completed: 8, priorBookings: 4, recentBookings: 5 }, scope).label, 'Protect capacity');
  assert.equal(servicePortfolioDecision({ bookings: 1, completed: 1, priorBookings: 1 }, scope).label, 'Test demand before expanding');
  assert.equal(servicePortfolioDecision({ bookings: 1, completed: 1 }, { periodDays: 7, portfolioBookings: 30 }).label, 'Collect more evidence');
  assert.equal(servicePortfolioDecision({ bookings: 9, completed: 8 }, { ...scope, portfolioComplete: false }).label, 'Review in full portfolio');
});

test('both shared reports show low activity lists and explain their cohort', () => {
  const root = path.join(__dirname, '..');
  const revenuePath = path.join(root, 'views/pages/admin/Reports/RevenueReports.ejs');
  const servicePath = path.join(root, 'views/pages/admin/Reports/ServiceReport.ejs');
  const revenue = fs.readFileSync(revenuePath, 'utf8');
  const service = fs.readFileSync(servicePath, 'utf8');
  assert.match(revenue, /Least Sold POS Products/);
  assert.match(revenue, /lowestPosProductsBody/);
  assert.match(revenue, /A\.lowestSellingPosProducts/);
  assert.match(service, /Least Booked Services/);
  assert.match(service, /lowestBookedServices/);
  const html = ejs.render(service, { analytics: { lowestBookedServices: [{ name: 'Relocation', type: 'core', bookings: 2, completed: 1, revenue: 6000 }] } }, { filename: servicePath });
  assert.match(html, /Relocation/);
  assert.match(html, /excludes services with no bookings/);
});

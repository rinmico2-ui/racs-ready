'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Booking = require('../models/BookingService');
const Order = require('../models/Order');
const { clear } = require('../utils/reportCache');
const { classifyCustomer, transactionBreakdown, parsePeriod, buildCustomerPerformance, customerProfile, historyPipeline, paginatedHistory, tableMatch, tableSort, normalizeQuery, customerSummaryPipeline, sourceSummaryPipeline } = require('../utils/customerPerformance');
const now = new Date('2026-10-09T12:00:00Z');
const period = parsePeriod({ range: 'month' }, now);
const base = { createdAt: new Date('2025-01-01'), completedBookings: 0, completedOrders: 0, lifetimeBookings: 0, lifetimeOrders: 0, lifetimeLastBooking: null, lifetimeLastOrder: null };
const customerId = new mongoose.Types.ObjectId('507f191e810c19729de860ea');
const aggregateResult = value => ({ allowDiskUse: () => Promise.resolve(value) });

test('periods use Manila midnight, clamp rolling month ends, and include all-time history', () => {
  assert.equal(period.start.toISOString(), '2026-09-30T16:00:00.000Z');
  assert.equal(parsePeriod({ range: 'year' }, now).start.toISOString(), '2025-12-31T16:00:00.000Z');
  assert.equal(parsePeriod({}, now).range, 'all');
  assert.equal(parsePeriod({ range: 'all' }, now).start.getTime(), 0);
  const monthEnd = new Date('2026-05-31T10:00:00Z');
  assert.equal(parsePeriod({ range: '3months' }, monthEnd).start.toISOString(), '2026-02-27T16:00:00.000Z');
  assert.equal(parsePeriod({ range: '6months' }, monthEnd).start.toISOString(), '2025-11-29T16:00:00.000Z');
  assert.equal(parsePeriod({ range: 'custom', from: '2020-01-01', to: '2026-10-09' }, now).end.toISOString(), now.toISOString());
  for (const [from, to] of [['2026-02-30', '2026-10-08'], ['2026-10-09', '2026-10-08'], ['2026-10-01', '2026-10-10'], ['invalid', '2026-10-08']]) {
    assert.throws(() => parsePeriod({ range: 'custom', from, to }, now), /Choose/);
  }
});

test('simple engagement keeps never engaged, new accounts, rare activity, and lapsed regulars distinct', () => {
  assert.equal(classifyCustomer(base, period, 90, now).engagement, 'Never Engaged');
  const newAccount = classifyCustomer({ ...base, createdAt: new Date('2026-10-01') }, period, 90, now);
  assert.equal(newAccount.engagement, 'Never Engaged'); assert.equal(newAccount.newAccount, true);
  const recent = new Date('2026-10-08T12:00:00Z');
  assert.equal(classifyCustomer({ ...base, lifetimeBookings: 1, lifetimeLastBooking: recent }, period, 90, now).engagement, 'Very Low Engagement');
  assert.equal(classifyCustomer({ ...base, lifetimeOrders: 3, lifetimeLastOrder: recent }, period, 90, now).engagement, 'Low Engagement');
  const singleOld = classifyCustomer({ ...base, lifetimeBookings: 1, lifetimeLastBooking: new Date('2026-03-01') }, period, 90, now);
  assert.equal(singleOld.engagement, 'Inactive'); assert.equal(singleOld.previouslyActiveNowInactive, false);
  const regularOld = classifyCustomer({ ...base, lifetimeBookings: 4, lifetimeOrders: 1, lifetimeLastOrder: new Date('2026-03-01') }, period, 90, now);
  assert.equal(regularOld.engagement, 'Previously Active / Now Inactive'); assert.equal(regularOld.previouslyActiveNowInactive, true);
  assert.equal(regularOld.daysSinceLastActivity, 222);
  assert.equal(classifyCustomer({ ...base, lifetimeBookings: 6 }, period, 90, now).engagement, 'Activity date unavailable');
});

test('inactivity uses lifetime completion dates independently of the analysis period', () => {
  const row = { ...base, lifetimeBookings: 5, lifetimeLastBooking: new Date('2026-08-24T12:00:00Z') };
  assert.equal(classifyCustomer(row, period, 90, now).engagement, 'Active');
  assert.equal(classifyCustomer(row, period, 30, now).engagement, 'Previously Active / Now Inactive');
  const boundary = new Date(now.getTime() - 90 * 86400000);
  assert.equal(classifyCustomer({ ...row, lifetimeLastBooking: boundary }, period, 90, now).recentlyActive, true);
});

test('spending separates product value, fulfillment fees, discounts, and actual refunds', () => {
  const amounts = transactionBreakdown({ serviceValue: 1500.25, serviceRefunds: 200, serviceDiscounts: 100 },
    { orderValue: 26000, productValue: 25000, productDiscounts: 500, productRefunds: 300 }, 100);
  assert.equal(amounts.orderFees, 1000); assert.equal(amounts.grossTransactionValue, 28100.25);
  assert.equal(amounts.discounts, 600); assert.equal(amounts.refunds, 600); assert.equal(amounts.recordedSpending, 26900.25);
  assert.equal(transactionBreakdown({ serviceValue: 100, serviceRefunds: 200 }).recordedSpending, 0);
});

test('customer filters escape literal searches and keep period and lifetime sorts distinct', () => {
  const query = normalizeQuery({ list: 'records', search: '  A.*(B)  ', sort: 'orders', page: '999999' });
  assert.equal(query.search, 'A.*(B)'); assert.equal(query.page, 100000);
  const match = tableMatch(query);
  assert.equal(match.$and[0].$or[0].name.$regex, 'A\\.\\*\\(B\\)');
  assert.equal(tableSort(query).completedOrders, -1);
  assert.equal(tableSort(normalizeQuery({ list: 'lowest', sort: 'bookings' })).lifetimeBookings, -1);
  assert.equal(tableSort(normalizeQuery({ sort: 'last' })).periodLastActivity, -1);
  assert.equal(tableSort(normalizeQuery({ list: 'lowest' })).lifetimeTransactions, 1);
  assert.equal(tableSort(query)._id, 1);
  assert.deepEqual(tableMatch(normalizeQuery({ list: 'records', segment: 'never' })), { $and: [{ lifetimeTransactions: 0 }] });
});

test('main report returns a bounded database page and clamps out-of-range requests', async t => {
  clear('customer-performance'); t.after(() => clear('customer-performance'));
  const queries = [];
  const row = { _id: customerId, name: 'Fixture Customer', completedBookings: 1, completedOrders: 0, serviceValue: 100, orderValue: 0, productValue: 0, discounts: 0 };
  t.mock.method(User, 'aggregate', pipeline => { queries.push(pipeline); return aggregateResult(queries.length === 1 ? [{ summary: [{ totalCustomers: 51, frequentCustomers: 1, neverEngaged: 3, inactive: 2 }], topBooker: [row], topBuyer: [], count: [{ total: 51 }], rows: [] }] : [row]); });
  const report = await buildCustomerPerformance({ range: 'all', list: 'records', page: 999 }, now);
  assert.equal(report.customers.page, 3); assert.equal(report.customers.total, 51); assert.equal(report.customers.rows.length, 1);
  assert.equal(report.customers.rows[0].id, String(customerId)); assert.equal(report.rows, undefined); assert.equal(report.matrix, undefined);
  assert.equal(queries.length, 2);
  const facet = queries[0].at(-1).$facet;
  assert.ok(facet.rows.some(stage => stage.$limit === 25)); assert.equal(facet.topBooker.at(-1).$limit, 1);
  assert.ok(queries[1].some(stage => stage.$skip === 50));
  const joins = queries[0].filter(stage => stage.$lookup);
  assert.equal(joins.length, 2); assert.ok(joins.every(stage => stage.$lookup.pipeline.at(-1).$group));
});

test('main report distinguishes successful activity from financially refunded completions and suppresses installation double counts', () => {
  const pipeline = customerSummaryPipeline(period, 90, now);
  assert.deepEqual(pipeline[0].$match, { role: 'customer' });
  assert.equal(pipeline[1].$project.email, 1); assert.equal(pipeline[1].$project.password, undefined);
  const bookings = sourceSummaryPipeline(period, true, now), orders = sourceSummaryPipeline(period, false, now);
  assert.deepEqual(bookings[0].$match, { sourceOrderId: null });
  assert.deepEqual(bookings[2].$match, { 'linkedOrders.0': { $exists: false } });
  const serialized = JSON.stringify(orders);
  assert.match(serialized, /"sourceType":"order","status":"completed"/);
  assert.doesNotMatch(serialized, /productRefundAmount/);
  assert.match(serialized, /"\$lt":\["\$itemRefunds","\$productNet"\]/);
  assert.match(JSON.stringify(bookings), /cancelledAt/); assert.match(JSON.stringify(bookings), /noShowAt/);
});

test('customer history is owner-scoped, defaults to successful completions, and validates status filters', async () => {
  const bookings = historyPipeline(customerId, {}, period, true), orders = historyPipeline(customerId, {}, period, false);
  assert.deepEqual(bookings[0].$match, { customerId }); assert.deepEqual(orders[0].$match, { userId: customerId });
  assert.ok(bookings.some(stage => stage.$match?.successful === true && stage.$match.sourceOrderId === null));
  assert.ok(orders.some(stage => stage.$match?.successful === true));
  const all = historyPipeline(customerId, { bookingStatus: 'all' }, period, true);
  assert.ok(!all.some(stage => stage.$match?.successful));
  assert.throws(() => historyPipeline(customerId, { bookingStatus: 'invented' }, period, true), /history status/);
  assert.throws(() => historyPipeline(customerId, { orderStatus: { $ne: 'completed' } }, period, false), /history status/);
  assert.equal(await customerProfile('invalid', {}, now), null);
});

test('history pagination clamps past-end pages and applies a stable bounded database sort', async () => {
  const queries = [], model = { aggregate: pipeline => { queries.push(pipeline); return aggregateResult(queries.length === 1 ? [{ count: [{ total: 23 }], rows: [] }] : [{ _id: customerId }]); } };
  const history = await paginatedHistory(model, [{ $match: { userId: customerId } }], { status: 1 }, 999, -1);
  assert.equal(history.page, 2); assert.equal(history.pageSize, 20); assert.equal(history.total, 23); assert.equal(history.rows.length, 1);
  assert.ok(queries[1].some(stage => stage.$skip === 20)); assert.ok(queries[1].some(stage => stage.$limit === 20));
  assert.deepEqual(queries[1][1].$sort, { historyDate: -1, _id: -1 });
});

test('report and profile render the simple views and reuse protected admin routes', async () => {
  const root = path.join(__dirname, '..');
  const pages = fs.readFileSync(path.join(root, 'routes/pages.js'), 'utf8'), api = fs.readFileSync(path.join(root, 'routes/adminApi.js'), 'utf8');
  const allowlist = fs.readFileSync(path.join(root, 'utils/secretaryReportAccess.js'), 'utf8');
  assert.match(pages, /\/admin\/reports\/customers'[\s\S]*?requireRole\('admin'\)/);
  assert.match(api, /router\.get\('\/reports\/customers', requirePermission\('reports\.view'\)/);
  assert.match(api, /router\.get\('\/reports\/customers\/:id', requirePermission\('reports\.view'\)/);
  assert.doesNotMatch(allowlist, /GET \/reports\/customers/);
  assert.doesNotMatch(api, /filterRows\(report\.rows/);
  const template = path.join(root, 'views/pages/admin/Reports/CustomerPerformance.ejs');
  const overview = await ejs.renderFile(template, {}), profile = await ejs.renderFile(template, { customerProfileId: String(customerId) });
  for (const view of ['frequent', 'records', 'lowest']) assert.match(overview, new RegExp('data-cp-view="' + view + '"'));
  assert.doesNotMatch(overview, /Service \+ order matrix|Highly engaged across both|Loyalty candidates/);
  for (const title of ['Selected period', 'Lifetime', 'Service Booking History', 'Most Booked Services', 'Order History', 'Most Purchased Products', 'Spending Summary', 'Loyalty Status']) assert.ok(profile.includes(title));
  for (const type of ['bookingStatus', 'orderStatus']) assert.match(profile, new RegExp('name="' + type + '"><option value="successful"'));
  // Every exposed status is a real status in the existing model, or a report-only filter.
  const options = html => [...html.matchAll(/<option value="([^"]*)">/g)].map(item => item[1]);
  for (const [key, model] of [['bookingStatus', Booking], ['orderStatus', Order]]) {
    const select = profile.match(new RegExp('name="' + key + '">([\\s\\S]*?)</select>'))[1];
    for (const value of options(select)) assert.ok(['successful', 'all', 'refunded', ...model.schema.path('status').enumValues].includes(value));
  }
});

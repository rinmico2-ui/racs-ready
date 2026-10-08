'use strict';
// Read-only: no seeding, index creation, record changes, or customer data output.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { buildMongoConnectionUri } = require('../utils/mongoConnection');
const { buildCustomerPerformance, customerProfile, sourceSummaryPipeline, classifyCustomer, parsePeriod } = require('../utils/customerPerformance');
const round = value => Math.round(value * 100) / 100;

async function checkExpressions(now) {
  now = new Date('2026-10-09T12:00:00Z');
  // $documents evaluates the real Mongo expressions using temporary inline data.
  // It never writes fixture records to any collection.
  const completedAt = new Date('2026-10-01T01:00:00Z');
  const fixtures = [
    { status: 'completed', completedAt, totalPrice: 900, total: 1200, subtotal: 1000, discount: 100, items: [{ totalPrice: 1000, quantity: 2 }] },
    { status: 'completed', completedAt, totalPrice: 500, total: 1500, subtotal: 1000, refundStatus: 'completed', refundAmount: 500, items: [{ totalPrice: 1000, quantity: 1 }] },
    { status: 'completed', completedAt, totalPrice: 800, total: 1000, subtotal: 1000, refundStatus: 'partial', refundAmount: 100, productRefundAmount: 200, itemReturns: [{ amount: 200 }], items: [{ totalPrice: 1000, quantity: 3 }] },
    { status: 'completed', completedAt, totalPrice: 700, total: 1100, subtotal: 1000, productRefundAmount: 1000, itemReturns: [{ amount: 1000 }], items: [{ totalPrice: 1000, quantity: 1 }] },
    { status: 'pending', createdAt: completedAt, totalPrice: 999, total: 999, subtotal: 999 },
    { status: 'cancelled', cancelledAt: completedAt, updatedAt: new Date('2025-01-01'), totalPrice: 999, total: 999 },
    { status: 'no-show', noShowAt: completedAt, updatedAt: new Date('2025-01-01'), totalPrice: 999 },
    { status: 'completed', completedAt, totalPrice: 999, sourceOrderId: new mongoose.Types.ObjectId(), linkedOrders: [] },
    { status: 'completed', completedAt, totalPrice: 999, linkedOrders: [{ _id: new mongoose.Types.ObjectId() }] },
  ];
  const period = parsePeriod({ range: 'custom', from: '2026-10-01', to: '2026-10-08' }, now);
  const evaluate = async (rows, booking) => {
    const stages = sourceSummaryPipeline(period, booking, now).filter(stage => !stage.$lookup);
    const result = await mongoose.connection.db.command({ aggregate: 1, pipeline: [{ $documents: rows }, ...stages], cursor: {} });
    return result.cursor.firstBatch[0];
  };
  const booking = await evaluate(fixtures, true), order = await evaluate(fixtures.slice(0, 7), false);
  assert.equal(booking.completed, 3); // fully refunded and both installation links excluded
  assert.equal(booking.value, 2900); assert.equal(booking.refunds, 600);
  assert.equal(booking.cancelled, 1); assert.equal(booking.noShows, 1);
  assert.equal(order.completed, 2); assert.equal(order.refunded, 2);
  assert.equal(order.value, 4800); assert.equal(order.refunds, 1800); // item refund mirror excluded
  assert.equal(order.itemsPurchased, 5); assert.equal(order.cancelled, 1);
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Database configuration is unavailable.');
  const { uri } = buildMongoConnectionUri(process.env.MONGODB_URI, { directHosts: process.env.MONGODB_DIRECT_HOSTS, replicaSet: process.env.MONGODB_REPLICA_SET, authSource: process.env.MONGODB_AUTH_SOURCE });
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, maxPoolSize: 3 });
  const now = new Date(), allRows = [], seen = new Set();
  const first = await buildCustomerPerformance({ range: 'all', list: 'records' }, now);
  const pages = Math.max(1, Math.ceil(first.customers.total / first.customers.pageSize));
  for (let page = 1; page <= pages; page++) {
    const report = page === 1 ? first : await buildCustomerPerformance({ range: 'all', list: 'records', page }, now);
    assert.equal(report.customers.total, first.customers.total);
    assert.ok(report.customers.rows.length <= 25);
    assert.equal(report.rows, undefined); assert.equal(report.matrix, undefined);
    for (const row of report.customers.rows) {
      assert.ok(!seen.has(row.id)); seen.add(row.id); allRows.push(row);
      assert.equal(row.recordedSpending, round(Math.max(0, row.serviceValue + row.orderValue - row.refunds)));
      assert.equal(row.completedBookings, row.lifetimeBookings); assert.equal(row.completedOrders, row.lifetimeOrders);
      assert.equal(row.recordedSpending, row.lifetimeSpending);
      const expected = classifyCustomer(row, parsePeriod({ range: 'all' }, now), 90, now);
      assert.equal(row.engagement, expected.engagement); assert.equal(row.daysSinceLastActivity, expected.daysSinceLastActivity);
      assert.equal(row.password, undefined); assert.equal(row.phone, undefined);
    }
  }
  assert.equal(allRows.length, first.summary.totalCustomers);
  assert.equal(first.summary.frequentCustomers, allRows.filter(row => row.completedTransactions >= 5).length);
  assert.equal(first.summary.neverEngaged, allRows.filter(row => row.lifetimeTransactions === 0).length);
  assert.equal(first.summary.inactive, allRows.filter(row => row.previouslyActiveNowInactive).length);
  const lowest = await buildCustomerPerformance({ range: 'month', list: 'lowest' }, now);
  assert.ok(lowest.customers.rows.every(row => row.lifetimeTransactions < 5 || !row.recentlyActive));
  const candidate = allRows.find(row => row.lifetimeTransactions > 0) || allRows[0];
  if (candidate) {
    const profile = await customerProfile(candidate.id, { range: 'all' }, now);
    assert.equal(profile.customer.recordedSpending, candidate.recordedSpending);
    assert.equal(profile.bookings.total, candidate.lifetimeBookings); assert.equal(profile.orders.total, candidate.lifetimeOrders);
    assert.ok(profile.bookings.rows.length <= 20 && profile.orders.rows.length <= 20);
    assert.ok(profile.bookings.rows.every(row => !row.linkedOrder));
    assert.ok(profile.servicePreferences.every(item => item.bookings <= candidate.lifetimeBookings));
    assert.ok(profile.productPreferences.every(item => item.orders <= candidate.lifetimeOrders));
    assert.equal(profile.collections.net, round(profile.collections.gross - profile.collections.refunds));
  }
  await checkExpressions(now);
  console.log(JSON.stringify({ result: 'passed', customers: allRows.length, pagesChecked: pages, profileChecked: Boolean(candidate), inlineFinancialFixtures: 'passed' }));
}
main().catch(error => {
  console.error('Customer Performance verification failed: ' + error.name + (error.code ? ' (' + error.code + ')' : ''));
  if (error.name === 'AssertionError') console.error('Expected: ' + error.expected + '; received: ' + error.actual);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const rewards = require('../utils/loyaltyRewards');
const discounts = require('../utils/transactionDiscounts');
const Booking = require('../models/BookingService');
const Order = require('../models/Order');
const SiteSetting = require('../models/SiteSetting');
const { calculatePaymentBreakdown } = require('../utils/paymentPolicy');
const { bookingApprovedValue } = require('../utils/revenueRecognition');
const { bookingRevenue } = require('../utils/serviceCostAnalytics');
const returns = require('../utils/productReturnPolicy');
const serviceId = '507f191e810c19729de86001';
const otherId = '507f191e810c19729de86002';
const customerId = '507f191e810c19729de86003';
const rule = overrides => ({ id: 'repeat-services', name: 'Repeat service reward', enabled: true, metric: 'bookings', threshold: 5, discountPercent: 10,
  appliesTo: 'both', qualifyingServiceIds: [], eligibleServiceIds: [], eligibleProductIds: [], ...overrides });
const policy = rules => ({ ...rewards.validatePolicy({ enabled: true, rules: rules || [rule()] }), revision: 'version-1' });
const history = { bookings: Array.from({ length: 5 }, () => ({ serviceIds: [serviceId] })), orders: 2 };
const lines = [{ id: serviceId, amount: 1000, eligible: true }, { id: otherId, amount: 500, eligible: false }];
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('reward rules reject invalid, duplicate, missing, and excessive settings', () => {
  assert.throws(() => policy([null]), /valid reward/);
  for (const input of [{ threshold: 0 }, { threshold: 1.5 }, { discountPercent: 0 }, { discountPercent: 0.001 }, { discountPercent: 51 }, { metric: 'pendingBookings' }, { eligibleServiceIds: ['bad'] }, { enabled: 'yes' }]) {
    assert.throws(() => policy([rule(input)]));
  }
  assert.throws(() => policy([rule(), rule()]), /unique/);
  assert.throws(() => policy([rule({ enabled: false })]), /activate/);
  assert.equal(rewards.validatePolicy({ enabled: false, rules: [] }).enabled, false);
  assert.equal(policy([rule({ discountPercent: 7.25 })]).rules[0].discountPercent, 7.25);
});

test('qualifying services count each completed booking once and use the selected metric', () => {
  const mixed = { bookings: [{ serviceIds: [serviceId, serviceId, otherId] }, { serviceIds: [otherId] }], orders: 3 };
  assert.deepEqual(rewards.ruleProgress(rule({ qualifyingServiceIds: [serviceId], threshold: 2 }), mixed), { value: 1, target: 2, qualified: false });
  assert.equal(rewards.ruleProgress(rule({ metric: 'orders' }), mixed).value, 3);
  assert.equal(rewards.ruleProgress(rule({ metric: 'combined', qualifyingServiceIds: [serviceId] }), mixed).value, 4);
  assert.equal(rewards.evaluateHistory(policy(), history).tier, 'Repeat service reward');
  assert.equal(rewards.evaluateHistory({ enabled: false, rules: [rule()] }, history).tier, null);
  assert.equal(rewards.evaluateHistory(policy(), { bookings: history.bookings.slice(0, 4), orders: 0 }).progress.percent, 80);
});

test('the best monetary reward applies only to eligible lines without stacking', () => {
  const choices = policy([rule({ id: 'whole-basket', discountPercent: 5 }), rule({ id: 'only-product', discountPercent: 25, eligibleProductIds: [otherId] })]);
  const products = [{ id: serviceId, amount: 10000 }, { id: otherId, amount: 1000 }];
  const reward = rewards.chooseReward(choices, history, 'orders', products);
  assert.equal(reward.ruleId, 'whole-basket');
  assert.equal(reward.amount, 550);
  assert.equal(rewards.chooseReward(policy(), history, 'services', lines).amount, 100);
  assert.equal(rewards.chooseReward(policy(), history, 'services', lines, true), null);
  assert.equal(rewards.chooseReward(policy([rule({ appliesTo: 'services' })]), history, 'orders', products), null);
  assert.equal(rewards.chooseReward(policy(), { bookings: [], orders: 0 }, 'services', lines), null);
});

test('checkout quote rejects forged, expired, cross-customer, changed-price and changed-policy tokens', t => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-only-loyalty-quote-signing-secret';
  t.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  const reward = rewards.chooseReward(policy(), history, 'services', lines);
  const token = rewards.quoteToken(customerId, 'services', lines, reward, false);
  assert.doesNotThrow(() => rewards.assertQuote(token, customerId, 'services', lines, reward, false));
  for (const input of [
    [null, customerId, 'services', lines, reward, false],
    [token + 'forged', customerId, 'services', lines, reward, false],
    [token, otherId, 'services', lines, reward, false],
    [token, customerId, 'orders', lines, reward, false],
    [token, customerId, 'services', [{ ...lines[0], amount: 1100 }, lines[1]], reward, false],
    [token, customerId, 'services', lines, { ...reward, policyRevision: 'version-2' }, false],
    [token, customerId, 'services', lines, null, false],
    [jwt.sign({ purpose: 'loyalty-checkout' }, process.env.JWT_SECRET, { expiresIn: -1 }), customerId, 'services', lines, reward, false],
  ]) assert.throws(() => rewards.assertQuote(...input), error => error.status === 409 && error.code === 'LOYALTY_QUOTE_CHANGED');
  assert.doesNotThrow(() => rewards.assertQuote(null, customerId, 'services', lines, null, false));
});

test('completion queries exclude fully refunded and linked-installation transactions', async t => {
  t.mock.method(Booking, 'aggregate', async pipeline => {
    assert.deepEqual(pipeline[0].$match.status.$in, ['completed', 'repair_completed', 'closed']);
    assert.equal(pipeline[0].$match.refundStatus.$ne, 'completed');
    assert.equal(pipeline[0].$match.sourceOrderId, null);
    assert.equal(pipeline[1].$lookup.foreignField, 'bookingId');
    assert.deepEqual(pipeline[2].$match, { 'orders.0': { $exists: false } });
    return [{ _id: new mongoose.Types.ObjectId(customerId), bookings: history.bookings }];
  });
  t.mock.method(Order, 'aggregate', async pipeline => {
    assert.equal(pipeline[0].$match.status, 'completed');
    assert.equal(pipeline[0].$match.refundStatus.$ne, 'completed');
    assert.match(JSON.stringify(pipeline[0]), /productRefundAmount/);
    return [{ _id: new mongoose.Types.ObjectId(customerId), orders: 2 }];
  });
  assert.deepEqual(await rewards.completedHistory(customerId), history);
});

test('admin rule saves use revision checks and preserve conflicting changes', async t => {
  t.mock.method(SiteSetting, 'findOne', () => ({ select: () => ({ lean: async () => ({ value: policy() }) }) }));
  const update = t.mock.method(SiteSetting, 'updateOne', async query => { assert.equal(query['value.revision'], 'version-1'); return { modifiedCount: 1 }; });
  await assert.rejects(rewards.savePolicy({ enabled: true, rules: [rule()], expectedRevision: 'old-version' }, customerId), error => error.status === 409);
  assert.equal(update.mock.callCount(), 0);
  const saved = await rewards.savePolicy({ enabled: true, rules: [rule({ threshold: 6 })], expectedRevision: 'version-1' }, customerId);
  assert.equal(saved.rules[0].threshold, 6);
  assert.notEqual(saved.revision, 'version-1');
  update.mock.mockImplementation(async () => ({ modifiedCount: 0 }));
  await assert.rejects(rewards.savePolicy({ enabled: true, rules: [rule()], expectedRevision: 'version-1' }, customerId), error => error.status === 409);
});

test('discounted booking totals stay stable and exclude repair inspection and travel', () => {
  const reward = rewards.chooseReward(policy(), history, 'services', lines);
  const booking = new Booking({ serviceType: 'mixed', travelFare: 150, loyaltyDiscount: reward, services: [
    { serviceId, name: 'Cleaning', type: 'core', quantity: 2, unitPrice: 500, totalPrice: 1000 },
    { serviceId: otherId, name: 'Inspection', type: 'repair', quantity: 1, initialCost: 500, unitPrice: 500 },
  ] });
  const costs = booking.calculateTotalCosts();
  assert.equal(costs.discount, 100);
  assert.equal(costs.totalPrice, 1550);
  booking.totalPrice = costs.totalPrice; booking.discount = costs.discount;
  assert.deepEqual(booking.calculateTotalCosts(), costs);
  assert.equal(calculatePaymentBreakdown(costs.totalPrice, 10).downpaymentAmount, 155);
  assert.equal(calculatePaymentBreakdown(costs.totalPrice, 10).balanceAmount, 1395);
  assert.equal(bookingApprovedValue(booking), 1550);
  assert.equal(bookingRevenue(booking), 1550);
  booking.services[0].finalCost = 0;
  booking.services[0].costUpdatedByTechnician = true;
  booking.discount = booking.calculateTotalCosts().discount;
  assert.equal(booking.discount, 0);
  assert.equal(booking.calculateTotalCosts().totalPrice, 650);
  assert.equal(bookingApprovedValue(booking), 650);
  assert.equal(bookingRevenue(booking), 650);
  booking.services[0].costUpdatedByTechnician = false;
  booking.services[0].serviceId = otherId;
  assert.equal(booking.calculateTotalCosts().discount, 0);
  assert.equal(booking.loyaltyDiscount.ruleName, 'Repeat service reward');
});

test('item discount allocations reconcile to the cent and refunds use only the discounted item price', () => {
  const reward = rewards.chooseReward(policy([rule({ eligibleProductIds: [serviceId] })]), history, 'orders', [{ id: serviceId, amount: 10000 }, { id: otherId, amount: 5000 }]);
  const amounts = discounts.allocateLoyaltyDiscount([{ id: serviceId, amount: 10000 }, { id: otherId, amount: 5000 }], reward);
  assert.deepEqual(amounts, [1000, 0]);
  const order = { subtotal: 15000, discount: 1000, total: 14150, items: [
    { inventoryId: serviceId, quantity: 2, totalPrice: 10000, discountAmount: amounts[0] },
    { inventoryId: otherId, quantity: 1, totalPrice: 5000, discountAmount: amounts[1] },
  ] };
  assert.equal(returns.allocationCap('order', order, order.items[0], 1, 14150), 4500);
  assert.equal(returns.allocationCap('order', order, order.items[1], 1, 14150), 5000);
  assert.equal(discounts.netLineValue(order, order.items[0]), 9000);
  for (let size = 1; size <= 40; size++) {
    const basket = Array.from({ length: size }, (_, index) => ({ id: serviceId, amount: (index + 1) * 0.37 }));
    const earned = rewards.chooseReward(policy([rule({ discountPercent: 7.25 })]), history, 'orders', basket);
    const allocation = discounts.allocateLoyaltyDiscount(basket, earned);
    assert.equal(Math.round(allocation.reduce((sum, value) => sum + value, 0) * 100), Math.round(earned.amount * 100));
  }
});

test('rules editor renders a real configuration page and checkout templates have valid JavaScript', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../views/pages/admin/Customers/Privilege.ejs'), {});
  assert.match(html, /Customer Privileges/);
  assert.match(html, /loyaltyRulesForm/);
  assert.match(html, /one-use coupons/);
  for (const file of ['views/partials/cart-wizard.ejs', 'views/partials/aircons.ejs']) {
    const source = read(file).replace(/<%[\s\S]*?%>/g, 'null');
    const blocks = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    for (const block of blocks) if (block[1].trim()) assert.doesNotThrow(() => new vm.Script(block[1]), file);
    assert.match(read(file), /loyaltyQuoteToken/);
  }
});

test('booking quotes refresh changed selections and share an in-flight price check', async () => {
  const source = read('public/js/services-multi.js');
  const helpers = source.slice(source.indexOf('let bookingLoyaltyQuote = null;'), source.indexOf('function displayTotalFee()'));
  let calls = 0, release;
  const state = { selectedServices: [{ serviceId, type: 'core', quantity: 1, unitPrice: 1000 }] };
  const context = {
    BookingState: state, bookingRequiresProjectSchedule: () => false, isRepairBookingService: () => false,
    displayTotalFee() {}, updatePaymentAmounts() {}, syncPaymentConfirmAction() {},
    fetch: async () => {
      calls++;
      if (calls === 2) await new Promise(resolve => { release = resolve; });
      return { ok: true, json: async () => ({ token: 'server-quote', discount: calls === 1 ? 100 : 150,
        lines: [{ id: serviceId, amount: 1000, eligible: true }], reward: { ruleName: 'Repeat customer', discountPercent: 10 } }) };
    },
  };
  vm.runInNewContext(helpers, context);
  await context.refreshBookingReward();
  assert.equal(context.currentBookingReward().discount, 100);
  await context.refreshBookingReward();
  assert.equal(calls, 1);
  const checking = context.refreshBookingReward(true);
  const waiting = context.refreshBookingReward();
  assert.equal(calls, 2);
  release();
  const refreshed = await Promise.all([checking, waiting]);
  assert.equal(refreshed[0].discount, 150);
  assert.equal(refreshed[1].discount, 150);
  state.selectedServices[0].quantity = 2;
  assert.equal(context.currentBookingReward(), null);
});

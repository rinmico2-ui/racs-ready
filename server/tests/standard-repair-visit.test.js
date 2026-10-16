'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const visit = require('../utils/standardRepairVisit');
const { manilaDateTime, parseAppointmentTime } = require('../utils/bookingDateTime');
const id = number => number.toString(16).padStart(24, '0');
const lead = id(1), support = id(2), bookingId = id(3), assignmentId = id(4), actorId = id(5), toolId = id(6);
const date = '2026-10-19', now = new Date('2026-10-19T01:03:15Z');
function query(value) { return { session() { return this; }, sort() { return this; }, lean: async () => structuredClone(value) }; }
function fixture({ part = false } = {}) {
  const store = { booking: { _id: bookingId, __v: 0, technicianId: lead, assignmentId, bookingDate: manilaDateTime(date, 0), startTime: '08:00', endTime: '10:00',
    status: 'repair_approved', serviceType: 'repair', repairUnitTracking: true, inspection: { completedAt: now }, approval: { status: 'approved' }, quotationReview: { status: 'approved' },
    initialCost: 500, inspectionFeeCollected: true, amountPaid: 500, totalPrice: 500,
    technicianTeam: [{ technicianId: lead, status: 'accepted' }, { technicianId: support, status: 'accepted' }],
    services: [{ name: 'Repair inspection', type: 'repair', status: 'repair_approved', quantity: 1, totalPrice: 500, units: [{ unitIndex: 1, repairReview: { state: 'approved' }, quotation: { laborCost: 300, totalCost: part ? 800 : 300, parts: part ? [{ name: 'Capacitor', toolId, quantity: 1, cost: 500 }] : [] } }] }],
    quotation: { laborCost: 300, totalCost: part ? 800 : 300, parts: part ? [{ name: 'Capacitor', toolId, quantity: 1, cost: 500 }] : [] }, localPurchase: [], statusHistory: [] },
    assignment: { _id: assignmentId, bookingId, technicianId: lead, status: 'in_progress', bookingDate: manilaDateTime(date, 0), startTime: '08:00' },
    kit: { status: 'confirmed', hasDelta: false, items: [] }, expenses: [] };
  const calls = [], blocked = new Set(); let failWrite = false;
  const deps = {
    mongoose: { isValidObjectId: value => /^[a-f\d]{24}$/i.test(value), async startSession() { return { async withTransaction(work) { const before = structuredClone(store); try { await work(); } catch (error) { Object.assign(store, before); throw error; } }, async endSession() {} }; } },
    Booking: { findById: key => query(String(key) === bookingId ? store.booking : null), async updateOne(filter, change, options) { assert.ok(options.session); calls.push(['booking-write']); if (failWrite || filter.__v !== store.booking.__v) return { modifiedCount: 0 }; Object.assign(store.booking, structuredClone(change.$set)); store.booking.__v++; return { modifiedCount: 1 }; } },
    Assignment: { findOne: filter => query(filter.technicianId === store.assignment.technicianId ? store.assignment : null), async updateMany(filter, change, options) { assert.ok(options.session); calls.push(['assignment-write', filter, change]); Object.assign(store.assignment, change.$set); return { modifiedCount: 2 }; } },
    Kit: { findOne: () => query(store.kit) },
    Expense: { async create(rows, options) { assert.ok(options.session); store.expenses.push(...structuredClone(rows)); } },
    now: () => now, receipt: async () => ({ metadata: { uploadedBy: actorId } }),
    lock: async (key, work) => { calls.push(['lock', key]); return work(); },
    async slots(input, exclusions) {
      calls.push(['slots', input, exclusions]);
      const start = exclusions.ongoingStartMinutes, duration = Number(input.duration) + 45;
      return { statusCode: 200, payload: { capacityPerSlot: duration, timeSlots: blocked.has(input.technicianId) ? [] : [{ available: true, startTime: `${Math.floor(start / 60)}:${String(start % 60).padStart(2, '0')}` }] } };
    },
  };
  const api = visit.createService(deps);
  return { store, calls, deps, blocked, api, read: input => api.read(bookingId, lead, input),
    act: (action, input = {}) => api.act(bookingId, { _id: lead, name: 'Primary' }, actorId, action, { version: store.booking.__v, ...input }),
    failWrite: () => { failWrite = true; } };
}
test('the current on-site job is excluded and every team member is checked at the Philippine current minute', async () => {
  const f = fixture(), plan = await f.read(); assert.equal(plan.canStart, true); assert.equal(plan.date, date);
  const checks = f.calls.filter(call => call[0] === 'slots'); assert.equal(checks.length, 2);
  for (const [, input, exclusions] of checks) { assert.equal(exclusions.excludeBookingId, bookingId); assert.equal(exclusions.ongoingStartMinutes, 544); assert.equal(exclusions.existingAppointment, true); assert.equal(input.date, date); }
  await f.act('start'); assert.equal(f.store.booking.status, 'repair_in_progress'); assert.equal(f.store.booking.repairExecution.status, 'in_progress');
  assert.equal(f.store.assignment.status, 'in_progress'); assert.ok(parseAppointmentTime(f.store.assignment.endTime) > 544);
  await assert.rejects(f.act('start'), /already started/);
});
test('arrival, Start Work, same-day schedule, acceptance and recorded customer consent remain required', async () => {
  for (const change of [f => { f.store.assignment.status = 'on_site'; }, f => { f.store.assignment.bookingDate = manilaDateTime('2026-10-20', 0); },
    f => { f.store.booking.approval.status = 'pending'; }, f => { f.store.booking.technicianTeam[1].status = 'pending'; }, f => { f.store.booking.quotationReview.status = 'pending'; }]) {
    const f = fixture(); change(f); const plan = await f.read(); assert.ok(plan.reasons.length || plan.requiresOnSiteConsent); await assert.rejects(f.act('start'), { status: plan.requiresOnSiteConsent && !plan.reasons.length ? 400 : 409 }); assert.ok(!f.calls.some(call => call[0] === 'booking-write'));
  }
  const f = fixture(); await assert.rejects(f.api.read(bookingId, support), { status: 403 });
});
test('a busy supporting member prevents same-day repair and a nearby purchase', async () => {
  const f = fixture({ part: true }); f.blocked.add(support); const plan = await f.read();
  assert.equal(plan.direct.available, false); assert.equal(plan.local.available, false);
  await assert.rejects(f.act('start'), /shift|conflict/);
});
test('warehouse quantities and packed-but-unissued kit items cannot stand in for parts brought to the site', async () => {
  const f = fixture({ part: true }); assert.equal((await f.read()).canStart, false);
  f.store.kit = { status: 'draft', items: [{ toolId, name: 'Capacitor', category: 'repair_part', quantity: 1, preparedChecked: true, bookingIds: [bookingId] }] };
  assert.equal((await f.read()).parts[0].missing, 1);
  f.store.kit.status = 'confirmed'; Object.assign(f.store.kit.items[0], { quantityIssued: 1, checkoutStatus: 'issued' });
  assert.equal((await f.read()).canStart, true);
  f.store.kit.items[0].returnPendingQuantity = 1; assert.equal((await f.read()).canStart, false);
});
async function planPurchase(f, purchaseBy = 'technician') {
  await f.act('plan-purchase', { customerAgreed: true, supplierCanProvide: true, supplierName: 'Nearby parts shop', purchaseBy,
    parts: [{ key: `id:${toolId}`, expectedPurchaseCost: 350 }] });
}
test('nearby technician purchase preserves the approved customer price and needs an owned receipt before start', async () => {
  const f = fixture({ part: true }), total = f.store.booking.quotation.totalCost;
  await planPurchase(f); assert.equal(f.store.booking.quotation.totalCost, total); assert.equal(f.store.booking.localPurchase[0].quantity, 1);
  assert.equal(f.store.booking.status, 'repair_approved'); assert.equal((await f.read()).canStart, false);
  await assert.rejects(f.act('start'), /not been brought/);
  await f.act('receipt', { key: `id:${toolId}`, receiptUrl: `/api/receipts/${id(8)}`, actualPurchaseCost: 375 });
  assert.equal(f.store.expenses.length, 1); assert.equal(f.store.expenses[0].status, 'pending'); assert.equal(f.store.expenses[0].amount, 375);
  assert.equal(f.store.booking.status, 'repair_approved', 'receipt must not start repair automatically');
  assert.equal((await f.read()).canStart, true); await f.act('start'); assert.equal(f.store.booking.status, 'repair_in_progress');
});
test('customer-provided parts require verification and create no company buying expense', async () => {
  const f = fixture({ part: true }); await planPurchase(f, 'customer');
  await assert.rejects(f.act('verify-customer-part', { key: `id:${toolId}`, correctPartVerified: false }), { status: 400 });
  await f.act('verify-customer-part', { key: `id:${toolId}`, correctPartVerified: true });
  assert.equal((await f.read()).canStart, true); assert.equal(f.store.expenses.length, 0);
});
test('stale snapshots, unknown parts, missing consent and unrelated receipts do not create purchases or costs', async () => {
  const f = fixture({ part: true });
  await assert.rejects(f.act('plan-purchase', { version: 99 }), /changed/);
  await assert.rejects(f.act('plan-purchase', { supplierName: 'Shop' }), { status: 400 });
  await assert.rejects(f.act('plan-purchase', { customerAgreed: true, supplierCanProvide: true, supplierName: 'Shop', purchaseBy: 'technician', parts: [{ key: 'unknown', expectedPurchaseCost: 20 }] }), { status: 409 });
  assert.equal(f.store.booking.localPurchase.length, 0);
  await planPurchase(f); f.deps.receipt = async () => ({ metadata: { uploadedBy: support } });
  const different = visit.createService(f.deps);
  await assert.rejects(different.act(bookingId, { _id: lead }, actorId, 'receipt', { version: 1, key: `id:${toolId}`, receiptUrl: `/api/receipts/${id(8)}`, actualPurchaseCost: 350 }), { status: 403 });
  assert.equal(f.store.expenses.length, 0);
});
test('a failed booking commit rolls the purchase expense back in the same transaction', async () => {
  const f = fixture({ part: true }); await planPurchase(f); f.failWrite();
  await assert.rejects(f.act('receipt', { key: `id:${toolId}`, receiptUrl: `/api/receipts/${id(8)}`, actualPurchaseCost: 350 }), { status: 409 });
  assert.equal(f.store.expenses.length, 0); assert.equal(f.store.booking.localPurchase[0].purchaseStatus, 'pending');
});
test('deferral closes only the current visit and preserves the approved quotation for the scheduling queue', async () => {
  const f = fixture({ part: true });
  await f.act('defer', { reason: 'There is not enough time for the missing parts today.', preferredDates: ['2026-10-20'], preferredTime: 'morning' });
  assert.equal(f.store.booking.status, 'repair_approved'); assert.equal(f.store.booking.repairSchedule.preference, 'later');
  assert.equal(f.store.booking.repairExecution.status, 'deferred'); assert.equal(f.store.assignment.status, 'completed');
  assert.equal(f.store.booking.approval.status, 'approved'); assert.equal(f.store.booking.quotation.totalCost, 800);
  assert.equal(f.store.booking.preferredSchedule.dates[0].toISOString(), '2026-10-19T16:00:00.000Z');
});
test('deferral validates dates and inspection payment; presentation contains no private booking record', async () => {
  const f = fixture();
  await assert.rejects(f.act('defer', { reason: 'No time', preferredDates: [date], preferredTime: 'any' }), { status: 400 });
  f.store.booking.inspectionFeeCollected = false;
  await assert.rejects(f.act('defer', { reason: 'No time', preferredDates: ['2026-10-20'], preferredTime: 'any' }), { code: 'PHASE_ONE_PAYMENT_REQUIRED' });
  const presented = visit.present(await f.read()); assert.equal(presented.booking, undefined); assert.equal(presented.assignment, undefined);
});

test('already received local parts are not requested from company inventory in a later daily kit', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../utils/dailyKitService'), 'utf8'), rows = [];
  const context = { hasScheduledRepairWork: () => true, resolvePartTool: async part => ({ _id: part.toolId }), mergeRequirement: (_map, row) => rows.push(row) };
  vm.runInNewContext(source.slice(source.indexOf('async function partRequirementsFor'), source.indexOf('async function requirementsFor')), context);
  await context.partRequirementsFor([{ _id: assignmentId, bookingId }], [{ _id: bookingId, quotation: { parts: [
    { name: 'Customer-provided capacitor', quantity: 1, source: 'external_purchase' },
    { name: 'Piping', quantity: 3, externalQuantity: 2, source: 'inventory', toolId },
  ] } }], new Map());
  assert.equal(rows.length, 1); assert.equal(rows[0].name, 'Piping'); assert.equal(rows[0].quantity, 1);
});

function pendingOnSite(f) {
  f.store.booking.status = 'awaiting_approval'; f.store.booking.approval.status = 'pending'; f.store.booking.quotationReview.status = 'pending';
  for (const item of f.store.booking.services) for (const unit of item.units || []) unit.repairReview = { state: 'staff_review', revision: 1 };
  return { customerAgreed: true, confirmedQuotationTotal: f.store.booking.quotation.totalCost };
}
test('reading a submitted on-site quotation previews time and parts without saving a customer decision', async () => {
  const f = fixture(); pendingOnSite(f); const before = structuredClone(f.store.booking);
  const plan = await f.read(); assert.equal(plan.requiresOnSiteConsent, true); assert.equal(plan.canStart, true); assert.equal(plan.confirmedQuotationTotal, 300);
  assert.deepEqual(f.store.booking, before); assert.ok(!f.calls.some(call => call[0] === 'booking-write'));
});
test('on-site Repair now records verbal approval and starts in one transaction without another admin confirmation', async () => {
  const f = fixture(), consent = pendingOnSite(f);
  await f.act('start', consent);
  assert.equal(f.store.booking.status, 'repair_in_progress'); assert.equal(f.store.booking.repairSchedule.preference, 'today');
  assert.equal(f.store.booking.approval.method, 'on_site'); assert.equal(f.store.booking.services[0].units[0].repairReview.state, 'approved');
  assert.equal(f.store.booking.repairExecution.status, 'in_progress'); assert.equal(f.store.booking.statusHistory.at(-1).fromStatus, 'awaiting_approval');
  assert.equal(f.store.booking.amountPaid, 500);
});
test('on-site Repair now still refuses missing tools, unreceived parts and an unavailable crew member', async () => {
  for (const blockedBy of ['kit', 'part', 'crew']) {
    const f = fixture({ part: blockedBy === 'part' }), consent = pendingOnSite(f);
    if (blockedBy === 'kit') f.store.kit = null;
    if (blockedBy === 'crew') f.blocked.add(support);
    await assert.rejects(f.act('start', consent), { status: 409 });
    assert.equal(f.store.booking.approval.status, 'pending'); assert.equal(f.store.booking.status, 'awaiting_approval');
  }
});
test('a pending or returned required tool cannot be used even when the daily kit says confirmed', async () => {
  const f = fixture(); f.store.kit.items = [{ category: 'equipment', source: 'standard', name: 'Multimeter', checkoutStatus: 'returned' }];
  assert.equal((await f.read()).toolsReady, false); await assert.rejects(f.act('start'), /tools/);
});
test('damaged, missing, and pending-return parts do not count as usable parts at the site', async () => {
  for (const field of ['quantityDamaged', 'quantityMissing', 'returnPendingQuantity']) {
    const f = fixture({ part: true });
    f.store.kit.items = [{ category: 'repair_part', name: 'Capacitor', toolId, bookingIds: [bookingId], checkoutStatus: 'issued', quantityIssued: 1, [field]: 1 }];
    assert.equal((await f.read()).parts[0].available, 0); assert.equal((await f.read()).canStart, false);
    await assert.rejects(f.act('start'), { status: 409 });
  }
});
test('on-site Repair later records the customer price acceptance and keeps the request in Repair Scheduling', async () => {
  const f = fixture(), consent = pendingOnSite(f);
  await f.act('defer', { ...consent, reason: 'The customer prefers a follow-up visit next day.', preferredDates: ['2026-10-20'], preferredTime: 'any' });
  assert.equal(f.store.booking.approval.method, 'on_site'); assert.equal(f.store.booking.repairSchedule.preference, 'later');
  assert.equal(f.store.assignment.status, 'completed'); assert.equal(f.store.booking.quotation.totalCost, 300);
});
test('on-site cancellation closes a paid inspection but preserves its money and physical stock custody', async () => {
  const f = fixture(), consent = pendingOnSite(f);
  await f.act('cancel-repair', { ...consent, reason: 'The customer chose to replace the appliance.' });
  assert.equal(f.store.booking.status, 'repair_declined'); assert.equal(f.store.booking.repairExecution.status, 'cancelled');
  assert.equal(f.store.booking.amountPaid, 500); assert.equal(f.store.booking.quotation.totalCost, 0); assert.equal(f.store.assignment.status, 'completed');
  assert.equal(f.store.kit.status, 'confirmed'); assert.equal(f.store.expenses.length, 0);
});
test('on-site cancellation requires the customer reason and does not close unpaid inspections', async () => {
  const f = fixture(), consent = pendingOnSite(f);
  await assert.rejects(f.act('cancel-repair', consent), { status: 400 });
  f.store.booking.inspectionFeeCollected = false;
  await assert.rejects(f.act('cancel-repair', { ...consent, reason: 'The customer chose to replace the appliance.' }), { code: 'PHASE_ONE_PAYMENT_REQUIRED' });
  assert.equal(f.store.booking.status, 'awaiting_approval'); assert.equal(f.store.assignment.status, 'in_progress');
});
test('a stale quotation total or failed write cannot partially record customer verbal consent', async () => {
  const f = fixture(), consent = pendingOnSite(f);
  await assert.rejects(f.act('start', { ...consent, confirmedQuotationTotal: 1 }), { status: 409 });
  f.failWrite(); await assert.rejects(f.act('start', consent), { status: 409 });
  assert.equal(f.store.booking.approval.status, 'pending'); assert.equal(f.store.booking.services[0].units[0].repairReview.state, 'staff_review');
});

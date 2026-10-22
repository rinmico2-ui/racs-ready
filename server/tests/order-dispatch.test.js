'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { orderAttentionState, orderDispatchWindow } = require('../utils/orderAttention');
const { departureCapacity, commitOrderDeparture } = require('../utils/orderDispatch');
const primary = '507f1f77bcf86cd799439011', support = '507f1f77bcf86cd799439012';
const now = new Date('2026-10-22T15:10:00Z');
function order() {
  return { _id: '507f1f77bcf86cd799439013', bookingId: '507f1f77bcf86cd799439014', status: 'technician_accepted',
    fulfillmentType: 'delivery_only', technicianId: primary, delivery: { preferredDate: '2026-10-22' }, timeSlot: '22:30',
    items: [{ quantity: 1 }], routeDurationMin: 5, preparation: { dispatch: { status: 'ready' } },
    technicianAcceptance: { status: 'accepted', respondedAt: '2026-10-22T14:59:00Z' },
    technicianTeam: [{ technicianId: primary, status: 'accepted', respondedAt: '2026-10-22T14:58:00Z' },
      { technicianId: support, status: 'accepted', respondedAt: '2026-10-22T14:59:00Z' }],
    statusHistory: [{ status: 'technician_assigned', timestamp: '2026-10-22T14:57:00Z' },
      { status: 'technician_accepted', timestamp: '2026-10-22T14:59:00Z' }] };
}
test('on-time whole-team acceptance gives a bounded departure window without changing the customer schedule', () => {
  const current = order(), before = structuredClone(current);
  const state = orderAttentionState(current, now);
  assert.equal(state.requestedScheduleAt, '2026-10-22T15:00:00.000Z');
  assert.equal(state.dispatchDeadlineAt, '2026-10-22T15:29:00.000Z');
  assert.equal(state.dispatchAcceptedAt, '2026-10-22T14:59:00.000Z');
  assert.equal(state.dispatchWindowExtended, true);
  assert.equal(state.isPastDate, false);
  assert.equal(orderAttentionState(current, new Date(state.dispatchDeadlineAt)).isPastDate, false);
  const expired = orderAttentionState(current, new Date('2026-10-22T15:29:00.001Z'));
  assert.equal(expired.isPastDate, true);
  assert.equal(expired.attentionType, 'dispatch_overdue');
  assert.deepEqual(current, before);
});
test('early acceptance keeps the original later cutoff', () => {
  const current = order();
  current.statusHistory = [];
  current.technicianTeam = [];
  current.technicianAcceptance.respondedAt = '2026-10-22T13:00:00Z';
  assert.equal(orderDispatchWindow(current, now).deadline.toISOString(), '2026-10-22T15:00:00.000Z');
});
test('staff preparation and repeated status notes cannot reset or revoke the accepted departure deadline', () => {
  const current = order();
  current.statusHistory.push({ status: 'technician_accepted', timestamp: now, note: 'Aircon prepared by staff.' });
  assert.equal(orderDispatchWindow(current, now).deadline.toISOString(), '2026-10-22T15:29:00.000Z');
  current.technicianAcceptance = {};
  current.technicianTeam.forEach(row => { delete row.respondedAt; });
  assert.equal(orderDispatchWindow(current, now).deadline.toISOString(), '2026-10-22T15:29:00.000Z');
});
test('operations opens dispatch recovery only after the accepted departure deadline', () => {
  const { orderResolutionCase } = require('../utils/resolutionCenter');
  const current = order();
  assert.equal(orderResolutionCase(current, now), null);
  const recovery = orderResolutionCase(current, new Date('2026-10-22T15:30:00Z'));
  assert.equal(recovery.issueType, 'dispatch_overdue');
  assert.equal(recovery.scheduledAt, '2026-10-22T15:29:00.000Z');
});
test('late, missing, future, stale and incomplete team responses cannot reopen the window', () => {
  const cases = [
    o => { o.technicianTeam[1].respondedAt = '2026-10-22T15:00:00.001Z'; },
    o => { o.statusHistory = []; o.technicianAcceptance = {}; o.technicianTeam = []; },
    o => { o.statusHistory = []; o.technicianAcceptance = {}; o.technicianTeam = [{ status: 'accepted', respondedAt: '2026-10-22T15:01:00Z' }]; },
    o => { o.statusHistory = [{ status: 'technician_assigned', timestamp: '2026-10-22T14:59:30Z' }]; },
    o => { o.technicianTeam[1].status = 'pending'; },
    o => { o.status = 'technician_assigned'; },
    o => { o.technicianId = null; },
  ];
  for (const change of cases) {
    const current = order(); change(current);
    assert.equal(orderDispatchWindow(current, now).extended, false);
    assert.equal(orderAttentionState(current, now).isPastDate, true);
  }
  assert.equal(orderDispatchWindow(order(), new Date('2026-10-22T14:58:30Z')).extended, false);
});
test('departure checks every crew member for a complete visit from actual departure time', async () => {
  const current = order(), calls = [];
  const capacity = await departureCapacity(current, { now, bufferMinutes: 45, slots: async (query, exclusions) => {
    calls.push({ query, exclusions }); return { statusCode: 200, payload: { timeSlots: [{ startTime: '23:10', available: true }] } };
  } });
  assert.deepEqual(calls.map(c => c.query.technicianId), [primary, support]);
  assert.equal(calls[0].query.duration, '60');
  assert.equal(calls[0].exclusions.assignmentStartMinutes, 1390);
  assert.equal(calls[0].exclusions.excludeBookingId, current.bookingId);
  assert.equal(capacity.endMinutes, 1500);
  assert.equal(current.timeSlot, '22:30');
});
test('a longer previous reservation is retained and an unavailable supporting technician blocks departure', async () => {
  const current = order();
  current.assignmentCapacity = { scheduleKey: require('../utils/standardJobTeam').scheduleKey('order', current), endMinutes: 1600 };
  const options = { now, bufferMinutes: 45, slots: async query => {
    assert.equal(query.duration, '160');
    return { statusCode: 200, payload: { timeSlots: [{ startTime: '23:10', available: query.technicianId !== support }] } };
  } };
  await assert.rejects(departureCapacity(current, options), e => e.code === 'ORDER_DISPATCH_CAPACITY_UNAVAILABLE');
  assert.equal(current.status, 'technician_accepted');
});
test('expired windows and another delivery date block departure before capacity checks', async () => {
  for (const reference of ['2026-10-22T15:29:00.001Z', '2026-10-21T15:00:00Z']) {
    await assert.rejects(departureCapacity(order(), { now: new Date(reference), slots: () => assert.fail('Must not check slots') }),
      e => ['ORDER_SCHEDULE_PASSED', 'ORDER_DISPATCH_DATE_REQUIRED'].includes(e.code));
  }
});

function transactionFixture() {
  let stored = order(), audits = [], mirrors = [], saves = 0, closed = 0;
  const session = { async withTransaction(work) {
    const before = structuredClone(stored), mirrorBefore = [...mirrors];
    try { await work(); } catch (e) { stored = before; mirrors = mirrorBefore; throw e; }
  }, async endSession() { closed++; } };
  const options = { mongoose: { connection: {}, startSession: async () => session },
    Order: { findById: () => ({ session: async supplied => {
      assert.equal(supplied, session);
      const current = structuredClone(stored);
      current.save = async opts => { assert.equal(opts.session, session); saves++; const { save, ...data } = current; stored = data; };
      return current;
    } }) },
    clock: () => now, bufferMinutes: 45,
    lock: async (key, work) => { assert.match(key, /2026-10-22/); return work(); },
    slots: async () => ({ statusCode: 200, payload: { timeSlots: [{ startTime: '23:10', available: true }] } }),
    audit: async entry => audits.push(entry),
  };
  const args = { order: structuredClone(stored), actor: { _id: primary, role: 'technician' }, note: 'Departing',
    syncLinked: async (current, supplied) => { assert.equal(supplied, session); mirrors.push(current.status); } };
  return { args, options, state: () => ({ stored, audits, mirrors, saves, closed }), mutate: fn => fn(stored) };
}
test('departure commits order, capacity and installation mirror together, then audits once', async () => {
  const f = transactionFixture();
  const saved = await commitOrderDeparture(f.args, f.options);
  assert.equal(saved.status, 'out_for_delivery');
  assert.equal(f.state().stored.assignmentCapacity.endMinutes, 1500);
  assert.equal(f.state().stored.timeSlot, '22:30');
  assert.deepEqual(f.state().mirrors, ['out_for_delivery']);
  assert.equal(f.state().audits.length, 1);
  assert.equal(f.state().closed, 1);
});
test('a failed installation mirror rolls back departure and sends no successful audit', async () => {
  const f = transactionFixture();
  f.args.syncLinked = async () => { throw new Error('Mirror failed'); };
  await assert.rejects(commitOrderDeparture(f.args, f.options), /Mirror failed/);
  assert.equal(f.state().stored.status, 'technician_accepted');
  assert.equal(f.state().stored.assignmentCapacity, undefined);
  assert.equal(f.state().audits.length, 0);
  assert.equal(f.state().closed, 1);
});
test('installation departure rechecks the saved kit inside the transaction before any writes', async () => {
  const f = transactionFixture();
  f.args.order.fulfillmentType = 'delivery_installation';
  f.mutate(o => { o.fulfillmentType = 'delivery_installation'; });
  f.args.kit = { _id: primary, status: 'confirmed' };
  let kitReads = 0;
  f.options.DailyKit = { findById: id => {
    assert.equal(id, primary); kitReads++;
    return { session: session => { assert.equal(typeof session.withTransaction, 'function'); return { lean: async () => ({ status: 'draft', technicianId: primary, items: [] }) }; } };
  } };
  await assert.rejects(commitOrderDeparture(f.args, f.options), e => e.code === 'ORDER_PREPARATION_REQUIRED');
  assert.equal(kitReads, 1);
  assert.equal(f.state().saves, 0);
  assert.equal(f.state().audits.length, 0);
});
test('stale assignments, expired windows, unavailable capacity and unprepared units never save departure', async () => {
  for (const condition of ['stale', 'expired', 'capacity', 'unit']) {
    const f = transactionFixture();
    if (condition === 'stale') f.mutate(o => { o.technicianId = support; });
    if (condition === 'expired') f.options.clock = () => new Date('2026-10-22T15:30:00Z');
    if (condition === 'capacity') f.options.slots = async () => ({ statusCode: 200, payload: { timeSlots: [] } });
    if (condition === 'unit') f.mutate(o => { o.preparation.dispatch.status = 'pending'; });
    await assert.rejects(commitOrderDeparture(f.args, f.options), e => e.status === 409);
    assert.equal(f.state().saves, 0, condition);
    assert.equal(f.state().audits.length, 0, condition);
    assert.equal(f.state().mirrors.length, 0, condition);
  }
});

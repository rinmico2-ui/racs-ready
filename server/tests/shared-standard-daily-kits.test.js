'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createService } = require('../utils/sharedStandardDailyKits');
const id = number => number.toString(16).padStart(24, '0');
const lead = id(1), support = id(2), bookingId = id(3), orderId = id(4), assignmentId = id(5), other = id(6);
const date = '2026-10-18', workDate = new Date(`${date}T00:00:00+08:00`);
const same = (a, b) => a == null && b == null || String(a) === String(b);
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const value = key.split('.').reduce((row, part) => row?.[part], row);
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) return Object.entries(expected).every(([op, operand]) => {
      if (op === '$in') return operand.some(entry => same(entry, value));
      if (op === '$nin') return !operand.some(entry => same(entry, value));
      if (op === '$ne') return !same(operand, value);
      if (op === '$gte') return value >= operand;
      if (op === '$lt') return value < operand;
      if (op === '$elemMatch') return (value || []).some(entry => matches(entry, operand));
      throw Error(`Unhandled operator ${op}`);
    });
    return same(value, expected);
  });
}
function fixture() {
  const team = [{ technicianId: lead, name: 'Primary technician', status: 'accepted' }, { technicianId: support, assignmentId, name: 'Support technician', status: 'accepted' }];
  const data = {
    Assignment: [{ _id: assignmentId, bookingId, technicianId: support, status: 'accepted', bookingDate: workDate, startTime: '08:00' }],
    Booking: [{ _id: bookingId, technicianId: lead, technicianTeam: structuredClone(team), bookingDate: workDate, startTime: '08:00', status: 'confirmed', bookingReference: 'BOOKING-1', serviceName: 'Aircon Cleaning' }],
    Order: [{ _id: orderId, technicianId: lead, technicianTeam: structuredClone(team), fulfillmentType: 'delivery_installation', delivery: { preferredDate: workDate }, status: 'technician_accepted', orderReference: 'ORDER-1' }],
    Kit: [{ _id: id(7), technicianId: lead, workDate, status: 'draft', items: [
      { name: 'Vacuum pump', quantity: 1, unit: 'pc', category: 'equipment', bookingIds: [bookingId], preparedChecked: false, toolId: other, resolution: { notes: 'Private operation notes' } },
      { name: 'Insulation', quantity: 4, unit: 'm', category: 'consumable', orderIds: [orderId], preparedChecked: true },
      { name: 'Unrelated job equipment', quantity: 8, bookingIds: [other], customerEmail: 'private@example.com' },
    ], deltaItems: [{ name: 'Additional tape', quantity: 1, orderIds: [orderId] }] }],
  };
  const calls = [];
  const deps = Object.fromEntries(Object.keys(data).map(model => [model, { find(filter) {
    calls.push({ model, filter });
    return { select() { return this; }, lean: async () => structuredClone(data[model].filter(row => matches(row, filter))) };
  } }]));
  return { data, calls, read: (who = support, when = date) => createService(deps).read(who, when) };
}

test('support receives one view-only primary kit for shared booking and order work, without unrelated items or private fields', async () => {
  const f = fixture(), result = await f.read();
  assert.equal(result.length, 1); assert.equal(result[0].readOnly, true); assert.equal(result[0].workDate, date);
  assert.equal(result[0].jobs.length, 2); assert.equal(result[0].items.length, 2); assert.equal(result[0].deltaItems.length, 1);
  assert.equal(result[0].items[0].preparedChecked, false);
  assert.doesNotMatch(JSON.stringify(result), /Unrelated|Private operation|private@example|toolId|customerEmail/);
  assert.equal(result[0]._id, undefined, 'shared projection is not another mutable kit');
  assert.equal(f.calls.filter(call => call.model === 'Kit').length, 1);
});

test('refresh reads primary packing and confirmation without updating or copying inventory', async () => {
  const f = fixture(); const before = structuredClone(f.data);
  await f.read(); assert.deepEqual(f.data, before);
  f.data.Kit[0].items[0].preparedChecked = true;
  f.data.Kit[0].items[0].checkoutStatus = 'checked_out';
  f.data.Kit[0].status = 'confirmed'; f.data.Kit[0].confirmedAt = workDate;
  const result = await f.read();
  assert.equal(result[0].items[0].preparedChecked, true); assert.equal(result[0].status, 'confirmed');
  assert.equal(result[0].items[0].checkoutStatus, 'checked_out');
  assert.ok(f.calls.every(call => ['Booking','Order','Assignment','Kit'].includes(call.model)));
});

test('support sees an explicit pending state when the automatic primary kit has not been generated yet', async () => {
  const f = fixture(); f.data.Kit = [];
  const [result] = await f.read(); assert.equal(result.status, 'pending'); assert.equal(result.readOnly, true); assert.deepEqual(result.items, []);
});

test('unassigned, declined and pending members cannot discover another primary kit', async () => {
  for (const state of ['pending', 'declined', 'expired']) {
    const f = fixture(); f.data.Booking[0].technicianTeam[1].status = state; f.data.Order[0].technicianTeam[1].status = state;
    assert.deepEqual(await f.read(), []); assert.ok(!f.calls.some(call => call.model === 'Kit'));
  }
  const f = fixture(); assert.deepEqual(await f.read(other), []); assert.deepEqual(await f.read(lead), []);
});

test('archived, rescheduled, project and cancelled jobs do not authorize shared kit access', async () => {
  for (const change of [{ archivedAt: workDate }, { bookingDate: new Date('2026-10-19T00:00:00+08:00') }, { isProject: true }, { status: 'cancelled' }, { startTime: '10:00' }, { continuation: { status: 'pending' } }]) {
    const f = fixture(); f.data.Order = []; Object.assign(f.data.Booking[0], change);
    assert.deepEqual(await f.read(), [], JSON.stringify(change));
  }
  const f = fixture(); assert.deepEqual(await f.read(support, '2026-10-19'), []);
  await assert.rejects(f.read(support, 'not-a-date'), { status: 400 });
});

test('a reassigned support record cannot read the former primary kit; linked order bookings do not duplicate jobs', async () => {
  const f = fixture(); f.data.Order = [];
  f.data.Booking[0].technicianTeam[1].assignmentId = other;
  assert.deepEqual(await f.read(), []);
  const second = fixture(); second.data.Booking[0].sourceOrderId = orderId;
  const [result] = await second.read(); assert.equal(result.jobs.length, 1); assert.equal(result.jobs[0].source, 'order');
});

test('supporting job actions link to the Manila work date and tolerate older rows without a date', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../public/js/standard-job-team'), 'utf8');
  const dates = source.slice(source.indexOf('  function kitDate('), source.indexOf('  const statusLabel'));
  const actions = source.slice(source.indexOf('  function assignmentActions('), source.indexOf('  function supportCard('));
  const emergency = source.slice(source.indexOf('  function emergencyAction('), source.indexOf('  function emergencyNotice('));
  const context = vm.createContext({ validId: value => /^[a-f\d]{24}$/i.test(value), escape: String, Intl, Date });
  vm.runInContext(dates + emergency + actions, context);
  assert.match(context.assignmentActions({ _id: assignmentId, status: 'accepted', bookingDate: '2026-10-17T16:30:00Z' }), /openTechnicianDailyKit\('2026-10-18'\)/);
  assert.match(context.assignmentActions({ _id: assignmentId, status: 'accepted' }), /View shared daily kit/);
  assert.doesNotMatch(context.assignmentActions({ _id: assignmentId, status: 'completed' }), /View shared daily kit/);
  assert.doesNotMatch(context.assignmentActions({ _id: assignmentId, status: 'pending_acceptance' }), /View shared daily kit/);
});

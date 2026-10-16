"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, continuationRequest, assertVisitActive } = require('../utils/workContinuation');
const { outstandingBookingBalance } = require('../utils/paymentSummary');
const mongoose = require('mongoose');
const B = '670000000000000000000001', A = '670000000000000000000002';
const T = '670000000000000000000003', O = '670000000000000000000004';
const details = { reason: 'Work cannot be safely completed today.', remainingWork: 'Finish pressure testing and commissioning.', remainingMinutes: 90 };
const query = value => ({ populate() { return this; }, lean: async () => structuredClone(value), then(resolve, reject) { return Promise.resolve(structuredClone(value)).then(resolve, reject); } });
function fixture(options = {}) {
  const rows = {
    booking: { _id: B, status: 'in-progress', assignmentId: A, technicianId: T, totalPrice: 9500, amountPaid: 3500, balanceAmount: 6000,
      services: [{ type: 'core', status: 'completed', unitPrice: 1200 }, { type: 'core', status: 'in_progress', unitPrice: 8300 }] },
    assignment: { _id: A, status: 'in_progress', bookingId: B, technicianId: T, serviceType: 'core', bookingDate: new Date(), arrivalProofUrl: '/proof/arrival.jpg' },
    order: { _id: O, status: 'installing', technicianId: T, bookingId: B, fulfillmentType: 'delivery_installation', total: 75000, amountPaid: 30000, balanceAmount: 45000 },
  };
  const writes = [], locks = [], exclusions = [];
  const model = key => ({ findById: id => query(String(id) === rows[key]?._id ? rows[key] : null) });
  const models = { Booking: model('booking'), Assignment: model('assignment'), Order: model('order') };
  const service = createService({ ...models, mongoose, Technician: { findById: () => query({ _id: T, name: 'Assigned technician', active: true, user: { role: 'technician', active: true } }) },
    lock: async (key, work) => { locks.push(key); return work(); },
    slots: async (input, trusted) => { exclusions.push(trusted); return { statusCode: 200, payload: { timeSlots: [{ available: true, startTime: '09:00' }] } }; },
    write: async changes => { writes.push(changes); return changes.map(change => {
      const key = Object.keys(models).find(key => models[key] === change.Model).toLowerCase();
      for (const [field, value] of Object.entries(change.set)) {
        const parts = field.split('.'); let obj = rows[key];
        while (parts.length > 1) { const part = parts.shift(); obj = obj[part] ||= {}; }
        obj[parts[0]] = structuredClone(value);
      }
      for (const field of Object.keys(change.unset || {})) delete rows[key][field];
      return structuredClone(rows[key]);
    }); }, ...options,
  });
  return { rows, writes, locks, exclusions, service };
}

for (const paymentMethod of ['cash', 'gcash', 'card', 'maya', 'bank_transfer', 'other']) {
  test(`${paymentMethod} partial walk-in balances remain payable before completion`, () => {
    assert.equal(outstandingBookingBalance({ totalPrice: 5000, amountPaid: 1000, balanceAmount: 4000, paymentMethod }), 4000);
    assert.equal(outstandingBookingBalance({ totalPrice: 5000, balanceAmount: 0, paymentMethod }, [{ status: 'pending', amount: 5000 }]), 5000);
  });
}
test('received ledger payments override stale snapshots and completed refunds restore the balance', () => {
  const booking = { totalPrice: 5000, amountPaid: 0, balanceAmount: 5000 };
  assert.equal(outstandingBookingBalance(booking, [{ status: 'verified', amount: 5000 }]), 0);
  assert.equal(outstandingBookingBalance(booking, [{ status: 'verified', amount: 5000, refundAmount: 1200 }]), 1200);
});

test('completion ignores an obsolete balance counter when the saved amount covers the full price', () => {
  assert.equal(outstandingBookingBalance({serviceType:'core',totalPrice:5000,amountPaid:5000,balanceAmount:5000,balanceCollected:false}),0);
  assert.equal(outstandingBookingBalance({serviceType:'core',totalPrice:5000,amountPaid:1000,balanceAmount:0,balanceCollected:true}),4000);
});

test('repair completion checks original visit charges plus the approved repair against actual payments', () => {
  const booking={serviceType:'repair',totalInitialCost:550,initialCost:500,travelFare:50,quotation:{totalCost:900},totalPrice:900,amountPaid:550};
  assert.equal(outstandingBookingBalance(booking,[{status:'verified',amount:550}]),900);
  assert.equal(outstandingBookingBalance(booking,[{status:'verified',amount:550},{status:'waiting_for_remittance',amount:900}]),0);
});
test('continuation requires a meaningful reason, work description and bounded duration', () => {
  for (const input of [{ ...details, reason: {} }, { ...details, remainingWork: 'x' }, { ...details, remainingMinutes: 14 }, { ...details, remainingMinutes: 481 }, { ...details, remainingMinutes: 30.5 }]) {
    assert.throws(() => continuationRequest(input), error => error.status === 400);
  }
});
test('a technician closes only their active visit and duplicate requests preserve history', async () => {
  const f = fixture();
  const first = await f.service.request('booking', A, T, details);
  assert.equal(first.continuation.status, 'pending');
  assert.equal(first.continuation.history[0].arrivalProofUrl, '/proof/arrival.jpg');
  assert.equal(f.rows.assignment.status, 'in_progress');
  assert.equal(f.rows.booking.services[0].status, 'completed');
  assert.equal(f.rows.booking.balanceAmount, 6000);
  assert.equal((await f.service.request('booking', A, T, details)).duplicate, true);
  assert.equal(f.writes.length, 1);
  assert.throws(() => assertVisitActive(f.rows.booking), /visit has ended/);
});
test('another technician cannot close or schedule somebody else’s active visit', async () => {
  const f = fixture();
  await assert.rejects(f.service.request('booking', A, O, details), error => error.status === 403);
  f.rows.assignment.status = 'accepted';
  await assert.rejects(f.service.request('booking', A, T, details), /Start the work/);
  assert.equal(f.writes.length, 0);
});
test('reassigned and project work cannot use ordinary visit continuation', async () => {
  const f = fixture(); f.rows.booking.technicianId = O;
  await assert.rejects(f.service.request('booking', A, T, details), /reassigned/);
  f.rows.booking.technicianId = T; f.rows.booking.isProject = true;
  await assert.rejects(f.service.request('booking', A, T, details), /project workflow/);
  f.rows.order.isProject = true;
  await assert.rejects(f.service.request('order', O, T, details), /project workflow/);
});
test('staff continuation rechecks live slots, excludes only its own work and preserves charges and finished services', async () => {
  const f = fixture(); await f.service.request('booking', A, T, details);
  const date = '2099-10-19'; const requestId = f.rows.booking.continuation.requestId;
  await f.service.availability('booking', B, { date });
  await f.service.schedule('booking', B, O, { date, requestId, startTime: '09:00', remainingMinutes: 120 });
  assert.equal(f.exclusions.length, 2); assert.equal(f.exclusions[1].excludeBookingId, B);
  assert.equal(f.rows.booking.status, 'confirmed'); assert.equal(f.rows.assignment.status, 'accepted');
  assert.equal(f.rows.booking.services[0].status, 'completed'); assert.equal(f.rows.booking.services[1].status, 'assigned');
  assert.equal(f.rows.booking.continuation.remainingMinutes, 120); assert.equal(f.rows.booking.endTime, '11:00');
  assert.equal(f.rows.assignment.arrivalProofUrl, undefined); assert.equal(f.rows.assignment.equipmentCheckedOut, false);
  assert.equal(f.rows.booking.totalPrice, 9500); assert.equal(f.rows.booking.amountPaid, 3500);
  assert.equal(f.rows.booking.continuation.history.length, 1);
  await assert.rejects(f.service.schedule('booking', B, O, { date, requestId, startTime: '09:00' }), /not awaiting/);
});
test('a stale preview cannot reserve a slot that has since become occupied', async () => {
  let open = true;
  const f = fixture({ slots: async () => ({ statusCode: 200, payload: { timeSlots: open ? [{ startTime: '09:00', available: true }] : [] } }) });
  await f.service.request('booking', A, T, details);
  await f.service.availability('booking', B, { date: '2099-10-19' }); open = false;
  await assert.rejects(f.service.schedule('booking', B, O, { date: '2099-10-19', requestId: f.rows.booking.continuation.requestId, startTime: '09:00' }), /no longer available/);
  assert.equal(f.writes.length, 1); assert.equal(f.rows.booking.continuation.status, 'pending');
});
test('unfinished installations resume with their linked booking and unchanged payment amounts', async () => {
  const f = fixture(); await f.service.request('order', O, T, details);
  const requestId = f.rows.order.continuation.requestId;
  await f.service.schedule('order', O, A, { date: '2099-10-19', requestId, startTime: '09:00' });
  assert.equal(f.rows.order.status, 'technician_accepted'); assert.equal(f.rows.booking.status, 'scheduled');
  assert.equal(f.rows.order.amountPaid, 30000); assert.equal(f.rows.order.balanceAmount, 45000);
  assert.equal(f.exclusions[0].excludeOrderId, O); assert.equal(f.exclusions[0].excludeBookingId, B);
});
for (const source of ['booking', 'order']) test(`a replacement technician must accept the ${source} continuation and customer snapshots follow the new assignee`, async () => {
  const f = fixture();
  await f.service.request(source, source === 'booking' ? A : O, T, details);
  const job = f.rows[source];
  await f.service.schedule(source, source === 'booking' ? B : O, A, { date: '2099-10-19', requestId: job.continuation.requestId, startTime: '09:00', technicianId: B });
  assert.equal(f.rows.booking.technicianId, B); assert.equal(String(f.rows.booking.technician._id), B);
  if (source === 'booking') { assert.equal(f.rows.assignment.status, 'pending_acceptance'); assert.equal(f.rows.booking.status, 'assigned'); assert.ok(f.rows.assignment.acceptanceDeadline > new Date()); }
  else { assert.equal(f.rows.order.status, 'technician_assigned'); assert.equal(f.rows.order.technicianAcceptance.status, 'pending'); }
});
test('repair continuation retains the repair phase instead of charging a new inspection', async () => {
  const f = fixture(); f.rows.assignment.serviceType = 'repair'; f.rows.booking.status = 'repair_in_progress';
  f.rows.booking.services = [{ type: 'repair', status: 'repair_in_progress', unitPrice: 9500 }];
  await f.service.request('booking', A, T, details);
  await f.service.schedule('booking', B, O, { date: '2099-10-19', requestId: f.rows.booking.continuation.requestId, startTime: '09:00' });
  assert.equal(f.rows.booking.status, 'repair_scheduled'); assert.equal(f.rows.booking.services[0].status, 'repair_scheduled');
  assert.equal(f.rows.booking.totalPrice, 9500);
});
for (const source of ['booking', 'order']) test(`${source} continuation keeps the team and requires everyone to accept the next visit`, async () => {
  const f = fixture(); const job = f.rows[source];
  job.technicianTeam = [{ technicianId: T, name: 'Primary', assignmentId: A, status: 'accepted' }, { technicianId: O, name: 'Supporting', assignmentId: '670000000000000000000099', status: 'accepted' }];
  await f.service.request(source, source === 'booking' ? A : O, T, details);
  const result = await f.service.schedule(source, source === 'booking' ? B : O, A, { date: '2099-10-19', startTime: '09:00', requestId: job.continuation.requestId });
  assert.equal(result.job._id, job._id);
  assert.ok(job.technicianTeam.every(row => row.status === 'pending' && row.deadlineAt));
  assert.equal(job.technicianTeam[1].technicianId, O); assert.equal(job.amountPaid, source === 'booking' ? 3500 : 30000);
  assert.equal(job.status, source === 'booking' ? 'assigned' : 'technician_assigned');
  if (source === 'booking') assert.equal(f.rows.assignment.status, 'pending_acceptance');
});
test('a continuation cannot use a slot when a supporting technician becomes unavailable', async () => {
  const f = fixture({ slots: async input => ({ statusCode: 200, payload: { timeSlots: [{ startTime: '09:00', available: input.technicianId !== O }] } }) });
  f.rows.booking.technicianTeam = [{ technicianId: T, status: 'accepted' }, { technicianId: O, status: 'accepted' }];
  await f.service.request('booking', A, T, details);
  const preview = await f.service.availability('booking', B, { date: '2099-10-19' });
  assert.equal(preview.timeSlots[0].available, false);
  await assert.rejects(f.service.schedule('booking', B, O, { date: '2099-10-19', startTime: '09:00', requestId: f.rows.booking.continuation.requestId }), /no longer available/);
  assert.equal(f.writes.length, 1); assert.equal(f.rows.booking.continuation.status, 'pending');
});

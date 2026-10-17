'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const Booking = require('../models/BookingService');
const { canTransitionServiceItem } = require('../utils/bookingServiceItems');

const routeFile = require.resolve('../routes/technicianApi');
const source = fs.readFileSync(routeFile, 'utf8').replace(/\r\n/g, '\n');
const actualRequire = createRequire(routeFile);
const id = number => number.toString(16).padStart(24, '0');
const snapshot = value => JSON.parse(JSON.stringify(value));
const query = value => ({ lean: async () => value, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });

function fixture({ coreStatus = 'in_progress', repairStatus = 'inspection_in_progress', bookingStatus = 'in-progress', evidence = false, balance = 0 } = {}) {
  const technician = { _id: id(1), name: 'Assigned technician' };
  const booking = new Booking({
    _id: id(2), technicianId: technician._id, serviceType: 'mixed', isMultiService: true,
    status: bookingStatus, bookingDate: new Date('2026-10-17'), paymentMethod: 'other', balanceAmount: balance,
    warranty: { startDate: new Date('2026-10-17'), endDate: new Date('2026-11-17') },
    ...(evidence ? { repairCompletion: { completedAt: new Date('2026-10-16') } } : {}),
    services: [
      { _id: id(3), name: 'Aircon cleaning', type: 'core', phase: 'core', status: coreStatus },
      { _id: id(4), name: 'Appliance repair', type: 'repair', phase: 'repair_phase_1', status: repairStatus,
        statusHistory: [{ status: repairStatus, changedAt: new Date('2026-10-17'), reason: 'Repair progress' }],
        quotation: { laborCost: 300, totalCost: 300 },
        units: [{ unitIndex: 1, label: 'Aircon', problemDescription: 'Not cooling', status: 'pending' }] },
    ],
  });
  const calls = { saves: [], assignmentUpdates: [], proofStores: 0 };
  booking.save = async () => { await booking.validate(); calls.saves.push(snapshot(booking)); return booking; };
  const models = {
    Technician: { findOne: () => query(technician) },
    BookingService: { findById: async () => booking },
    Payment: { find: () => query([]) },
    User: {},
    Assignment: {
      findById: () => query({ _id: id(5), bookingId: booking._id, technicianId: technician._id, status: 'in_progress' }),
      exists: async () => ({ _id: id(5) }),
      findOneAndUpdate: async (...args) => { calls.assignmentUpdates.push(args); return { _id: id(5) }; },
    },
  };
  async function update(endpoint, status, itemId = id(3)) {
    const path = endpoint === 'batch' ? '/appointments/:id/core-items/batch' : '/appointments/:id/service-items/:itemId/status';
    const begin = source.indexOf(`router.patch("${path}",`);
    assert.ok(begin >= 0);
    const start = source.indexOf('async (req, res, next) => {', begin);
    const end = source.indexOf('\n});', start);
    const handler = vm.runInNewContext('(' + source.slice(start, end + 2) + ')', {
      canTransitionServiceItem, console,
      configuredBookingWarranty: async () => ({ coverage: null }),
      require(name) {
        if (name.startsWith('../models/')) return models[name.split('/').at(-1)];
        if (name === '../utils/availability') return { resolveAvailabilityStatus: async () => 'Available' };
        if (name === '../utils/maintenanceLifecycle') return { syncMaintenanceFromBooking: async () => {} };
        return actualRequire(name);
      },
    });
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    let error;
    await handler({ params: { id: id(2), itemId }, body: { status }, user: { _id: id(6) }, app: { get: () => null } }, response, value => { error = value; });
    assert.ifError(error);
    return response;
  }
  async function submitProof() {
    const begin = source.indexOf('router.post("/assignments/:id/proof-of-completion",');
    const start = source.indexOf('async (req, res) => {', begin);
    const end = source.indexOf('\n});', start);
    let upload;
    const handler = vm.runInNewContext('(' + source.slice(start, end + 2) + ')', {
      console,
      proofUpload: (req, res, work) => { upload = work(null); },
      storeCompletionProof: async () => { calls.proofStores++; throw new Error('Proof storage must not run while service work is open'); },
      require(name) {
        if (name.startsWith('../models/')) return models[name.split('/').at(-1)];
        return actualRequire(name);
      },
    });
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ params: { id: id(5) }, body: {}, file: {}, user: { _id: id(6), role: 'technician' } }, response);
    await upload;
    return response;
  }
  return { booking, calls, update, submitProof };
}

for (const endpoint of ['single', 'batch']) {
  test(`${endpoint}: starting Core work preserves the entire Repair item`, async () => {
    const f = fixture({ coreStatus: 'arrived', repairStatus: 'inspection_scheduled' });
    const before = snapshot(f.booking.services[1]);
    const response = await f.update(endpoint, 'in_progress');
    assert.equal(response.statusCode, 200);
    assert.equal(f.booking.services[0].status, 'in_progress');
    assert.deepEqual(snapshot(f.booking.services[1]), before);
    assert.equal(f.calls.saves.length, 1);
    assert.equal(f.calls.assignmentUpdates.length, 0);
  });

  for (const state of [
    { repairStatus: 'inspection_in_progress' },
    { repairStatus: 'repair_in_progress', evidence: true, balance: 0 },
    { repairStatus: 'inspection_scheduled', bookingStatus: 'repair_completed' },
    { repairStatus: 'repair_approved', bookingStatus: 'under_warranty' },
  ]) {
    test(`${endpoint}: completing Core preserves ${state.repairStatus} despite ${state.bookingStatus || (state.evidence ? 'old repair evidence' : 'an active mixed visit')}`, async () => {
      const f = fixture({ balance: 500, ...state });
      const before = snapshot(f.booking.services[1]);
      const response = await f.update(endpoint, 'completed');
      assert.equal(response.statusCode, 200);
      assert.equal(f.booking.services[0].status, 'completed');
      assert.deepEqual(snapshot(f.booking.services[1]), before);
      assert.equal(response.body.allServicesCompleted, false);
      assert.equal(f.calls.saves.length, 1);
      assert.deepEqual(f.calls.saves[0].services[1], before);
      assert.equal(f.calls.assignmentUpdates.length, 0);
    });
  }

  for (const repairStatus of ['completed', 'repair_declined', 'cancelled']) {
    test(`${endpoint}: final Core completion preserves an already ${repairStatus} Repair item and closes the settled booking`, async () => {
      const f = fixture({ repairStatus, evidence: true });
      const before = snapshot(f.booking.services[1]);
      const response = await f.update(endpoint, 'completed');
      assert.equal(response.statusCode, 200);
      assert.deepEqual(snapshot(f.booking.services[1]), before);
      assert.equal(response.body.allServicesCompleted, true);
      assert.equal(response.body.hasDeclinedRepair, repairStatus !== 'completed');
      assert.equal(f.booking.status, 'completed');
      assert.equal(f.calls.assignmentUpdates.length, 1);
    });
  }

  test(`${endpoint}: the final Core item still requires collection when Repair is already complete`, async () => {
    const f = fixture({ repairStatus: 'completed', balance: 500 });
    const before = snapshot(f.booking.services[1]);
    const response = await f.update(endpoint, 'completed');
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'BOOKING_BALANCE_REQUIRED');
    assert.deepEqual(snapshot(f.booking.services[1]), before);
    assert.equal(f.calls.saves.length, 0);
    assert.equal(f.calls.assignmentUpdates.length, 0);
  });
}

for (const state of [
  {}, { evidence: true }, { bookingStatus: 'repair_completed' }, { bookingStatus: 'under_warranty' },
]) {
  test(`final proof cannot complete open Repair work using ${state.bookingStatus || (state.evidence ? 'old repair evidence' : 'completed Core work')}`, async () => {
    const f = fixture({ coreStatus: 'completed', ...state });
    const before = snapshot(f.booking.services[1]);
    const response = await f.submitProof();
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'MIXED_WORK_OPEN');
    assert.equal(response.body.openItems.length, 1);
    assert.equal(response.body.openItems[0].type, 'repair');
    assert.deepEqual(snapshot(f.booking.services[1]), before);
    assert.equal(f.calls.proofStores, 0);
    assert.equal(f.calls.saves.length, 0);
    assert.equal(f.calls.assignmentUpdates.length, 0);
  });
}

test('batch Core completion preserves other technicians and every Repair item', async () => {
  const f = fixture({ evidence: true });
  f.booking.services.push(
    { _id:id(7), type:'core', name:'Second cleaning', status:'in_progress' },
    { _id:id(8), type:'core', name:'Another technician cleaning', status:'in_progress', technicianId:id(9) },
    { _id:id(10), type:'repair', name:'Declined repair', status:'repair_declined', phase:'repair_phase_1' },
  );
  const untouched = f.booking.services.filter(row => row.type === 'repair' || String(row.technicianId) === id(9));
  const before = snapshot(untouched);
  const response = await f.update('batch', 'completed');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.updatedCount, 2);
  assert.deepEqual(snapshot(untouched), before);
  assert.equal(response.body.allServicesCompleted, false);
  assert.equal(f.calls.assignmentUpdates.length, 0);
});

for (const [repairStatus, nextStatus] of [['inspection_scheduled', 'inspection_in_progress'], ['repair_in_progress', 'completed']]) {
  test(`updating Repair to ${nextStatus} preserves unfinished Core work`, async () => {
    const f = fixture({ repairStatus });
    const before = snapshot(f.booking.services[0]);
    const response = await f.update('single', nextStatus, id(4));
    assert.equal(response.statusCode, 200);
    assert.equal(f.booking.services[1].status, nextStatus);
    assert.deepEqual(snapshot(f.booking.services[0]), before);
    assert.equal(response.body.allServicesCompleted, false);
    assert.equal(f.calls.assignmentUpdates.length, 0);
  });
}

'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const pricing = require('../public/js/repair-visit-payment');
const source = fs.readFileSync(require.resolve('../routes/technicianApi'), 'utf8');
const id = n => n.toString(16).padStart(24, '0');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(options = {}) {
  const routes = new Map(), events = [], photos = [], removed = [];
  let teamHooks;
  if (options.teamSize) {
    const schema = new (require('mongoose').Schema)();
    require('../utils/standardJobTeam').installHooks(schema, 'booking');
    teamHooks = schema.s.hooks;
  }
  let inTransaction = false;
  const state = { booking: { _id: id(1), technicianId: id(2), assignmentId: id(3), status: 'repair_in_progress', serviceType: options.mixed ? 'mixed' : 'repair',
    bookingDate: '2026-10-22', totalInitialCost: 550, initialCost: 500, travelFare: 50, amountPaid: 1450,
    quotation: { parts: [{ name: 'Approved capacitor', quantity: 1 }], laborCost: 500, totalCost: 900 },
    services: [{ type: 'repair', status: 'repair_in_progress' }, ...(options.mixed ? [{ type: 'core', status: options.coreStatus || 'in_progress' }] : [])],
    customer: { name: 'Customer' }, statusHistory: [], ...options.booking },
    assignment: { _id: id(3), bookingId: id(1), technicianId: id(2), status: 'in_progress', bookingDate: '2026-10-22' }, partUses: 0, consumableUses: 0 };
  if (options.teamSize) {
    state.booking.technicianTeam = [{ technicianId: id(2), assignmentId: id(3), status: 'accepted' }];
    state.supportAssignments = [];
    if (options.teamSize > 1) {
      state.booking.technicianTeam.push({ technicianId: id(4), assignmentId: id(5), status: 'accepted' });
      state.supportAssignments.push({ _id: id(5), bookingId: id(1), technicianId: id(4), status: 'in_progress' });
    }
    options.t.mock.method(require('../models/Assignment'), 'updateOne', async (filter, update, config) => {
      if (inTransaction) assert.equal(config.session, session);
      const assignment = [state.assignment, ...state.supportAssignments].find(row => row._id === String(filter._id));
      if (!assignment || filter.status.$nin.includes(assignment.status)) return { matchedCount: 0 };
      Object.assign(assignment, update.$set); events.push('team sync'); return { matchedCount: 1 };
    });
  }
  const query = value => ({ session() { return this; }, populate() { return this; }, lean() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  const session = { async withTransaction(work) {
    const before = clone(state); inTransaction = true;
    try {
      await work();
      if (options.retryOnce) {
        for (const key of Object.keys(state)) delete state[key]; Object.assign(state, clone(before));
        events.push('transient retry'); await work();
      }
      events.push('commit');
      if (options.uncertainCommit) throw Object.assign(Error('Commit confirmation delayed'), { hasErrorLabel: label => label === 'UnknownTransactionCommitResult' });
    }
    catch (error) { if (!error.hasErrorLabel?.('UnknownTransactionCommitResult')) { for (const key of Object.keys(state)) delete state[key]; Object.assign(state, before); events.push('rollback'); } throw error; }
    finally { inTransaction = false; }
  }, async endSession() {} };
  const models = {
    BookingService: { findById() {
      if (!state.booking) return query(null);
      Object.defineProperty(state.booking, 'save', { configurable: true, enumerable: false, value: async opts => {
        if (inTransaction) { assert.equal(opts.session, session); if (options.failSave) throw Object.assign(Error('Write failed'), { status: 409 }); }
        events.push('booking');
        if (teamHooks) {
          Object.defineProperty(state.booking, '$session', { configurable: true, enumerable: false, value: () => inTransaction ? session : null });
          await teamHooks.execPost('save', state.booking, [state.booking]);
        }
        return state.booking;
      } });
      return query(state.booking);
    } },
    Assignment: { findOne() { return query(options.reassigned ? null : state.assignment); }, async findOneAndUpdate(filter, update, opts) {
      assert.equal(opts.session, session); assert.equal(filter._id, id(3));
      if (options.assignmentConflict || state.assignment.status !== filter.status) return null;
      Object.assign(state.assignment, update.$set); events.push('assignment'); return state.assignment;
    } },
    Payment: { find: () => query([]) },
  };
  const inventory = { async plan() { return { parts: [{ name: 'Approved capacitor', quantity: 1, unit: 'pcs', missing: 0 }], consumables: [], equipmentCount: 1 }; },
    async record(input) { assert.equal(input.session, session); state.partUses++; return [{ name: 'Approved capacitor', quantity: 1, unit: 'pcs' }]; } };
  const context = { console, global: {}, router: {
    get(path, ...handlers) { routes.set('GET ' + path, handlers.at(-1)); }, post(path, ...handlers) { routes.set('POST ' + path, handlers.at(-1)); },
  }, mongoose: { isValidObjectId: () => true, startSession: async () => session }, proofUpload() {},
    Technician: { findOne: () => query({ _id: id(2), name: 'Technician' }) },
    storeCompletionProof: async () => { photos.push(id(7)); return { fileId: id(7) }; }, deleteCompletionProof: async file => removed.push(file),
    configuredBookingWarranty: async () => ({ coverage: null }),
    recordBookingConsumableUsage: async input => {
      assert.equal(input.session, session); assert.equal(input.completionStage, 'repair'); state.consumableUses++;
      if (options.badConsumable) throw Object.assign(Error('Usage exceeds issued quantity'), { status: 409 });
    },
    require(name) {
      if (name.startsWith('../models/')) return models[name.split('/').at(-1)];
      if (name.endsWith('/repairCompletionInventory')) return { createService: () => inventory };
      if (name.endsWith('/repairUnitWorkflow')) return { rows: () => options.unverifiedUnits ? [{ unit: { repairReview: { state: 'approved' } } }] : [] };
      if (name.endsWith('/customerCancellationPolicy')) return { assertNoHold() { if (options.cancellation) throw Object.assign(Error('Cancellation under review'), { status: 409 }); } };
      if (name.endsWith('/workContinuation')) return { assertVisitActive() {} };
      if (name.endsWith('/paymentSummary')) return { outstandingBookingBalance: booking => pricing.balance(booking).amountDue };
      if (name.endsWith('/maintenanceLifecycle')) return { syncMaintenanceFromBooking: async () => events.push('maintenance') };
      if (name.endsWith('/mailer')) return { sendRepairCompletedEmail: async () => assert.fail('No real email should be sent') };
      throw Error('Unexpected dependency: ' + name);
    },
  };
  const start = source.indexOf('// Read the exact approved parts');
  const end = source.indexOf('// POST /appointments/:id/scheduling-request', start);
  vm.runInNewContext(source.slice(start, end), context);
  const response = () => ({ statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  return { state, events, photos, removed, async complete(body = {}, file = {}) {
    const res = response();
    await routes.get('POST /appointments/:id/complete-repair')({ params: { id: id(1) }, user: { _id: id(2) }, body: { consumables: '[]', ...body }, file }, res);
    return res;
  }, async summary() {
    const res = response(); await routes.get('GET /appointments/:id/completion-summary')({ params: { id: id(1) }, user: { _id: id(2) } }, res, error => { throw error; }); return res;
  } };
}

test('photo completion uses approved parts and saves completion, assignment and usage in one transaction', async () => {
  const f = fixture(), res = await f.complete({ partsInstalled: [{ name: 'Unquoted equipment', quantity: 99 }], completionNotes: 'Repair tested.' });
  assert.equal(res.statusCode, 200); assert.equal(res.body.success, true); assert.equal(res.body.assignmentCompleted, true);
  assert.equal(f.state.booking.status, 'repair_completed'); assert.equal(f.state.assignment.status, 'completed');
  assert.equal(f.state.booking.repairCompletion.partsInstalled[0].name, 'Approved capacitor');
  assert.equal(f.state.partUses, 1); assert.equal(f.state.consumableUses, 1); assert.equal(f.removed.length, 0);
  assert.ok(f.events.indexOf('commit') < f.events.indexOf('maintenance'));
});

for (const teamSize of [1, 2]) test(`repair completion commits proof before the real booking hook closes a ${teamSize}-technician team`, async t => {
  const f = fixture({ teamSize, t }), res = await f.complete({ completionNotes: 'Repair and final tests complete.' });
  assert.equal(res.statusCode, 200, res.body?.error);
  assert.equal(res.body.assignmentCompleted, true);
  assert.equal(f.state.booking.status, 'repair_completed');
  assert.equal(f.state.assignment.status, 'completed');
  assert.ok(f.state.assignment.proofPhoto);
  assert.ok(f.state.supportAssignments.every(row => row.status === 'completed'));
  assert.equal(f.state.partUses, 1); assert.equal(f.state.consumableUses, 1);
  assert.equal(f.removed.length, 0); assert.ok(!f.events.includes('rollback'));
  const repeated = await f.complete();
  assert.equal(repeated.body.alreadyCompleted, true); assert.equal(f.photos.length, 1);
});

test('Repair completion keeps unfinished Core work and the shared assignment active', async () => {
  const f = fixture({ mixed: true }), res = await f.complete();
  assert.equal(res.body.assignmentCompleted, false); assert.equal(res.body.remainingCoreItems.length, 1);
  assert.equal(f.state.booking.status, 'in-progress'); assert.equal(f.state.booking.services[1].status, 'in_progress');
  assert.equal(f.state.assignment.status, 'in_progress'); assert.equal(f.state.booking.services[0].status, 'completed');
});

test('finishing Repair closes a mixed booking whose Core work is already complete', async () => {
  const f = fixture({ mixed: true, coreStatus: 'completed' }), res = await f.complete();
  assert.equal(res.body.assignmentCompleted, true); assert.equal(f.state.booking.status, 'completed'); assert.equal(f.state.assignment.status, 'completed');
});

test('failed consumable, booking or assignment writes roll back all completion usage and discard the new photo', async () => {
  for (const options of [{ badConsumable: true }, { failSave: true }, { assignmentConflict: true }]) {
    const f = fixture(options), res = await f.complete();
    assert.equal(res.statusCode, 409); assert.equal(f.state.booking.status, 'repair_in_progress');
    assert.equal(f.state.assignment.status, 'in_progress'); assert.equal(f.state.partUses, 0); assert.equal(f.state.consumableUses, 0);
    assert.equal(f.removed.length, 1); assert.ok(f.events.includes('rollback')); assert.ok(!f.events.includes('maintenance'));
  }
});

test('repeated repair completion cannot create another photo, part usage or maintenance cycle', async () => {
  const f = fixture(); await f.complete(); const events = [...f.events];
  const second = await f.complete(); assert.equal(second.body.alreadyCompleted, true);
  assert.equal(f.photos.length, 1); assert.equal(f.state.partUses, 1); assert.equal(f.state.consumableUses, 1); assert.deepEqual(f.events, events);
});

test('payment, cancellation, assignment and appliance-verification guards remain enforced', async () => {
  for (const options of [{ booking: { amountPaid: 100 } }, { cancellation: true }, { reassigned: true }, { booking: { technicianId: id(99) } },
    { booking: { repairUnitTracking: true }, unverifiedUnits: true }, { booking: { approval: { status: 'pending' } } }]) {
    const f = fixture(options), res = await f.complete(); assert.ok([403, 409].includes(res.statusCode));
    assert.equal(f.state.partUses, 0); assert.equal(f.state.assignment.status, 'in_progress');
  }
});

test('completion requires an uploaded image and accepts no arbitrary proof URL or manually typed parts', async () => {
  const missing = await fixture().complete({ proofUrl: '/uploads/proofs/other-technician.png' }, null);
  assert.equal(missing.statusCode, 400); assert.match(missing.body.error, /Choose a completion photo/);
});

test('transaction retry reuses the photo and records inventory once', async () => {
  const f = fixture({ retryOnce: true }), res = await f.complete();
  assert.equal(res.body.success, true); assert.equal(f.photos.length, 1); assert.equal(f.state.partUses, 1);
  assert.equal(f.state.consumableUses, 1); assert.ok(f.events.includes('transient retry'));
});

test('uncertain commit keeps its photo and asks for a status check before retrying', async () => {
  const f = fixture({ uncertainCommit: true }), res = await f.complete();
  assert.equal(res.statusCode, 503); assert.match(res.body.error, /Refresh the assignment/); assert.equal(f.removed.length, 0);
});

test('completion summary exposes only parts, issued consumables and the equipment custody note', async () => {
  const f = fixture(), res = await f.summary(); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.body.parts[0].name, 'Approved capacitor'); assert.equal(res.body.equipmentCount, 1);
  assert.equal(res.body.booking, undefined); assert.equal(res.body.customer, undefined); assert.equal(f.events.length, 0);
});

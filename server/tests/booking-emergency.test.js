'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createService, publish, reason } = require('../utils/bookingEmergency');
const Booking = require('../models/BookingService'), Assignment = require('../models/Assignment');
const Notification = require('../models/Notification');
const { atomicWorkflowChanges } = require('../utils/atomicWorkflowChanges');
const id = n => n.toString(16).padStart(24, '0');
const B = id(1), A = id(2), S = id(3), LEAD = id(4), SUPPORT = id(5), OWNER = id(6);
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
function fixture({ failAt = 0, single = false } = {}) {
  let store = { booking: { _id: B, __v: 0, updatedAt: '2026-10-19T00:00:00.000Z', bookingDate: '2099-10-19T00:00:00+08:00',
    status: 'on-the-way', serviceType: 'mixed', isMultiService: true, bookingReference: 'TEST-EMERGENCY',
    customerId: OWNER, technicianId: LEAD, assignmentId: A, technician: { name: 'Primary technician' },
    paymentMethod: 'gcash', paymentStatus: 'partial', amountPaid: 200, balanceAmount: 1200, totalPrice: 1400,
    downpaymentAmount: 200, paymentReference: 'DEMO-PAYMENT', notes: 'Keep customer instructions.',
    technicianTeam: [{ technicianId: LEAD, assignmentId: A, name: 'Primary technician', status: 'accepted' },
      ...single ? [] : [{ technicianId: SUPPORT, assignmentId: S, name: 'Supporting technician', status: 'accepted' }]],
    services: [{ _id: id(10), type: 'core', name: 'Cleaning', quantity: 1, status: 'en_route', technicianId: LEAD, assignmentId: A, totalPrice: 1000 },
      { _id: id(11), type: 'repair', name: 'Repair', quantity: 1, status: 'inspection_scheduled', technicianId: LEAD, assignmentId: A, totalPrice: 400,
        units: [{ unitIndex: 1, status: 'pending', problemDescription: 'Unit does not cool the room.', repairReview: { state: 'pending', revision: 0 } }] }], statusHistory: [] },
  assignments: [
    { _id: A, __v: 0, bookingId: B, technicianId: LEAD, serviceType: 'mixed', status: 'en_route', bookingDate: '2099-10-19', notes: [{ text: 'Original work note' }], equipmentCheckedOut: true },
    ...single ? [] : [{ _id: S, __v: 0, bookingId: B, technicianId: SUPPORT, crewRole: 'support', serviceType: 'mixed', status: 'en_route', bookingDate: '2099-10-19', notes: [] }],
  ] };
  const locks = [], writes = [];
  function match(row, filter) {
    return row && Object.entries(filter).every(([key, value]) => value?.$in ? value.$in.includes(row[key]) : JSON.stringify(row[key]) === JSON.stringify(value));
  }
  function query(value) { return { lean: async () => copy(value) }; }
  const models = {};
  function model(name, realModel) {
    return { findById: key => query((name === 'booking' ? [store.booking] : store.assignments).find(row => String(row._id) === String(key))),
      findOne: filter => query(store.assignments.find(row => match(row, filter))),
      find: filter => query(store.assignments.filter(row => match(row, filter))),
      async findOneAndUpdate(filter, update) {
        const row = (name === 'booking' ? [store.booking] : store.assignments).find(row => match(row, filter));
        if (!row) return null;
        writes.push({ name, update: copy(update) });
        if (writes.length === failAt) throw Error('Synthetic write failure');
        for (const [key, value] of Object.entries(update.$set || {})) {
          const parts = key.split('.'); let target = row;
          while (parts.length > 1) { const part = parts.shift(); target = target[part] ||= {}; }
          target[parts[0]] = copy(value);
        }
        for (const key of Object.keys(update.$unset || {})) delete row[key];
        row.__v += Number(update.$inc?.__v || 0);
        await realModel.hydrate(row).validate();
        return copy(row);
      },
    };
  }
  models.Booking = model('booking', Booking); models.Assignment = model('assignments', Assignment);
  const database = { Types: mongoose.Types, isValidObjectId: mongoose.isValidObjectId, connection: {},
    async startSession() { return { async withTransaction(fn) { const before = copy(store); try { await fn(); } catch (error) { store = before; throw error; } }, async endSession() {} }; } };
  const service = createService({ ...models, mongoose: database, write: changes => atomicWorkflowChanges(changes, database),
    lock: async (key, fn) => { locks.push(key); return fn(); }, now: () => new Date('2026-10-19T13:00:00Z') });
  return { get store() { return store; }, writes, locks, service,
    report: (support = false, input = { reason: 'emergency', details: 'Unexpected family emergency.' }) => service.report(support ? S : A,
      { _id: support ? SUPPORT : LEAD, name: support ? 'Supporting technician' : 'Primary technician' }, input, id(20)) };
}

for (const support of [false, true]) test(`${support ? 'supporting' : 'primary'} technician emergency atomically releases the complete current team`, async () => {
  const f = fixture();
  const result = await f.report(support);
  assert.equal(f.store.booking.status, 'pending_reassignment');
  assert.equal(f.store.booking.technicianId, null);
  assert.equal(f.store.booking.assignmentId, null);
  assert.deepEqual(f.store.booking.technicianTeam, []);
  assert.ok(f.store.assignments.every(row => row.status === 'cancelled'));
  assert.equal(result.incident.team.length, 2);
  assert.equal(result.incident.reporterRole, support ? 'support' : 'primary');
  assert.equal(f.store.booking.amountPaid, 200);
  assert.equal(f.store.booking.balanceAmount, 1200);
  assert.equal(f.store.booking.paymentStatus, 'partial');
  assert.equal(f.store.assignments[0].equipmentCheckedOut, true, 'Physical custody must not be invented or transferred');
  assert.match(f.store.booking.notes, /Keep customer instructions/);
  assert.equal(f.store.booking.services[0].status, 'awaiting_assignment');
  assert.equal(f.store.booking.services[1].status, 'inspection_pending');
  assert.equal(f.store.booking.cancellationHistory[0].action, 'emergency_reported');
  assert.match(f.locks[0], /2099-10-19/);
});
test('a repeated report by either released member does not duplicate history or change finances', async () => {
  const f = fixture(); await f.report(true); const after = copy(f.store);
  assert.equal((await f.report(true)).duplicate, true);
  assert.equal((await f.report(false)).duplicate, true);
  assert.deepEqual(f.store, after);
  assert.equal(f.writes.length, 3);
});
test('released service items can be assigned to a reviewed replacement crew without erasing finished work', async () => {
  const f = fixture();
  f.store.booking.services[0].status = 'completed';
  const finished = copy(f.store.booking.services[0]);
  await f.report(true);
  const team = require('../utils/standardJobTeam');
  const replacement = { _id: id(99), name: 'Replacement primary' };
  f.store.booking.technicianId = replacement._id; f.store.booking.assignmentId = id(98);
  team.assignServiceItems(f.store.booking, replacement);
  assert.deepEqual(f.store.booking.services[0], finished);
  assert.equal(f.store.booking.services[1].status, 'inspection_scheduled');
  assert.equal(f.store.booking.services[1].technicianId, replacement._id);
  assert.equal(f.store.booking.services[1].assignmentId, id(98));
  f.store.booking.technicianId = null;
  assert.equal(require('../utils/assignmentStaffing').staffingFor('booking', f.store.booking).recommendedCount, 2);
});
test('a failure while releasing the second member rolls back booking and every assignment', async () => {
  const f = fixture({ failAt: 3 }), before = copy(f.store);
  await assert.rejects(f.report(true), /Synthetic write failure/);
  assert.deepEqual(f.store, before);
});
test('admin can rebuild a paused en-route crew on a future slot through the actual team assignment writer', async t => {
  t.mock.method(require('../utils/audit'), 'logEvent', async () => {});
  const f = fixture(); f.store.booking.startTime='08:00'; f.store.booking.endTime='11:00'; f.store.booking.serviceDurationMinutes=120;
  await f.report(true);
  const cancelledIds=f.store.assignments.map(row=>row._id), replacement=id(99);
  const query=value=>({session(){return this;},lean:async()=>copy(value),then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}});
  function saved(Model,row,save) {
    if(!row)return null;
    const doc=Model.hydrate(copy(row));
    doc.save=async()=>{await doc.validate();save(copy(doc.toObject()));return doc;};
    return doc;
  }
  const BookingModel={findById:()=>query(saved(Booking,f.store.booking,row=>{f.store.booking=row;}))};
  class AssignmentModel {
    constructor(row) {return saved(Assignment,{_id:new mongoose.Types.ObjectId(),...row},value=>{f.store.assignments.push(value);});}
    static find(filter){return query(f.store.assignments.filter(row=>!filter.status.$nin.includes(row.status)));}
    static findById(key){return query(f.store.assignments.find(row=>row._id===String(key)));}
  }
  const manager=require('../utils/standardJobTeamService').createService({Booking:BookingModel,Assignment:AssignmentModel,
    mongoose:{isValidObjectId:mongoose.isValidObjectId,connection:{},startSession:async()=>({withTransaction:async fn=>fn(),endSession:async()=>{}})},
    lock:async(_key,fn)=>fn(),roster:async()=>[{_id:LEAD,name:'Previous primary',assignmentEligible:true},{_id:replacement,name:'Replacement support',assignmentEligible:true}],
    slots:async()=>({statusCode:200,payload:{timeSlots:[{startTime:'08:00',available:true}]}}),
  });
  await assert.rejects(manager.assign('booking',B,{technicianId:LEAD,technicianIds:[LEAD,replacement]}, {_id:id(20),name:'Admin'}), error=>error.code==='CUSTOMER_CONTACT_REQUIRED');
  f.store.booking.visitRecoveryHistory=[{requestId:'test-contact-agreement',incidentId:f.store.booking.staffingEmergencies.at(-1)._id,
    decision:'new_schedule',contactMethod:'call',customerConfirmed:true,date:f.store.booking.bookingDate,time:'08:00',
    notes:'Customer agreed to the replacement team.',recordedAt:new Date(),recordedBy:id(20),recordedByName:'Admin'}];
  await manager.assign('booking',B,{technicianId:LEAD,technicianIds:[LEAD,replacement],assignmentSource:'reviewed_plan'}, {_id:id(20),name:'Admin'});
  assert.equal(f.store.booking.technicianTeam.length,2);
  assert.ok(f.store.booking.technicianTeam.every(row=>row.status==='pending'));
  assert.ok(cancelledIds.every(key=>f.store.assignments.find(row=>row._id===key).status==='cancelled'));
  assert.equal(f.store.booking.staffingEmergencies.length,1);
  assert.equal(f.store.booking.amountPaid,200);assert.equal(f.store.booking.balanceAmount,1200);
  assert.equal(f.store.booking.services[0].status,'assigned');assert.equal(f.store.booking.services[1].status,'inspection_scheduled');
});
test('finished service evidence and a pending quotation retain their independent history', async () => {
  const f = fixture();
  f.store.booking.services[0].status = 'completed';
  f.store.booking.services[0].serviceReportId = id(100);
  f.store.booking.services[1].status = 'awaiting_quotation';
  f.store.booking.services[1].units[0].repairReview = { state: 'staff_review', revision: 2 };
  const before = copy(f.store.booking.services);
  await f.report();
  assert.deepEqual(f.store.booking.services, before);
});
test('repair follow-up emergencies preserve approved unit quotations and Phase 2', async () => {
  const f = fixture();
  const repair = f.store.booking.services[1];
  repair.status = 'repair_scheduled'; repair.phase = 'repair_phase_2';
  repair.units[0].repairReview = { state: 'approved', revision: 1 };
  await f.report();
  assert.equal(f.store.booking.services[1].status, 'ready_for_repair');
  assert.equal(f.store.booking.services[1].phase, 'repair_phase_2');
  assert.equal(f.store.booking.services[1].units[0].repairReview.state, 'approved');
});
test('single-technician and legacy assignments use the same recovery path', async () => {
  const f = fixture({ single: true }); delete f.store.booking.technicianTeam;
  await f.report();
  assert.equal(f.store.assignments[0].status, 'cancelled');
  assert.equal(f.store.booking.staffingEmergencies[0].team.length, 1);
});
test('another technician cannot report an emergency for an assignment they do not own', async () => {
  const f = fixture();
  await assert.rejects(f.service.report(A, { _id: SUPPORT, name: 'Other' }, { reason: 'emergency' }, id(20)), error => error.status === 404);
  assert.equal(f.writes.length, 0);
});
test('a stale accepted assignment cannot release a replacement team', async () => {
  const f = fixture(); f.store.booking.technicianTeam[1].assignmentId = id(77);
  await assert.rejects(f.report(true), error => error.status === 403);
  assert.equal(f.writes.length, 0);
});
test('a supporting technician cannot reset work that the primary already started', async () => {
  const f = fixture(); f.store.assignments[0].status = 'in_progress';
  await assert.rejects(f.report(true), /Continue on another visit/);
  assert.equal(f.writes.length, 0);
});
test('an in-progress service child cannot be reset even if assignment snapshots are stale', async () => {
  const f = fixture(); f.store.booking.services[0].status = 'in_progress';
  await assert.rejects(f.report(true), /Work has already started/);
  assert.equal(f.writes.length, 0);
});
test('an in-progress parent cannot be reset by stale accepted assignment snapshots', async () => {
  const f = fixture(); f.store.booking.status = 'in-progress';
  await assert.rejects(f.report(true), /Work has already started/);
  assert.equal(f.writes.length, 0);
});
function handlerFor(route, globals) {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../routes/technicianApi.js'), 'utf8');
  const begin = source.indexOf(route), start = source.indexOf('async (req, res, next) => {', begin);
  const end = source.indexOf('\n});', start);
  assert.ok(begin >= 0 && start > begin && end > start);
  return require('node:vm').runInNewContext('(' + source.slice(start, end + 2) + ')', { mongoose, ...globals });
}
for (const route of ['router.patch("/assignments/:id/status",', 'router.post("/repairs/:bookingId/status",']) {
  test(`${route}: generic cancellation cannot bypass whole-team emergency handling`, async () => {
    const handler = handlerFor(route, { require: name => name === 'mongoose' ? mongoose : {} });
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await handler({ params: { id: A, bookingId: B }, body: { status: 'cancelled' } }, res, error => { throw error; });
    assert.equal(res.code, 409); assert.equal(res.body.code, 'EMERGENCY_REPORT_REQUIRED');
  });
}
test('an emergency visit cannot be reclaimed from the available-jobs endpoint without admin review', async () => {
  const handler = handlerFor('router.post("/available-jobs/:bookingId/accept",', {
    Technician: { findOne: async () => ({ _id: LEAD }) },
    require(name) {
      if (name.endsWith('/Assignment')) return { countDocuments: async () => 0 };
      if (name.endsWith('/TechnicianSchedule')) return { findOne: () => ({ lean: async () => ({}) }) };
      if (name.endsWith('/BookingService')) return { findById: async () => ({ _id: B, status: 'pending_reassignment', technicianTeam: [], staffingEmergencies: [{}] }) };
      return {};
    },
  });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await handler({ params: { bookingId: B }, user: { _id: OWNER } }, res, error => { throw error; });
  assert.equal(res.code, 409); assert.equal(res.body.code, 'TEAM_REVIEW_REQUIRED');
});
test('invalid reasons and malformed details cannot cause any writes', () => {
  for (const input of [{ reason: 'invalid' }, { reason: 'emergency', details: {} }, { reason: 'other', details: 'x' }, { reason: 'weather', details: 'x'.repeat(501) }]) {
    assert.throws(() => reason(input), error => error.status === 400);
  }
});
test('supporting technicians can report an emergency through the team guard while work controls remain primary-only', async t => {
  const middleware = require('../utils/standardTeamMiddleware');
  const lead = { _id: LEAD }, support = { _id: SUPPORT };
  const job = { technicianId: LEAD, technicianTeam: [{ technicianId: LEAD, assignmentId: A, status: 'accepted' }, { technicianId: SUPPORT, assignmentId: S, status: 'accepted' }] };
  t.mock.method(Assignment, 'findById', () => ({ select() { return this; }, lean: async () => ({ _id: S, technicianId: SUPPORT, bookingId: B, status: 'en_route' }) }));
  t.mock.method(Booking, 'findById', () => ({ select() { return this; }, lean: async () => job }));
  t.mock.method(require('../models/Technician'), 'findOne', () => ({ lean: async () => support }));
  for (const action of ['emergency', 'cancel', 'status']) {
    let passed = false;
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await middleware({ params: { id: S }, user: { _id: id(90) }, method: 'POST', path: '/' + action, body: { status: 'en_route' } }, res,
      error => { if (error) throw error; passed = true; });
    assert.equal(passed, action !== 'status');
    if (action === 'status') assert.equal(res.body.code, 'PRIMARY_TECHNICIAN_REQUIRED');
  }
});
test('admin, all affected technician accounts and customer receive valid notifications after commit', async () => {
  const f = fixture(), result = await f.report(true), records = [], events = [];
  const deps = { Technician: { find: () => ({ select() { return this; }, lean: async () => [{ _id: LEAD, user: id(30) }, { _id: SUPPORT, user: id(31) }] }) },
    notify: async input => { await new Notification(input).validate(); records.push(input); }, publishWork: async value => events.push(value), syncEquipment: async () => {} };
  await publish(result, { app: { get: () => null } }, deps);
  assert.equal(records.length, 4);
  assert.equal(records.filter(row => row.role === 'admin').length, 1);
  assert.ok(records.some(row => String(row.userId) === id(30)));
  assert.ok(records.some(row => String(row.userId) === id(31)));
  assert.ok(records.some(row => String(row.userId) === OWNER));
  assert.match(records.find(row => row.role === 'admin').message, /supporting.*Unexpected family emergency/);
  assert.doesNotMatch(records.find(row => String(row.userId) === OWNER).message, /family/);
  assert.equal(events[0].reason, 'technician_emergency');
  records.length = 0;
  await publish({ ...result, duplicate: true }, { app: { get: () => null } }, deps);
  assert.equal(records.length, 0);
});
test('a notification failure does not suppress the other team notifications or the work update', async () => {
  const f = fixture(), result = await f.report(), recipients = [], events = [];
  await assert.rejects(publish(result, { app: { get: () => null } }, {
    Technician: { find: () => ({ select() { return this; }, lean: async () => [{ _id: SUPPORT, user: id(31) }] }) },
    notify: async input => { if (input.role === 'admin') throw Error('Synthetic notification failure'); recipients.push(input.userId); },
    publishWork: async input => events.push(input), syncEquipment: async () => {},
  }), /Synthetic notification failure/);
  assert.equal(recipients.length, 2);
  assert.equal(events.length, 1);
});

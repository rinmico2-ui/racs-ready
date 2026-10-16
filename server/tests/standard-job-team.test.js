'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const mongoose = require('mongoose');
const team = require('../utils/standardJobTeam');
const { createService } = require('../utils/standardJobTeamService');
const Booking = require('../models/BookingService'), Assignment = require('../models/Assignment'), Order = require('../models/Order');
require('../models/User');
const id = number => number.toString(16).padStart(24, '0');
const lead = id(1), support = id(2), customer = id(3), bookingId = id(4), orderId = id(5);
const copy = value => structuredClone(value);
function query(value) { const result = { session() { return result; }, select() { return result; }, populate() { return result; }, lean: async () => value, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; return result; }
function fixture({ source = 'booking', unavailable, failWrite = 0, standalone = false } = {}) {
  const store = { bookings: new Map(), orders: new Map(), assignments: new Map() }, events = [], checks = [];
  let writes = 0, sequence = 100;
  class Document {
    constructor(input = {}) { Object.assign(this, copy(input)); this._id ||= id(sequence++); }
    toObject() { return copy({ ...this }); }
    recordStatusHistory(event) { (this.statusHistory ||= []).push(event); }
    pushStatus(status, note) { this.status = status; (this.statusHistory ||= []).push({ status, note }); }
  }
  function model(name, RealModel) {
    return class extends Document {
      static findById(key) { const value = store[name].get(String(key)); return query(value ? new this(value) : null); }
      static find() { return query([...store[name].values()].map(row => new this(row))); }
      static async updateOne(filter, update) { const record = store[name].get(String(filter._id)); if (!record || filter.status && typeof filter.status === 'string' && record.status !== filter.status) return { matchedCount: 0 }; Object.assign(record, copy(update.$set || {})); return { matchedCount: 1 }; }
      async save() {
        if (++writes === failWrite) throw Error('Synthetic write failure');
        const document = RealModel.hydrate(this.toObject());
        await document.validate(name === 'assignments' ? ['technicianId','bookingId','crewRole','status','notes'] : ['technicianId','technicianTeam','status']);
        store[name].set(String(this._id), this.toObject()); return this;
      }
    };
  }
  const models = { Booking: model('bookings', Booking), Order: model('orders', Order), Assignment: model('assignments', Assignment) };
  const job = source === 'booking' ? { _id: bookingId, customerId: customer, customer: { name: 'Synthetic customer' }, bookingReference: 'DEMO-TEAM', status: 'awaiting_assignment', serviceType: 'core', services: [{ name: 'Cleaning', type: 'core', status: 'pending', quantity: 1 }],
    bookingDate: new Date('2099-01-05T00:00:00+08:00'), startTime: '08:00', endTime: '10:00', serviceDurationMinutes: 90, totalPrice: 1500, downpaymentAmount: 150, amountPaid: 150, balanceAmount: 1350, paymentStatus: 'partial', updatedAt: new Date('2098-01-01') }
    : { _id: orderId, userId: customer, customer: { name: 'Synthetic customer' }, orderReference: 'ORD-TEAM', status: 'preparing_unit', fulfillmentType: 'delivery_installation', paymentStatus: 'paid', total: 25000, installationFee: 1000,
      delivery: { preferredDate: new Date('2099-01-05T00:00:00+08:00'), address: 'Cabanatuan, Nueva Ecija' }, timeSlot: '08:00', items: [{ quantity: 1 }], updatedAt: new Date('2098-01-01') };
  store[source === 'booking' ? 'bookings' : 'orders'].set(String(job._id), copy(job));
  const technicians = [lead, support].map((_id, index) => ({ _id, name: index ? 'Support technician' : 'Primary technician', active: true, user: { _id: id(20 + index), role: 'technician', active: true } }));
  const deps = { ...models, Technician: { find: filter => query(technicians.filter(row => !filter._id || filter._id.$in.includes(row._id))) }, lock: async (key, work) => { events.push(key); return work(); },
    mongoose: { isValidObjectId: mongoose.isValidObjectId, connection: standalone ? { getClient: () => ({ topology: { description: { servers: new Map([['local', { type: 'Standalone' }]]) } } }) } : {},
      startSession: async () => ({ async withTransaction(work) { const snapshot = copy(store); events.push('start'); try { await work(); events.push('commit'); } catch (error) { for (const key of Object.keys(store)) store[key] = snapshot[key]; events.push('abort'); throw error; } }, endSession: async () => events.push('end') }) },
    slots: async (input, exclusions) => { checks.push({ input, exclusions }); return { statusCode: 200, payload: { timeSlots: [{ startTime: '08:00', available: input.technicianId !== unavailable }] } }; },
  };
  const service = createService(deps);
  return { service, store, events, checks, job, source, assign: input => service.assign(source, job._id, input || { technicianId: lead, technicianIds: [lead, support] }, { _id: id(9), name: 'Admin', role: 'admin' }), get current() { return store[source === 'booking' ? 'bookings' : 'orders'].get(String(job._id)); } };
}

test('one or multiple selections require a real primary member and reject duplicates or malformed IDs', () => {
  assert.deepEqual(team.normalize({ technicianId: lead }), [lead]);
  assert.deepEqual(team.normalize({ technicianId: lead, technicianIds: [support, lead] }), [lead, support]);
  for (const technicianIds of [[], [lead, lead], [support], ['invalid'], Array(11).fill(lead), {}, [null]]) assert.throws(() => team.normalize({ technicianId: lead, technicianIds }), /Choose/);
});
test('team assignment creates separate technician invitations and one booking without duplicating money', async () => {
  const f = fixture(), result = await f.assign();
  assert.equal(f.store.bookings.size, 1); assert.equal(f.store.assignments.size, 2);
  assert.equal(result.job.technicianId, lead); assert.equal(result.job.technicianTeam.length, 2);
  assert.equal([...f.store.assignments.values()].filter(row => row.crewRole === 'support')[0].servicePrice, 0);
  for (const field of ['totalPrice','amountPaid','balanceAmount','paymentStatus']) assert.equal(f.current[field], f.job[field]);
  assert.equal(f.current.isProject, undefined); assert.equal(f.current.services[0].quantity, 1);
  assert.deepEqual(f.checks.map(row => row.input.technicianId).sort(), [lead,support]);
});
test('the same assignment service accepts one technician and retains single-primary compatibility', async () => {
  const f = fixture(); await f.assign({ technicianId: lead, technicianIds: [lead] });
  assert.equal(f.store.assignments.size, 1); assert.equal(f.current.technicianTeam.length, 1);
  assert.equal(team.readiness(f.current).ready, false); assert.equal(f.current.technicianId, lead);
});

for (const source of ['booking', 'order']) {
  test(`${source}: a reviewed installation cannot bypass crew size by posting only the primary`, async () => {
    const f = fixture({ source });
    if (source === 'booking') { f.current.service = { name: 'Aircon Installation' }; f.current.services = []; }
    await assert.rejects(f.assign({ technicianId: lead, technicianIds: [lead], assignmentSource: 'reviewed_plan' }), error => error.code === 'INCOMPLETE_RECOMMENDED_TEAM');
    assert.equal(f.store.assignments.size, 0); assert.equal(f.current.technicianId, undefined);
  });
  test(`${source}: reviewed full crew uses one transaction, invites both members and preserves money`, async () => {
    const f = fixture({ source });
    await f.assign({ technicianId: lead, technicianIds: [lead, support], assignmentSource: 'reviewed_plan', responseMinutes: 120 });
    assert.equal(f.current.technicianTeam.length, 2); assert.ok(f.events.includes('commit'));
    assert.ok(f.current.technicianTeam.every(row => row.status === 'pending'));
    if (source === 'booking') {
      assert.equal(f.store.assignments.size, 2); assert.equal(f.current.totalPrice, f.job.totalPrice);
      assert.equal([...f.store.assignments.values()][0].responseSLAMinutes, 120);
    } else { assert.equal(f.store.bookings.size, 1); assert.equal(f.current.total, f.job.total); }
  });
  test(`${source}: unavailable support prevents reviewed assignment without a partial crew`, async () => {
    const f = fixture({ source, unavailable: support });
    await assert.rejects(f.assign({ technicianId: lead, technicianIds: [lead, support], assignmentSource: 'reviewed_plan' }), /no longer available/);
    assert.equal(f.store.assignments.size, 0); assert.equal(f.current.technicianId, undefined);
  });
  test(`${source}: AI confirmation cannot overwrite a job already assigned after preview`, async () => {
    const f = fixture({ source }); await f.assign();
    await assert.rejects(f.assign({ technicianId: lead, technicianIds: [lead, support], assignmentSource: 'reviewed_plan' }), /already been assigned/);
  });
  test(`${source}: changing the schedule after AI preview prevents confirmation`, async () => {
    const f = fixture({ source });
    await assert.rejects(f.assign({ technicianId: lead, technicianIds: [lead, support], assignmentSource: 'reviewed_plan', expectedSchedule: 'old-date|old-time' }), error => error.code === 'ASSIGNMENT_SCHEDULE_CHANGED');
    assert.equal(f.store.assignments.size, 0); assert.equal(f.current.technicianId, undefined);
  });
}
test('staff can explicitly choose one technician when manually reviewing an installation', async () => {
  const f = fixture({ source: 'order' });
  await f.assign({ technicianId: lead, technicianIds: [lead], notes: 'Staff reviewed staffing for this visit.' });
  assert.equal(f.current.technicianTeam.length, 1); assert.equal(f.store.bookings.size, 1);
});
test('unavailable supporting technician blocks the whole assignment before any write', async () => {
  const f = fixture({ unavailable: support }); await assert.rejects(f.assign(), /no longer available/);
  assert.equal(f.store.assignments.size, 0); assert.equal(f.current.status, 'awaiting_assignment');
});
test('failed middle and final writes roll back the whole team and original job', async () => {
  for (const failWrite of [1,2,3]) { const f = fixture({ failWrite }); await assert.rejects(f.assign(), /write failure/); assert.equal(f.store.assignments.size, 0); assert.equal(f.current.status, 'awaiting_assignment'); assert.ok(f.events.includes('abort')); }
});
test('one member accepting does not make the team ready; retries are idempotent', async () => {
  const f = fixture(); await f.assign();
  const first = await f.service.respond('booking', bookingId, lead, 'accept');
  assert.equal(first.job.status, 'assigned'); assert.equal(team.readiness(first.job).ready, false);
  assert.equal((await f.service.respond('booking', bookingId, lead, 'accept')).duplicate, true);
  const second = await f.service.respond('booking', bookingId, support, 'accept');
  assert.equal(second.job.status, 'confirmed'); assert.equal(team.readiness(second.job).ready, true);
  assert.ok([...f.store.assignments.values()].every(row => row.status === 'accepted'));
});
test('supporting technician decline preserves the primary assignment and blocks dispatch', async () => {
  const f = fixture(); await f.assign(); await f.service.respond('booking', bookingId, lead, 'accept');
  const result = await f.service.respond('booking', bookingId, support, 'decline', 'Unavailable');
  assert.equal(result.job.technicianId, lead); assert.equal(result.job.technicianTeam[1].status, 'declined');
  assert.throws(() => team.assertReady(result.job), /whole team/);
  assert.equal(f.store.assignments.get(String(result.job.assignmentId)).status, 'accepted');
});
test('expired and foreign responses cannot accept a team invitation', async () => {
  const f = fixture(); await f.assign();
  await assert.rejects(f.service.respond('booking', bookingId, id(88), 'accept'), /no longer assigned/);
  f.current.technicianTeam[1].deadlineAt = new Date('2000-01-01');
  await assert.rejects(f.service.respond('booking', bookingId, support, 'accept'), /no longer available/);
});
test('installation teams create one linked booking and leave the order amounts and quantities unchanged', async () => {
  const f = fixture({ source: 'order' }); const result = await f.assign();
  assert.equal(f.store.orders.size, 1); assert.equal(f.store.bookings.size, 1);
  assert.equal(f.store.assignments.size, 0); assert.equal(result.job.technicianTeam.length, 2);
  assert.equal(f.current.total, 25000); assert.equal(f.current.items[0].quantity, 1);
  const mirror = [...f.store.bookings.values()][0]; assert.equal(String(mirror.sourceOrderId), orderId); assert.equal(mirror.technicianTeam.length, 2);
});
test('installation acceptance waits for all members and a decline is visible without removing the primary', async () => {
  const f = fixture({ source: 'order' }); await f.assign();
  await f.service.respond('order', orderId, lead, 'accept'); assert.equal(f.current.status, 'technician_assigned');
  await f.service.respond('order', orderId, support, 'accept'); assert.equal(f.current.status, 'technician_accepted');
});
test('single-technician historical jobs and membership checks retain existing ownership', () => {
  assert.deepEqual(team.ids({ technicianId: lead }), [lead]);
  assert.equal(team.isPrimary({ technicianId: lead }, support), false);
  assert.deepEqual(team.ids({ technicianId: null, technicianTeam: [{ technicianId: support }] }), []);
});
test('capacity expansion includes every member once without multiplying transaction documents', () => {
  const source = { _id: bookingId, technicianId: lead, totalPrice: 1500, technicianTeam: [{ technicianId: lead }, { technicianId: support }] };
  const rows = team.capacityRows([source]); assert.deepEqual(rows.map(row => row.technicianId), [lead,support]); assert.equal(source.technicianTeam.length, 2);
});
test('the team API fails closed on a standalone database before inserting invitations', async () => {
  const f = fixture({ standalone: true }); await assert.rejects(f.assign(), /replica set/); assert.equal(f.store.assignments.size, 0);
});
test('started jobs cannot have their technician team replaced', async () => {
  const f = fixture(); f.current.status = 'in-progress'; await assert.rejects(f.assign(), /before work starts/); assert.equal(f.store.assignments.size, 0);
});

for (const source of ['booking', 'order']) {
  test(`${source}: a single technician decline cannot confirm the job`, async () => {
    const f = fixture({ source }); await f.assign({ technicianId: lead, technicianIds: [lead] });
    await f.service.respond(source, f.job._id, lead, 'decline', 'Unable to attend');
    assert.equal(f.current.status, source === 'booking' ? 'pending_reassignment' : 'technician_declined');
    assert.equal(team.readiness(f.current).ready, false);
  });
  test(`${source}: accepted members may record notes; other accounts and pending members cannot`, async () => {
    const f = fixture({ source }); await f.assign();
    await assert.rejects(f.service.addNote(source, f.job._id, support, 'Work noted'), error => error.status === 403);
    await f.service.respond(source, f.job._id, support, 'accept');
    await f.service.addNote(source, f.job._id, support, 'Checked the installation route.');
    assert.equal(f.current.technicianTeam[1].workNotes[0].text, 'Checked the installation route.');
    await assert.rejects(f.service.addNote(source, f.job._id, id(99), 'Work noted'), error => error.status === 403);
    await assert.rejects(f.service.addNote(source, f.job._id, support, {}), error => error.status === 400);
  });
}
test('new order installation mirrors pass the full booking schema without a second payment obligation', async () => {
  const f = fixture({ source: 'order' }); await f.assign();
  const mirror = Booking.hydrate([...f.store.bookings.values()][0]);
  await mirror.validate(); assert.equal(mirror.paymentMethod, 'other');
  assert.equal(mirror.sourceOrderId.toString(), orderId);
});
test('staff can choose the installation schedule while assigning an order', async () => {
  const f = fixture({ source: 'order' }); await f.assign({ technicianId: lead, technicianIds: [lead, support], scheduledDate: '2099-01-06', timeSlot: '08:00' });
  assert.equal(require('../utils/bookingDateTime').manilaDateKey(f.current.delivery.preferredDate), '2099-01-06');
  assert.equal(f.current.timeSlot, '08:00'); assert.ok(f.checks.every(row => row.input.date === '2099-01-06'));
});
test('changing the team during an approved repair preserves its repair phase', async () => {
  const f = fixture(); f.current.status = 'repair_scheduled'; f.current.serviceType = 'repair';
  await f.assign(); assert.equal(f.current.status, 'repair_scheduled');
});
test('legacy repair service models remain inspections when assigning a new team', async () => {
  const f = fixture(); f.current.serviceType = 'core'; f.current.serviceModel = 'RepairService'; f.current.services = [];
  await f.assign(); assert.equal(f.current.serviceType, 'repair'); assert.equal(f.current.status, 'inspection_scheduled');
  assert.ok([...f.store.assignments.values()].every(row => row.serviceType === 'repair'));
});
for (const source of ['booking', 'order']) {
  function scheduledJob() {
    const job = fixture({ source }).job; job.technicianId = lead;
    job.technicianTeam = [lead, support].map((technicianId, i) => ({ technicianId, assignmentId: id(100 + i), status: 'accepted', name: i ? 'Supporting' : 'Primary' }));
    job.technicianTeamSchedule = team.scheduleKey(source, job);
    if (source === 'booking') job.bookingDate = new Date('2099-01-06T00:00:00+08:00'); else job.delivery.preferredDate = new Date('2099-01-06T00:00:00+08:00');
    return job;
  }
  test(`${source}: rescheduling checks every member and resets every acceptance`, async () => {
    const job = scheduledJob(), checks = [];
    await team.prepareSchedule(source, job, async (input, exclusions) => { checks.push({ input, exclusions }); return { statusCode: 200, payload: { timeSlots: [{ available: true, startTime: '08:00' }] } }; });
    assert.deepEqual(checks.map(row => row.input.technicianId), [lead, support]);
    assert.ok(job.technicianTeam.every(row => row.status === 'pending' && row.deadlineAt));
    assert.equal(job.technicianTeamSchedule, team.scheduleKey(source, job)); assert.equal(team.readiness(job).ready, false);
  });
  test(`${source}: a reschedule conflict leaves the original acceptance intact`, async () => {
    const job = scheduledJob();
    await assert.rejects(team.prepareSchedule(source, job, async input => ({ statusCode: 200, payload: { timeSlots: [{ available: input.technicianId !== support, startTime: '08:00' }] } })), /unavailable at the new time/);
    assert.ok(job.technicianTeam.every(row => row.status === 'accepted'));
  });
  test(`${source}: status-only saves do not reset acceptance or recalculate availability`, async () => {
    const job = scheduledJob(); job.technicianTeamSchedule = team.scheduleKey(source, job);
    await team.prepareSchedule(source, job, () => assert.fail('No schedule check for unchanged date/time'));
    assert.ok(job.technicianTeam.every(row => row.status === 'accepted'));
  });
  test(`${source}: a failed schedule check cannot silently approve a team move`, async () => {
    await assert.rejects(team.prepareSchedule(source, scheduledJob(), async () => ({ statusCode: 503 })), error => error.status === 503);
  });
}

for (const status of ['on-the-way', 'in-progress', 'completed', 'cancelled']) {
  test(`booking model hook synchronizes supporting work when parent becomes ${status}`, async t => {
    const writes = [];
    t.mock.method(Assignment, 'updateOne', async (filter, update, options) => { writes.push({ filter, update, options }); return { matchedCount: 1 }; });
    const schema = new mongoose.Schema(); team.installHooks(schema, 'booking');
    const session = { synthetic: true };
    const job = { _id: bookingId, technicianId: lead, status, bookingDate: new Date('2099-01-05'), startTime: '08:00', endTime: '10:00',
      technicianTeam: [lead, support].map((technicianId, index) => ({ technicianId, assignmentId: id(100 + index), status: 'accepted' })), $session: () => session };
    await schema.s.hooks.execPost('save', job, [job]);
    const supporting = writes.find(row => row.filter.technicianId === support);
    assert.equal(supporting.update.$set.status, ({ 'on-the-way': 'en_route', 'in-progress': 'in_progress' })[status] || status);
    assert.equal(supporting.options.session, session);
    if (!['completed', 'cancelled'].includes(status)) assert.equal(writes.some(row => row.filter.technicianId === lead), false);
    if (status === 'completed') assert.ok(supporting.update.$set.completedAt);
  });
}
for (const action of ['status', 'checkout', 'collect-payment', 'proof-of-completion']) {
  test(`supporting assignment cannot call the primary-only ${action} endpoint`, async t => {
    t.mock.method(Assignment, 'findById', () => query({ _id: id(101), bookingId }));
    t.mock.method(Booking, 'findById', () => query({ _id: bookingId, technicianId: lead, technicianTeam: [{ technicianId: lead }, { technicianId: support, assignmentId: id(101) }] }));
    t.mock.method(require('../models/Technician'), 'findOne', () => query({ _id: support }));
    const res = { status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    await require('../utils/standardTeamMiddleware')({ params: { id: id(101) }, path: '/' + action, method: 'POST', body: { status: 'en_route' }, user: { _id: customer } }, res, () => assert.fail('Must deny this mutation'));
    assert.equal(res.statusCode, 403); assert.equal(res.body.code, 'PRIMARY_TECHNICIAN_REQUIRED');
  });
}
test('confirmed project work blocks standard technician availability; drafts and closed projects do not', async () => {
  let filter;
  const rows = [{ startTime: '08:00', endTime: '11:00', allocatedMinutes: 180, projectId: { status: 'in_progress' } }, { projectId: { status: 'cancelled' } }, { projectId: { status: 'in_progress', archivedAt: new Date() } }];
  const DailyAssignments = { find(value) { filter = value; return { select() { return this; }, populate() { return this; }, lean: async () => rows }; } };
  const intervals = await require('../utils/technicianProjectIntervals').technicianProjectIntervals(support, '2099-01-05', { DailyAssignments });
  assert.equal(filter.technicianId, support); assert.deepEqual(filter.planningOnly, { $ne: true }); assert.equal(intervals.length, 1); assert.equal(intervals[0].endTime, '11:00');
});
test('calendar strings and Manila-midnight timestamps acquire the same capacity lease', () => {
  const { bookingCapacityLockKey } = require('../utils/operationLock');
  assert.equal(bookingCapacityLockKey('2099-01-05'), bookingCapacityLockKey(new Date('2099-01-05T00:00:00+08:00')));
});
test('supporting service and installation kits do not duplicate shared equipment or repair parts', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../utils/dailyKitService'), 'utf8');
  const context = { require: () => team, uniqueIds: values => values || [], hasScheduledRepairWork: () => true,
    buildServicePreparation: () => assert.fail('Supporting service must not create a second equipment demand'),
    buildOrderInstallationPreparation: () => assert.fail('Supporting installation must not create a second equipment demand'),
    resolvePartTool: () => assert.fail('Supporting repair must not reserve parts again') };
  vm.runInNewContext(source.slice(source.indexOf('async function partRequirementsFor'), source.indexOf('function mergeOrderAllocations')), context);
  const rows = await context.requirementsFor([{ _id: id(101), bookingId, crewRole: 'support' }], [{ _id: bookingId, quotation: { parts: [{ name: 'Pump', quantity: 1 }] } }],
    [{ _id: orderId, technicianId: lead, technicianTeam: [{ technicianId: lead }, { technicianId: support }] }], [], [], support);
  assert.equal(rows.length, 0);
});
test('retrying the same team assignment preserves invitations instead of sending new ones', async () => {
  const f = fixture(); const first = await f.assign(); const retry = await f.assign();
  assert.equal(retry.duplicate, true); assert.equal(f.store.assignments.size, 2);
  assert.equal(retry.job.assignmentId, first.job.assignmentId);
});
test('staff cannot save object-valued assignment notes or duplicate differently-cased technician IDs', async () => {
  const f = fixture(); await assert.rejects(f.assign({ technicianId: lead, technicianIds: [lead], notes: {} }), error => error.status === 400);
  const hexadecimal = 'abcdefabcdefabcdefabcdef';
  assert.throws(() => team.normalize({ technicianId: hexadecimal, technicianIds: [hexadecimal, hexadecimal.toUpperCase()] }), /duplicate/);
  assert.equal(f.store.assignments.size, 0);
});
test('requesting another installation visit does not change or revalidate the visit that just ended', async () => {
  const f = fixture({ source: 'order' }); await f.assign();
  const job = f.current; const previousKey = team.scheduleKey('order', job);
  job.continuation = { status: 'pending', remainingMinutes: 90 };
  assert.equal(team.scheduleKey('order', job), previousKey);
  await team.prepareSchedule('order', job, () => assert.fail('The ended visit is not a new schedule'));
});
test('a scheduled installation continuation reserves the remaining work duration', () => {
  const { orderCapacityInterval } = require('../utils/orderScheduleCapacity');
  const order = { fulfillmentType: 'delivery_installation', timeSlot: '08:00', items: [{ quantity: 3 }], routeDurationMin: 30 };
  assert.equal(orderCapacityInterval(order).endTime, 690);
  order.continuation = { status: 'scheduled', remainingMinutes: 90 };
  assert.equal(orderCapacityInterval(order).endTime, 600);
});
for (const size of [1, 2]) test(`the order hook keeps one installation mirror for a ${size}-technician team`, async t => {
  const writes = [];
  t.mock.method(Booking, 'updateOne', async (filter, update, options) => { writes.push({ filter, update, options }); return { matchedCount: 1 }; });
  const schema = new mongoose.Schema(); team.installHooks(schema, 'order');
  const job = { _id: orderId, bookingId, technicianId: lead, status: 'technician_accepted', delivery: { preferredDate: new Date('2099-01-05') }, timeSlot: '08:00', items: [{ quantity: 1 }],
    technicianTeam: [lead, support].slice(0, size).map(technicianId => ({ technicianId, status: 'accepted' })) };
  await schema.s.hooks.execPost('save', job, [job]);
  assert.equal(writes.length, 1); assert.equal(writes[0].filter.sourceOrderId, orderId);
  assert.equal(writes[0].update.$set.status, 'confirmed'); assert.equal(writes[0].update.$set.technicianTeam.length, size);
});
test('query-based rescheduling saves team acceptance reset with the new appointment fields', async t => {
  const schema = new mongoose.Schema(); team.installHooks(schema, 'booking');
  const before = { _id: bookingId, technicianId: lead, status: 'confirmed', bookingDate: new Date('2099-01-05'), startTime: '08:00', endTime: '10:00', serviceDurationMinutes: 90,
    technicianTeam: [{ technicianId: lead, status: 'accepted' }, { technicianId: support, status: 'accepted' }] };
  before.technicianTeamSchedule = team.scheduleKey('booking', before);
  const update = { $set: { bookingDate: new Date('2099-01-06') } }, checks = [];
  t.mock.method(require('../routes/scheduleRoutes'), 'getTimeSlotsForQuery', async input => { checks.push(input); return { statusCode: 200, payload: { timeSlots: [{ startTime: '08:00', available: true }] } }; });
  await schema.s.hooks.execPre('findOneAndUpdate', { getUpdate: () => update, getFilter: () => ({ _id: bookingId }), getOptions: () => ({}), model: { findOne: () => query(before) } }, []);
  assert.equal(checks.length, 2); assert.equal(update.$set.status, 'assigned');
  assert.ok(update.$set.technicianTeam.every(row => row.status === 'pending'));
  assert.ok(before.technicianTeam.every(row => row.status === 'accepted'));
});
test('actual HTTP team guards block supporting writes and primary departure until the whole crew accepts', async t => {
  const express = require('express'), middleware = require('../utils/standardTeamMiddleware');
  const job = { _id: bookingId, technicianId: lead, technicianTeam: [{ technicianId: lead, assignmentId: id(100), status: 'accepted' }, { technicianId: support, assignmentId: id(101), status: 'pending' }] };
  let actor = support, mutations = 0;
  t.mock.method(Assignment, 'findById', value => query({ _id: value, bookingId }));
  t.mock.method(Booking, 'findById', () => query(job));
  t.mock.method(require('../models/Technician'), 'findOne', () => query({ _id: actor }));
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { _id: customer }; next(); });
  app.use('/assignments/:id', middleware);
  app.use('/repairs/:id', middleware.booking);
  app.post('/assignments/:id/status', (_req, res) => { mutations++; res.json({ success: true }); });
  app.post('/repairs/:id/en-route', (_req, res) => { mutations++; res.json({ success: true }); });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = url => fetch(`http://127.0.0.1:${server.address().port}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'en_route' }) });
  assert.equal((await post(`/assignments/${id(101)}/status`)).status, 403);
  assert.equal((await post(`/repairs/${bookingId}/en-route`)).status, 403);
  actor = lead;
  assert.equal((await post(`/assignments/${id(100)}/status`)).status, 409);
  assert.equal((await post(`/repairs/${bookingId}/en-route`)).status, 409); assert.equal(mutations, 0);
  job.technicianTeam[1].status = 'accepted';
  assert.equal((await post(`/assignments/${id(100)}/status`)).status, 200);
  assert.equal((await post(`/repairs/${bookingId}/en-route`)).status, 200); assert.equal(mutations, 2);
});

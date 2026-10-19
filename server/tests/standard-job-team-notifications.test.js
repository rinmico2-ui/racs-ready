'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Notification = require('../models/Notification');
const Technician = require('../models/Technician');
const SiteSetting = require('../models/SiteSetting');
const { publish } = require('../utils/standardJobTeamService');

const id = value => value.toString(16).padStart(24, '0');
const lead = id(1), support = id(2), leadUser = id(11), supportUser = id(12), owner = id(20), jobId = id(30);

function fixture(t, source, members = 2) {
  const records = [], errors = [], events = [];
  const technicians = new Map([[lead, { _id: lead, user: leadUser }], [support, { _id: support, user: supportUser }]]);
  t.mock.method(Technician, 'findById', key => ({ select() { return this; }, lean: async () => technicians.get(String(key)) || null }));
  t.mock.method(SiteSetting, 'findOne', () => ({ lean: async () => null }));
  t.mock.method(Notification, 'create', async values => {
    // Run the real schema on the exact payload produced by createNotification.
    const documents = values.map(value => new Notification(value));
    await Promise.all(documents.map(document => document.validate()));
    records.push(...documents.map(document => document.toObject()));
    return documents;
  });
  t.mock.method(console, 'error', (...args) => { errors.push(args); });
  const io = { to: room => ({ emit: (event, payload) => events.push({ room, event, payload }) }) };
  const job = {
    _id: jobId, technicianId: lead, status: source === 'booking' ? 'assigned' : 'technician_assigned',
    ...(source === 'booking' ? { bookingReference: 'BOOK-TEST', customerId: owner } : { orderReference: 'ORD-TEST', userId: owner }),
    technicianTeam: [
      { technicianId: lead, name: 'Primary technician', status: 'pending' },
      { technicianId: support, name: 'Supporting technician', status: 'pending' },
    ].slice(0, members),
  };
  return { job, records, errors, events, run: result => publish({ source, job, ...result }, { app: { get: () => io } }) };
}

for (const source of ['booking', 'order']) {
  const referenceModel = source === 'booking' ? 'BookingService' : 'Order';
  for (const size of [1, 2]) {
    test(`${source}: assigning ${size} technician(s) saves valid personal invitations and a customer team update`, async t => {
      const f = fixture(t, source, size);
      await f.run();
      assert.equal(f.errors.length, 0, 'Notification creation must not log a validation failure');
      assert.equal(f.records.length, size + 1);
      const invitations = f.records.filter(record => record.type === 'assignment_new');
      assert.deepEqual(invitations.map(record => String(record.userId)), [leadUser, supportUser].slice(0, size));
      for (const record of invitations) {
        assert.equal(record.role, null);
        assert.equal(record.link, source === 'booking' ? '/technician/assignments' : '/technician/orders');
      }
      const customer = f.records.find(record => String(record.userId) === owner);
      assert.equal(customer.type, 'assignment_update');
      assert.equal(customer.role, null);
      assert.equal(customer.link, source === 'booking' ? '/book-history' : '/my-orders');
      assert.match(customer.message, /Primary technician/);
      for (const record of f.records) {
        assert.equal(String(record.referenceId), jobId);
        assert.equal(record.referenceModel, referenceModel);
      }
      const notifications = f.events.filter(event => event.event === 'notification:new');
      for (const [technicianId, userId] of [[lead, leadUser], [support, supportUser]].slice(0, size)) {
        assert.ok(notifications.some(event => event.room === `user:${userId}` && event.payload.type === 'assignment_new'));
        assert.ok(notifications.some(event => event.room === `tech:${technicianId}` && event.payload.type === 'assignment_new'));
      }
      assert.ok(notifications.some(event => event.room === `user:${owner}` && event.payload.type === 'assignment_update'));
      assert.ok(notifications.every(event => event.room !== 'admin-room'));
    });
  }

  test(`${source}: declining creates schema-valid linked admin and secretary review alerts`, async t => {
    const f = fixture(t, source);
    await f.run({ response: true, decision: 'decline', technicianId: support });
    assert.equal(f.errors.length, 0);
    assert.equal(f.records.length, 2);
    assert.deepEqual(f.records.map(record => record.role), ['admin', 'secretary']);
    for (const record of f.records) {
      assert.equal(record.type, 'assignment_declined');
      assert.equal(record.userId, null);
      assert.equal(String(record.referenceId), jobId);
      assert.equal(record.referenceModel, referenceModel);
    }
    assert.equal(f.events.filter(event => event.event === 'notification:new').length, 1);
    assert.equal(f.records[0].link, source === 'booking' ? '/admin/appointments?tab=queue' : '/admin/appointments/orders');
    assert.equal(f.records[1].link, source === 'booking' ? '/secretary/appointments?tab=queue' : '/secretary/inventory/ordered-products');
  });

  test(`${source}: accepting does not send a second assignment invitation or customer team update`, async t => {
    const f = fixture(t, source);
    await f.run({ response: true, decision: 'accept', technicianId: support });
    assert.equal(f.records.length, 0); assert.equal(f.errors.length, 0);
    assert.ok(f.events.some(event => event.room === 'admin-room'));
  });

  test(`${source}: duplicate assignments publish no notifications or socket events`, async t => {
    const f = fixture(t, source);
    await f.run({ duplicate: true });
    assert.equal(f.records.length, 0); assert.equal(f.events.length, 0); assert.equal(f.errors.length, 0);
  });
}

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const id = 'customer', other = 'other';
const mocks = new Map();
function mock(modulePath, exports) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id:filename,filename,loaded:true,exports };
}
// Evaluate the real query against representative customer records, including
// Mongo's null/missing semantics and embedded request array matching.
function matches(row, query) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$or') return condition.some(branch => matches(row,branch));
    const value = key.split('.').reduce((value,part) => value?.[part],row);
    if (condition === null) return value == null;
    if (typeof condition !== 'object' || condition instanceof Date) return value === condition;
    return Object.entries(condition).every(([op, expected]) => {
      if (op === '$in') return expected.some(item => item == null ? value == null : item === value);
      if (op === '$nin') return !expected.includes(value);
      if (op === '$ne') return expected === null ? value != null : value !== expected;
      if (op === '$lt') return value != null && value < expected;
      if (op === '$lte') return value != null && value <= expected;
      if (op === '$gt') return value != null && value > expected;
      if (op === '$elemMatch') return Array.isArray(value) && value.some(item => matches(item,expected));
      throw new Error('Unsupported query operator ' + op);
    });
  });
}
mock('../middleware/authenticate',{ authenticate:() => {},requireRole:() => () => {} });
mock('../models/AirconCart',{ aggregate:async pipeline => { assert.equal(pipeline[0].$match.userId,id); return [{ total:126 }]; } });
for (const name of ['BookingService','Order','WarrantyClaim','ProductReturn','MaintenanceSchedule']) {
  const records = []; mocks.set(name,records);
  mock('../models/' + name,{ countDocuments:async query => records.filter(row => matches(row,query)).length });
}
const router = require('../routes/customerNavRoutes');
const handler = router.stack.find(layer => layer.route?.path === '/nav-summary').route.stack[0].handle;
test('all customer navigation counts exclude stale, completed, unrelated, and deferred records', async () => {
  const past = new Date(Date.now()-86400000), future = new Date(Date.now()+86400000*7);
  mocks.get('BookingService').push(
    { customerId:id,status:'confirmed',proposedReschedule:{ status:'pending' } },
    { customerId:id,status:'confirmed',proposedReschedule:{ status:'pending',date:future,expiresAt:past } },
    { customerId:id,status:'completed',proposedReschedule:{ status:'pending',date:future } },
    { customerId:other,status:'awaiting_approval' },
    { customerId:id,status:'confirmed',proposedReschedule:{ status:'pending',date:future,expiresAt:future } },
    { customerId:id,status:'confirmed',serviceChangeRequests:[{ status:'schedule_proposed' }] },
  );
  mocks.get('Order').push(
    { userId:id,status:'completed',paymentStatus:'pending' },
    { userId:id,status:'cancelled',paymentStatus:'failed' },
    { userId:id,status:'preparing_unit',paymentStatus:'pending' },
    { userId:id,status:'pending_payment',paymentStatus:'pending',gcashProofFileId:'uploaded-proof' },
    { userId:other,status:'pending_payment',paymentStatus:'pending' },
    { userId:id,status:'pending_payment',paymentStatus:'pending' },
    { userId:id,status:'ready_for_pickup',paymentStatus:'verified' },
    { userId:id,status:'pending_payment',paymentStatus:'rejected',gcashProofFileId:'rejected-proof' },
  );
  mocks.get('WarrantyClaim').push({ customerId:id,status:'submitted' },{ customerId:id,status:'closed' },{ customerId:other,status:'submitted' });
  mocks.get('ProductReturn').push({ customerId:id,status:'pending' },{ customerId:id,status:'completed' });
  mocks.get('MaintenanceSchedule').push(
    { customerId:id,status:'upcoming',dueDate:future,customerResponse:{ status:'none' } },
    { customerId:id,status:'overdue',dueDate:past,customerResponse:{ status:'remind_later',remindAt:future } },
    { customerId:id,status:'overdue',dueDate:past,customerResponse:{ status:'acknowledged' } },
    { customerId:id,status:'overdue',dueDate:past,customerResponse:{ status:'none' } },
    { customerId:id,status:'overdue',dueDate:past,customerResponse:{ status:'remind_later',remindAt:past } },
  );
  const res = { set() {},json(body) { this.body = body; } };
  await handler({ user:{ _id:id } },res,error => { throw error; });
  assert.deepEqual(res.body,{ cart:126,bookings:2,orders:3,aftercare:4 });
});

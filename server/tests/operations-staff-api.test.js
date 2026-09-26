const test = require('node:test');
const assert = require('node:assert/strict');
const BookingService = require('../models/BookingService');
const Assignment = require('../models/Assignment');
const Payment = require('../models/Payment');
const StockReservation = require('../models/StockReservation');
const Order = require('../models/Order');
const appointments = require('../routes/appointmentManagement');
const orders = require('../routes/orderRoutes');
const costAnalytics = require('../utils/serviceCostAnalytics');
const { currentAssignment, bookingPhotos, BOOKING_PHOTO_FIELDS, ORDER_PHOTO_FIELDS } = require('../utils/operationsDetail');

function endpoint(router, path) {
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods.get).route;
  return route.stack[route.stack.length - 1].handle;
}
function response() {
  return { statusCode: 200, set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function chain(value) {
  return { populate() { return this; }, sort() { return this; }, select() { return this; }, maxTimeMS() { return this; }, async lean() { return value; } };
}

test('pending API paginates the whole filtered queue after its effective-date sort', async () => {
  const originals = { count: BookingService.countDocuments, aggregate: BookingService.aggregate };
  let pipeline, filter;
  BookingService.countDocuments = async value => { filter = value; return 107; };
  BookingService.aggregate = async value => { pipeline = value; return []; };
  try {
    const res = response();
    await endpoint(appointments, '/list')({ query: {
      stage: 'pending_review', page: '2', limit: '10', compact: 'true', sort: 'date_desc', paymentStatus: 'pending',
    }, user: { role: 'secretary' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.pagination, { page: 2, limit: 10, total: 107, pages: 11 });
    assert.deepEqual(filter.$and, [{ paymentStatus: 'pending' }]);
    assert.deepEqual(pipeline[2].$sort, { _listUndated: 1, _listDate: -1, createdAt: -1, _id: -1 });
    assert.deepEqual(pipeline[3], { $skip: 10 });
    assert.deepEqual(pipeline[4], { $limit: 10 });
    assert.equal(pipeline[5].$project['services.name'], 1);
    assert.equal(pipeline[5].$project.proofPhoto, undefined);
  } finally { BookingService.countDocuments = originals.count; BookingService.aggregate = originals.aggregate; }
});

test('booking details load related records in parallel and preserve the stored assignment pointer', async () => {
  const originals = { booking: BookingService.findById, assignment: Assignment.find, payment: Payment.find, stock: StockReservation.find };
  const id = '507f1f77bcf86cd799439011';
  const started = [];
  BookingService.findById = () => chain({ _id: id, status: 'pending', assignmentId: 'older', totalPrice: 1000 });
  const related = (name, rows) => {
    started.push(name);
    const query = chain(rows);
    query.lean = () => new Promise(resolve => setImmediate(() => {
      assert.equal(started.length, 3, 'all independent reads should already be running');
      resolve(rows);
    }));
    return query;
  };
  Assignment.find = () => related('assignment', [{ _id: 'newer' }, { _id: 'older' }]);
  Payment.find = () => related('payment', []);
  StockReservation.find = () => related('parts', []);
  try {
    const res = response();
    await endpoint(appointments, '/:id')({ params: { id } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.assignment._id, 'older');
    assert.equal(res.body.booking.balanceAmount, 1000);
    assert.deepEqual(res.body.reservedParts, []);
  } finally {
    BookingService.findById = originals.booking; Assignment.find = originals.assignment;
    Payment.find = originals.payment; StockReservation.find = originals.stock;
  }
});

test('order API sorts before pagination and retains ObjectId technician filters in aggregation', async () => {
  const originals = { aggregate: Order.aggregate, count: Order.countDocuments, find: Order.find, populate: Order.populate };
  let main;
  Order.aggregate = async pipeline => {
    if (pipeline.some(stage => stage.$sort?._listDate)) { main = pipeline; return []; }
    return [];
  };
  Order.countDocuments = async () => 5;
  Order.find = () => chain([]);
  Order.populate = async rows => rows;
  try {
    const technicianId = '507f1f77bcf86cd799439021';
    const res = response();
    await endpoint(orders, '/all')({ query: { sort: 'date_asc', page: '2', limit: '2', technicianId, fulfillmentGroup: 'pickup' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.total, 5);
    assert.equal(res.body.page, 2);
    assert.equal(res.body.pages, 3);
    assert.equal(main[0].$match.technicianId.toString(), technicianId);
    assert.equal(typeof main[0].$match.technicianId, 'object');
    assert.equal(main[0].$match.fulfillmentType, 'customer_pickup');
    assert.equal(main[2].$sort._listDate, 1);
    assert.deepEqual(main[3], { $skip: 2 });
  } finally {
    Order.aggregate = originals.aggregate; Order.countDocuments = originals.count;
    Order.find = originals.find; Order.populate = originals.populate;
  }
});

test('completed booking modal projects out photos, skips cost analytics, and retains authoritative payment totals', async () => {
  const originals = { booking: BookingService.findById, assignment: Assignment.findOne,
    payment: Payment.find, stock: StockReservation.find, analytics: costAnalytics.buildServiceCostAnalytics };
  const selections = {};
  const id = '507f1f77bcf86cd799439011';
  const selected = (name, value) => {
    const query = chain(value);
    query.select = selection => { selections[name] = selection; return query; };
    return query;
  };
  BookingService.findById = () => selected('booking', { _id: id, status: 'completed', totalPrice: 1000, amountPaid: 0 });
  Assignment.findOne = () => selected('assignment', { _id: 'latest', bookingId: id, status: 'completed' });
  Payment.find = () => selected('payments', [{ amount: 100, status: 'verified' }, { amount: 900, status: 'pending' }]);
  StockReservation.find = () => chain([]);
  costAnalytics.buildServiceCostAnalytics = () => { throw new Error('Modal must not wait for analytics'); };
  try {
    const res = response();
    await endpoint(appointments, '/:id')({ params: { id }, query: { view: 'modal' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.photosDeferred, true);
    assert.equal(res.body.financialSummary, null);
    assert.equal(res.body.booking.amountPaid, 100);
    assert.equal(res.body.booking.balanceAmount, 900);
    assert.equal(res.body.booking.paymentStatus, 'partial');
    assert.equal(res.body.payments.length, 2, 'pending receipt amounts still remain visible');
    for (const field of BOOKING_PHOTO_FIELDS) assert.ok(selections.booking.split(' ').includes('-' + field));
    assert.match(selections.payments, /-proofUrl/);
    assert.match(selections.payments, /-customerSignature/);
    assert.match(selections.payments, /-webhookEvents/);
    assert.match(selections.assignment, /-proofPhoto/);
  } finally {
    BookingService.findById = originals.booking; Assignment.findOne = originals.assignment;
    Payment.find = originals.payment; StockReservation.find = originals.stock;
    costAnalytics.buildServiceCostAnalytics = originals.analytics;
  }
});

test('modal assignment lookup is bounded and falls back only when the stored pointer is missing', async () => {
  const reads = [];
  const model = { findOne(filter) { reads.push(filter); return chain(reads.length === 1 ? null : { _id: 'latest' }); } };
  const booking = { _id: 'booking', assignmentId: 'missing' };
  assert.equal((await currentAssignment(model, booking))._id, 'latest');
  assert.deepEqual(reads, [{ _id: 'missing', bookingId: 'booking' }, { bookingId: 'booking' }]);
  reads.length = 0;
  model.findOne = filter => { reads.push(filter); return chain({ _id: 'stored' }); };
  assert.equal((await currentAssignment(model, booking))._id, 'stored');
  assert.equal(reads.length, 1);
});

test('deferred booking photos retain repair, per-unit, and payment evidence without duplicates', () => {
  const photos = bookingPhotos({
    paymentProof: 'receipt', unitInfo: { photos: ['unit'] }, inspection: { photos: ['inspection'] },
    services: [{ photos: ['issue'], units: [{ inspection: { photos: ['unit-inspection'] } }] }],
  }, { proofPhoto: 'completed' }, [{ proofUrl: 'receipt', customerPhotoUrl: 'customer', remittanceProofUrl: 'remitted' }]);
  assert.deepEqual(photos.map(photo => photo.src),
    ['receipt', 'completed', 'customer', 'remitted', 'unit', 'inspection', 'issue', 'unit-inspection']);
});

test('staff order modal excludes inline evidence without changing order totals', async () => {
  const original = Order.findById;
  let selection;
  Order.findById = () => {
    const query = chain({ _id: '507f1f77bcf86cd799439011', userId: 'customer', subtotal: 1000, total: 1000,
      balanceAmount: 1000, status: 'preparing_unit', paymentStatus: 'pending', salesChannel: 'online' });
    query.select = value => { selection = value; return query; };
    return query;
  };
  try {
    const res = response();
    await endpoint(orders, '/:id')({ params: { id: '507f1f77bcf86cd799439011' },
      query: { view: 'modal' }, user: { role: 'secretary', _id: 'staff' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.photosDeferred, true);
    assert.equal(res.body.order.total, 1000);
    for (const field of ORDER_PHOTO_FIELDS) assert.ok(selection.split(' ').includes('-' + field));
  } finally { Order.findById = original; }
});

test('booking photo endpoint fetches only evidence fields and rejects invalid IDs before database reads', async () => {
  const originals = { booking: BookingService.findById, assignment: Assignment.findOne, payment: Payment.find };
  const selections = {};
  const selected = (name, value) => {
    const query = chain(value); query.select = value => { selections[name] = value; return query; }; return query;
  };
  const id = '507f1f77bcf86cd799439011';
  BookingService.findById = () => selected('booking', { _id: id, paymentProof: 'receipt' });
  Assignment.findOne = () => selected('assignment', { proofPhoto: 'completion' });
  Payment.find = () => selected('payments', [{ proofUrl: 'receipt' }]);
  try {
    const res = response();
    await endpoint(appointments, '/:id/photos')({ params: { id } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.photos.map(photo => photo.src), ['receipt', 'completion']);
    assert.ok(!selections.booking.includes('customer'));
    assert.ok(!selections.payments.includes('amount'));
    BookingService.findById = () => { throw new Error('Invalid IDs must not query the database'); };
    const invalid = response();
    await endpoint(appointments, '/:id/photos')({ params: { id: 'bad' } }, invalid);
    assert.equal(invalid.statusCode, 400);
  } finally {
    BookingService.findById = originals.booking; Assignment.findOne = originals.assignment; Payment.find = originals.payment;
  }
});

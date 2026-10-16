'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), mongoose = require('mongoose');
const seed = require('../utils/transactionHistorySeed');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const recovery = require('../utils/resetRecoveryBackup');
const now = new Date('2026-10-16T00:00:00Z');
const oid = index => new mongoose.Types.ObjectId(String(index).padStart(24, '0'));
function fixture() {
  return { users: [{ _id: oid(1), role: 'customer', firstName: 'Synthetic', lastName: 'Customer', email: 'fixture.customer@gmail.com', phone: '09123456789', emailVerified: true, emailVerifiedAt: new Date('2026-01-01'), address: { city: 'Cabanatuan', province: 'Nueva Ecija' } }],
    technicians: [{ _id: oid(2), user: oid(3), name: 'Synthetic Technician', active: true, userEmail: 'technician@example.test' }], staffUsers: [{ _id: oid(3), role: 'technician', active: true }],
    services: [{ _id: oid(4), name: 'Aircon Cleaning', slug: 'aircon-cleaning', active: true, brands: ['Carrier'], isAirconService: true, durationMinutes: 60, airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 600, durationMinutes: 60 }] }] }],
    categories: [{ _id: oid(5), active: true, name: 'Home Appliances', slug: 'appliance', unitTypes: [{ value: 'Washing Machine', label: 'Washing Machine', inspectionFee: 500 }] }],
    inventory: [{ _id: oid(6), modelLine: 'Synthetic aircon', brand: oid(7), capacity: '1', sellingPrice: 20000, costPrice: 14000, active: true }],
    hvac: [], brands: [{ _id: oid(7), name: 'Carrier' }], settings: [] };
}
test('the generator validates every linked document against the actual models and reconciles completed and cancelled work', async () => {
  const config = seed.configuration({ count: 20 }, now), rows = await seed.buildSeed(fixture(), config, now);
  const summary = seed.summary(rows, config);
  assert.equal(summary.primaryTransactions, 20);
  assert.equal(summary.services.completed, 8); assert.equal(summary.services.cancelled, 2);
  assert.equal(summary.orders.completed, 8); assert.equal(summary.orders.cancelled, 2);
  assert.equal(summary.simulatedPayments, summary.simulatedSales);
  assert.equal(summary.customerNotifications, 0); assert.equal(summary.physicalStockChanges, 0);
  assert.ok(rows.bookingservices.some(row => row.sourceOrderId));
  for (const row of rows.orders) assert.equal(row.items[0].costPrice, 14000, 'Private saved purchase costs must survive serialization');
  for (const row of rows.bookingservices.filter(row => row.status === 'cancelled')) assert.match(row.cancellationReason, /^DEMO scenario: .+/);
  for (const row of [...rows.bookingservices, ...rows.orders]) assert.equal(row.demonstration.moneyReceived, false);
  for (const row of rows.bookingservices) {
    const [hour, minute] = row.endTime.split(':').map(Number), [startHour, startMinute] = row.startTime.split(':').map(Number);
    assert.equal(hour * 60 + minute - startHour * 60 - startMinute, row.serviceDurationMinutes);
    for (const item of row.services) assert.equal(item.units.length, item.quantity);
  }
});
test('1,000 primary transactions cover every requested year without future or unfinished jobs', async () => {
  const config = seed.configuration({}, now), rows = await seed.buildSeed(fixture(), config, now), summary = seed.summary(rows, config);
  assert.equal(summary.primaryTransactions, 1000); assert.equal(summary.services.completed, 400); assert.equal(summary.orders.cancelled, 100);
  assert.ok(Object.values(summary.years).every(count => count > 0));
  assert.equal(summary.simulatedPayments, summary.simulatedSales);
  for (const row of [...rows.bookingservices, ...rows.orders]) {
    assert.ok(row.updatedAt < now); assert.ok(row.createdAt >= new Date('2021-12-31T16:00:00Z'));
    assert.ok(['completed', 'cancelled'].includes(row.status));
    assert.equal(row.customer.email, 'fixture.customer@gmail.com');
  }
});
test('customer Gmail eligibility requires verification evidence and never fabricates or modifies accounts', () => {
  const user = fixture().users[0]; assert.equal(seed.eligibleCustomer(user), true);
  for (const fields of [{ emailVerified: false }, { emailVerifiedAt: null }, { role: 'admin' }, { active: false }, { blocked: true }, { archivedAt: now }, { accountStatus: 'invited' }, { email: 'fixture@example.test' }]) assert.equal(seed.eligibleCustomer({ ...user, ...fields }), false);
  assert.equal(seed.eligibleCustomer({ ...user, emailVerifiedAt: null, hasGoogleIdentity: true }), true);
});
test('missing legitimate customers, technician accounts, pricing or buying costs block seeding', () => {
  for (const change of [{ users: [] }, { staffUsers: [] }, { services: [] }, { categories: [] }, { inventory: [] }, { inventory: [{ ...fixture().inventory[0], costPrice: undefined }] }]) assert.ok(seed.prerequisites({ ...fixture(), ...change }).length);
});
test('service pricing uses actual supported HP tiers and does not turn unrelated core services into aircon bookings', () => {
  const snapshot = fixture();
  snapshot.services.push({ _id: oid(99), name: 'Refrigerator service', basePrice: 1500, isAirconService: false });
  const choices = seed.serviceChoices(snapshot);
  assert.equal(choices.length, 1); assert.equal(choices[0].hp, 1); assert.equal(choices[0].price, 600);
  assert.equal(String(choices[0].service._id), String(oid(4)));
});
test('seed dates, batch names, count and CLI modes are bounded and explicit', () => {
  for (const input of [{ to: '2026-10-16' }, { to: '2027-01-01' }, { from: '2026-02-31' }, { count: 1001 }, { count: 11 }, { batch: '../other' }]) assert.throws(() => seed.configuration(input, now));
  const { parseArguments } = require('../scripts/seed-transaction-history');
  assert.equal(parseArguments([]).mode, 'preview'); assert.equal(parseArguments(['--prepare']).mode, 'prepare');
  for (const args of [['--apply'], ['--verify'], ['--prepare', '--apply'], ['--delete'], ['--preview', '--backup', 'x'], ['--apply', '--backup', 'x', '--count', '1000']]) assert.throws(() => parseArguments(args));
});
test('a broken payment ledger or installation back-reference fails validation', async () => {
  const config = seed.configuration({ count: 20 }, now), rows = await seed.buildSeed(fixture(), config, now);
  rows.payments[0].amount += 1; assert.throws(() => seed.assertSeedIntegrity(rows, config), /reconcile/);
  rows.payments[0].amount -= 1;
  rows.orders.find(order => order.bookingId).bookingId = oid(9999);
  assert.throws(() => seed.assertSeedIntegrity(rows, config), /Installation mirror/);
});
test('email snapshots must match the actual verified account, not just look like Gmail addresses', async () => {
  const snapshot = fixture(), config = seed.configuration({ count: 10 }, now), rows = await seed.buildSeed(snapshot, config, now);
  rows.orders[0].customer.email = 'different.account@gmail.com';
  assert.throws(() => seed.assertAccountLinks(rows, snapshot), /Gmail snapshot/);
});

function databaseFixture() {
  const data = fixture(), state = { users: [...data.users, ...data.staffUsers], technicians: data.technicians, coreservices: data.services,
    servicecategories: data.categories, inventories: data.inventory.map(row => ({ ...row, quantity: 50 })), hvac_products: [], brands: data.brands, sitesettings: [],
    bookingservices: [{ _id: oid(8000), status: 'completed', notes: 'Real existing work' }], orders: [{ _id: oid(8001), status: 'completed' }],
    payments: [], assignments: [], servicereports: [], activitylogs: [], notifications: [], emailoutboxes: [], payrolls: [{ _id: oid(8002), status: 'paid' }] };
  const clone = value => mongoose.mongo.BSON.EJSON.parse(recovery.serialize(value), { relaxed: true });
  const same = (left, right) => String(left) === String(right);
  function matches(row, filter = {}) {
    return Object.entries(filter).every(([field, value]) => {
      const actual = field.split('.').reduce((parent, key) => parent?.[key], row);
      if (value instanceof RegExp) return value.test(actual || '');
      if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId)) return Object.entries(value).every(([operator, item]) => {
        if (operator === '$in') return item.some(candidate => same(actual, candidate));
        if (operator === '$ne') return !same(actual, item);
        if (operator === '$exists') return (actual !== undefined) === item;
        throw Error('Unsupported fixture filter: ' + operator);
      });
      return value === null ? actual == null : same(actual, value);
    });
  }
  function project(row, fields) {
    if (!fields) return row;
    const result = { _id: row._id };
    for (const [field, value] of Object.entries(fields)) if (value === 1 && row[field] !== undefined) result[field] = row[field];
    if (fields.hasGoogleIdentity) result.hasGoogleIdentity = Boolean(row.googleSubject || row.hasGoogleIdentity);
    return result;
  }
  let writes = 0, failAt, standalone = false;
  const db = { databaseName: 'synthetic-seed-fixture', collection(name) {
    const rows = () => state[name] || [];
    const write = () => { writes++; if (name === failAt) throw Error('Simulated write failure'); };
    return {
      find(filter, options) { let maximum = Infinity; return { sort() { return this; }, limit(number) { maximum = number; return this; }, maxTimeMS() { return this; },
        toArray: async () => clone(rows().filter(row => matches(row, filter)).sort((a, b) => String(a._id).localeCompare(String(b._id))).slice(0, maximum).map(row => project(row, options?.projection))) }; },
      findOne: async filter => clone(rows().find(row => matches(row, filter)) || null),
      aggregate(stages) { assert.equal(name, 'users'); const fields = stages.find(stage => stage.$project).$project; return { toArray: async () => clone(rows().filter(row => matches(row, stages[0].$match)).map(row => project(row, fields))) }; },
      async insertMany(records) { write(); if (records.some(record => rows().some(row => same(row._id, record._id)))) throw Error('Duplicate fixture key'); state[name] = [...rows(), ...clone(records)]; },
      async insertOne(record) { write(); state[name] = [...rows(), clone(record)]; },
    };
  } };
  const client = { startSession() { return { async withTransaction(action) {
    if (standalone) throw Error('Transactions are not supported');
    const before = clone(state); try { await action(); } catch (error) { for (const key of Object.keys(state)) delete state[key]; Object.assign(state, before); throw error; }
  }, async endSession() {} }; } };
  return { db, client, state, get writes() { return writes; }, fail(collection) { failAt = collection; }, standalone() { standalone = true; }, clone };
}
function privateDirectory(t) {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.mkdtempSync(path.join(parent, 'racs-transaction-seed-test-'));
  t.after(() => { if (path.dirname(fs.realpathSync(directory)) !== parent) throw Error('Unexpected fixture directory'); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
test('preview is read-only, scans every model, and prints aggregate totals without customer email or contact data', async () => {
  const f = databaseFixture(), plan = await seed.previewSeed({ db: f.db, config: { count: 20 }, now });
  assert.equal(plan.mode, 'dry-run'); assert.equal(f.writes, 0); assert.equal(plan.databaseChanges, 0);
  const files = fs.readdirSync(path.resolve(__dirname, '../models')).filter(file => file.endsWith('.js'));
  assert.equal(plan.schemaAudit.files, files.length); assert.ok(plan.schemaAudit.models >= 69);
  assert.doesNotMatch(JSON.stringify(plan), /fixture.customer|09123456789|Synthetic Customer|passwordHash|googleSubject/);
});
test('prepare writes checksummed private recovery files and never sends mail or writes to the database', async t => {
  const f = databaseFixture(), result = await seed.previewSeed({ db: f.db, config: { count: 20 }, now, prepare: true, directory: privateDirectory(t) });
  assert.equal(result.mode, 'prepared'); assert.equal(f.writes, 0); assert.equal(result.recoveryVerified, true);
  assert.match(path.basename(result.backup), /^transaction-history-seed-\d{13}-[a-f0-9]{8}\.ejson\.gz$/);
  const { artifact } = await recovery.readResetBackup(result.backup);
  assert.equal(artifact.seed.orders.length, 10); assert.equal(artifact.original.users[0].email, 'fixture.customer@gmail.com');
  assert.equal(artifact.original.users[0].passwordHash, undefined); assert.equal(artifact.original.users[0].googleSubject, undefined);
  assert.equal(require('../utils/bookingOrderResetBackupDownload').BACKUP_NAME.test(path.basename(result.backup)), true);
});
test('apply and verify reconcile exact inserts, preserve real records and stock, and repeat runs do not add duplicates', async t => {
  const f = databaseFixture(), original = f.clone(f.state);
  const prepared = await seed.previewSeed({ db: f.db, config: { count: 20 }, now, prepare: true, directory: privateDirectory(t) });
  const result = await seed.applySeed({ db: f.db, client: f.client, backupFile: prepared.backup, now });
  assert.equal(result.mode, 'seeded'); assert.equal(result.atomic, true); assert.equal(result.reconciliation.matches, true);
  assert.equal(f.state.bookingservices.find(row => String(row._id) === String(oid(8000))).notes, 'Real existing work');
  for (const key of ['users', 'technicians', 'inventories', 'payrolls', 'notifications', 'emailoutboxes']) assert.deepEqual(f.state[key], original[key]);
  const writes = f.writes;
  const verified = await seed.applySeed({ db: f.db, client: f.client, backupFile: prepared.backup, now, verifyOnly: true });
  assert.equal(verified.mode, 'verified'); assert.equal(f.writes, writes);
  assert.equal((await seed.applySeed({ db: f.db, client: f.client, backupFile: prepared.backup, now })).mode, 'already-applied');
  assert.equal(f.writes, writes);
});
test('changed verification, stale preparation, a corrupt recovery file and transaction failure prevent partial data', async t => {
  const f = databaseFixture(), before = f.clone(f.state);
  const prepared = await seed.previewSeed({ db: f.db, config: { count: 20 }, now, prepare: true, directory: privateDirectory(t) });
  f.state.users[0].emailVerified = false;
  await assert.rejects(seed.applySeed({ db: f.db, client: f.client, backupFile: prepared.backup, now }), /inputs changed/);
  assert.equal(f.writes, 0); f.state.users[0].emailVerified = true;
  await assert.rejects(seed.applySeed({ db: f.db, client: f.client, backupFile: prepared.backup, now: new Date(now.getTime() + 2 * 86400000) }), /expired/);
  f.fail('payments'); await assert.rejects(seed.applySeed({ db: f.db, client: f.client, backupFile: prepared.backup, now }), /Simulated write failure/);
  assert.deepEqual(f.state, before);
  f.standalone(); await assert.rejects(seed.applySeed({ db: f.db, client: f.client, backupFile: prepared.backup, now }), /Transactions are not supported/);
  fs.appendFileSync(prepared.backup, 'corrupt'); await assert.rejects(seed.applySeed({ db: f.db, client: f.client, backupFile: prepared.backup, now }), /checksum/);
});
test('demonstration records do not generate aftercare assets, reminders, or real product returns', async () => {
  const lifecycle = require('../utils/maintenanceLifecycle');
  const record = { status: 'completed', demonstration: { batch: 'fixture-demo' } };
  assert.deepEqual(await lifecycle.syncMaintenanceFromBooking(record), []);
  assert.deepEqual(await lifecycle.syncMaintenanceFromOrder(record), []);
  const policy = require('../utils/productReturnPolicy');
  const source = { ...record, _id: oid(9000), completedAt: now, total: 1000, items: [{ inventoryId: oid(6), quantity: 1, unitPrice: 1000 }] };
  const result = policy.evaluateItem('order', source, 0, { returns: [], payments: [], returnDays: 30 }, now);
  assert.equal(result.eligible, false); assert.match(result.reason, /Demonstration orders/);
});
test('real customer loyalty counters exclude demonstration history in both database pipelines', async t => {
  const Booking = require('../models/BookingService'), Order = require('../models/Order');
  const filters = [];
  for (const Model of [Booking, Order]) t.mock.method(Model, 'aggregate', async pipeline => { filters.push(pipeline[0].$match); return []; });
  const result = await require('../utils/loyaltyRewards').completionHistories([oid(1)]);
  assert.equal(filters.length, 2);
  for (const filter of filters) assert.deepEqual(filter['demonstration.batch'], { $exists: false });
  assert.deepEqual(result.get(String(oid(1))), { bookings: [], orders: 0 });
});

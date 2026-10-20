'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const A = require('../public/js/appliance-services');
const editor = require('../public/js/booking-editor-services');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const core = (overrides = {}) => ({ _id: 'saved-cleaning', type: 'core', serviceId: 'cleaning', applianceGroupId: 'appliance_original',
  applianceKind: 'aircon', brand: 'Carrier', model: 'OLD-123', airconType: 'split', hp: 1, quantity: 1, unitPrice: 500, totalPrice: 500, ...overrides });
const repair = () => ({ _id: 'saved-repair', type: 'repair', unitType: 'Washer', brand: 'Midea', quantity: 1, unitPrice: 600,
  problemDescription: 'The washer does not drain.', photos: ['evidence.jpg'], units: [{ unitNumber: 1, status: 'pending' }] });

test('the editor groups services on the same appliance while keeping other units and repairs separate', () => {
  const rows = [core(), core({ _id: 'saved-install', serviceId: 'installation' }), core({ applianceGroupId: 'appliance_second' }), repair()];
  const grouped = editor.groups(rows);
  assert.equal(grouped.length, 3);
  assert.deepEqual(grouped[0].indexes, [0, 1]);
  assert.equal(grouped[0].rows.length, 2);
  assert.equal(grouped[2].primary.type, 'repair');
  assert.equal(A.unitCount(rows), 3);
});

test('updating one appliance preserves its service identities and leaves other appliance and repair data intact', () => {
  const other = core({ _id: 'another-unit', applianceGroupId: 'appliance_second', brand: 'Daikin', hp: 2 });
  const rows = [core({ photos: ['saved-unit.jpg'] }), other, repair()];
  const unchanged = structuredClone(rows.slice(1));
  const added = { ...core({ brand: 'LG', hp: 2, unitPrice: 850, totalPrice: 850 }), _id: undefined };
  editor.replaceCore(rows, [added], 'appliance_original');
  const updated = rows.find(row => row.applianceGroupId === 'appliance_original');
  assert.equal(updated._id, 'saved-cleaning'); assert.equal(updated.brand, 'LG'); assert.equal(updated.hp, 2);
  assert.equal(rows[0], updated);
  assert.deepEqual(updated.photos, ['saved-unit.jpg']);
  assert.deepEqual(rows.filter(row => row !== updated), unchanged);
});

test('splitting a historical quantity group keeps each saved identity once and retains per-unit details and prices', () => {
  const rows = [core({ quantity: 2, totalPrice: 1000 }), core({ _id: 'saved-install', serviceId: 'installation', quantity: 2, unitPrice: 1500, totalPrice: 3000 }), repair()];
  const added = ['cleaning', 'installation'].flatMap(serviceId => [
    core({ _id: undefined, serviceId, applianceGroupId: 'appliance_batch_first', model: 'FIRST-123' }),
    core({ _id: undefined, serviceId, applianceGroupId: 'appliance_batch_second', brand: 'Daikin', hp: 2, model: 'SECOND-456', unitPrice: 850, totalPrice: 850 }),
  ]);
  editor.replaceCore(rows, added, 'appliance_original');
  assert.equal(rows.filter(row => row._id === 'saved-cleaning').length, 1);
  assert.equal(rows.filter(row => row._id === 'saved-install').length, 1);
  assert.equal(rows.filter(row => row._id && row.type === 'core').length, 2);
  const grouped = editor.groups(rows).filter(group => group.primary.type === 'core');
  assert.equal(grouped.length, 2); assert.ok(grouped.every(group => group.rows.length === 2 && group.quantity === 1));
  assert.equal(grouped[0].primary.applianceGroupId, 'appliance_original');
  assert.equal(grouped[1].primary.brand, 'Daikin'); assert.equal(grouped[1].primary.model, 'SECOND-456');
  assert.equal(A.unitCount(rows), 3);
});

test('a changed service cannot inherit a different service identity and invalid edits leave the saved selection intact', () => {
  const rows = [core(), repair()];
  editor.replaceCore(rows, [core({ _id: 'forged-id', serviceId: 'installation' })], 'appliance_original');
  assert.equal(rows.find(row => row.type === 'core')._id, undefined);
  const before = structuredClone(rows);
  assert.throws(() => editor.replaceCore(rows, [core({ _id: undefined, applianceGroupId: 'appliance_too_many', quantity: 40 })]), /at most 40/);
  assert.deepEqual(rows, before);
  assert.throws(() => editor.replaceCore(rows, [core()], 'missing-appliance'), /changed/);
  assert.deepEqual(rows, before);
});

test('history loads the same versioned batch and field guidance assets as new service booking, in dependency order', () => {
  const history = read('views/pages/book-history.ejs'), services = read('views/pages/services.ejs');
  for (const asset of ['core-appliance-booking.css', 'core-appliance-batch.css', 'appliance-field-guide.css', 'appliance-services.js', 'appliance-field-guide.js', 'core-appliance-batch.js', 'core-appliance-booking.js', 'repair-appliance-booking.js']) {
    const url = source => source.match(new RegExp('(?:src|href)="([^" ]*/' + asset.replace('.', '\\.') + '\\?v=[^" ]+)"'))?.[1];
    assert.ok(url(history), asset); assert.equal(url(history), url(services), asset);
  }
  const names = ['appliance-services.js', 'appliance-field-guide.js', 'core-appliance-batch.js', 'core-appliance-booking.js', 'repair-appliance-booking.js', 'booking-editor-services.js', 'book-history.js'];
  assert.deepEqual([...names].sort((a, b) => history.indexOf(a) - history.indexOf(b)), names);
});

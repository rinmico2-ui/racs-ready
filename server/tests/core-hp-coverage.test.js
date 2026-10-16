'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const mongoose = require('mongoose');
const coverage = require('../utils/coreHpCoverage'), A = require('../public/js/appliance-services');
const { resolveCoreServicePricing } = require('../utils/coreServicePricing');
const { normalizeCoreServicePayload } = require('../utils/serviceCatalogPayload');
const recovery = require('../utils/resetRecoveryBackup');
const { parseArguments } = require('../scripts/expand-core-hp-prices');
const id = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
const copy = input => mongoose.mongo.BSON.EJSON.parse(recovery.serialize(input), { relaxed: true });
const service = () => ({ _id: id, name: 'Cleaning', slug: 'cleaning', category: 'Maintenance', active: true, isAirconService: true,
  updatedAt: new Date('2026-10-17T00:00:00Z'), durationMinutes: 60,
  hpPricing: [{ hp: 0.5, price: 100 }],
  airconTypes: [{ type: 'split', name: 'Split Type', hpPricing: [{ hp: 1, price: 1000, durationMinutes: 60 }, { hp: 2, price: 2000, durationMinutes: 120 }] },
    { type: 'cassette', name: 'Cassette Type', hpPricing: [{ hp: 1.5, price: 2500, durationMinutes: 90 }, { hp: 3, price: 4000, durationMinutes: 180 }] }] });

test('type-specific HP choices do not borrow unrelated legacy capacities or blank prices', () => {
  assert.deepEqual(A.airconHpOptions(service(), 'cassette', { inheritSplit: false }).map(row => row.hp), [1.5, 3]);
  assert.deepEqual(A.airconHpOptions(service(), 'split_suspended', { inheritSplit: false }), []);
  const unpriced = service(); unpriced.airconTypes[0].hpPricing.push({ hp: 5, price: null }, { hp: 4, price: '' });
  assert.deepEqual(A.airconHpOptions(unpriced, 'split').map(row => row.hp), [1, 2]);
  for (const selection of [{ applianceKind: 'aircon' }, {}]) {
    assert.throws(() => resolveCoreServicePricing(unpriced, { ...selection, airconType: 'split', hp: 5, quantity: 1, brand: 'Brand' }), /unavailable/);
  }
});

test('all requested HP tiers receive proposed prices while every saved price and original document remain unchanged', () => {
  const original = service(), before = recovery.serialize(original), proposal = coverage.buildProposal([original]);
  assert.equal(recovery.serialize(original), before); assert.equal(proposal.summary.existingPricesChanged, 0);
  assert.equal(proposal.summary.addedTypes, 1); assert.equal(proposal.summary.addedHpPrices, 29);
  for (const type of proposal.proposed[0].airconTypes) {
    assert.deepEqual(type.hpPricing.map(row => Number(row.hp)), coverage.HP);
    for (const row of type.hpPricing) assert.ok(Number.isFinite(Number(row.price)) && Number(row.price) > 0);
  }
  assert.deepEqual(proposal.proposed[0].supportedHpRange, { min: 0.5, max: 5 });
  const cassette = proposal.proposed[0].airconTypes.find(row => row.type === 'cassette');
  assert.equal(cassette.hpPricing.find(row => row.hp === 1.5).price, 2500);
  assert.equal(cassette.hpPricing.find(row => row.hp === 5).price, 6000);
  assert.match(proposal.csv, /PROPOSED - company review required/); assert.match(proposal.csv, /Saved price retained/);
});

test('saved zero rates stay saved, malformed source rates block proposals, and active empty types cannot be saved', () => {
  const original = service(); original.airconTypes[1].hpPricing.push({ hp: 5, price: 0 });
  const proposal = coverage.buildProposal([original]);
  assert.equal(proposal.proposed[0].airconTypes[1].hpPricing.find(row => row.hp === 5).price, 0);
  const invalid = service(); invalid.airconTypes[0].hpPricing.push({ hp: 2, price: 900 });
  assert.throws(() => coverage.buildProposal([invalid]), /invalid or duplicate/);
  assert.throws(() => normalizeCoreServicePayload({ airconTypes: [{ type: 'cassette', hpPricing: [] }] }), /priced HP tier/);
  assert.doesNotThrow(() => normalizeCoreServicePayload({ active: false, airconTypes: [{ type: 'cassette', hpPricing: [] }] }));
});

test('HP expansion preserves exact split prices and work minutes for missing suspended and cassette rates', () => {
  const original=service();original.airconTypes[0].hpPricing[0].durationMinutes=80;
  const result=coverage.buildProposal([original]);
  for(const type of ['split_suspended','cassette']){
    const tier=result.proposed[0].airconTypes.find(row=>row.type===type).hpPricing.find(row=>row.hp===1);
    assert.equal(tier.price,1000);assert.equal(tier.durationMinutes,80);
  }
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racs-core-prices-'));
  t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  let state = { coreservices: [service()], sitesettings: [], activitylogs: [] }, writes = 0, fail = false;
  const db = { databaseName: 'isolated-core-price-fixture', admin: () => ({ command: async () => ({ setName: 'fixture' }) }),
    collection(name) { return {
      find() { return { sort() { return this; }, limit() { return this; }, toArray: async () => copy(state[name] || []) }; },
      findOne: async filter => copy(state[name].find(row => row.key === filter.key) || null),
      updateOne: async (filter, update) => { writes++; const row = state[name].find(row => String(row._id) === String(filter._id));
        if (row) { Object.assign(row, copy(update.$set)); for (const key of Object.keys(update.$unset || {})) delete row[key]; } return { matchedCount: row ? 1 : 0 }; },
      insertOne: async row => { writes++; if (fail && name === 'activitylogs') throw Error('Synthetic audit failure'); state[name].push(copy(row)); },
      deleteOne: async filter => { writes++; state[name] = state[name].filter(row => row.key !== filter.key); },
    }; } };
  const client = { startSession() { return { async withTransaction(work) {
    const before = copy(state); try { await work(); } catch (error) { state = before; throw error; }
  }, async endSession() {} }; } };
  return { db, client, backupDirectory: directory, now: new Date('2026-10-17T01:00:00Z'),
    get state() { return state; }, get writes() { return writes; }, failAudit() { fail = true; } };
}

test('prepare creates a review CSV and verified recovery files without database writes', async t => {
  const f = fixture(t), result = await coverage.preview({ ...f, prepare: true });
  assert.equal(result.mode, 'prepared'); assert.equal(result.databaseChanges, 0); assert.equal(f.writes, 0);
  assert.equal(result.recoveryVerified, true); assert.match(fs.readFileSync(result.proposalCsv, 'utf8'), /company review required/);
  const download = require('../utils/bookingOrderResetBackupDownload');
  assert.equal(download.BACKUP_NAME.test(path.basename(result.proposalCsv)), true);
  assert.equal(download.BACKUP_NAME.test('../' + path.basename(result.proposalCsv)), false);
  assert.equal(download.BACKUP_NAME.test('core-pricing-update-1792175490194-fcb24c6f.ejson.gz.html'), false);
});

test('applying reviewed rates is atomic and idempotent, preserves saved amounts, and supports recovery', async t => {
  const f = fixture(t), original = copy(f.state.coreservices), prepared = await coverage.preview({ ...f, prepare: true });
  const input = { ...f, backupFile: prepared.backup };
  const result = await coverage.apply(input);
  assert.equal(result.mode, 'updated'); assert.equal(result.atomic, true);
  assert.equal(A.price(f.state.coreservices[0], { applianceKind: 'aircon', brand: 'Brand', airconType: 'cassette', hp: 5 }).unitPrice, 6000);
  assert.equal((await coverage.apply(input)).mode, 'already-applied');
  assert.equal((await coverage.preview({ ...f, prepare: true })).mode, 'already-applied');
  assert.equal((await coverage.apply({ ...input, restore: true })).mode, 'restored');
  assert.deepEqual(f.state.coreservices[0].airconTypes, original[0].airconTypes);
  assert.equal(f.state.coreservices[0].supportedHpRange, undefined);
});

test('edited catalogs and transaction failures cannot leave partially expanded prices', async t => {
  const f = fixture(t), prepared = await coverage.preview({ ...f, prepare: true });
  f.state.coreservices[0].airconTypes[0].hpPricing[0].price += 50;
  await assert.rejects(coverage.apply({ ...f, backupFile: prepared.backup }), /changed after preparation/);
  assert.equal(f.writes, 0);
  const fresh = await coverage.preview({ ...f, prepare: true }), before = copy(f.state);
  f.failAudit(); await assert.rejects(coverage.apply({ ...f, backupFile: fresh.backup }), /Synthetic audit failure/);
  assert.deepEqual(f.state, before);
});

test('corrupt, expired and foreign-database recovery files cannot update prices', async t => {
  const f = fixture(t), prepared = await coverage.preview({ ...f, prepare: true });
  const input = { ...f, backupFile: prepared.backup };
  await assert.rejects(coverage.apply({ ...input, now: new Date(f.now.getTime() + 86400001) }), /expired/);
  f.db.databaseName = 'different-database';
  await assert.rejects(coverage.apply(input), /matching core-pricing/);
  f.db.databaseName = 'isolated-core-price-fixture';
  fs.appendFileSync(prepared.backup, 'corrupt');
  await assert.rejects(coverage.apply(input), /checksum/); assert.equal(f.writes, 0);
});

test('recovery preserves staff price edits made after the expansion', async t => {
  const f = fixture(t), prepared = await coverage.preview({ ...f, prepare: true });
  const input = { ...f, backupFile: prepared.backup }; await coverage.apply(input);
  f.state.coreservices[0].airconTypes[0].hpPricing[0].price += 50;
  const before = copy(f.state);
  await assert.rejects(coverage.apply({ ...input, restore: true }), /refuses to overwrite staff changes/);
  assert.deepEqual(f.state, before);
});

test('the CLI requires the exact prepared backup for writes', () => {
  assert.equal(parseArguments([]).mode, 'preview'); assert.equal(parseArguments(['--prepare']).mode, 'prepare');
  assert.equal(parseArguments(['--apply', '--backup', 'private.ejson.gz']).mode, 'apply');
  for (const args of [['--apply'], ['--prepare', '--apply'], ['--restore', '--backup'], ['--backup', 'x'], ['--force']]) assert.throws(() => parseArguments(args));
});

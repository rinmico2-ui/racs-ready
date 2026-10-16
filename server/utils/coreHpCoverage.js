'use strict';
const fs = require('node:fs'), path = require('node:path');
const recovery = require('./resetRecoveryBackup');
const { airconHpOptions, airconHpValues } = require('../public/js/appliance-services');
const { csvRows } = require('./reportCsv');
const OPERATION = 'core-hp-coverage-20261017-v1';
const HP = airconHpValues;
const REQUIRED_TYPES = { split_suspended: 'Split Suspended', cassette: 'Cassette Type' };

function estimate(rows, hp, field, fallback) {
  const points = rows.filter(row => Number.isFinite(Number(row[field])) && Number(row[field]) > 0);
  if (!points.length) { if (fallback > 0) return fallback; throw Error('Missing source prices require staff review.'); }
  if (points.length === 1) return Number(points[0][field]) * hp / Number(points[0].hp);
  const upper = points.findIndex(row => Number(row.hp) >= hp);
  const right = upper <= 0 ? upper < 0 ? points.length - 1 : 1 : upper;
  const a = points[right - 1], b = points[right];
  return Number(a[field]) + (hp - Number(a.hp)) * (Number(b[field]) - Number(a[field])) / (Number(b.hp) - Number(a.hp));
}

function buildProposal(original) {
  const proposed = [], rows = []; let addedTypes = 0, addedTiers = 0;
  for (const service of original) {
    const types = (service.airconTypes || []).map(type => ({ ...type, hpPricing: [...(type.hpPricing || [])] }));
    // Existing type-specific prices always win. Only absent requested types
    // use split prices as a proposal; the CSV identifies these copied bases.
    for (const [type, name] of Object.entries(REQUIRED_TYPES)) if (!types.some(row => row.type === type)) {
      types.push({ type, name, hpPricing: [] }); addedTypes++;
    }
    for (const type of types) {
      const saved = airconHpOptions(service, type.type, { inheritSplit: false });
      if (saved.length !== (service.airconTypes?.find(row => row.type === type.type)?.hpPricing || []).length) throw Error(`${service.name}: fix invalid or duplicate saved HP prices first.`);
      const source = saved.length ? saved : airconHpOptions(service, 'split');
      if (!source.length) throw Error(`${service.name}: staff must provide source prices before generating missing HP tiers.`);
      const base = saved.length ? type.type : 'split';
      for (const hp of HP) {
        const existing = saved.find(row => row.hp === hp);
        if (existing) { rows.push([service.name, type.name, hp, existing.price, existing.price,
          existing.durationMinutes ?? '', existing.durationMinutes ?? '', 'Saved price retained', base]); continue; }
        const sharedExact = Object.hasOwn(REQUIRED_TYPES, type.type)
          ? airconHpOptions(service, 'split', { inheritSplit: false }).find(row => row.hp === hp) : null;
        const exact = sharedExact || source.find(row => row.hp === hp);
        const price = exact ? exact.price : Math.round(estimate(source, hp, 'price') / 50) * 50;
        const defaultMinutes = Number(service.durationMinutes || service.durationRange?.max || 60);
        const durationMinutes = sharedExact ? Number(sharedExact.durationMinutes || defaultMinutes)
          : Math.ceil((exact?.durationMinutes || estimate(source, hp, 'durationMinutes', defaultMinutes)) / 15) * 15;
        if (!(price > 0) || price > 1000000 || !(durationMinutes > 0) || durationMinutes > 10080) throw Error(`${service.name}: a proposed rate or duration needs manual review.`);
        type.hpPricing.push({ hp, price, durationMinutes }); addedTiers++;
        rows.push([service.name, type.name, hp, '', price, '', durationMinutes, 'PROPOSED - company review required', sharedExact ? 'split' : base]);
      }
      type.hpPricing.sort((a, b) => Number(a.hp) - Number(b.hp));
      type.supportedHpRange = { min: Math.min(...type.hpPricing.map(row => Number(row.hp))), max: Math.max(...type.hpPricing.map(row => Number(row.hp))) };
    }
    proposed.push({ ...service, airconTypes: types, supportedHpRange: {
      min: Math.min(...types.map(type => type.supportedHpRange.min)), max: Math.max(...types.map(type => type.supportedHpRange.max)) } });
  }
  return { proposed, csv: csvRows(['Service', 'Aircon type', 'HP', 'Saved price PHP', 'Proposed price PHP', 'Saved work minutes', 'Proposed work minutes', 'Review status', 'Source type'], rows),
    summary: { operation: OPERATION, services: original.length, hpTiers: HP, addedTypes, addedHpPrices: addedTiers,
      existingPricesChanged: 0, pricingMethod: 'Retain saved prices. Missing suspended/cassette HP use exact saved split prices and work times when available. Other missing HP are proposals using same-type trends rounded to PHP 50; estimated work times are rounded up to 15 minutes.',
      reviewRequired: 'New rates are proposals, not company-approved prices. Review the CSV before applying.',
      bookingsChanged: 0, paymentsChanged: 0, physicalStockChanges: 0 } };
}

async function read(db, session) {
  return db.collection('coreservices').find({ active: true, isAirconService: true }, { session }).sort({ _id: 1 }).limit(101).toArray();
}
async function validate(proposed) {
  const Model = require('../models/CoreService');
  for (const service of proposed) await new Model(service).validate();
}
async function preview({ db, prepare = false, backupDirectory, now = new Date() }) {
  const marker = await db.collection('sitesettings').findOne({ key: OPERATION });
  if (marker && !marker.value.restoredAt) return { mode: 'already-applied', operation: OPERATION, databaseChanges: 0 };
  const original = await read(db);
  if (!original.length || original.length > 100) throw Error('Expected 1 to 100 active aircon core services.');
  const proposal = buildProposal(original); await validate(proposal.proposed);
  if (!prepare) return { mode: 'dry-run', ...proposal.summary, databaseChanges: 0 };
  const backup = await recovery.writeResetBackup({ operation: OPERATION, database: db.databaseName, preparedAt: now,
    original: { coreservices: original }, seed: { coreservices: proposal.proposed } }, backupDirectory, { namePrefix: 'core-pricing-update' });
  const csvFile = backup.backup + '.prices.csv';
  fs.writeFileSync(csvFile, proposal.csv, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { mode: 'prepared', ...proposal.summary, ...backup, databaseChanges: 0,
    proposalCsv: csvFile, proposalDownloadPath: '/admin/maintenance/data-reset-backups/' + path.basename(csvFile),
    next: 'Download the proposed-price CSV, backup and checksum. Review the proposed rates before --apply --backup EXACT-FILE. Preparation changes no catalog records.' };
}

async function apply({ db, client, backupFile, restore = false, now = new Date() }) {
  const { artifact, backupSha256 } = await recovery.readResetBackup(backupFile);
  if (artifact.operation !== OPERATION || artifact.database !== db.databaseName
    || Object.keys(artifact.original || {}).join() !== 'coreservices' || Object.keys(artifact.seed || {}).join() !== 'coreservices'
    || !Array.isArray(artifact.original?.coreservices) || !artifact.original.coreservices.length || artifact.original.coreservices.length > 100) throw Error('This is not a matching core-pricing recovery file.');
  if (!restore && (now - artifact.preparedAt < 0 || now - artifact.preparedAt > 86400000)) throw Error('Prepare a new price proposal; this one is expired.');
  const proposal = buildProposal(artifact.original.coreservices); await validate(proposal.proposed);
  if (recovery.serialize(proposal.proposed) !== recovery.serialize(artifact.seed.coreservices)) throw Error('Prepared price proposal changed.');
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw Error('Atomic pricing updates require a MongoDB replica set.');
  const session = client.startSession(); let duplicate = false;
  try {
    await session.withTransaction(async () => {
      const marker = await db.collection('sitesettings').findOne({ key: OPERATION }, { session });
      if (!restore && marker && !marker.value.restoredAt) { duplicate = true; return; }
      if (restore && (!marker || marker.value.backupSha256 !== backupSha256 || marker.value.restoredAt)) throw Error('This backup does not match the active pricing update.');
      const current = await read(db, session);
      if (!restore && recovery.digest({ coreservices: current }) !== artifact.originalSnapshotHash) throw Error('Core Services changed after preparation. Prepare a fresh proposal. No prices changed.');
      if (restore) for (const row of artifact.seed.coreservices) {
        const saved = current.find(item => String(item._id) === String(row._id));
        if (!saved || recovery.serialize(saved.airconTypes) !== recovery.serialize(row.airconTypes)
          || recovery.serialize(saved.supportedHpRange) !== recovery.serialize(row.supportedHpRange)) throw Error('Prices changed after applying. Automatic recovery refuses to overwrite staff changes.');
      }
      for (const row of restore ? artifact.original.coreservices : artifact.seed.coreservices) {
        const update = { $set: { airconTypes: row.airconTypes, updatedAt: now } };
        if (row.supportedHpRange == null) update.$unset = { supportedHpRange: 1 };
        else update.$set.supportedHpRange = row.supportedHpRange;
        const result = await db.collection('coreservices').updateOne({ _id: row._id }, update, { session });
        if (result.matchedCount !== 1) throw Error('A service disappeared. Pricing update rolled back.');
      }
      if (marker) await db.collection('sitesettings').deleteOne({ key: OPERATION }, { session });
      await db.collection('sitesettings').insertOne({ key: OPERATION, value: { backupSha256, appliedAt: marker?.value?.appliedAt || now,
        ...(restore ? { restoredAt: now } : {}) }, createdAt: now, updatedAt: now }, { session });
      await db.collection('activitylogs').insertOne({ action: restore ? 'CORE_HP_PRICES_RESTORED' : 'CORE_HP_PRICES_EXPANDED',
        actorName: 'Owner-authorized catalog pricing update', source: 'system', outcome: 'success', createdAt: now,
        details: { backupSha256, services: proposal.summary.services, addedHpPrices: proposal.summary.addedHpPrices } }, { session });
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } finally { await session.endSession(); }
  return { mode: duplicate ? 'already-applied' : restore ? 'restored' : 'updated', ...proposal.summary,
    reviewRequired: undefined, atomic: true, backup: backupFile, backupSha256, maintenanceChanged: false };
}
module.exports = { OPERATION, HP, estimate, buildProposal, preview, apply };

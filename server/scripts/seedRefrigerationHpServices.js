'use strict';

// Adds missing refrigeration price tables only. Dry-run unless --apply is supplied.
// Sample prices are demonstration data, not company-approved rates.
const { normalizeCoreServicePayload } = require('../utils/serviceCatalogPayload');
const A = require('../public/js/appliance-services');
const SLUGS = ['freon-recharging', 'leak-testing'];
const HP_SIZES = ['1/8', '1/6', '1/5', '1/4', '1/3', '1/2'];

function tiers(prices, minutes) {
  return HP_SIZES.map((hp, index) => ({ hp: A.parseHp(hp), price: prices[index], durationMinutes: minutes[index] }));
}

const SAMPLE_PRICES = {
  'freon-recharging': [
    { kind: 'refrigerator', enabled: true, pricingMode: 'hp', hpPricing: tiers([650, 700, 750, 800, 900, 1100], [45, 50, 55, 60, 65, 75]) },
    { kind: 'freezer', enabled: true, pricingMode: 'hp', hpPricing: tiers([800, 900, 1000, 1100, 1250, 1500], [60, 65, 70, 75, 80, 90]) },
  ],
  'leak-testing': [
    { kind: 'refrigerator', enabled: true, pricingMode: 'hp', hpPricing: tiers([350, 375, 400, 450, 500, 600], [30, 30, 35, 35, 40, 45]) },
    { kind: 'freezer', enabled: true, pricingMode: 'hp', hpPricing: tiers([400, 450, 500, 550, 650, 750], [40, 40, 45, 45, 50, 55]) },
  ],
};

function buildSeedPlan(records, prices) {
  if (!prices || Object.keys(prices).some(slug => !SLUGS.includes(slug))) throw new Error('Provide prices only for Freon Recharging and Leak Testing.');
  return SLUGS.map(slug => {
    const matches = records.filter(record => record.slug === slug);
    if (matches.length !== 1) throw new Error(`Expected one existing service for ${slug}; no records were written.`);
    const record = matches[0];
    if (record.active === false || record.archivedAt) throw new Error(`Enable ${record.name} in the admin catalog before seeding its prices.`);
    const supplied = structuredClone(prices[slug]);
    if (!Array.isArray(supplied) || supplied.length !== 2 || !['refrigerator', 'freezer'].every(kind => supplied.some(profile => profile.kind === kind))) {
      throw new Error(`Provide refrigerator and freezer HP tables for ${slug}.`);
    }
    for (const profile of supplied) {
      if (profile.enabled !== true || profile.pricingMode !== 'hp') throw new Error('Seed profiles must be enabled and use HP pricing.');
    }
    normalizeCoreServicePayload({ applianceProfiles: supplied });
    const existing = structuredClone(record.applianceProfiles || []);
    const added = supplied.filter(profile => !existing.some(saved => saved.kind === profile.kind));
    const patch = normalizeCoreServicePayload({ applianceProfiles: [...existing, ...added] });
    return { record, addedKinds: added.map(profile => profile.kind), applianceProfiles: patch.applianceProfiles };
  });
}

async function main(args = process.argv.slice(2)) {
  const fs = require('node:fs');
  const path = require('node:path');
  const mongoose = require('mongoose');
  const CoreService = require('../models/CoreService');
  const { buildMongoConnectionUri, disableRetryableWritesForDirectConnection } = require('../utils/mongoConnection');
  const fileIndex = args.indexOf('--prices');
  const useSamples = args.includes('--sample-prices');
  if (args.includes('--help')) {
    console.log('Preview: node server/scripts/seedRefrigerationHpServices.js --sample-prices');
    console.log('Save approved samples: add --apply. Company rates: use --prices path/to/prices.json instead.');
    console.log('Existing appliance profiles and all aircon prices are kept. A local recovery backup is saved before writing.');
    return;
  }
  const allowed = new Set(['--sample-prices', '--prices', '--apply']);
  if (args.some((arg, index) => !(fileIndex >= 0 && index === fileIndex + 1) && !allowed.has(arg))) throw new Error('Unknown seed argument. Use --help.');
  if (useSamples === (fileIndex >= 0) || fileIndex >= 0 && !args[fileIndex + 1]) throw new Error('Choose --sample-prices or --prices followed by a JSON file.');
  const prices = useSamples ? SAMPLE_PRICES : JSON.parse(fs.readFileSync(path.resolve(args[fileIndex + 1]), 'utf8'));
  // Validate all supplied tiers before making a connection.
  for (const slug of SLUGS) normalizeCoreServicePayload({ applianceProfiles: structuredClone(prices[slug]) });
  require('dotenv').config({ quiet: true });
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing.');
  const configured = buildMongoConnectionUri(process.env.MONGODB_URI, {
    directHosts: process.env.MONGODB_DIRECT_HOSTS,
    replicaSet: process.env.MONGODB_REPLICA_SET,
    authSource: process.env.MONGODB_AUTH_SOURCE,
  });
  const connection = mongoose.createConnection(disableRetryableWritesForDirectConnection(configured.uri), {
    autoIndex: false, autoCreate: false, maxPoolSize: 2, minPoolSize: 0,
    serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000, socketTimeoutMS: 20000,
  });
  try {
    await connection.asPromise();
    const collection = connection.db.collection(CoreService.collection.name);
    const records = await collection.find({ slug: { $in: SLUGS } }, {
      projection: { name: 1, slug: 1, category: 1, active: 1, archivedAt: 1, applianceProfiles: 1, updatedAt: 1 },
    }).toArray();
    const plan = buildSeedPlan(records, prices);
    for (const item of plan) {
      await new CoreService({ name: item.record.name, slug: item.record.slug, category: item.record.category, applianceProfiles: item.applianceProfiles }).validate();
    }
    const summary = plan.map(item => ({
      service: item.record.name, add: item.addedKinds,
      profiles: item.applianceProfiles.map(profile => ({ ...profile, hpPricing: (profile.hpPricing || []).map(tier => ({ ...tier, hpLabel: A.formatHp(tier.hp) })) })),
    }));
    console.log(JSON.stringify({ database: connection.db.databaseName, mode: args.includes('--apply') ? 'apply' : 'preview', samplePrices: useSamples, services: summary }, null, 2));
    const changes = plan.filter(item => item.addedKinds.length);
    if (!args.includes('--apply') || !changes.length) {
      console.log(changes.length ? 'Preview only; no records written.' : 'No changes needed; existing profiles were kept.');
      return;
    }
    const hello = await connection.db.admin().command({ hello: 1 });
    if (!hello.isWritablePrimary || !(hello.setName || hello.msg === 'isdbgrid')) throw new Error('A writable replica set is required to save both services together.');
    const backupDir = path.resolve(__dirname, '../../temp/seed-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `refrigeration-hp-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ at: new Date().toISOString(), database: connection.db.databaseName, collection: collection.collectionName, records: changes.map(item => item.record) }, null, 2), { encoding: 'utf8', flag: 'wx' });
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        for (const item of changes) {
          const result = await collection.updateOne({
            _id: item.record._id, active: { $ne: false }, archivedAt: null,
            applianceProfiles: Object.hasOwn(item.record, 'applianceProfiles') ? item.record.applianceProfiles : { $exists: false },
          }, { $set: { applianceProfiles: item.applianceProfiles, updatedAt: new Date() } }, { session });
          if (result.matchedCount !== 1) throw new Error('A service changed during seeding; the transaction was rolled back. Preview again.');
        }
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await session.endSession(); }
    const saved = await collection.find({ _id: { $in: changes.map(item => item.record._id) } }, { projection: { slug: 1, applianceProfiles: 1 } }).toArray();
    for (const item of changes) {
      const current = saved.find(record => record.slug === item.record.slug);
      if (JSON.stringify(current?.applianceProfiles) !== JSON.stringify(item.applianceProfiles)) throw new Error('Saved prices did not match the seed. Check the recovery backup.');
      for (const profile of current.applianceProfiles.filter(profile => item.addedKinds.includes(profile.kind))) {
        for (const tier of profile.hpPricing) {
          const quote = A.price({ ...item.record, applianceProfiles: current.applianceProfiles }, { applianceKind: profile.kind, brand: 'Seed verification', hp: tier.hp });
          if (quote.unitPrice !== tier.price || quote.duration !== tier.durationMinutes) throw new Error('Customer catalog pricing verification failed.');
        }
      }
    }
    console.log(`Saved and verified ${changes.length} services. Recovery backup: ${backupPath}`);
  } finally { await connection.close().catch(() => {}); }
}

if (require.main === module) {
  main().catch(error => {
    // Driver errors can include a URI or credentials. Report their type/code only.
    console.error('Refrigeration seed failed:', error.name?.startsWith('Mongo') ? error.code || error.name : error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildSeedPlan, SAMPLE_PRICES, HP_SIZES };

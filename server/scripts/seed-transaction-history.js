'use strict';
const mongoose = require('mongoose');

function parseArguments(args) {
  const options = { mode: 'preview', config: {} };
  const modes = args.filter(value => ['--preview', '--prepare', '--apply', '--verify', '--schema-audit'].includes(value));
  if (modes.length > 1) throw Error('Choose one mode: --preview, --prepare, --apply, --verify or --schema-audit.');
  if (modes.length) options.mode = modes[0].slice(2);
  for (let index = 0; index < args.length; index++) {
    const value = args[index]; if (modes.includes(value)) continue;
    if (!['--backup', '--batch', '--count', '--from', '--to'].includes(value) || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('Unknown or incomplete argument. Use --help.');
    const setting = args[++index];
    if (value === '--backup') options.backupFile = setting;
    else options.config[value.slice(2)] = value === '--count' ? Number(setting) : setting;
  }
  const consumesBackup = ['apply', 'verify'].includes(options.mode);
  if (consumesBackup !== Boolean(options.backupFile)) throw Error('Only --apply and --verify accept and require --backup /app/temp/FILE.ejson.gz.');
  if ((consumesBackup || options.mode === 'schema-audit') && Object.keys(options.config).length) throw Error('This mode uses the prepared configuration; do not supply count, dates or batch.');
  return options;
}
async function main(args) {
  if (args.includes('--help')) {
    console.log('Read-only preview: node server/scripts/seed-transaction-history.js\nPrepare private recovery files: node server/scripts/seed-transaction-history.js --prepare\nApply once: node server/scripts/seed-transaction-history.js --apply --backup /app/temp/FILE.ejson.gz\nRead-only verification: node server/scripts/seed-transaction-history.js --verify --backup /app/temp/FILE.ejson.gz\nInspect every model without a database: node server/scripts/seed-transaction-history.js --schema-audit\nDefaults: 1000 main transactions, 500 services + 500 orders; 80% completed, 20% cancelled; Jan 2022–Oct 15, 2026. See docs/transaction-history-seeding.md.');
    return;
  }
  const options = parseArguments(args);
  mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
  if (options.mode === 'schema-audit') {
    console.log(JSON.stringify(require('../utils/modelSchemaAudit').auditModelSchemas(), null, 2)); return;
  }
  require('dotenv').config({ quiet: true });
  if (!process.env.MONGODB_URI) throw Error('Database configuration is missing.');
  const mongo = require('../utils/mongoConnection');
  const connection = mongo.buildMongoConnectionUri(process.env.MONGODB_URI, { directHosts: process.env.MONGODB_DIRECT_HOSTS, replicaSet: process.env.MONGODB_REPLICA_SET, authSource: process.env.MONGODB_AUTH_SOURCE });
  await mongoose.connect(mongo.disableRetryableWritesForDirectConnection(connection.uri), { serverSelectionTimeoutMS: 8000, maxPoolSize: 2, autoIndex: false, autoCreate: false });
  const seed = require('../utils/transactionHistorySeed'), db = mongoose.connection.db;
  const result = ['apply', 'verify'].includes(options.mode)
    ? await seed.applySeed({ db, client: mongoose.connection.getClient(), backupFile: options.backupFile, verifyOnly: options.mode === 'verify' })
    : await seed.previewSeed({ db, config: options.config, prepare: options.mode === 'prepare' });
  console.log(JSON.stringify(result, null, 2));
  if (result.mode === 'blocked') process.exitCode = 2;
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: error.name, message: /^(Mongo|Mongoose)/.test(error.name)
    ? 'Database or transaction failed. Run inside Dokploy with the private MongoDB connection; no standalone write fallback was attempted.' : error.message }));
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
module.exports = { parseArguments, main };

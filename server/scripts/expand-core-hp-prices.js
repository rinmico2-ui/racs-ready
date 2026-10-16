'use strict';
const mongoose = require('mongoose');
function parseArguments(args) {
  if (!args.length) return { mode: 'preview' };
  if (args.length === 1 && args[0] === '--prepare') return { mode: 'prepare' };
  if (args.length === 3 && ['--apply', '--restore'].includes(args[0]) && args[1] === '--backup' && args[2] && !args[2].startsWith('--')) return { mode: args[0].slice(2), backupFile: args[2] };
  throw Error('Use no arguments to preview, --prepare to save a reviewable price proposal, or --apply/--restore --backup FILE.');
}
async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Preview: node server/scripts/expand-core-hp-prices.js\nPrepare private proposal CSV and recovery files: add --prepare\nApply reviewed prices: add --apply --backup /app/temp/EXACT-FILE.ejson.gz\nRecover saved prices: add --restore --backup FILE\nNo changes run on deployment. Existing rates and transaction snapshots are preserved. Maintenance is unchanged.'); return;
  }
  const options = parseArguments(args);
  require('dotenv').config({ quiet: true });
  mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
  const mongo = require('../utils/mongoConnection');
  const connection = mongo.buildMongoConnectionUri(process.env.MONGODB_URI, { directHosts: process.env.MONGODB_DIRECT_HOSTS,
    replicaSet: process.env.MONGODB_REPLICA_SET, authSource: process.env.MONGODB_AUTH_SOURCE });
  await mongoose.connect(mongo.disableRetryableWritesForDirectConnection(connection.uri), { serverSelectionTimeoutMS: 8000, maxPoolSize: 2, autoIndex: false, autoCreate: false });
  const context = { db: mongoose.connection.db, client: mongoose.connection.getClient(), backupFile: options.backupFile };
  const coverage = require('../utils/coreHpCoverage');
  const result = ['apply', 'restore'].includes(options.mode) ? await coverage.apply({ ...context, restore: options.mode === 'restore' })
    : await coverage.preview({ ...context, prepare: options.mode === 'prepare' });
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: error.name, message: /^(Mongo|Mongoose)/.test(error.name) ? 'Database operation failed. Run inside Dokploy without exposing credentials.' : error.message }));
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
module.exports = { parseArguments, main };

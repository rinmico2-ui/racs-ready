"use strict";

const mongoose = require("mongoose");
const cleanup = require("../utils/scheduledTransactionCleanup");

function parseArguments(args) {
  let mode = "preview", from, to, backupFile, modeSet = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (["--preview", "--prepare", "--compare", "--apply", "--restore"].includes(value)) {
      if (modeSet) throw Error("Choose one cleanup mode.");
      mode = value.slice(2); modeSet = true;
    } else if (["--from", "--to", "--backup"].includes(value) && args[index + 1] && !args[index + 1].startsWith("--")) {
      const input = args[++index];
      if (value === "--from" && !from) from = input;
      else if (value === "--to" && !to) to = input;
      else if (value === "--backup" && !backupFile) backupFile = input;
      else throw Error("Do not repeat cleanup arguments.");
    } else throw Error("Unknown or incomplete cleanup argument. Use --help.");
  }
  if (["compare", "apply", "restore"].includes(mode) !== Boolean(backupFile)) throw Error("Only --compare, --apply or --restore requires --backup FILE.");
  return { mode, config: cleanup.configuration(from, to), backupFile };
}

async function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("Read-only preview: node server/scripts/clear-scheduled-bookings-orders.js --from 2026-10-15 --to 2026-10-21\nPrepare private recovery files: same command plus --prepare\nCompare without deleting: same dates plus --compare --backup /app/temp/EXACT-FILE.ejson.gz\nDelete prepared records: same dates plus --apply --backup /app/temp/EXACT-FILE.ejson.gz\nRestore: same dates plus --restore --backup /app/temp/EXACT-FILE.ejson.gz\nDates are inclusive Philippine appointment/delivery/pickup dates. Preparing/applying requires maintenance. Nothing runs automatically on deployment. See docs/scheduled-transaction-cleanup.md.");
    return;
  }
  const options = parseArguments(args);
  require("dotenv").config({ quiet: true });
  if (!process.env.MONGODB_URI) throw Error("Database configuration is missing.");
  mongoose.set("autoIndex", false); mongoose.set("autoCreate", false);
  const mongo = require("../utils/mongoConnection");
  const connection = mongo.buildMongoConnectionUri(process.env.MONGODB_URI, {
    directHosts: process.env.MONGODB_DIRECT_HOSTS, replicaSet: process.env.MONGODB_REPLICA_SET, authSource: process.env.MONGODB_AUTH_SOURCE,
  });
  await mongoose.connect(mongo.disableRetryableWritesForDirectConnection(connection.uri), {
    serverSelectionTimeoutMS: 8000, maxPoolSize: 2, autoIndex: false, autoCreate: false,
  });
  const context = { ...options, db: mongoose.connection.db, client: mongoose.connection.getClient(),
    decryptEmail: require("../utils/emailOutbox")._private.decryptPayload };
  const result = options.mode === "preview" ? await cleanup.preview(context)
    : options.mode === "prepare" ? await cleanup.prepare(context)
    : options.mode === "compare" ? await cleanup.compare(context)
    : await cleanup.apply({ ...context, restore: options.mode === "restore" });
  console.log(JSON.stringify(result, null, 2));
  if (result.mode === "blocked") process.exitCode = 2;
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: error.name, message: /^(Mongo|Mongoose)/.test(error.name)
    ? "Database connection or atomic transaction failed. Run inside Dokploy and keep MongoDB private." : error.message,
    ...(error.changes ? { changes: error.changes } : {}) }));
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());

module.exports = { parseArguments, main };

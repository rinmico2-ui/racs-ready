"use strict";

// Never imported by application startup. Only an operator inside the private
// database network can run this one-time, owner-authorized reset.
const mongoose = require("mongoose");

function parseArguments(args) {
  let mode = "preview", backupFile;
  const modes = args.filter(value => ["--preview", "--prepare", "--apply", "--restore", "--delete-only"].includes(value));
  if (modes.length > 1) throw Error("Choose exactly one mode: --preview, --prepare, --apply, --restore or --delete-only.");
  if (modes.length) mode = modes[0].slice(2);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (modes.includes(value)) continue;
    if (value === "--backup" && args[index + 1] && !args[index + 1].startsWith("--")) backupFile = args[++index];
    else throw Error("Unknown or incomplete argument. Use --help for instructions.");
  }
  if (["apply", "restore"].includes(mode) && !backupFile) throw Error("--apply and --restore require --backup followed by the prepared private EJSON file path.");
  if (!["apply", "restore"].includes(mode) && backupFile) throw Error("--backup is only valid with --apply or --restore.");
  return { mode, backupFile };
}

async function main(args) {
  if (args.includes("--help")) {
    console.log("Preview (read-only): node server/scripts/reset-booking-order-data.js\nDelete without seeding and disable maintenance (fresh verified recovery backup first): node server/scripts/reset-booking-order-data.js --delete-only\nPrepare private compressed recovery files for demo seeding: node server/scripts/reset-booking-order-data.js --prepare\nApply prepared reset and seed: node server/scripts/reset-booking-order-data.js --apply --backup /app/temp/FILE.ejson.gz\nRestore unchanged reset (enable maintenance first): node server/scripts/reset-booking-order-data.js --restore --backup /app/temp/FILE.ejson.gz\nSee docs/booking-order-data-reset.md before applying. This does not run automatically during deployment.");
    return;
  }
  const options = parseArguments(args);
  require("dotenv").config({ quiet: true });
  if (!process.env.MONGODB_URI) throw Error("Database configuration is missing.");
  mongoose.set("autoIndex", false); mongoose.set("autoCreate", false);
  const { buildMongoConnectionUri, disableRetryableWritesForDirectConnection } = require("../utils/mongoConnection");
  const connection = buildMongoConnectionUri(process.env.MONGODB_URI, {
    directHosts: process.env.MONGODB_DIRECT_HOSTS, replicaSet: process.env.MONGODB_REPLICA_SET, authSource: process.env.MONGODB_AUTH_SOURCE,
  });
  await mongoose.connect(disableRetryableWritesForDirectConnection(connection.uri), { serverSelectionTimeoutMS: 8000, maxPoolSize: 2, autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db, reset = require("../utils/bookingOrderDataReset");
  const decryptEmail = require("../utils/emailOutbox")._private.decryptPayload;
  let result;
  if (options.mode === "preview") {
    const existing = await db.collection("sitesettings").findOne({ key: reset.RESET_KEY });
    result = existing ? { mode: "already-applied", operation: reset.RESET_KEY, message: "The reset has already run. No later bookings will be deleted." }
      : { ...reset.buildResetPlan(await reset.snapshotResetData(db, undefined, { decryptEmail })), databaseChanges: 0 };
  } else if (options.mode === "delete-only") result = await reset.deleteOnlyReset({ db, client: mongoose.connection.getClient(), decryptEmail });
  else if (options.mode === "prepare") result = await reset.prepareReset({ db, decryptEmail });
  else result = await reset.applyReset({ db, client: mongoose.connection.getClient(), backupFile: options.backupFile, decryptEmail, restore: options.mode === "restore" });
  console.log(JSON.stringify(result, null, 2));
  if (result.mode === "blocked") process.exitCode = 2;
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: error.name, code: error.code || null, message: /^(Mongo|Mongoose)/.test(error.name)
    ? "Database connection or atomic transaction failed. No unsafe standalone fallback was attempted. Run inside Dokploy; keep MongoDB private." : error.message }));
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());

module.exports = { parseArguments, main };

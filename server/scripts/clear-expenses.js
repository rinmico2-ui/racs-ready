"use strict";

// Operator-only; never imported by startup or HTTP routes.
const mongoose = require("mongoose");

function parseArguments(args) {
  if (!args.length) return { mode: "preview" };
  if (args.length === 1 && args[0] === "--apply") return { mode: "apply" };
  if (args.length === 3 && args[0] === "--restore" && args[1] === "--backup" && args[2] && !args[2].startsWith("--")) return { mode: "restore", backupFile: args[2] };
  throw Error("Use no arguments for a read-only preview, --apply to remove existing expenses, or --restore --backup FILE to recover them.");
}

async function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("Preview existing expenses (read-only): node server/scripts/clear-expenses.js\nBack up and delete existing expenses: node server/scripts/clear-expenses.js --apply\nRestore deleted expenses: node server/scripts/clear-expenses.js --restore --backup /app/temp/expense-reset-EXACT-FILE.ejson.gz\nPayroll, POS sales, receipt files and maintenance mode stay unchanged. This never runs automatically on deployment.");
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
  await mongoose.connect(mongo.disableRetryableWritesForDirectConnection(connection.uri), { serverSelectionTimeoutMS: 8000, maxPoolSize: 2, autoIndex: false, autoCreate: false });
  const cleanup = require("../utils/expenseDataCleanup"), context = { db: mongoose.connection.db, client: mongoose.connection.getClient() };
  const result = options.mode === "restore" ? await cleanup.restoreExpenses({ ...context, backupFile: options.backupFile })
    : await cleanup.cleanupExpenses({ ...context, apply: options.mode === "apply" });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: error.name, message: /^(Mongo|Mongoose)/.test(error.name)
    ? "Database connection or atomic transaction failed. Run inside Dokploy and keep MongoDB private. No standalone fallback was attempted." : error.message }));
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());

module.exports = { parseArguments, main };

"use strict";

// Read-only connection check. Never print the MongoDB URI or credentials.
require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const { buildMongoConnectionUri, disableRetryableWritesForDirectConnection } = require("../utils/mongoConnection");
const { inspectMongoDeployment } = require("../utils/mongoDeployment");

const configuredUri = process.env.MONGODB_URI;
if (!configuredUri) {
  console.error("MONGODB_URI is missing from the environment.");
  process.exitCode = 1;
} else {
  const parsed = new URL(configuredUri);
  const secrets = [configuredUri, parsed.username, parsed.password];
  for (const part of [parsed.username, parsed.password]) {
    if (part) {
      try { secrets.push(decodeURIComponent(part)); } catch { /* Already decoded. */ }
    }
  }

  const safe = (value) => {
    let output = String(value || "");
    for (const secret of secrets.filter(Boolean)) {
      output = output.split(secret).join("[redacted]");
    }
    return output.replace(/mongodb(?:\+srv)?:\/\/[^\s@]+@/gi, "mongodb://[redacted]@");
  };

  const positiveInteger = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };

  async function check(label, uri) {
    const startedAt = Date.now();
    const connection = mongoose.createConnection(disableRetryableWritesForDirectConnection(uri), {
      retryWrites: false,
      maxPoolSize: positiveInteger(process.env.MONGODB_MAX_POOL_SIZE, 20),
      minPoolSize: positiveInteger(process.env.MONGODB_MIN_POOL_SIZE, process.env.NODE_ENV === "production" ? 2 : 1),
      waitQueueTimeoutMS: positiveInteger(process.env.MONGODB_WAIT_QUEUE_TIMEOUT_MS, 5000),
      serverSelectionTimeoutMS: positiveInteger(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 5000),
      connectTimeoutMS: positiveInteger(process.env.MONGODB_CONNECT_TIMEOUT_MS, 10000),
      socketTimeoutMS: positiveInteger(process.env.MONGODB_SOCKET_TIMEOUT_MS, 45000),
      maxIdleTimeMS: positiveInteger(process.env.MONGODB_MAX_IDLE_TIME_MS, 60000),
    });
    try {
      await connection.asPromise();
      await connection.db.admin().ping();
      console.log(`${label}: connected; ping succeeded in ${Date.now() - startedAt} ms`);
      const deployment = await inspectMongoDeployment(connection);
      console.log(`${label}: database=${safe(connection.db.databaseName)}; topology=${deployment.topology}; writable primary=${deployment.writablePrimary}; transactions configured=${deployment.transactionsConfigured}`);
      if (deployment.replicaSet) console.log(`${label}: replica set=${safe(deployment.replicaSet)}`);
      if (!deployment.transactionsConfigured) {
        console.error("This database can connect, but is not configured for the transactions required by payment, booking and equipment workflows. Configure a replica set before using those actions.");
        if (process.argv.includes("--require-transactions")) return false;
      }
      return true;
    } catch (error) {
      console.error(`${label}: ${safe(error.name)} after ${Date.now() - startedAt} ms: ${safe(error.message)}`);
      for (const [host, description] of error.reason?.servers || []) {
        const cause = description.error;
        console.error(`  ${safe(host)}: ${safe(cause?.name || description.type)}${cause?.code ? ` (${safe(cause.code)})` : ""}: ${safe(cause?.message || "no server response")}`);
      }
      return false;
    } finally {
      await connection.close().catch(() => {});
    }
  }

  (async () => {
    const srvOk = await check("Configured MongoDB URI", configuredUri);
    if (process.env.MONGODB_DIRECT_HOSTS) {
      const direct = buildMongoConnectionUri(configuredUri, {
        directHosts: process.env.MONGODB_DIRECT_HOSTS,
        replicaSet: process.env.MONGODB_REPLICA_SET,
        authSource: process.env.MONGODB_AUTH_SOURCE,
      });
      const directOk = await check("Configured direct hosts", direct.uri);
      process.exitCode = directOk ? 0 : 1;
    } else {
      process.exitCode = srvOk ? 0 : 1;
    }
  })().catch((error) => {
    process.exitCode = 1;
    console.error(`Diagnostic failed: ${safe(error.message)}`);
  });
}

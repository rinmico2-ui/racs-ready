"use strict";

// Read-only diagnostic. Does not create orders, change stock/payments, or
// migrate evidence. Never log connection strings, customers, or image data.
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { buildMongoConnectionUri } = require("../utils/mongoConnection");
const { imageMimeFromSignature } = require("../utils/uploadSecurity");

async function audit() {
  const connection = buildMongoConnectionUri(process.env.MONGODB_URI, {
    directHosts: process.env.MONGODB_DIRECT_HOSTS,
    replicaSet: process.env.MONGODB_REPLICA_SET,
    authSource: process.env.MONGODB_AUTH_SOURCE,
  });
  await mongoose.connect(connection.uri, { serverSelectionTimeoutMS: 5000, maxPoolSize: 1, autoIndex: false });
  const db = mongoose.connection.db;
  const orders = await db.collection("orders").find({ gcashProofUrl: { $type: "string" } }, {
    projection: { orderReference: 1, gcashProofUrl: 1, gcashProofFileId: 1, createdAt: 1, fulfillmentType: 1 },
  }).sort({ createdAt: -1 }).limit(12).toArray();
  for (const order of orders) {
    const src = String(order.gcashProofUrl || "");
    const result = { id: String(order._id), reference: order.orderReference, createdAt: order.createdAt,
      fulfillment: order.fulfillmentType, storage: src.startsWith("data:") ? "inline" : src.startsWith("/api/orders/") ? "persistent-api" : "url" };
    if (/^\/?uploads\/gcash-receipts\/[A-Za-z0-9._-]+$/.test(src)) {
      const localPath = path.join(__dirname, "../public", src);
      result.localExists = fs.existsSync(localPath);
      if (result.localExists) {
        result.localBytes = fs.statSync(localPath).size;
        const descriptor = fs.openSync(localPath, "r");
        try {
          const header = Buffer.alloc(16);
          const length = fs.readSync(descriptor, header, 0, header.length, 0);
          result.detectedImageType = imageMimeFromSignature(header.subarray(0, length));
        } finally { fs.closeSync(descriptor); }
      }
    }
    if (order.gcashProofFileId) {
      const file = await db.collection("paymentProofs.files").findOne({ _id: order.gcashProofFileId }, { projection: { length: 1, contentType: 1 } });
      result.storedFileExists = Boolean(file);
      if (file) { result.storedBytes = file.length; result.contentType = file.contentType; }
    }
    console.log(JSON.stringify(result));
  }
}

audit().catch(() => {
  console.error("Receipt audit could not connect or read; no data changed.");
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());

"use strict";
// Dry-run by default. Copies original files into GridFS with --apply;
// expense amounts, approval status and saved receipt references stay intact.
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const path = require("node:path");
const { BUCKET_NAME } = require("../utils/financialReceiptStorage");
const { recoverLegacyExpenseReceipt } = require("../utils/legacyExpenseReceiptRecovery");
const { buildMongoConnectionUri, disableRetryableWritesForDirectConnection } = require("../utils/mongoConnection");

(async () => {
  const apply = process.argv.includes("--apply");
  const configured = buildMongoConnectionUri(process.env.MONGODB_URI, { directHosts: process.env.MONGODB_DIRECT_HOSTS, replicaSet: process.env.MONGODB_REPLICA_SET, authSource: process.env.MONGODB_AUTH_SOURCE });
  const connection = mongoose.createConnection(disableRetryableWritesForDirectConnection(configured.uri), { autoIndex: false, autoCreate: false, maxPoolSize: 2, minPoolSize: 0, serverSelectionTimeoutMS: 8000, retryWrites: false });
  try {
    await connection.asPromise();
    const bucket = new mongoose.mongo.GridFSBucket(connection.db, { bucketName: BUCKET_NAME });
    const expenses = connection.db.collection("expenses").find({ receiptImage: /^\/uploads\/expense-receipts\/expense-\d+-\d+\.(?:jpe?g|png|webp|pdf)$/i }, { projection: { receiptImage: 1, technicianId: 1 } });
    const seen = new Set();
    console.log(apply ? "Recovery: saving original files to MongoDB." : "Dry run: no database changes. Add --apply to save original files.");
    for await (const expense of expenses) {
      if (seen.has(expense.receiptImage)) continue;
      seen.add(expense.receiptImage);
      const technician = await connection.db.collection("technicians").findOne({ _id: expense.technicianId }, { projection: { user: 1 } });
      const result = await recoverLegacyExpenseReceipt({ legacyPath: expense.receiptImage, uploadedBy: technician?.user, directory: path.join(__dirname, "../public/uploads/expense-receipts"), bucket, apply });
      console.log(JSON.stringify({ filename: path.basename(expense.receiptImage), ...result }));
    }
  } catch (error) {
    process.exitCode = 1;
    console.error("Receipt recovery failed:", error.code || error.name);
  } finally { await connection.close().catch(() => {}); }
})();

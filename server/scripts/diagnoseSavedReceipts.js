"use strict";

// Read-only: do not start the application, register models or create indexes.
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { buildMongoConnectionUri, disableRetryableWritesForDirectConnection } = require("../utils/mongoConnection");

(async () => {
  const configured = buildMongoConnectionUri(process.env.MONGODB_URI, { directHosts: process.env.MONGODB_DIRECT_HOSTS, replicaSet: process.env.MONGODB_REPLICA_SET, authSource: process.env.MONGODB_AUTH_SOURCE });
  const connection = mongoose.createConnection(disableRetryableWritesForDirectConnection(configured.uri), { autoIndex: false, autoCreate: false, maxPoolSize: 2, minPoolSize: 0, serverSelectionTimeoutMS: 8000, retryWrites: false });
  try {
    await connection.asPromise();
    const filename = process.argv[2];
    if (filename && /^expense-\d+-\d+\.(?:jpe?g|png|webp|pdf)$/i.test(filename)) {
      const legacyPath = `/uploads/expense-receipts/${filename}`;
      const references = await connection.db.collection("expenses").countDocuments({ receiptImage: legacyPath });
      const savedFile = await connection.db.collection("financialReceipts.files").findOne({ "metadata.legacyPath": legacyPath }, { projection: { _id: 1 } });
      console.log("Requested receipt:", JSON.stringify({ filename, expenseReferences: references, presentOnThisComputer: fs.existsSync(path.join(__dirname, "../public", legacyPath)), recoveredInDatabase: !!savedFile }));
    }
    const receipts = await connection.db.collection("expenses").find({ receiptImage: { $type: "string", $ne: "" } }, { projection: { receiptImage: 1 } }).limit(30).toArray();
    const summary = { inspected: receipts.length, inlineImages: 0, inlinePdfs: 0, localFilesPresent: 0, localFilesMissing: 0, externalUrls: 0, other: 0 };
    for (const record of receipts) {
      const value = record.receiptImage;
      if (/^data:image\//i.test(value)) summary.inlineImages++;
      else if (/^data:application\/pdf/i.test(value)) summary.inlinePdfs++;
      else if (/^\/uploads\/[a-z-]+\/[A-Za-z0-9._-]+$/.test(value)) {
        const file = path.join(__dirname, "../public", value);
        summary[fs.existsSync(file) ? "localFilesPresent" : "localFilesMissing"]++;
      } else if (/^https?:\/\//i.test(value)) summary.externalUrls++;
      else summary.other++;
    }
    console.log("Expense receipt storage:", JSON.stringify(summary));
    const projects = await connection.db.collection("projects").find({ archivedAt: null }, { projection: { bookingId: 1, "payment.proofUrl": 1 } }).limit(30).toArray();
    const bookingIds = projects.map(project => project.bookingId).filter(Boolean);
    const bookings = bookingIds.length ? await connection.db.collection("bookingservices").find({ _id: { $in: bookingIds } }, { projection: { paymentProofFileId: 1, paymentProof: 1 } }).toArray() : [];
    console.log("Project receipt references:", JSON.stringify({ projects: projects.length, legacyProjectReceipts: projects.filter(project => project.payment?.proofUrl).length, sourceBookingReceipts: bookings.filter(booking => booking.paymentProof || booking.paymentProofFileId).length, storedFileReceipts: bookings.filter(booking => booking.paymentProofFileId).length }));
  } catch (error) {
    process.exitCode = 1;
    console.error("Receipt diagnostic failed:", error.code || error.name);
  } finally { await connection.close().catch(() => {}); }
})();

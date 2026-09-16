"use strict";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config();

const Assignment = require("../models/Assignment");
const BookingService = require("../models/BookingService");
const { buildMongoConnectionUri } = require("../utils/mongoConnection");
const { imageMimeFromSignature } = require("../utils/uploadSecurity");
const {
  deleteCompletionProof,
  storeCompletionProof,
} = require("../utils/completionProofStorage");

const apply = process.argv.includes("--apply");
const bookingFilterArg = process.argv.find((value) => value.startsWith("--booking="));
const filenameFilterArg = process.argv.find((value) => value.startsWith("--filename="));
const bookingFilter = bookingFilterArg
  ? bookingFilterArg.slice("--booking=".length).trim()
  : "";
const filenameFilter = filenameFilterArg
  ? filenameFilterArg.slice("--filename=".length).trim()
  : "";
const uploadDirectory = path.resolve(
  __dirname,
  "../public/uploads/completion-proofs",
);

function localProofFilename(value) {
  const match = String(value || "").match(
    /^\/uploads\/completion-proofs\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|webp))$/i,
  );
  return match ? match[1] : null;
}

async function run() {
  const configuredUri =
    process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler";
  const connection = buildMongoConnectionUri(configuredUri, {
    directHosts: process.env.MONGODB_DIRECT_HOSTS,
    replicaSet: process.env.MONGODB_REPLICA_SET,
    authSource: process.env.MONGODB_AUTH_SOURCE,
  });
  await mongoose.connect(connection.uri);

  const query = {
    proofPhoto: /^\/uploads\/completion-proofs\//,
    completionProofFileId: null,
  };
  if (bookingFilter) {
    query.$or = [{ bookingReference: bookingFilter }];
    if (mongoose.Types.ObjectId.isValid(bookingFilter)) {
      query.$or.push({ _id: bookingFilter });
    }
  }
  if (filenameFilter) {
    if (path.basename(filenameFilter) !== filenameFilter) {
      throw new Error("--filename must contain a filename only.");
    }
    query.proofPhoto = `/uploads/completion-proofs/${filenameFilter}`;
  }

  const bookings = await BookingService.find(query)
    .select("bookingReference proofPhoto +completionProofFileId")
    .lean();
  console.log(`Found ${bookings.length} local completion proof(s) awaiting migration.`);

  let migrated = 0;
  let missing = 0;
  let failed = 0;
  for (const booking of bookings) {
    const filename = localProofFilename(booking.proofPhoto);
    const filePath = filename ? path.resolve(uploadDirectory, filename) : "";
    const safePath = filePath && filePath.startsWith(uploadDirectory + path.sep);
    if (!safePath || !fs.existsSync(filePath)) {
      missing += 1;
      console.warn(`Missing ${booking.bookingReference || booking._id}: ${filename || "invalid path"}`);
      continue;
    }
    if (!apply) {
      console.log(`[dry-run] ${booking.bookingReference || booking._id}: ${filename}`);
      continue;
    }

    let storedProof = null;
    try {
      const buffer = await fs.promises.readFile(filePath);
      const mimetype = imageMimeFromSignature(buffer);
      if (!mimetype) throw new Error("Unsupported or invalid image content");
      storedProof = await storeCompletionProof(
        { buffer, mimetype, originalname: filename },
        { bookingId: booking._id },
      );
      const update = await BookingService.updateOne(
        { _id: booking._id, completionProofFileId: null },
        { $set: { completionProofFileId: storedProof.fileId } },
      );
      if (update.modifiedCount !== 1) {
        throw new Error("Booking changed while migration was running");
      }
      await Assignment.updateMany(
        { bookingId: booking._id },
        { $set: { completionProofFileId: storedProof.fileId } },
      );
      migrated += 1;
      console.log(`Migrated ${booking.bookingReference || booking._id}`);
    } catch (error) {
      failed += 1;
      if (storedProof && storedProof.fileId) {
        await deleteCompletionProof(storedProof.fileId).catch(() => {});
      }
      console.error(`Failed ${booking.bookingReference || booking._id}: ${error.message}`);
    }
  }

  if (!apply && bookings.length) {
    console.log("Dry run only. Re-run with --apply to persist files in GridFS.");
  }
  console.log(`Summary: ${migrated} migrated, ${missing} missing, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

run()
  .catch((error) => {
    console.error(`Completion proof migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });

"use strict";

const { isKnownStandalone } = require("./bookingSubmissionWrite");
const { isUnsupportedMongoWriteFeature } = require("./mongoWriteSupport");

// Persist the collected payment with the booking, assignment, and project.
// Single-server MongoDB uses reversals scoped to these new document IDs.
async function persistWalkInService({ mongoose, documents }) {
  const snapshots = documents.map(doc => ({ Model: doc.constructor, data: doc.toObject({ depopulate: true, versionKey: false }) }));
  const write = async session => {
    const saved = [];
    for (const { Model, data } of snapshots) {
      const doc = new Model(data);
      await doc.save(session ? { session } : undefined);
      saved.push(doc);
    }
    return saved;
  };
  if (!isKnownStandalone(mongoose.connection)) {
    let session;
    try {
      session = await mongoose.startSession();
      let saved;
      await session.withTransaction(async () => { saved = await write(session); });
      return saved;
    } catch (error) {
      if (!isUnsupportedMongoWriteFeature(error)) throw error;
      for (const { Model, data } of snapshots) {
        if (await Model.exists({ _id: data._id })) throw Object.assign(new Error("The booking save could not be confirmed. Contact support before retrying."), { status: 503 });
      }
    } finally { await session?.endSession(); }
  }
  try { return await write(null); }
  catch (error) {
    const cleanupErrors = [];
    for (const { Model, data } of snapshots.slice().reverse()) {
      try { await Model.deleteOne({ _id: data._id }); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw Object.assign(new Error("The booking save requires review. Contact support before retrying."), { status: 503, cause: error });
    throw error;
  }
}

module.exports = { persistWalkInService };

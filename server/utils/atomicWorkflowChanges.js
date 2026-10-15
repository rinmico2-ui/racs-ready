"use strict";
const { isKnownStandalone } = require('./bookingSubmissionWrite');
const { isUnsupportedMongoWriteFeature } = require('./mongoWriteSupport');

// Updates a small group of existing workflow documents. Standalone MongoDB
// reverses only the fields written by this request, with version guards.
async function atomicWorkflowChanges(changes, mongoose = require('mongoose')) {
  async function write(session, written = []) {
    const results = [];
    for (const change of changes) {
      const { Model, before, set, unset = {}, guard = {} } = change;
      const update = { $set: { ...set, updatedAt: new Date() }, $inc: { __v: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) };
      const result = await Model.findOneAndUpdate({ _id: before._id, status: before.status,
        ...(before.__v == null ? { $or: [{ __v: 0 }, { __v: { $exists: false } }] } : { __v: before.__v }),
        ...(before.updatedAt ? { updatedAt: before.updatedAt } : {}), ...guard }, update,
        { returnDocument: 'after', runValidators: true, ...(session ? { session } : {}) });
      if (!result) throw Object.assign(new Error('This job changed. Refresh before trying again.'), { status: 409 });
      written.push({ change, result }); results.push(result);
    }
    return results;
  }
  if (!isKnownStandalone(mongoose.connection)) {
    let session;
    try {
      session = await mongoose.startSession(); let results;
      await session.withTransaction(async () => { results = await write(session); });
      return results;
    } catch (error) { if (!isUnsupportedMongoWriteFeature(error)) throw error; }
    finally { await session?.endSession(); }
  }
  const written = [];
  try { return await write(null, written); }
  catch (error) {
    let failed = false;
    for (const { change, result } of written.reverse()) {
      const restore = {}, remove = {};
      for (const key of new Set([...Object.keys(change.set), ...Object.keys(change.unset || {}), 'updatedAt'])) {
        const value = key.split('.').reduce((object, part) => object?.[part], change.before);
        if (value === undefined) remove[key] = ''; else restore[key] = value;
      }
      try {
        const undo = await change.Model.updateOne({ _id: result._id, __v: result.__v }, { $set: restore, $inc: { __v: 1 }, ...(Object.keys(remove).length ? { $unset: remove } : {}) });
        if (!undo.matchedCount) failed = true;
      } catch (_) { failed = true; }
    }
    if (failed) throw Object.assign(new Error('The workflow update needs an Operations review. Do not submit it again.'), { status: 503 });
    throw error;
  }
}
module.exports = { atomicWorkflowChanges };

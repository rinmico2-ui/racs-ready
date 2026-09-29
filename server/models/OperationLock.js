const mongoose = require("mongoose");

// Short-lived distributed mutexes for operations whose invariant spans more
// than one MongoDB document/query (for example, capacity-check then insert).
// `_id` is the lock name, so MongoDB's unique primary-key index is the arbiter
// across every Node process.
const operationLockSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true, maxlength: 180 },
    owner: { type: String, required: true, maxlength: 100 },
    expiresAt: { type: Date, required: true },
    acquiredAt: { type: Date, required: true },
  },
  { versionKey: false },
);

operationLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("OperationLock", operationLockSchema);

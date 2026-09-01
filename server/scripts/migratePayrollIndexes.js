require("dotenv").config();
const mongoose = require("mongoose");
const Payroll = require("../models/Payroll");

const TARGET_INDEX = "payroll_employee_active_period_unique";

function isLegacyExactPeriodIndex(index) {
  const key = index && index.key;
  return Boolean(index && index.unique
    && key
    && key.employee === 1
    && key.periodStart === 1
    && key.periodEnd === 1
    && key.status === undefined);
}

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI or MONGO_URI is required");
  await mongoose.connect(uri);

  const collection = Payroll.collection;
  const indexes = await collection.indexes();
  const legacyIndexes = indexes.filter(isLegacyExactPeriodIndex);

  const conflicts = await Payroll.aggregate([
    { $match: { status: { $in: ["draft", "approved", "paid"] } } },
    {
      $group: {
        _id: {
          employee: "$employee",
          periodStart: "$periodStart",
          periodEnd: "$periodEnd",
        },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ]);
  if (conflicts.length) {
    throw new Error("Duplicate payroll lifecycle records exist. Resolve them before migrating payroll indexes.");
  }

  for (const index of legacyIndexes) await collection.dropIndex(index.name);
  try {
    await collection.createIndex(
      { employee: 1, periodStart: 1, periodEnd: 1 },
      {
        unique: true,
        name: TARGET_INDEX,
        partialFilterExpression: { status: { $in: ["draft", "approved", "paid"] } },
      },
    );
  } catch (error) {
    // Restore the former unique guard if the target deployment does not
    // support the new partial index or index creation fails unexpectedly.
    for (const index of legacyIndexes) {
      await collection.createIndex(index.key, { unique: true, name: index.name });
    }
    throw error;
  }

  console.log(JSON.stringify({
    droppedLegacyIndexes: legacyIndexes.map(index => index.name),
    ensuredIndex: TARGET_INDEX,
  }));
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error.message || error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});

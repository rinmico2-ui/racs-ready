require('dotenv').config();
const mongoose = require('mongoose');
const Tool = require('../models/Tool');

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI or MONGO_URI is required');
  await mongoose.connect(uri);

  const operational = await Tool.find({
    inventoryClass: { $exists: false },
    type: { $in: ['equipment', 'tool'] },
  });
  for (const item of operational) {
    item.inventoryClass = 'operational_asset';
    item.assetCode = item.assetCode || `ASSET-${item._id.toString().slice(-8).toUpperCase()}`;
    item.assetStatus = item.assetStatus || 'available';
    item.assetCondition = item.assetCondition || 'good';
    item.assignable = item.assignable !== false;
    item.sellingPrice = 0;
    await item.save();
  }

  const merchandise = await Tool.updateMany(
    { inventoryClass: { $exists: false }, type: { $nin: ['equipment', 'tool'] } },
    { $set: { inventoryClass: 'merchandise' } },
  );

  console.log(JSON.stringify({
    operationalAssetsMigrated: operational.length,
    merchandiseMigrated: merchandise.modifiedCount,
  }));
  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});

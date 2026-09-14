"use strict";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config();

const HVACProduct = require("../models/HVACProduct");
const { buildMongoConnectionUri } = require("../utils/mongoConnection");
const { imageMimeFromSignature } = require("../utils/uploadSecurity");
const {
  isCloudinaryConfigured,
  uploadProductImage,
} = require("../utils/productImageStorage");

const apply = process.argv.includes("--apply");
const uploadDirectory = path.resolve(__dirname, "../public/uploads/hvac");

async function run() {
  if (!isCloudinaryConfigured()) throw new Error("CLOUDINARY_URL is not configured.");
  const configuredUri = process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler";
  const connection = buildMongoConnectionUri(configuredUri, {
    directHosts: process.env.MONGODB_DIRECT_HOSTS,
    replicaSet: process.env.MONGODB_REPLICA_SET,
    authSource: process.env.MONGODB_AUTH_SOURCE,
  });
  await mongoose.connect(connection.uri);

  const products = await HVACProduct.find({ imageUrl: /^\/uploads\/hvac\// })
    .select("modelLine imageUrl imagePublicId")
    .lean();
  console.log(`Found ${products.length} HVAC product image(s) stored on local disk.`);

  let migrated = 0;
  let missing = 0;
  let failed = 0;
  for (const product of products) {
    const filename = path.basename(product.imageUrl);
    const filePath = path.resolve(uploadDirectory, filename);
    if (!filePath.startsWith(uploadDirectory + path.sep) || !fs.existsSync(filePath)) {
      missing += 1;
      console.warn(`Missing local image for ${product.modelLine}: ${filename}`);
      continue;
    }
    if (!apply) {
      console.log(`[dry-run] ${product.modelLine}: ${filename}`);
      continue;
    }

    try {
      const buffer = await fs.promises.readFile(filePath);
      const mimetype = imageMimeFromSignature(buffer);
      if (!mimetype) throw new Error("Unsupported or invalid image content");
      const uploaded = await uploadProductImage(
        { buffer, mimetype, originalname: filename },
        { publicId: String(product._id) },
      );
      const update = await HVACProduct.updateOne(
        { _id: product._id, imageUrl: product.imageUrl },
        { $set: { imageUrl: uploaded.imageUrl, imagePublicId: uploaded.imagePublicId } },
      );
      if (update.modifiedCount !== 1) throw new Error("Product changed while migration was running");
      migrated += 1;
      console.log(`Migrated ${product.modelLine}`);
    } catch (error) {
      failed += 1;
      console.error(`Failed ${product.modelLine}: ${error.message}`);
    }
  }

  if (!apply && products.length) console.log("Dry run only. Re-run with --apply to upload and update MongoDB.");
  console.log(`Summary: ${migrated} migrated, ${missing} missing, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

run()
  .catch(error => {
    console.error(`HVAC image migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });

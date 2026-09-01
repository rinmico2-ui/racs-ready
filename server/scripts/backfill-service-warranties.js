require("dotenv").config();
const mongoose = require("mongoose");
const CoreService = require("../models/CoreService");
const RepairService = require("../models/RepairService");
const { normalizeServiceWarrantyPolicy } = require("../utils/serviceWarrantyPolicy");

async function backfillModel(Model, kind) {
  const services = await Model.find({}).select("name slug warrantyDays warrantyPolicy").lean();
  let updated = 0;
  for (const service of services) {
    const needsBaselinePartsUpgrade = kind === "core"
      && Number(service.warrantyPolicy?.termsVersion) === 1
      && service.warrantyPolicy?.partsCoverage?.mode === "manufacturer_terms";
    if (service.warrantyPolicy && Number(service.warrantyPolicy.termsVersion) >= 1 && !needsBaselinePartsUpgrade) continue;
    const warrantyPolicy = normalizeServiceWarrantyPolicy(
      needsBaselinePartsUpgrade
        ? { ...service.warrantyPolicy, partsCoverage: { mode: "same_as_workmanship", days: service.warrantyPolicy.workmanshipDays } }
        : null,
      service,
      kind,
    );
    const update = { warrantyPolicy };
    if (kind === "repair") update.warrantyDays = warrantyPolicy.workmanshipDays;
    await Model.updateOne({ _id: service._id }, { $set: update });
    updated += 1;
  }
  const configured = await Model.find({}).select("name slug warrantyDays warrantyPolicy").sort({ name: 1 }).lean();
  return {
    scanned: services.length,
    updated,
    policies: configured.map(service => ({
      name: service.name,
      slug: service.slug,
      enabled: service.warrantyPolicy?.enabled !== false,
      coverageType: service.warrantyPolicy?.coverageType,
      workmanshipDays: service.warrantyPolicy?.workmanshipDays,
      partsMode: service.warrantyPolicy?.partsCoverage?.mode,
    })),
  };
}

async function main() {
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler";
  await mongoose.connect(mongoUri);
  const [core, repair] = await Promise.all([
    backfillModel(CoreService, "core"),
    backfillModel(RepairService, "repair"),
  ]);
  console.log(JSON.stringify({ core, repair }, null, 2));
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(error.message);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const CoreService = require("../models/CoreService");
const RepairService = require("../models/RepairService");
const ServiceCategory = require("../models/ServiceCategory");
const WarrantyClaim = require("../models/WarrantyClaim");
const {
  MIN_SERVICE_WARRANTY_DAYS,
  defaultPolicyForService,
  normalizeServiceWarrantyPolicy,
} = require("../utils/serviceWarrantyPolicy");
const { resolveWarrantyCoverages, DAY_MS } = require("../utils/warrantyLifecycle");
const { canTransitionClaim, claimPriority, isActiveClaimStatus } = require("../utils/warrantyClaimPolicy");
const { manufacturerWarrantyDays, buildOrderWarrantySnapshot } = require("../utils/orderWarrantyPolicy");
const { findRepairCategory, repairCategoryMatchScore } = require("../utils/aftercarePolicy");

test("recommended service warranties distinguish installation and routine workmanship", () => {
  assert.equal(defaultPolicyForService({ slug: "aircon-installation" }).workmanshipDays, 180);
  assert.equal(defaultPolicyForService({ slug: "aircon-relocation" }).workmanshipDays, 180);
  assert.equal(defaultPolicyForService({ slug: "dismantling-reinstall" }).workmanshipDays, 180);
  assert.equal(defaultPolicyForService({ slug: "cctv-installation" }).workmanshipDays, 180);
  assert.equal(defaultPolicyForService({ slug: "aircon-cleaning" }).workmanshipDays, 90);
  assert.equal(defaultPolicyForService({ slug: "freon-recharging" }).workmanshipDays, 90);
  assert.equal(defaultPolicyForService({ slug: "system-reprocess" }).coverageType, "diagnostic");
  assert.equal(defaultPolicyForService({ slug: "leak-testing" }).coverageType, "diagnostic");
});

test("service policy normalization enforces the statutory operational floor", () => {
  const policy = normalizeServiceWarrantyPolicy({
    enabled: true,
    workmanshipDays: 30,
    freeReinspectionDays: 0,
    claimResponseDays: 99,
    partsCoverage: { mode: "custom", days: 15 },
  }, { slug: "aircon-cleaning" }, "core");
  assert.equal(policy.workmanshipDays, MIN_SERVICE_WARRANTY_DAYS);
  assert.equal(policy.freeReinspectionDays, 1);
  assert.equal(policy.claimResponseDays, 30);
  assert.equal(policy.partsCoverage.days, MIN_SERVICE_WARRANTY_DAYS);
});

test("disabled services retain valid configured terms while coverage issuance is disabled", async () => {
  const policy = normalizeServiceWarrantyPolicy({ enabled: false }, { slug: "aircon-cleaning" }, "core");
  assert.equal(policy.enabled, false);
  assert.equal(policy.workmanshipDays, 90);
  const service = new CoreService({ name: "Test", slug: `test-${Date.now()}`, category: "Aircon", warrantyPolicy: policy });
  await service.validate();
});

test("repair services support structured parts and workmanship warranty configuration", async () => {
  const service = new RepairService({
    name: "Repair Test",
    slug: `repair-${Date.now()}`,
    warrantyDays: 120,
    warrantyPolicy: normalizeServiceWarrantyPolicy({ workmanshipDays: 120, partsCoverage: { mode: "same_as_workmanship" } }, {}, "repair"),
  });
  await service.validate();
  assert.equal(service.warrantyPolicy.partsCoverage.days, 120);
});

test("repair request categories own warranty policy without forcing legacy records to be configured", async () => {
  const category = new ServiceCategory({ name: "Aircon", slug: `aircon-${Date.now()}`, unitTypes: [{ value: "split_type", label: "Split Type Aircon" }] });
  await category.validate();
  assert.equal(category.warrantyPolicy, undefined);
  category.warrantyPolicy = normalizeServiceWarrantyPolicy({ workmanshipDays: 180 }, category, "repair");
  await category.validate();
  assert.equal(category.warrantyPolicy.workmanshipDays, 180);
});

test("generic repair booking items resolve to their customer repair category", () => {
  const categories = [
    { _id: "appliance", name: "Appliances", slug: "appliances", unitTypes: [{ value: "refrigerator", label: "Refrigerator" }] },
    { _id: "aircon", name: "Aircon", slug: "aircon", unitTypes: [{ value: "split_type", label: "Split Type Aircon" }] },
  ];
  const entry = { serviceName: "Split Type Aircon Repair", categoryTerms: ["split_type", "Split Type Aircon"] };
  assert.ok(repairCategoryMatchScore(entry, categories[1]) > repairCategoryMatchScore(entry, categories[0]));
  assert.equal(findRepairCategory(entry, categories)._id, "aircon");
});

test("repair category policy is snapshotted for generic repair completions", async () => {
  const originalCoreFind = CoreService.find;
  const originalRepairFind = RepairService.find;
  const originalCategoryFind = ServiceCategory.find;
  const query = value => ({ select() { return this; }, lean: async () => value });
  CoreService.find = () => query([]);
  RepairService.find = () => query([]);
  ServiceCategory.find = () => query([{
    _id: new mongoose.Types.ObjectId(),
    name: "Aircon",
    slug: "aircon",
    unitTypes: [{ value: "split_type", label: "Split Type Aircon" }],
    warrantyPolicy: normalizeServiceWarrantyPolicy({ workmanshipDays: 180, claimResponseDays: 3 }, {}, "repair"),
  }]);

  try {
    const { buildBookingWarrantyCoverage } = require("../utils/aftercarePolicy");
    const built = await buildBookingWarrantyCoverage({
      serviceModel: "RepairService",
      serviceType: "repair",
      services: [{ type: "repair", name: "Split Type Aircon Repair", applianceTypeName: "Split Type Aircon" }],
    }, new Date("2026-08-31T00:00:00.000Z"), {
      warranty: { repairBookingsEnabled: true, repairBookingDays: 90, serviceBookingsEnabled: true, serviceBookingDays: 90 },
    });
    assert.equal(built.coverage.coverages[0].days, 180);
    assert.equal(built.coverage.coverages[0].claimResponseDays, 3);
    assert.equal(built.coverage.coverages[0].policySource, "repair_category");
    assert.equal(built.coverage.coverages[0].policyOwnerName, "Aircon");
  } finally {
    CoreService.find = originalCoreFind;
    RepairService.find = originalRepairFind;
    ServiceCategory.find = originalCategoryFind;
  }
});

test("coverage snapshots expire independently", () => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  const coverages = resolveWarrantyCoverages({ coverages: [
    { coverageId: "routine", days: 90, startDate: start, endDate: new Date(start.getTime() + 90 * DAY_MS), status: "active" },
    { coverageId: "install", days: 180, startDate: start, endDate: new Date(start.getTime() + 180 * DAY_MS), status: "active" },
  ] }, start, new Date(start.getTime() + 120 * DAY_MS));
  assert.equal(coverages.find(item => item.coverageId === "routine").status, "expired");
  assert.equal(coverages.find(item => item.coverageId === "install").status, "active");
});

test("warranty claim transitions preserve admin decisions and technician field sequence", () => {
  assert.equal(canTransitionClaim("inspection_scheduled", "inspection_en_route", "technician"), true);
  assert.equal(canTransitionClaim("inspection_en_route", "inspection_arrived", "technician"), true);
  assert.equal(canTransitionClaim("inspection_arrived", "inspection_completed", "technician"), false);
  assert.equal(canTransitionClaim("inspection_completed", "approved", "admin"), true);
  assert.equal(isActiveClaimStatus("resolved"), true);
  assert.equal(isActiveClaimStatus("closed"), false);
  assert.equal(claimPriority({ safetyRisk: true }), "critical");
});

test("warranty claim schema rejects incomplete reports", async () => {
  const claim = new WarrantyClaim({
    claimReference: "WC-TEST-INVALID",
    customerId: new mongoose.Types.ObjectId(),
    sourceType: "booking",
    sourceId: new mongoose.Types.ObjectId(),
    sourceReference: "BOOK-1",
    coverageSnapshot: { days: 90 },
    claimType: "repair_workmanship",
    affectedItem: { name: "Aircon repair" },
    description: "short",
    discoveredAt: new Date(),
  });
  await assert.rejects(claim.validate(), /description/);
});

test("order warranties preserve seller, manufacturer, and installation coverage separately", () => {
  assert.equal(manufacturerWarrantyDays("1 Year Compressor, 6 Months Parts"), 365);
  assert.equal(manufacturerWarrantyDays("No written duration"), 0);
  const coverage = buildOrderWarrantySnapshot({
    fulfillmentType: "delivery_installation",
    items: [{ inventoryId: new mongoose.Types.ObjectId(), brand: "Daikin", modelLine: "D-Smart", manufacturerWarranty: "5 Years Compressor, 1 Year Parts" }],
  }, new Date("2026-08-30T00:00:00.000Z"), { days: 30 });
  assert.equal(coverage.coverages.length, 3);
  assert.ok(coverage.coverages.some(item => item.coverageType === "product" && item.days === 30));
  assert.ok(coverage.coverages.some(item => item.coverageType === "manufacturer_product" && item.days === 1825));
  assert.ok(coverage.coverages.some(item => item.coverageType === "installation" && item.days === 180));
});

test("disabling seller coverage does not suppress manufacturer or installation warranties", () => {
  const coverage = buildOrderWarrantySnapshot({
    fulfillmentType: "delivery_installation",
    items: [{ inventoryId: new mongoose.Types.ObjectId(), brand: "Daikin", modelLine: "D-Smart", manufacturerWarranty: "5 Years Compressor" }],
  }, new Date("2026-08-30T00:00:00.000Z"), { enabled: false, days: 30 });
  assert.ok(coverage);
  assert.equal(coverage.coverages.length, 2);
  assert.equal(coverage.coverages.some(item => item.coverageType === "product"), false);
  assert.ok(coverage.coverages.some(item => item.coverageType === "manufacturer_product"));
  assert.ok(coverage.coverages.some(item => item.coverageType === "installation"));
});

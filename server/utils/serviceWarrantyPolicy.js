const MIN_SERVICE_WARRANTY_DAYS = 90;
const MAX_WARRANTY_DAYS = 3650;

const SERVICE_WARRANTY_DEFAULTS = Object.freeze({
  "aircon-installation": { workmanshipDays: 180, coverageType: "installation" },
  "aircon-cleaning": { workmanshipDays: 90, coverageType: "workmanship" },
  "freon-recharging": { workmanshipDays: 90, coverageType: "workmanship" },
  "aircon-relocation": { workmanshipDays: 180, coverageType: "installation" },
  "dismantling-reinstall": { workmanshipDays: 180, coverageType: "installation" },
  "system-reprocess": { workmanshipDays: 90, coverageType: "diagnostic" },
  "pump-down": { workmanshipDays: 90, coverageType: "workmanship" },
  "leak-testing": { workmanshipDays: 90, coverageType: "diagnostic" },
  "cctv-installation": { workmanshipDays: 180, coverageType: "installation" },
});

const DEFAULT_COVERED_ITEMS = Object.freeze({
  installation: ["Mounting, piping, drainage, wiring, commissioning, and installation workmanship"],
  diagnostic: ["Accuracy and workmanship of the documented diagnostic procedure", "Free reinspection for the same reported symptom"],
  workmanship: ["Workmanship and materials directly supplied during the recorded service"],
});

const DEFAULT_EXCLUSIONS = Object.freeze([
  "Pre-existing defects not included in the approved service scope",
  "Damage caused by misuse, accident, power irregularity, force majeure, pests, corrosion, or unauthorized third-party work",
  "Normal wear, maintenance, and consumable depletion unrelated to the completed workmanship",
  "Manufacturer defects covered by a separate product warranty",
]);

function boundedInteger(value, fallback, min = 1, max = MAX_WARRANTY_DAYS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function stringList(value, fallback = [], maxItems = 20, maxLength = 300) {
  const source = Array.isArray(value) ? value : fallback;
  return source
    .map(item => String(item || "").trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function defaultPolicyForService(service = {}, kind = "core") {
  const slug = String(service.slug || "").trim().toLowerCase();
  const mapped = SERVICE_WARRANTY_DEFAULTS[slug] || {};
  const repair = kind === "repair";
  const coverageType = mapped.coverageType || (repair ? "workmanship" : "workmanship");
  const configuredLegacyDays = Number(service.warrantyDays);
  const workmanshipDays = Math.max(
    MIN_SERVICE_WARRANTY_DAYS,
    Number.isFinite(configuredLegacyDays) && configuredLegacyDays > 0
      ? Math.round(configuredLegacyDays)
      : (mapped.workmanshipDays || MIN_SERVICE_WARRANTY_DAYS),
  );
  return {
    enabled: true,
    coverageType,
    workmanshipDays,
    freeReinspectionDays: Math.min(workmanshipDays, 90),
    claimResponseDays: 2,
    coveredItems: [...(DEFAULT_COVERED_ITEMS[coverageType] || DEFAULT_COVERED_ITEMS.workmanship)],
    exclusions: [...DEFAULT_EXCLUSIONS],
    partsCoverage: {
      mode: "same_as_workmanship",
      days: workmanshipDays,
    },
    termsVersion: 1,
  };
}

function normalizeServiceWarrantyPolicy(value, service = {}, kind = "core") {
  const defaults = defaultPolicyForService(service, kind);
  const source = value && typeof value === "object" ? value : {};
  const enabled = source.enabled === undefined ? defaults.enabled : Boolean(source.enabled);
  const coverageTypes = new Set(["workmanship", "installation", "diagnostic"]);
  const coverageType = coverageTypes.has(source.coverageType) ? source.coverageType : defaults.coverageType;
  const workmanshipDays = boundedInteger(source.workmanshipDays, defaults.workmanshipDays, MIN_SERVICE_WARRANTY_DAYS);
  const partsModes = new Set(["manufacturer_terms", "same_as_workmanship", "custom", "not_included"]);
  const partsMode = partsModes.has(source.partsCoverage?.mode)
    ? source.partsCoverage.mode
    : defaults.partsCoverage.mode;
  const customPartsDays = partsMode === "custom"
    ? boundedInteger(source.partsCoverage?.days, workmanshipDays || MIN_SERVICE_WARRANTY_DAYS, MIN_SERVICE_WARRANTY_DAYS)
    : partsMode === "same_as_workmanship" ? workmanshipDays : null;

  return {
    enabled,
    coverageType,
    workmanshipDays,
    freeReinspectionDays: boundedInteger(source.freeReinspectionDays, Math.min(workmanshipDays, defaults.freeReinspectionDays), 1),
    claimResponseDays: boundedInteger(source.claimResponseDays, defaults.claimResponseDays, 1, 30),
    coveredItems: stringList(source.coveredItems, DEFAULT_COVERED_ITEMS[coverageType] || defaults.coveredItems),
    exclusions: stringList(source.exclusions, defaults.exclusions),
    partsCoverage: { mode: partsMode, days: customPartsDays },
    termsVersion: boundedInteger(source.termsVersion, defaults.termsVersion, 1, 1000000),
  };
}

function warrantyPolicySchema(mongoose) {
  return new mongoose.Schema({
    enabled: { type: Boolean, default: true },
    coverageType: { type: String, enum: ["workmanship", "installation", "diagnostic"], default: "workmanship" },
    workmanshipDays: { type: Number, min: MIN_SERVICE_WARRANTY_DAYS, max: MAX_WARRANTY_DAYS, default: MIN_SERVICE_WARRANTY_DAYS },
    freeReinspectionDays: { type: Number, min: 1, max: MAX_WARRANTY_DAYS, default: 90 },
    claimResponseDays: { type: Number, min: 1, max: 30, default: 2 },
    coveredItems: { type: [String], default: [] },
    exclusions: { type: [String], default: [] },
    partsCoverage: {
      mode: { type: String, enum: ["manufacturer_terms", "same_as_workmanship", "custom", "not_included"], default: "manufacturer_terms" },
      days: { type: Number, min: MIN_SERVICE_WARRANTY_DAYS, max: MAX_WARRANTY_DAYS, default: null },
    },
    termsVersion: { type: Number, min: 1, default: 1 },
  }, { _id: false });
}

module.exports = {
  MIN_SERVICE_WARRANTY_DAYS,
  SERVICE_WARRANTY_DEFAULTS,
  defaultPolicyForService,
  normalizeServiceWarrantyPolicy,
  warrantyPolicySchema,
};

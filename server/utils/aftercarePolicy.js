const SiteSetting = require("../models/SiteSetting");
const { buildWarrantyCoverage } = require("./warrantyLifecycle");
const { normalizeServiceWarrantyPolicy } = require("./serviceWarrantyPolicy");

const SETTING_KEY = "aftercarePolicy";

const DEFAULT_AFTERCARE_POLICY = Object.freeze({
  maintenance: Object.freeze({
    bookingsEnabled: true,
    bookingIntervalDays: 90,
    allowTechnicianRecommendation: true,
    ordersEnabled: true,
    orderIntervalDays: 90,
  }),
  reminders: Object.freeze({
    enabled: true,
    firstReminderDays: 30,
    finalReminderDays: 7,
    dueDateEnabled: true,
    overdueEnabled: true,
    notifyAdminWhenOverdue: true,
  }),
  warranty: Object.freeze({
    serviceBookingsEnabled: true,
    serviceBookingDays: 90,
    repairBookingsEnabled: true,
    repairBookingDays: 90,
    productOrdersEnabled: true,
    productOrderDays: 30,
  }),
});

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function booleanValue(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeAftercarePolicy(value = {}) {
  const maintenance = value && typeof value.maintenance === "object" ? value.maintenance : {};
  const reminders = value && typeof value.reminders === "object" ? value.reminders : {};
  const warranty = value && typeof value.warranty === "object" ? value.warranty : {};

  const finalReminderDays = boundedInteger(
    reminders.finalReminderDays,
    DEFAULT_AFTERCARE_POLICY.reminders.finalReminderDays,
    1,
    30,
  );
  const firstReminderDays = boundedInteger(
    reminders.firstReminderDays,
    DEFAULT_AFTERCARE_POLICY.reminders.firstReminderDays,
    finalReminderDays + 1,
    90,
  );

  return {
    maintenance: {
      bookingsEnabled: booleanValue(maintenance.bookingsEnabled, DEFAULT_AFTERCARE_POLICY.maintenance.bookingsEnabled),
      bookingIntervalDays: boundedInteger(maintenance.bookingIntervalDays, DEFAULT_AFTERCARE_POLICY.maintenance.bookingIntervalDays, 30, 730),
      allowTechnicianRecommendation: booleanValue(maintenance.allowTechnicianRecommendation, DEFAULT_AFTERCARE_POLICY.maintenance.allowTechnicianRecommendation),
      ordersEnabled: booleanValue(maintenance.ordersEnabled, DEFAULT_AFTERCARE_POLICY.maintenance.ordersEnabled),
      orderIntervalDays: boundedInteger(maintenance.orderIntervalDays, DEFAULT_AFTERCARE_POLICY.maintenance.orderIntervalDays, 30, 730),
    },
    reminders: {
      enabled: booleanValue(reminders.enabled, DEFAULT_AFTERCARE_POLICY.reminders.enabled),
      firstReminderDays,
      finalReminderDays,
      dueDateEnabled: booleanValue(reminders.dueDateEnabled, DEFAULT_AFTERCARE_POLICY.reminders.dueDateEnabled),
      overdueEnabled: booleanValue(reminders.overdueEnabled, DEFAULT_AFTERCARE_POLICY.reminders.overdueEnabled),
      notifyAdminWhenOverdue: booleanValue(reminders.notifyAdminWhenOverdue, DEFAULT_AFTERCARE_POLICY.reminders.notifyAdminWhenOverdue),
    },
    warranty: {
      serviceBookingsEnabled: booleanValue(warranty.serviceBookingsEnabled, DEFAULT_AFTERCARE_POLICY.warranty.serviceBookingsEnabled),
      serviceBookingDays: boundedInteger(warranty.serviceBookingDays, DEFAULT_AFTERCARE_POLICY.warranty.serviceBookingDays, 90, 3650),
      repairBookingsEnabled: booleanValue(warranty.repairBookingsEnabled, DEFAULT_AFTERCARE_POLICY.warranty.repairBookingsEnabled),
      repairBookingDays: boundedInteger(warranty.repairBookingDays, DEFAULT_AFTERCARE_POLICY.warranty.repairBookingDays, 90, 3650),
      productOrdersEnabled: booleanValue(warranty.productOrdersEnabled, DEFAULT_AFTERCARE_POLICY.warranty.productOrdersEnabled),
      productOrderDays: boundedInteger(warranty.productOrderDays, DEFAULT_AFTERCARE_POLICY.warranty.productOrderDays, 1, 3650),
    },
  };
}

async function getAftercarePolicy() {
  const setting = await SiteSetting.findOne({ key: SETTING_KEY }).lean();
  return normalizeAftercarePolicy(setting?.value);
}

function isRepairBooking(booking) {
  return String(booking?.serviceModel || "") === "RepairService"
    || String(booking?.serviceType || "").toLowerCase() === "repair"
    || (Array.isArray(booking?.services) && booking.services.some((service) => String(service?.type || "").toLowerCase() === "repair"));
}

function warrantyRuleForBooking(policy, booking) {
  const normalized = normalizeAftercarePolicy(policy);
  if (isRepairBooking(booking)) {
    return {
      enabled: normalized.warranty.repairBookingsEnabled,
      days: normalized.warranty.repairBookingDays,
      type: "repair_booking",
    };
  }
  return {
    enabled: normalized.warranty.serviceBookingsEnabled,
    days: normalized.warranty.serviceBookingDays,
    type: "service_booking",
  };
}

function warrantyRuleForOrder(policy) {
  const normalized = normalizeAftercarePolicy(policy);
  return {
    enabled: normalized.warranty.productOrdersEnabled,
    days: normalized.warranty.productOrderDays,
    type: "product_order",
  };
}

function serviceEntriesForBooking(booking = {}) {
  if (Array.isArray(booking.services) && booking.services.length) {
    return booking.services.map((service, index) => ({
      // An embedded item has its own Mongo _id; that is not a catalog id.
      serviceId: service.serviceId || null,
      serviceModel: String(service.type || "").toLowerCase() === "repair" ? "RepairService" : "CoreService",
      serviceName: service.name || `Service ${index + 1}`,
      categoryTerms: [service.applianceType, service.applianceTypeName, service.unitCategory, service.name, booking.services.length === 1 ? booking.unitInfo?.unitType : null].filter(Boolean),
      index,
    }));
  }
  return [{
    serviceId: booking.serviceId || booking.service?._id || null,
    serviceModel: booking.serviceModel || (isRepairBooking(booking) ? "RepairService" : "CoreService"),
    serviceName: booking.service?.name || booking.serviceName || (isRepairBooking(booking) ? "Repair Service" : "Service"),
    categoryTerms: [booking.unitInfo?.unitType, booking.applianceType, booking.applianceTypeName, booking.service?.name, booking.serviceName].filter(Boolean),
    index: 0,
  }];
}

function normalizeRepairCategoryTerm(value) {
  return String(value || "").toLowerCase().replace(/\brepairs?\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

function repairCategoryMatchScore(entry, category) {
  const entryTerms = [entry?.serviceName, ...(entry?.categoryTerms || [])].map(normalizeRepairCategoryTerm).filter(Boolean);
  const unitTerms = (Array.isArray(category?.unitTypes) ? category.unitTypes : [])
    .flatMap(unit => [unit?.value, unit?.label]).map(normalizeRepairCategoryTerm).filter(Boolean);
  const categoryTerms = [category?.name, category?.slug].map(normalizeRepairCategoryTerm).filter(Boolean);
  let score = 0;
  for (const entryTerm of entryTerms) {
    for (const unitTerm of unitTerms) {
      if (entryTerm === unitTerm) score = Math.max(score, 120);
      else if (unitTerm.length >= 3 && (entryTerm.includes(unitTerm) || unitTerm.includes(entryTerm))) score = Math.max(score, 100);
    }
    for (const categoryTerm of categoryTerms) {
      if (entryTerm === categoryTerm) score = Math.max(score, 80);
      else if (categoryTerm.length >= 3 && entryTerm.includes(categoryTerm)) score = Math.max(score, 60);
    }
  }
  return score;
}

function findRepairCategory(entry, categories = []) {
  return categories.reduce((best, category) => {
    const score = repairCategoryMatchScore(entry, category);
    return score > best.score ? { category, score } : best;
  }, { category: null, score: 0 }).category;
}

async function buildBookingWarrantyCoverage(booking, completedAt = new Date(), suppliedPolicy = null) {
  const policy = suppliedPolicy || await getAftercarePolicy();
  const entries = serviceEntriesForBooking(booking);
  const CoreService = require("../models/CoreService");
  const RepairService = require("../models/RepairService");
  const ServiceCategory = require("../models/ServiceCategory");
  const definitions = new Map();
  const coreIds = entries.filter(entry => entry.serviceModel === "CoreService" && entry.serviceId).map(entry => entry.serviceId);
  const repairIds = entries.filter(entry => entry.serviceModel === "RepairService" && entry.serviceId).map(entry => entry.serviceId);
  const hasRepairEntries = entries.some(entry => entry.serviceModel === "RepairService");
  const [coreServices, repairServices, repairCategories] = await Promise.all([
    coreIds.length ? CoreService.find({ _id: { $in: coreIds } }).select("name slug warrantyPolicy").lean() : [],
    repairIds.length ? RepairService.find({ _id: { $in: repairIds } }).select("name slug warrantyDays warrantyPolicy").lean() : [],
    hasRepairEntries ? ServiceCategory.find({}).select("name slug unitTypes warrantyPolicy").lean() : [],
  ]);
  [...coreServices, ...repairServices].forEach(service => definitions.set(String(service._id), service));

  const coverages = [];
  for (const entry of entries) {
    const definition = entry.serviceId ? definitions.get(String(entry.serviceId)) : null;
    const kind = entry.serviceModel === "RepairService" ? "repair" : "core";
    const repairCategory = kind === "repair" && !definition ? findRepairCategory(entry, repairCategories) : null;
    const policyOwner = definition || repairCategory;
    const globalRule = kind === "repair"
      ? { enabled: policy.warranty.repairBookingsEnabled, days: policy.warranty.repairBookingDays }
      : { enabled: policy.warranty.serviceBookingsEnabled, days: policy.warranty.serviceBookingDays };
    const legacyDefaults = normalizeServiceWarrantyPolicy(null, policyOwner || { slug: "" }, kind);
    const hasMappedServiceDefault = Boolean(definition?.slug && require("./serviceWarrantyPolicy").SERVICE_WARRANTY_DEFAULTS[String(definition.slug).toLowerCase()]);
    const servicePolicy = policyOwner?.warrantyPolicy
      ? normalizeServiceWarrantyPolicy(policyOwner.warrantyPolicy, policyOwner, kind)
      : {
          ...legacyDefaults,
          enabled: globalRule.enabled,
          workmanshipDays: hasMappedServiceDefault ? legacyDefaults.workmanshipDays : Math.max(90, globalRule.days),
          freeReinspectionDays: Math.min(90, hasMappedServiceDefault ? legacyDefaults.workmanshipDays : Math.max(90, globalRule.days)),
        };
    if (!servicePolicy.enabled) continue;
    const dates = buildWarrantyCoverage(completedAt, servicePolicy.workmanshipDays);
    coverages.push({
      coverageId: repairCategory ? `repair_category:${repairCategory._id}:${entry.index}` : `service:${entry.serviceId || entry.index}`,
      serviceId: entry.serviceId || null,
      serviceModel: entry.serviceModel,
      serviceName: definition?.name || entry.serviceName,
      serviceSlug: definition?.slug || repairCategory?.slug || "",
      policySource: repairCategory ? "repair_category" : (definition ? "service" : "global_fallback"),
      policyOwnerId: repairCategory?._id || definition?._id || null,
      policyOwnerName: repairCategory?.name || definition?.name || "Global fallback",
      coverageType: servicePolicy.coverageType,
      days: servicePolicy.workmanshipDays,
      startDate: dates.startDate,
      endDate: dates.endDate,
      status: dates.status,
      freeReinspectionDays: servicePolicy.freeReinspectionDays,
      claimResponseDays: servicePolicy.claimResponseDays,
      coveredItems: servicePolicy.coveredItems,
      exclusions: servicePolicy.exclusions,
      partsCoverage: servicePolicy.partsCoverage,
      termsVersion: servicePolicy.termsVersion,
    });
  }

  if (!coverages.length) return { rule: { enabled: false, days: 0, type: "service_booking" }, coverage: null };
  const summaryEnd = coverages.reduce((latest, item) => new Date(item.endDate) > latest ? new Date(item.endDate) : latest, new Date(coverages[0].endDate));
  const summaryDays = Math.max(...coverages.map(item => item.days));
  return {
    rule: { enabled: true, days: summaryDays, type: isRepairBooking(booking) ? "repair_booking" : "service_booking" },
    coverage: {
      days: summaryDays,
      startDate: new Date(completedAt),
      endDate: summaryEnd,
      status: "active",
      coverages,
    },
  };
}

module.exports = {
  SETTING_KEY,
  DEFAULT_AFTERCARE_POLICY,
  normalizeAftercarePolicy,
  getAftercarePolicy,
  buildBookingWarrantyCoverage,
  isRepairBooking,
  warrantyRuleForBooking,
  warrantyRuleForOrder,
  findRepairCategory,
  repairCategoryMatchScore,
};

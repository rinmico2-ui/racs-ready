"use strict";

const mongoose = require("mongoose");
const SiteSetting = require("../models/SiteSetting");
const ServiceCategory = require("../models/ServiceCategory");
const RepairService = require("../models/RepairService");

const DEFAULT_REPAIR_INSPECTION_FEE = 500;
const REPAIR_INSPECTION_FEE_SETTING_KEY = "repairInspectionDefaultFee";
const MAX_REPAIR_INSPECTION_FEE = 100000;

function normalizeTerm(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ");
}

function parseInspectionFee(value, { allowEmpty = false } = {}) {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    if (allowEmpty) return null;
    throw pricingError("Inspection fee is required.");
  }
  const fee = Number(value);
  if (!Number.isFinite(fee) || fee < 0 || fee > MAX_REPAIR_INSPECTION_FEE) {
    throw pricingError(`Inspection fee must be between 0 and ${MAX_REPAIR_INSPECTION_FEE.toLocaleString("en-PH")}.`);
  }
  return Math.round(fee * 100) / 100;
}

function pricingError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function getDefaultRepairInspectionFee() {
  const setting = await SiteSetting.findOne({ key: REPAIR_INSPECTION_FEE_SETTING_KEY }).lean();
  try {
    return parseInspectionFee(setting?.value ?? DEFAULT_REPAIR_INSPECTION_FEE);
  } catch (_) {
    return DEFAULT_REPAIR_INSPECTION_FEE;
  }
}

async function setDefaultRepairInspectionFee(value) {
  const fee = parseInspectionFee(value);
  await SiteSetting.findOneAndUpdate(
    { key: REPAIR_INSPECTION_FEE_SETTING_KEY },
    { value: fee },
    { upsert: true, setDefaultsOnInsert: true, returnDocument: "after" },
  );
  return fee;
}

function resolveCatalogInspectionFee(item, categories, defaultFee) {
  const categorySlug = normalizeTerm(item?.unitCategory || item?.repairCategory || item?.categorySlug);
  const unitType = normalizeTerm(item?.unitType || item?.applianceTypeName || item?.applianceType);
  const activeCategories = (categories || []).filter((category) => category && category.active !== false);
  let category = null;

  if (categorySlug) {
    category = activeCategories.find((row) => normalizeTerm(row.slug) === categorySlug);
    if (!category) throw pricingError("The selected repair category is unavailable.");
  } else {
    category = activeCategories.find((row) => (row.unitTypes || []).some((unit) => (
      normalizeTerm(unit.value) === unitType || normalizeTerm(unit.label) === unitType
    )));
  }

  if (!category) throw pricingError("The selected appliance is not in the active repair catalog.");
  if (category.isCustom && !(category.unitTypes || []).length) {
    return { fee: defaultFee, source: "default", categorySlug: category.slug, unitType: item?.unitType || item?.applianceTypeName };
  }

  const unit = (category.unitTypes || []).find((row) => (
    normalizeTerm(row.value) === unitType || normalizeTerm(row.label) === unitType
  ));
  if (!unit) throw pricingError("The selected appliance type is unavailable in this repair category.");
  const override = parseInspectionFee(unit.inspectionFee, { allowEmpty: true });
  return {
    fee: override == null ? defaultFee : override,
    source: override == null ? "default" : "unit-override",
    categorySlug: category.slug,
    unitType: unit.value,
    unitLabel: unit.label,
  };
}

function resolveRepairServiceFee(item, service, defaultFee) {
  const airconType = String(item?.airconType || item?.applianceType || "");
  const hp = Number(item?.hp);
  const typeTier = (service.airconTypes || []).find((row) => row.type === airconType);
  const hpTier = (typeTier?.hpPricing || service.hpPricing || []).find((row) => Number(row.hp) === hp);
  const configured = hpTier?.price ?? service.initialPrice ?? service.basePrice;
  const fee = parseInspectionFee(configured, { allowEmpty: true });
  return {
    fee: fee == null ? defaultFee : fee,
    source: fee == null ? "default" : "repair-service",
    serviceId: service._id,
    unitType: item?.unitType || item?.applianceTypeName || service.applianceType,
  };
}

async function resolveRepairInspectionFees(items) {
  const rows = Array.isArray(items) ? items : [];
  const serviceIds = rows
    .map((item) => item?.serviceId)
    .filter((id) => mongoose.isValidObjectId(id));
  const [defaultFee, categories, repairServices] = await Promise.all([
    getDefaultRepairInspectionFee(),
    ServiceCategory.find({ active: true }).select("name slug isCustom unitTypes active").lean(),
    serviceIds.length
      ? RepairService.find({ _id: { $in: serviceIds }, active: { $ne: false } }).lean()
      : Promise.resolve([]),
  ]);
  const servicesById = new Map(repairServices.map((service) => [String(service._id), service]));

  return rows.map((item) => {
    if (item?.type !== "repair") return null;
    const repairService = servicesById.get(String(item.serviceId || ""));
    return repairService
      ? resolveRepairServiceFee(item, repairService, defaultFee)
      : resolveCatalogInspectionFee(item, categories, defaultFee);
  });
}

module.exports = {
  DEFAULT_REPAIR_INSPECTION_FEE,
  MAX_REPAIR_INSPECTION_FEE,
  REPAIR_INSPECTION_FEE_SETTING_KEY,
  getDefaultRepairInspectionFee,
  parseInspectionFee,
  resolveCatalogInspectionFee,
  resolveRepairInspectionFees,
  setDefaultRepairInspectionFee,
};

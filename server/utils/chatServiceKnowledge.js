"use strict";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function humanize(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    const clean = String(value || "").trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((value) => String(value).trim());
}

function mapHpPricing(rows) {
  return asArray(rows)
    .filter((row) => row && hasNumber(row.hp) && hasNumber(row.price))
    .map((row) => ({
      hp: row.hp,
      price: row.price,
      duration: row.durationMinutes || row.estimatedDurationMinutes,
      description: row.description,
    }));
}

function mapAirconTypes(service) {
  const byKey = new Map();

  for (const item of [...asArray(service.applianceTypes), ...asArray(service.airconTypes)]) {
    if (!item) continue;
    const key = String(item.type || item.name || "").trim().toLowerCase();
    if (!key) continue;
    const previous = byKey.get(key) || {};
    byKey.set(key, {
      key,
      name: item.name || previous.name || humanize(item.type),
      description: item.description || previous.description,
      hpPricing: mapHpPricing(item.hpPricing).length
        ? mapHpPricing(item.hpPricing)
        : (previous.hpPricing || []),
    });
  }

  return [...byKey.values()];
}

function mapCoreService(service) {
  const types = mapAirconTypes(service);
  return {
    kind: "core",
    name: service.name,
    slug: service.slug,
    category: service.category || "core",
    desc: service.description,
    price: service.basePrice,
    priceRange: service.priceRange,
    hpPricing: mapHpPricing(service.hpPricing),
    types,
    applianceNames: uniqueStrings(types.map((item) => item.name)),
    duration: service.durationMinutes,
    durationRange: service.durationRange,
    features: uniqueStrings([...asArray(service.features), ...asArray(service.includedItems)]),
    exclusions: uniqueStrings(asArray(service.exclusions)),
    brands: uniqueStrings(asArray(service.brands)),
    tags: uniqueStrings(asArray(service.tags)),
    isAirconService: Boolean(service.isAirconService),
  };
}

function aliasesForAppliance(value) {
  const key = String(value || "").toLowerCase().replace(/[-_]+/g, " ");
  if (/air\s*con|air condition|\bac\b/.test(key)) return ["aircon", "air conditioner", "air conditioning", "ac"];
  if (/refrigerator|fridge/.test(key)) return ["refrigerator", "fridge", "ref"];
  if (/washing machine|washer/.test(key)) return ["washing machine", "washer"];
  if (/microwave/.test(key)) return ["microwave", "microwave oven"];
  if (/clothes? dryer|\bdryer\b/.test(key)) return ["dryer", "clothes dryer"];
  if (/rice cooker/.test(key)) return ["rice cooker"];
  if (/electric fan|\bfan\b/.test(key)) return ["electric fan", "fan"];
  if (/water dispenser/.test(key)) return ["water dispenser"];
  if (/electric kettle|\bkettle\b/.test(key)) return ["electric kettle", "kettle"];
  if (/freezer/.test(key)) return ["freezer"];
  return [];
}

function mapRepairService(service) {
  const types = mapAirconTypes(service);
  const applianceName = humanize(service.applianceType) || "Appliance";
  return {
    kind: "repair",
    name: service.name,
    slug: service.slug,
    category: "repair",
    applianceType: service.applianceType,
    applianceName,
    applianceNames: uniqueStrings([
      applianceName,
      service.applianceType,
      ...aliasesForAppliance(`${service.applianceType || ""} ${service.name || ""}`),
      ...types.map((item) => item.name),
    ]),
    desc: service.description,
    initialFee: hasNumber(service.initialPrice)
      ? service.initialPrice
      : (hasNumber(service.basePrice) ? service.basePrice : undefined),
    pricingNote: service.pricingNote,
    hpPricing: mapHpPricing(service.hpPricing),
    types,
    duration: service.estimatedDurationMinutes,
    durationRange: service.durationRange,
    commonFaults: uniqueStrings(asArray(service.commonFaults)),
    possibleParts: uniqueStrings(asArray(service.parts).map((part) => part && part.name)),
    isAirconService: Boolean(service.isAirconService),
  };
}

function mapRepairCategory(category, defaultInspectionFee = 500) {
  const unitTypes = asArray(category.unitTypes);
  const rows = unitTypes.length
    ? unitTypes
    : [{ value: category.slug || category.name, label: category.name }];

  return rows.map((unit) => {
    const hasOverride = unit.inspectionFee !== "" && unit.inspectionFee != null;
    const override = Number(unit.inspectionFee);
    const fallback = Number(defaultInspectionFee);
    const inspectionFee = hasOverride && Number.isFinite(override) && override >= 0
      ? override
      : (Number.isFinite(fallback) && fallback >= 0 ? fallback : 500);
    const applianceName = String(unit.label || unit.value || category.name || "Appliance").trim();
    const catalogName = /\b(repair|service)\b/i.test(applianceName)
      ? applianceName
      : `${applianceName} Repair`;
    return {
      kind: "repair",
      source: "repair-category",
      name: catalogName,
      slug: category.slug,
      category: "repair",
      repairCategory: category.name,
      applianceType: unit.value,
      applianceName,
      applianceNames: uniqueStrings([
        applianceName,
        unit.value,
        ...aliasesForAppliance(`${unit.value || ""} ${unit.label || ""}`),
      ]),
      desc: undefined,
      initialFee: inspectionFee,
      pricingNote: "This is the inspection/service-call fee. Final repair pricing follows diagnosis.",
      hpPricing: [],
      types: [],
      duration: undefined,
      durationRange: undefined,
      commonFaults: [],
      possibleParts: [],
      isAirconService: /air\s*con|air condition|\bac\b/i.test(`${category.slug || ""} ${category.name || ""} ${unit.value || ""}`),
    };
  });
}

function serviceSearchText(service) {
  return uniqueStrings([
    service.name,
    service.slug,
    service.category,
    service.applianceType,
    service.applianceName,
    ...asArray(service.applianceNames),
    ...asArray(service.tags),
    ...asArray(service.commonFaults),
  ]).join(" ").toLowerCase().replace(/[-_]+/g, " ");
}

function findService(services, message) {
  const query = String(message || "").toLowerCase().replace(/[-_]+/g, " ");
  if (!query.trim()) return null;

  const ranked = asArray(services).map((service) => {
    const name = String(service.name || "").toLowerCase();
    const applianceTerms = asArray(service.applianceNames)
      .map((value) => String(value).toLowerCase().replace(/[-_]+/g, " "))
      .filter(Boolean);
    let score = 0;
    if (name && query.includes(name)) score += 100 + name.length;
    for (const term of applianceTerms) {
      if (term.length > 2 && query.includes(term)) score += 30 + term.length;
    }
    const words = serviceSearchText(service).split(/\s+/).filter((word) => word.length > 3);
    score += words.filter((word) => query.includes(word)).length;
    return { service, score };
  }).sort((a, b) => b.score - a.score);

  return ranked[0] && ranked[0].score >= 20 ? ranked[0].service : null;
}

function formatPeso(value) {
  return `₱${Number(value).toLocaleString("en-PH")}`;
}

function formatServicePrice(service) {
  if (service.kind === "repair" && hasNumber(service.initialFee)) {
    return `${formatPeso(service.initialFee)} initial inspection/service-call fee`;
  }
  if (hasNumber(service.price)) return formatPeso(service.price);
  if (service.priceRange && hasNumber(service.priceRange.min)) {
    const min = service.priceRange.min;
    const max = service.priceRange.max;
    return `${formatPeso(min)}${hasNumber(max) && max !== min ? ` – ${formatPeso(max)}` : ""}`;
  }
  const prices = asArray(service.hpPricing).map((row) => row.price).filter(hasNumber);
  if (prices.length) {
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    return `${formatPeso(min)}${max !== min ? ` – ${formatPeso(max)}` : ""} (HP-based)`;
  }
  return service.kind === "repair" ? "Quoted after inspection" : "Contact us for pricing";
}

module.exports = {
  findService,
  formatServicePrice,
  humanize,
  mapCoreService,
  mapRepairCategory,
  mapRepairService,
  serviceSearchText,
};

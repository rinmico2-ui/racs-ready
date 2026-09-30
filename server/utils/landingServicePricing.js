"use strict";

const { resolveCatalogInspectionFee } = require("./repairInspectionPricing");
const coreCards = {
  "Aircon Installation": ["aircon installation"],
  "Aircon Cleaning": ["aircon cleaning"],
  "Freon Recharging": ["freon recharging", "aircon recharging", "refrigerant recharging"],
  "Aircon Relocation": ["aircon relocation"],
};
const repairCards = {
  "Refrigerator Repair": ["refrigerator"],
  "Washing Machine": ["washing machine"],
  "Microwave Oven": ["microwave oven", "microwave"],
  "Water Dispenser": ["water dispenser"],
};
function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}
function amount(value) {
  if (value == null || typeof value === "boolean" || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}
function coreRows(service) {
  const types = Array.isArray(service.airconTypes) ? service.airconTypes : [];
  if (types.length) {
    return types.flatMap(type => (type.hpPricing || []).flatMap(tier => {
      const price = amount(tier.price);
      return price == null || !(Number(tier.hp) > 0) ? []
        : [{ label: `${type.name || normalize(type.type)} · ${Number(tier.hp)} HP`, amount: price }];
    }));
  }
  if (service.isAirconService && service.hpPricing?.length) {
    return service.hpPricing.flatMap(tier => {
      const price = amount(tier.price);
      return price == null || !(Number(tier.hp) > 0) ? [] : [{ label: `${Number(tier.hp)} HP`, amount: price }];
    });
  }
  const base = amount(service.basePrice);
  if (base != null) return [{ label: service.name, amount: base }];
  const min = amount(service.priceRange?.min);
  const max = amount(service.priceRange?.max);
  return min != null && max != null && max >= min
    ? [{ label: "Minimum service price", amount: min }, { label: "Maximum service price", amount: max }]
    : [];
}
function summarize(kind, rows) {
  if (!rows.length) return { kind, available: false, rows: [] };
  return {
    kind, available: true, min: Math.min(...rows.map(row => row.amount)),
    max: Math.max(...rows.map(row => row.amount)), rows,
  };
}

function buildLandingServicePrices(coreServices, categories, defaultInspectionFee) {
  const prices = {};
  for (const [name, aliases] of Object.entries(coreCards)) {
    const matches = coreServices.filter(service => service.active !== false
      && [normalize(service.name), normalize(service.slug)].some(term => aliases.includes(term)));
    const rows = matches.flatMap(service => coreRows(service).map(row => ({
      ...row, label: matches.length > 1 ? `${service.name} · ${row.label}` : row.label,
    })));
    prices[name] = summarize("service", rows);
  }
  for (const [name, aliases] of Object.entries(repairCards)) {
    const rows = [];
    for (const category of categories.filter(row => row.active !== false)) {
      for (const unit of category.unitTypes || []) {
        const matches = [normalize(unit.value), normalize(unit.label)].some(term => aliases.some(alias => (
          term === alias || term.startsWith(`${alias} `) || term.endsWith(` ${alias}`)
        )));
        if (!matches) continue;
        try {
          const { fee } = resolveCatalogInspectionFee(
            { unitCategory: category.slug, unitType: unit.value }, categories, defaultInspectionFee,
          );
          const price = amount(fee);
          if (price != null) rows.push({ label: unit.label || unit.value, amount: price });
        } catch (_) { /* Invalid/removed catalog entries must not advertise guessed prices. */ }
      }
    }
    prices[name] = summarize("inspection", rows);
  }
  return prices;
}

module.exports = { buildLandingServicePrices };

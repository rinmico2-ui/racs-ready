const SiteSetting = require('../models/SiteSetting');

const DEFAULT_REPAIR_LABOR_FEES = Object.freeze({ minor: 300, standard: 500, complex: 800, major: 1500 });
const SETTING_KEYS = Object.freeze({
  minor: 'customerRepairLaborMinor', standard: 'customerRepairLaborStandard',
  complex: 'customerRepairLaborComplex', major: 'customerRepairLaborMajor',
});

function normalizeRepairComplexity(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['minor', 'low', 'simple'].includes(normalized)) return 'minor';
  if (['complex', 'high', 'advanced'].includes(normalized)) return 'complex';
  if (['major', 'overhaul', 'major_overhaul'].includes(normalized)) return 'major';
  return 'standard';
}

async function getRepairLaborFees() {
  const rows = await SiteSetting.find({ key: { $in: Object.values(SETTING_KEYS) } }).lean();
  const byKey = new Map(rows.map(row => [row.key, row.value]));
  return Object.fromEntries(Object.entries(SETTING_KEYS).map(([category, key]) => {
    const configured = Number(byKey.get(key));
    return [category, Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REPAIR_LABOR_FEES[category]];
  }));
}

module.exports = { DEFAULT_REPAIR_LABOR_FEES, SETTING_KEYS, normalizeRepairComplexity, getRepairLaborFees };

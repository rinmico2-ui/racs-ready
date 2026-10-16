'use strict';
const { normalizeRepairComplexity } = require('./repairLaborPricing');
const normalized = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function buildRepairQuoteSuggestion(report = {}, catalog, fees) {
  const category = report.repairComplexity === 'specialist_required' ? 'major' : normalizeRepairComplexity(report.repairComplexity);
  const seen = new Set();
  const parts = (Array.isArray(report.possibleParts) ? report.possibleParts : []).slice(0, 50).flatMap(value => {
    const item = typeof value === 'string' ? { name: value } : value;
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200) return [];
    const key = normalized(item.name); if (seen.has(key)) return []; seen.add(key);
    const matches = catalog.filter(part => normalized(part.itemName) === key);
    const match = matches.length === 1 ? matches[0] : null;
    const quantity = Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 999 ? item.quantity : 1;
    const price = match ? Number(match.sellingPrice ?? match.costPrice) : NaN;
    return [{ name: match?.itemName || item.name.trim(), toolId: match?._id || null, quantity,
      cost: Number.isFinite(price) && price >= 0 ? price : null, requiresPrice: !Number.isFinite(price) || price < 0 }];
  });
  return { laborCategory: category, laborCost: Number(fees[category]), laborPricingMode: 'company', parts,
    note: 'Suggested labor uses the company rate. Matched parts use saved catalog prices. Confirm compatibility and enter a supplier price for unmatched parts.' };
}
module.exports = { buildRepairQuoteSuggestion };

const SiteSetting = require('../models/SiteSetting');

const KEY = 'loyaltyAnalyticsPolicy';
const METRICS = new Set(['completedBookings', 'completedOrders', 'combinedSpend']);
const NAMES = ['Bronze', 'Silver', 'Gold'];

function validatePolicy(input) {
  if (!input || typeof input !== 'object' || !METRICS.has(input.metric)) throw new Error('Choose a valid loyalty qualification metric.');
  if (!Array.isArray(input.tiers) || input.tiers.length !== 3) throw new Error('Configure Bronze, Silver, and Gold tiers.');
  const tiers = input.tiers.map((tier, index) => {
    const threshold = Number(tier.threshold);
    const discountPercent = Number(tier.discountPercent);
    if (!Number.isFinite(threshold) || threshold <= 0 || (input.metric !== 'combinedSpend' && !Number.isInteger(threshold)) || !Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 50) throw new Error('Tier thresholds and discounts must be valid numbers.');
    if (index && threshold <= Number(input.tiers[index - 1].threshold)) throw new Error('Tier thresholds must increase from Bronze to Gold.');
    return { name: NAMES[index], threshold, discountPercent };
  });
  return { metric: input.metric, tiers, updatedAt: input.updatedAt && !Number.isNaN(new Date(input.updatedAt).getTime()) ? new Date(input.updatedAt) : new Date() };
}

function evaluateCustomer(row, policy) {
  if (!policy) return { tier: null, progress: null };
  const value = Math.max(0, Number(row[policy.metric]) || (policy.metric === 'combinedSpend' ? Number(row.spend) || 0 : 0));
  const tier = [...policy.tiers].reverse().find(item => value >= item.threshold) || null;
  const next = policy.tiers.find(item => value < item.threshold) || null;
  return { tier: tier?.name || null, progress: next ? { value, target: next.threshold, nextTier: next.name, percent: Math.min(100, Math.round(value * 100 / next.threshold)) } : { value, target: value, nextTier: null, percent: 100 } };
}

async function loadPolicy() {
  const setting = await SiteSetting.findOne({ key: KEY }).lean();
  if (!setting?.value) return null;
  try { return validatePolicy(setting.value); } catch { return null; }
}

async function savePolicy(input) {
  const policy = validatePolicy(input);
  await SiteSetting.findOneAndUpdate({ key: KEY }, { $set: { value: policy } }, { upsert: true, new: true });
  return policy;
}

module.exports = { KEY, evaluateCustomer, loadPolicy, savePolicy, validatePolicy };

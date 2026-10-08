'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const SiteSetting = require('../models/SiteSetting');
const BookingService = require('../models/BookingService');
const Order = require('../models/Order');
const CoreService = require('../models/CoreService');
const Inventory = require('../models/Inventory');
const HVACProduct = require('../models/HVACProduct');
const { resolveCoreServicePricing } = require('./coreServicePricing');

const KEY = 'customerLoyaltyRewards';
const COMPLETED = ['completed', 'repair_completed', 'closed'];
const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const emptyPolicy = () => ({ enabled: false, revision: 'unconfigured', rules: [] });
class LoyaltyError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'LoyaltyError'; this.status = status; this.code = status === 409 ? 'LOYALTY_QUOTE_CHANGED' : 'LOYALTY_REQUEST_INVALID'; }
}
const error = (message, status = 400) => new LoyaltyError(message, status);

function validatePolicy(input) {
  if (!input || typeof input.enabled !== 'boolean' || !Array.isArray(input.rules) || input.rules.length > 12) throw error('Choose whether rewards are enabled and configure up to 12 rules.');
  const ids = new Set();
  const rules = input.rules.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw error('Choose a valid reward rule.');
    const id = item.id || crypto.randomUUID();
    const name = String(item.name || '').trim();
    const threshold = Number(item.threshold);
    const percent = Number(item.discountPercent);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(id) || ids.has(id)) throw error('Each reward must have a unique rule ID.');
    ids.add(id);
    if (!name || name.length > 80 || !['bookings', 'orders', 'combined'].includes(item.metric)
      || !['services', 'orders', 'both'].includes(item.appliesTo) || typeof item.enabled !== 'boolean'
      || !Number.isInteger(threshold) || threshold < 1 || threshold > 10000
      || !Number.isFinite(percent) || percent < 0.01 || percent > 50 || round(percent) !== percent) throw error('Set a rule name, 1–10,000 completed transactions, and a discount from 0.01% to 50% with up to two decimal places.');
    const idList = (value, label) => {
      if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id))) throw error('Choose valid ' + label + '.');
      return [...new Set(value.map(id => id.toLowerCase()))];
    };
    return { id, name, enabled: item.enabled, metric: item.metric, threshold, discountPercent: round(percent), appliesTo: item.appliesTo,
      qualifyingServiceIds: idList(item.qualifyingServiceIds || [], 'qualifying services'),
      eligibleServiceIds: idList(item.eligibleServiceIds || [], 'discounted services'),
      eligibleProductIds: idList(item.eligibleProductIds || [], 'discounted products') };
  });
  if (input.enabled && !rules.some(rule => rule.enabled)) throw error('Add and activate at least one rule before enabling automatic discounts.');
  return { enabled: input.enabled, rules };
}

async function loadPolicy() {
  const setting = await SiteSetting.findOne({ key: KEY }).select('value').lean();
  if (!setting?.value) return emptyPolicy();
  return { ...validatePolicy(setting.value), revision: setting.value.revision, updatedAt: setting.value.updatedAt };
}

async function savePolicy(input, actorId) {
  const policy = validatePolicy(input);
  const current = await loadPolicy();
  if (input.expectedRevision !== current.revision) throw error('These rules were changed by another admin. Reload them before saving.', 409);
  const value = { ...policy, revision: crypto.randomUUID(), updatedAt: new Date(), updatedBy: actorId };
  const existing = current.revision !== 'unconfigured';
  if (existing) {
    const result = await SiteSetting.updateOne({ key: KEY, 'value.revision': current.revision }, { $set: { value } });
    if (result.modifiedCount !== 1) throw error('These rules changed while saving. Reload them before saving again.', 409);
  } else {
    try { await SiteSetting.create({ key: KEY, value }); }
    catch (err) { if (err.code === 11000) throw error('Another admin saved these rules. Reload them before saving.', 409); throw err; }
  }
  return value;
}

async function completedHistory(customerId) {
  const histories = await completionHistories([customerId]);
  return histories.get(String(customerId)) || { bookings: [], orders: 0 };
}

async function completionHistories(customerIds) {
  if (!customerIds.length) return new Map();
  const ids = customerIds.map(id => new mongoose.Types.ObjectId(String(id)));
  const [bookings, orders] = await Promise.all([
    BookingService.aggregate([
      { $match: { customerId: { $in: ids }, sourceOrderId: null, status: { $in: COMPLETED }, refundStatus: { $ne: 'completed' } } },
      { $lookup: { from: Order.collection.name, localField: '_id', foreignField: 'bookingId', pipeline: [{ $project: { _id: 1 } }, { $limit: 1 }], as: 'orders' } },
      { $match: { 'orders.0': { $exists: false } } },
      { $project: { customerId: 1, serviceIds: { $setUnion: [{ $map: { input: { $ifNull: ['$services', []] }, as: 'service', in: { $toString: '$$service.serviceId' } } }, [{ $toString: '$serviceId' }]] } } },
      { $group: { _id: '$customerId', bookings: { $push: { serviceIds: '$serviceIds' } } } },
    ]),
    Order.aggregate([
      { $match: { userId: { $in: ids }, status: 'completed', refundStatus: { $ne: 'completed' },
        $expr: { $or: [{ $lte: [{ $ifNull: ['$productRefundAmount', 0] }, 0] }, { $lt: [{ $ifNull: ['$productRefundAmount', 0] }, { $max: [0, { $subtract: [{ $ifNull: ['$subtotal', { $sum: '$items.totalPrice' }] }, { $ifNull: ['$discount', 0] }] }] }] }] } } },
      { $group: { _id: '$userId', orders: { $sum: 1 } } },
    ]),
  ]);
  const histories = new Map(customerIds.map(id => [String(id), { bookings: [], orders: 0 }]));
  bookings.forEach(row => { const history = histories.get(String(row._id)); if (history) history.bookings = row.bookings; });
  orders.forEach(row => { const history = histories.get(String(row._id)); if (history) history.orders = row.orders; });
  return histories;
}

function ruleProgress(rule, history) {
  const bookings = rule.qualifyingServiceIds.length ? history.bookings.filter(booking => booking.serviceIds.some(id => rule.qualifyingServiceIds.includes(String(id)))).length : history.bookings.length;
  const value = rule.metric === 'orders' ? history.orders : rule.metric === 'combined' ? bookings + history.orders : bookings;
  return { value, target: rule.threshold, qualified: value >= rule.threshold };
}

function evaluateHistory(policy, history = { bookings: [], orders: 0 }) {
  const rules = policy.enabled ? policy.rules.filter(rule => rule.enabled) : [];
  const progress = rules.map(rule => ({ ...ruleProgress(rule, history), name: rule.name, discountPercent: rule.discountPercent, appliesTo: rule.appliesTo }));
  const qualified = progress.filter(rule => rule.qualified).sort((a, b) => b.discountPercent - a.discountPercent || a.name.localeCompare(b.name));
  const next = progress.filter(rule => !rule.qualified).sort((a, b) => b.value / b.target - a.value / a.target)[0] || qualified[0];
  return { enabled: policy.enabled, tier: qualified[0]?.name || null, discountPercent: qualified[0]?.discountPercent || 0, qualifiedRules: qualified,
    progress: next ? { value: next.value, target: next.target, nextTier: next.name, percent: Math.min(100, Math.floor(next.value * 100 / next.target)) } : null };
}

function chooseReward(policy, history, channel, lines, excluded = false) {
  if (!policy.enabled || excluded) return null;
  const candidates = policy.rules.filter(rule => rule.enabled && (rule.appliesTo === channel || rule.appliesTo === 'both')).map(rule => {
    const progress = ruleProgress(rule, history);
    const eligibleIds = channel === 'services' ? rule.eligibleServiceIds : rule.eligibleProductIds;
    const eligibleLines = lines.filter(line => line.eligible !== false && (!eligibleIds.length || eligibleIds.includes(String(line.id))));
    const base = round(eligibleLines.reduce((sum, line) => sum + Math.max(0, Number(line.amount) || 0), 0));
    return progress.qualified && base > 0 ? { ruleId: rule.id, ruleName: rule.name, policyRevision: policy.revision,
      metric: rule.metric, threshold: rule.threshold, completedCount: progress.value, discountPercent: rule.discountPercent,
      eligibleBase: base, eligibleItemIds: [...new Set(eligibleLines.map(line => String(line.id)))], amount: round(base * rule.discountPercent / 100), channel, appliedAt: new Date() } : null;
  }).filter(Boolean).sort((a, b) => b.amount - a.amount || a.ruleId.localeCompare(b.ruleId));
  return candidates[0] || null;
}

async function rewardFor(customerId, channel, lines, excluded = false) {
  const policy = await loadPolicy();
  if (!policy.enabled || excluded || !policy.rules.some(rule => rule.enabled)) return null;
  return chooseReward(policy, await completedHistory(customerId), channel, lines, excluded);
}

function quoteIdentity(lines, excluded) {
  return crypto.createHash('sha256').update(JSON.stringify({ excluded: Boolean(excluded), lines: lines.map(line => [String(line.id), round(line.amount), line.eligible !== false]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })).digest('hex');
}
function quoteToken(customerId, channel, lines, reward, excluded) {
  return jwt.sign({ purpose: 'loyalty-checkout', customerId: String(customerId), channel, identity: quoteIdentity(lines, excluded),
    amount: reward?.amount || 0, revision: reward?.policyRevision || null }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '15m' });
}
function assertQuote(token, customerId, channel, lines, reward, excluded) {
  if (!token && !reward) return;
  try {
    const quote = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (quote.purpose !== 'loyalty-checkout' || quote.customerId !== String(customerId) || quote.channel !== channel
      || quote.identity !== quoteIdentity(lines, excluded) || quote.amount !== (reward?.amount || 0) || quote.revision !== (reward?.policyRevision || null)) throw new Error();
  } catch { throw error('Your loyalty price changed or expired. Review the updated amount before submitting payment.', 409); }
}

async function serviceLines(selections) {
  if (!Array.isArray(selections) || !selections.length || selections.length > 40) throw error('Select valid services to check the loyalty price.');
  const lines = [];
  for (const selection of selections) {
    if (selection.type === 'repair' || selection.relocation?.scope === 'custom_quote' || selection.assistanceRequestId) {
      lines.push({ id: String(selection.serviceId || ''), amount: 0, eligible: false });
      continue;
    }
    if (!mongoose.Types.ObjectId.isValid(selection.serviceId)) throw error('Choose a valid service.');
    const catalog = await CoreService.findById(selection.serviceId).lean();
    let price;
    try { price = resolveCoreServicePricing(catalog, { ...selection, quantity: Number(selection.quantity) || 1 }); }
    catch (err) { throw error(err.message); }
    lines.push({ id: String(catalog._id), amount: price.totalPrice, eligible: true });
  }
  return lines;
}

async function orderLines(items) {
  if (!Array.isArray(items) || !items.length || items.length > 40) throw error('Choose valid products.');
  const lines = [];
  for (const item of items) {
    if (!mongoose.Types.ObjectId.isValid(item.inventoryId) || !Number.isInteger(Number(item.quantity)) || item.quantity < 1 || item.quantity > 40) throw error('Choose valid products and quantities.');
    let price;
    const inventory = await Inventory.findById(item.inventoryId).select('_id sellingPrice active').lean();
    if (inventory?.active !== false && inventory) price = inventory.sellingPrice;
    else {
      const hvac = await HVACProduct.findOne({ active: { $ne: false }, 'variants._id': item.inventoryId }).select('variants._id variants.sellingPrice variants.active').lean();
      const variant = hvac?.variants.find(variant => String(variant._id) === String(item.inventoryId) && variant.active !== false);
      price = variant?.sellingPrice;
    }
    if (!Number.isFinite(Number(price))) throw error('A selected product is unavailable.');
    lines.push({ id: String(item.inventoryId).toLowerCase(), amount: round(Number(price) * Number(item.quantity)), eligible: true });
  }
  return lines;
}

module.exports = { KEY, LoyaltyError, validatePolicy, loadPolicy, savePolicy, completedHistory, completionHistories, evaluateHistory, ruleProgress, chooseReward, rewardFor, quoteToken, assertQuote, serviceLines, orderLines, round };

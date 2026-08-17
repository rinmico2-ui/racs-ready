const SiteSetting = require("../models/SiteSetting");

const DEFAULT_DOWNPAYMENT_PERCENTAGE = 10;
const MIN_DOWNPAYMENT_PERCENTAGE = 1;
const MAX_DOWNPAYMENT_PERCENTAGE = 100;

function normalizeDownpaymentPercentage(value, fallback = DEFAULT_DOWNPAYMENT_PERCENTAGE) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_DOWNPAYMENT_PERCENTAGE || parsed > MAX_DOWNPAYMENT_PERCENTAGE) {
    return fallback;
  }
  return Math.round(parsed * 100) / 100;
}

function roundCurrency(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function calculatePaymentBreakdown(total, percentage) {
  const normalizedTotal = Math.max(0, roundCurrency(total));
  const normalizedPercentage = normalizeDownpaymentPercentage(percentage);
  // GCash downpayments are collected in whole pesos so customers never need to
  // transfer fractional amounts such as ₱202.10.
  const downpaymentAmount = Math.round(normalizedTotal * normalizedPercentage / 100);
  return {
    total: normalizedTotal,
    downpaymentPercentage: normalizedPercentage,
    downpaymentAmount,
    balanceAmount: roundCurrency(Math.max(0, normalizedTotal - downpaymentAmount)),
  };
}

async function getDownpaymentPercentage() {
  const setting = await SiteSetting.findOne({ key: "downpaymentPercentage" }).lean();
  return normalizeDownpaymentPercentage(setting && setting.value);
}

module.exports = {
  DEFAULT_DOWNPAYMENT_PERCENTAGE,
  MIN_DOWNPAYMENT_PERCENTAGE,
  MAX_DOWNPAYMENT_PERCENTAGE,
  normalizeDownpaymentPercentage,
  calculatePaymentBreakdown,
  getDownpaymentPercentage,
};

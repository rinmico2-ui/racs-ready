const SiteSetting = require("../models/SiteSetting");

const DEFAULT_DOWNPAYMENT_PERCENTAGE = 10;
const MIN_DOWNPAYMENT_PERCENTAGE = 1;
const MAX_DOWNPAYMENT_PERCENTAGE = 100;
const GCASH_RECIPIENT_SETTING_KEY = "gcashRecipientNumber";

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

function normalizeGcashRecipientNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^09\d{9}$/.test(digits)) return digits;
  if (/^639\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  return "";
}

async function getGcashRecipientNumber() {
  const setting = await SiteSetting.findOne({ key: GCASH_RECIPIENT_SETTING_KEY }).lean();
  if (setting) return normalizeGcashRecipientNumber(setting.value);
  return normalizeGcashRecipientNumber(process.env.ADMIN_GCASH_NUMBER);
}

module.exports = {
  DEFAULT_DOWNPAYMENT_PERCENTAGE,
  MIN_DOWNPAYMENT_PERCENTAGE,
  MAX_DOWNPAYMENT_PERCENTAGE,
  GCASH_RECIPIENT_SETTING_KEY,
  normalizeDownpaymentPercentage,
  normalizeGcashRecipientNumber,
  calculatePaymentBreakdown,
  getDownpaymentPercentage,
  getGcashRecipientNumber,
};

const SiteSetting = require("../models/SiteSetting");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DOWNPAYMENT_PERCENTAGE = 10;
const MIN_DOWNPAYMENT_PERCENTAGE = 1;
const MAX_DOWNPAYMENT_PERCENTAGE = 100;
const GCASH_RECIPIENT_SETTING_KEY = "gcashRecipientNumber";
const PAYMENT_METHODS_SETTING_KEY = "paymentMethods";
const GCASH_QR_SETTING_KEY = "gcashQrImageUrl";
// The QR image supplied for the currently configured recipient. Store only a
// fingerprint here so a later number change cannot silently reuse its QR.
const BUNDLED_GCASH_QR_URL = "/images/gcash-receiver-qr.jpg";
const BUNDLED_GCASH_RECIPIENT_SHA256 = "ff7eafd1e10508d114667101e5f117ce01e925470a30e48247d54da995b122fe";
const PAYMENT_CHANNELS = Object.freeze(["card", "gcash", "maya", "bank_transfer", "other"]);
const MANUAL_PAYMENT_CHANNELS = Object.freeze(["gcash", "maya", "bank_transfer", "other"]);
const DEFAULT_PAYMENT_METHODS = Object.freeze({
  card: { enabled: true, label: "Credit / Debit Card" },
  gcash: { enabled: true, label: "GCash", accountName: "", accountNumber: "", instructions: "" },
  maya: { enabled: false, label: "Maya", accountName: "", accountNumber: "", instructions: "" },
  bank_transfer: { enabled: false, label: "Bank Transfer", bankName: "", accountName: "", accountNumber: "", instructions: "" },
  other: { enabled: false, label: "Other Transfer", accountName: "", accountNumber: "", instructions: "" },
});

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

async function getGcashQrImageUrl() {
  const setting = await SiteSetting.findOne({ key: GCASH_QR_SETTING_KEY }).lean();
  const recipientNumber = await getGcashRecipientNumber();
  if (!recipientNumber) return "";
  if (!setting) {
    const recipientHash = crypto.createHash("sha256").update(recipientNumber).digest("hex");
    return recipientHash === BUNDLED_GCASH_RECIPIENT_SHA256 &&
      fs.existsSync(path.join(__dirname, "../public", BUNDLED_GCASH_QR_URL))
      ? BUNDLED_GCASH_QR_URL : "";
  }
  const url = String(setting?.value?.url || "");
  if (setting?.value?.recipientNumber !== recipientNumber) return "";
  return /^\/uploads\/payment-qr\/[a-zA-Z0-9._-]+\.(?:png|jpg|webp)$/.test(url) &&
    fs.existsSync(path.join(__dirname, "../public", url)) ? url : "";
}

function normalizePaymentChannel(value) {
  const channel = String(value || "gcash").trim().toLowerCase();
  return PAYMENT_CHANNELS.includes(channel) ? channel : "";
}

function paymentRecordMethod(channel) {
  const normalized = normalizePaymentChannel(channel);
  if (normalized === "bank_transfer") return "bank";
  return normalized || "other";
}

function cleanText(value, maxLength = 160) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function normalizePaymentMethods(value = {}, legacyGcashNumber = "") {
  const source = value && typeof value === "object" ? value : {};
  const normalized = {};
  for (const channel of PAYMENT_CHANNELS) {
    const defaults = DEFAULT_PAYMENT_METHODS[channel];
    const input = source[channel] && typeof source[channel] === "object" ? source[channel] : {};
    normalized[channel] = {
      enabled: input.enabled == null ? defaults.enabled : input.enabled === true,
      label: cleanText(input.label || defaults.label, 60),
    };
    if (channel !== "card") {
      normalized[channel].accountName = cleanText(input.accountName, 120);
      normalized[channel].accountNumber = cleanText(
        channel === "gcash" ? (input.accountNumber || legacyGcashNumber) : input.accountNumber,
        120,
      );
      normalized[channel].instructions = cleanText(input.instructions, 500);
    }
    if (channel === "bank_transfer") normalized[channel].bankName = cleanText(input.bankName, 120);
  }
  return normalized;
}

function methodHasRequiredDetails(channel, method) {
  if (!method?.enabled) return false;
  if (channel === "card") return true;
  if (channel === "gcash" || channel === "maya") return method.accountNumber.length >= 3;
  if (channel === "bank_transfer") return Boolean(method.bankName && method.accountName && method.accountNumber);
  return Boolean(method.label && (method.accountNumber || method.instructions));
}

async function getPaymentMethods() {
  const [setting, legacyGcashNumber] = await Promise.all([
    SiteSetting.findOne({ key: PAYMENT_METHODS_SETTING_KEY }).lean(),
    getGcashRecipientNumber(),
  ]);
  const methods = normalizePaymentMethods(setting?.value, legacyGcashNumber);
  for (const channel of PAYMENT_CHANNELS) {
    methods[channel].configured = channel === "card"
      ? true
      : methodHasRequiredDetails(channel, methods[channel]);
    methods[channel].available = methods[channel].enabled && methods[channel].configured;
  }
  return methods;
}

async function getPaymentPolicy() {
  const [downpaymentPercentage, methods, gcashQrImageUrl] = await Promise.all([
    getDownpaymentPercentage(),
    getPaymentMethods(),
    getGcashQrImageUrl(),
  ]);
  return {
    downpaymentPercentage,
    methods,
    gcashQrImageUrl,
    cardCollectionMode: "in_person",
  };
}

module.exports = {
  DEFAULT_DOWNPAYMENT_PERCENTAGE,
  MIN_DOWNPAYMENT_PERCENTAGE,
  MAX_DOWNPAYMENT_PERCENTAGE,
  GCASH_RECIPIENT_SETTING_KEY,
  PAYMENT_METHODS_SETTING_KEY,
  GCASH_QR_SETTING_KEY,
  PAYMENT_CHANNELS,
  MANUAL_PAYMENT_CHANNELS,
  DEFAULT_PAYMENT_METHODS,
  normalizeDownpaymentPercentage,
  normalizeGcashRecipientNumber,
  calculatePaymentBreakdown,
  getDownpaymentPercentage,
  getGcashRecipientNumber,
  getGcashQrImageUrl,
  normalizePaymentChannel,
  paymentRecordMethod,
  normalizePaymentMethods,
  methodHasRequiredDetails,
  getPaymentMethods,
  getPaymentPolicy,
};

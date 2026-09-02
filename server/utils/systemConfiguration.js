"use strict";

const SiteSetting = require("../models/SiteSetting");

const SETTING_KEY = "systemConfiguration";
const CACHE_TTL_MS = 30_000;
const DEFAULT_SYSTEM_CONFIGURATION = Object.freeze({
  application: {
    allowCustomerRegistrations: true,
    requireEmailVerification: true,
  },
  notifications: {
    adminAlertEmail: "",
    criticalEmailAlerts: false,
    minimumPriority: "urgent",
  },
  maintenance: {
    enabled: false,
    message: "We are performing scheduled maintenance. Please try again shortly.",
    enabledAt: null,
    enabledBy: null,
  },
});

let cache = { value: null, expiresAt: 0 };

function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase().slice(0, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normalizeSystemConfiguration(value = {}) {
  value = value && typeof value === "object" ? value : {};
  const application = value.application && typeof value.application === "object" ? value.application : {};
  const notifications = value.notifications && typeof value.notifications === "object" ? value.notifications : {};
  const maintenance = value.maintenance && typeof value.maintenance === "object" ? value.maintenance : {};
  const priority = ["high", "urgent"].includes(notifications.minimumPriority)
    ? notifications.minimumPriority
    : DEFAULT_SYSTEM_CONFIGURATION.notifications.minimumPriority;

  return {
    application: {
      allowCustomerRegistrations: application.allowCustomerRegistrations !== false,
      requireEmailVerification: application.requireEmailVerification !== false,
    },
    notifications: {
      adminAlertEmail: cleanEmail(notifications.adminAlertEmail),
      criticalEmailAlerts: notifications.criticalEmailAlerts === true,
      minimumPriority: priority,
    },
    maintenance: {
      enabled: maintenance.enabled === true,
      message: String(maintenance.message || DEFAULT_SYSTEM_CONFIGURATION.maintenance.message).trim().slice(0, 300),
      enabledAt: maintenance.enabledAt || null,
      enabledBy: maintenance.enabledBy || null,
    },
  };
}

async function getSystemConfiguration({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && cache.value && cache.expiresAt > now) return cache.value;
  const record = await SiteSetting.findOne({ key: SETTING_KEY }).lean();
  const value = normalizeSystemConfiguration(record && record.value);
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

async function saveSystemConfiguration(value) {
  const normalized = normalizeSystemConfiguration(value);
  await SiteSetting.findOneAndUpdate(
    { key: SETTING_KEY },
    { value: normalized },
    { upsert: true, setDefaultsOnInsert: true },
  );
  cache = { value: normalized, expiresAt: Date.now() + CACHE_TTL_MS };
  return normalized;
}

function invalidateSystemConfiguration() {
  cache = { value: null, expiresAt: 0 };
}

function priorityMeetsThreshold(priority, threshold) {
  const rank = { low: 0, normal: 1, high: 2, urgent: 3 };
  return (rank[priority] ?? 1) >= (rank[threshold] ?? 3);
}

function isMaintenanceExempt(pathname, role) {
  if (role === "admin") return true;
  const path = String(pathname || "").split("?")[0];
  const recoveryPaths = new Set([
    "/login",
    "/logout",
    "/forgot-password",
    "/reset-password",
    "/math-captcha",
    "/api/auth/login",
    "/api/auth/secure/login",
    "/api/auth/verify-login-otp",
    "/api/auth/resend-login-otp",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
    "/api/auth/logout",
    "/api/auth/secure/logout",
  ]);
  return recoveryPaths.has(path) || path.startsWith("/socket.io/");
}

module.exports = {
  SETTING_KEY,
  DEFAULT_SYSTEM_CONFIGURATION,
  normalizeSystemConfiguration,
  getSystemConfiguration,
  saveSystemConfiguration,
  invalidateSystemConfiguration,
  priorityMeetsThreshold,
  isMaintenanceExempt,
};

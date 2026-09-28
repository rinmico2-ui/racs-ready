"use strict";

const REPAIR_MODEL_MAX_LENGTH = 50;
const SAFE_REPAIR_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._/#()+-]*$/;

function normalizeRepairModel(value) {
  return String(value || "").trim();
}

function validateRepairModel(value) {
  const normalized = normalizeRepairModel(value);
  if (!normalized) return { valid: true, value: "" };
  if (normalized.length > REPAIR_MODEL_MAX_LENGTH) {
    return {
      valid: false,
      value: normalized,
      error: `Model number must be ${REPAIR_MODEL_MAX_LENGTH} characters or fewer.`,
    };
  }
  if (!SAFE_REPAIR_MODEL_PATTERN.test(normalized)) {
    return {
      valid: false,
      value: normalized,
      error: "Model number may use letters, numbers, spaces, and . - _ / # ( ) + only.",
    };
  }
  return { valid: true, value: normalized };
}

module.exports = {
  REPAIR_MODEL_MAX_LENGTH,
  SAFE_REPAIR_MODEL_PATTERN,
  normalizeRepairModel,
  validateRepairModel,
};

const MAX_SERIAL_NUMBERS_PER_VARIANT = 500;
const SERIAL_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,119}$/;

function serialValidationError(message, code) {
  return Object.assign(new Error(message), { status: 400, code });
}

function normalizeSerialNumbers(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\r\n,]+/)
      : [];
  const serialNumbers = values
    .map((serialNumber) => String(serialNumber || "").trim().toUpperCase())
    .filter(Boolean);

  if (serialNumbers.length > MAX_SERIAL_NUMBERS_PER_VARIANT) {
    throw serialValidationError(
      `A variant can contain at most ${MAX_SERIAL_NUMBERS_PER_VARIANT} serial numbers.`,
      "HVAC_SERIAL_LIMIT",
    );
  }
  const invalid = serialNumbers.find(
    (serialNumber) => !SERIAL_NUMBER_PATTERN.test(serialNumber),
  );
  if (invalid) {
    throw serialValidationError(
      `Invalid serial number "${invalid}". Use letters, numbers, dots, slashes, underscores, or hyphens.`,
      "HVAC_SERIAL_INVALID",
    );
  }
  if (new Set(serialNumbers).size !== serialNumbers.length) {
    throw serialValidationError(
      "Serial numbers must be unique.",
      "HVAC_SERIAL_DUPLICATE",
    );
  }
  return serialNumbers;
}

function normalizeVariantSerialNumbers(variant = {}) {
  const quantity = Number(variant.quantity || 0);
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw serialValidationError(
      "Stock quantity must be a whole number.",
      "HVAC_QUANTITY_INVALID",
    );
  }
  const serialNumbers = normalizeSerialNumbers(variant.serialNumbers);
  return { ...variant, quantity, serialNumbers };
}

function normalizeProductVariantSerialNumbers(variants) {
  if (!Array.isArray(variants)) return [];
  const normalized = variants.map(normalizeVariantSerialNumbers);
  const allSerialNumbers = normalized.flatMap(
    (variant) => variant.serialNumbers,
  );
  if (new Set(allSerialNumbers).size !== allSerialNumbers.length) {
    throw serialValidationError(
      "A serial number cannot be assigned to more than one aircon variant.",
      "HVAC_SERIAL_DUPLICATE",
    );
  }
  return normalized;
}

module.exports = {
  MAX_SERIAL_NUMBERS_PER_VARIANT,
  SERIAL_NUMBER_PATTERN,
  normalizeProductVariantSerialNumbers,
  normalizeSerialNumbers,
  normalizeVariantSerialNumbers,
};

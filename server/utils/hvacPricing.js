// Used by every staff aircon write path, including individual HP edits.
function normalizeHvacPrices(variant = {}) {
  const result = { ...variant };
  for (const [field, label] of [["costPrice", "Bought price"], ["sellingPrice", "Selling price"]]) {
    if (result[field] === undefined) continue;
    const raw = result[field];
    if (field === "costPrice" && (raw === "" || raw === null)) {
      result[field] = 0; // Existing catalog convention: zero means not recorded.
      continue;
    }
    if (!["number", "string"].includes(typeof raw) || String(raw).trim() === ""
      || !Number.isFinite(Number(raw)) || Number(raw) < 0 || Number(raw) > Number.MAX_SAFE_INTEGER / 100) {
      const error = new Error(`${label} must be a valid amount of zero or more.`);
      error.status = 400;
      throw error;
    }
    result[field] = Math.round(Number(raw) * 100) / 100;
  }
  return result;
}

module.exports = { normalizeHvacPrices };

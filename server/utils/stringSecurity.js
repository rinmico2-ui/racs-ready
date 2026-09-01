function escapeRegex(value, maxLength = 100) {
  return String(value || "")
    .slice(0, maxLength)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { escapeRegex };

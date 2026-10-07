"use strict";

// Some standalone or MongoDB-compatible deployments reject retryable writes
// and multi-document transactions. These are infrastructure errors, not
// customer validation errors, so their driver text must not reach checkout.
function isUnsupportedMongoWriteFeature(error) {
  const seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    const message = String(current.message || "");
    if (/does not support retryable writes|retryWrites=false|transaction numbers are only allowed|transactions? (?:are|is) not supported|transactions? (?:are|is) not allowed/i.test(message)) {
      return true;
    }
  }
  return false;
}

module.exports = { isUnsupportedMongoWriteFeature };

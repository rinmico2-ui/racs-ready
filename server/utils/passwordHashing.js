const bcrypt = require("bcrypt");

function rounds() {
  const configured = Number.parseInt(process.env.BCRYPT_ROUNDS, 10);
  return Number.isSafeInteger(configured)
    ? Math.min(14, Math.max(10, configured))
    : 11;
}

function hashPassword(password) {
  return bcrypt.hash(password, rounds());
}

function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Computed only once at process startup and used to equalize unknown-account
// login timing without running synchronous crypto inside a request.
const fakeHash = bcrypt.hashSync("invalid-password", rounds());

module.exports = { comparePassword, fakeHash, hashPassword, rounds };

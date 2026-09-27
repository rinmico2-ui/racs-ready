const REGISTRATION_PASSWORD_MESSAGE =
  "Password must be 8–30 characters and include at least one uppercase letter and at least one number or symbol.";

function getRegistrationPasswordState(value) {
  const password = String(value || "");
  const length = password.length >= 8 && password.length <= 30;
  const uppercase = /[A-Z]/.test(password);
  const numberOrSymbol = /[0-9]/.test(password) || /[^A-Za-z0-9\s]/.test(password);

  return {
    length,
    uppercase,
    numberOrSymbol,
    valid: length && uppercase && numberOrSymbol,
  };
}

function isValidRegistrationPassword(value) {
  return getRegistrationPasswordState(value).valid;
}

module.exports = {
  REGISTRATION_PASSWORD_MESSAGE,
  getRegistrationPasswordState,
  isValidRegistrationPassword,
};

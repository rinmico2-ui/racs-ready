(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GcashSenderInput = api;
})(typeof window !== 'undefined' ? window : null, function () {
  function check(value, required) {
    const raw = String(value || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (!raw) {
      return { valid: false, state: required ? 'invalid' : 'neutral', message: required
        ? 'Enter the mobile number you used to pay with GCash.'
        : 'Use 11 digits starting with 09, or 12 digits starting with 639.' };
    }
    if (/[^\d\s()+-]/.test(raw) || (raw.includes('+') && !raw.startsWith('+63'))) {
      return { valid: false, state: 'invalid', message: 'Use numbers only. If using a country code, start with +63.' };
    }
    const countryCode = raw.startsWith('+63') || digits.startsWith('63');
    const expectedLength = countryCode ? 12 : 11;
    const example = countryCode ? '639171234567' : '09171234567';
    if (digits.length > expectedLength) {
      return { valid: false, state: 'invalid', message: `This has ${digits.length} digits. Use ${expectedLength} digits, like ${example}.` };
    }
    if (countryCode && digits.length >= 3 && !digits.startsWith('639')) {
      return { valid: false, state: 'invalid', message: 'After 63, the mobile number must start with 9. Example: 639171234567.' };
    }
    if (!countryCode && digits.length >= 2 && !digits.startsWith('09')) {
      return { valid: false, state: 'invalid', message: 'Start with 09, like 09171234567. You may also use 639171234567.' };
    }
    if (digits.length < expectedLength) {
      return { valid: false, state: required ? 'invalid' : 'neutral', message: `${digits.length} of ${expectedLength} digits entered. ${required ? `Add ${expectedLength - digits.length} more.` : 'Keep typing.'}` };
    }
    if (!/^(?:09\d{9}|639\d{9})$/.test(digits)) {
      return { valid: false, state: 'invalid', message: `Check the number. Use ${example}.` };
    }
    return { valid: true, state: 'valid', message: 'Number looks good.', normalized: digits.startsWith('63') ? `0${digits.slice(2)}` : digits };
  }

  function update(input, feedback, options) {
    if (!input || !feedback) return check('', false);
    const enabled = options?.enabled !== false;
    const result = enabled ? check(input.value, Boolean(options?.required)) : { valid: false, state: 'neutral', message: '' };
    feedback.textContent = result.message;
    feedback.hidden = !enabled;
    feedback.classList.toggle('is-invalid', result.state === 'invalid');
    feedback.classList.toggle('is-valid', result.state === 'valid');
    input.classList.toggle('is-invalid', result.state === 'invalid');
    input.classList.toggle('is-valid', result.state === 'valid');
    if (result.state === 'invalid') input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    return result;
  }

  return { check, update };
});

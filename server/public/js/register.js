(function () {
  'use strict';

  var form = document.getElementById('auth-register-form');
  if (!form) return;

  var btn = document.getElementById('registerBtn');
  var verificationPanel = document.getElementById('registerVerificationPanel');
  var verificationEmail = document.getElementById('registerVerificationEmail');
  var verificationOtp = document.getElementById('register-otp');
  var verifyOtpBtn = document.getElementById('verifyRegisterOtpBtn');
  var resendOtpBtn = document.getElementById('resendRegisterOtpBtn');
  var changeRegistrationBtn = document.getElementById('changeRegistrationEmailBtn');
  var pendingVerificationEmail = '';
  var resendTimer = null;
  var currentRegisterStep = 1;

  function removeFieldError(input) {
    if (!input) return;
    input.classList.remove('error', 'auth-input-error');
    input.removeAttribute('aria-invalid');
    var field = input.closest('.auth-field') || input.closest('.auth-security') || input.parentElement;
    var existing = field && field.querySelector('.field-error');
    if (existing) existing.remove();
  }

  function showFieldError(input, message) {
    if (!input) return;
    removeFieldError(input);
    input.classList.add('error');
    input.setAttribute('aria-invalid', 'true');
    var field = input.closest('.auth-field') || input.closest('.auth-security') || input.parentElement;
    var error = document.createElement('div');
    error.className = 'field-error';
    error.setAttribute('role', 'alert');
    error.innerHTML = '<i class="bi bi-exclamation-circle" aria-hidden="true"></i> ';
    error.appendChild(document.createTextNode(message));
    if (field) field.appendChild(error);
  }

  function clearFieldErrors() {
    form.querySelectorAll('.field-error').forEach(function (el) { el.remove(); });
    form.querySelectorAll('.error, .auth-input-error').forEach(function (el) {
      el.classList.remove('error', 'auth-input-error');
      el.removeAttribute('aria-invalid');
    });
    var termsLabel = document.querySelector('.auth-terms');
    if (termsLabel) termsLabel.classList.remove('auth-check-error');
  }

  function setRegisterStep(step, focusHeading) {
    var nextStep = Math.max(1, Math.min(3, Number(step) || 1));
    currentRegisterStep = nextStep;
    form.querySelectorAll('[data-register-step]').forEach(function (panel) {
      panel.hidden = Number(panel.getAttribute('data-register-step')) !== nextStep;
    });
    form.querySelectorAll('[data-register-progress]').forEach(function (item) {
      var itemStep = Number(item.getAttribute('data-register-progress'));
      item.classList.toggle('active', itemStep === nextStep);
      item.classList.toggle('complete', itemStep < nextStep);
      if (itemStep === nextStep) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    var progressFill = document.getElementById('registerProgressFill');
    if (progressFill) progressFill.style.width = ((nextStep - 1) * 50) + '%';
    if (focusHeading) {
      var heading = form.querySelector('[data-register-step="' + nextStep + '"] h2');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
      form.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }
  }

  function focusRegisterField(input) {
    if (!input) return;
    var panel = input.closest('[data-register-step]');
    if (panel) setRegisterStep(Number(panel.getAttribute('data-register-step')), false);
    input.focus({ preventScroll: true });
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function requireRegisterField(id, message) {
    var input = document.getElementById(id);
    if (input && String(input.value || '').trim()) return true;
    showFieldError(input, message);
    focusRegisterField(input);
    return false;
  }

  function validateRegisterStep(step) {
    if (step === 1) {
      if (!requireRegisterField('register-firstName', 'Enter your first name.')) return false;
      if (!/^[A-Za-z\s]{1,20}$/.test(document.getElementById('register-firstName').value)) { showFieldError(document.getElementById('register-firstName'), 'Use letters only, up to 20 characters.'); focusRegisterField(document.getElementById('register-firstName')); return false; }
      if (!requireRegisterField('register-lastName', 'Enter your last name.')) return false;
      if (!/^[A-Za-z\s]{1,20}$/.test(document.getElementById('register-lastName').value)) { showFieldError(document.getElementById('register-lastName'), 'Use letters only, up to 20 characters.'); focusRegisterField(document.getElementById('register-lastName')); return false; }
      if (!requireRegisterField('register-email', 'Enter your email address.')) return false;
      var email = document.getElementById('register-email');
      if (!window.authUtils.validateEmail(email.value.trim())) { showFieldError(email, 'Enter a valid email address.'); focusRegisterField(email); return false; }
      if (!requireRegisterField('register-phone', 'Enter your mobile number.')) return false;
      var phone = document.getElementById('register-phone');
      if (!/^(?:0\d{10}|63\d{10}|9\d{9})$/.test(String(phone.value).replace(/\D+/g, ''))) { showFieldError(phone, 'Enter a valid Philippine mobile number.'); focusRegisterField(phone); return false; }
    }
    if (step === 2) {
      if (!requireRegisterField('register-addressProvince', 'Choose your province.')) return false;
      if (!requireRegisterField('register-addressCity', 'Choose your city or municipality.')) return false;
      if (!requireRegisterField('register-addressBarangay', 'Choose your barangay.')) return false;
      if (!requireRegisterField('register-addressPostal', 'Enter your postal code.')) return false;
      var postal = document.getElementById('register-addressPostal');
      if (!/^\d{4}$/.test(postal.value)) { showFieldError(postal, 'Enter a valid 4-digit postal code.'); focusRegisterField(postal); return false; }
    }
    return true;
  }

  form.querySelectorAll('[data-register-next]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (!validateRegisterStep(currentRegisterStep)) return;
      setRegisterStep(Number(button.getAttribute('data-register-next')), true);
    });
  });
  form.querySelectorAll('[data-register-back]').forEach(function (button) {
    button.addEventListener('click', function () { setRegisterStep(Number(button.getAttribute('data-register-back')), true); });
  });
  form.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || currentRegisterStep >= 3 || event.target.tagName === 'TEXTAREA') return;
    event.preventDefault();
    var next = form.querySelector('[data-register-step="' + currentRegisterStep + '"] [data-register-next]');
    if (next) next.click();
  });
  setRegisterStep(1, false);

  function startVerificationCooldown(seconds) {
    if (!resendOtpBtn) return;
    if (resendTimer) clearInterval(resendTimer);
    var remaining = Math.max(1, Number(seconds) || 60);
    resendOtpBtn.disabled = true;
    resendOtpBtn.textContent = 'Resend in ' + remaining + 's';
    resendTimer = setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(resendTimer);
        resendTimer = null;
        resendOtpBtn.disabled = false;
        resendOtpBtn.textContent = 'Resend code';
        return;
      }
      resendOtpBtn.textContent = 'Resend in ' + remaining + 's';
    }, 1000);
  }

  function showRegistrationVerification(email, startCooldown) {
    pendingVerificationEmail = String(email || '').trim().toLowerCase();
    if (!pendingVerificationEmail || !verificationPanel) return;
    var passwordInput = document.getElementById('register-password');
    var confirmInput = document.getElementById('register-confirm');
    if (passwordInput) passwordInput.value = '';
    if (confirmInput) confirmInput.value = '';
    if (typeof window.openSignUp === 'function') window.openSignUp();
    form.classList.add('d-none');
    verificationPanel.classList.remove('d-none');
    if (verificationEmail) verificationEmail.textContent = pendingVerificationEmail;
    if (verificationOtp) {
      verificationOtp.value = '';
      setTimeout(function () { verificationOtp.focus(); }, 100);
    }
    if (startCooldown !== false) startVerificationCooldown(60);
  }

  window.showRegistrationVerification = showRegistrationVerification;

  if (verificationOtp) {
    verificationOtp.addEventListener('input', function () {
      this.value = String(this.value || '').replace(/\D+/g, '').slice(0, 6);
    });
    verificationOtp.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && verifyOtpBtn) {
        event.preventDefault();
        verifyOtpBtn.click();
      }
    });
  }

  if (changeRegistrationBtn) {
    changeRegistrationBtn.addEventListener('click', function () {
      verificationPanel.classList.add('d-none');
      form.classList.remove('d-none');
      if (resendTimer) clearInterval(resendTimer);
      resendTimer = null;
      pendingVerificationEmail = '';
      var emailField = document.getElementById('register-email');
      setRegisterStep(1, false);
      if (emailField) emailField.focus();
    });
  }

  if (verifyOtpBtn) {
    verifyOtpBtn.addEventListener('click', async function () {
      var otp = verificationOtp ? verificationOtp.value.trim() : '';
      if (!/^\d{6}$/.test(otp)) {
        return window.authUtils.swalError('Invalid code', 'Enter the 6-digit code from your email.');
      }

      var previousText = verifyOtpBtn.innerHTML;
      verifyOtpBtn.disabled = true;
      verifyOtpBtn.innerHTML = '<span class="spinner"></span> Verifying...';
      try {
        var response = await fetch('/api/auth/verify-register-otp', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email: pendingVerificationEmail, otp: otp }),
        });
        var result = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          throw new Error(result.error || 'The verification code could not be confirmed.');
        }
        // The destination login page owns the single verification-success alert.
        window.location.assign(result.redirect || '/login?verified=1');
      } catch (error) {
        window.authUtils.swalError('Verification failed', error.message || 'Please try again.');
      } finally {
        verifyOtpBtn.disabled = false;
        verifyOtpBtn.innerHTML = previousText;
      }
    });
  }

  if (resendOtpBtn) {
    resendOtpBtn.addEventListener('click', async function () {
      if (!pendingVerificationEmail) return;
      resendOtpBtn.disabled = true;
      try {
        var response = await fetch('/api/auth/resend-register-otp', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email: pendingVerificationEmail }),
        });
        var result = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          if (response.status === 429 && result.retryAfter) {
            startVerificationCooldown(result.retryAfter);
          }
          throw new Error(result.error || 'Unable to resend the code.');
        }
        startVerificationCooldown(60);
        window.authUtils.swalSuccess('Code sent', result.message || 'A new code was sent to your email.');
      } catch (error) {
        if (!resendTimer) resendOtpBtn.disabled = false;
        window.authUtils.swalError('Unable to resend', error.message || 'Please try again later.');
      }
    });
  }

  // --- Password Toggles ---
  function setupToggle(toggleEl) {
    if (!toggleEl) return;
    var wrap = toggleEl.closest('.auth-field-input-wrap');
    var el = wrap ? wrap.querySelector('input') : toggleEl.previousElementSibling;
    if (!el || el.tagName !== 'INPUT') return;
    toggleEl.addEventListener('click', function () {
      var type = el.getAttribute('type') === 'password' ? 'text' : 'password';
      el.setAttribute('type', type);
      this.innerHTML = type === 'password'
        ? '<i class="bi bi-eye"></i>'
        : '<i class="bi bi-eye-slash"></i>';
      this.setAttribute('aria-label', type === 'password' ? 'Show password' : 'Hide password');
    });
  }
  setupToggle(document.getElementById('togglePasswordReg'));
  setupToggle(document.getElementById('toggleConfirmPasswordReg'));

  // --- Input sanitization ---
  var phoneField = document.getElementById('register-phone');
  if (phoneField) {
    phoneField.addEventListener('input', function () {
      this.value = (this.value || '').replace(/\D+/g, '').slice(0, 11);
    });
  }

  var postalField = document.getElementById('register-addressPostal');
  if (postalField) {
    postalField.addEventListener('input', function () {
      this.value = (this.value || '').replace(/\D+/g, '').slice(0, 4);
    });
  }

  ['firstName', 'lastName'].forEach(function (name) {
    var el = document.getElementById('register-' + name);
    if (el) {
      el.addEventListener('input', function () {
        this.value = (this.value || '').replace(/[^A-Za-z\s]/g, '').slice(0, 20);
      });
    }
  });

  // --- Password validation indicators ---
  var passField = document.getElementById('register-password');
  var confirmField = document.getElementById('register-confirm');
  var matchIndicator = document.getElementById('register-confirm-check');
  var validityIndicator = document.getElementById('register-password-check');
  var suggestionEl = document.getElementById('register-password-suggestions');

  function getPasswordState(value) {
    var password = String(value || '');
    var state = {
      length: password.length >= 8 && password.length <= 30,
      uppercase: /[A-Z]/.test(password),
      numberOrSymbol: /[0-9]/.test(password) || /[^A-Za-z0-9\s]/.test(password)
    };
    state.valid = state.length && state.uppercase && state.numberOrSymbol;
    return state;
  }

  if (passField) {
    passField.addEventListener('input', function () {
      updateIndicators();
      updateSuggestions();
    });
  }

  if (confirmField) {
    confirmField.addEventListener('input', function () {
      updateIndicators();
    });
  }

  function updateSuggestions() {
    if (!suggestionEl) return;
    var pwd = passField ? passField.value : '';
    var items = suggestionEl.querySelectorAll('li[data-rule]');
    var state = getPasswordState(pwd);
    items.forEach(function (li) {
      var rule = li.getAttribute('data-rule');
      var met = Boolean(state[rule]);
      li.classList.toggle('met', met);
      var ico = li.querySelector('i');
      if (ico) {
        ico.className = met ? 'bi bi-check-circle-fill text-success' : 'bi bi-circle';
      }
    });

    var strengthFill = document.getElementById('register-strength-fill');
    if (strengthFill) {
      var score = 0;
      if (pwd.length >= 8) score += 1;
      if (/[A-Z]/.test(pwd)) score += 1;
      if (/[0-9]/.test(pwd)) score += 1;
      if (/[^A-Za-z0-9\s]/.test(pwd)) score += 1;
      strengthFill.style.width = pwd ? (score * 25) + '%' : '0';
      strengthFill.style.background = score <= 1 ? '#d92d3f' : (score <= 2 ? '#d98a18' : '#168653');
    }
  }

  function updateIndicators() {
    var pwd = passField ? passField.value : '';
    var conf = confirmField ? confirmField.value : '';
    var passwordState = getPasswordState(pwd);
    var passwordsMatch = conf.length > 0 && pwd === conf;

    if (matchIndicator) {
      if (conf.length === 0) {
        matchIndicator.classList.add('d-none');
      } else {
        matchIndicator.classList.remove('d-none');
        matchIndicator.innerHTML = passwordsMatch
          ? '<i class="bi bi-check-circle-fill text-success"></i>'
          : '<i class="bi bi-x-circle-fill text-danger"></i>';
      }
    }

    var matchHint = document.getElementById('passwordMatchHint');
    if (matchHint) {
      matchHint.classList.remove('is-success', 'is-warning', 'is-error');
      if (!conf) {
        matchHint.textContent = 'Retype your password to confirm it.';
      } else if (passwordsMatch && passwordState.valid) {
        matchHint.textContent = 'Passwords match.';
        matchHint.classList.add('is-success');
      } else if (passwordsMatch) {
        matchHint.textContent = 'Passwords match. Complete the requirements above.';
        matchHint.classList.add('is-warning');
      } else if (pwd.indexOf(conf) === 0 && document.activeElement === confirmField) {
        matchHint.textContent = 'Keep typing to match your password.';
      } else {
        matchHint.textContent = 'Passwords do not match.';
        matchHint.classList.add('is-error');
      }
    }

    if (validityIndicator) {
      if (pwd.length > 0) {
        validityIndicator.classList.remove('d-none');
        validityIndicator.innerHTML = passwordState.valid
          ? '<i class="bi bi-check-circle-fill text-success"></i>'
          : '<i class="bi bi-x-circle-fill text-danger"></i>';
      } else {
        validityIndicator.classList.add('d-none');
      }
    }
  }

  // Initial state
  updateSuggestions();

  form.querySelectorAll('input, select').forEach(function (input) {
    input.addEventListener('input', function () { removeFieldError(input); });
    input.addEventListener('change', function () { removeFieldError(input); });
  });
  var termsCheckbox = document.getElementById('register-terms');
  if (termsCheckbox) {
    termsCheckbox.addEventListener('change', function () {
      var termsLabel = document.querySelector('.auth-terms');
      if (termsLabel) termsLabel.classList.remove('auth-check-error');
    });
  }

  var registerEmailField = document.getElementById('register-email');
  if (registerEmailField) {
    registerEmailField.addEventListener('blur', function () {
      var value = this.value.trim();
      if (value && !window.authUtils.validateEmail(value)) showFieldError(this, 'Enter a valid email address.');
    });
  }

  // --- Form Submit ---
  form.addEventListener('submit', async function (e) {
    e.preventDefault();

    clearFieldErrors();

    var formData = new FormData(form);
    var email = formData.get('email') || '';
    var password = formData.get('password') || '';
    var confirm = formData.get('confirmPassword') || '';
    var firstName = formData.get('firstName') || '';
    var lastName = formData.get('lastName') || '';
    var phone = formData.get('phone') || '';
    var addressProvince = formData.get('addressProvince') || '';
    var addressCity = formData.get('addressCity') || '';
    var addressBarangay = formData.get('addressBarangay') || '';
    var addressPostal = formData.get('addressPostal') || '';
    var mathCaptcha = formData.get('mathCaptcha') || '';
    var mathAnswer = formData.get('mathAnswer') || '';
    var csrfToken = formData.get('csrfToken') || '';
    var termsAccepted = document.getElementById('register-terms');

    // Validation
    var requiredFields = [
      ['register-firstName', firstName, 'First name is required.'],
      ['register-lastName', lastName, 'Last name is required.'],
      ['register-email', email, 'Email address is required.'],
      ['register-phone', phone, 'Phone number is required.'],
      ['register-addressProvince', addressProvince, 'Province is required.'],
      ['register-addressCity', addressCity, 'City or municipality is required.'],
      ['register-addressBarangay', addressBarangay, 'Barangay is required.'],
      ['register-addressPostal', addressPostal, 'Postal code is required.'],
      ['register-password', password, 'Password is required.'],
      ['register-confirm', confirm, 'Please confirm your password.'],
      ['register-math', mathCaptcha, 'Complete the security check.']
    ];
    var firstInvalid = null;
    requiredFields.some(function (item) {
      if (!String(item[1] || '').trim()) {
        var input = document.getElementById(item[0]);
        showFieldError(input, item[2]);
        firstInvalid = input;
        return true;
      }
      return false;
    });
    if (firstInvalid) { focusRegisterField(firstInvalid); return; }

    if (!/^\d{1,3}$/.test(mathCaptcha)) {
      showFieldError(document.getElementById('register-math'), 'Enter the answer as a number.');
      return focusRegisterField(document.getElementById('register-math'));
    }

    if (!/^[A-Za-z\s]{1,20}$/.test(firstName)) {
      showFieldError(document.getElementById('register-firstName'), 'Use letters only, up to 20 characters.');
      return focusRegisterField(document.getElementById('register-firstName'));
    }

    if (!/^[A-Za-z\s]{1,20}$/.test(lastName)) {
      showFieldError(document.getElementById('register-lastName'), 'Use letters only, up to 20 characters.');
      return focusRegisterField(document.getElementById('register-lastName'));
    }

    var phoneDigits = String(phone).replace(/\D+/g, '');
    if (!/^(?:0\d{10}|63\d{10}|9\d{9})$/.test(phoneDigits)) {
      showFieldError(document.getElementById('register-phone'), 'Enter a valid Philippine mobile number.');
      return focusRegisterField(document.getElementById('register-phone'));
    }

    if (email.length > 254) {
      showFieldError(registerEmailField, 'Email cannot exceed 254 characters.');
      return focusRegisterField(registerEmailField);
    }

    if (!window.authUtils.validateEmail(email)) {
      showFieldError(registerEmailField, 'Enter a valid email address.');
      return focusRegisterField(registerEmailField);
    }

    if (password.length < 8) {
      showFieldError(passField, 'Use at least 8 characters.');
      return focusRegisterField(passField);
    }

    if (password.length > 30) {
      showFieldError(passField, 'Password cannot exceed 30 characters.');
      return focusRegisterField(passField);
    }

    if (!getPasswordState(password).valid) {
      showFieldError(passField, 'Include at least one uppercase letter and at least one number or symbol.');
      return focusRegisterField(passField);
    }

    if (password !== confirm) {
      showFieldError(confirmField, 'Passwords do not match.');
      return focusRegisterField(confirmField);
    }

    if (!termsAccepted || !termsAccepted.checked) {
      var termsLabel = document.querySelector('.auth-terms');
      if (termsLabel) termsLabel.classList.add('auth-check-error');
      if (termsAccepted) termsAccepted.focus();
      return window.authUtils.swalError('Agreement required', 'Please agree to the Terms and Conditions to create your account.');
    }

    // Loading
    var previousText = btn ? btn.innerHTML : 'Sign Up';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Creating account...';
    }

    try {
      var res = await fetch('/api/auth/register', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email,
          password: password,
          csrfToken: csrfToken,
          firstName: firstName,
          lastName: lastName,
          phone: phoneDigits,
          addressProvince: addressProvince,
          addressCity: addressCity,
          addressBarangay: addressBarangay,
          addressPostal: addressPostal,
          mathCaptcha: mathCaptcha,
          mathAnswer: mathAnswer,
        }),
      });
      var body = await res.json().catch(function () { return {}; });

      if (res.ok && body.requiresVerification) {
        showRegistrationVerification(body.email || email, true);
        window.authUtils.swalSuccess('Check your email', body.message || 'Enter the verification code we sent you.');
      } else if (res.ok && body.requiresVerification === false) {
        await window.authUtils.swalSuccess('Account created', body.message || 'You can now sign in.');
        window.location.assign(body.redirect || '/login?registered=1');
      } else if (body && body.requiresVerification) {
        showRegistrationVerification(body.email || email, false);
        if (res.status === 429 && body.retryAfter) {
          startVerificationCooldown(body.retryAfter);
        }
        window.authUtils.swalError(
          res.status === 429 ? 'Verification pending' : 'Email not sent',
          body.error || 'Use Resend code to try again.'
        );
      } else if (res.status === 409) {
        showFieldError(registerEmailField, body && body.error ? body.error : 'An account already uses this email.');
        focusRegisterField(registerEmailField);
      } else if (res.status === 429) {
        window.authUtils.swalError('Too many attempts', 'Please wait a short while and try again.', { reload: true });
      } else {
        window.authUtils.swalError('Registration failed', body && body.error ? body.error : 'An error occurred.');
      }
    } catch (e) {
      window.authUtils.swalError('Network error', 'Unable to reach the server. Please try again later.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = previousText;
      }
    }
  });
})();

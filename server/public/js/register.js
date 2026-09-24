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

  function sanitizePwd(val) {
    var v = String(val || '');
    v = v.replace(/[^A-Za-z0-9@!#$]/g, '');
    var seen = {};
    var out = '';
    for (var i = 0; i < v.length; i++) {
      var ch = v[i];
      if (/[@!#$]/.test(ch)) {
        if (seen[ch]) continue;
        seen[ch] = true;
      }
      out += ch;
    }
    var upperSeen = false;
    var result = '';
    for (var j = 0; j < out.length; j++) {
      var c = out[j];
      if (c >= 'A' && c <= 'Z') {
        if (!upperSeen) { result += c; upperSeen = true; }
      } else {
        result += c;
      }
    }
    return result.slice(0, 30);
  }

  if (passField) {
    passField.addEventListener('input', function () {
      this.value = sanitizePwd(this.value);
      updateIndicators();
      updateSuggestions();
    });
  }

  if (confirmField) {
    confirmField.addEventListener('input', function () {
      this.value = sanitizePwd(this.value);
      updateIndicators();
    });
  }

  function updateSuggestions() {
    if (!suggestionEl) return;
    var pwd = passField ? passField.value : '';
    var items = suggestionEl.querySelectorAll('li[data-rule]');
    items.forEach(function (li) {
      var rule = li.getAttribute('data-rule');
      var met = false;
      if (rule === 'letter') met = /[A-Z]/.test(pwd);
      else if (rule === 'digitOrSpecial') met = /[0-9@!#$]/.test(pwd);
      else if (rule === 'length') met = pwd.length >= 8 && pwd.length <= 30;
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
      if (/[@!#$]/.test(pwd)) score += 1;
      strengthFill.style.width = pwd ? (score * 25) + '%' : '0';
      strengthFill.style.background = score <= 1 ? '#d92d3f' : (score <= 2 ? '#d98a18' : '#168653');
    }
  }

  function updateIndicators() {
    var pwd = passField ? passField.value : '';
    var conf = confirmField ? confirmField.value : '';
    var ok = /^(?=(?:.*[A-Z]){1})(?=.*[0-9@!#$])[A-Za-z0-9@!#$]{8,30}$/.test(pwd);

    if (matchIndicator) {
      if (conf.length === 0) {
        matchIndicator.classList.add('d-none');
      } else {
        matchIndicator.classList.remove('d-none');
        matchIndicator.innerHTML = pwd === conf && ok
          ? '<i class="bi bi-check-circle-fill text-success"></i>'
          : '<i class="bi bi-x-circle-fill text-danger"></i>';
      }
    }

    var matchHint = document.getElementById('passwordMatchHint');
    if (matchHint) {
      if (!conf) {
        matchHint.textContent = 'Both passwords must match.';
        matchHint.style.color = '';
      } else if (pwd === conf && ok) {
        matchHint.textContent = 'Passwords match.';
        matchHint.style.color = '#168653';
      } else {
        matchHint.textContent = 'Passwords do not match.';
        matchHint.style.color = '#d92d3f';
      }
    }

    if (validityIndicator) {
      if (pwd.length > 0) {
        validityIndicator.classList.remove('d-none');
        validityIndicator.innerHTML = ok && (conf.length === 0 || pwd === conf)
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
      ['register-addressPostal', addressPostal, 'Postal code is required.'],
      ['register-password', password, 'Password is required.'],
      ['register-confirm', confirm, 'Please confirm your password.'],
      ['register-math', mathCaptcha, 'Complete the security check.']
    ];
    var firstInvalid = null;
    requiredFields.forEach(function (item) {
      if (!String(item[1] || '').trim()) {
        var input = document.getElementById(item[0]);
        showFieldError(input, item[2]);
        if (!firstInvalid) firstInvalid = input;
      }
    });
    if (firstInvalid) { firstInvalid.focus(); return; }

    if (!/^\d{1,3}$/.test(mathCaptcha)) {
      showFieldError(document.getElementById('register-math'), 'Enter the answer as a number.');
      return document.getElementById('register-math').focus();
    }

    if (!/^[A-Za-z\s]{1,20}$/.test(firstName)) {
      showFieldError(document.getElementById('register-firstName'), 'Use letters only, up to 20 characters.');
      return document.getElementById('register-firstName').focus();
    }

    if (!/^[A-Za-z\s]{1,20}$/.test(lastName)) {
      showFieldError(document.getElementById('register-lastName'), 'Use letters only, up to 20 characters.');
      return document.getElementById('register-lastName').focus();
    }

    var phoneDigits = String(phone).replace(/\D+/g, '');
    if (!/^(?:0\d{10}|63\d{10}|9\d{9})$/.test(phoneDigits)) {
      showFieldError(document.getElementById('register-phone'), 'Enter a valid Philippine mobile number.');
      return document.getElementById('register-phone').focus();
    }

    if (email.length > 254) {
      showFieldError(registerEmailField, 'Email cannot exceed 254 characters.');
      return registerEmailField.focus();
    }

    if (!window.authUtils.validateEmail(email)) {
      showFieldError(registerEmailField, 'Enter a valid email address.');
      return registerEmailField.focus();
    }

    if (password.length < 8) {
      showFieldError(passField, 'Use at least 8 characters.');
      return passField.focus();
    }

    if (password.length > 30) {
      showFieldError(passField, 'Password cannot exceed 30 characters.');
      return passField.focus();
    }

    if (!/^(?=(?:.*[A-Z]){1})(?=.*[0-9@!#$])[A-Za-z0-9@!#$]{8,30}$/.test(password)) {
      showFieldError(passField, 'Include one uppercase letter and a number or symbol.');
      return passField.focus();
    }

    if (password !== confirm) {
      showFieldError(confirmField, 'Passwords do not match.');
      return confirmField.focus();
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
        registerEmailField.focus();
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

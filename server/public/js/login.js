(function () {
  'use strict';

  var form = document.getElementById('auth-login-form');
  if (!form) return;

  var btn = document.getElementById('loginBtn');
  var emailInput = document.getElementById('email');
  var passwordInput = document.getElementById('password');
  var otpBlock = document.getElementById('otpBlock');
  var otpInput = document.getElementById('login-otp');
  var resendBtn = document.getElementById('resendOtpBtn');
  var trustDeviceOption = document.getElementById('trustTechnicianDeviceOption');
  var trustDeviceInput = document.getElementById('trustTechnicianDevice');
  var mathInput = document.querySelector('#auth-login-form input[name="mathCaptcha"]');
  var csrfInput = document.querySelector('#auth-login-form input[name="csrfToken"]');
  var otpNotice = document.getElementById('loginOtpNotice');
  var resendTimer = null;
  var flowVersion = 0;
  var pendingEmail = '';

  function setOtpNotice(message) {
    if (otpNotice) otpNotice.textContent = message;
  }

  function resetOtpFlow() {
    pendingEmail = '';
    if (otpBlock) otpBlock.classList.add('d-none');
    if (otpInput) { otpInput.value = ''; removeFieldError(otpInput); }
    if (trustDeviceInput) trustDeviceInput.checked = false;
    clearTimeout(resendTimer);
    resendTimer = null;
    if (resendBtn) { resendBtn.disabled = false; resendBtn.textContent = 'Resend OTP'; }
  }

  function otpFailure(body, fallback) {
    var message = body.error || fallback;
    if (body.restartLogin) {
      resetOtpFlow();
      showFieldError(passwordInput, message);
      passwordInput.focus();
    } else {
      showFieldError(otpInput, message);
      otpInput.focus();
    }
  }

  // --- Helpers ---
  function showFieldError(input, message) {
    removeFieldError(input);
    if (!message) return;
    input.classList.add('error');
    input.setAttribute('aria-invalid', 'true');
    var err = document.createElement('div');
    err.className = 'field-error';
    err.setAttribute('role', 'alert');
    err.innerHTML = '<i class="bi bi-exclamation-circle"></i> ';
    err.appendChild(document.createTextNode(message));
    var field = input.closest('.auth-field') || input.parentElement;
    field.appendChild(err);
  }

  function removeFieldError(input) {
    input.classList.remove('error');
    input.classList.remove('success');
    input.removeAttribute('aria-invalid');
    var field = input.closest('.auth-field') || input.parentElement;
    var existing = field.querySelector('.field-error');
    if (existing) existing.remove();
  }

  function clearFieldErrors() {
    [emailInput, passwordInput, mathInput, otpInput].forEach(function (el) {
      if (el) removeFieldError(el);
    });
  }

  function setLoading(loading) {
    if (!btn) return;
    btn.disabled = loading;
    if (loading) {
      btn.innerHTML = '<span class="spinner"></span> Signing in...';
    } else {
      btn.innerHTML = '<span class="btn-text">Log In</span><i class="bi bi-arrow-right" aria-hidden="true"></i>';
    }
  }

  // --- Password Toggle ---
  function setupToggle(toggleEl) {
    if (!toggleEl) return;
    var wrap = toggleEl.closest('.auth-field-input-wrap');
    var el = wrap ? wrap.querySelector('input') : toggleEl.previousElementSibling;
    if (!el || el.tagName !== 'INPUT') return;
    toggleEl.addEventListener('click', function () {
      var isPwd = el.getAttribute('type') === 'password';
      el.setAttribute('type', isPwd ? 'text' : 'password');
      toggleEl.innerHTML = isPwd
        ? '<i class="bi bi-eye-slash"></i>'
        : '<i class="bi bi-eye"></i>';
      toggleEl.setAttribute('aria-label', isPwd ? 'Hide password' : 'Show password');
    });
  }
  setupToggle(document.getElementById('togglePassword'));

  // --- Caps Lock Detection ---
  var capsHint = document.getElementById('capsLockHint');
  if (passwordInput && capsHint) {
    var updateCaps = function (e) {
      var on = e && typeof e.getModifierState === 'function' && e.getModifierState('CapsLock');
      capsHint.classList.toggle('d-none', !on);
    };
    passwordInput.addEventListener('keydown', updateCaps);
    passwordInput.addEventListener('keyup', updateCaps);
    passwordInput.addEventListener('blur', function () { capsHint.classList.add('d-none'); });
  }

  // --- OTP Resend ---
  function startResendCooldown(button, duration) {
    clearTimeout(resendTimer);
    var remaining = Math.min(600, Math.max(1, Math.ceil(Number(duration) || 60)));
    button.disabled = true;
    function tick() {
      if (remaining <= 0) {
        resendTimer = null;
        button.disabled = false;
        button.textContent = 'Resend OTP';
      } else {
        button.textContent = 'Resend in ' + remaining + 's';
        remaining -= 1;
        resendTimer = setTimeout(tick, 1000);
      }
    }
    tick();
  }

  if (resendBtn) {
    resendBtn.addEventListener('click', async function () {
      var emailVal = emailInput ? emailInput.value : '';
      if (resendBtn.disabled || !pendingEmail || emailVal.trim().toLowerCase() !== pendingEmail) return;
      var version = flowVersion;
      resendBtn.disabled = true;
      removeFieldError(otpInput);
      try {
        var response = await fetch('/api/auth/resend-login-otp', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email: emailVal, csrfToken: csrfInput ? csrfInput.value : '' }),
        });
        var result = await response.json().catch(function () { return {}; });
        if (version !== flowVersion) return;
        if (!response.ok || !result.message) {
          if (response.status === 429) startResendCooldown(resendBtn, result.retryAfter || 60);
          otpFailure(result, 'Unable to resend the code right now. Please try again shortly.');
          return;
        }
        otpInput.value = '';
        setOtpNotice(result.message);
        startResendCooldown(resendBtn, result.retryAfter || 60);
        otpInput.focus();
      } catch (error) {
        if (version === flowVersion) otpFailure({}, 'Unable to reach the server. Check your connection and try again.');
      } finally {
        if (version === flowVersion && !resendTimer) resendBtn.disabled = false;
      }
    });
  }

  // --- Inline Validation ---
  if (emailInput) {
    emailInput.addEventListener('blur', function () {
      var val = this.value.trim();
      if (val && !window.authUtils.validateEmail(val)) {
        showFieldError(this, 'Please enter a valid email address');
      } else {
        removeFieldError(this);
      }
    });
    emailInput.addEventListener('input', function () {
      flowVersion += 1;
      if (pendingEmail) resetOtpFlow();
      if (this.classList.contains('error')) {
        var val = this.value.trim();
        if (val && window.authUtils.validateEmail(val)) {
          removeFieldError(this);
          this.classList.add('success');
        }
      }
    });
  }

  if (passwordInput) {
    passwordInput.addEventListener('input', function () {
      flowVersion += 1;
      if (pendingEmail) resetOtpFlow();
      if (this.classList.contains('error')) {
        removeFieldError(this);
      }
    });
  }

  // --- Form Submit ---
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    clearFieldErrors();

    var email = emailInput ? emailInput.value.trim() : '';
    var password = passwordInput ? passwordInput.value : '';
    var otp = otpInput ? otpInput.value.trim() : '';
    var mathCaptcha = mathInput ? mathInput.value.trim() : '';
    var mathAnswer = (document.querySelector('#auth-login-form input[name="mathAnswer"]') || {}).value || '';
    var csrfToken = csrfInput ? csrfInput.value : '';
    var rememberMe = document.getElementById('rememberMe') ? document.getElementById('rememberMe').checked : false;
    var version = flowVersion;

    // OTP verification flow
    if (otpBlock && !otpBlock.classList.contains('d-none')) {
      if (!email || !otp) {
        showFieldError(otpInput, 'Please enter the verification code from your email.');
        if (otpInput) otpInput.focus();
        return;
      }
      if (!/^\d{6}$/.test(otp)) {
        showFieldError(otpInput, 'Please enter the 6-digit code.');
        if (otpInput) otpInput.focus();
        return;
      }
      setLoading(true);
      try {
        var resp = await fetch('/api/auth/verify-login-otp', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            email: email,
            otp: otp,
            csrfToken: csrfToken,
            returnTo: returnTo,
            trustDevice: Boolean(
              trustDeviceOption &&
              !trustDeviceOption.classList.contains('d-none') &&
              trustDeviceInput &&
              trustDeviceInput.checked
            ),
          }),
        });
        var body = await resp.json().catch(function () { return {}; });
        if (version !== flowVersion) return;
        if (resp.ok && body.redirect) {
          window.location.assign(body.redirect);
          return;
        }
        otpFailure(body, 'Unable to verify the code right now. Please try again shortly.');
      } catch (e) {
        if (version === flowVersion) otpFailure({}, 'Unable to reach the server. Please try again.');
      } finally {
        setLoading(false);
      }
      return;
    }

    // Basic validation
    var hasError = false;
    if (!email) {
      showFieldError(emailInput, 'Email is required');
      hasError = true;
    } else if (email.length > 254) {
      showFieldError(emailInput, 'Email cannot exceed 254 characters');
      hasError = true;
    } else if (!window.authUtils.validateEmail(email)) {
      showFieldError(emailInput, 'Please enter a valid email');
      hasError = true;
    }
    if (!password) {
      showFieldError(passwordInput, 'Password is required');
      hasError = true;
    } else if (password.length > 128) {
      showFieldError(passwordInput, 'Password cannot exceed 128 characters');
      hasError = true;
    }
    if (!mathCaptcha) {
      showFieldError(mathInput, 'Please complete the captcha');
      hasError = true;
    }
    if (hasError) return;

    setLoading(true);

    var loginFinished = false;
    try {
      var res = await fetch('/api/auth/secure/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          email: email,
          password: password,
          csrfToken: csrfToken,
          mathCaptcha: mathCaptcha,
          mathAnswer: mathAnswer,
          mathChallenge: window.AuthSecurityQuestion ? window.AuthSecurityQuestion.token(form) : '',
          rememberMe: rememberMe,
          returnTo: returnTo,
        }),
      });
      var body = await res.json().catch(function () { return {}; });
      if (version !== flowVersion) return;

      // OTP required for privileged roles
      if (res.ok && body.requiresOTP) {
        loginFinished = true;
        pendingEmail = email.toLowerCase();
        if (otpBlock) otpBlock.classList.remove('d-none');
        if (trustDeviceOption) {
          trustDeviceOption.classList.toggle('d-none', !body.canTrustDevice);
        }
        if (trustDeviceInput) trustDeviceInput.checked = false;
        if (otpInput) { otpInput.focus(); otpInput.value = ''; }
        setOtpNotice(body.message || 'Check your inbox and spam folder for the newest verification code.');
        if (resendBtn) startResendCooldown(resendBtn, body.retryAfter || 60);
        return;
      }

      if (res.ok && body.redirect) {
        loginFinished = true;
        window.location.assign(body.redirect);
        return;
      }

      if (body && body.requiresEmailVerification) {
        if (typeof window.showRegistrationVerification === 'function') {
          window.showRegistrationVerification(body.email || email, false);
        }
        window.authUtils.swalError(
          'Email verification required',
          body.error || 'Verify your email before signing in. You can request a new code.'
        );
        return;
      }

      if (res.status === 429) {
        handleRateLimit(body);
      } else if (res.status === 401) {
        showFieldError(passwordInput, 'Incorrect email or password. Please try again.');
        passwordInput.focus();
      } else {
        window.authUtils.swalError(
          'Sign in failed',
          body && body.error ? body.error : 'Invalid email or password. Please try again.'
        );
      }
    } catch (e) {
      window.authUtils.swalError('Network error', 'Unable to reach the server. Please try again later.');
    } finally {
      if (!loginFinished && window.AuthSecurityQuestion) await window.AuthSecurityQuestion.refresh(form);
      setLoading(false);
    }
  });

  // --- Rate Limit Handler ---
  function handleRateLimit(body) {
    var retry = body && body.retryAfter ? Number(body.retryAfter) : null;
    var mins = retry ? Math.ceil(retry / 60) : 5;
    var waitText = mins > 1 ? mins + ' min' : mins + ' minute';

    if (body && body.showPopup) {
      Swal.fire({
        icon: 'warning',
        title: body.popupTitle || 'Account Temporarily Locked',
        html:
          '<div style="text-align:left;padding:10px;">' +
          '<p><strong>' + (body.popupMessage || 'You cannot log in again for ' + waitText + '.') + '</strong></p>' +
          '<p style="margin-top:12px;font-size:14px;color:#5a6a7e;">This is cycle ' + (body.currentCycle || 1) +
          ' - the lockout duration increases with each failed cycle.</p>' +
          '<div style="margin-top:12px;padding:10px;background:#f8fbff;border-radius:6px;font-size:13px;">' +
          '<strong>Progressive Lockout:</strong><br>' +
          'Cycle 1: 5 attempts \u2192 3 minutes<br>' +
          'Cycle 2: 5 attempts \u2192 5 minutes<br>' +
          'Cycle 3: 5 attempts \u2192 10 minutes<br>' +
          'Cycle 4+: 5 attempts \u2192 30 minutes' +
          '</div></div>',
        confirmButtonText: 'I Understand',
        confirmButtonColor: '#0d6efd',
        allowOutsideClick: false,
        allowEscapeKey: false,
      });
    }

    window.authUtils.swalError('Too many attempts', body.error || 'Too many login attempts. Try again after ' + waitText + '.');
  }

  // --- Go Home Button ---
  var goHomeBtn = document.getElementById('goHomeBtn');
  if (goHomeBtn) {
    goHomeBtn.addEventListener('click', function (e) {
      e.preventDefault();
      Promise.all([
        fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }).catch(function () {}),
        fetch('/api/auth/secure/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }).catch(function () {}),
      ]).finally(function () {
        window.location.href = '/';
      });
    });
  }

  // --- URL Parameter Handling ---
  var params = new URLSearchParams(window.location.search);
  var returnTo = params.get('returnTo') || '';

  if (params.get('google_error')) {
    var googleErrorMessages = {
      not_configured: 'Google sign-in is not available right now. Please use your email and password.',
      cancelled: 'Google sign-in was cancelled.',
      invalid_request: 'The Google sign-in request expired or was invalid. Please try again.',
      invalid_account: 'Google could not verify that account. Please choose a verified Google account.',
      account_not_found: 'No existing account uses that Google email. Create your account first, then sign in with Google.',
      registration_disabled: 'New account creation is temporarily unavailable.',
      email_verification_required: 'Use the email signup form for this address so you can verify it with a code.',
      signup_expired: 'Your Google signup expired. Please start again.',
      account_unavailable: 'That account is not available. Please contact support if you need help.',
      failed: 'Google sign-in could not be completed. Please try again.',
    };
    var googleError = params.get('google_error');
    window.authUtils.swalError(
      'Google sign-in failed',
      googleErrorMessages[googleError] || googleErrorMessages.failed
    );
    if (window.history && window.history.replaceState) {
      try {
        var googleErrorUrl = new URL(window.location.href);
        googleErrorUrl.searchParams.delete('google_error');
        window.history.replaceState(null, '', googleErrorUrl.pathname + googleErrorUrl.search + googleErrorUrl.hash);
      } catch (e) { /* ignore */ }
    }
  }

  if (params.get('registered')) {
    window.authUtils.swalSuccess('Account created', 'Your account was created successfully. Please log in.');
    // Clean URL
    if (window.history && window.history.replaceState) {
      try {
        var u = new URL(window.location.href);
        u.searchParams.delete('registered');
        window.history.replaceState(null, '', u.pathname + u.search + u.hash);
      } catch (e) { /* ignore */ }
    }
  }

  if (params.get('verified')) {
    window.authUtils.swalSuccess('Email verified', 'Your account is verified. You can now sign in.');
    if (window.history && window.history.replaceState) {
      try {
        var verifiedUrl = new URL(window.location.href);
        verifiedUrl.searchParams.delete('verified');
        window.history.replaceState(null, '', verifiedUrl.pathname + verifiedUrl.search + verifiedUrl.hash);
      } catch (e) { /* ignore */ }
    }
  }

  if (params.get('activated')) {
    window.authUtils.swalSuccess('Account activated', 'Your email is verified and your walk-in activity is ready to track. Sign in to continue.');
    if (window.history && window.history.replaceState) {
      try {
        var activatedUrl = new URL(window.location.href);
        activatedUrl.searchParams.delete('activated');
        window.history.replaceState(null, '', activatedUrl.pathname + activatedUrl.search + activatedUrl.hash);
      } catch (e) { /* ignore */ }
    }
  }

  if (params.get('msg')) {
    try {
      window.authUtils.swalError('Please sign in', params.get('msg'));
    } catch (e) { /* ignore */ }
  }
})();

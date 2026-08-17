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
  var mathInput = document.querySelector('#auth-login-form input[name="mathCaptcha"]');
  var csrfInput = document.querySelector('#auth-login-form input[name="csrfToken"]');

  // --- Helpers ---
  function showFieldError(input, message) {
    removeFieldError(input);
    if (!message) return;
    input.classList.add('error');
    var err = document.createElement('div');
    err.className = 'field-error';
    err.textContent = message;
    var field = input.closest('.auth-field') || input.parentElement;
    field.appendChild(err);
  }

  function removeFieldError(input) {
    input.classList.remove('error');
    input.classList.remove('success');
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
      btn.innerHTML = 'Sign In';
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

  // --- OTP Resend ---
  function startResendCooldown(button, duration) {
    var remaining = duration;
    button.disabled = true;
    function tick() {
      if (remaining <= 0) {
        button.disabled = false;
        button.textContent = 'Resend OTP';
      } else {
        button.textContent = 'Resend in ' + remaining + 's';
        remaining -= 1;
        setTimeout(tick, 1000);
      }
    }
    tick();
  }

  if (resendBtn) {
    resendBtn.addEventListener('click', function () {
      var emailVal = emailInput ? emailInput.value : '';
      if (!emailVal) {
        window.authUtils.swalError('Missing email', 'Please enter your email to resend the OTP.');
        return;
      }
      startResendCooldown(resendBtn, 60);
      fetch('/api/auth/resend-login-otp', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailVal }),
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          window.authUtils.swalSuccess('OTP sent', j.message || 'A new code was sent to your email.');
        })
        .catch(function () {
          window.authUtils.swalError('Unable to resend', 'Please try again later.');
        });
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
    passwordInput.addEventListener('blur', function () {
      if (this.value && this.value.length < 8) {
        showFieldError(this, 'Password must be at least 8 characters');
      } else {
        removeFieldError(this);
      }
    });
    passwordInput.addEventListener('input', function () {
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

    // OTP verification flow
    if (otpBlock && !otpBlock.classList.contains('d-none')) {
      if (!email || !otp) {
        window.authUtils.swalError('Missing code', 'Please enter the verification code sent to your email.');
        if (otpInput) otpInput.focus();
        return;
      }
      if (!/^\d{6}$/.test(otp)) {
        window.authUtils.swalError('Invalid code', 'Please enter the 6-digit code.');
        if (otpInput) otpInput.focus();
        return;
      }
      setLoading(true);
      try {
        var resp = await fetch('/api/auth/verify-login-otp', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email: email, otp: otp, returnTo: returnTo }),
        });
        var body = await resp.json().catch(function () { return {}; });
        if (resp.ok && body.redirect) {
          window.location.assign(body.redirect);
          return;
        }
        if (resp.ok) {
          window.location.assign('/');
          return;
        }
        if (resp.status === 429) {
          handleRateLimit(body);
        } else {
          window.authUtils.swalError('Verification failed', body.error || 'Invalid or expired code.');
        }
      } catch (e) {
        window.authUtils.swalError('Network error', 'Unable to reach the server. Please try again.');
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
          rememberMe: rememberMe,
          returnTo: returnTo,
        }),
      });
      var body = await res.json().catch(function () { return {}; });

      // OTP required for privileged roles
      if (res.ok && body.requiresOTP) {
        if (otpBlock) otpBlock.classList.remove('d-none');
        if (otpInput) { otpInput.focus(); otpInput.value = ''; }
        window.authUtils.swalSuccess('OTP sent', body.message || 'A verification code was sent to your email.');
        if (resendBtn) startResendCooldown(resendBtn, 60);
        return;
      }

      if (res.ok && body.redirect) {
        window.location.assign(body.redirect);
        return;
      }

      if (res.ok) {
        window.location.assign('/');
        return;
      }

      if (res.status === 429) {
        handleRateLimit(body);
      } else {
        window.authUtils.swalError(
          'Sign in failed',
          body && body.error ? body.error : 'Invalid email or password. Please try again.'
        );
      }
    } catch (e) {
      window.authUtils.swalError('Network error', 'Unable to reach the server. Please try again later.');
    } finally {
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

  if (params.get('msg')) {
    try {
      window.authUtils.swalError('Please sign in', params.get('msg'));
    } catch (e) { /* ignore */ }
  }
})();

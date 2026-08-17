(function () {
  'use strict';

  var form = document.getElementById('auth-register-form');
  if (!form) return;

  var btn = document.getElementById('registerBtn');

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
      else if (rule === 'length') met = pwd.length >= 10;
      li.classList.toggle('met', met);
      var ico = li.querySelector('i');
      if (ico) {
        ico.className = met ? 'bi bi-check-circle-fill text-success' : 'bi bi-circle';
      }
    });
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

  // --- Form Submit ---
  form.addEventListener('submit', async function (e) {
    e.preventDefault();

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

    // Validation
    if (!firstName || !lastName || !phone || !addressProvince || !addressCity || !addressPostal || !email || !password || !confirm || !mathCaptcha) {
      return window.authUtils.swalError('Missing information', 'Please complete all required fields.');
    }

    if (!/^\d{1,2}$/.test(mathCaptcha)) {
      return window.authUtils.swalError('Invalid captcha', 'Captcha must be a 1-2 digit number.');
    }

    if (!/^[A-Za-z\s]{1,20}$/.test(firstName)) {
      return window.authUtils.swalError('Invalid first name', 'First name must be letters only and maximum 20 characters.');
    }

    if (!/^[A-Za-z\s]{1,20}$/.test(lastName)) {
      return window.authUtils.swalError('Invalid last name', 'Last name must be letters only and maximum 20 characters.');
    }

    var phoneDigits = String(phone).replace(/\D+/g, '');
    if (!/^(?:0\d{10}|63\d{10}|9\d{9})$/.test(phoneDigits)) {
      return window.authUtils.swalError('Invalid phone', 'Phone must be a Philippine mobile number (e.g. 09XXXXXXXXX).');
    }

    if (email.length > 30) {
      return window.authUtils.swalError('Invalid email', 'Email cannot exceed 30 characters.');
    }

    if (!window.authUtils.validateEmail(email)) {
      return window.authUtils.swalError('Invalid email', 'Please provide a valid email address.');
    }

    if (password.length < 8) {
      return window.authUtils.swalError('Weak password', 'Password must be at least 8 characters long.');
    }

    if (password.length > 30) {
      return window.authUtils.swalError('Password too long', 'Password cannot exceed 30 characters.');
    }

    if (!/^(?=(?:.*[A-Z]){1})(?=.*[0-9@!#$])[A-Za-z0-9@!#$]{8,30}$/.test(password)) {
      return window.authUtils.swalError('Invalid password', 'Password must be 8-30 characters with letters, numbers, and at least one uppercase letter.');
    }

    if (password !== confirm) {
      return window.authUtils.swalError('Passwords do not match', 'Please ensure both password fields match.');
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

      if (res.status === 201) {
        window.location.href = '/login?registered=1';
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

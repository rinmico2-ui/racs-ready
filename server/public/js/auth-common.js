(function () {
  'use strict';

  window.authUtils = {
    swalError: function (title, text, opts) {
      opts = opts || {};
      return Swal.fire({
        icon: 'error',
        title: title || 'Error',
        text: text || '',
        confirmButtonText: 'OK',
        confirmButtonColor: '#0d6efd',
        showClass: { popup: 'swal2-show' },
        hideClass: { popup: 'swal2-hide' },
      }).then(function (res) {
        if (opts.reload) {
          setTimeout(function () { window.location.reload(); }, 200);
        }
        return res;
      });
    },

    swalSuccess: function (title, text) {
      return Swal.fire({
        icon: 'success',
        title: title || 'Success',
        text: text || '',
        confirmButtonText: 'OK',
        confirmButtonColor: '#0d6efd',
        showClass: { popup: 'swal2-show' },
        hideClass: { popup: 'swal2-hide' },
      });
    },

    swalToast: function (icon, title) {
      return Swal.fire({
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 3000,
        icon: icon,
        title: title,
      });
    },

    validateEmail: function (email) {
      if (!email) return false;
      return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(String(email));
    },
  };

  // --- Math Text Captcha Renderer ---
  window.renderMathCaptcha = function (container, num1, num2) {
    if (!container) return;
    container.textContent = (num1 || 0) + ' + ' + (num2 || 0) + ' =';
  };

  // --- Math Captcha Reload ---
  document.addEventListener('DOMContentLoaded', function () {
    try {
      var captchas = document.querySelectorAll('.math-captcha');
      captchas.forEach(function (container) {
        var btn = container.querySelector('.refresh-captcha');
        if (!btn) return;
        btn.addEventListener('click', function () {
          btn.disabled = true;
          var icon = btn.querySelector('i');
          if (icon) icon.className = 'bi bi-arrow-clockwise spinner';
          var eqEl = container.querySelector('.captcha-equation');
          if (eqEl) eqEl.classList.add('captcha-fading');
          fetch('/math-captcha')
            .then(function (r) { return r.json(); })
            .then(function (j) {
              setTimeout(function () {
                window.renderMathCaptcha(eqEl, j.num1, j.num2);
                if (eqEl) eqEl.classList.remove('captcha-fading');
              }, 300);
              var hidAnswer = container.querySelector('input[name="mathAnswer"]');
              if (hidAnswer && typeof j.answer !== 'undefined') hidAnswer.value = j.answer;
              var inp = container.querySelector('input[name="mathCaptcha"]');
              if (inp) inp.value = '';
            })
            .catch(function () { /* ignore */ })
            .finally(function () {
              btn.disabled = false;
              if (icon) icon.className = 'bi bi-arrow-clockwise';
            });
        });
      });
    } catch (e) { /* ignore */ }

    // --- Input sanitization ---
    try {
      var inputs = document.querySelectorAll(
        'input[type="email"], input[type="password"], input[name="otp"], ' +
        'input[id$="-otp"], input[name="confirmPassword"], input[name="mathCaptcha"], input[name="addressPostal"]'
      );
      inputs.forEach(function (el) {
        if (!el) return;
        var name = (el.name || el.id || '').toLowerCase();
        var maxLen = 256;
        if (el.type === 'email' || name.indexOf('email') !== -1) maxLen = 50;
        else if (el.type === 'password' || name.indexOf('password') !== -1) maxLen = 20;
        else if (name.indexOf('math') !== -1) maxLen = 2;
        else if (name.indexOf('otp') !== -1) maxLen = 6;
        else if (name.indexOf('postal') !== -1) maxLen = 4;

        if (!el.getAttribute('maxlength')) el.setAttribute('maxlength', String(maxLen));
      });
    } catch (e) { /* ignore */ }
  });

  // --- reCAPTCHA ---
  window._authRecaptchaWidgets = window._authRecaptchaWidgets || {};
  window.initRecaptcha = function () {
    try {
      if (!window.recaptchaSiteKey || typeof grecaptcha === 'undefined' || typeof grecaptcha.render !== 'function') return;
      ['register', 'login', 'reset', 'forgot'].forEach(function (k) {
        var elId = 'recaptcha-' + k;
        var el = document.getElementById(elId);
        if (!el) return;
        el.innerHTML = '';
        var wid = grecaptcha.render(elId, {
          sitekey: window.recaptchaSiteKey,
          theme: 'light',
          callback: function () {
            var tsEl = document.getElementById('recaptcha-ts-' + k);
            if (tsEl) tsEl.value = String(Date.now());
          },
        });
        window._authRecaptchaWidgets[k] = wid;
      });
    } catch (e) { /* ignore */ }
  };

  window.authRecaptchaGetResponse = function (name) {
    try {
      var wid = window._authRecaptchaWidgets[name];
      if (typeof wid !== 'undefined' && typeof grecaptcha.getResponse === 'function') return grecaptcha.getResponse(wid) || '';
      if (typeof grecaptcha.getResponse === 'function') return grecaptcha.getResponse() || '';
    } catch (e) { /* ignore */ }
    return '';
  };

  window.authRecaptchaReset = function (name) {
    try {
      var wid = window._authRecaptchaWidgets[name];
      if (typeof wid !== 'undefined' && typeof grecaptcha.reset === 'function') grecaptcha.reset(wid);
      else if (typeof grecaptcha.reset === 'function') grecaptcha.reset();
    } catch (e) { /* ignore */ }
  };
})();

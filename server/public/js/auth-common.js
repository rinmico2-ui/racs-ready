(function () {
  'use strict';

  var BRAND_CONFIRM_BG = 'linear-gradient(135deg, #2563eb, #0891b2)';
  var BRAND_CANCEL_BG = 'transparent';
  var BRAND_CANCEL_BORDER = '1.5px solid rgba(226,232,240,.6)';

  var _baseConfig = {
    customClass: {
      popup: 'calidro-swal-popup',
      htmlContainer: 'calidro-swal-html',
      confirmButton: 'calidro-swal-confirm',
      cancelButton: 'calidro-swal-cancel',
      title: 'calidro-swal-title',
      icon: 'calidro-swal-icon',
      actions: 'calidro-swal-actions',
      closeButton: 'calidro-swal-close',
    },
    buttonsStyling: true,
    showClass: { popup: 'swal2-show calidro-swal-enter' },
    hideClass: { popup: 'swal2-hide calidro-swal-exit' },
    showCloseButton: false,
    showConfirmButton: true,
    confirmButtonText: 'OK',
    confirmButtonColor: '',
    cancelButtonText: 'Cancel',
    backdrop: 'rgba(2,6,23,.55)',
    allowOutsideClick: true,
    allowEscapeKey: true,
    focusConfirm: true,
    grow: 'row',
    padding: '1.5em',
    width: '32em',
  };

  function _merge(target) {
    var result = {};
    for (var k in target) { if (target.hasOwnProperty(k)) result[k] = target[k]; }
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      for (var j in src) { if (src.hasOwnProperty(j)) result[j] = src[j]; }
    }
    return result;
  }

  function _brandHtml(title, text, iconHtml) {
    return (
      '<div class="calidro-swal-brand">' +
        '<div class="calidro-swal-logo">' +
          '<img src="/images/LOGO/RACS.png" alt="Calidro RACS" class="calidro-swal-logo-img" />' +
        '</div>' +
        '<div class="calidro-swal-title-wrap">' +
          '<h2 class="calidro-swal-heading">' + (title || '') + '</h2>' +
          (text ? '<p class="calidro-swal-text">' + text + '</p>' : '') +
        '</div>' +
      '</div>'
    );
  }

  window.authUtils = {
    swalError: function (title, text, opts) {
      opts = opts || {};
      return Swal.fire(_merge(_baseConfig, {
        html: _brandHtml(title || 'Something went wrong', text),
        iconHtml: '<div class="calidro-swal-icon-circle calidro-swal-icon-error"><i class="bi bi-x-lg"></i></div>',
        icon: 'error',
        iconColor: 'transparent',
        confirmButtonText: 'Understood',
        customClass: _merge(_baseConfig.customClass, {
          popup: 'calidro-swal-popup calidro-swal-popup--error',
          icon: 'calidro-swal-icon calidro-swal-icon--error',
        }),
        confirmButtonColor: '',
      })).then(function (res) {
        if (opts.reload) {
          setTimeout(function () { window.location.reload(); }, 200);
        }
        return res;
      });
    },

    swalSuccess: function (title, text) {
      return Swal.fire(_merge(_baseConfig, {
        html: _brandHtml(title || 'Success', text),
        iconHtml: '<div class="calidro-swal-icon-circle calidro-swal-icon-success"><i class="bi bi-check-lg"></i></div>',
        icon: 'success',
        iconColor: 'transparent',
        confirmButtonText: 'Great',
        customClass: _merge(_baseConfig.customClass, {
          popup: 'calidro-swal-popup calidro-swal-popup--success',
          icon: 'calidro-swal-icon calidro-swal-icon--success',
        }),
        confirmButtonColor: '',
      }));
    },

    swalToast: function (icon, title) {
      return Swal.fire(_merge(_baseConfig, {
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 3000,
        timerProgressBar: true,
        icon: icon,
        title: title,
        html: '',
        customClass: _merge(_baseConfig.customClass, {
          popup: 'calidro-swal-popup calidro-swal-popup--toast',
          confirmButton: 'calidro-swal-confirm d-none',
          title: 'calidro-swal-title calidro-swal-title--toast',
        }),
        didOpen: function (toastEl) {
          toastEl.addEventListener('mouseenter', Swal.stopTimer);
          toastEl.addEventListener('mouseleave', Swal.resumeTimer);
        },
      }));
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

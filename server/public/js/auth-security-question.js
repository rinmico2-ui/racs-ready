(function () {
  'use strict';
  var versions = new WeakMap();
  function input(form, name) { return form.querySelector('input[name="' + name + '"]'); }
  function purpose(form) {
    var id = form.id.toLowerCase();
    return id.includes('register') ? 'register' : id.includes('forgot') ? 'forgot' : id.includes('reset') ? 'reset' : 'login';
  }
  async function refresh(form) {
    if (!form) return false;
    var version = (versions.get(form) || 0) + 1;
    versions.set(form, version);
    var container = form.querySelector('.math-captcha');
    var proof = input(form, 'mathChallenge');
    if (proof) proof.value = '';
    var status = container && container.querySelector('[data-captcha-status]');
    if (!status && container) {
      status = document.createElement('div'); status.className = 'field-error';
      status.setAttribute('data-captcha-status', ''); status.setAttribute('role', 'alert'); container.appendChild(status);
    }
    if (status) status.textContent = '';
    try {
      var response = await fetch('/math-captcha?purpose=' + purpose(form), { credentials: 'same-origin', cache: 'no-store' });
      var data = await response.json().catch(function () { return {}; });
      if (versions.get(form) !== version) return false;
      if (!response.ok || !data.challenge || !Number.isInteger(data.num1) || !Number.isInteger(data.num2)) throw new Error('Unable to refresh the security question. Please try again shortly.');
      var equation = container && container.querySelector('.captcha-equation');
      if (equation) {
        if (typeof window.renderMathCaptcha === 'function') window.renderMathCaptcha(equation, data.num1, data.num2);
        else equation.textContent = data.num1 + ' + ' + data.num2 + ' =';
      }
      if (proof) proof.value = data.challenge;
      var answer = input(form, 'mathAnswer'), csrf = input(form, 'csrfToken'), entered = input(form, 'mathCaptcha');
      if (answer) answer.value = String(data.answer);
      if (csrf && data.csrfToken) csrf.value = data.csrfToken;
      if (entered) entered.value = '';
      return true;
    } catch (error) {
      if (versions.get(form) === version && status) status.textContent = error.message || 'Unable to refresh the security question.';
      return false;
    }
  }
  window.AuthSecurityQuestion = {
    token: function (form) { var proof = input(form, 'mathChallenge'); return proof ? proof.value : ''; },
    refresh: refresh,
  };
})();

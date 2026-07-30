(function () {
  'use strict';
  var root = document.getElementById('authPanelRoot') || document.getElementById('authWrapper');
  if (!root) return;

  function clearSensitive() {
    ['email','password','register-email','register-password','register-confirm','login-otp','login-math','register-math'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    var otpBlock = document.getElementById('otpBlock');
    if (otpBlock) otpBlock.classList.add('d-none');
  }

  clearSensitive();
  setTimeout(clearSensitive, 100);
  setTimeout(clearSensitive, 500);
  window.addEventListener('pageshow', function () { clearSensitive(); });
})();
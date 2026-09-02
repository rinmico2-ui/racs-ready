(function () {
  "use strict";
  var form = document.getElementById("accountActivationForm");
  if (!form) return;
  var password = document.getElementById("activationPassword");
  var confirm = document.getElementById("activationConfirm");
  var button = document.getElementById("activationSubmit");
  var alertBox = document.getElementById("activationAlert");
  var policy = /^(?=(?:.*[A-Z]){1})(?!.*[A-Z].*[A-Z])(?!.*!.*!)(?!.*@.*@)(?!.*#.*#)(?!.*\$.*\$)[A-Za-z0-9@!#$]{8,30}$/;

  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, "", window.location.pathname);
  }

  function show(message, type) {
    alertBox.textContent = message;
    alertBox.className = "invite-alert " + type;
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (!policy.test(password.value)) return show("Choose a password that follows all listed rules.", "error");
    if (password.value !== confirm.value) return show("The password confirmation does not match.", "error");
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Activating…';
    try {
      var response = await fetch("/api/auth/activate-invited-account", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: document.getElementById("activationToken").value,
          csrfToken: document.getElementById("activationCsrf").value,
          password: password.value,
        }),
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "Account activation failed.");
      show(data.message || "Account activated. Redirecting to sign in…", "success");
      window.setTimeout(function () { window.location.assign(data.redirect || "/login?activated=1"); }, 800);
    } catch (error) {
      show(error.message, "error");
      button.disabled = false;
      button.innerHTML = '<i class="bi bi-person-check me-1"></i> Verify email and activate';
    }
  });
})();

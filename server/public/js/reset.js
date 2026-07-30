document.addEventListener("DOMContentLoaded", function () {
  var form = document.getElementById("resetForm");
  var alertEl = document.getElementById("resetAlert");
  var btn = document.getElementById("resetBtn");
  if (!form) return;

  // Math captcha refresh
  var refreshBtn = document.querySelector(".refresh-captcha");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async function () {
      try {
        var res = await fetch("/math-captcha");
        var data = await res.json();
        var dice1El = document.querySelector('.dice-face[data-die="1"]');
        var dice2El = document.querySelector('.dice-face[data-die="2"]');
        if (dice1El && window.renderDice) window.renderDice(dice1El, data.dice1);
        if (dice2El && window.renderDice) window.renderDice(dice2El, data.dice2);
        var answerEl = document.querySelector("input[name='mathAnswer']");
        var d1El = document.querySelector("input[name='dice1']");
        var d2El = document.querySelector("input[name='dice2']");
        if (answerEl) answerEl.value = data.answer;
        if (d1El) d1El.value = data.dice1;
        if (d2El) d2El.value = data.dice2;
        var captchaInput = document.getElementById("reset-math");
        if (captchaInput) captchaInput.value = "";
      } catch (e) {
        console.error("Failed to refresh captcha", e);
      }
    });
  }

  // Password visibility toggles
  var toggle = document.getElementById("togglePasswordReset") || document.getElementById("togglePassword");
  var toggleConfirm = document.getElementById("toggleConfirmPasswordReset") || document.getElementById("toggleConfirmPasswordReg");
  function setupToggle(toggleEl, inputId) {
    if (!toggleEl) return;
    toggleEl.addEventListener("click", function () {
      var el = document.getElementById(inputId);
      if (!el) return;
      var type = el.getAttribute("type") === "password" ? "text" : "password";
      el.setAttribute("type", type);
      this.innerHTML = type === "password"
        ? '<i class="bi bi-eye"></i>'
        : '<i class="bi bi-eye-slash"></i>';
    });
  }
  setupToggle(toggle, "password");
  setupToggle(toggleConfirm, "confirmPassword");

  // Sanitize and validation
  var pwField = document.getElementById("password");
  var confField = document.getElementById("confirmPassword");
  var strengthBar = document.getElementById("pwStrengthBar");
  var strengthLabel = document.getElementById("pwStrengthLabel");
  var confirmFeedback = document.getElementById("confirmFeedback");

  try {
    function sanitize(el) {
      if (!el) return;
      el.addEventListener("input", function () {
        var v = String(this.value || "");
        v = v.replace(/[^A-Za-z0-9@!#$]/g, "");
        var seenSp = {};
        var outp = "";
        for (var j = 0; j < v.length; j++) {
          var ch = v[j];
          if (/[@!#$]/.test(ch)) {
            if (seenSp[ch]) continue;
            seenSp[ch] = true;
          }
          outp += ch;
        }
        v = outp;
        var seen = false;
        var out = "";
        for (var i = 0; i < v.length; i++) {
          var ch = v[i];
          if (ch >= "A" && ch <= "Z") {
            if (!seen) { out += ch; seen = true; }
          } else {
            out += ch;
          }
        }
        this.value = out.slice(0, 20);
      });
    }
    sanitize(pwField);
    sanitize(confField);

    var matchInd = document.getElementById("reset-confirm-check");
    var validInd = document.getElementById("reset-password-check");
    var suggestEl = document.getElementById("reset-password-suggestions");

    function calcStrength(pwd) {
      var score = 0;
      if (pwd.length >= 8) score++;
      if (pwd.length >= 12) score++;
      if (/[A-Z]/.test(pwd)) score++;
      if (/[0-9]/.test(pwd)) score++;
      if (/[@!#$]/.test(pwd)) score++;
      return Math.min(score, 4);
    }

    function updateStrength() {
      var pwd = pwField ? pwField.value : "";
      if (!strengthBar || !strengthLabel) return;
      if (pwd.length === 0) {
        strengthBar.style.width = "0%";
        strengthBar.style.background = "#e2e8f0";
        strengthLabel.textContent = "";
        return;
      }
      var score = calcStrength(pwd);
      var levels = [
        { width: "25%", color: "#dc3545", label: "Weak" },
        { width: "50%", color: "#fd7e14", label: "Fair" },
        { width: "75%", color: "#0d6efd", label: "Good" },
        { width: "100%", color: "#198754", label: "Strong" }
      ];
      var lvl = levels[Math.max(0, score - 1)] || levels[0];
      strengthBar.style.width = lvl.width;
      strengthBar.style.background = lvl.color;
      strengthLabel.textContent = lvl.label;
      strengthLabel.style.color = lvl.color;
    }

    function updateSuggest() {
      if (!suggestEl) return;
      var pwd = pwField ? pwField.value : "";
      var items = suggestEl.querySelectorAll("li[data-rule]");
      items.forEach(function (li) {
        var rule = li.getAttribute("data-rule");
        var met = false;
        if (rule === "letter") met = /[A-Z]/.test(pwd);
        else if (rule === "digitOrSpecial") met = /[0-9@!#$]/.test(pwd);
        else if (rule === "length") met = pwd.length >= 8;
        li.classList.toggle("met", met);
        var ico = li.querySelector("i");
        if (ico) {
          ico.className = met
            ? "bi bi-check-circle-fill me-1"
            : "bi bi-circle";
        }
      });
    }

    function updateBoth() {
      var pwd = pwField && pwField.value ? pwField.value : "";
      var conf = confField && confField.value ? confField.value : "";
      var ok = /^(?=(?:.*[A-Z]){1})(?=.*[0-9@!#$])(?!.*[A-Z].*[A-Z])(?!.*[!@#$].*[!@#$])[A-Za-z0-9@!#$]{8,20}$/.test(pwd);

      // Confirm icon
      if (matchInd) {
        if (conf.length === 0) {
          matchInd.classList.add("d-none");
        } else {
          matchInd.classList.remove("d-none");
          matchInd.innerHTML = (pwd === conf && ok)
            ? '<i class="bi bi-check-circle-fill" style="color:#198754;"></i>'
            : '<i class="bi bi-x-circle-fill" style="color:#dc3545;"></i>';
        }
      }

      // Password icon
      if (validInd) {
        if (pwd.length > 0) {
          validInd.classList.remove("d-none");
          validInd.innerHTML = (ok && (conf.length === 0 || pwd === conf))
            ? '<i class="bi bi-check-circle-fill" style="color:#198754;"></i>'
            : '<i class="bi bi-x-circle-fill" style="color:#dc3545;"></i>';
        } else {
          validInd.classList.add("d-none");
        }
      }

      // Confirm feedback text
      if (confirmFeedback) {
        if (conf.length === 0) {
          confirmFeedback.textContent = "";
        } else if (pwd === conf) {
          confirmFeedback.textContent = "Passwords match";
          confirmFeedback.style.color = "#198754";
        } else {
          confirmFeedback.textContent = "Passwords do not match";
          confirmFeedback.style.color = "#dc3545";
        }
      }

      updateStrength();
    }

    if (pwField && confField) {
      pwField.addEventListener("input", function () {
        updateBoth();
        updateSuggest();
      });
      confField.addEventListener("input", updateBoth);
      updateSuggest();
    }
  } catch (e) {
    console.error("Reset password input setup error", e);
  }

  // Field validation icons
  function setupFieldValidation(inputId, feedbackId) {
    var input = document.getElementById(inputId);
    var feedback = document.getElementById(feedbackId);
    if (!input) return;
    input.addEventListener("blur", function () {
      var val = (this.value || "").trim();
      var group = this.closest(".input-group");
      if (!group) return;
      var successIcon = group.querySelector(".success-icon");
      var errorIcon = group.querySelector(".error-icon");
      if (inputId === "email") {
        if (val && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
          if (successIcon) successIcon.classList.remove("d-none");
          if (errorIcon) errorIcon.classList.add("d-none");
          this.classList.add("success");
          this.classList.remove("error");
          if (feedback) feedback.textContent = "";
        } else if (val) {
          if (successIcon) successIcon.classList.add("d-none");
          if (errorIcon) errorIcon.classList.remove("d-none");
          this.classList.add("error");
          this.classList.remove("success");
          if (feedback) { feedback.textContent = "Enter a valid email address"; feedback.style.color = "#dc3545"; }
        }
      }
    });
    input.addEventListener("input", function () {
      var group = this.closest(".input-group");
      if (!group) return;
      var successIcon = group.querySelector(".success-icon");
      var errorIcon = group.querySelector(".error-icon");
      if (successIcon) successIcon.classList.add("d-none");
      if (errorIcon) errorIcon.classList.add("d-none");
      this.classList.remove("error", "success");
      if (feedback) feedback.textContent = "";
    });
  }
  setupFieldValidation("email", "emailFeedback");
  setupFieldValidation("reset-math", "captchaFeedback");

  // Form submission
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    if (alertEl) alertEl.classList.add("d-none");

    var formData = new FormData(form);
    var email = String(formData.get("email") || "").trim();
    var password = String(formData.get("password") || "");
    var confirm = String(formData.get("confirmPassword") || "");
    var mathCaptcha = String(formData.get("mathCaptcha") || "").trim();
    var mathAnswer = String(formData.get("mathAnswer") || "").trim();
    var csrfToken = String(formData.get("csrfToken") || "");
    var token = String(formData.get("token") || "");

    if (!email || !password || !confirm)
      return window.authUtils.swalError("Missing information", "Please fill in all required fields.");

    if (!mathCaptcha || mathCaptcha !== mathAnswer)
      return window.authUtils.swalError("Incorrect captcha", "Please solve the math problem correctly.");

    if (password.length < 8)
      return window.authUtils.swalError("Weak password", "Password must be at least 8 characters long.");

    if (password.length > 20)
      return window.authUtils.swalError("Invalid password", "Password cannot be longer than 20 characters.");

    if (!/^(?=(?:.*[A-Z]){1})(?!.*[A-Z].*[A-Z])(?!.*@.*@)[A-Za-z0-9@!#$]{8,20}$/.test(password))
      return window.authUtils.swalError("Invalid password", "Password must be 8–20 characters, letters/numbers and may include !,#,$; at most one '@', and exactly one uppercase letter.");

    if (password !== confirm)
      return window.authUtils.swalError("Passwords do not match", "Please ensure both passwords match.");

    btn.disabled = true;
    var prevText = btn.innerText;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Resetting...';

    try {
      var res = await fetch("/api/auth/reset-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, token, mathCaptcha, mathAnswer, csrfToken }),
      });

      var body = {};
      try { body = await res.json(); } catch (e) { body = {}; }

      if (res.status === 200) {
        // Show success state
        form.classList.add("d-none");
        var successEl = document.getElementById("resetSuccess");
        if (successEl) successEl.classList.remove("d-none");
        return;
      }

      var errMsg = body && (body.error || body.message) ? body.error || body.message : "Reset failed. Please check your input.";
      window.authUtils.swalError("Reset failed", errMsg);
    } catch (err) {
      console.error("Reset error", err);
      window.authUtils.swalError("Network error", "Unable to reach the server. Please try again later.");
    } finally {
      btn.disabled = false;
      btn.innerText = prevText || "Reset Password";
    }
  });
});

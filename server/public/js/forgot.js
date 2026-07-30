document.addEventListener("DOMContentLoaded", function () {
  var form = document.getElementById("forgotForm");
  var alertEl = document.getElementById("forgotAlert");
  var btn = document.getElementById("forgotBtn");
  var resendBtn = document.getElementById("resendBtn");
  var successEl = document.getElementById("forgotSuccess");
  var emailInput = document.getElementById("email");
  var mathInput = document.getElementById("forgot-math");
  var emailFeedback = document.getElementById("emailFeedback");
  var captchaFeedback = document.getElementById("captchaFeedback");

  if (!form || !btn) return;

  /* ---------- Inline validation helpers ---------- */
  function setFieldFeedback(input, feedbackEl, isValid, message) {
    var wrapper = input.closest(".forgot-field");
    var successIcon = wrapper.querySelector(".success-icon");
    var errorIcon = wrapper.querySelector(".error-icon");

    input.classList.remove("error", "success");
    if (successIcon) successIcon.classList.add("d-none");
    if (errorIcon) errorIcon.classList.add("d-none");
    if (feedbackEl) feedbackEl.textContent = "";
    if (feedbackEl) feedbackEl.className = "field-feedback";

    if (isValid === true) {
      input.classList.add("success");
      if (successIcon) successIcon.classList.remove("d-none");
    } else if (isValid === false) {
      input.classList.add("error");
      if (errorIcon) errorIcon.classList.remove("d-none");
      if (feedbackEl && message) {
        feedbackEl.textContent = message;
        feedbackEl.classList.add("error");
      }
    }
  }

  function validateEmailField() {
    var val = emailInput.value.trim();
    if (!val) {
      setFieldFeedback(emailInput, emailFeedback, null);
      return false;
    }
    if (val.length > 50) {
      setFieldFeedback(emailInput, emailFeedback, false, "Email is too long.");
      return false;
    }
    if (!window.authUtils.validateEmail(val)) {
      setFieldFeedback(emailInput, emailFeedback, false, "Enter a valid email address.");
      return false;
    }
    setFieldFeedback(emailInput, emailFeedback, true);
    return true;
  }

  function validateCaptchaField() {
    var val = mathInput.value.trim();
    if (!val || !/^[0-9]{1,2}$/.test(val)) {
      setFieldFeedback(mathInput, captchaFeedback, null);
      return false;
    }
    var hid = form.querySelector('input[name="mathAnswer"]');
    var answer = hid ? hid.value.trim() : "";
    if (val !== answer) {
      setFieldFeedback(mathInput, captchaFeedback, false, "Answer does not match.");
      return false;
    }
    setFieldFeedback(mathInput, captchaFeedback, true);
    return true;
  }

  /* ---------- Real-time validation ---------- */
  emailInput.addEventListener("blur", validateEmailField);
  emailInput.addEventListener("input", function () {
    if (this.classList.contains("error") || this.classList.contains("success")) {
      validateEmailField();
    }
  });

  mathInput.addEventListener("blur", validateCaptchaField);
  mathInput.addEventListener("input", function () {
    if (this.classList.contains("error") || this.classList.contains("success")) {
      validateCaptchaField();
    }
  });

  /* ---------- Cooldown timer ---------- */
  function startResendCooldown(button, duration) {
    var remaining = duration;
    button.disabled = true;
    var btnText = button.querySelector(".btn-text");
    function tick() {
      if (remaining <= 0) {
        button.disabled = false;
        if (btnText) btnText.textContent = "Send Reset Link";
        else button.innerText = "Send Reset Link";
      } else {
        if (btnText) btnText.textContent = "Resend in " + remaining + "s";
        else button.innerText = "Resend in " + remaining + "s";
        remaining -= 1;
        setTimeout(tick, 1000);
      }
    }
    tick();
  }

  /* ---------- Show success state ---------- */
  function showSuccessState() {
    form.classList.add("d-none");
    alertEl.classList.add("d-none");
    successEl.classList.remove("d-none");
    successEl.style.opacity = "0";
    successEl.style.transform = "translateY(20px)";
    requestAnimationFrame(function () {
      successEl.style.transition = "opacity 0.5s ease, transform 0.5s ease";
      successEl.style.opacity = "1";
      successEl.style.transform = "translateY(0)";
    });
  }

  /* ---------- Form submission ---------- */
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    alertEl.classList.add("d-none");
    alertEl.textContent = "";

    // Validate all fields
    var emailValid = validateEmailField();
    var captchaValid = validateCaptchaField();

    if (!emailValid) {
      emailInput.focus();
      return window.authUtils.swalError("Missing information", "Please enter a valid email address.");
    }
    if (!captchaValid) {
      mathInput.focus();
      return window.authUtils.swalError("Invalid captcha", "Please answer the math question correctly.");
    }

    // Get values
    var email = emailInput.value.trim();
    var csrfToken = (form.querySelector('input[name="csrfToken"]') || {}).value || "";
    var mathCaptcha = mathInput.value.trim();
    var mathAnswer = (form.querySelector('input[name="mathAnswer"]') || {}).value || "";

    // Loading state
    btn.disabled = true;
    var btnText = btn.querySelector(".btn-text");
    var btnIcon = btn.querySelector("i");
    if (btnIcon) btnIcon.className = "bi bi-arrow-repeat spinner";
    if (btnText) btnText.textContent = "Sending...";

    try {
      var res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email,
          csrfToken: csrfToken,
          mathCaptcha: mathCaptcha,
          mathAnswer: mathAnswer,
        }),
      });

      var body = await res.json();

      if (res.status === 429) {
        var retry = body && body.retryAfter ? body.retryAfter : null;
        var text = "Too many requests. Please wait a short while before retrying.";
        if (retry) text = "Too many requests. Please wait " + retry + " seconds and try again.";
        btn.disabled = false;
        if (btnIcon) btnIcon.className = "bi bi-send-fill";
        if (btnText) btnText.textContent = "Send Reset Link";
        window.authUtils.swalError("Too many requests", text);
        return;
      }

      if (res.status === 200) {
        showSuccessState();
        window.authUtils.swalSuccess("Request received", "If an account with that email exists, we have sent a password reset link.");
        startResendCooldown(resendBtn, 60);
      } else {
        var message = (body && body.error) || "Unable to process your request at this time.";
        btn.disabled = false;
        if (btnIcon) btnIcon.className = "bi bi-send-fill";
        if (btnText) btnText.textContent = "Send Reset Link";
        window.authUtils.swalError("Request failed", message);
      }
    } catch {
      btn.disabled = false;
      if (btnIcon) btnIcon.className = "bi bi-send-fill";
      if (btnText) btnText.textContent = "Send Reset Link";
      window.authUtils.swalError("Request failed", "Unable to process your request at this time. Please try again later.");
    }
  });
});

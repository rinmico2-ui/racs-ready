(function () {
  "use strict";

  function byId(id) {
    return document.getElementById(id);
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    var spinner = button.querySelector(".spinner-border");
    if (spinner) spinner.classList.toggle("d-none", !busy);
  }

  function showInlineError(element, message) {
    if (!element) return;
    element.textContent = message || "Something went wrong. Please try again.";
    element.classList.remove("d-none");
  }

  function clearInlineError(element) {
    if (!element) return;
    element.textContent = "";
    element.classList.add("d-none");
  }

  function showPageFeedback(type, message) {
    var element = byId("profileFeedback");
    if (!element) return;
    element.className = "alert profile-feedback alert-" + type + " mb-4";
    element.textContent = message;
    element.classList.remove("d-none");
    element.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function sendUpdate(url, payload) {
    var response = await fetch(url, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    var data = {};
    try {
      data = await response.json();
    } catch (error) {
      data = {};
    }
    if (!response.ok) {
      var requestError = new Error(data.error || "Unable to save your changes.");
      requestError.status = response.status;
      throw requestError;
    }
    return data;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var editForm = byId("editProfileForm");
    var editError = byId("editProfileError");
    var saveProfileButton = byId("saveProfileButton");
    var phoneInput = byId("adminPhone");
    var editModalElement = byId("editProfileModal");

    if (phoneInput) {
      phoneInput.addEventListener("input", function () {
        this.value = this.value.replace(/\D/g, "").slice(0, 15);
        this.setCustomValidity(/^\d{7,15}$/.test(this.value) ? "" : "Enter 7-15 digits.");
      });
    }

    if (editForm) {
      editForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        clearInlineError(editError);

        var firstName = byId("adminFirstName").value.trim().replace(/\s+/g, " ");
        var lastName = byId("adminLastName").value.trim().replace(/\s+/g, " ");
        var phone = phoneInput.value.trim();
        var namePattern = /^[A-Za-z\u00C0-\u024F\u1E00-\u1EFF.' -]+$/u;

        byId("adminFirstName").setCustomValidity(
          firstName.length <= 50 && namePattern.test(firstName) ? "" : "Enter a valid first name.",
        );
        byId("adminLastName").setCustomValidity(
          lastName.length <= 50 && namePattern.test(lastName) ? "" : "Enter a valid last name.",
        );
        phoneInput.setCustomValidity(/^\d{7,15}$/.test(phone) ? "" : "Enter 7-15 digits.");

        if (!editForm.checkValidity()) {
          editForm.classList.add("was-validated");
          editForm.reportValidity();
          return;
        }

        setBusy(saveProfileButton, true);
        try {
          var result = await sendUpdate("/api/users/me/profile", {
            firstName: firstName,
            lastName: lastName,
            phone: phone,
          });
          byId("profileFirstNameValue").textContent = result.user.firstName;
          byId("profileLastNameValue").textContent = result.user.lastName;
          byId("profilePhoneValue").textContent = result.user.phone;
          editForm.classList.remove("was-validated");
          if (window.bootstrap && editModalElement) {
            window.bootstrap.Modal.getOrCreateInstance(editModalElement).hide();
          }
          showPageFeedback("success", result.message || "Profile updated successfully.");
        } catch (error) {
          if (error.status === 401) {
            window.location.assign("/login");
            return;
          }
          showInlineError(editError, error.message);
        } finally {
          setBusy(saveProfileButton, false);
        }
      });
    }

    var passwordForm = byId("changePasswordForm");
    var passwordError = byId("changePasswordError");
    var passwordButton = byId("changePasswordButton");
    var passwordModalElement = byId("changePasswordModal");
    var newPassword = byId("newPassword");
    var confirmPassword = byId("confirmPassword");

    document.querySelectorAll("[data-password-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        var input = byId(button.getAttribute("data-password-toggle"));
        if (!input) return;
        var showing = input.type === "text";
        input.type = showing ? "password" : "text";
        button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
        var icon = button.querySelector("i");
        if (icon) icon.className = showing ? "bi bi-eye" : "bi bi-eye-slash";
      });
    });

    function validatePasswordConfirmation() {
      if (!confirmPassword || !newPassword) return;
      confirmPassword.setCustomValidity(
        confirmPassword.value === newPassword.value ? "" : "Passwords do not match.",
      );
    }
    if (newPassword) newPassword.addEventListener("input", validatePasswordConfirmation);
    if (confirmPassword) confirmPassword.addEventListener("input", validatePasswordConfirmation);

    if (passwordForm) {
      passwordForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        clearInlineError(passwordError);
        validatePasswordConfirmation();

        var currentValue = byId("currentPassword").value;
        var newValue = newPassword.value;
        var strongPassword =
          newValue.length >= 8 &&
          newValue.length <= 30 &&
          /[A-Z]/.test(newValue) &&
          /[a-z]/.test(newValue) &&
          /\d/.test(newValue) &&
          /[^A-Za-z0-9]/.test(newValue);
        newPassword.setCustomValidity(strongPassword ? "" : "Password does not meet the requirements.");

        if (!passwordForm.checkValidity()) {
          passwordForm.classList.add("was-validated");
          passwordForm.reportValidity();
          return;
        }

        setBusy(passwordButton, true);
        try {
          var result = await sendUpdate("/api/users/me/password", {
            currentPassword: currentValue,
            newPassword: newValue,
          });
          if (window.bootstrap && passwordModalElement) {
            window.bootstrap.Modal.getOrCreateInstance(passwordModalElement).hide();
          }
          showPageFeedback("success", result.message || "Password changed successfully. Please sign in again.");
          window.setTimeout(function () {
            window.location.assign("/login");
          }, 1400);
        } catch (error) {
          if (error.status === 401) {
            window.location.assign("/login");
            return;
          }
          showInlineError(passwordError, error.message);
        } finally {
          setBusy(passwordButton, false);
        }
      });
    }

    [editModalElement, passwordModalElement].forEach(function (modal) {
      if (!modal) return;
      modal.addEventListener("hidden.bs.modal", function () {
        var form = modal.querySelector("form");
        var errorBox = modal.querySelector(".alert-danger");
        if (form) form.classList.remove("was-validated");
        clearInlineError(errorBox);
        if (modal === passwordModalElement && passwordForm) {
          passwordForm.reset();
          document.querySelectorAll("[data-password-toggle]").forEach(function (button) {
            var input = byId(button.getAttribute("data-password-toggle"));
            if (input) input.type = "password";
            var icon = button.querySelector("i");
            if (icon) icon.className = "bi bi-eye";
          });
        }
      });
    });
  });
})();

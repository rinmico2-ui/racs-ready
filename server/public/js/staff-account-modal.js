(function () {
  "use strict";
  const modal = document.getElementById("addStaffModal");
  if (!modal) return;
  document.body.appendChild(modal);
  const el = id => modal.querySelector("#" + id);
  let step = 1, busy = false, advancing = false, created = false, userId = "", emailSequence = 0, locationSequence = 0;

  async function requestJson(url, options = {}) {
    const saving = options.method === "POST";
    let response;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        response = await fetch(url, { credentials: "same-origin", ...options, signal: controller.signal });
      } finally { clearTimeout(timeout); }
    } catch (_) {
      throw new Error(saving
        ? "The server did not confirm the result. Check the staff list before trying again."
        : "Could not reach the server. Check your connection and try again.");
    }
    if (response.status === 401) throw new Error("Your sign-in has expired. Sign in again before adding staff.");
    let data;
    try { data = await response.json(); } catch (_) {
      throw new Error(saving
        ? "The server did not confirm the result. Check the staff list before trying again."
        : "Could not check the email. Refresh the page and try again.");
    }
    if (!response.ok) throw new Error(data.error || "Could not complete this action. Refresh the page and try again.");
    return data;
  }

  function showResult(text, type = "") {
    el("wizResult").textContent = text;
    el("wizResult").className = "staff-setup-result " + type;
  }
  function setRole(role) {
    el("wizRole").value = role === "secretary" ? "secretary" : "technician";
    modal.querySelectorAll(".role-option").forEach(button => {
      const selected = button.dataset.role === el("wizRole").value;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    el("wizTechFields").style.display = el("wizRole").value === "technician" ? "" : "none";
  }
  function ui() {
    modal.querySelectorAll(".wizard-step").forEach(item => {
      const value = Number(item.dataset.step);
      item.classList.toggle("active", value === step);
      item.classList.toggle("completed", value < step);
      if (value === step) item.setAttribute("aria-current", "step"); else item.removeAttribute("aria-current");
    });
    modal.querySelectorAll(".wizard-panel").forEach(item => item.classList.toggle("active", item.id === "wizardPanel" + step));
    el("wizBackBtn").style.display = !created && step > 1 ? "" : "none";
    el("wizNextBtn").style.display = !created && step < 3 ? "" : "none";
    el("wizCreateBtn").style.display = !created && step === 3 ? "" : "none";
    el("wizDoneBtn").classList.toggle("d-none", !created);
    el("wizResendBtn").classList.toggle("d-none", !created);
    el("wizCreateBtn").textContent = busy ? "Creating..." : "Create Account";
    modal.querySelectorAll("input, button").forEach(input => { input.disabled = busy || (created && !["wizDoneBtn", "wizResendBtn"].includes(input.id) && !input.hasAttribute("data-bs-dismiss")); });
    if (!busy && !created) el("wizBtnUseLocation").textContent = "Use GPS";
    el("wizNextBtn").disabled = busy || advancing;
  }
  function error(field, text) {
    el(field + "Error").textContent = text;
    el(field).classList.toggle("is-invalid", Boolean(text));
    el(field).setAttribute("aria-invalid", String(Boolean(text)));
  }
  function validateAccount() {
    const email = el("wizEmail");
    const valid = email.value.trim() && email.validity.valid && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim());
    error("wizEmail", valid ? "" : "Enter a valid email address.");
    if (!valid) email.focus();
    return Boolean(valid);
  }
  function validateDetails() {
    const first = el("wizFirst").value.trim(), last = el("wizLast").value.trim();
    const phone = el("wizPhone").value.replace(/[\s()+-]/g, "");
    error("wizFirst", first && first.length <= 100 ? "" : "Enter a first name within 100 characters.");
    error("wizLast", last && last.length <= 100 ? "" : "Enter a last name within 100 characters.");
    error("wizPhone", /^\d{10,15}$/.test(phone) ? "" : "Enter a phone number with 10 to 15 digits.");
    const invalid = ["wizFirst", "wizLast", "wizPhone"].find(id => el(id).classList.contains("is-invalid"));
    if (invalid) el(invalid).focus();
    return !invalid;
  }
  async function checkEmail() {
    if (!validateAccount()) return false;
    const value = el("wizEmail").value.trim(), sequence = ++emailSequence;
    el("wizEmailHint").textContent = "Checking whether the email is already used...";
    try {
      const data = await requestJson("/api/admin/staff/check-email?email=" + encodeURIComponent(value), { cache: "no-store" });
      if (sequence !== emailSequence || value !== el("wizEmail").value.trim()) return false;
      error("wizEmail", data.available ? "" : "This email is already used. Enter a different email.");
      el("wizEmailHint").textContent = data.available ? "This email is not used in the system. The staff member still needs to confirm it through the setup link." : "Use an email that is not already linked to another account.";
      return data.available === true;
    } catch (err) {
      if (sequence === emailSequence) error("wizEmail", err.message);
      return false;
    }
  }
  function confirm() {
    const first = el("wizFirst").value.trim(), last = el("wizLast").value.trim(), role = el("wizRole").value;
    el("confirmName").textContent = first + " " + last;
    el("confirmRole").textContent = role === "technician" ? "Technician" : "Secretary";
    el("confirmEmail").textContent = el("wizEmail").value.trim();
    el("confirmPhone").textContent = el("wizPhone").value.trim();
    el("confirmLocation").textContent = role === "technician" ? el("wizLocation").value.trim() || "Not specified" : "Not needed";
    el("confirmAvatar").textContent = first[0]?.toUpperCase() || "S";
    el("confirmAvatar").style.background = role === "technician" ? "#2563eb" : "#db2777";
    el("confirmNote").textContent = (role === "technician" ? "The technician will be added to the roster. " : "The secretary will receive an office staff account. ") + "They must open the setup email and choose a password before signing in.";
  }
  function describeInvitation(invitation, prefix) {
    if (invitation.delivery === "failed") return showResult(prefix + " The setup email could not be sent. Check the email settings and try again after one minute.", "warning");
    showResult(prefix + (invitation.delivery === "queued" ? " The setup email is queued for sending to " : " The setup email was accepted for sending to ") + invitation.email + ". They must open the link and choose their password. Ask them to check their inbox and spam folder.");
  }
  async function next() {
    if (busy || created || advancing) return;
    if (step === 1) {
      advancing = true; ui();
      const valid = await checkEmail();
      advancing = false;
      if (!valid) { ui(); return; }
    } else if (!validateDetails()) return;
    step = Math.min(3, step + 1);
    if (step === 3) confirm();
    ui();
    modal.querySelector(".modal-body").scrollTop = 0;
    if (step === 2) el("wizFirst").focus();
  }
  async function resend(id, button) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const data = await requestJson("/api/admin/staff/" + encodeURIComponent(id) + "/account-invitation", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (button.id === "wizResendBtn") describeInvitation(data.invitation, "Account created and waiting for email confirmation.");
      else if (data.invitation.delivery === "failed") window.notify?.error("The setup email could not be sent. Check email settings and try again after one minute.");
      else window.notify?.success("Setup email " + (data.invitation.delivery === "queued" ? "queued" : "accepted for sending") + " to " + data.invitation.email);
    } catch (err) {
      if (button.id === "wizResendBtn") showResult(err.message, "error"); else window.notify?.error(err.message);
    } finally { button.disabled = false; }
  }

  modal.addEventListener("show.bs.modal", event => {
    step = 1; created = false; userId = ""; emailSequence++; locationSequence++;
    modal.querySelectorAll("input:not(#wizRole)").forEach(input => { input.value = ""; input.classList.remove("is-invalid"); input.removeAttribute("aria-invalid"); });
    modal.querySelectorAll(".wiz-error").forEach(item => { item.textContent = ""; });
    el("wizEmailHint").textContent = "Email access is confirmed through the setup link.";
    el("wizResult").classList.add("d-none");
    setRole(event.relatedTarget?.dataset.staffRole || modal.dataset.defaultRole); ui();
  });
  modal.addEventListener("shown.bs.modal", () => el("wizEmail").focus());
  modal.addEventListener("hide.bs.modal", event => { if (busy || advancing) event.preventDefault(); });
  modal.addEventListener("hidden.bs.modal", () => { emailSequence++; locationSequence++; });
  el("wizEmail").addEventListener("input", () => { emailSequence++;error("wizEmail", "");el("wizEmailHint").textContent = "Email access is confirmed through the setup link."; });
  el("wizEmail").addEventListener("blur", () => { if (!busy && !created && !advancing && step === 1 && el("wizEmail").value.trim()) checkEmail(); });
  modal.querySelectorAll(".role-option").forEach(button => button.addEventListener("click", () => { if (!busy && !created) setRole(button.dataset.role); }));
  el("wizNextBtn").addEventListener("click", next);
  el("wizBackBtn").addEventListener("click", () => { if (!busy && !advancing && !created) { step = Math.max(1, step - 1); ui(); } });
  el("wizCreateBtn").addEventListener("click", async () => {
    if (busy || created || step !== 3) return;
    if (!validateAccount()) { step = 1; ui(); el("wizEmail").focus(); return; }
    if (!validateDetails()) { step = 2; ui(); modal.querySelector(".is-invalid")?.focus(); return; }
    const payload = { role: el("wizRole").value, firstName: el("wizFirst").value.trim(), lastName: el("wizLast").value.trim(), email: el("wizEmail").value.trim(), phone: el("wizPhone").value.trim() };
    if (payload.role === "technician") {
      payload.locationText = el("wizLocation").value.trim();
      if (el("wizLocationGeo").value) payload.location = JSON.parse(el("wizLocationGeo").value);
    }
    busy = true; emailSequence++; locationSequence++; ui();
    showResult("Creating the staff account...");
    try {
      const data = await requestJson("/api/admin/staff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!data.user?.id || !data.invitation) throw new Error("The server did not confirm the result. Check the staff list before trying again.");
      created = true; userId = data.user.id;
      describeInvitation(data.invitation, "Staff account created.");
      document.dispatchEvent(new CustomEvent("staff:created", { detail: { role: payload.role } }));
    } catch (err) { showResult(err.message, "error"); }
    finally { busy = false; ui(); }
  });
  el("wizResendBtn").addEventListener("click", async () => {
    if (busy || !created) return;
    const button = el("wizResendBtn");
    if (button.disabled) return;
    busy = true;
    // Keep the result in this modal while resending.
    modal.querySelectorAll("[data-bs-dismiss]").forEach(item => { item.disabled = true; });
    await resend(userId, button);
    busy = false; ui();
  });
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-staff-invite]");
    if (button) resend(button.dataset.staffInvite, button);
  });
  el("wizLocation").addEventListener("input", () => { locationSequence++; el("wizLocationGeo").value = ""; el("wizBtnUseLocation").disabled = false; el("wizBtnUseLocation").textContent = "Use GPS"; });
  el("wizBtnUseLocation").addEventListener("click", () => {
    if (!navigator.geolocation) return showResult("Your browser cannot find your location. Enter the work address instead.", "warning");
    const sequence = ++locationSequence;
    el("wizBtnUseLocation").disabled = true; el("wizBtnUseLocation").textContent = "Locating...";
    navigator.geolocation.getCurrentPosition(position => {
      if (sequence !== locationSequence || busy || created) return;
      el("wizLocationGeo").value = JSON.stringify({ type: "Point", coordinates: [position.coords.longitude, position.coords.latitude] });
      el("wizLocation").value = position.coords.latitude.toFixed(6) + ", " + position.coords.longitude.toFixed(6);
      el("wizBtnUseLocation").disabled = false; el("wizBtnUseLocation").textContent = "Use GPS";
    }, () => {
      if (sequence !== locationSequence || busy || created) return;
      el("wizBtnUseLocation").disabled = false; el("wizBtnUseLocation").textContent = "Use GPS";
      showResult("Location could not be found. Enter the work address instead.", "warning");
    }, { enableHighAccuracy: true, timeout: 10000 });
  });
  modal.addEventListener("keydown", event => { if (event.key === "Enter" && event.target.matches("input:not([type=hidden])")) { event.preventDefault(); if (step < 3) next(); } });
  if (new URLSearchParams(location.search).get("add") === "1" && window.bootstrap) bootstrap.Modal.getOrCreateInstance(modal).show();
})();

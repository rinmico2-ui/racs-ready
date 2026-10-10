(function () {
  "use strict";
  const form = document.getElementById("techForm");
  if (!form) return;
  const byId = id => document.getElementById(id);
  const button = byId("btnSubmit");
  const email = byId("techEmail");
  const name = byId("techName");
  const phone = byId("techPhone");
  const help = byId("techEmailHelp");
  const edit = form.dataset.edit === "true";
  let techId = form.dataset.techId;
  let busy = false;
  let created = false;
  let emailSequence = 0;
  const originalValues = () => JSON.stringify(Array.from(form.querySelectorAll("input")).map(input => input.value));
  let savedValues = originalValues();

  function message(text, type = "danger") {
    const box = byId("techFormMessage");
    box.className = "alert alert-" + type;
    box.textContent = text;
  }

  function validate() {
    name.setCustomValidity(name.value.trim().split(/\s+/).length < 2 ? "Enter the first and last name." : "");
    phone.setCustomValidity(/^\d{10,15}$/.test(phone.value.replace(/[\s()+-]/g, "")) ? "" : "Enter a valid phone number.");
    form.classList.add("was-validated");
    if (!form.checkValidity()) {
      form.querySelector(":invalid")?.focus();
      return false;
    }
    return true;
  }

  email.addEventListener("input", () => {
    emailSequence++;
    email.setCustomValidity("");
    help.textContent = edit ? "If this email is unconfirmed, correcting it sends a new setup link and cancels the old one." : "Use an email the technician can open. We confirm it through the setup link.";
  });
  email.addEventListener("blur", async () => {
    if (form.dataset.emailLocked === "true" || edit || created || !email.value.trim() || !email.validity.valid) return;
    const current = ++emailSequence;
    const value = email.value.trim();
    help.textContent = "Checking whether this email is already used...";
    try {
      const response = await fetch("/api/admin/technicians/check-email?email=" + encodeURIComponent(value), { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (current !== emailSequence) return;
      if (!response.ok) throw new Error(data.error || "Could not check the email.");
      email.setCustomValidity(data.available ? "" : "This email is already in use.");
      help.textContent = data.available ? "This email is not used in the system. The technician still needs to confirm it through the setup email." : "This email is already used. Enter a different email.";
      if (!data.available) form.classList.add("was-validated");
    } catch (error) {
      if (current === emailSequence) help.textContent = "The email will be checked again when you save.";
    }
  });
  name.addEventListener("input", () => name.setCustomValidity(""));
  phone.addEventListener("input", () => phone.setCustomValidity(""));

  function invitationMessage(invitation, prefix) {
    if (invitation.delivery === "failed") {
      message(prefix + " The setup email could not be sent. Check the email settings, then try sending it again after one minute.", "warning");
    } else {
      message(prefix + (invitation.delivery === "queued" ? " The setup email is queued for sending to " : " The setup email was accepted for sending to ") + invitation.email + ". The technician must open the link and choose a password before signing in. Ask them to check their inbox and spam folder.", "success");
    }
  }

  async function sendInvite(sourceButton) {
    if (busy || !techId) return;
    if (edit && originalValues() !== savedValues) return message("Save your changes before sending the setup email.", "warning");
    busy = true;
    sourceButton.disabled = true;
    button.disabled = true;
    try {
      const response = await fetch("/api/admin/technicians/" + encodeURIComponent(techId) + "/account-invitation", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not send the setup email.");
      invitationMessage(data.invitation, "Account setup is waiting for email confirmation.");
      byId("techAccountHelp").textContent = "Waiting for email confirmation. The technician must open the setup email and choose a password before signing in.";
    } catch (error) { message(error.message); }
    finally { busy = false; sourceButton.disabled = false; button.disabled = created; }
  }

  byId("techSendInvite")?.addEventListener("click", event => sendInvite(event.currentTarget));
  byId("techRetryInvite").addEventListener("click", event => sendInvite(event.currentTarget));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || created || !validate()) return;
    busy = true;
    emailSequence++; // A late availability response must not override this save.
    button.disabled = true;
    const inviteButton = byId("techSendInvite");
    if (inviteButton) inviteButton.disabled = true;
    button.textContent = "Saving...";
    const payload = { name: name.value.trim(), userEmail: email.value.trim(), phone: phone.value.trim(), locationText: byId("techLocation").value.trim() };
    form.querySelectorAll("input").forEach(input => { input.disabled = true; });
    try {
      const response = await fetch(edit ? "/api/admin/technicians/" + encodeURIComponent(techId) : "/api/admin/technicians", { method: edit ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save the technician.");
      if (edit) {
        savedValues = originalValues();
        if (data.invitation) invitationMessage(data.invitation, "Technician details saved. The old setup link was cancelled.");
        else message("Technician details saved.", "success");
      } else {
        created = true;
        techId = data.technician._id;
        byId("techCreatedActions").classList.remove("d-none");
        byId("techAccountHelp").textContent = "Waiting for email confirmation. The technician will choose their own password using the setup link.";
        invitationMessage(data.invitation, "Technician and sign-in account created.");
      }
    } catch (error) { message(error.message); }
    finally {
      busy = false;
      button.disabled = created;
      button.textContent = created ? "Technician added" : edit ? "Save Changes" : "Add Technician";
      if (inviteButton) inviteButton.disabled = false;
      form.querySelectorAll("input").forEach(input => { input.disabled = created; });
    }
  });
})();

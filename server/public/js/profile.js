// Customer profile editor. The server is the source of truth for account data.

(function () {
  function qs(id) {
    return document.getElementById(id);
  }
  var editBtn = qs("editProfileBtn");
  var viewCard = qs("profileView");
  var editForm = qs("profileEditForm");
  var form = qs("customerProfileForm");
  var cancelBtn = qs("cancelProfileBtn");
  var saveBtn = qs("saveProfileBtn");
  var alertEl = qs("profileAlert");
  var firstInput = qs("profileFirstName");
  var lastInput = qs("profileLastName");
  var namePolicyHint = qs("profileNamePolicy");
  var saving = false;
  if (!editBtn || !editForm || !form) return;

  [qs("profilePhone"), qs("profile-addressPostal")].forEach(function (input) {
    if (input) input.addEventListener("input", function () {
      this.value = this.value.replace(/\D/g, "");
    });
  });
  ["Province", "City", "Barangay"].forEach(function (part) {
    var select = qs("profile-address" + part);
    if (!select) return;
    select.addEventListener("change", function (event) {
      if (!event.isTrusted) return; // Keep saved names during the PSGC initial load.
      delete select.dataset.selected;
      if (part === "Province") {
        delete qs("profile-addressCity").dataset.selected;
        delete qs("profile-addressBarangay").dataset.selected;
      } else if (part === "City") {
        delete qs("profile-addressBarangay").dataset.selected;
      }
    });
  });

  function showAlert(type, msg) {
    if (!alertEl) return;
    alertEl.className =
      "alert alert-" + (type === "error" ? "danger" : "success");
    alertEl.textContent = msg;
    alertEl.classList.remove("d-none");
    alertEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  editBtn.addEventListener("click", function () {
    viewCard.classList.add("d-none");
    editForm.classList.remove("d-none");
    alertEl && alertEl.classList.add("d-none");
    editForm.scrollIntoView({ behavior: "smooth", block: "start" });
    var firstEditable = firstInput && !firstInput.readOnly ? firstInput : qs("profilePhone");
    firstEditable && firstEditable.focus({ preventScroll: true });
  });

  // rating buttons on profile page
  document.body.addEventListener('click', function(e){
    if(e.target.matches('.rate-purchase')){
      const id = e.target.dataset.id;
      const score = prompt('Rate this order (1-5)');
      const num = Number(score);
      if(!num || num<1||num>5) return;
      fetch(`/api/rating/inventory/${encodeURIComponent(id)}`,{
         method:'POST', headers:{'Content-Type':'application/json'},
         body: JSON.stringify({score:num})
      }).then(r=>r.json()).then(d=>{ if(d.rating!==undefined) location.reload(); });
    }
    if(e.target.matches('.rate-booking')){
      const id = e.target.dataset.id;
      const score = prompt('Rate this service (1-5)');
      const num = Number(score);
      if(!num||num<1||num>5) return;
      const comment = prompt('Any comment?');
      fetch(`/api/appointments/${encodeURIComponent(id)}/rate`,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body: JSON.stringify({score:num,comment})
      }).then(r=>r.ok?location.reload():null);
    }
  });

  cancelBtn.addEventListener("click", function () {
    window.location.reload(); // Discard unsaved fields and restore server data.
  });

  function selectedName(id) {
    var select = qs(id);
    if (!select) return "";
    if (select.value) return (select.selectedOptions[0].textContent || "").trim();
    return (select.dataset.selected || "").trim();
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (saving) return;
    var firstName = firstInput.value.trim().replace(/\s+/g, " ");
    var lastName = lastInput.value.trim().replace(/\s+/g, " ");
    var phoneInput = qs("profilePhone");
    var phone = phoneInput.value.trim();
    var postalInput = qs("profile-addressPostal");
    var postalCode = postalInput.value.trim();
    var namePattern = /^[A-Za-z\u00C0-\u024F\u1E00-\u1EFF.' -]+$/u;
    if (!namePattern.test(firstName) || firstName.length > 50) {
      showAlert("error", "Enter a valid first name.");
      firstInput.focus();
      return;
    }
    if (!namePattern.test(lastName) || lastName.length > 50) {
      showAlert("error", "Enter a valid last name.");
      lastInput.focus();
      return;
    }
    if (!/^\d{7,15}$/.test(phone)) {
      showAlert("error", "Enter a phone number with 7 to 15 digits.");
      phoneInput.focus();
      return;
    }
    if (postalCode && !/^\d{4}$/.test(postalCode)) {
      showAlert("error", "Enter a 4-digit ZIP code.");
      postalInput.focus();
      return;
    }

    var province = selectedName("profile-addressProvince");
    var city = selectedName("profile-addressCity");
    var barangay = selectedName("profile-addressBarangay");
    var provinceSelect = qs("profile-addressProvince");
    var citySelect = qs("profile-addressCity");
    if (provinceSelect.value && !citySelect.value) {
      showAlert("error", "Choose your city or municipality.");
      citySelect.focus();
      return;
    }
    if (city && !province || barangay && !city) {
      showAlert("error", "Check your address selections.");
      provinceSelect.focus();
      return;
    }

    saving = true;
    saveBtn.disabled = true;
    saveBtn.setAttribute("aria-busy", "true");
    saveBtn.textContent = "Saving...";
    try {
      var response = await fetch("/api/users/me/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          firstName: firstName,
          lastName: lastName,
          phone: phone,
          address: { province: province, city: city, barangay: barangay, postalCode: postalCode }
        })
      });
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (result.nameChangePolicy && result.user) {
          firstInput.value = result.user.firstName;
          lastInput.value = result.user.lastName;
          firstInput.readOnly = lastInput.readOnly = !result.nameChangePolicy.canChangeName;
          if (namePolicyHint) {
            var nextDate = result.nameChangePolicy.nextNameChangeAt;
            namePolicyHint.dataset.nextChangeAt = nextDate || "";
            namePolicyHint.textContent = result.nameChangePolicy.canChangeName
              ? "You can change your name once every " + result.nameChangePolicy.cooldownDays + " days. Check the spelling before saving."
              : "Your next name change is available on " + new Date(nextDate).toLocaleString("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }) + " (Philippine time). You can still update your phone and address.";
          }
        }
        throw new Error(result.error || "Your changes could not be saved. Please try again.");
      }
      try { localStorage.removeItem("profile_ui_overrides"); } catch (storageError) {}
      showAlert("success", "Profile saved. Updating your page...");
      window.setTimeout(function () { window.location.reload(); }, 700);
    } catch (error) {
      showAlert("error", error.message || "Your changes could not be saved. Please try again.");
    } finally {
      saving = false;
      saveBtn.disabled = false;
      saveBtn.removeAttribute("aria-busy");
      saveBtn.innerHTML = '<i class="bi bi-check-lg"></i> Save Changes';
    }
  });
})();

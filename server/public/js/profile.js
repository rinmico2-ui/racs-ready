// Client-only profile UI: local edits only (no backend requests)
// - persists edits in localStorage under 'profile_ui_overrides' so changes survive reload
// - updates DOM and avatar initial live

(function () {
  function qs(id) {
    return document.getElementById(id);
  }
  var editBtn = qs("editProfileBtn");
  var viewCard = qs("profileView");
  var editForm = qs("profileEditForm");
  var cancelBtn = qs("cancelProfileBtn");
  var saveBtn = qs("saveProfileBtn");
  var alertEl = qs("profileAlert");
  var firstInput = qs("profileFirstName");
  var lastInput = qs("profileLastName");

  // first/last name are not editable; skip sanitizer and storage
  // (they remain read-only in the form)

  // Phone sanitizer: digits only (no arbitrary length limit)
  function attachPhoneSanitizer(el) {
    if (!el) return;
    el.addEventListener("input", function () {
      var v = String(this.value || "");
      this.value = v.replace(/\D+/g, "");
    });
  }
  attachPhoneSanitizer(qs("profilePhone"));

  // Postal code sanitizer: digits only (no length cap)
  function attachPostalSanitizer(el) {
    if (!el) return;
    el.addEventListener("input", function () {
      var v = String(this.value || "");
      this.value = v.replace(/\D+/g, "");
    });
  }
  attachPostalSanitizer(qs("profile-addressPostal"));

  var displayFirst = qs("displayFirstName");
  var displayLast = qs("displayLastName");
  var displayPhone = qs("displayPhone");
  var displayProvince = qs("displayProvince");
  var displayCity = qs("displayCity");
  var displayBarangay = qs("displayBarangay");
  var displayPostal = qs("displayPostal");
  var displayName = qs("profileDisplayName");
  var avatar = qs("profileAvatar");

  if (!editBtn || !editForm) return; // page doesn't include editable area

  function showAlert(type, msg) {
    if (!alertEl) return;
    alertEl.className =
      "alert alert-" + (type === "error" ? "danger" : "success");
    alertEl.textContent = msg;
    alertEl.classList.remove("d-none");
    setTimeout(function () {
      alertEl.classList.add("d-none");
    }, 4000);
  }

  function getOverrides() {
    try {
      return JSON.parse(localStorage.getItem("profile_ui_overrides") || "{}");
    } catch (e) {
      return {};
    }
  }
  function setOverrides(obj) {
    try {
      localStorage.setItem("profile_ui_overrides", JSON.stringify(obj || {}));
    } catch (e) {}
  }

  function applyOverridesToView() {
    var o = getOverrides();
    if (!displayFirst || !displayLast) return;
    function setText(el, val) {
      if (!el) return;
      if ("value" in el) el.value = val;
      else el.textContent = val;
    }
    if (o.firstName) setText(displayFirst, o.firstName);
    if (o.lastName) setText(displayLast, o.lastName);
    if (o.email) setText(qs("displayEmail"), o.email);
    if (o.phone) setText(displayPhone, o.phone);
    if (o.province) setText(displayProvince, o.province);
    if (o.city) setText(displayCity, o.city);
    if (o.barangay) setText(displayBarangay, o.barangay);
    if (o.postalCode) setText(displayPostal, o.postalCode);

    // update display name and avatar initial based on names
    var full = ((o.firstName || "") + " " + (o.lastName || "")).trim();
    if (full) displayName.textContent = full;
    var initial =
      o.firstName || o.lastName
        ? (o.firstName || o.lastName).charAt(0).toUpperCase()
        : (displayName &&
            displayName.textContent &&
            displayName.textContent.charAt(0)) ||
          "A";
    if (avatar) avatar.textContent = initial;
  }

  // Populate edit form from displayed values (server-rendered or overrides)
  function populateForm() {
    var o = getOverrides();
    function getDisplay(el) {
      if (!el) return "";
      return "value" in el ? el.value : el.textContent;
    }
    if (firstInput)
      firstInput.value = o.firstName || getDisplay(displayFirst) || "";
    if (lastInput)
      lastInput.value = o.lastName || getDisplay(displayLast) || "";

    var phoneEl = qs("profilePhone");
    var provEl = qs("profile-addressProvince");
    var cityEl = qs("profile-addressCity");
    var barangayEl = qs("profile-addressBarangay");
    var postalEl = qs("profile-addressPostal");

    if (phoneEl) phoneEl.value = o.phone || getDisplay(displayPhone) || "";
    if (provEl && o.province) provEl.setAttribute("data-selected", o.province);
    if (cityEl && o.city) cityEl.setAttribute("data-selected", o.city);
    if (barangayEl && o.barangay)
      barangayEl.setAttribute("data-selected", o.barangay);
    if (postalEl)
      postalEl.value = o.postalCode || getDisplay(displayPostal) || "";
  }

  editBtn.addEventListener("click", function () {
    populateForm();
    viewCard && viewCard.classList.add("d-none");
    editForm && editForm.classList.remove("d-none");
    firstInput && firstInput.focus();
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
    editForm && editForm.classList.add("d-none");
    viewCard && viewCard.classList.remove("d-none");
  });

  saveBtn.addEventListener("click", function () {
    // names are readonly; do not update them from the edit form
    var email = ((qs("profileEmail") && qs("profileEmail").value) || "").trim();
    var phone = ((qs("profilePhone") && qs("profilePhone").value) || "").trim();
    var province =
      (qs("profile-addressProvince") &&
        (qs("profile-addressProvince").selectedOptions[0] || {}).textContent) ||
      "";
    var city =
      (qs("profile-addressCity") &&
        (qs("profile-addressCity").selectedOptions[0] || {}).textContent) ||
      "";
    var barangay =
      (qs("profile-addressBarangay") &&
        (qs("profile-addressBarangay").selectedOptions[0] || {}).textContent) ||
      "";
    var postal = (
      (qs("profile-addressPostal") && qs("profile-addressPostal").value) ||
      ""
    ).trim();

    // basic validation
    if (phone && !/^\d{10,11}$/.test(phone))
      return showAlert("error", "Phone must be 10 or 11 digits");

    // save to localStorage (UI-only); do not store names since they are readonly
    var o = getOverrides();
    if (email) o.email = email;
    else delete o.email;
    if (phone) o.phone = phone;
    else delete o.phone;
    if (province) o.province = province;
    else delete o.province;
    if (city) o.city = city;
    else delete o.city;
    if (barangay) o.barangay = barangay;
    else delete o.barangay;
    if (postal) o.postalCode = postal;
    else delete o.postalCode;
    setOverrides(o);
    applyOverridesToView();
    showAlert("success", "Profile updated locally (UI-only)");
    editForm && editForm.classList.add("d-none");
    viewCard && viewCard.classList.remove("d-none");
  });

  // apply overrides on load
  try {
    applyOverridesToView();
  } catch (e) {}
})();

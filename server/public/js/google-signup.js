(function () {
  "use strict";
  var form = document.getElementById("google-signup-form");
  if (!form) return;
  var button = document.getElementById("google-signup-submit");
  var errorBox = document.getElementById("google-signup-error");

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    errorBox.classList.add("d-none");
    if (!form.reportValidity()) return;
    var data = new FormData(form);
    button.disabled = true;
    try {
      var response = await fetch("/api/auth/google/complete-signup", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          firstName: data.get("firstName"),
          lastName: data.get("lastName"),
          phone: data.get("phone"),
          addressProvince: data.get("addressProvince"),
          addressCity: data.get("addressCity"),
          addressBarangay: data.get("addressBarangay"),
          addressPostal: data.get("addressPostal"),
          termsAccepted: data.get("termsAccepted") === "on",
        }),
      });
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(result.error || "Your account could not be created.");
      window.location.assign(result.redirect || "/");
    } catch (error) {
      errorBox.textContent = error.message || "Please try again.";
      errorBox.classList.remove("d-none");
      button.disabled = false;
    }
  });
})();

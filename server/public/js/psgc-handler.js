// PSGC Address Dropdown Handler
(function () {
  "use strict";

  // Wait for DOM to be ready
  document.addEventListener("DOMContentLoaded", function () {
    initializeAddressDropdowns();
  });

  function initializeAddressDropdowns() {
    // Register form selects
    const provinceSelect = document.getElementById("register-addressProvince");
    const citySelect = document.getElementById("register-addressCity");
    const barangaySelect = document.getElementById("register-addressBarangay");
    const postalInput = document.getElementById("register-addressPostal");

    // Profile form selects
    const profileProvince = document.getElementById("profile-addressProvince");
    const profileCity = document.getElementById("profile-addressCity");
    const profileBarangay = document.getElementById("profile-addressBarangay");
    const profilePostal = document.getElementById("profile-addressPostal");

    /* ----- REGISTER form initialization ----- */
    if (provinceSelect && citySelect && barangaySelect) {
      // Populate provinces
      populateProvinces(provinceSelect).then(() => {
        try {
          provinceSelect.disabled = false;
          provinceSelect.removeAttribute("disabled");
          provinceSelect.style.pointerEvents = "auto";
        } catch (e) {}
      });

      // Province change handler
      provinceSelect.addEventListener("change", function () {
        const provinceCode = this.value;
        console.debug("PSGC: province changed ->", provinceCode);
        resetSelect(citySelect, "Select City/Municipality");
        resetSelect(barangaySelect, "Select Barangay");
        postalInput.value = "";

        if (provinceCode) {
          populateCities(citySelect, provinceCode).then(() => {
            try {
              citySelect.disabled = false;
              citySelect.removeAttribute("disabled");
              citySelect.style.pointerEvents = "auto";
            } catch (e) {}
          });
        } else {
          try {
            citySelect.disabled = true;
            citySelect.setAttribute("disabled", "");
            citySelect.style.pointerEvents = "none";
          } catch (e) {}
          try {
            barangaySelect.disabled = true;
            barangaySelect.setAttribute("disabled", "");
            barangaySelect.style.pointerEvents = "none";
          } catch (e) {}
        }
      });

      // City change handler
      citySelect.addEventListener("change", async function () {
        const cityCode = this.value;
        console.debug("PSGC: city changed ->", cityCode);

        // Reset barangay
        resetSelect(barangaySelect, "Select Barangay");

        if (!cityCode) {
          postalInput.value = "";
          barangaySelect.disabled = true;
          return;
        }

        // Get city info directly from the fetched cities array
        const raw = await fetchJSON("/api/psgc/cities");
        const cities = normalizeList(raw);

        // Match city object by code
        const selectedCity = cities.find((c) => {
          return String(c.code || "") === String(cityCode);
        });

        const cityPostal = selectedCity?.zip_code || "";
        postalInput.value = String(cityPostal || "")
          .replace(/\D+/g, "")
          .slice(0, 4);
        console.debug("Postal auto-filled from city object ->", cityPostal);

        // Populate barangays
        try {
          await populateBarangays(barangaySelect, cityCode);
          barangaySelect.disabled = false;
          barangaySelect.removeAttribute("disabled");
          barangaySelect.style.pointerEvents = "auto";
        } catch (e) {
          console.error("PSGC: failed to populate barangays", e);
        }
      });

      // Barangay change handler (postal code comes from barangay)
      barangaySelect.addEventListener("change", function () {
        const selected = this.selectedOptions && this.selectedOptions[0];
        const citySelect = document.querySelector("#register-addressCity");
        const cityPostal =
          citySelect?.selectedOptions[0]?.getAttribute("data-postal") || "";

        if (!selected) {
          document.getElementById("register-addressPostal").value = "";
          return;
        }

        // Prefer barangay data-postal if present, otherwise use cityPostal
        const barangayPostal =
          selected.getAttribute("data-postal") ||
          selected.dataset?.postal ||
          "";
        const finalPostal = String(barangayPostal || cityPostal || "")
          .replace(/\D+/g, "")
          .slice(0, 4);
        document.getElementById("register-addressPostal").value = finalPostal;
        console.debug("Postal auto-filled ->", {
          barangayPostal,
          cityPostal,
          finalPostal,
        });
      });
    }

    /* ----- PROFILE form initialization ----- */
    if (profileProvince) {
      populateProvinces(profileProvince).then(() => {
        try {
          profileProvince.disabled = false;
          profileProvince.removeAttribute("disabled");
          profileProvince.style.pointerEvents = "auto";
        } catch (e) {}
      });

      profileProvince.addEventListener("change", function () {
        const provinceCode = this.value;
        resetSelect(profileCity, "Select City/Municipality");
        resetSelect(profileBarangay, "Select Barangay");
        if (profilePostal) profilePostal.value = "";

        if (provinceCode) {
          populateCities(profileCity, provinceCode).then(() => {
            try {
              profileCity.disabled = false;
              profileCity.removeAttribute("disabled");
              profileCity.style.pointerEvents = "auto";
            } catch (e) {}
          });
        } else {
          try {
            profileCity.disabled = true;
            profileCity.setAttribute("disabled", "");
            profileCity.style.pointerEvents = "none";
          } catch (e) {}
          try {
            profileBarangay.disabled = true;
            profileBarangay.setAttribute("disabled", "");
            profileBarangay.style.pointerEvents = "none";
          } catch (e) {}
        }
      });

      profileCity.addEventListener("change", async function () {
        const cityCode = this.value;
        resetSelect(profileBarangay, "Select Barangay");

        if (!cityCode) {
          if (profilePostal) profilePostal.value = "";
          if (profileBarangay) profileBarangay.disabled = true;
          return;
        }

        const raw = await fetchJSON("/api/psgc/cities");
        const cities = normalizeList(raw);
        const selectedCity = cities.find((c) => {
          return String(c.code || "") === String(cityCode);
        });
        const cityPostal = selectedCity?.zip_code || "";
        if (profilePostal)
          profilePostal.value = String(cityPostal || "")
            .replace(/\D+/g, "")
            .slice(0, 4);

        try {
          await populateBarangays(profileBarangay, cityCode);
          profileBarangay.disabled = false;
          profileBarangay.removeAttribute("disabled");
          profileBarangay.style.pointerEvents = "auto";
        } catch (e) {
          console.error("PSGC: failed to populate barangays (profile)", e);
        }
      });

      profileBarangay.addEventListener("change", function () {
        const selected = this.selectedOptions && this.selectedOptions[0];
        const citySelect = document.querySelector("#profile-addressCity");
        const cityPostal =
          citySelect?.selectedOptions[0]?.getAttribute("data-postal") || "";

        if (!selected) {
          if (profilePostal) profilePostal.value = "";
          return;
        }

        const barangayPostal =
          selected.getAttribute("data-postal") ||
          selected.dataset?.postal ||
          "";
        const finalPostal = String(barangayPostal || cityPostal || "")
          .replace(/\D+/g, "")
          .slice(0, 4);
        if (profilePostal) profilePostal.value = finalPostal;
      });
    }

    /* ----- WALK-IN form initialization (admin/secretary) ----- */
    const walkinProvince = document.getElementById("addrProvince");
    const walkinCity = document.getElementById("addrCity");
    const walkinBarangay = document.getElementById("addrBarangay");
    const walkinPostal = document.getElementById("addrPostalCode");

    if (walkinProvince && walkinCity && walkinBarangay) {
      populateProvinces(walkinProvince).then(() => {
        try {
          walkinProvince.disabled = false;
          walkinProvince.removeAttribute("disabled");
          walkinProvince.style.pointerEvents = "auto";
        } catch (e) {}
      });

      walkinProvince.addEventListener("change", function () {
        const provinceCode = this.value;
        resetSelect(walkinCity, "Select City/Municipality");
        resetSelect(walkinBarangay, "Select Barangay");
        if (walkinPostal) walkinPostal.value = "";

        if (provinceCode) {
          populateCities(walkinCity, provinceCode).then(() => {
            try {
              walkinCity.disabled = false;
              walkinCity.removeAttribute("disabled");
              walkinCity.style.pointerEvents = "auto";
            } catch (e) {}
          });
        } else {
          try {
            walkinCity.disabled = true;
            walkinCity.setAttribute("disabled", "");
            walkinCity.style.pointerEvents = "none";
          } catch (e) {}
          try {
            walkinBarangay.disabled = true;
            walkinBarangay.setAttribute("disabled", "");
            walkinBarangay.style.pointerEvents = "none";
          } catch (e) {}
        }
      });

      walkinCity.addEventListener("change", async function () {
        const cityCode = this.value;
        resetSelect(walkinBarangay, "Select Barangay");

        if (!cityCode) {
          if (walkinPostal) walkinPostal.value = "";
          walkinBarangay.disabled = true;
          return;
        }

        const raw = await fetchJSON("/api/psgc/cities");
        const cities = normalizeList(raw);
        const selectedCity = cities.find((c) => {
          return String(c.code || "") === String(cityCode);
        });
        const cityPostal = selectedCity?.zip_code || "";
        if (walkinPostal)
          walkinPostal.value = String(cityPostal || "")
            .replace(/\D+/g, "")
            .slice(0, 4);

        try {
          await populateBarangays(walkinBarangay, cityCode);
          walkinBarangay.disabled = false;
          walkinBarangay.removeAttribute("disabled");
          walkinBarangay.style.pointerEvents = "auto";
        } catch (e) {
          console.error("PSGC: failed to populate barangays (walkin)", e);
        }
      });

      walkinBarangay.addEventListener("change", function () {
        const selected = this.selectedOptions && this.selectedOptions[0];
        const citySelect = document.querySelector("#addrCity");
        const cityPostal =
          citySelect?.selectedOptions[0]?.getAttribute("data-postal") || "";

        if (!selected) {
          if (walkinPostal) walkinPostal.value = "";
          return;
        }

        const barangayPostal =
          selected.getAttribute("data-postal") ||
          selected.dataset?.postal ||
          "";
        const finalPostal = String(barangayPostal || cityPostal || "")
          .replace(/\D+/g, "")
          .slice(0, 4);
        if (walkinPostal) walkinPostal.value = finalPostal;
      });
    }
  }

  async function fetchJSON(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      console.error("PSGC fetch error", url, e);
      return [];
    }
  }

  function normalizeList(resp) {
    if (!resp) return [];
    if (Array.isArray(resp)) return resp;
    if (resp.data && Array.isArray(resp.data)) return resp.data;
    if (resp.results && Array.isArray(resp.results)) return resp.results;
    if (resp.items && Array.isArray(resp.items)) return resp.items;
    // Some endpoints return an object keyed by id — convert values to array
    if (typeof resp === "object")
      return Object.values(resp).filter((v) =>
        Array.isArray(v) ? false : true,
      ).length
        ? []
        : [];
    return [];
  }

  // Use official psgc.cloud endpoints. We fetch provinces once and fetch cities/barangays on demand,
  // matching both PSGC id and correspondence code to handle different code formats.
  async function populateProvinces(selectElement) {
    const raw = await fetchJSON("/api/psgc/provinces");
    const provinces = normalizeList(raw);
    selectElement.innerHTML = '<option value="">Select Province</option>';
    provinces.forEach(function (p) {
      const option = document.createElement("option");
      // The v2 API uses `code` as the primary identifier
      const val = p.code || p.id || "";
      option.value = String(val);
      option.textContent = p.name || "";
      // Store the province name as data attribute for city matching
      option.setAttribute("data-name", p.name || "");
      selectElement.appendChild(option);
    });

    // If a preselected value/text was provided (via data-selected or value), try to select it
    const sel =
      (selectElement.dataset && selectElement.dataset.selected) ||
      selectElement.getAttribute("data-selected") ||
      selectElement.value ||
      "";
    if (sel) {
      const match = Array.from(selectElement.options).find(
        (o) =>
          o.value === String(sel) ||
          o.textContent.trim() === String(sel).trim(),
      );
      if (match) {
        selectElement.value = match.value;
        // trigger change so dependent selects populate
        selectElement.dispatchEvent(new Event("change"));
      }
    }
  }

  // Match cities/barangays by province name — the v2 API includes a `province`
  // field on every city object which is the most reliable way to filter.
  function matchesByProvince(item, provinceName) {
    if (!item || !provinceName) return false;
    const itemProvince = String(item.province || "").trim().toLowerCase();
    return itemProvince === provinceName.trim().toLowerCase();
  }

  async function populateCities(selectElement, provinceCode) {
    // Get the selected province name for matching
    const provinceSelect =
      document.querySelector(
        `#${selectElement.id.replace("City", "Province")}`,
      ) || document.querySelector("#register-addressProvince");

    const provinceName = provinceSelect
      ? provinceSelect.selectedOptions[0]?.getAttribute("data-name") ||
        provinceSelect.selectedOptions[0]?.textContent ||
        ""
      : "";

    const raw = await fetchJSON("/api/psgc/cities");
    const cities = normalizeList(raw);

    selectElement.innerHTML =
      '<option value="">Select City/Municipality</option>';

    // Filter cities by province name (primary) or by PSGC code prefix (fallback)
    const matches = cities.filter((c) => {
      // Primary: match by province name field
      if (provinceName && matchesByProvince(c, provinceName)) return true;
      // Fallback: match by PSGC code prefix (first 5 digits)
      if (provinceCode) {
        const cityCode = String(c.code || "");
        const provCode = String(provinceCode);
        if (cityCode.length >= 5 && provCode.length >= 5 &&
            cityCode.slice(0, 5) === provCode.slice(0, 5)) return true;
      }
      return false;
    });

    if (!matches.length) {
      const noopt = document.createElement("option");
      noopt.value = "";
      noopt.textContent = "No cities found";
      selectElement.appendChild(noopt);
      selectElement.disabled = true;
      return;
    }

    matches.forEach(function (city) {
      const option = document.createElement("option");
      option.value = String(city.code || "");
      option.textContent = city.name || "";

      /* POSTAL CODE */
      const postal = String(city.zip_code || "").trim().slice(0, 4);
      if (postal) option.setAttribute("data-postal", postal);
      console.debug("PSGC: adding city option", {
        name: option.textContent,
        value: option.value,
        postal,
      });

      selectElement.appendChild(option);
    });

    selectElement.disabled = false;

    // honor any preselected value/text
    const sel =
      (selectElement.dataset && selectElement.dataset.selected) ||
      selectElement.getAttribute("data-selected") ||
      selectElement.value ||
      "";
    if (sel) {
      const match = Array.from(selectElement.options).find(
        (o) =>
          o.value === String(sel) ||
          o.textContent.trim() === String(sel).trim(),
      );
      if (match) {
        selectElement.value = match.value;
        selectElement.dispatchEvent(new Event("change"));
      }
    }
  }

  async function populateBarangays(selectElement, cityCode) {
    const citySelect =
      document.querySelector(
        `#${selectElement.id.replace("Barangay", "City")}`,
      ) || document.querySelector("#register-addressCity");
    const cityPostal =
      citySelect?.selectedOptions[0]?.getAttribute("data-postal") || "";

    const raw = await fetchJSON(`/api/psgc/barangays?city_code=${cityCode}`);
    const barangays = normalizeList(raw);

    selectElement.innerHTML =
      '<option value="">Select Barangay (optional)</option>';

    barangays.forEach((b) => {
      const option = document.createElement("option");
      option.value = b.code || "";
      option.textContent = b.name || "";

      // Use barangay-level zip_code, fall back to city postal
      let postal = String(b.zip_code || "").trim();
      if (!postal && cityPostal) postal = String(cityPostal).trim();
      if (postal) postal = postal.slice(0, 4);
      if (postal) option.setAttribute("data-postal", postal);
      console.debug("PSGC: adding barangay option", {
        name: option.textContent,
        value: option.value,
        postal,
      });

      selectElement.appendChild(option);
    });

    selectElement.disabled = false;

    // honor any preselected value/text
    const sel =
      (selectElement.dataset && selectElement.dataset.selected) ||
      selectElement.getAttribute("data-selected") ||
      selectElement.value ||
      "";
    if (sel) {
      const match = Array.from(selectElement.options).find(
        (o) =>
          o.value === String(sel) ||
          o.textContent.trim() === String(sel).trim(),
      );
      if (match) {
        selectElement.value = match.value;
        selectElement.dispatchEvent(new Event("change"));
      }
    }

    // DON'T auto-select first barangay, leave optional
    // postal is already filled from city
  }

  function resetSelect(selectElement, placeholderText) {
    selectElement.innerHTML = `<option value="">${placeholderText}</option>`;
    selectElement.disabled = true;
  }
})();

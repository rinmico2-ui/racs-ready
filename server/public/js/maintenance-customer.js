(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const formatDate = (value) => value
    ? new Date(value).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", year: "numeric", month: "long", day: "numeric" })
    : "Not recorded";
  const label = (value) => String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  let installationAssetId = null;
  let alertTimer = null;
  let loadSequence = 0;
  let responsePending = false;
  let installationPending = false;
  let bookingPending = false;
  let bookingRequest = null;
  let cancellationRequest = null;
  let cancellationPending = false;
  let bookingLocation = null;
  let bookingLocationLoading = false;
  let bookingLocationSequence = 0;
  let bookingMap = null;
  let bookingMarker = null;
  let bookingCompanyLocation = null;
  let bookingPinSource = "saved";
  let bookingSavedLocation = null;
  const scheduleStatus = (schedule) => schedule?.effectiveStatus || schedule?.status;

  function localDateInput(date) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function setModalBusy(id, busy) {
    $(id).querySelectorAll("button, input, textarea").forEach(control => { control.disabled = busy; });
  }

  function showAlert(message, kind, timeoutMs = 10000) {
    if (kind === "error") {
      const target = $("aftercareResponseModal")?.classList.contains("show") ? $("aftercareResponseError") : $("installationDateModal")?.classList.contains("show") ? $("installationDateError") : null;
      if (target) { target.textContent = message; target.classList.remove("d-none"); }
    }
    const box = $("aftercareAlert");
    delete box.dataset.loadError;
    if (alertTimer) window.clearTimeout(alertTimer);
    box.className = `aftercare-alert ${kind || "success"}`;
    box.textContent = message;
    if (timeoutMs > 0) alertTimer = window.setTimeout(() => box.classList.add("d-none"), timeoutMs);
  }

  function activateTab(tab) {
    document.querySelectorAll(".aftercare-tab").forEach((button) => {
      const selected = button.dataset.aftercareTab === tab;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll("[data-aftercare-panel]").forEach((panel) => panel.classList.toggle("d-none", panel.dataset.aftercarePanel !== tab));
  }

  function equipmentName(asset) {
    const equipment = asset.equipment || {};
    const brand = String(equipment.brand || "").trim();
    const model = String(equipment.model || "").trim();
    const modelIncludesBrand = brand && (model.toLowerCase() === brand.toLowerCase() || model.toLowerCase().startsWith(brand.toLowerCase() + " "));
    return [modelIncludesBrand ? "" : brand, model, equipment.capacity ? `${equipment.capacity} ${equipment.capacityUnit || "HP"}` : ""]
      .filter(Boolean).join(" ") || equipment.applianceTypeName || "Air-conditioning unit";
  }

  function activeCycle(asset) {
    return (asset.schedules || []).find((schedule) => !["completed", "cancelled"].includes(scheduleStatus(schedule))) || null;
  }

  function responseSummary(cycle) {
    const response = cycle?.customerResponse || {};
    if (!response.status || response.status === "none") return "";
    const descriptions = {
      booking_started: "Booking started",
      callback_requested: "Callback requested",
      remind_later: response.remindAt ? `Reminder set for ${formatDate(response.remindAt)}` : "Reminder requested",
      declined: "Not booking now",
    };
    return `<div class="aftercare-response-state ${escapeHtml(response.status)}"><i class="bi bi-chat-square-check"></i>${escapeHtml(descriptions[response.status] || label(response.status))}</div>`;
  }

  function renderAsset(asset) {
    const equipment = asset.equipment || {};
    const cycle = activeCycle(asset);
    const installationRequired = asset.status === "installation_date_required";
    const booking = cycle?.bookingId;
    const name = equipmentName(asset);
    const open = asset.status === "active" && cycle && ["upcoming", "due", "overdue"].includes(scheduleStatus(cycle)) && !booking;
    const cycleLabel = booking?.status === "pending" ? "Booking requested"
      : booking?.status === "awaiting_assignment" ? "Awaiting technician" : label(scheduleStatus(cycle));
    const bookingActions = booking
      ? `<a class="btn btn-sm btn-outline-primary" href="/book-history?highlight=${encodeURIComponent(booking._id)}"><i class="bi bi-eye me-1"></i>View booking</a>
          ${booking.customerCanCancelMaintenance === true ? `<button class="btn btn-sm btn-outline-secondary js-aftercare-cancel" data-booking-id="${escapeHtml(booking._id)}" data-reference="${escapeHtml(booking.bookingReference || '')}" data-equipment="${escapeHtml(name)}" aria-haspopup="dialog">Cancel visit</button>` : '<span class="aftercare-cancel-help">To cancel this visit, please contact us.</span>'}`
      : open
        ? `<button class="btn btn-sm btn-primary js-aftercare-book" data-schedule-id="${cycle._id}" data-equipment="${escapeHtml(name)}" data-address="${escapeHtml(asset.serviceAddress || 'Your saved service address')}" data-due-date="${escapeHtml(cycle.dueDate || '')}" aria-haspopup="dialog"><i class="bi bi-calendar-check me-1"></i>Request maintenance</button>
          <button class="btn btn-sm btn-outline-primary js-aftercare-response" data-response="callback_requested" data-schedule-id="${cycle._id}" data-equipment="${escapeHtml(name)}"><i class="bi bi-telephone me-1"></i>Request a call</button>
          <details class="aftercare-more-options"><summary>More options<i class="bi bi-chevron-down" aria-hidden="true"></i></summary><div class="aftercare-extra-actions">
          <button class="btn btn-sm btn-outline-secondary js-aftercare-response" data-response="remind_later" data-schedule-id="${cycle._id}" data-equipment="${escapeHtml(name)}" title="Choose another reminder date" aria-label="Choose a reminder"><i class="bi bi-bell me-1" aria-hidden="true"></i>Remind me later</button>
          <button type="button" class="btn btn-sm btn-outline-secondary js-aftercare-response js-aftercare-decline" data-response="declined" data-schedule-id="${cycle._id}" data-equipment="${escapeHtml(name)}" aria-haspopup="dialog" ${cycle.customerResponse?.status === "declined" ? 'disabled' : ''}><i class="bi bi-x-lg me-1" aria-hidden="true"></i>${cycle.customerResponse?.status === "declined" ? 'Not now saved' : 'Not now'}</button></div></details>`
        : '<span class="text-muted small">No action available</span>';
    const cycleHtml = installationRequired
      ? `<div class="maintenance-cycle"><div><div class="maintenance-primary">Installation date required</div><div class="maintenance-secondary">Record the actual date before reminders begin.</div></div><button class="btn btn-sm btn-primary js-install-date" data-asset-id="${asset._id}"><i class="bi bi-calendar-plus me-1"></i>Record date</button></div>`
      : cycle
        ? `<div class="maintenance-cycle aftercare-cycle"><div><div class="maintenance-secondary">${booking ? "Your maintenance visit" : "Recommended maintenance date"}</div><div class="maintenance-primary">${formatDate(booking?.bookingDate || cycle.dueDate)}${booking?.startTime ? ` · ${escapeHtml(booking.startTime)}` : ""} <span class="maintenance-status ${escapeHtml(scheduleStatus(cycle))} ms-1">${escapeHtml(cycleLabel)}</span></div><div class="maintenance-secondary">${booking?.maintenance?.paymentOnSite ? "Pay on site after service. We will assign a technician." : booking?.status === "pending" ? "Visit confirmation is pending." : open ? "We'll use your saved address and choose the first open time. No payment is taken now." : `Every ${Number(cycle.intervalDays || 90)} days`}</div>${responseSummary(cycle)}</div><div class="maintenance-cycle-actions">${bookingActions}</div></div>`
        : '<div class="maintenance-cycle"><div><div class="maintenance-primary">No upcoming maintenance</div><div class="maintenance-secondary">Your completed service records are kept here.</div></div></div>';
    return `<article class="asset-card${open ? ' asset-needs-service' : ''}">
      <div class="asset-card-head"><div class="asset-icon"><i class="bi bi-snow2"></i></div><div class="flex-grow-1 min-width-0"><div class="maintenance-primary">${escapeHtml(name)}</div><div class="maintenance-secondary">${escapeHtml(equipment.unitLabel || "Unit")} | ${escapeHtml(asset.originReference || "Customer equipment")}</div></div><span class="maintenance-status ${escapeHtml(asset.status)}">${escapeHtml(label(asset.status))}</span></div>
      <div class="asset-card-body">
        ${cycleHtml}
        <details class="asset-history"><summary><span><i class="bi bi-info-circle" aria-hidden="true"></i>Unit details</span><i class="bi bi-chevron-down" aria-hidden="true"></i></summary>
        <div class="asset-meta">
          <div><div class="asset-meta-label">Installed</div><div class="asset-meta-value">${formatDate(asset.installationDate)}</div></div>
          <div><div class="asset-meta-label">Last service</div><div class="asset-meta-value">${formatDate(asset.lastServiceDate)}</div></div>
          <div><div class="asset-meta-label">Service address</div><div class="asset-meta-value">${escapeHtml(asset.serviceAddress || "Not recorded")}</div></div>
        </div>
        </details>
      </div>
    </article>`;
  }

  function reviewCancellation(button) {
    if (cancellationPending) return;
    cancellationRequest = { bookingId: button.dataset.bookingId };
    $("aftercareCancelEquipment").textContent = button.dataset.equipment || "Aircon";
    $("aftercareCancelReference").textContent = button.dataset.reference || "Maintenance booking";
    $("aftercareCancelReason").value = "";
    $("aftercareCancelError").classList.add("d-none");
    bootstrap.Modal.getOrCreateInstance($("aftercareCancelModal")).show();
  }

  async function cancelMaintenance(event) {
    event.preventDefault();
    if (cancellationPending || !cancellationRequest) return;
    const reason = $("aftercareCancelReason").value.replace(/\s+/g, " ").trim();
    const errorBox = $("aftercareCancelError");
    errorBox.classList.add("d-none");
    if (reason.length < 10 || reason.length > 500) {
      errorBox.textContent = "Please enter a reason with 10 to 500 characters.";
      errorBox.classList.remove("d-none");
      $("aftercareCancelReason").focus();
      return;
    }
    cancellationPending = true;
    setModalBusy("aftercareCancelModal", true);
    $("aftercareCancelSubmit").textContent = "Cancelling...";
    try {
      await requestJson(`/api/appointments/${encodeURIComponent(cancellationRequest.bookingId)}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
      });
      cancellationPending = false;
      bootstrap.Modal.getInstance($("aftercareCancelModal"))?.hide();
      cancellationRequest = null;
      await load();
      if (!$("aftercareAlert").dataset.loadError) showAlert("Visit cancelled. You can request maintenance again when you are ready.", "success");
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove("d-none");
    } finally {
      cancellationPending = false;
      setModalBusy("aftercareCancelModal", false);
      $("aftercareCancelSubmit").textContent = "Cancel visit";
    }
  }

  function renderWarrantyRecord(record) {
    const activeClaims = (record.claims || []).filter((claim) => claim.active);
    const coverages = (record.coverages || []).map((coverage) => `<div class="warranty-coverage-row"><div><strong>${escapeHtml(coverage.serviceName || label(coverage.coverageType) || "Warranty coverage")}</strong><span>${Number(coverage.days || 0)} days | ends ${formatDate(coverage.endDate)}</span></div><span class="maintenance-status ${escapeHtml(coverage.status)}">${escapeHtml(label(coverage.status))}</span></div>`).join("");
    const claims = (record.claims || []).map((claim) => `<div class="warranty-claim-row"><div><strong>${escapeHtml(claim.claimReference)}</strong><span>${escapeHtml(claim.affectedItem?.name || "Warranty issue")} | filed ${formatDate(claim.submittedAt)}</span></div><span class="maintenance-status ${claim.active ? "due" : "completed"}">${escapeHtml(label(claim.status))}</span></div>`).join("");
    return `<article class="warranty-record">
      <header><div><span class="aftercare-record-type">${record.sourceType === "order" ? "Aircon order" : "Service booking"}</span><h3>${escapeHtml(record.reference)}</h3><p>Completed ${formatDate(record.completedAt)}</p></div><span class="maintenance-status ${escapeHtml(record.status)}">${escapeHtml(label(record.status))}</span></header>
      <div class="warranty-record-body">${coverages || '<div class="text-muted small">No coverage details recorded.</div>'}${claims ? `<div class="warranty-claims"><div class="warranty-subhead">Claims</div>${claims}</div>` : ""}</div>
      <footer><span>${activeClaims.length ? `${activeClaims.length} open claim${activeClaims.length === 1 ? "" : "s"}` : "No open claims"}</span><a class="btn btn-sm btn-outline-primary" href="${escapeHtml(record.detailsUrl)}"><i class="bi bi-box-arrow-up-right me-1"></i>View coverage</a></footer>
    </article>`;
  }

  async function requestJson(url, options) {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
    if (response.redirected && new URL(response.url).pathname.includes("login")) throw new Error("Your session ended. Please sign in again.");
    const data = await response.json().catch(() => { throw new Error("The server could not load this request. Please try again."); });
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  async function load() {
    const sequence = ++loadSequence;
    const refresh = $("aftercareRefresh");
    if ($("aftercareAlert").dataset.loadError === "true") {
      if (alertTimer) window.clearTimeout(alertTimer);
      $("aftercareAlert").classList.add("d-none");
      delete $("aftercareAlert").dataset.loadError;
    }
    if (refresh) refresh.disabled = true;
    $("aftercareLoading")?.classList.remove("d-none");
    $("aftercareLoadError")?.classList.add("d-none");
    $("maintenanceCustomerApp").setAttribute("aria-busy", "true");
    try {
      const [maintenanceResult, warrantyResult] = await Promise.allSettled([
        requestJson("/api/maintenance/customer"),
        requestJson("/api/warranty-claims/overview"),
      ]);
      if (sequence !== loadSequence) return;
      const failed = [];
      const maintenanceError = $("aftercareMaintenanceError");
      const warrantyError = $("aftercareWarrantyError");
      maintenanceError.classList.toggle("d-none", maintenanceResult.status === "fulfilled");
      warrantyError.classList.toggle("d-none", warrantyResult.status === "fulfilled");
      if (maintenanceResult.status === "fulfilled") {
        const maintenance = maintenanceResult.value;
        const assets = maintenance.assets || [];
        $("customerAssetCount").textContent = assets.length;
        $("customerDueTotal").textContent = Number(maintenance.summary?.due || 0) + Number(maintenance.summary?.overdue || 0);
        $("customerAssetGrid").innerHTML = assets.map(renderAsset).join("");
        $("customerMaintenanceEmpty").classList.toggle("d-none", assets.length !== 0);
      } else {
        failed.push(maintenanceResult.reason.message);
        $("customerAssetGrid").replaceChildren();
        $("customerMaintenanceEmpty").classList.add("d-none");
        $("customerAssetCount").textContent = "\u2014";
        $("customerDueTotal").textContent = "\u2014";
      }
      if (warrantyResult.status === "fulfilled") {
        const warranty = warrantyResult.value;
        $("customerActiveCoverage").textContent = warranty.summary?.activeCoverages || 0;
        $("customerActiveClaims").textContent = warranty.summary?.activeClaims || 0;
        const records = warranty.records || [];
        $("customerWarrantyRecords").innerHTML = records.map(renderWarrantyRecord).join("");
        $("customerWarrantyEmpty").classList.toggle("d-none", records.length !== 0);
      } else {
        failed.push(warrantyResult.reason.message);
        $("customerWarrantyRecords").replaceChildren();
        $("customerWarrantyEmpty").classList.add("d-none");
        $("customerActiveCoverage").textContent = "\u2014";
        $("customerActiveClaims").textContent = "\u2014";
      }
      if (failed.length) {
        $("aftercareLoadError").classList.toggle("d-none", failed.length !== 2);
        showAlert(failed[0], "error", 0);
        $("aftercareAlert").dataset.loadError = "true";
      }
    } catch (error) {
      if (sequence !== loadSequence) return;
      $("aftercareLoadError")?.classList.remove("d-none");
      showAlert(error.message, "error");
      $("aftercareAlert").dataset.loadError = "true";
    } finally {
      if (sequence === loadSequence) {
        $("aftercareLoading")?.classList.add("d-none");
        $("maintenanceCustomerApp").setAttribute("aria-busy", "false");
        if (refresh) refresh.disabled = false;
      }
    }
  }

  async function submitResponse(scheduleId, status, values, button) {
    if (responsePending) return;
    responsePending = true;
    $("aftercareResponseError")?.classList.add("d-none");
    setModalBusy("aftercareResponseModal", true);
    if (button) button.disabled = true;
    const originalButtonText = button?.textContent;
    if (button) button.textContent = "Saving...";
    try {
      const data = await requestJson(`/api/maintenance/schedules/${encodeURIComponent(scheduleId)}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, ...values }),
      });
      responsePending = false;
      bootstrap.Modal.getInstance($("aftercareResponseModal"))?.hide();
      const messages = {
        callback_requested: "Your callback request was sent to the aftercare team.",
        remind_later: "Your reminder date was saved.",
        declined: "Your response was saved. You can book from here whenever you are ready.",
      };
      showAlert(messages[status] || "Your response was saved.", "success");
      await load();
      $("aftercareAlert").scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (error) {
      showAlert(error.message, "error");
    } finally {
      responsePending = false;
      setModalBusy("aftercareResponseModal", false);
      if (button) { button.disabled = false; button.textContent = originalButtonText; }
    }
  }

  function bookingLocationReady() {
    return bookingLocation && $("aftercareBookingAddress").value.trim().length >= 5 && !bookingLocationLoading;
  }

  function updateBookingLocationState(message) {
    $("aftercareBookingSubmit").disabled = bookingPending || !bookingLocationReady();
    if (message) $("aftercareBookingLocationStatus").textContent = message;
  }

  function drawBookingPin() {
    if (!bookingMap || !bookingLocation) return;
    const point = [bookingLocation.lat, bookingLocation.lng];
    if (!bookingMarker) {
      const icon = L.divIcon({ className: "aftercare-pin-icon", html: '<span class="aftercare-map-pin" aria-hidden="true"></span>', iconSize: [24, 24], iconAnchor: [12, 24] });
      bookingMarker = L.marker(point, { draggable: true, icon, title: "Drag to change the service location", alt: "Service location" }).addTo(bookingMap);
      bookingMarker.on("dragend", () => { const pin = bookingMarker.getLatLng(); selectMapPin(pin.lat, pin.lng); });
    } else bookingMarker.setLatLng(point);
    bookingMap.setView(point, 16);
  }

  function initializeBookingMap() {
    if ($("aftercareBookingLocationEditor").hidden) return;
    if (typeof L === "undefined") {
      updateBookingLocationState("Choose a suggested address to set your location. The map could not load.");
      return;
    }
    if (!bookingMap) {
      bookingMap = L.map("aftercareBookingMap", { scrollWheelZoom: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(bookingMap);
      bookingMap.on("click", event => selectMapPin(event.latlng.lat, event.latlng.lng));
    }
    bookingMap.invalidateSize();
    const center = bookingLocation || bookingCompanyLocation || { lat: 15.3593, lng: 120.9578 };
    bookingMap.setView([center.lat, center.lng], bookingLocation ? 16 : 11);
    drawBookingPin();
  }

  async function selectMapPin(lat, lng) {
    if (bookingPending) return;
    if (lat < 4.5 || lat > 21.5 || lng < 116 || lng > 127) {
      updateBookingLocationState("Choose a service location in the Philippines.");
      return;
    }
    const sequence = ++bookingLocationSequence;
    bookingPinSource = "map";
    bookingLocation = { lat, lng };
    bookingLocationLoading = true;
    $("aftercareBookingAddress").value = "";
    $("aftercareBookingSuggestions").classList.add("d-none");
    $("aftercareBookingAddress")._addressAutocomplete?.close();
    drawBookingPin();
    updateBookingLocationState("Map pin selected. Finding its address...");
    try {
      const result = await requestJson(`/api/geocoding/reverse?lat=${lat}&lon=${lng}`);
      if (sequence !== bookingLocationSequence) return;
      $("aftercareBookingAddress").value = String(result.display_name || "").slice(0, 500);
    } catch (error) {
      if (sequence !== bookingLocationSequence) return;
      // The map pin is still valid when address lookup is unavailable.
    } finally {
      if (sequence === bookingLocationSequence) {
        bookingLocationLoading = false;
        updateBookingLocationState($("aftercareBookingAddress").value.trim().length >= 5 ? "Location selected. Check the address before sending." : "Pin selected. Enter the full service address above.");
      }
    }
  }

  async function reviewMaintenance(button) {
    if (bookingPending) return;
    bookingRequest = { scheduleId: button.dataset.scheduleId };
    const sequence = ++bookingLocationSequence;
    bookingLocation = null;
    bookingCompanyLocation = null;
    bookingLocationLoading = true;
    bookingPinSource = "saved";
    bookingSavedLocation = null;
    $("aftercareBookingLocationEditor").hidden = true;
    $("aftercareBookingSavedLocation").hidden = false;
    $("aftercareBookingSavedAddress").textContent = "Loading your saved address...";
    $("aftercareBookingChangeLocation").disabled = true;
    $("aftercareBookingUseSavedLocation").hidden = true;
    $("aftercareBookingLocationExplanation").hidden = true;
    $("aftercareBookingLocationExplanationText").textContent = "The original record has no usable service address and map pin. Choose where this aircon needs maintenance. We will save it with your request for future visits.";
    if (bookingMarker) { bookingMarker.remove(); bookingMarker = null; }
    $("aftercareBookingAddress")._addressAutocomplete?.close();
    $("aftercareBookingEquipment").textContent = button.dataset.equipment;
    $("aftercareBookingAddress").value = button.dataset.address === "Your saved service address" ? "" : button.dataset.address;
    $("aftercareBookingDue").textContent = formatDate(button.dataset.dueDate);
    $("aftercareBookingError").classList.add("d-none");
    updateBookingLocationState("Loading your saved location...");
    bootstrap.Modal.getOrCreateInstance($("aftercareBookingModal")).show();
    try {
      const data = await requestJson(`/api/maintenance/schedules/${encodeURIComponent(bookingRequest.scheduleId)}/booking-location`);
      if (sequence !== bookingLocationSequence) return;
      const location = data.location || {};
      if (data.missingLocationReason === "store_pickup") $("aftercareBookingLocationExplanationText").textContent = "This aircon was picked up at the store, so the order has no home service location. Choose where it is installed. We will save that location with your maintenance request for future visits.";
      if (location.address) $("aftercareBookingAddress").value = location.address;
      if (Number.isFinite(location.lat) && Number.isFinite(location.lng)) bookingLocation = { lat: location.lat, lng: location.lng };
      if (bookingLocation && String(location.address || "").trim().length >= 5) bookingSavedLocation = { ...bookingLocation, address: location.address };
      if (Number.isFinite(data.companyLocation?.lat) && Number.isFinite(data.companyLocation?.lng)) bookingCompanyLocation = data.companyLocation;
    } catch (error) {
      if (sequence !== bookingLocationSequence) return;
      $("aftercareBookingError").textContent = "The saved location could not load. You can choose an address or pin below.";
      $("aftercareBookingError").classList.remove("d-none");
    } finally {
      if (sequence === bookingLocationSequence) {
        bookingLocationLoading = false;
        $("aftercareBookingSavedAddress").textContent = bookingSavedLocation?.address || "No saved service location";
        $("aftercareBookingSavedLocation").hidden = !bookingSavedLocation;
        $("aftercareBookingLocationEditor").hidden = Boolean(bookingSavedLocation);
        $("aftercareBookingChangeLocation").disabled = false;
        $("aftercareBookingUseSavedLocation").hidden = !bookingSavedLocation;
        $("aftercareBookingLocationExplanation").hidden = Boolean(bookingSavedLocation);
        if (!bookingSavedLocation && $("aftercareBookingModal").classList.contains("show")) initializeBookingMap();
        updateBookingLocationState(bookingLocation ? "Saved location loaded. Check the address and map pin." : "Choose an address suggestion or tap the map to set a service location.");
      }
    }
  }

  async function bookMaintenance() {
    if (bookingPending || !bookingRequest) return;
    if (!bookingLocationReady()) {
      updateBookingLocationState("Choose an address suggestion or map pin and enter the full service address.");
      return;
    }
    bookingPending = true;
    const button = $("aftercareBookingSubmit");
    setModalBusy("aftercareBookingModal", true);
    bookingMarker?.dragging?.disable();
    $("aftercareBookingAddress")._addressAutocomplete?.close();
    $("aftercareBookingError").classList.add("d-none");
    button.disabled = true;
    const original = button.innerHTML;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Finding a time…';
    try {
      const data = await requestJson(`/api/maintenance/schedules/${encodeURIComponent(bookingRequest.scheduleId)}/book`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: { ...bookingLocation, address: $("aftercareBookingAddress").value.trim() } }),
      });
      bookingPending = false;
      bootstrap.Modal.getInstance($("aftercareBookingModal"))?.hide();
      bookingPending = true;
      await load();
      const booking = data.booking || {};
      showAlert(`${data.alreadyBooked ? "Booking already exists" : "Booking requested"} for ${formatDate(booking.bookingDate)} at ${booking.startTime || "the next available time"}. No payment is needed now; pay on site after service. We will assign a technician.`, "success", 0);
      const details = document.createElement("a");
      details.className = "btn btn-sm btn-outline-primary ms-2";
      details.href = `/book-history?highlight=${encodeURIComponent(booking._id)}`;
      details.textContent = "View booking";
      $("aftercareAlert").appendChild(details);
      $("aftercareAlert").scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (error) {
      $("aftercareBookingError").textContent = error.message || "We could not book maintenance. Please try again.";
      $("aftercareBookingError").classList.remove("d-none");
      showAlert(error.message || "We could not book maintenance. Please try again.", "error");
    } finally {
      bookingPending = false;
      setModalBusy("aftercareBookingModal", false);
      bookingMarker?.dragging?.enable();
      updateBookingLocationState();
      button.innerHTML = original;
    }
  }

  function openResponseModal(button) {
    if (responsePending || button.disabled) return;
    const status = button.dataset.response;
    const isDeclining = status === "declined";
    $("aftercareResponseError")?.classList.add("d-none");
    $("aftercareResponseScheduleId").value = button.dataset.scheduleId;
    $("aftercareResponseStatus").value = status;
    $("aftercareResponseEquipment").textContent = button.dataset.equipment || "Equipment";
    $("aftercareResponseNote").value = "";
    $("aftercareResponseNote").placeholder = isDeclining ? "For example, I will request maintenance another time." : "Best time to call, access details, or service concerns";
    $("aftercareResponseDate").value = "";
    $("aftercareResponseDate").min = localDateInput(new Date(Date.now() + 30 * 60000));
    $("aftercareResponseDate").max = localDateInput(new Date(Date.now() + 180 * 86400000));
    $("aftercareResponseTitle").textContent = isDeclining ? "Skip maintenance for now?" : status === "remind_later" ? "Choose a reminder" : "Request a callback";
    $("aftercareResponseHelp").hidden = !isDeclining;
    $("aftercareResponseDateGroup").hidden = isDeclining;
    $("aftercareResponseDate").disabled = isDeclining;
    $("aftercareResponseDateLabel").textContent = status === "remind_later" ? "Remind me on" : "Preferred contact time";
    $("aftercareResponseDate").required = status === "remind_later";
    $("aftercareResponseSubmit").textContent = isDeclining ? "Confirm not now" : status === "remind_later" ? "Save reminder" : "Send request";
    bootstrap.Modal.getOrCreateInstance($("aftercareResponseModal")).show();
  }

  document.querySelectorAll("[data-aftercare-tab]").forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.aftercareTab)));

  $("aftercareRefresh")?.addEventListener("click", load);
  $("aftercareRetry")?.addEventListener("click", load);
  document.querySelector(".aftercare-tabs")?.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...document.querySelectorAll(".aftercare-tab")];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    activateTab(tabs[next].dataset.aftercareTab);
    tabs[next].focus();
  });

  $("customerAssetGrid").addEventListener("click", async (event) => {
    const cancelButton = event.target.closest(".js-aftercare-cancel");
    if (cancelButton) return reviewCancellation(cancelButton);
    const bookButton = event.target.closest(".js-aftercare-book");
    if (bookButton) return reviewMaintenance(bookButton);
    const responseButton = event.target.closest(".js-aftercare-response");
    if (responseButton) return openResponseModal(responseButton);
    const installButton = event.target.closest(".js-install-date");
    if (installButton) {
      installationAssetId = installButton.dataset.assetId;
      $("installationDateError")?.classList.add("d-none");
      $("assetInstallationDate").value = "";
      $("assetInstallationDate").max = localDateInput(new Date()).slice(0, 10);
      bootstrap.Modal.getOrCreateInstance($("installationDateModal")).show();
    }
  });

  $("aftercareResponseForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (responsePending || !$("aftercareResponseForm").reportValidity()) return;
    const status = $("aftercareResponseStatus").value;
    const chosenTime = $("aftercareResponseDate").value;
    const remindAt = chosenTime ? new Date(chosenTime) : null;
    if (remindAt && Number.isNaN(remindAt.getTime())) {
      showAlert("Choose a valid contact or reminder time.", "error");
      return;
    }
    return submitResponse(
      $("aftercareResponseScheduleId").value,
      status,
      { remindAt: remindAt ? remindAt.toISOString() : null, note: $("aftercareResponseNote").value.trim() },
      $("aftercareResponseSubmit"),
    );
  });

  $("saveInstallationDateBtn").addEventListener("click", async () => {
    if (installationPending) return;
    const date = $("assetInstallationDate").value;
    if (!installationAssetId || !date) {
      showAlert("Choose the installation date before saving.", "error");
      return;
    }
    if (!$("assetInstallationDate").reportValidity()) return;
    installationPending = true;
    $("installationDateError")?.classList.add("d-none");
    setModalBusy("installationDateModal", true);
    const button = $("saveInstallationDateBtn");
    button.disabled = true;
    try {
      await requestJson(`/api/maintenance/assets/${encodeURIComponent(installationAssetId)}/installation-date`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationDate: date }),
      });
      installationPending = false;
      bootstrap.Modal.getInstance($("installationDateModal"))?.hide();
      showAlert("Installation date saved and maintenance reminders activated.", "success");
      await load();
    } catch (error) { showAlert(error.message, "error"); }
    finally { installationPending = false; setModalBusy("installationDateModal", false); button.disabled = false; }
  });

  $("aftercareResponseModal").addEventListener("hide.bs.modal", event => { if (responsePending) event.preventDefault(); });
  $("aftercareCancelForm").addEventListener("submit", cancelMaintenance);
  $("aftercareCancelModal").addEventListener("hide.bs.modal", event => { if (cancellationPending) event.preventDefault(); });
  $("aftercareCancelModal").addEventListener("hidden.bs.modal", () => { cancellationRequest = null; });
  $("installationDateModal").addEventListener("hide.bs.modal", event => { if (installationPending) event.preventDefault(); });
  $("aftercareBookingModal").addEventListener("hide.bs.modal", event => { if (bookingPending) event.preventDefault(); });
  $("aftercareBookingSubmit").addEventListener("click", bookMaintenance);
  $("aftercareBookingChangeLocation").addEventListener("click", () => {
    if (bookingPending || bookingLocationLoading) return;
    $("aftercareBookingSavedLocation").hidden = true;
    $("aftercareBookingLocationEditor").hidden = false;
    initializeBookingMap();
    $("aftercareBookingAddress").focus();
  });
  $("aftercareBookingUseSavedLocation").addEventListener("click", () => {
    if (bookingPending || !bookingSavedLocation) return;
    ++bookingLocationSequence;
    bookingLocationLoading = false;
    bookingPinSource = "saved";
    bookingLocation = { lat: bookingSavedLocation.lat, lng: bookingSavedLocation.lng };
    $("aftercareBookingAddress")._addressAutocomplete?.close();
    $("aftercareBookingAddress").value = bookingSavedLocation.address;
    $("aftercareBookingLocationEditor").hidden = true;
    $("aftercareBookingSavedLocation").hidden = false;
    updateBookingLocationState();
  });
  $("aftercareBookingModal").addEventListener("shown.bs.modal", initializeBookingMap);
  $("aftercareBookingModal").addEventListener("hidden.bs.modal", () => { ++bookingLocationSequence; });
  const addressInput = $("aftercareBookingAddress");
  function addressChanged() {
    ++bookingLocationSequence;
    bookingLocationLoading = false;
    if (bookingPinSource !== "map") {
      bookingLocation = null;
      if (bookingMarker) { bookingMarker.remove(); bookingMarker = null; }
    }
    updateBookingLocationState(bookingLocation ? "Map pin selected. Check that the address matches." : "Select an address suggestion or place a new map pin.");
  }
  if (window.AddressAutocomplete) {
    AddressAutocomplete.create({ input: addressInput, list: $("aftercareBookingSuggestions"), onInput: addressChanged,
      onSelect: result => {
        if (bookingPending) return;
        ++bookingLocationSequence;
        bookingLocationLoading = false;
        bookingPinSource = "suggestion";
        bookingLocation = { lat: Number(result.lat), lng: Number(result.lon) };
        drawBookingPin();
        updateBookingLocationState("Location selected. Check the address and map pin.");
      },
    });
  } else addressInput.addEventListener("input", addressChanged);
  document.querySelectorAll(".js-aftercare-retry").forEach(button => button.addEventListener("click", load));

  load();
})();

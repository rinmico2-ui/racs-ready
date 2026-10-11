(function () {
  const requestedStatus = new URLSearchParams(window.location.search).get("status");
  const allowedStatuses = ["all", "upcoming", "due", "overdue", "responses", "scheduled", "completed", "paused"];
  const state = { status: allowedStatuses.includes(requestedStatus) ? requestedStatus : "all", search: "", page: 1, pages: 1, rows: new Map(), selectedId: null, timer: null, services: [] };
  const $ = (id) => document.getElementById(id);
  const staffPath = $("maintenanceAdminApp").dataset.staffRole === "secretary" ? "/secretary" : "/admin";
  const canManage = $("maintenanceAdminApp").dataset.canManage !== "false";
  let bookingPending = false, previewPending = false, previewController = null, previewSequence = 0, previewTimer = null;
  let bookingLocation = null, savedLocation = null, companyLocation = null, bookingMap = null, bookingMarker = null;
  let pinSource = "saved", locationSequence = 0, locationPending = false;
  const localDateTime = value => {
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const todayManila = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const money = value => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(Number(value || 0));
  // Bootstrap ignores hide() while a modal is still opening.
  for (const id of ["maintenanceDetailModal", "maintenanceBookingModal"]) {
    $(id).addEventListener("show.bs.modal", () => { $(id).dataset.opening = "true"; });
    $(id).addEventListener("shown.bs.modal", () => { $(id).dataset.opening = "false"; });
  }
  function hideModal(id) {
    const element = $(id);
    if (element.dataset.opening === "true") element.addEventListener("shown.bs.modal", () => bootstrap.Modal.getOrCreateInstance(element).hide(), { once: true });
    else bootstrap.Modal.getOrCreateInstance(element).hide();
  }
  const escapeHtml = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const formatDate = (value) => value ? new Date(value).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }) : "Not set";
  const inputDate = (value) => value ? new Date(value).toISOString().slice(0, 10) : "";
  const outreachLabel = (value) => String(value || "not_contacted").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  const responseLabel = (value) => ({
    booking_started: "Ready to book",
    callback_requested: "Callback requested",
    remind_later: "Reminder requested",
    declined: "Not booking now",
  })[String(value || "")] || "No response";

  function customerName(customer) {
    return customer?.name || [customer?.firstName, customer?.lastName].filter(Boolean).join(" ") || "Customer";
  }

  function equipmentLabel(asset) {
    const equipment = asset?.equipment || {};
    return [equipment.brand, equipment.model, equipment.capacity ? `${equipment.capacity} ${equipment.capacityUnit || "HP"}` : ""].filter(Boolean).join(" ") || equipment.applianceTypeName || "Air-conditioning unit";
  }

  function setSummary(summary) {
    $("maintKpiDueSoon").textContent = summary.dueSoon || 0;
    $("maintKpiDue").textContent = summary.due || 0;
    $("maintKpiOverdue").textContent = summary.overdue || 0;
    $("maintKpiResponses").textContent = summary.responses || 0;
    $("maintKpiScheduled").textContent = summary.scheduled || 0;
    $("maintKpiCompleted").textContent = summary.completed || 0;
  }

  function renderRows(rows) {
    state.rows = new Map(rows.map((row) => [String(row._id), row]));
    $("maintenanceRows").innerHTML = rows.map((row) => {
      const asset = row.assetId || {};
      const customer = row.customerId || {};
      const booking = row.bookingId;
      const customerResponse = row.customerResponse || {};
      const responseBadge = ["booking_started", "callback_requested", "remind_later", "declined"].includes(customerResponse.status)
        ? `<div class="mt-1"><span class="badge bg-light text-dark border"><i class="bi bi-chat-square-check me-1"></i>${escapeHtml(responseLabel(customerResponse.status))}</span></div>`
        : "";
      return `<tr>
        <td><div class="maintenance-primary">${escapeHtml(customerName(customer))}</div><div class="maintenance-secondary">${escapeHtml(customer.phone || customer.email || "No contact")}</div><div class="mt-1"><span class="badge bg-light text-dark border">${escapeHtml(outreachLabel(row.outreach?.status))}</span></div>${responseBadge}</td>
        <td><div class="maintenance-primary">${escapeHtml(equipmentLabel(asset))}</div><div class="maintenance-secondary">${escapeHtml(asset.equipment?.unitLabel || "Unit")} ${asset.equipment?.serialNumber ? `| SN ${escapeHtml(asset.equipment.serialNumber)}` : ""}</div></td>
        <td><div class="maintenance-primary">${escapeHtml(asset.originReference || "-")}</div><div class="maintenance-secondary">${escapeHtml(asset.originType || "record")}</div></td>
        <td><div class="maintenance-primary">${formatDate(row.dueDate)}</div><div class="maintenance-secondary">Cycle ${Number(row.cycleNumber || 1)}</div></td>
        <td>${Number(row.intervalDays || 90)} days</td>
        <td><span class="maintenance-status ${escapeHtml(row.status)}"><i class="bi bi-circle-fill" style="font-size:.38rem"></i>${escapeHtml(row.status)}</span></td>
        <td>${booking ? `<a href="${staffPath}/appointments?highlight=${encodeURIComponent(booking._id)}" class="maintenance-primary text-decoration-none">${escapeHtml(booking.bookingReference || "View booking")}</a><div class="maintenance-secondary">${escapeHtml(booking.status || "")}</div>` : '<span class="text-muted">Not booked</span>'}</td>
        <td><button class="btn btn-sm btn-outline-secondary js-maint-detail" data-id="${row._id}" title="View or edit schedule"><i class="bi bi-eye"></i></button></td>
      </tr>`;
    }).join("");
    $("maintenanceTableWrap").classList.toggle("d-none", rows.length === 0);
    $("maintenanceEmpty").classList.toggle("d-none", rows.length !== 0);
  }

  let listController = null;
  let listRequest = 0;
  async function load() {
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    const request = ++listRequest;
    $("maintenancePageInfo").textContent = "Loading maintenance schedules...";
    const params = new URLSearchParams({ status: state.status, search: state.search, page: state.page, limit: 25 });
    try {
      const response = await fetch(`/api/maintenance/admin/overview?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (request !== listRequest) return;
      if (!response.ok) throw new Error(data.error || "Unable to load maintenance schedules.");
      setSummary(data.summary || {});
      state.pages = Math.max(1, data.pages || 1);
      renderRows(data.schedules || []);
      const start = data.total ? ((data.page - 1) * 25) + 1 : 0;
      const end = Math.min(data.total || 0, data.page * 25);
      $("maintenancePageInfo").textContent = `${start}-${end} of ${data.total || 0} schedules`;
      $("maintenancePrev").disabled = state.page <= 1;
      $("maintenanceNext").disabled = state.page >= state.pages;
    } catch (error) {
      if (error.name === 'AbortError' || request !== listRequest) return;
      renderRows([]);
      $("maintenancePageInfo").textContent = error.message;
    }
  }

  function openDetail(id) {
    const row = state.rows.get(String(id));
    if (!row) return;
    state.selectedId = String(id);
    const asset = row.assetId || {};
    const customer = row.customerId || {};
    const locked = !canManage || ["scheduled", "completed"].includes(row.status) || Boolean(row.bookingId);
    const openCycle = canManage && ["upcoming", "due", "overdue"].includes(row.status) && !row.bookingId;
    const outreach = row.outreach || {};
    const customerResponse = row.customerResponse || {};
    $("maintenanceDetailBody").innerHTML = `
      <div class="mb-3"><div class="maintenance-primary">${escapeHtml(equipmentLabel(asset))}</div><div class="maintenance-secondary">${escapeHtml(asset.originReference || "")} | ${escapeHtml(asset.serviceAddress || "No address recorded")}</div></div>
      <div class="border rounded-3 p-3 mb-3 bg-light">
        <div class="d-flex justify-content-between align-items-start gap-3 flex-wrap">
          <div><div class="maintenance-primary">${escapeHtml(customerName(customer))}</div><div class="maintenance-secondary">${escapeHtml(customer.phone || "No phone")} &middot; ${escapeHtml(customer.email || "No email")}</div></div>
          <div class="d-flex gap-2">${customer.phone ? `<a class="btn btn-sm btn-outline-primary" href="tel:${escapeHtml(customer.phone)}"><i class="bi bi-telephone me-1"></i>Call</a>` : ""}${customer.email ? `<a class="btn btn-sm btn-outline-primary" href="mailto:${escapeHtml(customer.email)}"><i class="bi bi-envelope me-1"></i>Email</a>` : ""}</div>
        </div>
      </div>
      ${customerResponse.status && customerResponse.status !== "none" ? `<div class="border border-warning-subtle rounded-3 p-3 mb-3 bg-warning-subtle">
        <div class="d-flex justify-content-between align-items-start gap-3"><div><div class="maintenance-secondary">Customer aftercare response</div><div class="maintenance-primary">${escapeHtml(responseLabel(customerResponse.status))}</div></div><span class="maintenance-secondary">${formatDate(customerResponse.respondedAt)}</span></div>
        ${customerResponse.remindAt ? `<div class="maintenance-secondary mt-2">Preferred time: ${escapeHtml(new Date(customerResponse.remindAt).toLocaleString("en-PH"))}</div>` : ""}
        ${customerResponse.note ? `<div class="small mt-2">${escapeHtml(customerResponse.note)}</div>` : ""}
      </div>` : ""}
      ${openCycle ? `<div class="border rounded-3 p-3 mb-3">
        <div class="maintenance-primary mb-2">Customer follow-up</div>
        <div class="row g-3">
          <div class="col-sm-6"><label class="form-label">Response</label><select class="form-select" id="maintOutreachStatus">${["not_contacted","contacted","interested","callback_requested","declined","unreachable"].map((status) => `<option value="${status}" ${String(outreach.status || "not_contacted") === status ? "selected" : ""}>${outreachLabel(status)}</option>`).join("")}</select></div>
          <div class="col-sm-6"><label class="form-label">Contact method</label><select class="form-select" id="maintOutreachMethod">${["phone","email","sms","in_person","other"].map((method) => `<option value="${method}" ${String(outreach.method || "phone") === method ? "selected" : ""}>${outreachLabel(method)}</option>`).join("")}</select></div>
          <div class="col-sm-6"><label class="form-label">Next follow-up</label><input class="form-control" id="maintOutreachFollowUp" type="datetime-local" value="${outreach.nextFollowUpAt ? localDateTime(outreach.nextFollowUpAt) : ""}"></div>
          <div class="col-12"><label class="form-label">Contact notes</label><textarea class="form-control" id="maintOutreachNotes" rows="2" maxlength="1000" placeholder="Outcome and customer instructions">${escapeHtml(outreach.notes || "")}</textarea></div>
        </div>
      </div>` : ""}
      <div class="row g-3">
        <div class="col-sm-6"><label class="form-label">Due date</label><input class="form-control" id="maintEditDueDate" type="date" value="${inputDate(row.dueDate)}" ${locked ? "disabled" : ""}></div>
        <div class="col-sm-6"><label class="form-label">Interval days</label><input class="form-control" id="maintEditInterval" type="number" min="30" max="730" value="${Number(row.intervalDays || 90)}" ${locked ? "disabled" : ""}></div>
        <div class="col-12"><label class="form-label">Status</label><select class="form-select" id="maintEditStatus" ${locked ? "disabled" : ""}>
          ${["upcoming", "due", "overdue", "paused", "cancelled"].map((status) => `<option value="${status}" ${row.status === status ? "selected" : ""}>${status.replace(/_/g, " ")}</option>`).join("")}
        </select></div>
        <div class="col-12"><label class="form-label">Change reason</label><textarea class="form-control" id="maintEditReason" rows="2" maxlength="500" placeholder="Reason for changing this schedule" ${locked ? "disabled" : ""}></textarea></div>
      </div>
      ${locked ? '<div class="alert alert-light border mt-3 mb-0 small">Scheduled and completed cycles are controlled by their linked booking and cannot be manually rewritten.</div>' : ""}`;
    $("maintenanceSaveBtn").classList.toggle("d-none", locked);
    $("maintenanceOutreachBtn").classList.toggle("d-none", !openCycle);
    $("maintenanceBookBtn").classList.toggle("d-none", !openCycle);
    bootstrap.Modal.getOrCreateInstance($("maintenanceDetailModal")).show();
  }

  async function saveDetail() {
    if (!state.selectedId || !canManage) return;
    const button = $("maintenanceSaveBtn");
    button.disabled = true;
    try {
      const response = await fetch(`/api/maintenance/admin/schedules/${state.selectedId}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dueDate: $("maintEditDueDate").value,
          intervalDays: Number($("maintEditInterval").value),
          status: $("maintEditStatus").value,
          reason: $("maintEditReason").value.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to update schedule.");
      hideModal("maintenanceDetailModal");
      await load();
    } catch (error) {
      alert(error.message);
    } finally { button.disabled = false; }
  }

  async function recordOutreach() {
    if (!state.selectedId || !canManage || !$("maintOutreachStatus")) return;
    const button = $("maintenanceOutreachBtn");
    button.disabled = true;
    try {
      const response = await fetch(`/api/maintenance/admin/schedules/${state.selectedId}/outreach`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: $("maintOutreachStatus").value,
          method: $("maintOutreachMethod").value,
          nextFollowUpAt: $("maintOutreachFollowUp").value ? new Date($("maintOutreachFollowUp").value).toISOString() : null,
          notes: $("maintOutreachNotes").value.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to record customer contact.");
      hideModal("maintenanceDetailModal");
      await load();
    } catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  }

  async function loadBookingOptions() {
    const response = await fetch(`/api/maintenance/admin/booking-options?scheduleId=${encodeURIComponent(state.selectedId)}`, { credentials: "same-origin", cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load maintenance services.");
    state.services = data.services || [];
    return data;
  }

  function selectedBookingService() {
    return state.services.find((service) => String(service._id) === String($("maintenanceBookingService").value));
  }

  function locationReady() {
    return bookingLocation && $("maintenanceBookingAddress").value.trim().length >= 5 && !locationPending;
  }

  function updateSubmit() {
    $("maintenanceCreateBookingBtn").disabled = !canManage || bookingPending || previewPending || !locationReady()
      || !$("maintenanceBookingService").value || !$("maintenanceBookingDate").value || !$("maintenanceBookingTime").value
      || !$("maintenanceCustomerConfirmed").checked;
  }

  function bookingError(message) {
    $("maintenanceBookingError").textContent = message || "";
    $("maintenanceBookingError").classList.toggle("d-none", !message);
  }

  async function loadBookingTimes() {
    clearTimeout(previewTimer);
    previewController?.abort();
    const sequence = ++previewSequence;
    previewPending = false;
    const date = $("maintenanceBookingDate").value;
    const service = selectedBookingService();
    const select = $("maintenanceBookingTime");
    select.innerHTML = '<option value="">Choose a service, location and date</option>';
    $("maintenanceBookingQuote").textContent = "Choose a service and location to see the total.";
    $("maintenanceBookingDuration").value = service ? service.durationMinutes + " minutes" : "\u2014";
    bookingError("");
    updateSubmit();
    if (!service || !locationReady()) return;
    previewController = new AbortController();
    previewPending = true;
    select.innerHTML = '<option value="">Checking available times...</option>';
    $("maintenanceBookingQuote").textContent = "Checking the service price and travel fee...";
    updateSubmit();
    try {
      const response = await fetch("/api/maintenance/admin/schedules/" + encodeURIComponent(state.selectedId) + "/booking-preview", {
        method: "POST", credentials: "same-origin", signal: previewController.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: service._id, date, location: { ...bookingLocation, address: $("maintenanceBookingAddress").value.trim() } }),
      });
      const data = await response.json();
      if (sequence !== previewSequence) return;
      if (!response.ok) throw new Error(data.error || "Unable to check the price and available times.");
      $("maintenanceBookingDuration").value = data.durationMinutes + " minutes";
      $("maintenanceBookingQuote").innerHTML = '<div class="d-flex justify-content-between gap-3"><span>Total after service</span><strong>'
        + escapeHtml(money(data.total)) + '</strong></div><div class="mt-1">Service ' + escapeHtml(money(data.servicePrice))
        + ' &middot; Travel fee ' + escapeHtml(money(data.travelFare)) + '</div><div class="mt-1">No payment needed now.</div>';
      const slots = (data.timeSlots || []).filter(slot => slot.available === true);
      select.innerHTML = !date ? '<option value="">Choose a date</option>' : slots.length
        ? '<option value="">Select available time</option>' + slots.map(slot => '<option value="' + escapeHtml(slot.startTime) + '">' + escapeHtml(slot.startTime) + '</option>').join("")
        : '<option value="">No available times on this date</option>';
    } catch (error) {
      if (error.name === "AbortError" || sequence !== previewSequence) return;
      select.innerHTML = '<option value="">Unable to load times</option>';
      $("maintenanceBookingQuote").textContent = "Price and available times could not be checked.";
      bookingError(error.message);
    } finally { if (sequence === previewSequence) { previewPending = false; updateSubmit(); } }
  }

  function drawPin() {
    if (!bookingMap || !bookingLocation) return;
    const point = [bookingLocation.lat, bookingLocation.lng];
    if (!bookingMarker) {
      const icon = L.divIcon({ className: "", html: '<span class="maintenance-pin"></span>', iconSize: [22,22], iconAnchor: [11,22] });
      bookingMarker = L.marker(point, { draggable: true, icon, title: "Service location" }).addTo(bookingMap);
      bookingMarker.on("dragend", () => { const point = bookingMarker.getLatLng(); selectPin(point.lat, point.lng); });
    } else bookingMarker.setLatLng(point);
    bookingMap.setView(point, 16);
  }

  function showMap() {
    if ($("maintenanceLocationEditor").hidden) return;
    if (typeof L === "undefined") {
      $("maintenanceLocationHelp").textContent = "The map could not load. Choose a suggested address to set the location.";
      return;
    }
    if (!bookingMap) {
      bookingMap = L.map("maintenanceBookingMap", { scrollWheelZoom: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(bookingMap);
      bookingMap.on("click", event => selectPin(event.latlng.lat, event.latlng.lng));
    }
    bookingMap.invalidateSize();
    const center = bookingLocation || companyLocation || { lat: 15.3593, lng: 120.9578 };
    bookingMap.setView([center.lat, center.lng], bookingLocation ? 16 : 11);
    drawPin();
  }

  async function selectPin(lat, lng) {
    if (bookingPending) return;
    if (lat < 4.5 || lat > 21.5 || lng < 116 || lng > 127) {
      $("maintenanceLocationHelp").textContent = "Choose a location in the Philippines.";
      return;
    }
    const sequence = ++locationSequence;
    pinSource = "map";
    bookingLocation = { lat, lng };
    locationPending = true;
    $("maintenanceBookingAddress").value = "";
    $("maintenanceBookingAddress")._addressAutocomplete?.close();
    drawPin();
    loadBookingTimes();
    $("maintenanceLocationHelp").textContent = "Finding the address for this pin...";
    try {
      const response = await fetch("/api/geocoding/reverse?lat=" + lat + "&lon=" + lng, { credentials: "same-origin" });
      const data = await response.json();
      if (response.ok && sequence === locationSequence) $("maintenanceBookingAddress").value = String(data.display_name || "").slice(0, 500);
    } catch (_) { /* Keep a valid pin so staff can enter its address. */ }
    finally {
      if (sequence === locationSequence) {
        locationPending = false;
        $("maintenanceLocationHelp").textContent = "Pin selected. Check or enter the full address.";
        loadBookingTimes();
      }
    }
  }

  async function openMaintenanceBooking() {
    const row = state.rows.get(String(state.selectedId));
    if (!row || !canManage || bookingPending) return;
    const button = $("maintenanceBookBtn");
    if (button.disabled) return;
    button.disabled = true;
    try {
      const data = await loadBookingOptions();
      if (!state.services.length) throw new Error("No maintenance price is set for this aircon type and HP.");
      previewController?.abort(); ++previewSequence; ++locationSequence;
      previewPending = locationPending = false;
      bookingLocation = data.location?.lat != null && data.location?.lng != null ? data.location : null;
      savedLocation = bookingLocation && String(bookingLocation.address || "").trim().length >= 5 ? { ...bookingLocation } : null;
      companyLocation = data.companyLocation?.lat != null ? data.companyLocation : null;
      pinSource = "saved";
      bookingMarker?.remove(); bookingMarker = null;
      $("maintenanceBookingAddress")._addressAutocomplete?.close();
      $("maintenanceBookingService").innerHTML = '<option value="">Select maintenance service</option>' + state.services.map(service =>
        '<option value="' + escapeHtml(service._id) + '">' + escapeHtml(service.name) + ' &middot; ' + escapeHtml(money(service.price)) + '</option>').join("");
      $("maintenanceBookingCustomer").textContent = customerName(row.customerId) + " \u00b7 " + equipmentLabel(row.assetId);
      $("maintenanceBookingDate").min = todayManila();
      $("maintenanceBookingDate").value = "";
      $("maintenanceBookingAddress").value = data.location?.address || "";
      $("maintenanceSavedAddress").textContent = savedLocation?.address || "";
      $("maintenanceSavedLocation").hidden = !savedLocation;
      $("maintenanceLocationEditor").hidden = Boolean(savedLocation);
      $("maintenanceUseSavedLocation").hidden = !savedLocation;
      $("maintenanceLocationHelp").textContent = data.missingLocationReason === "store_pickup"
        ? "This aircon was picked up at the store. Choose its home service location once; it will be saved for future visits."
        : "Choose an address suggestion or tap the map to set the service location.";
      $("maintenanceBookingNotes").value = row.outreach?.notes || "";
      $("maintenanceBookingMethod").value = row.outreach?.method || "phone";
      $("maintenanceCustomerConfirmed").checked = false;
      loadBookingTimes();
      const detail = $("maintenanceDetailModal");
      detail.addEventListener("hidden.bs.modal", () => bootstrap.Modal.getOrCreateInstance($("maintenanceBookingModal")).show(), { once: true });
      hideModal("maintenanceDetailModal");
    } catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  }

  async function createMaintenanceBooking() {
    updateSubmit();
    if (!state.selectedId || bookingPending || $("maintenanceCreateBookingBtn").disabled) return;
    const body = {
      serviceId: $("maintenanceBookingService").value, date: $("maintenanceBookingDate").value,
      startTime: $("maintenanceBookingTime").value,
      location: { ...bookingLocation, address: $("maintenanceBookingAddress").value.trim() },
      method: $("maintenanceBookingMethod").value, notes: $("maintenanceBookingNotes").value.trim(),
      customerConfirmed: $("maintenanceCustomerConfirmed").checked,
    };
    bookingPending = true;
    const button = $("maintenanceCreateBookingBtn"), original = button.innerHTML;
    const controls = [...$("maintenanceBookingModal").querySelectorAll("input,select,textarea,button")];
    const disabledStates = controls.map(control => control.disabled);
    controls.forEach(control => control.disabled = true);
    bookingMarker?.dragging?.disable();
    $("maintenanceBookingAddress")._addressAutocomplete?.close();
    bookingError("");
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Creating booking...';
    try {
      const response = await fetch("/api/maintenance/admin/schedules/" + encodeURIComponent(state.selectedId) + "/book", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to create the maintenance booking.");
      bookingPending = false;
      hideModal("maintenanceBookingModal");
      const banner = $("maintenanceStaffAlert");
      banner.innerHTML = 'Maintenance booking ' + escapeHtml(data.booking.bookingReference || "") + ' saved. No downpayment is needed. <a class="alert-link" href="'
        + staffPath + '/appointments?tab=queue&highlight=' + encodeURIComponent(data.booking._id) + '">View booking</a>';
      banner.classList.remove("d-none");
      await load();
      banner.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (error) { bookingError(error.message); }
    finally {
      bookingPending = false;
      controls.forEach((control, index) => control.disabled = disabledStates[index]);
      bookingMarker?.dragging?.enable();
      button.innerHTML = original;
      updateSubmit();
    }
  }

  $("maintenanceBookingModal").addEventListener("shown.bs.modal", showMap);
  $("maintenanceBookingModal").addEventListener("hide.bs.modal", event => { if (bookingPending) event.preventDefault(); });
  $("maintenanceBookingModal").addEventListener("hidden.bs.modal", () => {
    clearTimeout(previewTimer);
    previewController?.abort(); ++previewSequence; ++locationSequence;
    $("maintenanceBookingAddress")._addressAutocomplete?.close();
  });
  $("maintenanceChangeLocation").addEventListener("click", () => {
    $("maintenanceSavedLocation").hidden = true;
    $("maintenanceLocationEditor").hidden = false;
    showMap();
  });
  $("maintenanceUseSavedLocation").addEventListener("click", () => {
    if (!savedLocation || bookingPending) return;
    ++locationSequence; locationPending = false; pinSource = "saved";
    bookingLocation = { ...savedLocation };
    $("maintenanceBookingAddress").value = savedLocation.address;
    $("maintenanceBookingAddress")._addressAutocomplete?.close();
    $("maintenanceSavedLocation").hidden = false;
    $("maintenanceLocationEditor").hidden = true;
    loadBookingTimes();
  });
  const addressChanged = () => {
    if (bookingPending) return;
    ++locationSequence; locationPending = false;
    if (pinSource !== "map") { bookingLocation = null; bookingMarker?.remove(); bookingMarker = null; }
    previewController?.abort(); ++previewSequence;
    previewPending = true;
    $("maintenanceBookingTime").innerHTML = '<option value="">Check the new address first</option>';
    updateSubmit();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(loadBookingTimes, 350);
  };
  if (typeof AddressAutocomplete !== "undefined") AddressAutocomplete.create({
    input: $("maintenanceBookingAddress"), list: $("maintenanceAddressSuggestions"), onInput: addressChanged,
    onSelect: result => {
      if (bookingPending) return;
      ++locationSequence; locationPending = false; pinSource = "suggestion";
      bookingLocation = { lat: Number(result.lat), lng: Number(result.lon) };
      drawPin();
      $("maintenanceLocationHelp").textContent = "Location selected. Check the address and map pin.";
      loadBookingTimes();
    },
  });
  else $("maintenanceBookingAddress").addEventListener("input", addressChanged);
  $("maintenanceCustomerConfirmed").addEventListener("change", updateSubmit);
  $("maintenanceBookingTime").addEventListener("change", updateSubmit);


  document.querySelectorAll(".maintenance-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.status === state.status);
    button.addEventListener("click", () => {
    document.querySelectorAll(".maintenance-tab").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.status = button.dataset.status;
    state.page = 1;
    load();
    });
  });
  $("maintenanceRows").addEventListener("click", (event) => {
    const button = event.target.closest(".js-maint-detail");
    if (button) openDetail(button.dataset.id);
  });
  $("maintenanceSearch").addEventListener("input", (event) => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { state.search = event.target.value.trim(); state.page = 1; load(); }, 300);
  });
  $("maintenancePrev").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; load(); } });
  $("maintenanceNext").addEventListener("click", () => { if (state.page < state.pages) { state.page += 1; load(); } });
  $("maintenanceRefreshBtn").addEventListener("click", load);
  $("maintenanceSaveBtn").addEventListener("click", saveDetail);
  $("maintenanceOutreachBtn").addEventListener("click", recordOutreach);
  $("maintenanceBookBtn").addEventListener("click", openMaintenanceBooking);
  $("maintenanceBookingService").addEventListener("change", loadBookingTimes);
  $("maintenanceBookingDate").addEventListener("change", loadBookingTimes);
  $("maintenanceCreateBookingBtn").addEventListener("click", createMaintenanceBooking);
  load();
})();

(function () {
  const requestedStatus = new URLSearchParams(window.location.search).get("status");
  const allowedStatuses = ["all", "upcoming", "due", "overdue", "scheduled", "completed", "paused"];
  const state = { status: allowedStatuses.includes(requestedStatus) ? requestedStatus : "all", search: "", page: 1, pages: 1, rows: new Map(), selectedId: null, timer: null, services: [] };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const formatDate = (value) => value ? new Date(value).toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }) : "Not set";
  const inputDate = (value) => value ? new Date(value).toISOString().slice(0, 10) : "";
  const outreachLabel = (value) => String(value || "not_contacted").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

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
    $("maintKpiScheduled").textContent = summary.scheduled || 0;
    $("maintKpiCompleted").textContent = summary.completed || 0;
  }

  function renderRows(rows) {
    state.rows = new Map(rows.map((row) => [String(row._id), row]));
    $("maintenanceRows").innerHTML = rows.map((row) => {
      const asset = row.assetId || {};
      const customer = row.customerId || {};
      const booking = row.bookingId;
      return `<tr>
        <td><div class="maintenance-primary">${escapeHtml(customerName(customer))}</div><div class="maintenance-secondary">${escapeHtml(customer.phone || customer.email || "No contact")}</div><div class="mt-1"><span class="badge bg-light text-dark border">${escapeHtml(outreachLabel(row.outreach?.status))}</span></div></td>
        <td><div class="maintenance-primary">${escapeHtml(equipmentLabel(asset))}</div><div class="maintenance-secondary">${escapeHtml(asset.equipment?.unitLabel || "Unit")} ${asset.equipment?.serialNumber ? `| SN ${escapeHtml(asset.equipment.serialNumber)}` : ""}</div></td>
        <td><div class="maintenance-primary">${escapeHtml(asset.originReference || "-")}</div><div class="maintenance-secondary">${escapeHtml(asset.originType || "record")}</div></td>
        <td><div class="maintenance-primary">${formatDate(row.dueDate)}</div><div class="maintenance-secondary">Cycle ${Number(row.cycleNumber || 1)}</div></td>
        <td>${Number(row.intervalDays || 90)} days</td>
        <td><span class="maintenance-status ${escapeHtml(row.status)}"><i class="bi bi-circle-fill" style="font-size:.38rem"></i>${escapeHtml(row.status)}</span></td>
        <td>${booking ? `<a href="/admin/appointments?highlight=${encodeURIComponent(booking._id)}" class="maintenance-primary text-decoration-none">${escapeHtml(booking.bookingReference || "View booking")}</a><div class="maintenance-secondary">${escapeHtml(booking.status || "")}</div>` : '<span class="text-muted">Not booked</span>'}</td>
        <td><button class="btn btn-sm btn-outline-secondary js-maint-detail" data-id="${row._id}" title="View or edit schedule"><i class="bi bi-eye"></i></button></td>
      </tr>`;
    }).join("");
    $("maintenanceTableWrap").classList.toggle("d-none", rows.length === 0);
    $("maintenanceEmpty").classList.toggle("d-none", rows.length !== 0);
  }

  async function load() {
    $("maintenancePageInfo").textContent = "Loading maintenance schedules...";
    const params = new URLSearchParams({ status: state.status, search: state.search, page: state.page, limit: 25 });
    try {
      const response = await fetch(`/api/maintenance/admin/overview?${params}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
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
    const locked = ["scheduled", "completed"].includes(row.status);
    const openCycle = ["upcoming", "due", "overdue"].includes(row.status) && !row.bookingId;
    const outreach = row.outreach || {};
    $("maintenanceDetailBody").innerHTML = `
      <div class="mb-3"><div class="maintenance-primary">${escapeHtml(equipmentLabel(asset))}</div><div class="maintenance-secondary">${escapeHtml(asset.originReference || "")} | ${escapeHtml(asset.serviceAddress || "No address recorded")}</div></div>
      <div class="border rounded-3 p-3 mb-3 bg-light">
        <div class="d-flex justify-content-between align-items-start gap-3 flex-wrap">
          <div><div class="maintenance-primary">${escapeHtml(customerName(customer))}</div><div class="maintenance-secondary">${escapeHtml(customer.phone || "No phone")} &middot; ${escapeHtml(customer.email || "No email")}</div></div>
          <div class="d-flex gap-2">${customer.phone ? `<a class="btn btn-sm btn-outline-primary" href="tel:${escapeHtml(customer.phone)}"><i class="bi bi-telephone me-1"></i>Call</a>` : ""}${customer.email ? `<a class="btn btn-sm btn-outline-primary" href="mailto:${escapeHtml(customer.email)}"><i class="bi bi-envelope me-1"></i>Email</a>` : ""}</div>
        </div>
      </div>
      ${openCycle ? `<div class="border rounded-3 p-3 mb-3">
        <div class="maintenance-primary mb-2">Customer follow-up</div>
        <div class="row g-3">
          <div class="col-sm-6"><label class="form-label">Response</label><select class="form-select" id="maintOutreachStatus">${["not_contacted","contacted","interested","callback_requested","declined","unreachable"].map((status) => `<option value="${status}" ${String(outreach.status || "not_contacted") === status ? "selected" : ""}>${outreachLabel(status)}</option>`).join("")}</select></div>
          <div class="col-sm-6"><label class="form-label">Contact method</label><select class="form-select" id="maintOutreachMethod">${["phone","email","sms","in_person","other"].map((method) => `<option value="${method}" ${String(outreach.method || "phone") === method ? "selected" : ""}>${outreachLabel(method)}</option>`).join("")}</select></div>
          <div class="col-sm-6"><label class="form-label">Next follow-up</label><input class="form-control" id="maintOutreachFollowUp" type="datetime-local" value="${outreach.nextFollowUpAt ? new Date(outreach.nextFollowUpAt).toISOString().slice(0,16) : ""}"></div>
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
    if (!state.selectedId) return;
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
      bootstrap.Modal.getOrCreateInstance($("maintenanceDetailModal")).hide();
      await load();
    } catch (error) {
      alert(error.message);
    } finally { button.disabled = false; }
  }

  async function recordOutreach() {
    if (!state.selectedId || !$("maintOutreachStatus")) return;
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
          nextFollowUpAt: $("maintOutreachFollowUp").value || null,
          notes: $("maintOutreachNotes").value.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to record customer contact.");
      bootstrap.Modal.getOrCreateInstance($("maintenanceDetailModal")).hide();
      await load();
    } catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  }

  async function loadBookingOptions() {
    const response = await fetch(`/api/maintenance/admin/booking-options?scheduleId=${encodeURIComponent(state.selectedId)}`, { credentials: "same-origin", cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load maintenance services.");
    state.services = data.services || [];
    return state.services;
  }

  function selectedBookingService() {
    return state.services.find((service) => String(service._id) === String($("maintenanceBookingService").value));
  }

  async function loadBookingTimes() {
    const date = $("maintenanceBookingDate").value;
    const service = selectedBookingService();
    const select = $("maintenanceBookingTime");
    $("maintenanceBookingDuration").value = service ? `${Number(service.durationMinutes || 90)} minutes` : "—";
    if (!date || !service) { select.innerHTML = '<option value="">Choose service and date</option>'; return; }
    select.innerHTML = '<option value="">Loading available times...</option>';
    try {
      const params = new URLSearchParams({ date, duration: String(service.durationMinutes || 90), quantity: "1", travelTime: "0" });
      const response = await fetch(`/api/schedule/time-slots?${params}`, { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load times.");
      const slots = (data.timeSlots || []).filter((slot) => slot.available === true);
      select.innerHTML = slots.length
        ? '<option value="">Select available time</option>' + slots.map((slot) => `<option value="${escapeHtml(slot.startTime)}">${escapeHtml(slot.startTime)}</option>`).join("")
        : '<option value="">No available times</option>';
    } catch (error) { select.innerHTML = `<option value="">${escapeHtml(error.message)}</option>`; }
  }

  async function openMaintenanceBooking() {
    const row = state.rows.get(String(state.selectedId));
    if (!row) return;
    const button = $("maintenanceBookBtn");
    button.disabled = true;
    try {
      const services = await loadBookingOptions();
      if (!services.length) throw new Error("No active maintenance or cleaning service is configured.");
      $("maintenanceBookingService").innerHTML = '<option value="">Select maintenance service</option>' + services.map((service) => `<option value="${escapeHtml(service._id)}">${escapeHtml(service.name)} · ₱${Number(service.price || 0).toLocaleString("en-PH")}</option>`).join("");
      $("maintenanceBookingCustomer").textContent = `${customerName(row.customerId)} · ${equipmentLabel(row.assetId)}`;
      $("maintenanceBookingDate").min = new Date().toISOString().slice(0, 10);
      $("maintenanceBookingDate").value = "";
      $("maintenanceBookingTime").innerHTML = '<option value="">Choose a date</option>';
      $("maintenanceBookingDuration").value = "—";
      $("maintenanceBookingAddress").value = row.assetId?.serviceAddress || "";
      $("maintenanceBookingNotes").value = row.outreach?.notes || "";
      $("maintenanceBookingMethod").value = row.outreach?.method || "phone";
      bootstrap.Modal.getOrCreateInstance($("maintenanceDetailModal")).hide();
      bootstrap.Modal.getOrCreateInstance($("maintenanceBookingModal")).show();
    } catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  }

  async function createMaintenanceBooking() {
    if (!state.selectedId) return;
    const button = $("maintenanceCreateBookingBtn");
    button.disabled = true;
    const original = button.innerHTML;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Creating booking...';
    try {
      const response = await fetch(`/api/maintenance/admin/schedules/${state.selectedId}/book`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: $("maintenanceBookingService").value,
          date: $("maintenanceBookingDate").value,
          startTime: $("maintenanceBookingTime").value,
          address: $("maintenanceBookingAddress").value.trim(),
          method: $("maintenanceBookingMethod").value,
          notes: $("maintenanceBookingNotes").value.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to create the maintenance booking.");
      bootstrap.Modal.getOrCreateInstance($("maintenanceBookingModal")).hide();
      window.location.assign(`/admin/appointments?tab=queue&highlight=${encodeURIComponent(data.booking._id)}`);
    } catch (error) { alert(error.message); }
    finally { button.disabled = false; button.innerHTML = original; }
  }

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

(function () {
  "use strict";

  const state = { page: 1, pages: 1, limit: 25, total: 0, selectionLimit: 500, filter: "open", search: "", rows: new Map(), selectedId: null, selectedIds: new Set(), bulkMode: false, timer: null };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

  function formatDate(value) {
    if (!value) return "Not set";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Not set";
    return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function relativeOverdue(minutes) {
    if (!minutes) return "Due now";
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    if (days) return `${days}d ${hours}h overdue`;
    if (hours) return `${hours}h overdue`;
    return `${minutes}m overdue`;
  }

  async function request(url, options) {
    const response = await fetch(url, { credentials: "same-origin", ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || "Request failed");
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function showAlert(message, kind) {
    const alert = $("erAlert");
    alert.className = `er-alert show ${kind || "success"}`;
    alert.textContent = message;
    window.setTimeout(() => alert.classList.remove("show"), 5000);
  }

  function serviceName(row) {
    const booking = row.bookingId || {};
    if (booking.service?.name) return booking.service.name;
    if (Array.isArray(booking.services) && booking.services.length) return booking.services.map((service) => service.name).filter(Boolean).join(", ");
    return row.projectId?.service?.name || "Service job";
  }

  function rowHtml(row) {
    const tech = row.technicianId || {};
    const booking = row.bookingId || {};
    const customer = booking.customer || row.projectId?.customer || {};
    const code = row.equipmentCode || row.equipmentId?.assetCode || row.equipmentId?.barcode || "No asset code";
    const jobReference = row.bookingReference || booking.bookingReference || (row.projectId ? `Project ${String(row.projectId._id).slice(-6).toUpperCase()}` : "No job reference");
    const statusLabel = row.returnState === "overdue" ? relativeOverdue(row.overdueMinutes) : row.returnState === "due_today" ? "Due today" : "Outstanding";
    const reminder = row.reminderCount ? `${row.reminderCount} sent` : "No reminder yet";
    const lastReminder = row.lastReminderAt ? formatDate(row.lastReminderAt) : "";
    const phone = String(tech.phone || "").replace(/[^+\d]/g, "");
    const jobLink = booking._id ? `/admin/appointments?booking=${encodeURIComponent(booking._id)}` : row.projectId?._id ? `/admin/projects/${encodeURIComponent(row.projectId._id)}` : "";
    const selected = state.selectedIds.has(String(row._id));
    return `<tr class="${row.returnState === "overdue" ? "er-row-overdue" : ""}${selected ? " er-selected" : ""}" data-row-id="${row._id}">
      <td class="er-select-cell"><input class="form-check-input er-row-select" type="checkbox" data-select-id="${row._id}" aria-label="Select ${escapeHtml(row.equipmentName)}" ${selected ? "checked" : ""}></td>
      <td><div class="er-title">${escapeHtml(row.equipmentName)} <span class="text-secondary">×${Number(row.quantity) || 1}</span></div><div class="er-sub"><span class="er-code">${escapeHtml(code)}</span> · checked out ${escapeHtml(formatDate(row.checkedOutAt || row.issuedAt))}</div></td>
      <td><div class="er-title">${escapeHtml(tech.name || "Unassigned technician")}</div><div class="er-sub">${phone ? `<a href="tel:${escapeHtml(phone)}">${escapeHtml(tech.phone)}</a>` : escapeHtml(tech.userEmail || "No contact recorded")}</div></td>
      <td><div class="er-title">${escapeHtml(jobReference)}</div><div class="er-sub">${escapeHtml(serviceName(row))}${customer.name ? ` · ${escapeHtml(customer.name)}` : ""}</div>${jobLink ? `<a class="er-sub d-inline-block mt-1" href="${jobLink}">View job <i class="bi bi-box-arrow-up-right"></i></a>` : ""}</td>
      <td><span class="er-status ${escapeHtml(row.returnState)}"><i class="bi ${row.returnState === "overdue" ? "bi-exclamation-circle" : "bi-clock"}"></i>${escapeHtml(statusLabel)}</span><div class="er-sub">Expected ${escapeHtml(formatDate(row.effectiveExpectedReturnAt))}</div></td>
      <td><div class="er-title">${escapeHtml(reminder)}</div><div class="er-sub">${escapeHtml(lastReminder)}</div></td>
      <td><div class="er-actions"><button class="btn btn-outline-primary" data-action="remind" data-id="${row._id}"><i class="bi bi-bell"></i> Remind</button><button class="btn btn-outline-secondary" data-action="deadline" data-id="${row._id}"><i class="bi bi-calendar2"></i> Deadline</button><button class="btn btn-success" data-action="resolve" data-id="${row._id}"><i class="bi bi-check2-circle"></i> Resolve</button></div></td>
    </tr>`;
  }

  function currentPageIds() {
    return Array.from(state.rows.keys());
  }

  function syncSelectionUI() {
    const pageIds = currentPageIds();
    const selectedOnPage = pageIds.filter((id) => state.selectedIds.has(id));
    const selectedCount = state.selectedIds.size;
    $("erSelectionCount").textContent = `${selectedCount} selected`;
    $("erSelectionHint").textContent = selectedCount
      ? "Bulk reconciliation is limited to returned equipment in good or fair condition."
      : "Select returned equipment to reconcile it together.";
    $("erBulkResolve").disabled = selectedCount === 0;
    $("erClearSelection").disabled = selectedCount === 0;
    $("erSelectAllMatching").disabled = state.total === 0 || selectedCount >= Math.min(state.total, state.selectionLimit);
    $("erSelectAllMatching").innerHTML = `<i class="bi bi-list-check"></i> Select all matching (${Math.min(state.total, state.selectionLimit)})`;
    const selectPage = $("erSelectPage");
    selectPage.checked = pageIds.length > 0 && selectedOnPage.length === pageIds.length;
    selectPage.indeterminate = selectedOnPage.length > 0 && selectedOnPage.length < pageIds.length;
    document.querySelectorAll(".er-row-select").forEach((checkbox) => {
      const selected = state.selectedIds.has(checkbox.dataset.selectId);
      checkbox.checked = selected;
      checkbox.closest("tr")?.classList.toggle("er-selected", selected);
    });
  }

  function clearSelection() {
    state.selectedIds.clear();
    syncSelectionUI();
  }

  function render(payload) {
    state.rows.clear();
    (payload.assignments || []).forEach((row) => state.rows.set(String(row._id), row));
    const summary = payload.summary || {};
    $("erOverdue").textContent = summary.overdue || 0;
    $("erDueToday").textContent = summary.dueToday || 0;
    $("erCheckedOut").textContent = summary.checkedOut || 0;
    $("erReminders").textContent = summary.remindersSent || 0;
    $("erRows").innerHTML = payload.assignments?.length ? payload.assignments.map(rowHtml).join("") : '<tr><td colspan="7" class="er-empty"><i class="bi bi-check2-circle fs-3 d-block mb-2 text-success"></i>No outstanding equipment matches this view.</td></tr>';
    state.pages = payload.pagination?.pages || 1;
    state.page = payload.pagination?.page || 1;
    const total = payload.pagination?.total || 0;
    state.total = total;
    const from = total ? (state.page - 1) * state.limit + 1 : 0;
    const to = Math.min(state.page * state.limit, total);
    $("erRange").textContent = `Showing ${from}–${to} of ${total} outstanding assignment${total === 1 ? "" : "s"}`;
    $("erPrev").disabled = state.page <= 1;
    $("erNext").disabled = state.page >= state.pages;
    syncSelectionUI();
  }

  async function load() {
    $("erRows").innerHTML = '<tr><td colspan="7" class="er-empty"><span class="spinner-border spinner-border-sm"></span> Loading returns…</td></tr>';
    try {
      const params = new URLSearchParams({ state: state.filter, search: state.search, page: state.page, limit: state.limit });
      render(await request(`/api/admin/appointments/equipment-returns?${params}`));
    } catch (error) {
      $("erRows").innerHTML = `<tr><td colspan="7" class="er-empty text-danger"><i class="bi bi-exclamation-triangle d-block fs-3 mb-2"></i>${escapeHtml(error.message)}</td></tr>`;
    }
  }

  async function selectAllMatching(button) {
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Selecting';
    try {
      const params = new URLSearchParams({ state: state.filter, search: state.search, idsOnly: "true" });
      const payload = await request(`/api/admin/appointments/equipment-returns?${params}`);
      state.selectionLimit = payload.selectionLimit || 500;
      state.selectedIds = new Set(payload.ids || []);
      syncSelectionUI();
      if (payload.truncated) showAlert(`Selected the first ${payload.selectionLimit} of ${payload.total} matching assignments. Narrow the filters to process the remainder safely.`, "error");
      else showAlert(`Selected all ${payload.total} matching equipment assignments.`, "success");
    } catch (error) {
      showAlert(error.message, "error");
    } finally {
      button.innerHTML = original;
      syncSelectionUI();
    }
  }

  async function remind(id, button) {
    const row = state.rows.get(id);
    if (!row || !window.confirm(`Send an equipment return reminder to ${row.technicianId?.name || "this technician"}?`)) return;
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
      const result = await request(`/api/admin/appointments/equipment-returns/${encodeURIComponent(id)}/remind`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      showAlert(result.message || "Reminder sent", "success");
      await load();
    } catch (error) {
      const next = error.payload?.nextReminderAt ? ` Try again after ${formatDate(error.payload.nextReminderAt)}.` : "";
      showAlert(error.message + next, "error");
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  function localInputValue(date) {
    const value = new Date(date);
    value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
    return value.toISOString().slice(0, 16);
  }

  function openDeadline(id) {
    const row = state.rows.get(id);
    if (!row) return;
    state.selectedId = id;
    $("erDeadlineItem").textContent = `${row.equipmentName} · ${row.technicianId?.name || "Technician"}`;
    const proposed = new Date(row.effectiveExpectedReturnAt || Date.now());
    if (proposed <= new Date()) proposed.setDate(proposed.getDate() + 1);
    $("erDeadlineAt").value = localInputValue(proposed);
    $("erDeadlineAt").min = localInputValue(new Date(Date.now() + 5 * 60000));
    $("erDeadlineNotes").value = "";
    bootstrap.Modal.getOrCreateInstance($("erDeadlineModal")).show();
  }

  function openResolve(id) {
    const row = state.rows.get(id);
    if (!row) return;
    state.bulkMode = false;
    state.selectedId = id;
    $("erResolveTitle").innerHTML = '<i class="bi bi-clipboard-check me-2"></i>Reconcile equipment';
    Array.from($("erCondition").options).forEach((option) => { option.disabled = false; });
    $("erResolveItem").innerHTML = `<strong>${escapeHtml(row.equipmentName)} ×${Number(row.quantity) || 1}</strong><div class="er-sub">Assigned to ${escapeHtml(row.technicianId?.name || "Technician")} · ${escapeHtml(row.bookingReference || row.bookingId?.bookingReference || "service job")}</div>`;
    $("erCondition").value = "good";
    $("erResolutionNotes").value = "";
    $("erResolveWarning").innerHTML = '<i class="bi bi-info-circle me-1"></i> This action updates available inventory and is recorded in the audit log.';
    syncNotesRequirement();
    bootstrap.Modal.getOrCreateInstance($("erResolveModal")).show();
  }

  function openBulkResolve() {
    const ids = Array.from(state.selectedIds);
    if (!ids.length) return;
    state.bulkMode = true;
    state.selectedId = null;
    const names = ids.map((id) => state.rows.get(id)?.equipmentName).filter(Boolean);
    const previewNames = names.slice(0, 3);
    const remaining = ids.length - previewNames.length;
    $("erResolveTitle").innerHTML = '<i class="bi bi-check2-all me-2"></i>Reconcile selected equipment';
    $("erResolveItem").innerHTML = `<strong>${ids.length} equipment assignment${ids.length === 1 ? "" : "s"} selected</strong><div class="er-sub">${previewNames.map(escapeHtml).join(", ") || "Selected across loaded pages"}${remaining > 0 ? ` and ${remaining} more` : ""}</div>`;
    Array.from($("erCondition").options).forEach((option) => { option.disabled = ["damaged", "lost"].includes(option.value); });
    $("erCondition").value = "good";
    $("erResolutionNotes").value = "";
    $("erResolveWarning").innerHTML = '<i class="bi bi-shield-check me-1"></i> Bulk reconciliation only accepts Good or Fair returns. Resolve damaged or lost equipment individually so each exception has its own notes and audit record.';
    syncNotesRequirement();
    bootstrap.Modal.getOrCreateInstance($("erResolveModal")).show();
  }

  function syncNotesRequirement() {
    const required = ["damaged", "lost"].includes($("erCondition").value);
    $("erResolutionNotes").required = required;
    $("erNotesRequired").classList.toggle("d-none", !required);
    $("erResolveSave").className = `btn ${required ? "btn-danger" : "btn-success"}`;
  }

  document.addEventListener("DOMContentLoaded", function () {
    const requestedState = new URLSearchParams(window.location.search).get("state");
    if (["open", "overdue", "due_today"].includes(requestedState)) {
      state.filter = requestedState;
      $("erState").value = requestedState;
    }
    $("erLimit").value = String(state.limit);
    $("erRefresh").addEventListener("click", load);
    $("erState").addEventListener("change", (event) => { state.filter = event.target.value; state.page = 1; clearSelection(); load(); });
    $("erLimit").addEventListener("change", (event) => { state.limit = Number(event.target.value) || 25; state.page = 1; clearSelection(); load(); });
    $("erSearch").addEventListener("input", (event) => { window.clearTimeout(state.timer); state.timer = window.setTimeout(() => { state.search = event.target.value.trim(); state.page = 1; clearSelection(); load(); }, 350); });
    document.querySelectorAll(".er-metric[data-state]").forEach((button) => button.addEventListener("click", () => { state.filter = button.dataset.state; state.page = 1; $("erState").value = state.filter; clearSelection(); load(); }));
    $("erPrev").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; load(); } });
    $("erNext").addEventListener("click", () => { if (state.page < state.pages) { state.page += 1; load(); } });
    $("erRows").addEventListener("click", (event) => { const button = event.target.closest("button[data-action]"); if (!button) return; if (button.dataset.action === "remind") remind(button.dataset.id, button); if (button.dataset.action === "deadline") openDeadline(button.dataset.id); if (button.dataset.action === "resolve") openResolve(button.dataset.id); });
    $("erRows").addEventListener("change", (event) => {
      const checkbox = event.target.closest(".er-row-select");
      if (!checkbox) return;
      if (checkbox.checked) state.selectedIds.add(checkbox.dataset.selectId);
      else state.selectedIds.delete(checkbox.dataset.selectId);
      syncSelectionUI();
    });
    $("erSelectPage").addEventListener("change", (event) => {
      currentPageIds().forEach((id) => {
        if (event.target.checked) state.selectedIds.add(id);
        else state.selectedIds.delete(id);
      });
      syncSelectionUI();
    });
    $("erClearSelection").addEventListener("click", clearSelection);
    $("erSelectAllMatching").addEventListener("click", (event) => selectAllMatching(event.currentTarget));
    $("erBulkResolve").addEventListener("click", openBulkResolve);
    $("erCondition").addEventListener("change", syncNotesRequirement);
    $("erDeadlineForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = $("erDeadlineSave"); button.disabled = true;
      try {
        await request(`/api/admin/appointments/equipment-returns/${encodeURIComponent(state.selectedId)}/deadline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedReturnAt: new Date($("erDeadlineAt").value).toISOString(), notes: $("erDeadlineNotes").value }) });
        bootstrap.Modal.getInstance($("erDeadlineModal")).hide(); showAlert("Return deadline updated", "success"); await load();
      } catch (error) { showAlert(error.message, "error"); } finally { button.disabled = false; }
    });
    $("erResolveForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const condition = $("erCondition").value;
      const notes = $("erResolutionNotes").value;
      const button = $("erResolveSave");

      if (state.bulkMode) {
        const ids = Array.from(state.selectedIds);
        if (!ids.length) return;
        if (!["good", "fair"].includes(condition)) {
          showAlert("Damaged and lost equipment must be reconciled individually.", "error");
          return;
        }
        if (!window.confirm(`Reconcile ${ids.length} selected equipment assignment${ids.length === 1 ? "" : "s"} as ${condition}? Inventory will be updated immediately.`)) return;
        button.disabled = true;
        const failures = [];
        let completed = 0;
        let processed = 0;
        let nextIndex = 0;
        try {
          async function worker() {
            while (nextIndex < ids.length) {
              const index = nextIndex;
              nextIndex += 1;
              try {
                await request(`/api/admin/appointments/equipment-returns/${encodeURIComponent(ids[index])}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ condition, notes }) });
                completed += 1;
              } catch (error) {
                failures.push({ id: ids[index], message: error.message });
              } finally {
                processed += 1;
                button.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Reconciled ${processed}/${ids.length}`;
              }
            }
          }
          button.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Reconciling 0/${ids.length}`;
          await Promise.all(Array.from({ length: Math.min(4, ids.length) }, () => worker()));
          state.selectedIds = new Set(failures.map((failure) => failure.id));
          bootstrap.Modal.getInstance($("erResolveModal"))?.hide();
          await load();
          if (failures.length) showAlert(`${completed} reconciled; ${failures.length} failed and remain selected. ${failures[0].message}`, "error");
          else showAlert(`${completed} equipment assignment${completed === 1 ? "" : "s"} reconciled successfully.`, "success");
        } finally {
          button.disabled = false;
          button.textContent = "Confirm reconciliation";
          syncNotesRequirement();
        }
        return;
      }

      const row = state.rows.get(state.selectedId);
      if (!window.confirm(`Record ${row?.equipmentName || "equipment"} as ${condition}? Inventory will be updated immediately.`)) return;
      button.disabled = true;
      try {
        const result = await request(`/api/admin/appointments/equipment-returns/${encodeURIComponent(state.selectedId)}/resolve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ condition, notes }) });
        state.selectedIds.delete(state.selectedId);
        bootstrap.Modal.getInstance($("erResolveModal"))?.hide();
        await load();
        showAlert(result.message || "Return recorded", "success");
      } catch (error) {
        showAlert(error.message, "error");
      } finally {
        button.disabled = false;
        button.textContent = "Confirm reconciliation";
        syncNotesRequirement();
      }
    });
    load();
  });
})();

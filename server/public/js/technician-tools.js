/* Equipment custody and usage workspace. */
(() => {
  "use strict";
  const page = document.getElementById("technicianToolsPage");
  if (!page) return;
  const $ = id => document.getElementById(id);
  const state = { tab: "equipment", equipment: [], legacy: [], usage: [], errors: {}, loading: true, selected: null, returning: false, saving: false, deleting: new Set(), optionSequence: 0, loadSequence: 0 };
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const id = value => String(value?._id || value || "");
  const active = row => ["checked_out", "in_use", "assigned"].includes(row.status);
  const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const day = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  };
  const dateLabel = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" });
  };
  const name = row => row.equipmentName || row.equipmentId?.itemName || row.toolName || "Equipment";
  const code = row => row.equipmentCode || row.equipmentId?.assetCode || row.equipmentId?.barcode || row.toolBarcode || "";
  const quantity = row => Number(row.quantity) || 1;
  function context(row) {
    const booking = row.bookingId;
    const orders = (row.orderIds || []).map(order => order.orderReference || order.orderNumber).filter(Boolean);
    const project = row.projectId && (row.projectId.bookingId?.bookingReference || row.projectId.bookingId?.workOrderNumber || row.projectId.service?.name || "Project");
    const links = [booking?.bookingReference || booking?.workOrderNumber, ...orders, project].filter(Boolean);
    const title = links.join(" / ") || (row.dailyKitId ? "Daily Kit" : "General issue");
    const sub = [booking?.customerId?.name, booking?.service?.name, row.dailyKitId?.workDate ? dateLabel(row.dailyKitId.workDate) : row.workDate ? dateLabel(row.workDate) : ""].filter(Boolean).join(" · ");
    return { title, sub };
  }
  const labels = { checked_out: ["In your care", "blue"], in_use: ["In use", "blue"], assigned: ["In your care", "blue"], reserved: ["Reserved", "amber"], returned: ["Returned", "green"], released: ["Released", ""], damaged: ["Damaged", "red"], lost: ["Lost", "red"] };
  function badge(row) {
    const [label, color] = labels[row.status] || ["Recorded", ""];
    return `<span class="tt-badge ${color ? `tt-badge-${color}` : ""}">${label}</span>`;
  }
  function showMessage(message) {
    $("ttNotice").textContent = message;
    $("ttNotice").hidden = false;
  }
  function formError(target, message) {
    $(target).textContent = message || "";
    $(target).hidden = !message;
  }
  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: "same-origin", ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || (response.status === 401 ? "Your session ended. Sign in again." : "Could not save or load this record. Please try again."));
    return data;
  }
  const post = (url, body) => request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  function empty(title, description, retry = false) {
    return `<div class="tt-empty"><i class="bi ${retry ? "bi-wifi-off" : "bi-box-seam"}" aria-hidden="true"></i><h3>${escape(title)}</h3><p>${escape(description)}</p>${retry ? '<button type="button" class="tt-button tt-button-secondary" data-retry>Try again</button>' : ""}</div>`;
  }
  function equipmentRows(rows, history = false) {
    if (!rows.length) return empty($("ttSearch").value.trim() ? "No matching records" : history ? "No equipment history yet" : "No equipment to show", $("ttSearch").value.trim() ? "Try a different name or job reference." : history ? "Returned, damaged, and lost equipment will appear here." : "Equipment issued or reserved for you will appear here.");
    return '<div class="tt-table-head" aria-hidden="true"><span>Equipment</span><span>' + (history ? "Return / issue date" : "Linked work") + '</span><span>Qty</span><span>Status</span><span>Action</span></div>' + rows.map(row => {
      const link = context(row);
      const meta = history ? { title: dateLabel(row.returnedAt || row.returnedDate || row.checkedOutAt || row.assignedDate || row.createdAt), sub: link.title } : link;
      return `<article class="tt-equipment-row"><div class="tt-item"><span class="tt-item-icon"><i class="bi bi-tools" aria-hidden="true"></i></span><div><strong>${escape(name(row))}</strong><small>${escape(code(row) || "No equipment code")}</small></div></div><div class="tt-job"><strong>${escape(meta.title)}</strong><small>${escape(meta.sub)}</small></div><span class="tt-quantity">${quantity(row)}</span><div class="tt-status">${badge(row)}</div>${!history && active(row) && !row.legacy ? `<button type="button" class="tt-row-action" data-return="${escape(id(row._id))}" aria-label="Return ${escape(name(row))}">Return</button>` : `<span class="tt-row-note">${row.legacy && active(row) ? "Admin records this return" : row.status === "reserved" ? "Not issued yet" : escape(row.condition ? `Condition: ${row.condition}` : "")}</span>`}</article>`;
    }).join("");
  }
  function render() {
    const records = $("ttRecords");
    records.setAttribute("aria-busy", String(state.loading));
    $("ttStatus").parentElement.hidden = state.tab !== "equipment";
    $("ttContextHelp").textContent = state.tab === "equipment" ? "Return reusable equipment after the linked work is finished." : state.tab === "usage" ? "Usage records do not change inventory stock." : "Showing the latest 200 equipment records and 100 general tool records.";
    const errorKeys = state.tab === "usage" ? ["usage"] : ["equipment", "legacy"];
    const error = errorKeys.filter(key => state.errors[key]).map(key => state.errors[key]).join(" ");
    if (state.loading) { records.innerHTML = '<div class="tt-empty"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span><p>Loading your records...</p></div>'; return; }
    if (error) { records.innerHTML = empty("Your records could not be loaded", error, true); $("ttResultContext").textContent = "Could not load records"; return; }
    const query = $("ttSearch").value.trim().toLowerCase();
    const all = [...state.equipment, ...state.legacy];
    const filter = row => [name(row), code(row), context(row).title, context(row).sub, row.notes || ""].join(" ").toLowerCase().includes(query);
    if (state.tab === "usage") {
      const rows = state.usage.filter(row => [row.equipmentName, row.equipmentCode, row.notes].join(" ").toLowerCase().includes(query));
      $("ttResultContext").textContent = `${rows.length} usage record${rows.length === 1 ? "" : "s"} · Latest 200 records`;
      if (!rows.length) { records.innerHTML = empty(query ? "No matching records" : "No equipment use recorded", query ? "Try a different equipment name." : "Use Log equipment use to record equipment you used on a work date."); return; }
      let previous = "";
      records.innerHTML = rows.map(row => {
        const date = day(row.date);
        const heading = date !== previous ? `<div class="tt-usage-date">${escape(dateLabel(row.date))}</div>` : "";
        previous = date;
        return heading + `<article class="tt-usage-row"><div class="tt-item"><span class="tt-item-icon"><i class="bi bi-calendar-check" aria-hidden="true"></i></span><div><strong>${escape(row.equipmentName)}</strong><small>${escape(row.equipmentCode || "")}</small>${row.notes ? `<p>${escape(row.notes)}</p>` : ""}</div></div><button type="button" class="tt-delete" data-delete="${escape(id(row._id))}" aria-label="Delete usage record for ${escape(row.equipmentName)}"><i class="bi bi-trash3" aria-hidden="true"></i></button></article>`;
      }).join("");
    } else {
      const rows = all.filter(row => state.tab === "history" ? !active(row) && row.status !== "reserved" : active(row) || row.status === "reserved").filter(row => state.tab !== "equipment" || $("ttStatus").value === "all" || ($("ttStatus").value === "active" ? active(row) : row.status === "reserved")).filter(filter);
      $("ttResultContext").textContent = `${rows.length} equipment record${rows.length === 1 ? "" : "s"}`;
      records.innerHTML = equipmentRows(rows, state.tab === "history");
    }
  }
  async function load() {
    const sequence = ++state.loadSequence;
    state.loading = true;
    $("ttRefresh").disabled = true;
    render();
    const results = await Promise.allSettled([request("/api/technician/equipment"), request("/api/technician/tools/assigned/history"), request("/api/technician/equipment-usage")]);
    if (sequence !== state.loadSequence) return;
    state.errors = {};
    ["equipment", "legacy", "usage"].forEach((key, index) => {
      const result = results[index];
      if (result.status === "fulfilled") state[key] = key === "legacy" ? (result.value.items || []).filter(row => !row.itemType || ["equipment", "tool"].includes(row.itemType)).map(row => ({ ...row, legacy: true })) : result.value.items || [];
      else state.errors[key] = result.reason.message;
      if (key === "usage" && result.status === "fulfilled") state.todayCount = result.value.todayCount;
    });
    const all = [...state.equipment, ...state.legacy];
    const unavailable = state.errors.equipment || state.errors.legacy;
    $("ttActiveCount").textContent = unavailable ? "—" : all.filter(active).reduce((sum, row) => sum + quantity(row), 0);
    $("ttReservedCount").textContent = unavailable ? "—" : all.filter(row => row.status === "reserved").reduce((sum, row) => sum + quantity(row), 0);
    $("ttEquipmentBadge").textContent = unavailable ? "—" : all.filter(row => active(row) || row.status === "reserved").length;
    $("ttUsageCount").textContent = state.errors.usage ? "—" : Number.isInteger(state.todayCount) ? state.todayCount : state.usage.filter(row => day(row.date) === today()).length;
    state.loading = false;
    $("ttRefresh").disabled = false;
    render();
  }
  function tab(value) {
    state.tab = value;
    for (const button of page.querySelectorAll("[data-tab]")) {
      const selected = button.dataset.tab === value;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected) $("ttRecords").setAttribute("aria-labelledby", button.id);
    }
    $("ttSearch").value = "";
    render();
  }
  async function loadOptions() {
    const sequence = ++state.optionSequence;
    $("ttUsageEquipment").disabled = true;
    $("ttUsageSave").disabled = true;
    $("ttUsageEquipment").innerHTML = '<option value="">Loading equipment...</option>';
    formError("ttUsageError", "");
    try {
      const data = await request(`/api/technician/tools/usage-options?date=${encodeURIComponent($("ttUsageDate").value)}`);
      if (sequence !== state.optionSequence) return;
      $("ttUsageEquipment").innerHTML = '<option value="">Choose equipment</option>' + (data.items || []).map(row => `<option value="${escape(row._id)}">${escape(row.name)}${row.code ? ` (${escape(row.code)})` : ""}</option>`).join("");
      $("ttUsageHint").textContent = data.items?.length ? "Only equipment issued to you on this date is listed." : "No equipment was issued to you on this date. Choose another date or ask admin to check the issue record.";
      $("ttUsageEquipment").disabled = !data.items?.length;
      $("ttUsageSave").disabled = !data.items?.length;
    } catch (error) {
      if (sequence !== state.optionSequence) return;
      $("ttUsageEquipment").innerHTML = '<option value="">Equipment could not be loaded</option>';
      formError("ttUsageError", error.message);
      $("ttUsageHint").textContent = "Choose the date again to retry.";
    }
  }
  function busyModal(modalId, busy) {
    $(modalId).querySelectorAll('button, input, select, textarea').forEach(element => { element.disabled = busy; });
  }
  $("ttLogUsage").addEventListener("click", () => {
    $("ttUsageForm").reset();
    $("ttUsageDate").value = today();
    $("ttUsageDate").max = today();
    bootstrap.Modal.getOrCreateInstance($("ttUsageModal")).show();
    loadOptions();
  });
  $("ttUsageDate").addEventListener("change", loadOptions);
  $("ttUsageForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (state.saving || !$("ttUsageForm").reportValidity()) return;
    state.saving = true;
    const body = { equipmentId: $("ttUsageEquipment").value, date: $("ttUsageDate").value, notes: $("ttUsageNotes").value.trim() };
    busyModal("ttUsageModal", true);
    $("ttUsageSave").textContent = "Saving...";
    formError("ttUsageError", "");
    try {
      await post("/api/technician/equipment-usage", body);
      state.saving = false;
      bootstrap.Modal.getOrCreateInstance($("ttUsageModal")).hide();
      tab("usage");
      showMessage("Equipment use saved.");
      await load();
    } catch (error) { formError("ttUsageError", error.message); }
    finally { state.saving = false; busyModal("ttUsageModal", false); $("ttUsageSave").textContent = "Save record"; }
  });
  $("ttReturnCondition").addEventListener("change", () => {
    const required = ["damaged", "lost"].includes($("ttReturnCondition").value);
    $("ttReturnNotes").required = required;
    $("ttReturnNotesLabel").textContent = required ? "Required" : "Optional";
    $("ttReturnSave").textContent = required ? "Save report" : "Save return";
  });
  $("ttReturnForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (state.returning || !state.selected || !$("ttReturnForm").reportValidity()) return;
    const condition = $("ttReturnCondition").value;
    const note = $("ttReturnNotes").value.trim();
    if (["damaged", "lost"].includes(condition) && !note) { formError("ttReturnError", "Add a short note about the damage or missing equipment."); return; }
    state.returning = true;
    busyModal("ttReturnModal", true);
    $("ttReturnSave").textContent = "Saving...";
    formError("ttReturnError", "");
    try {
      await post(`/api/technician/equipment/${encodeURIComponent(id(state.selected._id))}/return`, { condition, damageDescription: note });
      state.returning = false;
      bootstrap.Modal.getOrCreateInstance($("ttReturnModal")).hide();
      showMessage(["good", "fair"].includes(condition) ? "Equipment return saved. Inventory and Daily Kit records were updated." : "Equipment condition reported. It is no longer available for use.");
      await load();
    } catch (error) { formError("ttReturnError", error.message); }
    finally { state.returning = false; busyModal("ttReturnModal", false); $("ttReturnCondition").dispatchEvent(new Event("change")); }
  });
  for (const [modalId, key] of [["ttUsageModal", "saving"], ["ttReturnModal", "returning"]]) {
    $(modalId).addEventListener("hide.bs.modal", event => { if (state[key]) event.preventDefault(); });
    $(modalId).addEventListener("shown.bs.modal", () => $(modalId === "ttUsageModal" ? "ttUsageDate" : "ttReturnCondition").focus());
  }
  page.addEventListener("click", async event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.tab) return tab(button.dataset.tab);
    if (button.hasAttribute("data-retry")) return load();
    if (button.dataset.return) {
      state.selected = state.equipment.find(row => id(row._id) === button.dataset.return);
      if (!state.selected) return;
      $("ttReturnForm").reset();
      $("ttReturnNotes").required = false;
      $("ttReturnNotesLabel").textContent = "Optional";
      $("ttReturnSave").textContent = "Save return";
      $("ttReturnName").textContent = name(state.selected);
      $("ttReturnMeta").textContent = `Qty: ${quantity(state.selected)} · ${context(state.selected).title}`;
      formError("ttReturnError", "");
      bootstrap.Modal.getOrCreateInstance($("ttReturnModal")).show();
    }
    if (button.dataset.delete) {
      const recordId = button.dataset.delete;
      if (state.deleting.has(recordId)) return;
      state.deleting.add(recordId);
      try {
        const choice = await Swal.fire({ title: "Delete this usage record?", text: "This removes the usage note. Equipment stock stays the same.", icon: "question", showCancelButton: true, confirmButtonText: "Delete record", cancelButtonText: "Keep record", confirmButtonColor: "#b91c1c" });
        if (!choice.isConfirmed) return;
        button.disabled = true;
        await request(`/api/technician/equipment-usage/${encodeURIComponent(recordId)}`, { method: "DELETE" });
        showMessage("Usage record deleted.");
        await load();
      } catch (error) { await Swal.fire({ title: "Could not delete the record", text: error.message, icon: "error", confirmButtonColor: "#15803d" }); }
      finally { state.deleting.delete(recordId); button.disabled = false; }
    }
  });
  page.querySelector(".tt-tabs").addEventListener("keydown", event => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const buttons = [...page.querySelectorAll("[data-tab]")];
    let index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    tab(buttons[index].dataset.tab);
    buttons[index].focus();
  });
  $("ttRefresh").addEventListener("click", load);
  $("ttSearch").addEventListener("input", render);
  $("ttStatus").addEventListener("change", render);
  load();
})();

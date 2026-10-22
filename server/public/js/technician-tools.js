/* Equipment custody and saved material history. */
(() => {
  "use strict";
  const page = document.getElementById("technicianToolsPage");
  if (!page) return;
  const $ = id => document.getElementById(id);
  const state = { category: 'equipment', page: 1, tab: "equipment", equipment: [], legacy: [], usage: [], extra: [], errors: {}, loading: true, selected: null, returning: false, loadSequence: 0 };
  const pageSize = 6;
  let searchTimer;
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const id = value => String(value?._id || value || "");
  const active = row => ["checked_out", "in_use", "assigned"].includes(row.status);
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
    const links = [...new Set([booking?.bookingReference || booking?.workOrderNumber, ...(row.bookingIds || []).map(booking => booking.bookingReference || booking.workOrderNumber), ...orders, project].filter(Boolean))];
    const title = links.join(" / ") || (row.dailyKitId ? "Daily Kit" : "General issue");
    const sub = [booking?.customerId?.name, booking?.service?.name, row.dailyKitId?.workDate ? dateLabel(row.dailyKitId.workDate) : row.workDate ? dateLabel(row.workDate) : ""].filter(Boolean).join(" · ");
    return { title, sub };
  }
  const labels = { checked_out: ["In your care", "blue"], in_use: ["In use", "blue"], assigned: ["In your care", "blue"], reserved: ["Reserved", "amber"], returned: ["Returned", "green"], released: ["Released", ""], damaged: ["Damaged", "red"], lost: ["Lost", "red"] };
  function badge(row) {
    if (row.returnPending) return '<span class="tt-badge tt-badge-amber">Awaiting admin receipt</span>';
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
      return `<article class="tt-equipment-row"><div class="tt-item"><span class="tt-item-icon"><i class="bi bi-tools" aria-hidden="true"></i></span><div><strong>${escape(name(row))}</strong><small>${escape(code(row) || "No equipment code")}</small></div></div><div class="tt-job"><strong>${escape(meta.title)}</strong><small>${escape(meta.sub)}</small></div><span class="tt-quantity">${quantity(row)}</span><div class="tt-status">${badge(row)}</div>${!history && active(row) && !row.legacy && !row.returnPending ? `<button type="button" class="tt-row-action" data-return="${escape(id(row._id))}" aria-label="Return ${escape(name(row))}">Return</button>` : `<span class="tt-row-note">${row.legacy && active(row) ? "Admin records this return" : row.status === "reserved" ? "Not issued yet" : escape(row.condition ? `Condition: ${row.condition}` : "")}</span>`}</article>`;
    }).join("");
  }
  function render() {
    const records = $("ttRecords");
    records.setAttribute("aria-busy", String(state.loading));
    $("ttStatus").parentElement.hidden = state.category !== 'equipment' || state.tab !== "equipment";
    $("ttPagination").innerHTML = '';
    $("ttContextHelp").textContent = state.tab === "equipment" ? "Return reusable equipment after the linked work is finished." : state.tab === 'extra' ? 'Equipment used outside the original kit. Personal and borrowed tools do not change company stock.' : state.tab === "usage" ? "Previous optional notes only. Daily Preparation and returns track equipment custody; these notes do not deduct stock." : "Showing the latest 200 equipment records and 100 general tool records.";
    const errorKeys = state.tab === 'extra' ? ['extra'] : state.tab === "usage" ? ["usage"] : ["equipment", "legacy"];
    const error = errorKeys.filter(key => state.errors[key]).map(key => state.errors[key]).join(" ");
    if (state.loading) { records.innerHTML = '<div class="tt-empty"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span><p>Loading your records...</p></div>'; return; }
    if (error) { records.innerHTML = empty("Your records could not be loaded", error, true); $("ttResultContext").textContent = "Could not load records"; return; }
    const query = $("ttSearch").value.trim().toLowerCase();
    const all = [...state.equipment, ...state.legacy];
    const filter = row => [name(row), code(row), context(row).title, context(row).sub, row.notes || ""].join(" ").toLowerCase().includes(query);
    const paginate = rows => {
      const pages = Math.max(1, Math.ceil(rows.length / pageSize));
      state.page = Math.min(state.page, pages);
      $("ttPagination").innerHTML = rows.length > pageSize ? `<button type="button" class="tt-button tt-button-secondary" data-tt-page="${state.page - 1}" ${state.page === 1 ? 'disabled' : ''}>Previous</button><span>Page ${state.page} of ${pages}</span><button type="button" class="tt-button tt-button-secondary" data-tt-page="${state.page + 1}" ${state.page === pages ? 'disabled' : ''}>Next</button>` : '';
      return rows.slice((state.page - 1) * pageSize, state.page * pageSize);
    };
    if (state.tab === 'extra') {
      const rows = state.extra.filter(row => [row.equipmentName, row.equipmentCode, row.workReference, row.owner, row.notes].join(' ').toLowerCase().includes(query));
      $('ttResultContext').textContent = `${rows.length} extra equipment record${rows.length === 1 ? '' : 's'} · Latest 200 records`;
      records.innerHTML = rows.length ? paginate(rows).map(row => `<article class="tt-usage-row"><div class="tt-item"><span class="tt-item-icon"><i class="bi bi-tools" aria-hidden="true"></i></span><div><strong>${escape(row.equipmentName)}</strong><small>${escape(row.workReference || 'Work reference not recorded')}</small><div class="tt-extra-meta"><span>${escape(({ company: 'Company equipment', personal: 'Personal equipment', borrowed: 'Borrowed equipment' })[row.source] || 'Equipment')}${row.source === 'borrowed' ? ' · ' + escape(row.owner) : ''}</span><span>Qty: ${escape(row.quantity || 1)}</span><span>${escape(dateLabel(row.date))}</span></div><p class="tt-extra-reason">${escape(row.notes)}</p></div></div></article>`).join('') : empty(query ? 'No matching extra equipment' : 'No extra equipment recorded', query ? 'Try another tool name or work reference.' : 'Use Record extra equipment when you used a company, personal, or borrowed tool outside the original kit.');
    } else if (state.tab === "usage") {
      const rows = state.usage.filter(row => [row.equipmentName, row.equipmentCode, row.notes].join(" ").toLowerCase().includes(query));
      $("ttResultContext").textContent = `${rows.length} past note${rows.length === 1 ? "" : "s"} · Latest 200 records`;
      if (!rows.length) { records.innerHTML = empty(query ? "No matching records" : "No past equipment notes", query ? "Try a different equipment name." : "Equipment is tracked through Daily Preparation and return reports. No separate tool log is required."); return; }
      let previous = "";
      records.innerHTML = paginate(rows).map(row => {
        const date = day(row.date);
        const heading = date !== previous ? `<div class="tt-usage-date">${escape(dateLabel(row.date))}</div>` : "";
        previous = date;
        return heading + `<article class="tt-usage-row"><div class="tt-item"><span class="tt-item-icon"><i class="bi bi-calendar-check" aria-hidden="true"></i></span><div><strong>${escape(row.equipmentName)}</strong><small>${escape(row.equipmentCode || "")}</small>${row.notes ? `<p>${escape(row.notes)}</p>` : ""}</div></div></article>`;
      }).join("");
    } else {
      const rows = all.filter(row => state.tab === "history" ? !active(row) && row.status !== "reserved" : active(row) || row.status === "reserved").filter(row => state.tab !== "equipment" || $("ttStatus").value === "all" || ($("ttStatus").value === "active" ? active(row) : row.status === "reserved")).filter(filter);
      const visible = paginate(rows);
      $("ttResultContext").textContent = rows.length ? `Showing ${(state.page - 1) * pageSize + 1}–${Math.min(state.page * pageSize, rows.length)} of ${rows.length} equipment records` : 'No equipment matches this view';
      records.innerHTML = equipmentRows(visible, state.tab === "history");
    }
  }
  async function load() {
    const sequence = ++state.loadSequence;
    state.loading = true;
    $("ttRefresh").disabled = true;
    render();
    const results = await Promise.allSettled([request("/api/technician/equipment"), request("/api/technician/tools/assigned/history"), request("/api/technician/equipment-usage?kind=notes"), request('/api/technician/equipment-usage?kind=extra')]);
    if (sequence !== state.loadSequence) return;
    state.errors = {};
    ["equipment", "legacy", "usage", 'extra'].forEach((key, index) => {
      const result = results[index];
      if (result.status === "fulfilled") state[key] = key === "legacy" ? (result.value.items || []).filter(row => !row.itemType || ["equipment", "tool"].includes(row.itemType)).map(row => ({ ...row, legacy: true })) : (result.value.items || []).filter(row => key === 'extra' ? row.recordKind === 'extra' : key !== 'usage' || row.recordKind !== 'extra');
      else state.errors[key] = result.reason.message;
    });
    const all = [...state.equipment, ...state.legacy];
    const unavailable = state.errors.equipment || state.errors.legacy;
    $("ttActiveCount").textContent = unavailable ? "—" : all.filter(active).reduce((sum, row) => sum + quantity(row), 0);
    $("ttReservedCount").textContent = unavailable ? "—" : all.filter(row => row.status === "reserved").reduce((sum, row) => sum + quantity(row), 0);
    $("ttEquipmentBadge").textContent = unavailable ? "—" : all.filter(row => active(row) || row.status === "reserved").length;
    $("ttPendingCount").textContent = unavailable ? "-" : all.filter(row => row.returnPending).length;
    state.loading = false;
    $("ttRefresh").disabled = false;
    render();
  }
  function tab(value) {
    state.tab = value;
    state.page = 1;
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
  function category(value) {
    if (!['equipment', 'repair_part', 'consumable', 'used', 'returns'].includes(value)) return;
    clearTimeout(searchTimer);
    state.category = value; state.page = 1;
    const equipment = value === 'equipment', returns = value === 'returns', used = value === 'used';
    $('ttEquipmentPanel').hidden = !equipment;
    $('kitReturnsPanel').hidden = equipment || used;
    $('ttMaterialsUsedPanel').hidden = !used;
    $('krMaterialsSection').hidden = equipment || returns || used;
    $('krReportsSection').hidden = !returns;
    $('ttCategoryToolbar').hidden = returns;
    $('ttSearch').value = '';
    $('ttSearch').placeholder = equipment ? 'Search equipment or job reference' : used ? 'Search item or booking / order reference' : value === 'repair_part' ? 'Search repair parts' : 'Search consumables';
    for (const button of page.querySelectorAll('[data-category]')) {
      const selected = button.dataset.category === value;
      button.classList.toggle('is-active', selected); button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      if (selected && !equipment && !used) $(returns ? 'krReportsSection' : 'krMaterialsSection').setAttribute('aria-labelledby', button.id);
    }
    const url = new URL(window.location.href);
    if (equipment) url.searchParams.delete('category'); else url.searchParams.set('category', value);
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    render();
    window.dispatchEvent(new CustomEvent('technician-tools-category', { detail: { category: value } }));
    if (!equipment && !used) window.dispatchEvent(new CustomEvent('technician-kit-filter', { detail: { category: value, search: '' } }));
  }
  function busyModal(modalId, busy) {
    $(modalId).querySelectorAll('button, input, select, textarea').forEach(element => { element.disabled = busy; });
  }
  $("ttReturnCondition").addEventListener("change", () => {
    const required = ["damaged", "lost"].includes($("ttReturnCondition").value);
    $("ttReturnNotes").required = required;
    $("ttReturnNotesLabel").textContent = required ? "Required" : "Optional";
    $("ttReturnSave").textContent = "Send report";
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
      await post(`/api/technician/equipment/${encodeURIComponent(id(state.selected._id))}/return`, { condition, damageDescription: note, equipmentUse: $('ttReturnUse').value });
      state.returning = false;
      bootstrap.Modal.getOrCreateInstance($("ttReturnModal")).hide();
      showMessage("Report sent. The equipment stays in your care until admin confirms receipt or reviews the report.");
      await load();
    } catch (error) { formError("ttReturnError", error.message); }
    finally { state.returning = false; busyModal("ttReturnModal", false); $("ttReturnCondition").dispatchEvent(new Event("change")); }
  });
  for (const [modalId, key] of [["ttReturnModal", "returning"]]) {
    $(modalId).addEventListener("hide.bs.modal", event => { if (state[key]) event.preventDefault(); });
    $(modalId).addEventListener("shown.bs.modal", () => $("ttReturnCondition").focus());
  }
  page.addEventListener("click", async event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.category) return category(button.dataset.category);
    if (button.hasAttribute('data-tt-page')) { state.page = Number(button.dataset.ttPage); return render(); }
    if (button.dataset.tab) return tab(button.dataset.tab);
    if (button.hasAttribute("data-retry")) return load();
    if (button.dataset.return) {
      state.selected = state.equipment.find(row => id(row._id) === button.dataset.return);
      if (!state.selected) return;
      $("ttReturnForm").reset();
      $("ttReturnNotes").required = false;
      $("ttReturnNotesLabel").textContent = "Optional";
      $("ttReturnSave").textContent = "Send report";
      $("ttReturnName").textContent = name(state.selected);
      $("ttReturnMeta").textContent = `Qty: ${quantity(state.selected)} · ${context(state.selected).title}`;
      formError("ttReturnError", "");
      bootstrap.Modal.getOrCreateInstance($("ttReturnModal")).show();
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
  page.querySelector('.tt-categories').addEventListener('keydown', event => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...page.querySelectorAll('[data-category]')], current = buttons.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus(); category(buttons[next].dataset.category);
  });
  $("ttRefresh").addEventListener("click", () => { load(); window.dispatchEvent(new Event('technician-kit-refresh')); window.dispatchEvent(new Event('technician-material-refresh')); });
  $("ttSearch").addEventListener("input", () => {
    state.page = 1; render(); clearTimeout(searchTimer);
    if (state.category === 'used') {
      window.dispatchEvent(new CustomEvent('technician-material-search', { detail: { search: $('ttSearch').value.trim() } }));
    } else if (state.category !== 'equipment') {
      window.dispatchEvent(new CustomEvent('technician-kit-search-pending', { detail: { search: $('ttSearch').value.trim() } }));
      searchTimer = setTimeout(() => window.dispatchEvent(new CustomEvent('technician-kit-filter', { detail: { category: state.category, search: $('ttSearch').value.trim() } })), 250);
    }
  });
  $("ttStatus").addEventListener("change", () => { state.page = 1; render(); });
  window.addEventListener('technician-kit-counts', event => {
    $('ttPartsBadge').textContent = event.detail?.repair_part ?? '—';
    $('ttConsumablesBadge').textContent = event.detail?.consumable ?? '—';
  });
  window.addEventListener('technician-extra-equipment-saved', event => { tab('extra'); showMessage(event.detail?.companyMode === 'stock' ? 'Equipment checked out and recorded against your work. Return it through Current items after work.' : 'Extra equipment recorded against your work.'); load(); });
  function refreshReceivedItems() {
    if (document.hidden || state.loading || state.returning || $('ttReturnModal').classList.contains('show') || $('ttExtraModal').classList.contains('show')) return;
    load();
  }
  document.addEventListener('visibilitychange', refreshReceivedItems);
  window.addEventListener('notification:new', refreshReceivedItems);
  window.setInterval(refreshReceivedItems, 60000);
  if (window.socket) window.socket.on('notification:new', data => {
    if (['kit_return_reviewed', 'equipment_return_resolved'].includes(data?.type)) refreshReceivedItems();
  });
  category(new URLSearchParams(window.location.search).get('category') || 'equipment');
  load();
})();

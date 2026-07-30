(function () {
  const ctx = window.TOOL_USAGE_CONTEXT || {};
  const apiBase = ctx.apiBase || "/api/admin";

  const qs = (id) => document.getElementById(id);
  const body = qs("toolUsageBody");

  const filterStart = qs("filterStart");
  const filterEnd = qs("filterEnd");
  const filterTech = qs("filterTech");

  const kpiEntries = qs("kpiEntries");
  const kpiQty = qs("kpiQty");
  const kpiFuel = qs("kpiFuel");
  const kpiCost = qs("kpiCost");

  const newItemName = qs("newItemName");
  const toolOptions = qs("toolOptions");
  const selectedToolId = qs("selectedToolId");
  const newUnit = qs("newUnit");
  const newUnitPrice = qs("newUnitPrice");
  const newQty = qs("newQty");
  const newNotes = qs("newNotes");

  function notify(type, msg) {
    if (window.notify && typeof window.notify[type] === "function") {
      return window.notify[type](msg);
    }
    if (type === "error") return alert(msg);
    console.log(msg);
  }

  function fmtDate(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString();
  }

  function fmtNum(v, digits = 2) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function bookingLabel(value) {
    if (!value) return "—";
    if (typeof value === "string") return value;
    const ref = value.bookingReference || value._id || "";
    const date = value.bookingDate ? new Date(value.bookingDate).toLocaleDateString() : "";
    const customer = value.customerName || "";
    return [ref, date, customer].filter(Boolean).join(" • ") || String(value._id || "—");
  }

  function technicianLabel(value) {
    if (!value) return "—";
    if (typeof value === "string") return value;
    return (
      value.name ||
      `${value.firstName || ""} ${value.lastName || ""}`.trim() ||
      value.email ||
      String(value._id || "—")
    );
  }

  function buildQuery() {
    const params = new URLSearchParams();
    if (filterStart && filterStart.value) params.set("start", filterStart.value);
    if (filterEnd && filterEnd.value) params.set("end", filterEnd.value);
    if (filterTech && filterTech.value) params.set("technicianId", filterTech.value);
    params.set("limit", "300");
    return params.toString();
  }

  async function loadOptions() {
    const r = await fetch(`${apiBase}/tool-usage/options`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Failed loading options");

    const technicians = d.technicians || [];
    if (filterTech) {
      filterTech.innerHTML = '<option value="">All technicians</option>';
      technicians.forEach((t) => {
        const name = t.name || `${t.firstName || ""} ${t.lastName || ""}`.trim() || t.email || t._id;
        const o = document.createElement("option");
        o.value = t._id;
        o.textContent = name;
        filterTech.appendChild(o);
      });
    }

    // inventory options are now tools
    const tools = d.tools || d.inventory || [];
    if (toolOptions) {
      toolOptions.innerHTML = "";
      tools.forEach((t) => {
        const o = document.createElement("option");
        o.value = t.itemName;
        o.dataset.id = t._id;
        o.dataset.unit = t.unit || "pcs";
        o.dataset.price = t.costPrice || 0;
        toolOptions.appendChild(o);
      });
    }

    // Auto-fill price and unit when a known tool is selected
    if (newItemName) {
      newItemName.addEventListener("input", function () {
        const val = this.value;
        const opts = toolOptions.childNodes;
        let found = false;
        for (let i = 0; i < opts.length; i++) {
          if (opts[i].value === val) {
            if (selectedToolId) selectedToolId.value = opts[i].dataset.id;
            if (newUnit) newUnit.value = opts[i].dataset.unit;
            if (newUnitPrice) newUnitPrice.value = opts[i].dataset.price;
            found = true;
            break;
          }
        }
        if (!found && selectedToolId) selectedToolId.value = "";
      });
    }
  }

  async function loadSummary() {
    const r = await fetch(`${apiBase}/tool-usage/summary?${buildQuery()}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Failed loading summary");

    const t = d.totals || {};
    kpiEntries.textContent = t.entries ?? 0;
    kpiQty.textContent = fmtNum(t.quantityUsed || 0, 2);
    kpiFuel.textContent = `₱${fmtNum(t.fuelUsed || 0, 2)}`;
    kpiCost.textContent = `₱${fmtNum(t.toolCost || 0, 2)}`;
  }

  function bindRowActions() {
    body.querySelectorAll(".js-edit").forEach((btn) => {
      btn.addEventListener("click", async function () {
        const id = this.dataset.id;
        if (!id) return;
        const qty = prompt("New quantity used:", this.dataset.qty || "");
        if (qty == null) return;
        const notes = prompt("Notes:", this.dataset.notes || "") || "";

        const r = await fetch(`${apiBase}/tool-usage/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantityUsed: Number(qty), notes }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Failed to update entry");
        notify("success", "Tool usage updated");
        await reload();
      });
    });

    body.querySelectorAll(".js-delete").forEach((btn) => {
      btn.addEventListener("click", async function () {
        const id = this.dataset.id;
        if (!id) return;
        if (!confirm("Delete this usage entry and restore stock?")) return;

        const r = await fetch(`${apiBase}/tool-usage/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Failed to delete entry");
        notify("success", "Entry deleted and stock restored");
        await reload();
      });
    });
  }

  async function loadTable() {
    const r = await fetch(`${apiBase}/tool-usage?${buildQuery()}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Failed loading tool usage");

    const items = d.items || [];
    qs("toolUsageCount").textContent = `${items.length} record${items.length === 1 ? "" : "s"}`;

    if (!items.length) {
      body.innerHTML = '<tr><td colspan="10" class="text-center text-muted py-4">No tool usage records found.</td></tr>';
      return;
    }

    body.innerHTML = items
      .map((u) => {
        return `
          <tr>
            <td>${fmtDate(u.usedAt || u.createdAt)}</td>
            <td>${bookingLabel(u.bookingId)}</td>
            <td>${technicianLabel(u.technicianId)}</td>
            <td>${u.itemName || "—"}</td>
            <td>₱${fmtNum(u.unitPrice || 0, 2)}</td>
            <td>${fmtNum(u.quantityUsed || 0, 2)} ${u.unit || "pcs"}</td>
            <td>₱${fmtNum(u.fuelUsed || 0, 2)}</td>
            <td>₱${fmtNum(u.toolCost || 0, 2)}</td>
            <td>${u.notes || "—"}</td>
            <td>
              <div class="d-flex gap-2">
                <button class="btn btn-sm btn-outline-secondary js-edit"
                  data-id="${u._id}"
                  data-qty="${u.quantityUsed || ""}"
                  data-notes="${(u.notes || "").replace(/"/g, "&quot;")}"
                >Edit</button>
                <button class="btn btn-sm btn-outline-danger js-delete" data-id="${u._id}">Delete</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("");

    bindRowActions();
  }

  async function reload() {
    await Promise.all([loadSummary(), loadTable()]);
  }

  async function addEntry(e) {
    e.preventDefault();

    const payload = {
      itemName: String(newItemName.value || "").trim(),
      inventoryItemId: selectedToolId ? selectedToolId.value : undefined,
      unit: String(newUnit.value || "pcs").trim() || "pcs",
      unitPrice: Number(newUnitPrice.value),
      quantityUsed: Number(newQty.value),
      notes: String(newNotes.value || "").trim(),
    };

    const r = await fetch(`${apiBase}/tool-usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Failed to create entry");

    newQty.value = "";
    newItemName.value = "";
    if (selectedToolId) selectedToolId.value = "";
    newUnitPrice.value = "";
    newNotes.value = "";
    notify("success", "Tool usage entry created");
    await reload();
    await loadOptions();
  }

  function wire() {
    qs("applyFilterBtn")?.addEventListener("click", reload);
    qs("toolUsageRefreshBtn")?.addEventListener("click", reload);
    qs("clearFilterBtn")?.addEventListener("click", () => {
      filterStart.value = "";
      filterEnd.value = "";
      if (filterTech) filterTech.value = "";
      reload();
    });

    qs("addToolUsageForm")?.addEventListener("submit", async (e) => {
      try {
        await addEntry(e);
      } catch (err) {
        notify("error", err.message || "Failed to add entry");
      }
    });

  }

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      wire();
      await loadOptions();
      await reload();
    } catch (err) {
      notify("error", err.message || "Failed to load tool management");
      body.innerHTML = '<tr><td colspan="10" class="text-center text-danger py-4">Failed to load data.</td></tr>';
    }
  });
})();

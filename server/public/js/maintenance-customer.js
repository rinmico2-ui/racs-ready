(function () {
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const formatDate = (value) => value ? new Date(value).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }) : "Not recorded";
  let installationAssetId = null;

  function equipmentName(asset) {
    const equipment = asset.equipment || {};
    return [equipment.brand, equipment.model, equipment.capacity ? `${equipment.capacity} ${equipment.capacityUnit || "HP"}` : ""].filter(Boolean).join(" ") || equipment.applianceTypeName || "Air-conditioning unit";
  }

  function activeCycle(asset) {
    return (asset.schedules || []).find((schedule) => !["completed", "cancelled"].includes(schedule.status)) || null;
  }

  function renderAsset(asset) {
    const equipment = asset.equipment || {};
    const cycle = activeCycle(asset);
    const installationRequired = asset.status === "installation_date_required";
    const booking = cycle?.bookingId;
    return `<article class="asset-card">
      <div class="asset-card-head"><div class="asset-icon"><i class="bi bi-snow2"></i></div><div class="flex-grow-1 min-width-0"><div class="maintenance-primary">${escapeHtml(equipmentName(asset))}</div><div class="maintenance-secondary">${escapeHtml(equipment.unitLabel || "Unit")} | From ${escapeHtml(asset.originType)} ${escapeHtml(asset.originReference || "")}</div></div><span class="maintenance-status ${escapeHtml(asset.status)}">${escapeHtml(asset.status.replace(/_/g, " "))}</span></div>
      <div class="asset-card-body">
        <div class="asset-meta">
          <div><div class="asset-meta-label">Installed</div><div class="asset-meta-value">${formatDate(asset.installationDate)}</div></div>
          <div><div class="asset-meta-label">Last Service</div><div class="asset-meta-value">${formatDate(asset.lastServiceDate)}</div></div>
          <div><div class="asset-meta-label">Service Address</div><div class="asset-meta-value">${escapeHtml(asset.serviceAddress || "Not recorded")}</div></div>
        </div>
        ${installationRequired ? `<div class="maintenance-cycle"><div><div class="maintenance-primary">Installation date required</div><div class="maintenance-secondary">Record the actual date before reminders begin.</div></div><button class="btn btn-sm btn-primary js-install-date" data-asset-id="${asset._id}"><i class="bi bi-calendar-plus me-1"></i>Record date</button></div>` : cycle ? `<div class="maintenance-cycle"><div><div class="maintenance-secondary">Next maintenance</div><div class="maintenance-primary">${formatDate(cycle.dueDate)} <span class="maintenance-status ${escapeHtml(cycle.status)} ms-1">${escapeHtml(cycle.status)}</span></div><div class="maintenance-secondary">Every ${Number(cycle.intervalDays || 90)} days</div></div><div class="maintenance-cycle-actions">${booking ? `<a class="btn btn-sm btn-outline-primary" href="/book-history?highlight=${encodeURIComponent(booking._id)}"><i class="bi bi-eye me-1"></i>View booking</a>` : ["upcoming", "due", "overdue"].includes(cycle.status) ? `<button class="btn btn-sm btn-primary js-schedule-maint" data-schedule-id="${cycle._id}"><i class="bi bi-calendar-check me-1"></i>Schedule</button>` : '<span class="text-muted small">No action available</span>'}</div></div>` : '<div class="maintenance-cycle"><div><div class="maintenance-primary">No active maintenance cycle</div><div class="maintenance-secondary">Completed maintenance history remains attached to this equipment.</div></div></div>'}
      </div>
    </article>`;
  }

  async function load() {
    try {
      const response = await fetch("/api/maintenance/customer", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load maintenance information.");
      const assets = data.assets || [];
      $("customerAssetCount").textContent = assets.length;
      $("customerDueSoon").textContent = data.summary?.dueSoon || 0;
      $("customerDue").textContent = data.summary?.due || 0;
      $("customerOverdue").textContent = data.summary?.overdue || 0;
      $("customerAssetGrid").innerHTML = assets.map(renderAsset).join("");
      $("customerMaintenanceEmpty").classList.toggle("d-none", assets.length !== 0);
    } catch (error) {
      $("customerMaintenanceEmpty").classList.remove("d-none");
      $("customerMaintenanceEmpty").textContent = error.message;
    }
  }

  async function scheduleMaintenance(scheduleId, button) {
    button.disabled = true;
    try {
      const response = await fetch(`/api/maintenance/schedules/${scheduleId}/booking-intent`, { credentials: "same-origin" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to start maintenance booking.");
      window.location.assign(data.bookingUrl);
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  }

  $("customerAssetGrid").addEventListener("click", (event) => {
    const scheduleButton = event.target.closest(".js-schedule-maint");
    if (scheduleButton) return scheduleMaintenance(scheduleButton.dataset.scheduleId, scheduleButton);
    const installButton = event.target.closest(".js-install-date");
    if (installButton) {
      installationAssetId = installButton.dataset.assetId;
      $("assetInstallationDate").value = "";
      $("assetInstallationDate").max = new Date().toISOString().slice(0, 10);
      bootstrap.Modal.getOrCreateInstance($("installationDateModal")).show();
    }
  });

  $("saveInstallationDateBtn").addEventListener("click", async () => {
    const date = $("assetInstallationDate").value;
    if (!installationAssetId || !date) return;
    const button = $("saveInstallationDateBtn");
    button.disabled = true;
    try {
      const response = await fetch(`/api/maintenance/assets/${installationAssetId}/installation-date`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationDate: date }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to save installation date.");
      bootstrap.Modal.getOrCreateInstance($("installationDateModal")).hide();
      await load();
    } catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  });

  load();
})();

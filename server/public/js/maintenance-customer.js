(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const formatDate = (value) => value
    ? new Date(value).toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" })
    : "Not recorded";
  const label = (value) => String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  let installationAssetId = null;

  function showAlert(message, kind) {
    const box = $("aftercareAlert");
    box.className = `aftercare-alert ${kind || "success"}`;
    box.textContent = message;
    window.setTimeout(() => box.classList.add("d-none"), 6000);
  }

  function activateTab(tab) {
    document.querySelectorAll(".aftercare-tab").forEach((button) => button.classList.toggle("active", button.dataset.aftercareTab === tab));
    document.querySelectorAll("[data-aftercare-panel]").forEach((panel) => panel.classList.toggle("d-none", panel.dataset.aftercarePanel !== tab));
  }

  function equipmentName(asset) {
    const equipment = asset.equipment || {};
    return [equipment.brand, equipment.model, equipment.capacity ? `${equipment.capacity} ${equipment.capacityUnit || "HP"}` : ""]
      .filter(Boolean).join(" ") || equipment.applianceTypeName || "Air-conditioning unit";
  }

  function activeCycle(asset) {
    return (asset.schedules || []).find((schedule) => !["completed", "cancelled"].includes(schedule.status)) || null;
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
    const open = cycle && ["upcoming", "due", "overdue"].includes(cycle.status) && !booking;
    return `<article class="asset-card">
      <div class="asset-card-head"><div class="asset-icon"><i class="bi bi-snow2"></i></div><div class="flex-grow-1 min-width-0"><div class="maintenance-primary">${escapeHtml(name)}</div><div class="maintenance-secondary">${escapeHtml(equipment.unitLabel || "Unit")} | ${escapeHtml(asset.originReference || "Customer equipment")}</div></div><span class="maintenance-status ${escapeHtml(asset.status)}">${escapeHtml(label(asset.status))}</span></div>
      <div class="asset-card-body">
        <div class="asset-meta">
          <div><div class="asset-meta-label">Installed</div><div class="asset-meta-value">${formatDate(asset.installationDate)}</div></div>
          <div><div class="asset-meta-label">Last service</div><div class="asset-meta-value">${formatDate(asset.lastServiceDate)}</div></div>
          <div><div class="asset-meta-label">Service address</div><div class="asset-meta-value">${escapeHtml(asset.serviceAddress || "Not recorded")}</div></div>
        </div>
        ${installationRequired ? `<div class="maintenance-cycle"><div><div class="maintenance-primary">Installation date required</div><div class="maintenance-secondary">Record the actual date before reminders begin.</div></div><button class="btn btn-sm btn-primary js-install-date" data-asset-id="${asset._id}"><i class="bi bi-calendar-plus me-1"></i>Record date</button></div>` : cycle ? `<div class="maintenance-cycle aftercare-cycle"><div><div class="maintenance-secondary">Next maintenance</div><div class="maintenance-primary">${formatDate(cycle.dueDate)} <span class="maintenance-status ${escapeHtml(cycle.status)} ms-1">${escapeHtml(label(cycle.status))}</span></div><div class="maintenance-secondary">Every ${Number(cycle.intervalDays || 90)} days</div>${responseSummary(cycle)}</div><div class="maintenance-cycle-actions">${booking ? `<a class="btn btn-sm btn-outline-primary" href="/book-history?highlight=${encodeURIComponent(booking._id)}"><i class="bi bi-eye me-1"></i>View booking</a>` : open ? `<button class="btn btn-sm btn-primary js-aftercare-book" data-schedule-id="${cycle._id}"><i class="bi bi-calendar-check me-1"></i>Book service</button><button class="btn btn-sm btn-outline-primary js-aftercare-response" data-response="callback_requested" data-schedule-id="${cycle._id}" data-equipment="${escapeHtml(name)}"><i class="bi bi-telephone me-1"></i>Request callback</button><button class="btn btn-sm btn-outline-secondary js-aftercare-response" data-response="remind_later" data-schedule-id="${cycle._id}" data-equipment="${escapeHtml(name)}" title="Choose another reminder date"><i class="bi bi-bell"></i></button><button class="btn btn-sm btn-outline-secondary js-aftercare-decline" data-schedule-id="${cycle._id}" title="Not interested right now"><i class="bi bi-x-lg"></i></button>` : '<span class="text-muted small">No action available</span>'}</div></div>` : '<div class="maintenance-cycle"><div><div class="maintenance-primary">No active maintenance cycle</div><div class="maintenance-secondary">Completed maintenance history remains attached to this equipment.</div></div></div>'}
      </div>
    </article>`;
  }

  function renderWarrantyRecord(record) {
    const activeClaims = (record.claims || []).filter((claim) => claim.active);
    const coverages = (record.coverages || []).map((coverage) => `<div class="warranty-coverage-row"><div><strong>${escapeHtml(coverage.serviceName || label(coverage.coverageType) || "Warranty coverage")}</strong><span>${Number(coverage.days || 0)} days | ends ${formatDate(coverage.endDate)}</span></div><span class="maintenance-status ${escapeHtml(coverage.status)}">${escapeHtml(label(coverage.status))}</span></div>`).join("");
    const claims = (record.claims || []).map((claim) => `<div class="warranty-claim-row"><div><strong>${escapeHtml(claim.claimReference)}</strong><span>${escapeHtml(claim.affectedItem?.name || "Warranty issue")} | filed ${formatDate(claim.submittedAt)}</span></div><span class="maintenance-status ${claim.active ? "due" : "completed"}">${escapeHtml(label(claim.status))}</span></div>`).join("");
    return `<article class="warranty-record">
      <header><div><span class="aftercare-record-type">${record.sourceType === "order" ? "Product order" : "Service booking"}</span><h3>${escapeHtml(record.reference)}</h3><p>Completed ${formatDate(record.completedAt)}</p></div><span class="maintenance-status ${escapeHtml(record.status)}">${escapeHtml(label(record.status))}</span></header>
      <div class="warranty-record-body">${coverages || '<div class="text-muted small">No coverage details recorded.</div>'}${claims ? `<div class="warranty-claims"><div class="warranty-subhead">Claims</div>${claims}</div>` : ""}</div>
      <footer><span>${activeClaims.length ? `${activeClaims.length} open claim${activeClaims.length === 1 ? "" : "s"}` : "No open claims"}</span><a class="btn btn-sm btn-outline-primary" href="${escapeHtml(record.detailsUrl)}"><i class="bi bi-box-arrow-up-right me-1"></i>View coverage</a></footer>
    </article>`;
  }

  async function requestJson(url, options) {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  async function load() {
    try {
      const [maintenance, warranty] = await Promise.all([
        requestJson("/api/maintenance/customer"),
        requestJson("/api/warranty-claims/overview"),
      ]);
      const assets = maintenance.assets || [];
      $("customerAssetCount").textContent = assets.length;
      $("customerDueTotal").textContent = Number(maintenance.summary?.due || 0) + Number(maintenance.summary?.overdue || 0);
      $("customerActiveCoverage").textContent = warranty.summary?.activeCoverages || 0;
      $("customerActiveClaims").textContent = warranty.summary?.activeClaims || 0;
      $("customerAssetGrid").innerHTML = assets.map(renderAsset).join("");
      $("customerMaintenanceEmpty").classList.toggle("d-none", assets.length !== 0);
      const records = warranty.records || [];
      $("customerWarrantyRecords").innerHTML = records.map(renderWarrantyRecord).join("");
      $("customerWarrantyEmpty").classList.toggle("d-none", records.length !== 0);
    } catch (error) {
      showAlert(error.message, "error");
    }
  }

  async function submitResponse(scheduleId, status, values, button) {
    if (button) button.disabled = true;
    try {
      const data = await requestJson(`/api/maintenance/schedules/${encodeURIComponent(scheduleId)}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, ...values }),
      });
      if (status === "booking_started" && data.bookingUrl) {
        window.location.assign(data.bookingUrl);
        return;
      }
      bootstrap.Modal.getInstance($("aftercareResponseModal"))?.hide();
      const messages = {
        callback_requested: "Your callback request was sent to the aftercare team.",
        remind_later: "Your reminder date was saved.",
        declined: "Your response was saved. You can book from here whenever you are ready.",
      };
      showAlert(messages[status] || "Your response was saved.", "success");
      await load();
    } catch (error) {
      showAlert(error.message, "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function openResponseModal(button) {
    const status = button.dataset.response;
    $("aftercareResponseScheduleId").value = button.dataset.scheduleId;
    $("aftercareResponseStatus").value = status;
    $("aftercareResponseEquipment").textContent = button.dataset.equipment || "Equipment";
    $("aftercareResponseNote").value = "";
    $("aftercareResponseDate").value = "";
    $("aftercareResponseDate").min = new Date(Date.now() + 30 * 60000).toISOString().slice(0, 16);
    $("aftercareResponseTitle").textContent = status === "remind_later" ? "Choose a reminder" : "Request a callback";
    $("aftercareResponseDateLabel").textContent = status === "remind_later" ? "Remind me on" : "Preferred contact time";
    $("aftercareResponseDate").required = status === "remind_later";
    $("aftercareResponseSubmit").textContent = status === "remind_later" ? "Save reminder" : "Send request";
    bootstrap.Modal.getOrCreateInstance($("aftercareResponseModal")).show();
  }

  document.querySelectorAll("[data-aftercare-tab]").forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.aftercareTab)));

  $("customerAssetGrid").addEventListener("click", async (event) => {
    const bookButton = event.target.closest(".js-aftercare-book");
    if (bookButton) return submitResponse(bookButton.dataset.scheduleId, "booking_started", {}, bookButton);
    const responseButton = event.target.closest(".js-aftercare-response");
    if (responseButton) return openResponseModal(responseButton);
    const declineButton = event.target.closest(".js-aftercare-decline");
    if (declineButton) {
      if (window.confirm("Record that you are not booking this maintenance right now?")) {
        return submitResponse(declineButton.dataset.scheduleId, "declined", {}, declineButton);
      }
      return;
    }
    const installButton = event.target.closest(".js-install-date");
    if (installButton) {
      installationAssetId = installButton.dataset.assetId;
      $("assetInstallationDate").value = "";
      $("assetInstallationDate").max = new Date().toISOString().slice(0, 10);
      bootstrap.Modal.getOrCreateInstance($("installationDateModal")).show();
    }
  });

  $("aftercareResponseForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = $("aftercareResponseStatus").value;
    return submitResponse(
      $("aftercareResponseScheduleId").value,
      status,
      { remindAt: $("aftercareResponseDate").value || null, note: $("aftercareResponseNote").value.trim() },
      $("aftercareResponseSubmit"),
    );
  });

  $("saveInstallationDateBtn").addEventListener("click", async () => {
    const date = $("assetInstallationDate").value;
    if (!installationAssetId || !date) return;
    const button = $("saveInstallationDateBtn");
    button.disabled = true;
    try {
      await requestJson(`/api/maintenance/assets/${encodeURIComponent(installationAssetId)}/installation-date`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationDate: date }),
      });
      bootstrap.Modal.getInstance($("installationDateModal"))?.hide();
      showAlert("Installation date saved and maintenance reminders activated.", "success");
      await load();
    } catch (error) { showAlert(error.message, "error"); }
    finally { button.disabled = false; }
  });

  load();
})();

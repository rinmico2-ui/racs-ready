(function () {
  "use strict";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const dateTime = value => value ? new Date(value).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) + " PHT" : "Not set";

  async function readJson(response) {
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data?.error || "The request could not be completed. Refresh and try again.");
    return data;
  }

  function render({ container, stats, records, total = records.length, onAction }) {
    const overdue = records.filter(r => r.deadline && new Date(r.deadline).getTime() < Date.now()).length;
    stats.className = "acceptance-stats";
    stats.innerHTML = [
      ["Waiting for Acceptance", total, "Awaiting technician confirmation", "bi-person-check"],
      ["Deadline Passed", overdue, "Review the unanswered assignments shown below", "bi-clock-history"],
      ["Schedule Recovery", records.filter(r => r.isPastDate).length, "A new customer schedule is required", "bi-calendar-event"],
    ].map(([label, value, hint, icon]) => `<div class="acceptance-stat"><i class="bi ${icon}" aria-hidden="true"></i><div><span>${label}</span><strong>${value}</strong><small>${hint}</small></div></div>`).join("");
    container.innerHTML = records.length ? records.map((r, index) => {
      const expired = r.deadline && new Date(r.deadline).getTime() < Date.now();
      const actions = r.isPastDate
        ? [{ key: "view", label: "View details", icon: "bi-eye", primary: true }, { key: "recover", label: "Resolve schedule", icon: "bi-calendar-event", disabled: !r.canResolve, hint: "Contact an administrator to resolve this schedule." }]
        : [{ key: "view", label: "View details", icon: "bi-eye", primary: true }, { key: "extend", label: "Extend deadline", icon: "bi-clock", disabled: !r.canExtend }, { key: "requeue", label: "Return to assignment queue", icon: "bi-arrow-repeat", disabled: !r.canRequeue, hint: r.requeueHint }];
      return `<article class="workflow-record-card acceptance-record"><div class="workflow-record-head"><div><div class="workflow-record-ref">${esc(r.reference)}</div><h3 class="workflow-record-title">${esc(r.customer || "Customer")}</h3><div class="workflow-record-subtitle">${esc(r.description)}</div></div><span class="acceptance-badge ${expired ? "overdue" : ""}">${r.isPastDate ? "Schedule recovery" : expired ? "Deadline passed" : "Waiting for acceptance"}</span></div><div class="workflow-record-grid"><span><i class="bi bi-calendar-event"></i>${esc(r.schedule)}</span><span><i class="bi bi-person-badge"></i>${esc(r.technician || "Technician not available")}</span><span><i class="bi bi-clock-history"></i>Accept by ${esc(dateTime(r.deadline))}</span>${r.address ? `<span><i class="bi bi-geo-alt"></i>${esc(r.address)}</span>` : ""}</div>${r.isPastDate ? '<p class="workflow-record-alert">The service schedule has passed. Agree on a new schedule before changing this assignment.</p>' : ""}<div class="workflow-record-actions">${actions.map(a => `<button type="button" class="btn btn-sm ${a.primary ? "btn-primary" : "btn-outline-secondary"}" data-acceptance-index="${index}" data-acceptance-action="${a.key}" ${a.disabled ? "disabled" : ""} ${a.hint && a.disabled ? `title="${esc(a.hint)}"` : ""}><i class="bi ${a.icon} me-1" aria-hidden="true"></i>${a.label}</button>`).join("")}</div></article>`;
    }).join("") : '<div class="acceptance-empty"><i class="bi bi-check-circle" aria-hidden="true"></i><p>No assignments waiting for technician acceptance.</p></div>';
    container.onclick = event => {
      const button = event.target.closest("[data-acceptance-action]");
      if (button && container.contains(button) && !button.disabled) onAction(button.dataset.acceptanceAction, records[Number(button.dataset.acceptanceIndex)]);
    };
  }
  async function askExtension() {
    const result = await Swal.fire({ title: "Extend acceptance deadline", input: "number", inputLabel: "Additional minutes (5–720)", inputValue: 60,
      inputAttributes: { min: 5, max: 720, step: 1 }, showCancelButton: true, confirmButtonText: "Extend deadline",
      inputValidator: value => !Number.isInteger(Number(value)) || Number(value) < 5 || Number(value) > 720 ? "Enter a whole number from 5 to 720." : undefined });
    return result.isConfirmed ? Number(result.value) : null;
  }
  function confirmReturn(reference) {
    return Swal.fire({ title: "Return to assignment queue?", text: `Release the unanswered assignment for ${reference} so another technician can be selected?`,
      icon: "warning", input: "text", inputPlaceholder: "Reason (optional)", showCancelButton: true,
      confirmButtonText: "Return to assignment queue", cancelButtonText: "Keep assignment" });
  }
  window.RACSAcceptance = { render, readJson, askExtension, confirmReturn };
})();

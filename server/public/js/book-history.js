// Client-side Booking History (front-end only)
// - Fetches /api/appointments, filters client-side to the current user and renders a responsive list/table
// - Provides search, status/date filters, pagination, view details modal and JSON download

(function () {
  "use strict";

  const root = document.getElementById("bookHistoryRoot");
  if (!root) return;

  const userId = root.getAttribute("data-user-id") || "";
  const userEmail = (root.getAttribute("data-user-email") || "").toLowerCase();

  // True when the booking belongs to the currently logged-in user.
  // Handles both raw and populated customer references, plus email fallback.
  function bookingBelongsToUser(b) {
    if (!b) return false;
    const idOf = (v) => (v && typeof v === "object" ? String(v._id || v.id || "") : String(v || ""));
    const uid = String(userId || "");
    // No identity info available — don't filter (the API already scopes results)
    if (!uid && !userEmail) return true;
    if (uid) {
      if (idOf(b.customerId) === uid) return true;
      if (idOf(b.customer && (b.customer._id || b.customer.id)) === uid) return true;
      if (idOf(b.userId) === uid) return true;
      if (idOf(b.user) === uid) return true;
    }
    if (userEmail) {
      const email = String((b.customer && b.customer.email) || b.email || "").toLowerCase();
      if (email && email === userEmail) return true;
    }
    return false;
  }

  const perPage = 8;
  let bookings = [];
  let originalBookings = [];
  let filtered = [];
  let page = 0;
  let usingSample = false;

  // UI elements
  const el = {
    loading: document.getElementById("bh-loading"),
    empty: document.getElementById("bh-empty"),
    tableWrap: document.getElementById("bh-table-wrapper"),
    tbody: document.getElementById("bh-tbody"),
    count: document.getElementById("bh-count"),
    prev: document.getElementById("bh-prev"),
    next: document.getElementById("bh-next"),
    search: document.getElementById("bh-search"),
    status: document.getElementById("bh-status"),
    from: document.getElementById("bh-from"),
    to: document.getElementById("bh-to"),
    clear: document.getElementById("bh-clear"),
    showSample: document.getElementById("bh-show-sample"),
    modalElement: document.getElementById("bhDetailModal"),
    modal: null,
    modalBody: document.getElementById("bh-modal-body"),
    downloadJsonBtn: document.getElementById("bh-download-json"),
  };

  function setupModalEnvironment() {
    if (!el.modalElement) return;
    if (el.modalElement.parentElement !== document.body) {
      document.body.appendChild(el.modalElement);
    }
  }

  setupModalEnvironment();

  function ensureModalInstance() {
    if (el.modal) return el.modal;
    if (!el.modalElement) return null;
    if (window.bootstrap && window.bootstrap.Modal) {
      el.modal = new window.bootstrap.Modal(el.modalElement, { backdrop: 'static', keyboard: true });
      return el.modal;
    }
    return null;
  }

  function statusBadge(status) {
    const map = {
      pending: "warning",
      confirmed: "success",
      completed: "secondary",
      cancelled: "danger",
      "re-scheduled": "info",
      awaiting_confirmation: "warning",
      // Enterprise Repair statuses
      repair_requested: "warning",
      pending_inspection: "info",
      inspection_scheduled: "primary",
      inspection_in_progress: "info",
      inspection_completed: "primary",
      awaiting_approval: "warning",
      repair_approved: "success",
      repair_declined: "danger",
      waiting_parts: "info",
      parts_reserved: "primary",
      ready_for_repair: "success",
      repair_scheduled: "primary",
      repair_in_progress: "primary",
      repair_completed: "success",
      under_warranty: "success",
      warranty_claim: "warning",
      closed: "secondary",
    };
    const cls = map[String(status || "").toLowerCase()] || "secondary";
    const label = String(status || "unknown").replace(/_/g, " ");
    return `<span class="badge bg-${cls} text-capitalize">${label}</span>`;
  }

  // True when the scheduled service window has fully elapsed and the booking
  // is still unresolved (mirrors server-side isBookingPast: endTime,
  // else startTime + serviceDurationMinutes).
  function isBookingPast(b) {
    if (!b || !b.bookingDate) return false;
    const TERMINAL = ['completed', 'cancelled', 'declined', 'rejected', 'closed', 'repair_completed', 'repair_declined'];
    if (TERMINAL.includes(b.status)) return false;
    const parseMin = (t) => {
      if (!t) return NaN;
      const m = String(t).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
      if (!m) return NaN;
      let h = Number(m[1]) % 12;
      if (m[3] && /pm/i.test(m[3])) h += 12;
      return h * 60 + Number(m[2] || 0);
    };
    const vd = new Date(b.bookingDate);
    if (isNaN(vd.getTime())) return false;
    let endMin = parseMin(b.endTime);
    if (!Number.isFinite(endMin)) {
      const startMin = parseMin(b.startTime);
      endMin = Number.isFinite(startMin) ? startMin + (Number(b.serviceDurationMinutes) || 60) : NaN;
    }
    if (Number.isFinite(endMin)) vd.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
    else vd.setHours(23, 59, 59, 999);
    return vd.getTime() < Date.now();
  }

  function shortId(id) {
    if (!id) return "-";
    const s = String(id);
    return s.length > 8 ? s.slice(-8) : s;
  }

  function formatDateTime(d) {
    if (!d) return "-";
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return d;
    return (
      dt.toLocaleDateString() +
      " • " +
      dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    );
  }

  function formatTime(value) {
    if (value === null || value === undefined || value === "") return "-";
    const raw = String(value).trim();

    // already in HH:MM form
    if (/^\d{1,2}:\d{2}$/.test(raw)) {
      const [h, m] = raw.split(":").map((n) => Number(n));
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    // minute-of-day numeric string or number
    const mins = Number(raw);
    if (Number.isFinite(mins)) {
      const h = Math.floor(mins / 60) % 24;
      const m = mins % 60;
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    // fallback for values like '08:00 AM'
    return raw;
  }

  function parseTimeToMinutes(t) {
    if (t == null) return null;
    const raw = String(t).trim();
    const m12 = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (m12) {
      let h = Number(m12[1]);
      const mm = Number(m12[2]);
      const period = m12[3].toUpperCase();
      if (period === 'AM' && h === 12) h = 0;
      if (period === 'PM' && h !== 12) h += 12;
      return h * 60 + mm;
    }
    const m24 = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (m24) {
      return Number(m24[1]) * 60 + Number(m24[2]);
    }
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    return null;
  }

  function isProposedDateTimePassed(pr) {
    if (!pr || !pr.date) return false;
    const dateStr = String(pr.date).split('T')[0];
    const [y, m, d] = dateStr.split('-').map(Number);
    const proposedDate = new Date(y, m - 1, d);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (proposedDate.getTime() < today.getTime()) return true;
    if (proposedDate.getTime() > today.getTime()) return false;
    const time = pr.time || pr.timeLabel;
    if (!time) return false;
    const mins = parseTimeToMinutes(time);
    if (mins === null) return false;
    const nowMins = now.getHours() * 60 + now.getMinutes();
    return mins < nowMins;
  }

  // ── Customer Reschedule Confirmation (proposed by admin) ────────────────
  window.bhRescheduleAction = async function (id, action) {
    const b = bookings.find((x) => String(x._id) === String(id));
    if (!b) return;

    if (action === 'cancel') {
      const reason = prompt('Please provide a reason for cancellation:');
      if (reason === null) return;
      if (!reason.trim()) {
        alert('Please provide a reason for cancellation.');
        return;
      }
      if (!confirm('Are you sure you want to cancel this booking? Any downpayment will be refunded.')) return;
      await submitRescheduleAction(id, 'cancel', { reason });
      return;
    }

    if (action === 'accept') {
      if (!confirm('Accept the proposed rescheduled date and time?')) return;
      await submitRescheduleAction(id, 'accept');
      return;
    }

    alert('Unknown action');
  };

  window.bhRequestNewSchedule = function (id) {
    const detailModal = document.getElementById('bhDetailModal');
    if (detailModal) {
      const inst = bootstrap.Modal.getInstance(detailModal);
      if (inst) inst.hide();
    }
    setTimeout(() => openBookingEditor(id, "schedule"), 400);
  };

  async function submitRescheduleAction(id, action, extras = {}) {
    try {
      const res = await fetch(`/api/appointments/${id}/reschedule-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, ...extras }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Action failed');
      alert(data.message || 'Done');
      await fetchBookings();
      const inst = ensureModalInstance();
      if (inst) inst.hide();
    } catch (e) {
      alert(e.message || 'Failed to process action');
    }
  }

  function renderTable() {
    const start = page * perPage;
    const pageItems = filtered.slice(start, start + perPage);

    el.tbody.innerHTML = pageItems
      .map((b) => {
        const needsConfirmation = ['re-scheduled', 'awaiting_assignment'].includes(b.status) && b.proposedReschedule && b.proposedReschedule.status === 'pending';
        const displayStatus = needsConfirmation ? 'awaiting_confirmation' : b.status;

        const dateText = b.bookingDate
          ? new Date(b.bookingDate).toLocaleDateString()
          : "-";
        const timeText = b.startTime || "-";

        const rescheduleIndicator = needsConfirmation
          ? `<div class="mt-1"><span class="badge bg-warning text-dark"><i class="bi bi-clock-history me-1"></i>Needs Confirmation</span></div>`
          : '';

        // Past-schedule indicator: the visit time has passed while the booking
        // is still unresolved — the company will reschedule it.
        const missedIndicator = isBookingPast(b)
          ? `<div class="mt-1"><span class="badge bg-warning text-dark"><i class="bi bi-alarm-fill me-1"></i>Missed Schedule — being rescheduled</span></div>`
          : '';

        const svc = b.serviceType || "service";
        const svcIcon = svc === 'core' ? 'bi-gear' : svc === 'repair' ? 'bi-wrench' : 'bi-tools';
        const rowType = svc === 'core' ? 'bh-row--core' : svc === 'repair' ? 'bh-row--repair' : 'bh-row--mixed';
        const location =
          b.location && b.location.address ? b.location.address : "-";
        const rated = b.customerRating != null && b.customerRating !== "";
        const ratingCell = (() => {
          if (b.status !== "completed") return "";
          if (rated) {
            return `<div class="text-warning" style="white-space:nowrap">${ratingStars(b.customerRating)}</div>`;
          }
          return `<button class="bh-action-btn bh-action-btn--success bh-rate" data-id="${b._id}" title="Rate"><i class="bi bi-star"></i></button>`;
        })();

        const reviewAction = ['re-scheduled', 'awaiting_assignment'].includes(b.status) && b.proposedReschedule && b.proposedReschedule.status === 'pending'
          ? `<button class="bh-action-btn bh-action-btn--warning bh-view" data-id="${b._id}" title="Review Reschedule"><i class="bi bi-calendar-check"></i></button>`
          : `<button class="bh-action-btn bh-action-btn--primary bh-view" data-id="${b._id}" title="View Details"><i class="bi bi-eye"></i></button>`;

        const pendingActions = b.status === 'pending'
          ? `<button class="bh-action-btn bh-action-btn--warning bh-reschedule" data-id="${b._id}" title="Re-schedule"><i class="bi bi-calendar-event"></i></button>
             <button class="bh-action-btn bh-action-btn--danger bh-cancel" data-id="${b._id}" title="Cancel"><i class="bi bi-x-circle"></i></button>`
          : '';

        const repairAction = b.status === 'repair_approved'
          ? `<button class="bh-action-btn bh-action-btn--primary bh-schedule-later" data-id="${b._id}" title="Schedule Repair"><i class="bi bi-calendar-plus"></i></button>`
          : '';

        const approvalAction = b.status === 'awaiting_approval'
          ? `<button class="bh-action-btn bh-action-btn--success bh-view" data-id="${b._id}" title="Review Quotation"><i class="bi bi-receipt"></i></button>`
          : '';

        const editAction = ['pending','payment_verified','confirmed','awaiting_assignment'].includes(b.status)
          ? `<button class="bh-action-btn bh-edit-services" data-id="${b._id}" title="Edit services" style="color:#0ea5e9;border-color:#bae6fd;"><i class="bi bi-list-check"></i></button>`
          : '';
        const maintenanceAction = b.maintenanceSummary || b.maintenance?.isMaintenance
          ? `<a class="bh-action-btn" href="/maintenance" title="View maintenance" style="color:#0f766e;border-color:#99f6e4;"><i class="bi bi-calendar2-check"></i></a>`
          : '';

        return `
        <tr data-id="${b._id}" class="bh-row ${rowType}">
          <td>
            <div class="bh-cell-title">#${shortId(b._id)}</div>
            <div class="bh-cell-meta">Created ${formatDateTime(b.createdAt)}</div>
          </td>
          <td>
            <div class="bh-cell-service"><i class="bi ${svcIcon}"></i><span class="text-capitalize">${escapeHtml(svc)}</span></div>
          </td>
          <td>
            <div class="bh-cell-title">${escapeHtml(dateText)}</div>
            <div class="bh-cell-meta">${escapeHtml(timeText)}</div>
            ${rescheduleIndicator}
          </td>
          <td>${statusBadge(displayStatus)}${missedIndicator}</td>
          <td class="bh-location" title="${escapeHtml(location)}">${escapeHtml(location)}</td>
          <td class="text-center">${ratingCell}</td>
          <td>
            <div class="bh-actions">
              ${reviewAction}
              <button class="bh-action-btn bh-download" data-id="${b._id}" title="Download JSON"><i class="bi bi-download"></i></button>
              ${pendingActions}
              ${repairAction}
              ${approvalAction}
              ${editAction}
              ${maintenanceAction}
              <a class="bh-action-btn" href="/services" title="Rebook" style="color:#2563eb;border-color:#bfdbfe;"><i class="bi bi-arrow-repeat"></i></a>
            </div>
          </td>
        </tr>`;
      })
      .join("");

    el.count.textContent = `Showing ${Math.min(filtered.length, start + 1)}–${Math.min(filtered.length, start + perPage)} of ${filtered.length}`;
    el.prev.disabled = page <= 0;
    el.next.disabled = start + perPage >= filtered.length;

    // toggle visibility
    el.loading.classList.add("d-none");
    el.empty.classList.toggle("d-none", filtered.length !== 0);
    el.tableWrap.classList.toggle("d-none", filtered.length === 0);

    attachRowHandlers();
  }

  function ratingStars(score) {
    if (!score || isNaN(score)) return "";
    let out = "";
    for (let i = 1; i <= 5; i++) {
      if (i <= Math.floor(score)) {
        out += '<i class="bi bi-star-fill"></i>';
      } else if (i - score < 1) {
        out += '<i class="bi bi-star-half"></i>';
      } else {
        out += '<i class="bi bi-star"></i>';
      }
    }
    return out;
  }

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function attachRowHandlers() {
    document.querySelectorAll(".bh-view").forEach((btn) => {
      btn.onclick = function () {
        const id = this.getAttribute("data-id");
        const b = bookings.find((x) => String(x._id) === String(id));
        if (!b) return;
        showDetailModal(b);
      };
    });

    document.querySelectorAll(".bh-download").forEach((btn) => {
      btn.onclick = function () {
        const id = this.getAttribute("data-id");
        const b = bookings.find((x) => String(x._id) === String(id));
        if (!b) return;
        downloadJSON(b, `booking-${shortId(b._id)}.json`);
      };
    });

    document.querySelectorAll(".bh-edit-services").forEach((btn) => {
      btn.onclick = () => openBookingEditor(btn.getAttribute("data-id"), "services");
    });

    // rating buttons - use premium modal
    document.querySelectorAll(".bh-rate").forEach((btn) => {
      btn.onclick = function () {
        const id = this.getAttribute("data-id");
        const b = bookings.find((x) => String(x._id) === String(id));
        if (!b) return;
        // Open premium rating modal
        if (window.openRatingModal) {
          const techText = b.technicianName || (b.technician && b.technician.name) || null;
          window.openRatingModal(id, b.serviceType || 'Service', techText);
        } else {
          // Fallback to native prompt if modal not available
          const score = prompt("Enter rating (1-5)");
          if (!score) return;
          submitRating(id, Number(score), null);
        }
      };
    });

    // cancel button handler
    document.querySelectorAll(".bh-cancel").forEach((btn) => {
      btn.onclick = function () {
        const id = this.getAttribute("data-id");
        const b = bookings.find((x) => String(x._id) === String(id));
        if (!b) return;
        const reason = prompt("Please provide a reason for cancelling this booking:");
        if (reason === null) return; // User clicked cancel
        if (reason.trim() === "") {
          alert("Please provide a reason for cancellation.");
          return;
        }
        if (confirm("Are you sure you want to cancel this booking?")) {
          cancelBooking(id, reason.trim());
        }
      };
    });

    // reschedule button handler
    document.querySelectorAll(".bh-reschedule").forEach((btn) => {
      btn.onclick = function () {
        const id = this.getAttribute("data-id");
        const b = bookings.find((x) => String(x._id) === String(id));
        if (!b) return;
        openRescheduleModal(b);
      };
    });

    // schedule later button handler (for repair_approved bookings)
    document.querySelectorAll(".bh-schedule-later").forEach((btn) => {
      btn.onclick = function () {
        const id = this.getAttribute("data-id");
        bhShowRepairTodayChoice(id);
      };
    });
  }

  function showDetailModal(b) {
    // Data normalisation
    const isRepair = b.serviceType === 'repair' || b.serviceModel === 'RepairService' || !!b.unitInfo;
    const serviceTypeLabel = isRepair ? 'Repair Service' : 'Core Service';
    const serviceName = (b.service && b.service.name) || (b.serviceId && b.serviceId.name) || b.serviceType || 'Service';
    const bookingRef = b.bookingReference || b.workOrderNumber || '—';
    const scheduleDate = b.preferredDate || b.bookingDate;
    const dateText = scheduleDate ? new Date(scheduleDate).toLocaleDateString() : '—';
    const timeText = b.selectedTimeLabel || b.preferredTime || b.startTime || '—';
    const occupiedBlock = (b.startTime && b.endTime) ? `${formatTime(b.startTime)} – ${formatTime(b.endTime)}` : '—';
    const techText = b.technicianName || (b.technician && b.technician.name) || b.technicianId || '—';
    const locationText = (b.location && b.location.address) || '—';
  
    const fmtCurrency = (n) =>
      n != null && n !== ''
        ? `₱${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '—';
    const fmtLongDate = (d) =>
      d ? new Date(d).toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '—';
  
    // Markup primitives
    const section = (title, icon, items, extra = '', accent = 'blue') => `
      <div class="bh-section-card bh-section--${accent}">
        <div class="bh-section-header">
          <div class="bh-section-icon bh-section-icon--${accent}"><i class="bi ${icon}"></i></div>
          <h6 class="bh-section-title">${escapeHtml(title)}</h6>
        </div>
        ${items ? `<div class="bh-kv-grid">${items}</div>` : ''}
        ${extra}
      </div>
    `;
  
    const kv = (label, value, opt = {}) => {
      const classes = ['bh-kv-item'];
      if (opt.full) classes.push('bh-kv-full');
      return `
        <div class="${classes.join(' ')}">
          <div class="bh-kv-label">${escapeHtml(label)}</div>
          <div class="bh-kv-value ${opt.code ? 'bh-kv-value--code' : ''} ${opt.problem ? 'bh-kv-problem' : ''}">${value}</div>
        </div>
      `;
    };
  
    // Status timeline
    const repairStatuses = ['repair_requested','pending_inspection','inspection_scheduled','inspection_in_progress','inspection_completed','awaiting_approval','repair_approved','repair_declined','waiting_parts','parts_reserved','ready_for_repair','repair_scheduled','repair_in_progress','repair_completed','under_warranty','warranty_claim','closed'];
    const timelineSteps = [
      { key: 'pending', label: 'Booked', icon: 'bi-calendar-check' },
      { key: 'confirmed', label: 'Confirmed', icon: 'bi-check-circle' },
      { key: 'repair_requested', label: 'Repair Requested', icon: 'bi-tools' },
      { key: 'inspection_completed', label: 'Inspected', icon: 'bi-clipboard-check' },
      { key: 'awaiting_approval', label: 'Awaiting Approval', icon: 'bi-hourglass-split' },
      { key: 'repair_completed', label: 'Repair Done', icon: 'bi-wrench-adjustable' },
      { key: 'completed', label: 'Completed', icon: 'bi-trophy' },
    ];
    const currentStepIdx = (() => {
      const s = String(b.status || '').toLowerCase();
      if (s === 'completed') return 6;
      if (s === 'repair_completed') return 5;
      if (['awaiting_approval','repair_approved','repair_declined'].includes(s)) return 4;
      if (['inspection_completed','inspection_scheduled','inspection_in_progress','pending_inspection'].includes(s)) return 3;
      if (['repair_requested','waiting_parts','parts_reserved','ready_for_repair','repair_scheduled','repair_in_progress'].includes(s)) return 2;
      if (s === 'confirmed') return 1;
      if (['pending','awaiting_confirmation','payment_verified','awaiting_assignment','re-scheduled'].includes(s)) return 0;
      return -1;
    })();
    const timelineHtml = currentStepIdx >= 0 ? `
      <div class="bh-timeline">
        ${timelineSteps.map((step, i) => `
          <div class="bh-timeline-step ${i < currentStepIdx ? 'bh-timeline--done' : i === currentStepIdx ? 'bh-timeline--current' : ''}">
            <div class="bh-timeline-dot"><i class="bi ${i < currentStepIdx ? 'bi-check-lg' : step.icon}"></i></div>
            <div class="bh-timeline-label">${escapeHtml(step.label)}</div>
          </div>
        `).join('')}
      </div>
    ` : '';
  
    // Hero
    const heroHtml = `
      <div class="bh-hero">
        <div class="bh-hero-top">
          <div class="bh-hero-left">
            <div class="bh-hero-status">${statusBadge(b.status)}</div>
            <h4 class="bh-hero-ref">${escapeHtml(String(bookingRef))}</h4>
            <div class="bh-hero-type"><i class="bi ${isRepair ? 'bi-wrench-adjustable' : 'bi-gear'}"></i> ${escapeHtml(serviceTypeLabel)}${serviceName !== 'Service' ? ` · ${escapeHtml(serviceName)}` : ''}</div>
          </div>
          <div class="bh-hero-right">
            <div class="bh-hero-id">ID: <code>${escapeHtml(String(b._id || '—').slice(-12))}</code></div>
            <div class="bh-hero-created">${escapeHtml(formatDateTime(b.createdAt))}</div>
          </div>
        </div>
        <div class="bh-hero-meta">
          <div class="bh-hero-meta-item"><i class="bi bi-calendar3"></i><span>${escapeHtml(dateText)}</span></div>
          <div class="bh-hero-meta-item"><i class="bi bi-clock"></i><span>${escapeHtml(timeText)}</span></div>
          <div class="bh-hero-meta-item"><i class="bi bi-person-gear"></i><span>${escapeHtml(techText)}</span></div>
          <div class="bh-hero-meta-item"><i class="bi bi-geo-alt"></i><span>${escapeHtml(locationText)}</span></div>
        </div>
        ${timelineHtml}
      </div>
    `;
  
    // Payment section
    const paymentHtml = (() => {
      const pm = b.paymentMethod || '';
      if (!pm) return '';
      const total = Number(b.totalPrice || b.estimatedFee || 0);
      const dp = Number(b.downpaymentAmount || Math.round(total * (Number(b.downpaymentPercentage) || 10) / 100));
      const amountPaid = Number(b.amountPaid || (b.paymentStatus === 'paid' ? total : pm === 'cod' ? dp : 0));
      const balance = Number(b.balanceAmount || (pm === 'cod' ? Math.max(0, total - dp) : 0));
      const methodName = pm === 'cod' ? 'Cash on Delivery' : pm === 'gcash' ? 'GCash' : pm.toUpperCase();
  
      let breakdown = '';
      if (pm === 'cod' && total > 0) {
        breakdown = `
          <div class="bh-payment-card">
            <div class="bh-payment-row">
              <span class="bh-payment-label">Total Service Fee</span>
              <span class="bh-payment-value">${fmtCurrency(total)}</span>
            </div>
            <div class="bh-payment-row">
              <span class="bh-payment-label">Downpayment (paid now)</span>
              <span class="bh-payment-value bh-payment-value--negative">-${fmtCurrency(dp)}</span>
            </div>
            <div class="bh-payment-row bh-payment-total">
              <span class="bh-payment-label">Balance on Completion</span>
              <span class="bh-payment-value ${balance <= 0 ? 'bh-payment-value--success' : 'bh-payment-value--warning'}">${fmtCurrency(balance)}</span>
            </div>
            ${amountPaid > dp ? `
            <div class="bh-payment-row bh-payment-paid">
              <span class="bh-payment-label"><i class="bi bi-check-circle me-1"></i>Total Paid</span>
              <span class="bh-payment-value bh-payment-value--success">${fmtCurrency(amountPaid)}</span>
            </div>` : ''}
          </div>`;
      }
  
      return section('Payment Details', 'bi-cash-coin', `
        ${kv('Method', escapeHtml(methodName))}
        ${kv('Payment Status', statusBadge(b.paymentStatus || 'pending'))}
        ${kv('Total Fee', fmtCurrency(total))}
      `, breakdown, 'blue');
    })();
  
    // Service items
    const serviceItemsHtml = (() => {
      const services = (b.services || []).filter(Boolean);
      if (!services.length) return '';
      const cards = services.map((item, index) => {
        const meta = [item.brand, item.model, item.applianceTypeName || item.airconTypeName]
          .filter(Boolean)
          .join(' · ') || 'Unit details not recorded';
        const typeText = item.type === 'repair'
          ? 'Repair · ' + String(item.phase || 'repair_phase_1').replace(/_/g, ' ')
          : 'Core Service';
        return `
          <div class="bh-service-card">
            <div class="bh-service-head">
              <div>
                <div class="bh-service-name">${index + 1}. ${escapeHtml(item.name || (item.type === 'repair' ? 'Repair' : 'Core Service'))}</div>
                <div class="bh-service-meta">${escapeHtml(meta)} · ${escapeHtml(typeText)}</div>
              </div>
              ${statusBadge(item.status || 'pending')}
            </div>
            ${item.problemDescription || item.repairIssue ? `<div class="bh-service-problem"><strong>Problem:</strong> ${escapeHtml(item.problemDescription || item.repairIssue)}</div>` : ''}
            ${item.quotation?.status === 'submitted' ? `
              <div class="bh-item-quotation">
                <div class="bh-payment-row bh-payment-total">
                  <span class="bh-payment-label">Quoted</span>
                  <span class="bh-payment-value">${fmtCurrency(item.quotation.totalCost)}</span>
                </div>
                <div class="bh-actions-bar bh-actions-bar--inline">
                  <button class="bh-btn bh-btn--success" onclick="window.bhDecideItemQuotation('${b._id}','${item._id}',true)"><i class="bi bi-check-lg me-1"></i>Approve</button>
                  <button class="bh-btn bh-btn--danger" onclick="window.bhDecideItemQuotation('${b._id}','${item._id}',false)"><i class="bi bi-x-lg me-1"></i>Decline</button>
                </div>
              </div>` : ''}
          </div>
        `;
      }).join('');
      return section('Service Items', 'bi-list-check', '', cards, 'purple');
    })();
  
    // Repair quotation
    const quotationHtml = (() => {
      if (!b.quotation?.totalCost) return '';
      const partRows = (b.quotation.parts || []).map(p => `
        <div class="bh-payment-row">
          <span class="bh-payment-label">${escapeHtml(p.name)} <span class="text-muted">×${p.quantity || 1}</span></span>
          <span class="bh-payment-value">${fmtCurrency((p.cost || 0) * (p.quantity || 1))}</span>
        </div>
      `).join('');
      const actions = b.status === 'awaiting_approval' ? `
        <div class="bh-actions-bar bh-actions-bar--inline mt-3">
          <button class="bh-btn bh-btn--success" onclick="bhApproveQuotation('${b._id}')"><i class="bi bi-check-lg me-1"></i>Approve Quotation</button>
          <button class="bh-btn bh-btn--danger" onclick="bhDeclineQuotation('${b._id}')"><i class="bi bi-x-lg me-1"></i>Decline</button>
        </div>` : '';
      return section('Repair Quotation', 'bi-receipt', `
        ${kv('Total', `<span class="bh-kv-value--xl">${fmtCurrency(b.quotation.totalCost)}</span>`)}
        ${b.quotation.notes ? kv('Notes', `<div class="bh-kv-problem">${escapeHtml(b.quotation.notes)}</div>`, { full: true, problem: true }) : ''}
      `, `
        <div class="bh-quotation-card">
          ${partRows}
          <div class="bh-payment-row">
            <span class="bh-payment-label">Labor</span>
            <span class="bh-payment-value">${fmtCurrency(b.quotation.laborCost)}</span>
          </div>
          <div class="bh-payment-row bh-payment-total">
            <span class="bh-payment-label">Quotation Total</span>
            <span class="bh-payment-value bh-payment-value--xl">${fmtCurrency(b.quotation.totalCost)}</span>
          </div>
        </div>
        ${actions}
      `, 'blue');
    })();
  
    // Warranty
    const warrantyHtml = (() => {
      if (!b.warranty?.startDate) return '';
      const chip = b.warranty.status === 'claimed' ? '<span class="badge bg-warning text-dark ms-2">CLAIMED</span>'
        : b.warranty.status === 'expired' ? '<span class="badge bg-secondary ms-2">EXPIRED</span>'
        : '<span class="badge bg-success ms-2">ACTIVE</span>';
      const action = (['completed','repair_completed','under_warranty','warranty_claim'].includes(b.status) && b.warranty.status !== 'expired') ? `
        <div class="bh-actions-bar bh-actions-bar--inline mt-3">
          <button class="bh-btn bh-btn--warning" onclick="window.bhWarrantyClaim('${b._id}')"><i class="bi bi-exclamation-triangle me-1"></i>Report Warranty Issue</button>
        </div>` : '';
      const coverageRows = (b.warranty.coverages || []).map(coverage => kv(
        coverage.serviceName || coverage.coverageType || 'Coverage',
        `${coverage.days || b.warranty.days || 90} days · until ${fmtLongDate(coverage.endDate)}`,
        { full: true }
      )).join('');
      return section('Warranty', 'bi-shield-check', `
        ${kv('Duration', `${b.warranty.days || 90} days`)}
        ${kv('Start', fmtLongDate(b.warranty.startDate))}
        ${kv('End', fmtLongDate(b.warranty.endDate))}
        ${kv('Status', chip)}
        ${coverageRows}
      `, action, 'green');
    })();
  
    // Proposed reschedule
    const proposedRescheduleHtml = (() => {
      if (!['re-scheduled', 'awaiting_assignment'].includes(b.status) || !b.proposedReschedule || b.proposedReschedule.status !== 'pending') return '';
      const passed = isProposedDateTimePassed(b.proposedReschedule);
      const alert = passed ? `<div class="bh-alert bh-alert--danger"><i class="bi bi-exclamation-circle me-1"></i>This proposed schedule has already passed. Please request a new schedule.</div>` : '';
      return section('Proposed Reschedule', 'bi-calendar-check', `
        ${kv('New Date', escapeHtml(fmtLongDate(b.proposedReschedule.date)))}
        ${kv('New Time', escapeHtml(b.proposedReschedule.timeLabel || b.proposedReschedule.time))}
        ${kv('Technician', escapeHtml(b.proposedReschedule.technicianName || 'To be assigned'), { full: true })}
      `, `
        ${alert}
        <div class="bh-actions-bar bh-actions-bar--inline mt-3">
          <button class="bh-btn bh-btn--success" data-reschedule-action="accept" ${passed ? 'disabled' : ''}><i class="bi bi-check-lg me-1"></i>Accept Schedule</button>
          <button class="bh-btn bh-btn--secondary" data-reschedule-action="request_new"><i class="bi bi-calendar-event me-1"></i>Request New Schedule</button>
          <button class="bh-btn bh-btn--danger" data-reschedule-action="cancel"><i class="bi bi-x-lg me-1"></i>Cancel Booking</button>
        </div>
      `, 'blue');
    })();
  
    // Rating
    const ratingHtml = (() => {
      if (b.status !== 'completed') return '';
      if (b.customerRating != null && b.customerRating !== '') {
        return section('Your Rating', 'bi-star-fill', `
          ${kv('Score', `<span class="bh-stars">${ratingStars(b.customerRating)}</span>`)}
          ${b.customerRatingComment ? kv('Comment', `<div class="bh-kv-problem">${escapeHtml(b.customerRatingComment)}</div>`, { full: true, problem: true }) : ''}
        `, '', 'yellow');
      }
      return section('Leave Feedback', 'bi-chat-right-text', '', `
        <div class="bh-rating-cta">
          <span class="text-muted">How was your service experience?</span>
          <button class="bh-rate" data-id="${b._id}"><i class="bi bi-star me-1"></i>Rate this booking</button>
        </div>
      `, 'yellow');
    })();
  
    // Assemble body
    let html = '';
    html += heroHtml;
  
    html += section('Schedule', 'bi-clock-history', `
      ${kv('Date', escapeHtml(dateText))}
      ${kv('Selected Time', escapeHtml(timeText))}
      ${kv('Occupied Block', escapeHtml(occupiedBlock))}
      ${kv('Travel Time', b.travelTime != null ? escapeHtml(String(b.travelTime) + ' min') : '—')}
    `, '', 'green');
  
    html += section('Service & Assignment', 'bi-tools', `
      ${kv('Service', escapeHtml(serviceTypeLabel) + (serviceName !== 'Service' ? ` · ${escapeHtml(serviceName)}` : ''))}
      ${kv('Technician', escapeHtml(String(techText)))}
      ${kv('Estimated Fee', fmtCurrency(b.estimatedFee))}
      ${kv('Location', escapeHtml(locationText), { full: true })}
    `, '', 'purple');
  
    if (b.unitInfo || isRepair || (b.status && String(b.status).startsWith('repair_')) || repairStatuses.includes(b.status)) {
      html += section('Unit Information', 'bi-wrench', `
        ${kv('Unit Type', escapeHtml(b.unitInfo?.unitType || '—'))}
        ${kv('Brand', escapeHtml(b.unitInfo?.brand || '—'))}
        ${kv('Model', escapeHtml(b.unitInfo?.model || 'N/A'))}
        ${kv('Problem', `<div class="bh-kv-problem">${escapeHtml(b.unitInfo?.problemDescription || b.issueDescription || '—')}</div>`, { full: true, problem: true })}
      `, '', 'orange');
    }
  
    if (b.preferredDate && !isRepair) {
      html += section('Preferred Schedule', 'bi-calendar-event', `
        ${kv('Date', escapeHtml(fmtLongDate(b.preferredDate)))}
        ${kv('Time', escapeHtml(b.preferredTime || '—'))}
      `, '', 'green');
    }
  
    if (serviceItemsHtml) {
      html += serviceItemsHtml;
    }
  
    html += paymentHtml;
  
    if (b.inspection?.completedAt) {
      html += section('Inspection Results', 'bi-clipboard-check', `
        ${kv('Findings', `<div class="bh-kv-problem">${escapeHtml(b.inspection.findings || '—')}</div>`, { full: true, problem: true })}
        ${b.inspection.damagedParts?.length ? kv('Damaged Parts', escapeHtml(b.inspection.damagedParts.join(', '))) : ''}
        ${b.inspection.laborRequired ? kv('Labor Required', escapeHtml(b.inspection.laborRequired)) : ''}
      `, '', 'orange');
    }
  
    html += quotationHtml;
    html += warrantyHtml;
  
    if (proposedRescheduleHtml) {
      html += `<div id="bhRescheduleActionPanel" data-booking-id="${b._id}">${proposedRescheduleHtml}</div>`;
    }
  
    if (b.notes) {
      html += section('Notes', 'bi-file-text', kv('Notes', `<div class="bh-kv-problem">${escapeHtml(String(b.notes))}</div>`, { full: true, problem: true }), '', 'slate');
    }
  
    html += ratingHtml;
  
    el.modalBody.innerHTML = html;
  
    // Wire controls
    el.downloadJsonBtn.onclick = () => downloadJSON(b, `booking-${shortId(b._id)}.json`);
  
    setTimeout(() => {
      el.modalBody.querySelectorAll('[data-reschedule-action]').forEach(btn => {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          const action = this.getAttribute('data-reschedule-action');
          if (action === 'accept' || action === 'cancel') window.bhRescheduleAction(b._id, action);
          else if (action === 'request_new') window.bhRequestNewSchedule(b._id);
        });
      });
      const rateBtn = el.modalBody.querySelector('.bh-rate');
      if (rateBtn) {
        rateBtn.addEventListener('click', function () {
          const techText = b.technicianName || (b.technician && b.technician.name) || null;
          if (window.openRatingModal) window.openRatingModal(b._id, b.serviceType || 'Service', techText);
        });
      }
    }, 0);
  
    const modalInstance = ensureModalInstance();
    if (modalInstance) {
      modalInstance.show();
      const xBtn = el.modalElement.querySelector('.bh-modal-close');
      const closeBtn = el.modalElement.querySelector('.bh-modal-footer .bh-btn-primary');
      const doClose = () => { try { modalInstance.hide(); } catch (e) { /* ignore */ } };
      if (xBtn) xBtn.addEventListener('click', doClose);
      if (closeBtn) closeBtn.addEventListener('click', doClose);
    } else {
      console.warn('Bootstrap Modal unavailable.');
    }
  }

  function applyFilters() {
    const q = (el.search.value || "").toLowerCase().trim();
    const status = (el.status.value || "all").toLowerCase();
    const from = el.from.value ? new Date(el.from.value) : null;
    const to = el.to.value ? new Date(el.to.value) : null;
    if (to) {
      to.setHours(23, 59, 59, 999);
    }

    filtered = bookings.filter((b) => {
      // client-side ownership filter
      if (userId && !bookingBelongsToUser(b)) return false;

      // status filter
      if (status !== "all" && String(b.status || "").toLowerCase() !== status)
        return false;

      // date range
      if (from || to) {
        const dt = b.bookingDate
          ? new Date(b.bookingDate)
          : b.createdAt
            ? new Date(b.createdAt)
            : null;
        if (!dt) return false;
        if (from && dt < from) return false;
        if (to && dt > to) return false;
      }

      // search
      if (q) {
        const hay = [
          String(b._id || ""),
          String(b.serviceType || ""),
          String(b.status || ""),
          String(b.notes || ""),
          String(b.technicianId || ""),
          String((b.location && b.location.address) || ""),
        ]
          .join(" ")
          .toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }

      return true;
    });

    // most-recent-first
    filtered.sort(
      (a, b) =>
        new Date(b.bookingDate || b.createdAt) -
        new Date(a.bookingDate || a.createdAt),
    );

    page = 0;
    renderTable();
  }

  function createSampleBookings() {
    const now = new Date();
    const sampleOwnerId = userId || undefined;
    const sampleOwner = userEmail || "guest@example.com";
    return [
      {
        _id: "sample0000000000000001",
        customerId: sampleOwnerId,
        customer: sampleOwner,
        serviceType: "core",
        serviceId: "core-101",
        bookingDate: new Date(
          now.getTime() - 7 * 24 * 3600 * 1000,
        ).toISOString(),
        startTime: "09:00",
        status: "completed",
        location: { address: "Brgy. San Isidro, Sample City" },
        technicianId: "Tech-001",
        createdAt: new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString(),
        notes: "Sample completed booking — AC maintenance.",
      },
      {
        _id: "sample0000000000000002",
        customerId: sampleOwnerId,
        customer: sampleOwner,
        serviceType: "repair",
        serviceId: "repair-201",
        bookingDate: new Date(
          now.getTime() + 2 * 24 * 3600 * 1000,
        ).toISOString(),
        startTime: "13:00",
        status: "pending",
        location: { address: "Brgy. Santa Maria, Example Town" },
        technicianId: "Tech-007",
        createdAt: new Date(now.getTime() - 1 * 24 * 3600 * 1000).toISOString(),
        notes: "Sample pending booking — diagnostics.",
      },
      {
        _id: "sample0000000000000003",
        customerId: sampleOwnerId,
        customer: sampleOwner,
        serviceType: "core",
        serviceId: "core-103",
        bookingDate: new Date(
          now.getTime() + 10 * 24 * 3600 * 1000,
        ).toISOString(),
        startTime: "15:30",
        status: "confirmed",
        location: { address: "Brgy. Poblacion, Demo City" },
        technicianId: "Tech-003",
        createdAt: new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString(),
        notes: "Sample confirmed booking — installation.",
      },
    ];
  }

  window.bhDecideItemQuotation = async function(bookingId, itemId, approved) {
    if (!confirm(`${approved ? "Approve" : "Decline"} this service-item quotation?`)) return;
    try {
      const response = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/service-items/${encodeURIComponent(itemId)}/quotation-decision`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ approved }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Decision failed");
      const detail = ensureModalInstance(); if (detail) detail.hide(); await fetchBookings();
    } catch (error) { alert(error.message); }
  };

  async function openBookingEditor(bookingId, focusTab) {
    try {
      const booking = bookings.find(x => String(x._id) === String(bookingId));
      const [itemsResponse, catalogResponse, categoriesResponse] = await Promise.all([
        fetch(`/api/bookings/${encodeURIComponent(bookingId)}/service-items`, { credentials: "include" }),
        fetch("/api/services", { credentials: "include" }),
        fetch("/api/services/categories", { credentials: "include" }),
      ]);
      const state = await itemsResponse.json();
      const catalog = await catalogResponse.json();
      const categoriesData = await categoriesResponse.json();
      if (!itemsResponse.ok) throw new Error(state.error || "Unable to load booking services");
      if (!catalogResponse.ok) throw new Error(catalog.error || "Unable to load service catalog");
      const core = catalog.coreServices || [];
      const repair = catalog.repairs || [];
      const categories = categoriesData.categories || [];
      const rows = (state.services || []).map(item => ({ ...item }));
      let selectedDate = null;
      let selectedTime = null;

      const activeTab = focusTab === "schedule" ? "schedule" : "services";

      let host = document.getElementById("bhBookingEditorModal");
      if (!host) host = document.createElement("div");
      host.id = "bhBookingEditorModal";
      host.className = "modal fade";
      host.tabIndex = -1;
      host.innerHTML = `
      <div class="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable">
        <div class="modal-content border-0 rounded-4 shadow-lg" style="overflow:hidden">
          <div class="modal-header border-bottom" style="background:linear-gradient(135deg,#f8fafc,#eff6ff);padding:20px 28px 16px">
            <div class="d-flex align-items-center gap-3">
              <div class="rounded-3 d-flex align-items-center justify-content-center" style="width:48px;height:48px;background:linear-gradient(135deg,#2563eb,#1d4ed8)"><i class="bi bi-pencil-square text-white fs-5"></i></div>
              <div>
                <h5 class="modal-title fw-bold mb-0" style="color:#1e293b;font-size:1.1rem">Edit Booking</h5>
                <div class="small text-muted mt-1" id="bhEditorPolicy">${state.policy?.direct ? "Changes apply immediately — this booking is not yet assigned." : "Changes will be submitted for administrator review."}</div>
              </div>
            </div>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body p-0" style="background:#fff">
            <ul class="nav nav-tabs nav-fill border-bottom fw-semibold" id="bhEditorTabs" role="tablist" style="background:#f8fafc">
              <li class="nav-item" role="presentation">
                <button class="nav-link ${activeTab === 'services' ? 'active' : ''}" id="bh-tab-services" data-bs-toggle="tab" data-bs-target="#bh-pane-services" type="button" role="tab" aria-selected="${activeTab === 'services'}">
                  <i class="bi bi-list-check me-2"></i>Services
                  <span class="badge bg-primary rounded-pill ms-1" style="font-size:.65rem" id="bhServiceCount">${rows.length}</span>
                </button>
              </li>
              <li class="nav-item" role="presentation">
                <button class="nav-link ${activeTab === 'schedule' ? 'active' : ''}" id="bh-tab-schedule" data-bs-toggle="tab" data-bs-target="#bh-pane-schedule" type="button" role="tab" aria-selected="${activeTab === 'schedule'}">
                  <i class="bi bi-calendar-event me-2"></i>Schedule
                  ${booking?.bookingDate ? `<span class="badge bg-secondary rounded-pill ms-1" style="font-size:.65rem">${new Date(booking.bookingDate).toLocaleDateString('en-PH',{month:'short',day:'numeric'})}</span>` : ''}
                </button>
              </li>
            </ul>
            <div class="tab-content p-4" id="bhEditorTabContent">
              <div class="tab-pane fade ${activeTab === 'services' ? 'show active' : ''}" id="bh-pane-services" role="tabpanel">
                <div id="bhScheduleProposal"></div>
                <div class="mb-4">
                  <h6 class="fw-bold text-uppercase text-muted mb-3" style="font-size:.7rem;letter-spacing:.05em;"><i class="bi bi-list-check me-1"></i>Current Service Items</h6>
                  <div id="bhCurrentItems"></div>
                </div>
                <hr class="my-3">
                <h6 class="fw-bold text-uppercase text-muted mb-3" style="font-size:.7rem;letter-spacing:.05em;"><i class="bi bi-plus-circle me-1"></i>Add Service</h6>
                <ul class="nav nav-pills mb-3" id="bhAddTabs" role="tablist">
                  <li class="nav-item"><button class="nav-link active" id="bh-core-tab" data-bs-toggle="pill" data-bs-target="#bh-core-pane" type="button" role="pill"><i class="bi bi-gear me-2"></i>Core Services</button></li>
                  <li class="nav-item"><button class="nav-link" id="bh-repair-tab" data-bs-toggle="pill" data-bs-target="#bh-repair-pane" type="button" role="pill"><i class="bi bi-tools me-2"></i>Repair Services</button></li>
                </ul>
                <div class="tab-content" id="bhAddTabContent">
                  <div class="tab-pane fade show active" id="bh-core-pane" role="tabpanel">
                    <div class="d-flex align-items-center gap-3 mb-3 p-3 rounded-4" style="background:linear-gradient(135deg,#eff6ff,#dbeafe)">
                      <div class="rounded-3 d-flex align-items-center justify-content-center" style="width:48px;height:48px;background:#fff"><i class="bi bi-gear fs-4 text-primary"></i></div>
                      <div><h6 class="fw-bold mb-0" style="color:#1e293b;font-size:.95rem">Core Services</h6><p class="mb-0 small text-muted">Professional maintenance, installation & servicing</p></div>
                    </div>
                    <div class="row g-3" id="bhCoreGrid"></div>
                  </div>
                  <div class="tab-pane fade" id="bh-repair-pane" role="tabpanel">
                    <div class="d-flex align-items-center gap-3 mb-3 p-3 rounded-4" style="background:linear-gradient(135deg,#eff6ff,#dbeafe)">
                      <div class="rounded-3 d-flex align-items-center justify-content-center" style="width:48px;height:48px;background:#fff"><i class="bi bi-wrench-adjustable-circle fs-4 text-primary"></i></div>
                      <div><h6 class="fw-bold mb-0" style="color:#1e293b;font-size:.95rem">Repair Service Configuration</h6><p class="mb-0 small text-muted">Configure repair request step by step.</p></div>
                    </div>
                    <div class="d-flex flex-column gap-3" id="bhRepairSteps">
                      <div class="p-3 rounded-4" style="background:#f8fafc;border:1px solid #e2e8f0" data-step="1">
                        <div class="d-flex align-items-center gap-2 mb-3"><span class="rounded-circle d-flex align-items-center justify-content-center text-white fw-bold" style="width:28px;height:28px;font-size:.8rem;background:#2563eb">1</span><div><h6 class="fw-bold mb-0" style="font-size:.9rem">Service Category</h6><p class="small text-muted mb-0">Select the type of equipment.</p></div></div>
                        <div class="row g-2" id="bhCatGrid"></div>
                      </div>
                      <div class="p-3 rounded-4 d-none" style="background:#f8fafc;border:1px solid #e2e8f0" data-step="2">
                        <div class="d-flex align-items-center gap-2 mb-3"><span class="rounded-circle d-flex align-items-center justify-content-center text-white fw-bold" style="width:28px;height:28px;font-size:.8rem;background:#2563eb">2</span><div><h6 class="fw-bold mb-0" style="font-size:.9rem">Specific Unit Type</h6><p class="small text-muted mb-0">Choose the model or configuration.</p></div></div>
                        <div class="d-flex flex-wrap gap-2" id="bhUnitChips"></div>
                      </div>
                      <div class="p-3 rounded-4" style="background:#f8fafc;border:1px solid #e2e8f0" data-step="3">
                        <div class="d-flex align-items-center gap-2 mb-3"><span class="rounded-circle d-flex align-items-center justify-content-center text-white fw-bold" style="width:28px;height:28px;font-size:.8rem;background:#2563eb">3</span><div><h6 class="fw-bold mb-0" style="font-size:.9rem">Unit Specifications</h6><p class="small text-muted mb-0">Basic identifiers for the technician.</p></div></div>
                        <div class="row g-2">
                          <div class="col-md-6"><label class="form-label small text-muted">Brand <span class="text-danger">*</span></label><input class="form-control" id="bhRepairBrand" placeholder="e.g. Carrier, Samsung, LG" maxlength="100"></div>
                          <div class="col-md-6"><label class="form-label small text-muted">Model Number <span class="text-muted">(optional)</span></label><input class="form-control" id="bhRepairModel" placeholder="e.g. 42KDPV48" maxlength="100"></div>
                          <div class="col-md-6">
                            <label class="form-label small text-muted">Number of Units</label>
                            <div class="input-group" style="max-width:160px"><button class="btn btn-outline-secondary" type="button" id="bhRepairQtyMinus">&minus;</button><input class="form-control text-center" id="bhRepairQty" type="number" min="1" max="40" value="1"><button class="btn btn-outline-secondary" type="button" id="bhRepairQtyPlus">+</button></div>
                          </div>
                          <div class="col-md-6"><label class="form-label small text-muted">Repair Service <span class="text-danger">*</span></label><select class="form-select" id="bhRepairSelect"></select></div>
                        </div>
                      </div>
                      <div class="p-3 rounded-4" style="background:#f8fafc;border:1px solid #e2e8f0" data-step="4">
                        <div class="d-flex align-items-center gap-2 mb-3"><span class="rounded-circle d-flex align-items-center justify-content-center text-white fw-bold" style="width:28px;height:28px;font-size:.8rem;background:#2563eb">4</span><div><h6 class="fw-bold mb-0" style="font-size:.9rem">Problem Description</h6><p class="small text-muted mb-0">Tap symptoms, then add details.</p></div></div>
                        <div class="d-flex flex-wrap gap-2 mb-2" id="bhSymptomChips">
                          ${["Not Cooling","Strange Noise","Leaking Water","Not Turning On","Bad Smell","Error Code","Overheating","Electrical Issue"].map(s => `<button type="button" class="btn btn-sm btn-outline-secondary bh-symptom rounded-pill" data-symptom="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("")}
                        </div>
                        <label class="form-label small text-muted">Detailed Issue <span class="text-danger">*</span></label>
                        <textarea class="form-control" id="bhRepairProblem" rows="3" maxlength="2000" placeholder="Describe the problem in detail."></textarea>
                        <div class="d-flex justify-content-between align-items-center mt-2"><span class="small text-muted"><i class="bi bi-info-circle me-1"></i>The more details, the better.</span><span class="small text-muted" id="bhCharCount">0 / 500</span></div>
                      </div>
                      <button class="btn btn-primary" id="bhAddRepair" disabled><i class="bi bi-plus-circle me-2"></i>Add Repair Service</button>
                    </div>
                  </div>
                </div>
                <hr class="my-3">
                <div><label class="form-label fw-bold small text-uppercase text-muted" style="font-size:.65rem;letter-spacing:.05em;"><i class="bi bi-chat-square-text me-1"></i>Reason for change</label><textarea class="form-control" id="bhServiceChangeReason" rows="2" maxlength="1000" placeholder="Explain why these services need to change"></textarea></div>
              </div>
              <div class="tab-pane fade ${activeTab === 'schedule' ? 'show active' : ''}" id="bh-pane-schedule" role="tabpanel">
                <div class="d-flex align-items-start gap-3 p-3 rounded-4 mb-4" style="background:linear-gradient(135deg,#eff6ff,#dbeafe)">
                  <div class="rounded-3 d-flex align-items-center justify-content-center" style="width:48px;height:48px;background:#fff;flex-shrink:0"><i class="bi bi-calendar-event fs-4 text-primary"></i></div>
                  <div><h6 class="fw-bold mb-1" style="color:#1e293b">Reschedule this booking</h6><p class="small text-muted mb-0">Choose a new available date and time slot. Your request will be sent for confirmation.</p></div>
                </div>
                ${booking ? `<div class="row g-3 mb-4">
                  <div class="col-md-6"><div class="p-3 rounded-4 border"><div class="small text-muted text-uppercase fw-semibold mb-1" style="font-size:.65rem">Current Date</div><div class="fw-bold" style="color:#1e293b">${booking.bookingDate ? new Date(booking.bookingDate).toLocaleDateString('en-PH',{weekday:'long',month:'long',day:'numeric',year:'numeric'}) : 'Not set'}</div></div></div>
                  <div class="col-md-6"><div class="p-3 rounded-4 border"><div class="small text-muted text-uppercase fw-semibold mb-1" style="font-size:.65rem">Current Time</div><div class="fw-bold" style="color:#1e293b">${escapeHtml(booking.startTime || booking.selectedTimeLabel || 'Not set')}</div></div></div>
                </div>` : ''}
                <div class="p-3 rounded-4 border mb-3" style="background:#f8fafc">
                  <div class="fw-semibold mb-2" style="font-size:.85rem"><i class="bi bi-calendar3 me-2 text-primary"></i>Select New Date & Time</div>
                  <div id="bhEditorCalendarLoading" class="text-center py-3"><div class="spinner-border spinner-border-sm text-primary" role="status"></div><p class="small text-muted mt-1 mb-0">Loading available dates...</p></div>
                  <div id="bhEditorCalendarError" class="alert alert-danger d-none small mb-0"></div>
                  <div id="bhEditorCalendarContent" class="d-none">
                    <div id="calendarGrid"></div>
                    <div id="timeSelection" class="d-none mt-3"><div id="timeSlots"></div></div>
                  </div>
                </div>
                <div id="bhEditorSelection" class="alert alert-success d-none">
                  <div class="fw-bold"><i class="bi bi-check-circle me-1"></i>New Selection</div>
                  <div id="bhEditorSelectionText"></div>
                </div>
                <div class="mt-3">
                  <label class="form-label fw-semibold">Reason for rescheduling</label>
                  <textarea class="form-control" id="bhEditorRescheduleReason" rows="2" placeholder="Optional: why do you need to reschedule?"></textarea>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer border-top" style="background:#f8fafc;padding:16px 28px">
            <button type="button" class="btn btn-light" data-bs-dismiss="modal"><i class="bi bi-x-lg me-1"></i>Cancel</button>
            <div class="d-flex align-items-center gap-2">
              <button class="btn btn-primary" id="bhEditorSave"><i class="bi bi-check-lg me-1"></i>Save Changes</button>
            </div>
          </div>
        </div>
      </div>`;
      if (!host.parentNode) document.body.appendChild(host);
      const bodyHost = host.querySelector("#bhEditorTabContent");

      const scheduleProposal = [...(state.changeRequests || [])].reverse().find(change => change.status === "schedule_proposed");
      const proposalHost = bodyHost.querySelector("#bhScheduleProposal");
      proposalHost.innerHTML = scheduleProposal ? `<div class="alert alert-warning border-warning-subtle rounded-3 mb-3"><div class="fw-bold mb-1"><i class="bi bi-calendar2-check me-2"></i>Administrator proposed a new schedule</div><div class="mb-3">${escapeHtml(new Date(scheduleProposal.proposedSchedule.date).toLocaleDateString())}, ${escapeHtml(scheduleProposal.proposedSchedule.startTime)}–${escapeHtml(scheduleProposal.proposedSchedule.endTime)}</div><div class="d-flex gap-2"><button class="btn btn-success btn-sm bh-schedule-response" data-accept="true">Accept schedule</button><button class="btn btn-outline-danger btn-sm bh-schedule-response" data-accept="false">Decline</button></div></div>` : "";
      proposalHost.querySelectorAll(".bh-schedule-response").forEach(button => button.onclick = async () => {
        const accept = button.dataset.accept === "true";
        if (!confirm(`${accept ? "Accept" : "Decline"} the proposed schedule?`)) return;
        button.disabled = true;
        try {
          const response = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/service-change-requests/${encodeURIComponent(scheduleProposal._id)}/schedule-response`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify({ accept }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Unable to process schedule response");
          alert(accept ? "The new schedule was accepted." : "The administrator was notified to propose another schedule.");
          bootstrap.Modal.getOrCreateInstance(host).hide(); await fetchBookings();
        } catch (error) { alert(error.message); button.disabled = false; }
      });

      let selectedCategory = null;
      let selectedUnitType = null;
      let selectedSymptoms = [];

      function updateServiceCount() {
        const badge = host.querySelector("#bhServiceCount");
        if (badge) badge.textContent = rows.length;
      }

      function renderCurrentItems() {
        const itemsHost = bodyHost.querySelector("#bhCurrentItems");
        if (!rows.length) { itemsHost.innerHTML = '<div class="text-muted small py-3 text-center"><i class="bi bi-inbox d-block fs-3 mb-2" style="color:#cbd5e1"></i>No service items yet. Add one below.</div>'; updateServiceCount(); return; }
        itemsHost.innerHTML = rows.map((row, index) => {
          const svc = (row.type === "repair" ? repair : core).find(s => String(s._id) === String(row.serviceId));
          const svcName = svc?.name || row.name || "Service";
          const details = [row.brand, row.model, row.applianceTypeName || row.airconTypeName, row.hp ? row.hp + " HP" : ""].filter(Boolean).join(" · ");
          const problem = row.problemDescription || row.repairIssue || "";
          const price = Number(row.totalPrice || row.unitPrice || 0);
          return `<div class="card border rounded-3 mb-2" style="border-color:#e2e8f0!important"><div class="card-body py-2 px-3"><div class="d-flex justify-content-between align-items-start"><div class="flex-grow-1"><div class="d-flex align-items-center gap-2 mb-1"><span class="badge rounded-pill ${row.type === 'repair' ? 'bg-warning text-dark' : 'bg-primary'}" style="font-size:.6rem">${row.type === 'repair' ? 'Repair' : 'Core'}</span><strong style="font-size:.85rem">${escapeHtml(svcName)}</strong>${price ? `<span class="badge bg-light text-muted rounded-pill" style="font-size:.6rem">₱${price.toLocaleString()}</span>` : ''}</div>${details ? `<div class="small text-muted">${escapeHtml(details)} · Qty ${Number(row.quantity||1)}</div>` : ''}${problem ? `<div class="small text-muted mt-1"><i class="bi bi-chat-square-text me-1"></i>${escapeHtml(problem)}</div>` : ''}</div><button type="button" class="btn btn-sm btn-outline-danger py-0 px-2" onclick="window._bhRemoveItem(${index})" title="Remove"><i class="bi bi-trash"></i></button></div></div></div>`;
        }).join("");
        updateServiceCount();
      }
      window._bhRemoveItem = function(idx) { rows.splice(idx, 1); renderCurrentItems(); };

      function formatDuration(svc, hp) {
        if (hp?.durationMinutes) return `${hp.durationMinutes} min`;
        if (svc.durationMinutes) return `${svc.durationMinutes} min`;
        if (svc.estimatedDurationMinutes) return `${svc.estimatedDurationMinutes} min`;
        return 'Duration TBD';
      }

      function showCoreConfigureModal(svc) {
        const hasAirconTypes = svc.isAirconService && svc.airconTypes && svc.airconTypes.length > 0;
        const hasLegacyHp = svc.isAirconService && svc.hpPricing && svc.hpPricing.length > 0;
        if (!hasAirconTypes && !hasLegacyHp) {
          rows.push({ type: "core", serviceId: svc._id, name: svc.name, quantity: 1, brand: "", model: "", unitPrice: svc.basePrice || 0, totalPrice: svc.basePrice || 0 });
          renderCurrentItems();
          return;
        }
        let hpModal = document.getElementById("bhHpModal");
        if (hpModal) hpModal.remove();
        hpModal = document.createElement("div");
        hpModal.id = "bhHpModal"; hpModal.className = "modal fade"; hpModal.tabIndex = -1;
        const allTypes = hasAirconTypes ? svc.airconTypes : [{ type: '', name: 'Standard', hpPricing: svc.hpPricing, description: '', durationMinutes: svc.durationMinutes }];
        const allPrices = allTypes.flatMap(at => (at.hpPricing || []).map(h => h.price)).filter(Boolean);
        const globalMin = allPrices.length ? Math.min(...allPrices) : 0;
        const globalMax = allPrices.length ? Math.max(...allPrices) : 0;
        const typeCards = allTypes.map((at, i) => `<div class="col-6 col-md-4"><div class="card bh-aircon-type-card h-100 text-center" data-aircon-index="${i}"><div class="card-body py-3 px-2"><i class="bi bi-snow fs-1 text-info"></i><h6 class="fw-bold mt-2 mb-1" style="font-size:.85rem">${escapeHtml(at.name)}</h6><p class="small text-muted mb-1 d-none d-md-block" style="font-size:.72rem;line-height:1.3">${escapeHtml(at.description || 'Standard aircon unit')}</p><span class="badge bg-success-subtle text-success" style="background:#dcfce7;color:#166534;font-size:.65rem">₱${Math.min(...(at.hpPricing||[]).map(h=>h.price)).toLocaleString()} - ₱${Math.max(...(at.hpPricing||[]).map(h=>h.price)).toLocaleString()}</span></div></div></div>`).join("");
        hpModal.innerHTML = `
          <div class="modal-dialog modal-lg modal-fullscreen-sm-down modal-dialog-centered modal-dialog-scrollable">
            <div class="modal-content border-0 rounded-4 shadow" data-bh-hp-modal>
              <style data-bh-hp-style>
                [data-bh-hp-modal] .bh-aircon-type-card{border:1.5px solid #e2e8f0;border-radius:1rem;cursor:pointer;transition:all .15s;background:#fff}
                [data-bh-hp-modal] .bh-aircon-type-card:hover,[data-bh-hp-modal] .bh-aircon-type-card.active{border-color:#2563eb;background:#eff6ff;transform:translateY(-2px);box-shadow:0 4px 12px rgba(37,99,235,.12)}
                [data-bh-hp-modal] .bh-hp-card{border:1.5px solid #e2e8f0;border-radius:1rem;cursor:pointer;transition:all .15s;background:#fff}
                [data-bh-hp-modal] .bh-hp-card:hover,[data-bh-hp-modal] .bh-hp-card.selected{border-color:#2563eb;background:#eff6ff;box-shadow:0 4px 12px rgba(37,99,235,.12)}
                [data-bh-hp-modal] .bh-hp-card .form-check-input{cursor:pointer;width:1.15rem;height:1.15rem}
                [data-bh-hp-modal] .bh-qty-group{flex:0 0 auto}
                [data-bh-hp-modal] .modal-footer .btn{min-height:44px}
                @media(max-width:575.98px){
                  [data-bh-hp-modal] .modal-body{padding:1rem}
                  [data-bh-hp-modal] .bh-hp-card .card-body{flex-direction:column;align-items:flex-start;gap:.75rem}
                  [data-bh-hp-modal] .bh-hp-card .bh-hp-meta{width:100%;text-align:left}
                  [data-bh-hp-modal] .bh-qty-group{margin-left:0;width:100%;justify-content:space-between}
                  [data-bh-hp-modal] .modal-footer{flex-wrap:wrap;gap:.5rem;padding:.75rem}
                  [data-bh-hp-modal] .modal-footer .btn,[data-bh-hp-modal] .modal-footer>div{flex:1 1 auto;min-width:120px}
                  [data-bh-hp-modal] .modal-footer .btn-primary{order:3;width:100%}
                }
              </style>
              <div class="modal-header text-white" style="background:linear-gradient(135deg,#2563eb,#1d4ed8)">
                <div class="d-flex align-items-center gap-2"><div class="rounded-3 d-flex align-items-center justify-content-center" style="width:40px;height:40px;background:rgba(255,255,255,.2)"><i class="bi bi-box-seam"></i></div><div><h5 class="modal-title fw-bold mb-0" style="font-size:1.05rem">Configure Service</h5><p class="mb-0 small" style="opacity:.85">Select aircon type & HP rating</p></div></div>
                <button class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body p-3 p-md-4">
                <h5 class="fw-bold mb-3" style="color:#1e293b">${escapeHtml(svc.name)}</h5>
                <div class="mb-3"><label class="form-label fw-bold small">Brand Name <span class="text-danger">*</span></label><select class="form-select" id="bhHpBrandSelect"><option value="">Select brand...</option>${(svc.brands || []).map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("")}</select><input class="form-control mt-2 d-none" id="bhHpBrandOther" placeholder="Enter brand" maxlength="100"></div>
                <div class="d-flex align-items-center gap-2 mb-3"><div class="rounded-circle d-flex align-items-center justify-content-center fw-bold text-white" style="width:28px;height:28px;font-size:.8rem;background:#2563eb">1</div><h6 class="fw-bold mb-0" style="font-size:.9rem">Select Aircon Type</h6></div>
                <p class="small text-muted">Choose the type of aircon unit. Prices vary by type and HP rating.</p>
                <div class="row g-3" id="bhAirconTypeGrid">${typeCards}</div>
                <div id="bhHpOptionsSection" class="d-none mt-4">
                  <div class="d-flex align-items-center gap-2 mb-2"><div class="rounded-circle d-flex align-items-center justify-content-center fw-bold text-white" style="width:28px;height:28px;font-size:.8rem;background:#2563eb">2</div><h6 class="fw-bold mb-0" style="font-size:.9rem">Select HP Rating(s)</h6></div>
                  <p class="small text-muted">Choose the horsepower rating and quantity for each unit.</p>
                  <div class="d-flex flex-column gap-2" id="bhHpOptionsList"></div>
                </div>
                <div class="alert alert-light border rounded-3 mt-3" role="alert"><i class="bi bi-info-circle me-2 text-info"></i>Final pricing may be confirmed by the technician after inspection.</div>
              </div>
              <div class="modal-footer bg-light border-top flex-wrap justify-content-between gap-2">
                <button class="btn btn-light" data-bs-dismiss="modal">Cancel</button>
                <div class="d-flex align-items-center gap-2 p-2 rounded-3 flex-fill justify-content-center" style="background:#fff;border:1px solid #e2e8f0;min-width:140px"><div><div class="small text-muted">Estimated Price:</div><div class="small" style="color:#64748b">Includes service & travel</div></div><div class="fw-bold fs-5 text-primary" id="bhHpEstimatedPrice">₱0</div></div>
                <button class="btn btn-primary ms-md-auto" id="bhHpAddToBooking" disabled><i class="bi bi-check-lg me-1"></i>Add to Booking</button>
              </div>
            </div>
          </div>`;
        document.body.appendChild(hpModal);

        const brandSelect = hpModal.querySelector("#bhHpBrandSelect");
        const brandOther = hpModal.querySelector("#bhHpBrandOther");
        brandSelect.onchange = () => {
          if (brandSelect.value === "__other__") { brandOther.classList.remove("d-none"); brandOther.focus(); }
          else { brandOther.classList.add("d-none"); brandOther.value = ""; }
        };

        let selectedAirconIndex = null;
        let selectedHp = null;

        function updateEstimatedPrice() {
          if (!selectedHp) { hpModal.querySelector("#bhHpEstimatedPrice").textContent = "₱0"; return; }
          const qty = Math.max(1, Number(hpModal.querySelector("#bhHpQtyInput")?.value) || 1);
          hpModal.querySelector("#bhHpEstimatedPrice").textContent = `₱${(selectedHp.price * qty).toLocaleString()}`;
        }

        function renderHpOptions(type) {
          const list = hpModal.querySelector("#bhHpOptionsList");
          list.innerHTML = (type.hpPricing || []).map((hp, i) => {
            const duration = formatDuration(svc, hp);
            return `<div class="card bh-hp-card" data-hp-index="${i}" data-hp="${hp.hp}" data-price="${hp.price}" data-duration="${hp.durationMinutes || ''}">
              <div class="card-body d-flex justify-content-between align-items-center gap-3 py-3">
                <div class="d-flex align-items-center gap-3">
                  <input class="form-check-input" type="radio" name="bhHpOption" value="${i}">
                  <div><span class="badge bg-primary rounded-pill mb-1">${hp.hp} HP</span><div class="fw-bold fs-5 text-primary">₱${Number(hp.price).toLocaleString()}</div></div>
                </div>
                <div class="bh-hp-meta text-center" style="min-width:120px"><div class="small text-muted"><i class="bi bi-clock me-1"></i>${duration}</div><div class="small text-muted">${escapeHtml(hp.description || '')}</div></div>
                <div class="bh-qty-group d-flex align-items-center gap-2">
                  <span class="small text-muted d-none d-md-inline">Quantity:</span>
                  <div class="input-group" style="width:120px"><button class="btn btn-outline-secondary" type="button" id="bhHpQtyMinus">&minus;</button><input class="form-control text-center" id="bhHpQtyInput" type="number" min="1" max="40" value="1" readonly><button class="btn btn-outline-secondary" type="button" id="bhHpQtyPlus">+</button></div>
                </div>
              </div>
            </div>`;
          }).join("");
          list.querySelectorAll("[data-hp-index]").forEach(card => {
            card.onclick = (e) => {
              if (e.target.tagName === "BUTTON" || e.target.id === "bhHpQtyInput") return;
              list.querySelectorAll("[data-hp-index]").forEach(c => c.classList.remove("selected"));
              list.querySelectorAll("[data-hp-index] input").forEach(c => c.checked = false);
              card.classList.add("selected");
              card.querySelector("input").checked = true;
              selectedHp = { hp: parseFloat(card.dataset.hp), price: parseFloat(card.dataset.price), durationMinutes: parseFloat(card.dataset.duration) || null };
              hpModal.querySelector("#bhHpAddToBooking").disabled = false;
              updateEstimatedPrice();
            };
          });
          list.querySelector("#bhHpQtyMinus").onclick = () => { const inp = list.querySelector("#bhHpQtyInput"); inp.value = Math.max(1, Number(inp.value) - 1); updateEstimatedPrice(); };
          list.querySelector("#bhHpQtyPlus").onclick = () => { const inp = list.querySelector("#bhHpQtyInput"); inp.value = Math.min(40, Number(inp.value) + 1); updateEstimatedPrice(); };
          list.querySelector("#bhHpQtyInput").oninput = () => updateEstimatedPrice();
        }

        hpModal.querySelectorAll("#bhAirconTypeGrid [data-aircon-index]").forEach(card => card.onclick = () => {
          hpModal.querySelectorAll("#bhAirconTypeGrid [data-aircon-index]").forEach(c => c.classList.remove("active"));
          card.classList.add("active");
          selectedAirconIndex = parseInt(card.dataset.airconIndex);
          hpModal.querySelector("#bhHpOptionsSection").classList.remove("d-none");
          renderHpOptions(allTypes[selectedAirconIndex]);
          selectedHp = null;
          hpModal.querySelector("#bhHpAddToBooking").disabled = true;
          hpModal.querySelector("#bhHpEstimatedPrice").textContent = "₱0";
        });

        hpModal.querySelector("#bhHpAddToBooking").onclick = () => {
          let brand = brandSelect.value;
          if (brand === "__other__") brand = brandOther.value.trim();
          if (!brand) { alert("Please select or enter a brand name."); brandSelect.focus(); return; }
          if (!selectedAirconIndex && selectedAirconIndex !== 0) { alert("Please select an aircon type."); return; }
          if (!selectedHp) { alert("Please select an HP rating."); return; }
          const qty = Math.max(1, Number(hpModal.querySelector("#bhHpQtyInput").value) || 1);
          const airconType = allTypes[selectedAirconIndex];
          rows.push({
            type: "core", serviceId: svc._id, name: svc.name, quantity: qty,
            brand, model: "",
            airconType: airconType.type || "", airconTypeName: airconType.name || "",
            applianceType: airconType.type || "", applianceTypeName: airconType.name || "",
            hp: selectedHp.hp, hpDescription: `${selectedHp.hp} HP`,
            unitPrice: selectedHp.price, totalPrice: selectedHp.price * qty,
          });
          bootstrap.Modal.getOrCreateInstance(hpModal).hide();
          renderCurrentItems();
        };

        bootstrap.Modal.getOrCreateInstance(hpModal).show();
      }

      function renderCoreGrid() {
        const grid = bodyHost.querySelector("#bhCoreGrid");
        grid.innerHTML = core.map(s => {
          const isAircon = s.isAirconService && ((s.airconTypes && s.airconTypes.length > 0) || (s.hpPricing && s.hpPricing.length > 0));
          const prices = isAircon ? (s.airconTypes || []).flatMap(at => (at.hpPricing || []).map(h => h.price)).concat(s.hpPricing || []).filter(Boolean) : [];
          let priceDisplay = "";
          if (isAircon && prices.length) priceDisplay = `₱${Math.min(...prices).toLocaleString()} - ₱${Math.max(...prices).toLocaleString()}`;
          else if (s.basePrice) priceDisplay = `₱${Number(s.basePrice).toLocaleString()}`;
          const duration = isAircon ? 'Duration TBD' : formatDuration(s);
          return `<div class="col-md-4"><div class="card border-0 rounded-4 shadow-sm h-100" style="transition:all .15s" data-svc="${escapeHtml(s._id)}"><div class="card-body p-4">
            <div class="d-flex align-items-start gap-3 mb-3">
              <div class="rounded-3 d-flex align-items-center justify-content-center" style="width:48px;height:48px;background:linear-gradient(135deg,#eff6ff,#dbeafe)"><i class="bi ${escapeHtml(s.icon||'bi-gear')} fs-4 text-primary"></i></div>
              <div class="flex-grow-1">
                <h6 class="fw-bold mb-1" style="font-size:.9rem">${escapeHtml(s.name)}</h6>
                <div class="d-flex gap-1 mb-1">${isAircon ? '<span class="badge" style="background:#06b6d4;color:#fff;font-size:.55rem">HP-based</span>' : ''}<span class="badge bg-light text-muted" style="font-size:.55rem">${escapeHtml(duration)}</span></div>
              </div>
            </div>
            <div class="text-center mb-3"><span class="fw-bold text-primary" style="font-size:1.1rem">${priceDisplay || 'Price on quote'}</span></div>
            <button class="btn btn-primary w-100 rounded-pill" type="button"><i class="bi bi-plus-circle me-2"></i>Add to Booking</button>
          </div></div></div>`;
        }).join("") || '<div class="text-muted small">No core services available.</div>';
        grid.querySelectorAll("[data-svc]").forEach(card => card.onclick = () => {
          const svcId = card.dataset.svc;
          const svc = core.find(s => String(s._id) === String(svcId));
          if (!svc) return;
          showCoreConfigureModal(svc);
        });
      }

      function renderCategoryGrid() {
        const grid = bodyHost.querySelector("#bhCatGrid");
        grid.innerHTML = categories.map(cat => `<div class="col-md-4"><div class="card border rounded-4 h-100 text-center" style="cursor:pointer;transition:all .15s" data-cat="${escapeHtml(cat.slug)}" onmouseover="this.style.borderColor='#2563eb';this.style.transform='translateY(-2px)'" onmouseout="this.style.borderColor='#e2e8f0';this.style.transform=''"><div class="card-body py-3"><i class="bi ${escapeHtml(cat.icon||'bi-grid')} fs-1 text-${escapeHtml(cat.iconColor||'primary')}"></i><h6 class="fw-bold mt-2 mb-1" style="font-size:.9rem">${escapeHtml(cat.name)}</h6><p class="small text-muted mb-0">${cat.isCustom ? 'Custom description' : (cat.unitTypes||[]).length + ' unit types'}</p></div></div></div>`).join("") || '<div class="text-muted small">No categories available.</div>';
        grid.querySelectorAll("[data-cat]").forEach(card => card.onclick = () => {
          grid.querySelectorAll("[data-cat]").forEach(c => { c.classList.remove("border-primary", "bg-light"); c.style.borderColor = "#e2e8f0"; });
          card.classList.add("border-primary", "bg-light");
          card.style.borderColor = "#2563eb";
          selectedCategory = categories.find(c => c.slug === card.dataset.cat);
          bodyHost.querySelector("[data-step='2']").classList.remove("d-none");
          renderUnitChips();
          renderRepairSelect();
        });
      }

      function renderUnitChips() {
        const section = bodyHost.querySelector("[data-step='2']");
        const chipsHost = bodyHost.querySelector("#bhUnitChips");
        if (!selectedCategory || !selectedCategory.unitTypes?.length) { section.classList.add("d-none"); selectedUnitType = null; return; }
        section.classList.remove("d-none");
        chipsHost.innerHTML = selectedCategory.unitTypes.map(ut => `<button type="button" class="btn btn-sm btn-outline-secondary bh-unit-chip rounded-pill" data-val="${escapeHtml(ut.value)}" data-label="${escapeHtml(ut.label)}"><i class="bi ${escapeHtml(ut.icon||'bi-circle')} me-1"></i>${escapeHtml(ut.label)}</button>`).join("");
        chipsHost.querySelectorAll(".bh-unit-chip").forEach(chip => chip.onclick = () => {
          chipsHost.querySelectorAll(".bh-unit-chip").forEach(c => c.classList.remove("btn-secondary", "text-white"));
          chip.classList.add("btn-secondary", "text-white");
          selectedUnitType = { value: chip.dataset.val, label: chip.dataset.label };
          renderRepairSelect();
        });
      }

      function renderRepairSelect() {
        const sel = bodyHost.querySelector("#bhRepairSelect");
        let filtered = repair;
        if (selectedCategory) {
          const catSlug = selectedCategory.slug;
          filtered = repair.filter(r => r.applianceType === catSlug || r.applianceType === selectedCategory.name || (catSlug === "aircon" && r.isAirconService));
          if (!filtered.length) filtered = repair;
        }
        sel.innerHTML = filtered.map(s => `<option value="${escapeHtml(s._id)}">${escapeHtml(s.name)}</option>`).join("") || '<option value="">No repair services available</option>';
      }

      function renderSymptomChips() {
        bodyHost.querySelectorAll(".bh-symptom").forEach(chip => chip.onclick = () => {
          const symptom = chip.dataset.symptom;
          if (selectedSymptoms.includes(symptom)) { selectedSymptoms = selectedSymptoms.filter(s => s !== symptom); chip.classList.remove("btn-secondary","text-white"); chip.classList.add("btn-outline-secondary"); }
          else { selectedSymptoms.push(symptom); chip.classList.add("btn-secondary","text-white"); chip.classList.remove("btn-outline-secondary"); }
          updateProblemText();
        });
      }
      function updateProblemText() {
        const ta = bodyHost.querySelector("#bhRepairProblem");
        const existing = ta.value.trim();
        const symptomsText = selectedSymptoms.join(", ");
        if (symptomsText && (!existing || !existing.startsWith(symptomsText))) {
          ta.value = symptomsText + (existing ? ". " + existing : "");
        }
        bodyHost.querySelector("#bhCharCount").textContent = `${ta.value.length} / 500`;
        const svc = repair.find(s => String(s._id) === String(bodyHost.querySelector("#bhRepairSelect").value));
        const brand = bodyHost.querySelector("#bhRepairBrand").value.trim();
        const problem = ta.value.trim();
        bodyHost.querySelector("#bhAddRepair").disabled = !(svc && brand && problem);
      }

      function updateAddRepairButton() {
        const svc = repair.find(s => String(s._id) === String(bodyHost.querySelector("#bhRepairSelect").value));
        const brand = bodyHost.querySelector("#bhRepairBrand").value.trim();
        const problem = bodyHost.querySelector("#bhRepairProblem").value.trim();
        bodyHost.querySelector("#bhAddRepair").disabled = !(svc && brand && problem);
      }

      bodyHost.querySelector("#bhRepairBrand").oninput = updateAddRepairButton;
      bodyHost.querySelector("#bhRepairModel").oninput = () => {};
      bodyHost.querySelector("#bhRepairProblem").oninput = () => { updateProblemText(); };
      bodyHost.querySelector("#bhRepairQtyMinus").onclick = () => { const inp = bodyHost.querySelector("#bhRepairQty"); inp.value = Math.max(1, Number(inp.value) - 1); };
      bodyHost.querySelector("#bhRepairQtyPlus").onclick = () => { const inp = bodyHost.querySelector("#bhRepairQty"); inp.value = Math.min(40, Number(inp.value) + 1); };
      bodyHost.querySelector("#bhRepairSelect").onchange = updateAddRepairButton;

      bodyHost.querySelector("#bhAddRepair").onclick = () => {
        const svcId = bodyHost.querySelector("#bhRepairSelect").value;
        const svc = repair.find(s => String(s._id) === String(svcId));
        if (!svc) { alert("Please select a repair service."); return; }
        const brand = bodyHost.querySelector("#bhRepairBrand").value.trim();
        if (!brand) { alert("Please enter a brand."); bodyHost.querySelector("#bhRepairBrand").focus(); return; }
        const problem = bodyHost.querySelector("#bhRepairProblem").value.trim();
        if (!problem) { alert("Please describe the problem."); bodyHost.querySelector("#bhRepairProblem").focus(); return; }
        const qty = Math.max(1, Number(bodyHost.querySelector("#bhRepairQty").value) || 1);
        rows.push({
          type: "repair", serviceId: svc._id, name: svc.name, quantity: qty,
          brand, model: bodyHost.querySelector("#bhRepairModel").value.trim(),
          applianceType: selectedCategory?.slug || "", applianceTypeName: selectedCategory?.name || "",
          airconType: selectedUnitType?.value || "", airconTypeName: selectedUnitType?.label || "",
          problemDescription: problem, repairIssue: problem,
          unitPrice: svc.initialPrice || svc.basePrice || 0, totalPrice: (svc.initialPrice || svc.basePrice || 0) * qty,
        });
        bodyHost.querySelector("#bhRepairBrand").value = "";
        bodyHost.querySelector("#bhRepairModel").value = "";
        bodyHost.querySelector("#bhRepairProblem").value = "";
        bodyHost.querySelector("#bhRepairQty").value = "1";
        selectedSymptoms = [];
        bodyHost.querySelectorAll(".bh-symptom").forEach(c => { c.classList.remove("btn-secondary","text-white"); c.classList.add("btn-outline-secondary"); });
        bodyHost.querySelector("#bhAddRepair").disabled = true;
        renderCurrentItems();
      };

      function attachSaveHandler() {
        host.querySelector("#bhEditorSave").onclick = async event => {
          const button = event.currentTarget; button.disabled = true;
          try {
            const promises = [];
            let hasServices = rows.length > 0;
            const reasonEl = host.querySelector("#bhServiceChangeReason");
            const reason = reasonEl ? reasonEl.value.trim() : "";

            if (hasServices) {
              const rescheduleReason = host.querySelector("#bhEditorRescheduleReason")?.value?.trim() || reason || "";
              const services = rows.map(row => ({
                _id: row._id, type: row.type,
                serviceId: row.serviceId,
                quantity: Number(row.quantity || 1),
                brand: row.brand || "", model: row.model || "",
                problemDescription: row.problemDescription || row.repairIssue || "",
                applianceType: row.applianceType || "", applianceTypeName: row.applianceTypeName || "",
                airconType: row.airconType || "", airconTypeName: row.airconTypeName || "", hp: row.hp,
              }));
              promises.push(
                fetch(`/api/bookings/${encodeURIComponent(bookingId)}/service-change-requests`, {
                  method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
                  body: JSON.stringify({
                    services,
                    reason: reason || rescheduleReason,
                    requestedSchedule: selectedDate && selectedTime
                      ? { date: selectedDate, startTime: selectedTime, notes: rescheduleReason }
                      : undefined,
                  })
                }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "Unable to save service changes"); return d; })
              );
            }

            if (!promises.length) {
              alert("Make a change to services or schedule before saving.");
              button.disabled = false;
              return;
            }

            const results = await Promise.allSettled(promises);
            const errors = results.filter(r => r.status === "rejected").map(r => r.reason?.message || "Unknown error");
            if (errors.length) {
              alert("Some changes failed:\n" + errors.join("\n"));
            } else {
              const msgs = results.map(r => r.value?.applied ? "Services updated" : r.value?.message || "Changes saved").filter(Boolean);
              alert(msgs.length ? msgs.join(". ") + "." : "Changes saved successfully.");
              bootstrap.Modal.getOrCreateInstance(host).hide();
              await fetchBookings();
            }
          } catch (error) { alert(error.message || "Unable to save changes"); } finally { button.disabled = false; }
        };
      }

      (async () => {
        try {
          if (typeof EnterpriseCalendar === 'undefined') throw new Error('Calendar module not loaded');
          const serviceId = booking ? ((booking.serviceId && (booking.serviceId._id || booking.serviceId)) || (booking.service && booking.service._id) || null) : null;
          await EnterpriseCalendar.init({
            serviceId,
            duration: booking ? (Number(booking.serviceDurationMinutes) || 90) : 90,
            quantity: booking ? (Number(booking.quantity) || 1) : 1,
            onSelect: ({ date, slot }) => {
              if (!date || !slot) return;
              selectedDate = EnterpriseCalendar.formatDateKey(date);
              selectedTime = slot.startTime || slot.label;
              const selBox = host.querySelector('#bhEditorSelection');
              const selText = host.querySelector('#bhEditorSelectionText');
              selBox.classList.remove('d-none');
              const dObj = new Date(selectedDate + 'T00:00:00');
              selText.innerHTML = `<strong>Date:</strong> ${dObj.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}<br><strong>Time:</strong> ${selectedTime}`;
              updateServiceCount();
            }
          });
          host.querySelector('#bhEditorCalendarLoading')?.classList.add('d-none');
          host.querySelector('#bhEditorCalendarContent')?.classList.remove('d-none');
        } catch (err) {
          console.error(err);
          host.querySelector('#bhEditorCalendarLoading')?.classList.add('d-none');
          const calErr = host.querySelector('#bhEditorCalendarError');
          if (calErr) { calErr.textContent = 'Could not load available dates. You can still edit services.'; calErr.classList.remove('d-none'); }
        }
      })();

      attachSaveHandler();
      renderCurrentItems();
      renderCoreGrid();
      renderCategoryGrid();
      renderRepairSelect();
      renderSymptomChips();
      bootstrap.Modal.getOrCreateInstance(host).show();
    } catch (error) { alert(error.message || "Unable to open booking editor"); }
  }

  async function fetchBookings() {
    try {
      el.loading.classList.remove("d-none");
      el.tableWrap.classList.add("d-none");
      el.empty.classList.add("d-none");

      const res = await fetch("/api/appointments?limit=1000");
      if (!res.ok) throw new Error("Failed to load");
      const payload = await res.json();
      let items = [];
      if (Array.isArray(payload.items)) items = payload.items;
      else if (Array.isArray(payload)) items = payload;

      bookings = items || [];
      originalBookings = bookings.slice();
      applyFilters();

      // show sample bookings button only when available
      if (el.showSample) el.showSample.classList.remove("d-none");
    } catch (e) {
      console.error("Failed to load bookings", e);
      el.loading.innerHTML =
        '<div class="text-danger">Failed to load bookings. Try reloading the page.</div>';

      // still allow sample demonstration when network fails
      if (el.showSample) el.showSample.classList.remove("d-none");
    }
  }

  // events
  el.search.addEventListener("input", debounce(applyFilters, 250));
  el.status.addEventListener("change", applyFilters);
  el.from.addEventListener("change", applyFilters);
  el.to.addEventListener("change", applyFilters);
  el.clear.addEventListener("click", function () {
    el.search.value = "";
    el.status.value = "all";
    el.from.value = "";
    el.to.value = "";
    applyFilters();
  });

  // sample bookings toggle (front-end only)
  if (el.showSample) {
    el.showSample.addEventListener("click", function () {
      if (!usingSample) {
        bookings = originalBookings.concat(createSampleBookings());
        usingSample = true;
        el.showSample.textContent = "Hide example bookings";
        el.showSample.classList.remove("btn-outline-primary");
        el.showSample.classList.add("btn-outline-secondary");
      } else {
        bookings = originalBookings.slice();
        usingSample = false;
        el.showSample.textContent = "Show example bookings";
        el.showSample.classList.remove("btn-outline-secondary");
        el.showSample.classList.add("btn-outline-primary");
      }
      applyFilters();
    });
  }

  el.prev.addEventListener("click", function () {
    if (page > 0) {
      page--;
      renderTable();
    }
  });
  el.next.addEventListener("click", function () {
    if ((page + 1) * perPage < filtered.length) {
      page++;
      renderTable();
    }
  });

  // Expose submit rating function for premium modal
  window.submitBookingRating = function(bookingId, score, comment) {
    fetch(`/api/rating/booking/${encodeURIComponent(bookingId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ score: score, comment: comment }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(j))))
      .then(() => fetchBookings())
      .catch((err) => {
        console.error(err);
        alert("Failed to submit rating");
      });
  };

  // Cancel booking function
  function cancelBooking(bookingId, reason) {
    fetch(`/api/appointments/${encodeURIComponent(bookingId)}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(j))))
      .then(() => {
        alert("Booking cancelled successfully");
        fetchBookings();
      })
      .catch((err) => {
        console.error(err);
        alert("Failed to cancel booking: " + (err.message || "Unknown error"));
      });
  }

  // ── Quotation approve/decline (customer-facing) ──
  window.bhApproveQuotation = function(bookingId) {
    Swal.fire({
      title: 'Approve Quotation?',
      text: "You're approving this repair quotation. After approval, you can choose to repair now or schedule for later.",
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#16a34a',
      cancelButtonColor: '#6b7280',
      confirmButtonText: 'Yes, Approve',
      cancelButtonText: 'Cancel'
    }).then((result) => {
      if (!result.isConfirmed) return;
      fetch(`/api/bookings/${encodeURIComponent(bookingId)}/approve-quotation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Approved by customer" }),
        credentials: "same-origin"
      })
        .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j)))
        .then(() => {
          fetchBookings();
          bhShowRepairTodayChoice(bookingId);
        })
        .catch(err => { console.error(err); bhToast('error', 'Failed to approve: ' + (err.message || 'Unknown error')); });
    });
  };

  window.bhDeclineQuotation = function(bookingId) {
    Swal.fire({
      title: 'Decline Quotation?',
      text: "Are you sure you want to decline this repair quotation? This action cannot be undone.",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      cancelButtonColor: '#6b7280',
      confirmButtonText: 'Yes, Decline',
      cancelButtonText: 'Cancel',
      input: 'text',
      inputPlaceholder: 'Reason for declining (optional)',
      inputAttributes: { maxlength: 200 }
    }).then((result) => {
      if (!result.isConfirmed) return;
      fetch(`/api/bookings/${encodeURIComponent(bookingId)}/decline-quotation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: result.value || "Declined by customer" }),
        credentials: "same-origin"
      })
        .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j)))
        .then(() => {
          bhToast('success', 'Quotation declined successfully.');
          fetchBookings();
        })
        .catch(err => { console.error(err); bhToast('error', 'Failed to decline: ' + (err.message || 'Unknown error')); });
    });
  };

  // ── Schedule Later (for repair_approved bookings) ──
  window.bhScheduleLater = function(bookingId, directToSchedule) {
    if (directToSchedule) {
      // Customer clicked email link with ?schedule=true — go directly to date picker
      bhShowScheduleLaterForm(bookingId);
    } else {
      bhShowRepairTodayChoice(bookingId);
    }
  };

  // ── Toast notification helper ──
  function bhToast(type, message) {
    if (typeof Swal !== 'undefined') {
      Swal.fire({
        toast: true,
        position: 'top-end',
        icon: type,
        title: message,
        showConfirmButton: false,
        timer: 4000,
        timerProgressBar: true
      });
    } else {
      const toast = document.createElement('div');
      toast.className = `alert alert-${type === 'success' ? 'success' : type === 'error' ? 'danger' : 'info'} position-fixed`;
      toast.style.cssText = 'top:20px;right:20px;z-index:9999;min-width:300px;box-shadow:0 8px 24px rgba(0,0,0,0.15);border-radius:10px;';
      toast.innerHTML = `<div class="d-flex align-items-center gap-2"><i class="bi bi-${type === 'success' ? 'check-circle-fill' : type === 'error' ? 'exclamation-triangle-fill' : 'info-circle-fill'}"></i><span>${message}</span></div>`;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 4000);
    }
  }
  window.bhToast = bhToast;

  // ── Repair Today / Schedule Later Choice Modal ──
  window.bhShowRepairTodayChoice = function(bookingId) {
    // Remove existing modals
    const existing1 = document.getElementById('repairTodayModal');
    if (existing1) existing1.remove();
    const existing2 = document.getElementById('scheduleLaterModal');
    if (existing2) existing2.remove();

    const modalHtml = `
    <div class="modal fade" id="repairTodayModal" tabindex="-1" data-bs-backdrop="static">
      <div class="modal-dialog modal-dialog-centered modal-md">
        <div class="modal-content" style="border:none;border-radius:20px;overflow:hidden;box-shadow:0 25px 60px rgba(0,0,0,0.25);">
          <div style="background:linear-gradient(135deg,#1e3a5f 0%,#7c3aed 100%);padding:24px 28px;color:#fff;">
            <div class="d-flex align-items-center gap-3 mb-2">
              <div style="width:48px;height:48px;border-radius:14px;background:rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;">
                <i class="bi bi-calendar2-check" style="font-size:1.4rem;"></i>
              </div>
              <div>
                <h5 class="fw-bold mb-0" style="font-size:1.15rem;">Schedule Your Repair</h5>
                <small class="opacity-75">Choose when you'd like the repair done</small>
              </div>
            </div>
          </div>
          <div class="modal-body" style="padding:24px 28px;">
            <p style="font-size:0.88rem;color:#475569;margin-bottom:1.25rem;line-height:1.6;">
              Your quotation has been approved. Would you like the repair to be done <strong>today</strong>, or would you prefer to <strong>schedule it for another day</strong>?
            </p>
            <div class="d-flex flex-column gap-3">
              <button class="btn text-start p-3" style="border:2px solid #22c55e;background:#f0fdf4;border-radius:14px;transition:all 0.2s;" 
                onmouseover="this.style.borderColor='#16a34a';this.style.boxShadow='0 0 0 3px rgba(34,197,94,0.15)'" 
                onmouseout="this.style.borderColor='#22c55e';this.style.boxShadow='none'"
                onclick="bhChooseRepairToday('${bookingId}', 'today')">
                <div class="d-flex align-items-center gap-3">
                  <div style="width:50px;height:50px;border-radius:50%;background:linear-gradient(135deg,#dcfce7,#bbf7d0);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <i class="bi bi-lightning-charge-fill" style="color:#16a34a;font-size:1.3rem;"></i>
                  </div>
                  <div>
                    <div class="fw-bold" style="color:#166534;font-size:0.95rem;">Yes, Repair Today</div>
                    <div style="font-size:0.78rem;color:#16a34a;line-height:1.4;">If technician is available, repair starts immediately</div>
                  </div>
                  <i class="bi bi-chevron-right ms-auto" style="color:#22c55e;"></i>
                </div>
              </button>
              <button class="btn text-start p-3" style="border:2px solid #3b82f6;background:#eff6ff;border-radius:14px;transition:all 0.2s;"
                onmouseover="this.style.borderColor='#2563eb';this.style.boxShadow='0 0 0 3px rgba(59,130,246,0.15)'" 
                onmouseout="this.style.borderColor='#3b82f6';this.style.boxShadow='none'"
                onclick="bhChooseRepairToday('${bookingId}', 'later')">
                <div class="d-flex align-items-center gap-3">
                  <div style="width:50px;height:50px;border-radius:50%;background:linear-gradient(135deg,#dbeafe,#bfdbfe);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <i class="bi bi-calendar3" style="color:#2563eb;font-size:1.3rem;"></i>
                  </div>
                  <div>
                    <div class="fw-bold" style="color:#1e40af;font-size:0.95rem;">Schedule for Another Day</div>
                    <div style="font-size:0.78rem;color:#2563eb;line-height:1.4;">Choose your preferred dates and our team will confirm</div>
                  </div>
                  <i class="bi bi-chevron-right ms-auto" style="color:#3b82f6;"></i>
                </div>
              </button>
            </div>
          </div>
          <div style="padding:16px 28px;border-top:1px solid #f1f5f9;background:#fafbfc;text-align:center;">
            <small class="text-muted" style="font-size:0.75rem;">You can also decide later from your booking history</small>
          </div>
        </div>
      </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = new bootstrap.Modal(document.getElementById('repairTodayModal'));
    modal.show();
  };

  window.bhChooseRepairToday = function(bookingId, choice) {
    if (choice === 'today') {
      // Show loading state
      const modal = document.getElementById('repairTodayModal');
      if (modal) {
        const body = modal.querySelector('.modal-body');
        if (body) {
          body.innerHTML = `
            <div class="text-center py-4">
              <div class="spinner-border text-primary mb-3" role="status" style="width:3rem;height:3rem;">
                <span class="visually-hidden">Loading...</span>
              </div>
              <p class="fw-semibold text-dark mb-1">Checking Technician Availability</p>
              <p class="text-muted" style="font-size:0.82rem;">Please wait a moment...</p>
            </div>`;
        }
      }

      fetch(`/api/appointments/${encodeURIComponent(bookingId)}/repair-today-choice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice: "today" }),
        credentials: "same-origin"
      })
        .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j)))
        .then(data => {
          bootstrap.Modal.getInstance(document.getElementById('repairTodayModal'))?.hide();
          if (data.available) {
            Swal.fire({
              toast: true,
              position: 'top-end',
              icon: 'success',
              title: data.message || 'Technician is available! Repair will start shortly.',
              showConfirmButton: false,
              timer: 5000,
              timerProgressBar: true
            });
          } else {
            // Not available — auto-open schedule later form
            Swal.fire({
              icon: 'info',
              title: 'Technician Not Available Today',
              text: data.message || 'The technician is not available today. Would you like to schedule for another day?',
              showCancelButton: true,
              confirmButtonText: 'Schedule for Later',
              cancelButtonText: 'Close',
              confirmButtonColor: '#3b82f6'
            }).then((result) => {
              if (result.isConfirmed) {
                bhShowScheduleLaterForm(bookingId);
              }
            });
          }
          fetchBookings();
        })
        .catch(err => { 
          console.error(err); 
          bootstrap.Modal.getInstance(document.getElementById('repairTodayModal'))?.hide();
          bhToast('error', 'Failed: ' + (err.message || 'Unknown error')); 
          fetchBookings();
        });
    } else {
      // Show schedule later form
      bhShowScheduleLaterForm(bookingId);
    }
  };

  window.bhShowScheduleLaterForm = function(bookingId) {
    // Remove existing modals
    const existing1 = document.getElementById('repairTodayModal');
    if (existing1) bootstrap.Modal.getInstance(existing1)?.hide();
    const existing2 = document.getElementById('scheduleLaterModal');
    if (existing2) existing2.remove();

    const today = new Date();
    const dates = [];
    for (let i = 1; i <= 7; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      dates.push(d);
    }

    const dateOptions = dates.map(d => {
      const dayName = d.toLocaleDateString('en-PH', { weekday: 'short' });
      const monthDay = d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
      const fullDate = d.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' });
      const value = d.toISOString().split('T')[0];
      return `<label class="schedule-date-option" data-date="${value}">
        <input type="checkbox" class="form-check-input schedule-date-cb" value="${value}">
        <div class="schedule-date-content">
          <div class="schedule-date-day">${dayName}</div>
          <div class="schedule-date-md">${monthDay}</div>
        </div>
      </label>`;
    }).join('');

    const modalHtml = `
    <style>
      .schedule-date-option {
        display: flex; align-items: center; gap: 10px; padding: 12px 14px;
        border: 2px solid #e2e8f0; border-radius: 12px; cursor: pointer;
        background: #fff; transition: all 0.2s;
      }
      .schedule-date-option:hover { border-color: #3b82f6; background: #eff6ff; }
      .schedule-date-option:has(input:checked) { border-color: #3b82f6; background: #eff6ff; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
      .schedule-date-option input { width: 18px; height: 18px; accent-color: #3b82f6; }
      .schedule-date-day { font-weight: 700; font-size: 0.88rem; color: #1e293b; }
      .schedule-date-md { font-size: 0.78rem; color: #64748b; }
      .schedule-time-option {
        display: flex; align-items: center; gap: 10px; padding: 14px 16px;
        border: 2px solid #e2e8f0; border-radius: 12px; cursor: pointer;
        background: #fff; transition: all 0.2s; flex: 1;
      }
      .schedule-time-option:hover { border-color: #3b82f6; background: #eff6ff; }
      .schedule-time-option:has(input:checked) { border-color: #3b82f6; background: #eff6ff; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
      .schedule-time-option input { width: 18px; height: 18px; accent-color: #3b82f6; }
    </style>
    <div class="modal fade" id="scheduleLaterModal" tabindex="-1" data-bs-backdrop="static">
      <div class="modal-dialog modal-dialog-centered modal-lg">
        <div class="modal-content" style="border:none;border-radius:20px;overflow:hidden;box-shadow:0 25px 60px rgba(0,0,0,0.25);">
          <div style="background:linear-gradient(135deg,#1e3a5f 0%,#7c3aed 100%);padding:24px 28px;color:#fff;">
            <div class="d-flex align-items-center justify-content-between">
              <div class="d-flex align-items-center gap-3">
                <div style="width:48px;height:48px;border-radius:14px;background:rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;">
                  <i class="bi bi-calendar-week" style="font-size:1.4rem;"></i>
                </div>
                <div>
                  <h5 class="fw-bold mb-0" style="font-size:1.15rem;">Choose Preferred Dates</h5>
                  <small class="opacity-75">Select up to 3 dates that work for you</small>
                </div>
              </div>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
            </div>
          </div>
          <div class="modal-body" style="padding:24px 28px;">
            <div class="mb-4">
              <label class="form-label fw-bold d-flex align-items-center gap-2" style="font-size:0.85rem;color:#1e293b;">
                <i class="bi bi-calendar3" style="color:#7c3aed;"></i>
                Preferred Dates
                <span class="text-muted fw-normal" style="font-size:0.75rem;">(select 1-3 dates)</span>
              </label>
              <div id="scheduleDateGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;">
                ${dateOptions}
              </div>
              <div id="scheduleDateCount" class="mt-2" style="font-size:0.75rem;color:#64748b;">
                <span id="dateCountNum">0</span> of 3 dates selected
              </div>
            </div>
            <div class="mb-3">
              <label class="form-label fw-bold d-flex align-items-center gap-2" style="font-size:0.85rem;color:#1e293b;">
                <i class="bi bi-clock" style="color:#7c3aed;"></i>
                Preferred Time Window
              </label>
              <div class="d-flex gap-3">
                <label class="schedule-time-option">
                  <input type="radio" name="scheduleTimeRadio" value="any" checked>
                  <div>
                    <div class="fw-bold" style="font-size:0.88rem;color:#1e293b;">Any Time</div>
                    <div style="font-size:0.72rem;color:#64748b;">8AM - 5PM</div>
                  </div>
                </label>
                <label class="schedule-time-option">
                  <input type="radio" name="scheduleTimeRadio" value="morning">
                  <div>
                    <div class="fw-bold" style="font-size:0.88rem;color:#1e293b;">Morning</div>
                    <div style="font-size:0.72rem;color:#64748b;">8AM - 12PM</div>
                  </div>
                </label>
                <label class="schedule-time-option">
                  <input type="radio" name="scheduleTimeRadio" value="afternoon">
                  <div>
                    <div class="fw-bold" style="font-size:0.88rem;color:#1e293b;">Afternoon</div>
                    <div style="font-size:0.72rem;color:#64748b;">12PM - 5PM</div>
                  </div>
                </label>
              </div>
            </div>
            <div id="scheduleError" class="alert alert-danger d-none" style="font-size:0.82rem;border-radius:10px;"></div>
          </div>
          <div style="padding:16px 28px;border-top:1px solid #f1f5f9;background:#fafbfc;display:flex;justify-content:space-between;align-items:center;">
            <small class="text-muted" style="font-size:0.75rem;"><i class="bi bi-info-circle me-1"></i>Our team will confirm the final schedule within 24 hours</small>
            <div class="d-flex gap-2">
              <button class="btn btn-light fw-semibold" data-bs-dismiss="modal" style="border-radius:10px;">Cancel</button>
              <button class="btn btn-primary fw-semibold" onclick="bhSubmitScheduleLater('${bookingId}')" style="border-radius:10px;padding:8px 20px;">
                <i class="bi bi-check-lg me-1"></i>Submit Request
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Date selection logic (max 3)
    const dateCbs = document.querySelectorAll('.schedule-date-cb');
    const countEl = document.getElementById('dateCountNum');
    dateCbs.forEach(cb => {
      cb.addEventListener('change', () => {
        const checked = document.querySelectorAll('.schedule-date-cb:checked');
        if (checked.length > 3) {
          cb.checked = false;
          bhToast('info', 'Maximum 3 dates allowed.');
          return;
        }
        countEl.textContent = checked.length;
        // Update visual state
        document.querySelectorAll('.schedule-date-option').forEach(opt => {
          const checkbox = opt.querySelector('input[type="checkbox"]');
          if (checkbox.checked) {
            opt.style.borderColor = '#3b82f6';
            opt.style.background = '#eff6ff';
          } else {
            opt.style.borderColor = '#e2e8f0';
            opt.style.background = '#fff';
          }
        });
      });
    });

    const modal = new bootstrap.Modal(document.getElementById('scheduleLaterModal'));
    modal.show();
  };

  window.bhSubmitScheduleLater = function(bookingId) {
    const checked = document.querySelectorAll('.schedule-date-cb:checked');
    const timeRadio = document.querySelector('input[name="scheduleTimeRadio"]:checked');
    const timeWindow = timeRadio ? timeRadio.value : 'any';
    const errorBox = document.getElementById('scheduleError');

    if (checked.length === 0) {
      errorBox.textContent = 'Please select at least one preferred date.';
      errorBox.classList.remove('d-none');
      return;
    }

    const preferredDates = Array.from(checked).map(cb => cb.value);

    // Show loading
    const submitBtn = document.querySelector('#scheduleLaterModal .btn-primary');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Submitting...';
    }

    fetch(`/api/appointments/${encodeURIComponent(bookingId)}/repair-today-choice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice: "later", preferredDates, preferredTimeWindow: timeWindow }),
      credentials: "same-origin"
    })
      .then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(j)))
      .then(data => {
        bootstrap.Modal.getInstance(document.getElementById('scheduleLaterModal'))?.hide();
        Swal.fire({
          icon: 'success',
          title: 'Schedule Request Submitted!',
          html: `
            <div class="text-start">
              <p style="color:#475569;margin-bottom:12px;">${data.message || 'Our team will confirm the final schedule shortly.'}</p>
              <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px;">
                <div style="font-size:0.82rem;color:#166534;">
                  <strong>What happens next?</strong>
                  <ul style="margin:8px 0 0;padding-left:16px;">
                    <li>Our team will review your preferred dates</li>
                    <li>You'll receive an email confirmation within 24 hours</li>
                    <li>The final schedule will appear in your booking history</li>
                  </ul>
                </div>
              </div>
            </div>
          `,
          confirmButtonColor: '#3b82f6',
          confirmButtonText: 'Got it!'
        });
        fetchBookings();
      })
      .catch(err => { 
        console.error(err); 
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Submit Request';
        }
        bhToast('error', 'Failed: ' + (err.message || 'Unknown error')); 
      });
  };

  // Reschedule modal state
  let currentRescheduleBooking = null;
  let currentRescheduleTechnicianId = null;
  let selectedRescheduleDate = null;
  let selectedRescheduleTime = null;
  let rescheduleCalendarState = {
    currentMonth: new Date().getMonth(),
    currentYear: new Date().getFullYear(),
    availableDates: []
  };

  function formatDateKeyLocal(d) {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  }

  // Open reschedule modal
  function openRescheduleModal(booking) {
    currentRescheduleBooking = booking;
    currentRescheduleTechnicianId = booking.technicianId || booking.technician?._id;
    selectedRescheduleDate = null;
    selectedRescheduleTime = null;

    // Show loading state
    document.getElementById('bhRescheduleLoading').classList.remove('d-none');
    document.getElementById('bhRescheduleError').classList.add('d-none');
    document.getElementById('bhRescheduleCalendarContent').classList.add('d-none');
    document.getElementById('bhSubmitReschedule').disabled = true;

    // Set technician name
    const techName = booking.technicianName || booking.technician?.name || 'Not assigned';
    document.getElementById('bhRescheduleTechName').textContent = techName;

    // Open modal
    const modal = new bootstrap.Modal(document.getElementById('bhRescheduleModal'));
    modal.show();

    // If no technician assigned, show error
    if (!currentRescheduleTechnicianId) {
      document.getElementById('bhRescheduleLoading').classList.add('d-none');
      document.getElementById('bhRescheduleError').textContent = 'No technician assigned to this booking. Please contact customer support.';
      document.getElementById('bhRescheduleError').classList.remove('d-none');
      return;
    }

    // Fetch available slots for this technician
    fetchAvailableSlots();
  }

  // Fetch available slots for the technician
  async function fetchAvailableSlots() {
    try {
      const response = await fetch(`/api/schedule/technician/${encodeURIComponent(currentRescheduleTechnicianId)}/available-slots`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch available slots');
      }

      rescheduleCalendarState.availableDates = data.availableDates || [];

      // Initialize calendar
      rescheduleCalendarState.currentMonth = new Date().getMonth();
      rescheduleCalendarState.currentYear = new Date().getFullYear();

      // Show calendar content
      document.getElementById('bhRescheduleLoading').classList.add('d-none');
      document.getElementById('bhRescheduleCalendarContent').classList.remove('d-none');

      renderRescheduleCalendar();
    } catch (error) {
      console.error('Error fetching available slots:', error);
      document.getElementById('bhRescheduleLoading').classList.add('d-none');
      document.getElementById('bhRescheduleError').textContent = error.message || 'Failed to load available slots. Please try again.';
      document.getElementById('bhRescheduleError').classList.remove('d-none');
    }
  }

  // Render reschedule calendar
  function renderRescheduleCalendar() {
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById('bhCalendarTitle').textContent = `${monthNames[rescheduleCalendarState.currentMonth]} ${rescheduleCalendarState.currentYear}`;

    const grid = document.getElementById('bhCalendarGrid');
    grid.innerHTML = '';

    const firstDay = new Date(rescheduleCalendarState.currentYear, rescheduleCalendarState.currentMonth, 1);
    const lastDay = new Date(rescheduleCalendarState.currentYear, rescheduleCalendarState.currentMonth + 1, 0);
    const startingDay = firstDay.getDay();
    const totalDays = lastDay.getDate();

    // Add empty cells for days before the first day of the month
    for (let i = 0; i < startingDay; i++) {
      const emptyCell = document.createElement('div');
      emptyCell.className = 'calendar-cell disabled';
      grid.appendChild(emptyCell);
    }

    // Add days of the month
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let day = 1; day <= totalDays; day++) {
      const date = new Date(rescheduleCalendarState.currentYear, rescheduleCalendarState.currentMonth, day);
      const dateStr = formatDateKeyLocal(date);

      const cell = document.createElement('button');
      cell.className = 'calendar-cell';
      cell.innerHTML = `<span class="date-num">${day}</span>`;

      // Check if date is available
      const isAvailable = rescheduleCalendarState.availableDates.some(availableDate =>
        availableDate.date === dateStr && availableDate.available
      );

      // Check if date is in the past
      const isPast = date < today;

      if (isAvailable && !isPast) {
        cell.setAttribute('data-status', 'available');
        cell.onclick = function() {
          selectRescheduleDate(date, dateStr, this);
        };
      } else if (isPast) {
        cell.classList.add('disabled');
        cell.setAttribute('data-status', 'blocked');
      } else {
        cell.setAttribute('data-status', 'blocked');
        cell.classList.add('disabled');
      }

      // Check if this date is selected
      if (selectedRescheduleDate === dateStr) {
        cell.classList.add('is-selected');
      }

      grid.appendChild(cell);
    }
  }

  // Select reschedule date
  function selectRescheduleDate(date, dateStr, cellElement) {
    selectedRescheduleDate = dateStr;
    selectedRescheduleTime = null;

    // Update calendar selection
    document.querySelectorAll('#bhCalendarGrid .calendar-cell').forEach(cell => {
      cell.classList.remove('is-selected');
    });
    cellElement.classList.add('is-selected');

    // For project bookings, hide time slots — date only is sufficient
    const container = document.getElementById('bhTimeSlotsContainer');
    const isProject = currentRescheduleBooking && (currentRescheduleBooking.isProject || currentRescheduleBooking.projectScheduling);
    if (isProject) {
      if (container) {
        container.classList.remove('d-none');
        container.innerHTML = `
          <div class="alert alert-info mb-0">
            <i class="bi bi-kanban me-2"></i>
            <strong>Project Booking</strong> — Only a new start date is needed. The Operations Team will prepare the multi-day schedule.
          </div>`;
      }
      const reason = document.getElementById('bhRescheduleReason').value.trim();
      document.getElementById('bhSubmitReschedule').disabled = !reason;
      return;
    }

    // Find available time slots for this date
    const availableDate = rescheduleCalendarState.availableDates.find(ad => ad.date === dateStr);
    const timeSlots = availableDate ? availableDate.timeSlots : [];

    // Render time slots
    renderTimeSlots(timeSlots);
  }

  // Render time slots
  function renderTimeSlots(timeSlots) {
    const container = document.getElementById('bhTimeSlotsContainer');
    const slotsContainer = document.getElementById('bhTimeSlots');

    if (timeSlots.length === 0) {
      container.classList.add('d-none');
      document.getElementById('bhSubmitReschedule').disabled = true;
      return;
    }

    container.classList.remove('d-none');
    slotsContainer.innerHTML = '';

    timeSlots.forEach(slot => {
      const slotBtn = document.createElement('button');
      slotBtn.className = 'time-slot';
      slotBtn.innerHTML = `
        <div class="time-slot-time">${slot.time}</div>
        <div class="text-muted small">${slot.duration || '60 min'}</div>
      `;
      slotBtn.onclick = () => selectRescheduleTime(slot.time, slotBtn);
      slotsContainer.appendChild(slotBtn);
    });

    document.getElementById('bhSubmitReschedule').disabled = true;
  }

  // Select reschedule time
  function selectRescheduleTime(time, btnElement) {
    selectedRescheduleTime = time;

    // Update selection
    document.querySelectorAll('#bhTimeSlots .time-slot').forEach(btn => {
      btn.classList.remove('active');
    });
    btnElement.classList.add('active');

    // Enable submit button if reason is provided
    const reason = document.getElementById('bhRescheduleReason').value.trim();
    document.getElementById('bhSubmitReschedule').disabled = !reason;
  }

  // Setup calendar navigation
  document.getElementById('bhPrevMonth').addEventListener('click', () => {
    rescheduleCalendarState.currentMonth--;
    if (rescheduleCalendarState.currentMonth < 0) {
      rescheduleCalendarState.currentMonth = 11;
      rescheduleCalendarState.currentYear--;
    }
    renderRescheduleCalendar();
  });

  document.getElementById('bhNextMonth').addEventListener('click', () => {
    rescheduleCalendarState.currentMonth++;
    if (rescheduleCalendarState.currentMonth > 11) {
      rescheduleCalendarState.currentMonth = 0;
      rescheduleCalendarState.currentYear++;
    }
    renderRescheduleCalendar();
  });

  // Handle reason input change
  document.getElementById('bhRescheduleReason').addEventListener('input', function() {
    const reason = this.value.trim();
    document.getElementById('bhSubmitReschedule').disabled = !reason || !selectedRescheduleDate || !selectedRescheduleTime;
  });

  // Submit reschedule request
  document.getElementById('bhSubmitReschedule').addEventListener('click', async function() {
    const reason = document.getElementById('bhRescheduleReason').value.trim();
    const isProject = currentRescheduleBooking && (currentRescheduleBooking.isProject || currentRescheduleBooking.projectScheduling);

    if (!reason || !selectedRescheduleDate) {
      alert('Please select a date and provide a reason for rescheduling.');
      return;
    }

    if (!isProject && !selectedRescheduleTime) {
      alert('Please select a preferred time.');
      return;
    }

    try {
      const response = await fetch(`/api/appointments/${encodeURIComponent(currentRescheduleBooking._id)}/reschedule-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestedDate: selectedRescheduleDate,
          requestedTime: selectedRescheduleTime || null,
          reason: reason,
          isProject: isProject
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to submit reschedule request');
      }

      // Close modal
      const modal = bootstrap.Modal.getInstance(document.getElementById('bhRescheduleModal'));
      modal.hide();

      alert('Reschedule request submitted successfully! The secretary will review your request and you will be notified once it is approved.');
      fetchBookings();
    } catch (error) {
      console.error('Error submitting reschedule request:', error);
      alert('Failed to submit reschedule request: ' + error.message);
    }
  });

  document.addEventListener("DOMContentLoaded", function() {
    fetchBookings().then(() => {
      // Handle ?highlight= query parameter from email links
      const params = new URLSearchParams(window.location.search);
      const highlightId = params.get('highlight');
      const openSchedule = params.get('schedule') === 'true';
      if (highlightId) {
        setTimeout(() => {
          const row = document.querySelector(`tr[data-id="${highlightId}"]`);
          if (row) {
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            row.style.transition = 'background 0.3s';
            row.style.background = '#fef3c7';
            setTimeout(() => { row.style.background = ''; }, 3000);
            // Auto-open the detail modal
            const b = bookings.find(x => String(x._id) === String(highlightId));
            if (b) {
              showDetailModal(b);
              // If ?schedule=true, auto-open the Schedule Later form after detail modal loads
              if (openSchedule && (b.status === 'repair_approved' || b.status === 'awaiting_approval')) {
                setTimeout(() => {
                  const detailModalEl = document.getElementById('detailModal');
                  if (detailModalEl && (detailModalEl.classList.contains('show') || detailModalEl.style.display === 'block')) {
                    bhScheduleLater(b._id, true);
                  }
                }, 800);
              }
            }
          }
          // Clean URL
          if (window.history && window.history.replaceState) {
            const u = new URL(window.location.href);
            u.searchParams.delete('highlight');
            u.searchParams.delete('schedule');
            window.history.replaceState(null, '', u.pathname + u.search + u.hash);
          }
        }, 500);
      }
    });
  });

  // helpers
  function debounce(fn, delay) {
    let t;
    return function () {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, arguments), delay);
    };
  }

  // ── Warranty Claim ──
  window.bhWarrantyClaim = async function(bookingId) {
    try {
      const response = await fetch(`/api/warranty-claims/eligibility/booking/${encodeURIComponent(bookingId)}`, { credentials:'same-origin', headers:{Accept:'application/json'} });
      const eligibility = await response.json();
      if (!response.ok) throw new Error(eligibility.error || 'Warranty coverage could not be loaded.');
      if (eligibility.activeClaims?.length) {
        const activeClaim = eligibility.activeClaims[0];
        if (activeClaim.status === 'resolved' && confirm(`Claim ${activeClaim.claimReference} is marked resolved. Confirm that the remedy was completed to your satisfaction?`)) {
          const confirmed = await fetch(`/api/warranty-claims/${encodeURIComponent(activeClaim._id)}/confirm-resolution`, { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json',Accept:'application/json'}, body:'{}' });
          const result = await confirmed.json();
          if (!confirmed.ok) throw new Error(result.error || 'Resolution could not be confirmed.');
          alert('Resolution confirmed. The warranty claim is now closed.'); fetchBookings();
        } else if (activeClaim.status !== 'resolved') {
          alert(`Claim ${activeClaim.claimReference} is already active. Current status: ${String(activeClaim.status).replace(/_/g,' ')}.`);
        }
        return;
      }
      if (!eligibility.eligible) throw new Error(eligibility.activeClaims?.length ? `An active claim already exists: ${eligibility.activeClaims[0].claimReference}` : 'No active warranty coverage is available.');
      let modalEl = document.getElementById('bhWarrantyClaimModal');
      if (!modalEl) {
        modalEl = document.createElement('div');
        modalEl.className = 'modal fade'; modalEl.id = 'bhWarrantyClaimModal'; modalEl.tabIndex = -1;
        modalEl.innerHTML = `<div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable"><form class="modal-content border-0 shadow-lg" id="bhWarrantyClaimForm"><div class="modal-header bg-dark text-white"><div><h5 class="modal-title fw-bold">Report a warranty issue</h5><div class="small text-white-50">Select the completed service and provide inspection-ready details.</div></div><button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button></div><div class="modal-body bg-light"><div class="alert alert-info small"><strong>Safety first:</strong> Stop operating unsafe equipment and select Safety defect below.</div><div class="row g-3"><div class="col-md-6"><label class="form-label small fw-bold">Coverage</label><select class="form-select" name="coverageId" id="bhClaimCoverage" required></select></div><div class="col-md-6"><label class="form-label small fw-bold">Affected service / unit</label><select class="form-select" name="itemKey" id="bhClaimItem" required></select></div><div class="col-md-6"><label class="form-label small fw-bold">Issue type</label><select class="form-select" name="claimType" id="bhClaimType" required></select></div><div class="col-md-6"><label class="form-label small fw-bold">Date discovered</label><input class="form-control" type="date" name="discoveredAt" id="bhClaimDiscovered" required></div><div class="col-md-6"><label class="form-label small fw-bold">Unit model / serial (if available)</label><input class="form-control" name="serialNumber" maxlength="120"></div><div class="col-md-6"><label class="form-label small fw-bold">Preferred remedy</label><select class="form-select" name="requestedRemedy"><option value="inspection">Inspection first</option><option value="repair">Repair</option><option value="replacement">Replacement part</option><option value="refund">Refund review</option></select></div><div class="col-12"><label class="form-label small fw-bold">Issue description</label><textarea class="form-control" name="description" rows="4" minlength="10" maxlength="3000" required></textarea></div><div class="col-12"><label class="form-label small fw-bold">Evidence (up to 5 JPG, PNG, or WEBP images)</label><input class="form-control" type="file" name="evidence" multiple accept="image/jpeg,image/png,image/webp"></div><div class="col-12"><label class="form-check"><input class="form-check-input" type="checkbox" name="safetyRisk" value="true" id="bhClaimSafety"><span class="form-check-label small ms-1">This may be unsafe to operate.</span></label></div></div><div class="alert alert-danger d-none mt-3 mb-0" id="bhClaimError"></div></div><div class="modal-footer"><button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button><button class="btn btn-primary" id="bhClaimSubmit" type="submit">Submit claim</button></div></form></div>`;
        document.body.appendChild(modalEl);
      }
      modalEl.dataset.bookingId = bookingId;
      modalEl._eligibility = eligibility;
      const coverage = modalEl.querySelector('#bhClaimCoverage');
      coverage.innerHTML = eligibility.coverages.map(item => `<option value="${escapeHtml(item.coverageId)}">${escapeHtml(item.serviceName || item.coverageType || 'Coverage')} · until ${escapeHtml(fmtLongDate(item.endDate))}</option>`).join('');
      modalEl.querySelector('#bhClaimDiscovered').value = new Date().toISOString().slice(0,10);
      const updateTypes = () => {
        const selected = eligibility.coverages.find(item => item.coverageId === coverage.value);
        const labels = { installation_workmanship:'Installation workmanship', repair_workmanship:'Repair workmanship', replacement_part:'Replacement part', diagnostic_accuracy:'Diagnostic accuracy', safety_defect:'Safety defect', product_defect:'Product defect' };
        modalEl.querySelector('#bhClaimType').innerHTML = (selected?.allowedClaimTypes || []).map(type => `<option value="${escapeHtml(type)}">${escapeHtml(labels[type] || type)}</option>`).join('');
        const coverageItemKey = String(selected?.itemKey || selected?.serviceId || '');
        const items = eligibility.items.filter(item => !coverageItemKey || String(item.itemKey) === coverageItemKey);
        modalEl.querySelector('#bhClaimItem').innerHTML = items.map(item => `<option value="${escapeHtml(item.itemKey)}">${escapeHtml(item.name)}</option>`).join('');
      };
      coverage.onchange = updateTypes; updateTypes();
      const form = modalEl.querySelector('#bhWarrantyClaimForm');
      form.onsubmit = async event => {
        event.preventDefault(); const button=modalEl.querySelector('#bhClaimSubmit'); const errorBox=modalEl.querySelector('#bhClaimError'); button.disabled=true; errorBox.classList.add('d-none');
        try {
          const data = new FormData(form); data.set('sourceType','booking'); data.set('sourceId',bookingId); data.set('safetyRisk',modalEl.querySelector('#bhClaimSafety').checked?'true':'false');
          const submitted = await fetch('/api/warranty-claims',{method:'POST',body:data,credentials:'same-origin',headers:{Accept:'application/json'}}); const result=await submitted.json();
          if(!submitted.ok) throw new Error(result.error || 'Claim could not be submitted.');
          bootstrap.Modal.getInstance(modalEl)?.hide(); alert(`Warranty claim ${result.claim.claimReference} was submitted.`); fetchBookings();
        } catch(error) { errorBox.textContent=error.message; errorBox.classList.remove('d-none'); }
        finally { button.disabled=false; }
      };
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    } catch(error) { alert(error.message || 'Warranty claim could not be started.'); }
  };
})();

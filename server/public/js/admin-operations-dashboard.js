(function () {
  "use strict";

  var refreshButton = document.getElementById("opsRefresh");
  if (!refreshButton) return;

  function el(id) { return document.getElementById(id); }
  function text(id, value) { var node = el(id); if (node) node.textContent = value; }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }
  function money(value) {
    return new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 2 }).format(Number(value) || 0);
  }
  function count(value) { return (Number(value) || 0).toLocaleString("en-PH"); }
  function overdueLabel(value) {
    var hours = Number(value) || 0;
    if (hours < 1) return "<1h overdue";
    if (hours < 24) return hours + "h overdue";
    return Math.floor(hours / 24) + "d " + (hours % 24) + "h overdue";
  }

  function renderPriorities(rows) {
    var target = el("opsPriorities");
    if (!rows.length) {
      target.innerHTML = '<div class="ops-empty"><i class="bi bi-check-circle text-success me-1"></i>No critical operational exception is open.</div>';
      return;
    }
    target.innerHTML = rows.map(function (row) {
      var dangerous = row.tone === "danger";
      return '<a class="ops-priority ' + (dangerous ? "danger" : "") + '" href="' + esc(row.href) + '"><i class="bi ' + (dangerous ? "bi-exclamation-octagon" : "bi-exclamation-triangle") + '"></i><span>' + esc(row.label) + '</span><i class="bi bi-chevron-right ms-auto"></i></a>';
    }).join("");
  }

  function renderEquipment(rows) {
    var target = el("opsEquipmentRows");
    if (!rows.length) {
      target.innerHTML = '<div class="ops-empty"><i class="bi bi-check-circle text-success me-1"></i>No overdue equipment.</div>';
      return;
    }
    target.innerHTML = rows.map(function (row) {
      return '<div class="ops-row"><div class="ops-row-main"><div class="ops-row-title">' + esc(row.equipment) + ' × ' + count(row.quantity) + '</div><div class="ops-row-meta">' + esc(row.technician) + '</div></div><div class="ops-row-value text-danger">' + esc(overdueLabel(row.overdueHours)) + '</div></div>';
    }).join("");
  }

  function renderControls(data) {
    var rows = [];
    (data.remittance.recent || []).slice(0, 3).forEach(function (row) {
      rows.push('<div class="ops-row"><div class="ops-row-main"><div class="ops-row-title">' + esc(row.reference) + ' · ' + esc(row.technician) + '</div><div class="ops-row-meta">' + esc(String(row.status).replaceAll("_", " ")) + '</div></div><div class="ops-row-value">' + esc(money(row.amount)) + '</div></div>');
    });
    (data.attendance.exceptions || []).slice(0, Math.max(0, 5 - rows.length)).forEach(function (row) {
      rows.push('<div class="ops-row"><div class="ops-row-main"><div class="ops-row-title">' + esc(row.name) + '</div><div class="ops-row-meta">Attendance control</div></div><div class="ops-row-value ' + (row.tone === "danger" ? "text-danger" : "text-warning") + '">' + esc(row.issue) + '</div></div>');
    });
    el("opsControlRows").innerHTML = rows.length ? rows.join("") : '<div class="ops-empty"><i class="bi bi-check-circle text-success me-1"></i>No cash or attendance control exceptions.</div>';
  }

  function render(data) {
    var work = data.work || {};
    var bookings = work.bookings || {};
    var orders = work.orders || {};
    var review = data.review || {};
    var cancellations = data.cancellations || {};
    var today = (data.collections || {}).today || {};
    var month = (data.collections || {}).month || {};
    var equipment = data.equipment || {};
    var remittance = data.remittance || { recent: [] };
    var attendance = data.attendance || { exceptions: [] };

    text("opsAsOf", "Updated " + new Date(data.asOf).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }));
    text("opsBookings", count(bookings.today));
    text("opsBookingsSub", count(bookings.createdToday) + " new booking" + (Number(bookings.createdToday) === 1 ? "" : "s") + " created today");
    text("opsBookingsActive", count(bookings.active) + " active");
    text("opsBookingsDone", count(bookings.completedToday) + " completed");
    text("opsOrders", count(orders.dueToday));
    text("opsOrdersSub", count(orders.createdToday) + " new order" + (Number(orders.createdToday) === 1 ? "" : "s") + " created today");
    text("opsOrdersActive", count(orders.active) + " active");
    text("opsOrdersDone", count(orders.completedToday) + " completed");
    text("opsReview", count(review.total));
    text("opsReviewBreakdown", count(review.bookings) + " bookings · " + count(review.orders) + " orders · " + count(review.noShow) + " no-shows");
    text("opsReviewOverdue", count(review.overdue) + " overdue");
    text("opsCancellations", count(cancellations.jobs));
    text("opsCancellationEvents", count(cancellations.events) + " events");
    text("opsCancellationEscalated", count(cancellations.escalated) + " escalated");
    text("opsCollected", money(today.net));
    text("opsCollectedSub", money(today.gross) + " gross · " + money(month.net) + " month net");
    text("opsCollectedTx", count(today.transactions) + " transactions");
    text("opsRefunds", money(today.refunds) + " refunds");
    text("opsEquipment", count(equipment.overdue));
    text("opsEquipmentSub", count(equipment.checkedOut) + " assets currently checked out · " + count(equipment.dueToday) + " due today");
    text("opsEquipmentUnits", count(equipment.overdueUnits) + " units");
    text("opsEquipmentTechs", count(equipment.techniciansWithOverdue) + " technicians");
    text("opsRemittance", count(remittance.actionCount));
    text("opsRemittanceSub", money((remittance.awaitingTechnicianAmount || 0) + (remittance.awaitingAdminAmount || 0)) + " under custody/reconciliation");
    text("opsRemitTech", count(remittance.awaitingTechnician) + " with tech");
    text("opsRemitAdmin", count(remittance.awaitingAdmin) + " to verify");
    text("opsAttendance", count((attendance.present || 0) + (attendance.late || 0)) + " / " + count(attendance.headcount));
    text("opsAttendanceSub", count(attendance.onLeave) + " on approved leave · " + count(attendance.checkedOut) + " checked out");
    text("opsAttendanceLate", count(attendance.late) + " late");
    text("opsAttendanceAbsent", count(attendance.absent) + " absent");

    renderPriorities(data.priorities || []);
    renderEquipment(equipment.recentOverdue || []);
    renderControls({ remittance: remittance, attendance: attendance });
  }

  async function load() {
    var error = el("opsError");
    var icon = refreshButton.querySelector("i");
    refreshButton.disabled = true;
    if (icon) icon.classList.add("spin");
    try {
      var response = await fetch("/api/admin/dashboard/operations", { credentials: "same-origin", cache: "no-store" });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || "Operations summary could not be loaded.");
      error.style.display = "none";
      render(payload);
    } catch (failure) {
      error.textContent = failure.message || "Operations summary could not be loaded.";
      error.style.display = "block";
      text("opsAsOf", "Refresh required");
    } finally {
      refreshButton.disabled = false;
      if (icon) icon.classList.remove("spin");
    }
  }

  refreshButton.addEventListener("click", load);
  load();
  window.setInterval(function () { if (!document.hidden) load(); }, 120000);
})();

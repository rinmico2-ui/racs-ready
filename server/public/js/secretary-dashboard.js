// secretary-dashboard.js
// Loads analytics metrics for the secretary dashboard and populates KPI cards.

async function loadDashboard() {
  try {
    // call the secretary-specific analytics summary endpoint that was
    // introduced to avoid giving secretaries blanket access to everything
    const sRes = await fetch("/api/secretary/analytics/summary");
    const s = sRes.ok ? await sRes.json() : {};

    document.getElementById("kpi-today-appointments").innerText =
      typeof s.todaysAppointments === "number" ? s.todaysAppointments : "—";
    document.getElementById("kpi-pending-bookings").innerText =
      typeof s.pendingBookingRequests === "number"
        ? s.pendingBookingRequests
        : "—";
    document.getElementById("kpi-on-the-way").innerText =
      typeof s.onTheWayCount === "number" ? s.onTheWayCount : "—";
    document.getElementById("kpi-active-jobs").innerText =
      typeof s.activeJobsInProgress === "number" ? s.activeJobsInProgress : "—";
    document.getElementById("kpi-completed-jobs").innerText =
      typeof s.completedJobsToday === "number" ? s.completedJobsToday : "—";
    document.getElementById("kpi-lowstock").innerText =
      typeof s.lowStockCount === "number" ? s.lowStockCount : "—";

    const revEl = document.getElementById("kpi-revenue-today");
    // ensure we never display the literal string "undefined"; treat undefined
    // the same as null/absent data by showing an em dash.
    if (typeof s.revenueToday === "number") {
      const formatted = s.revenueToday.toLocaleString(undefined, {
        style: "currency",
        currency: s.revenueCurrency || "PHP",
      });
      revEl.innerHTML = `<span class="text-success">${formatted}</span>`;
    } else {
      revEl.innerText = s.revenueToday == null ? "—" : s.revenueToday;
    }
  } catch (e) {
    console.warn("failed to load dashboard analytics", e);
  }
}

// attach refresh button handler
const refreshBtn = document.getElementById("btn-refresh");
if (refreshBtn) {
  refreshBtn.addEventListener("click", () => loadDashboard());
}

// initial load
document.addEventListener("DOMContentLoaded", loadDashboard);

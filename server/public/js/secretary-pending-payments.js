document.addEventListener("DOMContentLoaded", function () {
  const page = document.querySelector(".payments-page");
  if (!page) return;

  const tbody = document.querySelector("tbody");
  const searchInput = document.querySelector('input[placeholder*="Customer, invoice"]');
  const queueFilter = document.querySelector('select');
  const methodFilter = document.querySelectorAll('select')[1];
  const filterBtn = document.querySelector('.btn .bi-funnel')?.parentElement;

  // KPI elements
  const statVerify = document.getElementById("statVerify");
  const statOverdue = document.getElementById("statOverdue");
  const statManual = document.getElementById("statManual");

  let cache = [];

  // Helper: format currency
  function formatCurrency(amount) {
    if (!amount && amount !== 0) return "—";
    return "₱" + Number(amount).toLocaleString("en-PH", { minimumFractionDigits: 2 });
  }

  // Helper: format date
  function formatDate(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-PH", {
      year: "numeric",
      month: "short", 
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  // Helper: priority badge
  function priorityBadge(priority) {
    const colors = {
      high: "danger",
      medium: "warning",
      low: "success"
    };
    const color = colors[priority?.toLowerCase()] || "secondary";
    return `<span class="badge bg-${color}-subtle text-${color} border border-${color}-subtle">${priority || "Normal"}</span>`;
  }

  // Helper: method badge
  function methodBadge(method) {
    const colors = {
      gcash: "info",
      cash: "primary",
      bank: "primary"
    };
    const color = colors[method?.toLowerCase()] || "secondary";
    return `<span class="badge bg-${color}-subtle text-${color} border border-${color}-subtle">${method || "Unknown"}</span>`;
  }

  // Helper: render a single row
  function renderRow(payment) {
    const tr = document.createElement("tr");
    
    // Determine if overdue (more than 24 hours)
    const submittedDate = new Date(payment.submittedAt);
    const now = new Date();
    const hoursOld = (now - submittedDate) / (1000 * 60 * 60);
    const isOverdue = hoursOld > 24;
    
    // Determine priority based on amount and age
    let priority = "low";
    if (payment.amount > 20000 || isOverdue) priority = "high";
    else if (payment.amount > 10000 || hoursOld > 12) priority = "medium";

    tr.innerHTML = `
      <td class="ps-4">
        <div class="fw-bold text-dark">${payment.bookingReference || `TXN-${payment._id?.slice(-6)}`}</div>
        <div class="small text-muted">${payment.proofImage ? "Proof uploaded" : "Awaiting reference check"}</div>
      </td>
      <td>
        <div class="fw-semibold">${payment.customerName || "—"}</div>
        <div class="small text-muted">${payment.customerEmail || ""}</div>
      </td>
      <td class="small text-muted">${payment.bookingReference || "—"}</td>
      <td class="fw-bold">${formatCurrency(payment.amount)}</td>
      <td>${methodBadge(payment.method)}</td>
      <td class="small text-muted">${formatDate(payment.submittedAt)}</td>
      <td>${priorityBadge(priority)}</td>
      <td class="text-end pe-4">
        <div class="btn-group btn-group-sm">
          <button class="btn btn-outline-success approve-payment" data-id="${payment._id}">Approve</button>
          <button class="btn btn-outline-danger reject-payment" data-id="${payment._id}">Reject</button>
        </div>
      </td>
    `;
    return tr;
  }

  // Helper: render all rows
  function renderRows(payments) {
    if (!tbody) return;
    tbody.innerHTML = "";
    if (!payments || !payments.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">No pending payments found.</td></tr>';
      return;
    }
    const fragment = document.createDocumentFragment();
    payments.forEach((p) => fragment.appendChild(renderRow(p)));
    tbody.appendChild(fragment);
  }

  // Helper: update KPI stats
  function updateStats(payments) {
    if (!payments || !payments.length) {
      if (statVerify) statVerify.textContent = "0";
      if (statOverdue) statOverdue.textContent = "0";
      if (statManual) statManual.textContent = "0";
      return;
    }

    const now = new Date();
    const pending = payments.filter(p => p.status === "pending");
    const overdue = pending.filter(p => {
      const submitted = new Date(p.submittedAt);
      const hoursOld = (now - submitted) / (1000 * 60 * 60);
      return hoursOld > 24;
    });
    const manual = pending.filter(p => p.method === "cash" || !p.proofImage);

    if (statVerify) statVerify.textContent = pending.length.toLocaleString();
    if (statOverdue) statOverdue.textContent = overdue.length.toLocaleString();
    if (statManual) statManual.textContent = manual.length.toLocaleString();
  }

  // Helper: apply client-side filters
  function applyClientFilters(payments) {
    let filtered = payments || [];
    const searchTerm = searchInput ? searchInput.value.trim().toLowerCase() : "";
    const queueVal = queueFilter ? queueFilter.value : "";
    const methodVal = methodFilter ? methodFilter.value : "";

    if (searchTerm) {
      filtered = filtered.filter(
        (p) =>
          (p.bookingReference && p.bookingReference.toLowerCase().includes(searchTerm)) ||
          (p.customerName && p.customerName.toLowerCase().includes(searchTerm)) ||
          (p.customerEmail && p.customerEmail.toLowerCase().includes(searchTerm))
      );
    }

    if (queueVal && queueVal !== "All") {
      if (queueVal === "Verification Pending") {
        filtered = filtered.filter(p => p.status === "pending" && p.proofImage);
      } else if (queueVal === "Proof Required") {
        filtered = filtered.filter(p => p.status === "pending" && !p.proofImage);
      } else if (queueVal === "Disputed") {
        filtered = filtered.filter(p => p.status === "disputed");
      }
    }

    if (methodVal && methodVal !== "All") {
      filtered = filtered.filter((p) => p.method?.toLowerCase() === methodVal.toLowerCase());
    }

    return filtered;
  }

  // Load pending payments from server
  async function loadPendingPayments() {
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4"><div class="spinner-border spinner-border-sm me-2" role="status"></div>Loading pending payments...</td></tr>';
    try {
      const res = await fetch("/api/secretary/payments?status=pending", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payments = await res.json();
      cache = Array.isArray(payments) ? payments : [];
      const visible = applyClientFilters(cache);
      renderRows(visible);
      updateStats(visible);
    } catch (err) {
      console.warn("secretary-pending-payments: failed to load", err && err.message);
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-danger py-4">Failed to load pending payments.</td></tr>';
      }
    }
  }

  // Approve payment
  async function approvePayment(paymentId) {
    if (!paymentId || !confirm("Approve this payment?")) return;
    
    try {
      const res = await fetch(`/api/secretary/payments/${encodeURIComponent(paymentId)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "paid", completedAt: new Date() })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      // Show success message
      alert("Payment approved successfully!");
      loadPendingPayments(); // Reload data
    } catch (err) {
      console.error("Failed to approve payment:", err);
      alert("Failed to approve payment.");
    }
  }

  // Reject payment
  async function rejectPayment(paymentId) {
    if (!paymentId || !confirm("Reject this payment?")) return;
    
    try {
      const res = await fetch(`/api/secretary/payments/${encodeURIComponent(paymentId)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "failed" })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      // Show success message
      alert("Payment rejected successfully!");
      loadPendingPayments(); // Reload data
    } catch (err) {
      console.error("Failed to reject payment:", err);
      alert("Failed to reject payment.");
    }
  }

  // Event listeners
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const visible = applyClientFilters(cache);
      renderRows(visible);
      updateStats(visible);
    });
  }

  if (queueFilter) {
    queueFilter.addEventListener("change", () => {
      const visible = applyClientFilters(cache);
      renderRows(visible);
      updateStats(visible);
    });
  }

  if (methodFilter) {
    methodFilter.addEventListener("change", () => {
      const visible = applyClientFilters(cache);
      renderRows(visible);
      updateStats(visible);
    });
  }

  if (filterBtn) {
    filterBtn.addEventListener("click", () => {
      const visible = applyClientFilters(cache);
      renderRows(visible);
      updateStats(visible);
    });
  }

  // Approve/Reject button clicks
  document.addEventListener("click", function (e) {
    const approveBtn = e.target.closest(".approve-payment");
    if (approveBtn) {
      const paymentId = approveBtn.getAttribute("data-id");
      approvePayment(paymentId);
    }

    const rejectBtn = e.target.closest(".reject-payment");
    if (rejectBtn) {
      const paymentId = rejectBtn.getAttribute("data-id");
      rejectPayment(paymentId);
    }
  });

  // Initial load
  loadPendingPayments();
});

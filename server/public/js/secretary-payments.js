document.addEventListener("DOMContentLoaded", function () {
  const page = document.querySelector(".payments-page");
  if (!page) return;
  // move modal element to body to avoid z-index/overflow issues
  const dm = document.getElementById("paymentDetailsModal");
  if (dm && dm.parentElement !== document.body) {
    document.body.appendChild(dm);
  }

  const searchInput = document.getElementById("paymentsSearch");
  // highlight booking filter if present
  const urlParams = new URLSearchParams(window.location.search);
  const highlightedBookingId = urlParams.get("bookingId");
  const statusFilter = document.getElementById("paymentsStatusFilter");
  const methodFilter = document.getElementById("paymentsMethodFilter");
  const gatewayFilter = document.getElementById("paymentsGatewayFilter");
  const gatewayStatusFilter = document.getElementById("paymentsGatewayStatusFilter");
  const dateFilter = document.getElementById("paymentsDateFilter");
  const filterBtn = document.getElementById("paymentsFilterBtn");

  const tbody = document.getElementById("paymentsTableBody");
  const statTotalTx = document.getElementById("statTotalTx");
  const statCollected = document.getElementById("statCollected");
  const statPending = document.getElementById("statPending");
  const statFailed = document.getElementById("statFailed");

  const detailsModalEl = document.getElementById("paymentDetailsModal");
  const detailsModal = detailsModalEl ? new bootstrap.Modal(detailsModalEl) : null;

  const detailsBookingReference = document.getElementById("detailsBookingReference");
  const detailsBookingStatus = document.getElementById("detailsBookingStatus");
  const detailsStatusBadge = document.getElementById("detailsStatusBadge");
  const detailsCustomer = document.getElementById("detailsCustomer");
  const detailsService = document.getElementById("detailsService");
  const detailsDate = document.getElementById("detailsDate");
  const detailsTime = document.getElementById("detailsTime");
  const detailsLocation = document.getElementById("detailsLocation");
  const detailsMethod = document.getElementById("detailsMethod");
  const detailsGcashNumber = document.getElementById("detailsGcashNumber");
  const detailsReference = document.getElementById("detailsReference");
  const detailsTravelFare = document.getElementById("detailsTravelFare");
  const detailsDownpayment = document.getElementById("detailsDownpayment");
  const detailsEstimatedFee = document.getElementById("detailsEstimatedFee");
  const detailsIssue = document.getElementById("detailsIssue");
  const detailsNotes = document.getElementById("detailsNotes");
  const detailsProofLink = document.getElementById("detailsProofLink");
  const detailsNoProof = document.getElementById("detailsNoProof");
  const detailsVerifyBtn = document.getElementById("detailsVerifyBtn");
  const detailsFailBtn = document.getElementById("detailsFailBtn");
  const detailsCompleteBtn = document.getElementById("detailsCompleteBtn");
  const detailsPartialBtn = document.getElementById("detailsPartialBtn");

  let cache = [];
  let highlightedRow = null;

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
    });
  }

  // Helper: format time
  function formatTime(minutes) {
    if (!minutes && minutes !== 0) return "—";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const period = h >= 12 ? "PM" : "AM";
    const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${displayHour}:${String(m).padStart(2, "0")} ${period}`;
  }

  // Helper: status badge HTML
  function statusBadge(status) {
    const colors = {
      paid: "success",
      pending: "warning",
      failed: "danger",
      partial: "info",
    };
    const color = colors[status] || "secondary";
    return `<span class="badge bg-${color}">${status}</span>`;
  }

  // Helper: render a single row
  function renderRow(payment) {
    const tr = document.createElement("tr");
    if (highlightedBookingId && payment.bookingId === highlightedBookingId) {
      tr.classList.add("table-warning");
      highlightedRow = tr;
    }
    const submittedDate = payment.submittedAt ? new Date(payment.submittedAt) : null;
    const completedDate = payment.completedAt ? new Date(payment.completedAt) : null;

    tr.innerHTML = `
      <td><div class="fw-semibold">${payment.bookingReference || "—"}</div></td>
      <td><div>${payment.customerName || "—"}</div></td>
      <td><div>${payment.serviceName || "—"}</div></td>
      <td><div>${formatDate(submittedDate)} ${submittedDate ? submittedDate.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" }) : ""}</div></td>
      <td><div>${payment.method || "—"}</div></td>
      <td><div>${formatCurrency(payment.amount)}</div></td>
      <td><div>${statusBadge(payment.status)}</div></td>
      <td>
        <div class="d-flex gap-1">
          <button class="btn btn-sm btn-outline-secondary view-payment" data-id="${payment._id}" title="View Details">
            <i class="bi bi-eye"></i>
          </button>
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
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">No payments found.</td></tr>';
      return;
    }
    const fragment = document.createDocumentFragment();
    payments.forEach((p) => fragment.appendChild(renderRow(p)));
    tbody.appendChild(fragment);
    if (highlightedRow) {
      highlightedRow.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // Helper: update KPI stats
  function updateStats(payments) {
    if (!payments || !payments.length) {
      if (statTotalTx) statTotalTx.textContent = "0";
      if (statCollected) statCollected.textContent = formatCurrency(0);
      if (statPending) statPending.textContent = "0";
      if (statFailed) statFailed.textContent = "0";
      return;
    }
    const total = payments.length;
    const collected = payments
      .filter((p) => p.status === "paid")
      .reduce((sum, p) => sum + (p.amount || 0), 0);
    const pending = payments.filter((p) => p.status === "pending").length;
    const failed = payments.filter((p) => p.status === "failed").length;

    if (statTotalTx) statTotalTx.textContent = total.toLocaleString();
    if (statCollected) statCollected.textContent = formatCurrency(collected);
    if (statPending) statPending.textContent = pending.toLocaleString();
    if (statFailed) statFailed.textContent = failed.toLocaleString();
  }

  // Helper: apply client-side filters
  function applyClientFilters(payments) {
    let filtered = payments || [];
    const searchTerm = searchInput ? searchInput.value.trim().toLowerCase() : "";
    const statusVal = statusFilter ? statusFilter.value : "";
    const methodVal = methodFilter ? methodFilter.value : "";
    const gatewayVal = gatewayFilter ? gatewayFilter.value : "";
    const gatewayStatusVal = gatewayStatusFilter ? gatewayStatusFilter.value : "";

    if (searchTerm) {
      filtered = filtered.filter(
        (p) =>
          (p.bookingReference && p.bookingReference.toLowerCase().includes(searchTerm)) ||
          (p.customerName && p.customerName.toLowerCase().includes(searchTerm)) ||
          (p.serviceName && p.serviceName.toLowerCase().includes(searchTerm))
      );
    }
    if (statusVal) {
      filtered = filtered.filter((p) => p.status === statusVal);
    }
    if (methodVal) {
      filtered = filtered.filter((p) => p.method === methodVal);
    }
    if (gatewayVal) {
      filtered = filtered.filter((p) => p.gateway === gatewayVal);
    }
    if (gatewayStatusVal) {
      filtered = filtered.filter((p) => p.gatewayStatus === gatewayStatusVal);
    }

    return filtered;
  }

  // Load payments from server
  async function loadPayments() {
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4"><div class="spinner-border spinner-border-sm me-2" role="status"></div>Loading payments...</td></tr>';
    try {
      const res = await fetch("/api/secretary/payments", {
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
      console.warn("secretary-payments: failed to load", err && err.message);
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-danger py-4">Failed to load payments.</td></tr>';
      }
    }
  }

  // View payment details
  async function viewPaymentDetails(paymentId) {
    if (!paymentId) return;
    try {
      const res = await fetch(`/api/secretary/payments/${encodeURIComponent(paymentId)}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payment = await res.json();

      // Populate modal fields
      if (detailsBookingReference) detailsBookingReference.textContent = payment.bookingReference || "—";
      if (detailsBookingStatus) detailsBookingStatus.textContent = payment.bookingStatus || "—";
      if (detailsStatusBadge) detailsStatusBadge.innerHTML = statusBadge(payment.status);
      if (detailsCustomer) detailsCustomer.textContent = payment.customerName || "—";
      if (detailsService) detailsService.textContent = payment.serviceName || "—";
      if (detailsDate) detailsDate.textContent = formatDate(payment.submittedAt);
      if (detailsTime) detailsTime.textContent = payment.submittedAt ? new Date(payment.submittedAt).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" }) : "—";
      if (detailsLocation) detailsLocation.textContent = payment.location || "—";
      if (detailsMethod) detailsMethod.textContent = payment.method || "—";
      if (detailsGcashNumber) detailsGcashNumber.textContent = payment.gcashNumber || "—";
      if (detailsReference) detailsReference.textContent = payment.reference || "—";
      if (detailsTravelFare) detailsTravelFare.textContent = formatCurrency(payment.travelFare);
      if (detailsDownpayment) detailsDownpayment.textContent = formatCurrency(payment.downpayment);
      if (detailsEstimatedFee) detailsEstimatedFee.textContent = formatCurrency(payment.estimatedFee);
      if (detailsIssue) detailsIssue.textContent = payment.issueDescription || "—";
      if (detailsNotes) detailsNotes.textContent = payment.notes || "—";

      // Handle proof/receipt
      if (payment.proofImage) {
        if (detailsProofLink) {
          detailsProofLink.href = payment.proofImage;
          detailsProofLink.classList.remove("d-none");
        }
        if (detailsNoProof) detailsNoProof.classList.add("d-none");
      } else {
        if (detailsProofLink) detailsProofLink.classList.add("d-none");
        if (detailsNoProof) detailsNoProof.classList.remove("d-none");
      }

      // Configure action buttons based on status
      const canVerify = payment.status === "pending";
      const canFail = payment.status === "pending";
      const canComplete = payment.status === "paid";
      const canPartial = payment.status === "pending";

      if (detailsVerifyBtn) {
        detailsVerifyBtn.disabled = !canVerify;
        detailsVerifyBtn.style.display = canVerify ? "inline-block" : "none";
      }
      if (detailsFailBtn) {
        detailsFailBtn.disabled = !canFail;
        detailsFailBtn.style.display = canFail ? "inline-block" : "none";
      }
      if (detailsCompleteBtn) {
        detailsCompleteBtn.disabled = !canComplete;
        detailsCompleteBtn.style.display = canComplete ? "inline-block" : "none";
      }
      if (detailsPartialBtn) {
        detailsPartialBtn.disabled = !canPartial;
        detailsPartialBtn.style.display = canPartial ? "inline-block" : "none";
      }

      if (detailsModal) detailsModal.show();
    } catch (err) {
      console.error("Failed to load payment details:", err);
      alert("Failed to load payment details.");
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

  if (filterBtn) {
    filterBtn.addEventListener("click", () => {
      const visible = applyClientFilters(cache);
      renderRows(visible);
      updateStats(visible);
    });
  }

  // View payment buttons
  document.addEventListener("click", function (e) {
    const viewBtn = e.target.closest(".view-payment");
    if (viewBtn) {
      const paymentId = viewBtn.getAttribute("data-id");
      viewPaymentDetails(paymentId);
    }
  });

  // Initial load
  loadPayments();
});

document.addEventListener("DOMContentLoaded", function () {
  const page = document.querySelector(".payments-page");
  if (!page) return;

  const tbody = document.querySelector("tbody");
  const searchInput = document.querySelector('input[placeholder*="Transaction ID"]');
  const methodFilter = document.querySelector('select');
  const dateFilter = document.querySelector('input[type="date"]');
  const applyBtn = document.querySelector('.btn .bi-funnel')?.parentElement;

  // KPI elements
  const statCompletedToday = document.getElementById("statCompletedToday");
  const statSettledAmount = document.getElementById("statSettledAmount");
  const statAvgTime = document.getElementById("statAvgTime");

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
    
    // Determine verification method
    let verificationMethod = "Auto-reconciled";
    if (payment.completedAt && payment.proofImage) {
      verificationMethod = "Verified by Finance";
    } else if (payment.completedAt) {
      verificationMethod = "Manual verification";
    }

    tr.innerHTML = `
      <td class="ps-4">
        <div class="fw-bold text-dark">${payment.bookingReference || `TXN-${payment._id?.slice(-6)}`}</div>
        <div class="small text-muted">${verificationMethod}</div>
      </td>
      <td>
        <div class="fw-semibold">${payment.customerName || "—"}</div>
        <div class="small text-muted">${payment.customerEmail || ""}</div>
      </td>
      <td class="small text-muted">${payment.bookingReference || "—"}</td>
      <td>${methodBadge(payment.method)}</td>
      <td class="fw-bold text-dark">${formatCurrency(payment.amount)}</td>
      <td class="small text-muted">${formatDate(payment.completedAt)}</td>
      <td class="small text-success">
        <i class="bi bi-check-circle me-1"></i>Issued
      </td>
      <td class="text-end pe-4">
        <button class="btn btn-sm btn-light border download-receipt" data-id="${payment._id}" ${payment.proofImage ? '' : 'disabled'}>
          <i class="bi bi-download"></i>
        </button>
      </td>
    `;
    return tr;
  }

  // Helper: render all rows
  function renderRows(payments) {
    if (!tbody) return;
    tbody.innerHTML = "";
    if (!payments || !payments.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">No completed payments found.</td></tr>';
      return;
    }
    const fragment = document.createDocumentFragment();
    payments.forEach((p) => fragment.appendChild(renderRow(p)));
    tbody.appendChild(fragment);
  }

  // Helper: update KPI stats
  function updateStats(payments) {
    if (!payments || !payments.length) {
      if (statCompletedToday) statCompletedToday.textContent = "0";
      if (statSettledAmount) statSettledAmount.textContent = "₱0";
      if (statAvgTime) statAvgTime.textContent = "0h";
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayPayments = payments.filter(p => {
      const completedDate = new Date(p.completedAt);
      return completedDate >= today;
    });

    const todayAmount = todayPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
    
    // Calculate average settlement time (from submitted to completed)
    const avgSettlementTimes = payments
      .filter(p => p.submittedAt && p.completedAt)
      .map(p => {
        const submitted = new Date(p.submittedAt);
        const completed = new Date(p.completedAt);
        return (completed - submitted) / (1000 * 60 * 60); // hours
      });

    const avgTime = avgSettlementTimes.length > 0 
      ? avgSettlementTimes.reduce((a, b) => a + b, 0) / avgSettlementTimes.length 
      : 0;

    if (statCompletedToday) statCompletedToday.textContent = todayPayments.length.toLocaleString();
    if (statSettledAmount) statSettledAmount.textContent = todayAmount >= 1000 
      ? `₱${(todayAmount / 1000).toFixed(1)}k` 
      : formatCurrency(todayAmount);
    if (statAvgTime) statAvgTime.textContent = avgTime.toFixed(1) + 'h';
  }

  // Helper: apply client-side filters
  function applyClientFilters(payments) {
    let filtered = payments || [];
    const searchTerm = searchInput ? searchInput.value.trim().toLowerCase() : "";
    const methodVal = methodFilter ? methodFilter.value : "";
    const dateVal = dateFilter ? dateFilter.value : "";

    if (searchTerm) {
      filtered = filtered.filter(
        (p) =>
          (p.bookingReference && p.bookingReference.toLowerCase().includes(searchTerm)) ||
          (p.customerName && p.customerName.toLowerCase().includes(searchTerm)) ||
          (p.customerEmail && p.customerEmail.toLowerCase().includes(searchTerm))
      );
    }

    if (methodVal && methodVal !== "All Methods") {
      filtered = filtered.filter((p) => p.method?.toLowerCase() === methodVal.toLowerCase());
    }

    if (dateVal) {
      const filterDate = new Date(dateVal);
      filtered = filtered.filter(p => {
        const completedDate = new Date(p.completedAt);
        return completedDate.toDateString() === filterDate.toDateString();
      });
    }

    return filtered;
  }

  // Load completed payments from server
  async function loadCompletedPayments() {
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4"><div class="spinner-border spinner-border-sm me-2" role="status"></div>Loading completed payments...</td></tr>';
    try {
      const res = await fetch("/api/secretary/payments?status=paid", {
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
      console.warn("secretary-completed-payments: failed to load", err && err.message);
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center text-danger py-4">Failed to load completed payments.</td></tr>';
      }
    }
  }

  // Download receipt
  function downloadReceipt(paymentId) {
    const payment = cache.find(p => p._id === paymentId);
    if (payment && payment.proofImage) {
      // Create a temporary link to download the image
      const link = document.createElement('a');
      link.href = payment.proofImage;
      link.download = `receipt-${payment.bookingReference || payment._id}.jpg`;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      alert("No receipt available for this payment.");
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

  if (methodFilter) {
    methodFilter.addEventListener("change", () => {
      const visible = applyClientFilters(cache);
      renderRows(visible);
      updateStats(visible);
    });
  }

  if (dateFilter) {
    dateFilter.addEventListener("change", () => {
      const visible = applyClientFilters(cache);
      renderRows(visible);
      updateStats(visible);
    });
  }

  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      const visible = applyClientFilters(cache);
      renderRows(visible);
      updateStats(visible);
    });
  }

  // Download receipt button clicks
  document.addEventListener("click", function (e) {
    const downloadBtn = e.target.closest(".download-receipt");
    if (downloadBtn) {
      const paymentId = downloadBtn.getAttribute("data-id");
      downloadReceipt(paymentId);
    }
  });

  // Initial load
  loadCompletedPayments();
});

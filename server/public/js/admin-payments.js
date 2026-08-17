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
  const highlightedOrderId = urlParams.get("orderId");
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

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatCurrency(value) {
    const num = Number(value || 0);
    return num.toLocaleString("en-PH", {
      style: "currency",
      currency: "PHP",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function badgeClassForStatus(status) {
    const s = String(status || "").toLowerCase();
    if (["completed", "verified", "paid", "succeeded"].includes(s)) {
      return "bg-success-subtle text-success border border-success-subtle";
    }
    if (["failed", "cancelled", "expired"].includes(s)) {
      return "bg-danger-subtle text-danger border border-danger-subtle";
    }
    if (s === "partial") {
      // treat partial as a distinct warning/info state
      return "bg-warning-subtle text-warning border border-warning-subtle";
    }
    return "bg-warning-subtle text-warning border border-warning-subtle";
  }

  function normalizeMethod(method) {
    const m = String(method || "").toLowerCase();
    if (m === "cod") return "Cash";
    if (m === "gcash") return "GCash";
    if (m === "bank") return "Bank";
    if (!m) return "-";
    return m.charAt(0).toUpperCase() + m.slice(1);
  }

  function renderRows(items) {
    if (!tbody) return;
    if (!Array.isArray(items) || !items.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center py-5">
        <div style="color:#94a3b8;">
          <i class="bi bi-credit-card-2-front" style="font-size:2.5rem;display:block;margin-bottom:12px;opacity:0.5;"></i>
          <div style="font-weight:600;color:#64748b;margin-bottom:4px;">No payment records found</div>
          <div style="font-size:0.8rem;">Payments will appear here when customers complete bookings</div>
        </div>
      </td></tr>`;
      return;
    }

    tbody.innerHTML = items
      .map((p) => {
        const transactionId = p._id;
        const bookingReference = p.bookingReference || "-";
        const bookingDateText = p.bookingDate
          ? new Date(p.bookingDate).toLocaleDateString("en-PH")
          : "-";
        const bookingCreatedText = p.bookingCreatedAt
          ? new Date(p.bookingCreatedAt).toLocaleString("en-PH")
          : "-";
        const reference = p.reference || "-";
        const customerName = p.customerName || "-";
        const customerEmail = p.customerEmail || "-";
        const method = normalizeMethod(p.method);
        const proofUrl = p.proofUrl || "";
        const amount = formatCurrency(p.amount || 0);
        let status = p.status || "pending";
        const submittedAtRaw = p.submittedAt || p.createdAt || p.bookingCreatedAt;
        const date = submittedAtRaw
          ? new Date(submittedAtRaw).toLocaleDateString("en-PH")
          : "-";
        const time = submittedAtRaw
          ? new Date(submittedAtRaw).toLocaleTimeString("en-PH", { hour: '2-digit', minute: '2-digit' })
          : "";
        // convert completed to paid for table display
        if (String(status).toLowerCase() === "completed") {
          status = "paid";
        }

        // show booking reference plus current booking status
        const bookingBadge = p.bookingStatus
          ? `<div><span class="badge bg-${
              p.bookingStatus === "confirmed" ? "success" :
              p.bookingStatus === "completed" ? "info" :
              p.bookingStatus === "cancelled" ? "danger" :
              "warning"
            } text-capitalize">${escapeHtml(p.bookingStatus)}</span></div>`
          : "";
        const rowClass =
          (highlightedBookingId && String(p.bookingId) === String(highlightedBookingId)) ||
          (highlightedOrderId && String(p.orderId) === String(highlightedOrderId))
            ? "table-primary"
            : "";
        return `
          <tr id="payment-row-${escapeHtml(transactionId)}" class="${rowClass}">
            <td class="ps-4 td-truncate-md" title="ID: ${escapeHtml(transactionId)}\nRef: ${escapeHtml(reference)}">
              <div class="fw-bold text-dark text-truncate">${escapeHtml(transactionId)}</div>
              <div class="text-muted text-truncate text-micro">Reference: ${escapeHtml(reference)}</div>
            </td>
            <td class="td-truncate-md" title="${escapeHtml(customerName)}\n${escapeHtml(customerEmail)}">
              <div class="fw-semibold text-truncate text-dark">${escapeHtml(customerName)}</div>
              <div class="text-muted text-truncate text-micro">${escapeHtml(customerEmail)}</div>
            </td>
            <td class="text-muted text-micro td-truncate-md" title="Ref: ${escapeHtml(bookingReference)}\nBooked: ${escapeHtml(bookingCreatedText)}">
              <div class="fw-semibold text-dark">${escapeHtml(bookingReference)}</div>
              <div class="text-muted text-micro">Booking date: ${escapeHtml(bookingDateText)}</div>
              <div class="text-muted text-truncate text-micro">Booked: ${escapeHtml(bookingCreatedText)}</div>
              ${bookingBadge}
            </td>
            <td class="d-none"><span class="badge bg-info-subtle text-info border border-info-subtle">${escapeHtml(method)}</span></td>
            <td class="text-muted text-micro d-none">${escapeHtml(reference)}</td>
            <td class="d-none">
              ${proofUrl
                ? `<button type="button" class="btn btn-micro btn-outline-primary" onclick="window.openPaymentImage('${escapeHtml(proofUrl).replace(/'/g, "\\'")}')"><i class="bi bi-image me-1"></i>View</button>`
                : '<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle">No Proof</span>'}
            </td>
            <td class="fw-bold text-dark">${escapeHtml(amount)}</td>
            <td><span class="badge ${badgeClassForStatus(status)}">${escapeHtml(String(status).toUpperCase())}</span></td>
            <td class="text-nowrap">${escapeHtml(date)}<div class="text-muted text-micro">${escapeHtml(time)}</div></td>
            <td class="text-end pe-4">
              <button class="btn btn-micro btn-light border js-view-details" data-payment-id="${escapeHtml(p._id)}" title="View details">
                <i class="bi bi-receipt"></i>
              </button>
            </td>
          </tr>`;
      })
      .join("");
    // after inserting rows, scroll highlight into view
    if (highlightedBookingId || highlightedOrderId) {
      const target = tbody.querySelector(`tr.table-primary`);
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }

  let currentPaymentId = null;

  async function changePaymentStatus(paymentId, newStatus) {
    if (!paymentId) return false;
    let body = { status: newStatus };
    // when failing, ask admin for reason and include it as notes
    if (newStatus === "failed") {
      const reason = prompt("Please enter reason for failing this payment (will be recorded and sent to the customer):");
      if (reason != null) {
        body.notes = reason.trim();
      }
    }
    try {
      const resp = await fetch(`/api/admin/payments/${encodeURIComponent(paymentId)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        window.notify?.error("Status update failed: " + txt);
        return false;
      }
      window.notify?.success("Payment status set to " + newStatus);
      // hide details modal if open
      if (detailsModal) detailsModal.hide();
      await loadPayments();
      return true;
    } catch (e) {
      console.warn("changePaymentStatus error", e && e.message);
      window.notify?.error("Failed to update payment status");
      return false;
    }
  }

  function statusBadgeMarkup(status) {
    const s = String(status || "pending").toLowerCase();
    if (["paid", "succeeded", "completed", "verified"].includes(s)) {
      // unify completed/verified with paid for display
      return { text: "✅ PAID", style: "background:#ecfdf3;color:#047857;border:1px solid #86efac;" };
    }
    if (s === "partial") {
      return { text: "➗ PARTIAL", style: "background:#fff7ed;color:#c2410c;border:1px solid #fde68a;" };
    }
    if (["failed"].includes(s)) {
      return { text: "❌ FAILED", style: "background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;" };
    }
    return { text: "⏳ PENDING", style: "background:#fff8e1;color:#e65100;border:1px solid #ffd54f;" };
  }

  async function openDetails(paymentId) {
    if (!paymentId || !detailsModal) return;
    currentPaymentId = paymentId;
    // configure footer buttons based on booking/ payment status later
    const configureButtons = (paid, method, currentStatus) => {
      if (detailsVerifyBtn) {
        detailsVerifyBtn.textContent = "Mark Paid";
        detailsVerifyBtn.style.display = paid ? "none" : "inline-block";
        detailsVerifyBtn.onclick = () => changePaymentStatus(paymentId, "paid");
      }
      if (detailsFailBtn) {
        detailsFailBtn.style.display = paid ? "none" : "inline-block";
        detailsFailBtn.onclick = () => changePaymentStatus(paymentId, "failed");
      }
      if (detailsPartialBtn) {
        const isCash = method === "cod" || method === "cash";
        const alreadyPartial = String(currentStatus || "").toLowerCase() === "partial";
        detailsPartialBtn.style.display = !paid && isCash && !alreadyPartial ? "inline-block" : "none";
        detailsPartialBtn.onclick = () => changePaymentStatus(paymentId, "partial");
      }
      if (detailsCompleteBtn) {
        detailsCompleteBtn.style.display = "none";
      }
    };
    // temporarily hide until we know current state
    configureButtons(true, null, null);
    try {
      const res = await fetch(`/api/admin/payments/${encodeURIComponent(paymentId)}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("Failed to fetch payment details");
      const data = await res.json();
      const payment = data && data.payment ? data.payment : null;
      if (!payment) throw new Error("Missing payment details");

      // display badge according to booking's payment status where available
      const badge = statusBadgeMarkup(payment.bookingPaymentStatus || payment.status);
      if (detailsBookingReference) detailsBookingReference.textContent = payment.bookingReference || "-";
      if (detailsBookingStatus) detailsBookingStatus.textContent = payment.bookingStatus || "-";
      
      const isOrder = !!payment.orderId;
      const modalTitleEl = detailsModalEl.querySelector(".modal-title");
      if (modalTitleEl) {
        modalTitleEl.textContent = isOrder ? "Order & Payment Details" : "Booking & Payment Details";
      }
      // update buttons now that we know if booking/payment is already paid
      const paidFlag = String(payment.bookingPaymentStatus || payment.status || "").toLowerCase() === "paid" ||
        String(payment.status || "").toLowerCase() === "completed";
      configureButtons(paidFlag, payment.method, String(payment.status || "").toLowerCase());
      if (detailsStatusBadge) {
        detailsStatusBadge.textContent = badge.text;
        detailsStatusBadge.setAttribute("style", `${badge.style}font-size:.78rem;font-weight:700;`);
      }

      const bookingDate = payment.bookingDate ? new Date(payment.bookingDate).toLocaleDateString("en-PH", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      }) : "-";

      if (detailsCustomer) detailsCustomer.textContent = `${payment.customerName || "-"} (${payment.customerEmail || "-"})`;
      if (detailsService) detailsService.textContent = payment.serviceName || "-";
      if (detailsDate) detailsDate.textContent = bookingDate;
      if (detailsTime) detailsTime.textContent = payment.selectedTimeLabel || "-";
      if (detailsLocation) detailsLocation.textContent = payment.locationAddress || "-";
      if (detailsMethod) detailsMethod.textContent = normalizeMethod(payment.bookingPaymentMethod || payment.method);
      if (detailsGcashNumber) detailsGcashNumber.textContent = payment.gcashNumber || "-";
      if (detailsReference) detailsReference.textContent = payment.gcashReference || payment.reference || "-";
      if (detailsTravelFare) detailsTravelFare.textContent = formatCurrency(payment.travelFare || 0);
      if (detailsDownpayment) detailsDownpayment.textContent = formatCurrency(payment.downpaymentAmount || payment.amount || 0);
      if (detailsEstimatedFee) detailsEstimatedFee.textContent = formatCurrency(payment.estimatedFee || 0);
      if (detailsIssue) detailsIssue.textContent = payment.issueDescription || "-";
      if (detailsNotes) detailsNotes.textContent = payment.notes || "-";

      const proofUrl = payment.proofUrl || "";
      if (detailsProofLink && detailsNoProof) {
        if (proofUrl) {
          detailsProofLink.onclick = () => window.openPaymentImage(proofUrl);
          detailsProofLink.classList.remove("d-none");
          detailsNoProof.classList.add("d-none");
        } else {
          detailsProofLink.onclick = null;
          detailsProofLink.classList.add("d-none");
          detailsNoProof.classList.remove("d-none");
        }
      }

      detailsModal.show();
    } catch (err) {
      console.warn("admin-payments: failed to load details", err && err.message);
      alert("Could not load payment details right now.");
    }
  }

  function updateStats(items) {
    const rows = Array.isArray(items) ? items : [];
    const total = rows.length;
    const paidRows = rows.filter((p) => ["paid","completed", "verified"].includes(String(p.status || "").toLowerCase()));
    const collected = paidRows.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const pendingRows = rows.filter((p) => String(p.status || "").toLowerCase() === "pending");
    const pending = pendingRows.length;
    const pendingAmount = pendingRows.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const failedRows = rows.filter((p) => String(p.status || "").toLowerCase() === "failed");
    const failed = failedRows.length;
    const failedAmount = failedRows.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const partialRows = rows.filter((p) => String(p.status || "").toLowerCase() === "partial");
    const partial = partialRows.length;
    const partialAmount = partialRows.reduce((sum, p) => sum + Number(p.amount || 0), 0);

    if (statTotalTx) statTotalTx.textContent = total.toLocaleString("en-PH");
    if (statCollected) statCollected.textContent = formatCurrency(collected);
    if (statPending) statPending.textContent = pending.toLocaleString("en-PH");
    if (statFailed) statFailed.textContent = failed.toLocaleString("en-PH");

    // Update Executive KPIs
    const kpiTotalRevenue = document.getElementById("kpiTotalRevenue");
    const kpiMonthlyRevenue = document.getElementById("kpiMonthlyRevenue");
    const kpiCollectionRate = document.getElementById("kpiCollectionRate");
    const kpiPendingAmount = document.getElementById("kpiPendingAmount");
    const kpiSuccessRate = document.getElementById("kpiSuccessRate");
    const kpiFailedCount = document.getElementById("kpiFailedCount");
    const kpiAvgTransaction = document.getElementById("kpiAvgTransaction");
    const kpiTotalTransactions = document.getElementById("kpiTotalTransactions");

    if (kpiTotalRevenue) kpiTotalRevenue.textContent = formatCurrency(collected);
    if (kpiMonthlyRevenue) kpiMonthlyRevenue.textContent = formatCurrency(collected);
    
    const collectionRate = total > 0 ? ((paidRows.length / total) * 100).toFixed(1) : 0;
    if (kpiCollectionRate) kpiCollectionRate.textContent = collectionRate;
    if (kpiPendingAmount) kpiPendingAmount.textContent = formatCurrency(pendingAmount);

    const successRate = total > 0 ? (((paidRows.length + partialRows.length) / total) * 100).toFixed(1) : 0;
    if (kpiSuccessRate) kpiSuccessRate.textContent = successRate;
    if (kpiFailedCount) kpiFailedCount.textContent = failed;

    const avgTransaction = paidRows.length > 0 ? (collected / paidRows.length) : 0;
    if (kpiAvgTransaction) kpiAvgTransaction.textContent = formatCurrency(avgTransaction);
    if (kpiTotalTransactions) kpiTotalTransactions.textContent = total;

    // Payment Methods Breakdown
    const gcashRows = rows.filter((p) => String(p.method || "").toLowerCase() === "gcash");
    const cashRows = rows.filter((p) => String(p.method || "").toLowerCase() === "cod");
    const bankRows = rows.filter((p) => String(p.method || "").toLowerCase() === "bank");

    const kpiGcashCount = document.getElementById("kpiGcashCount");
    const kpiGcashPercent = document.getElementById("kpiGcashPercent");
    const kpiCashCount = document.getElementById("kpiCashCount");
    const kpiCashPercent = document.getElementById("kpiCashPercent");
    const kpiBankCount = document.getElementById("kpiBankCount");
    const kpiBankPercent = document.getElementById("kpiBankPercent");

    if (kpiGcashCount) kpiGcashCount.textContent = gcashRows.length;
    if (kpiGcashPercent) kpiGcashPercent.textContent = total > 0 ? ((gcashRows.length / total) * 100).toFixed(0) + "%" : "0%";
    if (kpiCashCount) kpiCashCount.textContent = cashRows.length;
    if (kpiCashPercent) kpiCashPercent.textContent = total > 0 ? ((cashRows.length / total) * 100).toFixed(0) + "%" : "0%";
    if (kpiBankCount) kpiBankCount.textContent = bankRows.length;
    if (kpiBankPercent) kpiBankPercent.textContent = total > 0 ? ((bankRows.length / total) * 100).toFixed(0) + "%" : "0%";

    // Outstanding Amounts
    const kpiPendingCount = document.getElementById("kpiPendingCount");
    const kpiPendingValue = document.getElementById("kpiPendingValue");
    const kpiPartialCount = document.getElementById("kpiPartialCount");
    const kpiPartialValue = document.getElementById("kpiPartialValue");
    const kpiFailedCountDetail = document.getElementById("kpiFailedCountDetail");
    const kpiFailedValue = document.getElementById("kpiFailedValue");

    if (kpiPendingCount) kpiPendingCount.textContent = pending;
    if (kpiPendingValue) kpiPendingValue.textContent = formatCurrency(pendingAmount);
    if (kpiPartialCount) kpiPartialCount.textContent = partial;
    if (kpiPartialValue) kpiPartialValue.textContent = formatCurrency(partialAmount);
    if (kpiFailedCountDetail) kpiFailedCountDetail.textContent = failed;
    if (kpiFailedValue) kpiFailedValue.textContent = formatCurrency(failedAmount);

    // Performance Metrics
    const amounts = rows.map(p => Number(p.amount || 0)).filter(a => a > 0);
    const avgDailyRevenue = amounts.length > 0 ? (collected / 30) : 0; // Assuming 30-day period
    const highestTxn = amounts.length > 0 ? Math.max(...amounts) : 0;
    const lowestTxn = amounts.length > 0 ? Math.min(...amounts) : 0;

    const kpiAvgDailyRevenue = document.getElementById("kpiAvgDailyRevenue");
    const kpiHighestTxn = document.getElementById("kpiHighestTxn");
    const kpiLowestTxn = document.getElementById("kpiLowestTxn");

    if (kpiAvgDailyRevenue) kpiAvgDailyRevenue.textContent = formatCurrency(avgDailyRevenue);
    if (kpiHighestTxn) kpiHighestTxn.textContent = formatCurrency(highestTxn);
    if (kpiLowestTxn) kpiLowestTxn.textContent = formatCurrency(lowestTxn);

    // Update status overview bars
    const paidPercent = total > 0 ? ((paidRows.length / total) * 100).toFixed(1) : 0;
    const pendingPercent = total > 0 ? ((pending / total) * 100).toFixed(1) : 0;
    const partialPercent = total > 0 ? ((partial / total) * 100).toFixed(1) : 0;
    const failedPercent = total > 0 ? ((failed / total) * 100).toFixed(1) : 0;

    const paidPercentEl = document.getElementById("paidPercent");
    const paidBarEl = document.getElementById("paidBar");
    const paidCountEl = document.getElementById("paidCount");
    if (paidPercentEl) paidPercentEl.textContent = paidPercent + "%";
    if (paidBarEl) paidBarEl.style.width = paidPercent + "%";
    if (paidCountEl) paidCountEl.textContent = paidRows.length + " transactions";

    const pendingPercentEl = document.getElementById("pendingPercent");
    const pendingBarEl = document.getElementById("pendingBar");
    const pendingCountEl = document.getElementById("pendingCount");
    if (pendingPercentEl) pendingPercentEl.textContent = pendingPercent + "%";
    if (pendingBarEl) pendingBarEl.style.width = pendingPercent + "%";
    if (pendingCountEl) pendingCountEl.textContent = pending + " transactions";

    const partialPercentEl = document.getElementById("partialPercent");
    const partialBarEl = document.getElementById("partialBar");
    const partialCountEl = document.getElementById("partialCount");
    if (partialPercentEl) partialPercentEl.textContent = partialPercent + "%";
    if (partialBarEl) partialBarEl.style.width = partialPercent + "%";
    if (partialCountEl) partialCountEl.textContent = partial + " transactions";

    const failedPercentEl = document.getElementById("failedPercent");
    const failedBarEl = document.getElementById("failedBar");
    const failedCountEl = document.getElementById("failedCount");
    if (failedPercentEl) failedPercentEl.textContent = failedPercent + "%";
    if (failedBarEl) failedBarEl.style.width = failedPercent + "%";
    if (failedCountEl) failedCountEl.textContent = failed + " transactions";

    // Update pagination info
    const paginationInfo = document.getElementById("paymentsPaginationInfo");
    if (paginationInfo) paginationInfo.textContent = `Showing ${rows.length} of ${total} transactions`;

    // Update charts
    updateCharts(rows);
  }

  let paymentTrendChart = null;
  let paymentMethodChart = null;

  function updateCharts(items) {
    const rows = Array.isArray(items) ? items : [];

    // Payment Trend Chart (last 30 days)
    const trendCanvas = document.getElementById("chartPaymentTrend");
    if (trendCanvas && typeof Chart !== "undefined") {
      const ctx = trendCanvas.getContext("2d");
      
      // Generate last 30 days
      const days = [];
      const dailyAmounts = [];
      const dailyCounts = [];
      for (let i = 29; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().slice(0, 10);
        days.push(date.toLocaleDateString("en-PH", { month: "short", day: "numeric" }));
        
        const dayPayments = rows.filter(p => {
          const pDate = new Date(p.submittedAt || p.createdAt || p.bookingCreatedAt);
          return pDate.toISOString().slice(0, 10) === dateStr;
        });
        dailyAmounts.push(dayPayments.reduce((sum, p) => sum + Number(p.amount || 0), 0));
        dailyCounts.push(dayPayments.length);
      }

      if (paymentTrendChart) paymentTrendChart.destroy();
      paymentTrendChart = new Chart(ctx, {
        type: "line",
        data: {
          labels: days,
          datasets: [{
            label: "Revenue",
            data: dailyAmounts,
            borderColor: "#2563eb",
            backgroundColor: "rgba(37, 99, 235, 0.1)",
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 4,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 7, font: { size: 10 } } },
            y: { grid: { color: "#f1f5f9" }, ticks: { font: { size: 10 }, callback: v => "₱" + (v/1000).toFixed(0) + "k" } }
          }
        }
      });

      // Update trend stats
      const totalAmount = dailyAmounts.reduce((a, b) => a + b, 0);
      const avgAmount = dailyAmounts.length > 0 ? totalAmount / dailyAmounts.length : 0;
      const peakAmount = Math.max(...dailyAmounts);
      const peakIndex = dailyAmounts.indexOf(peakAmount);
      const firstHalf = dailyAmounts.slice(0, 15).reduce((a, b) => a + b, 0);
      const secondHalf = dailyAmounts.slice(15).reduce((a, b) => a + b, 0);
      const growth = firstHalf > 0 ? (((secondHalf - firstHalf) / firstHalf) * 100).toFixed(1) : 0;

      const paymentAvgEl = document.getElementById("paymentAvg");
      const paymentPeakEl = document.getElementById("paymentPeak");
      const paymentGrowthEl = document.getElementById("paymentGrowth");
      if (paymentAvgEl) paymentAvgEl.textContent = "₱" + Math.round(avgAmount).toLocaleString();
      if (paymentPeakEl) paymentPeakEl.textContent = days[peakIndex] || "--";
      if (paymentGrowthEl) paymentGrowthEl.textContent = (growth >= 0 ? "+" : "") + growth + "%";
    }

    // Payment Method Distribution Chart
    const methodCanvas = document.getElementById("chartPaymentMethod");
    if (methodCanvas && typeof Chart !== "undefined") {
      const ctx = methodCanvas.getContext("2d");
      
      const methodCounts = {};
      rows.forEach(p => {
        const method = normalizeMethod(p.method);
        methodCounts[method] = (methodCounts[method] || 0) + 1;
      });

      const labels = Object.keys(methodCounts);
      const data = Object.values(methodCounts);
      const colors = ["#2563eb", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444"];

      if (paymentMethodChart) paymentMethodChart.destroy();
      paymentMethodChart = new Chart(ctx, {
        type: "doughnut",
        data: {
          labels: labels.length ? labels : ["No Data"],
          datasets: [{
            data: data.length ? data : [1],
            backgroundColor: data.length ? colors.slice(0, labels.length) : ["#e2e8f0"],
            borderWidth: 0,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "65%",
          plugins: {
            legend: { position: "right", labels: { boxWidth: 12, padding: 16, font: { size: 11 } } }
          }
        }
      });
    }
  }

  function applyClientFilters(items) {
    const q = String(searchInput?.value || "").trim().toLowerCase();
    const status = String(statusFilter?.value || "all").toLowerCase();
    const method = String(methodFilter?.value || "all").toLowerCase();
    const gateway = String(gatewayFilter?.value || "all").toLowerCase();
    const gatewayStatus = String(gatewayStatusFilter?.value || "all").toLowerCase();
    const date = String(dateFilter?.value || "").trim();

    return items.filter((p) => {
      const haystack = [
        p._id,
        p.bookingId,
        p.bookingReference,
        p.bookingStatus,
        p.serviceName,
        p.reference,
        p.customerName,
        p.customerEmail,
      ]
        .map((x) => String(x || "").toLowerCase())
        .join(" ");
      if (q && !haystack.includes(q)) return false;

      if (status !== "all") {
        let st = String(p.status || p.bookingPaymentStatus || "").toLowerCase();
        if (st === "completed") st = "paid"; // treat legacy completed as paid
        if (st !== status) return false;
      }
      if (method !== "all" && String(p.method || "").toLowerCase() !== method) return false;
      if (gateway !== "all" && String(p.gateway || "").toLowerCase() !== gateway) return false;
      if (gatewayStatus !== "all" && String(p.gatewayStatus || "").toLowerCase() !== gatewayStatus) return false;

      if (date) {
        const submittedDate = p.submittedAt
          ? new Date(p.submittedAt).toISOString().slice(0, 10)
          : "";
        if (submittedDate !== date) return false;
      }

      return true;
    });
  }

  let cache = [];

  async function loadPayments() {
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center py-5">
        <div style="color:#94a3b8;">
          <div class="spinner-border spinner-border-sm text-primary mb-2" role="status"></div>
          <div style="font-size:0.85rem;">Loading payment records...</div>
        </div>
      </td></tr>`;
    }

    try {
      const res = await fetch("/api/admin/payments", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("Failed to fetch payment list");

      const data = await res.json();
      cache = Array.isArray(data.payments) ? data.payments : [];
      cache.sort((a, b) => {
        const da = new Date(a.submittedAt || a.bookingCreatedAt || 0).getTime();
        const db = new Date(b.submittedAt || b.bookingCreatedAt || 0).getTime();
        return db - da;
      });
      const visible = applyClientFilters(cache);
      renderRows(visible);
      updateStats(visible);
    } catch (err) {
      console.warn("admin-payments: failed to load", err && err.message);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center py-5">
          <div style="color:#ef4444;">
            <i class="bi bi-exclamation-triangle" style="font-size:2rem;display:block;margin-bottom:12px;"></i>
            <div style="font-weight:600;margin-bottom:4px;">Failed to load payments</div>
            <div style="font-size:0.8rem;color:#94a3b8;">Please check your connection and try again</div>
            <button class="btn btn-sm btn-outline-primary mt-3" onclick="location.reload()">
              <i class="bi bi-arrow-clockwise me-1"></i>Retry
            </button>
          </div>
        </td></tr>`;
      }
    }
  }

  if (filterBtn) {
    filterBtn.addEventListener("click", function () {
      const visible = applyClientFilters(cache);
      renderRows(visible);
      updateStats(visible);
    });
  }

  [searchInput, statusFilter, methodFilter, gatewayFilter, gatewayStatusFilter, dateFilter]
    .filter(Boolean)
    .forEach((el) => {
      el.addEventListener("change", function () {
        const visible = applyClientFilters(cache);
        renderRows(visible);
        updateStats(visible);
      });
      if (el === searchInput) {
        el.addEventListener("input", function () {
          const visible = applyClientFilters(cache);
          renderRows(visible);
          updateStats(visible);
        });
      }
    });

  if (tbody) {
    tbody.addEventListener("click", function (event) {
      const viewBtn = event.target.closest(".js-view-details");
      if (viewBtn) {
        const paymentId = viewBtn.getAttribute("data-payment-id");
        openDetails(paymentId);
        return;
      }
    });
  }

  loadPayments();
});

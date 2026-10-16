document.addEventListener("DOMContentLoaded", function () {
  const page = document.querySelector(".payments-page");
  if (!page) return;
  const paymentsApiBase = (window.RACSPaymentsConfig && window.RACSPaymentsConfig.apiBase) || "/api/admin/payments";
  const paymentsCanManage = !window.RACSPaymentsConfig || window.RACSPaymentsConfig.canManage !== false;
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
  const fromDate = document.getElementById('paymentsFromDate');
  const toDate = document.getElementById('paymentsToDate');
  const manilaKey = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(value);
  const todayParts = manilaKey(new Date()).split('-').map(Number);
  if (fromDate) fromDate.value = urlParams.get('from') || manilaKey(new Date(Date.UTC(todayParts[0], todayParts[1] - 12, 1)));
  if (toDate) toDate.value = urlParams.get('to') || manilaKey(new Date());
  const filterBtn = document.getElementById("paymentsFilterBtn");

  const tbody = document.getElementById("paymentsTableBody");
  const statTotalTx = document.getElementById("statTotalTx");
  const statCollected = document.getElementById("statCollected");
  const statPending = document.getElementById("statPending");
  const statFailed = document.getElementById("statFailed");

  const detailsModalEl = document.getElementById("paymentDetailsModal");
  const detailsModal = detailsModalEl ? bootstrap.Modal.getOrCreateInstance(detailsModalEl) : null;

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
        const amount = formatCurrency(p.amount || 0);
        let status = p.status || "pending";
        const submittedAtRaw = p.activityAt || p.collectedAt || p.verifiedAt || p.completedAt || p.submittedAt || p.createdAt || p.bookingCreatedAt;
        const date = submittedAtRaw
          ? new Date(submittedAtRaw).toLocaleDateString("en-PH", { timeZone: 'Asia/Manila' })
          : "-";
        const time = submittedAtRaw
          ? new Date(submittedAtRaw).toLocaleTimeString("en-PH", { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' })
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
            <td class="payment-transaction-cell" title="ID: ${escapeHtml(transactionId)}\nRef: ${escapeHtml(reference)}">
              <div class="fw-bold text-dark text-truncate">${escapeHtml(transactionId)}</div>
              <div class="text-muted text-truncate text-micro">Reference: ${escapeHtml(reference)}</div>
            </td>
            <td class="payment-customer-cell" title="${escapeHtml(customerName)}\n${escapeHtml(customerEmail)}">
              <div class="fw-semibold text-truncate text-dark">${escapeHtml(customerName)}</div>
              <div class="text-muted text-truncate text-micro">${escapeHtml(customerEmail)}</div>
            </td>
            <td class="payment-booking-cell text-muted text-micro" title="Ref: ${escapeHtml(bookingReference)}\nBooked: ${escapeHtml(bookingCreatedText)}">
              <div class="fw-semibold text-dark">${escapeHtml(bookingReference)}</div>
              <div class="text-muted text-micro">Booking date: ${escapeHtml(bookingDateText)}</div>
              <div class="text-muted text-truncate text-micro">Booked: ${escapeHtml(bookingCreatedText)}</div>
              ${bookingBadge}
            </td>
            <td class="fw-bold text-dark text-end text-nowrap">${escapeHtml(amount)}</td>
            <td class="text-nowrap"><span class="badge bg-info-subtle text-info border border-info-subtle">${escapeHtml(method)}</span></td>
            <td><span class="badge ${badgeClassForStatus(status)}">${escapeHtml(String(status).toUpperCase())}</span></td>
            <td class="text-nowrap">${escapeHtml(date)}<div class="text-muted text-micro">${escapeHtml(time)}</div></td>
            <td class="text-end">
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
  let detailsRequestController = null;

  if (detailsModalEl) {
    detailsModalEl.addEventListener("hidden.bs.modal", function () {
      if (detailsRequestController) detailsRequestController.abort();
      detailsRequestController = null;
      window.AdminModalUX?.settle(detailsModalEl);
    });
  }

  async function changePaymentStatus(paymentId, newStatus) {
    if (!paymentId || !paymentsCanManage) return false;
    let body = { status: newStatus };
    // when failing, ask admin for reason and include it as notes
    if (newStatus === "failed") {
      const reason = prompt("Please enter reason for failing this payment (will be recorded and sent to the customer):");
      if (reason != null) {
        body.notes = reason.trim();
      }
    }
    try {
      await RACSRequest.json(`${paymentsApiBase}/${encodeURIComponent(paymentId)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      window.notify?.success("Payment status set to " + newStatus);
      // hide details modal if open
      if (detailsModal) detailsModal.hide();
      await loadPayments();
      return true;
    } catch (e) {
      console.warn("changePaymentStatus error", e && e.message);
      window.notify?.error(e.message || "Failed to update payment status");
      return false;
    }
  }

  function statusBadgeMarkup(status) {
    const s = String(status || "pending").toLowerCase();
    const labels = { payment_collected: 'COLLECTED BY TECHNICIAN', waiting_for_remittance: 'AWAITING REMITTANCE',
      remitted: 'REMITTED · AWAITING VERIFICATION', rejected: 'REMITTANCE REJECTED', unaccounted: 'UNACCOUNTED', refunded: 'REFUNDED' };
    if (labels[s]) return { text: labels[s], style: 'background:#fff7ed;color:#9a3412;border:1px solid #fed7aa;' };
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
    if (detailsRequestController) detailsRequestController.abort();
    const requestController = new AbortController();
    detailsRequestController = requestController;
    // Never leave the previous payment's receipt clickable during a new read.
    if (detailsProofLink) {
      detailsProofLink.onclick = null;
      detailsProofLink.classList.add("d-none");
    }
    if (detailsNoProof) detailsNoProof.classList.remove("d-none");
    // configure footer buttons based on booking/ payment status later
    const configureButtons = (paid, method, currentStatus) => {
      if (detailsVerifyBtn) {
        detailsVerifyBtn.textContent = "Mark Paid";
        detailsVerifyBtn.style.display = paid || !paymentsCanManage ? "none" : "inline-block";
        detailsVerifyBtn.onclick = () => changePaymentStatus(paymentId, "paid");
      }
      if (detailsFailBtn) {
        detailsFailBtn.style.display = paid || !paymentsCanManage ? "none" : "inline-block";
        detailsFailBtn.onclick = () => changePaymentStatus(paymentId, "failed");
      }
      if (detailsPartialBtn) {
        const isCash = method === "cod" || method === "cash";
        const alreadyPartial = String(currentStatus || "").toLowerCase() === "partial";
        detailsPartialBtn.style.display = paymentsCanManage && !paid && isCash && !alreadyPartial ? "inline-block" : "none";
        detailsPartialBtn.onclick = () => changePaymentStatus(paymentId, "partial");
      }
      if (detailsCompleteBtn) {
        detailsCompleteBtn.style.display = "none";
      }
    };
    // temporarily hide until we know current state
    configureButtons(true, null, null);
    if (window.AdminModalUX) {
      window.AdminModalUX.open(detailsModalEl, { loadingMessage: "Loading payment details…" });
    } else {
      detailsModal.show();
    }
    try {
      const res = await fetch(`${paymentsApiBase}/${encodeURIComponent(paymentId)}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: requestController.signal,
      });
      if (!res.ok) throw new Error("Failed to fetch payment details");
      const data = await res.json();
      if (requestController !== detailsRequestController) return;
      const payment = data && data.payment ? data.payment : null;
      if (!payment) throw new Error("Missing payment details");

      // display badge according to booking's payment status where available
      const badge = statusBadgeMarkup(payment.status);
      if (detailsBookingReference) detailsBookingReference.textContent = payment.bookingReference || "-";
      if (detailsBookingStatus) detailsBookingStatus.textContent = payment.bookingStatus || "-";
      
      const isOrder = !!payment.orderId;
      const modalTitleEl = detailsModalEl.querySelector(".modal-title");
      if (modalTitleEl) {
        modalTitleEl.textContent = isOrder ? "Order & Payment Details" : "Booking & Payment Details";
      }
      // update buttons now that we know if booking/payment is already paid
      const paidFlag = ['paid', 'verified', 'completed', 'refunded'].includes(String(payment.status || '').toLowerCase());
      configureButtons(paidFlag, payment.method, String(payment.status || "").toLowerCase());
      if (payment.collectedBy) configureButtons(true, payment.method, payment.status);
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
      if (detailsMethod) detailsMethod.textContent = normalizeMethod(payment.method);
      if (detailsGcashNumber) detailsGcashNumber.textContent = payment.gcashNumber || "-";
      if (detailsReference) detailsReference.textContent = payment.gcashReference || payment.reference || "-";
      if (detailsTravelFare) detailsTravelFare.textContent = formatCurrency(payment.travelFare || 0);
      if (detailsDownpayment) detailsDownpayment.textContent = formatCurrency(payment.amount || 0);
      if (detailsEstimatedFee) detailsEstimatedFee.textContent = formatCurrency(payment.estimatedFee || 0);
      if (detailsIssue) detailsIssue.textContent = payment.issueDescription || 'No appliance issue was recorded for this work.';
      if (detailsNotes) detailsNotes.textContent = payment.notes || "-";
      const setText = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value || '—'; };
      setText('detailsCollector', payment.collectedByName || (payment.collectedBy ? 'Technician (name unavailable)' : 'No technician collection recorded'));
      setText('detailsCollectedAt', payment.collectedAt ? new Date(payment.collectedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '');
      setText('detailsCollectionNotes', payment.collectionNotes);
      setText('detailsSpecialInstructions', payment.specialInstructions);

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

      window.AdminModalUX?.settle(detailsModalEl);
    } catch (err) {
      if (err?.name === "AbortError" || requestController !== detailsRequestController) return;
      console.warn("admin-payments: failed to load details", err && err.message);
      if (window.AdminModalUX) {
        window.AdminModalUX.fail(detailsModalEl, "Could not load payment details right now.");
      } else {
        window.notify?.error("Could not load payment details right now.");
      }
    } finally {
      if (detailsRequestController === requestController) detailsRequestController = null;
    }
  }

  let ledgerPage = 1, ledgerPages = 1, listController = null, debounceTimer;
  let paymentTrendChart = null, paymentMethodChart = null;
  const put = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = value; };
  function updateStats(summary) {
    const S = summary || {}, statuses = S.statuses || {}, total = Number(S.total || 0);
    const group = keys => keys.reduce((sum, key) => ({ count: sum.count + Number(statuses[key]?.count || 0), amount: sum.amount + Number(statuses[key]?.amount || 0) }), { count: 0, amount: 0 });
    const confirmed = group(['paid', 'verified', 'refunded']);
    const pending = group(['pending']);
    const held = group(['payment_collected', 'waiting_for_remittance', 'remitted', 'partial']);
    const failed = group(['failed', 'rejected', 'unaccounted']);
    put('statTotalTx', total.toLocaleString('en-PH'));
    put('statCollected', formatCurrency(S.grossCollections));
    put('statPending', pending.count);
    put('statFailed', failed.count);
    put('kpiTotalRevenue', formatCurrency(S.grossCollections));
    put('kpiMonthlyRevenue', formatCurrency(S.monthlyCollections));
    put('kpiCollectionRate', total ? (100 * S.collectedRecords / total).toFixed(1) : '0.0');
    put('kpiPendingAmount', formatCurrency(pending.amount));
    put('kpiSuccessRate', total ? (100 * confirmed.count / total).toFixed(1) : '0.0');
    put('kpiFailedCount', failed.count);
    put('kpiAvgTransaction', formatCurrency(S.collectedRecords ? S.grossCollections / S.collectedRecords : 0));
    put('kpiTotalTransactions', total);
    put('kpiPendingCount', pending.count); put('kpiPendingValue', formatCurrency(pending.amount));
    put('kpiPartialCount', held.count); put('kpiPartialValue', formatCurrency(held.amount));
    put('kpiFailedCountDetail', failed.count); put('kpiFailedValue', formatCurrency(failed.amount));
    put('kpiHighestTxn', formatCurrency(S.highest)); put('kpiLowestTxn', formatCurrency(S.lowest));
    put('paymentsRefundTotal', formatCurrency(S.refunds)); put('paymentsNetTotal', formatCurrency(S.netCollections));
    for (const [prefix, value] of [['paid', confirmed], ['pending', pending], ['partial', held], ['failed', failed]]) {
      const percent = total ? 100 * value.count / total : 0;
      put(prefix + 'Percent', percent.toFixed(1) + '%'); put(prefix + 'Count', value.count + ' records');
      const bar = document.getElementById(prefix + 'Bar'); if (bar) bar.style.width = percent + '%';
    }
    const trend = S.trend || [], values = trend.map(row => Number(row.amount || 0));
    const average = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    put('kpiAvgDailyRevenue', formatCurrency(average)); put('paymentAvg', formatCurrency(average));
    const peak = Math.max(0, ...values), peakIndex = values.indexOf(peak);
    put('paymentPeak', peak > 0 ? trend[peakIndex].date : 'No collections');
    const first = values.slice(0, 15).reduce((sum, value) => sum + value, 0), last = values.slice(15).reduce((sum, value) => sum + value, 0);
    put('paymentGrowth', first > 0 ? ((last - first) / first * 100).toFixed(1) + '%' : 'N/A');
    if (typeof Chart === 'undefined') return;
    const trendCanvas = document.getElementById('chartPaymentTrend');
    if (trendCanvas) {
      paymentTrendChart?.destroy();
      paymentTrendChart = new Chart(trendCanvas, { type: 'line', data: { labels: trend.map(row => row.date), datasets: [{ label: 'Payments received', data: values, borderColor: '#2563eb', tension: 0.3 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } } });
    }
    const methodCanvas = document.getElementById('chartPaymentMethod');
    if (methodCanvas) {
      paymentMethodChart?.destroy();
      const methods = Object.entries(S.methods || {});
      paymentMethodChart = new Chart(methodCanvas, { type: 'doughnut', data: { labels: methods.map(([method]) => normalizeMethod(method)), datasets: [{ label: 'Collected amount', data: methods.map(([, value]) => value), backgroundColor: ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6'] }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } } });
    }
  }
  async function loadPayments() {
    listController?.abort();
    const controller = new AbortController(); listController = controller;
    const query = new URLSearchParams({ view: 'ledger', page: String(ledgerPage), pageSize: '25' });
    for (const [key, element] of [['search', searchInput], ['status', statusFilter], ['method', methodFilter], ['gateway', gatewayFilter], ['gatewayStatus', gatewayStatusFilter], ['date', dateFilter]]) {
      const value = String(element?.value || '').trim(); if (value && value.toLowerCase() !== 'all') query.set(key, key === 'search' ? value : value.toLowerCase());
    }
    if (highlightedBookingId) query.set('bookingId', highlightedBookingId);
    if (highlightedOrderId) query.set('orderId', highlightedOrderId);
    if (fromDate?.value) query.set('from', fromDate.value);
    if (toDate?.value) query.set('to', toDate.value);
    if (tbody) tbody.setAttribute('aria-busy', 'true');
    try {
      const data = await RACSRequest.json(paymentsApiBase + '?' + query, { signal: controller.signal });
      if (listController !== controller) return;
      if (!Array.isArray(data.payments) || !data.summary || !data.pagination) throw Error('The payment ledger returned an incomplete response. Please refresh.');
      ledgerPages = data.pagination.totalPages;
      if (ledgerPage > ledgerPages) { ledgerPage = ledgerPages; return loadPayments(); }
      renderRows(data.payments); updateStats(data.summary);
      put('paymentsPaginationInfo', `Showing ${data.pagination.total ? (ledgerPage - 1) * data.pagination.pageSize + 1 : 0}–${Math.min(ledgerPage * data.pagination.pageSize, data.pagination.total)} of ${data.pagination.total} records`);
      put('paymentsPage', ledgerPage + ' / ' + ledgerPages);
      const periodLabel = data.period ? `${manilaKey(new Date(data.period.from))} – ${manilaKey(new Date(data.period.to))} · Philippine time. ` : '';
      put('paymentsLedgerBasis', periodLabel + data.basis);
      document.getElementById('paymentsPrevious').disabled = ledgerPage <= 1;
      document.getElementById('paymentsNext').disabled = ledgerPage >= ledgerPages;
    } catch (error) {
      if (error.name === 'AbortError' || listController !== controller) return;
      if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-danger" role="alert">${escapeHtml(error.message)} <button type="button" id="retryPaymentLedger" class="btn btn-sm btn-outline-primary">Retry</button></td></tr>`;
      put('paymentsLedgerBasis', 'The payment ledger could not refresh. Any totals still shown are from the previous successful request.');
    } finally { if (listController === controller) { listController = null; tbody?.removeAttribute('aria-busy'); } }
  }
  function resetFilters() { ledgerPage = 1; clearTimeout(debounceTimer); loadPayments(); }
  filterBtn?.addEventListener('click', resetFilters);
  searchInput?.addEventListener('input', () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(resetFilters, 300); });
  [statusFilter, methodFilter, gatewayFilter, gatewayStatusFilter, dateFilter, fromDate, toDate].filter(Boolean).forEach(node => node.addEventListener('change', resetFilters));
  document.getElementById('paymentsPrevious')?.addEventListener('click', () => { if (ledgerPage > 1) { ledgerPage--; loadPayments(); } });
  document.getElementById('paymentsNext')?.addEventListener('click', () => { if (ledgerPage < ledgerPages) { ledgerPage++; loadPayments(); } });
  tbody?.addEventListener('click', event => { if (event.target.closest('#retryPaymentLedger')) loadPayments(); });

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

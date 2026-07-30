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
      tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted py-4">No payment records found.</td></tr>';
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
    const collected = rows
      .filter((p) => ["paid","completed", "verified"].includes(String(p.status || "").toLowerCase()))
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const pending = rows.filter((p) => String(p.status || "").toLowerCase() === "pending").length;
    const failed = rows.filter((p) => String(p.status || "").toLowerCase() === "failed").length;

    if (statTotalTx) statTotalTx.textContent = total.toLocaleString("en-PH");
    if (statCollected) statCollected.textContent = formatCurrency(collected);
    if (statPending) statPending.textContent = pending.toLocaleString("en-PH");
    if (statFailed) statFailed.textContent = failed.toLocaleString("en-PH");
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
      tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted py-4">Loading payments...</td></tr>';
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
        tbody.innerHTML = '<tr><td colspan="10" class="text-center text-danger py-4">Failed to load payments.</td></tr>';
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

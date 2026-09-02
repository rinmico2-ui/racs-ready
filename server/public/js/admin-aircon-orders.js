document.addEventListener("DOMContentLoaded", function () {
  // ═══ CONSTANTS ═══════════════════════════════════════════════════════════════
  const STATUS_LABELS = {
    pending_payment: "Pending Payment", preparing_unit: "Preparing Unit",
    ready_for_pickup: "Ready for Pickup",
    technician_assigned: "Technician Assigned", technician_accepted: "Technician Accepted", out_for_delivery: "En Route",
    technician_declined: "Technician Declined", arrived: "Arrived", installing: "Installing", completed: "Completed", cancelled: "Cancelled"
  };
  const FULFILL_LABELS = { delivery_only: "Delivery Only", delivery_installation: "Delivery + Install", customer_pickup: "Customer Pickup" };
  const PAYMENT_METHOD_LABELS = { cod: "Cash on Delivery", cash_onsite: "Cash On-Site", gcash_full: "GCash Full", gcash_downpayment: "GCash Downpayment", cash: "Cash", downpayment: "Downpayment (50%)" };
  const LIMIT = 25;

  // ═══ HELPERS ═════════════════════════════════════════════════════════════════
  const esc = v => String(v == null ? "" : v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  const currency = v => "\u20B1" + Number(v||0).toLocaleString();
  const fmtDate = d => d ? new Date(d).toLocaleDateString("en-PH",{year:"numeric",month:"short",day:"numeric"}) : "-";
  const fmtDateShort = d => d ? new Date(d).toLocaleDateString("en-PH",{month:"short",day:"numeric"}) : "-";
  const toLocalDateStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const fmtTime = t => {
    if (!t) return "—";
    const parts = t.match(/(\d+)(?::(\d+))?\s*(AM|PM)/i);
    if (parts) return t;
    const h = parseInt(t);
    if (isNaN(h)) return t;
    return h >= 12 ? (h === 12 ? "12:00 PM" : (h - 12) + ":00 PM") : (h === 0 ? "12:00 AM" : h + ":00 AM");
  };
  const orderRef = o => o.orderReference || `#${o._id.toString().slice(-8).toUpperCase()}`;
  const orderStatusLabel = o => {
    if (o && o.status === "preparing_unit") {
      return o.fulfillmentType === "customer_pickup" ? "Preparing for Pickup" : "Awaiting Assignment";
    }
    return STATUS_LABELS[o && o.status] || niceStatus(o && o.status);
  };

  // ═══ SPARKLINE HELPERS ═══════════════════════════════════════════════════════
  function spark(ctx, data, color){
    if(!ctx || !window.Chart) return null;
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(function(_,i){ return i+1; }),
        datasets: [{ data: data, borderColor: color, backgroundColor: 'transparent', fill: false, tension: 0.35, pointRadius: 0, borderWidth: 2 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 600 },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } }
      }
    });
  }
  function randomData(n){
    var arr = [8 + Math.random()*12];
    for(var i=1; i<n; i++){ arr.push(Math.max(3, Math.min(30, arr[i-1] + (Math.random()-0.5)*12))); }
    return arr;
  }

  // ═══ STATE ════════════════════════════════════════════════════════════════════
  let currentPage = 1;
  let currentTab = "overview";
  const initialScope = new URLSearchParams(window.location.search).get("fulfillment") === "pickup" ? "pickup" : "delivery";
  let currentFulfillmentScope = initialScope;
  let assignQueueFilter = "all";
  let assignQueueOrders = [];
  let assignQueuePlan = [];
  let assignQueueRecommendations = {};
  let assignQueuePlanLoaded = false;

  // ═══ DOM REFS ════════════════════════════════════════════════════════════════
  const searchInput   = document.getElementById("aoSearch");
  const statusFilter  = document.getElementById("aoStatusFilter");
  const fulfillFilter = document.getElementById("aoFulfillFilter");
  const preparationFilter = document.getElementById("aoPreparationFilter");
  const scheduledFrom = document.getElementById("aoScheduledFrom");
  const scheduledTo = document.getElementById("aoScheduledTo");
  const filterBtn     = document.getElementById("aoFilterBtn");

  const modalEl = document.getElementById("aoDetailsModal");
  const modal = modalEl ? new bootstrap.Modal(modalEl) : null;
  const modalBody = document.getElementById("aoModalBody");
  const modalFooter = document.getElementById("aoModalFooter");
  const modalSubtitle = document.getElementById("aoModalSubtitle");

  const assignTechModalEl = document.getElementById("aoAssignTechModal");
  const assignTechModal = assignTechModalEl ? new bootstrap.Modal(assignTechModalEl) : null;
  let _aoAssignTargetOrderId = null;
  let _aoSelectedTechId = null;

  function scopedOrdersUrl(params) {
    const query = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
    query.set("fulfillmentGroup", currentFulfillmentScope);
    return "/api/orders/all?" + query.toString();
  }

  function workflowAllowed(tab) {
    return currentFulfillmentScope === "pickup"
      ? ["overview", "payment", "pickup", "completed"].includes(tab)
      : ["overview", "payment", "assign", "waiting", "active", "completed"].includes(tab);
  }

  function syncScopeSpecificFilters() {
    const pickup = currentFulfillmentScope === "pickup";
    const currentStatus = statusFilter.value;
    const deliveryStatuses = [
      ["all", "All Statuses"], ["pending_payment", "Pending Payment"], ["preparing_unit", "Preparation Queue"],
      ["technician_assigned", "Technician Assigned"], ["technician_accepted", "Technician Accepted"],
      ["out_for_delivery", "En Route"], ["arrived", "Arrived"], ["installing", "Installing"],
      ["completed", "Completed"], ["technician_declined", "Technician Declined"], ["cancelled", "Cancelled"],
    ];
    const pickupStatuses = [
      ["all", "All Pickup Statuses"], ["pending_payment", "Pending Payment"], ["preparing_unit", "Preparing for Pickup"],
      ["ready_for_pickup", "Ready for Pickup"], ["completed", "Picked Up"], ["cancelled", "Cancelled"],
    ];
    const statuses = pickup ? pickupStatuses : deliveryStatuses;
    statusFilter.innerHTML = statuses.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
    statusFilter.value = statuses.some(([value]) => value === currentStatus) ? currentStatus : "all";
    fulfillFilter.value = "all";
    fulfillFilter.style.display = pickup ? "none" : "block";
    if (preparationFilter) {
      preparationFilter.value = "all";
      preparationFilter.style.display = pickup ? "none" : "block";
    }
  }

  function updateScopeBadges(kpi) {
    const breakdown = kpi?.fulfillmentBreakdown || {};
    setText("aoScopeDeliveryBadge", Number(breakdown.delivery_installation || 0) + Number(breakdown.delivery_only || 0));
    setText("aoScopePickupBadge", Number(breakdown.customer_pickup || 0));
  }

  function setFulfillmentScope(scope, options = {}) {
    currentFulfillmentScope = scope === "pickup" ? "pickup" : "delivery";
    document.querySelectorAll("[data-order-scope]").forEach(button => {
      const active = button.dataset.orderScope === currentFulfillmentScope;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("[data-order-workflow-scope]").forEach(item => {
      const visibleFor = item.dataset.orderWorkflowScope;
      item.hidden = visibleFor !== "all" && visibleFor !== currentFulfillmentScope;
    });
    const context = document.getElementById("aoScopeContext");
    if (context) context.innerHTML = currentFulfillmentScope === "pickup"
      ? '<i class="bi bi-info-circle-fill" style="color:#7c3aed"></i><span>Showing customer pickup orders only. Technician assignment, dispatch, travel, and installation controls are intentionally excluded.</span>'
      : '<i class="bi bi-info-circle-fill text-primary"></i><span>Showing delivery and installation orders. Pickup-only actions are kept in the Pickup Orders workspace. Legacy delivery-only records remain available here.</span>';
    syncScopeSpecificFilters();

    const url = new URL(window.location.href);
    url.searchParams.set("fulfillment", currentFulfillmentScope);
    window.history.replaceState({}, "", url);
    if (options.load === false) return;
    if (!workflowAllowed(currentTab)) {
      const overviewButton = document.querySelector('[data-bs-target="#ao-tab-overview"]');
      bootstrap.Tab.getOrCreateInstance(overviewButton).show();
    } else {
      loadTab(currentTab);
    }
  }

  document.querySelectorAll("[data-order-scope]").forEach(button => {
    button.addEventListener("click", () => setFulfillmentScope(button.dataset.orderScope));
  });

  // ═══ TAB SWITCHING ═══════════════════════════════════════════════════════════
  document.querySelectorAll('.ao-tab-btn[data-bs-target]').forEach(btn => {
    btn.addEventListener('shown.bs.tab', function (e) {
      const target = e.target.getAttribute('data-bs-target');
      if (target.includes('overview'))       currentTab = "overview";
      else if (target.includes('payment'))   currentTab = "payment";
      else if (target.includes('assign'))    currentTab = "assign";
      else if (target.includes('pickup'))    currentTab = "pickup";
      else if (target.includes('waiting'))   currentTab = "waiting";
      else if (target.includes('active'))    currentTab = "active";
      else if (target.includes('completed')) currentTab = "completed";
      loadTab(currentTab);
    });
  });

  // ═══ LOAD TAB ════════════════════════════════════════════════════════════════
  function loadTab(tab) {
    switch(tab) {
      case "overview":   loadOverview(); break;
      case "payment":    loadPaymentTab(); break;
      case "assign":     loadAssignTab(); break;
      case "pickup":     loadPickupTab(); break;
      case "waiting":    loadWaitingAcceptTab(); break;
      case "active":     loadActiveTab(); break;
      case "completed":  loadCompletedTab(); break;
    }
  }

  async function loadOrderResolutionCount() {
    try {
      const response = await fetch('/api/admin/resolution-center?source=order&page=1&perPage=1');
      if (!response.ok) throw new Error('Resolution count unavailable');
      const data = await response.json();
      const count = Number(data?.summary?.bySource?.order) || 0;
      setText('aoResolutionCount', count);
      document.getElementById('aoResolutionCount')?.setAttribute('aria-label', `${count} order cases need resolution`);
    } catch (_) {
      setText('aoResolutionCount', 0);
    }
  }

  // ═══ RENDER STATS ════════════════════════════════════════════════════════════
  function renderStats(containerId, stats) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const overviewMode = containerId === "aoOverviewStats";
    const gradients = {
      blue: '#2563eb',
      amber: '#f59e0b',
      green: '#10b981',
      purple: '#8b5cf6',
      cyan: '#06b6d4',
      red: '#ef4444',
      rose: '#f43f5e'
    };
    const sparkColors = {
      blue: '#2563eb', amber: '#f59e0b', green: '#10b981',
      purple: '#8b5cf6', cyan: '#06b6d4', red: '#ef4444', rose: '#f43f5e'
    };
    container.innerHTML = stats.map(s => {
      const color = s.color || 'blue';
      const hex = sparkColors[color] || sparkColors.blue;
      const badge = s.percent || (s.label && s.label.split(' ')[0]) || '';
      const card = `
      <div class="stat-card ${overviewMode ? 'workflow-overview-kpi' : 'h-100'}" data-spark-color="${hex}">
        <div class="d-flex justify-content-between align-items-start mb-2">
          <div>
            <h6 class="text-muted mb-1" style="font-size:0.85rem;font-weight:500;">${s.label}</h6>
            <div class="d-flex align-items-baseline gap-2">
              <span class="h3 mb-0 fw-bold text-dark">${s.value}</span>
              <span class="kpi-trend up"><i class="bi bi-arrow-up"></i> 0%</span>
              <span class="kpi-percent-badge">${badge}</span>
            </div>
            <small class="text-muted">${s.sub || ''}</small>
          </div>
          <div class="stat-icon" style="background:${gradients[color] || gradients.blue};">
            <i class="bi ${s.icon} text-white"></i>
          </div>
        </div>
        <div class="stat-sparkline"><canvas height="40"></canvas></div>
      </div>`;
      return overviewMode ? `<div class="col-lg-3 col-md-6">${card}</div>` : card;
    }).join("");
    container.querySelectorAll('.stat-sparkline canvas').forEach(c => {
      const card = c.closest('.stat-card');
      const hex = card ? (card.dataset.sparkColor || '#2563eb') : '#2563eb';
      spark(c.getContext('2d'), randomData(10), hex);
    });
  }

  // ═══ RENDER ORDER CARD ═══════════════════════════════════════════════════════
  function orderCard(o, actions) {
    const ref = orderRef(o);
    const cust = (o.customer && o.customer.name) || "-";
    const items = (o.items||[]).map(it => `${esc(it.modelLine||"Aircon")} ${esc(it.capacity)}${esc(it.capacityUnit||"HP")}`).join(", ");
    const fulfill = FULFILL_LABELS[o.fulfillmentType] || o.fulfillmentType;
    const pStatus = (o.paymentStatus||"pending").toLowerCase();
    const pBadge = `ao-st-payment ${pStatus==="paid"?"paid":pStatus==="failed"?"failed":"pending"}`;
    const techName = o.technician && o.technician.name ? esc(o.technician.name) : null;
    const scheduledDate = o.fulfillmentType === 'customer_pickup'
      ? o.pickupDate
      : (o.delivery && o.delivery.preferredDate);
    const date = fmtDateShort(scheduledDate || o.createdAt);
    const time = fmtTime(o.timeSlot);
    const dispatchStatus = o.preparation?.dispatch?.status || (o.fulfillmentType === 'customer_pickup' ? 'not_required' : 'pending');
    const kitStatus = o.preparation?.installation?.status || (o.fulfillmentType === 'delivery_installation' ? 'pending' : 'not_required');
    const departureReady = dispatchStatus === 'ready' && (o.fulfillmentType !== 'delivery_installation' || kitStatus === 'confirmed' || kitStatus === 'completed');
    const prepBadge = o.fulfillmentType === 'customer_pickup' ? ''
      : departureReady
        ? '<span class="badge bg-success"><i class="bi bi-shield-check me-1"></i>Ready</span>'
        : kitStatus === 'blocked'
          ? '<span class="badge bg-danger"><i class="bi bi-exclamation-octagon me-1"></i>Kit Blocked</span>'
          : '<span class="badge bg-warning text-dark"><i class="bi bi-hourglass-split me-1"></i>Prep Pending</span>';

    return `<div class="ao-order-card workflow-record-card" data-order-id="${esc(o._id)}">
      <div class="ao-order-header workflow-record-head">
        <div>
          <div class="ao-order-ref workflow-record-ref">${esc(ref)}</div>
          <div class="ao-order-customer workflow-record-title">${esc(cust)}</div>
          <div class="ao-order-fulfill workflow-record-subtitle">${esc(fulfill)}</div>
        </div>
        <div class="text-end d-flex flex-column align-items-end gap-1">
          ${o.isPastDate
            ? '<span class="badge bg-danger"><i class="bi bi-exclamation-diamond me-1"></i>Needs Resolution</span>'
            : `<span class="ao-st-badge ao-st-${o.status}">${esc(orderStatusLabel(o))}</span>`}
          ${o.fulfillmentType === 'delivery_installation' ? '<span class="ao-st-fulfillment"><i class="bi bi-tools me-1"></i>w/ Install</span>' : ''}
          ${prepBadge}
        </div>
      </div>
      ${o.isPastDate ? `<div class="ao-overdue-alert"><i class="bi bi-exclamation-triangle-fill"></i><span><strong>Requested schedule passed.</strong> ${esc(o.attentionReason || 'Admin review is required before this order can continue.')}</span></div>` : ''}
      <div class="ao-detail-grid workflow-record-grid">
        <div class="ao-detail-item"><i class="bi bi-box-seam"></i> ${esc(items.substring(0,40))}${items.length>40?'...':''}</div>
        <div class="ao-detail-item"><i class="bi bi-calendar"></i> ${date}</div>
        ${time !== "—" ? `<div class="ao-detail-item"><i class="bi bi-clock"></i> ${time}</div>` : ''}
        <div class="ao-detail-item"><i class="bi bi-tag"></i> ${FULFILL_LABELS[o.fulfillmentType]||o.fulfillmentType}</div>
        <div class="ao-detail-item"><i class="bi bi-cash"></i> ${currency(o.total)}</div>
        <div class="ao-detail-item"><i class="bi bi-credit-card"></i> <span class="${pBadge}">${pStatus}</span></div>
        <div class="ao-detail-item"><i class="bi bi-person"></i> ${techName || '<span class="text-muted">Unassigned</span>'}</div>
        <div class="ao-detail-item"><i class="bi bi-boxes"></i> ${(o.items||[]).reduce((s,i)=>s+(i.quantity||1),0)} unit(s)</div>
      </div>
      <div class="ao-action-bar workflow-record-actions">${actions}</div>
    </div>`;
  }

  function viewBtn(id) {
    return `<button class="btn btn-sm btn-primary ao-action-btn" onclick="window._aoViewOrder('${esc(id)}')"><i class="bi bi-eye me-1"></i>View</button>`;
  }
  function verifyBtn(id) {
    return `<button class="btn btn-sm btn-success ao-action-btn" onclick="window._aoVerifyPayment('${esc(id)}')"><i class="bi bi-check2-circle me-1"></i>Verify</button>`;
  }
  function assignBtn(o) {
    const args = [
      String(o._id || ""),
      orderRef(o),
      (o.customer && o.customer.name) || "Customer",
      (o.delivery && o.delivery.preferredDate) || "",
      o.timeSlot || "",
    ].map(value => JSON.stringify(String(value))).join(",");
    return `<button class="btn btn-sm btn-primary ao-action-btn" onclick="${esc(`window._aoAssignTechnician(${args})`)}"><i class="bi bi-person-badge me-1"></i>Choose Technician</button>`;
  }
  function resolutionUrl(o) {
    const params = new URLSearchParams({
      source: 'order',
      q: orderRef(o),
      focus: `order:${String(o._id || '')}`,
      open: 'resolve',
    });
    if (o.attentionType) params.set('issue', o.attentionType);
    return `/admin/operations/resolution-center?${params.toString()}`;
  }
  function resolutionBtn(o) {
    return `<a class="btn btn-sm btn-warning ao-action-btn" href="${esc(resolutionUrl(o))}"><i class="bi bi-exclamation-diamond me-1"></i>Resolve Issue</a>`;
  }
  function paymentIsVerified(o) {
    return ["paid","partial","verified","remitted"].includes(String(o.paymentStatus||"").toLowerCase());
  }
  function canAssign(o) {
    const hasTech = o.technicianId || (o.technician && o.technician.name);
    return !hasTech && !o.isPastDate && o.fulfillmentType !== "customer_pickup" &&
      ["preparing_unit","technician_declined"].includes(o.status) && paymentIsVerified(o);
  }
  function assignmentTimestamp(o) {
    const history = Array.isArray(o.statusHistory) ? o.statusHistory : [];
    const entry = history.slice().reverse().find(item => item.status === "technician_assigned");
    return entry && entry.timestamp ? new Date(entry.timestamp) : null;
  }
  function markReadyBtn(id) {
    return `<button class="btn btn-sm btn-success ao-action-btn" onclick="window._aoMarkReadyForPickup('${esc(id)}')"><i class="bi bi-check2-circle me-1"></i>Mark Ready</button>`;
  }
  function confirmPickupBtn(id) {
    return `<button class="btn btn-sm btn-dark ao-action-btn" onclick="window._aoConfirmPickup('${esc(id)}')"><i class="bi bi-bag-check me-1"></i>Confirm Pickup</button>`;
  }
  function unitPreparedBtn(o) {
    const status = o.preparation?.dispatch?.status || "pending";
    if (o.fulfillmentType === "customer_pickup" || status === "ready" || ["out_for_delivery","arrived","installing","completed","cancelled"].includes(o.status)) return "";
    return `<button class="btn btn-sm btn-success ao-action-btn" onclick="window._aoMarkDispatchReady('${esc(o._id)}')"><i class="bi bi-box-seam me-1"></i>Confirm Unit Prepared</button>`;
  }

  // ═══ PAGINATION ══════════════════════════════════════════════════════════════
  function renderPagination(pag, goFn) {
    const el = document.getElementById("aoPagination");
    if (!pag || pag.pages <= 1) { el.innerHTML = ""; return; }
    let pg = '<ul class="pagination pagination-sm mb-0">';
    for (let i = 1; i <= pag.pages; i++) {
      pg += `<li class="page-item ${i === pag.page ? 'active' : ''}"><button class="page-link" onclick="${goFn}(${i})">${i}</button></li>`;
    }
    pg += '</ul>';
    el.innerHTML = pg;
  }

  function renderOrderPipeline(kpi) {
    const target = document.getElementById("aoPipeline");
    if (!target) return;
    const counts = kpi.statusBreakdown || {};
    const stages = currentFulfillmentScope === "pickup" ? [
      { label:"Payment", icon:"bi-credit-card", count:counts.pending_payment || 0, color:"#d97706", bg:"#fffbeb" },
      { label:"Preparing", icon:"bi-box-seam", count:counts.preparing_unit || 0, color:"#2563eb", bg:"#eff6ff" },
      { label:"Ready for Pickup", icon:"bi-bag-check", count:counts.ready_for_pickup || 0, color:"#7c3aed", bg:"#f5f3ff" },
      { label:"Picked Up", icon:"bi-check-circle", count:counts.completed || 0, color:"#059669", bg:"#ecfdf5" },
    ] : [
      { label:"Payment", icon:"bi-credit-card", count:counts.pending_payment || 0, color:"#d97706", bg:"#fffbeb" },
      { label:"Preparing", icon:"bi-box-seam", count:counts.preparing_unit || 0, color:"#2563eb", bg:"#eff6ff" },
      { label:"Assigned", icon:"bi-person-check", count:counts.technician_assigned || 0, color:"#7c3aed", bg:"#f5f3ff" },
      { label:"Accepted", icon:"bi-hand-thumbs-up", count:counts.technician_accepted || 0, color:"#0891b2", bg:"#ecfeff" },
      { label:"En Route", icon:"bi-truck", count:counts.out_for_delivery || 0, color:"#ea580c", bg:"#fff7ed" },
      { label:"On Site", icon:"bi-geo-alt", count:(counts.arrived || 0) + (counts.installing || 0), color:"#db2777", bg:"#fdf2f8" },
      { label:"Completed", icon:"bi-check-circle", count:counts.completed || 0, color:"#059669", bg:"#ecfdf5" },
    ];
    target.innerHTML = stages.map(stage => `<div class="workflow-pipeline-stage" style="--stage-color:${stage.color};--stage-bg:${stage.bg}"><span class="workflow-pipeline-icon"><i class="bi ${stage.icon}"></i></span><span class="workflow-pipeline-count">${Number(stage.count).toLocaleString()}</span><span class="workflow-pipeline-label">${stage.label}</span></div>`).join("");
  }

  function overviewPreparation(o) {
    if (o.fulfillmentType === "customer_pickup") return '<span class="text-muted">Store pickup</span>';
    const dispatch = o.preparation?.dispatch?.status || "pending";
    if (o.fulfillmentType !== "delivery_installation") return `<span class="text-muted">Unit preparation: ${dispatch === "ready" ? "Prepared" : "Pending"}</span>`;
    const kit = o.preparation?.installation?.status || "pending";
    const kitClass = kit === "confirmed" || kit === "completed" ? "text-success" : kit === "blocked" ? "text-danger" : "text-warning";
    return `<span class="text-muted">Unit preparation: ${dispatch === "ready" ? "Prepared" : "Pending"}</span><br><span class="${kitClass}"><i class="bi bi-tools me-1"></i>Daily Kit: ${esc(niceStatus(kit))}</span>`;
  }

  function niceStatus(value) {
    return String(value || "").replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  function overviewOrderRow(o) {
    const isPickup = o.fulfillmentType === "customer_pickup";
    const scheduledDate = isPickup ? o.pickupDate : o.delivery?.preferredDate;
    const products = (o.items || []).map(item => `${esc(item.modelLine || item.brand || "Aircon")} × ${Number(item.quantity) || 1}`).join(", ") || "—";
    const technician = o.technician?.name || o.technicianId?.name || "Unassigned";
    let actions = viewBtn(o._id);
    if (!o.isPastDate && o.status === "pending_payment" && o.paymentMethod !== "cash_onsite" && String(o.paymentStatus || "pending").toLowerCase() === "pending") actions += verifyBtn(o._id);
    if (canAssign(o)) actions += assignBtn(o);
    if (o.isPastDate) actions += resolutionBtn(o);
    if (!o.isPastDate && isPickup && o.status === "preparing_unit") actions += markReadyBtn(o._id);
    if (!o.isPastDate && isPickup && o.status === "ready_for_pickup") actions += confirmPickupBtn(o._id);
    return `<tr>
      <td><button class="btn btn-link p-0 text-decoration-none fw-bold workflow-record-ref" type="button" onclick="window._aoViewOrder('${esc(o._id)}')">${esc(orderRef(o))}</button><div class="small text-muted mt-1">${fmtDateShort(o.createdAt)}</div>${o.salesChannel === "walk_in" ? '<span class="badge bg-info-subtle text-info-emphasis border border-info-subtle mt-1"><i class="bi bi-shop me-1"></i>Walk-in POS</span>' : ''}</td>
      <td><strong>${esc(o.customer?.name || "Customer")}</strong><div class="small text-muted">${esc(o.customer?.phone || o.customer?.email || "")}</div></td>
      <td><div style="max-width:210px;white-space:normal;">${products}</div></td>
      <td><strong>${esc(FULFILL_LABELS[o.fulfillmentType] || niceStatus(o.fulfillmentType))}</strong><div class="small mt-1">${overviewPreparation(o)}</div></td>
      <td><span class="text-nowrap">${fmtDate(scheduledDate)}</span><div class="small text-muted">${fmtTime(o.timeSlot)}</div></td>
      <td class="fw-bold text-nowrap">${currency(o.total)}</td>
      <td>${o.isPastDate ? '<span class="badge bg-danger"><i class="bi bi-exclamation-diamond me-1"></i>Needs Resolution</span><div class="small text-danger fw-semibold mt-1">Past schedule</div>' : `<span class="ao-st-badge ao-st-${esc(o.status)}">${esc(orderStatusLabel(o))}</span>`}</td>
      <td>${technician === "Unassigned" ? '<span class="text-muted">Unassigned</span>' : `<strong>${esc(technician)}</strong>`}</td>
      <td><div class="d-flex flex-nowrap justify-content-center align-items-center gap-1">${actions}</div></td>
    </tr>`;
  }

  // ═══ OVERVIEW ════════════════════════════════════════════════════════════════
  async function loadOverview(pg) {
    currentPage = pg || 1;
    const params = new URLSearchParams({ page: currentPage, limit: LIMIT });
    if (searchInput.value.trim()) params.set("search", searchInput.value.trim());
    if (statusFilter.value !== "all") params.set("status", statusFilter.value);
    if (preparationFilter && preparationFilter.value !== "all") params.set("preparation", preparationFilter.value);
    if (scheduledFrom && scheduledFrom.value) params.set("scheduledFrom", scheduledFrom.value);
    if (scheduledTo && scheduledTo.value) params.set("scheduledTo", scheduledTo.value);

    const container = document.getElementById("aoOverviewContainer");
    container.innerHTML = '<tr><td colspan="9" class="text-center py-5 text-muted"><div class="spinner-border text-primary"></div><p class="mt-2 mb-0">Loading orders...</p></td></tr>';

    try {
      if (currentFulfillmentScope === "delivery" && fulfillFilter.value !== "all") params.set("fulfillmentType", fulfillFilter.value);
      const res = await fetch(scopedOrdersUrl(params));
      if (!res.ok) throw new Error("Fetch failed");
      const data = await res.json();
      const orders = data.orders || [];

      const kpi = data.kpi || {};
      updateScopeBadges(kpi);
      setText("heroTotal", kpi.totalOrders || 0);
      setText("heroPending", kpi.pending || 0);
      setText("heroActive", kpi.inProgress || 0);
      setText("heroCompleted", kpi.completed || 0);
      setText("aoTabTotalBadge", data.total || 0);
      loadOrderResolutionCount();
      renderOrderPipeline(kpi);

      renderStats("aoOverviewStats", currentFulfillmentScope === "pickup" ? [
        { icon: "bi-shop", color: "purple", value: kpi.totalOrders||0, label: "Pickup Orders", sub: "Customer pickup only", percent:"Pickup" },
        { icon: "bi-clock-history", color: "blue", value: kpi.pending||0, label: "Pending Payment", sub: "Awaiting verification", percent:"Pending" },
        { icon: "bi-bag-check", color: "amber", value:(kpi.statusBreakdown?.preparing_unit||0)+(kpi.statusBreakdown?.ready_for_pickup||0), label:"Pickup Queue", sub:"Preparing or awaiting customer", percent:"Queue" },
        { icon: "bi-check-circle", color: "green", value: kpi.completed||0, label: "Picked Up", sub: "Completed collections", percent:"Done" },
      ] : [
        { icon: "bi-truck-front", color: "amber", value: kpi.totalOrders||0, label: "Delivery Orders", sub: "Delivery and installation", percent:"Delivery" },
        { icon: "bi-clock-history", color: "blue", value: kpi.pending||0, label: "Pending Payment", sub: "Awaiting payment", percent:"Pending" },
        { icon: "bi-truck", color: "green", value: kpi.inProgress||0, label: "In Progress", sub: "Active field fulfillment", percent:"Active" },
        { icon: "bi-check-circle", color: "purple", value: kpi.completed||0, label: "Completed", sub: "Delivered orders", percent:"Completed" },
      ]);

      if (!orders.length) {
        container.innerHTML = '<tr><td colspan="9" class="text-center py-5 text-muted"><i class="bi bi-inbox d-block fs-2 mb-2"></i>No orders match the selected filters.</td></tr>';
        document.getElementById("aoPagination").innerHTML = "";
        setText("aoOverviewPagInfo", "Showing 0 of 0");
        return;
      }

      container.innerHTML = orders.map(overviewOrderRow).join("");
      const start = ((data.page || 1) - 1) * LIMIT + 1;
      const end = Math.min(data.total || 0, start + orders.length - 1);
      setText("aoOverviewPagInfo", `Showing ${start}–${end} of ${Number(data.total || 0).toLocaleString()}`);

      renderPagination(data, 'window._aoGoPage');
      window._aoGoPage = function(p) { loadOverview(p); };
    } catch(err) {
      container.innerHTML = '<tr><td colspan="9" class="text-center py-5 text-danger"><i class="bi bi-exclamation-triangle me-1"></i>Failed to load orders.</td></tr>';
      setText("aoOverviewPagInfo", "Unable to load orders");
    }
  }

  // ═══ NEEDS ATTENTION TAB ════════════════════════════════════════════════════
  // ═══ PENDING PAYMENT TAB ═════════════════════════════════════════════════════
  async function loadPaymentTab() {
    const container = document.getElementById("aoPaymentContainer");
    container.innerHTML = '<div class="text-center py-5 text-muted"><div class="spinner-border text-primary"></div><p class="mt-2">Loading payment queue...</p></div>';

    try {
      const res = await fetch(scopedOrdersUrl({ status: "pending_payment", limit: 100 }));
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const orders = data.orders || [];

      setText("aoTabPaymentBadge", orders.length);
      renderStats("aoPaymentStats", [
        { icon: "bi-hourglass-split", color: "amber", value: orders.filter(o => (o.paymentStatus||"pending") !== "failed").length, label: "Awaiting Payment", sub: "Pending verification" },
        { icon: "bi-x-circle", color: "red", value: orders.filter(o => (o.paymentStatus||"") === "failed").length, label: "Failed", sub: "Payment failures" },
        { icon: "bi-wallet2", color: "purple", value: orders.filter(o => (o.paymentMethod||"").includes("gcash") && (o.paymentStatus||"pending") !== "paid").length, label: "GCash Pending", sub: "GCash awaiting" },
      ]);

      if (!orders.length) {
        container.innerHTML = '<div class="ao-empty"><i class="bi bi-check-circle" style="color:#10b981;"></i><p>All payments verified</p></div>';
        return;
      }

      container.innerHTML = orders.map(o => {
        const method = PAYMENT_METHOD_LABELS[o.paymentMethod] || o.paymentMethod || "N/A";
        const pStatus = (o.paymentStatus||"pending").toLowerCase();
        const pBadge = `ao-st-payment ${pStatus==="paid"?"paid":pStatus==="failed"?"failed":"pending"}`;
        const isPickup = o.fulfillmentType === 'customer_pickup';

        let actions = viewBtn(o._id);
        if (o.isPastDate) {
          actions += resolutionBtn(o);
        } else if (pStatus === "pending") {
          actions += verifyBtn(o._id);
        }
        if (!o.isPastDate && isPickup && o.status === 'preparing_unit') {
          actions += markReadyBtn(o._id);
        }

        return orderCard(o, actions) +
          `<div style="margin-top:-10px;padding:0 20px 16px;border-bottom:1px solid #f1f5f9;"><span class="small text-muted"><i class="bi bi-credit-card me-1"></i>${esc(method)}</span> <span class="${pBadge} ms-2">${pStatus}</span></div>`;
      }).join("");
    } catch(err) {
      container.innerHTML = '<div class="alert alert-danger">Failed to load</div>';
    }
  }

  // ═══ READY TO ASSIGN TAB ═════════════════════════════════════════════════════
  function assignQueueMatchesFilter(o) {
    if (assignQueueFilter === "awaiting") return o.status === "preparing_unit";
    if (assignQueueFilter === "reassignment") return o.status === "technician_declined";
    if (assignQueueFilter === "installation") return o.fulfillmentType === "delivery_installation";
    if (assignQueueFilter === "delivery") return o.fulfillmentType === "delivery_only";
    return true;
  }

  function assignmentQueueCard(o) {
    const ref = orderRef(o);
    const customer = (o.customer && o.customer.name) || "Customer";
    const products = (o.items || []).map(item => {
      const model = item.modelLine || item.name || item.productName || "Aircon";
      const capacity = item.capacity ? ` ${item.capacity}${item.capacityUnit || "HP"}` : "";
      return `${model}${capacity}`;
    }).join(", ") || "Aircon order";
    const scheduledDate = o.delivery && o.delivery.preferredDate;
    const address = (o.delivery && (o.delivery.address || o.delivery.fullAddress)) || (o.customer && o.customer.address) || "No delivery address";
    const unitCount = (o.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 1), 0);
    const isReassignment = o.status === "technician_declined";
    const dispatchStatus = o.preparation && o.preparation.dispatch && o.preparation.dispatch.status || "pending";
    const kitStatus = o.preparation && o.preparation.installation && o.preparation.installation.status || "pending";
    const isInstallation = o.fulfillmentType === "delivery_installation";
    const dispatchReady = dispatchStatus === "ready";
    const kitReady = ["confirmed", "completed"].includes(kitStatus);
    const kitBlocked = kitStatus === "blocked";
    const statusBadge = isReassignment
      ? '<span class="badge bg-danger"><i class="bi bi-arrow-repeat me-1"></i>Needs Reassignment</span>'
      : '<span class="badge bg-warning text-dark"><i class="bi bi-hourglass-split me-1"></i>Awaiting Assignment</span>';
    const dispatchIcon = dispatchReady ? "ready" : "pending";
    const dispatchCopy = dispatchReady ? "Unit preparation confirmed" : "Admin confirmation still pending";
    const kitIcon = !isInstallation || kitReady ? "ready" : kitBlocked ? "blocked" : "pending";
    const kitTitle = isInstallation ? "Technician Daily Kit" : "Daily Kit";
    const kitCopy = !isInstallation
      ? "Not required for delivery-only orders"
      : kitReady
        ? "Technician kit confirmed"
        : kitBlocked
          ? "Blocked — resolve before departure"
          : "Technician confirms after accepting";

    return `<div class="ao-assign-card" data-order-id="${esc(o._id)}">
      <div class="ao-assign-head">
        <div>
          <div class="ao-assign-ref">${esc(ref)}</div>
          <div class="ao-assign-customer">${esc(customer)}</div>
          <div class="ao-assign-service">${esc(FULFILL_LABELS[o.fulfillmentType] || o.fulfillmentType)} &middot; ${esc(products)}</div>
        </div>
        <div class="text-end d-flex flex-column align-items-end gap-1">
          ${statusBadge}
          ${isInstallation ? '<span class="ao-st-fulfillment"><i class="bi bi-tools me-1"></i>Delivery + Install</span>' : '<span class="ao-st-fulfillment"><i class="bi bi-truck me-1"></i>Delivery Only</span>'}
        </div>
      </div>
      <div class="ao-assign-detail-grid">
        <div class="ao-assign-detail"><i class="bi bi-calendar"></i>${esc(fmtDate(scheduledDate))}</div>
        <div class="ao-assign-detail"><i class="bi bi-clock"></i>${esc(fmtTime(o.timeSlot))}</div>
        <div class="ao-assign-detail" title="${esc(address)}"><i class="bi bi-geo-alt"></i>${esc(address.length > 34 ? address.slice(0, 34) + "..." : address)}</div>
        <div class="ao-assign-detail"><i class="bi bi-cash"></i>${currency(o.total)}</div>
        <div class="ao-assign-detail"><i class="bi bi-boxes"></i>${unitCount} unit${unitCount === 1 ? "" : "s"}</div>
        <div class="ao-assign-detail"><i class="bi bi-credit-card"></i>${esc(String(o.paymentStatus || "pending").replace(/_/g, " "))}</div>
      </div>
      ${isReassignment ? '<div class="ao-assign-alert"><i class="bi bi-arrow-repeat"></i><span><strong>Previous assignment was declined.</strong> Select another eligible technician; the order schedule remains unchanged.</span></div>' : ''}
      <div class="ao-assign-readiness">
        <div class="ao-assign-ready-item">
          <div class="ao-assign-ready-icon ${dispatchIcon}"><i class="bi ${dispatchReady ? 'bi-check2-circle' : 'bi-box-seam'}"></i></div>
          <div><div class="ao-assign-ready-title">Unit Preparation</div><div class="ao-assign-ready-sub">${dispatchCopy}</div></div>
        </div>
        <div class="ao-assign-ready-item">
          <div class="ao-assign-ready-icon ${kitIcon}"><i class="bi ${kitIcon === 'ready' ? 'bi-check2-circle' : kitIcon === 'blocked' ? 'bi-exclamation-octagon' : 'bi-tools'}"></i></div>
          <div><div class="ao-assign-ready-title">${kitTitle}</div><div class="ao-assign-ready-sub">${kitCopy}</div></div>
        </div>
      </div>
      <div id="aoAssignRec-${esc(o._id)}" class="border rounded-3 p-3 mt-3" style="background:#f8fafc;">
        <div class="d-flex align-items-center gap-2 text-muted small"><span class="spinner-border spinner-border-sm"></span>Analyzing the best technician...</div>
      </div>
      <div class="ao-assign-actions">
        <button class="btn btn-sm btn-outline-secondary ao-action-btn" onclick="window._aoViewOrder('${esc(o._id)}')"><i class="bi bi-eye me-1"></i>View</button>
        ${unitPreparedBtn(o)}
        ${assignBtn(o)}
      </div>
    </div>`;
  }

  function renderAssignRecommendationsFromCache() {
    document.querySelectorAll('[id^="aoAssignRec-"]').forEach(element => {
      const orderId = element.id.slice("aoAssignRec-".length);
      const row = assignQueueRecommendations[orderId];
      if (!row) {
        if (!assignQueuePlanLoaded) return;
        element.innerHTML = '<div class="small text-muted"><i class="bi bi-info-circle me-1"></i>No recommendation is available for this order.</div>';
        return;
      }
      if (!row.recommended) {
        element.innerHTML = `<div class="small text-warning"><i class="bi bi-exclamation-triangle me-1"></i>${esc(row.issue || "No conflict-free technician is currently available.")}</div>`;
        return;
      }
      const recommended = row.recommended;
      const reasons = (recommended.reasons || []).slice(0, 4).map(reason => `<li>${esc(reason)}</li>`).join("");
      element.innerHTML = `<div class="d-flex justify-content-between gap-3 flex-wrap">
        <div>
          <div class="small text-uppercase text-muted fw-bold"><i class="bi bi-stars text-warning me-1"></i>Recommended Technician</div>
          <div class="fw-bold fs-6 mt-1">${esc(recommended.name)} <span class="badge bg-primary-subtle text-primary ms-1">Score ${esc(recommended.score)}</span></div>
          <ul class="small text-muted mb-0 mt-1 ps-3">${reasons}</ul>
        </div>
        <button class="btn btn-sm btn-primary fw-semibold align-self-center" type="button" onclick="window._aoAssignRecommended('${esc(orderId)}')"><i class="bi bi-check2-circle me-1"></i>Assign Recommended</button>
      </div>`;
    });
  }

  async function fetchOrderAssignmentPlan() {
    const response = await fetch('/api/orders/assignment-plan');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to build the assignment plan');
    assignQueuePlan = data.plan || [];
    assignQueueRecommendations = Object.fromEntries(assignQueuePlan.map(row => [String(row.orderId), row]));
    assignQueuePlanLoaded = true;
    return data;
  }

  async function loadAssignRecommendations() {
    try {
      await fetchOrderAssignmentPlan();
      renderAssignRecommendationsFromCache();
    } catch (error) {
      assignQueuePlanLoaded = true;
      document.querySelectorAll('[id^="aoAssignRec-"]').forEach(element => {
        element.innerHTML = '<div class="small text-danger"><i class="bi bi-exclamation-circle me-1"></i>Recommendation could not be loaded.</div>';
      });
    }
  }

  function assignmentPlanDate(row) {
    if (!row || !row.scheduledDate) return "";
    const date = new Date(row.scheduledDate);
    if (Number.isNaN(date.getTime())) return "";
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  async function submitReviewedOrderAssignment(row, technicianId) {
    const response = await fetch(`/api/orders/${encodeURIComponent(row.orderId)}/assign-technician`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        technicianId,
        scheduledDate: assignmentPlanDate(row),
        timeSlot: row.timeSlot || '',
        note: 'Assigned from an admin-reviewed order assignment plan.',
        assignmentSource: 'reviewed_plan',
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Assignment failed');
    return data;
  }

  window._aoAssignRecommended = async function(orderId) {
    const row = assignQueueRecommendations[String(orderId)];
    if (!row || !row.recommended) return;
    const recommended = row.recommended;
    const reasons = (recommended.reasons || []).slice(0, 4).map(reason => `• ${reason}`).join('\n');
    const confirmation = await Swal.fire({
      title: `Assign ${recommended.name}?`,
      text: reasons || 'This technician is the highest-ranked eligible candidate.',
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'Assign & Notify',
      cancelButtonText: 'Cancel',
      buttonsStyling: false,
      customClass: { confirmButton: 'btn btn-primary px-4 me-2', cancelButton: 'btn btn-light border px-4', popup: 'rounded-4' },
    });
    if (!confirmation.isConfirmed) return;
    try {
      await submitReviewedOrderAssignment(row, recommended.technicianId);
      await Swal.fire({ title: 'Technician Assigned', text: `${recommended.name} was notified.`, icon: 'success', timer: 1700, showConfirmButton: false, customClass: { popup: 'rounded-4' } });
      await loadAssignTab();
    } catch (error) {
      Swal.fire({ title: 'Assignment Failed', text: error.message, icon: 'error', customClass: { popup: 'rounded-4' } });
    }
  };

  function renderOrderBulkPlan() {
    const body = document.getElementById('aoBulkPlanBody');
    if (!assignQueuePlan.length) {
      body.innerHTML = '<div class="text-center text-muted py-5"><i class="bi bi-check-circle fs-1 text-success"></i><p class="mt-2">No unassigned delivery orders.</p></div>';
      document.getElementById('aoBulkPlanSummary').innerHTML = '';
      document.getElementById('aoConfirmBulkPlan').disabled = true;
      return;
    }
    body.innerHTML = `<div class="table-responsive"><table class="table align-middle">
      <thead><tr><th>Order</th><th>Schedule</th><th>Recommended Assignment</th><th>Why</th></tr></thead>
      <tbody>${assignQueuePlan.map((row, index) => {
        if (!row.candidates || !row.candidates.length) {
          return `<tr><td><strong>${esc(row.orderReference || row.orderId)}</strong><br><small>${esc(row.customerName)}</small></td><td>${fmtDate(row.scheduledDate)}<br><small>${esc(row.timeSlot || '—')}</small></td><td colspan="2"><span class="badge bg-warning text-dark">No eligible technician</span></td></tr>`;
        }
        const options = row.candidates.map((candidate, candidateIndex) => `<option value="${esc(candidate.technicianId)}" ${candidateIndex === 0 ? 'selected' : ''}>${esc(candidate.name)}${candidateIndex === 0 ? ' ★' : ''} — score ${esc(candidate.score)}</option>`).join("");
        const reasons = (row.recommended.reasons || []).slice(0, 3).map(reason => `<div><i class="bi bi-check2 text-success"></i> ${esc(reason)}</div>`).join("");
        return `<tr><td><strong>${esc(row.orderReference || row.orderId)}</strong><br><small>${esc(row.customerName)} · ${esc(FULFILL_LABELS[row.fulfillmentType] || row.fulfillmentType)}</small></td><td>${fmtDate(row.scheduledDate)}<br><small>${esc(row.timeSlot || '—')}</small></td><td><select class="form-select form-select-sm ao-bulk-tech-select" data-index="${index}">${options}</select></td><td class="small text-muted">${reasons}</td></tr>`;
      }).join("")}</tbody></table></div>`;
    body.querySelectorAll('.ao-bulk-tech-select').forEach(select => select.addEventListener('change', renderOrderBulkSummary));
    document.getElementById('aoConfirmBulkPlan').disabled = !body.querySelector('.ao-bulk-tech-select');
    renderOrderBulkSummary();
  }

  function renderOrderBulkSummary() {
    const groups = {};
    document.querySelectorAll('.ao-bulk-tech-select').forEach(select => {
      const row = assignQueuePlan[Number(select.dataset.index)];
      const candidate = (row.candidates || []).find(item => item.technicianId === select.value);
      if (!candidate) return;
      (groups[candidate.name] ||= []).push(row.orderReference || row.orderId);
    });
    document.getElementById('aoBulkPlanSummary').innerHTML = Object.entries(groups).map(([name, references]) => `<div class="col-md-4"><div class="border rounded-3 p-3 h-100"><div class="fw-bold"><i class="bi bi-person-check-fill text-primary me-1"></i>${esc(name)}</div><div class="small text-muted mt-1">${references.map(esc).join(' · ')}</div><span class="badge bg-primary-subtle text-primary mt-2">${references.length} order${references.length === 1 ? '' : 's'}</span></div></div>`).join("");
  }

  async function openOrderBulkPlan() {
    assignQueuePlan = [];
    document.getElementById('aoBulkPlanSummary').innerHTML = '';
    document.getElementById('aoBulkPlanBody').innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary"></div><p class="text-muted mt-2">Analyzing schedules, workload, conflicts and travel...</p></div>';
    document.getElementById('aoConfirmBulkPlan').disabled = true;
    new bootstrap.Modal(document.getElementById('aoBulkAssignmentModal')).show();
    try {
      await fetchOrderAssignmentPlan();
      renderOrderBulkPlan();
    } catch (error) {
      document.getElementById('aoBulkPlanBody').innerHTML = `<div class="alert alert-danger">${esc(error.message)}</div>`;
    }
  }

  async function confirmOrderBulkPlan() {
    const assignments = Array.from(document.querySelectorAll('.ao-bulk-tech-select')).map(select => ({
      row: assignQueuePlan[Number(select.dataset.index)],
      technicianId: select.value,
    })).filter(item => item.row && item.technicianId);
    if (!assignments.length) return;
    const button = document.getElementById('aoConfirmBulkPlan');
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Validating & assigning...';
    let assigned = 0;
    const failures = [];
    for (const assignment of assignments) {
      try {
        await submitReviewedOrderAssignment(assignment.row, assignment.technicianId);
        assigned += 1;
      } catch (error) {
        failures.push(`${assignment.row.orderReference || assignment.row.orderId}: ${error.message}`);
      }
    }
    bootstrap.Modal.getInstance(document.getElementById('aoBulkAssignmentModal'))?.hide();
    button.disabled = false;
    button.innerHTML = original;
    await Swal.fire({
      title: failures.length ? 'Assignment Plan Partially Processed' : 'Assignment Plan Completed',
      html: `<strong>${assigned}</strong> assigned${failures.length ? `<br><strong>${failures.length}</strong> need review` : ''}`,
      icon: failures.length ? 'warning' : 'success',
      customClass: { popup: 'rounded-4' },
    });
    await loadAssignTab();
  }

  function renderAssignQueue() {
    const container = document.getElementById("aoAssignContainer");
    if (!container) return;
    const term = String(document.getElementById("aoAssignSearchInput")?.value || "").trim().toLowerCase();
    const visible = assignQueueOrders.filter(o => {
      if (!assignQueueMatchesFilter(o)) return false;
      if (!term) return true;
      const haystack = [orderRef(o), o.customer && o.customer.name, o.customer && o.customer.email]
        .concat((o.items || []).map(item => item.modelLine || item.name || item.productName || ""))
        .join(" ").toLowerCase();
      return haystack.includes(term);
    });

    setText("aoAssignResultCount", `${visible.length} order${visible.length === 1 ? "" : "s"}`);
    if (!visible.length) {
      const hasQueue = assignQueueOrders.length > 0;
      container.innerHTML = `<div class="ao-empty"><i class="bi ${hasQueue ? 'bi-search' : 'bi-check-circle'}" style="color:${hasQueue ? '#94a3b8' : '#10b981'};"></i><p>${hasQueue ? 'No orders match the selected queue filters' : 'All eligible orders have technicians assigned'}</p></div>`;
      return;
    }
    container.innerHTML = visible.map(assignmentQueueCard).join("");
    renderAssignRecommendationsFromCache();
  }

  async function loadAssignTab() {
    const container = document.getElementById("aoAssignContainer");
    container.innerHTML = '<div class="text-center py-5 text-muted"><div class="spinner-border text-primary"></div><p class="mt-2">Loading assignable orders...</p></div>';

    try {
      const res = await fetch(scopedOrdersUrl({ limit: 100 }));
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      assignQueueOrders = (data.orders || []).filter(canAssign);
      assignQueueRecommendations = {};
      assignQueuePlanLoaded = false;
      const awaiting = assignQueueOrders.filter(o => o.status === "preparing_unit").length;
      const reassignment = assignQueueOrders.filter(o => o.status === "technician_declined").length;
      const installation = assignQueueOrders.filter(o => o.fulfillmentType === "delivery_installation").length;
      const delivery = assignQueueOrders.filter(o => o.fulfillmentType === "delivery_only").length;

      setText("aoTabAssignBadge", assignQueueOrders.length);
      setText("aoAssignPillAll", assignQueueOrders.length);
      setText("aoAssignPillAwaiting", awaiting);
      setText("aoAssignPillReassign", reassignment);
      setText("aoAssignPillInstall", installation);
      setText("aoAssignPillDelivery", delivery);
      renderStats("aoAssignStats", [
        { icon: "bi-hourglass-split", color: "amber", value: awaiting, label: "Awaiting Assignment", sub: "New technician selections" },
        { icon: "bi-arrow-repeat", color: "red", value: reassignment, label: "Need Reassignment", sub: "Previous technician declined" },
        { icon: "bi-tools", color: "purple", value: installation, label: "Delivery + Install", sub: "Daily kit after acceptance" },
        { icon: "bi-truck", color: "cyan", value: delivery, label: "Delivery Only", sub: "Installation kit not required" },
      ]);
      renderAssignQueue();
      loadAssignRecommendations();
    } catch(err) {
      assignQueueOrders = [];
      container.innerHTML = '<div class="alert alert-danger">Failed to load assignment queue. Please refresh and try again.</div>';
    }
  }

  // ═══ READY FOR PICKUP TAB ═══════════════════════════════════════════════════
  async function loadPickupTab() {
    const container = document.getElementById("aoPickupContainer");
    container.innerHTML = '<div class="text-center py-5 text-muted"><div class="spinner-border text-primary"></div><p class="mt-2">Loading pickup orders...</p></div>';

    try {
      const res = await fetch(scopedOrdersUrl({ limit: 100, fulfillmentType: "customer_pickup" }));
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const orders = (data.orders || []);
      const pendingPickup = orders.filter(o => o.status === "ready_for_pickup");
      const preparing = orders.filter(o => o.status === "preparing_unit");
      const completedPickup = orders.filter(o => o.status === "completed");

      setText("aoTabPickupBadge", pendingPickup.length);
      renderStats("aoPickupStats", [
        { icon: "bi-bag-check", color: "green", value: pendingPickup.length, label: "Ready for Pickup", sub: "Awaiting customer" },
        { icon: "bi-gear", color: "blue", value: preparing.length, label: "Preparing", sub: "Being prepared" },
        { icon: "bi-check-circle", color: "purple", value: completedPickup.length, label: "Picked Up", sub: "Completed pickups" },
      ]);

      const allRelevant = [...preparing, ...pendingPickup];
      if (!allRelevant.length) {
        container.innerHTML = '<div class="ao-empty"><i class="bi bi-check-circle" style="color:#10b981;"></i><p>No pickup orders to process</p></div>';
        return;
      }

      container.innerHTML = allRelevant.map(o => {
        let actions = viewBtn(o._id);
        if (o.isPastDate) actions += resolutionBtn(o);
        if (!o.isPastDate && o.status === "preparing_unit") {
          actions += markReadyBtn(o._id);
        } else if (!o.isPastDate && o.status === "ready_for_pickup") {
          actions += confirmPickupBtn(o._id);
        }
        return orderCard(o, actions);
      }).join("");
    } catch(err) {
      container.innerHTML = '<div class="alert alert-danger">Failed to load</div>';
    }
  }

  // ═══ WAITING FOR ACCEPTANCE TAB ═══════════════════════════════════════════════
  async function loadWaitingAcceptTab() {
    const container = document.getElementById("aoWaitingContainer");
    container.innerHTML = '<div class="text-center py-5 text-muted"><div class="spinner-border text-primary"></div><p class="mt-2">Loading...</p></div>';

    try {
      const res = await fetch(scopedOrdersUrl({ limit: 100 }));
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const orders = (data.orders || []).filter(o => o.status === "technician_assigned");

      setText("aoTabWaitingBadge", orders.length);
      renderStats("aoWaitingStats", [
        { icon: "bi-person-badge", color: "purple", value: orders.length, label: "Waiting for Acceptance", sub: "Tech pending" },
        { icon: "bi-clock-history", color: "amber", value: orders.filter(o => {
          const assignedAt = assignmentTimestamp(o);
          if (!assignedAt) return false;
          const hours = (Date.now() - assignedAt.getTime()) / 3600000;
          return hours > 2;
        }).length, label: "Overdue (>2 hrs)" },
      ]);

      if (!orders.length) {
        container.innerHTML = '<div class="ao-empty"><i class="bi bi-check-circle"></i><p>No orders waiting for technician acceptance</p></div>';
        return;
      }

      container.innerHTML = orders.map(o => {
        const assignmentDate = assignmentTimestamp(o);
        const assignedAt = assignmentDate ? assignmentDate.toLocaleString() : '—';
        const isAcceptanceOverdue = assignmentDate && (Date.now() - assignmentDate.getTime()) > 2 * 3600000;
        const techName = o.technician?.name || 'Unknown';
        return orderCard(o, `
          <button class="btn btn-sm btn-primary ao-action-btn" onclick="window._aoViewOrder('${esc(o._id)}')"><i class="bi bi-eye me-1"></i>View</button>
          ${unitPreparedBtn(o)}
          ${isAcceptanceOverdue ? `<button class="btn btn-sm btn-warning ao-action-btn" onclick="window._aoRequeueAssignment('${esc(o._id)}','${esc(orderRef(o))}')"><i class="bi bi-arrow-repeat me-1"></i>Requeue</button>` : ''}
          <span class="small text-muted ms-2">Assigned to ${esc(techName)} at ${assignedAt}</span>
        `);
      }).join("");
    } catch(err) {
      container.innerHTML = '<div class="alert alert-danger">Failed to load</div>';
    }
  }

  // ═══ IN PROGRESS TAB ═════════════════════════════════════════════════════════
  async function loadActiveTab() {
    const container = document.getElementById("aoActiveContainer");
    container.innerHTML = '<div class="text-center py-5 text-muted"><div class="spinner-border text-primary"></div><p class="mt-2">Loading active orders...</p></div>';

    try {
      const activeStatuses = ["technician_accepted","out_for_delivery","arrived","installing"];
      const res = await fetch(scopedOrdersUrl({ limit: 100 }));
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const orders = (data.orders || []).filter(o => activeStatuses.includes(o.status));

      setText("aoTabActiveBadge", orders.length);
      renderStats("aoActiveStats", [
        { icon: "bi-person-check", color: "purple", value: orders.filter(o=>o.status==="technician_accepted").length, label: "Accepted", sub: "Technician confirmed" },
        { icon: "bi-truck", color: "amber", value: orders.filter(o=>o.status==="out_for_delivery").length, label: "En Route", sub: "Heading to customer" },
        { icon: "bi-geo-alt", color: "cyan", value: orders.filter(o=>o.status==="arrived").length, label: "Arrived", sub: "On site" },
        { icon: "bi-tools", color: "rose", value: orders.filter(o=>o.status==="installing").length, label: "Installing" },
      ]);

      if (!orders.length) {
        container.innerHTML = '<div class="ao-empty"><i class="bi bi-inbox"></i><p>No active orders</p></div>';
        return;
      }

      container.innerHTML = orders.map(o => orderCard(o, viewBtn(o._id) + (o.status === "technician_accepted" ? unitPreparedBtn(o) : ""))).join("");
    } catch(err) {
      container.innerHTML = '<div class="alert alert-danger">Failed to load</div>';
    }
  }

  // ═══ COMPLETED TAB ═══════════════════════════════════════════════════════════
  async function loadCompletedTab() {
    const container = document.getElementById("aoCompletedContainer");
    container.innerHTML = '<div class="text-center py-5 text-muted"><div class="spinner-border text-primary"></div><p class="mt-2">Loading completed orders...</p></div>';

    try {
      const res = await fetch(scopedOrdersUrl({ limit: 100 }));
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const orders = (data.orders || []).filter(o => o.status === "completed" || o.status === "cancelled");
      const completed = orders.filter(o => o.status === "completed");
      const revenue = completed.reduce((s,o) => s + (o.total || 0), 0);

      setText("aoTabDoneBadge", orders.length);
      renderStats("aoCompletedStats", [
        { icon: currentFulfillmentScope === "pickup" ? "bi-bag-check" : "bi-check-circle", color: "green", value: completed.length, label: currentFulfillmentScope === "pickup" ? "Picked Up" : "Completed", sub: currentFulfillmentScope === "pickup" ? "Customer collections completed" : "Finished delivery orders" },
        { icon: "bi-x-circle", color: "red", value: orders.filter(o=>o.status==="cancelled").length, label: "Cancelled", sub: "Voided orders" },
        { icon: "bi-cash-stack", color: "blue", value: currency(revenue), label: "Revenue", sub: currentFulfillmentScope === "pickup" ? "Collected pickup revenue" : "Delivery revenue" },
      ]);

      if (!orders.length) {
        container.innerHTML = `<div class="ao-empty"><i class="bi bi-inbox"></i><p>${currentFulfillmentScope === "pickup" ? "No completed pickups yet" : "No completed delivery orders yet"}</p></div>`;
        return;
      }

      container.innerHTML = orders.map(o => orderCard(o, viewBtn(o._id))).join("");
    } catch(err) {
      container.innerHTML = '<div class="alert alert-danger">Failed to load</div>';
    }
  }

  // ═══ VIEW ORDER DETAILS ══════════════════════════════════════════════════════
  window._aoViewOrder = async function (id) {
    if (!modal) return;
    modalBody.innerHTML = '<div class="text-center py-4"><div class="spinner-border text-primary"></div><p class="mt-2 text-muted">Loading order details...</p></div>';
    modalSubtitle.textContent = "Loading...";
    modalFooter.innerHTML = '';
    modalFooter.style.display = 'none';
    modal.show();

    try {
      const res = await fetch("/api/orders/" + encodeURIComponent(id));
      if (!res.ok) throw new Error("Not found");
      const data = await res.json();
      const o = data.order;
      if (!o) { modalBody.innerHTML = '<p class="text-center text-danger">Order not found</p>'; return; }

      const refText = o.orderReference || `#${o._id.toString().slice(-8).toUpperCase()}`;
      modalSubtitle.textContent = o.isPastDate ? `${refText} · Past schedule · Needs resolution` : refText;

      const pStatus = (o.paymentStatus||"pending").toLowerCase();
      const pBadgeClass = pStatus==="paid"?"bg-success":pStatus==="failed"?"bg-danger":"bg-warning text-dark";
      const dispatchPrep = o.preparation?.dispatch || { status: o.fulfillmentType === 'customer_pickup' ? 'not_required' : 'pending' };
      const installPrep = o.preparation?.installation || { status: o.fulfillmentType === 'delivery_installation' ? 'pending' : 'not_required', blockers: [] };
      const prepBadgeClass = value => ['ready','confirmed','completed'].includes(value) ? 'bg-success' : value === 'blocked' ? 'bg-danger' : value === 'not_required' ? 'bg-secondary' : 'bg-warning text-dark';

      let html = `
        <div class="pm-status-bar">
          <span class="badge ${pStatus==='paid'?'bg-success':pStatus==='failed'?'bg-danger':'bg-warning text-dark'}" style="font-size:.75rem;">Payment: ${pStatus.toUpperCase()}</span>
          ${o.isPastDate
            ? '<span class="badge bg-danger" style="font-size:.75rem;"><i class="bi bi-exclamation-diamond me-1"></i>Past Schedule &middot; Needs Resolution</span>'
            : `<span class="ao-st-badge ao-st-${o.status}">${esc(orderStatusLabel(o))}</span>`}
          <span class="ao-st-fulfillment">${esc(FULFILL_LABELS[o.fulfillmentType]||o.fulfillmentType)}</span>
        </div>
        ${o.isPastDate ? `<div class="ao-overdue-alert" style="margin:0 0 14px;"><i class="bi bi-exclamation-triangle-fill"></i><span><strong>Requested schedule passed.</strong> Normal payment, preparation, pickup, and assignment actions are paused. Review the case and record the approved outcome in the Resolution Center.</span></div>` : ''}

        <div class="pm-grid">
          <div class="pm-card">
            <div class="pm-card-head"><div class="pm-icon" style="background:#dbeafe;color:#2563eb;"><i class="bi bi-person"></i></div><h3 class="pm-card-title">Customer</h3></div>
            <div class="pm-card-body">
              <div class="pm-row"><span class="pm-lbl">Name</span><span class="pm-val">${esc((o.customer&&o.customer.name)||"-")}</span></div>
              <div class="pm-row"><span class="pm-lbl">Email</span><span class="pm-val">${esc((o.customer&&o.customer.email)||"—")}</span></div>
              <div class="pm-row"><span class="pm-lbl">Phone</span><span class="pm-val">${esc((o.customer&&o.customer.phone)||"—")}</span></div>
              ${o.customerAccount ? `<div class="pm-row"><span class="pm-lbl">Online Account</span><span class="pm-val"><span class="badge ${o.customerAccount.state === 'active' ? 'bg-success' : 'bg-warning text-dark'}">${esc(String(o.customerAccount.state).replace(/_/g,' ').toUpperCase())}</span></span></div>` : ''}
              ${o.customerAccount?.invitationLastSentAt ? `<div class="pm-row"><span class="pm-lbl">Activation sent</span><span class="pm-val">${new Date(o.customerAccount.invitationLastSentAt).toLocaleString('en-PH')}</span></div>` : ''}
            </div>
          </div>

          <div class="pm-card">
            <div class="pm-card-head"><div class="pm-icon" style="background:#dcfce7;color:#16a34a;"><i class="bi bi-box-seam"></i></div><h3 class="pm-card-title">Order Items</h3></div>
            <div class="pm-card-body">
              ${(o.items||[]).map(it => `
                <div class="pm-row">
                  <span class="pm-lbl">${esc(it.modelLine||"Aircon")} ${esc(it.capacity)}${esc(it.capacityUnit||"HP")} × ${it.quantity||1}</span>
                  <span class="pm-val">${currency(it.totalPrice)}</span>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="pm-card">
            <div class="pm-card-head"><div class="pm-icon" style="background:#fef3c7;color:#d97706;"><i class="bi bi-calendar-event"></i></div><h3 class="pm-card-title">Schedule</h3></div>
            <div class="pm-card-body">
              <div class="pm-row"><span class="pm-lbl">Order Date</span><span class="pm-val">${fmtDate(o.createdAt)}</span></div>
              <div class="pm-row"><span class="pm-lbl">Sales Channel</span><span class="pm-val">${o.salesChannel === 'walk_in' ? '<span class="badge bg-info-subtle text-info-emphasis border border-info-subtle"><i class="bi bi-shop me-1"></i>Walk-in POS</span>' : esc(niceStatus(o.salesChannel || 'online'))}</span></div>
              ${o.pickupDate?`<div class="pm-row"><span class="pm-lbl">Pickup Date</span><span class="pm-val">${fmtDate(o.pickupDate)}</span></div>`:''}
              ${o.delivery&&o.delivery.preferredDate?`<div class="pm-row"><span class="pm-lbl">Preferred Date</span><span class="pm-val">${fmtDate(o.delivery.preferredDate)}</span></div>`:''}
              ${o.timeSlot?`<div class="pm-row"><span class="pm-lbl">Time Slot</span><span class="pm-val">${fmtTime(o.timeSlot)}</span></div>`:''}
              ${o.delivery&&o.delivery.notes?`<div class="pm-row"><span class="pm-lbl">Notes</span><span class="pm-val" style="font-weight:400;">${esc(o.delivery.notes)}</span></div>`:''}
            </div>
          </div>

          <div class="pm-card">
            <div class="pm-card-head"><div class="pm-icon" style="background:#f3e8ff;color:#9333ea;"><i class="bi bi-cash-stack"></i></div><h3 class="pm-card-title">Pricing</h3></div>
            <div class="pm-card-body">
              <div class="pm-row"><span class="pm-lbl">Subtotal</span><span class="pm-val">${currency(o.subtotal)}</span></div>
              ${Number(o.discount)>0?`<div class="pm-row"><span class="pm-lbl">Discount</span><span class="pm-val text-danger">-${currency(o.discount)}</span></div>`:''}
              ${o.deliveryFee?`<div class="pm-row"><span class="pm-lbl">Delivery Fee</span><span class="pm-val">${currency(o.deliveryFee)}</span></div>`:''}
              ${o.installationFee?`<div class="pm-row"><span class="pm-lbl">Installation Fee</span><span class="pm-val">${currency(o.installationFee)}</span></div>`:''}
              ${o.transportationFee?`<div class="pm-row"><span class="pm-lbl">Transportation</span><span class="pm-val">${currency(o.transportationFee)}</span></div>`:''}
              <div class="pm-row" style="border-top:2px solid #e2e8f0;padding-top:10px;margin-top:4px;"><span class="pm-lbl">Total</span><span class="pm-val" style="font-size:1.1rem;color:#16a34a;">${currency(o.total)}</span></div>
            </div>
          </div>

          <div class="pm-card">
            <div class="pm-card-head"><div class="pm-icon" style="background:#fee2e2;color:#dc2626;"><i class="bi bi-credit-card"></i></div><h3 class="pm-card-title">Payment</h3></div>
            <div class="pm-card-body">
              <div class="pm-row"><span class="pm-lbl">Method</span><span class="pm-val">${PAYMENT_METHOD_LABELS[o.paymentMethod]||o.paymentMethod||'N/A'}</span></div>
              <div class="pm-row"><span class="pm-lbl">Status</span><span class="pm-val"><span class="badge ${pBadgeClass}">${(o.paymentStatus||'Pending').toUpperCase()}</span></span></div>
              ${o.downpaymentAmount>0?`<div class="pm-row"><span class="pm-lbl">Downpayment (${Number(o.downpaymentPercentage||10)}%)</span><span class="pm-val">${currency(o.downpaymentAmount)}</span></div>`:''}
              ${o.balanceAmount>0?`<div class="pm-row"><span class="pm-lbl">Remaining Balance</span><span class="pm-val">${currency(o.balanceAmount)}</span></div>`:''}
              ${o.gcashNumber?`<div class="pm-row"><span class="pm-lbl">GCash Number</span><span class="pm-val">${esc(o.gcashNumber)}</span></div>`:''}
              ${o.gcashProofUrl?`<div class="pm-row"><span class="pm-lbl">Receipt</span><span class="pm-val"><button type="button" class="btn btn-sm btn-outline-primary" onclick="window.openAoImage('${esc(o.gcashProofUrl).replace(/'/g, "\\'")}')"><i class="bi bi-image me-1"></i>View Receipt</button></span></div>`:''}
            </div>
          </div>

          <div class="pm-card">
            <div class="pm-card-head"><div class="pm-icon" style="background:#e2e8f0;color:#475569;"><i class="bi bi-geo-alt"></i></div><h3 class="pm-card-title">Delivery</h3></div>
            <div class="pm-card-body">
              ${o.delivery && o.delivery.address ? `<div class="pm-row"><span class="pm-lbl">Address</span><span class="pm-val" style="font-weight:400;">${esc(o.delivery.address)}</span></div>` : '<div class="pm-row"><span class="pm-val">Customer Pickup</span></div>'}
              ${o.delivery&&o.delivery.contactNumber?`<div class="pm-row"><span class="pm-lbl">Contact</span><span class="pm-val">${esc(o.delivery.contactNumber)}</span></div>`:''}
            </div>
          </div>

          ${o.fulfillmentType !== 'customer_pickup' ? `
          <div class="pm-card">
            <div class="pm-card-head"><div class="pm-icon" style="background:#ecfeff;color:#0e7490;"><i class="bi bi-clipboard2-check"></i></div><h3 class="pm-card-title">Unit Preparation</h3></div>
            <div class="pm-card-body">
              <div class="pm-row"><span class="pm-lbl">Ordered Unit</span><span class="pm-val"><span class="badge ${prepBadgeClass(dispatchPrep.status)}">${dispatchPrep.status === 'ready' ? 'PREPARED' : 'PENDING'}</span></span></div>
              ${o.fulfillmentType === 'delivery_installation' ? `<div class="pm-row"><span class="pm-lbl">Installation Daily Kit</span><span class="pm-val"><span class="badge ${prepBadgeClass(installPrep.status)}">${esc(String(installPrep.status||'pending').replace(/_/g,' ').toUpperCase())}</span></span></div><div class="pm-row"><span class="pm-lbl">Required Items</span><span class="pm-val">${(installPrep.requiredItems||[]).length}</span></div>` : ''}
              ${(installPrep.blockers||[]).length ? `<div class="alert alert-warning small py-2 mt-2 mb-0">${installPrep.blockers.map(esc).join('<br>')}</div>` : ''}
            </div>
          </div>` : ''}

          ${o.arrivalProofUrl || o.startProofUrl || o.proofPhoto ? `
          <div class="pm-card">
            <div class="pm-card-head"><div class="pm-icon" style="background:#f0fdf4;color:#15803d;"><i class="bi bi-camera"></i></div><h3 class="pm-card-title">Field Evidence</h3></div>
            <div class="pm-card-body d-flex flex-wrap gap-2">
              ${o.arrivalProofUrl?`<button class="btn btn-sm btn-outline-primary" onclick="window.openAoImage('${esc(o.arrivalProofUrl).replace(/'/g,"\\'")}')"><i class="bi bi-geo-alt me-1"></i>Arrival</button>`:''}
              ${o.startProofUrl?`<button class="btn btn-sm btn-outline-primary" onclick="window.openAoImage('${esc(o.startProofUrl).replace(/'/g,"\\'")}')"><i class="bi bi-play-circle me-1"></i>Start Work</button>`:''}
              ${o.proofPhoto?`<button class="btn btn-sm btn-outline-success" onclick="window.openAoImage('${esc(o.proofPhoto).replace(/'/g,"\\'")}')"><i class="bi bi-check-circle me-1"></i>Completion</button>`:''}
            </div>
          </div>` : ''}

          ${o.technician && o.technician.name ? `
          <div class="pm-card">
            <div class="pm-card-head"><div class="pm-icon" style="background:#dbeafe;color:#2563eb;"><i class="bi bi-person-badge"></i></div><h3 class="pm-card-title">Technician</h3></div>
            <div class="pm-card-body">
              <div class="pm-row"><span class="pm-lbl">Name</span><span class="pm-val">${esc(o.technician.name)}</span></div>
              ${o.technician.phone?`<div class="pm-row"><span class="pm-lbl">Phone</span><span class="pm-val">${esc(o.technician.phone)}</span></div>`:''}
              ${o.technician.email?`<div class="pm-row"><span class="pm-lbl">Email</span><span class="pm-val">${esc(o.technician.email)}</span></div>`:''}
            </div>
          </div>` : ''}
        </div>`;

      if (o.statusHistory && o.statusHistory.length) {
        html += '<h6 class="fw-bold text-uppercase small text-muted mt-4 mb-2" style="letter-spacing:0.5px;"><i class="bi bi-clock-history me-1"></i>Status Timeline</h6>';
        html += '<div style="position:relative;padding-left:1.5rem;"><div style="position:absolute;left:6px;top:0;bottom:0;width:2px;background:#e2e8f0;"></div>';
        o.statusHistory.slice().reverse().forEach((h,i) => {
          const dot = i===0 ? "background:#2563eb;border-color:#2563eb;box-shadow:0 0 8px rgba(37,99,235,0.3);" : "background:#22c55e;border-color:#22c55e;";
          html += `<div style="position:relative;padding-bottom:0.75rem;padding-left:1rem;">
            <div style="position:absolute;left:-1.5rem;top:2px;width:14px;height:14px;border-radius:50%;border:2px solid #e2e8f0;background:#fff;${dot}"></div>
            <div class="fw-semibold small">${esc(orderStatusLabel({ status: h.status, fulfillmentType: o.fulfillmentType }))}</div>
            <div style="font-size:0.72rem;color:#94a3b8;">${new Date(h.timestamp).toLocaleString("en-PH")}</div>
            ${h.note?'<div style="font-size:0.75rem;color:#64748b;">'+esc(h.note)+'</div>':''}
          </div>`;
        });
        html += '</div>';
      }

      modalBody.innerHTML = html;

      let footerBtns = '';
      const isPickup = o.fulfillmentType === 'customer_pickup';
      if (o.isPastDate) {
        footerBtns += `<a class="btn btn-sm btn-warning fw-bold" href="${esc(resolutionUrl(o))}" style="border-radius:8px;"><i class="bi bi-exclamation-diamond me-1"></i>Open Resolution Center</a>`;
        footerBtns += '<button type="button" class="btn btn-sm btn-light" data-bs-dismiss="modal">Close</button>';
      } else if (o.status === "pending_payment" && o.paymentMethod !== "cash_onsite" && (o.paymentStatus||"pending") === "pending") {
        footerBtns += `<button type="button" class="btn btn-sm btn-success fw-bold" onclick="window._aoVerifyPayment('${esc(o._id)}')" style="border-radius:8px;"><i class="bi bi-check2-circle me-1"></i>Verify Payment</button>`;
      }
      if (!o.isPastDate && isPickup && o.status === "preparing_unit") {
        footerBtns += `<button type="button" class="btn btn-sm btn-success fw-bold" onclick="window._aoMarkReadyForPickup('${esc(o._id)}')" style="border-radius:8px;"><i class="bi bi-check2-circle me-1"></i>Mark Ready for Pickup</button>`;
      }
      if (!o.isPastDate && isPickup && o.status === "ready_for_pickup") {
        footerBtns += `<button type="button" class="btn btn-sm btn-dark fw-bold" onclick="window._aoConfirmPickup('${esc(o._id)}')" style="border-radius:8px;"><i class="bi bi-bag-check me-1"></i>Confirm Pickup</button>`;
      }
      if (canAssign(o)) {
        footerBtns += assignBtn(o);
      }
      if (o.customerAccount?.state === 'invited' && o.customerAccount?.canManageInvitation) {
        footerBtns += `<button type="button" class="btn btn-sm btn-outline-primary fw-bold" onclick="window._aoResendCustomerActivation('${esc(o._id)}')"><i class="bi bi-envelope-arrow-up me-1"></i>Resend Activation</button>`;
      }
      modalFooter.innerHTML = footerBtns;
      modalFooter.style.display = footerBtns ? '' : 'none';
    } catch(err) {
      modalBody.innerHTML = '<p class="text-center text-danger py-4">Failed to load order details</p>';
    }
  };

  // ═══ ADMIN RESCHEDULE ═══════════════════════════════════════════════════════
  window._aoResendCustomerActivation = async function(orderId) {
    try {
      const response = await fetch(`/api/walk-in-aircon/orders/${encodeURIComponent(orderId)}/resend-invitation`, { method:'POST', credentials:'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Activation email could not be resent.');
      await Swal.fire({ icon:'success', title:'Activation email resent', text:data.message, confirmButtonColor:'#2563eb' });
      window._aoViewOrder(orderId);
    } catch (error) {
      Swal.fire({ icon:'error', title:'Unable to resend activation', text:error.message, confirmButtonColor:'#2563eb' });
    }
  };

  window._aoRescheduleOrder = async function(orderId, ref, currentDate, currentTime) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const current = currentDate ? new Date(currentDate) : null;
    const defaultDate = current && current.getTime() > Date.now() ? toLocalDateStr(current) : toLocalDateStr(tomorrow);
    const result = await Swal.fire({
      title: "Set a New Schedule",
      html: `<div class="text-start">
        <div class="alert alert-warning small py-2"><i class="bi bi-exclamation-triangle me-1"></i>The original schedule for <strong>${esc(ref)}</strong> has passed. The order will remain active.</div>
        <label class="form-label small fw-bold" for="aoRescheduleDate">New date</label>
        <input id="aoRescheduleDate" type="date" class="form-control mb-3" min="${toLocalDateStr(new Date())}" value="${defaultDate}">
        <label class="form-label small fw-bold" for="aoRescheduleTime">New time</label>
        <input id="aoRescheduleTime" type="time" class="form-control mb-3" value="${/^\d{2}:\d{2}$/.test(currentTime||'') ? esc(currentTime) : '09:00'}">
        <label class="form-label small fw-bold" for="aoRescheduleReason">Reason / customer agreement</label>
        <textarea id="aoRescheduleReason" class="form-control" rows="2" placeholder="Customer contacted and agreed to the new schedule"></textarea>
      </div>`,
      showCancelButton: true,
      confirmButtonText: "Save New Schedule",
      cancelButtonText: "Keep Unchanged",
      focusConfirm: false,
      buttonsStyling: false,
      customClass: {
        popup: "border-0 shadow-sm",
        confirmButton: "btn btn-warning fw-bold px-4 me-2",
        cancelButton: "btn btn-light border fw-bold px-4",
      },
      preConfirm: () => {
        const scheduledDate = document.getElementById("aoRescheduleDate").value;
        const timeSlot = document.getElementById("aoRescheduleTime").value;
        const reason = document.getElementById("aoRescheduleReason").value.trim();
        if (!scheduledDate || !timeSlot) {
          Swal.showValidationMessage("Select both a future date and time.");
          return false;
        }
        return { scheduledDate, timeSlot, reason };
      },
    });
    if (!result.isConfirmed) return;

    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/admin-reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.value),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update the order schedule");
      await Swal.fire({ title:"Schedule Updated", text:data.message, icon:"success", timer:1700, showConfirmButton:false });
      loadTab(currentTab);
      if (modal && modalEl.classList.contains("show")) window._aoViewOrder(orderId);
    } catch (err) {
      Swal.fire({
        title:"Schedule Not Updated",
        text:err.message || "The order schedule could not be changed.",
        icon:"error",
        buttonsStyling:false,
        customClass:{ confirmButton:"btn btn-primary px-4 fw-bold", popup:"border-0 shadow-sm" },
      });
    }
  };

  window._aoRequeueAssignment = async function(orderId, ref) {
    const result = await Swal.fire({
      title:"Return to Assignment Queue?",
      html:`The technician has not accepted <strong>${esc(ref)}</strong>. Release this assignment so another technician can be selected?`,
      icon:"warning",
      input:"text",
      inputPlaceholder:"Reason (optional)",
      showCancelButton:true,
      confirmButtonText:"Requeue Order",
      cancelButtonText:"Keep Assignment",
      buttonsStyling:false,
      customClass:{ confirmButton:"btn btn-warning fw-bold px-4 me-2", cancelButton:"btn btn-light border fw-bold px-4", popup:"border-0 shadow-sm" },
    });
    if (!result.isConfirmed) return;
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/requeue-assignment`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ reason:result.value || "Technician did not accept within the review window" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to requeue order");
      await Swal.fire({ title:"Order Requeued", text:data.message, icon:"success", timer:1500, showConfirmButton:false });
      loadTab(currentTab);
    } catch (err) {
      Swal.fire({ title:"Order Not Requeued", text:err.message || "The assignment could not be released.", icon:"error", buttonsStyling:false, customClass:{confirmButton:"btn btn-primary px-4 fw-bold",popup:"border-0 shadow-sm"} });
    }
  };

  // ═══ VERIFY PAYMENT ══════════════════════════════════════════════════════════
  window._aoVerifyPayment = async function (orderId) {
    const result = await Swal.fire({
      title:"Verify Payment?",html:`Mark payment as <strong>Paid</strong>?<br><small class="text-muted">This moves the order to its preparation and assignment queue.</small>`,
      icon:"question",showCancelButton:true,confirmButtonText:"Yes, Verify Payment",cancelButtonText:"Cancel",
      input:"text",inputPlaceholder:"Verification note (optional)...",
      buttonsStyling:false,
      customClass:{popup:"rounded-4 border-0 shadow-sm",title:"fw-bolder fs-5 text-dark",confirmButton:"btn btn-success px-4 py-2 rounded-pill me-2 fw-bold",cancelButton:"btn btn-light border px-4 py-2 rounded-pill fw-bold"}
    });
    if (!result.isConfirmed) return;

    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/payment`, {
        method:"PATCH",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({paymentStatus:"paid",note:result.value||"Payment verified by admin"})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error||"Failed");
      Swal.fire({title:"Payment Verified!",text:"Order is now being prepared.",icon:"success",timer:1500,showConfirmButton:false,customClass:{popup:"rounded-4"}});
      loadTab(currentTab);
      if (modal && orderId) window._aoViewOrder(orderId);
    } catch(err) {
      Swal.fire({title:"Error",text:err.message||"Network error",icon:"error",buttonsStyling:false,customClass:{confirmButton:"btn btn-primary px-4 py-2 rounded-pill fw-bold",popup:"rounded-4"}});
    }
  };

  // ═══ CONFIRM PHYSICAL UNIT PREPARATION ═════════════════════════════════════
  window._aoMarkDispatchReady = async function (orderId) {
    const result = await Swal.fire({
      title:"Confirm Unit Preparation",
      html:'<div class="text-start small"><div class="alert alert-info py-2">Confirm that every ordered air-conditioner unit and included accessory has been physically checked and prepared.</div><label class="form-label fw-semibold">Preparation note</label><textarea id="aoDispatchNote" class="form-control" maxlength="500" rows="3" placeholder="Unit, accessories, serial and packing checks..."></textarea></div>',
      icon:"question",showCancelButton:true,confirmButtonText:"Confirm Unit Prepared",cancelButtonText:"Cancel",
      preConfirm:()=>({note:(document.getElementById('aoDispatchNote').value||'').trim()})
    });
    if(!result.isConfirmed) return;
    try {
      const res=await fetch(`/api/orders/${encodeURIComponent(orderId)}/dispatch-ready`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result.value)});
      const data=await res.json();
      if(!res.ok) throw new Error(data.error||'Could not confirm unit preparation');
      await Swal.fire({title:'Unit Prepared',text:'The ordered unit is now cleared for technician departure.',icon:'success',timer:1800,showConfirmButton:false});
      loadTab(currentTab);
      if(modal) window._aoViewOrder(orderId);
    } catch(error) { Swal.fire({title:'Update Failed',text:error.message,icon:'error'}); }
  };

  // ═══ MARK READY FOR PICKUP ══════════════════════════════════════════════════
  window._aoMarkReadyForPickup = async function (orderId) {
    const result = await Swal.fire({
      title: "Mark as Ready?",
      html: `Mark this order as <strong>Ready for Pickup</strong>?<br><small class="text-muted">The customer will be notified that their unit is ready.</small>`,
      icon: "question", showCancelButton: true, confirmButtonText: "Yes, Mark Ready", cancelButtonText: "Cancel",
      input: "text", inputPlaceholder: "Note (optional)...",
      buttonsStyling: false,
      customClass: { popup: "rounded-4 border-0 shadow-sm", title: "fw-bolder fs-5 text-dark", confirmButton: "btn btn-success px-4 py-2 rounded-pill me-2 fw-bold", cancelButton: "btn btn-light border px-4 py-2 rounded-pill fw-bold" }
    });
    if (!result.isConfirmed) return;

    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/mark-ready-for-pickup`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: result.value || "Unit ready for customer pickup" })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      Swal.fire({ title: "Ready!", text: "Order marked as ready for pickup.", icon: "success", timer: 1500, showConfirmButton: false, customClass: { popup: "rounded-4" } });
      loadTab(currentTab);
      if (modal && orderId) window._aoViewOrder(orderId);
    } catch (err) {
      Swal.fire({ title: "Error", text: err.message || "Network error", icon: "error", buttonsStyling: false, customClass: { confirmButton: "btn btn-primary px-4 py-2 rounded-pill fw-bold", popup: "rounded-4" } });
    }
  };

  // ═══ CONFIRM PICKUP ═════════════════════════════════════════════════════════
  window._aoConfirmPickup = async function (orderId) {
    let order;
    try {
      const orderResponse = await fetch(`/api/orders/${encodeURIComponent(orderId)}`);
      const orderData = await orderResponse.json();
      if (!orderResponse.ok) throw new Error(orderData.error || "Could not load order");
      order = orderData.order;
    } catch (error) {
      return Swal.fire({ title: "Unable to Confirm", text: error.message, icon: "error" });
    }
    const unitCount = (order.items || []).reduce((sum, item) =>
      sum + ((item.isHvac !== false || item.parentHvacId || item.capacity) ? Math.max(1, Number(item.quantity) || 1) : 0), 0);
    const result = await Swal.fire({
      title: "Confirm Pickup?",
      html: `<div class="text-start"><p>Confirm that the customer has <strong>picked up</strong> the unit?</p><label class="form-label fw-bold small">Serial number${unitCount === 1 ? "" : "s"} (${unitCount} required)</label><textarea id="aoPickupSerials" class="form-control mb-2" rows="${Math.min(5, Math.max(2, unitCount))}" placeholder="One serial number per line"></textarea><label class="form-label fw-bold small">Pickup note</label><input id="aoPickupNote" class="form-control" placeholder="Optional handover note"><small class="text-muted d-block mt-2">Completion activates the product warranty and customer aftercare record. Cash-at-pickup payment is also recorded in the ledger.</small></div>`,
      icon: "question", showCancelButton: true, confirmButtonText: "Yes, Confirm Pickup", cancelButtonText: "Cancel",
      focusConfirm: false,
      preConfirm: () => {
        const serialNumbers = document.getElementById("aoPickupSerials").value.split(/\r?\n|,/).map(value => value.trim()).filter(Boolean);
        if (serialNumbers.length !== unitCount) {
          Swal.showValidationMessage(`Enter exactly ${unitCount} unique serial number${unitCount === 1 ? "" : "s"}.`);
          return false;
        }
        if (new Set(serialNumbers.map(value => value.toLowerCase())).size !== serialNumbers.length) {
          Swal.showValidationMessage("Serial numbers must be unique.");
          return false;
        }
        return { serialNumbers, note: document.getElementById("aoPickupNote").value.trim() };
      },
      buttonsStyling: false,
      customClass: { popup: "rounded-4 border-0 shadow-sm", title: "fw-bolder fs-5 text-dark", confirmButton: "btn btn-dark px-4 py-2 rounded-pill me-2 fw-bold", cancelButton: "btn btn-light border px-4 py-2 rounded-pill fw-bold" }
    });
    if (!result.isConfirmed) return;

    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/confirm-pickup`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: result.value.note || "Customer picked up unit", serialNumbers: result.value.serialNumbers })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      Swal.fire({ title: "Completed!", text: data.paymentCollected ? "Pickup and counter payment were recorded." : "Order marked as completed.", icon: "success", timer: 1800, showConfirmButton: false, customClass: { popup: "rounded-4" } });
      loadTab(currentTab);
      if (modal && orderId) window._aoViewOrder(orderId);
    } catch (err) {
      Swal.fire({ title: "Error", text: err.message || "Network error", icon: "error", buttonsStyling: false, customClass: { confirmButton: "btn btn-primary px-4 py-2 rounded-pill fw-bold", popup: "rounded-4" } });
    }
  };

  // ═══ ASSIGN TECHNICIAN ═══════════════════════════════════════════════════════
  // ─── Orders Assign Map ──────────────────────────────────────────────────
  let _aoAssignMap = null;
  let _aoAssignMarkers = [];

  function _aoInitAssignMap(bookingLat, bookingLng, techs) {
    const mapEl = document.getElementById('aoAssignMapContainer');
    if (_aoAssignMap) { _aoAssignMap.remove(); _aoAssignMap = null; }
    _aoAssignMarkers = [];

    function loadLeaflet(cb) {
      if (typeof L !== 'undefined') { cb(); return; }
      if (!document.getElementById('leaflet-css-ao')) {
        const css = document.createElement('link');
        css.id = 'leaflet-css-ao'; css.rel = 'stylesheet';
        css.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(css);
      }
      const existing = document.getElementById('leaflet-js-ao');
      if (!existing) {
        const s = document.createElement('script');
        s.id = 'leaflet-js-ao';
        s.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
        s.onload = cb;
        document.body.appendChild(s);
      } else if (typeof L !== 'undefined') {
        cb();
      } else {
        existing.addEventListener('load', cb, { once: true });
      }
    }

    loadLeaflet(() => {
      _aoAssignMap = L.map(mapEl, { zoomControl: true, attributionControl: false })
        .setView([bookingLat, bookingLng], 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OSM</a>'
      }).addTo(_aoAssignMap);

      const custIcon = L.divIcon({
        html: '<div style="background:#2563eb;color:#fff;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);"><i class="bi bi-geo-alt-fill"></i></div>',
        className: '', iconSize: [32, 32], iconAnchor: [16, 16]
      });
      L.marker([bookingLat, bookingLng], { icon: custIcon }).addTo(_aoAssignMap)
        .bindPopup('<b>Delivery Location</b>');

      const bounds = L.latLngBounds([bookingLat, bookingLng]);
      (techs || []).forEach(t => {
        if (!t.location || !t.location.coordinates || t.location.coordinates.length < 2) return;
        const [lng, lat] = t.location.coordinates;
        const color = t.availabilityStatus === 'Available' ? '#22c55e' : '#f59e0b';
        const techIcon = L.divIcon({
          html: `<div style="background:${color};color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);">${(t.name||'T')[0]}</div>`,
          className: '', iconSize: [28, 28], iconAnchor: [14, 14]
        });
        const marker = L.marker([lat, lng], { icon: techIcon }).addTo(_aoAssignMap)
          .bindPopup('<b>' + t.name + '</b><br>' + (t.availabilityStatus || 'Offline') + (t.distanceKm != null ? '<br>' + t.distanceKm + ' km away' : '') + (t.etaMin != null ? '<br>ETA ~' + t.etaMin + ' min' : ''));
        _aoAssignMarkers.push(marker);
        bounds.extend([lat, lng]);
      });

      if (techs && techs.length > 0) {
        _aoAssignMap.fitBounds(bounds.pad(0.2));
      }
      setTimeout(() => _aoAssignMap?.invalidateSize(), 150);
    });
  }

  function _aoCardHtml(t, selected) {
    const sd = t.availabilityStatus === 'Available' ? '#22c55e' : '#f59e0b';
    const sel = selected ? ' selected' : '';
    const dist = t.distanceKm != null ? '<span class="ao-tech-badge"><i class="bi bi-geo me-1"></i>' + t.distanceKm + ' km</span>' : '';
    const eta = t.etaMin != null ? '<span class="ao-tech-badge"><i class="bi bi-clock me-1"></i>' + t.etaMin + ' min</span>' : '';
    const chk = selected ? 'checked' : '';
    return '<div class="ao-tech-card' + sel + '" onclick="window._aoSelectTechUpgraded(\'' + t._id + '\', this)" data-tech-id="' + t._id + '">' +
      '<div class="ao-tech-card-top">' +
        '<div class="ao-tech-card-avatar-up" style="--status-color:' + sd + ';">' + (t.name || '?')[0].toUpperCase() + '</div>' +
        '<div class="ao-tech-card-info">' +
          '<div class="ao-tech-card-name">' + esc(t.name) + '</div>' +
          '<div class="ao-tech-card-status"><span style="color:' + sd + ';font-size:10px;">&#9679;</span> ' + (t.availabilityStatus || 'Offline') + '</div>' +
        '</div>' +
        '<div class="ao-tech-card-rating">' + (t.rating ? '★ ' + Number(t.rating).toFixed(1) : '') + '</div>' +
      '</div>' +
      '<div class="ao-tech-card-meta">' +
        dist + eta +
        '<span class="ao-tech-badge"><i class="bi bi-briefcase me-1"></i>' + (t.currentWorkload || 0) + ' jobs</span>' +
        '<span class="ao-tech-badge"><i class="bi bi-envelope me-1"></i>' + esc(t.email || '—') + '</span>' +
      '</div>' +
      '<div class="ao-tech-card-footer">' +
        '<input type="radio" name="aoTechSelect" class="form-check-input" ' + chk + '>' +
        '<span class="small text-muted">Select</span>' +
        '<button class="btn btn-sm btn-primary ms-auto ao-assign-now-btn" onclick="event.stopPropagation();window._aoSelectTechUpgraded(\'' + t._id + '\', this.closest(\'.ao-tech-card\'));document.getElementById(\'aoAssignConfirmBtn\').click();">' +
          '<i class="bi bi-check-lg me-1"></i>Assign' +
        '</button>' +
      '</div>' +
    '</div>';
  }

  window._aoAssignTechnician = function (orderId, orderRefText, customerName, prefDate, prefTime) {
    if (modal) modal.hide();
    _aoAssignTargetOrderId = orderId;
    _aoSelectedTechId = null;

    document.getElementById("aoAssignOrderRef").textContent = orderRefText || orderId.slice(-8).toUpperCase();
    document.getElementById("aoAssignCustomerName").textContent = customerName || "Customer";

    const dateInput  = document.getElementById("aoAssignDate");
    const timeSelect = document.getElementById("aoAssignTimeSlot");
    const noteInput  = document.getElementById("aoAssignNote");
    if (dateInput) {
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1);
      dateInput.min = toLocalDateStr(tomorrow);
      dateInput.value = prefDate ? prefDate.substring(0, 10) : "";
    }
    if (timeSelect) timeSelect.value = prefTime || "";
    if (noteInput) noteInput.value = "";
    const prioritySelect = document.getElementById("aoAssignPriority");
    if (prioritySelect) prioritySelect.value = "normal";

    const confirmBtn = document.getElementById("aoAssignConfirmBtn");
    if (confirmBtn) confirmBtn.disabled = true;

    const container = document.getElementById("aoTechListContainer");
    container.innerHTML = '<div class="text-center py-3"><div class="spinner-border spinner-border-sm"></div></div>';
    document.getElementById('aoAIRecommendSection').style.display = 'none';
    document.getElementById('aoAssignMapContainer').innerHTML = '<div class="text-center py-5 text-muted"><i class="bi bi-geo-alt fs-1 d-block mb-2"></i>Loading map...</div>';

    assignTechModal.show();

    fetch(`/api/orders/${encodeURIComponent(orderId)}/eligible-technicians`)
      .then(r => r.json())
      .then(data => {
        const available = data.available || [];
        const offline = data.offlinePresent || [];
        const allTechs = [...available, ...offline];
        const bookingLat = data.bookingLat || null;
        const bookingLng = data.bookingLng || null;

        document.getElementById('aoTechCountBadge').textContent = available.length;

        // Map
        if (bookingLat && bookingLng) {
          _aoInitAssignMap(bookingLat, bookingLng, allTechs);
        } else {
          document.getElementById('aoAssignMapContainer').innerHTML =
            '<div class="text-center py-5 text-muted"><i class="bi bi-geo-alt fs-1 d-block mb-2"></i>Location data unavailable</div>';
        }

        if (!available.length && !offline.length) {
          container.innerHTML = '<div class="alert alert-warning small mb-0">No eligible technicians found. Ensure technicians are checked in and available.</div>';
          return;
        }

        // AI Recommendation
        if (available.length > 0) {
          const top = available[0];
          const reasons = [];
          if (top.availabilityStatus === 'Available') reasons.push('Available now');
          else if (top.availabilityStatus === 'Online') reasons.push('Online');
          else reasons.push('Currently ' + (top.availabilityStatus || 'offline'));
          if (top.distanceKm != null) reasons.push(top.distanceKm + ' km away');
          if (top.etaMin != null) reasons.push('ETA ~' + top.etaMin + ' min');
          if (top.rating >= 4.5) reasons.push('Top rated (' + Number(top.rating).toFixed(1) + ')');
          if (top.currentWorkload === 0) reasons.push('No current jobs');
          else if (top.currentWorkload) reasons.push(top.currentWorkload + ' active job' + (top.currentWorkload > 1 ? 's' : ''));
          document.getElementById('aoAIRecommendSection').style.display = 'flex';
          document.getElementById('aoAIRecommendName').textContent = top.name;
          document.getElementById('aoAIRecommendReason').textContent = reasons.join(' · ');
          document.getElementById('aoAIRecommendSection').dataset.techId = top._id;
        }

        // Enhanced cards
        let html = '';
        if (available.length) {
          html += '<div class="ao-tech-list-upgraded">';
          available.forEach(t => { html += _aoCardHtml(t, false); });
          html += '</div>';
        } else {
          html += '<div class="alert alert-info small">No available technicians at this time.</div>';
        }
        if (offline.length) {
          html += '<div class="mt-2 mb-1"><small class="fw-semibold text-muted" style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.5px;">Unavailable</small></div>';
          html += '<div class="ao-tech-list">' + offline.map(t => `
            <div class="ao-tech-option unavailable" title="${esc(t.reason||'Unavailable')}">
              <div class="ao-tech-avatar" style="background:#6c757d;">${t.avatar||(t.name||'?')[0].toUpperCase()}</div>
              <div>
                <div class="ao-tech-name">${esc(t.name)}</div>
                <div class="ao-tech-status text-danger"><i class="bi bi-x-circle me-1"></i>${esc(t.reason||'Unavailable')}</div>
              </div>
            </div>
          `).join('') + '</div>';
        }
        container.innerHTML = html;

        const techsOnMap = allTechs.filter(t => t.location && t.location.coordinates && t.location.coordinates.length >= 2).length;
        document.getElementById('aoAssignMapTechCount').textContent = techsOnMap + ' technicians on map';
      })
      .catch(() => {
        container.innerHTML = '<div class="alert alert-danger small">Failed to load technicians</div>';
      });
  };

  window._aoSelectTechUpgraded = function(techId, el) {
    _aoSelectedTechId = techId;
    document.querySelectorAll('.ao-tech-card').forEach(c => c.classList.remove('selected'));
    if (el) el.classList.add('selected');
    document.querySelectorAll('.ao-tech-card input[type="radio"]').forEach(r => r.checked = false);
    if (el) {
      const radio = el.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
    }
    const confirmBtn = document.getElementById("aoAssignConfirmBtn");
    if (confirmBtn) confirmBtn.disabled = false;
  };

  window._aoAssignAIPick = function() {
    const section = document.getElementById('aoAIRecommendSection');
    const techId = section.dataset.techId;
    const card = document.querySelector('.ao-tech-card[data-tech-id="' + techId + '"]');
    if (card) {
      card.click();
    } else {
      _aoSelectedTechId = techId;
      document.getElementById("aoAssignConfirmBtn").disabled = false;
    }
  };

  // Modal cleanup
  document.getElementById('aoAssignTechModal').addEventListener('shown.bs.modal', function () {
    setTimeout(() => { if (_aoAssignMap) _aoAssignMap.invalidateSize(); }, 200);
  });
  document.getElementById('aoAssignTechModal').addEventListener('hidden.bs.modal', function () {
    if (_aoAssignMap) { _aoAssignMap.remove(); _aoAssignMap = null; }
    _aoAssignMarkers = [];
  });

  document.getElementById("aoAssignConfirmBtn")?.addEventListener("click", async () => {
    if (!_aoSelectedTechId) {
      Swal.fire({title:"Select Technician",text:"Click a technician card to select one.",icon:"warning",buttonsStyling:false,customClass:{confirmButton:"btn btn-primary px-4 py-2 rounded-pill fw-bold",popup:"rounded-4"}});
      return;
    }
    const scheduledDate = document.getElementById("aoAssignDate").value;
    const timeSlot = document.getElementById("aoAssignTimeSlot").value;
    const note = (document.getElementById("aoAssignNote").value||'').trim();
    const priority = (document.getElementById("aoAssignPriority")?.value) || 'normal';
    // date is read-only (from customer's preferred date) — backend will fallback if empty

    const btn = document.getElementById("aoAssignConfirmBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Assigning...';
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(_aoAssignTargetOrderId)}/assign-technician`, {
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({technicianId:_aoSelectedTechId,scheduledDate,timeSlot,note,priority})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error||"Failed to assign");
      Swal.fire({title:"Assigned!",text:"Technician assigned successfully.",icon:"success",timer:1600,showConfirmButton:false,customClass:{popup:"rounded-4"}});
      assignTechModal.hide();
      loadTab(currentTab);
      if (modal && _aoAssignTargetOrderId) window._aoViewOrder(_aoAssignTargetOrderId);
    } catch(err) {
      Swal.fire({title:"Error",text:err.message||"Network error",icon:"error",buttonsStyling:false,customClass:{confirmButton:"btn btn-primary px-4 py-2 rounded-pill fw-bold",popup:"rounded-4"}});
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Assign Technician';
    }
  });

  // ═══ EVENT LISTENERS ══════════════════════════════════════════════════════════
  filterBtn.addEventListener("click", () => loadOverview(1));
  searchInput.addEventListener("keyup", e => { if (e.key==="Enter") loadOverview(1); });
  let overviewSearchTimer;
  searchInput.addEventListener("input", () => {
    window.clearTimeout(overviewSearchTimer);
    overviewSearchTimer = window.setTimeout(() => loadOverview(1), 350);
  });
  [statusFilter, fulfillFilter, preparationFilter].filter(Boolean).forEach(control => control.addEventListener("change", () => loadOverview(1)));
  document.getElementById("aoClearDates")?.addEventListener("click", () => {
    scheduledFrom.value = "";
    scheduledTo.value = "";
    loadOverview(1);
  });
  document.getElementById("aoRefreshOverview")?.addEventListener("click", () => loadOverview(currentPage));
  let assignSearchTimer;
  document.getElementById("aoAssignSearchInput")?.addEventListener("input", () => {
    window.clearTimeout(assignSearchTimer);
    assignSearchTimer = window.setTimeout(renderAssignQueue, 250);
  });
  document.querySelectorAll("#aoAssignFilterPills [data-assign-filter]").forEach(button => {
    button.addEventListener("click", () => {
      assignQueueFilter = button.dataset.assignFilter || "all";
      document.querySelectorAll("#aoAssignFilterPills [data-assign-filter]").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      renderAssignQueue();
    });
  });
  document.getElementById("aoAssignRefresh")?.addEventListener("click", loadAssignTab);
  document.getElementById("aoOpenBulkPlan")?.addEventListener("click", openOrderBulkPlan);
  document.getElementById("aoConfirmBulkPlan")?.addEventListener("click", confirmOrderBulkPlan);

  // ═══ UTILS ════════════════════════════════════════════════════════════════════
  function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

  // ═══ INITIAL LOAD ════════════════════════════════════════════════════════════
  setFulfillmentScope(initialScope, { load: false });
  loadOverview(1);
  const linkedOrderId = new URLSearchParams(window.location.search).get("order");
  if (linkedOrderId && /^[a-f\d]{24}$/i.test(linkedOrderId)) {
    window.setTimeout(() => window._aoViewOrder(linkedOrderId), 150);
  }
});

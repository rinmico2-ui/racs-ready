document.addEventListener("DOMContentLoaded", function () {
  // ═══ CONSTANTS ═══════════════════════════════════════════════════════════════
  const STATUS_LABELS = {
    pending_payment: "Pending Payment", preparing_unit: "Preparing Unit",
    technician_assigned: "Technician Assigned", out_for_delivery: "Out for Delivery",
    arrived: "Arrived", installing: "Installing", completed: "Completed", cancelled: "Cancelled"
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

  // ═══ SPARKLINE HELPERS ═══════════════════════════════════════════════════════
  function spark(ctx, data, color){
    if(!ctx || !window.Chart) return null;
    var h = ctx.canvas.height || ctx.canvas.offsetHeight || 40;
    var g = ctx.createLinearGradient(0,0,0,h);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(function(_,i){ return i+1; }),
        datasets: [{ data: data, borderColor: color, backgroundColor: g, fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2 }]
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

  // ═══ DOM REFS ════════════════════════════════════════════════════════════════
  const searchInput   = document.getElementById("aoSearch");
  const statusFilter  = document.getElementById("aoStatusFilter");
  const fulfillFilter = document.getElementById("aoFulfillFilter");
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

  // ═══ TAB SWITCHING ═══════════════════════════════════════════════════════════
  document.querySelectorAll('.ao-tab-btn[data-bs-target]').forEach(btn => {
    btn.addEventListener('shown.bs.tab', function (e) {
      const target = e.target.getAttribute('data-bs-target');
      if (target.includes('overview'))       currentTab = "overview";
      else if (target.includes('payment'))   currentTab = "payment";
      else if (target.includes('assign'))    currentTab = "assign";
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
      case "waiting":    loadWaitingAcceptTab(); break;
      case "active":     loadActiveTab(); break;
      case "completed":  loadCompletedTab(); break;
    }
  }

  // ═══ RENDER STATS ════════════════════════════════════════════════════════════
  function renderStats(containerId, stats) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const gradients = {
      blue: 'linear-gradient(135deg,#2563eb,#1d4ed8)',
      amber: 'linear-gradient(135deg,#f59e0b,#d97706)',
      green: 'linear-gradient(135deg,#10b981,#059669)',
      purple: 'linear-gradient(135deg,#8b5cf6,#6d28d9)',
      cyan: 'linear-gradient(135deg,#06b6d4,#0891b2)',
      red: 'linear-gradient(135deg,#ef4444,#dc2626)',
      rose: 'linear-gradient(135deg,#f43f5e,#e11d48)'
    };
    const sparkColors = {
      blue: '#2563eb', amber: '#f59e0b', green: '#10b981',
      purple: '#8b5cf6', cyan: '#06b6d4', red: '#ef4444', rose: '#f43f5e'
    };
    container.innerHTML = stats.map(s => {
      const color = s.color || 'blue';
      const hex = sparkColors[color] || sparkColors.blue;
      const badge = s.percent || (s.label && s.label.split(' ')[0]) || '';
      return `
      <div class="stat-card h-100" data-spark-color="${hex}">
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
    const date = fmtDateShort(o.delivery && o.delivery.preferredDate ? o.delivery.preferredDate : o.createdAt);
    const time = fmtTime(o.timeSlot);

    return `<div class="ao-order-card" data-order-id="${esc(o._id)}">
      <div class="ao-order-header">
        <div>
          <div class="ao-order-ref">${esc(ref)}</div>
          <div class="ao-order-customer">${esc(cust)}</div>
          <div class="ao-order-fulfill">${esc(fulfill)}</div>
        </div>
        <div class="text-end d-flex flex-column align-items-end gap-1">
          <span class="ao-st-badge ao-st-${o.status}">${STATUS_LABELS[o.status]||o.status}</span>
          ${o.fulfillmentType === 'delivery_installation' ? '<span class="ao-st-fulfillment"><i class="bi bi-tools me-1"></i>w/ Install</span>' : ''}
        </div>
      </div>
      <div class="ao-detail-grid">
        <div class="ao-detail-item"><i class="bi bi-box-seam"></i> ${esc(items.substring(0,40))}${items.length>40?'...':''}</div>
        <div class="ao-detail-item"><i class="bi bi-calendar"></i> ${date}</div>
        ${time !== "—" ? `<div class="ao-detail-item"><i class="bi bi-clock"></i> ${time}</div>` : ''}
        <div class="ao-detail-item"><i class="bi bi-tag"></i> ${FULFILL_LABELS[o.fulfillmentType]||o.fulfillmentType}</div>
        <div class="ao-detail-item"><i class="bi bi-cash"></i> ${currency(o.total)}</div>
        <div class="ao-detail-item"><i class="bi bi-credit-card"></i> <span class="${pBadge}">${pStatus}</span></div>
        <div class="ao-detail-item"><i class="bi bi-person"></i> ${techName || '<span class="text-muted">Unassigned</span>'}</div>
        <div class="ao-detail-item"><i class="bi bi-boxes"></i> ${(o.items||[]).reduce((s,i)=>s+(i.quantity||1),0)} unit(s)</div>
      </div>
      <div class="ao-action-bar">${actions}</div>
    </div>`;
  }

  function viewBtn(id) {
    return `<button class="btn btn-sm btn-outline-secondary ao-action-btn" onclick="window._aoViewOrder('${esc(id)}')"><i class="bi bi-eye me-1"></i>View</button>`;
  }
  function verifyBtn(id) {
    return `<button class="btn btn-sm btn-success ao-action-btn" onclick="window._aoVerifyPayment('${esc(id)}')"><i class="bi bi-check2-circle me-1"></i>Verify</button>`;
  }
  function assignBtn(o) {
    return `<button class="btn btn-sm btn-primary ao-action-btn" onclick="window._aoAssignTechnician('${esc(o._id)}','${esc(orderRef(o))}','${esc((o.customer&&o.customer.name)||'Customer')}','${esc(o.delivery&&o.delivery.preferredDate||'')}','${esc(o.timeSlot||'')}')"><i class="bi bi-person-badge me-1"></i>Assign</button>`;
  }

  // ═══ PAGINATION ══════════════════════════════════════════════════════════════
  function renderPagination(pag, goFn) {
    const el = document.getElementById("aoPagination");
    if (!pag || pag.pages <= 1) { el.innerHTML = ""; return; }
    let pg = '<ul class="pagination pagination-sm">';
    for (let i = 1; i <= pag.pages; i++) {
      pg += `<li class="page-item ${i === pag.page ? 'active' : ''}"><button class="page-link" onclick="${goFn}(${i})">${i}</button></li>`;
    }
    pg += '</ul>';
    el.innerHTML = pg;
  }

  // ═══ OVERVIEW ════════════════════════════════════════════════════════════════
  async function loadOverview(pg) {
    currentPage = pg || 1;
    const params = new URLSearchParams({ page: currentPage, limit: LIMIT });
    if (searchInput.value.trim()) params.set("search", searchInput.value.trim());
    if (statusFilter.value !== "all") params.set("status", statusFilter.value);
    if (fulfillFilter.value !== "all") params.set("fulfillmentType", fulfillFilter.value);

    const container = document.getElementById("aoOverviewContainer");
    container.innerHTML = '<div class="text-center py-5 text-muted"><div class="spinner-border text-primary"></div><p class="mt-2">Loading orders...</p></div>';

    try {
      const res = await fetch("/api/orders/all?" + params.toString());
      if (!res.ok) throw new Error("Fetch failed");
      const data = await res.json();
      const orders = data.orders || [];

      const kpi = data.kpi || {};
      setText("heroTotal", kpi.totalOrders || 0);
      setText("heroPending", kpi.pending || 0);
      setText("heroActive", kpi.inProgress || 0);
      setText("heroCompleted", kpi.completed || 0);
      setText("aoTabTotalBadge", data.total || 0);

      renderStats("aoOverviewStats", [
        { icon: "bi-bag-check", color: "blue", value: kpi.totalOrders||0, label: "Total Orders", sub: "All orders" },
        { icon: "bi-clock-history", color: "amber", value: kpi.pending||0, label: "Pending Payment", sub: "Awaiting payment" },
        { icon: "bi-truck", color: "purple", value: kpi.inProgress||0, label: "In Progress", sub: "Active orders" },
        { icon: "bi-check-circle", color: "green", value: kpi.completed||0, label: "Completed" },
        { icon: "bi-x-circle", color: "red", value: kpi.cancelled||0, label: "Cancelled" },
      ]);

      if (!orders.length) {
        container.innerHTML = '<div class="ao-empty"><i class="bi bi-inbox"></i><p>No orders found</p></div>';
        document.getElementById("aoPagination").innerHTML = "";
        return;
      }

      container.innerHTML = orders.map(o => {
        const hasTech = o.technicianId || (o.technician && o.technician.name);
        let actions = viewBtn(o._id);
        if (o.status === 'pending_payment' && o.paymentStatus !== 'paid') {
          actions += verifyBtn(o._id);
        }
        if ((o.status === 'pending_payment' || o.status === 'preparing_unit' || o.status === 'technician_declined') && !hasTech) {
          actions += assignBtn(o);
        }
        return orderCard(o, actions);
      }).join("");

      renderPagination(data, 'window._aoGoPage');
      window._aoGoPage = function(p) { loadOverview(p); };
    } catch(err) {
      container.innerHTML = '<div class="alert alert-danger">Failed to load orders</div>';
    }
  }

  // ═══ PENDING PAYMENT TAB ═════════════════════════════════════════════════════
  async function loadPaymentTab() {
    const container = document.getElementById("aoPaymentContainer");
    container.innerHTML = '<div class="text-center py-5 text-muted"><div class="spinner-border text-primary"></div><p class="mt-2">Loading payment queue...</p></div>';

    try {
      const res = await fetch("/api/orders/all?status=pending_payment&limit=100");
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
        const hasTech = o.technicianId || (o.technician && o.technician.name);

        let actions = viewBtn(o._id);
        if (pStatus !== "paid") {
          actions += verifyBtn(o._id);
        }
        if ((pStatus === "paid" || o.status === "pending_payment") && !hasTech) {
          actions += assignBtn(o);
        }

        return orderCard(o, actions) +
          `<div style="margin-top:-10px;padding:0 20px 16px;border-bottom:1px solid #f1f5f9;"><span class="small text-muted"><i class="bi bi-credit-card me-1"></i>${esc(method)}</span> <span class="${pBadge} ms-2">${pStatus}</span></div>`;
      }).join("");
    } catch(err) {
      container.innerHTML = '<div class="alert alert-danger">Failed to load</div>';
    }
  }

  // ═══ READY TO ASSIGN TAB ═════════════════════════════════════════════════════
  async function loadAssignTab() {
    const container = document.getElementById("aoAssignContainer");
    container.innerHTML = '<div class="text-center py-5 text-muted"><div class="spinner-border text-primary"></div><p class="mt-2">Loading assignable orders...</p></div>';

    try {
      const res = await fetch("/api/orders/all?limit=100");
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const orders = (data.orders || []).filter(o =>
        (o.status === "pending_payment" || o.status === "preparing_unit" || o.status === "technician_declined") &&
        !o.technicianId && !(o.technician && o.technician.name)
      );

      setText("aoTabAssignBadge", orders.length);
      renderStats("aoAssignStats", [
        { icon: "bi-person-check", color: "blue", value: orders.length, label: "Assignment Queue", sub: "Ready to assign" },
        { icon: "bi-box-seam", color: "green", value: orders.filter(o => o.fulfillmentType === "delivery_installation").length, label: "Delivery + Install", sub: "With installation" },
        { icon: "bi-geo-alt", color: "cyan", value: orders.filter(o => o.fulfillmentType === "delivery_only").length, label: "Delivery Only", sub: "No installation" },
      ]);

      if (!orders.length) {
        container.innerHTML = '<div class="ao-empty"><i class="bi bi-check-circle" style="color:#10b981;"></i><p>All orders have technicians assigned</p></div>';
        return;
      }

      container.innerHTML = orders.map(o => orderCard(o, viewBtn(o._id) + assignBtn(o))).join("");
    } catch(err) {
      container.innerHTML = '<div class="alert alert-danger">Failed to load</div>';
    }
  }

  // ═══ WAITING FOR ACCEPTANCE TAB ═══════════════════════════════════════════════
  async function loadWaitingAcceptTab() {
    const container = document.getElementById("aoWaitingContainer");
    container.innerHTML = '<div class="text-center py-5 text-muted"><div class="spinner-border text-primary"></div><p class="mt-2">Loading...</p></div>';

    try {
      const res = await fetch("/api/orders/all?limit=100");
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const orders = (data.orders || []).filter(o => o.status === "technician_assigned");

      setText("aoTabWaitingBadge", orders.length);
      renderStats("aoWaitingStats", [
        { icon: "bi-person-badge", color: "purple", value: orders.length, label: "Waiting for Acceptance", sub: "Tech pending" },
        { icon: "bi-clock-history", color: "amber", value: orders.filter(o => {
          if (!o.technician?.assignedAt) return false;
          const hours = (Date.now() - new Date(o.technician.assignedAt).getTime()) / 3600000;
          return hours > 2;
        }).length, label: "Overdue (>2 hrs)" },
      ]);

      if (!orders.length) {
        container.innerHTML = '<div class="ao-empty"><i class="bi bi-check-circle"></i><p>No orders waiting for technician acceptance</p></div>';
        return;
      }

      container.innerHTML = orders.map(o => {
        const assignedAt = o.technician?.assignedAt ? new Date(o.technician.assignedAt).toLocaleString() : '—';
        const techName = o.technician?.name || 'Unknown';
        const techPhone = o.technician?.phone || o.technician?.contact || '—';
        return orderCard(o, `
          <button class="btn btn-sm btn-outline-secondary ao-action-btn" onclick="window._aoViewOrder('${esc(o._id)}')"><i class="bi bi-eye me-1"></i>View</button>
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
      const activeStatuses = ["technician_assigned","out_for_delivery","arrived","installing"];
      const res = await fetch("/api/orders/all?limit=100");
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const orders = (data.orders || []).filter(o => activeStatuses.includes(o.status));

      setText("aoTabActiveBadge", orders.length);
      renderStats("aoActiveStats", [
        { icon: "bi-person-badge", color: "purple", value: orders.filter(o=>o.status==="technician_assigned").length, label: "Assigned", sub: "Tech assigned" },
        { icon: "bi-truck", color: "amber", value: orders.filter(o=>o.status==="out_for_delivery").length, label: "Out for Delivery", sub: "In transit" },
        { icon: "bi-geo-alt", color: "cyan", value: orders.filter(o=>o.status==="arrived").length, label: "Arrived", sub: "On site" },
        { icon: "bi-tools", color: "rose", value: orders.filter(o=>o.status==="installing").length, label: "Installing" },
      ]);

      if (!orders.length) {
        container.innerHTML = '<div class="ao-empty"><i class="bi bi-inbox"></i><p>No active orders</p></div>';
        return;
      }

      container.innerHTML = orders.map(o => orderCard(o, viewBtn(o._id))).join("");
    } catch(err) {
      container.innerHTML = '<div class="alert alert-danger">Failed to load</div>';
    }
  }

  // ═══ COMPLETED TAB ═══════════════════════════════════════════════════════════
  async function loadCompletedTab() {
    const container = document.getElementById("aoCompletedContainer");
    container.innerHTML = '<div class="text-center py-5 text-muted"><div class="spinner-border text-primary"></div><p class="mt-2">Loading completed orders...</p></div>';

    try {
      const res = await fetch("/api/orders/all?limit=100");
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      const orders = (data.orders || []).filter(o => o.status === "completed" || o.status === "cancelled");
      const completed = orders.filter(o => o.status === "completed");
      const revenue = completed.reduce((s,o) => s + (o.total || 0), 0);

      setText("aoTabDoneBadge", orders.length);
      renderStats("aoCompletedStats", [
        { icon: "bi-check-circle", color: "green", value: completed.length, label: "Completed", sub: "Finished orders" },
        { icon: "bi-x-circle", color: "red", value: orders.filter(o=>o.status==="cancelled").length, label: "Cancelled", sub: "Voided orders" },
        { icon: "bi-cash-stack", color: "blue", value: currency(revenue), label: "Revenue", sub: "Total revenue" },
      ]);

      if (!orders.length) {
        container.innerHTML = '<div class="ao-empty"><i class="bi bi-inbox"></i><p>No completed orders yet</p></div>';
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
    modalFooter.innerHTML = '<button type="button" class="btn btn-sm btn-light border fw-semibold" data-bs-dismiss="modal" style="border-radius:8px;">Close</button>';
    modal.show();

    try {
      const res = await fetch("/api/orders/" + encodeURIComponent(id));
      if (!res.ok) throw new Error("Not found");
      const data = await res.json();
      const o = data.order;
      if (!o) { modalBody.innerHTML = '<p class="text-center text-danger">Order not found</p>'; return; }

      const refText = o.orderReference || `#${o._id.toString().slice(-8).toUpperCase()}`;
      modalSubtitle.textContent = refText;

      const pStatus = (o.paymentStatus||"pending").toLowerCase();
      const pBadgeClass = pStatus==="paid"?"bg-success":pStatus==="failed"?"bg-danger":"bg-warning text-dark";

      let html = `
        <div class="pm-status-bar">
          <span class="badge ${pStatus==='paid'?'bg-success':pStatus==='failed'?'bg-danger':'bg-warning text-dark'}" style="font-size:.75rem;">Payment: ${pStatus.toUpperCase()}</span>
          <span class="ao-st-badge ao-st-${o.status}">${STATUS_LABELS[o.status]||o.status}</span>
          <span class="ao-st-fulfillment">${esc(FULFILL_LABELS[o.fulfillmentType]||o.fulfillmentType)}</span>
        </div>

        <div class="pm-grid">
          <div class="pm-card">
            <div class="pm-card-head"><div class="pm-icon" style="background:#dbeafe;color:#2563eb;"><i class="bi bi-person"></i></div><h3 class="pm-card-title">Customer</h3></div>
            <div class="pm-card-body">
              <div class="pm-row"><span class="pm-lbl">Name</span><span class="pm-val">${esc((o.customer&&o.customer.name)||"-")}</span></div>
              <div class="pm-row"><span class="pm-lbl">Email</span><span class="pm-val">${esc((o.customer&&o.customer.email)||"—")}</span></div>
              <div class="pm-row"><span class="pm-lbl">Phone</span><span class="pm-val">${esc((o.customer&&o.customer.phone)||"—")}</span></div>
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
              ${o.delivery&&o.delivery.preferredDate?`<div class="pm-row"><span class="pm-lbl">Preferred Date</span><span class="pm-val">${fmtDate(o.delivery.preferredDate)}</span></div>`:''}
              ${o.timeSlot?`<div class="pm-row"><span class="pm-lbl">Time Slot</span><span class="pm-val">${fmtTime(o.timeSlot)}</span></div>`:''}
              ${o.delivery&&o.delivery.notes?`<div class="pm-row"><span class="pm-lbl">Notes</span><span class="pm-val" style="font-weight:400;">${esc(o.delivery.notes)}</span></div>`:''}
            </div>
          </div>

          <div class="pm-card">
            <div class="pm-card-head"><div class="pm-icon" style="background:#f3e8ff;color:#9333ea;"><i class="bi bi-cash-stack"></i></div><h3 class="pm-card-title">Pricing</h3></div>
            <div class="pm-card-body">
              <div class="pm-row"><span class="pm-lbl">Subtotal</span><span class="pm-val">${currency(o.subtotal)}</span></div>
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
            <div class="fw-semibold small">${esc(STATUS_LABELS[h.status]||h.status)}</div>
            <div style="font-size:0.72rem;color:#94a3b8;">${new Date(h.timestamp).toLocaleString("en-PH")}</div>
            ${h.note?'<div style="font-size:0.75rem;color:#64748b;">'+esc(h.note)+'</div>':''}
          </div>`;
        });
        html += '</div>';
      }

      modalBody.innerHTML = html;

      let footerBtns = '<button type="button" class="btn btn-sm btn-light border fw-semibold" data-bs-dismiss="modal" style="border-radius:8px;">Close</button>';
      if (o.status === "pending_payment" && o.paymentStatus !== "paid") {
        footerBtns += `<button type="button" class="btn btn-sm btn-success fw-bold" onclick="window._aoVerifyPayment('${esc(o._id)}')" style="border-radius:8px;"><i class="bi bi-check2-circle me-1"></i>Verify Payment</button>`;
      }
      const assignableStatuses = ["pending_payment","preparing_unit"];
      const hasTech = o.technicianId || (o.technician && o.technician.name);
      if (assignableStatuses.includes(o.status) && !hasTech) {
        footerBtns += `<button type="button" class="btn btn-sm btn-primary fw-bold" onclick="window._aoAssignTechnician('${esc(o._id)}','${esc(refText)}','${esc((o.customer&&o.customer.name)||'Customer')}','${esc(o.delivery&&o.delivery.preferredDate||'')}','${esc(o.timeSlot||'')}')" style="border-radius:8px;"><i class="bi bi-person-badge me-1"></i>Assign Technician</button>`;
      }
      modalFooter.innerHTML = footerBtns;
    } catch(err) {
      modalBody.innerHTML = '<p class="text-center text-danger py-4">Failed to load order details</p>';
    }
  };

  // ═══ VERIFY PAYMENT ══════════════════════════════════════════════════════════
  window._aoVerifyPayment = async function (orderId) {
    const result = await Swal.fire({
      title:"Verify Payment?",html:`Mark payment as <strong>Paid</strong>?<br><small class="text-muted">This moves the order to "Preparing Unit".</small>`,
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

  // ═══ UTILS ════════════════════════════════════════════════════════════════════
  function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

  // ═══ INITIAL LOAD ════════════════════════════════════════════════════════════
  loadOverview(1);
});

(function() {
  'use strict';

  // Only run if we're on the Pending Review page with the repair queue tab
  const repairTab = document.getElementById('repairs-tab');
  if (!repairTab) return;

  let allRepairs = [];
  let currentFilter = 'all';
  let currentSearch = '';
  let initialized = false;

  const STATUS_LABELS = {
    repair_requested: 'New Request',
    pending_inspection: 'Pending Inspection',
    inspection_scheduled: 'Inspection Scheduled',
    inspection_in_progress: 'Inspection In Progress',
    inspection_completed: 'Diagnosis Completed',
    awaiting_approval: 'Awaiting Approval',
    repair_approved: 'Repair Approved',
    repair_declined: 'Repair Declined',
    waiting_parts: 'Waiting Parts',
    parts_reserved: 'Parts Reserved',
    ready_for_repair: 'Ready for Repair',
    repair_scheduled: 'Repair Scheduled',
    repair_in_progress: 'Repair In Progress',
    repair_completed: 'Repair Completed',
    under_warranty: 'Under Warranty',
    warranty_claim: 'Warranty Claim',
    closed: 'Closed',
  };

  function getPriorityBadge(priority) {
    const colors = { low: 'bg-success', medium: 'bg-warning text-dark', high: 'bg-danger', critical: 'bg-dark text-white' };
    return `<span class="rq-priority-badge ${colors[priority] || 'bg-secondary'}">${priority || 'normal'}</span>`;
  }

  function getStatusBadge(status) {
    const label = STATUS_LABELS[status] || status;
    return `<span class="rq-badge rq-badge-${status || 'unknown'}">${label}</span>`;
  }

  function formatDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDateTime(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' • ' +
      dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  function getTimeDisplay(b) {
    if (b.selectedTimeLabel || b.preferredTime) return b.selectedTimeLabel || b.preferredTime;
    if (b.startTime) {
      const parts = b.startTime.split(':');
      const h = parseInt(parts[0]);
      const m = parts[1];
      const ampm = h >= 12 ? 'PM' : 'AM';
      return `${h % 12 || 12}:${m} ${ampm}`;
    }
    return '—';
  }

  async function fetchRepairs() {
    try {
      const tbody = document.getElementById('rqTableBody');
      tbody.innerHTML = `<tr><td colspan="9" class="text-center py-4 text-muted">
        <div class="spinner-border spinner-border-sm text-primary mb-2" role="status"></div>
        <div>Loading repair requests...</div></td></tr>`;

      const res = await fetch('/api/admin/repair-queue?limit=200');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      allRepairs = data.items || [];
      renderTable();
      updateStats();
      updateTabCount();
      initialized = true;
    } catch (err) {
      console.error('Repair queue fetch error:', err);
      document.getElementById('rqTableBody').innerHTML =
        `<tr><td colspan="9" class="text-center py-4 text-muted">
          <i class="bi bi-exclamation-triangle" style="font-size:2rem;"></i>
          <div class="mt-2">Error loading repair requests</div></td></tr>`;
    }
  }

  function updateStats() {
    const stats = { pending: 0, inspections: 0, approval: 0, repair: 0, inProgress: 0, parts: 0 };
    allRepairs.forEach(b => {
      const s = b.status;
      if (['repair_requested', 'pending_inspection'].includes(s)) stats.pending++;
      if (['inspection_scheduled', 'inspection_in_progress'].includes(s)) stats.inspections++;
      if (s === 'awaiting_approval') stats.approval++;
      if (['repair_approved', 'ready_for_repair', 'repair_scheduled'].includes(s)) stats.repair++;
      if (s === 'repair_in_progress') stats.inProgress++;
      if (['waiting_parts', 'parts_reserved'].includes(s)) stats.parts++;
    });
    ['rqStatPending','rqStatInspections','rqStatApproval','rqStatRepair','rqStatInProgress','rqStatParts'].forEach(id => {});
    document.getElementById('rqStatPending').textContent = stats.pending;
    document.getElementById('rqStatInspections').textContent = stats.inspections;
    document.getElementById('rqStatApproval').textContent = stats.approval;
    document.getElementById('rqStatRepair').textContent = stats.repair;
    document.getElementById('rqStatInProgress').textContent = stats.inProgress;
    document.getElementById('rqStatParts').textContent = stats.parts;
  }

  function updateTabCount() {
    const el = document.getElementById('repairTabCount');
    if (el) el.textContent = allRepairs.length || '';
  }

  function filterRepairs() {
    return allRepairs.filter(b => {
      if (currentFilter !== 'all') {
        const statuses = currentFilter.split(',');
        if (!statuses.includes(b.status)) return false;
      }
      if (currentSearch) {
        const q = currentSearch.toLowerCase();
        const ref = (b.bookingReference || '').toLowerCase();
        const name = (b.customerName || b.customer?.name || '').toLowerCase();
        const issue = (b.issueDescription || '').toLowerCase();
        if (!ref.includes(q) && !name.includes(q) && !issue.includes(q)) return false;
      }
      return true;
    });
  }

  function renderTable() {
    const filtered = filterRepairs();
    const tbody = document.getElementById('rqTableBody');
    document.getElementById('rqResultCount').textContent = filtered.length;

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center py-5 text-muted">
        <i class="bi bi-inbox" style="font-size:2.5rem;"></i>
        <div class="mt-2">No repair requests found</div></td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(b => `
      <tr>
        <td><code class="small" style="cursor:pointer;color:#2563eb;" onclick="openRqDetail('${b._id}')">${b.bookingReference || '—'}</code></td>
        <td>
          <div class="fw-semibold small">${b.customerName || b.customer?.name || 'N/A'}</div>
          <div class="text-muted" style="font-size:0.7rem;">${b.customerEmail || b.customer?.email || ''}</div>
        </td>
        <td>
          <div class="small">${b.unitInfo?.brand || b.airconType || '—'}</div>
          <div style="font-size:0.7rem;color:#64748b;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(b.issueDescription || '').replace(/"/g,'&quot;')}">${(b.issueDescription || '').substring(0, 50)}${(b.issueDescription || '').length > 50 ? '…' : ''}</div>
        </td>
        <td>${getStatusBadge(b.status)}</td>
        <td>${getPriorityBadge(b.priority)}</td>
        <td><span class="small">${formatDate(b.preferredDate || b.bookingDate)}<br><span class="text-muted">${getTimeDisplay(b)}</span></span></td>
        <td><span class="small">${b.technician?.name || b.technicianName || '—'}</span></td>
        <td><span class="small text-muted">${formatDateTime(b.createdAt)}</span></td>
        <td class="text-center">
          <button class="btn btn-sm btn-outline-primary action-btn" onclick="openRqDetail('${b._id}')">
            <i class="bi bi-eye"></i>
          </button>
        </td>
      </tr>
    `).join('');
  }

  // ── Helpers ──────────────────────────────────
  function fmtAddr(b) {
    if (b.location?.address && typeof b.location.address === 'string') return b.location.address;
    const c = b.customer;
    if (c && c.address && typeof c.address === 'object') {
      const parts = [c.address.barangay, c.address.city, c.address.province].filter(Boolean);
      const zip = c.address.postalCode || '';
      return parts.join(', ') + (zip ? ' ' + zip : '');
    }
    if (b.address && typeof b.address === 'string') return b.address;
    if (b.customerAddress && typeof b.customerAddress === 'string') return b.customerAddress;
    return '—';
  }

  function fmtDist(km) {
    if (km == null || isNaN(km)) return '—';
    return Number(km).toFixed(2) + ' km';
  }

  // ── Detail Modal ──────────────────────────────
  window.openRqDetail = async function(bookingId) {
    try {
      const res = await fetch(`/api/admin/repair-queue/${bookingId}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const b = await res.json();

      const issueText = b.issueDescription || b.unitInfo?.problemDescription || 'No description';
      document.getElementById('rqDetailRef').textContent = b.bookingReference || b._id;

      const addrText = fmtAddr(b);
      const distText = fmtDist(b.distanceKm);

      document.getElementById('rqDetailBody').innerHTML = `
        <div class="ent-detail-grid">
          <div class="ent-detail-card">
            <div class="ent-detail-card-icon" style="background:#e0e7ff;color:#4338ca;"><i class="bi bi-person"></i></div>
            <div class="ent-detail-card-content">
              <div class="ent-detail-label">Customer</div>
              <div class="ent-detail-value">${b.customerName || b.customer?.name || 'N/A'}</div>
              <div class="ent-detail-sub">${b.customerEmail || b.customer?.email || ''}</div>
              <div class="ent-detail-sub">${b.customerPhone || b.customer?.phone || b.phone || ''}</div>
            </div>
          </div>
          <div class="ent-detail-card">
            <div class="ent-detail-card-icon" style="background:#d1fae5;color:#059669;"><i class="bi bi-info-circle"></i></div>
            <div class="ent-detail-card-content">
              <div class="ent-detail-label">Status</div>
              <div>${getStatusBadge(b.status)} ${getPriorityBadge(b.priority)}</div>
              <div class="ent-detail-sub" style="margin-top:2px;">${b.technician?.name || b.technicianName || 'No technician assigned'}</div>
            </div>
          </div>
          <div class="ent-detail-card">
            <div class="ent-detail-card-icon" style="background:#fef3c7;color:#d97706;"><i class="bi bi-calendar"></i></div>
            <div class="ent-detail-card-content">
              <div class="ent-detail-label">Inspection Schedule</div>
              <div class="ent-detail-value">${formatDate(b.preferredDate || b.bookingDate)}</div>
              <div class="ent-detail-sub">${getTimeDisplay(b)}</div>
            </div>
          </div>
          <div class="ent-detail-card">
            <div class="ent-detail-card-icon" style="background:#fce7f3;color:#db2777;"><i class="bi bi-laptop"></i></div>
            <div class="ent-detail-card-content">
              <div class="ent-detail-label">Unit</div>
              <div class="ent-detail-value">${b.unitInfo?.unitType || b.airconType || '—'} ${b.unitInfo?.brand || ''}</div>
              <div class="ent-detail-sub">${b.unitInfo?.model || ''}</div>
            </div>
          </div>
          <div class="ent-detail-card ent-detail-card-wide">
            <div class="ent-detail-card-icon" style="background:#dbeafe;color:#2563eb;"><i class="bi bi-chat-dots"></i></div>
            <div class="ent-detail-card-content">
              <div class="ent-detail-label">Reported Issue</div>
              <div class="ent-detail-value" style="font-weight:500;font-size:0.9rem;">${issueText}</div>
            </div>
          </div>
          <div class="ent-detail-card ent-detail-card-wide">
            <div class="ent-detail-card-icon" style="background:#f3e8ff;color:#7c3aed;"><i class="bi bi-geo-alt"></i></div>
            <div class="ent-detail-card-content">
              <div class="ent-detail-label">Service Address</div>
              <div class="ent-detail-value" style="font-weight:500;font-size:0.9rem;">${addrText}</div>
              ${b.distanceKm != null ? `<div class="ent-detail-sub">${distText}</div>` : ''}
            </div>
          </div>
        </div>
        ${(() => {
          const allPhotos = [];
          if (b.unitInfo && Array.isArray(b.unitInfo.photos)) b.unitInfo.photos.forEach(p => { if (p && !allPhotos.includes(p)) allPhotos.push(p); });
          if (b.imageUrl && !allPhotos.includes(b.imageUrl)) allPhotos.push(b.imageUrl);
          if (!allPhotos.length) return '';
          return `
          <div class="ent-detail-card ent-detail-card-wide" style="margin-top:14px;display:block;padding:16px;">
            <div class="ent-detail-label" style="margin-bottom:10px;"><i class="bi bi-images me-1"></i> Unit Photos (${allPhotos.length})</div>
            <div style="display:flex;flex-wrap:wrap;gap:10px;">
              ${allPhotos.map((src, i) => `
                <div style="flex:0 0 auto;background:#fff;padding:6px;border-radius:8px;border:1px solid #e2e8f0;box-shadow:0 1px 4px rgba(0,0,0,0.05);">
                  <img src="${src}" alt="Photo ${i + 1}" style="max-width:220px;max-height:200px;border-radius:6px;cursor:pointer;object-fit:contain;display:block;" onclick="window.open('${src}', '_blank')" onerror="this.closest('div').innerHTML='<div class=\\'text-muted small p-3\\' style=\\'text-align:center;\\'>Image unavailable</div>'">
                  <div style="margin-top:4px;text-align:center;font-size:0.68rem;color:#94a3b8;">Photo ${i + 1} · Click to enlarge</div>
                </div>`).join('')}
            </div>
          </div>`;
        })()}
        <div class="ent-detail-card ent-detail-card-wide" style="margin-top:14px;display:block;padding:0;overflow:hidden;border-color:#fed7aa;">
          <div style="background:linear-gradient(135deg,#fff7ed,#fed7aa);padding:14px 18px;border-bottom:1px solid #fed7aa;">
            <div class="ent-detail-label" style="color:#c2410c;margin:0;"><i class="bi bi-receipt me-1"></i> Inspection Payment & Proof</div>
          </div>
          <div style="padding:16px 18px;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
              <div style="background:#fff;padding:12px;border-radius:8px;border:1px solid #e2e8f0;">
                <div style="font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;margin-bottom:4px;">Inspection Fee</div>
                <div style="font-size:1.1rem;font-weight:700;color:#1e293b;">₱${(b.initialCost||0).toLocaleString()}</div>
              </div>
              <div style="background:#fff;padding:12px;border-radius:8px;border:1px solid #e2e8f0;">
                <div style="font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;margin-bottom:4px;">Travel Fare</div>
                <div style="font-size:1.1rem;font-weight:700;color:#1e293b;">₱${(b.travelFare||0).toLocaleString()}</div>
              </div>
              <div style="background:#fff;padding:12px;border-radius:8px;border:1px solid #e2e8f0;">
                <div style="font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;margin-bottom:4px;">Downpayment</div>
                <div style="font-size:1.1rem;font-weight:700;color:#059669;">₱${(b.downpaymentAmount||0).toLocaleString()}</div>
              </div>
              <div style="background:#fff;padding:12px;border-radius:8px;border:1px solid #e2e8f0;">
                <div style="font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;margin-bottom:4px;">Balance Due</div>
                <div style="font-size:1.1rem;font-weight:700;color:${(b.balanceAmount||0) > 0 ? '#dc2626' : '#059669'};">₱${(b.balanceAmount||0).toLocaleString()}</div>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:0.82rem;color:#64748b;">
              <span>Method: <strong style="color:#1e293b;">${(b.paymentMethod||'—').toUpperCase()}</strong></span>
              ${b.amountPaid ? `<span>|</span><span>Paid: <strong style="color:#059669;">₱${b.amountPaid.toLocaleString()}</strong></span>` : ''}
            </div>
            ${b.paymentProof ? `
            <div style="border-top:1px solid #f1f5f9;padding-top:12px;">
              <div style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;margin-bottom:8px;"><i class="bi bi-camera me-1"></i> Payment Proof / Screenshot</div>
              <div style="background:#fff;padding:8px;border-radius:10px;border:1px solid #e2e8f0;display:inline-block;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
                <img src="${b.paymentProof}" alt="Payment Proof" style="max-width:320px;max-height:280px;border-radius:8px;cursor:pointer;object-fit:contain;display:block;" onclick="window.open('${b.paymentProof}', '_blank')" onerror="this.parentElement.innerHTML='<div style=\\'padding:24px;text-align:center;color:#94a3b8;font-size:0.85rem;\\'>Proof image unavailable</div>'">
              </div>
              <div style="margin-top:6px;font-size:0.72rem;color:#94a3b8;"><i class="bi bi-info-circle me-1"></i>Click image to view full size</div>
            </div>
            ` : `
            <div style="border-top:1px solid #f1f5f9;padding-top:12px;">
              <div style="padding:12px;background:#fef2f2;border:1px dashed #fecaca;border-radius:8px;text-align:center;color:#94a3b8;font-size:0.82rem;">
                <i class="bi bi-exclamation-circle me-1" style="color:#dc2626;"></i> No payment proof uploaded yet
              </div>
            </div>
            `}
          </div>
        </div>
        ${b.technicianAssistant?.summary ? `
        <div class="ent-detail-card ent-detail-card-wide" style="margin-top:14px;display:block;padding:16px;background:#f0f9ff;border-color:#bae6fd;">
          <div class="ent-detail-label" style="color:#0369a1;margin-bottom:8px;"><i class="bi bi-robot me-1"></i> AI Technician Assistant</div>
          <div style="font-size:0.88rem;margin-bottom:10px;line-height:1.5;">${b.technicianAssistant.summary}</div>
          ${b.technicianAssistant.probableCauses?.length ? `
          <div style="margin-bottom:4px;"><strong style="font-size:0.8rem;color:#0284c7;">Probable Causes</strong></div>
          <ol style="margin:0 0 10px 0;padding-left:20px;font-size:0.82rem;">
            ${b.technicianAssistant.probableCauses.map(c => `<li style="margin-bottom:2px;">${c}</li>`).join('')}
          </ol>` : ''}
          ${b.technicianAssistant.suggestedTools?.length ? `
          <div style="margin-bottom:4px;"><strong style="font-size:0.8rem;color:#0284c7;">Suggested Tools</strong></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px;">
            ${b.technicianAssistant.suggestedTools.map(t => `<span style="background:#e0f2fe;color:#0369a1;padding:2px 10px;border-radius:4px;font-size:0.75rem;">${t}</span>`).join('')}
          </div>` : ''}
          ${b.technicianAssistant.possibleParts?.length ? `
          <div style="margin-bottom:4px;"><strong style="font-size:0.8rem;color:#0284c7;">Possible Parts Needed</strong></div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;">
            ${b.technicianAssistant.possibleParts.map(p => `<span style="background:#fef3c7;color:#92400e;padding:2px 10px;border-radius:4px;font-size:0.75rem;">${p}</span>`).join('')}
          </div>` : ''}
        </div>` : ''}
        ${b.inspection?.findings ? `
        <div class="ent-detail-card ent-detail-card-wide" style="margin-top:14px;display:block;padding:16px;background:#f0fdf4;border-color:#bbf7d0;">
          <div class="ent-detail-label" style="color:#16a34a;margin-bottom:8px;"><i class="bi bi-clipboard-check me-1"></i> Inspection Findings</div>
          <div style="font-size:0.85rem;margin-bottom:4px;"><span style="color:#64748b;">Findings:</span> ${b.inspection.findings}</div>
          ${b.inspection.severity ? `<div style="font-size:0.85rem;margin-bottom:4px;"><span style="color:#64748b;">Severity:</span> <span class="badge ${b.inspection.severity === 'critical' ? 'bg-danger' : b.inspection.severity === 'major' ? 'bg-warning text-dark' : 'bg-info'}">${b.inspection.severity.toUpperCase()}</span></div>` : ''}
          ${b.inspection.recommendedAction ? `<div style="font-size:0.85rem;"><span style="color:#64748b;">Recommended:</span> ${b.inspection.recommendedAction}</div>` : ''}
        </div>` : ''}
        ${b.quotation ? `
        <div class="ent-detail-card ent-detail-card-wide" style="margin-top:14px;display:block;padding:16px;background:#fefce8;border-color:#fde68a;">
          <div class="ent-detail-label" style="color:#d97706;margin-bottom:8px;"><i class="bi bi-receipt me-1"></i> Quotation</div>
          ${(b.quotation.parts || []).map(p => `<div style="display:flex;justify-content:space-between;font-size:0.85rem;padding:3px 0;"><span>${p.name} ×${p.quantity || 1}</span><span style="font-weight:600;">₱${((p.cost||0)*(p.quantity||1)).toLocaleString()}</span></div>`).join('')}
          <div style="display:flex;justify-content:space-between;font-size:0.85rem;padding:3px 0;"><span>Labor</span><span style="font-weight:600;">₱${(b.quotation.laborCost||0).toLocaleString()}</span></div>
          <hr style="margin:6px 0;border-color:#fde68a;">
          <div style="display:flex;justify-content:space-between;font-size:1rem;font-weight:700;color:#92400e;"><span>Total</span><span>₱${(b.quotation.totalCost||0).toLocaleString()}</span></div>
        </div>` : ''}
        ${b.approval?.status && b.approval.status !== 'pending' ? `
        <div class="ent-detail-card ent-detail-card-wide" style="margin-top:14px;display:block;padding:16px;border-color:${b.approval.status === 'approved' ? '#bbf7d0' : '#fecaca'};background:${b.approval.status === 'approved' ? '#f0fdf4' : '#fef2f2'};">
          <div class="ent-detail-label" style="color:${b.approval.status === 'approved' ? '#16a34a' : '#dc2626'};"><i class="bi ${b.approval.status === 'approved' ? 'bi-check-circle' : 'bi-x-circle'} me-1"></i> Customer ${b.approval.status === 'approved' ? 'Approved' : 'Declined'}</div>
        </div>` : ''}
        <div style="margin-top:14px;">
          <div class="ent-detail-label" style="margin-bottom:6px;">Status History</div>
          <div style="max-height:120px;overflow-y:auto;border:1px solid #f1f5f9;border-radius:8px;padding:4px 8px;">
            ${(b.statusHistory || []).slice(-5).reverse().map(h => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f8fafc;font-size:0.8rem;">
                <span class="rq-badge rq-badge-${h.status || h.toStatus || 'unknown'}">${STATUS_LABELS[h.status || h.toStatus] || h.status || h.toStatus || '—'}</span>
                <span class="text-muted" style="font-size:0.75rem;">${formatDateTime(h.timestamp || h.date)}</span>
              </div>
            `).join('') || '<div class="text-muted" style="font-size:0.8rem;padding:8px 0;">No history recorded</div>'}
          </div>
        </div>
      `;

      const footer = document.getElementById('rqDetailFooter');
      let actions = '';
      const s = b.status;
      const terminalStatuses = ['cancelled', 'closed', 'repair_completed', 'repair_declined', 'rejected'];
      const isTerminal = terminalStatuses.includes(s);

      if (s === 'repair_requested') {
        actions = `
          <button class="btn btn-success btn-sm" onclick="confirmRqRepair('${b._id}')"><i class="bi bi-check-circle"></i> Confirm</button>
          <button class="btn btn-outline-danger btn-sm ms-2" onclick="rejectRqRepair('${b._id}')"><i class="bi bi-x-circle"></i> Reject</button>
        `;
      } else if (s === 'awaiting_assignment') {
        actions = `
          <button class="btn btn-primary btn-sm" onclick="openAssignTechModal('${b._id}')"><i class="bi bi-person-plus"></i> Assign Technician</button>
          <button class="btn btn-outline-danger btn-sm ms-2" onclick="cancelRqRepair('${b._id}')"><i class="bi bi-x-circle"></i> Cancel</button>
        `;
      } else if (s === 'assigned') {
        actions = `<span class="text-muted small"><i class="bi bi-person-check me-1"></i>Technician assigned — waiting for acceptance</span>`;
      } else if (s === 'inspection_scheduled' || s === 'inspection_in_progress') {
        actions = `<span class="text-muted small"><i class="bi bi-search me-1"></i>Inspection in progress</span>`;
      } else if (s === 'inspection_completed') {
        actions = `<span class="text-muted small"><i class="bi bi-clipboard-check me-1"></i>Inspection completed — quotation pending</span>`;
      } else if (s === 'awaiting_approval') {
        actions = `
          <button class="btn btn-success btn-sm" onclick="approveRqQuotation('${b._id}')"><i class="bi bi-check-circle"></i> Approve Quotation</button>
          <button class="btn btn-outline-danger btn-sm ms-2" onclick="declineRqQuotation('${b._id}')"><i class="bi bi-x-circle"></i> Decline</button>
        `;
      } else if (s === 'repair_approved') {
        actions = `
          <button class="btn btn-primary btn-sm" onclick="scheduleRqRepair('${b._id}')"><i class="bi bi-calendar-plus"></i> Schedule Repair</button>
          <button class="btn btn-outline-danger btn-sm ms-2" onclick="cancelRqRepair('${b._id}')"><i class="bi bi-x-circle"></i> Cancel</button>
        `;
      } else if (s === 'repair_scheduled') {
        actions = `<span class="text-muted small"><i class="bi bi-calendar-check me-1"></i>Repair scheduled</span>`;
      } else if (s === 'repair_in_progress') {
        actions = `<span class="text-muted small"><i class="bi bi-tools me-1"></i>Repair in progress</span>`;
      } else if (s === 'waiting_parts' || s === 'parts_reserved') {
        actions = `
          <button class="btn btn-success btn-sm" onclick="receiveRqParts('${b._id}')"><i class="bi bi-box-seam"></i> Receive Parts</button>
          <span class="text-muted small ms-2"><i class="bi bi-hourglass-split me-1"></i>Waiting for parts procurement</span>
        `;
      } else if (s === 'ready_for_repair') {
        actions = `<button class="btn btn-primary btn-sm" onclick="scheduleRqRepair('${b._id}')"><i class="bi bi-calendar-plus"></i> Schedule Repair</button>`;
      } else if (s === 'repair_completed') {
        actions = `<span class="text-muted small"><i class="bi bi-check-circle me-1"></i>Repair completed</span>`;
      } else if (s === 'under_warranty') {
        actions = `<span class="text-muted small"><i class="bi bi-shield-check me-1"></i>Under warranty</span>`;
      }

      // Add cancel button for non-terminal statuses (except those already handled)
      if (!isTerminal && !['repair_requested', 'awaiting_approval', 'repair_in_progress', 'repair_scheduled', 'repair_completed', 'under_warranty'].includes(s)) {
        const cancelBtn = `<button class="btn btn-outline-danger btn-sm ms-2" onclick="cancelRqRepair('${b._id}')"><i class="bi bi-x-circle"></i> Cancel</button>`;
        actions = actions ? actions + cancelBtn : cancelBtn;
      }

      footer.innerHTML = actions || '<span class="text-muted small">No actions available</span>';

      new bootstrap.Modal(document.getElementById('rqDetailModal')).show();
    } catch (err) {
      console.error('Detail error:', err);
      alert('Error loading repair detail');
    }
  };

  // ── Actions: Confirm Repair (moves to Assignment Queue) ──
  window.confirmRqRepair = async function(bookingId) {
    document.getElementById('rqConfirmBookingId').value = bookingId;
    bootstrap.Modal.getInstance(document.getElementById('rqDetailModal'))?.hide();
    new bootstrap.Modal(document.getElementById('rqConfirmModal')).show();
  };

  window.submitRqConfirm = async function() {
    const bookingId = document.getElementById('rqConfirmBookingId').value;
    const btn = document.querySelector('#rqConfirmModal .btn-success');
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Confirming...';

    try {
      const res = await fetch(`/api/admin/repair-queue/${bookingId}/confirm`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Confirmation failed');
      bootstrap.Modal.getInstance(document.getElementById('rqConfirmModal'))?.hide();
      fetchRepairs();
    } catch (err) {
      alert('Confirmation failed: ' + err.message);
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg me-1"></i> Yes, Confirm';
    }
  };

  // ── Actions: Assign Technician to Repair ──
  window.openAssignTechModal = async function(bookingId) {
    document.getElementById('rqAssignBookingId').value = bookingId;
    document.getElementById('rqAssignTech').value = '';
    document.getElementById('rqAssignDate').value = '';
    document.getElementById('rqAssignTime').value = '';
    document.getElementById('rqAssignPriority').value = 'normal';
    document.getElementById('rqAssignNotes').value = '';

    // Set min date to tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    document.getElementById('rqAssignDate').min = tomorrow.toISOString().split('T')[0];

    // Fetch available technicians
    const techSelect = document.getElementById('rqAssignTech');
    techSelect.innerHTML = '<option value="">Loading technicians...</option>';

    try {
      const res = await fetch(`/api/admin/appointments/${bookingId}/eligible-technicians`);
      if (!res.ok) throw new Error('Failed to fetch technicians');
      const data = await res.json();
      const techs = data.available || data.technicians || data.eligibleTechnicians || [];

      if (!techs.length) {
        techSelect.innerHTML = '<option value="">No available technicians</option>';
      } else {
        techSelect.innerHTML = '<option value="">Select technician...</option>' +
          techs.map(t => `<option value="${t._id}">${t.name || t.firstName || 'Technician'} — ${t.specialization || t.role || ''}</option>`).join('');
      }
    } catch (err) {
      techSelect.innerHTML = '<option value="">Error loading technicians</option>';
      console.error('Error fetching technicians:', err);
    }

    bootstrap.Modal.getInstance(document.getElementById('rqDetailModal'))?.hide();
    new bootstrap.Modal(document.getElementById('rqAssignModal')).show();
  };

  window.submitAssignTech = async function() {
    const bookingId = document.getElementById('rqAssignBookingId').value;
    const technicianId = document.getElementById('rqAssignTech').value;
    const scheduledDate = document.getElementById('rqAssignDate').value;
    const scheduledTime = document.getElementById('rqAssignTime').value;
    const priority = document.getElementById('rqAssignPriority').value;
    const notes = document.getElementById('rqAssignNotes').value;

    if (!technicianId) { alert('Please select a technician.'); return; }
    if (!scheduledDate) { alert('Please select an inspection date.'); return; }

    const btn = document.querySelector('#rqAssignModal .btn-primary');
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Assigning...';

    try {
      const res = await fetch(`/api/admin/repair-queue/${bookingId}/assign-technician`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ technicianId, scheduledDate, scheduledTime, priority, notes }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Assignment failed');
      bootstrap.Modal.getInstance(document.getElementById('rqAssignModal'))?.hide();
      fetchRepairs();
    } catch (err) {
      alert('Assignment failed: ' + err.message);
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg me-1"></i> Confirm Assignment';
    }
  };

  // ── Actions: Reject Repair Request ──
  window.rejectRqRepair = async function(bookingId) {
    document.getElementById('rqRejectBookingId').value = bookingId;
    document.getElementById('rqRejectReason').value = '';
    bootstrap.Modal.getInstance(document.getElementById('rqDetailModal'))?.hide();
    new bootstrap.Modal(document.getElementById('rqRejectModal')).show();
  };

  window.submitRqReject = async function() {
    const bookingId = document.getElementById('rqRejectBookingId').value;
    const reason = document.getElementById('rqRejectReason').value.trim();
    if (!reason) { alert('Please enter a rejection reason.'); return; }

    const btn = document.querySelector('#rqRejectModal .btn-danger');
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Rejecting...';

    try {
      const res = await fetch(`/api/admin/repair-queue/${bookingId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Rejection failed');
      bootstrap.Modal.getInstance(document.getElementById('rqRejectModal'))?.hide();
      fetchRepairs();
    } catch (err) {
      alert('Rejection failed: ' + err.message);
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="bi bi-x-lg me-1"></i> Reject Request';
    }
  };

  // ── Actions: Approve Quotation ────────────────
  window.approveRqQuotation = async function(bookingId) {
    document.getElementById('rqApproveQuoteBookingId').value = bookingId;
    bootstrap.Modal.getInstance(document.getElementById('rqDetailModal'))?.hide();
    new bootstrap.Modal(document.getElementById('rqApproveQuoteModal')).show();
  };

  window.submitRqApproveQuote = async function() {
    const bookingId = document.getElementById('rqApproveQuoteBookingId').value;
    const btn = document.querySelector('#rqApproveQuoteModal .btn-success');
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Approving...';

    try {
      const res = await fetch(`/api/admin/repair-queue/${bookingId}/approve-quotation`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Approval failed');
      bootstrap.Modal.getInstance(document.getElementById('rqApproveQuoteModal'))?.hide();
      fetchRepairs();
    } catch (err) {
      alert('Approval failed: ' + err.message);
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg me-1"></i> Yes, Approve';
    }
  };

  // ── Actions: Decline Quotation ────────────────
  window.declineRqQuotation = async function(bookingId) {
    document.getElementById('rqDeclineQuoteBookingId').value = bookingId;
    document.getElementById('rqDeclineQuoteReason').value = '';
    bootstrap.Modal.getInstance(document.getElementById('rqDetailModal'))?.hide();
    new bootstrap.Modal(document.getElementById('rqDeclineQuoteModal')).show();
  };

  window.submitRqDeclineQuote = async function() {
    const bookingId = document.getElementById('rqDeclineQuoteBookingId').value;
    const reason = document.getElementById('rqDeclineQuoteReason').value.trim();
    const btn = document.querySelector('#rqDeclineQuoteModal .btn-danger');
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Declining...';

    try {
      const res = await fetch(`/api/admin/repair-queue/${bookingId}/decline-quotation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || 'Quotation declined by customer' }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Decline failed');
      bootstrap.Modal.getInstance(document.getElementById('rqDeclineQuoteModal'))?.hide();
      fetchRepairs();
    } catch (err) {
      alert('Decline failed: ' + err.message);
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="bi bi-x-lg me-1"></i> Confirm Decline';
    }
  };

  // ── Actions: Cancel Repair ────────────────────
  window.cancelRqRepair = async function(bookingId) {
    const reason = prompt('Enter cancellation reason:');
    if (reason === null) return; // User cancelled the prompt

    if (!confirm('Cancel this repair request? This action cannot be undone.')) return;

    try {
      const res = await fetch(`/api/admin/repair-queue/${bookingId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || 'Cancelled by admin' }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Cancellation failed');
      bootstrap.Modal.getInstance(document.getElementById('rqDetailModal'))?.hide();
      fetchRepairs();
    } catch (err) {
      alert('Cancellation failed: ' + err.message);
    }
  };

  // ── Actions: Receive Parts ────────────────────
  window.receiveRqParts = async function(bookingId) {
    if (!confirm('Mark all parts as received? This will update the booking status to Ready for Repair.')) return;

    try {
      const res = await fetch(`/api/admin/repair-queue/${bookingId}/receive-parts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to receive parts');
      const data = await res.json();
      bootstrap.Modal.getInstance(document.getElementById('rqDetailModal'))?.hide();
      alert(data.message || 'Parts received successfully');
      fetchRepairs();
    } catch (err) {
      alert('Failed to receive parts: ' + err.message);
    }
  };

  // ── Actions: Schedule Repair ──────────────────
  window.scheduleRqRepair = async function(bookingId) {
    document.getElementById('rqScheduleBookingId').value = bookingId;

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    document.getElementById('rqScheduleDate').min = tomorrow.toISOString().split('T')[0];
    document.getElementById('rqScheduleDate').value = '';
    document.getElementById('rqScheduleNotes').value = '';

    bootstrap.Modal.getInstance(document.getElementById('rqDetailModal'))?.hide();
    new bootstrap.Modal(document.getElementById('rqScheduleModal')).show();
  };

  window.submitRqSchedule = async function() {
    const bookingId = document.getElementById('rqScheduleBookingId').value;
    const date = document.getElementById('rqScheduleDate').value;
    const time = document.getElementById('rqScheduleTime').value;
    const notes = document.getElementById('rqScheduleNotes').value;

    if (!date) { alert('Please select a repair date.'); return; }

    const btn = document.querySelector('#rqScheduleModal .btn-success');
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Saving...';

    try {
      const res = await fetch(`/api/admin/repair-queue/${bookingId}/schedule-repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repairDate: date, timeSlot: time, notes }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Scheduling failed');
      bootstrap.Modal.getInstance(document.getElementById('rqScheduleModal')).hide();
      fetchRepairs();
    } catch (err) {
      alert('Scheduling failed: ' + err.message);
    } finally {
      btn.disabled = false; btn.innerHTML = '<i class="bi bi-check-lg me-1"></i> Confirm Schedule';
    }
  };

  // ── Init on tab show ─────────────────────────
  document.addEventListener('DOMContentLoaded', function() {
    const tabEl = document.getElementById('repairs-tab');
    if (!tabEl) return;

    // Fetch when repair tab is shown
    tabEl.addEventListener('shown.bs.tab', function() {
      if (!initialized) fetchRepairs();
    });

    // Fetch immediately if tab is already active (unlikely but safe)
    if (tabEl.classList.contains('active')) {
      fetchRepairs();
    }

    // Status filter buttons
    document.querySelectorAll('#rqStatusFilter .btn').forEach(btn => {
      btn.addEventListener('click', function() {
        document.querySelectorAll('#rqStatusFilter .btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        currentFilter = this.dataset.status;
        renderTable();
        updateStats();
      });
    });

    // Search
    document.getElementById('rqSearchInput')?.addEventListener('input', function() {
      currentSearch = this.value;
      renderTable();
    });
  });
})();

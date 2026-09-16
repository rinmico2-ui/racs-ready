(function () {
  'use strict';

  var state = { kits: [], technicians: [], date: '', loading: false };
  var els = {};

  function byId(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character];
    });
  }
  function label(value) {
    return String(value || 'pending').replace(/_/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }
  function localDateKey(date) {
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, '0');
    var day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }
  function readableDate(value) {
    if (!value) return 'Unknown date';
    var parts = String(value).slice(0, 10).split('-');
    var date = parts.length === 3
      ? new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
      : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown date';
    return date.toLocaleDateString('en-PH', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' });
  }
  function readableTime(value) {
    if (!value) return 'Not confirmed';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not confirmed';
    return date.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  }
  function number(value) {
    var parsed = Number(value || 0);
    return parsed.toLocaleString('en-PH', { maximumFractionDigits: 2 });
  }
  function initials(name) {
    var parts = String(name || 'Technician').trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map(function (part) { return part.charAt(0).toUpperCase(); }).join('') || 'T';
  }
  function uniqueJobs(jobs) {
    var seen = new Set();
    return (jobs || []).filter(function (job) {
      var key = String(job.type) + ':' + String(job.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function allItems(kit) { return (kit.items || []).concat(kit.deltaItems || []); }
  function activeCustody(kit) {
    return (kit.custody || []).filter(function (row) { return row.status === 'checked_out' || row.status === 'in_use'; });
  }
  function kitState(kit) {
    if (kit.hasDelta || Number(kit.counts && kit.counts.unresolved || 0) > 0) return 'attention';
    if (kit.status === 'completed') return 'completed';
    if (kit.status === 'confirmed' || kit.status === 'in_progress') return 'ready';
    return 'pending';
  }
  function kitStateLabel(kit) {
    var current = kitState(kit);
    if (current === 'attention') return kit.hasDelta ? 'New items pending' : 'Needs attention';
    if (current === 'ready') return kit.status === 'in_progress' ? 'In progress' : 'Ready';
    if (current === 'completed') return 'Completed';
    return label(kit.status);
  }

  function setLoading(loading) {
    state.loading = loading;
    els.loading.hidden = !loading;
    els.grid.hidden = loading;
    els.refresh.disabled = loading;
    els.refresh.innerHTML = loading
      ? '<span class="spinner-border spinner-border-sm" aria-hidden="true"></span> Refreshing'
      : '<i class="bi bi-arrow-clockwise"></i> Refresh';
  }
  function showError(message) {
    els.alert.textContent = message || '';
    els.alert.classList.toggle('show', Boolean(message));
  }
  function renderMetrics(summary) {
    summary = summary || {};
    els.kitCount.textContent = number(summary.kits);
    els.readyCount.textContent = number(summary.ready);
    els.attentionCount.textContent = number(summary.attention);
    els.custodyCount.textContent = number(summary.checkedOut);
    els.usageCount.textContent = number(summary.used);
  }
  function renderTechnicians() {
    var selected = els.technician.value || 'all';
    els.technician.innerHTML = '<option value="all">All technicians</option>' + state.technicians.map(function (technician) {
      return '<option value="' + escapeHtml(technician.id) + '">' + escapeHtml(technician.name) + '</option>';
    }).join('');
    els.technician.value = state.technicians.some(function (technician) { return technician.id === selected; }) ? selected : 'all';
  }
  function matchesFilters(kit) {
    var technician = els.technician.value;
    if (technician !== 'all' && String(kit.technician && kit.technician.id) !== technician) return false;
    var status = els.status.value;
    if (status === 'custody' && activeCustody(kit).length === 0) return false;
    if (status !== 'all' && status !== 'custody' && kitState(kit) !== status) return false;
    var query = els.search.value.trim().toLowerCase();
    if (!query) return true;
    var haystack = [kit.technician && kit.technician.name, kit.status];
    allItems(kit).forEach(function (item) {
      haystack.push(item.name, item.code, item.category, item.checkoutStatus);
      (item.jobs || []).forEach(function (job) { haystack.push(job.reference, job.label, job.customer); });
    });
    (kit.jobs || []).forEach(function (job) { haystack.push(job.reference, job.label, job.customer); });
    return haystack.filter(Boolean).join(' ').toLowerCase().includes(query);
  }
  function itemIcon(category) {
    if (category === 'consumable') return 'bi-droplet-half';
    if (category === 'repair_part') return 'bi-gear-wide-connected';
    return 'bi-tools';
  }
  function cardHtml(kit) {
    var currentState = kitState(kit);
    var items = allItems(kit);
    var jobs = uniqueJobs(kit.jobs);
    var preview = items.slice(0, 4).map(function (item) {
      return '<span class="tta-item-chip"><i class="bi ' + itemIcon(item.category) + '"></i><span>' + escapeHtml(item.name) + '</span><b>×' + number(item.quantity) + '</b></span>';
    }).join('');
    if (items.length > 4) preview += '<span class="tta-item-chip tta-item-more">+' + (items.length - 4) + ' more</span>';
    if (!preview) preview = '<span class="tta-item-chip"><i class="bi bi-info-circle"></i><span>No physical items required</span></span>';
    var warnings = [];
    if (Number(kit.counts && kit.counts.unresolved || 0) > 0) warnings.push(number(kit.counts.unresolved) + ' unavailable item(s) need resolution');
    if (kit.hasDelta) warnings.push('New job requirements need technician review');
    var warningHtml = warnings.length
      ? '<div class="tta-card-warning"><i class="bi bi-exclamation-triangle-fill"></i><span>' + escapeHtml(warnings.join('. ')) + '</span></div>'
      : '';
    var jobText = jobs.length
      ? jobs.slice(0, 2).map(function (job) { return job.reference; }).join(', ') + (jobs.length > 2 ? ' +' + (jobs.length - 2) : '')
      : 'No booking or order links';
    return '<article class="tta-card ' + (currentState === 'attention' ? 'tta-card-attention' : '') + '" data-kit-id="' + escapeHtml(kit.id) + '">' +
      '<div class="tta-card-head"><div class="tta-person"><span class="tta-avatar">' + escapeHtml(initials(kit.technician && kit.technician.name)) + '</span><div><h2>' + escapeHtml(kit.technician && kit.technician.name || 'Unassigned technician') + '</h2><p>' + escapeHtml(readableDate(state.date)) + ' · ' + escapeHtml(kit.technician && kit.technician.availabilityStatus || 'Status unavailable') + '</p></div></div>' +
      '<span class="tta-status tta-status-' + currentState + '"><i class="bi ' + (currentState === 'ready' ? 'bi-check2-circle' : currentState === 'attention' ? 'bi-exclamation-triangle' : currentState === 'completed' ? 'bi-flag' : 'bi-clock') + '"></i>' + escapeHtml(kitStateLabel(kit)) + '</span></div>' +
      '<div class="tta-card-stats"><div class="tta-card-stat"><strong>' + number(kit.counts && kit.counts.jobs) + '</strong><small>Jobs</small></div><div class="tta-card-stat"><strong>' + number(kit.counts && kit.counts.equipment) + '</strong><small>Equipment</small></div><div class="tta-card-stat"><strong>' + number((kit.counts && kit.counts.consumables || 0) + (kit.counts && kit.counts.repairParts || 0)) + '</strong><small>Materials</small></div><div class="tta-card-stat"><strong>' + number(activeCustody(kit).reduce(function (sum, row) { return sum + Number(row.quantity || 0); }, 0)) + '</strong><small>Custody</small></div></div>' +
      '<div class="tta-item-preview">' + preview + '</div>' + warningHtml +
      '<div class="tta-card-footer"><span class="tta-card-jobs"><i class="bi bi-link-45deg"></i> ' + escapeHtml(jobText) + '</span><button class="tta-view-btn" type="button" data-view-kit="' + escapeHtml(kit.id) + '"><i class="bi bi-eye"></i> View Daily Kit</button></div>' +
      '</article>';
  }
  function render() {
    var filtered = state.kits.filter(matchesFilters);
    els.grid.innerHTML = filtered.map(cardHtml).join('');
    els.grid.hidden = false;
    els.empty.hidden = filtered.length !== 0;
    els.grid.style.display = filtered.length ? 'grid' : 'none';
    els.resultContext.textContent = filtered.length + ' of ' + state.kits.length + ' Daily Kit' + (state.kits.length === 1 ? '' : 's') + ' shown for ' + readableDate(state.date);
  }

  function jobLinkHtml(job) {
    return '<a class="tta-job-link" href="' + escapeHtml(job.href || '#') + '"><span class="tta-job-icon"><i class="bi ' + (job.type === 'order' ? 'bi-box-seam' : 'bi-calendar2-check') + '"></i></span><span><strong>' + escapeHtml(job.reference) + '</strong><small>' + escapeHtml(job.label || '') + (job.customer ? ' · ' + escapeHtml(job.customer) : '') + '</small></span></a>';
  }
  function itemJobsHtml(item) {
    var jobs = uniqueJobs(item.jobs);
    if (!jobs.length) return '<span class="text-muted">Shared kit</span>';
    return '<div class="tta-job-tags">' + jobs.map(function (job) { return '<span class="tta-job-tag" title="' + escapeHtml(job.label || '') + '">' + escapeHtml(job.reference) + '</span>'; }).join('') + '</div>';
  }
  function usageHtml(item) {
    if (item.category === 'equipment') return '<span class="text-muted">Reusable</span>';
    var issued = Number(item.quantityIssued || 0);
    var used = Number(item.quantityUsed || 0);
    var percent = issued > 0 ? Math.min(100, Math.round((used / issued) * 100)) : 0;
    return '<strong>' + number(used) + ' / ' + number(issued) + ' ' + escapeHtml(item.unit) + '</strong><div class="tta-usage-bar" aria-label="' + percent + '% used"><span style="width:' + percent + '%"></span></div>' + (item.quantityReturned ? '<small>' + number(item.quantityReturned) + ' returned</small>' : '');
  }
  function itemRowHtml(item) {
    var status = item.custody && item.custody.status ? item.custody.status : item.checkoutStatus;
    var issue = item.conflict && item.conflict.message
      ? '<div class="tta-issue-note"><i class="bi bi-exclamation-triangle"></i> ' + escapeHtml(item.conflict.message) + '</div>'
      : item.resolution && item.resolution.status
        ? '<div class="tta-issue-note">Resolution: ' + escapeHtml(label(item.resolution.status)) + '</div>'
        : '';
    return '<tr class="' + (item.isDelta ? 'tta-row-delta' : '') + '"><td><div class="tta-item-name">' + escapeHtml(item.name) + (item.isDelta ? ' <span class="badge text-bg-warning">New</span>' : '') + '</div><div class="tta-item-code">' + escapeHtml(item.code || 'No asset code') + ' · ' + escapeHtml(label(item.source)) + '</div></td>' +
      '<td><span class="tta-kind tta-kind-' + escapeHtml(item.category) + '">' + escapeHtml(label(item.category)) + '</span></td>' +
      '<td><strong>' + number(item.quantity) + '</strong> ' + escapeHtml(item.unit) + '</td>' +
      '<td><span class="tta-mini-status ' + escapeHtml(status) + '">' + escapeHtml(label(status)) + '</span>' + issue + '</td>' +
      '<td>' + usageHtml(item) + '</td><td>' + itemJobsHtml(item) + '</td></tr>';
  }
  function openDetail(id) {
    var kit = state.kits.find(function (entry) { return entry.id === id; });
    if (!kit) return;
    var items = allItems(kit);
    var jobs = uniqueJobs(kit.jobs.concat(items.flatMap(function (item) { return item.jobs || []; })));
    var custody = activeCustody(kit);
    var materialUsed = items.reduce(function (sum, item) { return sum + Number(item.quantityUsed || 0); }, 0);
    els.detailTitle.textContent = (kit.technician && kit.technician.name || 'Technician') + "'s Daily Kit";
    els.detailSubtitle.textContent = readableDate(state.date) + ' · ' + kitStateLabel(kit) + ' · Confirmed ' + readableTime(kit.confirmedAt);
    var issueBanner = kitState(kit) === 'attention'
      ? '<div class="alert alert-warning d-flex align-items-start gap-2"><i class="bi bi-exclamation-triangle-fill mt-1"></i><div><strong>Preparation needs attention.</strong><div class="small mt-1">Resolve unavailable items from the Preparation Issues section on the <a href="/admin">admin dashboard</a>. New delta items must be reviewed and confirmed by the technician.</div></div></div>'
      : '';
    var jobsHtml = jobs.length ? jobs.map(jobLinkHtml).join('') : '<div class="tta-no-items">This kit has no direct booking or installation-order links.</div>';
    var rows = items.length ? items.map(itemRowHtml).join('') : '<tr><td colspan="6" class="tta-no-items">No physical equipment or materials are required for the covered work.</td></tr>';
    els.detailBody.innerHTML = issueBanner +
      '<div class="tta-detail-summary"><div class="tta-detail-stat"><small>Preparation state</small><strong>' + escapeHtml(kitStateLabel(kit)) + '</strong></div><div class="tta-detail-stat"><small>Covered jobs</small><strong>' + number(jobs.length) + '</strong></div><div class="tta-detail-stat"><small>Active custody</small><strong>' + number(custody.reduce(function (sum, row) { return sum + Number(row.quantity || 0); }, 0)) + '</strong></div><div class="tta-detail-stat"><small>Materials used</small><strong>' + number(materialUsed) + '</strong></div></div>' +
      '<section class="tta-detail-section"><div class="tta-detail-heading"><h3><i class="bi bi-link-45deg me-1"></i> Covered bookings and orders</h3><span>' + jobs.length + ' linked</span></div><div class="tta-job-list">' + jobsHtml + '</div></section>' +
      '<section class="tta-detail-section"><div class="tta-detail-heading"><h3><i class="bi bi-tools me-1"></i> Tools and materials</h3><span>' + items.length + ' line item' + (items.length === 1 ? '' : 's') + '</span></div><div class="tta-table-wrap"><table class="tta-table"><thead><tr><th>Item</th><th>Category</th><th>Required</th><th>Custody / issue</th><th>Actual usage</th><th>Used for</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>';
    bootstrap.Modal.getOrCreateInstance(byId('ttaDetailModal')).show();
  }

  async function load() {
    if (state.loading) return;
    var date = els.date.value || localDateKey(new Date());
    state.date = date;
    setLoading(true);
    showError('');
    try {
      var response = await fetch('/api/admin/appointments/daily-kits?date=' + encodeURIComponent(date), { headers: { Accept: 'application/json' } });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || 'Could not load technician tools.');
      state.kits = Array.isArray(data.kits) ? data.kits : [];
      state.technicians = Array.isArray(data.technicians) ? data.technicians : [];
      renderMetrics(data.summary);
      renderTechnicians();
      render();
      var url = new URL(window.location.href);
      url.searchParams.set('date', date);
      window.history.replaceState({}, '', url.pathname + url.search);
    } catch (error) {
      state.kits = [];
      renderMetrics({});
      render();
      showError(error.message || 'Could not load technician tools. Please retry.');
    } finally {
      setLoading(false);
    }
  }

  function cacheElements() {
    els = {
      refresh: byId('ttaRefresh'), date: byId('ttaDate'), technician: byId('ttaTechnician'), status: byId('ttaStatus'), search: byId('ttaSearch'),
      kitCount: byId('ttaKitCount'), readyCount: byId('ttaReadyCount'), attentionCount: byId('ttaAttentionCount'), custodyCount: byId('ttaCustodyCount'), usageCount: byId('ttaUsageCount'),
      resultContext: byId('ttaResultContext'), alert: byId('ttaAlert'), loading: byId('ttaLoading'), empty: byId('ttaEmpty'), grid: byId('ttaGrid'), clearFilters: byId('ttaClearFilters'),
      detailTitle: byId('ttaDetailTitle'), detailSubtitle: byId('ttaDetailSubtitle'), detailBody: byId('ttaDetailBody')
    };
  }
  function init() {
    cacheElements();
    var queryDate = new URLSearchParams(window.location.search).get('date');
    els.date.value = /^\d{4}-\d{2}-\d{2}$/.test(queryDate || '') ? queryDate : localDateKey(new Date());
    els.refresh.addEventListener('click', load);
    els.date.addEventListener('change', load);
    els.technician.addEventListener('change', render);
    els.status.addEventListener('change', render);
    var searchTimer;
    els.search.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(render, 180); });
    els.clearFilters.addEventListener('click', function () { els.technician.value = 'all'; els.status.value = 'all'; els.search.value = ''; render(); });
    document.querySelectorAll('[data-quick-filter]').forEach(function (button) {
      button.addEventListener('click', function () { els.status.value = button.getAttribute('data-quick-filter') || 'all'; render(); });
    });
    els.grid.addEventListener('click', function (event) {
      var button = event.target.closest('[data-view-kit]');
      if (button) openDetail(button.getAttribute('data-view-kit'));
    });
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

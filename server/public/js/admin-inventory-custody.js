(() => {
  'use strict';
  function init() {
    const $ = id => document.getElementById(id);
    if (!$('icTracking')) return;
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const amount = value => value == null ? 'Not recorded' : Number(value).toLocaleString('en-PH', { maximumFractionDigits: 3 });
    const date = (value, time = false) => value ? new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', ...(time ? { hour: 'numeric', minute: '2-digit' } : {}) }) : 'Not recorded';
    const labels = { all: 'All items', equipment: 'Equipment', repair_part: 'Repair parts', consumable: 'Consumables' };
    const params = new URLSearchParams(location.search);
    const state = { page: 1, pages: 1, category: 'all', rows: new Map(), selected: null, controller: null, revision: 0, loading: false, timer: null, view: 'tracking' };
    const tabs = [...document.querySelectorAll('[data-custody-view]')];
    function activate(view, focus = false) {
      const previous = state.view;
      state.view = ['tracking', 'reports', 'followup'].includes(view) ? view : 'tracking';
      tabs.forEach(tab => {
        const selected = tab.dataset.custodyView === state.view;
        tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
        $(tab.getAttribute('aria-controls')).hidden = !selected;
        if (selected && focus) tab.focus();
      });
      const url = new URL(location.href); url.searchParams.set('view', state.view); history.replaceState(null, '', url);
      if (previous !== 'tracking' && state.view === 'tracking') load();
    }
    function activeFilters() { return state.category !== 'all' || $('icSearch').value.trim() || $('icTechnician').value || $('icDate').value || $('icStatus').value !== 'all'; }
    function paging() { $('icPrev').disabled = state.loading || state.page <= 1; $('icNext').disabled = state.loading || state.page >= state.pages; }
    function populateTechnicians(options) {
      for (const target of [$('icTechnician'), $('krTechnician')].filter(Boolean)) {
        const chosen = target.value;
        target.innerHTML = '<option value="">All technicians</option>' + options.map(tech => '<option value="' + escape(tech.id) + '">' + escape(tech.name) + (tech.archived ? ' (inactive)' : '') + '</option>').join('');
        if (chosen && !options.some(tech => tech.id === chosen)) target.add(new Option('Selected technician', chosen));
        target.value = chosen;
      }
    }
    function status(row) {
      return [row.overdue ? '<span class="ic-status danger">Overdue return</span>' : '', row.pendingQuantity ? '<span class="ic-status warning">' + amount(row.pendingQuantity) + ' awaiting receipt</span>' : '', row.checkBalance ? '<span class="ic-status warning">Check balance</span>' : ''].filter(Boolean).join(' ');
    }
    const jobLink = job => '<a href="' + escape(String(job.href || '').startsWith('/admin/') ? job.href : '#') + '">' + escape(job.reference) + '</a>';
    function render(data) {
      state.pages = data.pagination.pages;
      state.rows = new Map(data.items.map(row => [row.id, row]));
      populateTechnicians(data.technicians || []);
      const summary = data.summary, total = summary.equipment + summary.repair_part + summary.consumable;
      for (const key of ['all', 'equipment', 'repair_part', 'consumable']) $('icCount-' + key).textContent = amount(key === 'all' ? total : summary[key]);
      $('icHolderCount').textContent = amount(summary.technicians); $('icRecordCount').textContent = amount(total);
      $('icPendingCount').textContent = amount(summary.pending); $('icOverdueCount').textContent = amount(summary.overdue);
      $('icRows').innerHTML = data.items.map(row => {
        const work = row.jobs || [], job = work[0];
        return '<article class="ic-row"><div class="ic-item"><span class="ic-category">' + escape(labels[row.category] || 'Item') + '</span><strong>' + escape(row.name) + '</strong><small>' + escape(row.code || 'No item code') + '</small></div>' +
          '<div class="ic-holder"><span>' + escape(row.technician.name) + '</span><small>' + (row.technician.archived ? 'Inactive technician' : 'Current holder') + '</small></div>' +
          '<div><div class="ic-balance"><span>Issued<b>' + amount(row.quantityIssued) + '</b></span><span>' + (row.category === 'equipment' ? 'Unit' : 'Used') + '<b>' + (row.category === 'equipment' ? escape(row.unit) : amount(row.quantityUsed)) + '</b></span><span>Still held<b>' + (row.checkBalance ? 'Check balance' : amount(row.remaining) + ' ' + escape(row.unit)) + '</b></span></div>' + status(row) + '</div>' +
          '<div class="ic-work">' + (job ? jobLink(job) + (work.length > 1 ? '<small>+ ' + (work.length - 1) + ' linked job' + (work.length > 2 ? 's' : '') + '</small>' : '') : '<span>General issue</span>') + '<small>Work date: ' + escape(date(row.workDate)) + '</small></div>' +
          '<button class="btn btn-outline-primary btn-sm" type="button" data-custody-detail="' + escape(row.id) + '" aria-label="View ' + escape(row.name) + ' with ' + escape(row.technician.name) + '">View details</button></article>';
      }).join('') || '<p class="ic-empty"><i class="bi bi-inbox" aria-hidden="true"></i><br>No outstanding items match these filters.</p>';
      $('icResultHint').textContent = (activeFilters() ? 'Matching' : 'All') + ' outstanding items · ' + ($('icDate').value ? 'selected Philippine work date' : 'all work dates');
      $('icRange').textContent = data.pagination.total ? 'Showing ' + ((state.page - 1) * data.pagination.limit + 1) + '–' + Math.min(state.page * data.pagination.limit, data.pagination.total) + ' of ' + data.pagination.total + ' records' : '0 records';
      $('icUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }) + ' PHT';
    }
    async function load() {
      clearTimeout(state.timer); state.controller?.abort();
      const controller = new AbortController(), revision = ++state.revision;
      state.controller = controller; state.loading = true; state.rows.clear();
      $('icRows').setAttribute('aria-busy', 'true'); $('icRows').innerHTML = '<p class="ic-empty"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span> Loading issued items...</p>';
      $('icError').hidden = true; $('icClear').hidden = !activeFilters(); $('icResultHint').textContent = 'Loading matching items...'; paging();
      const query = new URLSearchParams({ category: state.category, status: $('icStatus').value, search: $('icSearch').value.trim(), technicianId: $('icTechnician').value, date: $('icDate').value, page: state.page, limit: 8 });
      try {
        const response = await fetch('/api/admin/appointments/inventory-custody?' + query, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not load item tracking. Please try again.');
        if (!Array.isArray(data.items) || !data.pagination || !data.summary) throw new Error('Could not load item tracking. Refresh the page and try again.');
        if (revision !== state.revision) return;
        if (state.page > data.pagination.pages) { state.page = data.pagination.pages; return load(); }
        render(data);
      } catch (error) {
        if (error.name === 'AbortError' || revision !== state.revision) return;
        $('icError').querySelector('span').textContent = error.message;
        $('icError').hidden = false; $('icRows').innerHTML = ''; $('icRange').textContent = ''; $('icResultHint').textContent = 'Item tracking could not be loaded.'; $('icUpdated').textContent = '';
        for (const target of document.querySelectorAll('.ic-summary strong, .ic-categories b')) target.textContent = '—';
      } finally { if (revision === state.revision) { state.loading = false; $('icRows').setAttribute('aria-busy', 'false'); paging(); } }
    }
    function filter() { state.page = 1; load(); }
    function openDetail(row) {
      state.selected = row;
      const values = row.category === 'equipment'
        ? [['Issued', row.quantityIssued], ['Still held', row.remaining], ['Awaiting receipt', row.pendingQuantity]]
        : [['Issued', row.quantityIssued], ['Recorded used', row.quantityUsed], ['Still held', row.remaining], ['Received back', row.quantityReturned], ['Damaged', row.quantityDamaged], ['Missing', row.quantityMissing]];
      $('icDetailBody').innerHTML = '<span class="ic-category">' + escape(labels[row.category]) + '</span><div class="ic-detail-item">' + escape(row.name) + '</div><p class="ic-detail-sub">' + escape(row.code || 'No item code') + ' · ' + escape(row.technician.name) + '</p>' + status(row) +
        '<dl class="ic-detail-facts">' + values.map(([label, value]) => '<div><dt>' + label + '</dt><dd>' + (value == null ? 'Not recorded' : amount(value) + ' ' + escape(row.unit)) + '</dd></div>').join('') + '</dl>' +
        '<p class="ic-detail-date">Work date: ' + escape(date(row.workDate)) + '</p><p class="ic-detail-date">Issued: ' + escape(date(row.issuedAt, true)) + '</p>' + (row.expectedReturnAt ? '<p class="ic-detail-date">Return due: ' + escape(date(row.expectedReturnAt, true)) + ' PHT</p>' : '') +
        '<p class="ic-detail-note">' + (row.checkBalance ? 'This older material issue has no recorded usage balance. Check the remaining quantity with the technician before reconciling it.' : row.pendingQuantity ? amount(row.pendingQuantity) + ' ' + escape(row.unit) + ' reported for return. These items remain outstanding until admin checks and confirms receipt.' : 'This view reflects recorded issues and usage. Confirm physical returns through Return reports or Equipment follow-up.') + '</p>' +
        '<h6>Linked work' + (row.jobs.length > 1 ? ' · shared item' : '') + '</h6>' + (row.jobs.length ? '<ul class="ic-detail-jobs">' + row.jobs.map(job => '<li>' + jobLink(job) + '<small>' + escape(job.type) + ' · ' + escape(String(job.status || '').replace(/_/g, ' ')) + '</small></li>').join('') + '</ul>' : '<p class="ic-detail-sub">General issue. No individual job is linked to this record.</p>');
      $('icDetailAction').hidden = !(row.pendingQuantity || row.source === 'equipment_assignment' && row.category === 'equipment');
      $('icDetailAction').textContent = row.pendingQuantity ? 'Review returns' : 'Equipment follow-up';
      bootstrap.Modal.getOrCreateInstance($('icDetailModal')).show();
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(tab.dataset.custodyView));
      tab.addEventListener('keydown', event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        if (next != null) { event.preventDefault(); activate(tabs[next].dataset.custodyView, true); }
      });
    });
    document.querySelectorAll('[data-custody-category]').forEach(button => button.addEventListener('click', () => {
      state.category = button.dataset.custodyCategory;
      document.querySelectorAll('[data-custody-category]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); filter();
    }));
    for (const key of ['icTechnician', 'icDate', 'icStatus']) $(key).addEventListener('change', filter);
    $('icSearch').addEventListener('input', () => {
      clearTimeout(state.timer); state.controller?.abort(); state.revision++; state.rows.clear(); state.loading = true; paging();
      $('icRows').innerHTML = '<p class="ic-empty">Searching...</p>'; $('icRows').setAttribute('aria-busy', 'true'); state.timer = setTimeout(filter, 250);
    });
    $('icClear').addEventListener('click', () => {
      state.category = 'all'; $('icSearch').value = ''; $('icTechnician').value = ''; $('icDate').value = ''; $('icStatus').value = 'all';
      document.querySelectorAll('[data-custody-category]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.custodyCategory === 'all'))); filter();
    });
    $('icRows').addEventListener('click', event => { const button = event.target.closest('[data-custody-detail]'); if (button && state.rows.has(button.dataset.custodyDetail)) openDetail(state.rows.get(button.dataset.custodyDetail)); });
    $('icDetailAction').addEventListener('click', () => {
      const row = state.selected; if (!row) return;
      $('icDetailModal').addEventListener('hidden.bs.modal', () => {
        if (row.pendingQuantity) {
          activate('reports', true);
          const target = $('krTechnician');
          if (![...target.options].some(option => option.value === row.technician.id)) target.add(new Option(row.technician.name, row.technician.id));
          target.value = row.technician.id; $('krStatus').value = 'pending'; target.dispatchEvent(new Event('change'));
        } else {
          activate('followup', true); $('erSearch').value = row.code || row.name; $('erState').value = 'open'; $('erState').dispatchEvent(new Event('change')); $('erSearch').dispatchEvent(new Event('input'));
        }
      }, { once: true });
      bootstrap.Modal.getOrCreateInstance($('icDetailModal')).hide();
    });
    $('icPrev').addEventListener('click', () => { if (!state.loading && state.page > 1) { state.page--; load(); } });
    $('icNext').addEventListener('click', () => { if (!state.loading && state.page < state.pages) { state.page++; load(); } });
    $('icRetry').addEventListener('click', load);
    $('erRefresh').addEventListener('click', () => { load(); $('krRefresh').click(); });
    window.addEventListener('inventory:changed', load);
    window.setInterval(() => { if (!document.hidden && state.view === 'tracking' && !state.loading && !$('icDetailModal').classList.contains('show')) load(); }, 60000);
    activate(params.get('view') || (params.has('state') ? 'followup' : 'tracking'));
    load();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();

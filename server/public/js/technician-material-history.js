/* Read-only materials recorded against the technician's work. */
(() => {
  'use strict';
  const panel = document.getElementById('ttMaterialsUsedPanel');
  if (!panel) return;
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const state = { active: false, page: 1, search: '', sequence: 0, controller: null, timer: null, loading: false };
  const date = value => {
    if (!value) return 'Date not recorded';
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Date not recorded';
  };
  const quantity = value => Number(value || 0).toLocaleString('en-PH', { maximumFractionDigits: 4 });
  const label = source => ({ booking: 'Booking', order: 'Order', project: 'Project', unlinked: 'Unlinked record' })[source] || 'Work record';

  function render(data) {
    const pagination = data.pagination || { page: 1, pages: 1, total: 0 };
    const jobs = data.items || [];
    $('ttHistoryContext').textContent = `${pagination.total} work record${pagination.total === 1 ? '' : 's'}${pagination.total ? ` · Page ${pagination.page} of ${pagination.pages}` : ''}`;
    $('ttHistoryRecords').innerHTML = jobs.length ? jobs.map(job => `<article class="tt-history-job">
      <header><div><span class="tt-badge tt-badge-blue">${escape(label(job.source))}</span><h3>${escape(job.reference)}</h3></div><span class="tt-history-date">Last recorded ${escape(date(job.lastUsedAt))}</span></header>
      <div class="tt-history-table"><div class="tt-history-head" aria-hidden="true"><span>Material</span><span>Quantity used</span><span>Recorded</span></div>${(job.items || []).map(item => `<div class="tt-history-item"><div><strong>${escape(item.name)}</strong><small>${item.type === 'part' ? 'Repair part' : 'Consumable'}${item.stage === 'repair' ? ' · Repair completion' : ''}</small></div><span class="tt-history-quantity">${escape(quantity(item.quantity))} ${escape(item.unit)}</span><time>${escape(date(item.usedAt))}</time></div>`).join('')}</div>
      ${job.recordCount > job.items.length ? `<p class="tt-history-truncated">Showing the latest ${job.items.length} of ${job.recordCount} entries for this work. Narrow the dates to review older entries.</p>` : ''}
    </article>`).join('') : '<div class="tt-empty"><i class="bi bi-journal-check" aria-hidden="true"></i><h3>No materials used to show</h3><p>Try another date or filter. Saved repair-part and consumable usage appears here after it is recorded for your work.</p></div>';
    $('ttHistoryPagination').innerHTML = pagination.pages > 1 ? `<button class="tt-button tt-button-secondary" type="button" data-history-page="${pagination.page - 1}" ${pagination.page <= 1 ? 'disabled' : ''}>Previous</button><span>Page ${pagination.page} of ${pagination.pages}</span><button class="tt-button tt-button-secondary" type="button" data-history-page="${pagination.page + 1}" ${pagination.page >= pagination.pages ? 'disabled' : ''}>Next</button>` : '';
  }

  async function load() {
    if (!state.active) return;
    const sequence = ++state.sequence;
    state.controller?.abort();
    state.controller = new AbortController();
    state.loading = true;
    panel.setAttribute('aria-busy', 'true');
    $('ttHistoryRecords').setAttribute('aria-busy', 'true');
    $('ttHistoryContext').textContent = 'Loading materials used…';
    $('ttHistoryPagination').innerHTML = '';
    $('ttHistoryRecords').innerHTML = '<div class="tt-empty"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span><p>Loading your history…</p></div>';
    const query = new URLSearchParams({ page: String(state.page), q: state.search,
      source: $('ttHistorySource').value, type: $('ttHistoryType').value,
      from: $('ttHistoryFrom').value, to: $('ttHistoryTo').value });
    try {
      const response = await fetch('/api/technician/tools/material-history?' + query, { credentials: 'same-origin', cache: 'no-store', signal: state.controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load materials used. Please try again.');
      if (sequence !== state.sequence || !state.active) return;
      if (state.page > data.pagination.pages) { state.page = data.pagination.pages; return load(); }
      render(data);
    } catch (error) {
      if (sequence !== state.sequence || !state.active || error.name === 'AbortError') return;
      $('ttHistoryContext').textContent = 'History could not be loaded';
      $('ttHistoryRecords').innerHTML = `<div class="tt-empty" role="alert"><h3>Could not load your history</h3><p>${escape(error.message)}</p><button class="tt-button tt-button-secondary" type="button" data-history-retry>Try again</button></div>`;
    } finally {
      if (sequence === state.sequence) { state.loading = false; panel.setAttribute('aria-busy', 'false'); $('ttHistoryRecords').setAttribute('aria-busy', 'false'); }
    }
  }
  window.addEventListener('technician-tools-category', event => {
    state.active = event.detail?.category === 'used';
    clearTimeout(state.timer);
    if (state.active) { state.page = 1; state.search = ''; load(); }
    else { state.sequence++; state.controller?.abort(); state.loading = false; panel.setAttribute('aria-busy', 'false'); $('ttHistoryRecords').setAttribute('aria-busy', 'false'); }
  });
  window.addEventListener('technician-material-search', event => {
    state.search = event.detail?.search || ''; state.page = 1;
    state.sequence++; state.controller?.abort(); clearTimeout(state.timer);
    state.timer = setTimeout(load, 250);
  });
  window.addEventListener('technician-material-refresh', () => { clearTimeout(state.timer); load(); });
  $('ttHistoryFilters').addEventListener('submit', event => event.preventDefault());
  $('ttHistoryFilters').addEventListener('change', () => { state.page = 1; clearTimeout(state.timer); load(); });
  $('ttHistoryReset').addEventListener('click', () => {
    $('ttHistoryFilters').reset(); $('ttSearch').value = ''; state.search = ''; state.page = 1; clearTimeout(state.timer); load();
  });
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-history-retry')) return load();
    if (button.hasAttribute('data-history-page') && !state.loading) { state.page = Number(button.dataset.historyPage); load(); }
  });
})();

(function () {
  'use strict';
  const config = JSON.parse(document.getElementById('techLeavesInitial').textContent);
  const tbody = document.getElementById('leavesTableBody');
  const footer = document.getElementById('leavesFooter');
  const search = document.getElementById('leaveSearch');
  const feedback = document.getElementById('leaveFeedback');
  const modalEl = document.getElementById('reviewModal');
  const noteEl = document.getElementById('reviewNote');
  const errorEl = document.getElementById('reviewError');
  const approve = document.getElementById('btnApproveLeave');
  const reject = document.getElementById('btnRejectLeave');
  const refreshButton = document.getElementById('refreshLeaves');
  const inFlight = new Set();
  let items = config.items;
  let filter = 'all';
  let page = 1;
  let selected = null;
  let refreshing = false;
  let reviewing = false;
  const pageSize = 10;
  const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const date = value => {
    const day = new Date(value);
    return Number.isFinite(day.getTime()) ? day.toLocaleDateString('en-PH', {
      timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric',
    }) : '—';
  };
  const range = item => date(item.startDate) === date(item.endDate) ? date(item.startDate) : `${date(item.startDate)} – ${date(item.endDate)}`;
  function message(text, failed) {
    feedback.className = 'alert ' + (failed ? 'alert-danger' : 'alert-success');
    feedback.textContent = text;
  }
  function render() {
    const query = search.value.trim().toLowerCase();
    const visible = items.filter(item => (filter === 'all' || item.status === filter)
      && [item.technician?.name, item.technician?.email].filter(Boolean).join(' ').toLowerCase().includes(query));
    for (const status of ['pending', 'approved', 'rejected']) {
      document.getElementById('kpi' + status[0].toUpperCase() + status.slice(1)).textContent = items.filter(item => item.status === status).length;
    }
    const pending = items.filter(item => item.status === 'pending').length;
    document.getElementById('pendingCountHero').textContent = pending;
    document.getElementById('pendingBadgeHero').style.display = pending ? '' : 'none';
    document.getElementById('resultCount').textContent = visible.length;
    document.getElementById('totalCount').textContent = items.length === 500 ? 'Latest 500 requests' : `${items.length} total requests`;
    const pages = Math.max(1, Math.ceil(visible.length / pageSize));
    page = Math.min(page, pages);
    tbody.innerHTML = visible.slice((page - 1) * pageSize, page * pageSize).map(item => {
      const id = escape(item._id);
      const status = ['pending', 'approved', 'rejected'].includes(item.status) ? item.status : 'pending';
      const color = { pending: 'warning', approved: 'success', rejected: 'danger' }[status];
      const days = Math.max(1, Math.round((new Date(item.endDate) - new Date(item.startDate)) / 86400000) + 1) || 1;
      const actions = config.canManage ? `<div class="d-flex gap-2 justify-content-end">
        ${status === 'pending' ? `<button type="button" class="btn btn-sm btn-outline-success" data-approve="${id}" ${inFlight.has(String(item._id)) ? 'disabled' : ''}>Approve</button>` : ''}
        <button type="button" class="btn btn-sm btn-outline-secondary" data-review="${id}" ${inFlight.has(String(item._id)) ? 'disabled' : ''}>${status === 'pending' ? 'Review' : 'Edit decision'}</button></div>`
        : '<span class="text-muted small">View only</span>';
      return `<tr><td class="ps-4"><div class="fw-semibold">${escape(item.technician?.name || item.technician?.email || 'Unknown')}</div><div class="text-muted small">${escape(item.technician?.email)}</div></td>
        <td>${range(item)}</td><td>${days} day${days === 1 ? '' : 's'}</td>
        <td style="max-width:240px;white-space:pre-wrap;overflow-wrap:anywhere">${escape(item.reason) || '—'}</td><td>${date(item.createdAt)}</td>
        <td><span class="badge bg-${color}-subtle text-${color}">${status[0].toUpperCase() + status.slice(1)}</span>
        ${item.adminNote ? `<div class="text-muted small mt-1" style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(item.adminNote)}</div>` : ''}</td>
        <td class="text-end pe-4">${actions}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="text-center py-4 text-muted">No leave requests found.</td></tr>';
    footer.innerHTML = `<nav aria-label="Leave pagination" class="d-flex gap-2 justify-content-end align-items-center">
      <button type="button" class="btn btn-sm btn-light border" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>Previous</button>
      <span class="small">${page} / ${pages}</span><button type="button" class="btn btn-sm btn-light border" data-page="${page + 1}" ${page === pages ? 'disabled' : ''}>Next</button></nav>`;
  }
  async function refresh() {
    if (refreshing || reviewing || inFlight.size || modalEl.classList.contains('show')) return;
    refreshing = true;
    refreshButton.disabled = true;
    try {
      const result = await RACSRequest.json(config.apiBase, { cache: 'no-store' });
      if (!Array.isArray(result.items)) throw Error('The server returned an unexpected leave list. Please refresh.');
      items = result.items;
      render();
      if (feedback.classList.contains('alert-danger')) feedback.classList.add('d-none');
    } catch (error) { message(error.message, true); }
    finally { refreshing = false; refreshButton.disabled = false; }
  }
  async function save(item, status, note) {
    return RACSRequest.json(`${config.apiBase}/${encodeURIComponent(item._id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, adminNote: note, expectedStatus: item.status, expectedReviewedAt: item.reviewedAt || null }),
    });
  }
  function update(result) {
    if (!result.leave?._id) throw Error('The server did not return the updated decision. Refresh to check its status.');
    items = items.map(item => String(item._id) === String(result.leave._id) ? result.leave : item);
    render();
    message(result.message || 'Leave decision saved.', false);
  }
  function openReview(id) {
    if (!config.canManage || reviewing || refreshing || inFlight.has(id)) return;
    const item = items.find(item => String(item._id) === id);
    if (!item) return;
    selected = { ...item };
    document.getElementById('reviewSummary').textContent = `${item.technician?.name || 'Technician'} · ${range(item)}${item.reason ? '\n' + item.reason : ''}`;
    noteEl.value = item.adminNote || '';
    errorEl.classList.add('d-none');
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
  }
  tbody.addEventListener('click', async event => {
    const review = event.target.closest('[data-review]');
    if (review) return openReview(review.dataset.review);
    const button = event.target.closest('[data-approve]');
    if (!config.canManage || !button || inFlight.has(button.dataset.approve) || reviewing || refreshing) return;
    const id = button.dataset.approve;
    const item = items.find(item => String(item._id) === id);
    if (!item) return;
    inFlight.add(id);
    render();
    try { update(await save(item, 'approved', item.adminNote || '')); }
    catch (error) { message(error.message, true); }
    finally { inFlight.delete(id); render(); }
  });
  async function submit(status) {
    if (!config.canManage || !selected || reviewing || refreshing || inFlight.size) return;
    reviewing = true;
    approve.disabled = reject.disabled = true;
    errorEl.classList.add('d-none');
    try {
      update(await save(selected, status, noteEl.value));
      reviewing = false;
      bootstrap.Modal.getInstance(modalEl)?.hide();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.classList.remove('d-none');
    } finally { reviewing = false; approve.disabled = reject.disabled = false; }
  }
  // Keep the selected request and note visible until the server finishes saving.
  modalEl.addEventListener('hide.bs.modal', event => { if (reviewing) event.preventDefault(); });
  approve.addEventListener('click', () => submit('approved'));
  reject.addEventListener('click', () => submit('rejected'));
  document.getElementById('leaveTabs').addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    filter = button.dataset.filter;
    page = 1;
    document.querySelectorAll('#leaveTabs [data-filter]').forEach(tab => tab.classList.toggle('active', tab === button));
    render();
  });
  search.addEventListener('input', () => { page = 1; render(); });
  document.getElementById('clearLeaveSearch').addEventListener('click', () => { search.value = ''; page = 1; render(); });
  footer.addEventListener('click', event => {
    const button = event.target.closest('[data-page]');
    if (button && !button.disabled) { page = Number(button.dataset.page); render(); }
  });
  refreshButton.addEventListener('click', refresh);
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  render();
})();

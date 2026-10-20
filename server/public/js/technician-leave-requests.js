(function () {
  'use strict';
  function init() {
    const get = id => document.getElementById(id);
    const form = get('leaveForm'), modal = get('leaveModal');
    if (!form || !modal) return;
    const esc = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const dayKey = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(value));
    const date = value => new Date(value).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' });
    const range = item => date(item.startDate) + (dayKey(item.startDate) === dayKey(item.endDate) ? '' : ' – ' + date(item.endDate));
    const status = item => ({ pending: 'Pending approval', approved: 'Approved', rejected: 'Not approved' })[item.status] || 'Pending approval';
    const badge = item => '<span class="badge bg-' + ({ pending: 'warning text-dark', approved: 'success', rejected: 'secondary' })[item.status] + '">' + status(item) + '</span>';

    const leaveStart = document.getElementById('leaveStart');
    const leaveEnd = document.getElementById('leaveEnd');
    function syncLeaveDates() {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
      leaveStart.min = today;
      leaveEnd.min = leaveStart.value && leaveStart.value > today ? leaveStart.value : today;
      leaveEnd.setCustomValidity(leaveEnd.value && leaveEnd.value < leaveEnd.min
        ? 'End date must be on or after the start date and cannot be in the past.' : '');
    }
    leaveStart.addEventListener('input', syncLeaveDates);
    leaveStart.addEventListener('change', syncLeaveDates);
    leaveEnd.addEventListener('input', syncLeaveDates);
    leaveEnd.addEventListener('change', syncLeaveDates);
    syncLeaveDates();

    // Leave request state
    let items = [], unavailable = [], loaded = false, availabilityFailed = false, refreshing, submitting = false, showAll = false;
    const submit = form.querySelector('[type="submit"]');
    const feedback = (message, failed) => {
      const node = get('leaveFeedback'); node.hidden = !message;
      node.className = 'alert ' + (failed ? 'alert-danger' : 'alert-success') + ' mx-3 mt-3 mb-0';
      node.textContent = message;
    };
    function validateRange() {
      syncLeaveDates();
      const start = leaveStart.value, end = leaveEnd.value || start, notice = get('leaveDatesNotice');
      const conflict = start && end >= start && unavailable.find(item => start <= dayKey(item.endDate) && end >= dayKey(item.startDate));
      const warning = conflict ? 'These dates overlap with ' + (conflict.status === 'approved' ? 'approved' : 'pending') + ' leave (' + range(conflict) + '). Choose different dates.' : '';
      leaveStart.setCustomValidity(warning);
      notice.textContent = warning || (!loaded ? availabilityFailed ? 'Refresh your existing leave dates before submitting.' : 'Checking your existing leave dates…' : !start ? 'Choose a start date. Leave the end date blank for one day.' : start < leaveStart.min ? 'Choose today or a future start date.' : end < start ? 'Choose an end date on or after the start date.' : 'These dates are available to request. Admin approval is still required.');
      notice.className = 'small mt-3 mb-0 ' + (warning ? 'text-danger' : 'text-muted');
      submit.disabled = submitting || !loaded || !!conflict || !start || start < leaveStart.min || end < start;
    }
    function renderUnavailable() {
      get('leaveUnavailableSummary').textContent = unavailable.length ? 'Dates already requested (' + unavailable.length + ')' : 'No pending or approved leave on upcoming dates';
      get('leaveUnavailableList').innerHTML = unavailable.map(item => '<div class="leave-unavailable-row"><span>' + esc(range(item)) + '</span>' + badge(item) + '</div>').join('');
    }
    function render() {
      get('leaveContainer').innerHTML = items.length ? (showAll ? items : items.slice(0, 5)).map(item => '<article class="leave-request-row"><div class="leave-request-heading"><strong>' + esc(range(item)) + '</strong>' + badge(item) + '</div>' +
        (item.reason ? '<p class="small text-muted mb-1 leave-request-note">' + esc(item.reason) + '</p>' : '') +
        (item.adminNote ? '<p class="small mb-0 leave-request-note"><strong>Admin note:</strong> ' + esc(item.adminNote) + '</p>' : '') + '</article>').join('') +
        (items.length > 5 ? '<button type="button" class="btn btn-sm btn-outline-secondary mt-3" data-toggle-leave-history>' + (showAll ? 'Show fewer requests' : 'Show all ' + items.length + (items.length === 100 ? ' recent' : '') + ' requests') + '</button>' : '') : '<p class="text-muted text-center small mb-0">No leave requests yet. You can request a single day or a date range.</p>';
      renderUnavailable(); validateRange();
    }
    async function refresh() {
      if (refreshing) return refreshing;
      loaded = false; availabilityFailed = false; validateRange();
      get('leaveAvailabilityStatus').hidden = false;
      get('leaveAvailabilityStatus').innerHTML = '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Checking existing requests…';
      get('refreshLeavesButton').disabled = true;
      refreshing = (async () => {
        try {
          const result = await RACSRequest.json('/api/technician/leave-requests', { cache: 'no-store' });
          if (!Array.isArray(result.items) || !Array.isArray(result.unavailableRanges)) throw Error('Your leave dates could not be checked. Refresh and try again.');
          items = result.items; unavailable = result.unavailableRanges; loaded = true;
          get('leaveAvailabilityStatus').hidden = true;
          render(); return true;
        } catch (error) {
          availabilityFailed = true;
          get('leaveAvailabilityStatus').innerHTML = '<span>' + esc(error.message) + '</span> <button type="button" class="btn btn-sm btn-outline-primary" data-retry-leaves>Try again</button>';
          if (!items.length) get('leaveContainer').innerHTML = '<p class="text-muted small mb-0">Leave requests could not be loaded. Use Refresh to try again.</p>';
          validateRange(); return false;
        } finally { refreshing = null; get('refreshLeavesButton').disabled = false; }
      })();
      return refreshing;
    }
    get('requestLeaveButton').addEventListener('click', () => {
      if (submitting) return;
      form.reset(); FormFeedback.clear(form); leaveStart.setCustomValidity('');
      get('leaveUnavailableDetails').open = false; validateRange();
      bootstrap.Modal.getOrCreateInstance(modal).show(); refresh();
    });
    for (const input of [leaveStart, leaveEnd]) for (const event of ['input', 'change']) input.addEventListener(event, () => { FormFeedback.clear(form); validateRange(); });
    get('refreshLeavesButton').addEventListener('click', () => { if (!submitting) refresh(); });
    get('leaveAvailabilityStatus').addEventListener('click', event => { if (event.target.closest('[data-retry-leaves]')) refresh(); });
    get('leaveContainer').addEventListener('click', event => { if (event.target.closest('[data-toggle-leave-history]')) { showAll = !showAll; render(); } });
    modal.addEventListener('hide.bs.modal', event => { if (submitting) event.preventDefault(); });
    form.addEventListener('submit', async event => {
      event.preventDefault(); validateRange();
      if (submitting || !loaded || submit.disabled || !form.reportValidity()) return;
      const payload = { startDate: leaveStart.value, endDate: leaveEnd.value || leaveStart.value, reason: get('leaveReason').value };
      submitting = true; form.dataset.submitting = 'true'; submit.disabled = true; submit.textContent = 'Submitting…';
      const controls = Array.from(form.querySelectorAll('input, textarea, [data-bs-dismiss]'));
      controls.forEach(control => { control.disabled = true; }); FormFeedback.clear(form);
      try {
        const result = await RACSRequest.json('/api/technician/leave-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!result.leave?._id) throw Error('Refresh your leave requests to check whether the request was received.');
        items = [result.leave, ...items.filter(item => item._id !== result.leave._id)]; unavailable = [result.leave, ...unavailable];
        submitting = false; render(); bootstrap.Modal.getInstance(modal)?.hide();
        feedback('Your leave request was submitted for approval. You can request other dates that do not overlap.', false);
        await refresh();
      } catch (error) {
        FormFeedback.show(form, error, { startDate: 'leaveStart', endDate: 'leaveEnd', reason: 'leaveReason' });
        refresh();
      } finally {
        submitting = false; delete form.dataset.submitting; controls.forEach(control => { control.disabled = false; });
        submit.textContent = 'Submit request'; validateRange();
      }
    });
    window.addEventListener('focus', () => { if (!document.hidden && !submitting && !modal.classList.contains('show')) refresh(); });
    setInterval(() => { if (!document.hidden && !submitting && !modal.classList.contains('show')) refresh(); }, 60000);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();

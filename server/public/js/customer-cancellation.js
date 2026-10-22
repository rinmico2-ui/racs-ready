(function () {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const currency = value => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(value) || 0);
  const labels = { pending: 'Waiting for staff review', under_review: 'Under review', approved: 'Cancellation approved', declined: 'Request declined' };
  const reasons = { no_technician: 'No technician assigned', payment_delay: 'Payment verification delayed', schedule_passed: 'Scheduled visit did not happen', plans_changed: 'I no longer need the service', other: 'Another reason' };
  const date = value => value ? new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : '';
  const historyLabels = { submitted: 'Request sent', appealed: 'Review requested again', review_started: 'Staff review started', approved: 'Cancellation approved', declined: 'Request declined' };
  function history(request) {
    return request ? `<div class="cc-request"><span class="cc-status">${escape(labels[request.status] || request.status)}</span><p class="mt-3 mb-1"><strong>Your reason</strong></p><p class="cc-wrap">${escape(request.reason)}</p>${request.decisionNote ? `<p class="mb-1"><strong>Staff response</strong></p><p class="cc-wrap">${escape(request.decisionNote)}</p>` : ''}<details><summary>Request history</summary><ol class="cc-history">${(request.history || []).map(row => `<li><strong>${escape(historyLabels[row.type] || 'Request updated')}</strong><small>${escape(date(row.at))}</small><p class="cc-wrap">${escape(row.note)}</p></li>`).join('')}</ol></details></div>` : '';
  }
  let current;
  function modal(title) {
    if (current?.busy) return null;
    if (current) { current.instance.hide(); current = null; }
    const element = document.createElement('div');
    element.className = 'modal fade cc-modal'; element.tabIndex = -1;
    element.setAttribute('aria-labelledby', 'ccTitle');
    element.innerHTML = `<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable"><div class="modal-content"><div class="modal-header"><h2 class="modal-title fs-5" id="ccTitle">${escape(title)}</h2><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body"><p role="status">Loading booking details...</p></div><div class="modal-footer"></div></div></div>`;
    document.body.appendChild(element);
    const state = { element, body: element.querySelector('.modal-body'), footer: element.querySelector('.modal-footer'), instance: bootstrap.Modal.getOrCreateInstance(element), busy: false };
    element.addEventListener('hide.bs.modal', event => { if (state.busy) event.preventDefault(); });
    element.addEventListener('hidden.bs.modal', () => { element.remove(); if (current === state) current = null; });
    current = state; state.instance.show(); return state;
  }
  async function request(url, body) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || 'Could not load or save this request. Please try again.'), { status: response.status });
    return result;
  }
  function error(state, message) {
    let box = state.body.querySelector('[data-cc-error]');
    if (!box) { box = document.createElement('p'); box.className = 'alert alert-danger'; box.setAttribute('role', 'alert'); box.dataset.ccError = ''; state.body.prepend(box); }
    box.textContent = message; box.tabIndex = -1; box.focus();
  }
  function busy(state, value) {
    state.busy = value;
    state.element.querySelectorAll('button,input,select,textarea').forEach(node => {
      if (value) { node.dataset.wasDisabled = String(node.disabled); node.disabled = true; }
      else { node.disabled = node.dataset.wasDisabled === 'true'; delete node.dataset.wasDisabled; }
    });
  }
  function closeButton() { return '<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Close</button>'; }
  function reloadAfterConflict(state, failure, load) {
    if (failure.status !== 409 || state.footer.querySelector('[data-cc-reload]')) return;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-outline-primary'; button.dataset.ccReload = '';
    button.textContent = 'Reload Latest Request'; button.addEventListener('click', load); state.footer.appendChild(button);
  }
  function notes(label, placeholder, max = 1000) { return `<label for="ccNote" class="form-label fw-semibold">${label}</label><textarea id="ccNote" class="form-control" rows="4" minlength="10" maxlength="${max}" required placeholder="${escape(placeholder)}" aria-describedby="ccNoteHelp"></textarea><small id="ccNoteHelp" class="text-muted d-block mt-1">10 to ${max.toLocaleString('en-US')} characters. ${label.startsWith('Response') ? 'The customer can read this response.' : 'Please leave out passwords and payment account details.'}</small>`; }
  function validNote(state) {
    const input = state.body.querySelector('#ccNote');
    if (!input || input.value.trim().length < 10) { input?.setCustomValidity('Please explain in at least 10 characters.'); input?.reportValidity(); return false; }
    input.setCustomValidity(''); return true;
  }
  function installNotes(state) { state.body.querySelector('#ccNote')?.addEventListener('input', event => event.target.setCustomValidity('')); }
  async function openCustomer(id) {
    if (!/^[a-f\d]{24}$/i.test(String(id))) return;
    const state = modal('Cancel this booking'); if (!state) return;
    const url = `/api/appointments/${encodeURIComponent(id)}/cancellation-request`;
    async function load() {
      try {
        const data = await request(url); if (current !== state) return;
        const appeal = data.canAppeal;
        state.body.innerHTML = `<p class="text-muted">Booking ${escape(data.reference || '')}</p>${history(data.request)}${data.hold ? '<p class="alert alert-info mt-3">Staff will review your request here. Technician assignment is paused. You do not need to upload your payment again.</p>' : ''}${data.refund?.status !== 'none' && Number(data.refund?.amount) > 0 ? `<p class="alert alert-info">Refund ${escape(data.refund.status)}: <strong>${currency(data.refund.amount)}</strong></p>` : ''}${data.canRequest ? `<p class="alert alert-light border">${data.mode === 'cancel' ? 'No payment or technician assignment was found. You can cancel now.' : 'Staff will check your booking and any submitted payment before deciding. Sending this request pauses technician assignment.'}</p><label for="ccReason" class="form-label fw-semibold">Why do you want to cancel?</label><select id="ccReason" class="form-select mb-3">${Object.entries(reasons).map(([key, label]) => `<option value="${key}" ${data.request?.reasonCode === key ? 'selected' : ''}>${label}</option>`).join('')}</select>${notes(appeal ? 'What should staff reconsider?' : 'Tell us what happened', appeal ? 'Add information for staff to reconsider the decision.' : 'Explain the delay or why you need to cancel.', 500)}` : !data.request ? '<p>This visit has already started, closed, or is managed as a project. Please contact staff for help.</p>' : ''}`;
        state.footer.innerHTML = closeButton() + (data.canRequest ? `<button type="button" class="btn btn-danger" data-cc-submit>${appeal ? 'Ask for Review' : data.mode === 'cancel' ? 'Cancel Booking' : 'Send Cancellation Request'}</button>` : '');
        installNotes(state);
        state.footer.querySelector('[data-cc-submit]')?.addEventListener('click', async () => {
          if (state.busy || !validNote(state)) return;
          const input = { reasonCode: state.body.querySelector('#ccReason').value, reason: state.body.querySelector('#ccNote').value, ...(appeal ? { appeal: true, requestId: data.request.requestId, revision: data.request.revision } : {}) };
          busy(state, true);
          try {
            const saved = await request(url, input); busy(state, false);
            window.dispatchEvent(new CustomEvent('booking:cancellation-updated', { detail: { bookingId: id } }));
            await load();
            const message = document.createElement('p'); message.className = 'alert alert-success'; message.setAttribute('role', 'status'); message.textContent = saved.message; state.body.prepend(message);
          } catch (failure) { busy(state, false); error(state, failure.message); reloadAfterConflict(state, failure, load); }
        });
      } catch (failure) {
        error(state, failure.message); state.footer.innerHTML = closeButton() + '<button type="button" class="btn btn-primary" data-cc-retry>Try again</button>';
        state.footer.querySelector('[data-cc-retry]').onclick = load;
      }
    }
    await load();
  }
  async function openReview(id, base, onUpdated) {
    if (!/^[a-f\d]{24}$/i.test(String(id)) || !['/api/admin', '/api/secretary/operations'].includes(base)) return;
    const state = modal('Review cancellation request'); if (!state) return;
    const url = `${base}/resolution-center/${encodeURIComponent(id)}/cancellation-request`;
    async function load() {
      try {
        const data = await request(url); if (current !== state) return;
        const bill = data.payment || {}, open = data.hold;
        state.body.innerHTML = `<p class="text-muted">Booking ${escape(data.reference || '')}</p>${history(data.request)}<div class="cc-bill"><span>Verified / received <strong>${currency(bill.receivedAmount)}</strong></span><span>Awaiting verification <strong>${currency(bill.submittedAmount)}</strong></span></div>${bill.requiresVerification ? '<p class="alert alert-warning">Review the submitted payment first. The customer does not need to upload it again. Cancellation approval and refunds stay blocked until payment review is complete.</p><button type="button" class="btn btn-outline-success mb-3" data-cc-payment>Review submitted payment</button>' : ''}${(data.evidence || []).length ? `<details class="mb-3"><summary>Existing payment records</summary><ul class="cc-history">${data.evidence.map(row => `<li>${currency(row.amount)} · ${escape(row.status)}${row.reference ? `<p class="cc-wrap mb-0">Reference: ${escape(row.reference)}</p>` : ''}${safeProof(row.proofUrl) ? `<a href="${escape(row.proofUrl)}" target="_blank" rel="noopener noreferrer">View saved receipt</a>` : ''}</li>`).join('')}</ul></details>` : ''}${open ? `${notes('Response to customer', 'Explain the decision and any refund arrangement.')}<fieldset class="mt-3"><legend class="fs-6 fw-semibold">If you approve cancellation</legend><label for="ccRefund" class="form-label">Refund decision</label><select id="ccRefund" class="form-select mb-2"><option value="${bill.refundableAmount > 0 ? 'full' : 'none'}">${bill.refundableAmount > 0 ? `Full refund (${currency(bill.refundableAmount)})` : 'No refund — no received balance'}</option>${bill.refundableAmount > 0 ? '<option value="partial">Partial refund</option><option value="none">No refund — explain in your response</option>' : ''}</select><div data-cc-partial hidden><label for="ccRefundAmount" class="form-label">Refund amount</label><input id="ccRefundAmount" class="form-control mb-2" type="number" min="0.01" step="0.01" max="${Number(bill.refundableAmount) || 0}"></div><div data-cc-method ${bill.refundableAmount > 0 ? '' : 'hidden'}><label for="ccRefundMethod" class="form-label">Refund method</label><select id="ccRefundMethod" class="form-select"><option value="original">Original payment method</option><option value="gcash">GCash</option><option value="bank">Bank transfer</option><option value="cash">Cash</option></select></div><p class="small text-muted mt-2">Approval queues a refund for processing. It does not mark money as returned.</p></fieldset>` : '<p class="alert alert-light border mt-3">This request has already been decided. Reload the queue to see the current booking.</p>'}`;
        state.footer.innerHTML = closeButton() + (open ? `${data.request.status === 'pending' ? '<button type="button" class="btn btn-outline-primary" data-cc-action="review">Start Review</button>' : ''}<button type="button" class="btn btn-outline-danger" data-cc-action="decline">Decline Request</button><button type="button" class="btn btn-danger" data-cc-action="approve" ${bill.requiresVerification ? 'disabled' : ''}>Approve Cancellation</button>` : '');
        installNotes(state);
        state.body.querySelector('[data-cc-payment]')?.addEventListener('click', () => {
          state.element.addEventListener('hidden.bs.modal', () => window.openResolutionPaymentReview('booking', id), { once: true }); state.instance.hide();
        });
        state.body.querySelector('#ccRefund')?.addEventListener('change', event => {
          state.body.querySelector('[data-cc-partial]').hidden = event.target.value !== 'partial';
          state.body.querySelector('[data-cc-method]').hidden = event.target.value === 'none';
        });
        state.footer.querySelectorAll('[data-cc-action]').forEach(button => button.addEventListener('click', async () => {
          const action = button.dataset.ccAction;
          if (state.busy || (action !== 'review' && !validNote(state))) return;
          const amount = state.body.querySelector('#ccRefundAmount');
          if (action === 'approve' && state.body.querySelector('#ccRefund').value === 'partial' && (!amount.value || !amount.reportValidity())) return;
          const input = { action, requestId: data.request.requestId, revision: data.request.revision, note: state.body.querySelector('#ccNote').value,
            refundDecision: state.body.querySelector('#ccRefund').value, refundAmount: Number(amount.value), refundMethod: state.body.querySelector('#ccRefundMethod').value };
          busy(state, true);
          try {
            const result = await request(url, input); busy(state, false);
            if (action === 'review') await load();
            else { state.body.innerHTML = `<p class="alert alert-success" role="status">${escape(result.message)}</p>${history(result.request)}`; state.footer.innerHTML = closeButton(); }
            await onUpdated?.();
          } catch (failure) { busy(state, false); error(state, failure.message); reloadAfterConflict(state, failure, load); }
        }));
      } catch (failure) {
        error(state, failure.message); state.footer.innerHTML = closeButton() + '<button type="button" class="btn btn-primary" data-cc-retry>Reload request</button>';
        state.footer.querySelector('[data-cc-retry]').onclick = load;
      }
    }
    await load();
  }
  function safeProof(url) { return typeof url === 'string' && (/^\/(?!\/)/.test(url) || /^https:\/\//i.test(url)); }
  window.CustomerCancellation = { open: openCustomer, history };
  window.CustomerCancellationReview = { open: openReview };
})();

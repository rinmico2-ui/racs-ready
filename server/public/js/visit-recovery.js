(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let generation = 0;
  const dateKey = value => {
    if (!value || Number.isNaN(new Date(value).getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
  };
  function ready(item) {
    const contact = item.recoveryContact;
    const date = dateKey(item.bookingDate || item.scheduledAt);
    const time = String(item.startTime || '').slice(0, 5);
    return !!(contact?.customerConfirmed && dateKey(contact.date) === date && String(contact.time).slice(0, 5) === time
      && (!item.staffingEmergency || String(contact.incidentId) === String(item.staffingEmergency._id))
      && new Date(`${date}T${time}:00+08:00`) > new Date());
  }
  async function hide(element) {
    const modal = bootstrap.Modal.getInstance(element);
    if (!modal || !element.classList.contains('show')) return;
    if (modal._isTransitioning) await new Promise(resolve => element.addEventListener('shown.bs.modal', resolve, { once: true }));
    await new Promise(resolve => { element.addEventListener('hidden.bs.modal', resolve, { once: true }); modal.hide(); });
  }
  async function open(item, options = {}) {
    if (!item?.recoveryAvailable || !/^[a-f\d]{24}$/i.test(item.id)) return;
    const sequence = ++generation, source = item.sourceType === 'order' ? 'order' : 'booking';
    for (const other of document.querySelectorAll('.modal.show')) await hide(other);
    const old = document.getElementById('visitRecoveryModal');
    if (old) { bootstrap.Modal.getInstance(old)?.dispose(); old.remove(); }
    const element = document.createElement('div'); element.className = 'modal fade visit-recovery'; element.id = 'visitRecoveryModal'; element.tabIndex = -1;
    element.setAttribute('aria-labelledby', 'visitRecoveryTitle');
    element.innerHTML = `<div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable"><form class="modal-content">
      <div class="modal-header"><div><div class="vr-eyebrow">${esc(item.reference)} · ${source === 'order' ? 'Order' : 'Service booking'}</div><h2 class="modal-title" id="visitRecoveryTitle">Arrange a replacement visit</h2><p class="small text-muted mb-0">Keep the same ${source} and its recorded payments.</p></div><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
      <div class="modal-body"><ol class="vr-steps" aria-label="Recovery steps"><li aria-current="step">1. Customer agreement</li><li>2. Visit schedule</li><li>3. Replacement team</li></ol>
      <div data-recovery-error class="alert alert-danger d-none" role="alert" tabindex="-1"></div>
      <section data-recovery-contact><div class="vr-contact"><span class="vr-eyebrow">Contact the customer first</span><h3>${esc(item.customer || 'Customer')}</h3><p class="small mb-2">Explain the delay and ask: “Would you still like us to complete your visit with a replacement technician, arriving later?”</p><div class="d-flex flex-wrap gap-2" data-contact-links></div><p class="small text-muted mt-2 mb-0">${esc([item.phone, item.email].filter(Boolean).join(' · ') || 'No contact details saved. Check the customer’s account before continuing.')}</p></div>
      <fieldset class="mt-3"><legend class="fs-6 fw-bold">What did the customer agree to?</legend><label class="vr-choice"><input type="radio" name="decision" value="late_visit" required><span><strong>A later visit today</strong><small>The customer accepts the delay and a replacement technician.</small></span></label><label class="vr-choice"><input type="radio" name="decision" value="new_schedule"><span><strong>Another available schedule</strong><small>Agree on a new date and time with the customer.</small></span></label></fieldset>
      <label class="d-block mt-3 fw-semibold">Contact method<select name="contactMethod" class="form-select mt-1" required><option value="">Choose how you spoke</option><option value="call">Phone call</option><option value="message">Customer replied by message</option><option value="in_person">In person</option></select></label>
      <label class="d-block mt-3 fw-semibold">Customer’s reply<textarea class="form-control mt-1" name="notes" rows="2" minlength="5" maxlength="1000" required placeholder="Record the agreed delay or preferred schedule."></textarea></label>
      <label class="vr-consent mt-3"><input type="checkbox" name="confirmed" required><span>I spoke with the customer and they agreed to the replacement visit. I will confirm the selected time with them before saving.</span></label>
      <div class="vr-alternatives"><p class="small fw-semibold mb-2">No agreement yet?</p><button type="button" class="btn btn-sm btn-outline-secondary" data-recovery-link>Send a schedule link</button> <button type="button" class="btn btn-sm btn-outline-danger" data-recovery-cancel>Customer wants to cancel</button><p class="small text-muted mt-2 mb-0">Leave the case open if the customer has not replied. Cancellation includes payment and refund review.</p></div></section>
      <section data-recovery-schedule hidden><div class="vr-contact"><strong data-recovery-summary></strong><p class="small mt-1 mb-0">Choose an available time agreed with the customer. The replacement team must fit the whole visit, travel and preparation buffer.</p></div><div data-calendar-host class="mt-3"><div id="calendarGrid"></div><div id="timeSelection" class="mt-3 d-none"><div id="timeSlots"></div></div><div id="projectPrefs" class="d-none"></div></div><div class="vr-tools mt-3"><strong>Tools and units before dispatch</strong><p class="small mb-2">Issued tools${source === 'order' ? ' and aircon units' : ''} stay with the recorded holder until staff confirms their return or handover. Check custody with the previous team. The replacement technician completes their own Daily Preparation before departure.</p><button type="button" class="btn btn-sm btn-outline-secondary" data-recovery-tools>Review tools with previous team</button><div data-recovery-equipment aria-live="polite" class="small mt-2"></div></div></section>
      </div><div class="modal-footer"><button type="button" class="btn btn-outline-secondary me-auto" data-recovery-back hidden>Back to customer reply</button><button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Close</button><button type="submit" class="btn btn-primary" data-recovery-next>Continue to schedule</button></div>
      </form></div>`;
    document.body.append(element);
    const form = element.querySelector('form'), contact = element.querySelector('[data-recovery-contact]'), schedule = element.querySelector('[data-recovery-schedule]');
    form.noValidate = true;
    const next = element.querySelector('[data-recovery-next]'), back = element.querySelector('[data-recovery-back]'), error = element.querySelector('[data-recovery-error]');
    const requestId = crypto.randomUUID(); let stage = 1, busy = false, calendarReady = false, selectionKey = '';
    const exactConsent = document.createElement('label'); exactConsent.className = 'vr-consent mt-3';
    exactConsent.innerHTML = '<input type="checkbox" name="scheduleConfirmed"><span data-exact-schedule>Confirm the selected date and time with the customer before saving.</span>';
    element.querySelector('[data-calendar-host]').after(exactConsent);
    form.addEventListener('click', event => { const button = event.target.closest('[data-calendar-host] button'); if (button) button.type = 'button'; }, true);
    function showError(message) { error.textContent = message; error.classList.remove('d-none'); error.focus(); }
    const links = element.querySelector('[data-contact-links]');
    const phone = String(item.phone || '').replace(/[^+\d]/g, '');
    if (/^\+?\d{7,15}$/.test(phone)) { const a = document.createElement('a'); a.className = 'btn btn-sm btn-outline-success'; a.href = `tel:${phone}`; a.textContent = 'Call customer'; links.append(a); }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email || '')) { const a = document.createElement('a'); a.className = 'btn btn-sm btn-outline-secondary'; a.href = `mailto:${encodeURIComponent(item.email)}`; a.textContent = 'Email customer'; links.append(a); }
    const modal = new bootstrap.Modal(element, { backdrop: 'static' }); modal.show();
    element.addEventListener('hide.bs.modal', event => { if (busy) event.preventDefault(); });
    const refresh = () => {
      const selected = stage === 2 && EnterpriseCalendar.getSelectedDate(), time = stage === 2 && EnterpriseCalendar.getSelectedSlot()?.startTime;
      const key = selected && time ? `${EnterpriseCalendar.formatDateKey(selected)} ${time}` : '';
      if (key !== selectionKey) { selectionKey = key; form.elements.scheduleConfirmed.checked = false; }
      exactConsent.querySelector('span').textContent = key ? `The customer confirmed ${key} PHT for the replacement visit.` : 'Confirm the selected date and time with the customer before saving.';
      next.disabled = busy || stage === 2 && (!calendarReady || !key);
    };
    async function handoff(saved) {
      busy = false; await hide(element); await options.onSaved?.(saved);
      if (source === 'order' && item.fulfillmentType === 'delivery_only') {
        location.href = `${location.pathname.startsWith('/secretary/') ? '/secretary' : '/admin'}/appointments/orders?fulfillment=delivery&order=${encodeURIComponent(item.id)}&assign=1`;
      } else await window.RACSJobTeams.open(source, item.id, { onAssigned: () => options.onAssigned?.(), recovery: true });
    }
    if (ready(item)) {
      contact.hidden = true; schedule.hidden = false; stage = 3;
      element.querySelector('[data-calendar-host]').hidden = true;
      exactConsent.hidden = true;
      element.querySelector('[data-recovery-summary]').textContent = `Customer agreement saved for ${dateKey(item.recoveryContact.date)} at ${item.recoveryContact.time} PHT.`;
      next.textContent = 'Choose replacement team'; back.hidden = false;
    }
    back.addEventListener('click', () => { stage = 1; contact.hidden = false; schedule.hidden = true; back.hidden = true; next.textContent = 'Continue to schedule'; next.disabled = false; error.classList.add('d-none'); element.querySelector('[data-calendar-host]').hidden = false; exactConsent.hidden = false; });
    for (const [selector, callback] of [['[data-recovery-link]', options.onSendLink], ['[data-recovery-cancel]', options.onCancel]]) {
      element.querySelector(selector).addEventListener('click', async () => { if (busy) return; await hide(element); await callback?.(item); });
    }
    element.querySelector('[data-recovery-tools]').addEventListener('click', async event => {
      const button = event.currentTarget, output = element.querySelector('[data-recovery-equipment]'); button.disabled = true; output.textContent = 'Checking recorded custody…';
      try {
        const response = await fetch(`/api/work-teams/${source}/${item.id}/emergency-equipment`), data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load tool custody. Try again.');
        output.innerHTML = data.items?.length ? `<ul class="mb-0 ps-3">${data.items.map(row => `<li>${esc(row.name)} · ${esc(row.quantity)} ${esc(row.unit || 'pcs')} · ${esc(row.holder)} · ${row.state === 'return_pending' ? 'Return awaiting staff confirmation' : row.state === 'reserved' ? 'Reserved, not issued' : 'With technician'}</li>`).join('')}</ul>` : (source === 'order' ? 'No outstanding tools are linked to this emergency report. Check issued aircon units separately in order preparation.' : 'No outstanding tools are linked to this emergency report. Confirm any physical custody with the previous team before dispatch.');
      } catch (failure) { output.textContent = failure.message; } finally { button.disabled = false; }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy) return; error.classList.add('d-none');
      if (stage === 3) { await handoff(); return; }
      if (stage === 1) {
        if (!form.reportValidity()) return;
        contact.hidden = true; schedule.hidden = false; stage = 2; back.hidden = false; next.textContent = 'Save schedule and assign';
        element.querySelector('[data-recovery-summary]').textContent = form.elements.decision.value === 'late_visit' ? 'Customer agreed to a later visit today.' : 'Customer agreed to another available schedule.';
        element.querySelectorAll('.vr-steps li').forEach((li, index) => index === 1 ? li.setAttribute('aria-current', 'step') : li.removeAttribute('aria-current'));
        calendarReady = false; refresh();
        try {
          const duration = Number(item.totalEstimatedMinutes || item.serviceDurationMinutes) || 60;
          await EnterpriseCalendar.init({ root: element, syncGlobalState: false, resetSelection: true, mode: 'appointment', autoDetectProject: false,
            duration, quantity: 1, totalEstimatedMinutes: duration, showStartDatePrompt: false,
            availabilityUrl: source === 'order' ? `/api/orders/${item.id}/admin-reschedule-availability` : `${options.apiBase || '/api/admin'}/resolution-center/${item.id}/schedule-availability`,
            onSelect: refresh, onStateChange: refresh });
          if (sequence !== generation) return;
          calendarReady = true; refresh(); element.querySelector('.modal-body').scrollTop = 0;
        } catch (_) { showError('Could not load availability. Go back and try again.'); }
        return;
      }
      const date = EnterpriseCalendar.formatDateKey(EnterpriseCalendar.getSelectedDate()), slot = EnterpriseCalendar.getSelectedSlot();
      if (!slot?.startTime) { showError('Choose an available date and time.'); return; }
      if (!form.elements.scheduleConfirmed.checked) {
        showError('Confirm this exact date and time with the customer, then tick the confirmation.');
        form.elements.scheduleConfirmed.focus(); exactConsent.scrollIntoView({ block: 'center' }); return;
      }
      if (form.elements.decision.value === 'late_visit' && date !== dateKey(new Date())) { showError('Choose a time today, or go back and record agreement to another schedule.'); return; }
      busy = true; refresh(); next.textContent = 'Saving agreement and schedule…';
      try {
        const response = await fetch(`/api/work-teams/${source}/${item.id}/recovery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          requestId, expectedUpdatedAt: item.updatedAt, decision: form.elements.decision.value, contactMethod: form.elements.contactMethod.value,
          notes: form.elements.notes.value, customerConfirmed: form.elements.confirmed.checked, date, time: slot.startTime }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not save the replacement visit. Try again.');
        await handoff(data);
      } catch (failure) { busy = false; next.textContent = 'Save schedule and assign'; showError(failure.message); refresh(); }
    });
  }
  window.RACSVisitRecovery = { open, ready };
})();

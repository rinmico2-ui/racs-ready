(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else document.addEventListener('DOMContentLoaded', () => api.initOrderReschedule(document, root));
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function initOrderReschedule(doc, win) {
    const modalElement = doc.getElementById('orderRescheduleModal');
    if (!modalElement || !win.bootstrap || !win.OrderReschedulePicker) return;
    // Keep Bootstrap overlays outside page containers with overflow/transforms.
    doc.body.appendChild(modalElement);
    const modal = win.bootstrap.Modal.getOrCreateInstance(modalElement);
    const get = id => doc.getElementById(id);
    const loading = get('rescheduleLoading'), fields = get('rescheduleFields');
    const errorBox = get('rescheduleError'), retry = get('rescheduleRetry');
    const date = get('rescheduleDate'), time = get('rescheduleTime');
    const reason = get('rescheduleReason'), submit = get('submitReschedule');
    const calendar = get('rescheduleCalendar');
    let current = null, generation = 0, controller = null, submitting = false, opening = false;

    async function jsonRequest(url, options) {
      let response;
      try {
        response = await win.fetch(url, { credentials:'same-origin', cache:'no-store', ...options });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error('Unable to reach the server. Check your connection and try again. Your request has not been confirmed.');
      }
      const data = await response.json().catch(() => null);
      if (response.redirected || response.status === 401) throw new Error('Your session expired. Sign in again before rescheduling.');
      if (!response.ok || !data) {
        const error = new Error(data?.error || 'Unable to complete this request. Please try again.');
        error.refreshSlots = Boolean(data?.refreshSlots);
        throw error;
      }
      if (data.blocked) throw new Error(data.message || 'Please contact us to arrange this schedule.');
      return data;
    }
    const picker = new win.OrderReschedulePicker(calendar, date, time, updateSubmit, async key => {
      const order = current;
      if (!order) throw new Error('Open this order again to choose a schedule.');
      if (order.fulfillment === 'customer_pickup') return [{ time:'store_hours', label:'During store hours' }];
      const data = await jsonRequest('/api/orders/' + encodeURIComponent(order.id) + '/reschedule-availability?date=' + encodeURIComponent(key));
      return Array.isArray(data.timeSlots) ? data.timeSlots : [];
    });
    function updateSubmit() { submit.disabled = submitting || !current || !(date.value && time.value && reason.value.trim()); }
    function showError(message) { errorBox.textContent = message; errorBox.classList.remove('d-none'); errorBox.focus(); }
    function setBusy(busy) {
      submitting = busy;
      calendar.inert = busy;
      reason.readOnly = busy;
      modalElement.querySelectorAll('[data-bs-dismiss="modal"]').forEach(button => { button.disabled = busy; });
      submit.innerHTML = busy ? '<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Submitting request' : 'Submit request';
      modalElement.setAttribute('aria-busy', String(busy));
      updateSubmit();
    }
    function pickupDates(hours) {
      const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Manila', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
      const today = new Date(todayKey + 'T00:00:00Z');
      const rows = [];
      for (let offset = 1; offset <= 30; offset++) {
        const candidate = new Date(today); candidate.setUTCDate(today.getUTCDate() + offset);
        const day = hours.find(row => Number(row.dayOfWeek) === candidate.getUTCDay());
        if (day?.open && Number(day.endMinutes) > Number(day.startMinutes)) rows.push({ date:candidate.toISOString().slice(0,10), available:true, timeSlots:[{ time:'store_hours', label:'During store hours' }] });
      }
      return rows;
    }
    async function loadDates() {
      if (!current) return;
      const order = current, requestGeneration = ++generation;
      controller?.abort();
      controller = new win.AbortController();
      const signal = controller.signal;
      loading.classList.remove('d-none'); fields.classList.add('d-none');
      errorBox.classList.add('d-none'); retry.classList.add('d-none');
      picker.reset(); updateSubmit();
      try {
        const data = await jsonRequest(order.fulfillment === 'customer_pickup' ? '/api/public/company/store-open-hours' : '/api/orders/' + encodeURIComponent(order.id) + '/reschedule-availability', { signal });
        if (requestGeneration !== generation) return;
        const rows = order.fulfillment === 'customer_pickup' ? pickupDates(Array.isArray(data.hours) ? data.hours : []) : data.availableDates || [];
        if (!picker.setDates(rows)) throw new Error('No open schedules are available. Contact us for help arranging a new date.');
        fields.classList.remove('d-none');
      } catch (error) {
        if (requestGeneration !== generation || error.name === 'AbortError') return;
        showError(error.message); retry.classList.remove('d-none');
      } finally {
        if (requestGeneration === generation) { loading.classList.add('d-none'); controller = null; updateSubmit(); }
      }
    }
    reason.addEventListener('input', updateSubmit);
    retry.addEventListener('click', loadDates);
    modalElement.addEventListener('shown.bs.modal', () => { opening = false; });
    modalElement.addEventListener('hide.bs.modal', event => { if (submitting) event.preventDefault(); });
    modalElement.addEventListener('hidden.bs.modal', () => {
      generation++; controller?.abort(); controller = null; current = null; opening = false;
      picker.reset(); reason.value = ''; setBusy(false);
    });
    doc.querySelectorAll('.ord-reschedule-btn').forEach(button => button.addEventListener('click', () => {
      if (submitting) return;
      current = { id:button.dataset.id, fulfillment:button.dataset.fulfillment, button };
      get('rescheduleOrderRef').textContent = 'Order ' + button.dataset.ref;
      get('rescheduleCurrentSchedule').textContent = button.dataset.currentSchedule || 'To be confirmed';
      reason.value = ''; setBusy(false); opening = true; modal.show(); loadDates();
    }));
    submit.addEventListener('click', async () => {
      if (submitting || submit.disabled || !current) return;
      const order = current;
      const requestedDate = date.value, requestedTime = time.value;
      const reasonText = reason.value.trim();
      errorBox.classList.add('d-none'); setBusy(true);
      try {
        // Submission validates live capacity on the server using the same owned-order exclusions.
        const data = await jsonRequest('/api/orders/' + encodeURIComponent(order.id) + '/reschedule-request', {
          method:'POST', headers:{ 'Content-Type':'application/json' },
          body:JSON.stringify({ requestedDate: requestedDate, requestedTime: requestedTime, reason: reasonText })
        });
        const card = order.button.closest('.ord-card');
        if (card) {
          const note = doc.createElement('div'); note.className = 'ord-request-note';
          const requestedLabel = new Date(requestedDate + 'T00:00:00Z').toLocaleDateString('en-PH', { timeZone:'Asia/Manila', year:'numeric', month:'short', day:'numeric' });
          note.textContent = 'Reschedule request under review · ' + requestedLabel + (order.fulfillment === 'customer_pickup' ? ' during store hours' : ' at ' + requestedTime) + '. Your current schedule stays in place until approval.';
          card.querySelector('.ord-request-note')?.remove();
          card.insertBefore(note, card.querySelector('.ord-action-row'));
          order.button.remove();
        }
        setBusy(false); submit.disabled = true;
        // Bootstrap ignores hide() during the entrance transition. A fast
        // successful response must still close the dialog once it is shown.
        if (opening) modalElement.addEventListener('shown.bs.modal', () => modal.hide(), { once:true });
        else modal.hide();
        doc.dispatchEvent(new win.CustomEvent('orders:reschedule-submitted', { detail:{ orderId:order.id, message:data.message || 'Request submitted. We will notify you after the new schedule is reviewed.' } }));
      } catch (error) {
        if (error.refreshSlots && current === order) await picker.selectDate(requestedDate);
        showError(error.message);
      } finally { if (submitting) setBusy(false); }
    });
    return { picker, loadDates };
  }
  return { initOrderReschedule };
});

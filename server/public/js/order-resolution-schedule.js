(() => {
  'use strict';
  const root = document.getElementById('orderResolutionSchedule');
  const form = document.getElementById('orderScheduleForm');
  if (!root || !form) return;
  const id = encodeURIComponent(root.dataset.orderId);
  const message = document.getElementById('orderScheduleMessage');
  const save = document.getElementById('orderScheduleSave');
  const retry = document.getElementById('orderScheduleRetry');
  const picker = document.getElementById('orderSchedulePicker');
  const pickup = document.getElementById('orderPickupDate');
  let context = null, busy = false, loading = false;
  const show = (text, error = false) => { message.textContent = text; message.hidden = false; message.classList.toggle('is-error', error); };
  async function api(url, options) {
    const response = await fetch(url, { credentials:'same-origin', cache:'no-store', ...options });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Could not complete this request. Please try again.'), { refreshSlots:data.refreshSlots });
    return data;
  }
  async function load() {
    if (loading || busy) return;
    loading = true; retry.hidden = true; message.hidden = true; form.hidden = true;
    document.getElementById('orderScheduleLoading').hidden = false;
    try {
      const availabilityUrl = `/api/orders/${id}/customer-resolution-availability`;
      context = await api(availabilityUrl);
      const isPickup = root.dataset.fulfillment === 'customer_pickup';
      picker.hidden = isPickup;
      document.getElementById('orderPickupField').hidden = !isPickup;
      if (isPickup) {
        const tomorrow = new Date(Date.now() + 86400000);
        pickup.min = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Manila', year:'numeric', month:'2-digit', day:'2-digit' }).format(tomorrow);
        document.getElementById('orderScheduleGuide').textContent = 'Choose your new pickup date. Our team will check the store hours when you save.';
      } else {
        const workload = context.scheduling;
        if (!workload) throw new Error('Schedule details are unavailable. Please try again.');
        document.getElementById('orderScheduleGuide').textContent = workload.isProject
          ? 'Choose a start date and finish-by date for installation. Our team will confirm the final project schedule.'
          : 'Choose an available date and start time for your order.';
        await EnterpriseCalendar.init({ root:picker, syncGlobalState:false, resetSelection:true,
          duration:workload.isProject ? Math.ceil(workload.totalEstimatedMinutes / workload.totalUnits) : workload.totalEstimatedMinutes,
          quantity:workload.isProject ? workload.totalUnits : 1, totalEstimatedMinutes:workload.totalEstimatedMinutes,
          mode:workload.isProject ? 'project' : 'appointment', autoDetectProject:false, availabilityUrl,
          projectAvailabilityUrl:`/api/orders/${id}/customer-project-window-availability`, showStartDatePrompt:false,
          projectPreferences:context.projectScheduling ? { workingDays:context.projectScheduling.preferredWorkingDays, preferredWorkingHours:context.projectScheduling.preferredWorkingHours?.start } : null,
          onSelect:() => {},
        });
      }
      form.hidden = false;
    } catch (error) { show(error.message, true); retry.hidden = false; }
    finally { loading = false; document.getElementById('orderScheduleLoading').hidden = true; }
  }
  retry.addEventListener('click', load);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !context) return;
    const payload = { reason:document.getElementById('orderScheduleReason').value.trim() };
    if (root.dataset.fulfillment === 'customer_pickup') {
      if (!pickup.value) { show('Choose a new pickup date.', true); pickup.focus(); return; }
      payload.scheduledDate = pickup.value;
    } else {
      const date = EnterpriseCalendar.getSelectedDate(), slot = EnterpriseCalendar.getSelectedSlot();
      if (!date || (context.scheduling.isProject ? !(EnterpriseCalendar.getSelectedEndDate() && EnterpriseCalendar.getWindowVerdict()?.sufficient) : !slot?.startTime)) {
        show(context.scheduling.isProject ? 'Choose a start date and finish-by date with enough available time.' : 'Choose an available date and start time.', true); return;
      }
      payload.scheduledDate = EnterpriseCalendar.formatDateKey(date);
      if (context.scheduling.isProject) {
        const selection = EnterpriseCalendar.getProjectSelection();
        payload.endDate = EnterpriseCalendar.formatDateKey(selection.endDate);
        payload.projectScheduling = { preferredStartDate:payload.scheduledDate, preferredCompletionDeadline:payload.endDate,
          preferredWorkingDays:selection.preferences.workingDays, preferredWorkingHours:{ start:selection.preferences.preferredWorkingHours, end:'' } };
      } else payload.timeSlot = slot.startTime;
    }
    busy = true; save.disabled = true; save.textContent = 'Saving…';
    picker.inert = true; pickup.disabled = true; document.getElementById('orderScheduleReason').readOnly = true;
    try {
      const data = await api(`/api/orders/${id}/customer-resolution-reschedule`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(payload) });
      show(data.message || 'Your new schedule has been saved.');
      form.hidden = true;
    } catch (error) {
      show(error.message, true);
      if (error.refreshSlots && root.dataset.fulfillment !== 'customer_pickup') await EnterpriseCalendar.refresh({ invalidateSelection:true }).catch(() => {});
    } finally {
      busy = false; save.disabled = false; save.textContent = 'Save new schedule'; picker.inert = false; pickup.disabled = false; document.getElementById('orderScheduleReason').readOnly = false;
    }
  });
  load();
})();

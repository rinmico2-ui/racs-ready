(() => {
  'use strict';
  function init() {
    const $ = id => document.getElementById(id), modal = $('attendanceCloseModal');
    if (!modal) return;
    let selected = null, saving = false;
    const local = value => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 16);
    const time = value => new Date(value).toLocaleString('en-PH', { timeZone:'Asia/Manila', dateStyle:'medium', timeStyle:'short' });
    $('tblRosterBody').addEventListener('click', event => {
      const button = event.target.closest('[data-close-attendance]');
      if (!button || saving) return;
      selected = { staffId: button.dataset.staffId, staffType: button.dataset.staffType, recordId: button.dataset.recordId };
      $('attendanceCloseForm').reset(); $('attendanceCloseError').classList.add('d-none');
      $('attendanceCloseStaff').textContent = button.dataset.staffName;
      $('attendanceCloseContext').textContent = 'Check-in: ' + time(button.dataset.checkIn) + ' PHT · Work date: ' + new Date(button.dataset.workDate + 'T12:00:00+08:00').toLocaleDateString('en-PH', {timeZone:'Asia/Manila',dateStyle:'medium'});
      $('attendanceCloseTime').min = local(new Date(new Date(button.dataset.checkIn).getTime() + 59999));
      $('attendanceCloseTime').max = local(new Date());
      bootstrap.Modal.getOrCreateInstance(modal).show();
    });
    modal.addEventListener('hide.bs.modal', event => { if (saving) event.preventDefault(); });
    $('attendanceCloseForm').addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || !selected || !$('attendanceCloseForm').reportValidity()) return;
      saving = true; $('attendanceCloseError').classList.add('d-none');
      modal.querySelectorAll('button').forEach(button => { button.disabled = true; });
      $('attendanceCloseSave').textContent = 'Saving checkout...';
      try {
        const response = await fetch('/api/admin/attendance/' + encodeURIComponent(selected.staffId) + '/close-shift', {
          method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ staffType:selected.staffType, recordId:selected.recordId, checkOutLocal:$('attendanceCloseTime').value, overrideReason:$('attendanceCloseReason').value.trim() }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Could not record checkout. Please try again.');
        saving = false; bootstrap.Modal.getOrCreateInstance(modal).hide();
        window.dispatchEvent(new Event('attendance:changed'));
      } catch (error) {
        $('attendanceCloseError').textContent = error.message; $('attendanceCloseError').classList.remove('d-none');
      } finally {
        saving = false; modal.querySelectorAll('button').forEach(button => { button.disabled = false; });
        $('attendanceCloseSave').textContent = 'Record verified checkout';
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true }); else init();
})();

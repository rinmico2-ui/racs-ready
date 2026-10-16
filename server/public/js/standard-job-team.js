(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const validId = value => /^[a-f\d]{24}$/i.test(String(value || ''));
  const statusLabel = value => ({ pending: 'Awaiting response', accepted: 'Accepted', declined: 'Declined', expired: 'Response expired', technician_assigned: 'Waiting for team acceptance', technician_accepted: 'Team accepted', out_for_delivery: 'En route', installing: 'Installation in progress' })[value] || String(value || 'Pending').replace(/_/g, ' ');
  async function json(url, options) {
    if (window.RACSRequest?.json) return window.RACSRequest.json(url, { credentials: 'same-origin', ...options });
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const body = await response.json().catch(() => ({ error: 'The server response could not be read. Please try again.' }));
    if (!response.ok) throw Error(body.error || 'This request could not be completed.');
    return body;
  }
  function summary(rows) {
    if (!rows?.length) return '';
    return `<div class="job-team-summary"><strong>Assigned technicians</strong>${rows.map(row => `<div><span>${escape(row.name)}</span><small>${row.role === 'primary' ? 'Primary' : 'Supporting'} · ${escape(statusLabel(row.status))}</small></div>`).join('')}</div>`;
  }
  function ready(rows) { return !rows?.length || rows.every(row => row.status === 'accepted'); }
  function recommendation(row) {
    const staffing = row.staffing || { recommendedCount: 1, reason: 'Review the technician schedule before assigning.' };
    const crew = row.recommendedTeam || (row.recommended ? [row.recommended] : []);
    return `<div class="small text-uppercase text-muted fw-bold"><i class="bi bi-stars text-warning me-1"></i>Recommended crew: ${escape(staffing.recommendedCount)} technician${staffing.recommendedCount === 1 ? '' : 's'}</div><p class="small text-muted mb-2 mt-1">${escape(staffing.reason)}</p>${crew.length ? crew.map((person, index) => `<div class="small"><strong>${escape(person.name)}</strong> <span class="text-muted">${index ? 'Supporting' : 'Primary'}</span></div>`).join('') + '<div class="small text-success mt-1">Available together for this appointment. Availability is checked again when assigning.</div>' : `<div class="small text-warning" role="status">${escape(row.issue || 'No complete crew is available. Review staffing or choose another schedule.')}</div>`}`;
  }
  function planPicker(row) {
    if (!row.recommended) return recommendation(row);
    const crew = row.recommendedTeam || [row.recommended];
    return `<fieldset data-plan-picker><legend class="fs-6">${crew.length} technician${crew.length === 1 ? '' : 's'} recommended</legend><p class="small text-muted mb-2">${escape(row.staffing?.reason || '')} Uncheck everyone to skip this job.</p><div class="job-team-list" style="max-height:180px;overflow:auto">${(row.candidates || []).map(person => `<label class="job-team-person"><input type="checkbox" data-plan-member value="${escape(person.technicianId)}" ${crew.some(member => member.technicianId === person.technicianId) ? 'checked' : ''}><span>${escape(person.name)}<small>Score ${escape(person.score)}</small></span></label>`).join('')}</div><label class="small mt-2">Primary technician<select class="form-select form-select-sm" data-plan-primary>${crew.map(person => `<option value="${escape(person.technicianId)}">${escape(person.name)}</option>`).join('')}</select></label><div class="small text-danger mt-1" data-plan-error role="alert"></div></fieldset>`;
  }
  function planRow(row, index) {
    const booking = !!row.bookingId, reference = row.bookingReference || row.orderReference || row.bookingId || row.orderId;
    const date = new Date(row.bookingDate || row.scheduledDate), dateLabel = Number.isNaN(date.getTime()) ? 'Schedule needs review' : date.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric' });
    return `<article class="border rounded-3 p-3 mb-3" data-plan-index="${index}"><div class="row g-3"><div class="col-lg-4"><div class="small text-muted text-uppercase">${booking ? 'Booking' : 'Order'}</div><strong class="d-block">${escape(reference)}</strong><div class="small mt-1">${escape(row.customerName)}</div>${row.serviceName ? `<div class="small text-muted">${escape(row.serviceName)}</div>` : ''}<div class="small mt-2">${escape(dateLabel)}<br>${escape(row.startTime || row.timeSlot || '')} PHT</div></div><div class="col-lg-8">${planPicker(row)}</div></div></article>`;
  }
  function planSelection(container, row) {
    const checked = [...container.querySelectorAll('[data-plan-member]:checked')].map(input => input.value);
    const primary = container.querySelector('[data-plan-primary]');
    if (!primary) return null;
    const previous = primary.value;
    primary.innerHTML = (row.candidates || []).filter(person => checked.includes(person.technicianId)).map(person => `<option value="${escape(person.technicianId)}">${escape(person.name)}</option>`).join('');
    primary.value = checked.includes(previous) ? previous : checked[0] || '';
    const maximum = row.fulfillmentType === 'delivery_only' ? 1 : 10;
    const invalid = checked.length && (checked.length < (row.staffing?.recommendedCount || 1) || checked.length > maximum);
    container.querySelector('[data-plan-error]').textContent = invalid ? maximum === 1 ? 'Legacy delivery-only jobs use one technician. Uncheck everyone to skip.' : `Select at least ${row.staffing?.recommendedCount || 1} technicians (up to 10), or uncheck everyone to skip.` : '';
    return checked.length ? { technicianId: primary.value, technicianIds: checked, invalid: !!invalid } : null;
  }
  let modal, requestId = 0;
  async function open(source, id, options = {}) {
    if (!['booking', 'order'].includes(source) || !validId(id)) return;
    const currentRequest = ++requestId;
    for (const existing of document.querySelectorAll('.modal.show')) bootstrap.Modal.getInstance(existing)?.hide();
    modal?.dispose?.(); document.getElementById('jobTeamModal')?.remove();
    const element = document.createElement('div'); element.className = 'modal fade'; element.id = 'jobTeamModal'; element.tabIndex = -1;
    element.setAttribute('aria-labelledby', 'jobTeamTitle');
    element.innerHTML = `<div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable"><form class="modal-content"><div class="modal-header"><div><h5 class="modal-title" id="jobTeamTitle">Assign technicians</h5><p class="small text-muted mb-0">One appointment. One team. One primary technician.</p></div><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body"><fieldset class="job-team-options"><legend class="fs-6">Assignment type</legend><label><input type="radio" name="teamMode" value="single" checked> Assign one technician</label><label><input type="radio" name="teamMode" value="multiple"> Assign multiple technicians</label></fieldset><p class="small text-muted">Each technician must be available for the whole appointment. Every selected member receives an acceptance request.</p><div data-team-list aria-live="polite">Checking availability…</div><label class="d-block mt-3">Primary technician<select class="form-select" name="primary" required><option value="">Choose a technician</option></select><small class="text-muted">Manages job status, shared tools, payments and completion.</small></label><label class="d-block mt-3">Assignment notes <span class="text-muted">(optional)</span><textarea name="notes" class="form-control" maxlength="1000" rows="2"></textarea></label><div data-team-error class="text-danger mt-2" role="alert"></div></div><div class="modal-footer"><button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button><button type="submit" class="btn btn-primary" disabled>Assign technician</button></div></form></div>`;
    document.body.append(element); modal = new bootstrap.Modal(element); modal.show();
    const form = element.querySelector('form'), list = form.querySelector('[data-team-list]'), primary = form.elements.primary, submit = form.querySelector('[type=submit]'), error = form.querySelector('[data-team-error]');
    if (source === 'order') {
      const schedule = document.createElement('fieldset'); schedule.className = 'mb-3';
      schedule.innerHTML = '<legend class="fs-6">Installation schedule</legend><div class="row g-2"><label class="col-sm-6">Date<input type="date" class="form-control" name="scheduledDate" required></label><label class="col-sm-6">Start time<input type="time" class="form-control" name="timeSlot" required step="1800"></label></div><button type="button" data-check-team class="btn btn-outline-primary btn-sm mt-2">Check team availability</button>';
      list.before(schedule);
      schedule.addEventListener('change', () => { candidateRequest++; rows = []; list.textContent = 'Check availability for the new schedule.'; loading = true; refresh(); });
      schedule.querySelector('[data-check-team]').addEventListener('click', () => loadCandidates());
    }
    let rows = [], loading = true, busy = false, candidateRequest = 0, preselected = false;
    const staffingHint = document.createElement('p'); staffingHint.className = 'alert alert-info small'; staffingHint.hidden = true; list.before(staffingHint);
    if (source === 'booking') {
      const refreshButton = document.createElement('button'); refreshButton.type = 'button'; refreshButton.className = 'btn btn-outline-secondary btn-sm mt-2'; refreshButton.textContent = 'Refresh availability'; refreshButton.addEventListener('click', () => loadCandidates()); list.after(refreshButton);
    }
    const scheduleInput = () => source === 'order' ? { scheduledDate: form.elements.scheduledDate.value, timeSlot: form.elements.timeSlot.value } : {};
    function refresh() {
      const multiple = form.elements.teamMode.value === 'multiple';
      const checked = [...form.querySelectorAll('[name=member]:checked')].map(input => input.value);
      if (!multiple && checked.length > 1) for (const input of form.querySelectorAll('[name=member]')) input.checked = input.value === (primary.value || checked[0]);
      const selected = [...form.querySelectorAll('[name=member]:checked')].map(input => input.value);
      const previous = primary.value;
      primary.innerHTML = '<option value="">Choose a primary technician</option>' + rows.filter(row => selected.includes(row.technicianId)).map(row => `<option value="${row.technicianId}">${escape(row.name)}</option>`).join('');
      primary.value = selected.includes(previous) ? previous : selected[0] || '';
      submit.textContent = multiple ? `Assign ${selected.length} technicians` : 'Assign technician';
      submit.disabled = loading || busy || !primary.value || !selected.length || selected.length > 10 || multiple && selected.length < 2;
      const primaryLabel = primary.closest('label'); primaryLabel.hidden = !multiple; primaryLabel.classList.toggle('d-block', multiple);
    }
    form.addEventListener('change', event => {
      if (event.target.name === 'member' && form.querySelectorAll('[name=member]:checked').length > 10) { event.target.checked = false; error.textContent = 'Choose up to ten technicians.'; }
      if (event.target.name === 'member' && form.elements.teamMode.value === 'single' && event.target.checked) {
        form.querySelectorAll('[name=member]').forEach(input => { if (input !== event.target) input.checked = false; });
        primary.value = '';
      }
      refresh();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || submit.disabled || !form.reportValidity()) return;
      busy = true; error.textContent = ''; refresh();
      try {
        const selected = [...form.querySelectorAll('[name=member]:checked')].map(input => input.value);
        await json(`/api/work-teams/${source}/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ technicianId: primary.value, technicianIds: selected, notes: form.elements.notes.value, ...scheduleInput() }) });
        modal.hide(); options.onAssigned?.();
        if (window.Swal) await Swal.fire({ icon: 'success', title: selected.length > 1 ? 'Technician team assigned' : 'Technician assigned', text: 'Each selected technician must accept the assignment.' });
        document.dispatchEvent(new CustomEvent('racs:team-assigned', { detail: { source, id } }));
      } catch (failure) { error.textContent = failure.message; busy = false; refresh(); }
    });
    async function loadCandidates() {
     const sequence = ++candidateRequest; loading = true; refresh(); error.textContent = ''; list.textContent = 'Checking availability...';
     try {
      const result = await json(`/api/work-teams/${source}/${id}/candidates?${new URLSearchParams(scheduleInput())}`);
      if (currentRequest !== requestId || sequence !== candidateRequest || !element.isConnected) return;
      if (source === 'order') { form.elements.scheduledDate.value = result.visit.date; form.elements.timeSlot.value = result.visit.time.split(/\s+-\s+/)[0]; }
      rows = result.candidates || [];
      if (result.staffing) { staffingHint.hidden = false; staffingHint.textContent = `${result.staffing.recommendedCount} technician(s) recommended. ${result.staffing.reason} Staff can review the crew for this job.`; }
      list.innerHTML = rows.length ? `<div class="job-team-list">${rows.map(row => `<label class="job-team-person${row.available ? '' : ' unavailable'}"><input type="checkbox" name="member" value="${escape(row.technicianId)}" ${row.available ? '' : 'disabled'}><span><strong>${escape(row.name)}</strong><small>${escape(row.reason)}</small></span></label>`).join('')}</div>` : '<div class="alert alert-warning">No active technician accounts are available.</div>';
      if (result.team?.length > 1) form.elements.teamMode.value = 'multiple';
      const proposed = !preselected && options.recommendedTeam?.length ? options.recommendedTeam : result.team || [];
      preselected = true;
      if (proposed.length > 1) form.elements.teamMode.value = 'multiple';
      const currentIds = proposed.map(row => row.technicianId);
      for (const input of form.querySelectorAll('[name=member]')) input.checked = !input.disabled && currentIds.includes(input.value);
      primary.value = proposed.find(row => row.role === 'primary')?.technicianId || proposed[0]?.technicianId || '';
      loading = false; refresh();
     } catch (failure) { if (sequence !== candidateRequest) return; list.textContent = ''; error.textContent = failure.message; }
    }
    await loadCandidates();
  }
  async function note(id) {
    if (!validId(id)) return;
    const result = await Swal.fire({ title: 'Add a work note', input: 'textarea', inputAttributes: { maxlength: 1000 }, showCancelButton: true, confirmButtonText: 'Save note', inputValidator: value => !value?.trim() ? 'Enter a work note.' : undefined });
    if (!result.isConfirmed) return;
    try { await json(`/api/technician/assignments/${id}/note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: result.value }) }); await Swal.fire({ icon: 'success', title: 'Work note saved' }); }
    catch (failure) { await Swal.fire({ icon: 'error', title: 'Could not save note', text: failure.message }); }
  }
  async function orderNote(id) {
    if (!validId(id)) return;
    const result = await Swal.fire({ title: 'Add an installation note', input: 'textarea', inputAttributes: { maxlength: 1000 }, showCancelButton: true, confirmButtonText: 'Save note', inputValidator: value => !value?.trim() ? 'Enter a work note.' : undefined });
    if (!result.isConfirmed) return;
    try { await json(`/api/work-teams/order/${id}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: result.value }) }); await supportingOrders(); }
    catch (failure) { await Swal.fire({ icon: 'error', text: failure.message }); }
  }
  function assignmentActions(a) {
    if (!validId(a?._id)) return '';
    if (a.status === 'pending_acceptance') return `<button class="btn btn-success" onclick="RACSJobTeams.respondBooking('${a._id}','accept',this)">Accept team assignment</button><button class="btn btn-outline-danger" onclick="RACSJobTeams.respondBooking('${a._id}','decline',this)">Decline</button>`;
    return `<p class="small text-muted mb-2">Supporting technician. The primary technician manages job status, shared tools, payments and completion.</p>${['cancelled','declined','expired','completed'].includes(a.status) ? '' : `<button class="btn btn-outline-primary" onclick="RACSJobTeams.note('${a._id}')">Add work note</button>`}`;
  }
  function supportCard(a) {
    const rows = a.technicianTeam || a.bookingId?.technicianTeam?.map(row => ({ ...row, role: String(row.technicianId) === String(a.bookingId.technicianId) ? 'primary' : 'support' }));
    return `<article class="card border-0 shadow-sm mb-3"><div class="card-body"><span class="badge bg-primary-subtle text-primary">Supporting technician</span><h5 class="mt-2">${escape(a.serviceName || 'Service appointment')}</h5><p>${escape(a.customerName)} · ${escape(a.startTime)} · ${escape(new Date(a.bookingDate).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' }))}</p><p>${escape(a.address)}${a.customerPhone ? '<br>' + escape(a.customerPhone) : ''}</p>${a.bookingNotes ? `<p><strong>Special instructions</strong><br>${escape(a.bookingNotes)}</p>` : ''}${summary(rows)}${assignmentActions(a)}</div></article>`;
  }
  function display(source, job, container, editable = false) {
    if (!container || !job) return;
    const entries = job.technicianTeam?.length ? job.technicianTeam : editable && job.technicianId ? [{ technicianId: job.technicianId?._id || job.technicianId, name: job.technician?.name || job.technicianId?.name || 'Primary technician', status: ['assigned', 'technician_assigned'].includes(job.status) ? 'pending' : 'accepted' }] : [];
    if (!entries.length) return;
    const rows = entries.map(row => ({ ...row, role: String(row.technicianId) === String(job.technicianId?._id || job.technicianId) ? 'primary' : 'support' }));
    const section = document.createElement('section'); section.innerHTML = summary(rows);
    if (editable) for (const entry of entries) for (const note of entry.workNotes || []) {
      const paragraph = document.createElement('p'); paragraph.className = 'small'; paragraph.textContent = `${entry.name} - ${note.text}`; section.append(paragraph);
    }
    if (editable && !job.isProject && validId(job._id) && ['assigned','confirmed','scheduled','inspection_scheduled','technician_assigned','technician_accepted'].includes(job.status)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-sm btn-outline-primary mb-3'; button.textContent = 'Review technician team';
      button.addEventListener('click', () => open(source, job._id, { onAssigned: () => location.reload() })); section.append(button);
    }
    container.prepend(section);
  }
  async function supportingOrders() {
    if (!location.pathname.startsWith('/technician/orders')) return;
    try {
      const data = await json('/api/work-teams/mine');
      let host = document.getElementById('supportingInstallationTeams');
      if (!host) { host = document.createElement('section'); host.id = 'supportingInstallationTeams'; (document.querySelector('main') || document.body).prepend(host); }
      host.hidden = !data.jobs?.length;
      host.innerHTML = '<h4 class="mt-3">Supporting installation assignments</h4>' + (data.jobs || []).map(job => `<article class="card mb-3"><div class="card-body"><h5>${escape(job.reference)}</h5><p>${escape(job.customer)} · ${escape(job.address)}</p><p>${escape(new Date(job.date).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila' }))} · ${escape(job.time)}</p>${summary(job.team)}<p>Job status: ${escape(job.status)}</p>${job.myStatus === 'pending' ? `<button class="btn btn-success me-2" data-team-respond="accept" data-id="${job.id}">Accept</button><button class="btn btn-outline-danger" data-team-respond="decline" data-id="${job.id}">Decline</button>` : '<p class="small text-muted">The primary technician manages installation, shared tools, payment and completion.</p>'}</div></article>`).join('');
      host.querySelectorAll('[data-team-respond]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        try { await json(`/api/work-teams/order/${button.dataset.id}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: button.dataset.teamRespond }) }); await supportingOrders(); }
        catch (failure) { button.disabled = false; await Swal.fire({ icon: 'error', text: failure.message }); }
      }));
      (data.jobs || []).forEach((job, index) => {
        const body = host.querySelectorAll('article .card-body')[index];
        if (job.myStatus === 'accepted') {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-outline-primary btn-sm'; button.textContent = 'Add work note'; button.addEventListener('click', () => orderNote(job.id)); body.append(button);
        }
        for (const entry of job.myNotes || []) { const paragraph = document.createElement('p'); paragraph.className = 'small mt-2'; paragraph.textContent = entry.text; body.append(paragraph); }
      });
    } catch (error) {
      let host = document.getElementById('supportingInstallationTeams');
      if (!host) { host = document.createElement('section'); host.id = 'supportingInstallationTeams'; (document.querySelector('main') || document.body).prepend(host); }
      host.innerHTML = `<div class="alert alert-warning">Supporting assignments could not be loaded. <button type="button" class="btn btn-sm btn-outline-secondary" data-team-retry>Retry</button></div>`;
      host.querySelector('[data-team-retry]').addEventListener('click', supportingOrders);
    }
  }
  async function respondBooking(id, decision, button) {
    button.disabled = true;
    const finish = window.TechnicianWorkUpdates?.beginMutation?.();
    try { await json(`/api/technician/assignments/${id}/${decision}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); if (window.TechnicianWorkUpdates) finish?.(true); else if (window._refreshTechnicianWork) await window._refreshTechnicianWork(); else location.reload(); }
    catch (failure) { finish?.(false); button.disabled = false; await Swal.fire({ icon: 'error', text: failure.message }); }
  }
  window.RACSJobTeams = { open, recommendation, planPicker, planRow, planSelection, note, orderNote, summary, ready, assignmentActions, supportCard, respondBooking, display, supportingOrders };
  supportingOrders();
  window.addEventListener('racs:work-refresh', supportingOrders);
  const styles = document.createElement('style'); styles.textContent = '.job-team-options{display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:1rem}.job-team-options label{padding:.75rem;border:1px solid #cbd5e1;border-radius:10px}.job-team-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.5rem}.job-team-person{display:flex;gap:.75rem;padding:.85rem;border:1px solid #cbd5e1;border-radius:10px;align-items:start}.job-team-person:has(input:checked){border-color:#2563eb;background:#eff6ff}.job-team-person.unavailable{opacity:.6}.job-team-person small,.job-team-summary small{display:block;color:#64748b}.job-team-summary{padding:.85rem;background:#f8fafc;border-radius:10px;margin:.75rem 0}.job-team-summary>div{display:flex;justify-content:space-between;gap:1rem;padding:.35rem 0}'; document.head.append(styles);
})();

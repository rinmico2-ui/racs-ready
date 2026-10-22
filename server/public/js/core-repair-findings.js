(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const money = value => new Intl.NumberFormat('en-PH', { style:'currency', currency:'PHP', maximumFractionDigits:2 }).format(Number(value) || 0);
  const drafts = new Map();
  let dialog, state, draft, busy = false, returnFocus, generation = 0, onSaved, urls = [];
  const statuses = { continuing:'Core service can continue', on_hold:'Core work paused · Operations review', resumed:'Core work cleared to continue', not_performed:'Affected core work will not be performed' };
  async function request(url, options) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(),20000);
    try {
      const response = await fetch(url, { credentials:'same-origin', cache:'no-store', ...options, signal:controller.signal });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'This action could not be saved. Try again.');
      return data;
    } catch (err) { if (err.name === 'AbortError') throw Error('The connection timed out. Your details are kept; retry to check the saved finding.'); throw err; }
    finally { clearTimeout(timer); }
  }
  function endpoint() { return `${state.role === 'technician' ? '/api/technician' : '/api'}/appointments/${encodeURIComponent(state.bookingId)}/repair-findings`; }
  function clearUrls() { urls.forEach(url => URL.revokeObjectURL(url)); urls = []; }
  function close() {
    if (busy) return;
    generation++; clearUrls(); dialog?.close(); dialog?.remove(); dialog = null; returnFocus?.focus?.({preventScroll:true});
  }
  function error(message) {
    const box = dialog.querySelector('[data-error]'); box.hidden = false; box.textContent = message; box.focus();
  }
  function shell(body, footer = '') {
    clearUrls();
    dialog.innerHTML = `<header class="crf-header"><div><span class="crf-eyebrow">${esc(state.reference || 'Service visit')}</span><h2 id="crf-title">Repair found during service</h2></div><button type="button" class="crf-close" aria-label="Close repair findings">×</button></header><div class="crf-body"><div class="crf-error" data-error role="alert" tabindex="-1" hidden></div>${body}</div><footer class="crf-footer">${footer || '<button type="button" class="crf-btn" data-close>Close</button>'}</footer>`;
    dialog.querySelector('.crf-close').onclick = close; dialog.querySelector('[data-close]')?.addEventListener('click',close);
  }
  function setBusy(value) {
    busy = value; dialog?.setAttribute('aria-busy',String(value));
    dialog?.querySelectorAll('button,input,select,textarea').forEach(el => { el.disabled = value; });
  }
  function remember(form) {
    if (!form) return;
    const values = new FormData(form);
    for (const key of ['appliance','findings','recommendedAction','severity','coreCanContinue']) draft[key] = values.get(key) || '';
    const files = Array.from(form.elements.photos.files || []); if (files.length) draft.files = files;
    drafts.set(state.bookingId,draft);
  }
  function sources() { return state.sources.filter(row => row.eligible && !row.findingId); }
  function previews(files = draft.files || []) {
    return `<div class="crf-preview">${files.map(file => { const url = URL.createObjectURL(file); urls.push(url); return `<img src="${url}" alt="Attached finding photo">`; }).join('')}</div>`;
  }
  function edit() {
    shell(`<ol class="crf-steps" aria-label="Report progress"><li aria-current="step">1 · Record finding</li><li>2 · Review</li></ol><p class="crf-intro">Describe what you found on the booked appliance. Prepare the quotation next so the customer can decide.</p><form id="crf-form"><label class="crf-field">Appliance *<select name="appliance" required><option value="">Choose an appliance</option>${sources().map(row => `<option value="${row.serviceItemId}:${row.unitIndex}">${esc(row.label)} · ${esc(row.services.join(' + '))}</option>`).join('')}</select><small data-appliance-note>Select the appliance you are servicing.</small></label><label class="crf-field">What did you find? *<textarea name="findings" required minlength="10" maxlength="2000" rows="3" placeholder="Describe the fault and the checks that identified it."></textarea></label><label class="crf-field">Recommended repair *<textarea name="recommendedAction" required minlength="5" maxlength="1000" rows="2" placeholder="What additional work would fix this?"></textarea></label><label class="crf-field">Urgency<select name="severity"><option value="standard">Repair needed</option><option value="urgent">Needs prompt attention</option><option value="unsafe">Unsafe to continue servicing</option></select></label><fieldset class="crf-work-choice"><legend>Can the booked core work continue? *</legend><label><input type="radio" name="coreCanContinue" value="yes" required><span>Continue the original service<small>The finding does not prevent the booked work.</small></span></label><label><input type="radio" name="coreCanContinue" value="no" required><span>Pause the affected work<small>Operations must review it. Other appliances can continue.</small></span></label></fieldset><label class="crf-field">Photos <small>Optional · up to 4 JPG, PNG or WEBP photos, 5 MB each</small><input name="photos" type="file" multiple accept="image/jpeg,image/png,image/webp"><span data-file-count></span></label><div data-previews>${previews()}</div><div class="crf-callout"><strong>No added inspection or travel fee</strong>Saving a finding keeps the original service price. Repair charges need a separate customer decision.</div></form>`, '<button type="button" class="crf-btn" data-close>Keep draft & close</button><button type="submit" form="crf-form" class="crf-btn primary">Review finding</button>');
    const form = dialog.querySelector('#crf-form');
    for (const key of ['appliance','findings','recommendedAction','severity']) form.elements[key].value = draft[key] || (key === 'severity' ? 'standard' : '');
    if (!draft.appliance && sources().length === 1) form.elements.appliance.value = `${sources()[0].serviceItemId}:${sources()[0].unitIndex}`;
    if (draft.coreCanContinue) form.querySelector(`[name="coreCanContinue"][value="${draft.coreCanContinue === 'yes' ? 'yes' : 'no'}"]`).checked = true;
    const note = () => {
      const row = sources().find(row => `${row.serviceItemId}:${row.unitIndex}` === form.elements.appliance.value);
      form.querySelector('[data-appliance-note]').textContent = row ? `Booked work: ${row.services.join(', ')}` : 'Select the appliance you are servicing.';
    };
    form.elements.appliance.onchange = note; note();
    form.elements.severity.onchange = () => { if (form.elements.severity.value === 'unsafe') { form.querySelector('[name="coreCanContinue"][value="no"]').checked = true; } remember(form); };
    form.oninput = () => remember(form);
    form.elements.photos.onchange = () => {
      const files = Array.from(form.elements.photos.files || []);
      form.elements.photos.setCustomValidity(files.length > 4 || files.some(file => !['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 5*1024*1024) ? 'Choose up to 4 JPG, PNG or WEBP photos, 5 MB each.' : '');
      if (!form.elements.photos.reportValidity()) return;
      draft.files = files; clearUrls(); dialog.querySelector('[data-previews]').innerHTML = previews(files);
      dialog.querySelector('[data-file-count]').textContent = `${files.length} photo${files.length === 1 ? '' : 's'} selected`; remember(form);
    };
    form.onsubmit = event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      if (form.elements.severity.value === 'unsafe' && form.elements.coreCanContinue.value !== 'no') return error('Pause the affected work when the appliance is unsafe to service.');
      remember(form); review();
    };
    dialog.querySelector('[data-close]').onclick = () => { remember(form); close(); };
    form.elements.appliance.focus({preventScroll:true});
  }
  function review() {
    const row = sources().find(row => `${row.serviceItemId}:${row.unitIndex}` === draft.appliance);
    if (!row) return edit();
    shell(`<ol class="crf-steps" aria-label="Report progress"><li>1 · Record finding</li><li aria-current="step">2 · Review</li></ol><section class="crf-review"><h3>Check the finding before saving</h3><dl><dt>Appliance</dt><dd>${esc(row.label)}</dd><dt>Finding</dt><dd>${esc(draft.findings)}</dd><dt>Recommended repair</dt><dd>${esc(draft.recommendedAction)}</dd><dt>Core work</dt><dd>${draft.coreCanContinue === 'yes' ? 'Continue the original service' : 'Pause affected work for Operations review'}</dd><dt>Original booking total</dt><dd>${money(state.payment.total)} · payments already recorded stay credited</dd><dt>Added inspection and travel</dt><dd>${money(0)}</dd></dl></section><div class="crf-callout${draft.coreCanContinue === 'no' ? ' is-warning' : ''}"><strong>${draft.coreCanContinue === 'no' ? 'Operations will review the paused work' : 'Next: prepare the repair quotation'}</strong>The customer must approve the repair price before repair work begins.</div>${previews()}`, '<button type="button" class="crf-btn" data-back>Edit finding</button><button type="button" class="crf-btn primary" data-save>Save finding & prepare quote</button>');
    dialog.querySelector('[data-back]').onclick = edit; dialog.querySelector('[data-save]').onclick = save;
    dialog.querySelector('[data-save]').focus({preventScroll:true});
  }
  async function refreshWorkspace() {
    try {
      if (onSaved) await onSaved();
      else if (state.role === 'technician' && typeof window.refreshOpenAssignmentDetail === 'function') await window.refreshOpenAssignmentDetail('overview');
      window.TechnicianWorkUpdates?.request();
    } catch (err) { console.warn('Finding saved; the workspace refresh needs a retry.',err.message); }
  }
  async function save() {
    if (busy) return;
    setBusy(true); let saved = false;
    try {
      const [serviceItemId,unitIndex] = draft.appliance.split(':');
      const result = await request(`${endpoint()}/report`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ version:state.version, requestId:draft.requestId,
        serviceItemId, unitIndex:Number(unitIndex), findings:draft.findings, recommendedAction:draft.recommendedAction, severity:draft.severity, coreCanContinue:draft.coreCanContinue === 'yes' }) });
      state = result; saved = true;
      const finding = state.findings.find(row => row.id === result.findingId);
      if (draft.files?.length) {
        const latest = await request(`/api/repair-units/booking/${state.bookingId}`);
        const photos = latest.units.find(unit => unit.key === finding.key)?.inspection?.photos || [];
        if (!draft.uploadAttempted || photos.length < draft.files.length) {
          const upload = new FormData(); upload.append('version',String(latest.version)); upload.append('key',finding.key);
          draft.files.forEach(file => upload.append('photos',file)); draft.uploadAttempted = true;
          await request(`/api/repair-units/booking/${state.bookingId}/evidence`,{method:'POST',body:upload});
        }
      }
      drafts.delete(state.bookingId); setBusy(false); close(); await refreshWorkspace();
      window.openRepairUnits?.('booking',state.bookingId);
    } catch (err) {
      setBusy(false); error(`${saved ? 'The finding is saved, but the photos could not be attached. Your files are kept; select Save again to retry. ' : ''}${err.message}`);
      if (!saved) {
        const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'crf-btn'; reload.textContent = 'Load latest booking';
        reload.onclick = () => open(state.bookingId,{role:state.role,onSaved,showForm:true}); dialog.querySelector('[data-error]').append(reload);
      }
    }
  }
  function findingCard(finding, staff) {
    const refund = Number(finding.refundReviewAmount) > 0;
    const decisions = [];
    if (staff && !state.closed) {
      if (finding.coreDisposition === 'on_hold') decisions.push(
        ['resume-core','Clear affected work to continue','primary'], ['cancel-core','Do not perform affected core work','danger']);
      else if (refund && state.quotationSettled) {
        if (!finding.refundQueued) decisions.push(['queue-refund','Queue refund in Payments','primary']);
        decisions.push(['review-refund','Check recorded refund','']);
      } else if (state.canCloseUnperformed) decisions.push(['close-visit','Close reviewed visit','primary']);
    }
    const operations = decisions.length ? `<form class="crf-review-form"><label for="crf-reason-${finding.id}">Operations decision and reason *</label><textarea id="crf-reason-${finding.id}" name="reason" required minlength="5" maxlength="1000" rows="2" placeholder="Explain the decision and any work or payment follow-up."></textarea><div class="crf-actions">${decisions.map(([action,label,tone]) => `<button type="button" class="crf-btn ${tone}" data-decision="${action}">${label}</button>`).join('')}</div><p class="crf-hint">Unperformed core charges are removed. Payments remain credited. Queuing a refund does not record it as paid.</p></form>` : '';
    return `<article class="crf-finding" data-finding="${finding.id}"><span class="crf-badge${finding.coreDisposition === 'on_hold' ? ' is-hold' : ''}">${esc(statuses[finding.coreDisposition] || finding.coreDisposition)}</span>
      <h3>${esc(finding.name)}</h3><p>${esc(finding.findings)}</p><small>Recommended repair</small><p>${esc(finding.recommendedAction)}</p>
      <div class="crf-status">Repair: ${esc(finding.repairState.replace(/_/g,' '))} &middot; Added inspection fee ${money(0)}</div>
      ${finding.decisionNotes ? `<p class="crf-hint">Operations: ${esc(finding.decisionNotes)}</p>` : ''}
      ${finding.photos.length ? `<div class="crf-preview">${finding.photos.map(url => `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Finding evidence"></a>`).join('')}</div>` : ''}
      ${refund ? `<div class="crf-callout is-warning"><strong>${state.quotationSettled ? 'Refund review' : 'Potential overpayment'}: ${money(finding.refundReviewAmount)}</strong>${state.quotationSettled ? 'Payments stay recorded until the refund is actually completed.' : 'The final refund depends on the customer repair decision.'}${staff && finding.refundQueued ? `<div class="crf-actions"><a class="crf-btn" href="/${state.role === 'secretary' ? 'secretary' : 'admin'}/payments?refundStatus=open" target="_blank" rel="noopener">Open refund queue</a></div>` : ''}</div>` : ''}
      ${operations}</article>`;
  }
  function list() {
    const staff = ['admin','secretary'].includes(state.role);
    shell(`<p class="crf-intro">Findings stay with the original appliance. Repair work follows the customer?s quotation decision.</p>${state.findings.map(finding => findingCard(finding,staff)).join('')}
      ${!state.canAdd && state.role === 'technician' ? `<p class="crf-hint">${esc(state.addBlockedReason)}</p>` : ''}`,
      `<button type="button" class="crf-btn" data-close>Close</button><button type="button" class="crf-btn" data-quotes>View repair quotation</button>${state.role === 'technician' && state.canAdd && sources().length ? '<button type="button" class="crf-btn primary" data-new>Report another finding</button>' : ''}`);
    dialog.querySelector('[data-new]')?.addEventListener('click', edit);
    dialog.querySelector('[data-quotes]').onclick = () => {
      const id=state.bookingId,role=state.role; close();
      if (typeof window.openRepairUnits==='function') window.openRepairUnits('booking',id);
      else location.href=`/${role==='secretary'?'secretary':'admin'}/appointments?booking=${encodeURIComponent(id)}`;
    };
    dialog.querySelectorAll('[data-decision]').forEach(button => button.onclick = async () => {
      const form = button.closest('form'); if (busy || !form.reportValidity()) return;
      setBusy(true);
      try {
        state = await request(`${endpoint()}/${button.dataset.decision}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:state.version,findingId:button.closest('[data-finding]').dataset.finding,reason:form.elements.reason.value.trim()})});
        setBusy(false); list(); await refreshWorkspace();
      } catch(err) { setBusy(false); error(err.message); }
    });
  }
  async function open(id, options = {}) {
    if (busy || !/^[a-f\d]{24}$/i.test(String(id))) return;
    if (dialog) close(); returnFocus=document.activeElement; onSaved=options.onSaved;
    state={bookingId:id,role:options.role || 'technician',reference:''};
    draft=drafts.get(id) || {requestId:crypto.randomUUID(),files:[],severity:'standard'}; drafts.set(id,draft);
    dialog=document.createElement('dialog');dialog.className='crf-dialog';dialog.setAttribute('aria-labelledby','crf-title');
    dialog.addEventListener('cancel',event=>{event.preventDefault();close()});document.body.append(dialog);
    shell('<div class="crf-wait" role="status">Loading the latest appliance details…</div>');dialog.showModal();
    const current=++generation;
    try { const result=await request(endpoint());if(current!==generation||!dialog)return;state=result;
      if(state.role==='technician'&&state.canAdd&&sources().length&&(!state.findings.length||options.showForm))edit();else list();
    } catch(err){if(current===generation&&dialog)error(err.message);}
  }
  function actions(assignment) {
    const booking=assignment?.bookingId;
    if (!booking || typeof booking!=='object' || assignment.crewRole==='support' || assignment.status!=='in_progress' || booking.isProject || booking.sourceOrderId || assignment.serviceType==='project') return '';
    const items=booking.services||[],found=items.some(row=>row.discoveredDuringService);
    if (!found) return '';
    return `<button type="button" class="btn btn-outline-warning" onclick="CoreRepairFindings.open('${esc(booking._id)}')"><i class="bi bi-clipboard-plus me-1" aria-hidden="true"></i>Repair findings</button>`;
  }
  function notice(assignment) {
    const held=(assignment?.bookingId?.services || []).some(item=>item.coreRepairHold?.state==='on_hold');
    return held ? '<div class="alert alert-warning w-100 mb-2" role="status"><strong>Affected core work is paused.</strong> Operations must review the finding before that work resumes. Other appliances and the repair quotation can continue.</div>' : '';
  }
  window.CoreRepairFindings={open,actions,notice};
})();

(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const money = value => new Intl.NumberFormat('en-PH', { style:'currency', currency:'PHP' }).format(Number(value || 0));
  function decisionIcon(name) {
    const paths = {
      choice:'M12 3v6M5 21v-5l7-7 7 7v5M9 3h6M2 21h6M16 21h6',
      now:'M14 5a5 5 0 0 0-6 6l-5 5a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-3-3 3-3Z',
      later:'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2ZM8 15h3M8 18h6',
      cancel:'M9 9l6 6M15 9l-6 6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
      parts:'M3 7l9-4 9 4-9 5-9-5ZM3 7v10l9 4 9-4V7M12 12v9M7 5l10 5',
    };
    return `<svg class="ru-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${paths[name] || paths.choice}"></path></svg>`;
  }
  let dialog, id, state, busy = false, generation = 0, mode = 'choice', draft = {}, notice = '';
  const field = name => dialog.querySelector(`[name="${name}"]`);
  const base = () => `/api/technician/appointments/${encodeURIComponent(id)}/repair-workflow`;
  function capture() {
    dialog?.querySelectorAll('[name]').forEach(input => { if (input.type !== 'file') draft[input.name] = input.type === 'checkbox' ? input.checked : input.value; });
  }
  function restore() {
    dialog.querySelectorAll('[name]').forEach(input => { if (!Object.hasOwn(draft,input.name) || input.type === 'file') return; if (input.type === 'checkbox') input.checked = draft[input.name]; else input.value = draft[input.name]; });
  }
  function disable(value) {
    dialog.querySelectorAll('button,input,select,textarea').forEach(node => {
      if (value) { if (!Object.hasOwn(node.dataset,'rvDisabled')) node.dataset.rvDisabled = String(node.disabled); node.disabled = true; }
      else if (Object.hasOwn(node.dataset,'rvDisabled')) { node.disabled = node.dataset.rvDisabled === 'true'; delete node.dataset.rvDisabled; }
    });
  }
  function error(message) { const box = dialog.querySelector('[data-visit-error]'); box.textContent = message; box.hidden = false; box.focus(); box.scrollIntoView({block:'nearest'}); }
  async function request(url, body) {
    let response;
    try { response = await fetch(url, { credentials:'same-origin', signal:AbortSignal.timeout(45000), ...(body ? { method:'POST', ...(body instanceof FormData ? {body} : {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}) } : {}) }); }
    catch (failure) { throw Error(['TimeoutError','AbortError'].includes(failure.name) ? 'This request took too long. Refresh the work plan to check whether it was saved.' : 'Could not connect. Your return-visit details are still here. Please try again.'); }
    const data = await response.json().catch(() => ({ error:'The server could not complete this request. Please try again.' }));
    if (!response.ok) throw Object.assign(Error(data.error || data.message || 'Could not update this repair visit.'), {code:data.code});
    return data;
  }
  const minutes = () => ({ repairMinutes:Number(field('repairMinutes')?.value ?? draft.repairMinutes ?? state.repairMinutes), purchaseMinutes:Number(field('purchaseMinutes')?.value ?? draft.purchaseMinutes ?? state.purchaseMinutes), confirmedQuotationTotal:Number(state.confirmedQuotationTotal), ...(field('onsiteConsent') ? {customerAgreed:field('onsiteConsent').checked} : {}) });
  function consent() {
    return state.requiresOnSiteConsent ? `<label class="rv-check rq-consent rv-consent"><input type="checkbox" name="onsiteConsent" required><span>I explained the <strong>${money(state.confirmedQuotationTotal)}</strong> repair quotation and the customer agreed to this repair choice on site.</span></label>` : '<p class="rv-approved">Customer approval is recorded for this quotation.</p>';
  }
  function paymentCard() {
    const bill = state.firstVisitPayment;
    if (!bill) return '<section class="rv-card"><h3>First-visit payment</h3><p>Refresh this page to load the latest first-visit balance before requesting another visit.</p></section>';
    const rows = '<dl><div><dt>Inspection</dt><dd>'+money(bill.repairInspectionFee)+'</dd></div><div><dt>Travel fee</dt><dd>'+money(bill.distanceFare)+'</dd></div>'+(bill.coreServiceAmount > 0 ? '<div><dt>Completed core services</dt><dd>'+money(bill.coreServiceAmount)+'</dd></div>' : '')+'<div><dt>Payments applied</dt><dd>&minus;'+money(bill.credited)+'</dd></div><div class="rv-bill-total"><dt>Remaining for this visit</dt><dd>'+money(bill.amountDue)+'</dd></div></dl>';
    if (bill.settled) return '<section class="rv-card rv-bill rv-paid-card" data-first-visit><div class="rv-paid-heading"><span aria-hidden="true">&#10003;</span><div><h3>First visit paid in full</h3><p>Inspection, travel and completed core services are covered. No collection is needed.</p></div></div><details class="rv-paid-breakdown"><summary>View payment breakdown</summary>'+rows+'</details></section>';
    return '<section class="rv-card rv-bill" data-first-visit><div class="rv-card-heading"><h3>First-visit payment</h3><span class="rv-badge">Balance due</span></div><p>Inspection, travel and completed core services. The repair quotation is separate.</p>'+rows+'<details class="rv-payment-details" open><summary>Record payment received</summary><form data-visit-payment><div class="ru-grid"><label class="ru-field">Payment method *<select name="visitPaymentMethod"><option value="cash">Cash</option><option value="gcash">GCash</option><option value="maya">Maya</option><option value="bank_transfer">Bank transfer</option></select></label><label class="ru-field">Reference / notes<input name="visitPaymentNotes" maxlength="1000" placeholder="Optional collection notes"></label></div><label class="rv-check"><input type="checkbox" name="visitPaymentReceived" required><span>I received <strong>'+money(bill.amountDue)+'</strong> from the customer. Record only money actually received.</span></label><button type="submit" class="ru-btn" data-record-payment>Record '+money(bill.amountDue)+' payment</button></form></details></section>';
  }
  function purchaseForms() {
    return (state.purchases || []).map(purchase => {
      if (['receipt_uploaded','verified'].includes(purchase.purchaseStatus)) return `<div class="rv-purchase"><strong>${esc(purchase.partName)}</strong><p>Received and recorded.</p></div>`;
      return `<form class="rv-purchase" data-purchase-key="${esc(purchase.key)}"><h4>${esc(purchase.partName)} · ${esc(purchase.quantity)} required</h4><p>${esc(purchase.supplierName)}</p>${purchase.purchaseByType === 'customer' ? '<label class="rv-check"><input type="checkbox" name="correct" required> I checked the customer-provided part and received the full quantity.</label><button type="submit" class="ru-btn">Verify received part</button>' : `<div class="ru-grid"><label class="ru-field">Actual total buying cost (PHP)<input type="number" name="actualCost" required min="0.01" max="1000000" step="0.01" value="${esc(purchase.expectedPurchaseCost)}"></label><label class="ru-field">Receipt photo or PDF<input type="file" name="receipt" required accept="image/jpeg,image/png,image/webp,application/pdf"><small>Up to 5 MB. Staff will review the expense.</small></label></div><button type="submit" class="ru-btn">Save receipt and received parts</button>`}</form>`;
    }).join('');
  }
  function toolsMarkup() {
    const running = state.execution?.status === 'in_progress';
    return (state.tools || []).map(tool => `<div class="rv-tool"><div class="rv-tool-heading"><strong>${esc(tool.name)}</strong><span class="rv-tool-status ${tool.ready ? 'is-ready' : ''}">${esc(tool.detail || (tool.ready ? 'At site' : 'Not ready'))}</span></div>${tool.decisionReason ? `<p class="rv-tool-reason">${esc(tool.decisionReason)}</p>` : ''}${!running && tool.key && tool.decisionReason ? `<button type="button" class="ru-btn" data-require-tool="${esc(tool.key)}">Require this tool again</button>` : !running && tool.key && !tool.ready ? `<details class="rv-tool-decision"><summary>Not required for this repair?</summary><form data-tool-decision data-tool-key="${esc(tool.key)}"><label class="ru-field">Why can this repair proceed without this tool? *<textarea name="toolReason:${esc(tool.key)}" required minlength="5" maxlength="500" placeholder="Explain why this tool is unnecessary for the diagnosed repair."></textarea></label><button type="submit" class="ru-btn">Mark not required</button></form></details>` : ''}</div>`).join('');
  }
  function partsSummary() {
    const parts = state.parts || [], missing = parts.filter(part => part.missing > 0);
    return `<section class="rv-card rv-parts-summary" data-parts-state="${!parts.length ? 'none' : missing.length ? 'missing' : 'ready'}"><div class="rv-card-heading"><div class="rv-heading-label"><span class="rv-section-symbol">${decisionIcon('parts')}</span><div><span class="ru-eyebrow">REPLACEMENT PARTS</span><h3>${!parts.length ? 'No replacement parts needed' : missing.length ? 'Parts need to be arranged' : 'Required parts are at the site'}</h3></div></div><span class="rv-badge ${missing.length ? 'is-warning' : ''}">${missing.length ? `${missing.length} to arrange` : 'Ready'}</span></div>${parts.length ? `<div class="rv-parts">${parts.map(part => `<div><span><strong>${esc(part.name)}</strong><small>Need ${esc(part.quantity)} &middot; At site ${esc(part.available)}</small></span><span class="rq-stock-badge ${part.missing ? 'is-unavailable' : ''}">${part.purchasePending ? 'Awaiting receipt / verification' : part.missing ? `${esc(part.missing)} missing` : 'Ready'}</span></div>`).join('')}</div>` : '<p>Continue with labor only once the customer agrees and time and tools are checked.</p>'}${missing.length ? `<p>${mode === 'now' ? 'Confirm a nearby supplier below, or choose Another date if the parts cannot be obtained today.' : 'Choose Repair today to check a nearby supplier, or arrange another visit if the parts cannot be obtained today.'}</p>` : ''}</section>`;
  }
  function nearbyPurchasePanel(missing) {
    if (!missing.length) return '';
    const available = !state.reasons.length && state.local.available;
    return `<section class="rv-card rv-source-card" data-nearby-purchase><div class="rv-card-heading"><div><span class="ru-eyebrow">MISSING REPLACEMENT PARTS</span><h3>Get parts from a nearby store</h3></div><span class="rv-badge ${available ? '' : 'is-warning'}">${available ? 'Purchase plan' : 'Check required'}</span></div><p>Confirm the correct part and store price before leaving. The customer quotation stays the same; the actual buying cost is recorded as an expense.</p>${!available ? `<div class="rq-stock-guidance"><strong>Today's purchase cannot be confirmed yet</strong><p>${esc(state.reasons[0] || state.local.reason || 'Check the team schedule again.')}</p><button type="button" class="ru-btn" data-mode="later">Request another visit</button></div>` : `<form data-purchase-plan><div class="ru-grid"><label class="ru-field">Nearby store / supplier *<input name="supplierName" required minlength="2" maxlength="160" placeholder="Confirmed supplier name"></label><label class="ru-field">Who will get the parts?<select name="purchaseBy"><option value="technician">Technician</option><option value="customer">Customer</option></select></label></div>${missing.map(part => `<div class="rv-buy-part" data-buy-key="${esc(part.key)}"><label class="rv-check"><input type="checkbox" checked name="purchasePart:${esc(part.key)}" aria-label="Buy ${esc(part.name)}"><span><strong>${esc(part.name)}</strong><small>${esc(part.missing)} needed</small></span></label><label class="ru-field">Total store cost (PHP) *<input type="number" min="0.01" max="1000000" step="0.01" required name="purchaseCost:${esc(part.key)}" data-buy-cost aria-label="Total store cost for ${esc(part.name)}"></label></div>`).join('')}<label class="rv-check"><input type="checkbox" name="supplierCanProvide" required><span>The supplier confirmed the correct parts and quantities are available.</span></label><label class="rv-check"><input type="checkbox" name="customerAgreed" required><span>The customer agrees to this purchase plan within the quotation.</span></label><button class="ru-btn ru-btn-primary" type="submit">Confirm nearby purchase plan</button><small class="rv-source-note">This records the plan. Receive and verify the parts before starting the repair. For a technician purchase, save the receipt for expense review.</small></form>`}</section>`;
  }
  function nowPanel() {
    const missing = (state.parts || []).filter(part => part.missing > 0 && !part.purchasePending), running = state.execution?.status === 'in_progress', purchases = purchaseForms();
    return [
      state.reasons.length ? `<section class="rv-card rq-notice"><h3>Before repairing today</h3><ul>${state.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul><button type="button" class="ru-btn" data-mode="later">Request another visit</button></section>` : '',
      !running && state.requiresOnSiteConsent ? `<section class="rv-card rv-approval-card">${consent()}</section>` : '',
      partsSummary(),
      purchases ? `<section class="rv-card"><h3>Receive purchased parts</h3><p>Record the receipt or verify customer-provided parts to make them available for repair.</p>${purchases}</section>` : '',
      !running ? nearbyPurchasePanel(missing) : '',
      `<details class="rv-card rv-time-details" ${!state.direct.available ? 'open' : ''}><summary>Team time today <span>${esc(state.direct.available ? `${state.repairMinutes} min repair${missing.length ? ` + ${state.purchaseMinutes} min purchase trip` : ''}` : 'Review required')}</span></summary><p>Work date: ${esc(state.date)}. Every crew member's schedule is checked.</p>${state.remainingCoreMinutes ? `<p>The schedule also reserves ${state.remainingCoreMinutes} minutes for unfinished core services.</p>` : ''}<div class="ru-grid"><label class="ru-field">Repair and testing (minutes)<input name="repairMinutes" type="number" min="15" max="480" step="1" value="${state.repairMinutes}"></label><label class="ru-field">Nearby purchase trip (minutes)<input name="purchaseMinutes" type="number" min="15" max="480" step="1" value="${state.purchaseMinutes}"></label></div><button type="button" class="ru-btn" data-check-time>Check time and parts again</button><p class="rv-result ${state.direct.available ? 'is-ready' : ''}">${esc(state.direct.available ? 'There is enough time if the required tools and parts are ready.' : state.direct.reason)}</p></details>`,
      `<details class="rv-card rv-tools-details" ${!state.toolsReady ? 'open' : ''}><summary>Tools at the site <span>${state.toolsReady ? 'Ready' : 'Review required'}</span></summary><p class="rv-result ${state.toolsReady ? 'is-ready' : ''}">${esc(state.toolsReady ? 'Daily preparation and tools are ready.' : state.toolReason || 'Review the daily kit before starting.')}</p>${toolsMarkup()}</details>`,
      `<section class="rv-card rv-start-card">${running ? '<h3>Repair is in progress</h3><p>Record the repairs and tests before final payment and completion.</p><button type="button" class="ru-btn ru-btn-primary" data-appliances>Record appliance repairs and tests</button>' : `<h3>Ready to start?</h3><p>${state.canStart ? 'Team time, tools and replacement parts are checked. Confirm the customer agrees before starting.' : missing.length || state.parts.some(part => part.purchasePending) ? 'Receive the missing parts first, then check the work plan again.' : 'Resolve the time, tool or visit checks above before starting.'}</p><button type="button" class="ru-btn ru-btn-primary" data-start ${state.canStart ? '' : 'disabled'}>Start approved repair</button>`}</section>`,
    ].join('');
  }
  function laterPanel() {
    const tomorrow = new Date(`${state.date}T00:00:00+08:00`); tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
    const minDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(tomorrow);
    const bill = state.firstVisitPayment;
    return `${bill?.corePending ? '<section class="rv-card rq-notice"><h3>Complete core services first</h3><p>This is a mixed visit. Finish the core-service work before ending this visit and scheduling the repair for another day.</p><button type="button" class="ru-btn" data-core>View core services</button></section>' : ''}<div class="rv-plan-grid"><aside class="rv-payment-column">${paymentCard()}</aside><section class="rv-card rv-request-card"><span class="ru-eyebrow">NEXT APPOINTMENT</span><h3>Request a return visit</h3><p>Enter dates that suit the customer. Operations will check availability, confirm the appointment and notify the customer.</p><form id="rv-return-request" data-defer><label class="ru-field">Reason and remaining work *<textarea name="reason" required minlength="5" maxlength="1000" placeholder="For example, the replacement part is unavailable or more time is needed."></textarea></label><div class="ru-grid rv-date-fields"><label class="ru-field">Preferred date *<input name="date1" type="date" min="${minDate}" required></label><label class="ru-field">Preferred time<select name="preferredTime"><option value="any">Any available time</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option></select></label></div><details class="rv-extra-dates"><summary>Add alternative dates (optional)</summary><div class="ru-grid">${[2,3].map(index=>`<label class="ru-field">Alternative date ${index-1}<input name="date${index}" type="date" min="${minDate}"></label>`).join('')}</div></details>${consent()}<div class="rv-form-actions"><button type="submit" class="ru-btn ru-btn-primary" ${bill?.corePending || (state.visitReasons || []).length ? 'disabled' : ''}>Send return-visit request</button><small>${bill?.settled ? 'This sends a request; the date is confirmed by Operations.' : 'Record the first-visit payment above before sending. Your entered dates and reason will be kept.'}</small></div></form></section></div>`;
  }
  function cancelPanel() {
    const bill = state.firstVisitPayment;
    return `<div class="rv-plan-grid"><aside class="rv-payment-column">${!bill?.corePending ? paymentCard() : ''}</aside><section class="rv-card rv-request-card"><span class="ru-eyebrow">CUSTOMER DECISION</span><h3>Cancel the quoted repair</h3><p>Inspection, travel and completed core services remain payable. ${bill?.corePending ? 'The core services on this visit remain active.' : 'This ends the repair visit.'}</p><form id="rv-cancel-request" data-cancel-repair><label class="ru-field">Customer's cancellation reason *<textarea name="cancelReason" required minlength="5" maxlength="1000"></textarea></label><label class="rv-check"><input type="checkbox" name="cancelConsent" required> The customer heard the quotation and asked to cancel this repair.</label><button type="submit" class="ru-btn rq-btn-danger">Record cancellation</button></form></section></div>`;
  }
  function render() {
    dialog.dataset.decision = mode;
    const labels = {choice:'Choose the next repair step',now:'Prepare the repair today',later:'Plan a return visit',cancel:'Cancel quoted repair'};
    dialog.innerHTML = `<header class="ru-header"><div class="ru-heading-group"><span class="ru-heading-icon">${decisionIcon(mode)}</span><div><span class="rv-eyebrow">REPAIR WORK PLAN · ${esc(state.reference)}</span><h2>${labels[mode]}</h2><p>${mode === 'later' ? 'Settle this visit and request a new repair date.' : 'Choose the next step with the customer.'}</p></div></div><button type="button" class="ru-close" aria-label="Close repair work plan">×</button></header><div class="ru-body"><div class="ru-error" data-visit-error role="alert" tabindex="-1" hidden></div>${notice ? `<p class="rq-notice" role="status">${esc(notice)}</p>` : ''}<section class="rv-quote-bar"><div><span class="ru-eyebrow">QUOTED REPAIR TOTAL</span><strong>${money(state.confirmedQuotationTotal)}</strong><small>Inspection and travel are separate.</small></div><span class="rv-quote-status" data-approval="${state.requiresOnSiteConsent ? 'pending' : 'approved'}">${state.requiresOnSiteConsent ? 'Awaiting customer decision' : 'Customer approval recorded'}</span></section><nav class="rv-decisions" aria-label="Repair decision">${[['now','Repair today','Use brought parts or buy nearby'],['later','Another date','Request a return visit'],['cancel','Cancel repair','Record the customer reason']].map(([key,title,description])=>`<button type="button" data-mode="${key}" aria-pressed="${mode===key}"><span class="rv-decision-mark">${decisionIcon(key)}</span><span><strong>${title}</strong><small>${description}</small></span></button>`).join('')}</nav>${(state.visitReasons || []).length ? `<section class="rv-card rq-notice"><h3>Before continuing</h3><ul>${state.visitReasons.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul><button type="button" class="ru-btn" data-appliances>View inspection and quotation</button></section>` : ''}${mode==='now' ? nowPanel() : mode==='later' ? laterPanel() : mode==='cancel' ? cancelPanel() : partsSummary()}</div><footer class="ru-footer rv-action-footer"><p>${mode==='later' ? 'Return-visit requests go to Repair Scheduling. The new appointment is confirmed separately.' : 'Record the customer’s decision before continuing with the quoted repair.'}</p><div data-visit-actions></div></footer>`;
    const action = dialog.querySelector('[data-defer] [type=submit], [data-cancel-repair] [type=submit], [data-start]');
    if (action) { if (action.form) action.setAttribute('form',action.form.id); dialog.querySelector('[data-visit-actions]').append(action); }
    restore(); bind();
  }
  function bind() {
    dialog.querySelectorAll('[data-tool-decision]').forEach(form => form.addEventListener('submit', event => {
      event.preventDefault();
      if (form.reportValidity()) save('tool-decision', { key:form.dataset.toolKey, notRequired:true, reason:form.querySelector('textarea').value.trim() });
    }));
    dialog.querySelectorAll('[data-require-tool]').forEach(button => button.onclick = () => save('tool-decision', {
      key:button.dataset.requireTool, notRequired:false, reason:'Technician marked this tool required again after reviewing the repair.',
    }));
    dialog.querySelector('.ru-close').onclick = () => { if (!busy) { capture(); dialog.close(); } };
    dialog.querySelectorAll('[data-mode]').forEach(button=>button.onclick=async()=>{ if(busy)return;capture();mode=button.dataset.mode;notice='';render();try{await load();}catch(failure){error(failure.message);} });
    dialog.querySelectorAll('[data-appliances]').forEach(button=>button.onclick=()=>{capture();dialog.close();window.openRepairUnits('booking',id);});
    dialog.querySelector('[data-core]')?.addEventListener('click',()=>{capture();dialog.close();window.refreshOpenAssignmentDetail?.('core-service');});
    dialog.querySelector('[data-check-time]')?.addEventListener('click',async()=>{if(busy)return;capture();try{await load();}catch(failure){error(failure.message);} });
    dialog.querySelector('[data-start]')?.addEventListener('click',()=>save('start',minutes()));
    dialog.querySelector('[data-defer]')?.addEventListener('submit',event=>{
      event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;
      if(!state.firstVisitPayment?.settled){dialog.querySelector('[data-first-visit]').scrollIntoView({block:'start',behavior:'smooth'});return error('Record the remaining first-visit payment shown above, then send this request. Your dates and reason are still here.');}
      save('defer',{...minutes(),reason:form.elements.reason.value,preferredDates:[1,2,3].map(index=>form.elements['date'+index].value).filter(Boolean),preferredTime:form.elements.preferredTime.value});
    });
    dialog.querySelector('[data-cancel-repair]')?.addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;if(form.reportValidity())save('cancel-repair',{...minutes(),customerAgreed:form.elements.cancelConsent.checked,reason:form.elements.cancelReason.value});});
    dialog.querySelector('[data-visit-payment]')?.addEventListener('submit',collectPayment);
    dialog.querySelectorAll('[data-buy-key]').forEach(row => {
      const checkbox = row.querySelector('[type=checkbox]'), cost = row.querySelector('[data-buy-cost]');
      const update = () => { cost.disabled = !checkbox.checked; cost.required = checkbox.checked; };
      checkbox.onchange = update; update();
    });
    dialog.querySelector('[data-purchase-plan]')?.addEventListener('submit',event=>{
      event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;
      const parts=[...form.querySelectorAll('[data-buy-key]')].filter(row=>row.querySelector('[type=checkbox]').checked).map(row=>({key:row.dataset.buyKey,expectedPurchaseCost:Number(row.querySelector('[data-buy-cost]').value)}));
      if(!parts.length)return error('Select at least one missing replacement part for this purchase.');
      save('plan-purchase',{...minutes(),parts,supplierName:form.elements.supplierName.value,purchaseBy:form.elements.purchaseBy.value,supplierCanProvide:form.elements.supplierCanProvide.checked,customerAgreed:form.elements.customerAgreed.checked});
    });
    dialog.querySelectorAll('[data-purchase-key]').forEach(form=>form.onsubmit=async event=>{
      event.preventDefault();if(busy||!form.reportValidity())return;const key=form.dataset.purchaseKey;
      if(form.elements.correct)return save('verify-customer-part',{...minutes(),key,correctPartVerified:form.elements.correct.checked});
      const file=form.elements.receipt.files[0];if(!file||file.size>5*1024*1024||!['image/jpeg','image/png','image/webp','application/pdf'].includes(file.type))return error('Choose a JPG, PNG, WEBP or PDF receipt up to 5 MB.');
      const cost=Number(form.elements.actualCost.value),body=new FormData();body.append('receipt',file);busy=true;disable(true);
      try{const upload=await request('/api/technician/expenses/upload-receipt',body);busy=false;disable(false);await save('receipt',{...minutes(),key,receiptUrl:upload.url,actualPurchaseCost:cost});}
      catch(failure){error(failure.message);}finally{busy=false;disable(false);}
    });
  }
  async function collectPayment(event) {
    event.preventDefault();const form=event.currentTarget;if(busy||!form.reportValidity())return;
    capture();busy=true;disable(true);const bill=state.firstVisitPayment;
    const finish=window.TechnicianWorkUpdates?.beginMutation?.();
    try{
      const result=await request(`/api/technician/appointments/${encodeURIComponent(id)}/collect-inspection-payment`,{amount:bill.amountDue,inspectionFee:bill.repairInspectionFee,distanceFare:bill.distanceFare,method:form.elements.visitPaymentMethod.value,notes:form.elements.visitPaymentNotes.value});
      draft.visitPaymentReceived=false;if(field('visitPaymentReceived'))field('visitPaymentReceived').checked=false;notice=result.alreadyCollected ? 'The first-visit payment was already recorded. Review and send your return-visit request.' : 'Payment recorded. Your preferred dates and reason are kept. Review and send the return-visit request.';
      await load();finish?.(true);
    }catch(failure){finish?.(false);try{await load();}catch{}error(failure.message);}finally{busy=false;disable(false);}
  }
  async function load() {
    capture();const ticket=++generation;busy=true;disable(true);
    try{
      const data=await request(base()+'?'+new URLSearchParams({...minutes(),mode}));if(ticket!==generation)return;
      if(state&&Number(state.confirmedQuotationTotal)!==Number(data.confirmedQuotationTotal)){draft.onsiteConsent=false;draft.cancelConsent=false;notice='The repair quotation changed. Show the latest amount to the customer and confirm their decision again.';}
      if(state?.firstVisitPayment?.amountDue!==data.firstVisitPayment?.amountDue)draft.visitPaymentReceived=false;
      state=data;render();
    }finally{busy=false;disable(false);}
  }
  async function save(action, body) {
    if(busy)return;
    if(state.requiresOnSiteConsent&&['start','defer','plan-purchase'].includes(action)&&!field('onsiteConsent')?.checked)return error('Explain the repair quotation and record the customer’s agreement before continuing.');
    capture();busy=true;disable(true);const finish=window.TechnicianWorkUpdates?.beginMutation?.();
    try{
      await request(base()+'/'+action,{...body,version:state.version});
      if(action==='defer'||action==='cancel-repair'){
        draft={};notice='';dialog.querySelector('.ru-body').innerHTML=`<section class="rv-card rv-success" role="status"><span>✓</span><h3>${action==='defer'?'Return-visit request sent':'Repair cancelled'}</h3><p>${action==='defer'?'Operations will confirm the next repair appointment and notify the customer. Your current visit is closed.':'The customer’s decision and reason were saved. Inspection charges and completed core services are retained.'}</p></section>`;dialog.querySelector('.ru-close').disabled=false;dialog.querySelector('.ru-footer').innerHTML='<p>The decision has been saved.</p><div><button type="button" class="ru-btn ru-btn-primary" data-done>Done</button></div>';dialog.querySelector('[data-done]').onclick=()=>dialog.close();
      }else {
        if(action==='plan-purchase')notice='Purchase plan saved. Receive the correct parts and record the receipt or verification before starting.';
        else if(['receipt','verify-customer-part'].includes(action))notice='Parts received and recorded. Review the work plan, then start the approved repair.';
        await load();
      }
      if(finish)finish(true);else window.refreshOpenAssignmentDetail?.();
    }catch(failure){finish?.(false);if(failure.code==='PHASE_ONE_PAYMENT_REQUIRED'){try{await load();}catch{}}error(failure.message);}
    finally{busy=false;disable(false);}
  }
  window.openRepairWorkflow=async function(bookingId){
    if(busy||!/^[a-f\d]{24}$/i.test(String(bookingId||'')))return;
    if(id!==bookingId){draft={};notice='';state=null;mode='choice';}else capture();id=bookingId;
    for(const modal of document.querySelectorAll('.modal.show'))window.bootstrap?.Modal.getInstance(modal)?.hide();
    dialog ||= document.createElement('dialog');dialog.className='ru-dialog rv-dialog';dialog.setAttribute('aria-label','Repair work plan');if(!dialog.isConnected)document.body.append(dialog);
    dialog.innerHTML='<header class="ru-header"><h2>Loading repair work plan…</h2></header><div class="ru-body"><div class="ru-error" data-visit-error tabindex="-1" hidden></div></div>';if(!dialog.open)dialog.showModal();dialog.oncancel=event=>{if(busy)event.preventDefault();else capture();};
    busy=true;
    try{const data=await request(base()+'?'+new URLSearchParams({mode}));
      if(state&&Number(state.confirmedQuotationTotal)!==Number(data.confirmedQuotationTotal)){draft.onsiteConsent=false;draft.cancelConsent=false;notice='The repair quotation changed. Show the latest amount to the customer and confirm their decision again.';}
      if(state?.firstVisitPayment?.amountDue!==data.firstVisitPayment?.amountDue)draft.visitPaymentReceived=false;
      state=data;if(mode==='choice'&&state.execution?.status==='in_progress')mode='now';render();}
    catch(failure){error(failure.message);const close=document.createElement('button');close.type='button';close.className='ru-btn';close.textContent='Close';close.onclick=()=>dialog.close();dialog.querySelector('.ru-body').append(close);}
    finally{busy=false;}
  };
  window.openRepairSchedulingModal=window.openRepairWorkflow;
})();

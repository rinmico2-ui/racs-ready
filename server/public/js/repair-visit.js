(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const money = value => new Intl.NumberFormat('en-PH', { style:'currency', currency:'PHP' }).format(Number(value || 0));
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
    return `<section class="rv-card rv-bill" data-first-visit><div class="rv-card-heading"><h3>First-visit payment</h3><span class="rv-badge ${bill.settled ? 'is-paid' : ''}">${bill.settled ? 'Recorded' : 'Balance due'}</span></div><p>Only inspection, travel and completed core services are due for this visit. The repair quotation is separate.</p><dl><div><dt>Inspection</dt><dd>${money(bill.repairInspectionFee)}</dd></div><div><dt>Travel fee</dt><dd>${money(bill.distanceFare)}</dd></div>${bill.coreServiceAmount > 0 ? `<div><dt>Completed core services</dt><dd>${money(bill.coreServiceAmount)}</dd></div>` : ''}<div><dt>Recorded payments applied</dt><dd>−${money(bill.credited)}</dd></div><div class="rv-bill-total"><dt>Remaining for this visit</dt><dd>${money(bill.amountDue)}</dd></div></dl>${!bill.settled ? `<details class="rv-payment-details" open><summary>Record payment received</summary><form data-visit-payment><div class="ru-grid"><label class="ru-field">Payment method *<select name="visitPaymentMethod"><option value="cash">Cash</option><option value="gcash">GCash</option><option value="maya">Maya</option><option value="bank_transfer">Bank transfer</option></select></label><label class="ru-field">Reference / notes<input name="visitPaymentNotes" maxlength="1000" placeholder="Optional reference or collection notes"></label></div><label class="rv-check"><input type="checkbox" name="visitPaymentReceived" required><span>I received <strong>${money(bill.amountDue)}</strong> from the customer. Record only money actually received.</span></label><button type="submit" class="ru-btn" data-record-payment>Record ${money(bill.amountDue)} payment</button></form></details>` : '<p class="rv-approved">No additional first-visit payment is needed.</p>'}</section>`;
  }
  function purchaseForms() {
    return (state.purchases || []).map(purchase => {
      if (['receipt_uploaded','verified'].includes(purchase.purchaseStatus)) return `<div class="rv-purchase"><strong>${esc(purchase.partName)}</strong><p>Received and recorded.</p></div>`;
      return `<form class="rv-purchase" data-purchase-key="${esc(purchase.key)}"><h4>${esc(purchase.partName)} · ${esc(purchase.quantity)} required</h4><p>${esc(purchase.supplierName)}</p>${purchase.purchaseByType === 'customer' ? '<label class="rv-check"><input type="checkbox" name="correct" required> I checked the customer-provided part and received the full quantity.</label><button type="submit" class="ru-btn">Verify received part</button>' : `<div class="ru-grid"><label class="ru-field">Actual total buying cost (PHP)<input type="number" name="actualCost" required min="0.01" max="1000000" step="0.01" value="${esc(purchase.expectedPurchaseCost)}"></label><label class="ru-field">Receipt photo or PDF<input type="file" name="receipt" required accept="image/jpeg,image/png,image/webp,application/pdf"><small>Up to 5 MB. Staff will review the expense.</small></label></div><button type="submit" class="ru-btn">Save receipt and received parts</button>`}</form>`;
    }).join('');
  }
  function nowPanel() {
    const missing = (state.parts || []).filter(part => part.missing > 0 && !part.purchasePending), running = state.execution?.status === 'in_progress';
    return `${state.reasons.length ? `<section class="rv-card"><h3>Before repairing now</h3><ul>${state.reasons.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul><button type="button" class="ru-btn" data-mode="later">Request a return visit</button></section>` : ''}<section class="rv-card"><h3>Time available for the team</h3><p>Work date: ${esc(state.date)}. Every crew member's schedule is checked.</p><div class="ru-grid"><label class="ru-field">Repair and testing (minutes)<input name="repairMinutes" type="number" min="15" max="480" step="1" value="${state.repairMinutes}"></label><label class="ru-field">Nearby purchase trip (minutes)<input name="purchaseMinutes" type="number" min="15" max="480" step="1" value="${state.purchaseMinutes}"></label></div><button type="button" class="ru-btn" data-check-time>Check time and parts again</button><p class="rv-result ${state.direct.available ? 'is-ready' : ''}">${esc(state.direct.available ? 'There is enough time if the required tools and parts are ready.' : state.direct.reason)}</p></section><section class="rv-card"><h3>Tools and parts at the site</h3><p class="rv-result ${state.toolsReady ? 'is-ready' : ''}">${esc(state.toolsReady ? 'Daily preparation and tools are ready.' : state.toolReason || 'Review the daily kit before starting.')}</p>${(state.tools || []).map(tool=>`<p>${esc(tool.name)} · ${tool.ready ? 'At site' : 'Not ready'}</p>`).join('')}${state.parts.length ? `<div class="rv-parts">${state.parts.map(part=>`<div><strong>${esc(part.name)}</strong><span>Need ${part.quantity} · Received ${part.available}</span><small>${part.purchasePending ? 'Purchase pending receipt or verification' : part.missing ? `${part.missing} still missing` : 'Ready'}</small></div>`).join('')}</div>` : '<p>No replacement parts are required.</p>'}${purchaseForms()}</section>${missing.length && !state.reasons.length ? `<details class="rv-card"><summary>Buy missing parts nearby</summary><p>The approved customer price stays the same. Record the actual buying cost separately.</p>${!state.local.available ? `<p>${esc(state.local.reason)}</p>` : `<form data-purchase-plan><div class="ru-grid"><label class="ru-field">Supplier name<input name="supplierName" required minlength="2" maxlength="160"></label><label class="ru-field">Who will buy?<select name="purchaseBy"><option value="technician">Technician</option><option value="customer">Customer</option></select></label></div>${missing.map(part=>`<label class="ru-field rv-buy-part" data-buy-key="${esc(part.key)}"><span><input type="checkbox" checked> ${esc(part.name)} · ${part.missing} needed</span>Expected total store price (PHP)<input type="number" min="0.01" max="1000000" step="0.01" required data-buy-cost></label>`).join('')}<label class="rv-check"><input type="checkbox" name="supplierCanProvide" required> The supplier confirmed the correct parts and quantities.</label><label class="rv-check"><input type="checkbox" name="customerAgreed" required> The customer agrees to the purchase plan within the quotation.</label><button class="ru-btn" type="submit">Save purchase plan</button></form>`}</details>` : ''}<section class="rv-card">${running ? '<h3>Repair is in progress</h3><p>Record the repairs and tests before final payment and completion.</p><button type="button" class="ru-btn ru-btn-primary" data-appliances>Record appliance repairs and tests</button>' : `${consent()}<button type="button" class="ru-btn ru-btn-primary" data-start ${state.canStart ? '' : 'disabled'}>Repair now</button>`}</section>`;
  }
  function laterPanel() {
    const tomorrow = new Date(`${state.date}T00:00:00+08:00`); tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
    const minDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(tomorrow);
    const bill = state.firstVisitPayment;
    return `${bill?.corePending ? '<section class="rv-card rq-notice"><h3>Complete core services first</h3><p>This is a mixed visit. Finish the core-service work before ending this visit and scheduling the repair for another day.</p><button type="button" class="ru-btn" data-core>View core services</button></section>' : ''}${paymentCard()}<section class="rv-card"><h3>Request the next repair visit</h3><p>Enter dates that suit the customer. Operations will check availability, confirm the appointment and notify the customer.</p><form data-defer><label class="ru-field">Reason and remaining work *<textarea name="reason" required minlength="5" maxlength="1000" placeholder="For example, the replacement part is unavailable or more time is needed."></textarea></label><div class="ru-grid rv-date-fields"><label class="ru-field">Preferred date *<input name="date1" type="date" min="${minDate}" required></label><label class="ru-field">Preferred time<select name="preferredTime"><option value="any">Any available time</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option></select></label></div><details class="rv-extra-dates"><summary>Add alternative dates (optional)</summary><div class="ru-grid">${[2,3].map(index=>`<label class="ru-field">Alternative date ${index-1}<input name="date${index}" type="date" min="${minDate}"></label>`).join('')}</div></details>${consent()}<div class="rv-form-actions"><button type="submit" class="ru-btn ru-btn-primary" ${bill?.corePending || (state.visitReasons || []).length ? 'disabled' : ''}>Send return-visit request</button><small>${bill?.settled ? 'This sends a request; the date is confirmed by Operations.' : 'Record the first-visit payment above before sending. Your entered dates and reason will be kept.'}</small></div></form></section>`;
  }
  function cancelPanel() {
    const bill = state.firstVisitPayment;
    return `${!bill?.corePending ? paymentCard() : ''}<section class="rv-card"><h3>Cancel the quoted repair</h3><p>Inspection, travel and completed core services remain payable. ${bill?.corePending ? 'The core services on this visit remain active.' : 'This ends the repair visit.'}</p><form data-cancel-repair><label class="ru-field">Customer's cancellation reason *<textarea name="cancelReason" required minlength="5" maxlength="1000"></textarea></label><label class="rv-check"><input type="checkbox" name="cancelConsent" required> The customer heard the quotation and asked to cancel this repair.</label><button type="submit" class="ru-btn rq-btn-danger">Record cancellation</button></form></section>`;
  }
  function render() {
    const labels = {choice:'Customer repair decision',now:'Repair now',later:'Plan a return visit',cancel:'Cancel quoted repair'};
    dialog.innerHTML = `<header class="ru-header"><div><span class="rv-eyebrow">REPAIR WORK PLAN · ${esc(state.reference)}</span><h2>${labels[mode]}</h2><p>${mode === 'later' ? 'Settle this visit and request a new repair date.' : 'Choose the next step with the customer.'}</p></div><button type="button" class="ru-close" aria-label="Close repair work plan">×</button></header><div class="ru-body"><div class="ru-error" data-visit-error role="alert" tabindex="-1" hidden></div>${notice ? `<p class="rq-notice" role="status">${esc(notice)}</p>` : ''}<section class="rv-quote-bar"><span>Repair quotation<small>Inspection and travel are separate.</small></span><strong>${money(state.confirmedQuotationTotal)}</strong></section><nav class="rv-decisions" aria-label="Repair decision">${[['now','Repair now','Check time, tools and parts'],['later','Repair later','Request another visit'],['cancel','Cancel repair','Record the customer reason']].map(([key,title,description])=>`<button type="button" data-mode="${key}" aria-pressed="${mode===key}"><strong>${title}</strong><small>${description}</small></button>`).join('')}</nav>${(state.visitReasons || []).length ? `<section class="rv-card rq-notice"><h3>Before continuing</h3><ul>${state.visitReasons.map(reason=>`<li>${esc(reason)}</li>`).join('')}</ul><button type="button" class="ru-btn" data-appliances>View inspection and quotation</button></section>` : ''}${mode==='now' ? nowPanel() : mode==='later' ? laterPanel() : mode==='cancel' ? cancelPanel() : '<section class="rv-card"><h3>What would the customer like to do?</h3><p>Choose Repair now to check today’s available time and parts, or Repair later to request another visit.</p></section>'}</div><footer class="ru-footer">${mode==='later' ? 'Return-visit requests go to Repair Scheduling. The new appointment is confirmed separately.' : 'Record the customer’s decision before continuing with the quoted repair.'}</footer>`;
    restore(); bind();
  }
  function bind() {
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
    dialog.querySelector('[data-purchase-plan]')?.addEventListener('submit',event=>{
      event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;
      const parts=[...form.querySelectorAll('[data-buy-key]')].filter(row=>row.querySelector('[type=checkbox]').checked).map(row=>({key:row.dataset.buyKey,expectedPurchaseCost:Number(row.querySelector('[data-buy-cost]').value)}));
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
        draft={};notice='';dialog.querySelector('.ru-body').innerHTML=`<section class="rv-card rv-success" role="status"><span>✓</span><h3>${action==='defer'?'Return-visit request sent':'Repair cancelled'}</h3><p>${action==='defer'?'Operations will confirm the next repair appointment and notify the customer. Your current visit is closed.':'The customer’s decision and reason were saved. Inspection charges and completed core services are retained.'}</p></section>`;dialog.querySelector('.ru-close').disabled=false;
      }else await load();
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

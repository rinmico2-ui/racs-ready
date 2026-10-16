(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(value || 0));
  let dialog, id, state, busy = false, generation = 0;
  const field = name => dialog.querySelector(`[name="${name}"]`);
  async function request(url, body) {
    let response;
    try { response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.timeout(45000),
      ...(body ? { method: 'POST', ...(body instanceof FormData ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) } : {}) }); }
    catch (failure) { throw Error(['TimeoutError', 'AbortError'].includes(failure.name) ? 'This request took too long. Refresh the work plan before trying again.' : 'Could not connect. Refresh the work plan to check whether the last change was saved.'); }
    const data = await response.json().catch(() => ({ error: 'The server could not complete this request. Refresh the work plan and try again.' }));
    if (!response.ok) throw Object.assign(Error(data.error || data.message || 'Could not update this repair visit.'), { code: data.code });
    return data;
  }
  function error(message) { const box = dialog.querySelector('[data-visit-error]'); box.textContent = message; box.hidden = false; box.focus(); }
  const base = () => `/api/technician/appointments/${encodeURIComponent(id)}/repair-workflow`;
  const minutes = () => ({ repairMinutes: Number(field('repairMinutes').value), purchaseMinutes: Number(field('purchaseMinutes').value),
    confirmedQuotationTotal: Number(state.confirmedQuotationTotal), ...(field('onsiteConsent') ? { customerAgreed: field('onsiteConsent').checked } : {}) });
  function purchaseForms() {
    return (state.purchases || []).map(purchase => {
      if (['receipt_uploaded', 'verified'].includes(purchase.purchaseStatus)) return `<div class="rv-purchase"><strong>${esc(purchase.partName)}</strong><p>Received and recorded. The schedule is checked again before repair starts.</p></div>`;
      return `<form class="rv-purchase" data-purchase-key="${esc(purchase.key)}"><h4>${esc(purchase.partName)} &middot; ${esc(purchase.quantity)} required</h4><p>${esc(purchase.supplierName)}</p>${purchase.purchaseByType === 'customer'
        ? '<label class="rv-check"><input type="checkbox" name="correct" required> I checked that the customer-provided part is correct and the full quantity has been received.</label><button type="submit" class="ru-btn">Verify received part</button>'
        : `<div class="ru-grid"><label class="ru-field">Actual total buying cost (PHP)<input type="number" name="actualCost" required min="0.01" max="1000000" step="0.01" value="${esc(purchase.expectedPurchaseCost)}"></label><label class="ru-field">Receipt photo or PDF<input type="file" name="receipt" required accept="image/jpeg,image/png,image/webp,application/pdf"><small>Up to 5 MB. The expense goes to staff for review.</small></label></div><button type="submit" class="ru-btn">Save receipt and received parts</button>`}</form>`;
    }).join('');
  }
  function render() {
    const missing = (state.parts || []).filter(part => part.missing > 0 && !part.purchasePending), running = state.execution?.status === 'in_progress';
    const tomorrow = new Date(`${state.date}T00:00:00+08:00`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const minDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
    dialog.innerHTML = `<header class="ru-header"><div><span class="rv-eyebrow">REPAIR WORK PLAN &middot; ${esc(state.reference)}</span><h2>Customer repair decision</h2><p>Check approval, the team's time, and parts at the site.</p></div><button type="button" class="ru-close" aria-label="Close repair work plan">&times;</button></header>
      <div class="ru-body"><div class="ru-error" data-visit-error role="alert" tabindex="-1" hidden></div>
      <ol class="rv-steps" aria-label="Repair stages"><li>Travel and arrival</li><li>Inspect and quote</li><li>Customer decision</li><li aria-current="step">Repair or next visit</li></ol>
      ${state.requiresOnSiteConsent ? `<section class="rv-card rq-consent"><h3>Confirm the customer's on-site decision</h3><p>Submitted repair quotation: <strong>${money(state.confirmedQuotationTotal)}</strong>. Inspection fees are separate.</p><label class="rv-check"><input type="checkbox" name="onsiteConsent"> I explained this quotation and the customer verbally agreed to the repair choice I am recording. The decision is given on site and recorded under my account.</label><small>No additional admin confirmation is required for repair now. Time, tools, and received parts must still be ready.</small></section>` : ''}
      ${state.reasons.length ? `<section class="rv-card"><h3>Before you can continue</h3><ul>${state.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul><button type="button" class="ru-btn" data-appliances>Open inspection and quotation</button></section>` : ''}
      <section class="rv-card"><h3>1. Check the team's remaining time</h3><p>Philippine work date: ${esc(state.date)}. This checks every crew member's shift, leave and other service, order and project assignments.</p><div class="ru-grid"><label class="ru-field">Repair and testing time (minutes)<input name="repairMinutes" type="number" min="15" max="480" step="1" value="${state.repairMinutes}"></label><label class="ru-field">Nearby purchase trip (minutes)<input name="purchaseMinutes" type="number" min="15" max="480" step="1" value="${state.purchaseMinutes}"></label></div><button type="button" class="ru-btn mt-3" data-check-time>Check time and parts again</button><p class="rv-result ${state.direct.available ? 'is-ready' : ''}">${esc(state.direct.available ? 'There is time to repair now if all approved parts are at the site.' : state.direct.reason)}</p></section>
      <section class="rv-card"><h3>2. Confirm tools and parts at the site</h3><p>Company items must have been issued in the primary technician's daily kit.</p><p class="rv-result ${state.toolsReady ? 'is-ready' : ''}">${esc(state.toolsReady ? 'Daily preparation and required tools are ready.' : state.toolReason || 'Review the daily kit before starting repair.')}</p>${(state.tools || []).map(tool => `<p>${esc(tool.name)} · ${tool.ready ? 'Issued / at site' : 'Not ready'}</p>`).join('')}${state.parts.length ? `<div class="rv-parts">${state.parts.map(part => `<div><strong>${esc(part.name)}</strong><span>Need ${part.quantity} &middot; Received ${part.available}</span><small>${part.purchasePending ? 'Purchase pending receipt or verification' : part.missing > 0 ? `${part.missing} still missing` : 'Ready'}</small></div>`).join('')}</div>` : '<p>No replacement parts are required by the quotation.</p>'}${purchaseForms()}</section>
      ${missing.length && !state.reasons.length ? `<details class="rv-card" ${state.local.available ? '' : 'open'}><summary><strong>Buy missing parts from a nearby store</strong></summary><p>The approved customer price stays the same. Record the actual buying cost separately. Repairs start only after the parts are received and the schedule is checked again.</p>${!state.local.available ? `<p class="rv-result">${esc(state.local.reason)} Request another visit below.</p>` : `<form data-purchase-plan><div class="ru-grid"><label class="ru-field">Nearby supplier<input name="supplierName" required minlength="2" maxlength="160" placeholder="Store name"></label><label class="ru-field">Who will buy the parts?<select name="purchaseBy"><option value="technician">Technician</option><option value="customer">Customer</option></select></label></div>${missing.map(part => `<label class="ru-field rv-buy-part" data-buy-key="${esc(part.key)}"><span><input type="checkbox" checked> ${esc(part.name)} &middot; ${part.missing} needed</span>Expected total store price (PHP)<input type="number" min="0.01" max="1000000" step="0.01" required data-buy-cost></label>`).join('')}<label class="rv-check"><input type="checkbox" name="supplierCanProvide" required> I confirmed that the supplier has the correct parts and quantities.</label><label class="rv-check"><input type="checkbox" name="customerAgreed" required> The customer agrees to this purchase plan under the already-approved repair quotation.</label><button class="ru-btn" type="submit">Save nearby purchase plan</button></form>`}</details>` : ''}
      <section class="rv-card"><h3>3. ${running ? 'Repair is in progress' : 'Choose the repair decision'}</h3>${running ? '<p>This same-day repair is visible in Repair Scheduling. Record the repairs and tests, then continue to payment and completion proof.</p><button type="button" class="ru-btn ru-btn-primary" data-appliances>Record appliance repairs and tests</button>' : `<button type="button" class="ru-btn ru-btn-primary" data-start ${state.canStart ? '' : 'disabled'}>Repair now</button>${!state.reasons.length ? '<button type="button" class="ru-btn" data-select-later>Repair later</button><button type="button" class="ru-btn rq-btn-danger" data-select-cancel>Cancel repair</button>' : ''}<p class="ru-muted mt-2">${state.canStart ? 'Starting reserves the remaining work window for the team.' : 'Approval, enough time and received parts are required to start.'}</p>`}
      ${!state.reasons.length ? `<details class="rv-defer"><summary>Request another repair visit</summary><form data-defer><p>Operations will check availability and confirm the final date in the Repair Scheduling queue. This is a request, not a confirmed appointment.</p><label class="ru-field">Why is another visit needed?<textarea name="reason" required minlength="5" maxlength="1000" placeholder="For example, there is not enough time to finish after buying the replacement part."></textarea></label><div class="ru-grid mt-3">${[1,2,3].map(index => `<label class="ru-field">Preferred date ${index}${index === 1 ? '' : ' (optional)'}<input name="date${index}" type="date" min="${minDate}" ${index === 1 ? 'required' : ''}></label>`).join('')}<label class="ru-field">Preferred time<select name="preferredTime"><option value="any">Any available time</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option></select></label></div><button class="ru-btn mt-3" type="submit">Send to Repair Scheduling</button></form></details>` : ''}${!running && !state.reasons.length ? `<details class="rv-cancel rv-defer"><summary>Cancel the repair</summary><form data-cancel-repair><p>Cancel only the repair quoted above. Inspection fees and completed core services remain payable. This does not refund payments or return equipment.</p><label class="ru-field">Customer cancellation reason<textarea name="cancelReason" required minlength="5" maxlength="1000" placeholder="Record why the customer decided not to continue."></textarea></label><label class="rv-check"><input type="checkbox" name="cancelConsent" required> The customer was shown the repair quotation and asked to cancel the repair on site.</label><button type="submit" class="ru-btn rq-btn-danger">Record cancellation</button></form></details>` : ''}</section></div><footer class="ru-footer">The technician reviews the diagnosis and quotation, records the customer decision, and confirms time, tools, and parts before repair.</footer>`;
    dialog.querySelector('.ru-close').onclick = () => { if (!busy) dialog.close(); };
    dialog.querySelectorAll('[data-appliances]').forEach(button => button.onclick = () => { dialog.close(); window.openRepairUnits('booking', id); });
    dialog.querySelector('[data-check-time]').onclick = async () => { if (busy) return; try { await load(minutes()); } catch (failure) { error(failure.message); } };
    dialog.querySelector('[data-start]')?.addEventListener('click', () => save('start', minutes()));
    dialog.querySelector('[data-select-later]')?.addEventListener('click', () => { const section = dialog.querySelector('.rv-defer'); section.open = true; section.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    dialog.querySelector('[data-select-cancel]')?.addEventListener('click', () => { const section = dialog.querySelector('.rv-cancel'); section.open = true; section.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    dialog.querySelector('[data-cancel-repair]')?.addEventListener('submit', event => {
      event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return;
      save('cancel-repair', { ...minutes(), customerAgreed: form.elements.cancelConsent.checked, reason: form.elements.cancelReason.value });
    });
    dialog.querySelector('[data-purchase-plan]')?.addEventListener('submit', event => {
      event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return;
      const parts = [...form.querySelectorAll('[data-buy-key]')].filter(row => row.querySelector('[type=checkbox]').checked).map(row => ({ key: row.dataset.buyKey, expectedPurchaseCost: Number(row.querySelector('[data-buy-cost]').value) }));
      save('plan-purchase', { ...minutes(), parts, supplierName: form.elements.supplierName.value, purchaseBy: form.elements.purchaseBy.value, supplierCanProvide: form.elements.supplierCanProvide.checked, customerAgreed: form.elements.customerAgreed.checked });
    });
    dialog.querySelector('[data-defer]')?.addEventListener('submit', event => {
      event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return;
      save('defer', { ...minutes(), reason: form.elements.reason.value, preferredDates: [1,2,3].map(index => form.elements['date'+index].value).filter(Boolean), preferredTime: form.elements.preferredTime.value });
    });
    dialog.querySelectorAll('[data-purchase-key]').forEach(form => form.onsubmit = async event => {
      event.preventDefault(); if (busy || !form.reportValidity()) return;
      const key = form.dataset.purchaseKey;
      if (form.elements.correct) return save('verify-customer-part', { ...minutes(), key, correctPartVerified: form.elements.correct.checked });
      const file = form.elements.receipt.files[0];
      if (!file || file.size > 5 * 1024 * 1024 || !['image/jpeg','image/png','image/webp','application/pdf'].includes(file.type)) return error('Choose a JPG, PNG, WEBP or PDF receipt up to 5 MB.');
      const cost = Number(form.elements.actualCost.value), body = new FormData(); body.append('receipt', file);
      busy = true; disable(true);
      try { const upload = await request('/api/technician/expenses/upload-receipt', body); busy = false; disable(false); await save('receipt', { ...minutes(), key, receiptUrl: upload.url, actualPurchaseCost: cost }); }
      catch (failure) { error(failure.message); }
      finally { busy = false; disable(false); }
    });
  }
  function disable(value) { dialog.querySelectorAll('button,input,select,textarea').forEach(node => { if (value) { node.dataset.rvDisabled = String(node.disabled); node.disabled = true; } else if (Object.hasOwn(node.dataset, 'rvDisabled')) { node.disabled = node.dataset.rvDisabled === 'true'; delete node.dataset.rvDisabled; } }); }
  async function load(input = {}) {
    const ticket = ++generation; busy = true;
    try { const data = await request(base() + '?' + new URLSearchParams(input)); if (ticket !== generation) return; state = data; render(); }
    finally { busy = false; }
  }
  async function save(action, body) {
    if (busy) return; busy = true; disable(true);
    if (state.requiresOnSiteConsent && ['start', 'defer', 'plan-purchase'].includes(action) && !field('onsiteConsent')?.checked) { busy = false; disable(false); return error('Confirm the customer\'s verbal decision on the displayed quotation before continuing.'); }
    const finish = window.TechnicianWorkUpdates?.beginMutation?.();
    try {
      await request(base() + '/' + action, { ...body, version: state.version });
      if (action === 'defer' || action === 'cancel-repair') {
        dialog.querySelector('.ru-body').innerHTML = action === 'defer' ? '<section class="rv-card"><h3>Repair later request sent</h3><p>Repair Scheduling will confirm the next visit. The customer will be notified. Your current visit is closed.</p></section>' : '<section class="rv-card"><h3>Repair cancelled</h3><p>The customer decision and reason were recorded. Inspection fees and any completed core services are retained. Return issued equipment through the normal returns flow.</p></section>';
        dialog.querySelector('.ru-close').disabled = false;
      } else await load({ repairMinutes: body.repairMinutes, purchaseMinutes: body.purchaseMinutes });
      if (finish) finish(true); else window.refreshOpenAssignmentDetail?.();
    } catch (failure) {
      finish?.(false); error(failure.message);
      if (failure.code === 'PHASE_ONE_PAYMENT_REQUIRED') {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'ru-btn'; button.textContent = 'Record inspection payment';
        button.onclick = () => { dialog.close(); window.requirePhaseOneInspectionPayment?.(id, () => window.openRepairWorkflow(id), true); };
        dialog.querySelector('[data-visit-error]').append(button);
      }
    } finally { busy = false; disable(false); }
  }
  window.openRepairWorkflow = async function (bookingId) {
    if (busy || !/^[a-f\d]{24}$/i.test(String(bookingId || ''))) return;
    id = bookingId;
    for (const modal of document.querySelectorAll('.modal.show')) window.bootstrap?.Modal.getInstance(modal)?.hide();
    dialog ||= document.createElement('dialog'); dialog.className = 'ru-dialog rv-dialog'; dialog.setAttribute('aria-label', 'Repair work plan');
    if (!dialog.isConnected) document.body.append(dialog);
    dialog.innerHTML = '<header class="ru-header"><h2>Loading repair work plan...</h2></header><div class="ru-body"><div class="ru-error" data-visit-error tabindex="-1" hidden></div></div>';
    if (!dialog.open) dialog.showModal(); dialog.oncancel = event => { if (busy) event.preventDefault(); };
    try { await load(); }
    catch (failure) { error(failure.message); const close = document.createElement('button'); close.type = 'button'; close.className = 'ru-btn'; close.textContent = 'Close'; close.onclick = () => dialog.close(); dialog.querySelector('.ru-body').append(close); }
  };
  window.openRepairSchedulingModal = window.openRepairWorkflow;
})();

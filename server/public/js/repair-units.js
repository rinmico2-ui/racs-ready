(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const money = value => new Intl.NumberFormat('en-PH', { style:'currency', currency:'PHP' }).format(Number(value || 0));
  const labels = { pending:'Needs inspection', staff_review:'Staff review', customer_review:'Your decision needed', approved:'Repair approved', declined:'Repair declined', completed:'Repaired' };
  let dialog, state, busy = false;
  async function request(path, body) {
    let response;
    try { response = await fetch(path, { credentials:'same-origin', signal:AbortSignal.timeout(45000), ...(body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {}) }); }
    catch (error) { throw Error(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'This request took too long. Refresh the latest record before trying again.' : 'Could not connect to the server. Please try again.'); }
    const data = await response.json().catch(() => ({ error:'The server could not complete this request. Please try again.' }));
    if (!response.ok) throw new Error(data.error || data.message || 'Unable to update appliance repairs.');
    return data;
  }
  function partRow(part = {}) {
    return `<div class="ru-parts rq-part-row"><label class="ru-field">Part<select aria-label="Repair part"><option value="">Other part / supplier price</option>${(state.parts || []).map(p => `<option value="${esc(p._id)}" ${String(p._id) === String(part.toolId) ? 'selected' : ''}>${esc(p.itemName)} · ${money(p.sellingPrice ?? p.costPrice)}</option>`).join('')}</select></label><label class="ru-field">Quantity<input type="number" min="1" max="999" step="1" required value="${Number(part.quantity || 1)}" aria-label="Part quantity"></label><label class="ru-field">Unit price (PHP)<input class="ru-part-cost" type="number" min="0" max="1000000" required step=".01" value="${part.cost == null ? '' : Number(part.cost)}" aria-label="Part unit price"></label><button type="button" class="ru-btn" data-remove-part aria-label="Remove part">×</button><label class="ru-field rq-part-name">Part name / specification<input class="ru-part-name" required maxlength="200" placeholder="Enter the correct replacement part" value="${esc(part.name)}" aria-label="Other part name"></label></div>`;
  }
  function aiInspector(unit) {
    return state.scope === 'booking' ? '<section class="rq-ai"><div><strong>AI diagnostic assistance</strong><p>Get suggestions from the reported problem, or add your own diagnosis first. Check only the findings and parts you confirmed on site.</p></div><div class="ru-actions"><button type="button" class="ru-btn" data-unit-ai>Get AI diagnostic</button><button type="button" class="ru-btn" data-unit-quote-ai>Suggest labor and parts from my diagnosis</button></div><div data-unit-ai-result aria-live="polite"></div></section>' : '';
  }
  function quotePreview(form) {
    const category = form.elements.laborCategory.value, fees = state.laborFees || {}, preview = form.querySelector('[data-quote-preview]');
    if (!Object.hasOwn(fees, category)) { preview.textContent = 'Company labor rates are unavailable. Refresh before preparing the quotation.'; return; }
    const custom = form.elements.laborPricingMode.value === 'custom';
    if (!custom) form.elements.laborCost.value = fees[category];
    form.elements.laborCost.readOnly = !custom;
    form.querySelector('[data-labor-reason]').hidden = !custom;
    form.elements.laborPriceReason.required = custom;
    const labor = Number(form.elements.laborCost.value);
    let partsTotal = 0;
    for (const row of form.querySelectorAll('.ru-parts')) {
      const quantity = Number(row.querySelector('input[type=number]').value), cost = Number(row.querySelector('.ru-part-cost').value);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999 || !Number.isFinite(cost) || cost < 0 || row.querySelector('.ru-part-cost').value === '') { preview.textContent = 'Enter a confirmed quantity and price for each repair part.'; return; }
      partsTotal += quantity * cost;
    }
    preview.innerHTML = `<span>Repair parts <strong>${money(partsTotal)}</strong></span><span>Labor ${custom ? '(technician price)' : '(company rate)'} <strong>${money(labor)}</strong></span><span class="rq-total">Repair quotation <strong>${money(partsTotal + labor)}</strong></span><small>Inspection fees are separate. Show this price to the customer before recording their decision.</small>`;
  }
  async function generateUnitAi(form, fromDiagnosis = false) {
    if (busy) return;
    busy = true;
    const button = form.querySelector(fromDiagnosis ? '[data-unit-quote-ai]' : '[data-unit-ai]'), panel = form.querySelector('[data-unit-ai-result]');
    button.disabled = true; panel.textContent = 'Preparing diagnostic suggestions...';
    try {
      const findings = form.elements.findings.value.trim();
      const diagnosis = form.elements.diagnosis.value.trim();
      if (fromDiagnosis && diagnosis.length < 5) throw Error('Enter your diagnosis first (at least 5 characters), then request suggested labor and parts.');
      let report, suggestion;
      {
        const data = await request(`/api/repair-units/booking/${encodeURIComponent(state.id)}/ai-diagnostic`, { key: form.dataset.key, findings, diagnosis });
        const latest = await request(`/api/repair-units/${state.scope}/${state.id}`);
        const previousUnit = state.units.find(unit => unit.key === form.dataset.key), latestUnit = latest.units.find(unit => unit.key === form.dataset.key);
        if (!latestUnit || previousUnit?.review?.revision !== latestUnit.review?.revision || previousUnit?.review?.state !== latestUnit.review?.state) throw Error('This appliance changed while suggestions were loading. Reopen its latest inspection before continuing.');
        if (!latest.canInspect) throw Error(latest.blockedReason || 'This inspection is no longer editable. Refresh the repair workspace.');
        if (form.elements.findings.value.trim() !== findings || form.elements.diagnosis.value.trim() !== diagnosis) throw Error('Your findings or diagnosis changed while suggestions were loading. Generate again using the latest notes.');
        state.version = latest.version; report = data.technicianAssistant; suggestion = data.quoteSuggestion;
      }
      const unit = state.units.find(unit => unit.key === form.dataset.key);
      if (!report?.summary) throw Error('Diagnostic suggestions are unavailable. You can continue with a manual diagnosis and quotation.');
      const analysis = report;
      if (!analysis) throw Error('No suggestions were returned for this appliance. You can enter the diagnosis and quotation manually.');
      const text = item => typeof item === 'string' ? item : item?.cause || item?.name || item?.description || '';
      const causes = (Array.isArray(analysis.probableCauses) ? analysis.probableCauses : []).map(text).filter(Boolean), parts = suggestion?.parts || (Array.isArray(analysis.possibleParts) ? analysis.possibleParts : []).map(part => typeof part === 'string' ? { name: part } : part).filter(part => part?.name);
      panel.innerHTML = `<p class="mt-2">${esc(analysis.summary || 'Confirm each suggestion against your on-site findings.')}</p><strong>Diagnoses confirmed on site</strong>${causes.map((cause,index)=>`<label class="d-block my-2"><input type="checkbox" data-ai-cause value="${index}"> ${esc(cause)}</label>`).join('') || '<p>Enter your diagnosis in the form below.</p>'}<strong>Parts confirmed as necessary</strong>${suggestion ? `<p><strong>Suggested labor:</strong> ${esc(suggestion.laborCategory)} ? ${money(suggestion.laborCost)} (company rate)</p>` : ''}${parts.map((part,index)=>`<label class="d-block my-2"><input type="checkbox" data-ai-part value="${index}"> <span>${esc(part.name)}${part.quantity > 1 ? ` ? ${part.quantity} needed` : ''}<small class="d-block">${part.cost == null ? 'Confirm the supplier price before submitting.' : `${money(part.cost)} each ? saved catalog price`}</small></span></label>`).join('') || '<p>No parts suggested.</p>'}<button type="button" class="ru-btn" data-use-ai>Use confirmed selections and build quotation draft</button>`;
      panel.querySelector('[data-use-ai]').onclick = () => {
        const selected = [...panel.querySelectorAll('[data-ai-cause]:checked')].map(input => causes[Number(input.value)]).filter(Boolean);
        if (!selected.length && !form.elements.diagnosis.value.trim()) return showError('Confirm an on-site diagnosis or enter your diagnosis before building the quotation draft.');
        if (selected.length) {
          form.elements.diagnosis.value = [...new Set([form.elements.diagnosis.value.trim(), ...selected].filter(Boolean))].join('\n');
          if (!form.elements.findings.value.trim()) form.elements.findings.value = 'Confirmed on site: ' + selected.join('; ');
          form.dataset.diagnosisSource = 'ai_reviewed';
        }
        const category = suggestion?.laborCategory || ({ low:'minor', minor:'minor', medium:'standard', moderate:'standard', high:'complex', specialist_required:'major' })[analysis.repairComplexity] || 'standard';
        if (Object.hasOwn(state.laborFees || {}, category)) form.elements.laborCategory.value = category;
        const unmatched = [];
        for (const input of panel.querySelectorAll('[data-ai-part]:checked')) {
          const part = parts[Number(input.value)];
          if ([...form.querySelectorAll('.ru-part-name')].some(field => field.value.trim().toLowerCase() === String(part.name).trim().toLowerCase())) continue;
          const catalog = (state.parts || []).find(item => item.itemName.trim().toLowerCase() === String(part.name).trim().toLowerCase());
          if (!catalog) unmatched.push(part.name);
          form.querySelector('.ru-parts-list').insertAdjacentHTML('beforeend', partRow({ toolId:catalog?._id, name:part.name, quantity:part.quantity || 1, cost:catalog ? catalog.sellingPrice ?? catalog.costPrice ?? 0 : null }));
        }
        bindParts(form); quotePreview(form);
        if (unmatched.length) showError('Enter a confirmed supplier price for: ' + unmatched.join(', ') + '. The AI does not invent a parts price.');
      };
    } catch (error) { panel.textContent = error.message; }
    finally { busy = false; button.disabled = false; }
  }
  function inspector(unit) {
    if (!state.canInspect || state.closed || state.needsSetup) return '';
    if (state.submitted && ['pending', 'awaiting_customer'].includes(state.reviewStatus)) return `<p class="rq-notice">Inspection and quotation submitted. ${state.scope === 'booking' ? 'Show the price to the customer, then record Repair now, Repair later, or Cancel repair in the repair decision screen.' : 'Staff review and the customer decision are pending.'}</p>`;
    if (['pending','staff_review'].includes(unit.review?.state || 'pending')) {
      const canSubmit = state.units.every(other => other.key === unit.key || other.review?.state === 'staff_review');
      return `<form class="ru-inspect rq-inspection" data-key="${esc(unit.key)}" data-diagnosis-source="${esc(unit.diagnosis?.source || 'technician')}">
        <section class="rq-section"><h3><span>1</span> Confirm the diagnosis</h3>${aiInspector(unit)}<div class="ru-grid"><label class="ru-field">Inspection findings<textarea name="findings" required minlength="10" maxlength="2000" placeholder="Record what you checked and the results.">${esc(unit.inspection?.findings)}</textarea></label><label class="ru-field">Technician diagnosis<textarea name="diagnosis" required minlength="5" maxlength="2000" placeholder="Confirm an AI suggestion or enter your own diagnosis.">${esc(unit.diagnosis?.summary)}</textarea></label></div></section>
        <section class="rq-section"><h3><span>2</span> Prepare the repair quotation</h3><div class="ru-grid"><label class="ru-field">Repair complexity<select name="laborCategory">${Object.entries(state.laborFees || {}).map(([key,value]) => `<option value="${key}" ${(unit.quotation?.laborCategory || 'standard') === key ? 'selected' : ''}>${key[0].toUpperCase()+key.slice(1)} · ${money(value)}</option>`).join('')}</select></label><label class="ru-field">Labor pricing<select name="laborPricingMode"><option value="company">Company labor rate</option><option value="custom" ${unit.quotation?.laborPricingMode === 'custom' ? 'selected' : ''}>Set technician labor price</option></select></label><label class="ru-field">Labor amount (PHP)<input name="laborCost" type="number" min="0" max="1000000" step=".01" required value="${Number(unit.quotation?.laborCost || state.laborFees?.standard || 0)}"></label><label class="ru-field" data-labor-reason hidden>Reason for custom labor price<textarea name="laborPriceReason" minlength="5" maxlength="500" placeholder="Explain the work covered by this labor price.">${esc(unit.quotation?.laborPriceReason)}</textarea></label></div>
        <div class="rq-section-heading"><h4>Replacement parts</h4><button class="ru-btn" type="button" data-add-part>Add part</button></div><p class="ru-muted">Catalog parts use saved selling prices. Other parts need a confirmed supplier price. Leave the list empty if no replacement is needed.</p><div class="ru-parts-list">${(unit.quotation?.parts || []).map(partRow).join('')}</div><label class="ru-field">Quotation notes<input name="notes" maxlength="2000" value="${esc(unit.quotation?.notes)}" placeholder="Warranty, repair scope, or details the customer should know."></label><div class="rq-quote-total" data-quote-preview aria-live="polite"></div></section>
        <div class="ru-actions rq-submit"><button class="ru-btn" type="submit" data-save-draft>Save draft</button><button class="ru-btn" type="button" data-calculate-quote>Recalculate</button>${canSubmit ? '<button class="ru-btn ru-btn-primary" type="submit" data-submit-inspection>Submit inspection and quotation</button>' : '<p class="ru-muted">Save each appliance draft before submitting the whole inspection and quotation.</p>'}</div></form>`;
    }
    if (unit.review?.state === 'approved' && state.scope === 'booking' && state.canComplete) return `<form class="ru-complete" data-key="${esc(unit.key)}"><label class="ru-field">Repair and tests performed<textarea name="notes" required minlength="10" maxlength="1000"></textarea></label><button class="ru-btn ru-btn-primary" type="submit">Mark this appliance repaired</button></form>`;
    return '';
  }
  function quotationDetails(unit) {
    if (!unit.quotation) return '';
    const quote = unit.quotation;
    return `<section class="rq-quote-total"><h4>Repair quotation</h4>${(quote.parts || []).map(part => `<span>${esc(part.name)} · ${part.quantity} × ${money(part.cost)}<strong>${money(Number(part.quantity) * Number(part.cost))}</strong></span>`).join('') || '<span>No replacement parts</span>'}<span>Labor ${quote.laborPricingMode === 'custom' ? '(technician price)' : '(company rate)'}<strong>${money(quote.laborCost)}</strong></span>${quote.laborPricingMode === 'custom' ? `<small>Price reason: ${esc(quote.laborPriceReason)}</small>` : ''}<span class="rq-total">Repair total<strong>${money(quote.totalCost)}</strong></span>${quote.notes ? `<small>${esc(quote.notes)}</small>` : ''}${unit.review?.decisionMethod === 'on_site' ? `<small class="rq-notice">Customer decision given verbally on site and recorded by the assigned technician. ${esc(unit.review.decisionNotes || '')}</small>` : ''}</section>`;
  }
  function render() {
    const reviewed = state.units.filter(unit => unit.review?.state === 'customer_review');
    const allInspected = state.units.length && state.units.every(unit => unit.review?.state === 'staff_review');
    dialog.innerHTML = `<header class="ru-header"><div><h2>Inspection and quotation</h2><p>Review the diagnosis, prepare the price, and record the customer decision.</p></div><button class="ru-close" aria-label="Close appliance repairs">×</button></header><div class="ru-body"><div class="ru-error" role="alert" hidden></div><div class="ru-toolbar"><span>${state.units.length} appliance${state.units.length === 1 ? '' : 's'}</span>${!state.closed && state.canInspect && allInspected && (!state.submitted || state.reviewStatus === 'rejected') ? '<button class="ru-btn ru-btn-primary" data-submit>Submit inspection and quotation</button>' : ''}${!state.closed && state.submitted && allInspected && ['admin','secretary'].includes(state.role) && state.reviewStatus === 'pending' ? '<button class="ru-btn ru-btn-primary" data-review="approve">Send prices to customer</button><button class="ru-btn" data-review="reject">Return for changes</button><input id="ruReviewNotes" class="form-control" maxlength="1000" placeholder="Review notes / changes needed">' : ''}${!state.closed && state.role === 'customer' && reviewed.length ? '<button class="ru-btn" data-select-all>Select all waiting quotes</button><button class="ru-btn ru-btn-primary" data-decide="true">Approve selected repairs</button><button class="ru-btn" data-decide="false">Decline selected repairs</button>' : ''}</div>${state.units.map(unit => `<details class="ru-unit" ${state.units.length === 1 ? 'open' : ''}><summary><span>${state.role === 'customer' && unit.review?.state === 'customer_review' ? `<input class="ru-choose" type="checkbox" data-key="${esc(unit.key)}" aria-label="Select ${esc(unit.label)}">` : ''} <strong>${esc(unit.key)} · ${esc(unit.label)}</strong><br><small class="ru-muted">${esc([unit.brand,unit.model].filter(Boolean).join(' · '))}</small></span><span class="ru-status">${esc(unit.review?.state === 'staff_review' ? state.submitted ? 'Quotation submitted' : 'Draft saved' : labels[unit.review?.state || 'pending'])}</span>${unit.quotation ? `<span class="ru-price">${money(unit.quotation.totalCost)}</span>` : ''}</summary><div class="ru-unit-content"><p class="ru-evidence"><strong>Reported problem:</strong> ${esc(unit.problemDescription || 'Not recorded')}</p>${unit.inspection?.findings ? `<p class="ru-evidence"><strong>Findings:</strong> ${esc(unit.inspection.findings)}<br><strong>Diagnosis:</strong> ${esc(unit.diagnosis?.summary)}</p>` : ''}${quotationDetails(unit)}${unit.completionNotes ? `<p class="ru-evidence"><strong>Repairs and tests:</strong> ${esc(unit.completionNotes)}</p>` : ''}${inspector(unit)}</div></details>`).join('')}</div><footer class="ru-footer">Inspection fees are separate. For on-site repairs, the technician records the customer decision and checks time, tools, and parts.</footer>`;
    if (state.blockedReason) { const hint=document.createElement('p');hint.className='ru-evidence';hint.textContent=state.blockedReason;dialog.querySelector('.ru-toolbar').after(hint); }
    if (state.canPlanRepair && !state.canComplete && window.openRepairWorkflow) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ru-btn ru-btn-primary'; button.textContent = 'Customer decision: repair now, later, or cancel';
      button.onclick = () => { dialog.close(); window.openRepairWorkflow(state.id); }; dialog.querySelector('.ru-toolbar').append(button);
    }
    if (state.readyForCompletion && window.completeRepair) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ru-btn ru-btn-primary'; button.textContent = 'Continue to payment and completion proof';
      button.onclick = () => { dialog.close(); window.completeRepair(state.id); }; dialog.querySelector('.ru-toolbar').append(button);
    }
    dialog.querySelector('.ru-close').onclick = () => { if (!busy) dialog.close(); };
    if (state.needsSetup && (state.canInspect || ['admin', 'secretary'].includes(state.role))) {
      const button = document.createElement('button'); button.className = 'ru-btn ru-btn-primary'; button.textContent = 'Start individual appliance inspections';
      button.onclick = () => { if (confirm('Start individual inspections for this existing repair project? No completed work will be changed.')) save('prepare', {}); };
      dialog.querySelector('.ru-toolbar').append(button);
    }
    dialog.querySelector('[data-select-all]')?.addEventListener('click', () => dialog.querySelectorAll('.ru-choose').forEach(box => { box.checked = true; }));
    dialog.querySelector('[data-submit]')?.addEventListener('click', () => save('submit', {}));
    dialog.querySelectorAll('[data-review]').forEach(button => button.onclick = () => save('review', { action:button.dataset.review, notes:dialog.querySelector('#ruReviewNotes')?.value || '' }));
    dialog.querySelectorAll('[data-decide]').forEach(button => button.onclick = () => {
      const decisions = [...dialog.querySelectorAll('.ru-choose:checked')].map(box => ({ key:box.dataset.key, revision:state.units.find(unit => unit.key === box.dataset.key).review.revision, approved:button.dataset.decide === 'true' }));
      if (!decisions.length) return showError('Select the appliances you want to approve or decline.');
      if (confirm(`${button.dataset.decide === 'true' ? 'Approve' : 'Decline'} repairs for these ${decisions.length} appliances?`)) save('decide', { decisions });
    });
    dialog.querySelectorAll('.ru-inspect').forEach(form => {
      form.querySelector('[data-add-part]').onclick = () => { form.querySelector('.ru-parts-list').insertAdjacentHTML('beforeend', partRow()); bindParts(form); };
      bindParts(form);
      form.querySelector('[data-unit-ai]')?.addEventListener('click',()=>generateUnitAi(form));
      form.querySelector('[data-unit-quote-ai]')?.addEventListener('click',()=>generateUnitAi(form, true));
      form.querySelector('[data-calculate-quote]').onclick=()=>quotePreview(form);
      form.addEventListener('input',()=>{if(form.querySelector('[data-quote-preview]').textContent)quotePreview(form);});
      form.elements.diagnosis.addEventListener('input', () => { form.dataset.diagnosisSource = 'technician'; });
      form.elements.laborPricingMode.addEventListener('change', () => quotePreview(form));
      form.elements.laborCategory.addEventListener('change', () => quotePreview(form));
      quotePreview(form);
      form.onsubmit = event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const parts = [...form.querySelectorAll('.ru-parts')].map(row => ({ toolId:row.querySelector('select').value || null, name:row.querySelector('.ru-part-name').value, quantity:Number(row.querySelector('input[type=number]').value), cost:Number(row.querySelector('.ru-part-cost').value) }));
        save(event.submitter?.hasAttribute('data-submit-inspection') ? 'inspect-and-submit' : 'inspect', { key:form.dataset.key, findings:form.elements.findings.value, diagnosis:form.elements.diagnosis.value, diagnosisSource:form.dataset.diagnosisSource, laborCategory:form.elements.laborCategory.value, laborPricingMode:form.elements.laborPricingMode.value, laborCost:Number(form.elements.laborCost.value), laborPriceReason:form.elements.laborPriceReason.value, notes:form.elements.notes.value, parts });
      };
    });
    dialog.querySelectorAll('.ru-complete').forEach(form => form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) save('complete', { key:form.dataset.key, notes:form.elements.notes.value }); });
  }
  function bindParts(form) {
    form.querySelectorAll('[data-remove-part]').forEach(button => button.onclick = () => { button.closest('.ru-parts').remove(); quotePreview(form); });
    form.querySelectorAll('.ru-parts select').forEach(select => {
      const update = () => {
        const row = select.closest('.ru-parts'), part = state.parts.find(part => String(part._id) === select.value);
        row.querySelector('.ru-part-cost').readOnly = !!part; row.querySelector('.ru-part-name').readOnly = !!part;
        if (part) { row.querySelector('.ru-part-cost').value = part.sellingPrice ?? part.costPrice ?? 0; row.querySelector('.ru-part-name').value = part.itemName; }
      };
      select.onchange = () => { update(); quotePreview(form); }; update();
    });
  }
  function showError(message) { const box = dialog.querySelector('.ru-error'); box.textContent = message; box.hidden = false; box.scrollIntoView({block:'nearest'}); }
  async function save(action, data) {
    if (busy) return;
    busy = true;
    const openKeys = [...dialog.querySelectorAll('details[open]')].map(details => details.querySelector('[data-key]')?.dataset.key).filter(Boolean);
    const controls = [...dialog.querySelectorAll('button,input,select,textarea')]; controls.forEach(control => { control.dataset.ruDisabled = String(control.disabled); control.disabled = true; });
    try {
      const updated = await request(`/api/repair-units/${state.scope}/${state.id}/${action}`, { ...data, version:state.version });
      state = { ...state, ...updated }; render();
      openKeys.forEach(key => dialog.querySelector(`[data-key="${key}"]`)?.closest('details')?.setAttribute('open',''));
      window.dispatchEvent(new CustomEvent('repair-units:updated', { detail:{ scope:state.scope, id:state.id } }));
      if (['submit', 'inspect-and-submit'].includes(action) && state.scope === 'booking' && state.canPlanRepair && window.openRepairWorkflow) { dialog.close(); window.openRepairWorkflow(state.id); }
    } catch (error) { showError(error.message); controls.forEach(control => { control.disabled = control.dataset.ruDisabled === 'true'; }); }
    finally { busy = false; }
  }
  window.openRepairUnits = async function (scope, id) {
    if (busy) return;
    busy = true;
    if (dialog?.open) dialog.close();
    dialog = dialog || document.createElement('dialog'); dialog.className = 'ru-dialog';
    if (!dialog.isConnected) document.body.append(dialog);
    dialog.innerHTML = '<div class="ru-header"><h2>Loading appliance repairs…</h2></div>';
    dialog.showModal();
    dialog.oncancel = event => { if (busy) event.preventDefault(); };
    try { state = await request(`/api/repair-units/${encodeURIComponent(scope)}/${encodeURIComponent(id)}`); render(); }
    catch (error) { dialog.innerHTML = `<div class="ru-header"><h2>Appliance repairs</h2><button class="ru-close" aria-label="Close">×</button></div><div class="ru-body"><p role="alert">${esc(error.message)}</p></div>`; dialog.querySelector('button').onclick = () => dialog.close(); }
    finally { busy = false; }
  };
  window.openRepairUnitCompletion = async function (projectId, orders) {
    if (busy) return;
    busy = true;
    const completion = document.createElement('dialog'); completion.className = 'ru-dialog'; document.body.append(completion);
    completion.innerHTML = '<div class="ru-header"><h2>Loading appliances…</h2></div>'; completion.showModal();
    completion.oncancel = event => { if (busy) event.preventDefault(); };
    let unitState, materials;
    try {
      [unitState, materials] = await Promise.all([request(`/api/repair-units/project/${projectId}`), request(`/api/projects/${projectId}/submission-consumables`)]);
      const approved = new Set(unitState.units.filter(unit => unit.review.state === 'approved').map(unit => unit.key));
      completion.innerHTML = `<header class="ru-header"><div><h2>Submit repaired appliances</h2><p>Select the exact appliances you finished and tested.</p></div><button class="ru-close" aria-label="Close">×</button></header><form><div class="ru-body"><div class="ru-error" role="alert" hidden></div>${orders.map(order => `<div class="ru-unit-content"><strong>${esc(order.title || order.workOrderNumber || 'Work order')}</strong>${(order.units || []).filter(unit => !['completed','cancelled','on_hold'].includes(unit.status)).map(unit => { const repair = unitState.units.some(row => row.key === unit.unitKey); const allowed = !repair || approved.has(unit.unitKey); return `<label style="display:block;padding:8px 0"><input type="checkbox" class="ru-choose" data-order="${esc(order._id)}" value="${esc(unit.unitKey)}" ${allowed ? '' : 'disabled'}> ${esc(unit.unitKey)} · ${esc(unit.label)} ${allowed ? '' : '(Repair approval needed)'}</label>`; }).join('')}</div>`).join('')}<label class="ru-field">Proof photo<input type="file" name="proof" accept="image/jpeg,image/png,image/webp" required></label><label class="ru-field">Repairs and tests performed<textarea name="notes" minlength="10" maxlength="1000" required></textarea></label><h3 style="font-size:1rem;margin-top:18px">Materials used</h3>${(materials.consumables || []).map(item => `<label class="ru-field">${esc(item.equipmentName || item.itemName)} · ${Number(item.quantityRemaining || 0)} available<input type="number" class="ru-usage" data-id="${esc(item.assignmentId || item._id)}" min="0" max="${Number(item.quantityRemaining || 0)}" step=".001" value="0"></label>`).join('')}<label style="display:block;margin-top:12px"><input type="checkbox" name="none"> No materials were used</label></div><footer class="ru-footer"><button type="submit" class="ru-btn ru-btn-primary">Submit appliances and proof</button></footer></form>`;
      completion.querySelector('.ru-close').onclick = () => { if (!busy) completion.close(); };
      const token = crypto.randomUUID();
      completion.querySelector('form').onsubmit = async event => {
        event.preventDefault(); if (busy) return;
        const form = event.currentTarget, error = completion.querySelector('.ru-error');
        const fail = message => { error.textContent = message; error.hidden = false; };
        const grouped = new Map();
        completion.querySelectorAll('.ru-choose:checked').forEach(box => { if (!grouped.has(box.dataset.order)) grouped.set(box.dataset.order, []); grouped.get(box.dataset.order).push(box.value); });
        if (!grouped.size) return fail('Select at least one completed appliance.');
        const proof = form.elements.proof.files[0];
        if (!proof || proof.size > 5 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(proof.type)) return fail('Choose a JPEG, PNG or WebP proof photo up to 5 MB.');
        const consumables = [...completion.querySelectorAll('.ru-usage')].map(input => ({ assignmentId:input.dataset.id, quantityUsed:Number(input.value) })).filter(item => item.quantityUsed > 0);
        if (!consumables.length && !form.elements.none.checked) return fail('Enter materials used or confirm that none were used.');
        if (consumables.length && form.elements.none.checked) return fail('Clear “No materials were used” when entering used quantities.');
        const body = new FormData(); body.append('clientSubmissionId',token); body.append('proofPhoto',proof); body.append('notes',form.elements.notes.value);
        body.append('workOrders',JSON.stringify([...grouped].map(([workOrderId,unitKeys]) => ({workOrderId,unitKeys,completedUnits:unitKeys.length}))));
        body.append('consumables',JSON.stringify(consumables)); body.append('consumablesDeclaredNone',String(form.elements.none.checked));
        busy = true; const controls = [...completion.querySelectorAll('button,input,textarea')]; const previously = controls.map(control => control.disabled); controls.forEach(control => { control.disabled = true; });
        try { const response = await fetch(`/api/projects/${projectId}/work-submissions`, { method:'POST', credentials:'same-origin', body }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Submission failed.'); completion.close(); window.__loadProjectWork?.(); }
        catch (error) { fail(error.message); controls.forEach((control,index) => { control.disabled = previously[index]; }); }
        finally { busy = false; }
      };
    } catch (error) { completion.innerHTML = `<div class="ru-body"><p>${esc(error.message)}</p><button class="ru-btn" type="button">Close</button></div>`; completion.querySelector('button').onclick = () => completion.close(); }
    finally { busy = false; }
    completion.addEventListener('close', () => completion.remove(), {once:true});
  };
})();

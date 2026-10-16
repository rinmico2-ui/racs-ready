(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const money = value => new Intl.NumberFormat('en-PH', { style:'currency', currency:'PHP' }).format(Number(value || 0));
  const labels = { pending:'Needs inspection', staff_review:'Staff review', customer_review:'Your decision needed', approved:'Repair approved', declined:'Repair declined', completed:'Repaired' };
  let dialog, state, busy = false, activeKey = '', draftScope = '';
  const drafts = new Map();
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
    return state.scope === 'booking' ? '<details class="rq-ai"><summary><span class="ru-ai-symbol" aria-hidden="true">✦</span><span><strong>Diagnostic assistant</strong><small>Get a second opinion on the reported symptoms</small></span><span aria-hidden="true">+</span></summary><div class="rq-ai-content"><p>Review suggestions against your on-site checks. Your confirmed diagnosis determines the quotation.</p><div class="ru-actions"><button type="button" class="ru-btn" data-unit-ai>Analyze reported problem</button><button type="button" class="ru-btn" data-unit-quote-ai>Suggest labor and parts</button></div><div data-unit-ai-result aria-live="polite"></div></div></details>' : '';
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
      const testsPerformed = form.elements.testsPerformed.value.trim();
      if (fromDiagnosis && diagnosis.length < 5) throw Error('Enter your diagnosis first (at least 5 characters), then request suggested labor and parts.');
      let report, suggestion;
      {
        const data = await request(`/api/repair-units/booking/${encodeURIComponent(state.id)}/ai-diagnostic`, { key: form.dataset.key, findings, diagnosis, testsPerformed });
        const latest = await request(`/api/repair-units/${state.scope}/${state.id}`);
        const previousUnit = state.units.find(unit => unit.key === form.dataset.key), latestUnit = latest.units.find(unit => unit.key === form.dataset.key);
        if (!latestUnit || previousUnit?.review?.revision !== latestUnit.review?.revision || previousUnit?.review?.state !== latestUnit.review?.state) throw Error('This appliance changed while suggestions were loading. Reopen its latest inspection before continuing.');
        if (!latest.canInspect) throw Error(latest.blockedReason || 'This inspection is no longer editable. Refresh the repair workspace.');
        if (form.elements.findings.value.trim() !== findings || form.elements.diagnosis.value.trim() !== diagnosis || form.elements.testsPerformed.value.trim() !== testsPerformed) throw Error('Your findings or diagnosis changed while suggestions were loading. Generate again using the latest notes.');
        state.version = latest.version; report = data.technicianAssistant; suggestion = data.quoteSuggestion;
      }
      const unit = state.units.find(unit => unit.key === form.dataset.key);
      if (!report?.summary) throw Error('Diagnostic suggestions are unavailable. You can continue with a manual diagnosis and quotation.');
      const analysis = report;
      if (!analysis) throw Error('No suggestions were returned for this appliance. You can enter the diagnosis and quotation manually.');
      const text = item => typeof item === 'string' ? item : item?.cause || item?.name || item?.description || '';
      const causes = (Array.isArray(analysis.probableCauses) ? analysis.probableCauses : []).map(text).filter(Boolean), parts = suggestion?.parts || (Array.isArray(analysis.possibleParts) ? analysis.possibleParts : []).map(part => typeof part === 'string' ? { name: part } : part).filter(part => part?.name);
      panel.innerHTML = `<p class="mt-2">${esc(analysis.summary || 'Confirm each suggestion against your on-site findings.')}</p><strong>Diagnoses confirmed on site</strong>${causes.map((cause,index)=>`<label class="d-block my-2"><input type="checkbox" data-ai-cause value="${index}"> ${esc(cause)}</label>`).join('') || '<p>Enter your diagnosis in the form below.</p>'}<strong>Parts confirmed as necessary</strong>${suggestion ? `<p><strong>Suggested labor:</strong> ${esc(suggestion.laborCategory)} &middot; ${money(suggestion.laborCost)} (company rate)</p>` : ''}${parts.map((part,index)=>`<label class="d-block my-2"><input type="checkbox" data-ai-part value="${index}"> <span>${esc(part.name)}${part.quantity > 1 ? ` &middot; ${part.quantity} needed` : ''}<small class="d-block">${part.cost == null ? 'Confirm the supplier price before submitting.' : `${money(part.cost)} each &middot; saved catalog price`}</small></span></label>`).join('') || '<p>No parts suggested.</p>'}<button type="button" class="ru-btn" data-use-ai>Use confirmed selections and build quotation draft</button>`;
      panel.querySelector('[data-use-ai]').onclick = () => {
        const selected = [...panel.querySelectorAll('[data-ai-cause]:checked')].map(input => causes[Number(input.value)]).filter(Boolean);
        if (!selected.length && !form.elements.diagnosis.value.trim()) return showError('Confirm an on-site diagnosis or enter your diagnosis before building the quotation draft.');
        if (selected.length) {
          form.elements.diagnosis.value = [...new Set([form.elements.diagnosis.value.trim(), ...selected].filter(Boolean))].join('\n');
          // Suggestions can help the diagnosis, but cannot invent observations or tests.
          form.elements.technicianConfirmed.checked = false;
          form.dataset.diagnosisSource = 'ai_reviewed';
          form.dataset.dirty = 'true';
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
        form.dataset.dirty = 'true';
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
      return `<form class="ru-inspect rq-inspection" id="ru-form-${esc(unit.key)}" data-key="${esc(unit.key)}" data-diagnosis-source="${esc(unit.diagnosis?.source || 'technician')}">
        <nav class="rq-progress" aria-label="Inspection steps"><button type="button" data-inspection-step="inspection" aria-current="step"><span>1</span>Inspection</button><button type="button" data-inspection-step="quotation"><span>2</span>Quotation</button><button type="button" data-inspection-step="review"><span>3</span>Review</button></nav>
        <section class="rq-section" data-inspection-panel><div class="rq-section-title"><div><span class="ru-eyebrow">STEP 1 OF 3</span><h3>Inspect the appliance</h3><p>Record what you checked and the repair you recommend.</p></div><span class="rq-required-note">* Required</span></div>${aiInspector(unit)}<div class="ru-grid">
        <label class="ru-field">Inspection findings *<textarea name="findings" required minlength="10" maxlength="2000" placeholder="What did you observe? Describe the fault and condition of the appliance.">${esc(unit.inspection?.findings)}</textarea></label>
        <label class="ru-field">Checks and test results *<textarea name="testsPerformed" required minlength="10" maxlength="2000" placeholder="Record checks, measurements and results. If a test was unsafe or unavailable, explain why.">${esc(unit.inspection?.testsPerformed)}</textarea></label>
        <label class="ru-field">Technician diagnosis *<textarea name="diagnosis" required minlength="5" maxlength="2000" placeholder="Explain the likely fault based on your checks.">${esc(unit.diagnosis?.summary)}</textarea></label>
        <label class="ru-field">Recommended repair *<textarea name="recommendedAction" required minlength="5" maxlength="2000" placeholder="What work is needed to address the fault? Include any limitations.">${esc(unit.inspection?.recommendedAction)}</textarea></label></div>
        <details class="rq-evidence"><summary><strong>Inspection photos</strong><span>Optional &middot; up to 4 images</span></summary><div class="rq-evidence-content"><p class="ru-muted">Appliance condition, model sticker or test readings. Up to four JPG, PNG or WEBP images, 5 MB each. Saved photos are visible only to the customer and authorised staff.</p><div data-evidence-gallery>${evidenceGallery(unit)}</div><label class="ru-field">Choose inspection photos<input type="file" name="inspectionPhotos" accept="image/jpeg,image/png,image/webp" multiple></label><button type="button" class="ru-btn" data-upload-evidence>Upload selected photos</button><p data-evidence-status role="status" class="ru-muted"></p></div></details>
        <label class="rv-check"><input type="checkbox" name="technicianConfirmed" required ${unit.inspection?.technicianConfirmed ? 'checked' : ''}><span>I inspected this appliance and checked the findings, diagnosis and recommended repair.</span></label>
        <div class="ru-actions rq-submit" data-inspection-actions><button class="ru-btn" type="button" data-save-inspection>Save inspection draft</button><button class="ru-btn ru-btn-primary" type="button" data-continue-quote>Continue to quotation</button></div></section>
        <section class="rq-section" data-quotation-panel hidden><div class="rq-section-title"><div><span class="ru-eyebrow">STEP 2 OF 3</span><h3>Build the repair quotation</h3><p>Add labor and the parts required for this repair.</p></div></div><div class="ru-grid"><label class="ru-field">Repair complexity<select name="laborCategory">${Object.entries(state.laborFees || {}).map(([key,value]) => `<option value="${key}" ${(unit.quotation?.laborCategory || 'standard') === key ? 'selected' : ''}>${key[0].toUpperCase()+key.slice(1)} · ${money(value)}</option>`).join('')}</select></label><label class="ru-field">Labor pricing<select name="laborPricingMode"><option value="company">Company labor rate</option><option value="custom" ${unit.quotation?.laborPricingMode === 'custom' ? 'selected' : ''}>Set technician labor price</option></select></label><label class="ru-field">Labor amount (PHP)<input name="laborCost" type="number" min="0" max="1000000" step=".01" required value="${Number(unit.quotation?.laborCost ?? state.laborFees?.standard ?? 0)}"></label><label class="ru-field" data-labor-reason hidden>Reason for custom labor price<textarea name="laborPriceReason" minlength="5" maxlength="500" placeholder="Explain the work covered by this labor price.">${esc(unit.quotation?.laborPriceReason)}</textarea></label></div>
        <div class="rq-section-heading"><h4>Replacement parts</h4><button class="ru-btn" type="button" data-add-part>Add part</button></div><p class="ru-muted">Catalog parts use saved selling prices. Other parts need a confirmed supplier price. Leave the list empty if no replacement is needed.</p><div class="ru-parts-list">${(unit.quotation?.parts || []).map(partRow).join('')}</div><label class="ru-field">Quotation notes<input name="notes" maxlength="2000" value="${esc(unit.quotation?.notes)}" placeholder="Warranty, repair scope, or details the customer should know."></label><div class="rq-quote-total" data-quote-preview aria-live="polite"></div></section>
        <div class="ru-actions rq-submit" data-quotation-actions hidden><button class="ru-btn" type="button" data-back-inspection>Back</button><button class="ru-btn" type="submit" data-save-draft>Save draft</button><button class="ru-btn ru-btn-primary" type="button" data-review-quote>Review quotation</button></div><section class="rq-section" data-review-panel hidden><div class="rq-section-title"><div><span class="ru-eyebrow">STEP 3 OF 3</span><h3>Review before sending</h3><p>The customer and staff will receive this inspection and quotation.</p></div></div><div data-review-preview></div></section><div class="ru-actions rq-submit" data-review-actions hidden><button class="ru-btn" type="button" data-back-quote>Edit quotation</button>${canSubmit ? '<button class="ru-btn ru-btn-primary" type="submit" data-submit-inspection>Submit inspection and quotation</button>' : '<p class="ru-muted">Save the other appliance drafts before submitting this quotation.</p>'}</div></form>`;
    }
    if (unit.review?.state === 'approved' && state.scope === 'booking' && state.canComplete) return `<form class="ru-complete rq-section" data-key="${esc(unit.key)}"><h3>Test and verify the repair</h3><p class="ru-muted">Record the actual work and test results. An unresolved appliance remains open for follow-up.</p><div class="ru-grid"><label class="ru-field">Work performed *<textarea name="notes" required minlength="10" maxlength="1000">${esc(unit.repairVerification?.workPerformed)}</textarea></label><label class="ru-field">Final test results *<textarea name="testResults" required minlength="10" maxlength="2000" placeholder="Describe how operation was tested and the actual results.">${esc(unit.repairVerification?.testResults)}</textarea></label><label class="ru-field">Test outcome *<select name="outcome"><option value="">Choose an outcome</option><option value="resolved">Issue resolved; tests passed</option><option value="follow_up_required">Unresolved; follow-up needed</option></select></label><label class="ru-field" data-follow-up hidden>Follow-up reason and remaining work *<textarea name="followUpReason" minlength="10" maxlength="500">${esc(unit.repairVerification?.followUpReason)}</textarea></label></div><label class="rv-check" data-customer-confirmation><input type="checkbox" name="customerConfirmed"><span>I explained the work and test results to the customer, and they confirmed the appliance is working.</span></label><button class="ru-btn ru-btn-primary" type="submit">Save test outcome</button></form>`;
    return '';
  }
  function evidenceGallery(unit) {
    return (unit.inspection?.photos || []).filter(url => /^\/api\/repair-units\/(booking|project)\/[a-f\d]{24}\/evidence\/[a-f\d]{24}$/i.test(url)).map((url, index) => `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Inspection evidence ${index + 1}" loading="lazy"><span>Photo ${index + 1}</span></a>`).join('');
  }
  function inspectionPayload(form) {
    return { key: form.dataset.key, findings: form.elements.findings.value, testsPerformed: form.elements.testsPerformed.value,
      diagnosis: form.elements.diagnosis.value, recommendedAction: form.elements.recommendedAction.value, technicianConfirmed: form.elements.technicianConfirmed.checked };
  }
  function partsPayload(form) {
    return [...form.querySelectorAll('.ru-parts')].map(row => ({toolId:row.querySelector('select').value || null,name:row.querySelector('.ru-part-name').value,quantity:Number(row.querySelector('input[type=number]').value),cost:row.querySelector('.ru-part-cost').value === '' ? null : Number(row.querySelector('.ru-part-cost').value)}));
  }
  function rememberForms(exceptKey) {
    dialog?.querySelectorAll('.ru-inspect').forEach(form => {
      if(form.dataset.key===exceptKey || form.dataset.dirty!=='true')return;
      const unit=state.units.find(unit=>unit.key===form.dataset.key);
      const fields={}; [...form.elements].forEach(input=>{if(input.name&&input.type!=='file')fields[input.name]=input.type==='checkbox'?input.checked:input.value;});
      drafts.set(form.dataset.key,{revision:unit.review?.revision,fields,parts:partsPayload(form),source:form.dataset.diagnosisSource,step:form.dataset.step});
    });
  }
  function activateUnit(key) {
    if(!state.units.some(unit=>unit.key===key))key=state.units[0]?.key;
    activeKey=key;
    if(dialog.classList.contains('ru-workspace')){
      dialog.querySelectorAll('.ru-unit').forEach((card,index)=>{card.hidden=state.units[index].key!==key;card.open=state.units[index].key===key;});
      dialog.querySelectorAll('[data-unit-select]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.unitSelect===key)));
    }
    placeActions();
  }
  function placeActions() {
    const footer=dialog.querySelector('[data-work-actions]');if(!footer)return;
    // Move real buttons, keeping their form association and event handlers.
    dialog.querySelectorAll('.ru-inspect').forEach(form=>{
      const step=form.dataset.step||'inspection';
      for(const [name,block] of Object.entries(form._actions||{})){
        block.hidden=name!==step;
        block.querySelectorAll('button').forEach(button=>button.setAttribute('form',form.id));
        if(form.dataset.key===activeKey&&name===step){footer.append(block);block.hidden=false;}else form.append(block);
      }
    });
  }
  function reviewPreview(form) {
    const parts=partsPayload(form),labor=Number(form.elements.laborCost.value),total=parts.reduce((sum,part)=>sum+part.quantity*part.cost,labor);
    form.querySelector('[data-review-preview]').innerHTML=`<section class="rq-review-findings"><h4>Inspection summary</h4><dl><div><dt>Diagnosis</dt><dd>${esc(form.elements.diagnosis.value)}</dd></div><div><dt>Recommended repair</dt><dd>${esc(form.elements.recommendedAction.value)}</dd></div></dl><details><summary>View findings and test results</summary><p class="ru-evidence">${esc(form.elements.findings.value)}\n\n${esc(form.elements.testsPerformed.value)}</p></details></section><section class="rq-review-prices"><h4>Repair quotation</h4>${parts.map(part=>`<div><span>${esc(part.name)}<small>${part.quantity} × ${money(part.cost)}</small></span><strong>${money(part.cost*part.quantity)}</strong></div>`).join('')||'<p class="ru-muted">No replacement parts</p>'}<div><span>Labor</span><strong>${money(labor)}</strong></div><div class="rq-review-total"><span>Quoted repair total</span><strong>${money(total)}</strong></div><p class="ru-muted">Inspection and travel charges are recorded separately.</p></section>`;
  }
  function inspectionValid(form) {
    const invalid = ['findings','testsPerformed','diagnosis','recommendedAction','technicianConfirmed'].find(name => !form.elements[name].checkValidity());
    if (!invalid) return true;
    showInspectionStep(form, 'inspection');
    form.elements[invalid].reportValidity();
    return false;
  }
  function showInspectionStep(form, stage) {
    if(stage!=='inspection'&&!inspectionValid(form))return;
    if(stage==='review'){
      showInspectionStep(form,'quotation');
      if(!form.reportValidity())return;
      reviewPreview(form);
    }
    form.dataset.step = stage;
    form.querySelector('[data-inspection-panel]').hidden = stage !== 'inspection';
    form.querySelector('[data-quotation-panel]').hidden = stage !== 'quotation';
    form.querySelector('[data-review-panel]').hidden = stage !== 'review';
    form.querySelectorAll('[data-inspection-step]').forEach(button => { if (button.dataset.inspectionStep === stage) button.setAttribute('aria-current','step'); else button.removeAttribute('aria-current'); });
    placeActions();
    form.querySelector(stage === 'quotation' ? '[data-quotation-panel]' : stage==='review'?'[data-review-panel]':'[data-inspection-panel]').scrollIntoView({block:'start'});
  }
  function quotationDetails(unit) {
    if (!unit.quotation) return '';
    const quote = unit.quotation;
    return `<section class="rq-quote-total"><h4>Repair quotation</h4>${(quote.parts || []).map(part => `<span>${esc(part.name)} · ${part.quantity} × ${money(part.cost)}<strong>${money(Number(part.quantity) * Number(part.cost))}</strong></span>`).join('') || '<span>No replacement parts</span>'}<span>Labor ${quote.laborPricingMode === 'custom' ? '(technician price)' : '(company rate)'}<strong>${money(quote.laborCost)}</strong></span>${quote.laborPricingMode === 'custom' ? `<small>Price reason: ${esc(quote.laborPriceReason)}</small>` : ''}<span class="rq-total">Repair total<strong>${money(quote.totalCost)}</strong></span>${quote.notes ? `<small>${esc(quote.notes)}</small>` : ''}${unit.review?.decisionMethod === 'on_site' ? `<small class="rq-notice">Customer decision given verbally on site and recorded by the assigned technician. ${esc(unit.review.decisionNotes || '')}</small>` : ''}</section>`;
  }
  function inspectionRecord(unit) {
    const inspection = unit.inspection || {}, verification = unit.repairVerification;
    return `${inspection.testsPerformed ? `<p class="ru-evidence"><strong>Inspection checks and test results:</strong> ${esc(inspection.testsPerformed)}</p>` : ''}${inspection.recommendedAction ? `<p class="ru-evidence"><strong>Recommended repair:</strong> ${esc(inspection.recommendedAction)}</p>` : ''}${inspection.photos?.length ? `<div class="rq-evidence-gallery">${evidenceGallery(unit)}</div>` : ''}${verification?.outcome ? `<section class="rq-notice"><strong>${verification.outcome === 'resolved' ? 'Issue resolved · customer confirmation recorded' : 'Follow-up required · appliance remains open'}</strong><p class="ru-evidence">Work performed: ${esc(verification.workPerformed)}\nTest results: ${esc(verification.testResults)}${verification.followUpReason ? `\nRemaining work: ${esc(verification.followUpReason)}` : ''}</p></section>` : ''}`;
  }
  function unitCard(unit) {
    const editable = state.canInspect && !state.closed && !state.needsSetup && ['pending','staff_review'].includes(unit.review?.state || 'pending') && (!state.submitted || state.reviewStatus === 'rejected');
    const status = unit.repairVerification?.outcome === 'follow_up_required' ? 'Follow-up required' : unit.review?.state === 'staff_review' ? state.submitted ? 'Quotation submitted' : 'Draft saved' : labels[unit.review?.state || 'pending'];
    return `<details class="ru-unit" ${state.units.length === 1 ? 'open' : ''}><summary><span>${state.role === 'customer' && unit.review?.state === 'customer_review' ? `<input class="ru-choose" type="checkbox" data-key="${esc(unit.key)}" aria-label="Select ${esc(unit.label)}">` : ''} <strong>${esc(unit.key)} · ${esc(unit.label)}</strong><br><small class="ru-muted">${esc([unit.brand,unit.model].filter(Boolean).join(' · '))}</small></span><span class="ru-status">${esc(status)}</span>${unit.quotation && !editable ? `<span class="ru-price">${money(unit.quotation.totalCost)}</span>` : ''}</summary><div class="ru-unit-content"><p class="ru-evidence"><strong>Reported problem:</strong> ${esc(unit.problemDescription || 'Not recorded')}</p>${!editable ? `${unit.inspection?.findings ? `<p class="ru-evidence"><strong>Findings:</strong> ${esc(unit.inspection.findings)}<br><strong>Diagnosis:</strong> ${esc(unit.diagnosis?.summary)}</p>` : ''}${inspectionRecord(unit)}${quotationDetails(unit)}${!unit.repairVerification?.outcome && unit.completionNotes ? `<p class="ru-evidence"><strong>Repairs and tests:</strong> ${esc(unit.completionNotes)}</p>` : ''}` : ''}${inspector(unit)}</div></details>`;
  }
  function unitNavigation() {
    return `<aside class="ru-appliances"><span class="ru-eyebrow">${state.units.length===1?'APPLIANCE':'SELECT AN APPLIANCE'}</span>${state.units.map(unit=>`<button type="button" data-unit-select="${esc(unit.key)}" aria-pressed="${unit.key===activeKey}"><span class="ru-appliance-icon" aria-hidden="true">▤</span><span><strong>${esc(unit.label)}</strong><small>${esc([unit.brand,unit.model].filter(Boolean).join(' · ')||unit.key)}</small><em>${esc(unit.review?.state==='staff_review'?state.submitted?'Quotation sent':'Draft saved':labels[unit.review?.state||'pending'])}</em></span></button>`).join('')}</aside>`;
  }
  function render() {
    const reviewed = state.units.filter(unit => unit.review?.state === 'customer_review');
    const allInspected = state.units.length && state.units.every(unit => unit.review?.state === 'staff_review');
    const workspace = state.role==='technician' && state.canInspect;
    activeKey = state.units.some(unit=>unit.key===activeKey) ? activeKey : state.units[0]?.key;
    dialog.classList.toggle('ru-workspace',workspace);
    dialog.classList.toggle('ru-readonly',!workspace);
    dialog.innerHTML = `<header class="ru-header"><div><span class="ru-eyebrow">REPAIR VISIT${state.reference ? ' &middot; '+esc(state.reference) : ''}</span><h2>Inspection & quotation</h2><p>${state.submitted?'Review the report and the customer&#39;s next step.':'Document the inspection, price the repair and review before sending.'}</p></div><button class="ru-close" aria-label="Close appliance repairs">&times;</button></header><div class="ru-body"><div class="ru-error" role="alert" tabindex="-1" hidden></div><div class="ru-toolbar">${!state.closed && state.canInspect && allInspected && (!state.submitted || state.reviewStatus === 'rejected') ? '<button class="ru-btn ru-btn-primary" data-submit>Submit inspection and quotation</button>' : ''}${!state.closed && state.submitted && allInspected && ['admin','secretary'].includes(state.role) && state.reviewStatus === 'pending' ? '<button class="ru-btn ru-btn-primary" data-review="approve">Send prices to customer</button><button class="ru-btn" data-review="reject">Return for changes</button><input id="ruReviewNotes" class="form-control" maxlength="1000" placeholder="Review notes / changes needed">' : ''}${!state.closed && state.role === 'customer' && reviewed.length ? '<button class="ru-btn" data-select-all>Select all waiting quotes</button><button class="ru-btn ru-btn-primary" data-decide="true">Approve selected repairs</button><button class="ru-btn" data-decide="false">Decline selected repairs</button>' : ''}</div><div class="ru-workspace-grid">${workspace?unitNavigation():''}<main class="ru-workspace-main">${state.units.map(unitCard).join('')}</main></div></div><footer class="ru-footer ru-work-footer"><p>${state.payment?.paidInFull?'Payment is recorded in full. No collection is needed.':workspace?'Save your findings before leaving this workspace.':'Inspection fees are separate from the repair quotation.'}</p><div data-work-actions></div></footer>`;

    if (state.blockedReason) { const hint=document.createElement('p');hint.className='ru-evidence';hint.textContent=state.blockedReason;dialog.querySelector('.ru-toolbar').after(hint); }
    if (state.canPlanRepair && (!state.canComplete || state.units.some(unit => unit.repairVerification?.outcome === 'follow_up_required')) && window.openRepairWorkflow) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ru-btn ru-btn-primary'; button.textContent = 'Customer decision: repair now, later, or cancel';
      if (state.canComplete) button.textContent = 'Plan remaining work or a return visit';
      button.onclick = () => { dialog.close(); window.openRepairWorkflow(state.id); }; dialog.querySelector('.ru-toolbar').append(button);
    }
    if (state.readyForCompletion && window.completeRepair) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ru-btn ru-btn-primary'; button.textContent = state.payment?.paidInFull ? 'Continue to completion proof' : 'Continue to payment and completion proof';
      button.onclick = () => { dialog.close(); window.completeRepair(state.id); }; dialog.querySelector('.ru-toolbar').append(button);
    }
    dialog.querySelector('.ru-close').onclick = () => { if (!busy) { rememberForms(); dialog.close(); } };
    dialog.querySelectorAll('[data-unit-select]').forEach(button=>button.onclick=()=>{if(!busy)activateUnit(button.dataset.unitSelect);});
    if (state.needsSetup && (state.canInspect || ['admin', 'secretary'].includes(state.role))) {
      const button = document.createElement('button'); button.className = 'ru-btn ru-btn-primary'; button.textContent = 'Start individual appliance inspections';
      button.onclick = () => { if (confirm('Start individual inspections for this existing repair project? No completed work will be changed.')) save('prepare', {}); };
      dialog.querySelector('.ru-toolbar').append(button);
    }
    dialog.querySelector('[data-select-all]')?.addEventListener('click', () => dialog.querySelectorAll('.ru-choose').forEach(box => { box.checked = true; }));
    dialog.querySelector('[data-submit]')?.addEventListener('click', () => {
      if ([...dialog.querySelectorAll('.ru-inspect')].some(form => form.dataset.dirty === 'true')) return showError('Save or review your changed appliance quotations before sending them.');
      save('submit', {});
    });
    dialog.querySelectorAll('[data-review]').forEach(button => button.onclick = () => save('review', { action:button.dataset.review, notes:dialog.querySelector('#ruReviewNotes')?.value || '' }));
    dialog.querySelectorAll('[data-decide]').forEach(button => button.onclick = () => {
      const decisions = [...dialog.querySelectorAll('.ru-choose:checked')].map(box => ({ key:box.dataset.key, revision:state.units.find(unit => unit.key === box.dataset.key).review.revision, approved:button.dataset.decide === 'true' }));
      if (!decisions.length) return showError('Select the appliances you want to approve or decline.');
      if (confirm(`${button.dataset.decide === 'true' ? 'Approve' : 'Decline'} repairs for these ${decisions.length} appliances?`)) save('decide', { decisions });
    });
    dialog.querySelectorAll('.ru-inspect').forEach(form => {
      form.noValidate = true;
      form.dataset.step = 'inspection';
      form._actions={inspection:form.querySelector('[data-inspection-actions]'),quotation:form.querySelector('[data-quotation-actions]'),review:form.querySelector('[data-review-actions]')};
      form.querySelectorAll('[data-inspection-step]').forEach(button => button.onclick = () => showInspectionStep(form, button.dataset.inspectionStep));
      form.querySelector('[data-continue-quote]').onclick = () => showInspectionStep(form, 'quotation');
      form.querySelector('[data-back-inspection]').onclick = () => showInspectionStep(form, 'inspection');
      form.querySelector('[data-save-inspection]').onclick = () => {
        if (form.elements.findings.reportValidity()) save('inspection-draft', inspectionPayload(form));
      };
      form.querySelector('[data-upload-evidence]').onclick = () => uploadEvidence(form);
      form.querySelector('[data-add-part]').onclick = () => { form.dataset.dirty='true';form.querySelector('.ru-parts-list').insertAdjacentHTML('beforeend', partRow()); bindParts(form); };
      bindParts(form);
      form.querySelector('[data-unit-ai]')?.addEventListener('click',()=>generateUnitAi(form));
      form.querySelector('[data-unit-quote-ai]')?.addEventListener('click',()=>generateUnitAi(form, true));
      form.querySelector('[data-review-quote]').onclick=()=>showInspectionStep(form,'review');
      form.querySelector('[data-back-quote]').onclick=()=>showInspectionStep(form,'quotation');
      form.addEventListener('input', event => {
        form.dataset.dirty='true';
        if (['findings','testsPerformed','diagnosis','recommendedAction'].includes(event.target.name)) form.elements.technicianConfirmed.checked = false;
        if(form.querySelector('[data-quote-preview]').textContent)quotePreview(form);
      });
      form.elements.diagnosis.addEventListener('input', () => { form.dataset.diagnosisSource = 'technician'; });
      form.elements.laborPricingMode.addEventListener('change', () => quotePreview(form));
      form.elements.laborCategory.addEventListener('change', () => quotePreview(form));
      const local=drafts.get(form.dataset.key),unit=state.units.find(unit=>unit.key===form.dataset.key);
      if(local && local.revision===unit.review?.revision){
        for(const [name,value] of Object.entries(local.fields)){const input=form.elements[name];if(!input)continue;if(input.type==='checkbox')input.checked=value;else input.value=value;}
        form.querySelector('.ru-parts-list').innerHTML=local.parts.map(partRow).join('');bindParts(form);form.dataset.diagnosisSource=local.source;form.dataset.dirty='true';
      }else if(local)drafts.delete(form.dataset.key);
      quotePreview(form);
      if(local && local.revision===unit.review?.revision)showInspectionStep(form,local.step||'inspection');
      form.onsubmit = event => {
        event.preventDefault();
        if (busy) return;
        if(event.submitter?.hasAttribute('data-submit-inspection') && form.dataset.step!=='review')return showInspectionStep(form,'review');
        if(form.dataset.step==='inspection')return showInspectionStep(form,'quotation');
        if (!inspectionValid(form)) return showInspectionStep(form, 'inspection');
        if (!form.checkValidity()) { showInspectionStep(form,'quotation'); form.reportValidity(); return; }
        if (form.elements.inspectionPhotos.files.length) { showInspectionStep(form, 'inspection'); return showError('Upload the selected inspection photos before submitting, or clear the file selection.'); }
        if (event.submitter?.hasAttribute('data-submit-inspection') && [...dialog.querySelectorAll('.ru-inspect')].some(other => other !== form && other.dataset.dirty === 'true')) return showError('Another appliance has unsaved changes. Save its quotation draft before sending the complete quotation.');
        const parts = partsPayload(form);
        save(event.submitter?.hasAttribute('data-submit-inspection') ? 'inspect-and-submit' : 'inspect', { ...inspectionPayload(form), diagnosisSource:form.dataset.diagnosisSource, laborCategory:form.elements.laborCategory.value, laborPricingMode:form.elements.laborPricingMode.value, laborCost:Number(form.elements.laborCost.value), laborPriceReason:form.elements.laborPriceReason.value, notes:form.elements.notes.value, parts });
      };
    });
    dialog.querySelectorAll('.ru-complete').forEach(form => {
      form.elements.outcome.required = true;
      const update = () => {
        const followUp = form.elements.outcome.value === 'follow_up_required';
        form.querySelector('[data-follow-up]').hidden = !followUp; form.elements.followUpReason.required = followUp;
        form.querySelector('[data-customer-confirmation]').hidden = followUp; form.elements.customerConfirmed.required = !followUp;
      };
      form.elements.outcome.onchange = update; update();
      form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) save('complete', { key:form.dataset.key, notes:form.elements.notes.value, testResults:form.elements.testResults.value, outcome:form.elements.outcome.value, customerConfirmed:form.elements.customerConfirmed.checked, followUpReason:form.elements.followUpReason.value }); };
    });
    activateUnit(activeKey);
  }
  async function uploadEvidence(form) {
    if (busy) return;
    const files = [...form.elements.inspectionPhotos.files], unit = state.units.find(unit => unit.key === form.dataset.key);
    if (!files.length || files.length + (unit.inspection?.photos?.length || 0) > 4 || files.some(file => file.size > 5 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(file.type))) return showError('Choose up to four JPG, PNG or WEBP photos per appliance, no more than 5 MB each.');
    const body = new FormData(); body.append('key', form.dataset.key); body.append('version', String(state.version)); files.forEach(file => body.append('photos', file));
    busy = true;
    const controls = [...dialog.querySelectorAll('button,input,select,textarea')], disabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; }); form.querySelector('[data-evidence-status]').textContent = 'Uploading inspection photos…';
    try {
      const response = await fetch(`/api/repair-units/${state.scope}/${state.id}/evidence`, { method:'POST', credentials:'same-origin', body, signal:AbortSignal.timeout(45000) });
      const data = await response.json().catch(() => ({ error:'The server could not save the photos. Please try again.' }));
      if (!response.ok) throw Error(data.error || 'Could not save the inspection photos.');
      state.version = data.version; unit.inspection = { ...unit.inspection, photos:data.photos };
      form.querySelector('[data-evidence-gallery]').innerHTML = evidenceGallery(unit); form.elements.inspectionPhotos.value = '';
      form.querySelector('[data-evidence-status]').textContent = 'Inspection photos saved. Your unsaved form details are still here.';
    } catch (error) { form.querySelector('[data-evidence-status]').textContent = ''; showError(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'The upload took too long. Reopen the inspection to check saved photos before retrying.' : error.message); }
    finally { controls.forEach((control,index) => { control.disabled = disabled[index]; }); busy = false; }
  }
  function bindParts(form) {
    form.querySelectorAll('[data-remove-part]').forEach(button => button.onclick = () => { form.dataset.dirty='true';button.closest('.ru-parts').remove(); quotePreview(form); });
    form.querySelectorAll('.ru-parts select').forEach(select => {
      const update = () => {
        const row = select.closest('.ru-parts'), part = state.parts.find(part => String(part._id) === select.value);
        row.querySelector('.ru-part-cost').readOnly = !!part; row.querySelector('.ru-part-name').readOnly = !!part;
        if (part) { row.querySelector('.ru-part-cost').value = part.sellingPrice ?? part.costPrice ?? 0; row.querySelector('.ru-part-name').value = part.itemName; }
      };
      select.onchange = () => { form.dataset.dirty='true';update(); quotePreview(form); }; update();
    });
  }
  function showError(message) { const box = dialog.querySelector('.ru-error'); box.textContent = message; box.hidden = false; box.focus(); box.scrollIntoView({block:'nearest'}); }
  async function save(action, data) {
    if (busy) return;
    rememberForms(data.key);
    busy = true;
    const openKeys = [...dialog.querySelectorAll('details[open]')].map(details => details.querySelector('[data-key]')?.dataset.key).filter(Boolean);
    const controls = [...dialog.querySelectorAll('button,input,select,textarea')]; controls.forEach(control => { control.dataset.ruDisabled = String(control.disabled); control.disabled = true; });
    try {
      const updated = await request(`/api/repair-units/${state.scope}/${state.id}/${action}`, { ...data, version:state.version });
      if(data.key)drafts.delete(data.key);else if(['submit','inspect-and-submit'].includes(action))drafts.clear();
      state = { ...state, ...updated }; render();
      const notice = document.createElement('p'); notice.className = 'rq-notice'; notice.setAttribute('role','status');
      notice.textContent = action === 'inspection-draft' ? 'Inspection draft saved. No quotation has been submitted.'
        : action === 'inspect' ? 'Quotation draft saved. Review it before submitting to the customer and staff.'
        : action === 'complete' && data.outcome === 'follow_up_required' ? 'Follow-up recorded and admin notified. This appliance remains open; plan the remaining work or a return visit.'
        : action === 'complete' ? 'Repair testing and customer confirmation saved. Continue to the final payment and completion proof when every appliance is finished.' : 'Repair records updated.';
      dialog.querySelector('.ru-toolbar').after(notice);
      openKeys.forEach(key => dialog.querySelector(`[data-key="${key}"]`)?.closest('details')?.setAttribute('open',''));
      window.dispatchEvent(new CustomEvent('repair-units:updated', { detail:{ scope:state.scope, id:state.id } }));
      if (['submit', 'inspect-and-submit'].includes(action) && state.scope === 'booking' && state.canPlanRepair && window.openRepairWorkflow) { dialog.close(); window.openRepairWorkflow(state.id); }
    } catch (error) { showError(error.message); controls.forEach(control => { control.disabled = control.dataset.ruDisabled === 'true'; }); }
    finally { busy = false; }
  }
  window.openRepairUnits = async function (scope, id) {
    if (busy) return;
    busy = true;
    rememberForms();
    if(draftScope!==scope+':'+id){drafts.clear();activeKey='';draftScope=scope+':'+id;}
    if (dialog?.open) dialog.close();
    dialog = dialog || document.createElement('dialog'); dialog.className = 'ru-dialog';
    if (!dialog.isConnected) document.body.append(dialog);
    dialog.innerHTML = '<div class="ru-header"><h2>Loading appliance repairs…</h2></div>';
    dialog.showModal();
    dialog.oncancel = event => { if (busy) event.preventDefault(); else rememberForms(); };
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

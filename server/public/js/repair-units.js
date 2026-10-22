(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const money = value => new Intl.NumberFormat('en-PH', { style:'currency', currency:'PHP' }).format(Number(value || 0));
  const labels = { pending:'Needs inspection', staff_review:'Staff review', customer_review:'Your decision needed', approved:'Repair approved', declined:'Repair declined', completed:'Repaired' };
  function workspaceIcon(name) {
    const paths = {
      inspection:'M9 5H6a2 2 0 0 0-2 2v13h16V7a2 2 0 0 0-2-2h-3M9 3h6v4H9zM8 12h8M8 16h5',
      quotation:'M14 3H6v18h12V7l-4-4ZM14 3v5h4M9 12h6M9 16h4',
      review:'M9 12l2 2 4-4M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z',
      appliance:'M5 3h14v15H5zM8 7h8M8 11h5M8 21h8',
    };
    return `<svg class="ru-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${paths[name] || paths.inspection}"></path></svg>`;
  }
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
    const catalog = (state.parts || []).find(item => String(item._id) === String(part.toolId));
    const name = catalog?.itemName || part.name || '', price = catalog ? catalog.sellingPrice ?? catalog.costPrice ?? 0 : part.cost;
    return `<div class="ru-parts rq-part-row" data-part-source="${catalog ? 'catalog' : part.toolId ? 'unavailable' : 'supplier'}"><input type="hidden" class="ru-part-id" value="${esc(part.toolId || '')}"><label class="ru-field rq-part-identity">${part.toolId ? 'Replacement part' : 'Supplier part / specification *'}<input class="ru-part-name" required maxlength="200" placeholder="Part, rating and compatible model" value="${esc(name)}" ${catalog ? 'readonly' : ''} aria-label="Replacement part name"><small data-part-stock></small></label><label class="ru-field">Quantity<input type="number" min="1" max="999" step="1" required value="${Number(part.quantity || 1)}" aria-label="Part quantity"></label><label class="ru-field">Price each (PHP)<input class="ru-part-cost" type="number" min="0" max="1000000" required step=".01" value="${price == null ? '' : Number(price)}" ${catalog ? 'readonly' : ''} aria-label="Part unit price"></label><button type="button" class="ru-btn rq-remove-part" data-remove-part aria-label="Remove ${esc(name || 'part')}">&times;</button><span class="rq-part-subtotal" data-part-total></span></div>`;
  }
  function companyStock(part) {
    if (part.quantity == null || !Number.isFinite(Number(part.quantity))) return null;
    return Math.max(0, Number(part.quantity) - Math.max(0, Number(part.reservedQuantity) || 0));
  }
  function partsPicker() {
    return `<section class="rq-parts-section"><div class="rq-section-heading"><div><h4>Replacement parts <span class="rq-count" data-parts-count>0</span></h4><p>Add only the parts this appliance needs.</p></div><button class="ru-btn" type="button" data-add-part aria-expanded="false">Find a part</button></div><div class="rq-part-picker" data-part-picker hidden><div class="rq-picker-heading"><strong>Find a replacement part</strong><button type="button" class="ru-btn" data-close-picker aria-label="Close parts search">&times;</button></div><div class="rq-picker-filters"><label class="ru-field">Search parts<input type="search" data-part-search maxlength="200" placeholder="Part name, rating or specification" autocomplete="off"></label><label class="ru-field">Company stock<select data-part-filter><option value="all">All replacement parts</option><option value="available">Available stock</option><option value="unavailable">Out of stock</option></select></label></div><p class="rq-picker-status" data-picker-status role="status"></p><div class="rq-picker-results" data-part-results></div><div class="rq-picker-pagination"><button type="button" class="ru-btn" data-parts-prev>Previous</button><span data-parts-page></span><button type="button" class="ru-btn" data-parts-next>Next</button></div><div class="rq-picker-supplier"><span>Can't find the correct part?</span><button type="button" class="ru-btn" data-supplier-part>Add a supplier part</button></div></div><p class="rq-parts-empty" data-parts-empty>No replacement parts needed? Leave this section empty.</p><div class="ru-parts-list"></div><div class="rq-stock-guidance" data-stock-guidance hidden><strong>Plan the parts before starting</strong><p>Company stock is a guide, not confirmation of parts at the site. After sending the quotation, choose with the customer: source parts nearby, request another visit, or cancel the repair.</p></div></section>`;
  }
  function renderPartPicker(form) {
    const query = form.querySelector('[data-part-search]').value.toLowerCase().trim().split(/\s+/).filter(Boolean), filter = form.querySelector('[data-part-filter]').value;
    const matches = (state.parts || []).filter(part => {
      const text = [part.itemName, part.specification, part.category].filter(Boolean).join(' ').toLowerCase(), stock = companyStock(part);
      return query.every(word => text.includes(word)) && (filter === 'all' || (filter === 'available' ? stock > 0 : stock === 0));
    });
    const pages = Math.max(1, Math.ceil(matches.length / 6));
    form._partsPage = Math.min(Math.max(0, form._partsPage || 0), pages - 1);
    const start = form._partsPage * 6, selected = new Set(partsPayload(form).map(part => String(part.toolId)));
    form.querySelector('[data-picker-status]').textContent = matches.length ? `${matches.length} matching part${matches.length === 1 ? '' : 's'} · Showing ${start + 1}–${Math.min(start + 6, matches.length)}` : 'No matching replacement parts. Try another name or add a supplier part.';
    form.querySelector('[data-part-results]').innerHTML = matches.slice(start, start + 6).map(part => {
      const stock = companyStock(part), added = selected.has(String(part._id));
      return `<div class="rq-catalog-part"><div><strong>${esc(part.itemName)}</strong>${part.specification ? `<small>${esc(part.specification)}</small>` : ''}<span class="rq-stock-badge ${stock === 0 ? 'is-unavailable' : ''}">${esc(stock == null ? 'Stock not recorded' : stock > 0 ? `Company stock: ${stock} ${part.unit || 'pcs'}` : 'Out of stock')}</span></div><div class="rq-catalog-price"><strong>${money(part.sellingPrice ?? part.costPrice)}</strong><small>each</small></div><button type="button" class="ru-btn" data-pick-part="${esc(part._id)}" ${added ? 'disabled' : ''} aria-label="${added ? 'Added' : 'Add'} ${esc(part.itemName)}">${added ? 'Added' : '+ Add'}</button></div>`;
    }).join('');
    form.querySelector('[data-parts-page]').textContent = `Page ${form._partsPage + 1} of ${pages}`;
    form.querySelector('[data-parts-prev]').disabled = form._partsPage === 0;
    form.querySelector('[data-parts-next]').disabled = form._partsPage >= pages - 1;
    form.querySelectorAll('[data-pick-part]').forEach(button => button.onclick = () => {
      const part = state.parts.find(part => String(part._id) === button.dataset.pickPart);
      if (!part || partsPayload(form).some(row => String(row.toolId) === String(part._id))) return;
      addQuotationPart(form, { toolId:part._id, name:part.itemName, quantity:1, cost:part.sellingPrice ?? part.costPrice });
      form.querySelector('[data-part-search]').focus();
    });
  }
  function addQuotationPart(form, part = {}) {
    if (form.querySelectorAll('.ru-parts').length >= 50) return showError('A quotation can contain up to 50 replacement parts. Adjust the quantity of an existing part instead.');
    form.querySelector('.ru-parts-list').insertAdjacentHTML('beforeend', partRow(part));
    form.dataset.dirty = 'true'; form.elements.technicianConfirmed.checked = false; bindParts(form); quotePreview(form);
  }
  function bindPartPicker(form) {
    const picker = form.querySelector('[data-part-picker]'), toggle = form.querySelector('[data-add-part]'), search = form.querySelector('[data-part-search]');
    const close = () => { picker.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); };
    toggle.onclick = () => { picker.hidden = !picker.hidden; toggle.setAttribute('aria-expanded', String(!picker.hidden)); if (!picker.hidden) { renderPartPicker(form); search.focus({preventScroll:true}); picker.scrollIntoView({block:'start'}); } };
    form.querySelector('[data-close-picker]').onclick = close;
    search.oninput = () => { form._partsPage = 0; renderPartPicker(form); };
    form.querySelector('[data-part-filter]').onchange = () => { form._partsPage = 0; renderPartPicker(form); };
    picker.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } else if (event.key === 'Enter' && event.target === search) event.preventDefault(); };
    form.querySelector('[data-parts-prev]').onclick = () => { form._partsPage--; renderPartPicker(form); };
    form.querySelector('[data-parts-next]').onclick = () => { form._partsPage++; renderPartPicker(form); };
    form.querySelector('[data-supplier-part]').onclick = () => {
      addQuotationPart(form, { name:search.value.trim() }); close();
      const row = form.querySelector('.ru-parts:last-child'); row?.querySelector('.ru-part-name').focus(); row?.scrollIntoView({block:'nearest'});
    };
  }
  function aiInspector(unit) {
    if (state.scope !== 'booking') return '';
    const previous = unit.preVisitAssessment;
    return `<details class="rq-ai"><summary><span class="ru-ai-symbol" aria-hidden="true">&#10022;</span><span><strong>${previous ? 'Review earlier AI assessment' : 'Diagnostic help'}</strong><small>${previous?.reviewed ? 'Reviewed before departure' : 'Optional reference'}</small></span><span aria-hidden="true">+</span></summary><div class="rq-ai-content"><div data-assessment-reference></div><div class="ru-actions"><button type="button" class="ru-btn" data-unit-ai>${previous ? 'Update suggestions using my findings' : 'Get diagnostic suggestions'}</button></div><p data-unit-ai-result role="status"></p></div></details>`;
  }
  function diagnosisChoices() {
    return '<div class="rq-diagnosis"><label class="ru-field" data-diagnosis-choices hidden>Confirmed diagnosis *<select name="diagnosisChoice" aria-label="Confirmed diagnosis"></select><small>Choose only a cause confirmed by your inspection.</small></label><p class="rq-confirmed-cause" data-diagnosis-preview hidden></p><label class="ru-field" data-manual-diagnosis>Diagnosis *<textarea name="diagnosis" required minlength="5" maxlength="2000" placeholder="What is causing the problem, based on your checks?"></textarea></label><button type="button" class="ru-btn rq-edit-diagnosis" data-edit-diagnosis hidden>Edit diagnosis</button></div>';
  }
  function setDiagnosisMode(form, value, focus = false) {
    const cause = form._causes?.[Number(value)];
    const selected = value !== '' && value !== 'custom' && !!cause;
    form.querySelector('[data-manual-diagnosis]').hidden = selected || (value === '' && form._causes.length > 0);
    form.querySelector('[data-diagnosis-preview]').hidden = !selected;
    form.querySelector('[data-diagnosis-preview]').textContent = selected ? cause : '';
    form.querySelector('[data-edit-diagnosis]').hidden = !selected;
    if (focus && !selected && value === 'custom') form.elements.diagnosis.focus();
  }
  function bindDiagnosis(form, preferCustom = false) {
    form._causes = [...new Set((form._assessment?.probableCauses || []).map(item => typeof item === 'string' ? item : item?.cause).filter(cause => typeof cause === 'string' && cause.trim().length >= 5 && cause.length <= 2000).map(cause => cause.trim()))];
    const select = form.elements.diagnosisChoice, diagnosis = form.elements.diagnosis.value.trim();
    const index = form._causes.indexOf(diagnosis);
    select.innerHTML = '<option value="">Choose the cause you confirmed</option>' + form._causes.map((cause, index) => `<option value="${index}">${esc(cause)}</option>`).join('') + '<option value="custom">Enter another diagnosis</option>';
    select.required = form._causes.length > 0;
    form.querySelector('[data-diagnosis-choices]').hidden = !form._causes.length;
    select.value = preferCustom || !form._causes.length || (diagnosis && index < 0) ? 'custom' : index >= 0 ? String(index) : '';
    setDiagnosisMode(form, select.value);
    select.onchange = () => {
      const value = select.value, selected = value !== '' && value !== 'custom' && form._causes[Number(value)];
      if (selected) { form.elements.diagnosis.value = selected; form.dataset.diagnosisSource = 'ai_reviewed'; }
      else if (value === '') form.elements.diagnosis.value = '';
      form.dataset.dirty = 'true'; form.elements.technicianConfirmed.checked = false;
      setDiagnosisMode(form, value, true);
    };
    form.querySelector('[data-edit-diagnosis]').onclick = () => { select.value = 'custom'; setDiagnosisMode(form, 'custom', true); };
  }
  function assessmentParts(report) {
    const normalized = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return (report?.quoteSuggestion?.parts || report?.possibleParts || []).slice(0, 50).map(value => {
      const item = typeof value === 'string' ? {name:value} : value;
      const matches = (state.parts || []).filter(part => item?.toolId ? String(part._id) === String(item.toolId) : normalized(part.itemName) === normalized(item?.name));
      const catalog = matches.length === 1 ? matches[0] : null;
      return {name:catalog?.itemName || String(item?.name || '').slice(0, 200), quantity:Number.isInteger(item?.quantity) && item.quantity > 0 && item.quantity <= 999 ? item.quantity : 1,
        toolId:catalog?._id, cost:catalog ? catalog.sellingPrice ?? catalog.costPrice : null};
    }).filter(part => part.name);
  }
  function renderAssessment(form, report, origin = 'pre_visit', preferCustom = false) {
    form._assessment = report; form._assessmentOrigin = origin;
    bindDiagnosis(form, preferCustom);
    const reference = form.querySelector('[data-assessment-reference]');
    if (!reference) return;
    const button = form.querySelector('[data-unit-ai]');
    button.textContent = report ? 'Update suggestions using my findings' : 'Get diagnostic suggestions';
    if (!report) { reference.innerHTML = '<p>No earlier assessment is available for this appliance. Enter your diagnosis directly or request optional suggestions.</p>'; return; }
    const parts = assessmentParts(report), checks = (report.inspectionChecklist || []).map(item => typeof item === 'string' ? item : item?.action).filter(Boolean);
    const tools = (report.suggestedTools || []).map(item => typeof item === 'string' ? item : item?.name).filter(Boolean);
    reference.innerHTML = `<p class="rq-assessment-origin">${origin === 'on_site' ? 'Updated using your on-site notes' : 'Assessment prepared before this visit'}</p><p class="ru-evidence">${esc(report.summary)}</p>${checks.length || tools.length ? `<details><summary>Suggested checks and tools</summary>${checks.length ? `<ul>${checks.map(check => `<li>${esc(check)}</li>`).join('')}</ul>` : ''}${tools.length ? `<p>Tools: ${tools.map(esc).join(', ')}</p>` : ''}</details>` : ''}${parts.length ? `<details><summary>Possible parts (${parts.length})</summary><p>Select only parts confirmed as necessary for this appliance.</p>${parts.map((part,index) => `<label><input type="checkbox" data-ai-part value="${index}"><span>${esc(part.name)}${part.quantity > 1 ? ` &middot; ${part.quantity} needed` : ''}<small>${part.cost == null ? 'Enter a confirmed supplier price in Quotation.' : `${money(part.cost)} each &middot; catalog price`}</small></span></label>`).join('')}<button type="button" class="ru-btn" data-use-ai>Add selected parts to quotation</button></details>` : ''}`;
    reference.querySelector('[data-use-ai]')?.addEventListener('click', () => {
      const selected = [...reference.querySelectorAll('[data-ai-part]:checked')];
      if (!selected.length) return showError('Select the parts you confirmed as necessary.');
      const unmatched = [];
      selected.forEach(input => {
        const part = parts[Number(input.value)];
        if ([...form.querySelectorAll('.ru-part-name')].some(field => field.value.trim().toLowerCase() === part.name.trim().toLowerCase())) return;
        if (part.cost == null) unmatched.push(part.name);
        addQuotationPart(form, part);
      });
      form.dataset.dirty = 'true'; bindParts(form); quotePreview(form);
      if (unmatched.length) showError('Enter a confirmed supplier price in Quotation for: ' + unmatched.join(', ') + '.');
      else form.querySelector('[data-unit-ai-result]').textContent = 'Selected parts added. Review their compatibility and price in Quotation.';
    });
  }
  function inspectionNotes(unit) {
    const findings = unit.inspection?.findings || '', checks = unit.inspection?.testsPerformed || '';
    return checks && findings && checks !== findings ? `Findings:\n${findings}\n\nChecks / readings:\n${checks}` : findings || checks;
  }
  function inspectionFields(form) {
    const notes = form.elements.inspectionNotes.value.trim(), original = form._originalInspection;
    // Preserve distinct historical notes verbatim when the combined field is unchanged.
    if (notes === original.notes.trim()) return { findings:original.findings || notes, testsPerformed:original.testsPerformed || notes };
    return { findings:notes, testsPerformed:notes };
  }
  function validateNotes(form) {
    const input = form.elements.inspectionNotes, notes = input.value.trim();
    const unchanged = notes === form._originalInspection.notes.trim();
    input.setCustomValidity(notes.length < 10 ? 'Describe your checks and findings in at least 10 characters.' : !unchanged && notes.length > 2000 ? 'Keep the updated checks and findings within 2,000 characters. Your earlier notes have been preserved.' : '');
    return input.checkValidity();
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
    let partsTotal = 0, needsSupply = false;
    const rows = [...form.querySelectorAll('.ru-parts')];
    form.querySelector('[data-parts-count]').textContent = rows.length;
    form.querySelector('[data-parts-empty]').hidden = rows.length > 0;
    for (const row of rows) {
      const quantity = Number(row.querySelector('input[type=number]').value), cost = Number(row.querySelector('.ru-part-cost').value);
      const id = row.querySelector('.ru-part-id').value, part = (state.parts || []).find(part => String(part._id) === id), stock = part ? companyStock(part) : null;
      const hint = row.querySelector('[data-part-stock]');
      hint.textContent = id && !part ? 'No longer available in the parts catalog. Remove and select a replacement.' : !id ? 'Not in catalog. Confirm compatibility and supplier price before quoting.' : stock == null ? 'Company stock not recorded. Confirm supply before starting.' : stock < quantity ? `Company stock: ${stock} · Source ${Math.max(0, quantity - stock)} more before starting.` : `Company stock: ${stock} ${part.unit || 'pcs'} · Confirm parts are at the site before starting.`;
      hint.classList.toggle('is-unavailable', !part || stock == null || stock < quantity);
      needsSupply ||= !part || stock == null || stock < quantity;
      const valid = Number.isInteger(quantity) && quantity >= 1 && quantity <= 999 && Number.isFinite(cost) && cost >= 0 && row.querySelector('.ru-part-cost').value !== '';
      row.querySelector('[data-part-total]').textContent = valid ? `Part total ${money(quantity * cost)}` : 'Confirm quantity and price';
      if (!valid) { form.querySelector('[data-stock-guidance]').hidden = false; preview.textContent = 'Enter a confirmed quantity and price for each repair part.'; return; }
      partsTotal += quantity * cost;
    }
    form.querySelector('[data-stock-guidance]').hidden = !needsSupply;
    preview.innerHTML = `<span>Repair parts <strong>${money(partsTotal)}</strong></span><span>Labor ${custom ? '(technician price)' : '(company rate)'} <strong>${money(labor)}</strong></span><span class="rq-total">Repair quotation <strong>${money(partsTotal + labor)}</strong></span><small>Inspection fees are separate. Show this price to the customer before recording their decision.</small>`;
  }
  async function generateUnitAi(form) {
    if (busy) return;
    if (form._assessment && (!validateNotes(form) || !form.elements.inspectionNotes.reportValidity())) { showInspectionStep(form, 'inspection'); form.elements.inspectionNotes.reportValidity(); return; }
    busy = true;
    const button = form.querySelector('[data-unit-ai]'), panel = form.querySelector('[data-unit-ai-result]');
    button.disabled = true; panel.textContent = 'Updating suggestions... Your inspection notes will stay here.';
    try {
      const { findings, testsPerformed } = inspectionFields(form), diagnosis = form.elements.diagnosis.value.trim();
      const data = await request(`/api/repair-units/booking/${encodeURIComponent(state.id)}/ai-diagnostic`, {key:form.dataset.key,findings,diagnosis,testsPerformed});
      const latest = await request(`/api/repair-units/${state.scope}/${state.id}`);
      const previous = state.units.find(unit => unit.key === form.dataset.key), currentUnit = latest.units.find(unit => unit.key === form.dataset.key);
      if (!currentUnit || previous?.review?.revision !== currentUnit.review?.revision || previous?.review?.state !== currentUnit.review?.state) throw Error('This appliance changed while suggestions were loading. Reopen its latest inspection before continuing.');
      if (!latest.canInspect) throw Error(latest.blockedReason || 'This inspection is no longer editable. Refresh the repair workspace.');
      const current = inspectionFields(form);
      if (current.findings !== findings || form.elements.diagnosis.value.trim() !== diagnosis || current.testsPerformed !== testsPerformed) throw Error('Your findings or diagnosis changed while suggestions were loading. Update again using the latest notes.');
      if (!data.technicianAssistant?.summary) throw Error('Suggestions are unavailable. You can continue with your own diagnosis and quotation.');
      state.version = latest.version;
      renderAssessment(form, {...data.technicianAssistant,quoteSuggestion:data.quoteSuggestion}, 'on_site', form.elements.diagnosisChoice.value === 'custom' && !!diagnosis);
      form.dataset.dirty = 'true';
      panel.textContent = 'Suggestions updated. Choose only a diagnosis confirmed by your checks.';
    } catch (error) { panel.textContent = error.message; }
    finally { busy = false; button.disabled = false; }
  }
  function inspector(unit) {
    if (!state.canInspect || state.closed || state.needsSetup) return '';
    if (state.submitted && ['pending', 'awaiting_customer'].includes(state.reviewStatus)) return `<p class="rq-notice">Inspection and quotation submitted. ${state.scope === 'booking' ? 'Show the price to the customer, then record Repair now, Repair later, or Cancel repair in the repair decision screen.' : 'Staff review and the customer decision are pending.'}</p>`;
    if (['pending','staff_review'].includes(unit.review?.state || 'pending')) {
      const canSubmit = state.units.every(other => other.key === unit.key || (other.review?.state === 'staff_review' && other.inspection?.technicianConfirmed === true));
      return `<form class="ru-inspect rq-inspection" id="ru-form-${esc(unit.key)}" data-key="${esc(unit.key)}" data-diagnosis-source="${esc(unit.diagnosis?.source || 'technician')}">
        <nav class="rq-progress" aria-label="Inspection steps"><button type="button" data-inspection-step="inspection" aria-current="step"><span>1</span>Inspection</button><button type="button" data-inspection-step="quotation"><span>2</span>Quotation</button><button type="button" data-inspection-step="review"><span>3</span>Review</button></nav>
        <section class="rq-section" data-inspection-panel><div class="rq-section-title"><span class="rq-section-symbol">${workspaceIcon('inspection')}</span><div><span class="ru-eyebrow">STEP 1 OF 3</span><h3>What did you find?</h3><p>Record your checks, then choose the cause you confirmed.</p></div><span class="rq-required-note">* Required</span></div>${aiInspector(unit)}<div class="ru-grid rq-inspection-notes">
        <label class="ru-field">Checks & findings *<textarea name="inspectionNotes" required minlength="10" maxlength="${Math.max(2000, inspectionNotes(unit).length)}" placeholder="Example: Checked the filter and airflow. Filter is clogged; airflow is weak. Include readings, or explain why a check could not be performed.">${esc(inspectionNotes(unit))}</textarea><small>Record your checks and results here once.</small></label>
        ${diagnosisChoices()}</div>
        <div class="rq-optional-tools"><details class="rq-evidence"><summary><strong>Inspection photos</strong><span>Optional${unit.inspection?.photos?.length ? ` &middot; ${unit.inspection.photos.length} saved` : ''}</span></summary><div class="rq-evidence-content"><p class="ru-muted">Photos upload when selected. Up to four JPG, PNG or WEBP images, 5 MB each. Visible only to the customer and authorised staff.</p><div data-evidence-gallery>${evidenceGallery(unit)}</div><label class="ru-field">Add inspection photos<input type="file" name="inspectionPhotos" accept="image/jpeg,image/png,image/webp" multiple></label><button type="button" class="ru-btn" data-upload-evidence hidden>Retry photo upload</button><p data-evidence-status role="status" class="ru-muted"></p></div></details></div>
        <div class="ru-actions rq-submit" data-inspection-actions><button class="ru-btn" type="button" data-save-inspection>Save draft</button><button class="ru-btn ru-btn-primary" type="button" data-continue-quote>Next: quotation</button></div></section>
        <section class="rq-section" data-quotation-panel hidden><div class="rq-section-title"><span class="rq-section-symbol">${workspaceIcon('quotation')}</span><div><span class="ru-eyebrow">STEP 2 OF 3</span><h3>What repair is needed?</h3><p>Describe the work, then check the labor and parts price.</p></div></div><label class="ru-field rq-recommendation">Recommended repair *<textarea name="recommendedAction" required minlength="5" maxlength="2000" placeholder="Describe the work needed and any limitations.">${esc(unit.inspection?.recommendedAction)}</textarea></label><div class="ru-grid"><label class="ru-field">Repair complexity<select name="laborCategory">${Object.entries(state.laborFees || {}).map(([key,value]) => `<option value="${key}" ${(unit.quotation?.laborCategory || 'standard') === key ? 'selected' : ''}>${key[0].toUpperCase()+key.slice(1)} · ${money(value)}</option>`).join('')}</select></label></div><details class="rq-labor-options" ${unit.quotation?.laborPricingMode === 'custom' ? 'open' : ''}><summary>Adjust labor price <span class="ru-muted">(optional)</span></summary><div class="ru-grid"><label class="ru-field">Labor pricing<select name="laborPricingMode"><option value="company">Company labor rate</option><option value="custom" ${unit.quotation?.laborPricingMode === 'custom' ? 'selected' : ''}>Set technician labor price</option></select></label><label class="ru-field">Labor amount (PHP)<input name="laborCost" type="number" min="0" max="1000000" step=".01" required value="${Number(unit.quotation?.laborCost ?? state.laborFees?.standard ?? 0)}"></label><label class="ru-field" data-labor-reason hidden>Reason for custom labor price<textarea name="laborPriceReason" minlength="5" maxlength="500" placeholder="Explain the work covered by this labor price.">${esc(unit.quotation?.laborPriceReason)}</textarea></label></div></details>
        ${partsPicker()}<details class="rq-labor-options"><summary>Add a note for the customer <span class="ru-muted">(optional)</span></summary><label class="ru-field">Quotation notes<input name="notes" maxlength="2000" value="${esc(unit.quotation?.notes)}" placeholder="Warranty, repair scope, or details the customer should know."></label></details><div class="rq-quote-total" data-quote-preview aria-live="polite"></div><p class="rq-next-decision">${state.scope === 'booking' ? 'Next: review and send the quotation, then record the customer’s choice for today, a return visit or cancellation.' : 'Next: send for staff review and the customer’s approval.'}</p></section>
        <div class="ru-actions rq-submit" data-quotation-actions hidden><button class="ru-btn" type="button" data-back-inspection>Back</button><button class="ru-btn" type="submit" data-save-draft>Save draft</button><button class="ru-btn ru-btn-primary" type="button" data-review-quote>Review quotation</button></div><section class="rq-section" data-review-panel hidden><div class="rq-section-title"><span class="rq-section-symbol">${workspaceIcon('review')}</span><div><span class="ru-eyebrow">STEP 3 OF 3</span><h3>Review before sending</h3><p>The customer and staff will receive this inspection and quotation.</p></div></div><div data-review-preview></div><label class="rv-check"><input type="checkbox" name="technicianConfirmed" ${unit.inspection?.technicianConfirmed ? 'checked' : ''}><span>I inspected this appliance and confirm the checks, diagnosis and recommended repair are accurate.</span></label></section><div class="ru-actions rq-submit" data-review-actions hidden><button class="ru-btn" type="button" data-back-quote>Edit quotation</button>${!canSubmit ? '<button class="ru-btn ru-btn-primary" type="submit" data-save-draft>Save this appliance</button>' : ''}${canSubmit ? '<button class="ru-btn ru-btn-primary" type="submit" data-submit-inspection>Send quotation</button>' : '<p class="ru-muted">Review and confirm each appliance before sending the full quotation.</p>'}</div></form>`;
    }
    if (unit.review?.state === 'approved' && state.scope === 'booking' && state.canComplete) return `<form class="ru-complete rq-section" data-key="${esc(unit.key)}"><h3>Test and verify the repair</h3><p class="ru-muted">Record the actual work and test results. An unresolved appliance remains open for follow-up.</p><div class="ru-grid"><label class="ru-field">Work performed *<textarea name="notes" required minlength="10" maxlength="1000">${esc(unit.repairVerification?.workPerformed)}</textarea></label><label class="ru-field">Final test results *<textarea name="testResults" required minlength="10" maxlength="2000" placeholder="Describe how operation was tested and the actual results.">${esc(unit.repairVerification?.testResults)}</textarea></label><label class="ru-field">Test outcome *<select name="outcome"><option value="">Choose an outcome</option><option value="resolved">Issue resolved; tests passed</option><option value="follow_up_required">Unresolved; follow-up needed</option></select></label><label class="ru-field" data-follow-up hidden>Follow-up reason and remaining work *<textarea name="followUpReason" minlength="10" maxlength="500">${esc(unit.repairVerification?.followUpReason)}</textarea></label></div><label class="rv-check" data-customer-confirmation><input type="checkbox" name="customerConfirmed"><span>I explained the work and test results to the customer, and they confirmed the appliance is working.</span></label><button class="ru-btn ru-btn-primary" type="submit">Save test outcome</button></form>`;
    return '';
  }
  function evidenceGallery(unit) {
    return (unit.inspection?.photos || []).filter(url => /^\/api\/repair-units\/(booking|project)\/[a-f\d]{24}\/evidence\/[a-f\d]{24}$/i.test(url)).map((url, index) => `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Inspection evidence ${index + 1}" loading="lazy"><span>Photo ${index + 1}</span></a>`).join('');
  }
  function inspectionPayload(form) {
    return { key: form.dataset.key, ...inspectionFields(form),
      diagnosis: form.elements.diagnosis.value, recommendedAction: form.elements.recommendedAction.value, technicianConfirmed: form.elements.technicianConfirmed.checked };
  }
  function partsPayload(form) {
    return [...form.querySelectorAll('.ru-parts')].map(row => ({toolId:row.querySelector('.ru-part-id').value || null,name:row.querySelector('.ru-part-name').value,quantity:Number(row.querySelector('input[type=number]').value),cost:row.querySelector('.ru-part-cost').value === '' ? null : Number(row.querySelector('.ru-part-cost').value)}));
  }
  function rememberForms(exceptKey) {
    dialog?.querySelectorAll('.ru-inspect').forEach(form => {
      if(form.dataset.key===exceptKey || form.dataset.dirty!=='true')return;
      const unit=state.units.find(unit=>unit.key===form.dataset.key);
      const fields={}; [...form.elements].forEach(input=>{if(input.name&&input.type!=='file')fields[input.name]=input.type==='checkbox'?input.checked:input.value;});
      drafts.set(form.dataset.key,{revision:unit.review?.revision,fields,parts:partsPayload(form),files:[...form.elements.inspectionPhotos.files],assessment:form._assessment,assessmentOrigin:form._assessmentOrigin,source:form.dataset.diagnosisSource,step:form.dataset.step});
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
    form.querySelector('[data-review-preview]').innerHTML=`<section class="rq-review-findings"><h4>Inspection summary</h4><dl><div><dt>Diagnosis</dt><dd>${esc(form.elements.diagnosis.value)}</dd></div><div><dt>Recommended repair</dt><dd>${esc(form.elements.recommendedAction.value)}</dd></div></dl><details><summary>View checks & findings</summary><p class="ru-evidence">${esc(form.elements.inspectionNotes.value)}</p></details></section><section class="rq-review-prices"><h4>Repair quotation</h4>${parts.map(part=>`<div><span>${esc(part.name)}<small>${part.quantity} × ${money(part.cost)}</small></span><strong>${money(part.cost*part.quantity)}</strong></div>`).join('')||'<p class="ru-muted">No replacement parts</p>'}<div><span>Labor</span><strong>${money(labor)}</strong></div><div class="rq-review-total"><span>Quoted repair total</span><strong>${money(total)}</strong></div><p class="ru-muted">Inspection and travel charges are recorded separately.</p></section>`;
  }
  function inspectionValid(form) {
    validateNotes(form);
    const invalid = ['inspectionNotes','diagnosisChoice','diagnosis'].find(name => !form.elements[name].checkValidity());
    if (!invalid) return true;
    showInspectionStep(form, 'inspection');
    if (invalid === 'diagnosis') { form.elements.diagnosisChoice.value = 'custom'; setDiagnosisMode(form, 'custom'); }
    form.elements[invalid].reportValidity();
    return false;
  }
  function showInspectionStep(form, stage) {
    if(stage!=='inspection'&&!inspectionValid(form))return;
    if(stage==='review'){
      showInspectionStep(form,'quotation');
      if(!quotationValid(form))return;
      reviewPreview(form);
    }
    form.dataset.step = stage;
    form.elements.technicianConfirmed.required = stage === 'review';
    form.querySelector('[data-inspection-panel]').hidden = stage !== 'inspection';
    form.querySelector('[data-quotation-panel]').hidden = stage !== 'quotation';
    form.querySelector('[data-review-panel]').hidden = stage !== 'review';
    form.querySelectorAll('[data-inspection-step]').forEach(button => { button.dataset.completed = String(['inspection','quotation','review'].indexOf(button.dataset.inspectionStep) < ['inspection','quotation','review'].indexOf(stage)); if (button.dataset.inspectionStep === stage) button.setAttribute('aria-current','step'); else button.removeAttribute('aria-current'); });
    placeActions();
    form.querySelector(stage === 'quotation' ? '[data-quotation-panel]' : stage==='review'?'[data-review-panel]':'[data-inspection-panel]').scrollIntoView({block:'start'});
  }
  function quotationValid(form) {
    const unavailable = partsPayload(form).find(part => part.toolId && !(state.parts || []).some(item => String(item._id) === part.toolId));
    if (unavailable) { showError(`${unavailable.name || 'A saved part'} is no longer available in the parts catalog. Remove it and select a replacement, or add the correct supplier part.`); return false; }
    const invalid = [...form.querySelectorAll('[data-quotation-panel] input, [data-quotation-panel] select, [data-quotation-panel] textarea')].find(input => !input.checkValidity());
    if (!invalid) return true;
    invalid.closest('details')?.setAttribute('open', '');
    invalid.reportValidity();
    return false;
  }
  function quotationDetails(unit) {
    if (!unit.quotation) return '';
    const quote = unit.quotation;
    return `<section class="rq-quote-total"><h4>Repair quotation</h4>${(quote.parts || []).map(part => `<span>${esc(part.name)} · ${part.quantity} × ${money(part.cost)}<strong>${money(Number(part.quantity) * Number(part.cost))}</strong></span>`).join('') || '<span>No replacement parts</span>'}<span>Labor ${quote.laborPricingMode === 'custom' ? '(technician price)' : '(company rate)'}<strong>${money(quote.laborCost)}</strong></span>${quote.laborPricingMode === 'custom' ? `<small>Price reason: ${esc(quote.laborPriceReason)}</small>` : ''}<span class="rq-total">Repair total<strong>${money(quote.totalCost)}</strong></span>${quote.notes ? `<small>${esc(quote.notes)}</small>` : ''}${unit.review?.decisionMethod === 'on_site' ? `<small class="rq-notice">Customer decision given verbally on site and recorded by the assigned technician. ${esc(unit.review.decisionNotes || '')}</small>` : ''}</section>`;
  }
  function inspectionRecord(unit) {
    const inspection = unit.inspection || {}, verification = unit.repairVerification;
    return `${inspection.testsPerformed && inspection.testsPerformed !== inspection.findings ? `<p class="ru-evidence"><strong>Inspection checks and test results:</strong> ${esc(inspection.testsPerformed)}</p>` : ''}${inspection.recommendedAction ? `<p class="ru-evidence"><strong>Recommended repair:</strong> ${esc(inspection.recommendedAction)}</p>` : ''}${inspection.photos?.length ? `<div class="rq-evidence-gallery">${evidenceGallery(unit)}</div>` : ''}${verification?.outcome ? `<section class="rq-notice"><strong>${verification.outcome === 'resolved' ? 'Issue resolved · customer confirmation recorded' : 'Follow-up required · appliance remains open'}</strong><p class="ru-evidence">Work performed: ${esc(verification.workPerformed)}\nTest results: ${esc(verification.testResults)}${verification.followUpReason ? `\nRemaining work: ${esc(verification.followUpReason)}` : ''}</p></section>` : ''}`;
  }
  function unitCard(unit) {
    const editable = state.canInspect && !state.closed && !state.needsSetup && ['pending','staff_review'].includes(unit.review?.state || 'pending') && (!state.submitted || state.reviewStatus === 'rejected');
    const status = unit.repairVerification?.outcome === 'follow_up_required' ? 'Follow-up required' : unit.review?.state === 'staff_review' ? state.submitted ? 'Quotation submitted' : 'Draft saved' : labels[unit.review?.state || 'pending'];
    return `<details class="ru-unit" ${state.units.length === 1 ? 'open' : ''}><summary><span>${state.role === 'customer' && unit.review?.state === 'customer_review' ? `<input class="ru-choose" type="checkbox" data-key="${esc(unit.key)}" aria-label="Select ${esc(unit.label)}">` : ''} <strong>${esc(unit.key)} · ${esc(unit.label)}</strong><br><small class="ru-muted">${esc([unit.brand,unit.model].filter(Boolean).join(' · '))}</small></span><span class="ru-status">${esc(status)}</span>${unit.quotation && !editable ? `<span class="ru-price">${money(unit.quotation.totalCost)}</span>` : ''}</summary><div class="ru-unit-content"><p class="ru-evidence ru-reported-problem"><strong>Reported problem:</strong> ${esc(unit.problemDescription || 'Not recorded')}</p>${!editable ? `${unit.inspection?.findings ? `<p class="ru-evidence"><strong>${unit.inspection.findings === unit.inspection.testsPerformed ? 'Checks &amp; findings' : 'Findings'}:</strong> ${esc(unit.inspection.findings)}<br><strong>Diagnosis:</strong> ${esc(unit.diagnosis?.summary)}</p>` : ''}${inspectionRecord(unit)}${quotationDetails(unit)}${!unit.repairVerification?.outcome && unit.completionNotes ? `<p class="ru-evidence"><strong>Repairs and tests:</strong> ${esc(unit.completionNotes)}</p>` : ''}` : ''}${inspector(unit)}</div></details>`;
  }
  function unitNavigation() {
    return `<aside class="ru-appliances"><span class="ru-eyebrow">${state.units.length===1?'APPLIANCE':'SELECT AN APPLIANCE'}</span>${state.units.map(unit=>`<button type="button" data-unit-select="${esc(unit.key)}" aria-pressed="${unit.key===activeKey}" data-review-state="${esc(unit.review?.state || 'pending')}"><span class="ru-appliance-icon">${workspaceIcon('appliance')}</span><span><strong>${esc(unit.label)}</strong><small>${esc([unit.brand,unit.model].filter(Boolean).join(' · ')||unit.key)}</small><em>${esc(unit.review?.state==='staff_review'?state.submitted?'Quotation sent':'Draft saved':labels[unit.review?.state||'pending'])}</em></span></button>`).join('')}</aside>`;
  }
  function render() {
    const reviewed = state.units.filter(unit => unit.review?.state === 'customer_review');
    const allInspected = state.units.length && state.units.every(unit => unit.review?.state === 'staff_review');
    const allConfirmed = allInspected && state.units.every(unit => unit.inspection?.technicianConfirmed === true);
    const workspace = state.role==='technician' && state.canInspect;
    activeKey = state.units.some(unit=>unit.key===activeKey) ? activeKey : state.units[0]?.key;
    dialog.classList.toggle('ru-workspace',workspace);
    dialog.classList.toggle('ru-readonly',!workspace);
    dialog.innerHTML = `<header class="ru-header"><div class="ru-heading-group"><span class="ru-heading-icon">${workspaceIcon('inspection')}</span><div><span class="ru-eyebrow">REPAIR VISIT${state.reference ? ' &middot; '+esc(state.reference) : ''}</span><h2>Inspection & quotation</h2><p>${state.submitted?'Review the report and the customer&#39;s next step.':'Document the inspection, price the repair and review before sending.'}</p></div></div><button class="ru-close" aria-label="Close appliance repairs">&times;</button></header><div class="ru-body"><div class="ru-error" role="alert" tabindex="-1" hidden></div><div class="ru-toolbar">${!state.closed && state.canInspect && allConfirmed && (!state.submitted || state.reviewStatus === 'rejected') ? '<button class="ru-btn ru-btn-primary" data-submit>Submit inspection and quotation</button>' : ''}${!state.closed && state.submitted && allInspected && ['admin','secretary'].includes(state.role) && state.reviewStatus === 'pending' ? '<button class="ru-btn ru-btn-primary" data-review="approve">Send prices to customer</button><button class="ru-btn" data-review="reject">Return for changes</button><input id="ruReviewNotes" class="form-control" maxlength="1000" placeholder="Review notes / changes needed">' : ''}${!state.closed && state.role === 'customer' && reviewed.length ? '<button class="ru-btn" data-select-all>Select all waiting quotes</button><button class="ru-btn ru-btn-primary" data-decide="true">Approve selected repairs</button><button class="ru-btn" data-decide="false">Decline selected repairs</button>' : ''}</div><div class="ru-workspace-grid">${workspace?unitNavigation():''}<main class="ru-workspace-main">${state.units.map(unitCard).join('')}</main></div></div><footer class="ru-footer ru-work-footer"><p>${state.payment?.paidInFull?'Payment is recorded in full. No collection is needed.':workspace?'Save your findings before leaving this workspace.':'Inspection fees are separate from the repair quotation.'}</p><div data-work-actions></div></footer>`;

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
      const unit = state.units.find(unit => unit.key === form.dataset.key);
      form.elements.diagnosis.value = unit.diagnosis?.summary || '';
      form._originalInspection = { notes:inspectionNotes(unit), findings:unit.inspection?.findings || '', testsPerformed:unit.inspection?.testsPerformed || '' };
      form.noValidate = true;
      form.dataset.step = 'inspection';
      form._actions={inspection:form.querySelector('[data-inspection-actions]'),quotation:form.querySelector('[data-quotation-actions]'),review:form.querySelector('[data-review-actions]')};
      form.querySelectorAll('[data-inspection-step]').forEach(button => button.onclick = () => showInspectionStep(form, button.dataset.inspectionStep));
      form.querySelector('[data-continue-quote]').onclick = () => showInspectionStep(form, 'quotation');
      form.querySelector('[data-back-inspection]').onclick = () => showInspectionStep(form, 'inspection');
      form.querySelector('[data-save-inspection]').onclick = () => {
        validateNotes(form);
        if (form.elements.inspectionPhotos.files.length) return showError('Retry the photo upload or clear the file selection before saving this draft. Your notes are still here.');
        if (form.elements.inspectionNotes.reportValidity()) save('inspection-draft', inspectionPayload(form));
      };
      form.querySelector('[data-upload-evidence]').onclick = () => uploadEvidence(form);
      form.elements.inspectionPhotos.onchange = () => {
        if (form.elements.inspectionPhotos.files.length) uploadEvidence(form);
        else { form.querySelector('[data-upload-evidence]').hidden = true; form.querySelector('[data-evidence-status]').textContent = 'No new photos selected.'; dialog.querySelector('.ru-error').hidden = true; }
      };
      form.querySelector('.ru-parts-list').innerHTML = (unit.quotation?.parts || []).map(partRow).join('');
      bindPartPicker(form);
      bindParts(form);
      form.querySelector('[data-unit-ai]')?.addEventListener('click',()=>generateUnitAi(form));
      form.querySelector('[data-review-quote]').onclick=()=>showInspectionStep(form,'review');
      form.querySelector('[data-back-quote]').onclick=()=>showInspectionStep(form,'quotation');
      form.addEventListener('input', event => {
        if (event.target.matches('[data-part-search], [data-part-filter]')) return;
        form.dataset.dirty='true';
        if (event.target.name !== 'technicianConfirmed') form.elements.technicianConfirmed.checked = false;
        if (event.target.name === 'inspectionNotes') validateNotes(form);
        if(form.querySelector('[data-quote-preview]').textContent)quotePreview(form);
      });
      form.elements.diagnosis.addEventListener('input', () => { form.dataset.diagnosisSource = 'technician'; });
      form.elements.laborPricingMode.addEventListener('change', () => quotePreview(form));
      form.elements.laborCategory.addEventListener('change', () => quotePreview(form));
      const local=drafts.get(form.dataset.key);
      if(local && local.revision===unit.review?.revision){
        for(const [name,value] of Object.entries(local.fields)){const input=form.elements[name];if(!input)continue;if(input.type==='checkbox')input.checked=value;else input.value=value;}
        form.querySelector('.ru-parts-list').innerHTML=local.parts.map(partRow).join('');bindParts(form);form.dataset.diagnosisSource=local.source;form.dataset.dirty='true';
        if (local.files?.length) {
          const transfer = new DataTransfer(); local.files.forEach(file => transfer.items.add(file)); form.elements.inspectionPhotos.files = transfer.files;
          form.querySelector('[data-upload-evidence]').hidden = false;
          form.querySelector('[data-evidence-status]').textContent = 'These photos have not uploaded yet. Retry or clear the selection to continue.';
        }
      }else if(local)drafts.delete(form.dataset.key);
      const validLocal = local && local.revision === unit.review?.revision;
      renderAssessment(form, validLocal && local.assessment || unit.preVisitAssessment || null, validLocal && local.assessmentOrigin || 'pre_visit', validLocal && local.fields.diagnosisChoice === 'custom');
      quotePreview(form);
      if(local && local.revision===unit.review?.revision)showInspectionStep(form,local.step||'inspection');
      form.onsubmit = event => {
        event.preventDefault();
        if (busy) return;
        const reviewing = form.dataset.step === 'review';
        if(event.submitter?.hasAttribute('data-submit-inspection') && form.dataset.step!=='review')return showInspectionStep(form,'review');
        if(form.dataset.step==='inspection')return showInspectionStep(form,'quotation');
        if (!inspectionValid(form)) return showInspectionStep(form, 'inspection');
        if (form.dataset.step === 'review' && !form.elements.technicianConfirmed.reportValidity()) return;
        showInspectionStep(form, 'quotation');
        if (!quotationValid(form)) return;
        if (reviewing) showInspectionStep(form, 'review');
        if (form.elements.inspectionPhotos.files.length) { showInspectionStep(form, 'inspection'); form.querySelector('.rq-evidence').open = true; return showError('Retry the photo upload before continuing, or clear the file selection.'); }
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
    if (!files.length || files.length + (unit.inspection?.photos?.length || 0) > 4 || files.some(file => file.size > 5 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(file.type))) { form.elements.inspectionPhotos.value = ''; return showError('Choose up to four JPG, PNG or WEBP photos per appliance, no more than 5 MB each.'); }
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
      dialog.querySelector('.ru-error').hidden = true;
      form.querySelector('[data-upload-evidence]').hidden = true;
      form.querySelector('.rq-evidence summary span').textContent = `Optional · ${data.photos.length} saved`;
    } catch (error) { form.querySelector('[data-upload-evidence]').hidden = false; form.querySelector('[data-evidence-status]').textContent = 'Photo upload failed. Your notes are still here. Retry or clear the file selection to continue.'; showError(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'The upload took too long. Reopen the inspection to check saved photos before retrying.' : error.message); }
    finally { controls.forEach((control,index) => { control.disabled = disabled[index]; }); busy = false; }
  }
  function bindParts(form) {
    form.querySelectorAll('[data-remove-part]').forEach(button => button.onclick = () => {
      form.dataset.dirty = 'true'; form.elements.technicianConfirmed.checked = false;
      const row = button.closest('.ru-parts'), next = row.nextElementSibling || row.previousElementSibling;
      row.remove(); quotePreview(form); renderPartPicker(form);
      (next?.querySelector('[data-remove-part]') || form.querySelector('[data-add-part]')).focus();
    });
    renderPartPicker(form);
  }
  function showError(message) { const box = dialog.querySelector('.ru-error'); box.textContent = message; box.hidden = false; box.focus(); box.scrollIntoView({block:'nearest'}); }
  async function save(action, data) {
    if (busy) return;
    const currentForm = data.key && [...dialog.querySelectorAll('.ru-inspect')].find(form => form.dataset.key === data.key), step = currentForm?.dataset.step;
    rememberForms(action === 'inspection-draft' ? undefined : data.key);
    busy = true;
    const openKeys = [...dialog.querySelectorAll('details[open]')].map(details => details.querySelector('[data-key]')?.dataset.key).filter(Boolean);
    const controls = [...dialog.querySelectorAll('button,input,select,textarea')]; controls.forEach(control => { control.dataset.ruDisabled = String(control.disabled); control.disabled = true; });
    try {
      const updated = await request(`/api/repair-units/${state.scope}/${state.id}/${action}`, { ...data, version:state.version });
      if (action === 'inspection-draft' && drafts.has(data.key)) drafts.get(data.key).revision = updated.units.find(unit => unit.key === data.key)?.review?.revision;
      else if(data.key)drafts.delete(data.key);else if(['submit','inspect-and-submit'].includes(action))drafts.clear();
      state = { ...state, ...updated }; render();
      const savedForm = data.key && [...dialog.querySelectorAll('.ru-inspect')].find(form => form.dataset.key === data.key);
      if (savedForm && step) showInspectionStep(savedForm, step);
      if (action === 'inspect' && step === 'review' && data.technicianConfirmed) {
        const next = state.units.find(unit => unit.key !== data.key && (unit.review?.state !== 'staff_review' || !unit.inspection?.technicianConfirmed));
        if (next) {
          activateUnit(next.key);
          const nextForm = [...dialog.querySelectorAll('.ru-inspect')].find(form => form.dataset.key === next.key);
          if (nextForm) showInspectionStep(nextForm, next.review?.state === 'staff_review' ? 'review' : 'inspection');
        }
      }
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

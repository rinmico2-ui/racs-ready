(function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const money = value => new Intl.NumberFormat('en-PH', { style:'currency', currency:'PHP' }).format(Number(value || 0));
  const labels = { pending:'Needs inspection', staff_review:'Staff review', customer_review:'Your decision needed', approved:'Repair approved', declined:'Repair declined', completed:'Repaired' };
  let dialog, state, busy = false;
  async function request(path, body) {
    const response = await fetch(path, { credentials:'same-origin', ...(body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || 'Unable to update appliance repairs.');
    return data;
  }
  function partRow(part = {}) {
    return `<div class="ru-parts"><select aria-label="Repair part"><option value="">Other part (enter below)</option>${(state.parts || []).map(p => `<option value="${esc(p._id)}" ${String(p._id) === String(part.toolId) ? 'selected' : ''}>${esc(p.itemName)} · ${money(p.sellingPrice ?? p.costPrice)}</option>`).join('')}</select><input type="number" min="1" max="999" step="1" value="${Number(part.quantity || 1)}" aria-label="Part quantity"><input class="ru-part-cost" type="number" min="0" step=".01" value="${Number(part.cost || 0)}" aria-label="Other part price"><button type="button" class="ru-btn" data-remove-part aria-label="Remove part">×</button><input class="ru-part-name" maxlength="200" placeholder="Other part name" value="${esc(part.name)}" aria-label="Other part name"></div>`;
  }
  function inspector(unit) {
    if (!state.canInspect || state.closed || state.needsSetup) return '';
    if (['pending','staff_review'].includes(unit.review?.state || 'pending')) return `<form class="ru-inspect" data-key="${esc(unit.key)}"><div class="ru-grid"><label class="ru-field">Inspection findings<textarea name="findings" required minlength="10" maxlength="2000">${esc(unit.inspection?.findings)}</textarea></label><label class="ru-field">Diagnosis<textarea name="diagnosis" required minlength="5" maxlength="2000">${esc(unit.diagnosis?.summary)}</textarea></label><label class="ru-field">Labor category<select name="laborCategory">${Object.entries(state.laborFees || {}).map(([key,value]) => `<option value="${key}" ${unit.quotation?.laborCategory === key ? 'selected' : ''}>${key[0].toUpperCase()+key.slice(1)} · ${money(value)}</option>`).join('')}</select></label><label class="ru-field">Quote notes<input name="notes" maxlength="2000" value="${esc(unit.quotation?.notes)}"></label></div><div class="ru-parts-list">${(unit.quotation?.parts || []).map(partRow).join('')}</div><div class="ru-actions"><button class="ru-btn" type="button" data-add-part>Add part</button><button class="ru-btn ru-btn-primary" type="submit">Save inspection and price</button></div></form>`;
    if (unit.review?.state === 'approved' && state.scope === 'booking') return `<form class="ru-complete" data-key="${esc(unit.key)}"><label class="ru-field">Repair and tests performed<textarea name="notes" required minlength="10" maxlength="1000"></textarea></label><button class="ru-btn ru-btn-primary" type="submit">Mark this appliance repaired</button></form>`;
    return '';
  }
  function render() {
    const reviewed = state.units.filter(unit => unit.review?.state === 'customer_review');
    const allInspected = state.units.length && state.units.every(unit => unit.review?.state === 'staff_review');
    dialog.innerHTML = `<header class="ru-header"><div><h2>Appliance repairs</h2><p>Each appliance has its own findings, price, and decision.</p></div><button class="ru-close" aria-label="Close appliance repairs">×</button></header><div class="ru-body"><div class="ru-error" role="alert" hidden></div><div class="ru-toolbar"><span>${state.units.length} appliance${state.units.length === 1 ? '' : 's'}</span>${!state.closed && state.canInspect && allInspected ? '<button class="ru-btn ru-btn-primary" data-submit>Send inspections for staff review</button>' : ''}${!state.closed && state.submitted && allInspected && ['admin','secretary'].includes(state.role) && state.reviewStatus === 'pending' ? '<button class="ru-btn ru-btn-primary" data-review="approve">Send prices to customer</button><button class="ru-btn" data-review="reject">Return for changes</button><input id="ruReviewNotes" class="form-control" maxlength="1000" placeholder="Review notes / changes needed">' : ''}${!state.closed && state.role === 'customer' && reviewed.length ? '<button class="ru-btn" data-select-all>Select all waiting quotes</button><button class="ru-btn ru-btn-primary" data-decide="true">Approve selected repairs</button><button class="ru-btn" data-decide="false">Decline selected repairs</button>' : ''}</div>${state.units.map(unit => `<details class="ru-unit" ${state.units.length === 1 ? 'open' : ''}><summary><span>${state.role === 'customer' && unit.review?.state === 'customer_review' ? `<input class="ru-choose" type="checkbox" data-key="${esc(unit.key)}" aria-label="Select ${esc(unit.label)}">` : ''} <strong>${esc(unit.key)} · ${esc(unit.label)}</strong><br><small class="ru-muted">${esc([unit.brand,unit.model].filter(Boolean).join(' · '))}</small></span><span class="ru-status">${esc(labels[unit.review?.state || 'pending'])}</span>${unit.quotation ? `<span class="ru-price">${money(unit.quotation.totalCost)}</span>` : ''}</summary><div class="ru-unit-content"><p class="ru-evidence"><strong>Reported problem:</strong> ${esc(unit.problemDescription || 'Not recorded')}</p>${unit.inspection?.findings ? `<p class="ru-evidence"><strong>Findings:</strong> ${esc(unit.inspection.findings)}<br><strong>Diagnosis:</strong> ${esc(unit.diagnosis?.summary)}</p>` : ''}${unit.quotation ? `<p class="ru-evidence"><strong>Parts:</strong> ${(unit.quotation.parts || []).map(part => `${esc(part.name)} × ${part.quantity} (${money(part.cost * part.quantity)})`).join(', ') || 'None'}<br><strong>Labor:</strong> ${money(unit.quotation.laborCost)}<br><strong>Total:</strong> ${money(unit.quotation.totalCost)}</p>` : ''}${unit.completionNotes ? `<p class="ru-evidence"><strong>Repairs and tests:</strong> ${esc(unit.completionNotes)}</p>` : ''}${inspector(unit)}</div></details>`).join('')}</div><footer class="ru-footer">Inspection fees remain separate. Repair work starts after staff review and your approval.</footer>`;
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
      form.onsubmit = event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const parts = [...form.querySelectorAll('.ru-parts')].map(row => ({ toolId:row.querySelector('select').value || null, name:row.querySelector('.ru-part-name').value, quantity:Number(row.querySelector('input[type=number]').value), cost:Number(row.querySelector('.ru-part-cost').value) }));
        save('inspect', { key:form.dataset.key, findings:form.elements.findings.value, diagnosis:form.elements.diagnosis.value, laborCategory:form.elements.laborCategory.value, notes:form.elements.notes.value, parts });
      };
    });
    dialog.querySelectorAll('.ru-complete').forEach(form => form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) save('complete', { key:form.dataset.key, notes:form.elements.notes.value }); });
  }
  function bindParts(form) {
    form.querySelectorAll('[data-remove-part]').forEach(button => button.onclick = () => button.closest('.ru-parts').remove());
    form.querySelectorAll('.ru-parts select').forEach(select => {
      const update = () => {
        const row = select.closest('.ru-parts'), part = state.parts.find(part => String(part._id) === select.value);
        row.querySelector('.ru-part-cost').readOnly = !!part; row.querySelector('.ru-part-name').readOnly = !!part;
        if (part) { row.querySelector('.ru-part-cost').value = part.sellingPrice ?? part.costPrice ?? 0; row.querySelector('.ru-part-name').value = part.itemName; }
      };
      select.onchange = update; update();
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

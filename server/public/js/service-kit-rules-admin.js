/* global document, window, fetch */
(() => {
  'use strict';
  const root = document.getElementById('kitRules');
  if (!root) return;
  const $ = id => document.getElementById(id);
  const state = { services: [], catalog: [], selected: null, draft: null, baseline: '', phase: 'items', busy: false, dirty: false };
  const key = service => `${service.serviceModel}:${service.id}`;
  const phases = service => service.serviceModel !== 'CoreService' ? ['inspectionItems', 'repairItems'] : ['items'];
  const kind = service => service.serviceModel === 'CoreService' ? 'Core service' : service.serviceModel === 'ServiceCategory' ? 'Customer repair category' : 'Repair catalog service';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function message(text, kind = 'error') { $('kitMessage').hidden = !text; $('kitMessage').textContent = text; $('kitMessage').dataset.kind = kind; }
  function draftFor(rule) {
    return { mode: rule.mode, revision: rule.revision, items: rule.items.map(item => ({ ...item })),
      inspectionItems: rule.inspectionItems.map(item => ({ ...item })), repairItems: rule.repairItems.map(item => ({ ...item })),
      emptyAllowed: { items: rule.mode === 'custom' && !rule.items.length, inspectionItems: rule.mode === 'custom' && !rule.inspectionItems.length, repairItems: rule.mode === 'custom' && !rule.repairItems.length } };
  }
  function changed() {
    state.dirty = JSON.stringify(state.draft) !== state.baseline;
    $('draftBadge').hidden = !state.dirty;
    $('saveRule').disabled = state.busy || !state.dirty;
  }
  function leaveDraft() { return !state.dirty || window.confirm('Discard the unsaved changes for this service?'); }
  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error('Unable to load service rules. Check your connection or sign in again.'); }
    if (!response.ok || data.success !== true) throw new Error(data.error || data.message || 'Unable to save the kit rule.');
    return data;
  }
  function directory() {
    const query = $('serviceSearch').value.trim().toLowerCase(), filter = $('serviceFilter').value;
    const visible = state.services.filter(service => (filter === 'all' || (filter === 'RepairService' ? service.serviceModel !== 'CoreService' : service.serviceModel === filter)) && service.name.toLowerCase().includes(query));
    $('serviceList').innerHTML = visible.map(service => `<button type="button" class="kr-service" data-service="${esc(key(service))}" aria-pressed="${state.selected && key(state.selected) === key(service) ? 'true' : 'false'}"><strong>${esc(service.name)}</strong><small>${esc(kind(service))} · ${service.rule.mode === 'custom' ? 'Own kit list' : 'Current defaults'}${service.active ? '' : ' · Inactive'}</small></button>`).join('') || '<p class="kr-muted">No services match your search.</p>';
    $('kitSummary').innerHTML = `<span><strong>${state.services.length}</strong>Services</span><span><strong>${state.services.filter(service => service.rule.mode === 'custom').length}</strong>Own kit lists</span><span><strong>${state.services.filter(service => service.rule.mode !== 'custom').length}</strong>Using defaults</span>`;
  }
  function select(service) {
    if (state.busy || (state.selected && key(state.selected) === key(service)) || !leaveDraft()) return;
    state.selected = service; state.draft = draftFor(service.rule); state.baseline = JSON.stringify(state.draft); state.phase = phases(service)[0];
    $('itemSearch').value = ''; message(''); render(); directory();
  }
  function catalog() {
    const query = $('itemSearch').value.trim().toLowerCase();
    const used = new Set(state.draft[state.phase].map(item => String(item.toolId)));
    const available = state.catalog.filter(item => !used.has(item.id) && `${item.name} ${item.code}`.toLowerCase().includes(query));
    $('catalogResults').innerHTML = available.slice(0, 25).map(item => `<div class="kr-catalog-row"><div><strong>${esc(item.name)}</strong><small>${esc(item.category)} · ${esc(item.unit)} · ${item.available} available${item.code ? ` · ${esc(item.code)}` : ` · ID ${esc(item.id.slice(-6))}`}</small></div><button type="button" class="kr-button kr-secondary" data-add="${esc(item.id)}"${state.busy ? ' disabled' : ''} aria-label="Add ${esc(item.name)}">Add</button></div>`).join('') || '<p class="kr-muted">No other items match. Add or update stock in Inventory first.</p>';
    if (available.length > 25) $('catalogResults').insertAdjacentHTML('beforeend', '<p class="kr-muted">Showing 25 items. Type a name or code to narrow the list.</p>');
  }
  function render() {
    const service = state.selected, draft = state.draft;
    $('editorEmpty').hidden = !!service; $('kitRuleForm').hidden = !service;
    if (!service) return;
    $('serviceKind').textContent = `${kind(service)}${service.category ? ` · ${service.category}` : ''}`;
    $('serviceName').textContent = service.name;
    $('ruleUpdated').textContent = service.rule.updatedAt ? `Last saved ${new Date(service.rule.updatedAt).toLocaleString()} · Version ${service.rule.revision}` : 'No custom rule saved yet.';
    $('ruleMode').value = draft.mode; $('ruleMode').disabled = state.busy;
    $('defaultInfo').hidden = draft.mode === 'custom'; $('customEditor').hidden = draft.mode !== 'custom';
    $('phaseTabs').hidden = service.serviceModel === 'CoreService';
    $('phaseTabs').innerHTML = phases(service).filter(phase => phase !== 'items').map(phase => `<button type="button" role="tab" class="kr-tab" data-phase="${phase}" aria-selected="${state.phase === phase}"${state.busy ? ' disabled' : ''}>${phase === 'inspectionItems' ? 'Inspection visit' : 'Repair visit'}</button>`).join('');
    const defaults = service.defaults?.[state.phase];
    $('defaultCount').textContent = Array.isArray(defaults) ? `(${defaults.length} items)` : '';
    $('defaultHelp').textContent = `Default quantities for ${state.phase === 'inspectionItems' ? 'an inspection' : state.phase === 'repairItems' ? 'a repair visit' : 'a job'} with one aircon or unit. Job details and booked quantities can change the final kit.${draft.mode === 'custom' ? ' Your own kit list below is used instead.' : ''}`;
    $('defaultItems').innerHTML = Array.isArray(defaults) ? defaults.map(item => `<div class="kr-default-item"><div><strong>${esc(item.name)}</strong><small>${esc(item.category === 'equipment' ? 'Equipment' : 'Consumable')}${item.code ? ` · ${esc(item.code)}` : ''}</small></div><div class="kr-default-quantity">${esc(item.quantity)} ${esc(item.unit || 'pcs')}</div><span class="kr-default-stock${item.catalogMissing || Number(item.available) < Number(item.quantity) ? ' kr-default-shortage' : ''}">${item.catalogMissing ? 'Missing from inventory' : `${esc(item.available)} available`}</span></div>`).join('') || '<p class="kr-muted">No default items for this visit.</p>' : '<p class="kr-muted">The default preview is unavailable. Reload the service rules to try again.</p>';
    $('phaseHeading').textContent = state.phase === 'items' ? 'Required kit items' : state.phase === 'inspectionItems' ? 'Inspection kit' : 'Repair kit';
    $('phaseHelp').textContent = state.phase === 'repairItems' ? 'Used for the repair visit after the customer accepts the quotation.' : 'Choose the exact items the technician should prepare for this visit.';
    const rows = draft[state.phase];
    $('kitItems').innerHTML = rows.map((item, index) => {
      const tool = state.catalog.find(tool => tool.id === String(item.toolId));
      return `<div class="kr-item"><div><strong>${esc(tool?.name || item.name)}</strong><small>${esc(item.category)} · ${esc(tool?.unit || item.unit)}${tool ? '' : ' · Unavailable in catalog; remove or replace before saving'}</small></div><div><label for="qty-${index}">Quantity</label><input class="kr-input" id="qty-${index}" data-quantity="${index}" type="number" min="1" max="10000" step="${item.category === 'equipment' ? '1' : 'any'}" value="${esc(item.quantity)}" required${state.busy ? ' disabled' : ''}></div><div><label for="basis-${index}">Needed</label><select class="kr-input" id="basis-${index}" data-basis="${index}"${state.busy ? ' disabled' : ''}><option value="per_visit"${item.quantityBasis === 'per_visit' ? ' selected' : ''}>Per visit</option><option value="per_unit"${item.quantityBasis === 'per_unit' ? ' selected' : ''}>Per aircon / unit</option></select></div><button type="button" class="kr-button kr-remove" data-remove="${index}" aria-label="Remove ${esc(item.name)}"${state.busy ? ' disabled' : ''}>Remove</button></div>`;
    }).join('') || '<p class="kr-muted">This visit list is empty. Add items below or confirm none are needed.</p>';
    $('emptyConfirmLabel').hidden = rows.length > 0; $('emptyConfirm').checked = draft.emptyAllowed[state.phase]; $('emptyConfirm').disabled = state.busy;
    if (draft.mode !== 'custom') $('kitItems').querySelectorAll('input, select, button').forEach(control => { control.disabled = true; });
    $('reloadRules').disabled = state.busy; $('saveRule').textContent = state.busy ? 'Saving…' : 'Save kit rule'; catalog(); changed();
  }
  async function load() {
    if (state.busy || !leaveDraft()) return;
    state.busy = true; $('reloadRules').disabled = true;
    try {
      const data = await request('/api/admin/service-kit-rules');
      const previous = state.selected && key(state.selected);
      state.services = data.services; state.catalog = data.catalog; state.selected = null; state.draft = null; state.dirty = false;
      state.busy = false; directory();
      const desired = state.services.find(service => key(service) === previous) || state.services[0];
      if (desired) select(desired); else render();
    } catch (error) { message(error.message); }
    finally { state.busy = false; $('reloadRules').disabled = false; if (state.selected) render(); }
  }
  $('serviceSearch').addEventListener('input', directory); $('serviceFilter').addEventListener('change', directory);
  $('reloadRules').addEventListener('click', load);
  $('serviceList').addEventListener('click', event => { const button = event.target.closest('[data-service]'); if (button) select(state.services.find(service => key(service) === button.dataset.service)); });
  $('ruleMode').addEventListener('change', () => { if (state.busy) return; state.draft.mode = $('ruleMode').value; render(); });
  $('phaseTabs').addEventListener('click', event => { const button = event.target.closest('[data-phase]'); if (button && !state.busy) { state.phase = button.dataset.phase; $('itemSearch').value = ''; render(); } });
  $('itemSearch').addEventListener('input', () => { if (state.draft) catalog(); });
  $('catalogResults').addEventListener('click', event => {
    const button = event.target.closest('[data-add]'); if (!button || state.busy) return;
    const tool = state.catalog.find(tool => tool.id === button.dataset.add); if (!tool || state.draft[state.phase].some(item => String(item.toolId) === tool.id)) return;
    state.draft[state.phase].push({ toolId: tool.id, name: tool.name, category: tool.category, unit: tool.unit, quantity: 1, quantityBasis: tool.category === 'equipment' ? 'per_visit' : 'per_unit' });
    state.draft.emptyAllowed[state.phase] = false; render();
  });
  $('kitItems').addEventListener('input', event => { if (state.busy) return; if (event.target.dataset.quantity !== undefined) { state.draft[state.phase][Number(event.target.dataset.quantity)].quantity = event.target.value; changed(); } });
  $('kitItems').addEventListener('change', event => { if (state.busy) return; if (event.target.dataset.basis !== undefined) { state.draft[state.phase][Number(event.target.dataset.basis)].quantityBasis = event.target.value; changed(); } });
  $('kitItems').addEventListener('click', event => { const button = event.target.closest('[data-remove]'); if (button && !state.busy) { state.draft[state.phase].splice(Number(button.dataset.remove), 1); state.draft.emptyAllowed[state.phase] = false; render(); } });
  $('emptyConfirm').addEventListener('change', () => { if (!state.busy) { state.draft.emptyAllowed[state.phase] = $('emptyConfirm').checked; changed(); } });
  $('kitRuleForm').addEventListener('submit', async event => {
    event.preventDefault(); if (state.busy || !state.dirty) return;
    if (state.draft.mode === 'custom') {
      for (const phase of phases(state.selected)) {
        const rows = state.draft[phase];
        if ((!rows.length && !state.draft.emptyAllowed[phase]) || rows.some(row => !Number.isFinite(Number(row.quantity)) || Number(row.quantity) < 1 || Number(row.quantity) > 10000 || (row.category === 'equipment' && !Number.isInteger(Number(row.quantity))))) {
          state.phase = phase; render(); message('Check this visit list: enter valid quantities or confirm that no items are needed.'); return;
        }
      }
    }
    state.busy = true; render(); message('');
    try {
      const service = state.selected;
      const data = await request(`/api/admin/service-kit-rules/${service.serviceModel}/${service.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.draft) });
      service.rule = data.rule; state.draft = draftFor(data.rule); state.baseline = JSON.stringify(state.draft); message('Kit rule saved.', 'success'); directory();
    } catch (error) { message(error.message); }
    finally { state.busy = false; render(); }
  });
  window.addEventListener('beforeunload', event => { if (state.dirty || state.busy) { event.preventDefault(); event.returnValue = ''; } });
  load();
})();

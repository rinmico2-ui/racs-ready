(function () {
  'use strict';
  function create() {
  let catalog = [], hooks, host, editingId = null, mounted = false, step = 1, reached = 1, saved = false;
  let savedMove = null, detailsUnknown = false, helpOpen = false, confirmationOpen = false;
  let sending = false, requestToken = null, requestFingerprint = null, assistanceReceipt = null;
  let assistanceUpdates = null;
  let assistanceOpen = false;
  let batch = null;
  let guide = null;
  const canAsk = () => typeof hooks?.assistance === 'function';
  let A = window.ApplianceServices;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = value => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 2 }).format(value);
  const field = name => host.querySelector(`[name="${name}"]${name === 'kind' && !hooks?.repair ? ':checked' : ''}`);
  function setKind(kind) { if (hooks.repair) field('kind').value = kind; else host.querySelector(`[name="kind"][value="${kind}"]`).checked = true; }
  const available = () => hooks.remaining ? hooks.remaining(editingId) : A.remainingUnits(hooks.state.selectedServices, editingId);
  const aircon = () => hooks.repair ? Boolean(hooks.isAirconKind?.(field('kind').value)) : field('kind').value === 'aircon';
  const repairQuantity = () => Math.max(1, Number(hooks.state.selectedServices.find(row => String(row.id || row._id || '') === String(editingId))?.quantity) || 1);
  function syncBrand() {
    const custom = field('brandCustom'), other = field('brand').value === '__other__';
    custom.closest('label').hidden = !other;
    custom.disabled = !other || helpOpen || detailsUnknown;
    custom.required = other && !custom.disabled;
    custom.setCustomValidity(other && /^(i don.t know|unknown|__unknown__)$/i.test(custom.value.trim()) ? 'Use the unit details help button if the brand is unknown.' : '');
  }
  function setBrand(value) {
    const brand = String(value || '').trim();
    const known = Array.from(field('brand').options).some(option => option.value === brand && brand !== '__other__');
    field('brand').value = known ? brand : brand ? '__other__' : '';
    field('brandCustom').value = known ? '' : brand;
    syncBrand();
  }
  function refreshBrands() {
    const previous = field('brand').value === '__other__' ? field('brandCustom').value : field('brand').value;
    const brands = [...new Map(catalog.flatMap(service => service.brands || [])
      .filter(brand => typeof brand === 'string' && brand.trim() && !/^(i don.t know|unknown)$/i.test(brand.trim()))
      .map(brand => [brand.trim().toLowerCase(), brand.trim()])).values()].sort((a, b) => a.localeCompare(b));
    field('brand').innerHTML = '<option value="">Choose a brand</option>' + brands.map(brand => `<option value="${escape(brand)}">${escape(brand)}</option>`).join('') + '<option value="__other__">Other (enter brand)</option>';
    setBrand(previous);
  }
  function selection() {
    const kind = field('kind').value;
    if (detailsUnknown) return { applianceKind: kind, quantity: Number(field('quantity').value), brand: "I don't know", model: '', airconType: null, hp: null };
    const hp = hooks.repair && !aircon() ? '' : field(aircon() ? 'hp' : 'compressorHp').value;
    return { applianceKind: kind, quantity: hooks.repair ? repairQuantity() : Number(field('quantity').value), brand: (field('brand').value === '__other__' ? field('brandCustom').value : field('brand').value).trim(), model: hooks.repair || editingId ? field('model').value.trim() : '', airconType: hooks.repair ? hooks.airconTypeFor?.(kind) || null : kind === 'aircon' && field('airconType').value !== '__unknown__' ? field('airconType').value : null, hp: hp && hp !== '__unknown__' ? Number(hp) : null };
  }
  function draft() {
    if (!mounted) return null;
    const values = {};
    host.querySelectorAll('input:not([type=file]), select, textarea').forEach(input => {
      if (input.closest('[data-core-batch]')) return;
      if (input.name && !['kind', 'service', 'moveScope'].includes(input.name)) values[input.name] = input.type === 'checkbox' ? input.checked : input.value;
    });
    return { kind: field('kind').value, values, services: [...host.querySelectorAll('[name="service"]:checked')].map(input => input.value),
      moveScope: host.querySelector('[name="moveScope"]:checked')?.value, detailsUnknown, helpOpen, assistanceOpen, step, reached, editingId, saved, assistanceReceipt, requestToken, requestFingerprint,
      ...(batch ? { batch: batch.snapshot() } : {}) };
  }
  function changed() { hooks.changed?.(draft()); }
  function restoreDraft(data) {
    if (!data || !A.kinds.includes(data.kind) || data.saved && !data.assistanceReceipt) return;
    editingId = typeof data.editingId === 'string' && hooks.state.selectedServices.some(row => (hooks.repair ? String(row.id || row._id || '') : row.applianceGroupId) === data.editingId) ? data.editingId : null;
    detailsUnknown = canAsk() && (data.detailsUnknown === true || data.values?.brandUnknown === true || ['airconType', 'hp'].some(name => data.values?.[name] === '__unknown__'));
    helpOpen = canAsk() && (data.helpOpen === true || detailsUnknown);
    setKind(data.kind);
    refreshTypes();
    setBrand(data.values?.brand === '__other__' ? data.values.brandCustom : data.values?.brand);
    for (const name of ['model', 'quantity', 'airconType', 'assistanceNotes', 'moveFrom', 'moveTo']) {
      const input = field(name), value = data.values?.[name]; if (!input || value === undefined) continue;
      if (input.type === 'checkbox') input.checked = value === true; else if (typeof value === 'string') input.value = value;
    }
    refreshHp();
    for (const name of ['hp', 'compressorHp']) if (typeof data.values?.[name] === 'string') field(name).value = data.values[name];
    batch?.restore(data.batch);
    host.querySelectorAll('[name="moveScope"]').forEach(input => { input.checked = input.value === (data.moveScope === 'custom_quote' ? 'different_address' : data.moveScope); });
    refreshServices();
    if (!hooks.repair) host.querySelectorAll('[name="service"]').forEach(input => { input.checked = !input.disabled && Array.isArray(data.services) && data.services.includes(input.value); });
    assistanceOpen = (hooks.repair || data.assistanceOpen !== false) && Boolean(host.querySelector('[name="service"][data-verification]:checked'));
    requestToken = typeof data.requestToken === 'string' ? data.requestToken : null; requestFingerprint = typeof data.requestFingerprint === 'string' ? data.requestFingerprint : null;
    reached = Math.min(3, Math.max(1, Number(data.reached) || 1)); setStep(Math.min(reached, Math.max(1, Number(data.step) || 1)), false);
    if (data.saved && data.assistanceReceipt?.id) { assistanceReceipt = data.assistanceReceipt; showAssistanceSuccess(); }
  }
  function relocationSelection() {
    const scope = host.querySelector('[name="moveScope"]:checked')?.value;
    return { ...(savedMove || {}), scope, model: field('model').value.trim(),
      from: { ...(savedMove?.from || {}), details: field('moveFrom').value.trim() },
      to: { ...(savedMove?.to || {}), details: field('moveTo').value.trim() } };
  }
  function selectedRelocation() {
    return [...host.querySelectorAll('[name="service"]:checked')].some(input => A.isRelocation(catalog.find(service => String(service._id) === input.value)));
  }
  function outsideRows() {
    return hooks.state.selectedServices.filter(row => !editingId || (hooks.repair ? String(row.id || row._id || '') : row.applianceGroupId || String(row.id || row._id || '')) !== String(editingId));
  }
  function syncStandaloneChoices() {
    const base = window.ApplianceServices, outside = outsideRows();
    const choices = [...host.querySelectorAll('[name="service"]')];
    const selected = choices.filter(input => input.checked);
    for (const input of choices) {
      const move = A.isRelocation(catalog.find(service => String(service._id) === input.value));
      const blocked = outside.some(base.isRelocation) || (move ? outside.length > 0 || selected.some(other => other !== input) : selected.some(other => other !== input && A.isRelocation(catalog.find(service => String(service._id) === other.value))));
      input.disabled = input.hasAttribute('data-unavailable') || blocked;
      input.closest('.cab-service').classList.toggle('is-unavailable', input.disabled);
      input.title = blocked ? 'Aircon Relocation must be booked on its own. Remove it or book other services separately.' : '';
    }
    const conflict = outside.some(base.isRelocation) || selected.some(input => A.isRelocation(catalog.find(service => String(service._id) === input.value))) && (outside.length > 0 || selected.length > 1);
    host.querySelector('[data-new]').disabled = !A.remainingUnits(hooks.state.selectedServices) || hooks.state.selectedServices.some(base.isRelocation);
    return !conflict;
  }
  function syncMove() {
    const selected = selectedRelocation(), move = relocationSelection(), sameProperty = move.scope === 'same_property';
    host.querySelector('[data-relocation-config]').hidden = !selected;
    host.querySelectorAll('[name="moveScope"]').forEach(input => { input.required = selected; input.disabled = !selected; });
    host.querySelector('[data-nearby-fields]').hidden = !sameProperty;
    host.querySelector('[data-move-address-note]').hidden = move.scope !== 'different_address';
    ['moveFrom', 'moveTo'].forEach(name => { field(name).disabled = !selected || !sameProperty; field(name).required = selected && sameProperty; });
    return !selected || Boolean(move.scope) && (sameProperty ? ['moveFrom', 'moveTo'].every(name => field(name).value.trim().length >= 2) : host.querySelectorAll('[name="service"]:checked').length === 1);
  }
  function message(text, error = false) { const node = host.querySelector('[data-feedback]'); node.textContent = text; node.classList.toggle('is-error', error); }
  function syncLimit(normalize = false) {
    if (hooks.repair) field('quantity').value = String(repairQuantity());
    const limit = available(), input = field('quantity'), number = Number(input.value), feedback = host.querySelector('[data-quantity-feedback]');
    input.max = String(limit); input.disabled = limit === 0;
    if (input.value !== '' && Number.isFinite(number) && number > limit && limit > 0) {
      input.value = String(limit); feedback.textContent = `Quantity changed to ${limit}. Your booking can have up to 40 appliances.`;
    } else if (normalize && limit > 0 && (input.value === '' || !Number.isFinite(number) || number < 1)) {
      input.value = '1'; feedback.textContent = 'The minimum quantity is 1 appliance.';
    }
    const quantity = Number(input.value);
    input.setCustomValidity(selectedRelocation() && quantity !== 1 ? 'Book one aircon relocation at a time.' : limit === 0 ? 'Your booking already has 40 appliances.' : !Number.isInteger(quantity) || quantity < 1 || quantity > limit ? `Enter a whole number from 1 to ${limit}.` : '');
    input.setAttribute('aria-invalid', String(limit > 0 && !input.validity.valid));
    if (limit > 0 && !input.validity.valid) feedback.textContent = `Enter a whole number from 1 to ${limit}.`;
    host.querySelectorAll('[data-capacity], [data-footer-capacity]').forEach(node => { node.textContent = `${A.unitCount(hooks.state.selectedServices)} / 40 appliances in your booking`; });
    host.querySelector('[data-limit]').textContent = limit > 0 ? `Up to ${limit} appliance${limit === 1 ? '' : 's'} available in this booking. Maximum 40 in total.` : 'Your booking has reached 40 appliances. Remove an item or edit an existing appliance to continue.';
    host.querySelector('[data-minus]').disabled = limit === 0 || !Number.isInteger(quantity) || quantity <= 1;
    host.querySelector('[data-plus]').disabled = limit === 0 || !Number.isInteger(quantity) || quantity >= limit || selectedRelocation();
    host.querySelector('[data-new]').disabled = !A.remainingUnits(hooks.state.selectedServices);
    return limit > 0 && input.validity.valid;
  }
  function detailsValid() {
    if (batch?.active()) return field('quantity').validity.valid && batch.detailsValid();
    if (detailsUnknown) return available() > 0 && field('quantity').validity.valid;
    if (helpOpen) return false;
    return available() > 0 && requiredDetailFields().every(name => field(name).disabled || field(name).validity.valid) && Boolean(selection().brand);
  }
  function requiredDetailFields() {
    return ['brand', ...(field('brand').value === '__other__' ? ['brandCustom'] : []), ...(hooks.repair ? ['model'] : []), 'quantity',
      ...(aircon() ? hooks.repair ? ['hp'] : ['airconType', 'hp'] : compressorHpRequired() ? ['compressorHp'] : [])];
  }
  function guidanceFields() {
    const result = [];
    function add(input, key, label, count = true, valid, includeDisabled = false) {
      if (!input) return;
      result.push({ element: input, key, label, count, includeDisabled,
        complete: valid === undefined ? input.validity.valid && (!input.required || Boolean(input.value.trim())) : valid,
      });
    }
    if (!hooks.repair) add(field('quantity'), 'quantity', 'Number of appliances', false);
    const labels = { brand: 'Brand', brandCustom: 'Other brand', airconType: 'Aircon type', hp: 'Capacity (HP)', compressorHp: 'Compressor HP', model: 'Model number' };
    if (batch?.active() && batch.differentDetails()) {
      batch.model.activeUnits().forEach((unit, index) => {
        for (const name of ['brand','brandCustom','airconType','hp','model']) {
          const input = host.querySelector(`[data-unit-row="${index}"] [data-unit-field="${name}"]`);
          let valid;
          if (name === 'brandCustom') valid = Boolean(unit.brand) && batch.model.issue(unit)?.field !== 'brand';
          if (name === 'model') valid = !unit.model || unit.model.length <= 50 && /^[A-Za-z0-9][A-Za-z0-9 ._/#()+-]*$/.test(unit.model);
          add(input, `${unit.key}-${name}`, `Aircon ${index + 1} · ${labels[name]}`, name !== 'model', valid, name === 'hp');
        }
      });
    } else {
      const label = batch?.active() ? 'Shared aircon' : A.labels[field('kind').value] || 'Appliance';
      for (const name of ['brand','brandCustom','airconType','hp','compressorHp','model']) {
        add(field(name), `shared-${name}`, `${label} · ${labels[name]}`, field(name).required);
      }
    }
    return result;
  }
  function compressorHpRequired() {
    if (hooks.repair || aircon()) return false;
    const kind = field('kind').value;
    const services = catalog.filter(service => service.active !== false && A.profile(service, kind));
    if (!services.length) return false;
    const priced = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0;
    const fixed = services.some(service => {
      const p = A.profile(service, kind);
      return p.pricingMode !== 'hp' && priced(p.unitPrice) && Number(p.durationMinutes) > 0;
    });
    if (fixed) return false;
    return services.some(service => {
      const p = A.profile(service, kind);
      return p.pricingMode === 'hp' && (p.hpPricing || []).some(row => Number.isFinite(A.parseHp(row.hp)) && priced(row.price) && Number(row.durationMinutes) > 0);
    });
  }
  function closeConfirmation() {
    confirmationOpen = false;
    host.querySelector('[data-request-confirmation]').hidden = true;
    host.querySelector('[data-submit]').hidden = step !== 3;
  }
  function showConfirmation(selected, service) {
    confirmationOpen = true;
    host.querySelector('[data-confirm-summary]').textContent = `${service.name} for ${selected.quantity} ${A.labels[selected.applianceKind].toLowerCase()} appliance${selected.quantity === 1 ? '' : 's'}.`;
    host.querySelector('[data-request-confirmation]').hidden = false;
    host.querySelector('[data-submit]').hidden = true;
    const heading = host.querySelector('[data-confirm-heading]');
    heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function chooseHelp(mode) {
    closeConfirmation();
    assistanceOpen = false;
    helpOpen = mode !== 'manual'; detailsUnknown = mode === 'staff';
    refreshServices(); changed();
    if (mode === 'staff') { setStep(3); return; }
    updateTotal();
    if (mode === 'ai') {
      if (window.RACSChat?.openUnitIdentification) {
        window.RACSChat.openUnitIdentification({ applianceKind: field('kind').value, ...(hooks?.repair ? { applianceLabel: A.labels[field('kind').value] } : {}) });
        message('RACS Ready AI is open. Your progress is kept. Return here to enter the details or ask staff.');
      } else message('AI help is temporarily unavailable. You can still ask staff to identify your unit.', true);
    } else if (mode === 'manual') field('brand').focus();
  }
  function setStep(value, focus = true) {
    step = value; reached = Math.max(reached, step); saved = false;
    closeConfirmation();
    host.querySelector('[data-wizard]').hidden = false; host.querySelector('[data-success]').hidden = true;
    host.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = Number(panel.dataset.panel) !== step; });
    host.querySelectorAll('[data-step]').forEach(button => {
      const number = Number(button.dataset.step); button.disabled = number > reached;
      button.classList.toggle('is-active', number === step); button.classList.toggle('is-complete', number < step);
      if (number === step) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    });
    host.querySelector('[data-step-label]').textContent = `Step ${step} of 3`;
    host.querySelector('[data-back]').hidden = step === 1; host.querySelector('[data-next]').hidden = step === 3; host.querySelector('[data-submit]').hidden = step !== 3;
    host.querySelector('[data-cancel]').hidden = !editingId && step === 1;
    host.querySelector('[data-cancel]').textContent = editingId ? 'Cancel changes' : 'Start over';
    host.querySelector('[data-next]').textContent = step === 1 ? 'Next: appliance details' : hooks.repair ? 'Next: describe the problem' : 'Next: choose services';
    message(''); updateTotal();
    changed();
    if (focus) { const heading = host.querySelector(hooks.repair && step === 3 ? '[data-identification-heading]' : `[data-panel="${step}"] h3`); heading.focus({ preventScroll: true }); host.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
  }
  function next() {
    syncLimit(true);
    if (!available()) return message('Your booking already has 40 appliances. Edit or remove an item first.', true);
    if (step === 2 && !detailsValid()) {
      if (batch?.active() && batch.focusInvalid()) return;
      const invalid = requiredDetailFields().map(field).find(input => !input.disabled && (!input.validity.valid || input.name === 'brand' && !input.value.trim()));
      message(hooks.repair ? 'Complete the required appliance details before describing the problem.' : 'Complete the required appliance details before choosing services.', true); invalid?.focus(); invalid?.reportValidity(); return;
    }
    if (step < 3) { refreshServices(); setStep(step + 1); }
  }
  function advanceCompletedRepairDetails(event) {
    if (hooks.guideFields || !hooks.repair || !['brand', 'brandCustom', 'model', 'hp'].includes(event.target.name)) return;
    setTimeout(() => {
      if (step !== 2 || saved || helpOpen || !host.isConnected || !detailsValid()) return;
      const panel = host.querySelector('[data-panel="2"]');
      if (!panel.getClientRects().length) return;
      const active = document.activeElement;
      if (active?.closest('[data-cancel], [data-back], [data-unit-help], [data-help-ai], [data-help-staff]')) return;
      if (panel.contains(active) && active.matches('input, select, textarea, [data-minus], [data-plus]')) return;
      next();
    }, 0);
  }
  function refreshTypes() {
    refreshBrands();
    if (hooks.repair) {
      hooks.syncApplianceChoices?.(field('kind').value);
      host.querySelector('[data-aircon-details]').hidden = !aircon();
      host.querySelector('[data-compressor-details]').hidden = true;
      host.querySelector('.cab-help')?.setAttribute('hidden', '');
      refreshHp(); return;
    }
    const kind = field('kind').value, previous = field('airconType').value, types = new Map();
    catalog.filter(service => A.profile(service, 'aircon')).forEach(service => A.effectiveAirconTypes(service).forEach(type => types.set(type.type, type.name)));
    field('airconType').innerHTML = '<option value="">Choose aircon type</option>' + [...types].map(([key, name]) => `<option value="${escape(key)}">${escape(name)}</option>`).join(''); field('airconType').value = previous;
    host.querySelector('[data-aircon-details]').hidden = kind !== 'aircon';
    host.querySelector('.cab-help').hidden = kind !== 'aircon';
    const compressorSizes = new Set();
    catalog.filter(service => service.active !== false).forEach(service => (A.profile(service, kind)?.hpPricing || []).forEach(tier => compressorSizes.add(A.parseHp(tier.hp))));
    const previousHp = field('compressorHp').value;
    field('compressorHp').innerHTML = '<option value="">I do not know / not needed for fixed prices</option>' + [...compressorSizes].filter(Number.isFinite).sort((a, b) => a - b).map(hp => `<option value="${hp}">${escape(A.formatHp(hp))} HP</option>`).join('');
    field('compressorHp').value = previousHp;
    field('compressorHp').disabled = kind === 'aircon';
    host.querySelector('[data-compressor-details]').hidden = kind === 'aircon' || !compressorSizes.size;
    ['airconType', 'hp'].forEach(name => { field(name).required = kind === 'aircon'; field(name).disabled = kind !== 'aircon'; }); refreshHp();
  }
  function refreshHp() {
    const previous = field('hp').value, type = field('airconType').value, sizes = new Set();
    if (hooks.repair) (A.repairHpValues || []).forEach(hp => sizes.add(hp));
    else catalog.filter(service => service.active !== false && A.profile(service, 'aircon'))
      .forEach(service => A.airconHpOptions(service, type).forEach(row => sizes.add(row.hp)));
    field('hp').innerHTML = '<option value="">Choose HP</option>' + [...sizes].sort((a, b) => a - b).map(hp => `<option value="${hp}">${hp} HP</option>`).join(''); field('hp').value = previous; refreshServices();
  }
  function refreshServices() {
    batch?.sync();
    if (batch?.active()) { batch.refreshServices(); updateTotal(); return; }
    const checked = new Set([...host.querySelectorAll('[name="service"]:checked')].map(input => input.value)), selected = selection();
    const candidates = catalog.filter(service => service.active !== false && A.profile(service, selected.applianceKind) && (!A.isRelocation(service) || selected.applianceKind === 'aircon'));
    const typeName = selected.airconType ? field('airconType').selectedOptions[0]?.textContent : '';
    host.querySelector('[data-service-appliance]').textContent = [detailsUnknown ? 'Staff identification' : selected.brand, A.labels[selected.applianceKind], typeName, selected.hp ? `${selected.hp} HP` : '', `${selected.quantity || 0} appliance${selected.quantity === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    const rows = [], serviceCards = [];
    let excluded = 0;
    candidates.forEach(service => {
      const state = A.availability(service, selected);
      const pricing = state.available ? state.pricing : null;
      const verification = canAsk() && (detailsUnknown || A.needsVerification(service, selected) && (!selected.airconType || !selected.hp));
      if (hooks.repair && (pricing || verification)) {
        if (verification) assistanceOpen = true;
        rows.push(`<div class="cab-service cab-service-included"><input type="${verification ? 'radio' : 'checkbox'}" name="service" value="${escape(service._id)}" ${verification ? 'data-verification' : ''} checked hidden tabindex="-1" aria-hidden="true"><span class="cab-service-copy"><strong>${escape(service.name)}</strong><small><i class="bi bi-check-circle-fill" aria-hidden="true"></i> Already selected for this appliance.</small></span><span class="cab-service-price">${verification ? 'Pending confirmation' : money(pricing.unitPrice)}<small>${verification ? 'Staff will confirm the fee' : `inspection only &middot; ${pricing.duration} min`}</small></span></div>`);
        return;
      }
      if (verification) {
        rows.push(`<label class="cab-service"><input type="radio" name="service" value="${escape(service._id)}" data-verification ${checked.has(String(service._id)) ? 'checked' : ''}><span class="cab-service-copy"><strong>${escape(service.name)}</strong><small>Staff will confirm your unit details and send a price for approval.</small></span><span class="cab-service-price">Price pending verification</span></label>`);
        return;
      }
      if (A.isRelocation(service)) {
        const tooMany = selected.quantity !== 1 || !pricing;
        rows.push(`<label class="cab-service ${tooMany ? 'is-unavailable' : ''}"><input type="checkbox" name="service" value="${escape(service._id)}" ${tooMany ? 'disabled data-unavailable' : ''} ${!tooMany && checked.has(String(service._id)) ? 'checked' : ''}><span class="cab-service-copy"><strong>${escape(service.name)}</strong><small>${tooMany ? 'Add one aircon at a time for relocation.' : 'Move within the same property or to another address. Your aircon details are already saved above.'}</small></span><span class="cab-service-price">${pricing ? money(pricing.unitPrice) : 'Price not configured'}<small>service price</small></span></label>`);
        return;
      }
      if (!pricing) {
        if (hooks.repair) {
          const error = state.reason || 'Staff must set a price for this service.';
          rows.push(`<div class="cab-service is-unavailable"><span class="cab-service-copy"><strong>${escape(service.name)}</strong><small>${escape(error)}</small></span><span class="cab-service-price">Unavailable<small>Contact staff to confirm the fee</small></span></div>`);
        } else excluded += 1;
        return;
      }
      const simpleCore = !hooks.repair && selected.applianceKind === 'aircon' && window.CoreApplianceBatch;
      const description = simpleCore ? CoreApplianceBatch.serviceDescription(service) : service.description || 'Service for your selected appliance.';
      const html = `<label class="cab-service"><input type="checkbox" name="service" value="${escape(service._id)}" ${checked.has(String(service._id)) ? 'checked' : ''}><span class="cab-service-copy"><span class="cab-service-name"><strong>${escape(service.name)}</strong>${simpleCore ? '<span class="cab-service-state" aria-hidden="true"><span data-service-unselected>Select</span><span data-service-selected><i class="bi bi-check2" aria-hidden="true"></i>Selected</span></span>' : ''}</span><small>${escape(description)}</small></span><span class="cab-service-price">${money(pricing.unitPrice)}<small>${hooks.repair ? 'inspection only' : 'per appliance'} &middot; ${pricing.duration} min</small></span></label>`;
      rows.push(html);
      serviceCards.push({ service, html, available: true, checked: checked.has(String(service._id)) });
    });
    const servicesList = host.querySelector('[data-services]');
    const markup = !hooks.repair && selected.applianceKind === 'aircon' && window.CoreApplianceBatch && serviceCards.length === rows.length
      ? CoreApplianceBatch.groupServiceCards(serviceCards) : rows.join('');
    servicesList.innerHTML = markup || '<div class="cab-empty"><strong>No services are available for this appliance yet.</strong><p>Choose another appliance, or use Repair Service if it needs an inspection.</p></div>';
    if (excluded && rows.length) {
      servicesList.insertAdjacentHTML('beforeend', `<p class="cab-note">${excluded} other service${excluded === 1 ? ' is' : 's are'} not offered for ${selected.applianceKind === 'aircon' ? 'this aircon type and HP' : 'this appliance'}.</p>`);
    }
    if (!canAsk() && selected.applianceKind !== 'aircon' && candidates.some(service => A.profile(service, selected.applianceKind)?.pricingMode === 'hp') && !selected.hp) host.querySelector('[data-services]').insertAdjacentHTML('beforeend', '<div class="cab-empty"><strong>Not sure about the compressor HP?</strong><p>You can book services with a fixed price, or request a repair inspection.</p><button type="button" class="cab-secondary" data-repair>Choose Repair Service</button></div>');
    updateTotal();
  }
  function updateTotal() {
    if (batch) {
      syncLimit();
      host.querySelector('.cab-quantity > div > p').textContent = aircon()
        ? 'Set the number first. You can enter shared details or adjust each unit below.'
        : 'Use one group for appliances with the same details and services.';
    }
    batch?.sync();
    if (batch?.active()) { updateBatchTotal(); guide?.refresh(); return; }
    syncProblemSuggestions();
    const assisted = helpOpen || detailsUnknown;
    host.querySelector('[data-unit-details]').hidden = assisted;
    host.querySelector('[data-details-required]').hidden = assisted;
    if (host.querySelector('[data-help-options]')) host.querySelector('[data-help-options]').hidden = !helpOpen;
    field('brand').disabled = assisted; field('brand').required = !assisted;
    field('model').disabled = assisted || !hooks.repair; field('model').required = false;
    syncBrand();
    field('compressorHp').disabled = assisted || hooks.repair || field('kind').value === 'aircon';
    const compressorRequired = compressorHpRequired() && !field('compressorHp').disabled;
    field('compressorHp').required = compressorRequired;
    const compressorCard = host.querySelector('[data-compressor-details]');
    if (compressorCard && !compressorCard.hidden) {
      compressorCard.querySelector('.cab-optional').hidden = compressorRequired;
      compressorCard.querySelector('label').firstChild.textContent = compressorRequired ? 'Compressor HP * ' : 'Compressor HP ';
      compressorCard.querySelector('.cab-note').textContent = compressorRequired ? 'Needed to show prices for these services. Use the HP printed on the compressor label.' : 'Use the HP on the compressor label. It is needed only for services priced by HP.';
    }
    const model = field('model');
    model.setCustomValidity(!hooks.repair || assisted || !model.value.trim() ? '' : /^[A-Za-z0-9][A-Za-z0-9 ._/#()+-]*$/.test(model.value.trim()) ? '' : 'Use letters, numbers, spaces, and . - _ / # ( ) + only.');
    ['airconType', 'hp'].forEach(name => { const enabled = aircon() && !assisted && (name === 'hp' || !hooks.repair); field(name).required = enabled; field(name).disabled = !enabled; });
    host.querySelector('[data-detail-appliance]').textContent = A.labels[field('kind').value] || 'Choose an appliance';
    host.querySelector('[data-detail-caption]').textContent = hooks.repair ? repairQuantity() > 1 ? `${repairQuantity()} appliances on this existing entry. Contact staff to change the quantity.` : 'One appliance per repair entry. Add another appliance separately.' : 'Choose the details shown on your appliance.';
    const help = host.querySelector('[data-unit-help]');
    if (help) { help.textContent = helpOpen ? 'Enter my unit details instead' : "I don't know my unit details"; help.setAttribute('aria-expanded', String(helpOpen)); help.disabled = Boolean(editingId); }
    host.querySelector('[data-services-intro]').textContent = hooks.repair ? 'Repair inspection is already selected. Describe the problem below.' : detailsUnknown ? 'Choose one service for staff to confirm. You can add more services after your unit details are verified.' : 'Select one or more services for the same appliance.';
    const priceNotice = host.querySelector('[data-price-notice]');
    if (priceNotice) {
      const item = hooks.priceNotice?.(selection(), { unknown: detailsUnknown });
      priceNotice.hidden = !item;
      priceNotice.innerHTML = item ? '<div><span>'+escape(item.label)+'</span><strong>'+escape(item.value)+'</strong></div><p>'+escape(item.note)+'</p>' : '';
    }
    const validQuantity = syncLimit(), selected = selection(), ids = [...host.querySelectorAll('[name="service"]:checked')].map(input => input.value), moveValid = syncMove();
    const standaloneValid = syncStandaloneChoices();
    const verification = ids.some(id => canAsk() && (detailsUnknown || A.needsVerification(catalog.find(service => String(service._id) === id), selected)));
    const identifying = verification && assistanceOpen;
    host.querySelector('[data-service-picker]').hidden = identifying;
    if (host.querySelector('[data-assistance]')) host.querySelector('[data-assistance]').hidden = verification ? !identifying : !hooks.repair;
    const selectedRequest = host.querySelector('[data-selected-request]');
    if (selectedRequest) {
      selectedRequest.hidden = !identifying;
      host.querySelector('[data-selected-request-summary]').textContent = ids.map(id => catalog.find(service => String(service._id) === id)?.name).filter(Boolean).join(', ') + ` · ${selected.quantity} appliance${selected.quantity === 1 ? '' : 's'}`;
    }
    host.querySelector('[data-step-label]').textContent = `Step ${step} of 3${step === 3 && identifying ? ' · Unit identification' : ''}`;
    const photoGuidance = host.querySelector('[data-photo-guidance]');
    if (photoGuidance) photoGuidance.textContent = verification ? 'Up to two photos: the appliance and its model sticker. JPG, PNG or WEBP, up to 5 MB each. If you cannot take a photo, staff will contact you.' : 'Up to five photos of the appliance and its problem. JPG, PNG or WEBP, up to 5 MB each.';
    const files = Array.from(field('assistancePhotos')?.files || []);
    const photosInvalid = files.length > (verification ? 2 : 5) || files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024);
    field('assistancePhotos')?.setCustomValidity(photosInvalid ? `Choose up to ${verification ? 2 : 5} JPG, PNG or WEBP photos, 5 MB each.` : '');
    const photoFeedback = host.querySelector('[data-photo-feedback]');
    if (photoFeedback) photoFeedback.textContent = photosInvalid ? field('assistancePhotos').validationMessage : '';
    let total = 0, minutes = 0;
    if (validQuantity) ids.forEach(id => { try { const price = A.price(catalog.find(service => String(service._id) === id), { ...selected, brand: selected.brand || 'Brand not entered' }); total += price.unitPrice * selected.quantity; minutes += price.duration * selected.quantity; } catch (_) {} });
    host.querySelector('[data-total]').textContent = verification ? 'Price pending verification' : ids.length && validQuantity ? money(total) : '—';
    host.querySelector('[data-count]').textContent = `${validQuantity ? selected.quantity : 0} appliance${selected.quantity === 1 ? '' : 's'} · ${ids.length} service${ids.length === 1 ? '' : 's'}`;
    host.querySelector('[data-duration]').textContent = verification ? 'Staff will confirm the price and work time.' : minutes ? `${minutes} minutes of service work` : 'Prices appear after you choose services.';
    host.querySelector('[data-submit]').disabled = sending || confirmationOpen || saved || !ids.length || !validQuantity || !detailsValid() || !moveValid || !standaloneValid || photosInvalid || Boolean(hooks.validate?.(selected)) || verification && (!identifying || ids.length !== 1 || Boolean(editingId));
    host.querySelector('[data-submit]').textContent = sending ? 'Sending request…' : verification ? 'Review staff request' : editingId ? 'Save changes' : 'Add to booking';
    host.querySelector('[data-next]').disabled = !available() || !A.kinds.includes(field('kind').value) || step === 2 && !detailsValid();
    host.querySelector('[data-summary-appliance]').textContent = `${detailsUnknown ? 'Staff identification' : selected.brand || 'Your appliance'} · ${A.labels[selected.applianceKind] || 'Choose an appliance'}`;
    host.querySelector('[data-guidance]').textContent = !available() ? 'Your booking has 40 appliances. Edit or remove an item before adding another.' : step === 1 ? hooks.repair ? 'Next, add the details for this appliance.' : 'Next, add the appliance details and quantity.' : step === 2 ? helpOpen ? 'Choose staff assistance or use AI to help read your unit label.' : 'Fill in the required fields to see matching services and prices.' : hooks.repair ? detailsUnknown ? 'Describe the problem, then review and confirm your request to staff.' : 'Describe the problem, then add this appliance to your booking.' : detailsUnknown ? 'Choose a service, then review and confirm your request to staff.' : 'Choose services, then add this appliance to your booking.';
    guide?.refresh();
  }
  function updateBatchTotal() {
    const individual = batch.differentDetails(), validQuantity = syncLimit(), state = batch.model.estimate();
    host.querySelector('[data-unit-details]').hidden = individual;
    host.querySelector('[data-details-required]').hidden = false;
    if (host.querySelector('[data-help-options]')) host.querySelector('[data-help-options]').hidden = true;
    for (const name of ['brand','airconType','hp']) { field(name).disabled = individual; field(name).required = !individual; }
    syncBrand();
    if (individual) { field('brandCustom').disabled = true; field('brandCustom').required = false; }
    field('model').disabled = true; field('compressorHp').disabled = true;
    host.querySelector('[data-detail-appliance]').textContent = 'Shared aircon details';
    host.querySelector('[data-detail-caption]').textContent = `These details apply to all ${state.count} aircons.`;
    host.querySelector('[data-service-picker]').hidden = false;
    if (host.querySelector('[data-assistance]')) host.querySelector('[data-assistance]').hidden = true;
    host.querySelector('[data-relocation-config]').hidden = true;
    host.querySelector('[data-service-appliance]').textContent = `${state.count} aircons · ${individual ? 'Individual unit details' : 'Shared unit details'}`;
    host.querySelector('[data-services-intro]').textContent = 'First, choose whether your aircons need the same work.';
    host.querySelector('[data-summary-appliance]').textContent = `${state.count} aircons · ${individual ? 'Different details' : 'Same details'}`;
    host.querySelector('[data-total]').textContent = state.tasks ? money(state.total) : '—';
    host.querySelector('[data-count]').textContent = `${state.count} aircons · ${state.tasks} service${state.tasks === 1 ? '' : 's'} selected`;
    host.querySelector('[data-duration]').textContent = state.minutes ? `${state.minutes} minutes of service work` : 'Choose services to see the total for your aircons.';
    host.querySelector('[data-next]').disabled = !validQuantity || step === 2 && !batch.detailsValid();
    host.querySelector('[data-submit]').disabled = saved || !validQuantity || !state.ready || outsideRows().some(window.ApplianceServices.isRelocation);
    host.querySelector('[data-submit]').textContent = editingId ? 'Save changes' : `Add ${state.count} aircons to booking`;
    host.querySelector('[data-guidance]').textContent = step === 2 ? individual ? 'Complete each aircon. Copy the fields that match to save time.' : 'Enter matching details once for all aircons.' : 'Review each unit’s services and the combined total before adding them.';
    batch.refreshServices();
  }
  function success(selected, ids, edited) {
    assistanceUpdates?.stop(); assistanceUpdates = null;
    assistanceReceipt = null;
    saved = true; editingId = null; host.querySelector('[data-wizard]').hidden = true; host.querySelector('[data-success]').hidden = false;
    host.querySelector('[data-success] h3').textContent = edited ? 'Your changes are saved' : 'Added to your booking';
    host.querySelector('[data-saved-details]').textContent = `${selected.quantity} ${A.labels[selected.applianceKind].toLowerCase()}${selected.quantity > 1 ? 's' : ''} · ${ids.length} service${ids.length > 1 ? 's' : ''}`;
    host.querySelector('[data-saved-total]').textContent = `${A.unitCount(hooks.state.selectedServices)} / 40 appliances in your booking`;
    host.querySelector('[data-address]').hidden = false; host.querySelector('[data-address]').disabled = !hooks.state.selectedServices.length; host.querySelector('[data-new]').disabled = !A.remainingUnits(hooks.state.selectedServices); host.querySelector('[data-success] h3').focus({ preventScroll: true });
    const move = hooks.state.selectedServices.find(row => row.relocation)?.relocation;
    host.querySelector('[data-success-next-title]').textContent = move ? 'Next: Relocation locations' : 'Next: Service address';
    host.querySelector('[data-success-next-copy]').textContent = move?.scope === 'different_address' ? 'Pin the current and new addresses, then choose an available date and time. Review the price and pay as usual.' : move ? 'Pin the current property. Your current and new positions are saved with the aircon details.' : 'Tell us where the service will happen. Then choose your schedule and review your booking.';
    host.querySelector('[data-address]').textContent = move ? 'Continue to locations' : 'Continue to service address';
    if (hooks.embedded && !hooks.bookingCreate) {
      if (hooks.bookingEdit) host.querySelector('[data-success] h3').textContent = 'Appliance changes are ready';
      host.querySelector('[data-success-next-title]').textContent = 'Next: Review your schedule';
      host.querySelector('[data-success-next-copy]').textContent = hooks.bookingEdit
        ? 'Review your schedule, then select Save Changes to update the booking or send it for staff review.'
        : 'Check whether your updated services need a new date or more time, then save your booking changes.';
      host.querySelector('[data-address]').textContent = 'Review schedule';
    }
    if (move) host.querySelector('[data-new]').disabled = true;
    host.querySelector('[data-request-link]')?.setAttribute('hidden', ''); changed();
  }
  function showAssistanceSuccess() {
    assistanceUpdates?.stop(); assistanceUpdates = null;
    saved = true; editingId = null;
    host.querySelector('[data-wizard]').hidden = true; host.querySelector('[data-success]').hidden = false;
    host.querySelector('[data-success] h3').textContent = 'Request sent for verification';
    host.querySelector('[data-saved-details]').textContent = assistanceReceipt.label;
    host.querySelector('[data-saved-total]').textContent = `${A.unitCount(hooks.state.selectedServices)} / 40 appliances in your booking`;
    host.querySelector('[data-success-next-title]').textContent = 'Next: Staff confirms your unit and price';
    host.querySelector('[data-success-next-copy]').textContent = 'We will contact you if more details are needed. Review and accept the quote in Unit assistance before booking this service. No payment or schedule is taken for this request.';
    host.querySelector('[data-address]').textContent = 'Continue with added services'; host.querySelector('[data-address]').hidden = !hooks.state.selectedServices.length; host.querySelector('[data-address]').disabled = !hooks.state.selectedServices.length;
    host.querySelector('[data-new]').disabled = !A.remainingUnits(hooks.state.selectedServices);
    const link = host.querySelector('[data-request-link]');
    link.hidden = false; link.href = '/unit-assistance?requestId=' + encodeURIComponent(assistanceReceipt.id);
    link.textContent = 'View request and staff quote'; link.classList.remove('cab-primary'); link.classList.add('cab-help');
    host.querySelector('[data-success] h3').focus({ preventScroll: true }); changed();
    assistanceUpdates = window.CustomerWorkflowRefresh?.bindWorkflowRefresh({ window, document,
      socket: window.socket || (window.UnitAssistanceSocket ||= typeof window.io === 'function' ? window.io() : null),
      refresh: refreshAssistanceQuote, isBusy: () => sending, pollIntervalMs: 15000,
    });
    assistanceUpdates?.schedule();
  }
  async function refreshAssistanceQuote() {
    if (!saved || !assistanceReceipt?.id || !host.isConnected) return;
    const id = String(assistanceReceipt.id);
    const response = await fetch('/api/unit-assistance/mine/' + encodeURIComponent(id), { credentials:'same-origin', cache:'no-store' });
    if (!response.ok) return;
    const { request } = await response.json();
    if (!saved || String(assistanceReceipt?.id) !== id || String(request?._id) !== id) return;
    const currentQuote = Number.isFinite(new Date(request.quote?.expiresAt).getTime()) && new Date(request.quote.expiresAt) > new Date();
    const quoted = request.status === 'quoted' && currentQuote;
    const accepted = request.status === 'accepted' && currentQuote && !request.existingBookingId;
    const link = host.querySelector('[data-request-link]');
    host.querySelector('[data-success] h3').textContent = quoted ? 'Your quote is ready' : accepted ? 'Quote accepted' : 'Request sent for verification';
    host.querySelector('[data-success-next-title]').textContent = quoted ? 'Next: Review and accept your quote' : accepted ? 'Next: Service address' : 'Next: Staff confirms your unit and price';
    host.querySelector('[data-success-next-copy]').textContent = quoted
      ? `${money(Number(request.quote.unitPrice) * Number(request.quantity))} ${request.requestType === 'repair' ? 'inspection fee' : 'service estimate'}, before travel fare. Review the verified details and accept the price to continue booking.`
      : accepted ? 'Your approved service is ready. Continue to choose the address and schedule.'
      : 'Review your request for the latest update. Accept a current quote before booking this service.';
    link.href = (accepted ? '/services?assistanceId=' : '/unit-assistance?requestId=') + encodeURIComponent(id);
    link.textContent = quoted ? 'Review quote and continue' : accepted ? 'Continue booking' : 'View request and staff quote';
    link.classList.toggle('cab-primary', quoted || accepted); link.classList.toggle('cab-help', !quoted && !accepted);
  }
  async function requestAssistance(selected, service) {
    if (sending) return;
    const files = Array.from(field('assistancePhotos')?.files || []);
    const validation = hooks.validate?.(selected);
    if (validation) { updateTotal(); return message(validation, true); }
    if (files.length > 2 || files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) { updateTotal(); return message('Choose up to two JPG, PNG, or WEBP photos, 5 MB each.', true); }
    const fingerprint = JSON.stringify([selected, service._id, field('assistanceNotes').value.trim(), A.isRelocation(service) ? relocationSelection() : null]);
    if (A.isRelocation(service) && relocationSelection().scope === 'different_address') { updateTotal(); return message('Ask staff to identify your unit first, then book the relocation with the confirmed details.', true); }
    if (requestFingerprint !== fingerprint) { requestFingerprint = fingerprint; requestToken = crypto.randomUUID(); }
    changed(); sending = true; updateTotal();
    const controls = [...host.querySelectorAll('button, input, select, textarea')].map(input => ({ input, disabled: input.disabled }));
    controls.forEach(({ input }) => { input.disabled = true; }); host.setAttribute('aria-busy', 'true');
    try {
      const result = await hooks.assistance({ ...selected, serviceId: service._id, notes: field('assistanceNotes').value.trim(), clientRequestId: requestToken,
        ...(A.isRelocation(service) ? { relocation: { scope: relocationSelection().scope, fromPosition: relocationSelection().from.details, toPosition: relocationSelection().to.details, model: selected.model } } : {}) }, files);
      assistanceReceipt = { id: result.id, label: `${selected.quantity} ${A.labels[selected.applianceKind].toLowerCase()} · ${service.name}` };
      closeConfirmation(); showAssistanceSuccess();
    } catch (error) { closeConfirmation(); message(error.message || 'Could not send your request. Please try again.', true); }
    finally { sending = false; controls.forEach(({ input, disabled }) => { input.disabled = disabled; }); host.removeAttribute('aria-busy'); sync(); host.querySelectorAll('.cab-progress button').forEach(button => { button.disabled = Number(button.dataset.step) > reached; }); }
  }
  function mount(services, options) {
    catalog = services; hooks = options; A = options.adapter || window.ApplianceServices; host = options.host || document.getElementById('coreApplianceBuilder'); if (!host) return;
    if (mounted) { refreshServices(); return; } mounted = true;
    const initialDraft = options.state.applianceDraft;
    const formTag = options.embedded ? "div" : "form";
    const bookingCounter = attribute => typeof hooks.review === 'function'
      ? `<button type="button" class="cab-capacity cab-review" data-booking-review aria-controls="selectedServicesSummary" aria-expanded="false"><span ${attribute}></span><span class="cab-review-label">View added services <i class="bi bi-chevron-up" aria-hidden="true"></i></span></button>`
      : `<span class="cab-capacity" ${attribute}></span>`;
    const repairChoices = options.repair ? options.applianceChoices || '<label class="cab-note">Appliance *<select name="kind" required><option value="">Choose an appliance</option>' + A.kinds.map(kind => '<option value="' + escape(kind) + '">' + escape(A.labels[kind]) + '</option>').join('') + '</select></label>' : '';
    host.innerHTML = `<${formTag} class="cab-form" ${options.embedded ? 'role="group" aria-label="Appliance configuration"' : "novalidate"}><div class="cab-heading"><div><span class="cab-eyebrow">${options.repair ? 'REPAIR SERVICES' : 'CORE SERVICES'}</span><h2>${options.repair ? 'Set up your repair service' : 'Set up your service'}</h2><p>Choose an appliance and tell us what it needs.</p></div>${bookingCounter('data-capacity')}</div>
      <div data-wizard><nav class="cab-progress" aria-label="Appliance service steps">${['Appliance', 'Details', 'Services'].map((name, index) => `<button type="button" data-step="${index + 1}" ${index ? 'disabled' : ''}><span>${index + 1}</span><strong>${name}</strong></button>`).join('')}</nav><div class="cab-step-meta"><span data-step-label></span><span>${options.embedded && !options.bookingCreate ? "Next booking step: Schedule" : "Next booking step: Service address"}</span></div>
      ${options.priceNotice ? '<section class="cab-inspection-price" data-price-notice role="status" aria-live="polite" hidden></section>' : ''}<div class="cab-workspace"><div class="cab-main"><section data-panel="1" aria-labelledby="cabApplianceHeading"><h3 id="cabApplianceHeading" tabindex="-1">${options.repair ? 'Which appliance needs repair?' : 'Which appliance needs service?'}</h3><p class="cab-note">You can add another appliance after this one.</p><fieldset class="cab-appliances"><legend class="cab-sr-only">Choose an appliance</legend>${repairChoices || A.kinds.map((kind, index) => `<label><input type="radio" name="kind" value="${kind}" ${index === 0 ? 'checked' : ''}><span><i class="bi ${kind === 'aircon' ? 'bi-snow' : kind === 'refrigerator' ? 'bi-door-closed' : 'bi-box'}" aria-hidden="true"></i><strong>${A.labels[kind]}</strong><small>${kind === 'aircon' ? 'Type and HP pricing' : 'Services set by staff'}</small></span></label>`).join('')}</fieldset></section>
      <section data-panel="2" hidden aria-labelledby="cabDetailsHeading"><h3 id="cabDetailsHeading" tabindex="-1">Tell us about your appliance</h3><p class="cab-note" data-details-required>Fields marked * are required.</p>${canAsk() ? `<div class="cab-unit-help"><button type="button" class="cab-secondary" data-unit-help aria-expanded="false" aria-controls="cabHelpOptions">I don&#39;t know my unit details</button><p>Choose staff confirmation or get help reading your unit label with RACS Ready AI.</p></div><section id="cabHelpOptions" class="cab-help-options" data-help-options hidden aria-labelledby="cabHelpHeading"><h4 id="cabHelpHeading">How would you like help?</h4><p>Staff must confirm unidentified details before you book. AI can help you understand the text on your unit label.</p><div class="cab-help-choices"><button type="button" data-help-staff><i class="bi bi-person-check" aria-hidden="true"></i><span><strong>Ask staff to identify my unit</strong><small>Choose a service next, then confirm and send your request. Staff will check the details and send a price for your approval.</small></span></button><button type="button" data-help-ai><i class="bi bi-chat-dots" aria-hidden="true"></i><span><strong>Use RACS Ready AI</strong><small>Open the assistant to help read the brand, model, type and HP on your label. Your booking progress is kept.</small></span></button></div><p>No payment or schedule is confirmed by choosing help.</p></section>` : ''}<div data-unit-details class="cab-detail-card"><div class="cab-detail-intro"><span class="cab-detail-icon" aria-hidden="true"><i class="bi bi-sliders"></i></span><div><strong data-detail-appliance></strong><p data-detail-caption></p></div></div><div class="cab-fields"><label>Brand *<select name="brand" required aria-label="Brand"></select></label><label hidden>Other brand *<input name="brandCustom" maxlength="80" placeholder="Enter the brand on the label" autocomplete="off" disabled></label>${options.repair ? '<label>Model number <span class="cab-optional">optional</span><input name="model" maxlength="50" placeholder="Example: 42KDPV48" autocomplete="off"><small class="cab-field-hint">Add it if you can read it on the appliance label.</small></label>' : '<input name="model" type="hidden">'}</div><div class="cab-fields" data-aircon-details><label ${options.repair ? 'hidden' : ''}>Aircon type *<select name="airconType" required></select></label><label>Aircon capacity (HP) *<select name="hp" required aria-label="Aircon capacity (HP)"></select><small class="cab-field-hint">Choose the HP shown on the unit label.</small></label></div>
      <div class="cab-fields" data-compressor-details hidden><label>Compressor HP <span class="cab-optional">if known</span><select name="compressorHp"></select></label><p class="cab-note">Use the HP on the compressor label. It is needed only for services priced by HP.</p></div></div><div class="cab-quantity" ${options.repair ? 'hidden' : ''}><div><label for="cabQuantity">Number of appliances *</label><p>Use one group for appliances with the same details and services.</p></div><div class="cab-stepper"><button type="button" data-minus aria-label="Decrease appliance quantity">−</button><input id="cabQuantity" name="quantity" type="number" min="1" max="40" step="1" inputmode="numeric" value="1" required aria-describedby="cabUnitLimit cabQuantityFeedback"><button type="button" data-plus aria-label="Increase appliance quantity">+</button></div></div><p class="cab-limit" id="cabUnitLimit" data-limit ${options.repair ? 'hidden' : ''}></p><p class="cab-quantity-feedback" id="cabQuantityFeedback" data-quantity-feedback role="status" aria-live="polite"></p>${canAsk() ? '<p class="cab-note cab-identification-note">Choose staff assistance to request confirmation. No payment or schedule is taken until your unit details and price are confirmed.</p>' : '<a class="cab-help" href="/unit-assistance">Not sure about the type or HP? Request help with your unit.</a>'}</section>
      <section data-panel="3" hidden aria-labelledby="cabServicesHeading"><div data-service-picker><h3 id="cabServicesHeading" tabindex="-1">Choose the services you need</h3><p class="cab-note">Aircon Relocation is a separate booking for one aircon and cannot be combined with other services.</p><p class="cab-note" data-services-intro>Select one or more services for the same appliance.</p><div class="cab-appliance-summary" data-service-appliance></div><div data-services></div></div><section class="cab-relocation" data-relocation-config hidden aria-labelledby="cabMoveHeading"><h4 id="cabMoveHeading">Where will the aircon move?</h4><p class="cab-note">We will use the brand, type and HP you already selected.</p><fieldset class="cab-move-scopes"><legend class="cab-sr-only">Relocation distance</legend><label><input type="radio" name="moveScope" value="same_property"><span><strong>Nearby, on the same property</strong><small>For example, from the living room to a bedroom.</small></span></label><label><input type="radio" name="moveScope" value="different_address"><span><strong>A different address</strong><small>Pin the current and new addresses, then choose a date and time.</small></span></label></fieldset><div class="cab-fields" data-nearby-fields hidden><label>Current position *<input name="moveFrom" minlength="2" maxlength="500" placeholder="e.g. Living room, ground floor"></label><label>New position *<input name="moveTo" minlength="2" maxlength="500" placeholder="e.g. Bedroom, ground floor"></label></div><p class="cab-note" data-move-address-note hidden>Relocation is booked on its own for one aircon. Your selected type and HP determine the service price. Choose both map pins in the next step, then follow the normal schedule and payment steps.</p></section>${(canAsk() || hooks.repair) ? `<section class="cab-assistance" data-assistance hidden aria-labelledby="cabIdentificationHeading"><div class="cab-selected-request" data-selected-request hidden><strong data-selected-request-summary></strong><button type="button" class="cab-secondary" data-change-service>Change service</button></div><h4 id="cabIdentificationHeading" data-identification-heading tabindex="-1">Help us identify your unit</h4><p class="cab-note">Request one service for verification. After your unit is identified, you can add other services using the confirmed details. No payment or schedule is taken yet.</p><label>Photos <span class="cab-optional">optional</span><input type="file" name="assistancePhotos" accept="image/jpeg,image/png,image/webp" multiple><small data-photo-guidance>Up to two photos: the appliance and its model sticker. JPG, PNG or WEBP, up to 5 MB each. If you cannot take a photo, staff will contact you.</small></label><p data-photo-feedback class="cab-photo-feedback" role="status"></p><label>What do you know about the unit? <span class="cab-optional">optional</span><textarea name="assistanceNotes" maxlength="1000" rows="3" placeholder="For example, wall-mounted aircon in the bedroom"></textarea></label></section>` : ''}<section class="cab-confirmation" data-request-confirmation hidden aria-labelledby="cabConfirmHeading"><h4 id="cabConfirmHeading" data-confirm-heading tabindex="-1">Send this request to staff?</h4><p data-confirm-summary></p><p>Staff will identify your unit and send a price for you to review and accept. This request does not book a schedule or take payment.</p><div class="cab-actions"><button type="button" class="cab-secondary" data-keep-editing>Keep editing</button><button type="button" class="cab-primary" data-send-request>Confirm and send request</button></div></section></section></div>
      <aside class="cab-summary" aria-label="Appliance service estimate"><span class="cab-eyebrow">YOUR SELECTION</span><strong data-summary-appliance></strong><span data-count></span><div class="cab-summary-price"><small>${options.repair ? 'Inspection fee total' : 'Estimated service total'}</small><strong data-total></strong></div><small data-duration></small><p>Travel fee is added once for the visit.</p></aside></div>
      <div class="cab-footer">${typeof hooks.review === 'function' ? bookingCounter('data-footer-capacity') : ''}<p data-feedback role="status" aria-live="polite"></p><p data-guidance></p><div class="cab-actions"><button type="button" class="cab-secondary" data-cancel hidden>Cancel changes</button><button type="button" class="cab-secondary" data-back hidden>Back</button><button type="button" class="cab-primary" data-next>Next: appliance details</button><button type="submit" data-submit class="cab-primary" hidden>Add to booking</button></div></div></div>
      <section class="cab-success" data-success hidden><span class="cab-success-icon" aria-hidden="true">✓</span><h3 tabindex="-1">Added to your booking</h3><p data-saved-details></p>${bookingCounter('data-saved-total')}<div class="cab-success-next"><strong data-success-next-title>Next: Service address</strong><p data-success-next-copy>Tell us where the service will happen. Then choose your schedule and review your booking.</p></div><div class="cab-actions"><button type="button" class="cab-secondary" data-new>Add another appliance</button><button type="button" class="cab-primary" data-address>Continue to service address</button></div><a class="cab-help" data-request-link href="/unit-assistance" hidden>View request and staff quote</a></section></${formTag}>`;
    if (options.allowDifferentAddressRelocation === false) {
      host.querySelector('[name="moveScope"][value="different_address"]').closest("label").hidden = true;
    }
    const ids = new Map();
    host.querySelectorAll('[id]').forEach(node => { const original = node.id; node.dataset.builderId = original; node.id = host.id + '-' + original; ids.set(original, node.id); });
    host.querySelectorAll('[for],[aria-controls],[aria-labelledby],[aria-describedby]').forEach(node => {
      for (const attribute of ['for','aria-controls','aria-labelledby','aria-describedby']) {
        if (node.hasAttribute(attribute)) node.setAttribute(attribute, node.getAttribute(attribute).split(' ').map(id => ids.get(id) || id).join(' '));
      }
    });
    if (options.repair) {
      host.querySelector('[data-step="3"] strong').textContent = 'Problem';
      host.querySelector('[data-builder-id="cabServicesHeading"]').textContent = 'Your repair inspection';
      host.querySelector('[data-service-picker] > .cab-note').hidden = true;
      host.querySelector('[data-change-service]').hidden = true;
      host.querySelector('[data-details-required]').textContent = options.guideFields ? 'Fields marked * are required. Follow the next-field guide below.' : 'Fields marked * are required. The problem form opens automatically when you finish these details.';
      host.querySelector('[data-assistance] h4').textContent = 'Describe the problem';
      host.querySelector('[data-assistance] p').textContent = 'Describe what happened. Repair work is quoted after inspection and needs your approval.';
      const notes = field('assistanceNotes'); notes.required = true; notes.minLength = 10; notes.maxLength = 500; notes.placeholder = 'Tell us what happened, in at least 10 characters.';
      notes.parentElement.firstChild.textContent = 'Problem description * ';
      notes.parentElement.querySelector('.cab-optional')?.remove();
      if (hooks.problemSuggestions) {
        const suggestions = document.createElement('div');
        suggestions.className = 'cab-problem-suggestions'; suggestions.dataset.problemSuggestions = '';
        notes.parentElement.before(suggestions);
      }
      field('assistancePhotos').closest('label').hidden = options.photos === false;
    }
    if (options.multiUnit && !options.repair && window.CoreApplianceBatch) {
      batch = window.CoreApplianceBatch.mount({ host, catalog, selection, step: () => step, guided: options.guideFields && Boolean(window.ApplianceFieldGuide),
        enabled: () => !helpOpen && !detailsUnknown && !selectedRelocation() && !hooks.state.selectedServices.some(row => row.applianceGroupId === editingId && row.assistanceRequestId),
        update: updateTotal, changed,
        restoreShared: unit => {
          setBrand(unit.brand); field('model').value = unit.model || '';
          field('airconType').value = unit.airconType || ''; refreshHp(); field('hp').value = unit.hp || '';
          refreshServices(); host.querySelectorAll('[name="service"]').forEach(input => { input.checked = unit.serviceIds.includes(input.value); });
        },
        help: index => {
          const unit = batch.model.activeUnits()[index];
          if (window.RACSChat?.openUnitIdentification) {
            window.RACSChat.openUnitIdentification({ applianceKind: 'aircon', applianceLabel: `Aircon ${index + 1}`, brand: unit.brand, airconType: unit.airconType, hp: unit.hp });
            message(`RACS Ready AI is open for Aircon ${index + 1}. Your unit details are saved while you check the label.`);
          } else message('Use the appliance label to find the brand, type and HP. Staff confirmation is available from the unit details help options.', true);
        },
      });
      host.querySelector('.cab-quantity > div > p').textContent = 'Set the number first. You can enter shared details or adjust each unit below.';
    }
    if (options.guideFields && window.ApplianceFieldGuide) {
      guide = window.ApplianceFieldGuide.mount({ host, fields: guidanceFields,
        enabled: () => step === 2 && !saved && !helpOpen && !detailsUnknown,
        nextButton: () => host.querySelector('[data-next]'),
        continueLabel: options.repair ? 'Next: describe the problem' : 'Choose services',
      });
    }
    host.addEventListener('change', event => {
      closeConfirmation();
      if (event.target.name === 'kind') { batch?.reset(); detailsUnknown = false; helpOpen = false; if (field('assistancePhotos')) field('assistancePhotos').value = ''; if (field('assistanceNotes')) field('assistanceNotes').value = ''; host.querySelectorAll('[name="service"]').forEach(input => { input.checked = false; }); reached = 1; refreshTypes(); }
      else if (event.target.name === 'airconType') refreshHp(); else if (['hp', 'compressorHp'].includes(event.target.name)) refreshServices(); else updateTotal();
      if (event.target.name === 'brand') { syncBrand(); if (!guide && field('brand').value === '__other__') field('brandCustom').focus(); }
      if (hooks.repair && !hooks.guideFields && step === 2 && ['brand', 'hp'].includes(event.target.name) && detailsValid()) next();
      if (event.target.name === 'service' && event.target.checked && A.isRelocation(catalog.find(service => String(service._id) === event.target.value))) {
        const heading = host.querySelector('[data-builder-id="cabMoveHeading"]'); heading.tabIndex = -1;
        heading.focus({ preventScroll: true }); heading.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      }
      if (event.target.name === 'service' && event.target.checked && canAsk()) {
        const verification = event.target.hasAttribute('data-verification');
        host.querySelectorAll('[name="service"]:checked').forEach(input => {
          if (input !== event.target && (verification || input.hasAttribute('data-verification'))) input.checked = false;
        }); assistanceOpen = verification; updateTotal();
        if (verification) {
          const heading = host.querySelector('[data-identification-heading]');
          heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
          message('Add photos or notes if you have them, then review your staff request.');
        }
      }
      changed();
    });
    host.addEventListener('input', event => { if (['quantity', 'brand', 'brandCustom', 'model', 'moveFrom', 'moveTo', 'assistanceNotes'].includes(event.target.name)) { closeConfirmation(); if (event.target.name === 'quantity') host.querySelector('[data-quantity-feedback]').textContent = ''; updateTotal(); changed(); } });
    host.addEventListener('focusout', advanceCompletedRepairDetails);
    field('quantity').addEventListener('blur', () => { syncLimit(true); updateTotal(); });
    host.addEventListener('click', event => {
      const symptom = event.target.closest('[data-problem-suggestion]');
      if (symptom && hooks.repair) {
        const choice = hooks.problemSuggestions?.(selection()).find(row => row.text === symptom.dataset.problemSuggestion);
        if (choice) {
          const notes = field('assistanceNotes');
          try { notes.value = hooks.toggleProblem(notes.value, choice.text, notes.maxLength); notes.dispatchEvent(new Event('input', { bubbles: true })); notes.focus({ preventScroll: true }); }
          catch (error) { message(error.message, true); }
        }
      }
      const review = event.target.closest('[data-booking-review]');
      if (review && host.contains(review)) hooks.review?.(event);
      if (event.target.closest('[data-unit-help]')) chooseHelp(helpOpen ? 'manual' : 'choice');
      if (event.target.closest('[data-help-staff]') && canAsk()) {
        if (!syncLimit(true)) return message('Check the appliance quantity before choosing services.', true);
        chooseHelp('staff');
      }
      if (event.target.closest('[data-help-ai]')) chooseHelp('ai');
      if (event.target.closest('[data-change-service]')) {
        closeConfirmation(); assistanceOpen = false;
        host.querySelectorAll('[name="service"]').forEach(input => { input.checked = false; });
        updateTotal(); changed();
        const heading = host.querySelector('[data-builder-id="cabServicesHeading"]'); heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      if (event.target.closest('[data-keep-editing]')) { closeConfirmation(); updateTotal(); host.querySelector('[data-submit]').focus(); }
      if (event.target.closest('[data-send-request]') && confirmationOpen && !sending) {
        const input = host.querySelector('[name="service"]:checked');
        if (detailsValid() && input?.hasAttribute('data-verification') && canAsk()) void requestAssistance(selection(), catalog.find(service => String(service._id) === input.value));
      }
      if (event.target.closest('[data-repair]')) { reset(); document.getElementById('repair-tab')?.click(); }
      if (event.target.closest('[data-cancel]') || event.target.closest('[data-new]')) reset();
      if (event.target.closest('[data-next]')) next();
      if (event.target.closest('[data-back]')) {
        if (step === 3 && assistanceOpen && !hooks.repair) { host.querySelector('[data-change-service]').click(); }
        else setStep(step - 1);
      }
      if (event.target.closest('[data-minus]') || event.target.closest('[data-plus]')) { closeConfirmation(); field('quantity').value = String(Math.max(1, Math.min(available(), Number(field('quantity').value) + (event.target.closest('[data-plus]') ? 1 : -1)))); updateTotal(); changed(); }
      const progress = event.target.closest('.cab-progress button[data-step]'); if (progress && host.contains(progress) && !progress.disabled) { const target = Number(progress.dataset.step); if (target === 3 && !detailsValid()) return setStep(2); setStep(target); }
      if (event.target.closest('[data-address]')) hooks.next?.();
    });
    const submit = event => {
      event.preventDefault(); event.stopPropagation(); if (saved) return; if (step < 3) return next();
      const button = host.querySelector('[data-submit]'); if (button.disabled) return;
      if (!detailsValid()) { setStep(2); message('Check your appliance details before adding services.', true); return; } button.disabled = true;
      if (batch?.active()) {
        try {
          const rows = batch.model.rows(), state = batch.model.estimate(), edited = Boolean(editingId);
          window.ApplianceServices.assertServiceTypes(outsideRows().concat(rows));
          window.ApplianceServices.assertStandaloneServices(outsideRows().concat(rows));
          hooks.commit(rows, editingId);
          success({ applianceKind: 'aircon', quantity: state.count }, Array(state.tasks), edited);
        } catch (error) { message(error.message, true); updateTotal(); }
        return;
      }
      const selected = selection(), verification = [...host.querySelectorAll('[name="service"]:checked')].find(input => input.hasAttribute('data-verification'));
      const validation = hooks.validate?.(selected);
      if (validation) { updateTotal(); return message(validation, true); }
      if (verification && canAsk()) { updateTotal(); return showConfirmation(selected, catalog.find(service => String(service._id) === verification.value)); }
      try { const selected = selection(), ids = [...host.querySelectorAll('[name="service"]:checked')].map(input => input.value), edited = Boolean(editingId); const rows = A.serviceLines(catalog, selected, ids, editingId || `appliance_${crypto.randomUUID()}`, relocationSelection()); window.ApplianceServices.assertStandaloneServices(outsideRows().concat(rows)); hooks.commit(rows, editingId); success(selected, ids, edited); }
      catch (error) { message(error.message, true); updateTotal(); }
    };
    if (options.embedded) {
      host.querySelector('[data-submit]').addEventListener('click', submit);
      host.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target.matches('input:not([type=radio]):not([type=checkbox])')) {
          event.preventDefault(); event.stopPropagation();
          if (step < 3) next(); else submit(event);
        }
      });
    } else host.querySelector('form').addEventListener('submit', submit);
    refreshTypes(); setStep(1, false); restoreDraft(initialDraft);
  }
  function reset(focus = true) {
    assistanceUpdates?.stop(); assistanceUpdates = null;
    batch?.reset();
    assistanceOpen = false;
    editingId = null; reached = 1; saved = false; savedMove = null; detailsUnknown = false; helpOpen = false;
    assistanceReceipt = null; requestToken = null; requestFingerprint = null;
    const form = host.querySelector('form');
    if (form) form.reset();
    else host.querySelectorAll('input, select, textarea').forEach(input => {
      if (['radio', 'checkbox'].includes(input.type)) input.checked = input.defaultChecked;
      else if (input.tagName === 'SELECT') input.selectedIndex = 0;
      else input.value = input.defaultValue;
    });
    host.querySelectorAll('[name="service"]').forEach(input => { input.checked = false; });
    host.querySelector('[data-quantity-feedback]').textContent = '';
    host.querySelector('[data-submit]').textContent = 'Add to booking'; host.querySelector('[data-cancel]').hidden = true; refreshTypes(); setStep(1, focus);
  }
  function edit(groupId) {
    const rows = hooks.state.selectedServices.filter(item => (hooks.repair ? String(item.id || item._id || '') : item.applianceGroupId || String(item.id || item._id || '')) === String(groupId)), item = rows[0]; if (!item) return;
    batch?.reset(); editingId = groupId; saved = false; reached = 3; detailsUnknown = false; helpOpen = false; setKind(hooks.kindFor?.(item) || item.applianceKind || 'aircon');
    host.querySelectorAll('[name="service"]').forEach(input => { input.checked = false; });
    savedMove = rows.find(row => row.relocation)?.relocation || null;
    host.querySelectorAll('[name="moveScope"]').forEach(input => { input.checked = input.value === savedMove?.scope; });
    field('moveFrom').value = savedMove?.from?.details || ''; field('moveTo').value = savedMove?.to?.details || '';
    setBrand(item.brand); field('model').value = item.model || ''; field('quantity').value = item.quantity;
    refreshTypes(); field('airconType').value = item.airconType || ''; refreshHp(); field('hp').value = item.hp || ''; field('compressorHp').value = item.hp || ''; refreshServices();
    host.querySelectorAll('[name="service"]').forEach(input => { input.checked = !input.disabled && rows.some(row => String(hooks.serviceIdFor?.(row) || row.serviceId) === input.value); });
    if (batch && !hooks.repair && (item.applianceKind || 'aircon') === 'aircon' && Number(item.quantity) > 1 && !savedMove && !item.assistanceRequestId) {
      const serviceIds = rows.map(row => String(row.serviceId));
      batch.restore({ version: 1, detailsMode: 'shared', servicesMode: 'shared', sharedServices: serviceIds,
        units: Array.from({ length: Number(item.quantity) }, (_, index) => ({ ...item,
          key: index === 0 ? String(groupId) : `appliance_${crypto.randomUUID()}`, serviceIds,
        })),
      });
    }
    host.querySelector('[data-submit]').textContent = 'Save changes'; host.querySelector('[data-cancel]').hidden = false; host.querySelector('[data-quantity-feedback]').textContent = ''; setStep(2); message('Changes apply to all services for this appliance.');
  }
  function sync() { if (!mounted) return; updateTotal(); if (saved) { host.querySelector('[data-saved-total]').textContent = `${A.unitCount(hooks.state.selectedServices)} / 40 appliances in your booking`; host.querySelector('[data-address]').disabled = !hooks.state.selectedServices.length; } }
  function syncProblemSuggestions() {
    const container = host.querySelector('[data-problem-suggestions]');
    if (!container || !hooks.problemSuggestions) return;
    const lines = field('assistanceNotes').value.split('\n').map(line => line.trim());
    const choices = hooks.problemSuggestions(selection());
    const signature = JSON.stringify([choices, lines]);
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature;
    container.innerHTML = '<p class="cab-note">Common problems: choose any that apply, then add details below. These are symptoms, not a diagnosis.</p><div role="group" aria-label="Suggested appliance problems">' + choices.map(choice => `<button type="button" data-problem-suggestion="${escape(choice.text)}" aria-pressed="${lines.includes(choice.text)}">${escape(choice.label)}</button>`).join('') + '</div>';
  }
  function pending() {
    return mounted && !saved && Boolean(editingId || helpOpen || detailsUnknown || hooks.repair && field('kind').value || field('brand').value.trim() || hooks.repair && field('model').value.trim() || field('airconType').value || field('hp').value || field('compressorHp').value || Number(field('quantity').value) !== 1 || host.querySelector('[name="service"]:checked'));
  }
  function start() { if (mounted && saved) reset(); }
  function chooseAppliance() {
    if (!mounted) return;
    if (saved) reset(false); else setStep(1, false);
    host.querySelector('[data-panel="1"] h3').focus({ preventScroll: true });
    host.querySelector('.cab-step-meta').scrollIntoView({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
    });
  }
  return { mount, edit, sync, pending, start, reset, chooseAppliance };
  }
  window.CoreApplianceBooking = Object.assign(create(), { create });
})();

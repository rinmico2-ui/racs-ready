(function () {
  'use strict';
  function create() {
  let catalog = [], hooks, host, editingId = null, mounted = false, step = 1, reached = 1, saved = false;
  let savedMove = null, detailsUnknown = false, helpOpen = false, confirmationOpen = false;
  let sending = false, requestToken = null, requestFingerprint = null, assistanceReceipt = null;
  let assistanceOpen = false;
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
      if (input.name && !['kind', 'service', 'moveScope'].includes(input.name)) values[input.name] = input.type === 'checkbox' ? input.checked : input.value;
    });
    return { kind: field('kind').value, values, services: [...host.querySelectorAll('[name="service"]:checked')].map(input => input.value),
      moveScope: host.querySelector('[name="moveScope"]:checked')?.value, detailsUnknown, helpOpen, assistanceOpen, step, reached, editingId, saved, assistanceReceipt, requestToken, requestFingerprint };
  }
  function changed() { hooks.changed?.(draft()); }
  function restoreDraft(data) {
    if (!data || !A.kinds.includes(data.kind) || data.saved && !data.assistanceReceipt) return;
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
    host.querySelectorAll('[name="moveScope"]').forEach(input => { input.checked = input.value === data.moveScope; });
    refreshServices();
    host.querySelectorAll('[name="service"]').forEach(input => { input.checked = !input.disabled && Array.isArray(data.services) && data.services.includes(input.value); });
    assistanceOpen = data.assistanceOpen !== false && Boolean(host.querySelector('[name="service"][data-verification]:checked'));
    editingId = typeof data.editingId === 'string' && hooks.state.selectedServices.some(row => (hooks.repair ? String(row.id || row._id || '') : row.applianceGroupId) === data.editingId) ? data.editingId : null;
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
  function syncMove() {
    const selected = selectedRelocation(), move = relocationSelection(), sameProperty = move.scope === 'same_property';
    host.querySelector('[data-relocation-config]').hidden = !selected;
    host.querySelectorAll('[name="moveScope"]').forEach(input => { input.required = selected; input.disabled = !selected; });
    host.querySelector('[data-nearby-fields]').hidden = !sameProperty;
    host.querySelector('[data-move-quote-note]').hidden = move.scope !== 'custom_quote';
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
    input.setCustomValidity(limit === 0 ? 'Your booking already has 40 appliances.' : !Number.isInteger(quantity) || quantity < 1 || quantity > limit ? `Enter a whole number from 1 to ${limit}.` : '');
    input.setAttribute('aria-invalid', String(limit > 0 && !input.validity.valid));
    if (limit > 0 && !input.validity.valid) feedback.textContent = `Enter a whole number from 1 to ${limit}.`;
    host.querySelectorAll('[data-capacity], [data-footer-capacity]').forEach(node => { node.textContent = `${A.unitCount(hooks.state.selectedServices)} / 40 appliances in your booking`; });
    host.querySelector('[data-limit]').textContent = limit > 0 ? `You can add ${limit} appliance${limit === 1 ? '' : 's'}${editingId ? ' in this group' : ' more'}. Maximum 40 per booking.` : 'Your booking has reached 40 appliances. Remove an item or edit an existing appliance to continue.';
    host.querySelector('[data-minus]').disabled = limit === 0 || !Number.isInteger(quantity) || quantity <= 1;
    host.querySelector('[data-plus]').disabled = limit === 0 || !Number.isInteger(quantity) || quantity >= limit;
    host.querySelector('[data-new]').disabled = !A.remainingUnits(hooks.state.selectedServices);
    return limit > 0 && input.validity.valid;
  }
  function detailsValid() {
    if (detailsUnknown) return available() > 0 && field('quantity').validity.valid;
    if (helpOpen) return false;
    return available() > 0 && requiredDetailFields().every(name => field(name).disabled || field(name).validity.valid) && Boolean(selection().brand);
  }
  function requiredDetailFields() { return ['brand', ...(field('brand').value === '__other__' ? ['brandCustom'] : []), ...(hooks.repair ? ['model'] : []), 'quantity', ...(aircon() ? hooks.repair ? ['hp'] : ['airconType', 'hp'] : [])]; }
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
    host.querySelector('[data-next]').textContent = step === 1 ? 'Next: appliance details' : 'Next: choose services';
    message(''); updateTotal();
    changed();
    if (focus) { const heading = host.querySelector(`[data-panel="${step}"] h3`); heading.focus({ preventScroll: true }); host.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
  }
  function next() {
    syncLimit(true);
    if (!available()) return message('Your booking already has 40 appliances. Edit or remove an item first.', true);
    if (step === 2 && !detailsValid()) {
      const invalid = requiredDetailFields().map(field).find(input => !input.disabled && (!input.validity.valid || input.name === 'brand' && !input.value.trim()));
      message('Complete the required appliance details before choosing services.', true); invalid?.focus(); invalid?.reportValidity(); return;
    }
    if (step < 3) { refreshServices(); setStep(step + 1); }
  }
  function advanceCompletedRepairDetails(event) {
    if (!hooks.repair || !['brand', 'brandCustom', 'model', 'hp'].includes(event.target.name)) return;
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
    catalog.filter(service => A.profile(service, 'aircon')).forEach(service => (service.airconTypes || []).forEach(type => types.set(type.type, type.name)));
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
    else catalog.forEach(service => (service.airconTypes?.find(row => row.type === type)?.hpPricing || service.hpPricing || []).forEach(row => sizes.add(Number(row.hp))));
    field('hp').innerHTML = '<option value="">Choose HP</option>' + [...sizes].sort((a, b) => a - b).map(hp => `<option value="${hp}">${hp} HP</option>`).join(''); field('hp').value = previous; refreshServices();
  }
  function refreshServices() {
    const checked = new Set([...host.querySelectorAll('[name="service"]:checked')].map(input => input.value)), selected = selection();
    const candidates = catalog.filter(service => service.active !== false && A.profile(service, selected.applianceKind) && (!A.isRelocation(service) || selected.applianceKind === 'aircon'));
    const typeName = selected.airconType ? field('airconType').selectedOptions[0]?.textContent : '';
    host.querySelector('[data-service-appliance]').textContent = [detailsUnknown ? 'Staff identification' : selected.brand, A.labels[selected.applianceKind], typeName, selected.hp ? `${selected.hp} HP` : '', `${selected.quantity || 0} appliance${selected.quantity === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    host.querySelector('[data-services]').innerHTML = candidates.map(service => {
      let pricing, error; try { pricing = A.price(service, { ...selected, brand: selected.brand || 'Brand not entered' }); } catch (err) { error = err.message; }
      if (canAsk() && (detailsUnknown || A.needsVerification(service, selected))) {
        return `<label class="cab-service"><input type="radio" name="service" value="${escape(service._id)}" data-verification ${checked.has(String(service._id)) ? 'checked' : ''}><span class="cab-service-copy"><strong>${escape(service.name)}</strong><small>Staff will confirm your unit details and send a price for approval.</small></span><span class="cab-service-price">Price pending verification</span></label>`;
      }
      if (A.isRelocation(service)) {
        const tooMany = selected.quantity !== 1;
        return `<label class="cab-service ${tooMany ? 'is-unavailable' : ''}"><input type="checkbox" name="service" value="${escape(service._id)}" ${tooMany ? 'disabled' : ''} ${!tooMany && checked.has(String(service._id)) ? 'checked' : ''}><span class="cab-service-copy"><strong>${escape(service.name)}</strong><small>${tooMany ? 'Add one aircon at a time for relocation.' : 'Move within the same property or to another address. Your aircon details are already saved above.'}</small></span><span class="cab-service-price">${pricing ? money(pricing.unitPrice) : 'Staff quote'}<small>nearby move estimate</small></span></label>`;
      }
      return `<label class="cab-service ${error ? 'is-unavailable' : ''}"><input type="checkbox" name="service" value="${escape(service._id)}" ${error ? 'disabled' : ''} ${pricing && checked.has(String(service._id)) ? 'checked' : ''}><span class="cab-service-copy"><strong>${escape(service.name)}</strong><small>${escape(error || service.description || 'Service for your selected appliance.')}</small></span><span class="cab-service-price">${pricing ? money(pricing.unitPrice) : 'Unavailable'}<small>${pricing ? `per appliance · ${pricing.duration} min` : 'Choose another service'}</small></span></label>`;
    }).join('') || '<div class="cab-empty"><strong>No services are available for this appliance yet.</strong><p>Choose another appliance, or use Repair Service if it needs an inspection.</p></div>';
    if (!canAsk() && selected.applianceKind !== 'aircon' && candidates.some(service => A.profile(service, selected.applianceKind)?.pricingMode === 'hp') && !selected.hp) host.querySelector('[data-services]').insertAdjacentHTML('beforeend', '<div class="cab-empty"><strong>Not sure about the compressor HP?</strong><p>You can book services with a fixed price, or request a repair inspection.</p><button type="button" class="cab-secondary" data-repair>Choose Repair Service</button></div>');
    updateTotal();
  }
  function updateTotal() {
    const assisted = helpOpen || detailsUnknown;
    host.querySelector('[data-unit-details]').hidden = assisted;
    host.querySelector('[data-details-required]').hidden = assisted;
    if (host.querySelector('[data-help-options]')) host.querySelector('[data-help-options]').hidden = !helpOpen;
    field('brand').disabled = assisted; field('brand').required = !assisted;
    field('model').disabled = assisted || !hooks.repair; field('model').required = !assisted && Boolean(hooks.repair);
    syncBrand();
    field('compressorHp').disabled = assisted || hooks.repair || field('kind').value === 'aircon';
    const model = field('model');
    model.setCustomValidity(!hooks.repair || assisted ? '' : !model.value.trim() ? 'Enter the appliance model number.' : /^[A-Za-z0-9][A-Za-z0-9 ._/#()+-]*$/.test(model.value.trim()) ? '' : 'Use letters, numbers, spaces, and . - _ / # ( ) + only.');
    ['airconType', 'hp'].forEach(name => { const enabled = aircon() && !assisted && (name === 'hp' || !hooks.repair); field(name).required = enabled; field(name).disabled = !enabled; });
    host.querySelector('[data-detail-appliance]').textContent = A.labels[field('kind').value] || 'Choose an appliance';
    host.querySelector('[data-detail-caption]').textContent = hooks.repair ? repairQuantity() > 1 ? `${repairQuantity()} appliances on this existing entry. Contact staff to change the quantity.` : 'One appliance per repair entry. Add another appliance separately.' : 'Choose the details shown on your appliance.';
    const help = host.querySelector('[data-unit-help]');
    if (help) { help.textContent = helpOpen ? 'Enter my unit details instead' : "I don't know my unit details"; help.setAttribute('aria-expanded', String(helpOpen)); help.disabled = Boolean(editingId); }
    host.querySelector('[data-services-intro]').textContent = detailsUnknown ? 'Choose one service for staff to confirm. You can add more services after your unit details are verified.' : hooks.repair ? 'Book an inspection for this appliance. Repair work is quoted after inspection.' : 'Select one or more services for the same appliance.';
    const validQuantity = syncLimit(), selected = selection(), ids = [...host.querySelectorAll('[name="service"]:checked')].map(input => input.value), moveValid = syncMove();
    const customMove = selectedRelocation() && relocationSelection().scope === 'custom_quote';
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
    host.querySelector('[data-total]').textContent = verification ? 'Price pending verification' : customMove ? 'Price after staff review' : ids.length && validQuantity ? money(total) : '—';
    host.querySelector('[data-count]').textContent = `${validQuantity ? selected.quantity : 0} appliance${selected.quantity === 1 ? '' : 's'} · ${ids.length} service${ids.length === 1 ? '' : 's'}`;
    host.querySelector('[data-duration]').textContent = verification ? 'Staff will confirm the price and work time.' : customMove ? 'Staff will confirm work time with your quote.' : minutes ? `${minutes} minutes of service work` : 'Prices appear after you choose services.';
    host.querySelector('[data-submit]').disabled = sending || confirmationOpen || saved || !ids.length || !validQuantity || !detailsValid() || !moveValid || photosInvalid || Boolean(hooks.validate?.(selected)) || verification && (!identifying || ids.length !== 1 || Boolean(editingId));
    host.querySelector('[data-submit]').textContent = sending ? 'Sending request…' : verification ? 'Review staff request' : editingId ? 'Save changes' : customMove ? 'Add relocation request' : 'Add to booking';
    host.querySelector('[data-next]').disabled = !available() || !A.kinds.includes(field('kind').value) || step === 2 && !detailsValid();
    host.querySelector('[data-summary-appliance]').textContent = `${detailsUnknown ? 'Staff identification' : selected.brand || 'Your appliance'} · ${A.labels[selected.applianceKind] || 'Choose an appliance'}`;
    host.querySelector('[data-guidance]').textContent = !available() ? 'Your booking has 40 appliances. Edit or remove an item before adding another.' : step === 1 ? hooks.repair ? 'Next, add the details for this appliance.' : 'Next, add the appliance details and quantity.' : step === 2 ? helpOpen ? 'Choose staff assistance or use AI to help read your unit label.' : 'Fill in the required fields to see matching services and prices.' : detailsUnknown ? 'Choose a service, then review and confirm your request to staff.' : 'Choose services, then add this appliance to your booking.';
  }
  function success(selected, ids, edited) {
    assistanceReceipt = null;
    saved = true; editingId = null; host.querySelector('[data-wizard]').hidden = true; host.querySelector('[data-success]').hidden = false;
    host.querySelector('[data-success] h3').textContent = edited ? 'Your changes are saved' : 'Added to your booking';
    host.querySelector('[data-saved-details]').textContent = `${selected.quantity} ${A.labels[selected.applianceKind].toLowerCase()}${selected.quantity > 1 ? 's' : ''} · ${ids.length} service${ids.length > 1 ? 's' : ''}`;
    host.querySelector('[data-saved-total]').textContent = `${A.unitCount(hooks.state.selectedServices)} / 40 appliances in your booking`;
    host.querySelector('[data-address]').disabled = !hooks.state.selectedServices.length; host.querySelector('[data-new]').disabled = !A.remainingUnits(hooks.state.selectedServices); host.querySelector('[data-success] h3').focus({ preventScroll: true });
    const move = hooks.state.selectedServices.find(row => row.relocation)?.relocation;
    host.querySelector('[data-success-next-title]').textContent = move ? 'Next: Relocation locations' : 'Next: Service address';
    host.querySelector('[data-success-next-copy]').textContent = move?.scope === 'custom_quote' ? 'Choose the current address first, then the new address. Pick a preferred date and send the request for a staff quote.' : move ? 'Pin the current property. Your current and new positions are saved with the aircon details.' : 'Tell us where the service will happen. Then choose your schedule and review your booking.';
    host.querySelector('[data-address]').textContent = move ? 'Continue to locations' : 'Continue to service address';
    if (hooks.embedded) {
      host.querySelector('[data-success-next-title]').textContent = 'Next: Review your schedule';
      host.querySelector('[data-success-next-copy]').textContent = 'Check whether your updated services need a new date or more time, then save your booking changes.';
      host.querySelector('[data-address]').textContent = 'Review schedule';
    }
    if (move?.scope === 'custom_quote') host.querySelector('[data-new]').disabled = true;
    host.querySelector('[data-request-link]')?.setAttribute('hidden', ''); changed();
  }
  function showAssistanceSuccess() {
    saved = true; editingId = null;
    host.querySelector('[data-wizard]').hidden = true; host.querySelector('[data-success]').hidden = false;
    host.querySelector('[data-success] h3').textContent = 'Request sent for verification';
    host.querySelector('[data-saved-details]').textContent = assistanceReceipt.label;
    host.querySelector('[data-saved-total]').textContent = `${A.unitCount(hooks.state.selectedServices)} / 40 appliances in your booking`;
    host.querySelector('[data-success-next-title]').textContent = 'Next: Staff confirms your unit and price';
    host.querySelector('[data-success-next-copy]').textContent = 'We will contact you if more details are needed. Review and accept the quote in Unit assistance before booking this service. No payment or schedule is taken for this request.';
    host.querySelector('[data-address]').textContent = 'Continue with added services'; host.querySelector('[data-address]').disabled = !hooks.state.selectedServices.length;
    host.querySelector('[data-new]').disabled = !A.remainingUnits(hooks.state.selectedServices);
    host.querySelector('[data-request-link]').hidden = false;
    host.querySelector('[data-success] h3').focus({ preventScroll: true }); changed();
  }
  async function requestAssistance(selected, service) {
    if (sending) return;
    const files = Array.from(field('assistancePhotos')?.files || []);
    const validation = hooks.validate?.(selected);
    if (validation) { updateTotal(); return message(validation, true); }
    if (files.length > 2 || files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)) { updateTotal(); return message('Choose up to two JPG, PNG, or WEBP photos, 5 MB each.', true); }
    const fingerprint = JSON.stringify([selected, service._id, field('assistanceNotes').value.trim(), A.isRelocation(service) ? relocationSelection() : null]);
    if (A.isRelocation(service) && relocationSelection().scope === 'custom_quote') { updateTotal(); return message('A move to another address needs confirmed unit details and a separate relocation quote. Contact our team if you need help identifying this unit.', true); }
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
      <div data-wizard><nav class="cab-progress" aria-label="Appliance service steps">${['Appliance', 'Details', 'Services'].map((name, index) => `<button type="button" data-step="${index + 1}" ${index ? 'disabled' : ''}><span>${index + 1}</span><strong>${name}</strong></button>`).join('')}</nav><div class="cab-step-meta"><span data-step-label></span><span>${options.embedded ? "Next booking step: Schedule" : "Next booking step: Service address"}</span></div>
      <div class="cab-workspace"><div class="cab-main"><section data-panel="1" aria-labelledby="cabApplianceHeading"><h3 id="cabApplianceHeading" tabindex="-1">${options.repair ? 'Which appliance needs repair?' : 'Which appliance needs service?'}</h3><p class="cab-note">You can add another appliance after this one.</p><fieldset class="cab-appliances"><legend class="cab-sr-only">Choose an appliance</legend>${repairChoices || A.kinds.map((kind, index) => `<label><input type="radio" name="kind" value="${kind}" ${index === 0 ? 'checked' : ''}><span><i class="bi ${kind === 'aircon' ? 'bi-snow' : kind === 'refrigerator' ? 'bi-door-closed' : 'bi-box'}" aria-hidden="true"></i><strong>${A.labels[kind]}</strong><small>${kind === 'aircon' ? 'Type and HP pricing' : 'Services set by staff'}</small></span></label>`).join('')}</fieldset></section>
      <section data-panel="2" hidden aria-labelledby="cabDetailsHeading"><h3 id="cabDetailsHeading" tabindex="-1">Tell us about your appliance</h3><p class="cab-note" data-details-required>Fields marked * are required.</p>${canAsk() ? `<div class="cab-unit-help"><button type="button" class="cab-secondary" data-unit-help aria-expanded="false" aria-controls="cabHelpOptions">I don&#39;t know my unit details</button><p>Choose staff confirmation or get help reading your unit label with RACS Ready AI.</p></div><section id="cabHelpOptions" class="cab-help-options" data-help-options hidden aria-labelledby="cabHelpHeading"><h4 id="cabHelpHeading">How would you like help?</h4><p>Staff must confirm unidentified details before you book. AI can help you understand the text on your unit label.</p><div class="cab-help-choices"><button type="button" data-help-staff><i class="bi bi-person-check" aria-hidden="true"></i><span><strong>Ask staff to identify my unit</strong><small>Choose a service next, then confirm and send your request. Staff will check the details and send a price for your approval.</small></span></button><button type="button" data-help-ai><i class="bi bi-chat-dots" aria-hidden="true"></i><span><strong>Use RACS Ready AI</strong><small>Open the assistant to help read the brand, model, type and HP on your label. Your booking progress is kept.</small></span></button></div><p>No payment or schedule is confirmed by choosing help.</p></section>` : ''}<div data-unit-details class="cab-detail-card"><div class="cab-detail-intro"><span class="cab-detail-icon" aria-hidden="true"><i class="bi bi-sliders"></i></span><div><strong data-detail-appliance></strong><p data-detail-caption></p></div></div><div class="cab-fields"><label>Brand *<select name="brand" required aria-label="Brand"></select></label><label hidden>Other brand *<input name="brandCustom" maxlength="80" placeholder="Enter the brand on the label" autocomplete="off" disabled></label>${options.repair ? '<label>Model number *<input name="model" required maxlength="50" placeholder="Example: 42KDPV48" autocomplete="off"><small class="cab-field-hint">Look for the model on the appliance label.</small></label>' : '<input name="model" type="hidden">'}</div><div class="cab-fields" data-aircon-details><label ${options.repair ? 'hidden' : ''}>Aircon type *<select name="airconType" required></select></label><label>Aircon capacity (HP) *<select name="hp" required aria-label="Aircon capacity (HP)"></select><small class="cab-field-hint">Choose the HP shown on the unit label.</small></label></div>
      <div class="cab-fields" data-compressor-details hidden><label>Compressor HP <span class="cab-optional">if known</span><select name="compressorHp"></select></label><p class="cab-note">Use the HP on the compressor label. It is needed only for services priced by HP.</p></div></div><div class="cab-quantity" ${options.repair ? 'hidden' : ''}><div><label for="cabQuantity">Number of appliances *</label><p>Use one group for appliances with the same details and services.</p></div><div class="cab-stepper"><button type="button" data-minus aria-label="Decrease appliance quantity">−</button><input id="cabQuantity" name="quantity" type="number" min="1" max="40" step="1" inputmode="numeric" value="1" required aria-describedby="cabUnitLimit cabQuantityFeedback"><button type="button" data-plus aria-label="Increase appliance quantity">+</button></div></div><p class="cab-limit" id="cabUnitLimit" data-limit ${options.repair ? 'hidden' : ''}></p><p class="cab-quantity-feedback" id="cabQuantityFeedback" data-quantity-feedback role="status" aria-live="polite"></p>${canAsk() ? '<p class="cab-note cab-identification-note">Choose staff assistance to request confirmation. No payment or schedule is taken until your unit details and price are confirmed.</p>' : '<a class="cab-help" href="/unit-assistance">Not sure about the type or HP? Request help with your unit.</a>'}</section>
      <section data-panel="3" hidden aria-labelledby="cabServicesHeading"><div data-service-picker><h3 id="cabServicesHeading" tabindex="-1">Choose the services you need</h3><p class="cab-note" data-services-intro>Select one or more services for the same appliance.</p><div class="cab-appliance-summary" data-service-appliance></div><div data-services></div></div><section class="cab-relocation" data-relocation-config hidden aria-labelledby="cabMoveHeading"><h4 id="cabMoveHeading">Where will the aircon move?</h4><p class="cab-note">We will use the brand, type and HP you already selected.</p><fieldset class="cab-move-scopes"><legend class="cab-sr-only">Relocation distance</legend><label><input type="radio" name="moveScope" value="same_property"><span><strong>Nearby, on the same property</strong><small>For example, from the living room to a bedroom.</small></span></label><label><input type="radio" name="moveScope" value="custom_quote"><span><strong>Another address or a distant position</strong><small>Choose both addresses on the next map step. Staff will send a quote.</small></span></label></fieldset><div class="cab-fields" data-nearby-fields hidden><label>Current position *<input name="moveFrom" minlength="2" maxlength="500" placeholder="e.g. Living room, ground floor"></label><label>New position *<input name="moveTo" minlength="2" maxlength="500" placeholder="e.g. Bedroom, ground floor"></label></div><p class="cab-note" data-move-quote-note hidden>This move needs its own quote. Select only Aircon Relocation; book other services separately. No payment is taken when you send this request.</p></section>${canAsk() ? `<section class="cab-assistance" data-assistance hidden aria-labelledby="cabIdentificationHeading"><div class="cab-selected-request" data-selected-request hidden><strong data-selected-request-summary></strong><button type="button" class="cab-secondary" data-change-service>Change service</button></div><h4 id="cabIdentificationHeading" data-identification-heading tabindex="-1">Help us identify your unit</h4><p class="cab-note">Request one service for verification. After your unit is identified, you can add other services using the confirmed details. No payment or schedule is taken yet.</p><label>Photos <span class="cab-optional">optional</span><input type="file" name="assistancePhotos" accept="image/jpeg,image/png,image/webp" multiple><small data-photo-guidance>Up to two photos: the appliance and its model sticker. JPG, PNG or WEBP, up to 5 MB each. If you cannot take a photo, staff will contact you.</small></label><p data-photo-feedback class="cab-photo-feedback" role="status"></p><label>What do you know about the unit? <span class="cab-optional">optional</span><textarea name="assistanceNotes" maxlength="1000" rows="3" placeholder="For example, wall-mounted aircon in the bedroom"></textarea></label></section>` : ''}<section class="cab-confirmation" data-request-confirmation hidden aria-labelledby="cabConfirmHeading"><h4 id="cabConfirmHeading" data-confirm-heading tabindex="-1">Send this request to staff?</h4><p data-confirm-summary></p><p>Staff will identify your unit and send a price for you to review and accept. This request does not book a schedule or take payment.</p><div class="cab-actions"><button type="button" class="cab-secondary" data-keep-editing>Keep editing</button><button type="button" class="cab-primary" data-send-request>Confirm and send request</button></div></section></section></div>
      <aside class="cab-summary" aria-label="Appliance service estimate"><span class="cab-eyebrow">YOUR SELECTION</span><strong data-summary-appliance></strong><span data-count></span><div class="cab-summary-price"><small>Estimated service total</small><strong data-total></strong></div><small data-duration></small><p>Travel fee is added once for the visit.</p></aside></div>
      <div class="cab-footer">${typeof hooks.review === 'function' ? bookingCounter('data-footer-capacity') : ''}<p data-feedback role="status" aria-live="polite"></p><p data-guidance></p><div class="cab-actions"><button type="button" class="cab-secondary" data-cancel hidden>Cancel changes</button><button type="button" class="cab-secondary" data-back hidden>Back</button><button type="button" class="cab-primary" data-next>Next: appliance details</button><button type="submit" data-submit class="cab-primary" hidden>Add to booking</button></div></div></div>
      <section class="cab-success" data-success hidden><span class="cab-success-icon" aria-hidden="true">✓</span><h3 tabindex="-1">Added to your booking</h3><p data-saved-details></p>${bookingCounter('data-saved-total')}<div class="cab-success-next"><strong data-success-next-title>Next: Service address</strong><p data-success-next-copy>Tell us where the service will happen. Then choose your schedule and review your booking.</p></div><div class="cab-actions"><button type="button" class="cab-secondary" data-new>Add another appliance</button><button type="button" class="cab-primary" data-address>Continue to service address</button></div><a class="cab-help" data-request-link href="/unit-assistance" hidden>View request and staff quote</a></section></${formTag}>`;
    if (options.allowQuotedRelocation === false) {
      host.querySelector('[name="moveScope"][value="custom_quote"]').closest("label").hidden = true;
    }
    const ids = new Map();
    host.querySelectorAll('[id]').forEach(node => { const original = node.id; node.dataset.builderId = original; node.id = host.id + '-' + original; ids.set(original, node.id); });
    host.querySelectorAll('[for],[aria-controls],[aria-labelledby],[aria-describedby]').forEach(node => {
      for (const attribute of ['for','aria-controls','aria-labelledby','aria-describedby']) {
        if (node.hasAttribute(attribute)) node.setAttribute(attribute, node.getAttribute(attribute).split(' ').map(id => ids.get(id) || id).join(' '));
      }
    });
    if (options.repair) {
      host.querySelector('[data-details-required]').textContent = 'Fields marked * are required. Services will open automatically when you finish these details.';
      host.querySelector('[data-assistance] h4').textContent = 'Describe the problem';
      host.querySelector('[data-assistance] p').textContent = 'Choose Repair inspection and describe what happened. Repair work is quoted after inspection and needs separate approval.';
      const notes = field('assistanceNotes'); notes.required = true; notes.minLength = 10; notes.maxLength = 500; notes.placeholder = 'Tell us what happened, in at least 10 characters.';
      notes.parentElement.firstChild.textContent = 'Problem description * ';
      notes.parentElement.querySelector('.cab-optional')?.remove();
      field('assistancePhotos').closest('label').hidden = options.photos === false;
    }
    host.addEventListener('change', event => {
      closeConfirmation();
      if (event.target.name === 'kind') { detailsUnknown = false; helpOpen = false; if (field('assistancePhotos')) field('assistancePhotos').value = ''; if (field('assistanceNotes')) field('assistanceNotes').value = ''; host.querySelectorAll('[name="service"]').forEach(input => { input.checked = false; }); reached = 1; refreshTypes(); }
      else if (event.target.name === 'airconType') refreshHp(); else if (['hp', 'compressorHp'].includes(event.target.name)) refreshServices(); else updateTotal();
      if (event.target.name === 'brand') { syncBrand(); if (field('brand').value === '__other__') field('brandCustom').focus(); }
      if (hooks.repair && step === 2 && ['brand', 'hp'].includes(event.target.name) && detailsValid()) next();
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
        if (step === 3 && assistanceOpen) { host.querySelector('[data-change-service]').click(); }
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
      const selected = selection(), verification = [...host.querySelectorAll('[name="service"]:checked')].find(input => input.hasAttribute('data-verification'));
      const validation = hooks.validate?.(selected);
      if (validation) { updateTotal(); return message(validation, true); }
      if (verification && canAsk()) { updateTotal(); return showConfirmation(selected, catalog.find(service => String(service._id) === verification.value)); }
      try { const selected = selection(), ids = [...host.querySelectorAll('[name="service"]:checked')].map(input => input.value), edited = Boolean(editingId); hooks.commit(A.serviceLines(catalog, selected, ids, editingId || `appliance_${crypto.randomUUID()}`, relocationSelection()), editingId); success(selected, ids, edited); }
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
  function reset() {
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
    host.querySelector('[data-quantity-feedback]').textContent = '';
    host.querySelector('[data-submit]').textContent = 'Add to booking'; host.querySelector('[data-cancel]').hidden = true; refreshTypes(); setStep(1);
  }
  function edit(groupId) {
    const rows = hooks.state.selectedServices.filter(item => (hooks.repair ? String(item.id || item._id || '') : item.applianceGroupId || String(item.id || item._id || '')) === String(groupId)), item = rows[0]; if (!item) return;
    editingId = groupId; saved = false; reached = 3; detailsUnknown = false; helpOpen = false; setKind(hooks.kindFor?.(item) || item.applianceKind || 'aircon');
    savedMove = rows.find(row => row.relocation)?.relocation || null;
    host.querySelectorAll('[name="moveScope"]').forEach(input => { input.checked = input.value === savedMove?.scope; });
    field('moveFrom').value = savedMove?.from?.details || ''; field('moveTo').value = savedMove?.to?.details || '';
    setBrand(item.brand); field('model').value = item.model || ''; field('quantity').value = item.quantity;
    refreshTypes(); field('airconType').value = item.airconType || ''; refreshHp(); field('hp').value = item.hp || ''; field('compressorHp').value = item.hp || ''; refreshServices();
    host.querySelectorAll('[name="service"]').forEach(input => { input.checked = !input.disabled && rows.some(row => String(hooks.serviceIdFor?.(row) || row.serviceId) === input.value); });
    host.querySelector('[data-submit]').textContent = 'Save changes'; host.querySelector('[data-cancel]').hidden = false; host.querySelector('[data-quantity-feedback]').textContent = ''; setStep(2); message('Changes apply to all services for this appliance.');
  }
  function sync() { if (!mounted) return; updateTotal(); if (saved) { host.querySelector('[data-saved-total]').textContent = `${A.unitCount(hooks.state.selectedServices)} / 40 appliances in your booking`; host.querySelector('[data-address]').disabled = !hooks.state.selectedServices.length; } }
  function pending() {
    return mounted && !saved && Boolean(editingId || helpOpen || detailsUnknown || hooks.repair && field('kind').value || field('brand').value.trim() || hooks.repair && field('model').value.trim() || field('airconType').value || field('hp').value || field('compressorHp').value || Number(field('quantity').value) !== 1 || host.querySelector('[name="service"]:checked'));
  }
  function start() { if (mounted && saved) reset(); }
  return { mount, edit, sync, pending, start, reset };
  }
  window.CoreApplianceBooking = Object.assign(create(), { create });
})();

(function () {
  'use strict';
  let catalog = [], hooks, host, editingId = null, mounted = false, step = 1, reached = 1, saved = false;
  let savedMove = null;
  const A = window.ApplianceServices;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = value => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 2 }).format(value);
  const field = name => host.querySelector(`[name="${name}"]${name === 'kind' ? ':checked' : ''}`);
  const available = () => A.remainingUnits(hooks.state.selectedServices, editingId);
  function selection() {
    const kind = field('kind').value;
    const hp = field(kind === 'aircon' ? 'hp' : 'compressorHp').value;
    return { applianceKind: kind, quantity: Number(field('quantity').value), brand: field('brand').value.trim(), model: field('model').value.trim(), airconType: kind === 'aircon' ? field('airconType').value : null, hp: hp ? Number(hp) : null };
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
    host.querySelector('[data-capacity]').textContent = `${A.unitCount(hooks.state.selectedServices)} / 40 appliances in your booking`;
    host.querySelector('[data-limit]').textContent = limit > 0 ? `You can add ${limit} appliance${limit === 1 ? '' : 's'}${editingId ? ' in this group' : ' more'}. Maximum 40 per booking.` : 'Your booking has reached 40 appliances. Remove an item or edit an existing appliance to continue.';
    host.querySelector('[data-minus]').disabled = limit === 0 || !Number.isInteger(quantity) || quantity <= 1;
    host.querySelector('[data-plus]').disabled = limit === 0 || !Number.isInteger(quantity) || quantity >= limit;
    host.querySelector('[data-new]').disabled = !A.remainingUnits(hooks.state.selectedServices);
    return limit > 0 && input.validity.valid;
  }
  function detailsValid() {
    return available() > 0 && ['brand', 'model', 'quantity', ...(field('kind').value === 'aircon' ? ['airconType', 'hp'] : [])].every(name => field(name).validity.valid) && Boolean(field('brand').value.trim());
  }
  function setStep(value, focus = true) {
    step = value; reached = Math.max(reached, step); saved = false;
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
    if (focus) { const heading = host.querySelector(`[data-panel="${step}"] h3`); heading.focus({ preventScroll: true }); host.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
  }
  function next() {
    syncLimit(true);
    if (!available()) return message('Your booking already has 40 appliances. Edit or remove an item first.', true);
    if (step === 2 && !detailsValid()) {
      const invalid = ['brand', 'model', 'quantity', ...(field('kind').value === 'aircon' ? ['airconType', 'hp'] : [])].map(field).find(input => !input.validity.valid || input.name === 'brand' && !input.value.trim());
      message('Complete the required appliance details before choosing services.', true); invalid?.focus(); invalid?.reportValidity(); return;
    }
    if (step < 3) { refreshServices(); setStep(step + 1); }
  }
  function refreshTypes() {
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
    catalog.forEach(service => (service.airconTypes?.find(row => row.type === type)?.hpPricing || service.hpPricing || []).forEach(row => sizes.add(Number(row.hp))));
    field('hp').innerHTML = '<option value="">Choose HP</option>' + [...sizes].sort((a, b) => a - b).map(hp => `<option value="${hp}">${hp} HP</option>`).join(''); field('hp').value = previous; refreshServices();
  }
  function refreshServices() {
    const checked = new Set([...host.querySelectorAll('[name="service"]:checked')].map(input => input.value)), selected = selection();
    const candidates = catalog.filter(service => service.active !== false && A.profile(service, selected.applianceKind) && (!A.isRelocation(service) || selected.applianceKind === 'aircon'));
    const typeName = selected.airconType ? field('airconType').selectedOptions[0]?.textContent : '';
    host.querySelector('[data-service-appliance]').textContent = [selected.brand, A.labels[selected.applianceKind], typeName, selected.hp ? `${selected.hp} HP` : '', `${selected.quantity || 0} appliance${selected.quantity === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    host.querySelector('[data-services]').innerHTML = candidates.map(service => {
      let pricing, error; try { pricing = A.price(service, { ...selected, brand: selected.brand || 'Brand not entered' }); } catch (err) { error = err.message; }
      if (A.isRelocation(service)) {
        const tooMany = selected.quantity !== 1;
        return `<label class="cab-service ${tooMany ? 'is-unavailable' : ''}"><input type="checkbox" name="service" value="${escape(service._id)}" ${tooMany ? 'disabled' : ''} ${!tooMany && checked.has(String(service._id)) ? 'checked' : ''}><span class="cab-service-copy"><strong>${escape(service.name)}</strong><small>${tooMany ? 'Add one aircon at a time for relocation.' : 'Move within the same property or to another address. Your aircon details are already saved above.'}</small></span><span class="cab-service-price">${pricing ? money(pricing.unitPrice) : 'Staff quote'}<small>nearby move estimate</small></span></label>`;
      }
      return `<label class="cab-service ${error ? 'is-unavailable' : ''}"><input type="checkbox" name="service" value="${escape(service._id)}" ${error ? 'disabled' : ''} ${pricing && checked.has(String(service._id)) ? 'checked' : ''}><span class="cab-service-copy"><strong>${escape(service.name)}</strong><small>${escape(error || service.description || 'Service for your selected appliance.')}</small></span><span class="cab-service-price">${pricing ? money(pricing.unitPrice) : 'Unavailable'}<small>${pricing ? `per appliance · ${pricing.duration} min` : 'Choose another service'}</small></span></label>`;
    }).join('') || '<div class="cab-empty"><strong>No services are available for this appliance yet.</strong><p>Choose another appliance, or use Repair Service if it needs an inspection.</p></div>';
    if (selected.applianceKind !== 'aircon' && candidates.some(service => A.profile(service, selected.applianceKind)?.pricingMode === 'hp') && !selected.hp) host.querySelector('[data-services]').insertAdjacentHTML('beforeend', '<div class="cab-empty"><strong>Not sure about the compressor HP?</strong><p>You can book services with a fixed price, or request a repair inspection.</p><button type="button" class="cab-secondary" data-repair>Choose Repair Service</button></div>');
    updateTotal();
  }
  function updateTotal() {
    const model = field('model');
    model.setCustomValidity(!model.value.trim() || /^[A-Za-z0-9][A-Za-z0-9 ._/#()+-]*$/.test(model.value.trim()) ? '' : 'Use letters, numbers, spaces, and . - _ / # ( ) + only.');
    const validQuantity = syncLimit(), selected = selection(), ids = [...host.querySelectorAll('[name="service"]:checked')].map(input => input.value), moveValid = syncMove();
    const customMove = selectedRelocation() && relocationSelection().scope === 'custom_quote';
    let total = 0, minutes = 0;
    if (validQuantity) ids.forEach(id => { try { const price = A.price(catalog.find(service => String(service._id) === id), { ...selected, brand: selected.brand || 'Brand not entered' }); total += price.unitPrice * selected.quantity; minutes += price.duration * selected.quantity; } catch (_) {} });
    host.querySelector('[data-total]').textContent = customMove ? 'Price after staff review' : ids.length && validQuantity ? money(total) : '—';
    host.querySelector('[data-count]').textContent = `${validQuantity ? selected.quantity : 0} appliance${selected.quantity === 1 ? '' : 's'} · ${ids.length} service${ids.length === 1 ? '' : 's'}`;
    host.querySelector('[data-duration]').textContent = customMove ? 'Staff will confirm work time with your quote.' : minutes ? `${minutes} minutes of service work` : 'Prices appear after you choose services.';
    host.querySelector('[data-submit]').disabled = saved || !ids.length || !validQuantity || !detailsValid() || !moveValid;
    host.querySelector('[data-submit]').textContent = editingId ? 'Save changes' : customMove ? 'Add relocation request' : 'Add to booking';
    host.querySelector('[data-next]').disabled = !available() || step === 2 && !detailsValid();
    host.querySelector('[data-summary-appliance]').textContent = `${selected.brand || 'Your appliance'} · ${A.labels[selected.applianceKind]}`;
    host.querySelector('[data-guidance]').textContent = !available() ? 'Your booking has 40 appliances. Edit or remove an item before adding another.' : step === 1 ? 'Next, add the appliance details and quantity.' : step === 2 ? 'Fill in the required fields to see matching services and prices.' : 'Choose services, then add this appliance to your booking.';
  }
  function success(selected, ids, edited) {
    saved = true; editingId = null; host.querySelector('[data-wizard]').hidden = true; host.querySelector('[data-success]').hidden = false;
    host.querySelector('[data-success] h3').textContent = edited ? 'Your changes are saved' : 'Added to your booking';
    host.querySelector('[data-saved-details]').textContent = `${selected.quantity} ${A.labels[selected.applianceKind].toLowerCase()}${selected.quantity > 1 ? 's' : ''} · ${ids.length} service${ids.length > 1 ? 's' : ''}`;
    host.querySelector('[data-saved-total]').textContent = `${A.unitCount(hooks.state.selectedServices)} / 40 appliances in your booking`;
    host.querySelector('[data-address]').disabled = !hooks.state.selectedServices.length; host.querySelector('[data-new]').disabled = !A.remainingUnits(hooks.state.selectedServices); host.querySelector('[data-success] h3').focus({ preventScroll: true });
    const move = hooks.state.selectedServices.find(row => row.relocation)?.relocation;
    host.querySelector('[data-success-next-title]').textContent = move ? 'Next: Relocation locations' : 'Next: Service address';
    host.querySelector('[data-success-next-copy]').textContent = move?.scope === 'custom_quote' ? 'Choose the current address first, then the new address. Pick a preferred date and send the request for a staff quote.' : move ? 'Pin the current property. Your current and new positions are saved with the aircon details.' : 'Tell us where the service will happen. Then choose your schedule and review your booking.';
    host.querySelector('[data-address]').textContent = move ? 'Continue to locations' : 'Continue to service address';
    if (move?.scope === 'custom_quote') host.querySelector('[data-new]').disabled = true;
  }
  function mount(services, options) {
    catalog = services; hooks = options; host = document.getElementById('coreApplianceBuilder'); if (!host) return;
    if (mounted) { refreshServices(); return; } mounted = true;
    host.innerHTML = `<form class="cab-form" novalidate><div class="cab-heading"><div><span class="cab-eyebrow">CORE SERVICES</span><h2>Set up your service</h2><p>Choose an appliance and tell us what it needs.</p></div><span class="cab-capacity" data-capacity></span></div>
      <div data-wizard><nav class="cab-progress" aria-label="Appliance service steps">${['Appliance', 'Details', 'Services'].map((name, index) => `<button type="button" data-step="${index + 1}" ${index ? 'disabled' : ''}><span>${index + 1}</span><strong>${name}</strong></button>`).join('')}</nav><div class="cab-step-meta"><span data-step-label></span><span>Next booking step: Service address</span></div>
      <div class="cab-workspace"><div class="cab-main"><section data-panel="1" aria-labelledby="cabApplianceHeading"><h3 id="cabApplianceHeading" tabindex="-1">Which appliance needs service?</h3><p class="cab-note">You can add another appliance after this one.</p><fieldset class="cab-appliances"><legend class="cab-sr-only">Choose an appliance</legend>${A.kinds.map((kind, index) => `<label><input type="radio" name="kind" value="${kind}" ${index === 0 ? 'checked' : ''}><span><i class="bi ${kind === 'aircon' ? 'bi-snow' : kind === 'refrigerator' ? 'bi-door-closed' : 'bi-box'}" aria-hidden="true"></i><strong>${A.labels[kind]}</strong><small>${kind === 'aircon' ? 'Type and HP pricing' : 'Services set by staff'}</small></span></label>`).join('')}</fieldset></section>
      <section data-panel="2" hidden aria-labelledby="cabDetailsHeading"><h3 id="cabDetailsHeading" tabindex="-1">Tell us about your appliance</h3><p class="cab-note">Fields marked * are required.</p><div class="cab-fields"><label>Brand *<input name="brand" required maxlength="80" placeholder="e.g. Carrier or Midea" autocomplete="off"></label><label>Model <span class="cab-optional">optional</span><input name="model" maxlength="50" placeholder="Shown on the unit label"></label></div><div class="cab-fields" data-aircon-details><label>Aircon type *<select name="airconType" required></select></label><label>HP *<select name="hp" required></select></label></div>
      <div class="cab-fields" data-compressor-details hidden><label>Compressor HP <span class="cab-optional">if known</span><select name="compressorHp"></select></label><p class="cab-note">Use the HP on the compressor label. It is needed only for services priced by HP.</p></div><div class="cab-quantity"><div><label for="cabQuantity">Number of appliances *</label><p>Use one group for appliances with the same details and services.</p></div><div class="cab-stepper"><button type="button" data-minus aria-label="Decrease appliance quantity">−</button><input id="cabQuantity" name="quantity" type="number" min="1" max="40" step="1" inputmode="numeric" value="1" required aria-describedby="cabUnitLimit cabQuantityFeedback"><button type="button" data-plus aria-label="Increase appliance quantity">+</button></div></div><p class="cab-limit" id="cabUnitLimit" data-limit></p><p class="cab-quantity-feedback" id="cabQuantityFeedback" data-quantity-feedback role="status" aria-live="polite"></p><a class="cab-help" href="/unit-assistance">Not sure about the type or HP? Request help with your unit.</a></section>
      <section data-panel="3" hidden aria-labelledby="cabServicesHeading"><h3 id="cabServicesHeading" tabindex="-1">Choose the services you need</h3><p class="cab-note">Select one or more services for the same appliance.</p><div class="cab-appliance-summary" data-service-appliance></div><div data-services></div><section class="cab-relocation" data-relocation-config hidden aria-labelledby="cabMoveHeading"><h4 id="cabMoveHeading">Where will the aircon move?</h4><p class="cab-note">We will use the brand, model, type and HP you already entered.</p><fieldset class="cab-move-scopes"><legend class="cab-sr-only">Relocation distance</legend><label><input type="radio" name="moveScope" value="same_property"><span><strong>Nearby, on the same property</strong><small>For example, from the living room to a bedroom.</small></span></label><label><input type="radio" name="moveScope" value="custom_quote"><span><strong>Another address or a distant position</strong><small>Choose both addresses on the next map step. Staff will send a quote.</small></span></label></fieldset><div class="cab-fields" data-nearby-fields hidden><label>Current position *<input name="moveFrom" minlength="2" maxlength="500" placeholder="e.g. Living room, ground floor"></label><label>New position *<input name="moveTo" minlength="2" maxlength="500" placeholder="e.g. Bedroom, ground floor"></label></div><p class="cab-note" data-move-quote-note hidden>This move needs its own quote. Select only Aircon Relocation; book other services separately. No payment is taken when you send this request.</p></section></section></div>
      <aside class="cab-summary" aria-label="Appliance service estimate"><span class="cab-eyebrow">YOUR SELECTION</span><strong data-summary-appliance></strong><span data-count></span><div class="cab-summary-price"><small>Estimated service total</small><strong data-total></strong></div><small data-duration></small><p>Travel fee is added once for the visit.</p></aside></div>
      <div class="cab-footer"><p data-feedback role="status" aria-live="polite"></p><p data-guidance></p><div class="cab-actions"><button type="button" class="cab-secondary" data-cancel hidden>Cancel changes</button><button type="button" class="cab-secondary" data-back hidden>Back</button><button type="button" class="cab-primary" data-next>Next: appliance details</button><button type="submit" data-submit class="cab-primary" hidden>Add to booking</button></div></div></div>
      <section class="cab-success" data-success hidden><span class="cab-success-icon" aria-hidden="true">✓</span><h3 tabindex="-1">Added to your booking</h3><p data-saved-details></p><span class="cab-capacity" data-saved-total></span><div class="cab-success-next"><strong data-success-next-title>Next: Service address</strong><p data-success-next-copy>Tell us where the service will happen. Then choose your schedule and review your booking.</p></div><div class="cab-actions"><button type="button" class="cab-secondary" data-new>Add another appliance</button><button type="button" class="cab-primary" data-address>Continue to service address</button></div></section></form>`;
    host.addEventListener('change', event => {
      if (event.target.name === 'kind') { host.querySelectorAll('[name="service"]').forEach(input => { input.checked = false; }); reached = 1; refreshTypes(); }
      else if (event.target.name === 'airconType') refreshHp(); else if (['hp', 'compressorHp'].includes(event.target.name)) refreshServices(); else updateTotal();
      if (event.target.name === 'service' && event.target.checked && A.isRelocation(catalog.find(service => String(service._id) === event.target.value))) {
        const heading = host.querySelector('#cabMoveHeading'); heading.tabIndex = -1;
        heading.focus({ preventScroll: true }); heading.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      }
    });
    host.addEventListener('input', event => { if (['quantity', 'brand', 'model', 'moveFrom', 'moveTo'].includes(event.target.name)) { if (event.target.name === 'quantity') host.querySelector('[data-quantity-feedback]').textContent = ''; updateTotal(); } });
    field('quantity').addEventListener('blur', () => { syncLimit(true); updateTotal(); });
    host.addEventListener('click', event => {
      if (event.target.closest('[data-repair]')) { reset(); document.getElementById('repair-tab')?.click(); }
      if (event.target.closest('[data-cancel]') || event.target.closest('[data-new]')) reset();
      if (event.target.closest('[data-next]')) next(); if (event.target.closest('[data-back]')) setStep(step - 1);
      if (event.target.closest('[data-minus]') || event.target.closest('[data-plus]')) { field('quantity').value = String(Math.max(1, Math.min(available(), Number(field('quantity').value) + (event.target.closest('[data-plus]') ? 1 : -1)))); updateTotal(); }
      const progress = event.target.closest('.cab-progress button[data-step]'); if (progress && host.contains(progress) && !progress.disabled) { const target = Number(progress.dataset.step); if (target === 3 && !detailsValid()) return setStep(2); setStep(target); }
      if (event.target.closest('[data-address]')) hooks.next?.();
    });
    host.querySelector('form').addEventListener('submit', event => {
      event.preventDefault(); if (saved) return; if (step < 3) return next();
      const button = host.querySelector('[data-submit]'); if (button.disabled) return;
      if (!detailsValid()) { setStep(2); message('Check your appliance details before adding services.', true); return; } button.disabled = true;
      try { const selected = selection(), ids = [...host.querySelectorAll('[name="service"]:checked')].map(input => input.value), edited = Boolean(editingId); hooks.commit(A.serviceLines(catalog, selected, ids, editingId || `appliance_${crypto.randomUUID()}`, relocationSelection()), editingId); success(selected, ids, edited); }
      catch (error) { message(error.message, true); updateTotal(); }
    }); refreshTypes(); setStep(1, false);
  }
  function reset() {
    editingId = null; reached = 1; saved = false; savedMove = null; host.querySelector('form').reset(); host.querySelector('[data-quantity-feedback]').textContent = '';
    host.querySelector('[data-submit]').textContent = 'Add to booking'; host.querySelector('[data-cancel]').hidden = true; refreshTypes(); setStep(1);
  }
  function edit(groupId) {
    const rows = hooks.state.selectedServices.filter(item => item.applianceGroupId === groupId), item = rows[0]; if (!item) return;
    editingId = groupId; saved = false; reached = 3; host.querySelector(`[name="kind"][value="${escape(item.applianceKind || 'aircon')}"]`).checked = true;
    savedMove = rows.find(row => row.relocation)?.relocation || null;
    host.querySelectorAll('[name="moveScope"]').forEach(input => { input.checked = input.value === savedMove?.scope; });
    field('moveFrom').value = savedMove?.from?.details || ''; field('moveTo').value = savedMove?.to?.details || '';
    field('brand').value = item.brand || ''; field('model').value = item.model || ''; field('quantity').value = item.quantity;
    refreshTypes(); field('airconType').value = item.airconType || ''; refreshHp(); field('hp').value = item.hp || ''; field('compressorHp').value = item.hp || ''; refreshServices();
    host.querySelectorAll('[name="service"]').forEach(input => { input.checked = !input.disabled && rows.some(row => String(row.serviceId) === input.value); });
    host.querySelector('[data-submit]').textContent = 'Save changes'; host.querySelector('[data-cancel]').hidden = false; host.querySelector('[data-quantity-feedback]').textContent = ''; setStep(2); message('Changes apply to all services for this appliance.');
  }
  function sync() { if (!mounted) return; updateTotal(); if (saved) { host.querySelector('[data-saved-total]').textContent = `${A.unitCount(hooks.state.selectedServices)} / 40 appliances in your booking`; host.querySelector('[data-address]').disabled = !hooks.state.selectedServices.length; } }
  function pending() {
    return mounted && !saved && Boolean(editingId || field('brand').value.trim() || field('model').value.trim() || field('airconType').value || field('hp').value || field('compressorHp').value || Number(field('quantity').value) !== 1 || host.querySelector('[name="service"]:checked'));
  }
  function start() { if (mounted && saved) reset(); }
  window.CoreApplianceBooking = { mount, edit, sync, pending, start };
})();

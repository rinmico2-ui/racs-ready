(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./appliance-services'));
  else root.CoreApplianceBatch = factory(root.ApplianceServices);
})(typeof window !== 'undefined' ? window : globalThis, function (A) {
  'use strict';
  const clean = value => String(value ?? '').trim();
  const escape = value => clean(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const money = value => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 2 }).format(value);

  function createModel(catalog, { newId = () => `appliance_${globalThis.crypto.randomUUID()}` } = {}) {
    let units = [], count = 1, shared = {}, detailsMode = 'shared', servicesMode = 'shared', sharedServices = [], individualServicesInitialized = false;
    const services = catalog.filter(service => service.active !== false && A.profile(service, 'aircon') && !A.isRelocation(service));
    const types = () => [...new Map(services.flatMap(service => A.effectiveAirconTypes(service)).map(type => [type.type, type.name || type.type]))];
    const capacities = type => [...new Set(services.flatMap(service => A.airconHpOptions(service, type).map(row => row.hp)))].sort((left, right) => left - right);
    const brands = () => [...new Map(services.flatMap(service => service.brands || []).filter(value => typeof value === 'string' && clean(value) && !/^(i don.t know|unknown)$/i.test(clean(value)))
      .map(value => [clean(value).toLowerCase(), clean(value)])).values()].sort((left, right) => left.localeCompare(right));
    const details = value => ({ applianceKind: 'aircon', brand: clean(value.brand), model: clean(value.model), airconType: clean(value.airconType), hp: value.hp == null || value.hp === '' ? null : Number(value.hp), quantity: 1 });
    const activeUnits = () => units.slice(0, count).map(unit => ({ ...unit, ...(detailsMode === 'shared' ? details(shared) : {}), serviceIds: [...(servicesMode === 'shared' ? sharedServices : unit.serviceIds)] }));
    function sync(selection, initialServices = []) {
      const quantity = Number(selection.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 40) return false;
      count = quantity; shared = details(selection);
      if (!units.length && !sharedServices.length) sharedServices = [...new Set(initialServices.map(String))];
      while (units.length < count) units.push({ ...details(selection), key: newId(), serviceIds: [...sharedServices], customBrand: Boolean(selection.brand && !brands().includes(selection.brand)) });
      if (detailsMode === 'shared' && !units.some(unit => unit.changed)) units.forEach(unit => Object.assign(unit, details(shared)));
      return true;
    }
    function issue(unit) {
      if (!unit.brand || unit.brand.length > 80 || /^(i don.t know|unknown|__unknown__|__other__)$/i.test(unit.brand)) return { field: 'brand', message: 'Choose the brand, or enter the brand shown on the label.' };
      if (!types().some(([type]) => type === unit.airconType)) return { field: 'airconType', message: 'Choose an aircon type.' };
      if (!capacities(unit.airconType).includes(Number(unit.hp))) return { field: 'hp', message: 'Choose an HP offered for this aircon type.' };
      if (unit.model.length > 50 || unit.model && !/^[A-Za-z0-9][A-Za-z0-9 ._/#()+-]*$/.test(unit.model)) return { field: 'model', message: 'Use up to 50 letters, numbers, spaces, or model-number punctuation.' };
      return null;
    }
    function setDetailsMode(mode) {
      if (!['shared', 'individual'].includes(mode)) return;
      if (mode === 'individual' && detailsMode === 'shared' && !units.some(unit => unit.changed)) {
        units.forEach(unit => Object.assign(unit, details(shared)));
      }
      detailsMode = mode;
    }
    function setServicesMode(mode) {
      if (!['shared', 'individual'].includes(mode)) return;
      if (mode === 'individual' && !individualServicesInitialized) {
        units.forEach(unit => { unit.serviceIds = [...sharedServices]; }); individualServicesInitialized = true;
      }
      servicesMode = mode;
    }
    function setDetail(index, field, value) {
      if (!units[index] || !['brand', 'model', 'airconType', 'hp', 'customBrand'].includes(field)) return;
      const unit = units[index];
      unit[field] = field === 'hp' ? value === '' ? null : Number(value) : field === 'customBrand' ? Boolean(value) : clean(value);
      unit.changed = true;
      if (field === 'airconType' && !capacities(unit.airconType).includes(Number(unit.hp))) unit.hp = null;
    }
    function adoptSingleUnit(selection, serviceIds) {
      if (!units.length) return;
      Object.assign(units[0], details(selection), { changed: true, customBrand: Boolean(selection.brand && !brands().includes(selection.brand)) });
      const selected = [...new Set(serviceIds.filter(id => services.some(service => String(service._id) === id)))];
      units[0].serviceIds = selected;
      if (servicesMode === 'shared') sharedServices = selected;
    }
    function copy(field) {
      const source = activeUnits()[0];
      const fields = field === 'all' ? ['brand', 'airconType', 'hp', 'model'] : [field];
      if (!fields.every(key => ['brand', 'airconType', 'hp', 'model'].includes(key))) throw Error('Choose which details to copy.');
      if (field !== 'all' && !source[field]) throw Error('Enter this detail for Aircon 1 before copying it.');
      if (field === 'all' && issue(source)) throw Error('Complete Aircon 1 before copying all its details.');
      if (field === 'hp') {
        const incompatible = activeUnits().findIndex((unit, index) => index > 0 && !capacities(unit.airconType).includes(source.hp));
        if (incompatible >= 0) throw Error(`Aircon ${incompatible + 1} needs a different HP choice. Check its type before copying capacity.`);
      }
      for (const unit of units.slice(1, count)) {
        fields.forEach(key => { unit[key] = source[key]; });
        if (fields.includes('brand')) unit.customBrand = !brands().includes(source.brand);
        if (!capacities(unit.airconType).includes(Number(unit.hp))) unit.hp = null;
        unit.changed = true;
      }
    }
    const choice = (service, unit) => issue(unit) ? { available: false, reason: 'Complete this aircon’s details first.' } : A.availability(service, unit);
    function selectService(serviceId, checked, index) {
      const id = String(serviceId), service = services.find(row => String(row._id) === id);
      if (!service) throw Error('Choose an available Core service.');
      const targets = index === undefined ? activeUnits() : [activeUnits()[index]];
      if (checked && (!targets.length || targets.some(unit => !unit || !choice(service, unit).available))) throw Error('This service is not offered for every selected aircon. Choose services per aircon instead.');
      if (index === undefined) sharedServices = checked ? [...new Set([...sharedServices, id])] : sharedServices.filter(value => value !== id);
      else units[index].serviceIds = checked ? [...new Set([...units[index].serviceIds, id])] : units[index].serviceIds.filter(value => value !== id);
    }
    function estimate() {
      let total = 0, minutes = 0, tasks = 0;
      const errors = [];
      activeUnits().forEach((unit, index) => {
        const detailIssue = issue(unit);
        if (detailIssue) errors.push({ index, ...detailIssue });
        if (!unit.serviceIds.length) errors.push({ index, field: 'service', message: `Choose at least one service for Aircon ${index + 1}.` });
        for (const id of unit.serviceIds) {
          try {
            if (detailIssue) continue;
            const service = services.find(row => String(row._id) === id);
            const price = A.price(service, unit);
            total += price.unitPrice; minutes += price.duration; tasks++;
          } catch (error) { errors.push({ index, field: 'service', message: `Aircon ${index + 1}: ${error.message}` }); }
        }
      });
      return { total, minutes, tasks, count, errors, ready: errors.length === 0 };
    }
    function rows() {
      const state = estimate();
      if (!state.ready) throw Error(state.errors[0].message);
      const result = activeUnits().flatMap(unit => A.serviceLines(catalog, details(unit), unit.serviceIds, unit.key));
      A.unitCount(result); A.assertStandaloneServices(result);
      return result;
    }
    function snapshot() { return { version: 1, units: units.map(unit => ({ ...unit, serviceIds: [...unit.serviceIds] })), detailsMode, servicesMode, sharedServices: [...sharedServices], individualServicesInitialized }; }
    function restore(value) {
      if (value?.version !== 1 || !Array.isArray(value.units) || value.units.length > 40) return;
      if (value.units.some(unit => !unit || typeof unit !== 'object' || Array.isArray(unit))) return;
      const seen = new Set();
      units = value.units.map(unit => {
        const validKey = typeof unit.key === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(unit.key) && !seen.has(unit.key);
        const key = validKey ? unit.key : newId(); seen.add(key);
        return { ...details(unit), key, serviceIds: Array.isArray(unit.serviceIds) ? [...new Set(unit.serviceIds.filter(id => services.some(row => String(row._id) === id)))] : [], customBrand: unit.customBrand === true, changed: unit.changed === true };
      });
      detailsMode = value.detailsMode === 'individual' ? 'individual' : 'shared';
      servicesMode = value.servicesMode === 'individual' ? 'individual' : 'shared';
      sharedServices = Array.isArray(value.sharedServices) ? [...new Set(value.sharedServices.filter(id => services.some(row => String(row._id) === id)))] : [];
      individualServicesInitialized = value.individualServicesInitialized === true;
    }
    function reset() { units = []; count = 1; shared = {}; detailsMode = 'shared'; servicesMode = 'shared'; sharedServices = []; individualServicesInitialized = false; }
    return { sync, issue, choice, estimate, rows, snapshot, restore, reset, types, capacities, brands, services, activeUnits, setDetailsMode, setServicesMode, setDetail, adoptSingleUnit, copy, selectService,
      get detailsMode() { return detailsMode; }, get servicesMode() { return servicesMode; }, get count() { return count; } };
  }

  function mount({ host, catalog, selection, enabled, step, update, changed, restoreShared, help }) {
    const model = createModel(catalog);
    let active = false, detailSignature = '', serviceSignature = '', restored = false, singleWasUsed = false;
    const quantity = host.querySelector('.cab-quantity'), limit = host.querySelector('[data-limit]'), feedback = host.querySelector('[data-quantity-feedback]');
    const sharedCard = host.querySelector('[data-unit-details]'), legacyServices = host.querySelector('[data-services]');
    const footer = host.querySelector('.cab-footer'), footerReview = footer.querySelector('[data-booking-review]');
    const quote = document.createElement('div');
    quote.className = 'cab-batch-quote'; quote.hidden = true;
    quote.innerHTML = '<div><strong data-batch-quote-units></strong><small>Service estimate · travel fee added later</small></div><b data-batch-quote-total></b>';
    footer.prepend(quote);
    if (window.ResizeObserver) new ResizeObserver(() => {
      document.documentElement.style.setProperty('--core-booking-actions-height', `${Math.ceil(footer.getBoundingClientRect().height)}px`);
    }).observe(footer);
    host.classList.add('cab-batch-enabled');
    host.querySelector('[data-details-required]').after(quantity, limit, feedback);
    const modes = document.createElement('div');
    modes.className = 'cab-batch-modes'; modes.dataset.coreBatch = ''; modes.hidden = true;
    modes.innerHTML = `<fieldset class="cab-batch-choice"><legend>Do these aircons have the same details?</legend><div class="cab-batch-switch"><label><input type="radio" name="batchDetailsMode" value="shared" checked><span><strong>Same details</strong><small>Enter once for all aircons</small></span></label><label><input type="radio" name="batchDetailsMode" value="individual"><span><strong>Different details</strong><small>Edit each aircon on this screen</small></span></label></div><p class="cab-note" data-batch-mode-note></p></fieldset>`;
    feedback.after(modes);
    const detailsRoot = document.createElement('section');
    detailsRoot.className = 'cab-batch-details'; detailsRoot.dataset.coreBatch = ''; detailsRoot.hidden = true;
    detailsRoot.innerHTML = `<div class="cab-batch-tools"><div><strong>Copy matching details</strong><p>Use Aircon 1 as your starting point.</p></div><div class="cab-batch-copy" role="group" aria-label="Copy details from Aircon 1">${[['brand','Brand'],['airconType','Type'],['hp','HP'],['all','All details']].map(([field,label]) => `<button type="button" data-copy-unit="${field}">${label}<i class="bi bi-copy" aria-hidden="true"></i></button>`).join('')}</div></div><div data-batch-unit-list></div><p class="cab-batch-status" data-batch-detail-status role="status" aria-live="polite"></p>`;
    sharedCard.after(detailsRoot);
    const servicesRoot = document.createElement('section');
    servicesRoot.className = 'cab-batch-services'; servicesRoot.dataset.coreBatch = ''; servicesRoot.hidden = true;
    servicesRoot.innerHTML = `<fieldset class="cab-batch-choice"><legend>Which aircons need these services?</legend><div class="cab-batch-switch"><label><input type="radio" name="batchServicesMode" value="shared" checked><span><strong>All aircons</strong><small>Choose common services once</small></span></label><label><input type="radio" name="batchServicesMode" value="individual"><span><strong>Choose per aircon</strong><small>Adjust services for each unit</small></span></label></div></fieldset><div data-batch-service-list></div><p class="cab-batch-status" data-batch-service-status role="status" aria-live="polite"></p>`;
    legacyServices.after(servicesRoot);
    const options = (values, value, empty) => `<option value="">${empty}</option>` + values.map(([key,label]) => `<option value="${escape(key)}" ${String(key) === String(value ?? '') ? 'selected' : ''}>${escape(label)}</option>`).join('');
    const unitTitle = index => `Aircon ${index + 1}`;
    const unitDescription = unit => [unit.brand, model.types().find(([type]) => type === unit.airconType)?.[1], unit.hp ? `${unit.hp} HP` : ''].filter(Boolean).join(' · ');
    const notify = (text, error = false, service = false) => {
      const node = (service ? servicesRoot : detailsRoot).querySelector(service ? '[data-batch-service-status]' : '[data-batch-detail-status]');
      node.textContent = text; node.classList.toggle('is-error', error);
    };
    function rowMarkup(unit, index) {
      const issue = model.issue(unit), custom = unit.customBrand || Boolean(unit.brand && !model.brands().includes(unit.brand));
      return `<article class="cab-batch-unit" data-unit-row="${index}" aria-label="${unitTitle(index)} details"><div class="cab-batch-unit-head"><div><span class="cab-batch-unit-number" aria-hidden="true">${index + 1}</span><h4>${unitTitle(index)}</h4></div><span class="cab-batch-completion ${issue ? '' : 'is-ready'}" data-unit-completion>${issue ? 'Details needed' : 'Details ready'}</span></div><div class="cab-batch-unit-fields">
        <label>Brand *<select data-unit-index="${index}" data-unit-field="brand" aria-label="Brand for ${unitTitle(index)}" required>${options(model.brands().map(value => [value,value]), custom ? '__other__' : unit.brand, 'Choose brand')}<option value="__other__" ${custom ? 'selected' : ''}>Other brand</option></select></label>
        <label data-custom-brand ${custom ? '' : 'hidden'}>Other brand *<input data-unit-index="${index}" data-unit-field="brandCustom" aria-label="Other brand for ${unitTitle(index)}" maxlength="80" value="${custom ? escape(unit.brand) : ''}" ${custom ? 'required' : 'disabled'} autocomplete="off" placeholder="Brand on the unit label"></label>
        <label>Aircon type *<select data-unit-index="${index}" data-unit-field="airconType" aria-label="Type for ${unitTitle(index)}" required>${options(model.types(), unit.airconType, 'Choose type')}</select></label>
        <label>Capacity (HP) *<select data-unit-index="${index}" data-unit-field="hp" aria-label="HP for ${unitTitle(index)}" ${unit.airconType ? '' : 'disabled'} required>${options(model.capacities(unit.airconType).map(value => [value, `${value} HP`]), unit.hp, unit.airconType ? 'Choose HP' : 'Choose type first')}</select></label>
        </div><div class="cab-batch-unit-foot"><details class="cab-batch-model" ${unit.model ? 'open' : ''}><summary>Model number <span>optional</span></summary><label class="cab-sr-only">Model for ${unitTitle(index)}</label><input data-unit-index="${index}" data-unit-field="model" aria-label="Model for ${unitTitle(index)}" maxlength="50" value="${escape(unit.model)}" autocomplete="off" placeholder="Model number on the label"></details><button type="button" class="cab-batch-help" data-unit-help-index="${index}"><i class="bi bi-question-circle" aria-hidden="true"></i>Help with this unit</button></div></article>`;
    }
    function refreshDetails(force = false) {
      detailsRoot.hidden = !active || model.detailsMode !== 'individual';
      if (detailsRoot.hidden) return;
      const signature = JSON.stringify([model.count, model.types(), model.brands()]);
      if (force || signature !== detailSignature) {
        detailSignature = signature;
        detailsRoot.querySelector('[data-batch-unit-list]').innerHTML = model.activeUnits().map(rowMarkup).join('');
      }
      const units = model.activeUnits();
      detailsRoot.querySelectorAll('[data-unit-row]').forEach(row => {
        const index = Number(row.dataset.unitRow), issue = model.issue(units[index]), badge = row.querySelector('[data-unit-completion]');
        badge.textContent = issue ? 'Details needed' : 'Details ready'; badge.classList.toggle('is-ready', !issue);
      });
      const first = units[0];
      detailsRoot.querySelectorAll('[data-copy-unit]').forEach(button => { button.disabled = button.dataset.copyUnit === 'all' ? Boolean(model.issue(first)) : !first[button.dataset.copyUnit]; });
    }
    function serviceMarkup(service, units, index) {
      const states = units.map(unit => model.choice(service, unit));
      const allAvailable = states.every(state => state.available), checked = units.every(unit => unit.serviceIds.includes(String(service._id)));
      const affected = states.map((state, position) => !state.available ? unitTitle(index === undefined ? position : index) : '').filter(Boolean);
      const prices = allAvailable ? states.map(state => state.pricing.unitPrice) : [];
      const total = prices.reduce((sum, value) => sum + value, 0);
      const priceText = !allAvailable ? 'Not offered' : units.length === 1 ? money(total) : `${money(total)} total`;
      const range = prices.length ? Math.min(...prices) === Math.max(...prices) ? `${money(prices[0])} per aircon` : `${money(Math.min(...prices))}–${money(Math.max(...prices))} per aircon` : '';
      const unavailable = checked ? 'Remove this choice or update the unit details.' : index === undefined ? 'Choose per aircon to select it for compatible units.' : 'Choose another service for this unit.';
      return `<label class="cab-batch-service ${allAvailable ? '' : 'is-unavailable'}"><input type="checkbox" data-batch-service="${escape(service._id)}" ${index === undefined ? '' : `data-service-unit="${index}"`} ${checked ? 'checked' : ''} ${!allAvailable && !checked ? 'disabled' : ''}><span><strong>${escape(service.name)}</strong><small>${allAvailable ? escape(units.length > 1 ? range : `${states[0].pricing.duration} min`) : escape(`Not offered for ${affected.join(', ')}. ${unavailable}`)}</small></span><b>${priceText}</b></label>`;
    }
    function refreshServices(force = false) {
      if (!active || step() !== 3) return;
      const units = model.activeUnits();
      const estimate = model.estimate(), error = estimate.tasks ? estimate.errors.find(error => error.field === 'service') : null;
      notify(error?.message || '', Boolean(error), true);
      const signature = JSON.stringify([units.map(({ serviceIds, ...unit }) => unit), model.servicesMode]);
      if (!force && signature === serviceSignature) {
        servicesRoot.querySelectorAll('[data-unit-service-total]').forEach(node => {
          const unit = units[Number(node.dataset.unitServiceTotal)];
          node.textContent = money(unit.serviceIds.reduce((sum,id) => { try { return sum + A.price(model.services.find(service => String(service._id) === id),unit).unitPrice; } catch (_) { return sum; } },0));
        });
        return;
      }
      serviceSignature = signature;
      const list = servicesRoot.querySelector('[data-batch-service-list]');
      if (model.servicesMode === 'shared') list.innerHTML = `<p class="cab-note">Selected services apply to all ${model.count} aircons. Each aircon uses its own catalog price.</p>${model.services.map(service => serviceMarkup(service, units)).join('')}`;
      else list.innerHTML = `<p class="cab-note">Review the services for each aircon. Shared choices are filled in for you.</p>${units.map((unit,index) => `<section class="cab-batch-unit-services" aria-label="Services for ${unitTitle(index)}"><div class="cab-batch-service-head"><div><h4>${unitTitle(index)}</h4><p>${escape(unitDescription(unit))}</p></div><span data-unit-service-total="${index}">${money(unit.serviceIds.reduce((sum,id) => { try { return sum + A.price(model.services.find(service => String(service._id) === id), unit).unitPrice; } catch (_) { return sum; } },0))}</span></div>${model.services.map(service => serviceMarkup(service,[unit],index)).join('')}</section>`).join('')}`;
      if (!model.services.length) list.innerHTML = '<p class="cab-empty">No Core services are offered for these aircons. Contact staff for assistance.</p>';
    }
    function sync() {
      const current = selection(), shouldActivate = enabled() && current.applianceKind === 'aircon' && Number(current.quantity) > 1;
      const wasActive = active; active = shouldActivate;
      if (wasActive && !active && Number(current.quantity) === 1) {
        singleWasUsed = true;
        restoreShared?.(model.activeUnits()[0]);
      }
      if (shouldActivate) {
        const services = [...host.querySelectorAll('[name="service"]:checked')].map(input => input.value);
        model.sync(selection(), services);
        if (singleWasUsed) { model.adoptSingleUnit(selection(), services); singleWasUsed = false; }
      } else if (Number(current.quantity) === 1 && model.snapshot().units.length) singleWasUsed = true;
      host.classList.toggle('cab-batch-active', active);
      quote.hidden = !active || step() !== 3;
      if (footerReview) footerReview.hidden = !quote.hidden;
      if (!quote.hidden) {
        const state = model.estimate();
        quote.querySelector('[data-batch-quote-units]').textContent = `${state.count} aircons · ${state.tasks} service task${state.tasks === 1 ? '' : 's'}`;
        quote.querySelector('[data-batch-quote-total]').textContent = state.tasks ? money(state.total) : '—';
      }
      modes.hidden = !active; servicesRoot.hidden = !active; legacyServices.hidden = active;
      if (!active) { detailsRoot.hidden = true; return false; }
      modes.querySelectorAll('input').forEach(input => { input.checked = input.value === model.detailsMode; });
      servicesRoot.querySelectorAll('[name="batchServicesMode"]').forEach(input => { input.checked = input.value === model.servicesMode; });
      modes.querySelector('[data-batch-mode-note]').textContent = model.detailsMode === 'shared'
        ? `Enter one brand, type and HP below for all ${model.count} aircons. Choose Different details if any unit differs.`
        : 'Your starting details are copied. Change only what differs, or copy a matching field from Aircon 1.';
      refreshDetails(!wasActive || restored); refreshServices(restored); restored = false;
      return true;
    }
    const onChange = event => {
      event.stopPropagation();
      const input = event.target;
      try {
        if (input.name === 'batchDetailsMode') { model.setDetailsMode(input.value); detailSignature = ''; }
        else if (input.name === 'batchServicesMode') model.setServicesMode(input.value);
        else if (input.dataset.batchService) model.selectService(input.dataset.batchService, input.checked, input.dataset.serviceUnit === undefined ? undefined : Number(input.dataset.serviceUnit));
        else if (input.dataset.unitField) {
          const index = Number(input.dataset.unitIndex), field = input.dataset.unitField;
          if (field === 'brand') { model.setDetail(index, 'customBrand', input.value === '__other__'); model.setDetail(index, 'brand', input.value === '__other__' ? '' : input.value); }
          else model.setDetail(index, field === 'brandCustom' ? 'brand' : field, input.value);
          if (['brand','airconType'].includes(field)) {
            refreshDetails(true);
            const target = detailsRoot.querySelector(`[data-unit-row="${index}"] [data-unit-field="${field === 'brand' && input.value === '__other__' ? 'brandCustom' : field === 'airconType' ? 'hp' : 'brand'}"]`);
            target?.focus();
          }
        }
        update(); changed();
      } catch (error) { notify(error.message, true, Boolean(input.dataset.batchService)); }
    };
    [modes, detailsRoot, servicesRoot].forEach(root => {
      root.addEventListener('change', onChange);
      root.addEventListener('input', event => { event.stopPropagation(); if (['brandCustom','model'].includes(event.target.dataset.unitField)) onChange(event); });
      root.addEventListener('click', event => {
        const copy = event.target.closest('[data-copy-unit]'), unitHelp = event.target.closest('[data-unit-help-index]');
        if (!copy && !unitHelp) return;
        event.preventDefault(); event.stopPropagation();
        if (unitHelp) return help?.(Number(unitHelp.dataset.unitHelpIndex));
        try { model.copy(copy.dataset.copyUnit); refreshDetails(true); update(); changed(); notify(`${copy.dataset.copyUnit === 'all' ? 'Details' : { brand:'Brand',airconType:'Type',hp:'HP' }[copy.dataset.copyUnit]} copied from Aircon 1 to the other ${model.count - 1} aircon${model.count === 2 ? '' : 's'}.`); }
        catch (error) { notify(error.message, true); }
      });
    });
    function focusInvalid() {
      const units = model.activeUnits(), index = units.findIndex(unit => model.issue(unit));
      if (index < 0 || model.detailsMode !== 'individual') return false;
      const issue = model.issue(units[index]), row = detailsRoot.querySelector(`[data-unit-row="${index}"]`);
      const field = issue.field === 'brand' && row.querySelector('[data-custom-brand]')?.hidden === false ? 'brandCustom' : issue.field;
      const input = row.querySelector(`[data-unit-field="${field}"]`);
      input?.focus(); input?.reportValidity(); notify(`${unitTitle(index)}: ${issue.message}`, true);
      return true;
    }
    return { model, sync, refreshServices, focusInvalid,
      active: () => active, differentDetails: () => model.detailsMode === 'individual',
      detailsValid: () => model.activeUnits().every(unit => !model.issue(unit)),
      snapshot: () => model.snapshot(), restore(value) { model.restore(value); restored = true; },
      reset() { model.reset(); detailSignature = ''; serviceSignature = ''; active = false; singleWasUsed = false; modes.hidden = true; detailsRoot.hidden = true; servicesRoot.hidden = true; legacyServices.hidden = false; quote.hidden = true; if (footerReview) footerReview.hidden = false; host.classList.remove('cab-batch-active'); },
    };
  }

  return { createModel, mount };
});

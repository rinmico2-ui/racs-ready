(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RepairApplianceBooking = Object.assign(api.create(), api);
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const other = value => /^(other|others)(?:$|[\s_(])/i.test(String(value || '').trim());
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const icon = (value, fallback) => /^bi-[a-z0-9-]+$/.test(value || '') ? value : fallback;
  const defaults = [
    { slug: 'aircon', name: 'Air Conditioning', icon: 'bi-snow', unitTypes: ['Split Type Aircon', 'Window Type Aircon', 'Floor Mounted Aircon', 'Cassette Type Aircon', 'Central Aircon'].map(value => ({ value, label: value })) },
    { slug: 'appliance', name: 'Home Appliances', icon: 'bi-house-gear', unitTypes: ['Refrigerator', 'Freezer', 'Washing Machine', 'Dryer', 'Microwave Oven', 'Electric Fan', 'Rice Cooker', 'Water Dispenser', 'Electric Kettle'].map(value => ({ value, label: value })) },
  ];
  function catalog(values) {
    return (Array.isArray(values) && values.length ? values : defaults)
      .filter(category => category.active !== false && !other(category.slug) && !other(category.name))
      .flatMap((category, index) => (category.unitTypes || []).filter(unit => !other(unit.value) && !other(unit.label))
        .map(unit => ({ ...unit, label: unit.label || unit.value, category: category.slug,
          categoryName: category.name || category.slug, categoryIcon: icon(category.icon, category.slug === 'aircon' ? 'bi-snow' : 'bi-house-gear'),
          kind: `repair_${category.slug}_${unit.value}` })));
  }
  const identity = row => String(row.id || row._id || '');
  function create() {
    let builder, hooks, units = [], selectedCategory = '';
    const field = name => hooks.host.querySelector(`[name="${name}"]`);
    const selectedUnit = kind => units.find(unit => unit.kind === kind);
    function choiceMarkup() {
      const groups = [...new Map(units.map(unit => [unit.category, unit])).values()];
      return `<div class="cab-repair-picker" data-repair-appliances><select name="kind" hidden aria-label="Selected repair appliance" tabindex="-1"><option value=""></option>${units.map(unit => `<option value="${escape(unit.kind)}">${escape(unit.label)}</option>`).join('')}</select><div class="cab-repair-categories" role="group" aria-label="Appliance categories">${groups.map(group => `<button type="button" class="cab-repair-category" data-repair-category="${escape(group.category)}" aria-pressed="false"><span class="cab-repair-category-icon" aria-hidden="true"><i class="bi ${group.categoryIcon}"></i></span><strong>${escape(group.categoryName)}</strong><small>${units.filter(unit => unit.category === group.category).length} choices</small><i class="bi bi-check-circle-fill cab-repair-check" aria-hidden="true"></i></button>`).join('')}</div><section class="cab-repair-types" data-repair-types hidden aria-labelledby="cabRepairTypeHeading"><h4 id="cabRepairTypeHeading" tabindex="-1">What type of appliance is it?</h4><p class="cab-note">Choose the appliance you want us to check.</p><div class="cab-repair-type-grid" data-repair-type-grid role="group" aria-label="Appliance types"></div></section>${groups.length ? '' : '<p class="cab-note">No repair appliances are available right now. Please contact our team.</p>'}</div>`;
    }
    function syncChoices(kind) {
      const selected = selectedUnit(kind);
      selectedCategory = selected?.category || '';
      renderChoices();
    }
    function renderChoices() {
      const root = hooks.host.querySelector('[data-repair-appliances]');
      if (!root) return;
      const selected = field('kind').value;
      root.querySelectorAll('[data-repair-category]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.repairCategory === selectedCategory)));
      root.querySelector('[data-repair-types]').hidden = !selectedCategory;
      root.querySelector('[data-repair-type-grid]').innerHTML = units.filter(unit => unit.category === selectedCategory)
        .map(unit => `<button type="button" class="cab-repair-type" data-repair-kind="${escape(unit.kind)}" aria-pressed="${unit.kind === selected}"><i class="bi ${icon(unit.icon, unit.categoryIcon)}" aria-hidden="true"></i><span>${escape(unit.label)}</span><i class="bi bi-check-circle-fill cab-repair-check" aria-hidden="true"></i></button>`).join('');
    }
    function mount(options) {
      hooks = options; units = catalog(options.categories);
      if (builder) return builder.sync();
      const base = window.ApplianceServices;
      const service = { _id: 'repair-inspection', name: 'Repair inspection', active: true,
        brands: [...new Set((options.coreServices || []).flatMap(item => item.brands || []))] };
      const pricing = selected => {
        const unit = selectedUnit(selected.applianceKind);
        if (!unit) throw Error('Choose an available repair appliance.');
        const override = unit.inspectionFee == null || unit.inspectionFee === '' ? NaN : Number(unit.inspectionFee);
        const unitPrice = Number.isFinite(override) && override >= 0 ? override : Number(options.defaultInspectionFee ?? 500);
        return { unitPrice, totalPrice: unitPrice * Number(selected.quantity), duration: Number(options.inspectionDuration) || 90, hp: null, airconType: null };
      };
      const adapter = { ...base, kinds: units.map(unit => unit.kind), labels: Object.fromEntries(units.map(unit => [unit.kind, unit.label])),
        profile: (_service, kind) => selectedUnit(kind) ? { pricingMode: 'fixed', enabled: true } : null,
        price: (_service, selected) => pricing(selected), needsVerification: () => false, isRelocation: () => false,
        remainingUnits: (rows, editingId) => Math.max(0, 40 - base.unitCount(rows.filter(row => !editingId || identity(row) !== String(editingId)))),
        serviceLines: (_catalog, selected, _ids, editingId) => {
          const unit = selectedUnit(selected.applianceKind), price = pricing(selected);
          const prior = options.state.selectedServices.find(row => identity(row) === String(editingId));
          return [{ type: 'repair', serviceId: null, id: `repair-${crypto.randomUUID()}`, name: `${selected.brand} ${unit.label}`,
            brand: selected.brand, model: selected.model, quantity: selected.quantity, unitType: unit.value, unitCategory: unit.category,
            applianceType: unit.value, applianceTypeName: unit.label, hp: null, airconType: null, ...price,
            initialCost: price.unitPrice, problemDescription: field('assistanceNotes').value.trim(), repairIssue: field('assistanceNotes').value.trim(),
            photos: field('assistancePhotos').files.length ? Array.from(field('assistancePhotos').files) : [...(prior?.photos || [])] }];
        },
      };
      builder = window.CoreApplianceBooking.create();
      builder.mount([service], { ...options, repair: true, adapter, applianceChoices: choiceMarkup(), syncApplianceChoices: syncChoices,
        state: { get selectedServices() { return options.state.selectedServices; }, applianceDraft: options.draft || null },
        kindFor: row => units.find(unit => unit.value === row.unitType && (!row.unitCategory || row.unitCategory === unit.category))?.kind || '', serviceIdFor: () => service._id,
        validate: selected => {
          if (!field('assistanceNotes') || field('assistanceNotes').value.trim().length < 10) return 'Describe the problem in at least 10 characters.';
          const files = Array.from(field('assistancePhotos')?.files || []), max = selected.brand === "I don't know" ? 2 : 5;
          return files.length > max || files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024)
            ? `Choose up to ${max} JPG, PNG or WEBP photos, 5 MB each.` : '';
        },
        commit: (rows, editingId) => {
          const prior = options.state.selectedServices.find(row => identity(row) === String(editingId));
          const row = { ...(prior || {}), ...rows[0], id: prior ? identity(prior) : rows[0].id, units: prior?.units || [] };
          options.commit(row, editingId);
        },
        assistance: (payload, photos) => {
          const unit = selectedUnit(payload.applianceKind);
          return options.assistance({ requestType: 'repair', repairUnitType: unit.value, repairUnitCategory: unit.category,
            quantity: payload.quantity, problemDescription: payload.notes, clientRequestId: payload.clientRequestId }, photos);
        },
      });
      options.host.addEventListener('click', event => {
        const category = event.target.closest('[data-repair-category]');
        if (category && options.host.contains(category)) {
          if (selectedCategory !== category.dataset.repairCategory) {
            field('kind').value = ''; field('kind').dispatchEvent(new Event('change', { bubbles: true }));
          }
          selectedCategory = category.dataset.repairCategory; renderChoices();
          options.host.querySelector('[data-repair-types] h4').focus({ preventScroll: true });
          options.host.querySelector('[data-repair-types]').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        const unit = event.target.closest('[data-repair-kind]');
        if (unit && options.host.contains(unit) && selectedUnit(unit.dataset.repairKind)) {
          field('kind').value = unit.dataset.repairKind; field('kind').dispatchEvent(new Event('change', { bubbles: true }));
          options.host.querySelector('[data-next]').click();
        }
      });
    }
    function edit(id) {
      const prior = hooks.state.selectedServices.find(row => identity(row) === String(id));
      if (!prior || !units.some(unit => unit.value === prior.unitType)) throw Error('This appliance is no longer available for new repair selections. Contact staff to change it.');
      builder.edit(String(id));
      field('assistanceNotes').value = prior.problemDescription || prior.repairIssue || ''; builder.sync();
    }
    return { mount, edit, sync: () => builder?.sync(), pending: () => builder?.pending() || false,
      start: () => builder?.start(), reset: () => builder?.reset() };
  }
  return { create, catalog };
});

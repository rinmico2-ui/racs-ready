(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RepairApplianceBooking = Object.assign(api.create(), api);
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const other = value => /^(other|others)(?:$|[\s_(])/i.test(String(value || '').trim());
  const defaults = [
    { slug: 'aircon', name: 'Aircon', unitTypes: ['Split Type Aircon', 'Window Type Aircon', 'Floor Mounted Aircon', 'Cassette Type Aircon', 'Central Aircon'].map(value => ({ value, label: value })) },
    { slug: 'appliance', name: 'Appliances', unitTypes: ['Refrigerator', 'Freezer', 'Washing Machine', 'Dryer', 'Microwave Oven', 'Electric Fan', 'Rice Cooker', 'Water Dispenser', 'Electric Kettle'].map(value => ({ value, label: value })) },
  ];
  function catalog(values) {
    return (Array.isArray(values) && values.length ? values : defaults)
      .filter(category => category.active !== false && !other(category.slug) && !other(category.name))
      .flatMap((category, index) => (category.unitTypes || []).filter(unit => !other(unit.value) && !other(unit.label))
        .map(unit => ({ ...unit, label: unit.label || unit.value, category: category.slug, kind: `repair_${category.slug}_${unit.value}` })));
  }
  const identity = row => String(row.id || row._id || '');
  function create() {
    let builder, hooks, units = [];
    const field = name => hooks.host.querySelector(`[name="${name}"]`);
    const selectedUnit = kind => units.find(unit => unit.kind === kind);
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
      builder.mount([service], { ...options, repair: true, adapter,
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

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApplianceServices = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const kinds = ['aircon', 'refrigerator', 'freezer'];
  const labels = { aircon: 'Aircon', refrigerator: 'Refrigerator', freezer: 'Freezer' };
  const airconHpValues = Object.freeze([0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
  const repairHpValues = Object.freeze([0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7.5, 10]);
  const isRepairAircon = item => item?.unitCategory === 'aircon' || /^repair_aircon_/.test(item?.applianceKind || '') || /aircon|air condition/i.test(item?.unitType || item?.applianceType || '');
  function repairDetails(item, { prior, allowLegacyHp = false } = {}) {
    const quantity = Number(item.quantity);
    if (!['string', 'number'].includes(typeof item.quantity) || !Number.isInteger(quantity) || quantity < 1 || quantity > 40 || quantity !== 1 && quantity !== Number(prior?.quantity)) throw new Error('Add each repair appliance separately. Repair entries cover one appliance.');
    if (!isRepairAircon(item)) return { quantity, hp: null, hpDescription: null };
    const unchangedLegacyHp = allowLegacyHp && prior && isRepairAircon(prior) && prior.hp == null && (item.hp == null || item.hp === '') && item.unitType === prior.unitType;
    if (unchangedLegacyHp) return { quantity, hp: null, hpDescription: null };
    if (!['number', 'string'].includes(typeof item.hp) || !repairHpValues.includes(Number(item.hp))) throw new Error('Choose the aircon HP, or ask staff to identify your unit.');
    return { quantity, hp: Number(item.hp), hpDescription: `${Number(item.hp)} HP` };
  }
  function parseHp(value) {
    const text = String(value ?? '').trim(), parts = text.split('/');
    if (!text || parts.length > 2 || !parts.every(part => /^\d+(?:\.\d+)?$/.test(part.trim()))) return NaN;
    const hp = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(text);
    const rounded = Math.round(hp * 1000000) / 1000000;
    return Number.isFinite(rounded) && rounded > 0 ? rounded : NaN;
  }
  function formatHp(value) {
    const hp = parseHp(value);
    for (const fraction of ['1/8', '1/6', '1/5', '1/4', '1/3', '1/2', '3/4']) {
      if (hp === parseHp(fraction)) return fraction;
    }
    return Number.isFinite(hp) ? String(hp) : '';
  }
  function profiles(catalog) {
    return [{ kind: 'aircon', enabled: catalog.isAirconService !== false }, ...(catalog.applianceProfiles || [])];
  }
  function profile(catalog, kind) {
    if (!kinds.includes(kind)) throw new Error('Choose a supported appliance.');
    return profiles(catalog).find(row => row.kind === kind && row.enabled);
  }
  function unitCount(services) {
    let total = 0;
    const groups = new Map();
    for (const item of services || []) {
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 40) throw new Error('Choose 1 to 40 appliances for each item.');
      const groupId = item.applianceGroupId;
      if (!groupId) { total += quantity; continue; }
      if (typeof groupId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(groupId) || (item.type || item.serviceType || 'core') !== 'core') throw new Error('Invalid shared appliance details.');
      const signature = JSON.stringify([quantity, item.applianceKind || 'aircon', item.brand || '', item.model || '', item.airconType || item.applianceType || '', item.hp == null ? null : Number(item.hp)]);
      const existing = groups.get(groupId);
      const serviceId = String(item.serviceId || '');
      if (existing) {
        if (existing.signature !== signature) throw new Error('Services for the same appliance must have matching appliance details and quantity.');
        if (existing.services.has(serviceId)) throw new Error('Choose each service only once for the same appliance.');
        existing.services.add(serviceId);
      } else {
        groups.set(groupId, { signature, services: new Set([serviceId]) });
        total += quantity;
      }
    }
    if (total > 40) throw new Error('A booking can contain at most 40 appliances.');
    return total;
  }
  const sharedSplitTypes = Object.freeze({ split_suspended: 'Split Suspended', cassette: 'Cassette Type' });
  const catalogValue = value => typeof value?.toObject === 'function' ? value.toObject() : value;
  function airconHpOptions(catalog, airconType, { inheritSplit = true } = {}) {
    const types = Array.isArray(catalog?.airconTypes) ? catalog.airconTypes : [];
    const own = (types.length ? types.find(row => row.type === airconType)?.hpPricing || [] : catalog?.hpPricing || []).map(catalogValue);
    // Company rule: a missing suspended/cassette rate uses this service's
    // exact saved split rate and work time. A separate saved rate always wins.
    // Never estimate a capacity, use another service, or hide an invalid rate.
    const tiers = [...own];
    if (inheritSplit && types.length && catalog?.isAirconService && Object.hasOwn(sharedSplitTypes, airconType)) {
      for (const row of airconHpOptions(catalog, 'split', { inheritSplit: false })) {
        const existing = own.find(item => Number(item?.hp) === row.hp);
        if (!existing || existing.price == null || String(existing.price).trim() === '') {
          tiers.push({ ...row, pricingSource: 'split' });
        }
      }
    }
    const seen = new Set();
    return tiers.filter(row => {
      const hp = Number(row?.hp), amount = Number(row?.price);
      if (!(hp > 0) || !Number.isFinite(hp) || row?.price == null || String(row.price).trim() === ''
        || !Number.isFinite(amount) || amount < 0 || seen.has(hp)) return false;
      seen.add(hp); return true;
    }).map(row => ({ ...row, hp: Number(row.hp), price: Number(row.price) })).sort((a, b) => a.hp - b.hp);
  }
  function effectiveAirconTypes(catalog) {
    const types = (catalog?.airconTypes || []).map(type => ({ ...catalogValue(type), hpPricing: type.type ? airconHpOptions(catalog, type.type) : (type.hpPricing || []).map(catalogValue) }));
    if (catalog?.isAirconService && airconHpOptions(catalog, 'split', { inheritSplit: false }).length) {
      for (const [type, name] of Object.entries(sharedSplitTypes)) {
        if (!types.some(row => row.type === type)) types.push({ type, name, hpPricing: airconHpOptions(catalog, type) });
      }
    }
    return types;
  }
  function unitPrice(catalog, selection) {
    if (!catalog || catalog.active === false) throw new Error('This service is unavailable.');
    const kind = selection.applianceKind || 'aircon';
    const supported = profile(catalog, kind);
    if (!supported) throw new Error('This service is not available for the selected appliance.');
    if (kind !== 'aircon') {
      const hp = selection.hp == null || selection.hp === '' ? null : parseHp(selection.hp);
      if (hp !== null && !Number.isFinite(hp)) throw new Error('Choose a valid compressor HP.');
      if (supported.pricingMode === 'hp') {
        const tier = (supported.hpPricing || []).find(row => parseHp(row.hp) === hp);
        if (!tier || hp === null) {
          const error = new Error('Choose a compressor HP with a saved price for this service. If you do not know it, use Repair Service for an inspection.');
          error.hpNeeded = true; throw error;
        }
        if (tier.price == null || !Number.isFinite(Number(tier.price)) || Number(tier.price) < 0 || !(Number(tier.durationMinutes) > 0)) throw new Error('Staff must set a price and work time for this compressor HP.');
        return { unitPrice: Number(tier.price), duration: Number(tier.durationMinutes), hp, airconType: null, airconTypeName: null };
      }
      if (supported.unitPrice == null || !Number.isFinite(Number(supported.unitPrice)) || Number(supported.unitPrice) < 0 || !(Number(supported.durationMinutes) > 0)) throw new Error('Staff must set a price and work time before this service can be booked.');
      return { unitPrice: Number(supported.unitPrice), duration: Number(supported.durationMinutes), hp, airconType: null, airconTypeName: null };
    }
    const types = catalog.airconTypes || [], tiers = catalog.hpPricing || [];
    const pricedByHp = catalog.isAirconService && (types.length || tiers.length);
    const selectedType = effectiveAirconTypes(catalog).find(row => row.type === selection.airconType);
    const tier = airconHpOptions(catalog, selection.airconType).find(row => row.hp === Number(selection.hp));
    if (pricedByHp && (!tier || !(Number(selection.hp) > 0))) throw new Error('This aircon type and HP combination is unavailable. Staff must configure its price.');
    const rawPrice = pricedByHp ? tier.price : catalog.basePrice;
    const amount = Number(rawPrice);
    if (rawPrice == null || String(rawPrice).trim() === '' || !Number.isFinite(amount) || amount < 0) throw new Error('This service does not have a valid catalog price.');
    return { unitPrice: amount, duration: Number(tier?.durationMinutes || catalog.durationMinutes || catalog.durationRange?.max || 60),
      hp: pricedByHp ? Number(selection.hp) : null, airconType: selectedType?.type || selection.airconType || null,
      airconTypeName: selectedType?.name || selection.airconTypeName || null };
  }
  function price(catalog, selection) {
    if (!String(selection.brand || '').trim() || ['__other__', '__unknown__'].includes(selection.brand)) throw new Error('Enter the appliance brand.');
    return unitPrice(catalog, selection);
  }
  function availability(catalog, selection) {
    try {
      const pricing = unitPrice(catalog, selection);
      return { available: true, pricing };
    } catch (error) {
      return { available: false, reason: error?.message || 'Service unavailable', hpNeeded: Boolean(error?.hpNeeded) };
    }
  }
  function isRelocation(service) {
    return service?.slug === 'aircon-relocation' || Boolean(service?.relocation?.scope) || /^aircon relocation$/i.test(service?.name || '');
  }
  function assertStandaloneServices(rows) {
    if ((rows || []).some(isRelocation) && (rows.length !== 1 || Number(rows[0].quantity) !== 1)) {
      throw new Error('Aircon Relocation must be booked on its own for one aircon. Book other services separately.');
    }
  }
  function assertSingleServiceType(rows) {
    if (!Array.isArray(rows)) throw Object.assign(new Error('Choose valid service details.'), { status:400, code:'SERVICE_SELECTION_INVALID' });
    const types = new Set(rows.map(item => {
      const type = String(item?.type || item?.serviceType || 'core').trim().toLowerCase();
      return ['repair', 'repairservices', 'repair_service'].includes(type) ? 'repair' : type === 'mixed' ? 'mixed' : 'core';
    }));
    if (types.has('mixed') || types.size > 1) {
      throw Object.assign(new Error('Book Core Services and Repair Service separately. Choose one service category per booking.'), {
        status:400, code:'MIXED_SERVICE_BOOKING_NOT_ALLOWED',
      });
    }
    return types.values().next().value || null;
  }
  function needsVerification(catalog, selection) {
    const supported = profile(catalog, selection.applianceKind || 'aircon');
    if (!supported) return false;
    if (selection.applianceKind && selection.applianceKind !== 'aircon') return supported.pricingMode === 'hp' && !Number.isFinite(parseHp(selection.hp));
    return Boolean(catalog.isAirconService && (catalog.airconTypes?.length || catalog.hpPricing?.length) &&
      (catalog.airconTypes?.length && !effectiveAirconTypes(catalog).some(row => row.type === selection.airconType) || !Number.isFinite(parseHp(selection.hp))));
  }
  function serviceLines(catalog, selection, serviceIds, groupId, relocation) {
    if (!serviceIds.length || new Set(serviceIds).size !== serviceIds.length) throw new Error('Choose at least one service, without duplicates.');
    const rows = serviceIds.map(id => {
      const service = catalog.find(row => String(row._id) === String(id));
      let move;
      if (isRelocation(service)) {
        if (selection.applianceKind !== 'aircon' || Number(selection.quantity) !== 1) throw new Error('Book one aircon relocation at a time.');
        if (!['same_property', 'different_address'].includes(relocation?.scope)) throw new Error('Choose where the aircon will move.');
        if (serviceIds.length !== 1) throw new Error('Aircon Relocation must be booked on its own. Book other services separately.');
        const from = String(relocation.from?.details || '').trim(), to = String(relocation.to?.details || '').trim();
        if (relocation.scope === 'same_property' && (from.length < 2 || to.length < 2)) throw new Error('Enter the current and new positions on the property.');
        move = { ...relocation, from: { ...(relocation.from || {}), details: from }, to: { ...(relocation.to || {}), details: to }, model: selection.model || '' };
      }
      const pricing = price(service, selection);
      return { ...selection, ...pricing, ...(move ? { relocation: move } : {}), id: `${groupId}_${id}`, applianceGroupId: groupId, serviceId: id, name: service.name,
        type: 'core', isAirconService: selection.applianceKind === 'aircon', totalPrice: pricing.unitPrice * Number(selection.quantity),
        applianceType: selection.applianceKind === 'aircon' ? pricing.airconType : selection.applianceKind,
        applianceTypeName: selection.applianceKind === 'aircon' ? pricing.airconTypeName : labels[selection.applianceKind] };
    });
    unitCount(rows);
    assertStandaloneServices(rows);
    return rows;
  }
  function setQuantity(services, index, quantity) {
    const selected = services[index];
    if (!selected) throw new Error('Appliance not found.');
    if (selected.type === 'repair' && Number(quantity) !== Number(selected.quantity)) throw new Error('Add each repair appliance separately. Contact staff to change an existing repair quantity.');
    const sameAppliance = row => row === selected || selected.applianceGroupId && row.applianceGroupId === selected.applianceGroupId;
    const proposed = services.map(row => sameAppliance(row) ? { ...row, quantity } : row);
    assertStandaloneServices(proposed);
    unitCount(proposed);
    services.filter(sameAppliance).forEach(row => {
      const unitPrice = Number(row.unitPrice ?? Number(row.totalPrice) / row.quantity) || 0;
      row.quantity = quantity; row.unitPrice = unitPrice; row.totalPrice = unitPrice * quantity;
    });
  }
  function remainingUnits(services, editingGroupId) {
    return Math.max(0, 40 - unitCount((services || []).filter(row => !editingGroupId || row.applianceGroupId !== editingGroupId)));
  }
  return { kinds, labels, profiles, profile, price, unitPrice, availability, airconHpOptions, effectiveAirconTypes, airconHpValues, unitCount, serviceLines, setQuantity, remainingUnits, parseHp, formatHp, isRelocation, assertStandaloneServices, assertSingleServiceType, needsVerification, repairHpValues, isRepairAircon, repairDetails };
});

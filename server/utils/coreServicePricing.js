function resolveCoreServicePricing(catalog, selection) {
  if (!catalog || catalog.active === false) throw new Error('This service is unavailable.');
  const quantity = Number(selection.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 40) throw new Error('Choose a valid number of units.');
  if (selection.applianceKind) {
    const pricing = require('../public/js/appliance-services').price(catalog, selection);
    return { ...pricing, totalPrice: pricing.unitPrice * quantity };
  }
  const types = Array.isArray(catalog.airconTypes) ? catalog.airconTypes : [];
  const legacyTiers = Array.isArray(catalog.hpPricing) ? catalog.hpPricing : [];
  const pricedByHp = Boolean(catalog.isAirconService && (types.length || legacyTiers.length));
  let tier = null;
  let selectedType = null;
  if (pricedByHp) {
    if (!String(selection.brand || '').trim() || ['__other__','__unknown__'].includes(String(selection.brand).trim())) throw new Error('Enter a brand or choose I don\'t know.');
    const hp = Number(selection.hp);
    if (!Number.isFinite(hp) || hp <= 0) throw new Error('Aircon HP must be identified before booking.');
    if (types.length) {
      selectedType = require('../public/js/appliance-services').effectiveAirconTypes(catalog).find(item => item.type === selection.airconType);
      if (!selectedType) throw new Error('Choose a supported aircon type before booking.');
      tier = require('../public/js/appliance-services').airconHpOptions(catalog, selection.airconType).find(item => item.hp === hp);
    } else {
      tier = require('../public/js/appliance-services').airconHpOptions(catalog, selection.airconType).find(item => item.hp === hp);
    }
    if (!tier) throw new Error('This aircon type and HP combination is unavailable.');
  }
  const rawPrice = pricedByHp ? tier.price : catalog.basePrice;
  const unitPrice = Number(rawPrice);
  if (rawPrice == null || String(rawPrice).trim() === '' || !Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('This service does not have a valid catalog price.');
  const duration = Number((pricedByHp && tier.durationMinutes) || catalog.durationMinutes || catalog.durationRange?.max || 60);
  return {
    unitPrice,
    totalPrice: unitPrice * quantity,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 60,
    airconType: selectedType?.type || selection.airconType || null,
    airconTypeName: selectedType?.name || selection.airconTypeName || null,
    hp: pricedByHp ? Number(selection.hp) : null,
  };
}

module.exports = { resolveCoreServicePricing };

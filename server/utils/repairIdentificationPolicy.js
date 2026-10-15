'use strict';
const { resolveRepairInspectionFees } = require('./repairInspectionPricing');
const { getInspectionDurationMinutes } = require('./bookingPolicy');
const invalid = message => Object.assign(new Error(message), { status: 400 });
function text(value, name, max) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw invalid(`Check the ${name}.`);
  return value.trim();
}
const unknownBrand = value => !value || /^(i don.t know|unknown|__unknown__|__other__)$/i.test(value);
async function inspection(unitType, unitCategory) {
  const [pricing] = await resolveRepairInspectionFees([{ type: 'repair', unitType, unitCategory }]);
  return pricing;
}
async function normalizeRepairIdentification(body) {
  const quantity = Number(body.quantity);
  if (!['string', 'number'].includes(typeof body.quantity) || !Number.isInteger(quantity) || quantity < 1 || quantity > 40) throw invalid('Choose 1 to 40 appliances.');
  const unitType = text(body.repairUnitType, 'appliance type', 80), unitCategory = text(body.repairUnitCategory, 'repair category', 80);
  const problemDescription = text(body.problemDescription, 'reported problem', 500);
  if (problemDescription.length < 10) throw invalid('Describe the problem in at least 10 characters.');
  const pricing = await inspection(unitType, unitCategory);
  const kind = /aircon/i.test(pricing.unitType) ? 'aircon' : /refrigerator/i.test(pricing.unitType) ? 'refrigerator' : /freezer/i.test(pricing.unitType) ? 'freezer' : 'other';
  return { requestType: 'repair', applianceKind: kind, serviceId: null, serviceName: `Repair inspection · ${pricing.unitLabel}`,
    brand: "I don't know", model: '', airconType: '', hp: null, quantity,
    notes: text(body.notes, 'notes', 1000), repair: { unitType: pricing.unitType, unitCategory: pricing.categorySlug, inspectionFee: pricing.fee, problemDescription } };
}
async function verifiedRepairPricing(request, body) {
  const brand = text(body.brand, 'brand', 80);
  if (unknownBrand(brand)) throw invalid('Confirm the appliance brand before sending the inspection quote.');
  const pricing = await inspection(text(body.unitType || request.repair?.unitType, 'appliance type', 80), request.repair?.unitCategory);
  return { brand, unitType: pricing.unitType, unitCategory: pricing.categorySlug,
    unitPrice: pricing.fee, duration: await getInspectionDurationMinutes(), airconType: null, airconTypeName: pricing.unitLabel, hp: null };
}
function repairQuoteMatches(request, item, now = Date.now()) {
  const quote = request?.quote;
  return Boolean(request?.requestType === 'repair' && request.status === 'accepted' && !request.existingBookingId && !request.bookingId &&
    new Date(quote?.expiresAt).getTime() > now && Number(request.quantity) === Number(item.quantity) &&
    quote.brand === item.brand && request.model === item.model && quote.unitType === item.unitType && quote.unitCategory === item.unitCategory &&
    Number(quote.unitPrice) === Number(item.unitPrice));
}
module.exports = { normalizeRepairIdentification, verifiedRepairPricing, repairQuoteMatches, unknownBrand };

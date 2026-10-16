'use strict';
const { resolveRepairInspectionFees } = require('./repairInspectionPricing');
const { getInspectionDurationMinutes } = require('./bookingPolicy');
const invalid = message => Object.assign(new Error(message), { status: 400 });
const appliance = require('../public/js/appliance-services');
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
  if (!['string', 'number'].includes(typeof body.quantity) || quantity !== 1) throw invalid('Submit a separate identification request for each repair appliance.');
  const unitType = text(body.repairUnitType, 'appliance type', 80), unitCategory = text(body.repairUnitCategory, 'repair category', 80);
  const problemDescription = text(body.problemDescription, 'reported problem', 500);
  if (problemDescription.length < 10) throw invalid('Describe the problem in at least 10 characters.');
  const pricing = await inspection(unitType, unitCategory);
  const kind = appliance.isRepairAircon({ unitType: pricing.unitType, unitCategory: pricing.categorySlug }) ? 'aircon' : /refrigerator/i.test(pricing.unitType) ? 'refrigerator' : /freezer/i.test(pricing.unitType) ? 'freezer' : 'other';
  return { requestType: 'repair', applianceKind: kind, serviceId: null, serviceName: `Repair inspection · ${pricing.unitLabel}`,
    brand: "I don't know", model: '', airconType: '', hp: null, quantity,
    notes: text(body.notes, 'notes', 1000), repair: { unitType: pricing.unitType, unitCategory: pricing.categorySlug, inspectionFee: pricing.fee, problemDescription } };
}
async function verifiedRepairPricing(request, body) {
  const brand = text(body.brand, 'brand', 80);
  if (unknownBrand(brand)) throw invalid('Confirm the appliance brand before sending the inspection quote.');
  const pricing = await inspection(text(body.unitType || request.repair?.unitType, 'appliance type', 80), request.repair?.unitCategory);
  let details;
  try { details = appliance.repairDetails({ unitType: pricing.unitType, unitCategory: pricing.categorySlug, quantity: request.quantity, hp: body.hp }, { prior: request }); }
  catch (error) { throw invalid(error.message); }
  return { brand, unitType: pricing.unitType, unitCategory: pricing.categorySlug,
    unitPrice: pricing.fee, duration: await getInspectionDurationMinutes(), airconType: appliance.isRepairAircon({ unitCategory: pricing.categorySlug, unitType: pricing.unitType }) ? pricing.unitType : null, airconTypeName: pricing.unitLabel, hp: details.hp };
}
function repairQuoteMatches(request, item, now = Date.now()) {
  const quote = request?.quote;
  return Boolean(request?.requestType === 'repair' && request.status === 'accepted' && !request.existingBookingId && !request.bookingId &&
    new Date(quote?.expiresAt).getTime() > now && Number(request.quantity) === Number(item.quantity) &&
    quote.brand === item.brand && request.model === item.model && quote.unitType === item.unitType && quote.unitCategory === item.unitCategory &&
    Number(quote.hp || 0) === Number(item.hp || 0) &&
    Number(quote.unitPrice) === Number(item.unitPrice));
}
module.exports = { normalizeRepairIdentification, verifiedRepairPricing, repairQuoteMatches, unknownBrand };

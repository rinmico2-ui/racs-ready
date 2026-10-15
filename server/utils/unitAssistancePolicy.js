'use strict';
const A = require('../public/js/appliance-services');
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function text(value, name, max) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw invalid(`Enter a valid ${name} up to ${max} characters.`);
  return value.trim();
}
function normalizeUnitAssistance(catalog, body) {
  const applianceKind = body.applianceKind === undefined ? 'aircon' : body.applianceKind;
  if (!A.kinds.includes(applianceKind)) throw invalid('Choose a supported appliance.');
  if (!catalog || catalog.active === false) throw invalid('This service is unavailable.');
  const supported = A.profile(catalog, applianceKind);
  if (!supported) throw invalid('Unit identification is unavailable for this appliance and service.');
  const quantity = Number(body.quantity);
  if (!['number', 'string'].includes(typeof body.quantity) || !Number.isInteger(quantity) || quantity < 1 || quantity > 40) throw invalid('Choose 1 to 40 appliances.');
  const brand = text(body.brand, 'brand', 80) || "I don't know";
  const model = text(body.model, 'model', 50);
  if (model && !/^[A-Za-z0-9][A-Za-z0-9 ._/#()+-]*$/.test(model)) throw invalid('Check the model number.');
  const airconType = text(body.airconType, 'aircon type', 40);
  if (airconType && (applianceKind !== 'aircon' || !catalog.airconTypes?.some(row => row.type === airconType))) throw invalid('Choose a supported aircon type.');
  const hp = body.hp == null || body.hp === '' ? null : A.parseHp(body.hp);
  if (hp !== null && (!['number', 'string'].includes(typeof body.hp) || !Number.isFinite(hp))) throw invalid('Enter a valid HP.');
  return { applianceKind, brand, model, airconType, hp, quantity, notes: text(body.notes, 'notes', 1000) };
}
function quoteMatchesRequest(request, item, pricing, now = Date.now()) {
  const quote = request?.quote;
  const expiration = new Date(quote?.expiresAt).getTime();
  return Boolean(request && !request.existingBookingId && !request.bookingId && request.status === 'accepted' && quote &&
    Number.isFinite(expiration) && expiration > now && String(request.serviceId) === String(item.serviceId) &&
    (request.applianceKind || 'aircon') === (item.applianceKind || 'aircon') &&
    Number(request.quantity) === Number(item.quantity) &&
    String(quote.airconType || '') === String(pricing.airconType || '') &&
    (quote.hp == null ? null : Number(quote.hp)) === pricing.hp &&
    quote.brand === String(item.brand || '').trim() && quote.unitPrice === pricing.unitPrice);
}
module.exports = { normalizeUnitAssistance, quoteMatchesRequest };

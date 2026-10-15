'use strict';
const axios = require('axios');
const rateLimit = require('./boundedRateLimit');
const { createWorkLimiter } = require('./workLimiter');
const coverage = require('../public/js/nueva-ecija-coverage');
const localAddresses = require('./nuevaEcijaAddresses');
const work = createWorkLimiter({ limit:8,perKeyLimit:2 });
const cache = new Map(), pending = new Map();
const ttl = 5 * 60 * 1000;
const blockedUntil = new Map();
const outageCooldown = 30000;
const suggestionLimiter = rateLimit({ windowMs:60000,limit:90,standardHeaders:true,legacyHeaders:false,
  message:{ error:'Address suggestions are busy. Wait a moment and try again.' } });
const provider = () => String(process.env.GEOAPIFY_API_KEY || '').trim() ? 'geoapify' : 'photon';
function suggestionAvailability() {
  const preferred = provider();
  const candidates = preferred === 'geoapify' ? ['geoapify', 'photon'] : ['photon'];
  const retryAfter = Math.min(...candidates.map(name => Math.max(0, (blockedUntil.get(name) || 0) - Date.now())));
  return { enabled: true, provider: preferred, liveEnabled: retryAfter === 0, retryAfter, coverage: coverage.province, localFallback: true };
}
function providerUnavailable(retryAfter) {
  const error = new Error('Live address suggestions are temporarily unavailable. Press Search or select the location on the map.');
  error.code = 'ADDRESS_SUGGESTIONS_UNAVAILABLE';
  error.retryAfter = retryAfter;
  return error;
}
function cooldownDuration(error) {
  const raw = error.response?.headers?.['retry-after'];
  if (!raw) return outageCooldown;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(delay) ? Math.max(outageCooldown, delay) : outageCooldown;
}
function validPoint(place) {
  return place.display_name && Number.isFinite(place.lat) && Number.isFinite(place.lon) &&
    coverage.contains(place.lat, place.lon);
}
function photonLabel(properties) {
  const street = [properties.housenumber,properties.street].filter(Boolean).join(' ');
  return [...new Set([properties.name,street,properties.district,properties.city,properties.county,
    properties.state,properties.postcode,properties.country || 'Philippines'].filter(Boolean))].join(', ');
}
async function fetchProvider(name,query) {
  const retryAfter = (blockedUntil.get(name) || 0) - Date.now();
  if (retryAfter > 0) throw providerUnavailable(retryAfter);
  try {
    const results = await requestProvider(name, query);
    blockedUntil.delete(name);
    return results;
  } catch (error) {
    if (error.code === 'WORK_CAPACITY_EXCEEDED') throw error;
    const delay = cooldownDuration(error);
    blockedUntil.set(name, Date.now() + delay);
    // Axios messages/configs can contain API keys or private address queries.
    // Record only the provider name and safe failure classification.
    const reason = error.response?.status ? `HTTP ${error.response.status}`
      : error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ? 'timeout' : 'request or response failure';
    console.warn(`[Address suggestions] ${name} unavailable (${reason}); cooling down for ${Math.ceil(delay / 1000)}s`);
    const unavailable = providerUnavailable(delay);
    if (error.response?.status === 429) unavailable.status = 429;
    throw unavailable;
  }
}
async function requestProvider(name,query) {
  if (name === 'geoapify') {
    const response = await work.run(name,() => axios.get('https://api.geoapify.com/v1/geocode/autocomplete',{
      params:{ text:query,format:'json',filter:`rect:${coverage.bounds.west},${coverage.bounds.south},${coverage.bounds.east},${coverage.bounds.north}`,limit:8,lang:'en',apiKey:String(process.env.GEOAPIFY_API_KEY).trim() },timeout:5000,
    }));
    if (!Array.isArray(response.data?.results)) throw new Error('Invalid geocoding response');
    return response.data.results
      .filter(place => String(place.country_code || '').toLowerCase() === 'ph')
      .map(place => ({ display_name:String(place.formatted || place.address_line1 || place.name || '').trim(),
        lat:Number(place.lat),lon:Number(place.lon),address:{ country_code:'ph' },match_level:'suggestion',source:name })).filter(validPoint).slice(0,5);
  }
  // Photon supports search-as-you-type; the public Nominatim endpoint does not.
  const base = String(process.env.PHOTON_BASE_URL || 'https://photon.komoot.io').replace(/\/+$/,'');
  const response = await work.run(name,() => axios.get(base + '/api/',{
    params:{ q:query,limit:8,lang:'en',countrycode:'PH',bbox:`${coverage.bounds.west},${coverage.bounds.south},${coverage.bounds.east},${coverage.bounds.north}` },timeout:5000,
  }));
  if (!Array.isArray(response.data?.features)) throw new Error('Invalid geocoding response');
  return response.data.features
    .filter(feature => feature.geometry?.type === 'Point' && String(feature.properties?.countrycode || '').toLowerCase() === 'ph')
    .map(feature => ({ display_name:photonLabel(feature.properties),lat:Number(feature.geometry.coordinates?.[1]),lon:Number(feature.geometry.coordinates?.[0]),
      address:{ country_code:'ph' },match_level:'suggestion',source:name })).filter(validPoint).slice(0,5);
}
async function suggestions(query) {
  const local = localAddresses.suggestions(query);
  if (local.length) return local;
  const name = provider(), key = name + ':' + query.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < ttl) return cached.results;
  if (pending.has(key)) return pending.get(key);
  const request = (async () => {
    let results;
    try { results = await fetchProvider(name,query); }
    catch (error) { if (name !== 'geoapify' || error.code === 'WORK_CAPACITY_EXCEEDED') throw error; results = await fetchProvider('photon',query); }
    if (cache.size >= 500) cache.delete(cache.keys().next().value);
    cache.set(key,{ at:Date.now(),results }); return results;
  })().finally(() => pending.delete(key));
  pending.set(key,request); return request;
}
async function handleSuggestions(req,res) {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().replace(/\s+/g,' ') : '';
  res.set('Cache-Control','no-store');
  if (query.length < 3 || query.length > 250) return res.status(400).json({ error:'Enter 3 to 250 characters for address suggestions.',suggestions:[] });
  try { return res.json({ suggestions:await suggestions(query) }); }
  catch (error) {
    const status = error.status === 429 ? 429 : 503;
    const retryAfter = error.retryAfter || 3000;
    res.set('Retry-After', String(Math.ceil(retryAfter / 1000)));
    return res.status(status).json({
      code: error.code === 'WORK_CAPACITY_EXCEEDED' ? 'ADDRESS_SEARCH_BUSY' : 'ADDRESS_SUGGESTIONS_UNAVAILABLE',
      error:'Live address suggestions are temporarily unavailable. Press Search or select the location on the map.',
      suggestions:[], retryAfter, manualSearchAvailable:true, localFallbackAvailable:true
    });
  }
}
module.exports = { provider,suggestionAvailability,suggestionLimiter,handleSuggestions };

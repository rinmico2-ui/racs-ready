'use strict';
const axios = require('axios');
const rateLimit = require('./boundedRateLimit');
const { createWorkLimiter } = require('./workLimiter');
const work = createWorkLimiter({ limit:8,perKeyLimit:2 });
const cache = new Map(), pending = new Map();
const ttl = 5 * 60 * 1000;
const suggestionLimiter = rateLimit({ windowMs:60000,limit:90,standardHeaders:true,legacyHeaders:false,
  message:{ error:'Address suggestions are busy. Wait a moment and try again.' } });
const provider = () => String(process.env.GEOAPIFY_API_KEY || '').trim() ? 'geoapify' : 'photon';
function validPoint(place) {
  return place.display_name && Number.isFinite(place.lat) && Number.isFinite(place.lon) &&
    place.lat >= 4.5 && place.lat <= 21.5 && place.lon >= 116 && place.lon <= 127;
}
function photonLabel(properties) {
  const street = [properties.housenumber,properties.street].filter(Boolean).join(' ');
  return [...new Set([properties.name,street,properties.district,properties.city,properties.county,
    properties.state,properties.postcode,properties.country || 'Philippines'].filter(Boolean))].join(', ');
}
async function fetchProvider(name,query) {
  if (name === 'geoapify') {
    const response = await work.run(name,() => axios.get('https://api.geoapify.com/v1/geocode/autocomplete',{
      params:{ text:query,format:'json',filter:'countrycode:ph',limit:5,lang:'en',apiKey:String(process.env.GEOAPIFY_API_KEY).trim() },timeout:7000,
    }));
    return (Array.isArray(response.data?.results) ? response.data.results : [])
      .filter(place => String(place.country_code || '').toLowerCase() === 'ph')
      .map(place => ({ display_name:String(place.formatted || place.address_line1 || place.name || '').trim(),
        lat:Number(place.lat),lon:Number(place.lon),address:{ country_code:'ph' },match_level:'suggestion',source:name })).filter(validPoint).slice(0,5);
  }
  // Photon supports search-as-you-type; the public Nominatim endpoint does not.
  const base = String(process.env.PHOTON_BASE_URL || 'https://photon.komoot.io').replace(/\/+$/,'');
  const response = await work.run(name,() => axios.get(base + '/api/',{
    params:{ q:query,limit:5,lang:'en',countrycode:'PH',bbox:'116,4.5,127,21.5' },timeout:7000,
  }));
  return (Array.isArray(response.data?.features) ? response.data.features : [])
    .filter(feature => feature.geometry?.type === 'Point' && String(feature.properties?.countrycode || '').toLowerCase() === 'ph')
    .map(feature => ({ display_name:photonLabel(feature.properties),lat:Number(feature.geometry.coordinates?.[1]),lon:Number(feature.geometry.coordinates?.[0]),
      address:{ country_code:'ph' },match_level:'suggestion',source:name })).filter(validPoint).slice(0,5);
}
async function suggestions(query) {
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
    const status = error.response?.status === 429 ? 429 : error.code === 'WORK_CAPACITY_EXCEEDED' ? 503 : 502;
    if (status === 429 || status === 503) res.set('Retry-After','3');
    return res.status(status).json({ error:'Address suggestions are temporarily unavailable. Try again or select the location on the map.',suggestions:[] });
  }
}
module.exports = { provider,suggestionLimiter,handleSuggestions };

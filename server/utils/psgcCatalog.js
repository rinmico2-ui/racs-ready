'use strict';
const axios = require('axios');
const cache = new Map();
const pending = new Map();
const TTL = 60 * 60 * 1000;

async function getList(kind, cityCode, { serviceAreaOnly = false } = {}) {
  if (serviceAreaOnly) return require('./nuevaEcijaAddresses').getList(kind, cityCode);
  if (!['provinces', 'cities', 'barangays'].includes(kind)) throw new Error('Unknown address catalog.');
  if (kind === 'barangays' && !/^\d{2,10}$/.test(String(cityCode))) {
    throw Object.assign(new Error('Select a valid city or municipality.'), { status: 400, fields: { addressCity: 'Select a valid city or municipality.' } });
  }
  const key = kind + ':' + (cityCode || '');
  const saved = cache.get(key);
  if (saved && Date.now() - saved.at < TTL) return saved.data;
  if (pending.has(key)) return pending.get(key);
  const path = kind === 'cities' ? 'cities-municipalities'
    : kind === 'barangays' ? `cities-municipalities/${encodeURIComponent(cityCode)}/barangays` : 'provinces';
  const work = (async () => {
    try {
      const response = await axios.get('https://psgc.cloud/api/v2/' + path, { timeout: 8000 });
      const data = Array.isArray(response.data) ? response.data : response.data && response.data.data;
      if (!Array.isArray(data) || !data.length) throw new Error('Empty address catalog.');
      if (cache.size >= 300 && !cache.has(key)) cache.delete(cache.keys().next().value);
      cache.set(key, { data, at: Date.now() });
      return data;
    } catch (_) {
      // A recent cached catalog remains authoritative during a short outage.
      if (saved && Date.now() - saved.at < 24 * TTL) return saved.data;
      const local = require('./nuevaEcijaAddresses').getList(kind, cityCode);
      if (local.length) return local;
      throw Object.assign(new Error('Address verification is temporarily unavailable. Please try again shortly.'), { status: 503, code: 'ADDRESS_CATALOG_UNAVAILABLE' });
    }
  })();
  pending.set(key, work);
  try { return await work; }
  finally { pending.delete(key); }
}

const keyOf = value => typeof value === 'string' ? value.trim().normalize('NFKC').toLowerCase() : '';
function findEntry(rows, value, aliases = false) {
  const key = keyOf(value), cityAlias = text => keyOf(text).replace(/^city of /, '').replace(/ city$/, '').replace(/\b(norte|sur|este|oeste)\b/g, word => ({ norte:'north',sur:'south',este:'east',oeste:'west' })[word]);
  return key && rows.find(row => [row.code, row.id, row.name].some(v => keyOf(String(v || '')) === key) || aliases && cityAlias(row.name) === cityAlias(value));
}

async function validateAddressSelection(input, { serviceAreaOnly = true } = {}) {
  const fields = {};
  for (const field of ['addressProvince', 'addressCity', 'addressBarangay']) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 100) fields[field] = 'Choose a valid option.';
  }
  if (typeof input.addressPostal !== 'string' || !/^\d{4}$/.test(input.addressPostal.trim())) fields.addressPostal = 'Enter a 4-digit postal code.';
  const invalid = () => Object.assign(new Error('Check your address selections.'), { status: 400, code: 'INVALID_ADDRESS', fields });
  if (Object.keys(fields).length) throw invalid();
  const [provinces, cities] = await Promise.all([module.exports.getList('provinces', undefined, { serviceAreaOnly }), module.exports.getList('cities', undefined, { serviceAreaOnly })]);
  const province = findEntry(provinces, input.addressProvince);
  const city = findEntry(cities, input.addressCity, true);
  if (!province) fields.addressProvince = 'Choose a province from the available options.';
  else if (serviceAreaOnly && keyOf(province.name) !== 'nueva ecija') fields.addressProvince = 'We currently serve Nueva Ecija only. Choose an address in Nueva Ecija.';
  if (!city) fields.addressCity = 'Choose a city or municipality from the available options.';
  if (province && city) {
    const provinceCode = String(province.code || province.id || '');
    const cityCode = String(city.code || '');
    const belongs = city.province ? keyOf(city.province) === keyOf(province.name)
      : city.province_code ? String(city.province_code) === provinceCode
        : provinceCode.length >= 5 && cityCode.slice(0, 5) === provinceCode.slice(0, 5);
    if (!belongs) fields.addressCity = 'Choose a city or municipality in the selected province.';
  }
  if (Object.keys(fields).length) throw invalid();
  const barangays = await module.exports.getList('barangays', String(city.code || city.id), { serviceAreaOnly });
  const barangay = findEntry(barangays, input.addressBarangay, true);
  if (!barangay) { fields.addressBarangay = 'Choose a barangay in the selected city or municipality.'; throw invalid(); }
  return { province: province.name, city: city.name, barangay: barangay.name, postalCode: input.addressPostal.trim() };
}

module.exports = { getList, validateAddressSelection };

'use strict';
const catalog = require('../data/nueva-ecija-addresses.json');
const coverage = require('../public/js/nueva-ecija-coverage');
const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function getList(kind, cityCode) {
  if (kind === 'provinces') return [catalog.province];
  if (kind === 'cities') return catalog.cities;
  if (kind === 'barangays') {
    const city = catalog.cities.find(item => String(item.code) === String(cityCode));
    return city ? catalog.barangays.filter(item => item.city_municipality === city.name) : [];
  }
  return [];
}
const places = [...catalog.cities.map(city => ({ name: city.name, city: city.name, type: 'city' })),
  ...catalog.barangays.map(barangay => ({ name: barangay.name, city: barangay.city_municipality, type: 'barangay' }))]
  .map(item => ({ ...item, search: normalize([item.name, item.city, coverage.province].join(' ')) }));
function suggestions(query) {
  const tokens = normalize(query).split(' ').filter(token => token && !['brgy', 'barangay', 'city', 'of', 'municipality', 'philippines', 'ph'].includes(token));
  if (!tokens.length) return [];
  return places.map(item => {
    const words = item.search.split(' '), matches = tokens.every(token => words.some(word => word.startsWith(token)));
    return { item, score: matches ? (normalize(item.name).startsWith(normalize(query)) ? 10 : 0) + (item.type === 'city' ? 2 : 0) : -1 };
  }).filter(row => row.score >= 0).sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name)).slice(0, 5).map(({ item }) => ({
    display_name: [...new Set([item.name, item.city, coverage.province, 'Philippines'])].join(', '), lat: null, lon: null,
    address: { state: coverage.province, province: coverage.province, city: item.city, ...(item.type === 'barangay' ? { village: item.name } : {}), country_code: 'ph' },
    match_level: 'locality', source: 'psgc',
  }));
}
module.exports = { getList, suggestions };

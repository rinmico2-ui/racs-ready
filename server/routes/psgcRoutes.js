const express = require('express');
const router = express.Router();
const axios = require('axios');

const cache = new Map();

async function fetchWithRetry(url, opts = {}, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await axios.get(url, opts);
      return res;
    } catch (err) {
      lastErr = err;
      const wait = Math.min(2000, 200 * Math.pow(2, i));
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function setCache(key, data, ttl = 1000 * 60 * 60) {
  cache.set(key, { ts: Date.now(), ttl, data });
}
function getCache(key) {
  const rec = cache.get(key);
  if (!rec) return null;
  if (Date.now() - rec.ts > rec.ttl) { cache.delete(key); return null; }
  return rec.data;
}

function unwrapPayload(response) {
  const payload = response.data;
  return Array.isArray(payload) ? payload : (payload && Array.isArray(payload.data) ? payload.data : []);
}

// ── All provinces ──
router.get('/provinces', async (req, res) => {
  try {
    const cacheKey = 'psgc:provinces';
    let provinces = getCache(cacheKey);
    if (!provinces) {
      const response = await fetchWithRetry('https://psgc.cloud/api/v2/provinces', { timeout: 15000 }, 3);
      provinces = unwrapPayload(response);
      setCache(cacheKey, provinces, 1000 * 60 * 60);
    }
    res.json({ data: provinces });
  } catch (err) {
    console.error('Error fetching provinces:', err.response?.status || err.code || err.message, err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : '');
    const stale = getCache('psgc:provinces');
    if (stale) return res.json({ data: stale });
    res.status(502).json({ error: 'Failed to fetch provinces' });
  }
});

// ── All cities/municipalities (with zip_code) ──
router.get('/cities', async (req, res) => {
  try {
    const cacheKey = 'psgc:cities';
    let cities = getCache(cacheKey);
    if (!cities) {
      const response = await fetchWithRetry('https://psgc.cloud/api/v2/cities-municipalities', { timeout: 15000 }, 3);
      cities = unwrapPayload(response);
      setCache(cacheKey, cities, 1000 * 60 * 60);
    }
    res.json({ data: cities });
  } catch (err) {
    console.error('Error fetching cities:', err.response?.status || err.code || err.message, err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : '');
    const stale = getCache('psgc:cities');
    if (stale) return res.json({ data: stale });
    res.status(502).json({ error: 'Failed to fetch cities' });
  }
});

// ── Barangays for a given city (with zip_code) ──
router.get('/barangays', async (req, res) => {
  try {
    const { city_code } = req.query;
    if (!city_code) {
      return res.status(400).json({ error: 'city_code is required' });
    }
    const cacheKey = `psgc:barangays:${city_code}`;
    let barangays = getCache(cacheKey);
    if (!barangays) {
      const response = await fetchWithRetry(
        `https://psgc.cloud/api/v2/cities-municipalities/${city_code}/barangays`,
        { timeout: 15000 }, 3
      );
      barangays = unwrapPayload(response);
      setCache(cacheKey, barangays, 1000 * 60 * 60);
    }
    res.json({ data: barangays });
  } catch (err) {
    console.error('Error fetching barangays:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch barangays' });
  }
});

// ── Search (provinces, cities, barangays by name) ──
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ results: [] });

    const provinces = getCache('psgc:provinces') || [];
    const cities = getCache('psgc:cities') || [];
    const matches = [];

    provinces.forEach(p => {
      const name = (p.name || '').toLowerCase();
      if (name.includes(q)) {
        matches.push({ description: p.name, type: 'Province' });
      }
    });

    cities.forEach(c => {
      const name = (c.name || '').toLowerCase();
      if (name.includes(q)) {
        const zip = String(c.zip_code || '').trim();
        matches.push({
          description: c.name,
          type: 'City/Municipality',
          province: c.province,
          zip_code: zip || null,
        });
      }
    });

    if (matches.length < 20) {
      // Search barangays from all cached cities
      const cityCodes = cities.filter(c => c.code).map(c => c.code);
      const barangayPromises = cityCodes.slice(0, 50).map(async code => {
        const cached = getCache(`psgc:barangays:${code}`);
        if (cached) return cached;
        try {
          const resp = await fetchWithRetry(
            `https://psgc.cloud/api/v2/cities-municipalities/${code}/barangays`,
            { timeout: 8000 }, 1
          );
          const list = unwrapPayload(resp);
          setCache(`psgc:barangays:${code}`, list, 1000 * 60 * 60);
          return list;
        } catch { return []; }
      });
      const barangayLists = await Promise.all(barangayPromises);
      for (const list of barangayLists) {
        for (const b of list) {
          if (matches.length >= 20) break;
          const name = (b.name || '').toLowerCase();
          if (name.includes(q)) {
            const zip = String(b.zip_code || '').trim();
            matches.push({
              description: b.name,
              type: 'Barangay',
              city_municipality: b.city_municipality,
              province: b.province,
              zip_code: zip || null,
            });
          }
        }
        if (matches.length >= 20) break;
      }
    }

    res.json({ results: matches });
  } catch (err) {
    console.warn('PSGC search error:', err && err.message);
    res.json({ results: [] });
  }
});

// ── Resolve PSGC codes to human-readable names ──
router.get('/resolve', async (req, res) => {
  try {
    const codes = String(req.query.codes || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!codes.length) return res.json({ resolved: {} });

    const provinces = getCache('psgc:provinces') || [];
    const cities = getCache('psgc:cities') || [];

    const resolved = {};

    for (const code of codes) {
      if (resolved[code]) continue;

      // Check provinces
      const prov = provinces.find(p => String(p.code) === code);
      if (prov) { resolved[code] = prov.name; continue; }

      // Check cities
      const city = cities.find(c => String(c.code) === code);
      if (city) { resolved[code] = city.name; continue; }

      // Check barangays (need to search cached barangay lists)
      let found = false;
      for (const cityObj of cities) {
        const barangays = getCache(`psgc:barangays:${cityObj.code}`) || [];
        const bgy = barangays.find(b => String(b.code) === code);
        if (bgy) { resolved[code] = bgy.name; found = true; break; }
      }
      if (!found) resolved[code] = null;
    }

    res.json({ resolved });
  } catch (err) {
    console.error('PSGC resolve error:', err.message);
    res.json({ resolved: {} });
  }
});

module.exports = router;

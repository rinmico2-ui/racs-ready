const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const router = express.Router();

/**
 * Backend proxy for the OpenStreetMap Nominatim API.
 * Requests are cached, deduplicated, and serialized to comply with the
 * provider's one-request-per-second public usage limit.
 */

const geocodeCache = new Map();
const inFlightRequests = new Map();
const CACHE_DURATION = 1000 * 60 * 60;
const MAX_CACHE_ENTRIES = 1000;

const MIN_REQUEST_INTERVAL = 1100;
const NOMINATIM_BASE_URL = String(
  process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org'
).replace(/\/+$/, '');
let nextProviderRequestAt = 0;
let providerBlockedUntil = 0;
let providerQueue = Promise.resolve();
const autocompleteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many address suggestions. Wait a minute or use Search.' }
});

router.get('/autocomplete/status', (_req, res) => {
  res.json({ enabled: Boolean(String(process.env.GEOAPIFY_API_KEY || '').trim()) });
});

router.get('/autocomplete', autocompleteLimiter, async (req, res) => {
  const apiKey = String(process.env.GEOAPIFY_API_KEY || '').trim();
  if (!apiKey) return res.status(503).json({ error: 'Live suggestions are not configured. Press Search instead.' });

  const query = typeof req.query.q === 'string' ? req.query.q.trim().replace(/\s+/g, ' ') : '';
  if (query.length < 3 || query.length > 250) {
    return res.status(400).json({ error: 'Enter 3 to 250 characters for suggestions.' });
  }

  try {
    const response = await axios.get('https://api.geoapify.com/v1/geocode/autocomplete', {
      params: { text: query, format: 'json', filter: 'countrycode:ph', limit: 5, lang: 'en', apiKey },
      timeout: 7000
    });
    const suggestions = (Array.isArray(response.data?.results) ? response.data.results : [])
      .filter(place => String(place.country_code || '').toLowerCase() === 'ph')
      .filter(place => Number(place.lat) >= 4.5 && Number(place.lat) <= 21.5 &&
        Number(place.lon) >= 116 && Number(place.lon) <= 127)
      .slice(0, 5)
      .map(place => ({
        display_name: String(place.formatted || place.address_line1 || place.name || '').trim(),
        lat: Number(place.lat),
        lon: Number(place.lon),
        address: { country_code: 'ph' },
        match_level: 'suggestion',
        source: 'geoapify'
      }))
      .filter(place => place.display_name);
    return res.json({ suggestions });
  } catch (error) {
    const status = error.response?.status === 429 ? 429 : 502;
    console.error('Address autocomplete provider unavailable:', status);
    return res.status(status).json({ error: status === 429
      ? 'Live suggestions are busy. Wait a moment or use Search.'
      : 'Live suggestions are unavailable. Press Search instead.' });
  }
});

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelay(error) {
  const raw = error?.response?.headers?.['retry-after'];
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(2000, seconds * 1000);

    const retryDate = Date.parse(raw);
    if (Number.isFinite(retryDate)) return Math.max(2000, retryDate - Date.now());
  }
  return 3000;
}

function enqueueProviderRequest(task) {
  const queued = providerQueue.then(async () => {
    const waitTime = Math.max(
      0,
      nextProviderRequestAt - Date.now(),
      providerBlockedUntil - Date.now()
    );
    if (waitTime > 0) {
      console.log(`Geocoding queue: waiting ${waitTime}ms`);
      await wait(waitTime);
    }

    nextProviderRequestAt = Date.now() + MIN_REQUEST_INTERVAL;
    return task();
  });

  // A failed request must not leave the queue permanently rejected.
  providerQueue = queued.catch(() => undefined);
  return queued;
}

async function requestNominatim(path, params) {
  return enqueueProviderRequest(async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        const waitTime = Math.max(
          0,
          nextProviderRequestAt - Date.now(),
          providerBlockedUntil - Date.now()
        );
        if (waitTime > 0) await wait(waitTime);
        nextProviderRequestAt = Date.now() + MIN_REQUEST_INTERVAL;
      }

      try {
        return await axios.get(`${NOMINATIM_BASE_URL}/${path}`, {
          params,
          headers: {
            'User-Agent': process.env.NOMINATIM_USER_AGENT || 'RACS-Ready-Booking-System/1.0',
            Accept: 'application/json'
          },
          timeout: 10000
        });
      } catch (error) {
        if (error?.response?.status !== 429) throw error;

        const delay = retryDelay(error);
        providerBlockedUntil = Math.max(providerBlockedUntil, Date.now() + delay);
        if (attempt === 1) throw error;
        console.warn(`Geocoding provider throttled the request; retrying in ${delay}ms`);
      }
    }
  });
}

function getCached(cacheKey) {
  const cached = geocodeCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp >= CACHE_DURATION) {
    geocodeCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

function setCached(cacheKey, data) {
  if (geocodeCache.size >= MAX_CACHE_ENTRIES) {
    geocodeCache.delete(geocodeCache.keys().next().value);
  }
  geocodeCache.set(cacheKey, { data, timestamp: Date.now() });
}

function cachedProviderRequest(cacheKey, path, params) {
  const cached = getCached(cacheKey);
  if (cached) return Promise.resolve(cached);

  const existing = inFlightRequests.get(cacheKey);
  if (existing) return existing;

  const request = requestNominatim(path, params)
    .then(response => {
      setCached(cacheKey, response.data);
      return response.data;
    })
    .finally(() => inFlightRequests.delete(cacheKey));

  inFlightRequests.set(cacheKey, request);
  return request;
}

function sendGeocodingError(res, error, action) {
  console.error(`${action} error:`, error.message);

  if (error.response?.status === 429) {
    const retryAfter = retryDelay(error);
    res.set('Retry-After', String(Math.ceil(retryAfter / 1000)));
    return res.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.',
      retryAfter
    });
  }

  return res.status(500).json({
    error: `Failed to ${action.toLowerCase()}`,
    details: 'The geocoding provider is unavailable'
  });
}

function buildPhilippineAddressQueries(address) {
  const normalized = address.trim().replace(/\s+/g, ' ')
    .replace(/\bbrgy\.?(?=\s|,|$)/gi, 'Barangay')
    .replace(/\bblk\.?(?=\s|,|$)/gi, 'Block');
  const parts = normalized.split(',').map(part => part.trim()).filter(Boolean);
  const candidates = [normalized];
  const add = value => {
    const query = String(value || '').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').trim();
    if (query.length >= 5 && !candidates.some(item => item.toLowerCase() === query.toLowerCase())) candidates.push(query);
  };

  // Local house, unit, zone and purok numbers are often not mapped. Try the
  // street/barangay first, then the wider locality without claiming an exact pin.
  const withoutHouse = normalized.replace(/^(?:(?:house|unit|lot|block|#)\s*)?[\d]+[\w/-]*\s+/i, '');
  add(withoutHouse);
  const withoutMicroArea = withoutHouse.replace(/\b(?:zone|purok|phase)\s*[\w-]+\b,?\s*/gi, '');
  add(withoutMicroArea);
  if (parts.length >= 3) add(parts.slice(1).join(', '));
  if (parts.length >= 3) add(parts.slice(-3).join(', '));
  return candidates.slice(0, 5);
}

router.get('/search', async (req, res) => {
  try {
    const { q, limit = 5 } = req.query;
    if (typeof q !== 'string' || !q.trim()) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    if (q.trim().length > 250) {
      return res.status(400).json({ error: 'Address is too long. Use 250 characters or fewer.' });
    }

    const safeLimit = Math.min(10, Math.max(1, Number.parseInt(limit, 10) || 5));
    const normalizedQuery = q.trim().replace(/\s+/g, ' ');
    const cacheKey = `search:${normalizedQuery.toLowerCase()}:${safeLimit}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const queries = buildPhilippineAddressQueries(normalizedQuery);
    for (let index = 0; index < queries.length; index += 1) {
      const candidate = queries[index];
      const providerKey = `provider-search:${candidate.toLowerCase()}:${safeLimit}`;
      const data = await cachedProviderRequest(providerKey, 'search', {
        format: 'json',
        q: candidate,
        limit: safeLimit,
        addressdetails: '1',
        countrycodes: 'ph'
      });
      const philippinesOnly = (Array.isArray(data) ? data : []).filter(place =>
        !place.address?.country_code || String(place.address.country_code).toLowerCase() === 'ph'
      );
      if (!philippinesOnly.length) continue;
      const matches = philippinesOnly.map(place => ({
        ...place,
        match_level: index === 0 ? 'search' : 'area',
        matched_query: candidate
      }));
      setCached(cacheKey, matches);
      return res.json(matches);
    }

    setCached(cacheKey, []);
    return res.json([]);
  } catch (error) {
    return sendGeocodingError(res, error, 'Search addresses');
  }
});

router.get('/reverse', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (lat === undefined || lon === undefined) {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }

    const parsedLat = Number.parseFloat(lat);
    const parsedLon = Number.parseFloat(lon);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon) ||
        parsedLat < -90 || parsedLat > 90 || parsedLon < -180 || parsedLon > 180) {
      return res.status(400).json({ error: 'Valid latitude and longitude are required' });
    }

    // Four decimals is approximately 11 metres and greatly improves cache hits
    // when GPS readings jitter around the same service location.
    const roundedLat = parsedLat.toFixed(4);
    const roundedLon = parsedLon.toFixed(4);
    const cacheKey = `reverse:${roundedLat}:${roundedLon}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await cachedProviderRequest(cacheKey, 'reverse', {
      format: 'json',
      lat: roundedLat,
      lon: roundedLon,
      addressdetails: '1'
    });

    if (data?.address?.country_code && String(data.address.country_code).toLowerCase() !== 'ph') {
      return res.status(422).json({ error: 'Choose a service location in the Philippines.' });
    }

    return res.json(data);
  } catch (error) {
    return sendGeocodingError(res, error, 'Reverse geocode');
  }
});

module.exports = router;

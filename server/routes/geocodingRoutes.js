const express = require('express');
const axios = require('axios');
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

router.get('/search', async (req, res) => {
  try {
    const { q, limit = 5 } = req.query;
    if (typeof q !== 'string' || !q.trim()) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const safeLimit = Math.min(10, Math.max(1, Number.parseInt(limit, 10) || 5));
    const normalizedQuery = q.trim().replace(/\s+/g, ' ');
    const cacheKey = `search:${normalizedQuery.toLowerCase()}:${safeLimit}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await cachedProviderRequest(cacheKey, 'search', {
      format: 'json',
      q: normalizedQuery,
      limit: safeLimit,
      addressdetails: '1',
      countrycodes: 'ph'
    });

    return res.json(data);
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

    return res.json(data);
  } catch (error) {
    return sendGeocodingError(res, error, 'Reverse geocode');
  }
});

module.exports = router;

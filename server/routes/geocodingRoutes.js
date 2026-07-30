const express = require('express');
const axios = require('axios');
const router = express.Router();

/**
 * Geocoding Routes - Backend proxy for OpenStreetMap Nominatim API
 * Solves CORS issues by proxying requests through our backend
 * Includes caching and rate limiting to prevent 429 errors
 */

// Simple in-memory cache to reduce API calls
const geocodeCache = new Map();
const CACHE_DURATION = 1000 * 60 * 60; // 1 hour

// Rate limiting
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1000; // 1 second between requests

/**
 * Wait to respect rate limits
 */
async function respectRateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    console.log(`⏳ Rate limiting: waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastRequestTime = Date.now();
}

/**
 * GET /api/geocoding/search
 * Search for addresses using Nominatim API
 * Query params: q (search query), limit (max results)
 */
router.get('/search', async (req, res) => {
  try {
    const { q, limit = 5 } = req.query;
    
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    // Create cache key
    const cacheKey = `search:${q}:${limit}`;
    
    // Check cache first
    const cached = geocodeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
      console.log(`💾 Cache hit for "${q}"`);
      return res.json(cached.data);
    }
    
    console.log(`🔍 Geocoding search: "${q}" (limit: ${limit})`);
    
    // Respect rate limits
    await respectRateLimit();
    
    // Make request to Nominatim with axios
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        format: 'json',
        q: q,
        limit: limit,
        addressdetails: '1',
        countrycodes: 'ph' // Limit to Philippines
      },
      headers: {
        'User-Agent': 'RACS-Ready-Booking-System/1.0' // Required by Nominatim
      },
      timeout: 10000 // 10 second timeout
    });
    
    const data = response.data;
    console.log(`✅ Found ${data.length} results for "${q}"`);
    
    // Cache the result
    geocodeCache.set(cacheKey, {
      data: data,
      timestamp: Date.now()
    });
    
    // Return results
    res.json(data);
    
  } catch (error) {
    console.error('❌ Geocoding search error:', error.message);
    
    // Handle rate limiting specifically
    if (error.response && error.response.status === 429) {
      return res.status(429).json({ 
        error: 'Too many requests. Please wait a moment and try again.',
        retryAfter: 2000
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to search addresses',
      details: error.message 
    });
  }
});

/**
 * GET /api/geocoding/reverse
 * Reverse geocode coordinates to address
 * Query params: lat, lon
 */
router.get('/reverse', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    
    if (!lat || !lon) {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }
    
    // Create cache key (round to 4 decimal places for better cache hits)
    const roundedLat = parseFloat(lat).toFixed(4);
    const roundedLon = parseFloat(lon).toFixed(4);
    const cacheKey = `reverse:${roundedLat}:${roundedLon}`;
    
    // Check cache first
    const cached = geocodeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
      console.log(`� Cache hit for reverse geocode ${roundedLat}, ${roundedLon}`);
      return res.json(cached.data);
    }
    
    console.log(`�🔍 Reverse geocoding: ${lat}, ${lon}`);
    
    // Respect rate limits
    await respectRateLimit();
    
    // Make request to Nominatim with axios
    const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: {
        format: 'json',
        lat: lat,
        lon: lon,
        addressdetails: '1'
      },
      headers: {
        'User-Agent': 'RACS-Ready-Booking-System/1.0'
      },
      timeout: 10000 // 10 second timeout
    });
    
    const data = response.data;
    console.log(`✅ Reverse geocoded to: ${data.display_name}`);
    
    // Cache the result
    geocodeCache.set(cacheKey, {
      data: data,
      timestamp: Date.now()
    });
    
    // Return result
    res.json(data);
    
  } catch (error) {
    console.error('❌ Reverse geocoding error:', error.message);
    
    // Handle rate limiting specifically
    if (error.response && error.response.status === 429) {
      return res.status(429).json({ 
        error: 'Too many requests. Please wait a moment and try again.',
        retryAfter: 2000
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to reverse geocode',
      details: error.message 
    });
  }
});

module.exports = router;

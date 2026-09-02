const express = require("express");
const logger = require("../utils/logger").create("serviceRoutes");
const router = express.Router();
const mongoose = require("mongoose");
const Service = require("../models/Service");
const CoreService = require("../models/CoreService");
const RepairService = require("../models/RepairService");
const BookingService = require("../models/BookingService");
const Order = require("../models/Order");
const auth = require("../middleware/authenticate");
const { getMinAdvanceMinutes, earliestAllowedDateTime } = require("../utils/bookingPolicy");
const { getDownpaymentPercentage } = require("../utils/paymentPolicy");

async function fetchJsonWithTimeout(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        // Nominatim requires a valid User-Agent identifying the application
        "User-Agent": process.env.USER_AGENT || "CALIDRO-RACS/1.0 (contact@calidro.example)"
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- GET /api/services
// Returns both core services and repair services. Falls back to `Service` collection if detailed
// CoreService/RepairService documents are not present.
router.get("/", async (req, res) => {
  try {
    const core = await CoreService.find({ active: true }).lean().limit(100);
    const repairs = await RepairService.find({ active: true })
      .lean()
      .limit(100);

    // fallback to Service model when specialized collections are empty
    if ((!core || core.length === 0) && (!repairs || repairs.length === 0)) {
      const all = await Service.find({ active: true }).lean().limit(200);
      return res.json({
        coreServices: all.filter((s) => s.category === "service"),
        repairs: all.filter((s) => s.category === "repair"),
      });
    }

    return res.json({ coreServices: core, repairs });
  } catch (err) {
    console.error("GET /api/services failed", err && err.message);
    return res.status(500).json({ error: "Failed to load services" });
  }
});

// --- GET /api/services/categories
// Returns active service categories (for repair unit type selection in booking edit modal)
router.get("/categories", async (req, res) => {
  try {
    const ServiceCategory = require("../models/ServiceCategory");
    const categories = await ServiceCategory.find({ active: true }).sort({ order: 1 }).lean();
    return res.json({ categories });
  } catch (err) {
    console.error("GET /api/services/categories failed", err && err.message);
    return res.status(500).json({ error: "Failed to load service categories" });
  }
});

// public endpoint used by booking calendar to retrieve technician schedule
// so that we can block dates when no tech is working.
// global schedule (all technicians combined)
router.get("/technician-schedule", async (req, res) => {
  try {
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const docs = await TechnicianSchedule.find({}).lean();
    const availableWeekdays = new Set();
    const restDates = new Set();
    docs.forEach((d) => {
      (d.workingDays || []).forEach((w) => {
        const dow = Number(w.dayOfWeek);
        if (Number.isInteger(dow) && dow >= 0 && dow < 7)
          availableWeekdays.add(dow);
      });
      (d.restDates || []).forEach((r) => {
        if (r && r.date) {
          const dKey = toIsoDate(new Date(r.date));
          restDates.add(dKey);
        }
      });
    });

    const nonWorkingWeekdays = [];
    for (let d = 0; d < 7; d++) {
      if (!availableWeekdays.has(d)) nonWorkingWeekdays.push(d);
    }

    return res.json({ nonWorkingWeekdays, restDates: Array.from(restDates) });
  } catch (err) {
    console.error(
      "GET /api/services/technician-schedule failed",
      err && err.message,
    );
    return res.status(500).json({ error: "failed" });
  }
});

// per-technician schedule for public booking UI
router.get("/technician-schedule/:id", async (req, res) => {
  try {
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const Technician = require("../models/Technician");
    let id = req.params.id;

    // primary lookup: schedule document whose technicianId matches the supplied id
    let doc = await TechnicianSchedule.findOne({ technicianId: id }).lean();

    // if not found, the id may actually be a user account id rather than a
    // Technician._id.  attempt to resolve the linked Technician record and
    // re-run the query using that identifier.
    if (!doc) {
      const tech = await Technician.findOne({ user: id }).select("_id").lean();
      if (tech) {
        id = tech._id.toString();
        doc = await TechnicianSchedule.findOne({ technicianId: id }).lean();
      }
    }

    if (!doc)
      return res.json({
        workingDays: [],
        nonWorkingWeekdays: [],
        restDates: [],
      });

    const availableWeekdays = new Set();
    const restDates = new Set();
    (doc.workingDays || []).forEach((w) => {
      const dow = Number(w.dayOfWeek);
      if (Number.isInteger(dow) && dow >= 0 && dow < 7)
        availableWeekdays.add(dow);
    });
    (doc.restDates || []).forEach((r) => {
      if (r && r.date) {
        const dKey = toIsoDate(new Date(r.date));
        restDates.add(dKey);
      }
    });

    const nonWorkingWeekdays = [];
    for (let d = 0; d < 7; d++) {
      if (!availableWeekdays.has(d)) nonWorkingWeekdays.push(d);
    }
    return res.json({
      workingDays: doc.workingDays || [],
      nonWorkingWeekdays,
      restDates: Array.from(restDates),
    });
  } catch (err) {
    console.error(
      "GET /api/services/technician-schedule/:id failed",
      err && err.message,
    );
    return res.status(500).json({ error: "failed" });
  }
});

// public endpoint returning current technician GPS coordinates.  This will
// be updated by the technician tracker page and polled by the customer UI.
router.get("/technician-location", auth.authenticate, async (req, res) => {
  try {
    const Technician = require("../models/Technician");
    const { id } = req.query;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "A valid technician id is required" });
    }

    const tech = await Technician.findOne({
      active: true,
      $or: [{ _id: id }, { user: id }],
    }).select("location user").lean();
    if (!tech) return res.status(404).json({ error: "Technician not found" });

    const role = req.user.role;
    let mayTrack = ["admin", "secretary"].includes(role);
    if (role === "technician") {
      mayTrack = String(tech.user || "") === String(req.user._id);
    } else if (role === "customer") {
      const activeBookingStatuses = [
        "assigned", "confirmed", "scheduled", "on-the-way", "arrived",
        "in-progress", "ongoing", "repair_scheduled", "repair_in_progress",
      ];
      const activeOrderStatuses = [
        "out_for_delivery", "arrived", "installing",
      ];
      const [booking, order] = await Promise.all([
        BookingService.exists({
          customerId: req.user._id,
          technicianId: tech._id,
          status: { $in: activeBookingStatuses },
        }),
        Order.exists({
          userId: req.user._id,
          technicianId: tech._id,
          status: { $in: activeOrderStatuses },
        }),
      ]);
      mayTrack = Boolean(booking || order);
    }
    if (!mayTrack) return res.status(403).json({ error: "Live location is not available" });

    if (tech && tech.location && tech.location.coordinates) {
      const [lng, lat] = tech.location.coordinates;
      return res.json({ lat, lng });
    }
    return res.status(404).json({ error: "Live location is not available" });
  } catch (err) {
    console.error(
      "GET /api/services/technician-location failed",
      err && err.message,
    );
    return res.status(500).json({ error: "failed" });
  }
});

// list active technicians for public booking UI
// Use the Technician model to get proper location data and coordinates
router.get("/technicians", async (req, res) => {
  try {
    const Technician = require("../models/Technician");
    // Public booking selection exposes identity and rating only, never private
    // contact details or live location.
    const technicians = await Technician.find({ active: true })
      .select("_id name user rating ratingCount")
      .populate('user', 'firstName lastName name')
      .lean();
    
    const techs = technicians.map((tech) => {
      // Get name from user or fallback to technician name
      let name = tech.name;
      if (tech.user) {
        name = tech.user.name || 
               tech.user.fullName || 
               ((tech.user.firstName || "") + " " + (tech.user.lastName || "")).trim() ||
               tech.name;
      }
      
      return {
        _id: tech._id,
        name: name,
        rating: tech.rating,
        ratingCount: tech.ratingCount,
      };
    });
    
    console.log(`✅ Found ${techs.length} technicians with location data`);
    return res.json({ technicians: techs });
  } catch (err) {
    console.error("GET /api/services/technicians failed", err && err.message);
    return res.status(500).json({ error: "failed" });
  }
});

// helper used by the schedule endpoint
function toIsoDate(date) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Simple in-memory cache to reduce rate-limit hits for geocoding queries.
// Keyed by query string; values expire after ~2 minutes.
const geocodeSuggestCache = new Map();
const GEOCODE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

function cachedGeocodeSuggest(q) {
  const entry = geocodeSuggestCache.get(q);
  if (!entry) return null;
  if (Date.now() - entry.ts > GEOCODE_CACHE_TTL_MS) {
    geocodeSuggestCache.delete(q);
    return null;
  }
  return entry.value;
}

function setCachedGeocodeSuggest(q, value) {
  geocodeSuggestCache.set(q, { ts: Date.now(), value });
  // keep cache size bounded
  if (geocodeSuggestCache.size > 250) {
    const firstKey = geocodeSuggestCache.keys().next().value;
    geocodeSuggestCache.delete(firstKey);
  }
}

async function fetchNominatimSuggestions(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=ph&q=" +
    encodeURIComponent(q);
  const data = await fetchJsonWithTimeout(url, 5000);
  if (!Array.isArray(data)) return null;
  return data.map((item) => ({
    display_name: item.display_name,
    lat: item.lat,
    lon: item.lon,
  }));
}

async function fetchPhotonSuggestions(q) {
  const url =
    "https://photon.komoot.io/api/?limit=5&lang=en&q=" +
    encodeURIComponent(q) +
    "&osm_tag=place:village,place=town,place=city";
  const data = await fetchJsonWithTimeout(url, 5000);
  if (!data || !Array.isArray(data.features)) return null;
  return data.features.map((feat) => {
    const coord = feat.geometry?.coordinates || [];
    return {
      display_name: feat.properties?.name || feat.properties?.osm_key || "",
      lat: coord[1],
      lon: coord[0],
    };
  });
}

// GET /api/services/geocode-suggest?q=<query>
// Proxy to address providers for autocomplete (primary: Nominatim, fallback: Photon)
router.get("/geocode-suggest", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q || q.length < 2) return res.json({ suggestions: [] });

    const cached = cachedGeocodeSuggest(q);
    if (cached) {
      return res.json({ suggestions: cached });
    }

    // 1) Try Nominatim (Philippines-only)
    let suggestions = await fetchNominatimSuggestions(q);

    // 2) If Nominatim returns nothing (or is rate-limited), fall back to Photon.
    if (!suggestions || suggestions.length === 0) {
      suggestions = await fetchPhotonSuggestions(q);
    }

    if (!suggestions) suggestions = [];
    setCachedGeocodeSuggest(q, suggestions);
    return res.json({ suggestions });
  } catch (err) {
    console.error("GET /api/services/geocode-suggest failed", err && err.message);
    return res.status(500).json({ suggestions: [] });
  }
});

// GET /api/services/geocode?q=<query>
// proxy that returns one matching address to avoid CORS errors
// If Nominatim is rate-limited or fails, fall back to Photon (komoot).
router.get("/geocode", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({});

    async function fetchFromNominatim() {
      const url =
        "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ph&q=" +
        encodeURIComponent(q);
      const data = await fetchJsonWithTimeout(url, 5000);
      if (Array.isArray(data) && data.length) {
        return {
          lat: data[0].lat,
          lon: data[0].lon,
          display_name: data[0].display_name,
        };
      }
      return null;
    }

    async function fetchFromPhoton() {
      const url =
        "https://photon.komoot.io/api/?limit=1&lang=en&q=" +
        encodeURIComponent(q) +
        "&osm_tag=place:village,place=town,place=city";
      const data = await fetchJsonWithTimeout(url, 5000);
      if (data && Array.isArray(data.features) && data.features.length) {
        const feat = data.features[0];
        const coord = feat.geometry?.coordinates || [];
        return {
          lat: coord[1],
          lon: coord[0],
          display_name: feat.properties?.name || feat.properties?.osm_tag || q,
        };
      }
      return null;
    }

    const nomRes = await fetchFromNominatim();
    if (nomRes) return res.json(nomRes);

    const phoRes = await fetchFromPhoton();
    if (phoRes) return res.json(phoRes);

    return res.json({});
  } catch (err) {
    console.error("GET /api/services/geocode failed", err && err.message);
    return res.status(500).json({});
  }
});

// ===== traffic-aware directions proxy =====
// GET /api/services/directions?origin=lat,lng&destination=lat,lng
// By default, this will call Google Directions API when GOOGLE_MAPS_API_KEY is set.
// If the API key is not configured (e.g. using OpenStreetMap/Leaflet), it will fall back
// to the public OSRM routing server.
router.get("/directions", async (req, res) => {
  try {
    const origin = String(req.query.origin || "").trim();
    const destination = String(req.query.destination || "").trim();
    if (!origin || !destination) return res.status(400).json({ error: "origin and destination required" });

    // prefer Google Directions when a key is configured
    const googleKey = process.env.GOOGLE_MAPS_API_KEY;
    if (googleKey) {
      const url =
        `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}` +
        `&destination=${encodeURIComponent(destination)}` +
        `&departure_time=now&traffic_model=best_guess&mode=driving&key=${encodeURIComponent(googleKey)}`;

      const data = await fetchJsonWithTimeout(url, 7000);
      if (!data || !data.routes || !data.routes.length) {
        return res.status(502).json({ error: "no routes" });
      }
      const route = data.routes[0];

      // decode polyline from google
      const decodePolyline = function(encoded) {
        let index = 0, lat = 0, lng = 0;
        const coordinates = [];
        while (index < encoded.length) {
          let b, shift = 0, result = 0;
          do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
          } while (b >= 0x20);
          const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
          lat += dlat;
          shift = 0;
          result = 0;
          do {
            b = encoded.charCodeAt(index++) - 63;
            result |= (b & 0x1f) << shift;
            shift += 5;
          } while (b >= 0x20);
          const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
          lng += dlng;
          coordinates.push({ lat: lat / 1e5, lng: lng / 1e5 });
        }
        return coordinates;
      };

      const coords = decodePolyline(route.overview_polyline.points);
      return res.json({
        distance: route.legs[0].distance.value,
        duration: route.legs[0].duration.value,
        duration_in_traffic: route.legs[0].duration_in_traffic
          ? route.legs[0].duration_in_traffic.value
          : route.legs[0].duration.value,
        distance_text: route.legs[0].distance.text,
        duration_text: route.legs[0].duration_in_traffic
          ? route.legs[0].duration_in_traffic.text
          : route.legs[0].duration.text,
        geometry: coords.map((c) => [c.lng, c.lat]),
      });
    }

    // Fallback to OSRM public routing service (no API key required).
    // Note: This uses the public demo server. For production, run your own OSRM instance.
    const osrmBase = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
    const [origLat, origLng] = origin.split(",").map(Number);
    const [destLat, destLng] = destination.split(",").map(Number);
    if (
      Number.isNaN(origLat) ||
      Number.isNaN(origLng) ||
      Number.isNaN(destLat) ||
      Number.isNaN(destLng)
    ) {
      return res.status(400).json({ error: "invalid lat/lng format" });
    }

    const osrmUrl =
      `${osrmBase}/route/v1/driving/${origLng},${origLat};${destLng},${destLat}` +
      `?overview=full&geometries=geojson&alternatives=false&steps=false`;

    const data = await fetchJsonWithTimeout(osrmUrl, 7000);
    if (!data || data.code !== "Ok" || !Array.isArray(data.routes) || !data.routes.length) {
      return res.status(502).json({ error: "no routes" });
    }

    const route = data.routes[0];
    // OSRM geometry is a GeoJSON LineString
    const geometry = (route.geometry && route.geometry.coordinates) || [];
    return res.json({
      distance: route.distance,
      duration: route.duration,
      duration_in_traffic: route.duration,
      distance_text: (route.distance / 1000).toFixed(1) + ' km',
      duration_text: Math.ceil(route.duration / 60) + ' min',
      geometry,
    });
  } catch (err) {
    console.error("/api/services/directions error", err && err.message);
    return res.status(502).json({ error: "Directions service unavailable" });
  }
});

// GET /api/services/ip-location
// Server-side IP geolocation proxy to avoid browser CORS/mixed-content issues.
router.get("/ip-location", async (req, res) => {
  try {
    const providers = [
      {
        name: "ipapi.co",
        url: "https://ipapi.co/json/",
        parse: (data) => ({
          lat: Number(data && data.latitude),
          lng: Number(data && data.longitude),
          city: (data && data.city) || null,
          country: (data && data.country_name) || null,
        }),
      },
      {
        name: "ipwho.is",
        url: "https://ipwho.is/",
        parse: (data) => {
          if (!data || data.success === false) return null;
          return {
            lat: Number(data.latitude),
            lng: Number(data.longitude),
            city: data.city || null,
            country: data.country || null,
          };
        },
      },
      {
        name: "ipwhois.app",
        url: "https://ipwhois.app/json/",
        parse: (data) => ({
          lat: Number(data && data.latitude),
          lng: Number(data && data.longitude),
          city: (data && data.city) || null,
          country: (data && data.country) || null,
        }),
      },
    ];

    for (const provider of providers) {
      const data = await fetchJsonWithTimeout(provider.url, 7000);
      if (!data) continue;
      const parsed = provider.parse(data);
      if (
        parsed &&
        Number.isFinite(parsed.lat) &&
        Number.isFinite(parsed.lng) &&
        parsed.lat >= -90 &&
        parsed.lat <= 90 &&
        parsed.lng >= -180 &&
        parsed.lng <= 180
      ) {
        return res.json({
          success: true,
          source: provider.name,
          coords: parsed,
        });
      }
    }

    return res.status(502).json({ success: false, error: "ip_lookup_failed" });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, error: "ip_lookup_exception" });
  }
});

// GET /api/services/osrm-route?coords=<lng,lat;lng,lat>
// Simple proxy to OSRM public routing API to avoid client-side CSP/CORS issues.
// Uses axios (already in package.json) for reliable HTTP in all Node versions.
router.get("/osrm-route", async (req, res) => {
  const axios = require("axios");
  try {
    const coordsRaw = String(req.query.coords || "").trim();
    // Expect exactly two coordinate pairs in the form "lng,lat;lng,lat"
    const m = coordsRaw.match(
      /^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*;\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/,
    );
    if (!m) {
      return res.status(400).json({ error: "invalid_coords" });
    }
    const lng1 = Number(m[1]);
    const lat1 = Number(m[2]);
    const lng2 = Number(m[3]);
    const lat2 = Number(m[4]);
    if (
      !Number.isFinite(lng1) ||
      !Number.isFinite(lat1) ||
      !Number.isFinite(lng2) ||
      !Number.isFinite(lat2)
    ) {
      return res.status(400).json({ error: "invalid_coords" });
    }

    const coords = `${lng1},${lat1};${lng2},${lat2}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
    logger.info("[osrm-route] proxying: %s", url);
    const { data } = await axios.get(url, { timeout: 10000 });
    if (!data || !data.routes) {
      logger.warn(
        "[osrm-route] OSRM returned unexpected body: %s",
        JSON.stringify(data).slice(0, 300),
      );
      return res.status(502).json({ error: "upstream_failed" });
    }
    logger.info(
      "[osrm-route] OK, routes: %d geometry pts: %d",
      data.routes.length,
      (data.routes[0]?.geometry?.coordinates || []).length,
    );
    return res.json(data);
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    logger.error(
      "[osrm-route] error",
      status || err.code || err.message,
      body && JSON.stringify(body).slice(0, 300),
    );
    return res
      .status(502)
      .json({ error: "upstream_failed", detail: status || err.message });
  }
});

// GET /api/services/availability?serviceId=<id>&date=YYYY-MM-DD
// or GET /api/services/:id/availability?date=YYYY-MM-DD
// ── Time Slot Generation ────────────────────────────────────────────────────
// Modular slot computation split into focused helpers:

/**
 * Resolve the per-unit service duration (minutes) from DB or manual override.
 */
async function resolveServiceDuration(serviceId, manualDuration) {
  if (manualDuration !== null && !isNaN(manualDuration)) {
    return Number(manualDuration);
  }
  if (!serviceId || !mongoose.Types.ObjectId.isValid(serviceId)) return 60;

  try {
    const cs = await CoreService.findById(serviceId).lean();
    if (cs && cs.durationMinutes) return cs.durationMinutes;
    const rs = await RepairService.findById(serviceId).lean();
    if (rs && rs.estimatedDurationMinutes) return rs.estimatedDurationMinutes;
    if (cs && cs.duration) return cs.duration;
    const legacy = await Service.findById(serviceId).lean();
    if (legacy && legacy.duration) return legacy.duration;
  } catch (e) {
    console.warn("resolveServiceDuration: lookup failed", serviceId, e.message);
  }
  return 60;
}

/**
 * Load the working-hour blocks for a technician on the given date.
 * Returns [{ start, end }] in minutes-from-midnight, or [] if non-working.
 */
async function loadTechnicianWorkingBlocks(technicianId, date) {
  const defaultBlock = [{ start: 8 * 60, end: 19 * 60 }];

  if (!technicianId || !mongoose.Types.ObjectId.isValid(technicianId)) {
    return defaultBlock;
  }

  try {
    const Technician = require("../models/Technician");
    const TechnicianSchedule = require("../models/TechnicianSchedule");

    let techIdForSched = technicianId;
    let sched = await TechnicianSchedule.findOne({ technicianId: techIdForSched }).lean();

    if (!sched) {
      const tech = await Technician.findOne({ user: technicianId }).select("_id").lean();
      if (tech) {
        techIdForSched = tech._id.toString();
        sched = await TechnicianSchedule.findOne({ technicianId: techIdForSched }).lean();
      }
    }

    if (sched && Array.isArray(sched.workingDays)) {
      const dow = date.getDay();
      const matching = sched.workingDays.filter((w) => w.dayOfWeek === dow);
      if (matching.length) {
        return matching.map((w) => ({
          start: w.startMinutes || 8 * 60,
          end: w.endMinutes || 19 * 60,
        }));
      }
      return [];
    }
  } catch (e) {
    console.warn("loadTechnicianWorkingBlocks: schedule lookup failed", technicianId, e.message);
  }
  return defaultBlock;
}

/**
 * Fetch existing bookings for a technician on a date and convert to busy ranges.
 * Returns [{ start, end }] in minutes-from-midnight.
 */
async function loadBusyRanges(technicianId, date, fallbackDuration) {
  const busyRanges = [];
  if (!technicianId) return busyRanges;

  try {
    const Technician = require("../models/Technician");
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const busyStatuses = [
      "pending", "confirmed", "scheduled", "on-the-way",
      "in-progress", "ongoing", "payment_verified",
      "awaiting_assignment", "assigned",
    ];

    const techIdsToMatch = [String(technicianId)];
    const byTechId = await Technician.findById(technicianId).select("_id user").lean();
    if (byTechId) {
      if (byTechId._id) techIdsToMatch.push(String(byTechId._id));
      if (byTechId.user) techIdsToMatch.push(String(byTechId.user));
    } else {
      const byUserId = await Technician.findOne({ user: technicianId }).select("_id user").lean();
      if (byUserId) {
        if (byUserId._id) techIdsToMatch.push(String(byUserId._id));
        if (byUserId.user) techIdsToMatch.push(String(byUserId.user));
      }
    }

    const uniqueTechIds = Array.from(new Set(techIdsToMatch));
    const bookings = await BookingService.find({
      bookingDate: { $gte: dayStart, $lte: dayEnd },
      status: { $in: busyStatuses },
      technicianId: { $in: uniqueTechIds },
    }).lean();

    for (const b of bookings) {
      const startMin = parseTimeToMinutes(b.startTime);
      if (Number.isNaN(startMin)) continue;
      let endMin = parseTimeToMinutes(b.endTime);
      if (Number.isNaN(endMin)) {
        const bookingDur = (Number(b.serviceDurationMinutes) || fallbackDuration) +
          Math.max(0, Number(b.travelTime) || 0);
        endMin = startMin + bookingDur;
      }
      if (endMin > startMin) {
        busyRanges.push({ start: startMin, end: endMin });
      }
    }
  } catch (e) {
    console.warn("loadBusyRanges: booking lookup failed", e && e.message);
  }
  return busyRanges;
}

/**
 * Merge overlapping busy ranges and find free gaps within working blocks.
 * Returns [{ start, end }] of free time in minutes-from-midnight.
 */
function findFreeGaps(workingBlocks, busyRanges) {
  const sorted = [...busyRanges].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of sorted) {
    if (merged.length && r.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  const gaps = [];
  for (const block of workingBlocks) {
    let cursor = block.start;
    for (const busy of merged) {
      if (busy.start >= block.end) break;
      if (busy.end <= block.start) continue;
      const gapEnd = Math.min(busy.start, block.end);
      if (gapEnd > cursor) gaps.push({ start: cursor, end: gapEnd });
      cursor = Math.max(cursor, Math.min(busy.end, block.end));
    }
    if (cursor < block.end) gaps.push({ start: cursor, end: block.end });
  }
  return gaps;
}

/**
 * Generate slot objects from free gaps.
 * Each slot starts at `t` and occupies `totalSlotDuration` minutes.
 * Slots are placed at `slotInterval`-minute increments.
 */
function generateSlotsFromGaps(gaps, totalSlotDuration, slotInterval, opts) {
  const { serviceDuration, travelMinutes, quantity } = opts;
  const result = [];

  for (const gap of gaps) {
    for (let t = gap.start; t + totalSlotDuration <= gap.end; t += slotInterval) {
      const serviceStart = t + (travelMinutes || 0);
      const totalEnd = t + totalSlotDuration;

      result.push({
        startMinutes: t,
        endMinutes: totalEnd,
        totalEndMinutes: totalEnd,
        durationMinutes: serviceDuration,
        travelMinutes: travelMinutes || 0,
        status: "available",
        label: minutesTo12HourLabel(serviceStart) + " – " + minutesTo12HourLabel(totalEnd),
        blockLabel: minutesTo12HourLabel(t) + " – " + minutesTo12HourLabel(totalEnd),
        detail: buildSlotDetail(serviceDuration, travelMinutes, totalSlotDuration, quantity),
      });
    }
  }
  return result;
}

function buildSlotDetail(serviceDuration, travelMinutes, totalDur, quantity) {
  const durLabel = formatMinutes(serviceDuration);
  const totalLabel = formatMinutes(totalDur);
  const travelLabel = travelMinutes > 0 ? formatMinutes(travelMinutes) : null;
  const unitLabel = quantity > 1 ? ` (${quantity}× ${durLabel} each)` : "";
  if (travelLabel) {
    return `🚗 ${travelLabel} travel · 🔧 ${durLabel} service · ${totalLabel} total${unitLabel}`;
  }
  return `🔧 ${durLabel} service${unitLabel}`;
}

function formatMinutes(m) {
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  }
  return `${m}m`;
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return NaN;
  const str = timeStr.toString().trim();
  if (/^\d{1,4}$/.test(str)) {
    const mins = parseInt(str, 10);
    return Number.isFinite(mins) ? mins : NaN;
  }
  const m1 = str.match(/^(\d{1,2}):(\d{2})$/);
  if (m1) return parseInt(m1[1], 10) * 60 + parseInt(m1[2], 10);
  const m2 = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m2) {
    let hh = parseInt(m2[1], 10) % 12;
    if (m2[3].toUpperCase() === "PM") hh += 12;
    return hh * 60 + parseInt(m2[2], 10);
  }
  return NaN;
}

function minutesTo12HourLabel(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
}

const COMPANY_WORK_START = 8 * 60;  // 08:00 (fallback default)
const COMPANY_WORK_END = 19 * 60;   // 19:00 (fallback default, includes overtime)

/**
 * Company-wide capacity for the customer-facing standard flow.
 *
 * Generates the fixed appointment windows (8 AM / 11 AM / 1 PM) and, for each,
 * determines how many technicians are free across the reservation span.
 * A window is offered only when:
 *   • its finish time is before company closing,
 *   • it is not in the past / before advance-notice (for today), and
 *   • at least one technician is free (working, not on leave/rest, and with no
 *     overlapping booking) after subtracting company-wide unassigned bookings.
 *
 * The reservation span reserves the FULL workload:
 *   (serviceDuration × quantity) + travel + traffic + prep + completion + buffer.
 */
async function computeCompanyWindows(dateStr, params) {
  const {
    reservationMinutes,
    serviceMinutes,
    travelMinutes,
    quantity,
    earliestMinutes,
    isToday,
    nowMinutes,
  } = params;

  const engine = require("../utils/enterpriseSchedulingEngine");
  const Technician = require("../models/Technician");
  const TechnicianSchedule = require("../models/TechnicianSchedule");
  const LeaveRequest = require("../models/LeaveRequest");

  const date = new Date(dateStr + "T00:00:00");
  const dayOfWeek = date.getDay();
  const dayStart = new Date(dateStr + "T00:00:00");
  const dayEnd = new Date(dateStr + "T23:59:59");

  const technicians = await Technician.find({ active: { $ne: false } })
    .select("_id user")
    .lean();
  if (!technicians.length) return [];

  const techIds = technicians.map((t) => t._id);
  const schedules = await TechnicianSchedule.find({
    technicianId: { $in: techIds },
  }).lean();
  const scheduleMap = {};
  for (const s of schedules) scheduleMap[String(s.technicianId)] = s;

  const leaves = await LeaveRequest.find({
    technicianId: { $in: techIds },
    status: "approved",
    startDate: { $lte: dayEnd },
    endDate: { $gte: dayStart },
  })
    .select("technicianId")
    .lean();
  const onLeave = new Set(leaves.map((l) => String(l.technicianId)));

  // Which technicians actually work this date, with their working window.
  const workable = [];
  for (const tech of technicians) {
    const id = String(tech._id);
    if (onLeave.has(id)) continue;

    const sched = scheduleMap[id];
    let blockStart = COMPANY_WORK_START;
    let blockEnd = COMPANY_WORK_END;

    if (sched && Array.isArray(sched.workingDays)) {
      const wd = sched.workingDays.find((w) => w.dayOfWeek === dayOfWeek);
      const isNonWork = sched.nonWorkingWeekdays?.some((n) => n.dayOfWeek === dayOfWeek);
      if (!wd || isNonWork) continue;
      const isRest = sched.restDates?.some((rd) => {
        const d = new Date(rd.date);
        d.setHours(0, 0, 0, 0);
        return d.getTime() === date.getTime();
      });
      if (isRest) continue;
      blockStart = wd.startMinutes || COMPANY_WORK_START;
      blockEnd = wd.endMinutes || COMPANY_WORK_END;
    }
    workable.push({ id, tech, blockStart, blockEnd });
  }
  if (!workable.length) return [];

  // Derive company-wide working-hours bounds from admin-configured schedules
  const DAY_START = Math.min(...workable.map(w => w.blockStart));
  const DAY_END   = Math.max(...workable.map(w => w.blockEnd));

  // Existing active bookings for the day (assigned + unassigned).
  const busyStatuses = [
    "pending", "payment_verified", "awaiting_assignment", "assigned",
    "pending_reassignment", "confirmed", "scheduled", "on-the-way",
    "arrived", "in-progress", "ongoing", "repair_requested",
    "inspection_scheduled", "inspection_in_progress", "repair_approved",
    "ready_for_repair", "repair_scheduled", "repair_in_progress",
  ];
  const dayBookings = await BookingService.find({
    bookingDate: { $gte: dayStart, $lte: dayEnd },
    status: { $in: busyStatuses },
  })
    .select("technicianId startTime endTime serviceDurationMinutes travelTime")
    .lean();

  // Each booking is assigned to a discrete daily window based on its start
  // time. A technician busy in the 8AM slot is still free for 11AM / 1PM,
  // so we key conflicts by window rather than by minute-range overlap.
  const winOfMinute = (m) => {
    let best = null;
    for (const win of engine.APPOINTMENT_WINDOWS) {
      if (m >= win.startMin && (best === null || win.startMin > best.startMin)) best = win;
    }
    return best;
  };

  const bookedTechsByWindow = new Map();
  const unassignedByWindow = new Map();
  for (const b of dayBookings) {
    const start = parseTimeToMinutes(b.startTime);
    if (Number.isNaN(start)) continue;
    const win = winOfMinute(start);
    if (!win) continue;
    if (b.technicianId) {
      const key = String(b.technicianId);
      if (!bookedTechsByWindow.has(key)) bookedTechsByWindow.set(key, new Set());
      bookedTechsByWindow.get(key).add(win.startMin);
    } else {
      if (!unassignedByWindow.has(win.startMin)) unassignedByWindow.set(win.startMin, 0);
      unassignedByWindow.set(win.startMin, unassignedByWindow.get(win.startMin) + 1);
    }
  }

  const windows = [];
  for (const win of engine.APPOINTMENT_WINDOWS) {
    const winStart = win.startMin;
    const winEnd = winStart + reservationMinutes;

    // Must start by admin-configured end of day; jobs may extend into overtime.
    if (winStart > DAY_END) continue;

    // Past / advance-notice filtering for today.
    if (isToday) {
      if (winStart <= nowMinutes + 30) continue;
      if (winStart < earliestMinutes) continue;
    }

    // Technicians free for this specific window: unbooked in this window
    // AND not still active in any earlier window (covers a late / overrun
    // job that hasn't been marked completed yet — the tech can't be
    // re-dispatched until the earlier job is done).
    let freeTechs = 0;
    for (const w of workable) {
      if (winStart < w.blockStart) continue;
      const booked = bookedTechsByWindow.get(w.id);
      const blockedEarlier = booked && Array.from(booked).some((s) => s < winStart);
      if (!booked || (!booked.has(winStart) && !blockedEarlier)) freeTechs++;
    }

    // Company-wide unassigned bookings consume a slot in this window.
    const unassigned = unassignedByWindow.get(winStart) || 0;
    const available = Math.max(0, freeTechs - unassigned);
    if (available <= 0) continue;

    const serviceStart = winStart + travelMinutes;
    windows.push({
      startMinutes: winStart,
      endMinutes: winEnd,
      totalEndMinutes: winEnd,
      durationMinutes: serviceMinutes,
      travelMinutes,
      availableCount: available,
      status: "available",
      label: win.label,
      blockLabel: minutesTo12HourLabel(winStart) + " – " + minutesTo12HourLabel(winEnd),
      detail: buildSlotDetail(serviceMinutes, travelMinutes, reservationMinutes, quantity),
    });
  }

  return windows;
}

/**
 * Main orchestrator — computes available time slots for a service on a date.
 *
 * Two modes:
 *  • Customer (no technicianId): fixed appointment windows with company-wide
 *    capacity — see computeCompanyWindows().
 *  • Admin/reschedule (technicianId given): fine-grained gap-based slots for the
 *    single technician, honouring their real schedule and bookings.
 */
async function computeAvailability(
  serviceId,
  dateStr,
  technicianId,
  travelTime = 0,
  manualDuration = null,
  quantity = 1
) {
  try {
    const date = new Date(dateStr + "T00:00:00");
    if (Number.isNaN(date.getTime())) throw new Error("invalid_date");

    const duration = await resolveServiceDuration(serviceId, manualDuration);
    const qty = Math.max(1, Number(quantity) || 1);
    const engine = require("../utils/enterpriseSchedulingEngine");
    if (qty > engine.MAX_BOOKING_UNITS) throw new Error(`Maximum quantity is ${engine.MAX_BOOKING_UNITS} units.`);
    const effectiveServiceDuration = duration * qty;
    const tt = Math.max(0, Number(travelTime) || 0);

    // Full reservation via the shared engine (service×qty + travel + traffic
    // + prep + completion + operational buffer) — single source of truth.
    const reservation = engine.computeReservationMinutes({
      totalEstimatedMinutes: effectiveServiceDuration,
      travelTime: tt,
    });
    const totalDur = reservation.reservationMinutes;

    const minAdvanceMinutes = await getMinAdvanceMinutes();
    const earliestAllowed = earliestAllowedDateTime(minAdvanceMinutes);
    const earliestMinutes = earliestAllowed.getHours() * 60 + earliestAllowed.getMinutes();
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // ── Customer standard flow: fixed windows + company capacity ──────────
    if (!technicianId) {
      return await computeCompanyWindows(dateStr, {
        reservationMinutes: totalDur,
        serviceMinutes: effectiveServiceDuration,
        travelMinutes: tt,
        quantity: qty,
        earliestMinutes,
        isToday,
        nowMinutes,
      });
    }

    // ── Admin / reschedule: granular per-technician slots ─────────────────
    const blocks = await loadTechnicianWorkingBlocks(technicianId, date);
    if (!blocks.length) return [];

    const busyRanges = await loadBusyRanges(technicianId, date, duration);
    const gaps = findFreeGaps(blocks, busyRanges);

    const slotInterval = 30;
    const result = generateSlotsFromGaps(gaps, totalDur, slotInterval, {
      serviceDuration: effectiveServiceDuration,
      travelMinutes: tt,
      quantity: qty,
    });

    return isToday ? result.filter((s) => s.startMinutes >= earliestMinutes) : result;
  } catch (err) {
    console.error("computeAvailability error", err, { serviceId, dateStr });
    return [];
  }
}

router.get("/availability", async (req, res) => {
  try {
    const { date, serviceId, technicianId, travelTime, serviceDuration, quantity, serviceModel } = req.query;
    if (!date)
      return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });

    const tt = travelTime ? Number(travelTime) || 0 : 0;
    const qty = Math.max(1, Number(quantity) || 1);

    const engine = require("../utils/enterpriseSchedulingEngine");
    if (qty > engine.MAX_BOOKING_UNITS) return res.status(400).json({ error: `Maximum quantity is ${engine.MAX_BOOKING_UNITS} units.` });
    const workload = await engine.calculateWorkload({
      serviceId,
      quantity: qty,
      serviceModel: serviceModel || "CoreService",
      travelTime: tt,
    });

    if (qty >= engine.LARGE_SCALE_MIN_UNITS) {
      return res.json({
        date,
        slots: [],
        isLargeProject: true,
        message: "This request exceeds the capacity of a standard appointment and requires project scheduling. Please select your preferred project start date. Our administrator will prepare a work schedule and contact you for confirmation.",
        workload: {
          durationMinutes: workload.durationMinutes,
          travelMinutes: workload.travelMinutes,
          trafficAllowance: workload.trafficAllowance,
          prepBuffer: workload.prepBuffer,
          completionBuffer: workload.completionBuffer,
          totalWorkloadMinutes: workload.totalWorkloadMinutes,
        },
        totalEstimatedMinutes: workload.durationMinutes,
        totalEstimatedHours: (workload.durationMinutes / 60).toFixed(1),
        quantity: qty,
        durationPerUnit: workload.durationPerUnit,
      });
    }

    let slots = [];
    let errMsg = null;
    try {
      slots = await computeAvailability(serviceId, date, technicianId, tt, workload.durationPerUnit, qty);
    } catch (err) {
      errMsg = err && (err.message || String(err));
      console.error("availability compute failed", errMsg, { date, serviceId, technicianId, quantity });
    }

    const resp = {
      date,
      slots,
      isLargeProject: false,
      workload: {
        durationMinutes: workload.durationMinutes,
        travelMinutes: workload.travelMinutes,
        trafficAllowance: workload.trafficAllowance,
        prepBuffer: workload.prepBuffer,
        completionBuffer: workload.completionBuffer,
        totalWorkloadMinutes: workload.totalWorkloadMinutes,
      },
      totalEstimatedMinutes: workload.durationMinutes,
      quantity: qty,
    };
    if (errMsg && process.env.NODE_ENV !== "production") {
      resp.error = errMsg;
    }
    return res.json(resp);
  } catch (un) {
    console.error("availability handler crashed", un && (un.stack || un));
    return res.json({
      date: req.query.date || null,
      slots: [],
      isLargeProject: false,
      error: "handler_exception",
    });
  }
});

router.get("/:id/availability", async (req, res) => {
  const id = req.params.id;
  const { date, technicianId } = req.query;
  if (!date)
    return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
  try {
    const slots = await computeAvailability(id, date, technicianId);
    return res.json({ date, slots });
  } catch (err) {
    return res.status(500).json({ error: "failed to compute availability" });
  }
});

// GET /api/services/fare-per-km — public endpoint so the booking UI can
// display the correct fare rate configured by the admin.
// IMPORTANT: Must be defined BEFORE /:id wildcard route!
router.get("/fare-per-km", async (req, res) => {
  try {
    const SiteSetting = require("../models/SiteSetting");
    const [fareSetting, installSetting] = await Promise.all([
      SiteSetting.findOne({ key: "farePerKm" }).lean(),
      SiteSetting.findOne({ key: "airconInstallFee" }).lean()
    ]);
    
    // Use parseFloat to handle Mixed schema values (could be string or number)
    const fareRaw = fareSetting && fareSetting.value != null ? parseFloat(fareSetting.value) : NaN;
    const installRaw = installSetting && installSetting.value != null ? parseFloat(installSetting.value) : NaN;
    
    const farePerKm = !isNaN(fareRaw) ? fareRaw : 40;
    const airconInstallFee = !isNaN(installRaw) ? installRaw : 1500;
    
    return res.json({ farePerKm, airconInstallFee });
  } catch (err) {
    console.error("GET /api/services/fare-per-km failed", err && err.message);
    return res.json({ farePerKm: 40, airconInstallFee: 1500 });
  }
});

// Public read-only payment policy used by product checkout and service booking.
router.get("/payment-policy", async (_req, res) => {
  try {
    const downpaymentPercentage = await getDownpaymentPercentage();
    return res.json({ downpaymentPercentage });
  } catch (err) {
    logger.warn("Failed to load payment policy", { error: err && err.message });
    return res.json({ downpaymentPercentage: 10 });
  }
});

// GET /api/services/:id - return a single service from any relevant collection
router.get("/:id", async (req, res) => {
  const id = req.params.id;
  try {
    let found = null;
    // try normalized Service collection first
    found = await Service.findById(id).lean();
    if (!found) found = await CoreService.findById(id).lean();
    if (!found) found = await RepairService.findById(id).lean();
    if (!found) return res.status(404).json({ error: "Service not found" });
    return res.json({ service: found });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load service" });
  }
});

// GET /api/services/:id/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns sets of booked and blocked dates in the requested range (public endpoint used by booking UI)
router.get("/:id/calendar", async (req, res) => {
  try {
    const id = req.params.id;
    const { start, end } = req.query;
    const startDate = start ? new Date(start + "T00:00:00") : null;
    const endDate = end ? new Date(end + "T00:00:00") : null;
    if (
      (start && Number.isNaN(startDate.getTime())) ||
      (end && Number.isNaN(endDate.getTime()))
    )
      return res.status(400).json({ error: "invalid start/end" });

    // bookings -> bookedDates
    const bookedSet = new Set();
    const { technicianId } = req.query;
    const bq = {};
    if (technicianId) {
      let techIdForQuery = technicianId;
      if (mongoose.Types.ObjectId.isValid(technicianId)) {
        const Technician = require("../models/Technician");
        const tech = await Technician.findOne({ user: technicianId })
          .select("_id")
          .lean();
        if (tech) techIdForQuery = tech._id.toString();
      }
      // when technician is selected, calendar should reflect ALL of their
      // customer bookings across services to prevent perceived double-booking.
      bq.technicianId = techIdForQuery;
      bq.status = { $nin: ["cancelled"] };
    } else {
      // fallback behavior (no technician context): keep service-based calendar.
      bq.serviceId = id;
    }
    if (startDate || endDate) bq.bookingDate = {};
    if (startDate) bq.bookingDate.$gte = startDate;
    if (endDate) {
      const ed = new Date(endDate);
      ed.setHours(23, 59, 59, 999);
      bq.bookingDate.$lte = ed;
    }
    const bookings = await BookingService.find(bq).lean();
    bookings.forEach((b) => {
      if (!b.bookingDate) return;
      const d = new Date(b.bookingDate);
      bookedSet.add(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
      );
    });

    // blockedDates collected from non-working days and public holidays
    const blockedSet = new Set();
    let nonWorkingDays = [];
    try {
      const ndq = {};
      if (startDate || endDate) ndq.date = {};
      if (startDate) ndq.date.$gte = startDate;
      if (endDate) {
        const ed3 = new Date(endDate);
        ed3.setHours(23, 59, 59, 999);
        ndq.date.$lte = ed3;
      }
      // include global day-offs (service=null) and service-specific ones
      ndq.$or = [
        { service: id },
        { service: { $exists: false } },
        { service: null },
      ];
      const NonWorkingDay = require("../models/NonWorkingDay");
      const ndocs = await NonWorkingDay.find(ndq).lean();
      ndocs.forEach((n) => {
        const d = new Date(n.date);
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        blockedSet.add(iso);
        nonWorkingDays.push({ date: iso, note: n.note || "" });
      });
    } catch (e) {
      // ignore day-off lookup failures
      console.warn("calendar: failed to load non-working days", e && e.message);
    }

    // optionally include public holidays from configured provider (adds to blockedDates)
    try {
      const enabled = (process.env.PUBLIC_HOLIDAYS_ENABLED || "1") !== "0";
      const publicHolidays = [];
      if (enabled && startDate && endDate) {
        const provHeader = req.get("X-Provider");
        const provQuery = req.query.provider;
        const provider = (
          provQuery ||
          provHeader ||
          process.env.PUBLIC_HOLIDAYS_PROVIDER ||
          "google"
        ).toLowerCase();
        if (provider === "google") {
          const googleCal = require("../utils/googleCalendarService");
          const countryCal =
            process.env.PUBLIC_HOLIDAYS_CALENDAR_ID ||
            "en.ph#holiday@group.v.calendar.google.com";
          const ph = await googleCal.getHolidaysInRange(
            startDate,
            endDate,
            countryCal,
            process.env.GOOGLE_CALENDAR_API_KEY,
          );
          (ph || []).forEach((h) => {
            blockedSet.add(h.date);
            publicHolidays.push({
              date: h.date,
              name: h.name || h.summary || "",
            });
          });
        } else if (provider === "nager") {
          const nager = require("../utils/nagerDateService");
          const country = (
            req.query.country ||
            process.env.NAGER_COUNTRY ||
            "PH"
          ).toUpperCase();
          const startYr = startDate.getFullYear();
          const endYr = endDate.getFullYear();
          for (let yr = startYr; yr <= endYr; yr++) {
            try {
              const phs = await nager.getPublicHolidays(country, yr);
              (phs || []).forEach((h) => {
                if (h && h.date) {
                  blockedSet.add(h.date);
                  publicHolidays.push({
                    date: h.date,
                    name: h.localName || h.name || "",
                  });
                }
              });
            } catch (err) {
              console.warn(
                "calendar: failed to fetch nager holidays",
                err && err.message,
              );
            }
          }
        }
      }
      return res.json({
        bookedDates: Array.from(bookedSet),
        blockedDates: Array.from(blockedSet),
        publicHolidays,
        nonWorkingDays,
      });
    } catch (e) {
      console.warn(
        "calendar: failed to include public holidays",
        e && e.message,
      );
      return res.json({
        bookedDates: Array.from(bookedSet),
        blockedDates: Array.from(blockedSet),
        nonWorkingDays,
      });
    }
  } catch (err) {
    console.error("GET /api/services/:id/calendar failed", err && err.message);
    return res.status(500).json({ error: "failed to load calendar data" });
  }
});


router.get("/enterprise/estimate", async (req, res) => {
  try {
    const { serviceId, quantity, serviceModel, hp, airconType } = req.query;
    if (!serviceId) return res.status(400).json({ error: "serviceId is required" });

    const { calculateTotalEstimatedDuration, isLargeProject, getProjectThresholdHours } = require("../utils/enterpriseSchedulingEngine");

    const estimate = await calculateTotalEstimatedDuration(serviceId, quantity, serviceModel, hp, airconType);
    if (estimate.quantity > 40) return res.status(400).json({ error: "Maximum quantity is 40 units." });
    const large = await isLargeProject({ totalUnits: estimate.quantity, totalEstimatedMinutes: estimate.totalMinutes });
    const thresholdHours = await getProjectThresholdHours();

    res.json({
      ...estimate,
      isLargeProject: large,
      thresholdHours,
      message: large
        ? "This request exceeds the capacity of a standard appointment and requires project scheduling."
        : "This request qualifies for standard appointment scheduling.",
    });
  } catch (error) {
    console.error("Error estimating project:", error);
    res.status(500).json({ error: "Failed to estimate" });
  }
});

router.get("/enterprise/dates", async (req, res) => {
  try {
    const { serviceId, quantity, serviceModel, travelTime, startDate, endDate, hp, airconType } = req.query;
    if (!serviceId) return res.status(400).json({ error: "serviceId is required" });

    const { calculateTotalEstimatedDuration, generateAvailableDates } = require("../utils/enterpriseSchedulingEngine");

    const estimate = await calculateTotalEstimatedDuration(serviceId, quantity, serviceModel, hp, airconType);
    if (estimate.quantity > 40) return res.status(400).json({ error: "Maximum quantity is 40 units." });
    const result = await generateAvailableDates({
      totalEstimatedMinutes: estimate.totalMinutes,
      serviceId,
      quantity: estimate.quantity,
      serviceModel,
      minDate: startDate,
      maxDate: endDate,
      travelTime: Number(travelTime) || 20,
    });

    res.json(result);
  } catch (error) {
    console.error("Error generating dates:", error);
    res.status(500).json({ error: "Failed to generate dates" });
  }
});

module.exports = router;

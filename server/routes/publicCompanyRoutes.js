const express = require("express");

const router = express.Router();
const SiteSetting = require("../models/SiteSetting");

/**
 * GET /api/public/company/location
 * Returns the admin-configured company/base location used for distance/fare calculations.
 */
router.get("/location", async (req, res, next) => {
  try {
    const [latSetting, lngSetting, addrSetting] = await Promise.all([
      SiteSetting.findOne({ key: "companyLocationLat" }).lean(),
      SiteSetting.findOne({ key: "companyLocationLng" }).lean(),
      SiteSetting.findOne({ key: "companyLocationAddress" }).lean(),
    ]);

    const latRaw = latSetting && latSetting.value != null ? Number(latSetting.value) : NaN;
    const lngRaw = lngSetting && lngSetting.value != null ? Number(lngSetting.value) : NaN;

    // Provide safe defaults so the UI doesn't crash if admin hasn't configured yet.
    const fallback = {
      lat: 14.676049, // Manila
      lng: 121.043731,
      address: "Company location not set",
    };

    const payload = {
      lat: Number.isFinite(latRaw) ? latRaw : fallback.lat,
      lng: Number.isFinite(lngRaw) ? lngRaw : fallback.lng,
      address: addrSetting && typeof addrSetting.value === "string" && addrSetting.value.trim()
        ? addrSetting.value.trim()
        : fallback.address,
      configured: Number.isFinite(latRaw) && Number.isFinite(lngRaw),
    };

    return res.json(payload);
  } catch (err) {
    next(err);
  }
});

const DEFAULT_STORE_HOURS = [
  { dayOfWeek: 0, open: false, startMinutes: 0, endMinutes: 0 },
  { dayOfWeek: 1, open: true,  startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 2, open: true,  startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 3, open: true,  startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 4, open: true,  startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 5, open: true,  startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 6, open: true,  startMinutes: 480, endMinutes: 1080 },
];

/**
 * GET /api/public/store-open-hours
 * Returns the store's open hours for customer pickup scheduling.
 */
router.get("/store-open-hours", async (req, res, next) => {
  try {
    const doc = await SiteSetting.findOne({ key: "storeOpenHours" }).lean();
    const hours = (doc && Array.isArray(doc.value)) ? doc.value : DEFAULT_STORE_HOURS;
    return res.json({ hours });
  } catch (err) {
    next(err);
  }
});

module.exports = router;


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

module.exports = router;


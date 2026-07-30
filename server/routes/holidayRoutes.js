const express = require("express");
const router = express.Router();
const googleCal = require("../utils/googleCalendarService");

// GET /api/holidays?start=YYYY-MM-DD&end=YYYY-MM-DD[&calendarId=&apiKey=&provider=google|nager]
// or supply X-Provider header to override provider for a single request.
router.get("/", async (req, res) => {
  try {
    const { start, end, calendarId, provider: qp } = req.query;
    const headerProv = req.get("X-Provider");
    const prov = (
      qp ||
      headerProv ||
      process.env.PUBLIC_HOLIDAYS_PROVIDER ||
      "google"
    ).toLowerCase();

    if (!start || !end)
      return res
        .status(400)
        .json({ error: "start and end are required (YYYY-MM-DD)" });
    const sd = new Date(start + "T00:00:00");
    const ed = new Date(end + "T00:00:00");
    if (Number.isNaN(sd.getTime()) || Number.isNaN(ed.getTime()))
      return res.status(400).json({ error: "invalid start/end" });

    const enabled = (process.env.PUBLIC_HOLIDAYS_ENABLED || "1") !== "0";
    if (!enabled) return res.json({ holidays: [] });

    if (prov === "google") {
      const calId =
        calendarId ||
        process.env.PUBLIC_HOLIDAYS_CALENDAR_ID ||
        "en.ph#holiday@group.v.calendar.google.com";
      const list = await googleCal.getHolidaysInRange(
        sd,
        ed,
        calId,
        process.env.GOOGLE_CALENDAR_API_KEY,
      );
      return res.json({ holidays: list || [] });
    } else if (prov === "nager") {
      const nager = require("../utils/nagerDateService");
      // allow country override via query parameter when using nager
      const country = (
        req.query.country ||
        process.env.NAGER_COUNTRY ||
        "PH"
      ).toUpperCase();
      const startYr = sd.getFullYear();
      const endYr = ed.getFullYear();
      const out = [];
      for (let yr = startYr; yr <= endYr; yr++) {
        try {
          const phs = await nager.getPublicHolidays(country, yr);
          (phs || []).forEach((h) => {
            if (h && h.date) {
              out.push({ date: h.date, name: h.localName || h.name || "" });
            }
          });
        } catch (err) {
          console.warn("holidayRoutes: nager fetch failed", err && err.message);
        }
      }
      return res.json({ holidays: out });
    }

    // unknown provider
    return res.json({ holidays: [] });
  } catch (err) {
    console.error("GET /api/holidays failed", err && err.message);
    return res.status(500).json({ error: "failed to load holidays" });
  }
});

module.exports = router;

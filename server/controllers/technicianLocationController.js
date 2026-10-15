"use strict";
// Shared by the tracker and project panel; both routes enforce technician auth.
exports.updateLocation = async (req, res) => {
    try {
      const user = req.user;
      if (!user || user.role !== "technician")
        return res.status(403).json({ error: "forbidden" });
      // Accept lat/lng in request body; caller (tracker page) sends {lat, lng}
      const { lat, lng } = req.body || {};
      if (
        typeof lng !== "number" ||
        typeof lat !== "number" ||
        Number.isNaN(lng) ||
        Number.isNaN(lat) ||
        lng < -180 ||
        lng > 180 ||
        lat < -90 ||
        lat > 90
      ) {
        return res.status(400).json({ error: "invalid_coordinates" });
      }
      const Technician = require("../models/Technician");
      const tech = await Technician.findOneAndUpdate(
        { user: user._id },
        // GeoJSON order is [lng, lat]
        { location: { type: "Point", coordinates: [lng, lat] } },
        { returnDocument: "after" },
      );
      if (!tech) return res.status(404).json({ error: "technician_not_found" });

      // after updating location, check for any nearby bookings that have not
      // yet been notified.  Use a simple haversine distance test.
      try {
        const BookingService = require("../models/BookingService");
        const mailer = require("../utils/mailer");

        function distanceMeters(lat1, lng1, lat2, lng2) {
          const R = 6371e3; // metres
          const φ1 = (lat1 * Math.PI) / 180;
          const φ2 = (lat2 * Math.PI) / 180;
          const Δφ = ((lat2 - lat1) * Math.PI) / 180;
          const Δλ = ((lng2 - lng1) * Math.PI) / 180;
          const a =
            Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          return R * c;
        }

        const threshold = 200; // metres
        const active = await BookingService.find({
          technicianId: tech._id,
          status: { $in: ["scheduled", "on-the-way"] },
          arrivalNotified: { $ne: true },
          "location.coordinates": { $exists: true, $size: 2 },
        }).lean();
        for (const appt of active) {
          const coords =
            appt.location && appt.location.coordinates && appt.location.coordinates.coordinates;
          if (Array.isArray(coords) && coords.length === 2) {
            const [custLng, custLat] = coords;
            const d = distanceMeters(lat, lng, custLat, custLng);
            if (d <= threshold) {
              // send mail and mark notified
              try {
                await mailer.sendTechArrivalNotificationEmail({
                  to: appt.customerEmail || (appt.customer && appt.customer.email),
                  customerName: appt.customerName || (appt.customer && appt.customer.name),
                  bookingReference: appt.bookingReference || appt._id,
                  techName: tech.name || "",
                });
              } catch (e) {
                console.warn("arrival mail failed", e && e.message);
              }
              try {
                await BookingService.findByIdAndUpdate(appt._id, { arrivalNotified: true });
              } catch (_) {}
            }
          }
        }
      } catch (mailErr) {
        console.warn("proximity notification error", mailErr && mailErr.message);
      }

      return res.json({ location: tech.location });
    } catch (err) {
      console.error("technician location update error", err);
      return res.status(500).json({ error: "server_error" });
    }
  };

const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const authController = require("../controllers/authController");
// secure (session) auth - optional new implementation
const secureAuthRoutes = require("./secureAuth");

// Register - basic customer registration
router.post(
  "/register",
  [
    body("email")
      .isLength({ max: 254 })
      .withMessage("Invalid input")
      .trim()
      .isEmail()
      .withMessage("Invalid email format")
      .normalizeEmail({
        gmail_remove_dots: false,
        gmail_remove_subaddress: false,
        all_lowercase: true,
      }),
    body("password")
      .isLength({ min: 8, max: 30 })
      .withMessage("Invalid input")
      .matches(
        /^(?=(?:.*[A-Z]){1})(?!.*[A-Z].*[A-Z])(?!.*!.*!)(?!.*@.*@)(?!.*#.*#)(?!.*\$.*\$)[A-Za-z0-9@!#$]+$/,
      )
      .withMessage(
        "Password must be 8–30 chars, include exactly one uppercase, and each of !,@,#,$ may appear at most once",
      ),
    body("mathCaptcha")
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 3 }) 
      .withMessage("Invalid captcha")
      .trim(),
    body("mathAnswer")
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 3 })
      .withMessage("Invalid captcha answer")
      .trim(),
    // Profile fields required for customers
    body("firstName")
      .isLength({ min: 1, max: 20 })
      .withMessage("Invalid first name")
      .matches(/^[A-Za-z\s]+$/)
      .withMessage("First name must contain letters only")
      .trim(),
    body("lastName")
      .isLength({ min: 1, max: 20 })
      .withMessage("Invalid last name")
      .matches(/^[A-Za-z\s]+$/)
      .withMessage("Last name must contain letters only")
      .trim(),
    body("phone")
      .matches(/^(?:0\d{10}|63\d{10}|9\d{9})$/)
      .withMessage("Invalid Philippine mobile number")
      .trim(),
    body("addressProvince")
      .isLength({ min: 1, max: 100 })
      .withMessage("Invalid province")
      .trim(),
    body("addressCity")
      .isLength({ min: 1, max: 100 })
      .withMessage("Invalid city")
      .trim(),
    body("addressBarangay")
      .optional()
      .isLength({ min: 1, max: 100 })
      .withMessage("Invalid barangay")
      .trim(),
    body("addressPostal")
      .matches(/^[0-9]{1,4}$/)
      .withMessage("Postal code must be 1 to 4 digits")
      .trim(),
  ],
  authController.register,
);

router.post(
  "/verify-register-otp",
  [
    body("email")
      .trim()
      .isLength({ min: 3, max: 254 })
      .isEmail()
      .withMessage("Invalid email format")
      .normalizeEmail({
        gmail_remove_dots: false,
        gmail_remove_subaddress: false,
        all_lowercase: true,
      }),
    body("otp")
      .trim()
      .isNumeric()
      .isLength({ min: 6, max: 6 })
      .withMessage("Invalid verification code"),
  ],
  authController.verifyRegisterOTP,
);

router.post(
  "/resend-register-otp",
  [
    body("email")
      .trim()
      .isLength({ min: 3, max: 254 })
      .isEmail()
      .withMessage("Invalid email format")
      .normalizeEmail({
        gmail_remove_dots: false,
        gmail_remove_subaddress: false,
        all_lowercase: true,
      }),
  ],
  authController.resendRegisterOTP,
);

// Login - CSRF double submit expected (csrfToken) and generic errors
router.post(
  "/login",
  [
    body("email")
      .trim()
      .isLength({ min: 3, max: 254 })
      .withMessage("Invalid input")
      .isEmail()
      .withMessage("Invalid email format")
      .normalizeEmail({
        gmail_remove_dots: false,
        gmail_remove_subaddress: false,
        all_lowercase: true,
      }),
    body("password")
      .isString()
      .isLength({ min: 1, max: 128 })
      .withMessage("Invalid input"),
    body("mathCaptcha")
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 3 })
      .withMessage("Invalid input")
      .trim(),
    body("mathAnswer")
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 3 })
      .withMessage("Invalid input")
      .trim(),
    body("csrfToken").isString().withMessage("Invalid input"),
  ],
  authController.login,
);

// Verify login OTP (used when an OTP was requested during initial login)
router.post(
  "/verify-login-otp",
  [
    body("email")
      .isLength({ max: 254 })
      .withMessage("Invalid input")
      .trim()
      .isEmail()
      .withMessage("Invalid email format")
      .normalizeEmail({
        gmail_remove_dots: false,
        gmail_remove_subaddress: false,
        all_lowercase: true,
      }),
    body("otp")
      .isNumeric()
      .isLength({ min: 6, max: 6 })
      .withMessage("Invalid OTP")
      .trim(),
    body("trustDevice").optional().isBoolean().withMessage("Invalid device preference"),
  ],
  authController.verifyLoginOTP,
);

// Resend login OTP
router.post(
  "/resend-login-otp",
  [
    body("email")
      .isLength({ max: 254 })
      .withMessage("Invalid input")
      .trim()
      .isEmail()
      .withMessage("Invalid email format")
      .normalizeEmail({
        gmail_remove_dots: false,
        gmail_remove_subaddress: false,
        all_lowercase: true,
      }),
  ],
  authController.resendLoginOTP,
);

// Forgot password (generic response)
router.post(
  "/forgot-password",
  [
    body("email")
      .isLength({ max: 30 })
      .withMessage("Invalid input")
      .trim()
      .isEmail()
      .withMessage("Invalid email format")
      .normalizeEmail({
        gmail_remove_dots: false,
        gmail_remove_subaddress: false,
        all_lowercase: true,
      }),
    body("mathCaptcha")
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 3 })
      .withMessage("Invalid captcha")
      .trim(),
    body("mathAnswer")
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 3 })
      .withMessage("Invalid captcha answer")
      .trim(),
    body("csrfToken").optional().isString().withMessage("Invalid input"),
  ],
  authController.forgotPassword,
);

// Reset password
router.post(
  "/reset-password",
  [
    body("token")
      .isString()
      .isLength({ min: 10, max: 256 })
      .withMessage("Invalid input"),
    body("email")
      .isLength({ max: 30 })
      .withMessage("Invalid input")
      .trim()
      .isEmail()
      .withMessage("Invalid email format")
      .normalizeEmail({
        gmail_remove_dots: false,
        gmail_remove_subaddress: false,
        all_lowercase: true,
      }),
    body("password").isLength({ min: 8, max: 30 }).withMessage("Invalid input"),
    body("mathCaptcha")
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 3 })
      .withMessage("Invalid captcha")
      .trim(),
    body("mathAnswer")
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 3 })
      .withMessage("Invalid captcha answer")
      .trim(),
    body("csrfToken").isString().withMessage("Invalid input"),
  ],
  authController.resetPassword,
);

// Logout
router.post("/logout", authController.logout);

// technician location update (device reports its coordinates)
router.post(
  "/technician/location",
  require("../middleware/authenticate").authenticate,
  async (req, res) => {
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
  },
);

// Verify token
router.get("/verify", authController.verify);

// Dev login route — ONLY available in non-production environments
if (process.env.NODE_ENV !== "production" && process.env.ENABLE_DEV_LOGIN === "true") {
  router.get("/dev-login", async (req, res) => {
    try {
      const Technician = require("../models/Technician");
      const User = require("../models/User");
      const Project = require("../models/Project");

      // Pick the most useful technician for UAT: prefer the lead of a
      // large-scale project (so the Projects tab has data), then one with
      // bookings, then simply the first technician.
      let tech = null;
      const leadProj = await Project.findOne({ isLargeScale: true, leadTechnicianId: { $exists: true } })
        .sort({ updatedAt: -1 })
        .lean()
        .catch(() => null);
      if (leadProj && leadProj.leadTechnicianId) {
        tech = await Technician.findById(leadProj.leadTechnicianId).lean().catch(() => null);
      }
      if (!tech) {
        const Assignment = require("../models/Assignment");
        const withAssign = await Assignment.findOne({}).lean().catch(() => null);
        if (withAssign) tech = await Technician.findById(withAssign.technicianId).lean().catch(() => null);
      }
      if (!tech) tech = await Technician.findOne({}).lean();

      if (!tech) return res.send("Dev login failed: no technician found");
      const user = await User.findById(tech.user);
      if (!user) return res.send("Dev login failed: technician has no user");

      // DEV ONLY: ensure the chosen technician has at least one standard booking
      // so the "My Work" tab isn't empty during UAT. Skips if they already have one.
      try {
        const Assignment = require("../models/Assignment");
        const BookingService = require("../models/BookingService");
        const existing = await Assignment.countDocuments({ technicianId: tech._id });
        if (existing === 0) {
          const booking = await BookingService.create({
            customerName: "Sample Customer",
            serviceName: "Aircon Cleaning",
            address: "123 Demo Street, Quezon City",
            bookingDate: new Date(),
            startTime: "09:00",
            endTime: "11:00",
            status: "pending_acceptance",
            paymentStatus: "unpaid",
            totalPrice: 1500,
            estimatedFee: 1500,
            serviceType: "cleaning",
          });
          await Assignment.create({
            bookingId: booking._id,
            technicianId: tech._id,
            customerName: booking.customerName,
            serviceName: booking.serviceName,
            address: booking.address,
            bookingDate: booking.bookingDate,
            startTime: booking.startTime,
            endTime: booking.endTime,
            status: "pending_acceptance",
            serviceType: "cleaning",
            slaDeadline: new Date(Date.now() + 7 * 864e5),
          });
        }
      } catch (_) {}

      // Simulate login by signing a JWT token cookie (similar to what authController does)
      const jwt = require("jsonwebtoken");
      const token = jwt.sign(
        { id: user._id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );
      res.cookie("auth_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.redirect("/technician");
    } catch (err) {
      res.send("Dev login failed: " + err.message);
    }
  });
}

// Mount secure session-based endpoints (optional, non-breaking)
router.use("/secure", secureAuthRoutes);

module.exports = router;

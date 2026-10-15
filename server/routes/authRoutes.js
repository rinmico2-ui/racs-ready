const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const { limitAuthWork } = require("../utils/authWork");
const authController = require("../controllers/authController");
const googleAuthController = require("../controllers/googleAuthController");
const auth = require("../middleware/authenticate");
const {
  REGISTRATION_PASSWORD_MESSAGE,
  isValidRegistrationPassword,
} = require("../utils/registrationPasswordPolicy");
// secure (session) auth - optional new implementation
const secureAuthRoutes = require("./secureAuth");

// Google OAuth signs in existing accounts and offers profile completion to
// first-time customers after Google verifies their identity.
router.get("/google", googleAuthController.start);
router.get("/google/callback", googleAuthController.callback);
router.get("/google/device", auth.authenticate, auth.requireRole("technician"), googleAuthController.deviceSetupPage);
router.post("/google/device", auth.authenticate, auth.requireRole("technician"), googleAuthController.deviceSetupSubmit);
router.get("/google/signup", googleAuthController.signupPage);
router.post("/google/complete-signup", limitAuthWork(googleAuthController.completeSignup));

// Register - basic customer registration
router.post(
  "/register",
  [
    body("email")
      .isString().withMessage('Enter an email address.').bail()
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
      .isString().withMessage(REGISTRATION_PASSWORD_MESSAGE).bail()
      .isLength({ min: 8, max: 30 })
      .withMessage(REGISTRATION_PASSWORD_MESSAGE)
      .custom(isValidRegistrationPassword)
      .withMessage(REGISTRATION_PASSWORD_MESSAGE),
    body("mathCaptcha")
      .isString().withMessage('Complete the security question.').bail()
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 3 }) 
      .withMessage("Invalid captcha")
      .trim(),
    body("mathAnswer")
      .isString().withMessage('Complete the security question.').bail()
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 3 })
      .withMessage("Invalid captcha answer")
      .trim(),
    // Profile fields required for customers
    body("firstName")
      .isString().withMessage('Enter a first name.').bail().trim()
      .isLength({ min: 1, max: 20 })
      .withMessage("Invalid first name")
      .matches(/^[A-Za-z\s]+$/)
      .withMessage("First name must contain letters only")
      .trim(),
    body("lastName")
      .isString().withMessage('Enter a last name.').bail().trim()
      .isLength({ min: 1, max: 20 })
      .withMessage("Invalid last name")
      .matches(/^[A-Za-z\s]+$/)
      .withMessage("Last name must contain letters only")
      .trim(),
    body("phone")
      .isString().withMessage('Enter a mobile number.').bail().trim()
      .matches(/^(?:0\d{10}|63\d{10}|9\d{9})$/)
      .withMessage("Invalid Philippine mobile number")
      .trim(),
    body("addressProvince")
      .isString().withMessage('Choose a province.').bail().trim()
      .isLength({ min: 1, max: 100 })
      .withMessage("Invalid province")
      .trim(),
    body("addressCity")
      .isString().withMessage('Choose a city or municipality.').bail().trim()
      .isLength({ min: 1, max: 100 })
      .withMessage("Invalid city")
      .trim(),
    body("addressBarangay")
      .isString().withMessage('Choose a barangay.').bail().trim()
      .isLength({ min: 1, max: 100 })
      .withMessage("Invalid barangay")
      .trim(),
    body("addressPostal")
      .isString().withMessage('Enter a postal code.').bail().trim()
      .matches(/^[0-9]{4}$/)
      .withMessage("Postal code must be 4 digits")
      .trim(),
  ],
  limitAuthWork(authController.register),
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
  limitAuthWork(authController.login),
);

// Verify login OTP (used when an OTP was requested during initial login)
router.post(
  "/verify-login-otp",
  [
    body("email")
      .isString().bail()
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
      .isString().bail()
      .isNumeric()
      .isLength({ min: 6, max: 6 })
      .withMessage("Invalid OTP")
      .trim(),
    body("trustDevice").optional().isBoolean().withMessage("Invalid device preference"),
    body("csrfToken").isString().isLength({ min: 1, max: 256 }),
  ],
  authController.verifyLoginOTP,
);

// Resend login OTP
router.post(
  "/resend-login-otp",
  [
    body("email")
      .isString().bail()
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
    body("csrfToken").isString().isLength({ min: 1, max: 256 }),
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
  limitAuthWork(authController.forgotPassword),
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
  limitAuthWork(authController.resetPassword),
);

router.post(
  "/activate-invited-account",
  [
    body("token").isString().isLength({ min: 64, max: 64 }).isHexadecimal(),
    body("password").isString().isLength({ min: 8, max: 30 }),
    body("csrfToken").isString().isLength({ min: 16, max: 128 }),
  ],
  authController.activateInvitedAccount,
);

// Logout
router.post("/logout", authController.logout);

// technician location update (device reports its coordinates)
router.post("/technician/location", auth.authenticate, require("../controllers/technicianLocationController").updateLocation);

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

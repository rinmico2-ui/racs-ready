const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const secureAuth = require("../controllers/secureAuthController");

router.post(
  "/login",
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
    body("password")
      .isString()
      .isLength({ min: 1, max: 128 })
      .withMessage("Invalid password"),
    body("mathCaptcha")
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 3 })
      .withMessage("Invalid captcha"),
    body("mathAnswer")
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 3 })
      .withMessage("Invalid captcha answer"),
    body("csrfToken")
      .isString()
      .withMessage("Invalid CSRF token"),
  ],
  secureAuth.login,
);

router.post("/logout", secureAuth.logout);

module.exports = router;

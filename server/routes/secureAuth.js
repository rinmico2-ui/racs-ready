const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const secureAuth = require("../controllers/secureAuthController");

router.post(
  "/login",
  [
    body("email")
      .isLength({ max: 50 })
      .trim()
      .matches(/^[A-Za-z0-9]+@[A-Za-z0-9]+\.[A-Za-z0-9]+$/)
      .withMessage("Invalid email format"),
    body("password")
      .isLength({ min: 8, max: 20 })
      .matches(
        /^(?=(?:.*[A-Z]){1})(?!.*[A-Z].*[A-Z])(?!.*!.*!)(?!.*@.*@)(?!.*#.*#)(?!.*\$.*\$)[A-Za-z0-9@!#$]+$/,
      )
      .withMessage(
        "Password must be 8–20 chars, include exactly one uppercase, and each of !,@,#,$ may appear at most once",
      ),
    body("mathCaptcha")
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 2 })
      .withMessage("Invalid captcha"),
    body("mathAnswer")
      .matches(/^\d+$/)
      .isLength({ min: 1, max: 2 })
      .withMessage("Invalid captcha answer"),
    body("csrfToken")
      .isString()
      .withMessage("Invalid CSRF token"),
  ],
  secureAuth.login,
);

router.post("/logout", secureAuth.logout);

module.exports = router;

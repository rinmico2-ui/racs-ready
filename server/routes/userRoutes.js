const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const auth = require("../middleware/authenticate");
const User = require("../models/User");
const audit = require("../utils/audit");
const trustedDevices = require("../utils/trustedDevices");

const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many password attempts. Please try again in 15 minutes." },
});

function cleanText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function isValidName(value) {
  return value.length >= 1 && value.length <= 50 && /^[A-Za-z\u00C0-\u024F\u1E00-\u1EFF.' -]+$/u.test(value);
}

function isValidPassword(value) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 30 &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9]/.test(value)
  );
}

router.use(auth.authenticate);

// Update the signed-in user's editable personal details.
router.patch("/me/profile", async (req, res, next) => {
  try {
    const firstName = cleanText(req.body && req.body.firstName);
    const lastName = cleanText(req.body && req.body.lastName);
    const phone = cleanText(req.body && req.body.phone);

    if (!isValidName(firstName) || !isValidName(lastName)) {
      return res.status(400).json({
        error: "First and last names must be 1-50 characters and contain letters only.",
      });
    }
    if (!/^\d{7,15}$/.test(phone)) {
      return res.status(400).json({ error: "Phone number must contain 7-15 digits." });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const before = {
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
    };
    user.firstName = firstName;
    user.lastName = lastName;
    user.phone = phone;
    await user.save();

    await audit.logEvent({
      actor: user._id,
      target: user._id,
      action: "auth.profile_updated",
      module: "profile",
      req,
      entityType: "User",
      entityId: user._id,
      details: {
        before,
        after: { firstName: user.firstName, lastName: user.lastName, phone: user.phone },
      },
    });

    return res.json({
      message: "Profile updated successfully.",
      user: {
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        email: user.email,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Change the signed-in user's password after verifying the existing password.
// All sessions are revoked after a successful change.
router.patch("/me/password", passwordChangeLimiter, async (req, res, next) => {
  try {
    const currentPassword = req.body && req.body.currentPassword;
    const newPassword = req.body && req.body.newPassword;

    if (typeof currentPassword !== "string" || currentPassword.length < 1 || currentPassword.length > 128) {
      return res.status(400).json({ error: "Enter your current password." });
    }
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({
        error: "New password must be 8-30 characters and include uppercase, lowercase, number, and special characters.",
      });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: "New password must be different from the current password." });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const matches = await user.comparePassword(currentPassword);
    if (!matches) {
      await audit.logEvent({
        actor: user._id,
        target: user._id,
        action: "auth.password_change_failed",
        module: "auth",
        req,
        entityType: "User",
        entityId: user._id,
        outcome: "failure",
        riskLevel: "medium",
        details: { reason: "incorrect_current_password" },
      });
      return res.status(400).json({ error: "Current password is incorrect." });
    }

    await user.setPassword(newPassword);
    user.currentSessionId = undefined;
    await user.save();
    try {
      await trustedDevices.revokeAll(res, user._id);
    } catch (deviceError) {
      // Token validation also compares lastPasswordChange, so devices remain
      // unusable even if this cleanup query is temporarily unavailable.
      console.warn("trusted-device cleanup failed", deviceError && deviceError.message);
    }

    await audit.logEvent({
      actor: user._id,
      target: user._id,
      action: "auth.password_changed",
      module: "auth",
      req,
      entityType: "User",
      entityId: user._id,
      riskLevel: "high",
      details: { sessionsRevoked: true },
    });

    if (req.session && typeof req.session.destroy === "function") {
      await new Promise((resolve) => req.session.destroy(() => resolve()));
    }
    res.clearCookie("auth_token", { path: "/" });
    res.clearCookie("sid", { path: "/" });
    res.clearCookie("connect.sid", { path: "/" });
    return res.json({
      message: "Password changed successfully. Please sign in again.",
      requiresLogin: true,
    });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/me/trusted-devices",
  auth.requireRole("technician"),
  async (req, res, next) => {
    try {
      const devices = await trustedDevices.list(req, req.user);
      return res.json({ devices });
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  "/me/trusted-devices/:deviceId",
  auth.requireRole("technician"),
  async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.deviceId)) {
        return res.status(400).json({ error: "Invalid trusted device." });
      }
      const revoked = await trustedDevices.revoke(
        req,
        res,
        req.user,
        req.params.deviceId,
      );
      if (!revoked) {
        return res.status(404).json({ error: "Trusted device not found." });
      }

      await audit.logEvent({
        actor: req.user._id,
        target: req.user._id,
        action: "auth.trusted_device_revoked",
        module: "auth",
        req,
        entityType: "TrustedDevice",
        entityId: req.params.deviceId,
        details: {},
      });
      return res.json({ message: "Trusted device revoked." });
    } catch (err) {
      next(err);
    }
  },
);

// Get users - supports optional email query for existence check
router.get("/", auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    if (req.query.email) {
      res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
      const normalizedEmail = req.query.email.toLowerCase().trim();
      const customer = await User.findOne({
        email: normalizedEmail,
        $or: [
          { role: "customer" },
          { role: { $regex: /^customer$/i } },
          { role: { $exists: false } },
          { role: null },
        ],
      })
        .select("_id email firstName lastName phone address role isActive")
        .lean();
      if (customer) {
        customer.role = "customer";
        return res.json({ user: customer, emailAvailable: false, isCustomer: true });
      }
      const accountExists = await User.exists({ email: normalizedEmail });
      if (accountExists) {
        return res.json({ user: null, emailAvailable: false });
      }
      return res.json({ user: null, emailAvailable: true, isCustomer: false });
    }
    // otherwise return limited list or placeholder
    const users = await User.find({})
      .select("_id email firstName lastName name phone address role active blocked vip createdAt lastLogin")
      .limit(200)
      .lean();
    res.json({ users });
  } catch (err) {
    console.error("user list error", err);
    res.status(500).json({ error: "failed to load users" });
  }
});

// Get single user (requires authentication)
router.get("/:id", async (req, res) => {
  try {
    const isSelf = String(req.user._id) === String(req.params.id);
    const isStaff = ["admin", "secretary"].includes(req.user.role);
    if (!isSelf && !isStaff) return res.status(403).json({ error: "Forbidden" });

    const u = await User.findById(req.params.id)
      .select("_id email firstName lastName name phone address role active blocked vip createdAt lastLogin")
      .lean();
    if (!u) return res.status(404).json({ error: "User not found" });
    // sanitize via model toJSON helper
    const obj = new User(u);
    return res.json(obj.toJSON());
  } catch (err) {
    console.error("user fetch error", err);
    return res.status(500).json({ error: "failed to load user" });
  }
});

// Create user
router.post("/", auth.requireRole("admin"), (req, res) => {
  res.status(501).json({ error: "User creation is not implemented on this endpoint" });
});

// Update user
router.put("/:id", auth.requireRole("admin"), (req, res) => {
  res.status(501).json({ error: "User updates are not implemented on this endpoint" });
});

// Delete user
router.delete("/:id", auth.requireRole("admin"), (req, res) => {
  res.status(501).json({ error: "User deletion is not implemented on this endpoint" });
});

module.exports = router;

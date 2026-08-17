const express = require("express");
const router = express.Router();
const auth = require("../middleware/authenticate");

// Get users - supports optional email query for existence check
router.get("/", auth.authenticate, auth.requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const User = require("../models/User");
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
    const users = await User.find({}).limit(200).lean();
    res.json({ users });
  } catch (err) {
    console.error("user list error", err);
    res.status(500).json({ error: "failed to load users" });
  }
});

// Get single user (requires authentication)
router.get("/:id", auth.authenticate, async (req, res) => {
  try {
    const User = require("../models/User");
    const u = await User.findById(req.params.id).lean();
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
router.post("/", (req, res) => {
  res.json({ message: "Create user" });
});

// Update user
router.put("/:id", (req, res) => {
  res.json({ message: "Update user", id: req.params.id });
});

// Delete user
router.delete("/:id", (req, res) => {
  res.json({ message: "Delete user", id: req.params.id });
});

module.exports = router;

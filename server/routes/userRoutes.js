const express = require("express");
const router = express.Router();
const auth = require("../middleware/authenticate");

router.use(auth.authenticate);

// Get users - supports optional email query for existence check
router.get("/", auth.requireRole(["admin", "secretary"]), async (req, res) => {
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
    const User = require("../models/User");
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

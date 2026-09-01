const mongoose = require("mongoose");
const User = require("../models/User");
const ActivityLog = require("../models/ActivityLog");
const Brand = require("../models/Brand");
const Category = require("../models/Category");
const loginRateLimiter = require("../middleware/loginRateLimiter");
const { escapeRegex } = require("../utils/stringSecurity");
const { normalizeServiceWarrantyPolicy } = require("../utils/serviceWarrantyPolicy");
const { normalizeAuditQuery, csvCell } = require("../utils/auditTrailPolicy");

function sanitizeEmail(e) {
  return String(e || "")
    .trim()
    .replace(/[\$\{\}]/g, "")
    .toLowerCase();
}

function isPoint(obj) {
  if (
    !obj ||
    obj.type !== "Point" ||
    !Array.isArray(obj.coordinates) ||
    obj.coordinates.length !== 2
  )
    return false;
  const lng = Number(obj.coordinates[0]);
  const lat = Number(obj.coordinates[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return true;
}

const audit = require("../utils/audit");

async function logAction(actorId, targetId, action, req, details) {
  try {
    await audit.logEvent({
      actor: actorId,
      target: targetId,
      action,
      module: "admin",
      req,
      details,
    });
  } catch (e) {
    console.warn("ActivityLog error", e && e.message);
  }
}

exports.listCustomers = async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
    const page = Math.max(0, Number(req.query.page) || 0);
    const search = req.query.search ? String(req.query.search).trim() : "";

    const filter = { role: "customer" };
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { firstName: regex },
        { lastName: regex },
        { email: regex },
        { phone: regex },
      ];
    }

    const [customers, total] = await Promise.all([
      User.find(filter)
        .select("-passwordHash -resetPasswordTokenHash -resetPasswordExpires -currentSessionId")
        .sort({ createdAt: -1 })
        .skip(page * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);
    res.json({ customers, total, page, limit });
  } catch (err) {
    next(err);
  }
};

exports.getCustomer = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    const user = await User.findById(id).select(
      "-passwordHash -resetPasswordTokenHash -resetPasswordExpires",
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user });
  } catch (err) {
    next(err);
  }
};

exports.updateCustomer = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    const action = req.body.action;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "User not found" });

    switch (action) {
      case "block":
        user.blocked = true;
        await user.save();
        await logAction(req.user._id, user._id, "customer.block", req, {
          reason: req.body.reason || "",
        });
        return res.json({ message: "Customer blocked" });
      case "unblock":
        user.blocked = false;
        await user.save();
        await logAction(req.user._id, user._id, "customer.unblock", req, {});
        return res.json({ message: "Customer unblocked" });
      case "grant_vip":
        user.vip = true;
        await user.save();
        await logAction(req.user._id, user._id, "customer.grant_vip", req, {});
        return res.json({ message: "VIP granted" });
      case "revoke_vip":
        user.vip = false;
        await user.save();
        await logAction(req.user._id, user._id, "customer.revoke_vip", req, {});
        return res.json({ message: "VIP revoked" });
      case "set_booking_limit":
        const limit = Number(req.body.bookingLimit) || 0;
        user.bookingLimit = limit;
        await user.save();
        await logAction(
          req.user._id,
          user._id,
          "customer.set_booking_limit",
          req,
          { bookingLimit: limit },
        );
        return res.json({ message: "Booking limit set", bookingLimit: limit });
      case "reset_lock": {
        // clear rate limiter entry for this user's email
        loginRateLimiter.reset("email", user.email);
        await logAction(req.user._id, user._id, "customer.reset_lock", req, {});
        return res.json({ message: "Login lock cleared" });
      }
      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    next(err);
  }
};

exports.getCustomerViolations = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    const user = await User.findById(id).select("violations");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ violations: user.violations || [] });
  } catch (err) {
    next(err);
  }
};

exports.getCustomerBookingHistory = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    // Attempt to load Appointment model if available
    try {
      const Appointment = require("../models/Appointment");
      const bookings = await Appointment.find({ customer: id })
        .sort({ createdAt: -1 })
        .limit(200);
      return res.json({ bookings });
    } catch (e) {
      // If no Appointment model, return empty with helpful message
      return res.json({
        bookings: [],
        message: "No Appointment model available in this deployment.",
      });
    }
  } catch (err) {
    next(err);
  }
};

// Staff management
exports.listStaff = async (req, res, next) => {
  try {
    // 1) fetch Users that are staff (admin/secretary/technician)
    // only include real staff (secretaries and technicians), admins should not be listed here
    const users = await User.find({
      role: { $in: ["secretary", "technician"] },
    })
      .select("-passwordHash -resetPasswordTokenHash -resetPasswordExpires -currentSessionId")
      .lean();

    // 2) load Technician docs and Secretary metadata so we can merge / enrich Users
    const Technician = require("../models/Technician");
    const Secretary = require("../models/Secretary");

    const [techs, secs] = await Promise.all([
      Technician.find({}).lean(),
      Secretary.find({}).lean(),
    ]);

    const techByUser = new Map();
    const techById = new Map();
    techs.forEach((t) => {
      if (t.user) techByUser.set(String(t.user), t);
      techById.set(String(t._id), t);
    });

    const secByUser = new Map();
    secs.forEach((s) => {
      if (s.user) secByUser.set(String(s.user), s);
    });

    // 3) transform users: attach technician/secretary metadata where available
    const transformedUsers = users.map((u) => {
      const out = Object.assign({}, u);
      const uid = String(u._id);
      // attach technician metadata when linked
      if (techByUser.has(uid)) {
        const t = techByUser.get(uid);
        out._tech = true;
        out.technicianId = t._id; // useful for schedule lookups
        out.location = out.location || t.location;
        // `skills` removed from Technician model
      }
      // attach secretary metadata when present
      if (secByUser.has(uid)) {
        const s = secByUser.get(uid);
        out._secretary = true;
        out.secretary = {
          extension: s.extension || "",
          shift: s.shift || "",
          notes: s.notes || "",
        };
      }
      return out;
    });

    // 4) include Technician-only entries (technicians that don't have a User account)
    const techOnly = techs
      .filter((t) => !t.user)
      .map((t) => ({
        _id: t._id,
        firstName: (t.name || "").split(" ")[0] || "",
        lastName: (t.name || "").split(" ").slice(1).join(" ") || "",
        role: "technician",
        active: typeof t.active === "boolean" ? t.active : true,
        // skills removed from model
        _tech: true,
      }));

    // 5) combine and return (prefer user records)
    const combined = [];
    const seen = new Set();
    transformedUsers.forEach((u) => {
      seen.add(String(u._id));
      combined.push(u);
    });
    techOnly.forEach((tu) => {
      if (!seen.has(String(tu._id))) combined.push(tu);
    });

    // compute user-based counts for KPI (exclude tech-only entries)
    const userTechCount = users.filter((u) => u.role === "technician").length;
    const userSecretaryCount = users.filter(
      (u) => u.role === "secretary",
    ).length;
    const userTotalCount = users.length;

    res.json({
      staff: combined,
      userCounts: {
        total: userTotalCount,
        technicians: userTechCount,
        secretaries: userSecretaryCount,
      },
    });
  } catch (err) {
    next(err);
  }
};

exports.createStaff = async (req, res, next) => {
  try {
    let { email, password, role, firstName, lastName, phone, location } =
      req.body;
    email = sanitizeEmail(email);
    // admins should not be created via this interface (they are managed separately)
    if (role === "admin") {
      return res
        .status(400)
        .json({ error: "Cannot create admin via this form" });
    }
    role = ["secretary", "technician"].includes(role) ? role : "secretary";
    // input validation with clearer feedback
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }
    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "Password is required" });
    }
    // enforce the same constraints used in password reset: 8-12 alphanumeric
    if (password.length < 8 || password.length > 12) {
      return res
        .status(400)
        .json({ error: "Password must be 8-12 characters" });
    }
    if (!/^[A-Za-z0-9]+$/.test(password)) {
      return res
        .status(400)
        .json({ error: "Password must contain only letters and numbers" });
    }
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: "User already exists" });

    // create User (staff account)
    const user = new User({
      email,
      role,
      active: true,
      firstName: firstName || "",
      lastName: lastName || "",
      phone: phone || "",
    });
    await user.setPassword(password);
    await user.save();

    // if technician (or admin-as-technician), also create a Technician document and link where appropriate
    let techDoc = null;

    // if secretary, create a lightweight secretary profile so metadata can be stored later
    if (role === "secretary") {
      try {
        const Secretary = require("../models/Secretary");
        const secPayload = {
          user: user._id,
          phone: user.phone || undefined,
          extension: "",
          shift: "",
          notes: "",
        };
        const secDoc = new Secretary(secPayload);
        await secDoc.save();
      } catch (e) {
        // failure to create secretary metadata shouldn't block user creation
        console.warn("unable to create secretary profile", e && e.message);
      }
    }

    if (role === "technician" || role === "admin") {
      const Technician = require("../models/Technician");
      const tName =
        `${(firstName || "").trim()} ${(lastName || "").trim()}`.trim() ||
        email;
      const techPayload = {
        user: user._id,
        userEmail: user.email,
        phone: user.phone || undefined,
        name: tName,
        active: true,
      };
      // Accept either a simple address string (locationText) or a GeoJSON Point for `location`
      if (typeof location === "string" && location.trim()) {
        techPayload.locationText = String(location).trim();
      } else if (location) {
        // validate GeoJSON Point
        if (!isPoint(location))
          return res.status(400).json({ error: "invalid location" });
        techPayload.location = {
          type: "Point",
          coordinates: [
            Number(location.coordinates[0]),
            Number(location.coordinates[1]),
          ],
        };
      }

      techDoc = new Technician(techPayload);
      await techDoc.save();

      // mark the user as technician (already set in role) and add reference in meta
      user.meta = user.meta || {};
      user.meta.technicianId = techDoc._id;
      await user.save();
    }

    await logAction(req.user._id, user._id, "staff.create", req, {
      role,
      technicianId: techDoc?._id,
    });
    res.status(201).json({
      message: "Staff created",
      user: { id: user._id, email: user.email, role: user.role },
      technician: techDoc,
    });
  } catch (err) {
    next(err);
  }
};

exports.getStaff = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    const user = await User.findById(id)
      .select("-passwordHash -resetPasswordTokenHash -resetPasswordExpires -currentSessionId")
      .lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ staff: user });
  } catch (err) {
    next(err);
  }
};

exports.editStaff = async (req, res, next) => {
  try {
    const id = req.params.id;
    console.log("editStaff called with id:", id);
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    const { role, active, firstName, lastName, email, phone } = req.body;
    const update = {};
    if (role && ["admin", "secretary", "technician"].includes(role)) update.role = role;
    if (typeof active === "boolean") update.active = active;
    if (firstName !== undefined) update.firstName = firstName;
    if (lastName !== undefined) update.lastName = lastName;
    if (email !== undefined) update.email = email;
    if (phone !== undefined && phone !== "") update.phone = phone;
    if (Object.keys(update).length === 0)
      return res.status(400).json({ error: "No fields to update" });
    console.log("editStaff update payload:", JSON.stringify(update));
    const result = await User.updateOne({ _id: id }, { $set: update });
    console.log("editStaff result:", JSON.stringify(result));
    if (result.matchedCount === 0)
      return res.status(404).json({ error: "User not found" });

    // Sync linked Technician document if this user is a technician
    const user = await User.findById(id).select("role meta").lean();
    if (user) {
      const fullName = ((firstName || "") + " " + (lastName || "")).trim();
      if (user.role === "technician") {
        const Technician = require("../models/Technician");
        const techUpdate = {};
        if (fullName) techUpdate.name = fullName;
        if (email !== undefined) techUpdate.userEmail = email;
        if (phone !== undefined && phone !== "") techUpdate.phone = phone;
        if (typeof active === "boolean") techUpdate.active = active;
        if (Object.keys(techUpdate).length > 0) {
          const techResult = await Technician.updateOne(
            { user: user._id },
            { $set: techUpdate }
          );
          console.log("editStaff Technician sync result:", JSON.stringify(techResult));
        }
      } else if (user.role === "secretary") {
        const Secretary = require("../models/Secretary");
        const secUpdate = {};
        if (phone !== undefined && phone !== "") secUpdate.phone = phone;
        if (Object.keys(secUpdate).length > 0) {
          const secResult = await Secretary.updateOne(
            { user: user._id },
            { $set: secUpdate }
          );
          console.log("editStaff Secretary sync result:", JSON.stringify(secResult));
        }
      }
    }

    await logAction(req.user._id, id, "staff.edit", req, update);
    res.json({ message: "Staff updated", modified: result.modifiedCount });
  } catch (err) {
    console.error("editStaff error:", err);
    if (err.code === 11000) {
      return res.status(409).json({ error: "Email already in use" });
    }
    next(err);
  }
};

exports.resetStaffPassword = async (req, res, next) => {
  try {
    const id = req.params.id;
    const { newPassword } = req.body;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    if (!newPassword || newPassword.length < 8 || newPassword.length > 20)
      return res.status(400).json({ error: "Invalid password" });
    if (!/^[A-Za-z0-9]+$/.test(newPassword))
      return res.status(400).json({ error: "Invalid password" });
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "User not found" });
    await user.setPassword(newPassword);
    await user.save();
    await logAction(req.user._id, user._id, "staff.reset_password", req, {});
    res.json({ message: "Password reset" });
  } catch (err) {
    next(err);
  }
};

exports.viewStaffActivityLogs = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    const logs = await ActivityLog.find({
      $or: [{ actor: id }, { target: id }],
    })
      .sort({ createdAt: -1 })
      .limit(200);
    res.json({ logs });
  } catch (err) {
    next(err);
  }
};

// General activity logs (admin UI)
exports.listLogs = async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 200);
    const logs = await ActivityLog.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("actor", "email")
      .populate("target", "email")
      .lean();
    const out = logs.map((l) => ({
      _id: l._id,
      actor: l.actor ? l.actor._id : null,
      actorEmail: l.actor ? l.actor.email : null,
      target: l.target ? l.target._id : null,
      targetEmail: l.target ? l.target.email : null,
      action: l.action,
      details: l.details || {},
      ip: l.ip || "",
      createdAt: l.createdAt,
    }));
    res.json({ logs: out });
  } catch (err) {
    next(err);
  }
};

// Enterprise audit trail — aggregate stats for KPI cards + category chips
exports.auditStats = async (req, res, next) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 6);
    weekAgo.setHours(0, 0, 0, 0);

    const securityWindow = new Date(now);
    securityWindow.setDate(securityWindow.getDate() - 6);
    securityWindow.setHours(0, 0, 0, 0);

    const [total, today, reviewToday, securityEvents, byCategory, byRisk, byOutcome, weekSeries] = await Promise.all([
      ActivityLog.countDocuments({}),
      ActivityLog.countDocuments({ createdAt: { $gte: startOfDay } }),
      ActivityLog.countDocuments({
        createdAt: { $gte: startOfDay },
        $or: [
          { riskLevel: { $in: ["high", "critical"] } },
          { outcome: { $in: ["failure", "blocked"] } },
        ],
      }),
      ActivityLog.countDocuments({ category: "auth", createdAt: { $gte: securityWindow } }),
      ActivityLog.aggregate([
        { $group: { _id: "$category", count: { $sum: 1 } } },
      ]),
      ActivityLog.aggregate([
        { $group: { _id: "$riskLevel", count: { $sum: 1 } } },
      ]),
      ActivityLog.aggregate([
        { $group: { _id: "$outcome", count: { $sum: 1 } } },
      ]),
      ActivityLog.aggregate([
        { $match: { createdAt: { $gte: weekAgo } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const catMap = byCategory.reduce((o, x) => {
      o[x._id || "system"] = x.count;
      return o;
    }, {});
    const riskMap = byRisk.reduce((o, x) => {
      o[x._id || "info"] = x.count;
      return o;
    }, {});
    const outcomeMap = byOutcome.reduce((o, x) => {
      o[x._id || "unknown"] = x.count;
      return o;
    }, {});

    res.json({
      total,
      today,
      reviewToday,
      securityEvents,
      byCategory: catMap,
      byRisk: riskMap,
      byOutcome: outcomeMap,
      weekSeries,
    });
  } catch (err) {
    next(err);
  }
};

// Enterprise audit trail — filterable, categorized, paginated, CSV-exportable
exports.listAuditTrail = async (req, res, next) => {
  try {
    const { query, page, limit, sort } = normalizeAuditQuery(req.query);

    const total = await ActivityLog.countDocuments(query);
    const isCsvExport = req.query.format === "csv";
    const itemQuery = ActivityLog.find(query)
      .sort(sort)
      .populate("actor", "email firstName lastName name role")
      .populate("target", "email firstName lastName name role");
    if (isCsvExport) itemQuery.limit(10000);
    else itemQuery.skip((page - 1) * limit).limit(limit);
    const items = await itemQuery.lean();

    const mapped = items.map((l) => ({
      _id: l._id,
      action: l.action,
      category: l.category || "system",
      entityType: l.entityType || "",
      entityId: l.entityId || null,
      actionType: l.actionType || "action",
      module: l.module || (l.details && l.details.module) || "",
      actor: l.actor ? l.actor._id : (l.actor || null),
      actorEmail: l.actor && l.actor.email ? l.actor.email : (l.actorName || ""),
      actorName:
        l.actorName ||
        (l.actor && l.actor.name) ||
        (l.actor && l.actor.firstName && l.actor.lastName ? `${l.actor.firstName} ${l.actor.lastName}` : "") ||
        "System",
      actorRole: l.actorRole || (l.actor && l.actor.role) || "",
      target: l.target ? l.target._id : (l.target || null),
      targetName:
        (l.target && l.target.name) ||
        (l.target && l.target.firstName && l.target.lastName ? `${l.target.firstName} ${l.target.lastName}` : "") ||
        "",
      targetEmail: l.target && l.target.email ? l.target.email : "",
      outcome: l.outcome || "unknown",
      riskLevel: l.riskLevel || "info",
      source: l.source || (l.actor ? "authenticated_user" : "system"),
      requestId: l.requestId || "",
      requestMethod: l.requestMethod || "",
      requestPath: l.requestPath || "",
      userAgent: l.userAgent || "",
      ip: l.ip || "",
      details: l.details || {},
      createdAt: l.createdAt,
    }));

    if (isCsvExport) {
      const head = ["Date", "Risk", "Outcome", "Category", "Action", "Type", "Actor", "Role", "Target", "Entity", "Entity ID", "Source", "Method", "Path", "IP", "Request ID", "User Agent", "Details"];
      const csv = [head, ...mapped.map((l) => [
        l.createdAt ? new Date(l.createdAt).toISOString() : "",
        l.riskLevel,
        l.outcome,
        l.category,
        l.action,
        l.actionType,
        l.actorName,
        l.actorRole,
        l.targetName || l.targetEmail,
        l.entityType,
        l.entityId ? l.entityId.toString() : "",
        l.source,
        l.requestMethod,
        l.requestPath,
        l.ip,
        l.requestId,
        l.userAgent,
        JSON.stringify(l.details),
      ])].map((row) => row.map(csvCell).join(",")).join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="audit-trail.csv"');
      if (total > 10000) res.setHeader("X-Audit-Export-Truncated", "true");
      return res.send(csv);
    }

    const [byActionType, byRisk, byOutcome] = await Promise.all([
      ActivityLog.aggregate([
        { $match: query },
        { $group: { _id: "$actionType", count: { $sum: 1 } } },
      ]),
      ActivityLog.aggregate([
        { $match: query },
        { $group: { _id: "$riskLevel", count: { $sum: 1 } } },
      ]),
      ActivityLog.aggregate([
        { $match: query },
        { $group: { _id: "$outcome", count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      items: mapped,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      aggregates: {
        byActionType: byActionType.reduce((o, x) => {
          o[x._id || "action"] = x.count;
          return o;
        }, {}),
        byRisk: byRisk.reduce((o, x) => {
          o[x._id || "info"] = x.count;
          return o;
        }, {}),
        byOutcome: byOutcome.reduce((o, x) => {
          o[x._id || "unknown"] = x.count;
          return o;
        }, {}),
      },
    });
  } catch (err) {
    next(err);
  }
};

// Analytics summary used by admin dashboard (returns operational metrics)
exports.analyticsSummary = async (req, res, next) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    // Default values
    let data = {
      // KPIs
      totalBookingsToday: 0,
      totalBookingsAllTime: 0,
      pendingReview: 0,
      awaitingAssignment: 0,
      activeServices: 0,
      completedToday: 0,
      revenueToday: 0,
      revenueCurrency: "PHP",

      // Technician
      totalTechnicians: 0,
      availableTechnicians: 0,
      busyTechnicians: 0,
      absentTechnicians: 0,

      // Pipeline
      pipeline: {
        pending: 0,
        confirmed: 0,
        scheduled: 0,
        onTheWay: 0,
        arrived: 0,
        inProgress: 0,
        completed: 0,
        cancelled: 0,
        active: 0,
        awaitingAssignment: 0,
        assigned: 0,
      },

      // Schedule for today
      todaySchedule: [],

      // Revenue
      monthlyRevenue: 0,
      pendingPayments: 0,

      // 7-day trend
      trend7: [],

      // Service distribution
      serviceDistribution: [],

      // Notifications
      notifications: [],

      // Low stock
      lowStockCount: 0,
      lowStockItems: [],

      // ── Enterprise Summary Fields ──
      // Customers
      totalCustomers: 0,
      newCustomersThisMonth: 0,
      vipCustomers: 0,

      // Financial
      monthlyExpenses: 0,
      profitMargin: 0,
      lastMonthRevenue: 0,
      revenueTrend7: [],
      expensesByType: [],

      // Ratings
      avgRating: 0,
      totalRatings: 0,
      ratingDistribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },

      // Projects
      totalProjects: 0,
      activeProjects: 0,
      completedProjects: 0,

      // Bookings lifetime
      totalBookingsAllTime: 0,
      completionRate: 0,

      // Expenses pending approval
      pendingExpenses: 0,
      pendingExpensesTotal: 0,
    };

    // ── BookingService data ──
    try {
      const BookingService = require("../models/BookingService");

      // Total bookings today (by bookingDate OR createdAt)
      data.totalBookingsToday = await BookingService.countDocuments({
        $or: [
          { bookingDate: { $gte: startOfDay, $lte: endOfDay } },
          { createdAt: { $gte: startOfDay, $lte: endOfDay } }
        ],
      });

      // Total all-time bookings count
      data.totalBookingsAllTime = await BookingService.countDocuments();

      // Pipeline counts (all statuses) — single aggregation for efficiency
      var pipelineRaw = await BookingService.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]);
      var pipeMap = {};
      pipelineRaw.forEach(function (p) { pipeMap[p._id] = p.count; });
      console.log('[DEBUG] Pipeline:', JSON.stringify(pipeMap), 'TotalBookingsToday:', data.totalBookingsToday);

      // Active statuses: anything that isn't completed, cancelled, closed, no-show, rejected
      var activeStatuses = [
        "pending", "confirmed", "scheduled", "on-the-way", "arrived", "in-progress",
        "awaiting_assignment", "assigned", "pending_reassignment",
        "repair_requested", "pending_inspection", "inspection_scheduled",
        "inspection_in_progress", "inspection_completed", "awaiting_approval",
        "repair_approved", "waiting_parts", "parts_reserved", "ready_for_repair",
        "repair_scheduled", "repair_in_progress", "payment_verified",
        "under_warranty", "warranty_claim", "re-scheduled"
      ];

      // Compute pipeline totals from pipeMap
      var totalActive = 0;
      activeStatuses.forEach(function (s) { totalActive += pipeMap[s] || 0; });
      data.pipeline.active = totalActive;
      data.pipeline.pending = (pipeMap.pending || 0) + (pipeMap.payment_verified || 0);
      data.pipeline.confirmed = (pipeMap.confirmed || 0) + (pipeMap.scheduled || 0);
      data.pipeline.onTheWay = pipeMap["on-the-way"] || 0;
      data.pipeline.arrived = pipeMap.arrived || 0;
      data.pipeline.inProgress = (pipeMap["in-progress"] || 0) + (pipeMap.repair_in_progress || 0) + (pipeMap.inspection_in_progress || 0);
      data.pipeline.completed = pipeMap.completed || 0;
      data.pipeline.cancelled = (pipeMap.cancelled || 0) + (pipeMap.rejected || 0) + (pipeMap["no-show"] || 0);
      data.pipeline.awaitingAssignment = (pipeMap.awaiting_assignment || 0) + (pipeMap.pending_reassignment || 0);
      data.pipeline.assigned = pipeMap.assigned || 0;

      // Pending Review = paymentStatus "pending" or "partial"
      data.pendingReview = await BookingService.countDocuments({
        paymentStatus: { $in: ["pending", "partial"] },
      }).catch(function () { return 0; });

      // Awaiting Assignment = awaiting_assignment status OR confirmed with no technician
      data.awaitingAssignment = (pipeMap.awaiting_assignment || 0) + (pipeMap.pending_reassignment || 0);
      var awaitConfirmedNoTech = await BookingService.countDocuments({
        status: "confirmed",
        technicianId: { $in: [null, undefined] },
      }).catch(function () { return 0; });
      data.awaitingAssignment += awaitConfirmedNoTech;

      // Active Services = all statuses that mean work is in progress
      data.activeServices = data.pipeline.onTheWay + data.pipeline.arrived + data.pipeline.inProgress
        + data.pipeline.assigned + data.pipeline.awaitingAssignment;

      data.completedToday = await BookingService.countDocuments({
        status: "completed",
        $or: [
          { bookingDate: { $gte: startOfDay, $lte: endOfDay } },
          { createdAt: { $gte: startOfDay, $lte: endOfDay } }
        ],
      });

      // Today's schedule (upcoming, sorted)
      var scheduleItems = await BookingService.find({
        $or: [
          { bookingDate: { $gte: startOfDay, $lte: endOfDay } },
          { createdAt: { $gte: startOfDay, $lte: endOfDay } }
        ],
        status: { $nin: ["cancelled", "completed", "closed", "no-show", "rejected"] },
      })
        .sort({ startTime: 1 })
        .limit(10)
        .populate("customerId", "firstName lastName")
        .populate("technicianId", "name firstName lastName")
        .lean();

      data.todaySchedule = scheduleItems.map(function (b) {
        var techName = "";
        if (b.technician && b.technician.name) techName = b.technician.name;
        else if (b.technicianId) techName = ((b.technicianId.firstName || "") + " " + (b.technicianId.lastName || "")).trim();
        return {
          _id: b._id,
          time: b.startTime || "",
          service: b.serviceType || (b.service && b.service.name) || "Service",
          customer: b.customer && b.customer.name
            ? b.customer.name
            : (b.customerId ? ((b.customerId.firstName || "") + " " + (b.customerId.lastName || "")).trim() : "Customer"),
          technician: techName || "Unassigned",
          status: b.status,
        };
      });

      // 7-day booking trend
      var trendData = [];
      for (var i = 6; i >= 0; i--) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        d.setHours(0, 0, 0, 0);
        var dEnd = new Date(d);
        dEnd.setHours(23, 59, 59, 999);
        var cnt = await BookingService.countDocuments({
          $or: [
            { bookingDate: { $gte: d, $lte: dEnd } },
            { createdAt: { $gte: d, $lte: dEnd } }
          ],
        }).catch(function () { return 0; });
        var dayLabel = d.toLocaleDateString("en", { weekday: "short" });
        trendData.push({ date: dayLabel, count: cnt });
      }
      data.trend7 = trendData;

      // Service distribution
      var serviceAgg = await BookingService.aggregate([
        { $group: { _id: "$serviceType", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).catch(function () { return []; });
      data.serviceDistribution = (serviceAgg || []).map(function (s) {
        return { name: s._id || "Other", count: s.count };
      });

      // Notifications
      var notes = [];
      if (data.awaitingAssignment > 0)
        notes.push({ type: "warning", icon: "bi-person-plus-fill", message: data.awaitingAssignment + " booking" + (data.awaitingAssignment > 1 ? "s" : "") + " awaiting technician assignment" });
      if (data.pendingReview > 0)
        notes.push({ type: "warning", icon: "bi-clock-history", message: data.pendingReview + " booking" + (data.pendingReview > 1 ? "s" : "") + " pending payment review" });
      if (data.pipeline.cancelled > 0)
        notes.push({ type: "danger", icon: "bi-x-circle-fill", message: data.pipeline.cancelled + " booking" + (data.pipeline.cancelled > 1 ? "s" : "") + " cancelled" });

      data.notifications = notes;

    } catch (e) {
      console.error('[analyticsSummary] BookingService error:', e.message);
      // fallback: try ActivityLog
      try {
        var ActivityLog = require("../models/ActivityLog");
        var logsToday = await ActivityLog.find({
          action: /appointment/i,
          createdAt: { $gte: startOfDay, $lte: endOfDay },
        }).lean();
        data.totalBookingsToday = logsToday.length;
        data.completedToday = logsToday.filter(function (l) { return /complete|completed/i.test(l.action); }).length;
      } catch (xx) {}
    }

    // ── Technician data ──
    try {
      var Technician = require("../models/Technician");
      var { resolveAvailabilityBulk } = require("../utils/availability");
      var techs = await Technician.find({}).lean();
      data.totalTechnicians = techs.length;

      // Compute effective availability for all technicians
      var resolvedStatuses = await resolveAvailabilityBulk(techs);

      data.availableTechnicians = 0;
      data.busyTechnicians = 0;
      data.absentTechnicians = 0;

      techs.forEach(function (t) {
        var st = resolvedStatuses.get(String(t._id)) || t.availabilityStatus || "Offline";
        if (st === "Available") data.availableTechnicians++;
        else if (["Assigned", "On The Way", "In Progress"].indexOf(st) >= 0) data.busyTechnicians++;
        else data.absentTechnicians++;
      });
    } catch (e) {
      data.totalTechnicians = 0;
    }

    // ── Revenue data (all sources: services, POS, orders) ──
    var revenueSnapshot = null;
    try {
      var { buildRevenueDashboardSnapshot } = require("../utils/revenueAnalytics");
      revenueSnapshot = await buildRevenueDashboardSnapshot(new Date());
    } catch (revenueError) {
      console.error("[analyticsSummary] Enterprise revenue snapshot error:", revenueError.message);
    }

    if (!revenueSnapshot) try {
      var Payment = require("../models/Payment");
      var BookingService = require("../models/BookingService");
      var WalkInSale = require("../models/WalkInSale");
      var Order = require("../models/Order");
      var paidStatuses = ["paid", "payment_collected", "waiting_for_remittance", "remitted", "verified"];
      var allCompletedBookingStatuses = [
        "completed", "repair_completed", "under_warranty", "warranty_claim"
      ];

      // Helper: build date range filter for a given date field
      function dateRange(fieldName, start, end) {
        var f = {};
        f[fieldName] = { $gte: start, $lte: end };
        return f;
      }

      // ── Today's Revenue ──
      // 1) Payments (service payments)
      var todayPaymentAgg = await Payment.aggregate([
        { $match: { submittedAt: { $gte: startOfDay, $lte: endOfDay }, status: { $in: paidStatuses } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      var todayPayments = (todayPaymentAgg && todayPaymentAgg[0]) ? todayPaymentAgg[0].total : 0;

      // 2) Booking services (completed today, totalPrice)
      var todayBookingsAgg = await BookingService.aggregate([
        { $match: { status: { $in: allCompletedBookingStatuses }, ...dateRange("bookingDate", startOfDay, endOfDay) } },
        { $group: { _id: null, total: { $sum: "$totalPrice" } } },
      ]);
      var todayBookings = (todayBookingsAgg && todayBookingsAgg[0]) ? todayBookingsAgg[0].total : 0;

      // 3) Walk-in POS sales (completed today)
      var todayPosAgg = await WalkInSale.aggregate([
        { $match: { status: "completed", ...dateRange("completedAt", startOfDay, endOfDay) } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]);
      var todayPos = (todayPosAgg && todayPosAgg[0]) ? todayPosAgg[0].total : 0;

      // 4) Product orders (completed today)
      var todayOrdersAgg = await Order.aggregate([
        { $match: { status: "completed", ...dateRange("updatedAt", startOfDay, endOfDay) } },
        { $group: { _id: null, total: { $sum: "$total" } } },
      ]);
      var todayOrders = (todayOrdersAgg && todayOrdersAgg[0]) ? todayOrdersAgg[0].total : 0;

      data.revenueToday = todayPayments + todayBookings + todayPos + todayOrders;
      data.revenueBreakdown = {
        services: todayPayments + todayBookings,
        pos: todayPos,
        orders: todayOrders,
      };

      // ── Monthly Revenue ──
      var monthPaymentAgg = await Payment.aggregate([
        { $match: { submittedAt: { $gte: startOfMonth, $lte: endOfDay }, status: { $in: paidStatuses } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      var monthPayments = (monthPaymentAgg && monthPaymentAgg[0]) ? monthPaymentAgg[0].total : 0;

      var monthBookingsAgg = await BookingService.aggregate([
        { $match: { status: { $in: allCompletedBookingStatuses }, ...dateRange("bookingDate", startOfMonth, endOfDay) } },
        { $group: { _id: null, total: { $sum: "$totalPrice" } } },
      ]);
      var monthBookings = (monthBookingsAgg && monthBookingsAgg[0]) ? monthBookingsAgg[0].total : 0;

      var monthPosAgg = await WalkInSale.aggregate([
        { $match: { status: "completed", ...dateRange("completedAt", startOfMonth, endOfDay) } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]);
      var monthPos = (monthPosAgg && monthPosAgg[0]) ? monthPosAgg[0].total : 0;

      var monthOrdersAgg = await Order.aggregate([
        { $match: { status: "completed", ...dateRange("updatedAt", startOfMonth, endOfDay) } },
        { $group: { _id: null, total: { $sum: "$total" } } },
      ]);
      var monthOrders = (monthOrdersAgg && monthOrdersAgg[0]) ? monthOrdersAgg[0].total : 0;

      data.monthlyRevenue = monthPayments + monthBookings + monthPos + monthOrders;

      // ── Pending payments ──
      var pendingAgg = await Payment.aggregate([
        { $match: { status: { $in: ["pending", "partial"] } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      data.pendingPayments = (pendingAgg && pendingAgg[0]) ? pendingAgg[0].total : 0;

    } catch (e) {
      data.revenueToday = 0;
      data.monthlyRevenue = 0;
      data.pendingPayments = 0;
      data.revenueBreakdown = { services: 0, pos: 0, orders: 0 };
    }

    // ── Low stock ──
    try {
      var Inventory = require("../models/Inventory");
      var low = await Inventory.find({ active: true, quantity: { $lte: 5 } }).limit(10).lean();
      data.lowStockItems = low;
      data.lowStockCount = low.length;
    } catch (e) {
      data.lowStockCount = 0;
      data.lowStockItems = [];
    }

    // ── HVAC Product Inventory Stats (aircons) ──
    try {
      var HVACProduct = require("../models/HVACProduct");
      var hvacDocs = await HVACProduct.find({ active: true })
        .populate("brand", "name")
        .lean();

      var allVariants = [];
      hvacDocs.forEach(function(doc) {
        (doc.variants || []).forEach(function(v) {
          if (v.active !== false) {
            allVariants.push({
              _id: v._id,
              productId: doc._id,
              modelLine: doc.modelLine,
              brandName: doc.brand && doc.brand.name ? doc.brand.name : '',
              type: doc.type,
              inverter: doc.inverter || false,
              imageUrl: doc.imageUrl || '/images/products/default.png',
              capacity: v.capacity || '',
              displayLabel: doc.modelLine + ' ' + (v.capacity || '') + 'HP',
              sellingPrice: v.sellingPrice || 0,
              quantity: v.quantity || 0,
              status: v.status || 'out_of_stock',
            });
          }
        });
      });

      data.inventoryStats = {
        totalProducts: allVariants.length,
        totalUnits: allVariants.reduce(function(s, v) { return s + v.quantity; }, 0),
        totalValue: allVariants.reduce(function(s, v) { return s + (v.sellingPrice * v.quantity); }, 0),
        inStock: allVariants.filter(function(v) { return v.status === 'in_stock'; }).length,
        lowStock: allVariants.filter(function(v) { return v.status === 'low_stock'; }).length,
        outOfStock: allVariants.filter(function(v) { return v.status === 'out_of_stock'; }).length,
      };

      allVariants.sort(function(a, b) {
        return (b.sellingPrice * b.quantity) - (a.sellingPrice * a.quantity);
      });
      data.topProducts = allVariants.slice(0, 6);
    } catch (e) {
      data.inventoryStats = { totalProducts: 0, totalUnits: 0, totalValue: 0, inStock: 0, lowStock: 0, outOfStock: 0 };
      data.topProducts = [];
    }

    // ── Enterprise: Customer Data ──
    try {
      var User = require("../models/User");
      data.totalCustomers = await User.countDocuments({ role: "customer" }).catch(() => 0);
      data.newCustomersThisMonth = await User.countDocuments({ role: "customer", createdAt: { $gte: startOfMonth } }).catch(() => 0);
      data.vipCustomers = await User.countDocuments({ role: "customer", vip: true }).catch(() => 0);
    } catch (e) {}

    // ── Enterprise: Financial Analytics ──
    try {
      var Expense = require("../models/Expense");
      var Payment = require("../models/Payment");
      var BookingService = require("../models/BookingService");
      var WalkInSale = require("../models/WalkInSale");
      var Order = require("../models/Order");
      var paidStatuses = ["paid", "payment_collected", "waiting_for_remittance", "remitted", "verified"];
      var allCompletedBookingStatuses = [
        "completed", "repair_completed", "under_warranty", "warranty_claim"
      ];

      function dateRange(fieldName, start, end) {
        var f = {};
        f[fieldName] = { $gte: start, $lte: end };
        return f;
      }

      // Monthly approved expenses
      var expAgg = await Expense.aggregate([
        { $match: { status: "approved", expenseDate: { $gte: startOfMonth, $lte: endOfDay } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]).catch(() => []);
      data.monthlyExpenses = (expAgg && expAgg[0]) ? expAgg[0].total : 0;

      // Profit margin
      if (data.monthlyRevenue > 0) {
        data.profitMargin = Math.round(((data.monthlyRevenue - data.monthlyExpenses) / data.monthlyRevenue) * 100);
      }

      // Last month revenue (all sources)
      var lastMonthStart = new Date(startOfMonth);
      lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
      var lastMonthEnd = new Date(startOfMonth);
      lastMonthEnd.setDate(0);
      lastMonthEnd.setHours(23, 59, 59, 999);
      try {
        var lmPayments = await Payment.aggregate([
          { $match: { submittedAt: { $gte: lastMonthStart, $lte: lastMonthEnd }, status: { $in: paidStatuses } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ]);
        var lmBookings = await BookingService.aggregate([
          { $match: { status: { $in: allCompletedBookingStatuses }, ...dateRange("bookingDate", lastMonthStart, lastMonthEnd) } },
          { $group: { _id: null, total: { $sum: "$totalPrice" } } },
        ]);
        var lmPos = await WalkInSale.aggregate([
          { $match: { status: "completed", ...dateRange("completedAt", lastMonthStart, lastMonthEnd) } },
          { $group: { _id: null, total: { $sum: "$totalAmount" } } },
        ]);
        var lmOrders = await Order.aggregate([
          { $match: { status: "completed", ...dateRange("updatedAt", lastMonthStart, lastMonthEnd) } },
          { $group: { _id: null, total: { $sum: "$total" } } },
        ]);
        data.lastMonthRevenue =
          ((lmPayments && lmPayments[0]) ? lmPayments[0].total : 0) +
          ((lmBookings && lmBookings[0]) ? lmBookings[0].total : 0) +
          ((lmPos && lmPos[0]) ? lmPos[0].total : 0) +
          ((lmOrders && lmOrders[0]) ? lmOrders[0].total : 0);
      } catch (e) {}

      // Revenue trend (last 7 days, per day — all sources)
      try {
        var revTrend = [];
        for (var ri = 6; ri >= 0; ri--) {
          var rd = new Date(); rd.setDate(rd.getDate() - ri); rd.setHours(0, 0, 0, 0);
          var rdEnd = new Date(rd); rdEnd.setHours(23, 59, 59, 999);
          var rdRange = { $gte: rd, $lte: rdEnd };

          var rPay = await Payment.aggregate([
            { $match: { submittedAt: rdRange, status: { $in: paidStatuses } } },
            { $group: { _id: null, total: { $sum: "$amount" } } },
          ]).catch(() => []);
          var rBook = await BookingService.aggregate([
            { $match: { status: { $in: allCompletedBookingStatuses }, bookingDate: rdRange } },
            { $group: { _id: null, total: { $sum: "$totalPrice" } } },
          ]).catch(() => []);
          var rPos = await WalkInSale.aggregate([
            { $match: { status: "completed", completedAt: rdRange } },
            { $group: { _id: null, total: { $sum: "$totalAmount" } } },
          ]).catch(() => []);
          var rOrd = await Order.aggregate([
            { $match: { status: "completed", updatedAt: rdRange } },
            { $group: { _id: null, total: { $sum: "$total" } } },
          ]).catch(() => []);

          var revDay =
            ((rPay && rPay[0]) ? rPay[0].total : 0) +
            ((rBook && rBook[0]) ? rBook[0].total : 0) +
            ((rPos && rPos[0]) ? rPos[0].total : 0) +
            ((rOrd && rOrd[0]) ? rOrd[0].total : 0);
          revTrend.push({ date: rd.toLocaleDateString("en", { weekday: "short" }), amount: revDay });
        }
        data.revenueTrend7 = revTrend;
      } catch (e) {}

      // Expenses by type
      try {
        var expTypeAgg = await Expense.aggregate([
          { $match: { status: "approved", expenseDate: { $gte: startOfMonth, $lte: endOfDay } } },
          { $group: { _id: "$type", total: { $sum: "$amount" }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ]);
        data.expensesByType = (expTypeAgg || []).map(e => ({ type: e._id || "other", total: e.total, count: e.count }));
      } catch (e) {}

      // Pending expenses
      var pendExpAgg = await Expense.aggregate([
        { $match: { status: "pending" } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$amount" } } },
      ]).catch(() => []);
      data.pendingExpenses = (pendExpAgg && pendExpAgg[0]) ? pendExpAgg[0].count : 0;
      data.pendingExpensesTotal = (pendExpAgg && pendExpAgg[0]) ? pendExpAgg[0].total : 0;

    } catch (e) {}

    if (revenueSnapshot) {
      try {
        var Expense = require("../models/Expense");
        var [expenseTypes, pendingExpenseRows] = await Promise.all([
          Expense.aggregate([
            { $match: { status: "approved", expenseDate: { $gte: startOfMonth, $lte: endOfDay } } },
            { $group: { _id: "$type", total: { $sum: "$amount" }, count: { $sum: 1 } } },
            { $sort: { total: -1 } },
          ]),
          Expense.aggregate([
            { $match: { status: "pending" } },
            { $group: { _id: null, count: { $sum: 1 }, total: { $sum: "$amount" } } },
          ]),
        ]);
        data.expensesByType = expenseTypes.map(function (row) {
          return { type: row._id || "other", total: row.total, count: row.count };
        });
        data.pendingExpenses = pendingExpenseRows[0] ? pendingExpenseRows[0].count : 0;
        data.pendingExpensesTotal = pendingExpenseRows[0] ? pendingExpenseRows[0].total : 0;
      } catch (expenseError) {
        console.error("[analyticsSummary] Expense snapshot error:", expenseError.message);
      }
      Object.assign(data, revenueSnapshot, { revenueCurrency: "PHP" });
    }

    // ── Enterprise: Customer Ratings ──
    try {
      var Rating = require("../models/Rating");
      var ratingAgg = await Rating.aggregate([
        { $group: { _id: null, avg: { $avg: "$score" }, count: { $sum: 1 } } },
      ]).catch(() => []);
      if (ratingAgg && ratingAgg[0]) {
        data.avgRating = Math.round((ratingAgg[0].avg || 0) * 10) / 10;
        data.totalRatings = ratingAgg[0].count || 0;
      }

      // Rating distribution
      var ratingDist = await Rating.aggregate([
        { $group: { _id: "$score", count: { $sum: 1 } } },
        { $sort: { _id: -1 } },
      ]).catch(() => []);
      ratingDist.forEach(r => { if (r._id >= 1 && r._id <= 5) data.ratingDistribution[r._id] = r.count; });
    } catch (e) {}

    // ── Enterprise: Large-Scale Projects ──
    try {
      var Project = require("../models/Project");
      data.totalProjects = await Project.countDocuments({}).catch(() => 0);
      data.activeProjects = await Project.countDocuments({ status: { $in: ["in_progress", "planning", "ready", "accepted"] } }).catch(() => 0);
      data.completedProjects = await Project.countDocuments({ status: { $in: ["completed", "closed"] } }).catch(() => 0);
    } catch (e) {}

    // ── Enterprise: Lifetime Booking Stats ──
    try {
      data.totalBookingsAllTime = await BookingService.countDocuments({}).catch(() => 0);
      if (data.totalBookingsAllTime > 0) {
        data.completionRate = Math.round((data.pipeline.completed / data.totalBookingsAllTime) * 100);
      }
    } catch (e) {}

    // ── Orders Summary ──
    try {
      var Order = require("../models/Order");
      data.ordersThisMonth = await Order.countDocuments({ createdAt: { $gte: startOfMonth } }).catch(() => 0);
      data.totalOrdersAllTime = await Order.countDocuments({}).catch(() => 0);
      data.todayOrders = await Order.countDocuments({ createdAt: { $gte: startOfDay, $lte: endOfDay } }).catch(() => 0);

      var ordLastMonthStart = new Date(startOfMonth);
      ordLastMonthStart.setMonth(ordLastMonthStart.getMonth() - 1);
      var ordLastMonthEnd = new Date(startOfMonth);
      ordLastMonthEnd.setDate(0);
      ordLastMonthEnd.setHours(23, 59, 59, 999);

      data.ordersLastMonth = await Order.countDocuments({ createdAt: { $gte: ordLastMonthStart, $lte: ordLastMonthEnd } }).catch(() => 0);

      var orderRevenueAgg = await Order.aggregate([
        { $match: { createdAt: { $gte: startOfMonth }, paymentStatus: { $in: ["paid", "verified", "payment_collected", "remitted"] } } },
        { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } }
      ]).catch(() => []);
      data.orderRevenue = (orderRevenueAgg && orderRevenueAgg[0]) ? orderRevenueAgg[0].total : 0;

      var ordersByStatusRaw = await Order.aggregate([
        { $match: { createdAt: { $gte: startOfMonth } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]).catch(() => []);
      data.ordersByStatus = {};
      ordersByStatusRaw.forEach(function(o) { data.ordersByStatus[o._id] = o.count; });

      data.recentOrders = await Order.find({}).sort({ createdAt: -1 }).limit(5)
        .select("orderReference status total paymentStatus createdAt customer")
        .lean().catch(() => []);
    } catch (e) {}

    console.log('[DEBUG] analyticsSummary returning:', JSON.stringify({totalBookingsToday: data.totalBookingsToday, pendingReview: data.pendingReview, awaitingAssignment: data.awaitingAssignment, activeServices: data.activeServices, revenueToday: data.revenueToday, totalTechs: data.totalTechnicians, availableTechs: data.availableTechnicians}));
    res.json(data);
  } catch (err) {
    next(err);
  }
};

// Debug endpoint — remove after verifying
exports.debugCounts = async (req, res) => {
  try {
    const BookingService = require("../models/BookingService");
    const Payment = require("../models/Payment");
    const Order = require("../models/Order");
    const Technician = require("../models/Technician");

    const totalBookings = await BookingService.countDocuments();
    const bookingStatuses = await BookingService.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
    const bookingPaymentStatuses = await BookingService.aggregate([{ $group: { _id: "$paymentStatus", count: { $sum: 1 } } }]);
    const totalPayments = await Payment.countDocuments();
    const paymentStatuses = await Payment.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
    const totalOrders = await Order.countDocuments();
    const totalTechs = await Technician.countDocuments();

    res.json({
      bookings: { total: totalBookings, byStatus: bookingStatuses, byPaymentStatus: bookingPaymentStatuses },
      payments: { total: totalPayments, byStatus: paymentStatuses },
      orders: { total: totalOrders },
      technicians: { total: totalTechs },
    });
  } catch (e) {
    res.json({ error: e.message });
  }
};

// (TimeSlot-related endpoints removed)

// --- Non-working days (admin) -------------------------------------------------
// GET /api/admin/dayoffs?date=YYYY-MM-DD | startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&serviceId=
exports.listNonWorkingDays = async (req, res, next) => {
  try {
    const { date, startDate, endDate, serviceId } = req.query;
    const q = {};

    if (date) {
      const d = new Date(date + "T00:00:00");
      if (Number.isNaN(d.getTime()))
        return res.status(400).json({ error: "invalid date" });
      q.date = d;
    }

    if (startDate || endDate) {
      const sd = startDate ? new Date(startDate + "T00:00:00") : null;
      const ed = endDate ? new Date(endDate + "T00:00:00") : null;
      if (
        (sd && Number.isNaN(sd.getTime())) ||
        (ed && Number.isNaN(ed.getTime()))
      )
        return res.status(400).json({ error: "invalid startDate or endDate" });
      q.date = {};
      if (sd) q.date.$gte = sd;
      if (ed) {
        ed.setHours(23, 59, 59, 999);
        q.date.$lte = ed;
      }
    }

    if (serviceId) {
      if (!mongoose.Types.ObjectId.isValid(serviceId))
        return res.status(400).json({ error: "invalid serviceId" });
      q.service = serviceId;
    }

    const NonWorkingDay = require("../models/NonWorkingDay");
    const docs = await NonWorkingDay.find(q).sort({ date: 1 }).lean();
    return res.json({ dayoffs: docs });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/dayoffs  (create single day-off)
// body: { date: 'YYYY-MM-DD', serviceId?, note?, force? }
exports.createNonWorkingDay = async (req, res, next) => {
  try {
    const { date, serviceId, note, force } = req.body || {};
    if (!date)
      return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
    const d = new Date(date + "T00:00:00");
    if (Number.isNaN(d.getTime()))
      return res.status(400).json({ error: "invalid date" });
    const NonWorkingDay = require("../models/NonWorkingDay");
    const doc = new NonWorkingDay({
      date: d,
      service:
        serviceId && mongoose.Types.ObjectId.isValid(serviceId)
          ? serviceId
          : undefined,
      note: note || "",
    });
    await doc.save();

    await logAction(req.user._id, doc._id, "dayoff.create", req, {
      date,
      serviceId,
      force: !!force,
    });
    return res.status(201).json({ dayoff: doc });
  } catch (err) {
    if (err && err.code === 11000)
      return res
        .status(409)
        .json({ error: "Day off already exists for that date/scope" });
    next(err);
  }
};

// DELETE /api/admin/dayoffs/:id
exports.deleteNonWorkingDay = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    const NonWorkingDay = require("../models/NonWorkingDay");
    const d = await NonWorkingDay.findByIdAndDelete(id);
    if (!d) return res.status(404).json({ error: "Day off not found" });
    await logAction(req.user._id, d._id, "dayoff.delete", req, {});
    return res.json({ message: "deleted" });
  } catch (err) {
    next(err);
  }
};

exports.syncPublicHolidays = async (req, res, next) => {
  try {
    const { country, year } = req.body || {};
    const targetCountry = String(country || process.env.NAGER_COUNTRY || "PH").toUpperCase();
    const targetYear = Number(year || new Date().getFullYear());

    if (!targetCountry || targetCountry.length !== 2) {
      return res.status(400).json({ error: "Invalid country code" });
    }
    if (isNaN(targetYear) || targetYear < 2000 || targetYear > 2100) {
      return res.status(400).json({ error: "Invalid year" });
    }

    const { getPublicHolidays } = require("../utils/nagerDateService");
    const holidays = await getPublicHolidays(targetCountry, targetYear);
    
    let addedCount = 0;
    const NonWorkingDay = require("../models/NonWorkingDay");
    
    for (const h of holidays) {
      const date = new Date(h.date + "T00:00:00");
      const note = h.localName || h.name || "Public Holiday";
      try {
        const existing = await NonWorkingDay.findOne({ date, service: null });
        if (!existing) {
          await NonWorkingDay.create({ date, note, reason: "public holiday" });
          addedCount++;
        }
      } catch (e) {
        if (e.code !== 11000) {
          console.warn("Holiday sync error", e);
        }
      }
    }

    await logAction(req.user._id, null, "dayoffs.sync", req, {
      country: targetCountry,
      year: targetYear,
      addedCount,
    });

    return res.json({ message: "Holidays synced successfully", addedCount, total: holidays.length });
  } catch (err) {
    next(err);
  }
};


// ------------------------- Core Service management --------------------------
// these endpoints power the admin UI for creating/editing core service catalog

// GET /api/admin/core-services
exports.listCoreServices = async (req, res, next) => {
  try {
    const CoreService = require("../models/CoreService");
    const docs = await CoreService.find({}).lean();
    return res.json({ coreServices: docs });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/core-services/:id
exports.getCoreService = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "invalid id" });
    const CoreService = require("../models/CoreService");
    const svc = await CoreService.findById(id).lean();
    if (!svc) return res.status(404).json({ error: "not found" });
    return res.json({ coreService: svc });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/core-services  (body: service fields)
exports.createCoreService = async (req, res, next) => {
  try {
    const {
      name,
      slug,
      category,
      description,
      features,
      includedItems,
      exclusions,
      isAirconService,
      airconTypes,
      warrantyPolicy,
      active,
    } = req.body || {};
    if (!name || !slug || !category)
      return res
        .status(400)
        .json({ error: "name, slug and category are required" });
    const CoreService = require("../models/CoreService");
    const existing = await CoreService.findOne({ slug });
    if (existing) return res.status(409).json({ error: "slug already exists" });
    const normalizedWarranty = normalizeServiceWarrantyPolicy(warrantyPolicy, { slug, name }, "core");
    const svc = new CoreService({
      name,
      slug,
      category,
      description,
      features: Array.isArray(features) ? features : [],
      includedItems: Array.isArray(includedItems) ? includedItems : [],
      exclusions: Array.isArray(exclusions) ? exclusions : [],
      isAirconService: isAirconService === true || isAirconService === "true",
      airconTypes: Array.isArray(airconTypes) ? airconTypes : undefined,
      warrantyPolicy: normalizedWarranty,
      active: active !== false,
    });
    await svc.save();
    await logAction(req.user._id, svc._id, "coreService.create", req, {
      slug,
    });
    return res.status(201).json({ coreService: svc });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/admin/core-services/:id (body: fields to update)
exports.editCoreService = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "invalid id" });
    const updates = { ...(req.body || {}) };
    if (updates.slug) {
      const CoreService = require("../models/CoreService");
      const other = await CoreService.findOne({
        slug: updates.slug,
        _id: { $ne: id },
      });
      if (other) return res.status(409).json({ error: "slug already exists" });
    }
    const CoreService = require("../models/CoreService");
    const existingService = await CoreService.findById(id).lean();
    if (!existingService) return res.status(404).json({ error: "not found" });
    if (Object.prototype.hasOwnProperty.call(updates, "warrantyPolicy")) {
      const previousPolicy = normalizeServiceWarrantyPolicy(existingService.warrantyPolicy, existingService, "core");
      const nextPolicy = normalizeServiceWarrantyPolicy(
        updates.warrantyPolicy,
        { ...existingService, slug: updates.slug || existingService.slug, name: updates.name || existingService.name },
        "core",
      );
      const previousComparable = { ...previousPolicy, termsVersion: undefined };
      const nextComparable = { ...nextPolicy, termsVersion: undefined };
      nextPolicy.termsVersion = JSON.stringify(previousComparable) === JSON.stringify(nextComparable)
        ? previousPolicy.termsVersion
        : Math.min(1000000, Math.max(1, Number(previousPolicy.termsVersion) || 1) + 1);
      updates.warrantyPolicy = nextPolicy;
    }
    const svc = await CoreService.findByIdAndUpdate(id, updates, {
      returnDocument: "after",
      runValidators: true,
    }).lean();
    if (!svc) return res.status(404).json({ error: "not found" });
    await logAction(req.user._id, svc._id, "coreService.update", req, {
      updates,
    });
    return res.json({ coreService: svc });
  } catch (err) {
    next(err);
  }
};

// ------------------------- Repair Service management ------------------------
// thorough-but-simple CRUD for repair service catalog

// GET /api/admin/repair-services
exports.listRepairServices = async (req, res, next) => {
  try {
    const RepairService = require("../models/RepairService");
    const docs = await RepairService.find({}).lean();
    return res.json({ repairServices: docs });
  } catch (err) {
    next(err);
  }
};

// --------------------------
// Purchases / ordered products
// --------------------------
exports.listPurchases = async (req, res, next) => {
  try {
    const Purchase = require("../models/Purchase");
    const mongoose = require("mongoose");
    const query = {};

    // simple search support
    if (req.query.search) {
      const re = new RegExp(escapeRegex(req.query.search), "i");
      query.$or = [
        { _id: re },
        { "items.name": re },
        { customerName: re },
      ];
    }
    if (req.query.userId && mongoose.Types.ObjectId.isValid(req.query.userId)) {
      query.userId = req.query.userId;
    }
    // date range (optional)
    if (req.query.from || req.query.to) {
      query.purchaseDate = {};
      if (req.query.from) query.purchaseDate.$gte = new Date(req.query.from);
      if (req.query.to) query.purchaseDate.$lte = new Date(req.query.to);
    }

    const docs = await Purchase.find(query)
      .populate("userId", "firstName lastName email")
      .populate({ path: "items.productId", select: "itemName" })
      .sort({ purchaseDate: -1 })
      .lean();

    const purchases = docs.map((d) => {
      if (d.userId) {
        d.customerName = `${d.userId.firstName} ${d.userId.lastName}`.trim();
        d.customerEmail = d.userId.email;
      }
      return d;
    });

    return res.json({ purchases });
  } catch (err) {
    next(err);
  }
};

exports.getPurchase = async (req, res, next) => {
  try {
    const mongoose = require("mongoose");
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "invalid id" });

    const Purchase = require("../models/Purchase");
    const doc = await Purchase.findById(id)
      .populate("userId", "firstName lastName email")
      .populate({ path: "items.productId", select: "itemName" })
      .lean();
    if (!doc) return res.status(404).json({ error: "not found" });
    if (doc.userId) {
      doc.customerName = `${doc.userId.firstName} ${doc.userId.lastName}`.trim();
      doc.customerEmail = doc.userId.email;
    }
    return res.json({ purchase: doc });
  } catch (err) {
    next(err);
  }
};


// GET /api/admin/repair-services/:id
exports.getRepairService = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "invalid id" });
    const RepairService = require("../models/RepairService");
    const svc = await RepairService.findById(id).lean();
    if (!svc) return res.status(404).json({ error: "not found" });
    return res.json({ repairService: svc });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/repair-services
exports.createRepairService = async (req, res, next) => {
  try {
    const {
      name,
      slug,
      applianceType,
      basePrice,
      initialPrice,
      laborPerHour,
      isAirconService,
      allowTechnicianPricing,
      airconTypes,
      estimatedDurationMinutes,
      warrantyPolicy,
      active,
    } = req.body || {};
    if (!name || !slug)
      return res.status(400).json({ error: "name and slug are required" });
    const RepairService = require("../models/RepairService");
    const existing = await RepairService.findOne({ slug });
    if (existing) return res.status(409).json({ error: "slug already exists" });
    const normalizedWarranty = normalizeServiceWarrantyPolicy(warrantyPolicy, { slug, name }, "repair");
    const svc = new RepairService({
      name,
      slug,
      applianceType,
      basePrice,
      initialPrice,
      laborPerHour,
      isAirconService: isAirconService === true || isAirconService === "true",
      allowTechnicianPricing: allowTechnicianPricing !== false && allowTechnicianPricing !== "false",
      airconTypes: Array.isArray(airconTypes) ? airconTypes : undefined,
      estimatedDurationMinutes,
      warrantyDays: normalizedWarranty.workmanshipDays,
      warrantyPolicy: normalizedWarranty,
      active: active !== false,
    });
    await svc.save();
    await logAction(req.user._id, svc._id, "repairService.create", req, {
      slug,
    });
    return res.status(201).json({ repairService: svc });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/admin/repair-services/:id
exports.editRepairService = async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "invalid id" });
    const updates = { ...(req.body || {}) };
    if (updates.slug) {
      const RepairService = require("../models/RepairService");
      const other = await RepairService.findOne({
        slug: updates.slug,
        _id: { $ne: id },
      });
      if (other) return res.status(409).json({ error: "slug already exists" });
    }
    const RepairService = require("../models/RepairService");
    const existingService = await RepairService.findById(id).lean();
    if (!existingService) return res.status(404).json({ error: "not found" });
    if (Object.prototype.hasOwnProperty.call(updates, "warrantyPolicy")) {
      const previousPolicy = normalizeServiceWarrantyPolicy(existingService.warrantyPolicy, existingService, "repair");
      const nextPolicy = normalizeServiceWarrantyPolicy(
        updates.warrantyPolicy,
        { ...existingService, slug: updates.slug || existingService.slug, name: updates.name || existingService.name },
        "repair",
      );
      const previousComparable = { ...previousPolicy, termsVersion: undefined };
      const nextComparable = { ...nextPolicy, termsVersion: undefined };
      nextPolicy.termsVersion = JSON.stringify(previousComparable) === JSON.stringify(nextComparable)
        ? previousPolicy.termsVersion
        : Math.min(1000000, Math.max(1, Number(previousPolicy.termsVersion) || 1) + 1);
      updates.warrantyPolicy = nextPolicy;
      updates.warrantyDays = nextPolicy.workmanshipDays;
    }
    const svc = await RepairService.findByIdAndUpdate(id, updates, {
      returnDocument: "after",
      runValidators: true,
    }).lean();
    if (!svc) return res.status(404).json({ error: "not found" });
    await logAction(req.user._id, svc._id, "repairService.update", req, {
      updates,
    });
    return res.json({ repairService: svc });
  } catch (err) {
    next(err);
  }
};

// --- TechnicianSchedule endpoints -------------------------------------------------
exports.listTechnicianSchedules = async (req, res, next) => {
  try {
    // schedules are stored on TechnicianSchedule (single source of truth)
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const docs = await TechnicianSchedule.find({})
      .populate("technician", "name")
      .lean();
    const schedules = (docs || []).map((d) => ({
      technicianId: d.technicianId,
      technicianName: d.technician ? d.technician.name : "",
      workingDays: d.workingDays || [],
      nonWorkingWeekdays: (d.nonWorkingWeekdays || []).map((nw) => nw.dayOfWeek),
      restDates: d.restDates || [],
    }));
    return res.json({ schedules });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/technicians  (simple list used by scheduling UI)
exports.listTechnicians = async (req, res, next) => {
  try {
    // prevent clients from caching technician location data; we rely on frequent polls
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const Technician = require("../models/Technician");
    // return active technicians; include location so the admin list can show map
    const docs = await Technician.find({ active: true })
      .select(
        "name userEmail phone location locationText active avatarUrl avatar skills rating ratingCount",
      )
      .lean();
    return res.json({ technicians: docs });
  } catch (err) {
    next(err);
  }
};

exports.getTechnicianSchedule = async (req, res, next) => {
  try {
    const techId = req.params.technicianId;
    if (!mongoose.Types.ObjectId.isValid(techId))
      return res.status(400).json({ error: "invalid technicianId" });
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const doc = await TechnicianSchedule.findOne({
      technicianId: techId,
    }).lean();
    if (!doc)
      return res.json({
        schedule: {
          technicianId: techId,
          workingDays: [],
          nonWorkingWeekdays: [],
          restDates: [],
        },
      });
    return res.json({
      schedule: {
        technicianId: doc.technicianId,
        workingDays: doc.workingDays || [],
        nonWorkingWeekdays: (doc.nonWorkingWeekdays || []).map(
          (n) => n.dayOfWeek,
        ),
        restDates: doc.restDates || [],
      },
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/technicians/:id/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns merged calendar events for a technician by combining Technician, TechnicianSchedule and NonWorkingDay
exports.getTechnicianCalendar = async (req, res, next) => {
  try {
    const techId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(techId))
      return res.status(400).json({ error: "invalid technicianId" });

    const start = req.query.start
      ? new Date(req.query.start + "T00:00:00")
      : null;
    const end = req.query.end ? new Date(req.query.end + "T00:00:00") : null;

    // validate start/end parameters if provided
    if (
      (start && Number.isNaN(start.getTime())) ||
      (end && Number.isNaN(end.getTime()))
    )
      return res.status(400).json({ error: "invalid start/end" });

    const Technician = require("../models/Technician");
    const tech = await Technician.findById(techId).lean();
    if (!tech) return res.status(404).json({ error: "Technician not found" });

    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const sched = (await TechnicianSchedule.findOne({
      technicianId: techId,
    }).lean()) || { workingDays: [], restDates: [] };

    const NonWorkingDay = require("../models/NonWorkingDay");
    const ndq = {};
    if (start || end) ndq.date = {};
    if (start) ndq.date.$gte = start;
    if (end) {
      const ed = new Date(end);
      ed.setHours(23, 59, 59, 999);
      ndq.date.$lte = ed;
    }
    const nonWorkingDocs = await NonWorkingDay.find(ndq).lean();

    // helper: format a date to local YYYY-MM-DD (avoid UTC shifts)
    function localDateKey(d) {
      const dt = new Date(d);
      dt.setHours(0, 0, 0, 0);
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const day = String(dt.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }

    const nonWorkingMap = new Map();
    (nonWorkingDocs || []).forEach((n) => {
      const k = localDateKey(n.date);
      nonWorkingMap.set(k, { note: n.note || "", reason: n.reason || "" });
    });

    const restMap = new Map();
    (sched.restDates || []).forEach((r) => {
      const k = localDateKey(r.date);
      restMap.set(k, { _id: r._id, reason: r.reason || "" });
    });

    // determine iteration range
    let sDate = start ? new Date(start) : null;
    let eDate = end ? new Date(end) : null;
    if (!sDate || !eDate) {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      sDate = new Date(now);
      eDate = new Date(now);
      eDate.setDate(now.getDate() + 30);
    }
    const events = [];

    // helper: parse minute-based or HH:MM times into minute-of-day
    function parseMinuteValue(value) {
      if (value === null || value === undefined) return NaN;
      const raw = String(value).trim();
      if (!raw) return NaN;
      if (/^\d{1,4}$/.test(raw)) return Number(raw);
      const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
      if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
      const ampm = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (ampm) {
        let hh = Number(ampm[1]) % 12;
        if (ampm[3].toUpperCase() === "PM") hh += 12;
        return hh * 60 + Number(ampm[2]);
      }
      return NaN;
    }

    function mergeRanges(ranges) {
      if (!ranges.length) return [];
      const sorted = ranges
        .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
        .sort((a, b) => a.start - b.start);
      if (!sorted.length) return [];
      const merged = [sorted[0]];
      for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i];
        const last = merged[merged.length - 1];
        if (cur.start <= last.end) {
          last.end = Math.max(last.end, cur.end);
        } else {
          merged.push({ ...cur });
        }
      }
      return merged;
    }

    const BookingService = require("../models/BookingService");
    // treat anything that represents an active or upcoming job as busy
    const busyStatuses = [
      "pending",
      "confirmed",
      "scheduled",
      "on-the-way",
      "arrived",
      "in-progress",
      "ongoing",
      "re-scheduled",
    ];
    const rangeStart = new Date(sDate);
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = new Date(eDate);
    rangeEnd.setHours(23, 59, 59, 999);

    // include both technician._id and linked user id (legacy mixed references)
    const techIdsToMatch = [String(tech._id)];
    if (tech.user) techIdsToMatch.push(String(tech.user));

    const bookings = await BookingService.find({
      bookingDate: { $gte: rangeStart, $lte: rangeEnd },
      status: { $in: busyStatuses },
      technicianId: { $in: Array.from(new Set(techIdsToMatch)) },
    }).lean();

    const busyByDate = new Map();
    for (const b of bookings) {
      if (!b.bookingDate) continue;
      const key = localDateKey(b.bookingDate);
      const bStart = parseMinuteValue(b.startTime);
      if (!Number.isFinite(bStart)) continue;
      const explicitEnd = parseMinuteValue(b.endTime);
      const fallbackDur = (Number(b.serviceDurationMinutes) || 60) + Math.max(0, Number(b.travelTime) || 0);
      const bEnd = Number.isFinite(explicitEnd) && explicitEnd > bStart ? explicitEnd : bStart + fallbackDur;
      if (!Number.isFinite(bEnd) || bEnd <= bStart) continue;
      if (!busyByDate.has(key)) busyByDate.set(key, []);
      busyByDate.get(key).push({
        start: bStart,
        end: bEnd,
        title: b.bookingReference ? `Booked (${b.bookingReference})` : "Booked",
      });
    }
    for (const [k, ranges] of busyByDate.entries()) {
      busyByDate.set(k, mergeRanges(ranges));
    }

    const cur = new Date(sDate);
    while (cur <= eDate) {
      const day = cur.getDay(); // 0=Sunday, 1=Monday...

      const working = (sched.workingDays || []).find(
        (w) => w.dayOfWeek === day,
      );

      const key = localDateKey(cur);

      const isHoliday = nonWorkingMap.has(key);
      const isRest = restMap.has(key);

      const dayBusy = busyByDate.get(key) || [];

      if (working && !isHoliday && !isRest) {
        // subtract busy ranges from working block so calendar truly reflects blocked time
        let cursor = working.startMinutes;
        for (const br of dayBusy) {
          const s = Math.max(working.startMinutes, br.start);
          const e = Math.min(working.endMinutes, br.end);
          if (e <= s) continue;
          if (s > cursor) {
            const avStart = new Date(cur);
            avStart.setMinutes(cursor);
            const avEnd = new Date(cur);
            avEnd.setMinutes(s);
            events.push({
              title: "Available",
              start: avStart,
              end: avEnd,
              display: "background",
              color: "#28a745",
            });
          }
          cursor = Math.max(cursor, e);
        }
        if (cursor < working.endMinutes) {
          const avStart = new Date(cur);
          avStart.setMinutes(cursor);
          const avEnd = new Date(cur);
          avEnd.setMinutes(working.endMinutes);
          events.push({
            title: "Available",
            start: avStart,
            end: avEnd,
            display: "background",
            color: "#28a745",
          });
        }
      }

      // foreground blocked booking events
      for (const br of dayBusy) {
        const bs = new Date(cur);
        bs.setMinutes(br.start);
        const be = new Date(cur);
        be.setMinutes(br.end);
        events.push({
          title: br.title || "Booked",
          start: bs,
          end: be,
          color: "#dc3545",
          display: "auto",
          extendedProps: { blocked: true },
        });
      }

      if (isHoliday) {
        events.push({
          title: "Holiday",
          start: key,
          allDay: true,
          color: "#dc3545",
        });
      }

      if (isRest) {
        events.push({
          title: "Rest Day",
          start: key,
          allDay: true,
          color: "#ffc107",
        });
      }

      cur.setDate(cur.getDate() + 1);
    }

    const holidays = (nonWorkingDocs || []).map((n) => ({
      _id: n._id,
      date: localDateKey(n.date),
      note: n.note || "",
      reason: n.reason || "",
    }));

    const out = {
      _id: tech._id,
      name:
        tech.name ||
        ((tech.firstName || "") + " " + (tech.lastName || "")).trim() ||
        tech.userEmail ||
        "",
      location: tech.location || tech.locationText || null,
      schedule: {
        workingDays: sched.workingDays || [],
        nonWorkingWeekdays: (sched.nonWorkingWeekdays || []).map(
          (n) => n.dayOfWeek,
        ),
        restDates: (sched.restDates || []).map((r) => ({
          _id: r._id,
          date: localDateKey(r.date),
          reason: r.reason || "",
        })),
      },
      holidays,
      events,
    };

    return res.json(out);
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/technician-schedules  (create/update)
exports.upsertTechnicianSchedule = async (req, res, next) => {
  try {
    const { technicianId, workingDays, restDates } = req.body || {};
    // sanitize workingDays: ensure numeric fields, valid dow, start<end, and sort
    const rawWd = Array.isArray(workingDays) ? workingDays : [];
    const wd = rawWd
      .map((w) => ({
        dayOfWeek: Number(w.dayOfWeek),
        startMinutes: Number(w.startMinutes),
        endMinutes: Number(w.endMinutes),
      }))
      .filter(
        (w) =>
          Number.isInteger(w.dayOfWeek) &&
          w.dayOfWeek >= 0 &&
          w.dayOfWeek < 7 &&
          typeof w.startMinutes === "number" &&
          typeof w.endMinutes === "number" &&
          w.startMinutes < w.endMinutes,
      )
      .sort((a, b) => a.dayOfWeek - b.dayOfWeek);
    // derive nonWorkingWeekdays as the complement of wd over 0..6
    const allDays = [0, 1, 2, 3, 4, 5, 6];
    const nwNums = allDays.filter((d) => !wd.some((w) => w.dayOfWeek === d));
    // store as array of embedded docs to satisfy schema
    const nw = nwNums.map((d) => ({ dayOfWeek: d }));
    const rd = Array.isArray(restDates)
      ? restDates.map((r) => ({
          date: new Date((r.date || "") + "T00:00:00"),
          reason: String(r.reason || "")
            .trim()
            .substring(0, 200),
        }))
      : [];
    const Technician = require("../models/Technician");
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    // helper: apply schedule to single technician (no TimeSlot updates)
    async function applyScheduleToTech(tid) {
      // upsert new schedule
      const updated = await TechnicianSchedule.findOneAndUpdate(
        { technicianId: tid },
        { $set: { workingDays: wd, nonWorkingWeekdays: nw, restDates: rd } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
      return updated;
    }

    // apply to all technicians when technicianId === 'ALL'
    if (technicianId === "ALL") {
      const techs = await Technician.find({}).select("_id").lean();
      for (const t of techs) {
        await applyScheduleToTech(t._id);
      }
      await logAction(
        req.user._id,
        null,
        "technicianSchedule.upsert_all",
        req,
        {},
      );
      return res.json({ message: "applied_to_all" });
    }

    if (!technicianId || !mongoose.Types.ObjectId.isValid(technicianId))
      return res.status(400).json({ error: "technicianId is required" });

    const techExists = await Technician.findById(technicianId).lean();
    if (!techExists)
      return res.status(404).json({ error: "Technician not found" });

    const doc = await applyScheduleToTech(technicianId);
    await logAction(
      req.user._id,
      technicianId,
      "technicianSchedule.upsert",
      req,
      { technicianId },
    );
    return res.json({
      schedule: {
        technicianId: doc.technicianId,
        workingDays: doc.workingDays || [],
        restDates: doc.restDates || [],
      },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/admin/timeslots/regenerate  (body: { days = 60, technicianId? })
exports.regenerateTimeSlots = async (req, res, next) => {
  // TimeSlot regeneration removed — endpoint deprecated
  return res.json({ message: "deprecated" });
};

// ========================= Roles & Permissions ==============================
const Role = require("../models/Role");
const {
  PERMISSION_CATALOG,
  ALL_PERMISSION_KEYS,
} = require("../middleware/requirePermission");

// GET /api/admin/roles — list all roles with user counts
exports.listRoles = async (req, res, next) => {
  try {
    const roles = await Role.find({}).lean();
    // attach user counts
    const counts = await User.aggregate([
      { $match: { role: { $in: roles.map((r) => r.name) } } },
      { $group: { _id: "$role", count: { $sum: 1 } } },
    ]);
    const countMap = counts.reduce((m, c) => {
      m[c._id] = c.count;
      return m;
    }, {});
    roles.forEach((r) => {
      r.userCount = countMap[r.name] || 0;
    });
    return res.json({ roles });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/roles/:id — get a single role
exports.getRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    const role = await Role.findById(id).lean();
    if (!role) return res.status(404).json({ error: "Role not found" });
    const userCount = await User.countDocuments({ role: role.name });
    role.userCount = userCount;
    return res.json({ role });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/admin/roles/:id — update a role's permissions
exports.updateRolePermissions = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    const { permissions, description } = req.body || {};
    if (!Array.isArray(permissions))
      return res.status(400).json({ error: "permissions must be an array" });
    // Validate every key
    const invalid = permissions.filter((p) => !ALL_PERMISSION_KEYS.includes(p));
    if (invalid.length)
      return res
        .status(400)
        .json({ error: `Unknown permissions: ${invalid.join(", ")}` });
    const updates = { permissions };
    if (typeof description === "string") updates.description = description.trim();
    const role = await Role.findByIdAndUpdate(id, updates, { returnDocument: "after" }).lean();
    if (!role) return res.status(404).json({ error: "Role not found" });
    await logAction(req.user._id, role._id, "role.updatePermissions", req, {
      roleName: role.name,
      permissionCount: permissions.length,
    });
    return res.json({ role, message: "Role permissions updated" });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/roles/:id/users — list users assigned to a role
exports.listRoleUsers = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    const role = await Role.findById(id).lean();
    if (!role) return res.status(404).json({ error: "Role not found" });
    const users = await User.find({ role: role.name })
      .select("_id email firstName lastName role active permissions")
      .lean();
    return res.json({ users, roleName: role.name });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/admin/users/:id/permissions — set per-user permission overrides
exports.setUserPermissions = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    const { permissions } = req.body || {};
    if (!Array.isArray(permissions))
      return res.status(400).json({ error: "permissions must be an array" });
    const invalid = permissions.filter((p) => !ALL_PERMISSION_KEYS.includes(p));
    if (invalid.length)
      return res
        .status(400)
        .json({ error: `Unknown permissions: ${invalid.join(", ")}` });
    const user = await User.findByIdAndUpdate(
      id,
      { permissions },
      { returnDocument: "after" },
    )
      .select("_id email firstName lastName role permissions")
      .lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    await logAction(req.user._id, user._id, "user.setPermissions", req, {
      permissionCount: permissions.length,
    });
    return res.json({ user, message: "User permissions updated" });
  } catch (err) {
    next(err);
  }
};

// DELETE /api/admin/users/:id/permissions — clear per-user overrides
exports.clearUserPermissions = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid id" });
    const user = await User.findByIdAndUpdate(
      id,
      { $unset: { permissions: 1 } },
      { returnDocument: "after" },
    )
      .select("_id email firstName lastName role permissions")
      .lean();
    if (!user) return res.status(404).json({ error: "User not found" });
    await logAction(req.user._id, user._id, "user.clearPermissions", req, {});
    return res.json({ user, message: "User permissions reset to role defaults" });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/permissions/all — returns the master permission catalog
exports.listAllPermissions = async (req, res, next) => {
  try {
    return res.json({ catalog: PERMISSION_CATALOG });
  } catch (err) {
    next(err);
  }
};

// ─── Aircon Inventory CRUD ───────────────────────────────────────────────────

/**
 * GET /api/admin/inventory
 * List all active aircon products with brand + category populated.
 */
exports.listInventory = async (req, res, next) => {
  try {
    const Inventory = require("../models/Inventory");
    const Brand = require("../models/Brand");
    const Category = require("../models/Category");
    const filter = { active: true };
    // optional: allow ?showAll=1 to include inactive
    if (req.query.showAll === "1") delete filter.active;

    const inventory = await Inventory.find(filter)
      .populate("brand", "name")
      .populate("category", "name")
      .sort({ modelLine: 1, capacity: 1 })
      .lean();

    return res.json({ inventory, count: inventory.length });
  } catch (err) {
    console.error("listInventory 500:", err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};

/**
 * GET /api/admin/inventory/:id
 * Get a single aircon product by ID.
 */
exports.getInventory = async (req, res, next) => {
  try {
    const Inventory = require("../models/Inventory");
    const { id } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid inventory id" });
    }

    const item = await Inventory.findById(id)
      .populate("brand", "name")
      .populate("category", "name")
      .lean();

    if (!item) {
      return res.status(404).json({ error: "Inventory item not found" });
    }

    return res.json(item);
  } catch (err) {
    console.error("getInventory 500:", err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/admin/inventory
 * Create a new aircon product.
 * Expects body with modelLine, capacity, type, sellingPrice, etc.
 */
exports.createInventory = async (req, res, next) => {
  try {
    const Inventory = require("../models/Inventory");
    const Category  = require("../models/Category");
    const Brand     = require("../models/Brand");

    const {
      modelLine, brand, category, type, capacity, capacityUnit,
      btu, inverter, sellingPrice, costPrice, quantity, minStockLevel,
      status, description, features, warranty, imageUrl,
      salesChannel, supplier,
    } = req.body || {};

    if (!modelLine || String(modelLine).trim() === "") {
      return res.status(400).json({ error: "modelLine is required" });
    }
    if (!capacity || String(capacity).trim() === "") {
      return res.status(400).json({ error: "capacity is required" });
    }

    // Resolve brand ObjectId or create-by-name
    let brandId = null;
    if (brand && mongoose.Types.ObjectId.isValid(brand)) {
      brandId = brand;
    } else if (brand && typeof brand === "string" && brand.trim()) {
      let b = await Brand.findOne({ name: new RegExp(`^${escapeRegex(brand.trim(), 200)}$`, "i") });
      if (!b) b = await Brand.create({ name: brand.trim() });
      brandId = b._id;
    }

    // Resolve category ObjectId or create-by-name
    let categoryId = null;
    if (category && mongoose.Types.ObjectId.isValid(category)) {
      categoryId = category;
    } else if (category && typeof category === "string" && category.trim()) {
      let c = await Category.findOne({ name: new RegExp(`^${escapeRegex(category.trim(), 200)}$`, "i") });
      if (!c) c = await Category.create({ name: category.trim() });
      categoryId = c._id;
    } else {
      // Default category for aircon items
      let c = await Category.findOne({ name: /aircon/i });
      if (!c) c = await Category.create({ name: "Aircon" });
      categoryId = c._id;
    }

    const item = new Inventory({
      modelLine:       String(modelLine).trim(),
      brand:           brandId,
      category:        categoryId,
      type:            type            || "split",
      capacity:        String(capacity).trim(),
      capacityUnit:    capacityUnit    || "HP",
      btu:             Number(btu)     || 0,
      inverter:        !!inverter,
      sellingPrice:    Number(sellingPrice) || 0,
      costPrice:       Number(costPrice)    || 0,
      quantity:        Number(quantity)     || 0,
      minStockLevel:   Number(minStockLevel) || 3,
      description:     description     || null,
      features:        Array.isArray(features) ? features : [],
      warranty:        warranty         || "1 Year Compressor, 1 Year Parts",
      imageUrl:        imageUrl         || "/images/products/default.png",
      salesChannel:    salesChannel     || "both",
      supplier:        supplier         || null,
      status:          status           || undefined,
      active:          true,
    });
    await item.save();

    await logAction(req.user._id, item._id, "inventory.create", req, {
      modelLine: item.modelLine, capacity: item.capacity,
    });

    return res.status(201).json({ message: "Aircon product created", item });
  } catch (err) {
    // Duplicate key (brand_model_capacity_unique)
    if (err.code === 11000) {
      return res.status(409).json({
        error: "An aircon product with this brand + model + capacity already exists",
      });
    }
    next(err);
  }
};

/**
 * PATCH /api/admin/inventory/:id
 * Update an existing aircon product.
 */
exports.editInventory = async (req, res, next) => {
  try {
    const Inventory = require("../models/Inventory");
    const Category  = require("../models/Category");
    const Brand     = require("../models/Brand");
    const { id }    = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const item = await Inventory.findById(id);
    if (!item) return res.status(404).json({ error: "Aircon product not found" });

    const allowed = [
      "modelLine","type","capacity","capacityUnit","btu","inverter",
      "sellingPrice","costPrice","quantity","minStockLevel","status",
      "description","features","warranty","imageUrl","salesChannel",
      "supplier","active",
    ];
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) item[key] = req.body[key];
    });

    // Handle brand update by name
    if (req.body.brand !== undefined) {
      const bVal = req.body.brand;
      if (mongoose.Types.ObjectId.isValid(bVal)) {
        item.brand = bVal;
      } else if (typeof bVal === "string" && bVal.trim()) {
        let b = await Brand.findOne({ name: new RegExp(`^${escapeRegex(bVal.trim(), 200)}$`, "i") });
        if (!b) b = await Brand.create({ name: bVal.trim() });
        item.brand = b._id;
      }
    }

    // Handle category update by name
    if (req.body.category !== undefined) {
      const cVal = req.body.category;
      if (mongoose.Types.ObjectId.isValid(cVal)) {
        item.category = cVal;
      } else if (typeof cVal === "string" && cVal.trim()) {
        let c = await Category.findOne({ name: new RegExp(`^${escapeRegex(cVal.trim(), 200)}$`, "i") });
        if (!c) c = await Category.create({ name: cVal.trim() });
        item.category = c._id;
      }
    }

    await item.save();
    await logAction(req.user._id, item._id, "inventory.edit", req, {
      modelLine: item.modelLine, capacity: item.capacity,
    });
    return res.json({ message: "Aircon product updated", item });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: "Duplicate brand + model + capacity" });
    }
    next(err);
  }
};

// ─── Tool CRUD ───────────────────────────────────────────────────────────────

/**
 * GET /api/admin/tools
 * List all active tools/materials.
 */
exports.listTools = async (req, res, next) => {
  try {
    const Tool   = require("../models/Tool");
    const ServiceToolUsage = require("../models/ServiceToolUsage");
    const filter = { active: true };
    if (req.query.showAll === "1") delete filter.active;

    const tools = await Tool.find(filter)
      .sort({ itemName: 1 })
      .lean();

    // Expose a deterministic class for legacy rows without mutating them.
    tools.forEach((tool) => {
      tool.inventoryClass = Tool.effectiveInventoryClass(tool);
    });

    // Backfill missing type field
    const bulkOps = tools.filter(t => !t.type).map(t => ({
      updateOne: { filter: { _id: t._id }, update: { $set: { type: 'part' } } }
    }));
    if (bulkOps.length > 0) {
      await Tool.bulkWrite(bulkOps, { ordered: false });
      tools.forEach(t => { if (!t.type) t.type = 'part'; });
    }

    // Compute consumed quantities per tool
    // `lean()` preserves `_id` as an ObjectId. Reuse those values directly:
    // Mongoose 9's ObjectId is a class and throws when invoked without `new`.
    // The previous conversion therefore made the entire catalog endpoint fail.
    const toolIds = tools.map((tool) => tool._id).filter(Boolean);
    const consumedAgg = await ServiceToolUsage.aggregate([
      { $match: { toolItemId: { $in: toolIds } } },
      { $group: { _id: "$toolItemId", consumed: { $sum: "$quantityUsed" } } },
    ]);
    const consumedMap = new Map(consumedAgg.map(c => [c._id.toString(), c.consumed]));

    tools.forEach(t => {
      const reserved = t.reservedQuantity || 0;
      const consumed = consumedMap.get(t._id.toString()) || 0;
      t.reserved = reserved;
      t.consumed = consumed;
      t.available = Math.max(0, (t.quantity || 0) - reserved);
    });

    return res.json({ tools, count: tools.length });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/admin/tools
 * Create a new tool/material item.
 */
exports.createTool = async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const {
      itemName, unit, quantity, minStockLevel,
      costPrice, sellingPrice, specification, description, supplier, category, type,
      serialNumber, inventoryClass, assetCode, assetCondition, assetStatus,
      maintenanceIntervalDays, lastMaintenanceAt, assignable,
    } = req.body || {};

    if (!itemName || String(itemName).trim() === "") {
      return res.status(400).json({ error: "itemName is required" });
    }

    const normalizedClass = inventoryClass || (["equipment", "tool"].includes(type) ? "operational_asset" : "merchandise");
    if (!['merchandise', 'operational_asset'].includes(normalizedClass)) {
      return res.status(400).json({ error: "Invalid inventory class" });
    }

    const toolData = {
      itemName:      String(itemName).trim(),
      unit:          unit          || "pcs",
      quantity:      Number(quantity)     || 0,
      minStockLevel: Number.isFinite(Number(minStockLevel)) ? Number(minStockLevel) : 3,
      costPrice:     Number(costPrice)    || 0,
      sellingPrice:  normalizedClass === "merchandise" ? (Number(sellingPrice) || 0) : 0,
      specification: specification || null,
      description:   description   || null,
      supplier:      supplier      || null,
      category:      category      || "General",
      type:          type          || "part",
      inventoryClass: normalizedClass,
      assetCondition: assetCondition || "good",
      assetStatus: assetStatus || "available",
      maintenanceIntervalDays: Number(maintenanceIntervalDays) || 0,
      lastMaintenanceAt: lastMaintenanceAt || null,
      assignable: assignable !== false && assignable !== "false",
      active:        true,
    };
    // Sparse unique indexes only ignore an absent field; an explicit null can
    // still collide with another null value in MongoDB.
    if (normalizedClass === "operational_asset" && String(assetCode || "").trim()) {
      toolData.assetCode = String(assetCode).trim();
    }
    if (String(serialNumber || "").trim()) {
      toolData.serialNumber = String(serialNumber).trim();
    }
    const tool = new Tool(toolData);
    await tool.save();

    await logAction(req.user._id, tool._id, "tool.create", req, {
      itemName: tool.itemName,
    });
    return res.status(201).json({ message: "Tool created", tool });
  } catch (err) {
    console.error("[createTool] Error:", err.message, err.stack);
    if (err?.code === 11000) {
      const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || "identifier";
      return res.status(409).json({ error: `Another inventory item already uses this ${field}.` });
    }
    return res.status(500).json({ error: err.message || "Failed to create tool" });
  }
};

/**
 * GET /api/admin/tools/:id
 * Get a single tool by ID for editing.
 */
exports.getTool = async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const tool = await Tool.findById(id);
    if (!tool) return res.status(404).json({ error: "Tool not found" });

    return res.json({ tool });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/admin/tools/:id
 * Update an existing tool/material item.
 */
exports.editTool = async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const tool = await Tool.findById(id);
    if (!tool) return res.status(404).json({ error: "Tool not found" });

    const allowed = [
      "itemName","unit","quantity","minStockLevel","costPrice","sellingPrice",
      "specification","description","supplier","status","active","category","type",
      "serialNumber","inventoryClass","assetCode","assetCondition","assetStatus",
      "maintenanceIntervalDays","lastMaintenanceAt","assignable","reservedQuantity",
    ];
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) tool[key] = req.body[key];
    });
    if (!['merchandise', 'operational_asset'].includes(tool.inventoryClass)) {
      return res.status(400).json({ error: "Invalid inventory class" });
    }
    if (tool.inventoryClass === 'operational_asset') {
      tool.sellingPrice = 0;
      if (!String(tool.assetCode || '').trim()) tool.assetCode = undefined;
    } else {
      tool.assetCode = undefined;
    }
    if (!String(tool.serialNumber || '').trim()) tool.serialNumber = undefined;

    await tool.save();
    await logAction(req.user._id, tool._id, "tool.edit", req, {
      itemName: tool.itemName,
    });
    return res.json({ message: "Tool updated", tool });
  } catch (err) {
    if (err?.code === 11000) {
      const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || "identifier";
      return res.status(409).json({ error: `Another inventory item already uses this ${field}.` });
    }
    next(err);
  }
};

/**
 * DELETE /api/admin/tools/:id
 * Soft-delete a tool (sets active = false).
 */
exports.deleteTool = async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const tool = await Tool.findById(id);
    if (!tool) return res.status(404).json({ error: "Tool not found" });

    tool.active = false;
    await tool.save();
    await logAction(req.user._id, tool._id, "tool.delete", req, {
      itemName: tool.itemName,
    });
    return res.json({ message: "Tool archived", tool });
  } catch (err) {
    next(err);
  }
};

// Service Tracking Methods
exports.getServiceTracking = async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const services = await BookingService.find({})
      .populate('customerId', 'firstName lastName email phone')
      .populate('technicianId', 'firstName lastName email')
      .populate('serviceId', 'name type durationMinutes')
      .sort({ bookingDate: -1 })
      .limit(500)
      .lean();
    
    res.json({ services });
  } catch (err) {
    next(err);
  }
};

exports.getServiceTrackingDetail = async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const { id } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid service id" });
    }
    
    const service = await BookingService.findById(id)
      .populate('customerId', 'firstName lastName email phone address')
      .populate('technicianId', 'firstName lastName email phone')
      .populate('serviceId', 'name type durationMinutes estimatedPrice')
      .lean();
    
    if (!service) {
      return res.status(404).json({ error: "Service not found" });
    }
    
    res.json({ service });
  } catch (err) {
    next(err);
  }
};

exports.exportServiceTracking = async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const { id } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid service id" });
    }
    
    const service = await BookingService.findById(id)
      .populate('customerId', 'firstName lastName email phone')
      .populate('technicianId', 'firstName lastName email')
      .populate('serviceId', 'name type')
      .lean();
    
    if (!service) {
      return res.status(404).json({ error: "Service not found" });
    }
    
    // Create CSV data
    const csvData = [
      ['Reference', 'Customer', 'Email', 'Phone', 'Technician', 'Service', 'Date', 'Time', 'Status', 'Fuel Cost'],
      [
        service.bookingReference,
        `${service.customer?.firstName || ''} ${service.customer?.lastName || ''}`.trim(),
        service.customer?.email || '',
        service.customer?.phone || '',
        `${service.technician?.firstName || ''} ${service.technician?.lastName || ''}`.trim(),
        service.service?.name || '',
        service.bookingDate || '',
        service.startTime || '',
        service.status || '',
        service.travelFare || 0
      ]
    ];
    
    const csv = csvData.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="service-${service.bookingReference}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

exports.exportAllServiceTracking = async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const { serviceIds, filters } = req.body;
    
    let query = {};
    if (serviceIds && serviceIds.length > 0) {
      query._id = { $in: serviceIds };
    }
    
    // Apply filters if provided
    if (filters) {
      if (filters.startDate && filters.endDate) {
        query.bookingDate = {
          $gte: new Date(filters.startDate),
          $lte: new Date(filters.endDate)
        };
      }
      if (filters.technician) {
        query.technicianId = filters.technician;
      }
      if (filters.status) {
        query.status = filters.status;
      }
    }
    
    const services = await BookingService.find(query)
      .populate('customerId', 'firstName lastName email phone')
      .populate('technicianId', 'firstName lastName email')
      .populate('serviceId', 'name type')
      .sort({ bookingDate: -1 })
      .lean();
    
    // Create CSV data
    const csvData = [
      ['Reference', 'Customer', 'Email', 'Phone', 'Technician', 'Service', 'Date', 'Time', 'Status', 'Price', 'Fuel Cost']
    ];
    
    services.forEach(service => {
      csvData.push([
        service.bookingReference,
        `${service.customer?.firstName || ''} ${service.customer?.lastName || ''}`.trim(),
        service.customer?.email || '',
        service.customer?.phone || '',
        `${service.technician?.firstName || ''} ${service.technician?.lastName || ''}`.trim(),
        service.service?.name || '',
        service.bookingDate || '',
        service.startTime || '',
        service.status || '',
        service.estimatedFee || '',
        service.travelFare || 0
      ]);
    });
    
    const csv = csvData.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="service-tracking-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
};

exports.getServiceTypes = async (req, res, next) => {
  try {
    const CoreService = require("../models/CoreService");
    const RepairService = require("../models/RepairService");
    
    const [coreServices, repairServices] = await Promise.all([
      CoreService.find({ isActive: true }).select('name type').lean(),
      RepairService.find({ isActive: true }).select('name type').lean()
    ]);
    
    const serviceTypes = [
      ...coreServices.map(s => ({ name: s.name, type: s.type || 'core' })),
      ...repairServices.map(s => ({ name: s.name, type: s.type || 'repair' }))
    ];
    
    res.json({ serviceTypes });
  } catch (err) {
    next(err);
  }
};


const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const QRCode = require("qrcode");
const admin = require("../controllers/adminController");
const auth = require("../middleware/authenticate");
const audit = require("../utils/audit");
const {
  listToolUsage,
  summarizeToolUsage,
  createToolUsageEntry,
  updateToolUsageEntry,
  deleteToolUsageEntry,
} = require("../utils/toolUsageManagement");

// Protect all admin API routes
router.use(auth.authenticate);
router.use(auth.requireRole("admin"));

// Customers
router.get("/customers", admin.listCustomers);
router.get("/customers/:id", admin.getCustomer);
router.get("/customers/:id/violations", admin.getCustomerViolations);
router.get("/customers/:id/bookings", admin.getCustomerBookingHistory);
router.patch("/customers/:id", admin.updateCustomer);

// Staff
router.get("/staff", admin.listStaff);
router.get("/staff/:id", admin.getStaff);
router.post("/staff", admin.createStaff);
router.patch("/staff/:id", admin.editStaff);
router.post("/staff/:id/reset-password", admin.resetStaffPassword);
router.get("/staff/:id/logs", admin.viewStaffActivityLogs);
router.get("/logs", admin.listLogs);

// Dashboard KPI summary (counts used by admin dashboard)
router.get("/analytics/summary", admin.analyticsSummary);

// Non-working days (day-offs) — admin can add/remove full-day blocked dates
router.get("/dayoffs", admin.listNonWorkingDays);
router.post("/dayoffs", admin.createNonWorkingDay);
router.delete("/dayoffs/:id", admin.deleteNonWorkingDay);
router.post("/dayoffs/sync-holidays", admin.syncPublicHolidays);

// Technician schedules
router.get("/technician-schedules", admin.listTechnicianSchedules);
router.get("/technician-schedules/:technicianId", admin.getTechnicianSchedule);
router.post("/technician-schedules", admin.upsertTechnicianSchedule);

// Technicians list for scheduling UI
router.get("/technicians", admin.listTechnicians);
router.get("/technicians/:id/calendar", admin.getTechnicianCalendar);

// Core service administration
router.get("/core-services", admin.listCoreServices);
router.get("/core-services/:id", admin.getCoreService);
router.post("/core-services", admin.createCoreService);
router.patch("/core-services/:id", admin.editCoreService);
// Repair service administration
router.get("/repair-services", admin.listRepairServices);
router.get("/repair-services/:id", admin.getRepairService);
router.post("/repair-services", admin.createRepairService);
router.patch("/repair-services/:id", admin.editRepairService);

// Service Tracking
router.get("/service-tracking", admin.getServiceTracking);
router.get("/service-tracking/:id", admin.getServiceTrackingDetail);
router.get("/service-tracking/:id/export", admin.exportServiceTracking);
router.post("/service-tracking/export", admin.exportAllServiceTracking);

// Service Types for Service Tracking
router.get("/service-types", admin.getServiceTypes);

// Inventory administration (Aircon products only)
router.get("/inventory", admin.listInventory);
router.get("/inventory/:id", admin.getInventory);
router.post("/inventory", admin.createInventory);
router.patch("/inventory/:id", admin.editInventory);
router.delete("/inventory/:id", async (req, res, next) => {
  try {
    const Inventory = require("../models/Inventory");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid inventory id" });
    }

    const item = await Inventory.findById(id);
    if (!item) return res.status(404).json({ error: "Inventory item not found" });

    item.active = false;
    await item.save();

    return res.json({ message: "Aircon product archived", item });
  } catch (err) {
    next(err);
  }
});

// Tool administration (service tools & materials)
router.get("/tools", admin.listTools);
router.get("/tools/:id", admin.getTool);
router.post("/tools", admin.createTool);
router.patch("/tools/:id", admin.editTool);
router.delete("/tools/:id", admin.deleteTool);

// ─── Stock Adjustment (audit-logged inventory changes) ────────────────────────
router.post("/tools/:id/adjust-stock", async (req, res, next) => {
  try {
    const StockAdjustment = require("../models/StockAdjustment");
    const Tool = require("../models/Tool");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const { type, delta, reason, notes } = req.body;
    const validTypes = ["stock_in", "stock_out", "adjustment", "job_usage", "return", "damage"];
    if (!validTypes.includes(type)) return res.status(400).json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` });
    if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: "Delta must be a non-zero number" });

    const result = await StockAdjustment.record({
      toolId: id,
      type,
      delta,
      adjustedBy: req.user._id,
      reason: reason || null,
      notes: notes || null,
    });

    return res.json({ message: "Stock adjusted", adjustment: result.adjustment, tool: result.tool });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get("/stock-adjustments", async (req, res, next) => {
  try {
    const StockAdjustment = require("../models/StockAdjustment");
    const { toolId, type, from, to, page = 1, limit = 50 } = req.query;

    const filter = {};
    if (toolId && mongoose.Types.ObjectId.isValid(toolId)) filter.toolId = toolId;
    if (type) filter.type = type;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to + "T23:59:59.999Z");
    }

    const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const [adjustments, total] = await Promise.all([
      StockAdjustment.find(filter)
        .populate("toolId", "itemName unit barcode category")
        .populate("adjustedBy", "name email")
        .populate("referenceId", "workOrderNumber")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      StockAdjustment.countDocuments(filter),
    ]);

    // KPI summary for today
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const todayFilter = { createdAt: { $gte: todayStart, $lte: todayEnd } };
    const [todayIn, todayOut, todayAdj] = await Promise.all([
      StockAdjustment.aggregate([
        { $match: { ...todayFilter, type: { $in: ["stock_in", "return"] } } },
        { $group: { _id: null, total: { $sum: "$delta" }, count: { $sum: 1 } } },
      ]),
      StockAdjustment.aggregate([
        { $match: { ...todayFilter, type: { $in: ["stock_out", "job_usage", "damage"] } } },
        { $group: { _id: null, total: { $sum: { $abs: "$delta" } }, count: { $sum: 1 } } },
      ]),
      StockAdjustment.aggregate([
        { $match: { ...todayFilter, type: "adjustment" } },
        { $group: { _id: null, count: { $sum: 1 } } },
      ]),
    ]);

    return res.json({
      adjustments,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
      kpi: {
        todayIn: todayIn[0]?.total || 0,
        todayInCount: todayIn[0]?.count || 0,
        todayOut: todayOut[0]?.total || 0,
        todayOutCount: todayOut[0]?.count || 0,
        todayAdjCount: todayAdj[0]?.count || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Payments administration
const paymentController = require("../controllers/paymentController");

// Site-wide settings model (admin-configured runtime values)
// (required once below; kept here only if needed)


router.get("/payments", paymentController.listPayments);
router.get("/payments/:id", paymentController.getPayment);
router.post("/payments", paymentController.createPayment);
router.patch("/payments/:id", paymentController.updatePayment);

// Ordered products / purchases administration
router.get("/purchases", admin.listPurchases);
router.get("/purchases/:id", admin.getPurchase);

// Tool usage management (admin)
router.get("/tool-usage", async (req, res, next) => {
  try {
    const result = await listToolUsage(req.query || {}, 200);
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/tool-usage/summary", async (req, res, next) => {
  try {
    const summary = await summarizeToolUsage(req.query || {});
    return res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.get("/tool-usage/options", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");
    const Tool = require("../models/Tool");

    const [bookings, technicians, tools] = await Promise.all([
      BookingService.find({ status: { $ne: "cancelled" } })
        .sort({ bookingDate: -1, startTime: -1 })
        .limit(300)
        .select("_id bookingReference bookingDate startTime customerName customerId technicianId")
        .lean(),
      Technician.find({})
        .sort({ createdAt: -1 })
        .limit(200)
        .select("_id name firstName lastName email")
        .lean(),
      Tool.find({ active: true, isStockItem: true })
        .sort({ itemName: 1 })
        .limit(600)
        .select("_id itemName unit quantity costPrice barcode")
        .lean(),
    ]);

    return res.json({ bookings, technicians, tools, inventory: tools });
  } catch (err) {
    next(err);
  }
});

router.post("/tool-usage", async (req, res, next) => {
  try {
    const result = await createToolUsageEntry({
      body: req.body || {},
      actorId: req.user && req.user._id,
      req,
      moduleName: "admin",
      allowFuelAndToolCostInput: false,
    });
    return res.status(201).json({
      message: "Tool usage recorded",
      usage: result.usage,
      inventory: result.inventory
        ? {
          _id: result.inventory._id,
          itemName: result.inventory.itemName,
          unit: result.inventory.unit,
          quantity: result.inventory.quantity,
        }
        : null,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.patch("/tool-usage/:usageId", async (req, res, next) => {
  try {
    const usage = await updateToolUsageEntry({
      usageId: req.params.usageId,
      body: req.body || {},
      actorId: req.user && req.user._id,
      req,
      moduleName: "admin",
      allowFuelAndToolCostPatch: false,
    });
    return res.json({ message: "Tool usage updated", usage });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete("/tool-usage/:usageId", async (req, res, next) => {
  try {
    const result = await deleteToolUsageEntry({
      usageId: req.params.usageId,
      actorId: req.user && req.user._id,
      req,
      moduleName: "admin",
    });
    return res.json({ message: "Tool usage deleted and stock restored", ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ─── Fare / Pricing Settings ─────────────────────────────────────────────────
const SiteSetting = require("../models/SiteSetting");

/** GET /api/admin/settings/fare  — return the current pricing values */
router.get("/settings/fare", async (req, res, next) => {
  try {
    const [settingF, settingI] = await Promise.all([
      SiteSetting.findOne({ key: "farePerKm" }).lean(),
      SiteSetting.findOne({ key: "airconInstallFee" }).lean()
    ]);
    const fareRaw = settingF && settingF.value != null ? parseFloat(settingF.value) : NaN;
    const installRaw = settingI && settingI.value != null ? parseFloat(settingI.value) : NaN;
    const farePerKm = !isNaN(fareRaw) ? fareRaw : 40;
    const airconInstallFee = !isNaN(installRaw) ? installRaw : 1500;

    return res.json({ farePerKm, airconInstallFee });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/settings/fare  — update pricing configuration */
router.patch("/settings/fare", async (req, res, next) => {
  try {
    const updates = {};
    if (req.body.farePerKm !== undefined) {
      const val = Number(req.body.farePerKm);
      if (Number.isFinite(val) && val >= 0 && val <= 10000) {
        await SiteSetting.findOneAndUpdate({ key: "farePerKm" }, { value: val }, { upsert: true, setDefaultsOnInsert: true });
        updates.farePerKm = val;
      }
    }
    if (req.body.airconInstallFee !== undefined) {
      const val = Number(req.body.airconInstallFee);
      if (Number.isFinite(val) && val >= 0 && val <= 50000) {
        await SiteSetting.findOneAndUpdate({ key: "airconInstallFee" }, { value: val }, { upsert: true, setDefaultsOnInsert: true });
        updates.airconInstallFee = val;
      }
    }

    if (Object.keys(updates).length > 0) {
      await audit.logEvent({
        actor: req.user._id,
        target: req.user._id,
        action: "settings.pricing.update",
        module: "admin",
        req,
        details: updates,
      }).catch(() => { });
    }

    return res.json({ message: "Pricing settings updated successfully", updates });
  } catch (err) {
    next(err);
  }
});

// ── Project Fee Defaults ─────────────────────────────────────────────────────
/** GET /api/admin/settings/project-fees  — return default rates for large-scale projects */
router.get("/settings/project-fees", async (req, res, next) => {
  try {
    const [laborSetting, repairStandard, repairComplex, repairMajor] = await Promise.all([
      SiteSetting.findOne({ key: "projectLaborRatePerDay" }).lean(),
      SiteSetting.findOne({ key: "repairLaborStandard" }).lean(),
      SiteSetting.findOne({ key: "repairLaborComplex" }).lean(),
      SiteSetting.findOne({ key: "repairLaborMajor" }).lean(),
    ]);
    return res.json({
      laborRatePerDay: laborSetting && typeof laborSetting.value === "number" ? laborSetting.value : 0,
      repairLaborStandard: repairStandard && typeof repairStandard.value === "number" ? repairStandard.value : 0,
      repairLaborComplex: repairComplex && typeof repairComplex.value === "number" ? repairComplex.value : 0,
      repairLaborMajor: repairMajor && typeof repairMajor.value === "number" ? repairMajor.value : 0,
    });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/settings/project-fees  — update default rates for large-scale projects */
router.patch("/settings/project-fees", async (req, res, next) => {
  try {
    const updates = {};
    const fields = {
      projectLaborRatePerDay: "laborRatePerDay",
      repairLaborStandard: "repairLaborStandard",
      repairLaborComplex: "repairLaborComplex",
      repairLaborMajor: "repairLaborMajor",
    };
    for (const [dbKey, bodyKey] of Object.entries(fields)) {
      if (req.body[bodyKey] !== undefined) {
        const val = Number(req.body[bodyKey]);
        if (Number.isFinite(val) && val >= 0 && val <= 100000) {
          await SiteSetting.findOneAndUpdate({ key: dbKey }, { value: val }, { upsert: true, setDefaultsOnInsert: true });
          updates[bodyKey] = val;
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      await audit.logEvent({
        actor: req.user._id,
        target: req.user._id,
        action: "settings.project-fees.update",
        module: "admin",
        req,
        details: updates,
      }).catch(() => {});
    }
    return res.json({ message: "Project fee defaults updated successfully", updates });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/settings/booking-policy  — update minimum advance booking notice */
router.post("/settings/booking-policy", async (req, res, next) => {
  try {
    const { minAdvanceNoticeMinutes } = req.body;
    const val = Number(minAdvanceNoticeMinutes);
    if (!Number.isFinite(val) || val < 0 || val > 10080) {
      return res.status(400).json({ error: "Invalid value. Must be 0–10080 minutes (0–7 days)." });
    }
    await SiteSetting.findOneAndUpdate(
      { key: "minAdvanceNoticeMinutes" },
      { value: val },
      { upsert: true, setDefaultsOnInsert: true }
    );
    // Invalidate the cache so the next request picks up the new value
    const { invalidateCache } = require("../utils/bookingPolicy");
    invalidateCache();

    await audit.logEvent({
      actor: req.user._id,
      target: req.user._id,
      action: "settings.booking_policy.update",
      module: "admin",
      req,
      details: { minAdvanceNoticeMinutes: val },
    }).catch(() => { });

    return res.json({ message: "Booking policy updated successfully", minAdvanceNoticeMinutes: val });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/settings/inspection-duration  — update repair inspection duration */
router.post("/settings/inspection-duration", async (req, res, next) => {
  try {
    const { inspectionDurationMinutes } = req.body;
    const val = Number(inspectionDurationMinutes);
    if (!Number.isFinite(val) || val < 30 || val > 240) {
      return res.status(400).json({ error: "Invalid value. Must be 30–240 minutes." });
    }
    await SiteSetting.findOneAndUpdate(
      { key: "inspectionDurationMinutes" },
      { value: val },
      { upsert: true, setDefaultsOnInsert: true }
    );
    // Invalidate the cache so the next request picks up the new value
    const { invalidateCache } = require("../utils/bookingPolicy");
    invalidateCache();

    await audit.logEvent({
      actor: req.user._id,
      target: req.user._id,
      action: "settings.inspection_duration.update",
      module: "admin",
      req,
      details: { inspectionDurationMinutes: val },
    }).catch(() => { });

    return res.json({ message: "Inspection duration updated successfully", inspectionDurationMinutes: val });
  } catch (err) {
    next(err);
  }
});

// ─── Leave Requests (admin review) ───────────────────────────────────────────
const LeaveRequest = require("../models/LeaveRequest");

/**
 * GET  /api/admin/leave-requests          list all leave requests
 * Query params: ?status=pending|approved|rejected|all  ?technicianId=<id>
 */
router.get("/leave-requests", async (req, res, next) => {
  try {
    const q = req.query || {};
    const filter = {};
    if (q.status && q.status !== "all") filter.status = q.status;
    if (q.technicianId && mongoose.Types.ObjectId.isValid(q.technicianId)) {
      filter.technicianId = q.technicianId;
    }
    const items = await LeaveRequest.find(filter)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    return res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/leave-requests/:id     approve or reject a leave request
 * Body: { status: "approved"|"rejected", adminNote?: string }
 */
router.patch("/leave-requests/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const leave = await LeaveRequest.findById(id);
    if (!leave) return res.status(404).json({ error: "Leave request not found" });

    const { status, adminNote } = req.body;
    if (!["approved", "rejected", "pending"].includes(status)) {
      return res.status(400).json({ error: "Status must be 'approved' or 'rejected'" });
    }

    leave.status = status;
    leave.adminNote = String(adminNote || "").trim().slice(0, 500);
    leave.reviewedBy = req.user._id;
    leave.reviewedAt = new Date();
    await leave.save();

    // Notify technician of leave decision
    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    const isApproved = status === "approved";
    await createNotification({
      type: isApproved ? "leave_approved" : "leave_rejected",
      title: isApproved ? "Leave Approved" : "Leave Rejected",
      message: isApproved
        ? `Your leave request from ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()} has been approved.`
        : `Your leave request from ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()} was not approved.${leave.adminNote ? " Reason: " + leave.adminNote : ""}`,
      userId: leave.technicianId,
      role: "technician",
      referenceId: leave._id,
      referenceModel: "LeaveRequest",
      link: "/technician/attendance",
      priority: isApproved ? "normal" : "high",
      io,
    });

    await logAction(req.user._id, leave.technicianId, `leave.${status}`, req, {
      leaveId: id,
      adminNote: leave.adminNote,
    });

    return res.json({ message: `Leave request ${status}`, leave });
  } catch (err) {
    next(err);
  }
});

// ─── Roles & Permissions ─────────────────────────────────────────────────────
router.get("/roles", admin.listRoles);
router.get("/roles/:id", admin.getRole);
router.patch("/roles/:id", admin.updateRolePermissions);
router.get("/roles/:id/users", admin.listRoleUsers);
router.patch("/users/:id/permissions", admin.setUserPermissions);
router.delete("/users/:id/permissions", admin.clearUserPermissions);
router.get("/permissions/all", admin.listAllPermissions);

// ─── Ratings Management ─────────────────────────────────────────────────────
router.get("/ratings/dashboard", async (req, res, next) => {
  try {
    const Rating = require("../models/Rating");
    const BookingService = require("../models/BookingService");

    const [ratingDocs, bookingDocs] = await Promise.all([
      Rating.find({}).populate("customerId", "firstName lastName").lean(),
      BookingService.find({ customerRating: { $ne: null } })
        .populate("customerId", "firstName lastName")
        .select("customerRating customerRatingComment createdAt customerId")
        .lean(),
    ]);

    const allRatings = [
      ...ratingDocs.map(r => ({
        score: r.score,
        comment: r.comment || "",
        createdAt: r.createdAt,
        type: r.targetType,
        customer: r.customerId ? `${r.customerId.firstName || ""} ${r.customerId.lastName || ""}`.trim() || "Customer" : "Customer",
      })),
      ...bookingDocs.map(b => ({
        score: b.customerRating,
        comment: b.customerRatingComment || "",
        createdAt: b.createdAt,
        type: "booking",
        customer: b.customerId ? `${b.customerId.firstName || ""} ${b.customerId.lastName || ""}`.trim() || "Customer" : "Customer",
      })),
    ];

    const totalRatings = allRatings.length;
    const avgRating = totalRatings > 0
      ? +(allRatings.reduce((s, r) => s + r.score, 0) / totalRatings).toFixed(1)
      : 0;
    const serviceRatings = allRatings.filter(r => r.type === "booking").length;
    const productRatings = allRatings.filter(r => r.type === "inventory").length;

    const recentRatings = allRatings
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10)
      .map(r => ({
        id: r._id || r.score,
        date: r.createdAt,
        type: r.type,
        customer: r.customer,
        score: r.score,
        comment: r.comment,
      }));

    const now = new Date();
    const trendLabels = [];
    const trendData = [];
    for (let m = 5; m >= 0; m--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
      trendLabels.push(monthStart.toLocaleString("default", { month: "short" }));
      const monthRatings = allRatings.filter(r => {
        const d = new Date(r.createdAt);
        return d >= monthStart && d < monthEnd;
      });
      trendData.push(monthRatings.length > 0
        ? +(monthRatings.reduce((s, r) => s + r.score, 0) / monthRatings.length).toFixed(1)
        : 0);
    }

    const distribution = { "5": 0, "4": 0, "3": 0, "2": 0, "1": 0 };
    for (const r of allRatings) {
      const key = String(Math.round(r.score));
      if (distribution[key] !== undefined) distribution[key]++;
    }

    const categoryBreakdown = { booking: 0, technician: 0, inventory: 0, order: 0 };
    for (const r of allRatings) {
      if (categoryBreakdown[r.type] !== undefined) categoryBreakdown[r.type]++;
    }

    res.json({
      stats: { totalRatings, avgRating, serviceRatings, productRatings },
      recentRatings,
      trend: { labels: trendLabels, data: trendData },
      distribution,
      categoryBreakdown,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/ratings/service", async (req, res, next) => {
  try {
    const Rating = require("../models/Rating");
    const BookingService = require("../models/BookingService");

    const [bookingDocs, ratingDocs] = await Promise.all([
      BookingService.find({ customerRating: { $ne: null } })
        .populate("customerId", "firstName lastName email")
        .populate("technicianId", "name userEmail")
        .sort({ createdAt: -1 })
        .lean(),
      Rating.find({ targetType: "booking" })
        .populate("customerId", "firstName lastName email")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const bookingRatings = bookingDocs.map(b => ({
      id: String(b._id),
      date: b.createdAt,
      customer: b.customerId ? `${b.customerId.firstName || ""} ${b.customerId.lastName || ""}`.trim() || "Customer" : (b.customer?.name || "Customer"),
      email: b.customerId?.email || b.customer?.email || "",
      serviceType: b.service?.name || b.serviceModel || "Service",
      technician: b.technicianId?.name || b.technician?.name || "Unassigned",
      rating: b.customerRating,
      comment: b.customerRatingComment || "",
      responded: false,
      createdAt: b.createdAt,
    }));

    const standaloneRatings = ratingDocs.map(r => ({
      id: String(r._id),
      date: r.createdAt,
      customer: r.customerId ? `${r.customerId.firstName || ""} ${r.customerId.lastName || ""}`.trim() || "Customer" : "Customer",
      email: r.customerId?.email || "",
      serviceType: "booking",
      technician: "",
      rating: r.score,
      comment: r.comment || "",
      responded: false,
      createdAt: r.createdAt,
    }));

    const allRatings = [...bookingRatings, ...standaloneRatings]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = 10;
    const totalPages = Math.max(1, Math.ceil(allRatings.length / perPage));
    const paginatedRatings = allRatings.slice((page - 1) * perPage, page * perPage);
    const ratings = paginatedRatings.map(({ createdAt, ...rest }) => rest);

    const totalRatings = allRatings.length;
    const overallRating = totalRatings > 0
      ? +(allRatings.reduce((s, r) => s + r.rating, 0) / totalRatings).toFixed(1)
      : 0;
    const satisfiedCount = allRatings.filter(r => r.rating >= 4).length;
    const satisfactionRate = totalRatings > 0 ? Math.round((satisfiedCount / totalRatings) * 100) : 0;

    const starBreakdown = { "5": 0, "4": 0, "3": 0, "2": 0, "1": 0 };
    for (const r of allRatings) {
      const key = String(Math.round(r.rating));
      if (starBreakdown[key] !== undefined) starBreakdown[key]++;
    }

    const catGroups = {};
    for (const r of allRatings) {
      const cat = r.serviceType || "Unknown";
      if (!catGroups[cat]) catGroups[cat] = { total: 0, count: 0 };
      catGroups[cat].total += r.rating;
      catGroups[cat].count++;
    }
    const categories = Object.entries(catGroups).map(([name, v]) => ({
      name,
      rating: +(v.total / v.count).toFixed(1),
      count: v.count,
    })).sort((a, b) => b.rating - a.rating);

    res.json({
      ratings,
      totalPages,
      stats: {
        overallRating,
        satisfactionRate,
        responseTime: "N/A",
        avgCompletion: "N/A",
      },
      starBreakdown,
      categories,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/ratings/aircons", async (req, res, next) => {
  try {
    const Rating = require("../models/Rating");
    const Inventory = require("../models/Inventory");
    const Brand = require("../models/Brand");

    const ratingDocs = await Rating.find({ targetType: "inventory" })
      .populate("customerId", "firstName lastName email")
      .sort({ createdAt: -1 })
      .lean();

    const inventoryIds = [...new Set(ratingDocs.map(r => String(r.targetId)))];
    let inventoryMap = {};
    if (inventoryIds.length > 0) {
      const inventoryDocs = await Inventory.find({ _id: { $in: inventoryIds } })
        .populate("brand", "name")
        .lean();
      for (const inv of inventoryDocs) {
        inventoryMap[String(inv._id)] = inv;
      }
    }

    const reviews = ratingDocs.map(r => {
      const inv = inventoryMap[String(r.targetId)];
      return {
        id: String(r._id),
        productName: inv?.modelLine || "Product",
        brand: inv?.brand?.name || "Unknown",
        customerName: r.customerId ? `${r.customerId.firstName || ""} ${r.customerId.lastName || ""}`.trim() || "Customer" : "Customer",
        customerEmail: r.customerId?.email || "",
        rating: r.score,
        title: "",
        comment: r.comment || "",
        date: r.createdAt,
        verified: true,
        productImageUrl: "/images/products/default.png",
      };
    });

    const totalReviews = reviews.length;
    const totalProducts = new Set(reviews.map(r => r.productName)).size;
    const avgRating = totalReviews > 0
      ? +(reviews.reduce((s, r) => s + r.rating, 0) / totalReviews).toFixed(1)
      : 0;

    const brandGroups = {};
    for (const r of reviews) {
      const b = r.brand;
      if (!brandGroups[b]) brandGroups[b] = { total: 0, count: 0 };
      brandGroups[b].total += r.rating;
      brandGroups[b].count++;
    }
    const brandPerformance = Object.entries(brandGroups).map(([brand, v]) => ({
      brand,
      avgRating: +(v.total / v.count).toFixed(1),
      reviewCount: v.count,
    })).sort((a, b) => b.avgRating - a.avgRating);

    const prodGroups = {};
    for (const r of reviews) {
      const key = r.productName;
      if (!prodGroups[key]) prodGroups[key] = { total: 0, count: 0, brand: r.brand };
      prodGroups[key].total += r.rating;
      prodGroups[key].count++;
    }
    const topProducts = Object.entries(prodGroups)
      .map(([name, v]) => ({
        name,
        model: name,
        brand: v.brand,
        avgRating: +(v.total / v.count).toFixed(1),
        reviewCount: v.count,
      }))
      .sort((a, b) => b.reviewCount - a.reviewCount)
      .slice(0, 5);

    res.json({
      stats: { totalProducts, avgRating, totalReviews, verifiedReviews: totalReviews },
      reviews: reviews.slice(0, 50),
      brandPerformance,
      topProducts,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/ratings/technicians", async (req, res, next) => {
  try {
    const Rating = require("../models/Rating");
    const Technician = require("../models/Technician");
    const BookingService = require("../models/BookingService");

    const techRatings = await Rating.find({ targetType: "technician" })
      .populate("customerId", "firstName lastName email")
      .sort({ createdAt: -1 })
      .lean();

    const techIds = [...new Set(techRatings.map(r => String(r.targetId)))];
    let techMap = {};
    if (techIds.length > 0) {
      const techDocs = await Technician.find({ _id: { $in: techIds } }).lean();
      for (const t of techDocs) {
        techMap[String(t._id)] = t;
      }
    }

    const techGroups = {};
    for (const r of techRatings) {
      const tid = String(r.targetId);
      if (!techGroups[tid]) techGroups[tid] = { ratings: [], total: 0, count: 0 };
      techGroups[tid].ratings.push(r);
      techGroups[tid].total += r.score;
      techGroups[tid].count++;
    }

    const technicians = Object.entries(techGroups).map(([tid, g]) => {
      const t = techMap[tid] || {};
      return {
        id: tid,
        name: t.name || "Unknown Technician",
        email: t.userEmail || "",
        department: "",
        avgRating: +(g.total / g.count).toFixed(1),
        reviewCount: g.count,
        jobsCompleted: 0,
        experience: 0,
        status: t.active ? (t.availabilityStatus || "Offline") : "inactive",
        avatar: null,
      };
    }).sort((a, b) => b.avgRating - a.avgRating);

    const totalReviews = techRatings.length;
    const totalTechnicians = technicians.length;
    const avgRating = totalReviews > 0
      ? +(techRatings.reduce((s, r) => s + r.score, 0) / totalReviews).toFixed(1)
      : 0;
    const topPerformers = technicians.filter(t => t.avgRating >= 4.5).length;

    const ratingDistribution = { "5": 0, "4": 0, "3": 0, "2": 0, "1": 0 };
    for (const r of techRatings) {
      const key = String(Math.round(r.score));
      if (ratingDistribution[key] !== undefined) ratingDistribution[key]++;
    }

    const now = new Date();
    const trendLabels = [];
    const avgRatings = [];
    const jobCounts = [];
    for (let m = 5; m >= 0; m--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
      trendLabels.push(monthStart.toLocaleString("default", { month: "short" }));
      const monthRatings = techRatings.filter(r => {
        const d = new Date(r.createdAt);
        return d >= monthStart && d < monthEnd;
      });
      avgRatings.push(monthRatings.length > 0
        ? +(monthRatings.reduce((s, r) => s + r.score, 0) / monthRatings.length).toFixed(1)
        : 0);
      jobCounts.push(monthRatings.length);
    }

    res.json({
      stats: { totalTechnicians, avgRating, totalReviews, topPerformers },
      technicians,
      ratingDistribution,
      performanceTrends: { labels: trendLabels, avgRatings, jobCounts },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/ratings/analytics", async (req, res, next) => {
  try {
    const Rating = require("../models/Rating");
    const BookingService = require("../models/BookingService");

    // Gather ratings from both Rating model and legacy BookingService.customerRating
    const [ratingDocs, bookingDocs] = await Promise.all([
      Rating.find({}).populate("customerId", "firstName lastName email").lean(),
      BookingService.find({ customerRating: { $ne: null } })
        .populate("userId", "firstName lastName email")
        .select("customerRating customerRatingComment createdAt userId")
        .lean(),
    ]);

    // Normalize all ratings into a common array
    const allRatings = [
      ...ratingDocs.map(r => ({
        score: r.score,
        comment: r.comment || "",
        createdAt: r.createdAt,
        type: r.targetType,
        customer: r.customerId ? `${r.customerId.firstName || ""} ${r.customerId.lastName || ""}`.trim() || "Customer" : "Customer",
        customerId: r.customerId?._id || r.customerId,
      })),
      ...bookingDocs.map(b => ({
        score: b.customerRating,
        comment: b.customerRatingComment || "",
        createdAt: b.createdAt,
        type: "booking",
        customer: b.userId ? `${b.userId.firstName || ""} ${b.userId.lastName || ""}`.trim() || "Customer" : "Customer",
        customerId: b.userId?._id || b.userId,
      })),
    ];

    const totalRatings = allRatings.length;
    const avgRating = totalRatings > 0
      ? +(allRatings.reduce((s, r) => s + r.score, 0) / totalRatings).toFixed(1)
      : 0;

    // Sentiment buckets (positive=4-5, neutral=3, negative=1-2)
    const positive = allRatings.filter(r => r.score >= 4).length;
    const neutral = allRatings.filter(r => r.score === 3).length;
    const negative = allRatings.filter(r => r.score <= 2).length;
    const sentimentScore = totalRatings > 0
      ? Math.round(((positive * 1 + neutral * 0.5 + negative * 0) / totalRatings) * 100)
      : 0;

    // Top rated items (by type)
    const typeGroups = {};
    for (const r of allRatings) {
      const t = r.type || "booking";
      if (!typeGroups[t]) typeGroups[t] = { total: 0, count: 0 };
      typeGroups[t].total += r.score;
      typeGroups[t].count += 1;
    }
    const topRated = Object.entries(typeGroups)
      .filter(([, v]) => v.count > 0)
      .map(([type, v]) => ({
        name: type.charAt(0).toUpperCase() + type.slice(1),
        category: type,
        type,
        rating: +(v.total / v.count).toFixed(1),
        reviews: v.count,
        trend: "stable",
      }))
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 5);

    // Weekly trend (last 4 weeks)
    const now = new Date();
    const weeklyLabels = [];
    const weeklyData = [];
    for (let w = 3; w >= 0; w--) {
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay() - w * 7);
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      const weekRatings = allRatings.filter(r => {
        const d = new Date(r.createdAt);
        return d >= weekStart && d < weekEnd;
      });
      const weekAvg = weekRatings.length > 0
        ? +(weekRatings.reduce((s, r) => s + r.score, 0) / weekRatings.length).toFixed(2)
        : 0;
      weeklyLabels.push(`Week ${4 - w}`);
      weeklyData.push(weekAvg);
    }

    // By-category sentiment breakdown
    const catMap = {};
    for (const r of allRatings) {
      const t = r.type || "booking";
      if (!catMap[t]) catMap[t] = { positive: 0, neutral: 0, negative: 0 };
      if (r.score >= 4) catMap[t].positive++;
      else if (r.score === 3) catMap[t].neutral++;
      else catMap[t].negative++;
    }

    res.json({
      totalRatings,
      avgRating,
      responseRate: totalRatings > 0 ? Math.min(100, Math.round((totalRatings / (totalRatings + 50)) * 100)) : 0,
      sentimentScore,
      topRated,
      sentiment: { positive, neutral, negative },
      weeklyTrend: { labels: weeklyLabels, data: weeklyData },
      byCategory: catMap,
      recent: allRatings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50).map(r => ({
        ...r,
        rating: r.score,
        date: r.createdAt,
        sentiment: r.score >= 4 ? "positive" : r.score <= 2 ? "negative" : "neutral",
        sentimentScore: r.score / 5,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/ratings/stats", async (req, res, next) => {
  try {
    const Rating = require("../models/Rating");
    const BookingService = require("../models/BookingService");
    const [ratingCount, bookingRatingCount] = await Promise.all([
      Rating.countDocuments({}),
      BookingService.countDocuments({ customerRating: { $ne: null } }),
    ]);

    res.json({
      totalRatings: ratingCount + bookingRatingCount,
      pending: 0,
      flagged: 0,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Company Location Settings (admin) ─────────────────────────────────────
// This endpoint persists the company/base location used for booking distance & travel fare.
// Body: { address, lat, lng }
// PATCH /api/admin/settings/company-location
router.patch("/settings/company-location", async (req, res, next) => {
  try {
    const addressRaw = typeof req.body.address === "string" ? req.body.address.trim() : "";
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);

    if (!addressRaw) {
      return res.status(400).json({ error: "Company address is required" });
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Latitude and Longitude must be valid numbers" });
    }

    const updates = {
      companyLocationAddress: addressRaw.slice(0, 500),
      companyLocationLat: lat,
      companyLocationLng: lng,
    };

    await Promise.all([
      SiteSetting.findOneAndUpdate(
        { key: "companyLocationAddress" },
        { value: updates.companyLocationAddress },
        { upsert: true, setDefaultsOnInsert: true },
      ),
      SiteSetting.findOneAndUpdate(
        { key: "companyLocationLat" },
        { value: updates.companyLocationLat },
        { upsert: true, setDefaultsOnInsert: true },
      ),
      SiteSetting.findOneAndUpdate(
        { key: "companyLocationLng" },
        { value: updates.companyLocationLng },
        { upsert: true, setDefaultsOnInsert: true },
      ),
    ]);

    await audit.logEvent({
      actor: req.user && req.user._id,
      target: req.user && req.user._id,
      action: "settings.companyLocation.update",
      module: "admin",
      req,
      details: updates,
    }).catch(() => { });

    return res.json({ message: "Company location saved successfully" });
  } catch (err) {
    next(err);
  }
});

// ─── Attendance Settings & Management ───────────────────────────────────────
const crypto = require("crypto");
const Technician = require("../models/Technician");
const TechnicianAttendance = require("../models/TechnicianAttendance");

// helper to get or create today's QR token
async function getOrCreateDailyToken() {
  const todayStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  let tokenSetting = await SiteSetting.findOne({ key: "attendance_qr_token" });

  if (tokenSetting) {
    const val = tokenSetting.value;
    if (val && val.date === todayStr) {
      return val.token;
    }
  }

  // Generate a new secure token for today
  const newToken = crypto.randomBytes(16).toString("hex");
  await SiteSetting.findOneAndUpdate(
    { key: "attendance_qr_token" },
    { value: { date: todayStr, token: newToken } },
    { upsert: true, new: true }
  );
  return newToken;
}

/** GET /api/admin/attendance/qr-token */
router.get("/attendance/qr-token", async (req, res, next) => {
  try {
    const token = await getOrCreateDailyToken();
    const todayStr = new Date().toISOString().split("T")[0];

    // Generate QR code data URL
    const qrPayload = JSON.stringify({ token: token, date: todayStr });
    const qrImage = await QRCode.toDataURL(qrPayload, { width: 220, margin: 1 });

    return res.json({ token, date: todayStr, qrImage });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/attendance/regenerate-token */
router.post("/attendance/regenerate-token", async (req, res, next) => {
  try {
    const todayStr = new Date().toISOString().split("T")[0];
    const newToken = crypto.randomBytes(16).toString("hex");
    await SiteSetting.findOneAndUpdate(
      { key: "attendance_qr_token" },
      { value: { date: todayStr, token: newToken } },
      { upsert: true }
    );

    await audit.logEvent({
      actor: req.user._id,
      target: req.user._id,
      action: "attendance.qr.regenerate",
      module: "admin",
      req,
      details: { date: todayStr }
    }).catch(() => { });

    return res.json({ message: "QR Code Token regenerated successfully", token: newToken, date: todayStr });
  } catch (err) {
    next(err);
  }
});

/** GET /api/admin/attendance/today */
router.get("/attendance/today", async (req, res, next) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    // Get all active technicians (you can filter by role or status if needed)
    const technicians = await Technician.find({}).populate("user", "firstName lastName email").lean();

    // Get all attendance records for today
    const attendanceRecords = await TechnicianAttendance.find({
      date: { $gte: startOfToday, $lte: endOfToday }
    }).lean();

    const attendanceMap = new Map(attendanceRecords.map(r => [r.technicianId.toString(), r]));

    // Batch-fetch approved leaves for today to resolve availability
    const LeaveRequest = require("../models/LeaveRequest");
    const activeLeaves = await LeaveRequest.find({
      technicianId: { $in: technicians.map(t => t._id) },
      status: "approved",
      startDate: { $lte: startOfToday },
      endDate: { $gte: startOfToday },
    }).lean();
    const leaveMap = new Map(activeLeaves.map(l => [l.technicianId.toString(), l]));

    // Resolve availability for all technicians using centralized logic
    const { resolveAvailabilityStatus, computeAttendanceStatus } = require("../utils/availability");

    const result = await Promise.all(technicians.map(async (tech) => {
      const record = attendanceMap.get(tech._id.toString()) || null;
      const leave = leaveMap.get(tech._id.toString()) || null;

      const availabilityStatus = await resolveAvailabilityStatus(tech, record, leave, { syncDb: true });

      let attendanceStatus;
      if (leave) {
        const reason = (leave.reason || "").toLowerCase();
        attendanceStatus = reason.includes("sick") ? "Sick Leave" : "On Leave";
      } else if (record) {
        attendanceStatus = record.checkOutTime ? "Checked Out" : record.status;
      } else {
        attendanceStatus = "Absent";
      }

      return {
        technicianId: tech._id,
        name: tech.name || `${tech.firstName || ""} ${tech.lastName || ""}`.trim() || (tech.user && `${tech.user.firstName || ""} ${tech.user.lastName || ""}`.trim()),
        email: tech.email || (tech.user && tech.user.email),
        attendanceStatus,
        availabilityStatus,
        checkInTime: record ? record.checkInTime : null,
        checkOutTime: record ? record.checkOutTime : null,
        method: record ? record.method : null,
        updatedBy: record ? record.updatedBy : null
      };
    }));

    return res.json(result);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/attendance/:technicianId */
router.patch("/attendance/:technicianId", async (req, res, next) => {
  try {
    const { technicianId } = req.params;
    const { status, availabilityStatus } = req.body;

    if (!mongoose.Types.ObjectId.isValid(technicianId)) {
      return res.status(400).json({ error: "Invalid technician ID" });
    }

    const tech = await Technician.findById(technicianId);
    if (!tech) return res.status(404).json({ error: "Technician not found" });

    const updates = {};

    if (status) {
      const validStatuses = ["Absent", "Present", "Late", "On Leave", "Sick Leave", "Checked Out"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: "Invalid attendance status" });
      }
      updates.attendanceStatus = status;

      // Availability auto-update based on attendance status
      if (["Present", "Late"].includes(status)) {
        // Checked in → ready to work
        tech.availabilityStatus = "Available";
        updates.availabilityStatus = "Available";
      } else if (["Absent", "Checked Out", "On Leave", "Sick Leave"].includes(status)) {
        // Not at work → offline
        tech.availabilityStatus = "Offline";
        updates.availabilityStatus = "Offline";
      }

      // Upsert daily attendance record
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);

      const updateData = {
        method: "manual",
        updatedBy: req.user._id,
        userId: tech.user,
      };

      if (status === "Checked Out") {
        updateData.status = "Present"; // Keep standard present/late status for reports
        updateData.checkOutTime = new Date();
      } else {
        updateData.status = status;
        updateData.$setOnInsert = { checkInTime: new Date() };
        updateData.$unset = { checkOutTime: 1 }; // Clear checkout if status is changed back
      }

      await TechnicianAttendance.findOneAndUpdate(
        { technicianId: tech._id, date: startOfToday },
        updateData,
        { upsert: true }
      );
    }

    if (availabilityStatus) {
      const validAvail = ["Offline", "Available", "Assigned", "On The Way", "In Progress", "Unavailable"];
      if (!validAvail.includes(availabilityStatus)) {
        return res.status(400).json({ error: "Invalid availability status" });
      }
      tech.availabilityStatus = availabilityStatus;
      updates.availabilityStatus = availabilityStatus;
    }

    await tech.save();

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "attendance.manual.update",
      module: "admin",
      req,
      details: updates
    }).catch(() => { });

    return res.json({ message: "Technician attendance/availability updated", technician: tech });
  } catch (err) {
    next(err);
  }
});

// ─── Repair Queue Management ────────────────────────────────────────────
const BookingService = require("../models/BookingService");
const Assignment = require("../models/Assignment");

/**
 * GET /api/admin/repair-queue
 * Returns repair requests grouped by status for the admin repair queue.
 * Query: ?status=all|repair_requested|pending_inspection|inspection_scheduled|...&page=1&limit=20&search=
 */
router.get("/repair-queue", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const { status, search, page = 1, limit = 20 } = req.query;
    const filter = { serviceModel: "RepairService" };

    if (status && status !== "all") {
      const statuses = String(status).split(",").map(s => s.trim()).filter(Boolean);
      filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
    } else {
      // Default: show all active repair statuses
      filter.status = {
        $in: [
          "repair_requested", "pending_inspection", "inspection_scheduled",
          "inspection_in_progress", "inspection_completed", "awaiting_approval",
          "repair_approved", "repair_declined", "waiting_parts", "parts_reserved",
          "ready_for_repair", "repair_scheduled", "repair_in_progress",
          "repair_completed", "under_warranty", "warranty_claim"
        ]
      };
    }

    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|\\[\\]\\\\]/g, ""), "i");
      filter.$or = [
        { bookingReference: re },
        { "customer.name": re },
        { "customer.email": re },
        { "unitInfo.brand": re },
        { "unitInfo.problemDescription": re },
      ];
    }

    const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const lim = Math.min(100, Math.max(1, parseInt(limit)));

    const [items, total] = await Promise.all([
      BookingService.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      BookingService.countDocuments(filter),
    ]);

    // Get assigned technician info for each booking
    const technicianIds = items.filter(b => b.technicianId).map(b => b.technicianId);
    let techMap = {};
    if (technicianIds.length > 0) {
      const Technician = require("../models/Technician");
      const techs = await Technician.find({ _id: { $in: technicianIds } }).select("_id name").lean();
      techMap = techs.reduce((m, t) => { m[String(t._id)] = t.name; return m; }, {});
    }

    const enriched = items.map(b => ({
      ...b,
      technicianName: techMap[String(b.technicianId)] || null,
    }));

    return res.json({ items: enriched, total, page: parseInt(page), pages: Math.ceil(total / lim) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/repair-queue/stats
 * Returns aggregate counts for each repair status.
 */
router.get("/repair-queue/stats", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");

    const pipeline = [
      { $match: { serviceModel: "RepairService" } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ];
    const results = await BookingService.aggregate(pipeline);

    const stats = {
      repair_requested: 0,
      pending_inspection: 0,
      inspection_scheduled: 0,
      inspection_in_progress: 0,
      inspection_completed: 0,
      awaiting_approval: 0,
      repair_approved: 0,
      repair_declined: 0,
      waiting_parts: 0,
      parts_reserved: 0,
      ready_for_repair: 0,
      repair_scheduled: 0,
      repair_in_progress: 0,
      repair_completed: 0,
      under_warranty: 0,
      warranty_claim: 0,
      total: 0,
    };

    for (const r of results) {
      if (stats[r._id] !== undefined) {
        stats[r._id] = r.count;
        stats.total += r.count;
      }
    }

    return res.json(stats);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/admin/repair-queue/:id/status
 * Admin updates repair booking status (e.g. assign for inspection, mark parts ready, etc.)
 * Body: { status, technicianId?, notes? }
 */
router.patch("/repair-queue/:id/status", async (req, res, next) => {
  try {
    const mongoose = require("mongoose");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const { status: newStatus, technicianId, notes } = req.body;
    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Repair booking not found" });

    // Update status
    if (newStatus) {
      booking.status = newStatus;
    }

    // Assign technician for inspection
    if (technicianId) {
      const Technician = require("../models/Technician");
      const tech = await Technician.findById(technicianId).lean();
      if (!tech) return res.status(404).json({ error: "Technician not found" });

      booking.technicianId = tech._id;
      if (!booking.technician) {
        booking.technician = {};
      }
      booking.technician.name = tech.name || `${tech.firstName || ""} ${tech.lastName || ""}`.trim();
      booking.technician.email = tech.userEmail || tech.email || "";
      booking.technician.phone = tech.phone || "";

      // Create assignment if inspection_scheduled
      if (newStatus === "inspection_scheduled") {
        await Assignment.create({
          bookingId: booking._id,
          technicianId: tech._id,
          customerName: booking.customer?.name || "Customer",
          customerPhone: booking.customer?.phone || "",
          customerEmail: booking.customer?.email || "",
          serviceType: "repair",
          serviceName: "Repair Service — Inspection",
          bookingDate: booking.preferredDate || booking.bookingDate,
          startTime: booking.preferredTime || booking.startTime,
          address: booking.location?.address || "",
          coordinates: booking.location?.coordinates || {},
          estimatedFee: 0,
          status: "pending_acceptance",
          priority: req.body.priority || "normal",
        });

        // Notify technician
        const { createNotification } = require("../utils/notify");
        const io = req.app.get("io");
        await createNotification({
          type: "assignment_new",
          title: "Inspection Assignment",
          message: `You have been assigned to inspect a repair: ${booking.unitInfo?.brand || ""} ${booking.unitInfo?.unitType || ""} — ${(booking.unitInfo?.problemDescription || "").substring(0, 100)}`,
          userId: tech.user || tech._id,
          role: "technician",
          referenceId: booking._id,
          referenceModel: "BookingService",
          link: "/technician/assignments",
          priority: "high",
          io,
        });
      }
    }

    // Add note
    if (notes) {
      const note = `[Admin] ${notes}`;
      if (booking.notes) {
        booking.notes += `\n${note}`;
      } else {
        booking.notes = note;
      }
    }

    // Status history
    booking.recordStatusHistory({
      fromStatus: booking.status,
      toStatus: newStatus || booking.status,
      reason: notes || `Status updated to ${newStatus}`,
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: req.user.firstName || req.user.name || "Admin",
    });

    await booking.save();

    await audit.logEvent({
      actor: req.user._id,
      target: booking._id,
      action: "repair_queue.status.update",
      module: "admin",
      req,
      details: { newStatus: newStatus || booking.status, technicianId },
    }).catch(() => { });

    return res.json({ message: "Repair booking updated", booking });
  } catch (err) {
    next(err);
  }
});

// ─── Warranty Management ────────────────────────────────────────────────

/**
 * GET /api/admin/warranties
 * Returns bookings with active warranty or warranty claims.
 */
router.get("/warranties", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const { status, search, page = 1, limit = 20 } = req.query;
    const filter = {};

    if (status && status !== "all") {
      filter.status = status;
    } else {
      filter.status = { $in: ["under_warranty", "warranty_claim"] };
    }

    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|\\[\\]\\\\]/g, ""), "i");
      filter.$or = [
        { bookingReference: re },
        { "customer.name": re },
      ];
    }

    const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const lim = Math.min(100, Math.max(1, parseInt(limit)));

    const [items, total] = await Promise.all([
      BookingService.find(filter)
        .sort({ "warranty.endDate": 1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      BookingService.countDocuments(filter),
    ]);

    return res.json({ items, total, page: parseInt(page), pages: Math.ceil(total / lim) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/warranties/stats
 * Returns warranty statistics.
 */
router.get("/warranties/stats", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");

    const [activeWarranty, warrantyClaims, expiringSoon] = await Promise.all([
      BookingService.countDocuments({ status: "under_warranty" }),
      BookingService.countDocuments({ status: "warranty_claim" }),
      BookingService.countDocuments({
        status: "under_warranty",
        "warranty.endDate": {
          $gte: new Date(),
          $lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      }),
    ]);

    return res.json({ activeWarranty, warrantyClaims, expiringSoon });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/repair-queue/:id
 * Returns a single repair booking detail.
 */
router.get("/repair-queue/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(id).lean();
    if (!booking) return res.status(404).json({ error: "Repair booking not found" });

    return res.json(booking);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/repair-queue/:id/confirm
 * Confirms a repair request and moves it to the assignment queue.
 * Status: repair_requested → awaiting_assignment
 */
router.post("/repair-queue/:id/confirm", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Repair booking not found" });

    if (booking.status !== "repair_requested") {
      return res.status(400).json({ error: `Cannot confirm repair from status "${booking.status}". Expected "repair_requested".` });
    }

    booking.status = "awaiting_assignment";
    booking.recordStatusHistory({
      fromStatus: "repair_requested",
      toStatus: "awaiting_assignment",
      reason: "Repair request confirmed and moved to assignment queue",
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: req.user.firstName || req.user.name || "Admin",
    });
    await booking.save();

    return res.json({ message: "Repair confirmed and moved to assignment queue", booking });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/repair-queue/:id/assign-technician
 * Assigns a technician to a confirmed repair request and schedules inspection.
 * Status: awaiting_assignment → inspection_scheduled
 */
router.post("/repair-queue/:id/assign-technician", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");
    const Assignment = require("../models/Assignment");

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Repair booking not found" });

    if (booking.status !== "awaiting_assignment") {
      return res.status(400).json({ error: `Cannot assign technician from status "${booking.status}". Expected "awaiting_assignment".` });
    }

    const { technicianId, scheduledDate, scheduledTime, priority, notes } = req.body;
    if (!technicianId) return res.status(400).json({ error: "Technician ID is required" });
    if (!scheduledDate) return res.status(400).json({ error: "Inspection date is required" });

    const tech = await Technician.findById(technicianId);
    if (!tech) return res.status(404).json({ error: "Technician not found" });

    // Enterprise: Allow priority override during assignment
    if (priority && ['low', 'medium', 'high', 'critical'].includes(priority)) {
      booking.priority = priority;
    }

    // Set inspection schedule
    booking.inspection = {
      scheduledDate: new Date(scheduledDate),
      scheduledTime: scheduledTime || "",
      technicianId: tech._id,
    };

    // Record triage decision
    booking.triage = {
      assignedBy: req.user._id,
      assignedAt: new Date(),
      technicianSkillMatch: true,
      technicianAvailabilityConfirmed: true,
      customerPreferredDateHonored: booking.preferredDate
        ? new Date(scheduledDate).toDateString() === new Date(booking.preferredDate).toDateString()
        : true,
      notes: notes || ''
    };

    // Create assignment for the technician
    const slaDeadline = new Date();
    slaDeadline.setHours(slaDeadline.getHours() + 2);

    const assignment = new Assignment({
      bookingId: booking._id,
      technicianId: tech._id,
      bookingDate: new Date(scheduledDate),
      startTime: scheduledTime || "",
      status: "pending_acceptance",
      priority: priority === 'critical' ? 'urgent' : priority === 'high' ? 'high' : 'normal',
      slaDeadline,
      customerName: booking.customer?.name || "",
      customerPhone: booking.customer?.phone || "",
      customerEmail: booking.customer?.email || "",
      address: booking.location?.address || "",
      serviceName: `Inspection: ${booking.unitInfo?.unitType || "Repair"}`,
      serviceType: "repair",
      estimatedFee: booking.initialCost || 0,
      notes: [{ text: `Repair inspection scheduled by admin. Priority: ${booking.priority}`, byName: req.user.name || "Admin" }],
    });
    await assignment.save();

    booking.assignmentId = assignment._id;
    booking.technicianId = tech._id;

    // Record status transition
    booking.recordStatusHistory({
      fromStatus: "awaiting_assignment",
      toStatus: "inspection_scheduled",
      reason: `Technician ${tech.name} assigned for inspection on ${scheduledDate}`,
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: req.user.name || req.user.email || "Admin",
      metadata: {
        technicianId: tech._id,
        technicianName: tech.name,
        scheduledDate,
        scheduledTime,
        priority: booking.priority,
      }
    });

    booking.status = "inspection_scheduled";
    await booking.save();

    // Notify technician
    if (global.io) {
      global.io.to(`tech:${tech._id}`).emit("booking:assigned", {
        assignmentId: assignment._id,
        bookingId: booking._id,
        message: `New repair inspection assigned for ${new Date(scheduledDate).toLocaleDateString()}`,
      });
    }

    // Email: Notify Technician of Assignment
    try {
      const User = require("../models/User");
      const { sendTechnicianNotificationEmail } = require("../utils/mailer");
      const techUser = tech.user ? await User.findById(tech.user).lean() : null;
      const techEmail = techUser?.email;
      const techFullName = ((tech.firstName || '') + ' ' + (tech.lastName || '')).trim() || tech.name || 'Technician';

      if (techEmail) {
        const dateLabel = scheduledDate ? new Date(scheduledDate).toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD';
        const timeLabel = scheduledTime || 'TBD';
        sendTechnicianNotificationEmail({
          to: techEmail,
          technicianName: techFullName,
          customerName: booking.customer?.name || 'Customer',
          bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: `Inspection: ${booking.unitInfo?.unitType || 'Repair'}`,
          dateLabel,
          timeLabel,
          totalLabel: `₱${Number(booking.initialCost || 0).toLocaleString()}`,
          locationAddress: booking.location?.address || '',
          issueDescription: booking.issueDescription || '',
        }).catch(err => console.error('[MAILER] Failed to send repair assignment email:', err.message));
      }
    } catch (mailErr) {
      console.error('[MAILER] Repair assignment email error:', mailErr.message);
    }

    return res.json({ message: `Technician ${tech.name} assigned for inspection`, booking, assignment });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/repair-queue/:id/approve-quotation
 * Marks the quotation as customer-approved and sets status to repair_approved.
 */
router.post("/repair-queue/:id/approve-quotation", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Repair booking not found" });

    booking.status = "repair_approved";
    if (!booking.approval) booking.approval = {};
    booking.approval.status = "approved";
    booking.approval.decidedAt = new Date();
    booking.recordStatusHistory({
      fromStatus: "awaiting_approval",
      toStatus: "repair_approved",
      reason: "Quotation approved by customer",
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: req.user.firstName || req.user.name || "Admin",
    });
    await booking.save();

    // Reserve stock for approved quotation parts
    try {
      const StockReservation = require("../models/StockReservation");
      const parts = booking.quotation?.parts || [];
      if (parts.length > 0) {
        const { reservations, insufficientStock } = await StockReservation.reserveForBooking({
          bookingId: booking._id,
          parts,
          reservedBy: req.user._id,
        });
        if (insufficientStock.length > 0) {
          console.warn(`[STOCK] Insufficient stock for booking ${booking._id}:`, insufficientStock);
        }
      }
    } catch (e) { console.error('[STOCK] Reservation error:', e.message); }

    return res.json({ message: "Quotation approved", booking });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/repair-queue/:id/decline-quotation
 * Marks the quotation as customer-declined and closes the booking.
 * Only inspection fee is collected.
 */
router.post("/repair-queue/:id/decline-quotation", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Repair booking not found" });

    if (booking.status !== "awaiting_approval") {
      return res.status(400).json({ error: `Cannot decline quotation from status "${booking.status}". Expected "awaiting_approval".` });
    }

    booking.status = "repair_declined";
    if (!booking.approval) booking.approval = {};
    booking.approval.status = "declined";
    booking.approval.decidedAt = new Date();
    booking.approval.reason = req.body.reason || "Quotation declined by customer";

    // Only inspection fee is collected
    booking.balanceAmount = 0;
    booking.balanceCollected = true;

    booking.recordStatusHistory({
      fromStatus: "awaiting_approval",
      toStatus: "repair_declined",
      reason: req.body.reason || "Quotation declined by customer",
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: req.user.firstName || req.user.name || "Admin",
    });
    await booking.save();

    // Release any reserved stock
    try {
      const StockReservation = require("../models/StockReservation");
      await StockReservation.releaseForBooking(booking._id);
    } catch (e) { console.error('[STOCK] Release error:', e.message); }

    return res.json({ message: "Quotation declined. Only inspection fee collected.", booking });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/repair-queue/:id/schedule-repair
 * Schedules the repair appointment.
 * Body: { repairDate }
 */
router.post("/repair-queue/:id/schedule-repair", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });
    const { repairDate } = req.body;
    if (!repairDate) return res.status(400).json({ error: "Repair date is required" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Repair booking not found" });

    booking.status = "repair_scheduled";
    booking.bookingDate = new Date(repairDate);
    booking.recordStatusHistory({
      fromStatus: booking.status,
      toStatus: "repair_scheduled",
      reason: `Repair scheduled for ${repairDate}`,
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: req.user.firstName || req.user.name || "Admin",
    });
    await booking.save();

    return res.json({ message: "Repair scheduled", booking });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/repair-queue/:id/cancel
 * Cancel a repair booking.
 */
router.post("/repair-queue/:id/cancel", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Repair booking not found" });

    const terminalStatuses = ["repair_completed", "closed", "cancelled"];
    if (terminalStatuses.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot cancel repair in "${booking.status}" status` });
    }

    const previousStatus = booking.status;
    booking.status = "cancelled";
    booking.cancellationReason = req.body.reason || "Cancelled by admin";
    booking.recordStatusHistory({
      fromStatus: previousStatus,
      toStatus: "cancelled",
      reason: booking.cancellationReason,
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: req.user.firstName || req.user.name || "Admin",
    });
    await booking.save();

    // Release any reserved stock
    try {
      const StockReservation = require("../models/StockReservation");
      await StockReservation.releaseForBooking(booking._id);
    } catch (e) { console.error('[STOCK] Release error:', e.message); }

    return res.json({ message: "Repair booking cancelled", booking });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/repair-queue/:id/receive-parts
 * Mark parts as received and update booking status.
 * Body: { toolIds: string[] } - Optional: specific tool IDs received. If empty, marks all items as received.
 */
router.post("/repair-queue/:id/receive-parts", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const BookingService = require("../models/BookingService");
    const PartsRequest = require("../models/PartsRequest");
    const StockReservation = require("../models/StockReservation");

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Repair booking not found" });

    if (booking.status !== "waiting_parts") {
      return res.status(400).json({ error: `Booking is not in waiting_parts status. Current status: ${booking.status}` });
    }

    // Find the parts request for this booking
    const partsRequest = await PartsRequest.findOne({ bookingId: id, status: { $in: ["pending", "procuring"] } });
    if (!partsRequest) {
      return res.status(404).json({ error: "No active parts request found for this booking" });
    }

    const { toolIds } = req.body;

    // Mark items as received
    if (toolIds && Array.isArray(toolIds) && toolIds.length > 0) {
      for (const toolId of toolIds) {
        await PartsRequest.receiveItem(partsRequest._id, toolId);
      }
    } else {
      // Mark all items as received
      for (const item of partsRequest.items) {
        if (item.toolId) {
          await PartsRequest.receiveItem(partsRequest._id, item.toolId);
        }
      }
    }

    // Check if all items are now received
    const updatedRequest = await PartsRequest.findById(partsRequest._id);
    const allReceived = updatedRequest.items.every(i => i.status === "received");

    if (allReceived) {
      // Update booking status to ready_for_repair
      const prevStatus = booking.status;
      booking.status = "ready_for_repair";
      booking.recordStatusHistory({
        fromStatus: prevStatus,
        toStatus: "ready_for_repair",
        reason: "All parts received — ready for repair",
        changedBy: req.user._id,
        changedByModel: "User",
        changedByName: req.user.firstName || req.user.name || "Admin",
      });

      // Store the parts reservation info
      booking.partsRequest = {
        ...booking.partsRequest,
        status: "received",
        completedAt: new Date(),
        completedBy: req.user._id,
      };

      await booking.save();

      // Try to reserve stock now that parts are available
      try {
        const parts = booking.quotation?.parts || [];
        if (parts.length > 0) {
          await StockReservation.reserveForBooking({
            bookingId: booking._id,
            parts,
            reservedBy: req.user._id,
          });
        }
      } catch (e) {
        console.error('[STOCK] Reservation error after parts received:', e.message);
      }

      // Notify technician
      if (global.io && booking.technicianId) {
        const Technician = require("../models/Technician");
        const tech = await Technician.findById(booking.technicianId);
        if (tech?.user) {
          global.io.to(`user:${tech.user}`).emit("booking:updated", {
            bookingId: booking._id,
            status: booking.status,
            message: `Parts received for ${booking.workOrderNumber || booking._id}. Ready for scheduling.`,
          });
        }
      }

      // Notify customer
      if (global.io && booking.customerId) {
        global.io.to(`customer:${booking.customerId}`).emit("booking:updated", {
          bookingId: booking._id,
          status: booking.status,
          message: `Parts for your repair have arrived! We will contact you to schedule the repair.`,
        });
      }

      // Send email to customer
      try {
        const { sendEmail } = require("../utils/mailer");
        if (booking.customer?.email) {
          const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL || 'https://racs.com';
          await sendEmail(booking.customer.email, "Parts Received – Ready to Schedule Repair",
            `Dear ${booking.customer.name || 'Customer'},

Great news! The required parts for your repair have arrived and are now in stock.

Your Repair Quotation:
${(booking.quotation?.parts || []).map(p => `  - ${p.name}: ₱${(p.cost || 0).toLocaleString()} x ${p.quantity || 1}`).join('\n')}
Labor: ₱${(booking.quotation?.laborCost || 0).toLocaleString()}
─────────────────────
Total: ₱${(booking.quotation?.totalCost || 0).toLocaleString()}

We will contact you shortly to schedule your repair appointment.

You can view your booking details here:
${baseUrl}/book-history?highlight=${booking._id}

Work Order: ${booking.workOrderNumber || `#${String(booking._id).slice(-6).toUpperCase()}`}

If you have any questions, please contact our support team.

Best regards,
RACS Repair Team`);
        }
      } catch (e) { console.error('[MAILER] Parts received email error:', e.message); }

      return res.json({ message: "All parts received. Booking ready for scheduling.", booking, partsRequest: updatedRequest });
    } else {
      await booking.save();
      return res.json({ message: "Parts marked as received. Waiting for remaining parts.", booking, partsRequest: updatedRequest });
    }
  } catch (err) {
    console.error("Receive parts error:", err);
    next(err);
  }
});

/**
 * POST /api/admin/repair-queue/:id/reject
 * Reject a repair request (from repair_requested status).
 * Body: { reason }
 */
router.post("/repair-queue/:id/reject", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: "Rejection reason is required" });
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Repair booking not found" });

    if (booking.status !== "repair_requested") {
      return res.status(400).json({ error: `Cannot reject repair from status "${booking.status}". Expected "repair_requested".` });
    }

    booking.status = "rejected";
    booking.rejectionReason = reason;
    booking.rejectedAt = new Date();
    booking.rejectedBy = req.user._id;
    booking.recordStatusHistory({
      fromStatus: "repair_requested",
      toStatus: "rejected",
      reason: reason,
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: req.user.firstName || req.user.name || "Admin",
    });
    await booking.save();

    return res.json({ message: "Repair request rejected", booking });
  } catch (err) {
    next(err);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// REPAIR SCHEDULING QUEUE — "Schedule Repair Later" management
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/repair-scheduling-queue
 * Lists all bookings where customer chose "Schedule Repair Later".
 * Returns original inspector, inspection date, preferred dates/time, and status.
 */
router.get("/repair-scheduling-queue", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");

    // Find bookings where customer chose "later" — they have preferredSchedule set
    // and are in repair_approved / waiting_parts status (waiting for admin to schedule)
    const bookings = await BookingService.find({
      "repairSchedule.preference": "later",
      status: { $in: ["repair_approved", "repair_scheduled", "waiting_parts", "ready_for_repair"] },
    })
      .populate("technicianId", "name user")
      .populate("customerId", "name email phone")
      .populate("inspection.technicianId", "name user")
      .sort({ "preferredSchedule.submittedAt": -1 })
      .lean();

    // Enrich with technician availability data and parts/stock info
    const StockReservation = require("../models/StockReservation");
    const PartsRequest = require("../models/PartsRequest");
    const Tool = require("../models/Tool");
    const enriched = [];
    for (const b of bookings) {
      const originalInspector = b.inspection?.technicianId || b.technicianId;

      // Determine parts stock status
      let partsStatus = 'none';
      let partsRequestStatus = null;
      const hasParts = (b.quotation?.parts || []).length > 0;
      if (hasParts) {
        const reservationCount = await StockReservation.countDocuments({
          bookingId: b._id,
          status: "reserved",
        });
        const partsReq = await PartsRequest.findOne({
          bookingId: b._id,
          status: { $in: ["pending", "procuring"] },
        }).lean();

        if (reservationCount > 0) {
          partsStatus = 'reserved';
        } else if (partsReq) {
          partsStatus = 'waiting_parts';
          partsRequestStatus = partsReq.status;
        } else {
          partsStatus = 'pending_check';
        }
      }

      // Enrich each quotation part with stock availability
      const enrichedParts = await Promise.all((b.quotation?.parts || []).map(async (p) => {
        const qty = p.quantity || 1;
        let currentStock = 0;
        let toolFound = false;

        // Prefer the linked tool if it has enough stock
        if (p.toolId) {
          const tool = await Tool.findById(p.toolId).select("quantity active").lean();
          if (tool && tool.active !== false && (tool.quantity || 0) >= qty) {
            currentStock = tool.quantity || 0;
            toolFound = true;
          }
        }

        // Otherwise find the active tool with the most matching name that can fulfill
        if (!toolFound) {
          const escaped = (p.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (escaped) {
            const regex = new RegExp(escaped.replace(/\\s+/g, '.*'), 'i');
            const candidates = await Tool.find({ itemName: regex, active: true })
              .select("quantity").sort({ quantity: -1 }).lean();
            const best = candidates.find(t => (t.quantity || 0) >= qty) || candidates[0];
            if (best) {
              currentStock = best.quantity || 0;
            }
          }
        }

        return {
          ...p,
          currentStock,
          needsProcurement: currentStock < qty,
        };
      }));

      enriched.push({
        _id: b._id,
        workOrderNumber: b.workOrderNumber || `WO-${String(b._id).slice(-6).toUpperCase()}`,
        customer: b.customer || { name: b.customerId?.name, email: b.customerId?.email, phone: b.customerId?.phone },
        originalInspector: originalInspector ? {
          _id: originalInspector._id,
          name: originalInspector.name,
        } : null,
        inspectionDate: b.inspection?.completedAt || b.inspection?.scheduledDate,
        preferredDates: b.preferredSchedule?.dates || [],
        preferredTimeWindow: b.preferredSchedule?.timeWindow || 'any',
        submittedAt: b.preferredSchedule?.submittedAt,
        status: b.status,
        scheduledDate: b.schedulingRequest?.scheduledDate || null,
        unitInfo: b.unitInfo,
        quotation: { ...b.quotation, parts: enrichedParts },
        priority: b.priority || 'medium',
        partsStatus,
        partsRequestStatus,
        stockAvailable: partsStatus === 'reserved' || partsStatus === 'none',
      });
    }

    return res.json({ bookings: enriched });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/repair-scheduling-queue/:id/check-and-procure-parts
 * Enterprise: Checks quotation parts against inventory, reserves available stock,
 * and creates a parts purchase request for any items with insufficient stock.
 */
router.post("/repair-scheduling-queue/:id/check-and-procure-parts", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const BookingService = require("../models/BookingService");
    const Tool = require("../models/Tool");
    const StockReservation = require("../models/StockReservation");
    const PartsRequest = require("../models/PartsRequest");

    const booking = await BookingService.findById(id)
      .populate("technicianId", "name")
      .populate("customerId", "name email");
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const parts = (booking.quotation?.parts || []).filter(p => p.name);
    if (parts.length === 0) {
      return res.status(400).json({ error: "No parts found in quotation." });
    }

    // Step 1 & 2: Match each quotation part to an inventory Tool and persist the link
    const matchedParts = [];
    const insufficientStock = [];
    let bookingModified = false;

    for (const p of parts) {
      const qty = p.quantity || 1;
      let tool = null;

      // Use the linked tool if it has enough stock
      if (p.toolId && mongoose.Types.ObjectId.isValid(p.toolId)) {
        const linkedTool = await Tool.findById(p.toolId).lean();
        if (linkedTool && linkedTool.active !== false && (linkedTool.quantity || 0) >= qty) {
          tool = linkedTool;
        }
      }

      // Otherwise fuzzy-match by name, preferring a tool that can fulfill the quantity
      if (!tool && p.name) {
        const escaped = String(p.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped.replace(/\s+/g, '.*'), 'i');
        const candidates = await Tool.find({ itemName: regex, active: true }).sort({ quantity: -1 }).lean();
        tool = candidates.find(t => (t.quantity || 0) >= qty) || candidates[0] || null;
      }

      if (tool) {
        p.toolId = tool._id;
        p.currentStock = tool.quantity || 0;
        bookingModified = true;
        matchedParts.push({ ...p, toolId: tool._id, currentStock: tool.quantity, itemName: tool.itemName });
      } else {
        insufficientStock.push({ name: p.name, itemName: p.name, quantity: qty, cost: p.cost || 0, currentStock: 0, toolId: null });
      }
    }

    if (bookingModified) {
      booking.markModified('quotation.parts');
      await booking.save();
    }

    // Step 3: Reserve stock for all matched parts via StockReservation
    let reserveInsufficient = [];
    let reservedToolIds = [];
    try {
      const result = await StockReservation.reserveForBooking({
        bookingId: booking._id,
        parts: matchedParts,
        reservedBy: req.user._id,
      });
      reserveInsufficient = result.insufficientStock || [];
      reservedToolIds = (result.reservations || []).map(r => String(r.toolId));
    } catch (e) {
      console.error('[STOCK] Reservation error:', e.message);
      // Mark any matched parts that weren't reserved as insufficient
      reserveInsufficient = matchedParts.filter(p => p.toolId && !reservedToolIds.includes(String(p.toolId))).map(p => ({
        toolId: p.toolId,
        itemName: p.itemName || p.name,
        requested: p.quantity || 1,
        available: 0,
      }));
    }

    insufficientStock = [...insufficientStock, ...reserveInsufficient];

    // Step 4: Create PartsRequest for insufficient stock items
    let partsRequest = null;
    if (insufficientStock.length > 0) {
      try {
        const customerName = booking.customer?.name || booking.customerId?.name || 'Customer';
        const techName = booking.technicianId?.name || 'Technician';
        partsRequest = await PartsRequest.createFromInsufficientStock({
          bookingId: booking._id,
          workOrderNumber: booking.workOrderNumber || `WO-${String(booking._id).slice(-6).toUpperCase()}`,
          customerId: booking.customerId?._id || booking.customerId,
          customerName,
          technicianId: booking.technicianId?._id || booking.technicianId,
          technicianName: techName,
          items: insufficientStock.map(i => ({
            toolId: i.toolId,
            itemName: i.itemName,
            requested: i.requested,
            available: i.available,
          })),
          requestedBy: req.user._id,
        });
      } catch (e) {
        console.error('[PARTS_REQUEST] Create error:', e.message);
      }
    }

    // Step 5: Update booking status
    const hasReservations = matchedParts.some(p => p.toolId && !insufficientStock.some(i => String(i.toolId) === String(p.toolId)));
    const prevStatus = booking.status;
    if (insufficientStock.length === 0) {
      // All stock was reserved — ready for scheduling
      if (prevStatus !== "repair_approved" && prevStatus !== "ready_for_repair") {
        booking.status = "repair_approved";
        booking.recordStatusHistory({
          fromStatus: prevStatus,
          toStatus: "repair_approved",
          reason: "Parts stock verified and reserved",
          changedBy: req.user._id,
          changedByModel: "User",
          changedByName: req.user.firstName || req.user.name || "Admin",
        });
      }
      if (!booking.approval) booking.approval = {};
      booking.approval.status = "approved";
      booking.approval.decidedAt = booking.approval.decidedAt || new Date();
    } else {
      // Some parts need to be ordered
      if (prevStatus !== "waiting_parts") {
        booking.status = "waiting_parts";
        booking.recordStatusHistory({
          fromStatus: prevStatus,
          toStatus: "waiting_parts",
          reason: `Insufficient stock: ${insufficientStock.map(i => i.itemName).join(', ')}`,
          changedBy: req.user._id,
          changedByModel: "User",
          changedByName: req.user.firstName || req.user.name || "Admin",
        });
      }
    }

    await booking.save();

    // Notify
    if (global.io) {
      if (insufficientStock.length > 0) {
        global.io.to("admin").emit("booking:updated", {
          bookingId: booking._id,
          status: booking.status,
          message: `Parts request created for ${booking.workOrderNumber || booking._id}`,
        });
      } else {
        global.io.to("admin").emit("booking:updated", {
          bookingId: booking._id,
          status: booking.status,
          message: `Parts reserved for ${booking.workOrderNumber || booking._id} — ready for scheduling`,
        });
      }
    }

    const allReady = insufficientStock.length === 0;
    return res.json({
      success: true,
      allReady,
      status: booking.status,
      message: allReady
        ? `All parts verified and reserved. Ready for scheduling.`
        : `Stock reserved for available items. Parts request created for ${insufficientStock.length} item(s): ${insufficientStock.map(i => i.itemName).join(', ')}.`,
      details: {
        totalParts: parts.length,
        reserved: matchedParts.filter(p => p.toolId && !insufficientStock.some(i => String(i.toolId) === String(p.toolId))).length,
        insufficient: insufficientStock.map(i => ({ itemName: i.itemName, requested: i.requested, available: i.available })),
        partsRequestCreated: !!partsRequest,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/repair-scheduling-queue/:id/link-procured-part", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const { toolId, partName, quantity } = req.body || {};
    if (!toolId || !mongoose.Types.ObjectId.isValid(toolId)) return res.status(400).json({ error: "toolId required" });
    if (!partName || String(partName).trim() === "") return res.status(400).json({ error: "partName required" });

    const BookingService = require("../models/BookingService");
    const Tool = require("../models/Tool");

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const targetName = String(partName).trim().toLowerCase();
    const parts = booking.quotation?.parts || [];
    let matched = parts.find(p => String(p.name || p.itemName || '').trim().toLowerCase() === targetName);
    if (!matched) {
      matched = parts.find(p => {
        const n = String(p.name || p.itemName || '').trim().toLowerCase();
        return n && (n.includes(targetName) || targetName.includes(n));
      });
    }

    if (!matched) return res.status(404).json({ error: "Quotation part not found" });

    const tool = await Tool.findById(toolId).select("quantity").lean();
    matched.toolId = toolId;
    matched.currentStock = Number(quantity) || (tool?.quantity || 0);

    booking.markModified('quotation.parts');
    await booking.save();

    return res.json({ success: true, message: "Part linked to booking", part: matched });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/repair-scheduling-queue/:id/quotation-parts
 * Returns quotation parts for a booking (used by the Repair Parts page
 * to pre-fill the Add Part modal when procuring from inventory).
 */
router.get("/repair-scheduling-queue/:id/quotation-parts", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(id).select("quotation workOrderNumber");
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const parts = (booking.quotation?.parts || []).filter(p => p.name);
    return res.json({ success: true, workOrderNumber: booking.workOrderNumber, parts });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/repair-scheduling-queue/stats
 * Returns aggregate counts for the scheduling queue dashboard.
 */
router.get("/repair-scheduling-queue/stats", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");

    const [pendingCount, scheduledCount, totalCount] = await Promise.all([
      BookingService.countDocuments({
        "repairSchedule.preference": "later",
        status: { $in: ["repair_approved", "ready_for_repair"] },
      }),
      BookingService.countDocuments({
        "repairSchedule.preference": "later",
        status: "repair_scheduled",
      }),
      BookingService.countDocuments({
        "repairSchedule.preference": "later",
        status: { $in: ["repair_approved", "ready_for_repair", "repair_scheduled", "waiting_parts"] },
      }),
    ]);

    return res.json({
      pendingScheduling: pendingCount,
      scheduled: scheduledCount,
      total: totalCount,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/repair-scheduling-queue/:id/availability
 * Checks if the original inspector is available for each preferred date.
 * If not available, returns list of other available technicians.
 */
router.get("/repair-scheduling-queue/:id/availability", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const Assignment = require("../models/Assignment");
    const LeaveRequest = require("../models/LeaveRequest");

    const booking = await BookingService.findById(id)
      .populate("inspection.technicianId", "name user active")
      .populate("technicianId", "name user active")
      .lean();

    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const preferredDates = booking.preferredSchedule?.dates || [];
    const hasNoDates = preferredDates.length === 0;

    const originalInspector = booking.inspection?.technicianId || booking.technicianId;
    const estimatedDuration = booking.technicianAssistant?.estimatedDurationMinutes || 90;

    // Helper: check if a technician is available on a given date
    async function checkTechAvailability(techId, date) {
      const d = new Date(date);
      const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon, ...

      // Check working days
      const schedule = await TechnicianSchedule.findOne({ technicianId: techId }).lean();
      if (schedule) {
        // Check rest dates
        if (schedule.restDates && schedule.restDates.some(rd => {
          const restDate = new Date(rd);
          return restDate.toDateString() === d.toDateString();
        })) {
          return { available: false, reason: "Rest day" };
        }

        // Check non-working weekdays
        if (schedule.nonWorkingWeekdays && schedule.nonWorkingWeekdays.includes(dayOfWeek)) {
          return { available: false, reason: "Non-working day" };
        }

        // Check working hours capacity
        const workingDay = schedule.workingDays?.find(wd => wd.dayOfWeek === dayOfWeek);
        if (!workingDay) {
          return { available: false, reason: "Not a working day" };
        }

        const dayStart = new Date(d);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(d);
        dayEnd.setHours(23, 59, 59, 999);

        // Check existing assignments on that date
        const existingAssignments = await Assignment.find({
          technicianId: techId,
          status: { $in: ["accepted", "en_route", "on_site", "in_progress", "pending_acceptance"] },
          bookingDate: { $gte: dayStart, $lte: dayEnd },
        }).select("startTime endTime serviceDurationMinutes").lean();

        // Calculate total booked minutes
        let bookedMinutes = 0;
        for (const a of existingAssignments) {
          bookedMinutes += a.serviceDurationMinutes || 90;
        }

        const workStartMin = workingDay.startMinutes || 480; // 8:00 AM
        const workEndMin = workingDay.endMinutes || 1020;    // 5:00 PM
        const availableMinutes = (workEndMin - workStartMin) - bookedMinutes;

        if (availableMinutes < estimatedDuration) {
          return { available: false, reason: "Insufficient working hours remaining" };
        }
      }

      // Check leave requests
      const leaveOnDate = await LeaveRequest.findOne({
        technicianId: techId,
        status: "approved",
        startDate: { $lte: d },
        endDate: { $gte: d },
      }).lean();

      if (leaveOnDate) {
        return { available: false, reason: "On leave" };
      }

      return { available: true };
    }

    // Check original inspector availability for each preferred date
    const dateResults = [];
    let originalAvailable = true;

    if (hasNoDates) {
      // No preferred dates — show all technicians as available, admin will pick date later
      originalAvailable = true;
    } else if (originalInspector && originalInspector._id) {
      for (const pd of preferredDates) {
        const result = await checkTechAvailability(originalInspector._id, pd);
        dateResults.push({
          date: pd,
          available: result.available,
          reason: result.reason || null,
        });
        if (!result.available) originalAvailable = false;
      }
    } else {
      originalAvailable = false;
      for (const pd of preferredDates) {
        dateResults.push({ date: pd, available: false, reason: "No inspector assigned" });
      }
    }

    // If original inspector not available (or no dates), find other available technicians
    let availableTechnicians = [];
    if (!originalAvailable || hasNoDates) {
      const allTechnicians = await Technician.find({ active: true })
        .populate("user", "name email")
        .lean();

      for (const tech of allTechnicians) {
        const techId = tech._id;
        // Skip original inspector
        if (originalInspector && String(techId) === String(originalInspector._id)) continue;

        let availableOnAnyDate = false;
        let availableDates = [];

        if (hasNoDates) {
          // No preferred dates — mark as available (admin will pick date later)
          availableOnAnyDate = true;
          availableDates = [];
        } else {
          // Check if available on ANY of the preferred dates
          for (const pd of preferredDates) {
            const result = await checkTechAvailability(techId, pd);
            if (result.available) {
              availableOnAnyDate = true;
              availableDates.push(pd);
            }
          }
        }

        if (availableOnAnyDate) {
          availableTechnicians.push({
            _id: techId,
            name: tech.name || tech.user?.name || "Unknown",
            availableDates,
            rating: tech.rating || 0,
            ratingCount: tech.ratingCount || 0,
          });
        }
      }
    }

    return res.json({
      originalInspector: originalInspector ? {
        _id: originalInspector._id,
        name: originalInspector.name,
      } : null,
      originalAvailable,
      hasNoDates,
      dateResults,
      availableTechnicians,
      estimatedDuration,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/technicians/:techId/available-dates
 * Returns available repair dates for a specific technician (next 14 days)
 * Used by admin scheduling modal to show only bookable dates
 */
router.get("/technicians/:techId/available-dates", async (req, res, next) => {
  try {
    const { techId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(techId)) return res.status(400).json({ error: "Invalid technician id" });

    const Technician = require("../models/Technician");
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const LeaveRequest = require("../models/LeaveRequest");
    const { getBufferMinutesSync } = require("../utils/bookingPolicy");

    const tech = await Technician.findById(techId);
    if (!tech) return res.status(404).json({ error: "Technician not found" });

    const estimatedDuration = parseInt(req.query.duration) || 90;
    const TRAVEL_TIME = 30;
    const BUFFER_TIME = getBufferMinutesSync();
    const capacityPerSlot = estimatedDuration + TRAVEL_TIME + BUFFER_TIME;

    // Generate next 14 days
    const dates = [];
    const today = new Date();
    for (let i = 1; i <= 14; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      dates.push(d);
    }

    // Get technician schedule
    const schedule = await TechnicianSchedule.findOne({ technicianId: techId }).lean();

    // Get leave requests
    const leaves = await LeaveRequest.find({
      technicianId: techId,
      status: "approved",
      startDate: { $lte: dates[dates.length - 1] },
      endDate: { $gte: dates[0] },
    }).lean();

    // Get existing assignments
    const dayStart = new Date(dates[0]);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dates[dates.length - 1]);
    dayEnd.setHours(23, 59, 59, 999);

    const assignments = await Assignment.find({
      technicianId: techId,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress", "pending_acceptance"] },
      bookingDate: { $gte: dayStart, $lte: dayEnd },
    }).select("bookingDate startTime endTime serviceDurationMinutes").lean();

    // Also check BookingService records (repair bookings, core bookings)
    const bookingServiceStatuses = [
      "pending", "payment_verified", "awaiting_assignment", "assigned",
      "pending_reassignment", "confirmed", "scheduled", "on-the-way", "arrived",
      "in-progress", "repair_requested", "inspection_scheduled",
      "inspection_in_progress", "repair_approved", "ready_for_repair",
      "repair_scheduled", "repair_in_progress",
    ];
    const bookingServiceRecords = await BookingService.find({
      technicianId: techId,
      bookingDate: { $gte: dayStart, $lte: dayEnd },
      status: { $in: bookingServiceStatuses },
    }).select("bookingDate startTime endTime serviceDurationMinutes travelTime").lean();

    // Helper: derive capacity end for a booking record (matches core service logic)
    function deriveBookingCapacityEnd(b) {
      const startMin = parseBookingTime(b.startTime);
      if (!Number.isFinite(startMin)) return null;
      const explicitEnd = parseBookingTime(b.endTime);
      if (Number.isFinite(explicitEnd) && explicitEnd > startMin) return explicitEnd;
      const svc = Number(b.serviceDurationMinutes) || estimatedDuration;
      const travel = Number(b.travelTime) || TRAVEL_TIME;
      const buffer = BUFFER_TIME;
      return startMin + svc + travel + buffer;
    }

    function parseBookingTime(val) {
      if (val === null || val === undefined) return NaN;
      const num = Number(val);
      if (Number.isFinite(num)) return num;
      const str = String(val).trim();
      const ampm = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (ampm) {
        let hh = Number(ampm[1]) % 12;
        if (ampm[3].toUpperCase() === "PM") hh += 12;
        return hh * 60 + Number(ampm[2]);
      }
      const hm = str.match(/^(\d{1,2}):(\d{2})$/);
      if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
      return NaN;
    }

    // Build booked minute ranges for each date (from both sources)
    function getBookedRangesForDate(d) {
      const ranges = [];

      // From assignments
      for (const a of assignments) {
        const bd = new Date(a.bookingDate);
        if (bd.toDateString() !== d.toDateString()) continue;
        const startMin = parseBookingTime(a.startTime);
        const endMin = parseBookingTime(a.endTime);
        if (Number.isFinite(startMin) && Number.isFinite(endMin) && endMin > startMin) {
          ranges.push({ start: startMin, end: endMin });
        } else {
          // Fallback: use duration from working day start
          const dur = a.serviceDurationMinutes || estimatedDuration;
          const dow = d.getDay();
          const wd = schedule?.workingDays?.find(w => w.dayOfWeek === dow);
          const dayStartMin = wd?.startMinutes || 480;
          ranges.push({ start: dayStartMin, end: dayStartMin + dur + TRAVEL_TIME + BUFFER_TIME });
        }
      }

      // From BookingService records
      for (const b of bookingServiceRecords) {
        const bd = new Date(b.bookingDate);
        if (bd.toDateString() !== d.toDateString()) continue;
        const startMin = parseBookingTime(b.startTime);
        const endMin = deriveBookingCapacityEnd(b);
        if (Number.isFinite(startMin) && Number.isFinite(endMin) && endMin > startMin) {
          ranges.push({ start: startMin, end: endMin });
        }
      }

      return ranges;
    }

    // Check availability for each date
    const results = [];
    for (const d of dates) {
      const dayOfWeek = d.getDay();
      const dayStr = d.toISOString().split('T')[0];

      // Check if on leave
      const onLeave = leaves.some(lv => {
        const lvStart = new Date(lv.startDate);
        const lvEnd = new Date(lv.endDate);
        return d >= lvStart && d <= lvEnd;
      });
      if (onLeave) {
        results.push({ date: dayStr, available: false, reason: "On leave" });
        continue;
      }

      if (schedule) {
        // Check rest dates
        if (schedule.restDates && schedule.restDates.some(rd => {
          const restDate = new Date(rd);
          return restDate.toDateString() === d.toDateString();
        })) {
          results.push({ date: dayStr, available: false, reason: "Rest day" });
          continue;
        }

        // Check non-working weekdays
        if (schedule.nonWorkingWeekdays && schedule.nonWorkingWeekdays.includes(dayOfWeek)) {
          results.push({ date: dayStr, available: false, reason: "Non-working day" });
          continue;
        }

        // Check working hours capacity
        const workingDay = schedule.workingDays?.find(wd => wd.dayOfWeek === dayOfWeek);
        if (!workingDay) {
          results.push({ date: dayStr, available: false, reason: "Not a working day" });
          continue;
        }

        const workStartMin = workingDay.startMinutes || 480;
        const workEndMin = workingDay.endMinutes || 1020;

        // Count available slots using capacityPerSlot (matching core service logic)
        const bookedRanges = getBookedRangesForDate(d);
        let totalSlots = 0;
        let bookedSlots = 0;
        const DAY_SLOT_INTERVAL = 30;
        for (let s = workStartMin; s + capacityPerSlot <= workEndMin; s += DAY_SLOT_INTERVAL) {
          totalSlots++;
          const slotEnd = s + capacityPerSlot;
          const hasConflict = bookedRanges.some(b => s < b.end && slotEnd > b.start);
          if (hasConflict) bookedSlots++;
        }
        const remainingSlots = Math.max(0, totalSlots - bookedSlots);

        if (remainingSlots <= 0) {
          results.push({ date: dayStr, available: false, reason: "Fully booked", slots: bookedSlots });
          continue;
        }

        results.push({
          date: dayStr,
          available: true,
          remainingSlots,
          totalSlots,
          bookedSlots,
        });
      } else {
        // No schedule configured — use default 8AM-5PM
        const bookedRanges = getBookedRangesForDate(d);
        let totalSlots = 0;
        let bookedSlots = 0;
        const DAY_SLOT_INTERVAL = 30;
        for (let s = 480; s + capacityPerSlot <= 1020; s += DAY_SLOT_INTERVAL) {
          totalSlots++;
          const slotEnd = s + capacityPerSlot;
          const hasConflict = bookedRanges.some(b => s < b.end && slotEnd > b.start);
          if (hasConflict) bookedSlots++;
        }
        const remainingSlots = Math.max(0, totalSlots - bookedSlots);

        if (remainingSlots <= 0) {
          results.push({ date: dayStr, available: false, reason: "Fully booked" });
        } else {
          results.push({
            date: dayStr,
            available: true,
            remainingSlots,
            totalSlots,
            bookedSlots,
          });
        }
      }
    }

    return res.json({ dates: results, estimatedDuration, capacityPerSlot });
  } catch (err) {
    console.error("Technician available dates error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/admin/technicians/:techId/available-slots
 * Returns per-slot availability for a specific date.
 * Used by admin scheduling modal to show bookable time slots.
 * Query: date (YYYY-MM-DD), duration (minutes, default 90)
 */
router.get("/technicians/:techId/available-slots", async (req, res, next) => {
  try {
    const { techId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(techId)) return res.status(400).json({ error: "Invalid technician id" });

    const { date, duration: durParam } = req.query;
    if (!date) return res.status(400).json({ error: "date query param required (YYYY-MM-DD)" });

    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const LeaveRequest = require("../models/LeaveRequest");
    const { getBufferMinutesSync } = require("../utils/bookingPolicy");

    const duration = parseInt(durParam) || 90;
    const TRAVEL_TIME = 30;
    const BUFFER_TIME = getBufferMinutesSync();
    const capacityPerSlot = duration + TRAVEL_TIME + BUFFER_TIME;
    const slotInterval = Math.max(30, capacityPerSlot);

    const target = new Date(date + "T00:00:00");
    if (isNaN(target.getTime())) return res.status(400).json({ error: "Invalid date" });

    const dayOfWeek = target.getDay();
    const dayStart = new Date(target); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(target); dayEnd.setHours(23, 59, 59, 999);

    // Check leave
    const onLeave = await LeaveRequest.findOne({
      technicianId: techId, status: "approved",
      startDate: { $lte: dayEnd }, endDate: { $gte: dayStart },
    }).lean();
    if (onLeave) return res.json({ slots: [], reason: "On leave", duration, capacityPerSlot });

    // Get schedule
    const schedule = await TechnicianSchedule.findOne({ technicianId: techId }).lean();

    let workStartMin = 480; // 8:00 AM default
    let workEndMin = 1020;  // 5:00 PM default

    if (schedule) {
      // Check rest dates
      if (schedule.restDates?.some(rd => new Date(rd).toDateString() === target.toDateString())) {
        return res.json({ slots: [], reason: "Rest day", duration, capacityPerSlot });
      }
      // Check non-working weekdays
      if (schedule.nonWorkingWeekdays?.includes(dayOfWeek)) {
        return res.json({ slots: [], reason: "Non-working day", duration, capacityPerSlot });
      }
      const workingDay = schedule.workingDays?.find(wd => wd.dayOfWeek === dayOfWeek);
      if (!workingDay) {
        return res.json({ slots: [], reason: "Not a working day", duration, capacityPerSlot });
      }
      workStartMin = workingDay.startMinutes || 480;
      workEndMin = workingDay.endMinutes || 1020;
    }

    // Parse time string to minutes from midnight
    function parseTime(val) {
      if (val === null || val === undefined) return NaN;
      const num = Number(val);
      if (Number.isFinite(num)) return num;
      const str = String(val).trim();
      const ampm = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (ampm) {
        let hh = Number(ampm[1]) % 12;
        if (ampm[3].toUpperCase() === "PM") hh += 12;
        return hh * 60 + Number(ampm[2]);
      }
      const hm = str.match(/^(\d{1,2}):(\d{2})$/);
      if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
      return NaN;
    }

    // Derive capacity end for a booking (service + travel + buffer)
    function deriveCapacityEnd(b) {
      const s = parseTime(b.startTime);
      if (!Number.isFinite(s)) return NaN;
      const explicitEnd = parseTime(b.endTime);
      if (Number.isFinite(explicitEnd) && explicitEnd > s) return explicitEnd;
      const svc = Number(b.serviceDurationMinutes) || duration;
      const travel = Number(b.travelTime) || TRAVEL_TIME;
      return s + svc + travel + BUFFER_TIME;
    }

    // Build booked minute ranges from both sources
    const bookedRanges = [];

    // 1. From Assignment model
    const assignments = await Assignment.find({
      technicianId: techId,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress", "pending_acceptance"] },
      bookingDate: { $gte: dayStart, $lte: dayEnd },
    }).select("startTime endTime serviceDurationMinutes bookingDate").lean();

    for (const a of assignments) {
      const startMin = parseTime(a.startTime);
      const endMin = parseTime(a.endTime);
      if (Number.isFinite(startMin) && Number.isFinite(endMin) && endMin > startMin) {
        bookedRanges.push({ start: startMin, end: endMin });
      } else {
        const dur = a.serviceDurationMinutes || duration;
        const bd = new Date(a.bookingDate);
        const aDow = bd.getDay();
        const aWd = schedule?.workingDays?.find(wd => wd.dayOfWeek === aDow);
        const aStart = aWd?.startMinutes || 480;
        bookedRanges.push({ start: aStart, end: aStart + dur + TRAVEL_TIME + BUFFER_TIME });
      }
    }

    // 2. From BookingService model (repair bookings, core bookings)
    const bookingServiceStatuses = [
      "pending", "payment_verified", "awaiting_assignment", "assigned",
      "pending_reassignment", "confirmed", "scheduled", "on-the-way", "arrived",
      "in-progress", "repair_requested", "inspection_scheduled",
      "inspection_in_progress", "repair_approved", "ready_for_repair",
      "repair_scheduled", "repair_in_progress",
    ];
    const bookingServiceRecords = await BookingService.find({
      technicianId: techId,
      bookingDate: { $gte: dayStart, $lte: dayEnd },
      status: { $in: bookingServiceStatuses },
    }).select("startTime endTime serviceDurationMinutes travelTime").lean();

    for (const b of bookingServiceRecords) {
      const startMin = parseTime(b.startTime);
      const endMin = deriveCapacityEnd(b);
      if (Number.isFinite(startMin) && Number.isFinite(endMin) && endMin > startMin) {
        bookedRanges.push({ start: startMin, end: endMin });
      }
    }

    // Generate slots using capacityPerSlot as interval (matching core service logic)
    const slots = [];
    for (let min = workStartMin; min + capacityPerSlot <= workEndMin; min += slotInterval) {
      const slotEnd = min + capacityPerSlot;
      const isBooked = bookedRanges.some(b => min < b.end && slotEnd > b.start);
      const startH = Math.floor(min / 60);
      const startM = min % 60;
      const endH = Math.floor(slotEnd / 60);
      const endM = slotEnd % 60;
      slots.push({
        start: `${String(startH).padStart(2, "0")}:${String(startM).padStart(2, "0")}`,
        end: `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`,
        available: !isBooked,
        label: `${startH > 12 ? startH - 12 : startH}:${String(startM).padStart(2, "0")} ${startH >= 12 ? "PM" : "AM"} – ${endH > 12 ? endH - 12 : endH}:${String(endM).padStart(2, "0")} ${endH >= 12 ? "PM" : "AM"}`,
      });
    }

    return res.json({ slots, duration, capacityPerSlot, workStart: workStartMin, workEnd: workEndMin });
  } catch (err) {
    console.error("Available slots error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/admin/repair-scheduling-queue/:id/assign
 * Assigns a technician and schedules the repair on a specific date.
 * Body: { technicianId, scheduledDate, scheduledTime, notes }
 */
router.post("/repair-scheduling-queue/:id/assign", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { technicianId, scheduledDate, scheduledTime, notes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });
    if (!technicianId || !scheduledDate) {
      return res.status(400).json({ error: "technicianId and scheduledDate are required" });
    }

    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");
    const Assignment = require("../models/Assignment");

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    if (!["repair_approved", "ready_for_repair", "repair_scheduled"].includes(booking.status)) {
      return res.status(400).json({ error: `Cannot assign from status "${booking.status}"` });
    }

    const tech = await Technician.findById(technicianId).populate("user", "name email");
    if (!tech) return res.status(404).json({ error: "Technician not found" });

    // Update booking
    const prevStatus = booking.status;
    booking.status = "repair_scheduled";
    booking.technicianId = tech._id;
    booking.technician = {
      _id: tech._id,
      name: tech.name || tech.user?.name,
      phone: tech.phone,
      email: tech.user?.email,
    };
    booking.bookingDate = new Date(scheduledDate);
    booking.startTime = scheduledTime || "09:00";

    // Store scheduling details
    if (!booking.schedulingRequest) booking.schedulingRequest = {};
    booking.schedulingRequest.scheduledDate = new Date(scheduledDate);
    booking.schedulingRequest.scheduledTime = scheduledTime || "09:00";
    booking.schedulingRequest.scheduledBy = req.user._id;
    booking.schedulingRequest.status = "confirmed";
    booking.schedulingRequest.notes = notes || "";

    booking.recordStatusHistory({
      fromStatus: prevStatus,
      toStatus: "repair_scheduled",
      reason: `Repair scheduled for ${new Date(scheduledDate).toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} with ${tech.name || "technician"}`,
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: req.user.firstName || req.user.name || "Admin",
      metadata: { technicianId: tech._id, scheduledDate, scheduledTime },
    });

    await booking.save();

    // ── Assignment handling ───────────────────────────────────────────────
    // Check if there's already an active assignment for this booking (from inspection phase)
    let assignment = await Assignment.findOne({
      bookingId: booking._id,
      technicianId: tech._id,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress"] },
    });

    if (assignment) {
      // Update existing assignment with new schedule — no re-acceptance needed
      assignment.bookingDate = new Date(scheduledDate);
      assignment.startTime = scheduledTime || "09:00";
      assignment.status = "accepted";
      assignment.notes.push({
        text: `Repair rescheduled for ${new Date(scheduledDate).toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} at ${scheduledTime || "09:00"}. Inspection already completed.${notes ? " Notes: " + notes.trim() : ""}`,
        by: req.user._id,
        byName: req.user.firstName || req.user.name || "Admin",
        createdAt: new Date(),
      });
      await assignment.save();
    } else {
      // No existing assignment — create new one in pending_acceptance
      const assignmentData = {
        bookingId: booking._id,
        technicianId: tech._id,
        status: "pending_acceptance",
        bookingDate: new Date(scheduledDate),
        startTime: scheduledTime || "09:00",
        serviceDurationMinutes: booking.technicianAssistant?.estimatedDurationMinutes || 90,
        customerName: booking.customer?.name,
        customerPhone: booking.customer?.phone,
        serviceType: "repair",
      };
      if (notes && typeof notes === "string" && notes.trim()) {
        assignmentData.notes = [{
          text: notes.trim(),
          by: req.user._id,
          byName: req.user.firstName || req.user.name || "Admin",
          createdAt: new Date(),
        }];
      }
      assignment = await Assignment.create(assignmentData);
    }

    const isReschedule = assignment.status === "accepted";

    // ── Sync technician into Project.assignedTechnicians (large-scale repairs)
    try {
      const Project = require("../models/Project");
      const project = await Project.findOne({ bookingId: booking._id });
      if (project) {
        // If the project is a repair but has no repair snapshot, populate it
        if (booking.serviceType === 'repair' && (!project.repair || project.repair.serviceType !== 'repair')) {
          project.repair = {
            serviceType: 'repair',
            unitInfo: {
              unitType: booking.unitInfo?.unitType || '',
              brand: booking.unitInfo?.brand || '',
              model: booking.unitInfo?.model || '',
              problemDescription: booking.unitInfo?.problemDescription || '',
              photos: booking.unitInfo?.photos || [],
            },
            aiAssist: booking.technicianAssistant ? {
              summary: booking.technicianAssistant.summary || '',
              probableCauses: booking.technicianAssistant.probableCauses || [],
              suggestedTools: booking.technicianAssistant.suggestedTools || [],
              possibleParts: booking.technicianAssistant.possibleParts || [],
              repairComplexity: booking.technicianAssistant.repairComplexity || '',
              estimatedDurationMinutes: booking.technicianAssistant.estimatedDurationMinutes || 0,
              safetyReminders: booking.technicianAssistant.safetyReminders || [],
            } : undefined,
            quotation: booking.quotation ? {
              parts: (booking.quotation.parts || []).map(p => ({
                name: p.name, cost: p.cost, quantity: p.quantity, toolId: p.toolId,
                currentStock: 0, stockStatus: 'pending_check',
              })),
              laborCost: booking.quotation.laborCost || 0,
              laborCategory: booking.quotation.laborCategory || 'standard',
              totalCost: booking.quotation.totalCost || 0,
              notes: booking.quotation.notes || '',
            } : undefined,
            warranty: { days: 30 },
          };
        }
        const alreadyAssigned = (project.assignedTechnicians || []).some(
          (t) => (t._id || t).toString() === tech._id.toString()
        );
        if (!alreadyAssigned) {
          const techEntry = {
            _id: tech._id,
            name: tech.name || techFullName,
            phone: tech.phone || "",
            email: tech.user?.email || "",
            assignmentId: assignment._id,
          };
          project.assignedTechnicians = project.assignedTechnicians || [];
          project.assignedTechnicians.push(techEntry);
          project.totalAssignedTechnicians = project.assignedTechnicians.length;
          project.reservedTechnicians = project.assignedTechnicians.length;
          // If the project has no lead yet, make this technician the lead
          if (!project.leadTechnicianId) {
            project.leadTechnicianId = tech._id;
          }
          project.teamStatus = project.teamStatus || [];
          const alreadyInTeam = project.teamStatus.some(
            (t) => (t._id || "").toString() === tech._id.toString()
          );
          if (!alreadyInTeam) {
            project.teamStatus.push({
              _id: tech._id,
              name: techFullName,
              status: "notified",
              notifiedAt: new Date(),
            });
          }
          await project.save();
          if (global.io) {
            global.io.to(`tech:${tech._id}`).emit("project:team_assigned", {
              projectId: project._id,
              project: project.service?.name || "Project",
              lead: techFullName,
            });
          }
        }
      } else {
        const { isLargeProject } = require("../utils/enterpriseSchedulingEngine");
        const estimatedMinutes = Number(booking.projectScheduling?.estimatedTotalHours || 0) * 60
          || (booking.serviceDurationMinutes || 90);
        const isLarge = await isLargeProject({ totalEstimatedMinutes: estimatedMinutes }).catch(() => false);
        const custFirst = booking.customer?.name || "";
        const newProject = await Project.create({
          bookingId: booking._id,
          customerId: booking.customerId || booking.customer?._id,
          customer: {
            _id: booking.customerId || booking.customer?._id,
            name: custFirst,
            email: booking.customer?.email || "",
            phone: booking.customer?.phone || "",
            address: booking.location?.address || "",
          },
          service: {
            name: booking.serviceName || booking.service?.name || "Repair",
            description: booking.issueDescription || "",
            category: "repair",
          },
          status: "pending_project_scheduling",
          isLargeScale: isLarge,
          estimatedTotalHours: estimatedMinutes / 60,
          totalUnits: booking.quantity || 1,
          location: booking.location ? {
            address: booking.location.address,
            lat: booking.location.lat,
            lng: booking.location.lng,
          } : undefined,
          assignedTechnicians: [{
            _id: tech._id,
            name: techFullName,
            phone: tech.phone || "",
            email: tech.user?.email || "",
            assignmentId: assignment._id,
          }],
          totalAssignedTechnicians: 1,
          reservedTechnicians: 1,
          leadTechnicianId: tech._id,
          teamStatus: [{
            _id: tech._id,
            name: techFullName,
            status: "notified",
            notifiedAt: new Date(),
          }],
          ...(booking.serviceType === 'repair' ? {
            repair: {
              serviceType: 'repair',
              unitInfo: {
                unitType: booking.unitInfo?.unitType || '',
                brand: booking.unitInfo?.brand || '',
                model: booking.unitInfo?.model || '',
                problemDescription: booking.unitInfo?.problemDescription || '',
                photos: booking.unitInfo?.photos || [],
              },
              aiAssist: booking.technicianAssistant ? {
                summary: booking.technicianAssistant.summary || '',
                probableCauses: booking.technicianAssistant.probableCauses || [],
                suggestedTools: booking.technicianAssistant.suggestedTools || [],
                possibleParts: booking.technicianAssistant.possibleParts || [],
                repairComplexity: booking.technicianAssistant.repairComplexity || '',
                estimatedDurationMinutes: booking.technicianAssistant.estimatedDurationMinutes || 0,
                safetyReminders: booking.technicianAssistant.safetyReminders || [],
              } : undefined,
              quotation: booking.quotation ? {
                parts: (booking.quotation.parts || []).map(p => ({
                  name: p.name, cost: p.cost, quantity: p.quantity, toolId: p.toolId,
                  currentStock: 0, stockStatus: 'pending_check',
                })),
                laborCost: booking.quotation.laborCost || 0,
                laborCategory: booking.quotation.laborCategory || 'standard',
                totalCost: booking.quotation.totalCost || 0,
                notes: booking.quotation.notes || '',
              } : undefined,
              warranty: { days: 30 },
            }
          } : {}),
        });
        if (newProject && global.io) {
          global.io.to(`tech:${tech._id}`).emit("project:team_assigned", {
            projectId: newProject._id,
            project: newProject.service?.name || "Project",
            lead: techFullName,
          });
        }
      }
    } catch (projErr) {
      console.warn("Project team sync failed (non-fatal):", projErr.message);
    }

    // ── Notifications ─────────────────────────────────────────────────────
    const scheduledDateLabel = new Date(scheduledDate).toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" });
    const workOrderNum = booking.workOrderNumber || `WO-${String(booking._id).slice(-6).toUpperCase()}`;
    const techFullName = tech.name || tech.user?.name || "Technician";

    // Socket: technician
    if (global.io) {
      const eventName = isReschedule ? "booking:updated" : "assignment:new";
      global.io.to(`tech:${tech._id}`).emit(eventName, {
        bookingId: booking._id,
        workOrderNumber: workOrderNum,
        customerName: booking.customer?.name,
        scheduledDate,
        scheduledTime,
        message: isReschedule
          ? `Repair rescheduled — ${workOrderNum} on ${scheduledDateLabel}. Inspection already done, proceed to En Route.`
          : `New repair job assigned — ${workOrderNum} on ${scheduledDateLabel}`,
      });
    }

    // Socket: admin
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Repair scheduled with ${techFullName} for ${scheduledDateLabel}`,
      });
    }

    // Socket: customer
    if (global.io) {
      global.io.to(`customer:${booking.customerId}`).emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: isReschedule
          ? `Your repair has been rescheduled for ${scheduledDateLabel}. Your technician will be there to finish the repair.`
          : `Your repair has been scheduled for ${scheduledDateLabel}. A technician will be assigned shortly.`,
      });
    }

    // Email: technician
    try {
      const { sendTechnicianNotificationEmail } = require("../utils/mailer");
      sendTechnicianNotificationEmail({
        to: tech.user?.email,
        technicianName: techFullName,
        customerName: booking.customer?.name || "Customer",
        bookingReference: workOrderNum,
        serviceName: isReschedule ? "Repair Reschedule (Inspection Done)" : "Repair Service",
        dateLabel: scheduledDateLabel,
        timeLabel: scheduledTime || "09:00",
        totalLabel: `${booking.serviceDurationMinutes || 90} min`,
        locationAddress: booking.location?.address || "",
        issueDescription: isReschedule
          ? "This is a repair reschedule — the inspection is already complete. Proceed directly to repair execution."
          : (booking.issueDescription || booking.unitInfo?.problemDescription || ""),
      }).catch(err => console.error("[MAILER] Failed to send technician notification:", err.message));
    } catch (mailErr) {
      console.error("[MAILER] Technician notification email error:", mailErr.message);
    }

    // Email: customer
    try {
      const { sendBookingConfirmationEmail } = require("../utils/mailer");
      const populatedBooking = await BookingService.findById(booking._id).populate("customerId", "name email").lean();
      const customerEmail = populatedBooking?.customerId?.email || booking.customer?.email;
      if (customerEmail) {
        const durationMinutes = booking.serviceDurationMinutes || 90;
        const totalMinutes = durationMinutes + (booking.travelTime || 30);
        sendBookingConfirmationEmail({
          to: customerEmail,
          customerName: populatedBooking?.customerId?.name || booking.customer?.name || "Customer",
          bookingReference: workOrderNum,
          serviceName: isReschedule ? "Repair Reschedule" : "Repair Service",
          dateLabel: scheduledDateLabel,
          timeLabel: scheduledTime || "09:00",
          totalLabel: `${totalMinutes} min`,
          paymentMethod: booking.paymentMethod || "cod",
          estimatedFee: booking.quotation?.totalCost || 0,
          locationAddress: booking.location?.address || "",
          issueDescription: isReschedule
            ? "Your repair has been rescheduled. The technician will return to complete the repair work."
            : (booking.issueDescription || booking.unitInfo?.problemDescription || ""),
          isConfirmed: true,
        }).catch(err => console.error("[MAILER] Failed to send customer confirmation:", err.message));
      }
    } catch (mailErr) {
      console.error("[MAILER] Customer confirmation email error:", mailErr.message);
    }

    return res.json({
      message: `Repair scheduled with ${techFullName} for ${scheduledDateLabel}`,
      booking,
      assignment,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;


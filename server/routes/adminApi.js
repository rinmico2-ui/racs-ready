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

// Enterprise Audit Trail
router.get("/audit/stats", admin.auditStats);
router.get("/audit", admin.listAuditTrail);

// Dashboard KPI summary (counts used by admin dashboard)
router.get("/analytics/summary", admin.analyticsSummary);

// Debug — remove after verifying
router.get("/debug/counts", admin.debugCounts);

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

// Service Categories (dynamic repair request categories & unit types)
const ServiceCategory = require("../models/ServiceCategory");

router.get("/service-categories", async (req, res) => {
  try {
    const categories = await ServiceCategory.find({}).sort({ order: 1 }).lean();
    res.json({ success: true, categories });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/service-categories", async (req, res) => {
  try {
    const { name, slug, icon, iconColor, unitTypes, isCustom, order } = req.body;
    if (!name || !slug) return res.status(400).json({ success: false, error: "Name and slug are required." });
    const exists = await ServiceCategory.findOne({ $or: [{ name }, { slug }] });
    if (exists) return res.status(409).json({ success: false, error: "Category name or slug already exists." });
    const maxOrder = await ServiceCategory.findOne().sort({ order: -1 }).lean();
    const category = await ServiceCategory.create({
      name, slug, icon: icon || "bi-grid", iconColor: iconColor || "blue",
      unitTypes: unitTypes || [], isCustom: !!isCustom, order: order ?? ((maxOrder?.order || 0) + 1)
    });
    res.status(201).json({ success: true, category });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch("/service-categories/:id", async (req, res) => {
  try {
    const { name, slug, icon, iconColor, unitTypes, active, order, isCustom } = req.body;
    const update = {};
    if (name !== undefined) update.name = name;
    if (slug !== undefined) update.slug = slug;
    if (icon !== undefined) update.icon = icon;
    if (iconColor !== undefined) update.iconColor = iconColor;
    if (unitTypes !== undefined) update.unitTypes = unitTypes;
    if (active !== undefined) update.active = active;
    if (order !== undefined) update.order = order;
    if (isCustom !== undefined) update.isCustom = isCustom;
    const category = await ServiceCategory.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!category) return res.status(404).json({ success: false, error: "Category not found." });
    res.json({ success: true, category });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/service-categories/:id", async (req, res) => {
  try {
    const category = await ServiceCategory.findById(req.params.id);
    if (!category) return res.status(404).json({ success: false, error: "Category not found." });
    if (category.isCustom) return res.status(400).json({ success: false, error: "Cannot delete the 'Other' category." });
    category.active = false;
    await category.save();
    res.json({ success: true, message: "Category deactivated." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch("/service-categories/:id/reorder", async (req, res) => {
  try {
    const { order } = req.body;
    const category = await ServiceCategory.findByIdAndUpdate(req.params.id, { order }, { new: true });
    if (!category) return res.status(404).json({ success: false, error: "Category not found." });
    res.json({ success: true, category });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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

// â”€â”€â”€ Stock Adjustment (audit-logged inventory changes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

router.get("/remittances", async (req, res, next) => {
  try {
    const Payment = require("../models/Payment");
    const status = req.query.status;
    const requestedStatus = status && status !== "all" ? status : null;
    const normalStatuses = requestedStatus ? [requestedStatus] : ["waiting_for_remittance", "remitted", "rejected", "verified"];
    const includeLegacyCollections = !requestedStatus || requestedStatus === "waiting_for_remittance";
    const filter = includeLegacyCollections
      ? { $or: [{ status: { $in: normalStatuses } }, { status: "paid", collectedBy: { $exists: false }, bookingId: { $ne: null } }, { status: "paid", collectedBy: null, bookingId: { $ne: null } }] }
      : { status: { $in: normalStatuses } };
    const payments = await Payment.find(filter)
      .populate("bookingId", "bookingReference customer status paymentStatus technicianId balanceCollected repairPaymentCollected inspectionFeeCollected")
      .populate("orderId", "orderReference customer status paymentStatus total")
      .populate("projectId", "projectReference customer status payment")
      .populate("collectedBy", "name firstName lastName")
      .sort({ collectedAt: -1, submittedAt: -1 }).lean();
    const visiblePayments = payments.filter((payment) => {
      if (payment.status !== "paid" || payment.collectedBy) return true;
      const booking = payment.bookingId;
      return Boolean(booking && (booking.balanceCollected || booking.repairPaymentCollected || booking.inspectionFeeCollected));
    });
    visiblePayments.forEach((payment) => {
      if (payment.status === "paid" && !payment.collectedBy) {
        payment.status = "waiting_for_remittance";
        payment.collectedByName = payment.collectedByName || "Assigned technician (legacy record)";
        payment.collectedAt = payment.collectedAt || payment.completedAt || payment.submittedAt;
        payment.legacyCollection = true;
      }
    });

    const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
    const page = Math.max(0, Number(req.query.page) || 0);
    const paged = visiblePayments.slice(page * limit, (page + 1) * limit);

    res.json({ payments: paged, total: visiblePayments.length, page, limit });
  } catch (err) { next(err); }
});

// Unified invoice register: service bookings/projects, ecommerce product
// orders, and completed walk-in POS sales.
router.get("/invoices", async (req, res, next) => {
  try {
    const Payment = require("../models/Payment");
    const BookingService = require("../models/BookingService");
    const Order = require("../models/Order");
    const WalkInSale = require("../models/WalkInSale");
    const [payments, legacyBookings, orders, posSales] = await Promise.all([
      Payment.find({ status: { $in: ["verified", "paid"] } })
        .populate("bookingId", "bookingReference customer service services status")
        .populate("orderId", "orderReference customer items subtotal deliveryFee installationFee transportationFee total status")
        .populate("projectId", "projectReference customer service status")
        .sort({ verifiedAt: -1, submittedAt: -1 }).lean(),
      BookingService.find({ paymentStatus: { $in: ["verified", "paid"] } })
        .select("bookingReference customer service services totalPrice estimatedFee amountPaid paymentMethod paymentStatus completedAt createdAt").lean(),
      Order.find({ $or: [{ paymentStatus: { $in: ["verified", "paid"] } }, { status: "completed" }] })
        .select("orderReference customer items subtotal deliveryFee installationFee transportationFee total paymentMethod paymentStatus status createdAt updatedAt").lean(),
      WalkInSale.find({ status: "completed" }).sort({ completedAt: -1, createdAt: -1 }).lean(),
    ]);

    const linkedBookingIds = new Set(payments.map(p => p.bookingId && String(p.bookingId._id)).filter(Boolean));
    const linkedOrderIds = new Set(payments.map(p => p.orderId && String(p.orderId._id)).filter(Boolean));
    const invoiceRows = payments.map(p => {
      const subject = p.bookingId || p.orderId || p.projectId || {};
      const source = p.orderId ? "Product Order" : p.projectId ? "Large Project" : "Service Booking";
      const reference = p.bookingId?.bookingReference || p.orderId?.orderReference || p.projectId?.projectReference || `PAY-${String(p._id).slice(-8).toUpperCase()}`;
      return { _id: `payment:${p._id}`, invoiceNumber: `INV-${String(p._id).slice(-8).toUpperCase()}`, source, reference,
        customer: subject.customer || {}, amount: p.amount, paymentMethod: p.method, status: p.status,
        issuedAt: p.verifiedAt || p.completedAt || p.submittedAt, paymentReference: p.reference,
        items: p.orderId?.items || [{ description: p.bookingId?.service?.name || p.projectId?.service?.name || "Service payment", quantity: 1, totalPrice: p.amount }],
        breakdown: p.orderId ? { subtotal: p.orderId.subtotal, deliveryFee: p.orderId.deliveryFee, installationFee: p.orderId.installationFee, transportationFee: p.orderId.transportationFee } : null };
    });
    for (const b of legacyBookings) if (!linkedBookingIds.has(String(b._id))) invoiceRows.push({
      _id: `booking:${b._id}`, invoiceNumber: `INV-B-${String(b._id).slice(-7).toUpperCase()}`, source: "Service Booking", reference: b.bookingReference,
      customer: b.customer || {}, amount: b.amountPaid || b.totalPrice || b.estimatedFee || 0, paymentMethod: b.paymentMethod, status: b.paymentStatus,
      issuedAt: b.completedAt || b.createdAt, items: [{ description: b.service?.name || b.services?.map(s => s.name).filter(Boolean).join(", ") || "Service", quantity: 1, totalPrice: b.totalPrice || b.estimatedFee || 0 }]
    });
    for (const o of orders) if (!linkedOrderIds.has(String(o._id))) invoiceRows.push({
      _id: `order:${o._id}`, invoiceNumber: `INV-O-${String(o._id).slice(-7).toUpperCase()}`, source: "Product Order", reference: o.orderReference,
      customer: o.customer || {}, amount: o.total || 0, paymentMethod: o.paymentMethod, status: o.paymentStatus === "pending" && o.status === "completed" ? "completed" : o.paymentStatus,
      issuedAt: o.updatedAt || o.createdAt, items: o.items || [], breakdown: { subtotal: o.subtotal, deliveryFee: o.deliveryFee, installationFee: o.installationFee, transportationFee: o.transportationFee }
    });
    for (const s of posSales) invoiceRows.push({
      _id: `pos:${s._id}`, invoiceNumber: s.invoiceNumber, source: "POS Sale", reference: s.invoiceNumber,
      customer: { name: s.customerName, phone: s.customerPhone, address: s.customerAddress, tin: s.customerTin }, amount: s.totalAmount,
      paymentMethod: s.paymentMethod, status: s.status, issuedAt: s.completedAt || s.createdAt, items: s.items || [],
      breakdown: { subtotal: s.subtotal, discount: s.discount, tax: s.tax, amountPaid: s.amountPaid, change: s.change }
    });
    invoiceRows.sort((a, b) => new Date(b.issuedAt || 0) - new Date(a.issuedAt || 0));

    const counts = { total: invoiceRows.length, bookings: invoiceRows.filter(i => ["Service Booking", "Large Project"].includes(i.source)).length, orders: invoiceRows.filter(i => i.source === "Product Order").length, pos: invoiceRows.filter(i => i.source === "POS Sale").length };

    const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);
    const page = Math.max(0, Number(req.query.page) || 0);
    const paged = invoiceRows.slice(page * limit, (page + 1) * limit);

    res.json({ invoices: paged, total: invoiceRows.length, page, limit, counts });
  } catch (err) { next(err); }
});

router.patch("/remittances/:id/status", async (req, res, next) => {
  try {
    const Payment = require("../models/Payment");
    const BookingService = require("../models/BookingService");
    const Order = require("../models/Order");
    const Project = require("../models/Project");
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    const action = String(req.body.action || "").toLowerCase();
    const allowed = { verify: "verified", reject: "rejected", refund: "refunded" };
    const nextStatus = allowed[action];
    if (!nextStatus) return res.status(400).json({ error: "Action must be verify, reject, or refund." });
    if (action === "verify" && payment.status !== "remitted") return res.status(409).json({ error: "The collecting technician must submit the remittance before verification." });
    if (action === "reject" && !String(req.body.reason || "").trim()) return res.status(400).json({ error: "Rejection reason is required." });
    if (action === "refund" && payment.status !== "verified") return res.status(409).json({ error: "Only verified payments can be refunded." });
    if (action === "refund" && !String(req.body.reason || "").trim()) return res.status(400).json({ error: "Refund reason is required." });
    const now = new Date();
    payment.status = nextStatus;
    if (action === "verify") { payment.verifiedBy = req.user._id; payment.verifiedAt = now; payment.completedAt = now; }
    if (action === "reject") { payment.rejectedBy = req.user._id; payment.rejectedAt = now; payment.rejectionReason = String(req.body.reason).trim(); }
    if (action === "refund") { payment.refundedBy = req.user._id; payment.refundedAt = now; payment.refundReason = String(req.body.reason).trim(); }
    payment.events.push({ status: nextStatus, actor: req.user._id, actorName: req.user.name || req.user.email, actorRole: req.user.role, note: req.body.reason || req.body.notes, at: now });
    await payment.save();
    const update = { paymentStatus: nextStatus };
    if (payment.bookingId) await BookingService.findByIdAndUpdate(payment.bookingId, update);
    if (payment.orderId) await Order.findByIdAndUpdate(payment.orderId, update);
    if (payment.projectId) await Project.findByIdAndUpdate(payment.projectId, { "payment.paymentStatus": nextStatus });
    await audit.logEvent({ actor: req.user._id, target: payment._id, action: `payment.${nextStatus}`, module: "payment", req, details: { reason: req.body.reason } }).catch(() => {});
    res.json({ message: `Payment marked ${nextStatus.replace(/_/g, " ")}.`, payment });
  } catch (err) { next(err); }
});

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

// â”€â”€â”€ Fare / Pricing Settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SiteSetting = require("../models/SiteSetting");
const {
  getDownpaymentPercentage,
  normalizeDownpaymentPercentage,
} = require("../utils/paymentPolicy");

/** GET /api/admin/settings/payment-policy */
router.get("/settings/payment-policy", async (_req, res, next) => {
  try {
    return res.json({ downpaymentPercentage: await getDownpaymentPercentage() });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/admin/settings/payment-policy */
router.put("/settings/payment-policy", async (req, res, next) => {
  try {
    const raw = Number(req.body.downpaymentPercentage);
    if (!Number.isFinite(raw) || raw < 1 || raw > 100) {
      return res.status(400).json({ error: "Downpayment percentage must be between 1 and 100." });
    }
    const downpaymentPercentage = normalizeDownpaymentPercentage(raw);
    await SiteSetting.findOneAndUpdate(
      { key: "downpaymentPercentage" },
      { value: downpaymentPercentage },
      { upsert: true, setDefaultsOnInsert: true },
    );
    await audit.logEvent({
      actor: req.user && req.user._id,
      target: req.user && req.user._id,
      action: "settings.paymentPolicy.update",
      module: "admin",
      req,
      details: { downpaymentPercentage },
    }).catch(() => {});
    return res.json({ message: "Payment policy saved successfully", downpaymentPercentage });
  } catch (err) {
    next(err);
  }
});

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

const { DEFAULT_REPAIR_LABOR_FEES, SETTING_KEYS: REPAIR_LABOR_SETTING_KEYS, getRepairLaborFees } = require('../utils/repairLaborPricing');

router.get('/settings/repair-labor-fees', async (req, res, next) => {
  try { return res.json({ fees: await getRepairLaborFees() }); }
  catch (err) { next(err); }
});

router.patch('/settings/repair-labor-fees', async (req, res, next) => {
  try {
    const supplied = req.body?.fees || req.body || {};
    const fees = {};
    for (const category of Object.keys(DEFAULT_REPAIR_LABOR_FEES)) {
      const value = Number(supplied[category]);
      if (!Number.isFinite(value) || value <= 0 || value > 100000) {
        return res.status(400).json({ error: `${category} labor fee must be between 1 and 100,000.` });
      }
      fees[category] = value;
    }
    await Promise.all(Object.entries(fees).map(([category, value]) => SiteSetting.findOneAndUpdate(
      { key: REPAIR_LABOR_SETTING_KEYS[category] }, { value }, { upsert: true, setDefaultsOnInsert: true }
    )));
    await audit.logEvent({ actor: req.user._id, target: req.user._id, action: 'settings.repair-labor-fees.update', module: 'admin', req, details: fees }).catch(() => {});
    return res.json({ message: 'Customer repair labor fees updated successfully', fees });
  } catch (err) { next(err); }
});

// â”€â”€ Project Fee Defaults â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Store Open Hours (for customer pickup scheduling) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const DEFAULT_STORE_HOURS = [
  { dayOfWeek: 0, open: false, startMinutes: 0, endMinutes: 0 },
  { dayOfWeek: 1, open: true,  startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 2, open: true,  startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 3, open: true,  startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 4, open: true,  startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 5, open: true,  startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 6, open: true,  startMinutes: 480, endMinutes: 1080 },
];

/** GET /api/admin/settings/store-open-hours */
router.get("/settings/store-open-hours", async (req, res, next) => {
  try {
    const doc = await SiteSetting.findOne({ key: "storeOpenHours" }).lean();
    const hours = (doc && Array.isArray(doc.value)) ? doc.value : DEFAULT_STORE_HOURS;
    return res.json({ hours });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/admin/settings/store-open-hours */
router.put("/settings/store-open-hours", async (req, res, next) => {
  try {
    const { hours } = req.body;
    if (!Array.isArray(hours) || hours.length !== 7) {
      return res.status(400).json({ error: "hours must be an array of 7 day objects." });
    }
    const sanitized = hours.map((h, i) => ({
      dayOfWeek: i,
      open: !!h.open,
      startMinutes: Number(h.startMinutes) || 0,
      endMinutes: Number(h.endMinutes) || 0,
    }));
    await SiteSetting.findOneAndUpdate(
      { key: "storeOpenHours" },
      { value: sanitized },
      { upsert: true, setDefaultsOnInsert: true }
    );
    await audit.logEvent({
      actor: req.user._id,
      target: req.user._id,
      action: "settings.storeOpenHours.update",
      module: "admin",
      req,
      details: { hours: sanitized },
    }).catch(() => { });
    return res.json({ message: "Store open hours saved successfully", hours: sanitized });
  } catch (err) {
    next(err);
  }
});

// â”€â”€â”€ Leave Requests (admin review) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Roles & Permissions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get("/roles", admin.listRoles);
router.get("/roles/:id", admin.getRole);
router.patch("/roles/:id", admin.updateRolePermissions);
router.get("/roles/:id/users", admin.listRoleUsers);
router.patch("/users/:id/permissions", admin.setUserPermissions);
router.delete("/users/:id/permissions", admin.clearUserPermissions);
router.get("/permissions/all", admin.listAllPermissions);

// â”€â”€â”€ Combined Admin Dashboard Overview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get("/dashboard/overview", async (req, res, next) => {
  try {
    var BookingService = require("../models/BookingService");
    var Payment = require("../models/Payment");
    var Technician = require("../models/Technician");
    var User = require("../models/User");
    var Rating = require("../models/Rating");
    var Inventory = require("../models/Inventory");
    var Expense = require("../models/Expense");
    var Order = require("../models/Order");

    var safe = function(p, def){ return p.catch(function(e){ console.error('[DASHBOARD] query error:', e.message); return def; }); };

    var now = new Date();
    var startOfDay = new Date(now); startOfDay.setHours(0,0,0,0);
    var endOfDay = new Date(now); endOfDay.setHours(23,59,59,999);
    var startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    var lastMonthStart = new Date(startOfMonth); lastMonthStart.setMonth(lastMonthStart.getMonth()-1);
    var lastMonthEnd = new Date(startOfMonth); lastMonthEnd.setDate(0); lastMonthEnd.setHours(23,59,59,999);

    // â”€â”€ Parallel queries â”€â”€
    var results = await Promise.all([
      // 0: booking pipeline counts
      safe(BookingService.aggregate([{$group:{_id:"$status",count:{$sum:1}}}]), []),
      // 1: today's bookings
      safe(BookingService.countDocuments({bookingDate:{$gte:startOfDay,$lte:endOfDay}}), 0),
      // 2: total bookings
      safe(BookingService.countDocuments({}), 0),
      // 3: technician docs
      safe(Technician.find({active:true}).select("name rating ratingCount availabilityStatus").lean(), []),
      // 4: total customers
      safe(User.countDocuments({role:"customer"}), 0),
      // 5: new customers this month
      safe(User.countDocuments({role:"customer",createdAt:{$gte:startOfMonth}}), 0),
      // 6: this month's paid revenue (bookings)
      safe(Payment.aggregate([{$match:{bookingId:{$ne:null},submittedAt:{$gte:startOfMonth,$lte:endOfDay},status:{$in:["paid","verified","payment_collected","remitted"]}}},{$group:{_id:null,total:{$sum:"$amount"}}}]), []),
      // 7: last month's paid revenue (bookings)
      safe(Payment.aggregate([{$match:{bookingId:{$ne:null},submittedAt:{$gte:lastMonthStart,$lte:lastMonthEnd},status:{$in:["paid","verified","payment_collected","remitted"]}}},{$group:{_id:null,total:{$sum:"$amount"}}}]), []),
      // 8: pending/partial payments
      safe(Payment.aggregate([{$match:{status:{$in:["pending","partial"]}}},{$group:{_id:null,total:{$sum:"$amount"}}}]), []),
      // 9: expenses by type (approved, this month)
      safe(Expense.aggregate([{$match:{status:"approved",expenseDate:{$gte:startOfMonth,$lte:endOfDay}}},{$group:{_id:"$type",total:{$sum:"$amount"},count:{$sum:1}}},{$sort:{total:-1}}]), []),
      // 10: all ratings from Rating model
      safe(Rating.find({}).populate("customerId","firstName lastName").lean(), []),
      // 11: booking customer ratings
      safe(BookingService.find({customerRating:{$ne:null}}).populate("customerId","firstName lastName").populate("technicianId","name").select("customerRating customerRatingComment createdAt technicianId service serviceType").lean(), []),
      // 12: low stock inventory
      safe(Inventory.find({active:true,quantity:{$lte:5}}).limit(10).lean(), []),
      // 13: all active inventory
      safe(Inventory.find({active:true}).populate("brand","name").lean(), []),
      // 14: service distribution from bookings
      safe(BookingService.aggregate([{$group:{_id:"$serviceType",count:{$sum:1}}},{$sort:{count:-1}}]), []),
      // 15: 7-day revenue trend (single aggregation with date grouping)
      safe(Payment.aggregate([
        {$match:{submittedAt:{$gte:new Date(new Date().setDate(new Date().getDate()-6)).setHours(0,0,0,0)},status:{$in:["paid","verified","payment_collected","remitted"]}}},
        {$group:{_id:{$dateToString:{format:"%Y-%m-%d",date:"$submittedAt"}},total:{$sum:"$amount"}}},
        {$sort:{_id:1}}
      ]), []),
      // 16: orders count this month
      safe(Order.countDocuments({createdAt:{$gte:startOfMonth,$lte:endOfDay}}), 0),
      // 17: orders count last month
      safe(Order.countDocuments({createdAt:{$gte:lastMonthStart,$lte:lastMonthEnd}}), 0),
      // 18: total orders all time
      safe(Order.countDocuments({}), 0),
      // 19: order revenue this month (from orders with paid/verified payment status)
      safe(Order.aggregate([{$match:{createdAt:{$gte:startOfMonth,$lte:endOfDay},paymentStatus:{$in:["paid","verified","payment_collected","remitted"]}}},{$group:{_id:null,total:{$sum:"$total"},count:{$sum:1}}}]), []),
      // 20: orders by status
      safe(Order.aggregate([{$match:{createdAt:{$gte:startOfMonth,$lte:endOfDay}}},{$group:{_id:"$status",count:{$sum:1}}},{$sort:{count:-1}}]), []),
      // 21: recent orders (last 5)
      safe(Order.find({}).sort({createdAt:-1}).limit(5).select("orderReference status total paymentStatus createdAt customer").lean(), []),
      // 22: today's orders
      safe(Order.countDocuments({createdAt:{$gte:startOfDay,$lte:endOfDay}}), 0),
      // 23: bookings this month
      safe(BookingService.countDocuments({createdAt:{$gte:startOfMonth,$lte:endOfDay}}), 0),
      // 24: completed bookings this month
      safe(BookingService.countDocuments({status:"completed",createdAt:{$gte:startOfMonth,$lte:endOfDay}}), 0),
      // 25: cancelled bookings this month
      safe(BookingService.countDocuments({status:"cancelled",createdAt:{$gte:startOfMonth,$lte:endOfDay}}), 0),
      // 26: total order revenue all time
      safe(Order.aggregate([{$match:{paymentStatus:{$in:["paid","verified","payment_collected","remitted"]}}},{$group:{_id:null,total:{$sum:"$total"}}}]), [])
    ]);

    // â”€â”€ Unpack results â”€â”€
    var pipelineAgg = results[0];
    var todayBookings = results[1];
    var totalBookings = results[2];
    var techDocs = results[3];
    var userCount = results[4];
    var newUsersMonth = results[5];
    var monthRevenue = results[6];
    var lastMonthRevenue = results[7];
    var pendingPayAgg = results[8];
    var expenseAgg = results[9];
    var ratingDocs = results[10];
    var bookingRatings = results[11];
    var lowStock = results[12];
    var inventoryDocs = results[13];
    var serviceDist = results[14];
    var trend7Raw = results[15];
    var ordersThisMonth = results[16];
    var ordersLastMonth = results[17];
    var totalOrdersAllTime = results[18];
    var orderRevenueAgg = results[19];
    var ordersByStatusRaw = results[20];
    var recentOrders = results[21];
    var todayOrders = results[22];
    var bookingsThisMonth = results[23];
    var completedBookings = results[24];
    var cancelledBookings = results[25];
    var totalOrderRevenue = results[26];

    // â”€â”€ Pipeline â”€â”€
    var pipeMap = {};
    pipelineAgg.forEach(function(p){ pipeMap[p._id] = p.count; });
    var pipeline = {
      pending: pipeMap.pending||0, confirmed: pipeMap.confirmed||0,
      scheduled: pipeMap.scheduled||0, inProgress: (pipeMap["in-progress"]||0)+(pipeMap["on-the-way"]||0)+(pipeMap.arrived||0),
      completed: pipeMap.completed||0, cancelled: pipeMap.cancelled||0
    };

    // â”€â”€ Revenue â”€â”€
    var monthlyBookingRevenue = (monthRevenue&&monthRevenue[0])?monthRevenue[0].total:0;
    var lastMonthBookingRevenue = (lastMonthRevenue&&lastMonthRevenue[0])?lastMonthRevenue[0].total:0;
    var pendingPayments = (pendingPayAgg&&pendingPayAgg[0])?pendingPayAgg[0].total:0;
    var monthlyExpenses = expenseAgg.reduce(function(s,e){return s+e.total;},0);
    // Combined revenue: bookings + orders
    var orderRevThisMonth = (orderRevenueAgg&&orderRevenueAgg[0])?orderRevenueAgg[0].total:0;
    var monthlyRevenue = monthlyBookingRevenue + orderRevThisMonth;
    var orderRevLastMonth = 0; // approximation: we track total order revenue separately
    var lastMonthRev = lastMonthBookingRevenue + orderRevLastMonth;
    var profitMargin = monthlyRevenue>0?Math.round(((monthlyRevenue-monthlyExpenses)/monthlyRevenue)*100):0;

    // â”€â”€ 7-day revenue trend â”€â”€
    var trendMap = {};
    trend7Raw.forEach(function(t){ trendMap[t._id] = t.total; });
    var revenueTrend = [];
    for(var i=6;i>=0;i--){
      var d = new Date(); d.setDate(d.getDate()-i);
      var key = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      var dayLabel = d.toLocaleDateString("en",{weekday:"short"});
      revenueTrend.push({date:dayLabel, amount:trendMap[key]||0});
    }

    // â”€â”€ Technicians â”€â”€
    var totalTechs = techDocs.length;
    var availableTechs = techDocs.filter(function(t){return t.availabilityStatus==="Available";}).length;
    var busyTechs = techDocs.filter(function(t){return ["Assigned","On The Way","In Progress"].indexOf(t.availabilityStatus)!==-1;}).length;

    // â”€â”€ Ratings â”€â”€
    var allRatings = [];
    ratingDocs.forEach(function(r){
      var cust = "Customer";
      if(r.customerId && r.customerId.firstName) cust = (r.customerId.firstName||"")+" "+(r.customerId.lastName||"");
      cust = cust.trim()||"Customer";
      allRatings.push({score:r.score, comment:r.comment||"", createdAt:r.createdAt, type:r.targetType,
        customer:cust, serviceName:r.targetType==="inventory"?"Product":r.targetType, technicianName:""});
    });
    bookingRatings.forEach(function(b){
      var cust = "Customer";
      if(b.customerId && b.customerId.firstName) cust = (b.customerId.firstName||"")+" "+(b.customerId.lastName||"");
      cust = cust.trim()||"Customer";
      var svcName = "Service";
      if(b.service && b.service.name) svcName = b.service.name;
      else if(b.serviceType==="repair") svcName = "Repair";
      var techName = "";
      if(b.technicianId && b.technicianId.name) techName = b.technicianId.name;
      allRatings.push({score:b.customerRating, comment:b.customerRatingComment||"", createdAt:b.createdAt, type:"booking",
        customer:cust, serviceName:svcName, technicianName:techName});
    });

    // Also include order ratings
    var orderRatings = await safe(Order.find({customerRating:{$ne:null}}).populate("userId","firstName lastName").select("customerRating customerRatingComment createdAt").lean(), []);
    orderRatings.forEach(function(o){
      var cust = "Customer";
      if(o.userId && o.userId.firstName) cust = (o.userId.firstName||"")+" "+(o.userId.lastName||"");
      cust = cust.trim()||"Customer";
      allRatings.push({score:o.customerRating, comment:o.customerRatingComment||"", createdAt:o.createdAt, type:"order",
        customer:cust, serviceName:"Order", technicianName:""});
    });

    var totalRatings = allRatings.length;
    var avgRating = totalRatings>0?+(allRatings.reduce(function(s,r){return s+r.score;},0)/totalRatings).toFixed(1):0;
    var positive=allRatings.filter(function(r){return r.score>=4;}).length;
    var neutral=allRatings.filter(function(r){return r.score===3;}).length;
    var negative=allRatings.filter(function(r){return r.score<=2;}).length;
    var sentimentScore = totalRatings>0?Math.round(((positive*1+neutral*0.5+negative*0)/totalRatings)*100):0;

    // Star distribution
    var starDist = {"5":0,"4":0,"3":0,"2":0,"1":0};
    allRatings.forEach(function(r){var k=String(Math.round(r.score));if(starDist[k]!==undefined)starDist[k]++;});

    // Technician leaderboard
    var techRatingMap = {};
    ratingDocs.filter(function(r){return r.targetType==="technician";}).forEach(function(r){
      var tid=String(r.targetId);if(!techRatingMap[tid])techRatingMap[tid]={total:0,count:0};techRatingMap[tid].total+=r.score;techRatingMap[tid].count++;
    });
    bookingRatings.forEach(function(b){
      if(b.technicianId&&b.customerRating){var tid=String(b.technicianId._id||b.technicianId);if(!techRatingMap[tid])techRatingMap[tid]={total:0,count:0};techRatingMap[tid].total+=b.customerRating;techRatingMap[tid].count++;}
    });
    var techNames={};techDocs.forEach(function(t){techNames[String(t._id)]=t.name;});
    var technicians=Object.entries(techRatingMap).map(function(e){var tid=e[0],g=e[1];return{id:tid,name:techNames[tid]||"Unknown",avgRating:+(g.total/g.count).toFixed(1),reviewCount:g.count};}).sort(function(a,b){return b.avgRating-a.avgRating;});
    var topTechnicians=technicians.slice(0,5);
    var lowestTechnicians=technicians.slice(-5).reverse();

    // Service ratings
    var svcGroups={};
    allRatings.forEach(function(r){var s=r.serviceName||"Unknown";if(!svcGroups[s])svcGroups[s]={total:0,count:0};svcGroups[s].total+=r.score;svcGroups[s].count++;});
    var serviceRatings=Object.entries(svcGroups).map(function(e){var n=e[0],v=e[1];return{name:n,avgRating:+(v.total/v.count).toFixed(1),count:v.count};}).sort(function(a,b){return b.avgRating-a.avgRating;});

    // Recent reviews
    var recentReviews=allRatings.slice().sort(function(a,b){return new Date(b.createdAt)-new Date(a.createdAt);}).slice(0,10).map(function(r){return{date:r.createdAt,type:r.type,customer:r.customer,score:r.score,comment:r.comment,serviceName:r.serviceName,technicianName:r.technicianName,priority:r.score<=2?"high":r.score===3?"medium":"low"};});

    // Inventory stats
    var inStockCount = inventoryDocs.filter(function(i){return i.quantity>5;}).length;
    var lowStockCount = inventoryDocs.filter(function(i){return i.quantity>0&&i.quantity<=5;}).length;
    var outOfStockCount = inventoryDocs.filter(function(i){return !i.quantity||i.quantity<=0;}).length;
    var inventoryStats = {
      totalProducts: inventoryDocs.length,
      totalUnits: inventoryDocs.reduce(function(s,i){return s+(i.quantity||0);},0),
      inStock: inStockCount,
      lowStockCount: lowStockCount,
      outOfStock: outOfStockCount,
      lowStockItems: lowStock.map(function(i){return{name:i.modelLine||i.name,quantity:i.quantity||0,brand:i.brand&&i.brand.name?i.brand.name:""};})
    };

    // Service distribution
    var serviceDistribution = serviceDist.map(function(s){return{name:s._id||"Other",count:s.count};});

    // Expenses by type
    var expenses = expenseAgg.map(function(e){return{type:e._id||"other",total:e.total,count:e.count};});

    // Orders by status
    var ordersByStatus = {};
    ordersByStatusRaw.forEach(function(o){ordersByStatus[o._id]=o.count;});
    var ordersStats = {
      thisMonth: ordersThisMonth,
      lastMonth: ordersLastMonth,
      total: totalOrdersAllTime,
      today: todayOrders,
      revenue: (orderRevenueAgg&&orderRevenueAgg[0])?orderRevenueAgg[0].total:0,
      byStatus: ordersByStatus,
      recentOrders: recentOrders.map(function(o){
        var cname = "Customer";
        if(o.customer && o.customer.name) cname = o.customer.name;
        return {ref:o.orderReference||"--", status:o.status, total:o.total||0, paymentStatus:o.paymentStatus||"pending", date:o.createdAt, customer:cname};
      })
    };

    res.json({
      monthlyRevenue: monthlyRevenue, lastMonthRevenue: lastMonthRev, pendingPayments: pendingPayments,
      monthlyExpenses: monthlyExpenses, profitMargin: profitMargin, revenueTrend: revenueTrend, revenueTrend7: revenueTrend,
      totalBookingsToday: todayBookings, totalBookingsAllTime: totalBookings, pipeline: pipeline,
      totalTechnicians: totalTechs, availableTechnicians: availableTechs, busyTechnicians: busyTechs,
      totalCustomers: userCount, newCustomersThisMonth: newUsersMonth,
      avgRating: avgRating, totalRatings: totalRatings, sentimentScore: sentimentScore,
      sentiment:{positive:positive,neutral:neutral,negative:negative}, starDistribution: starDist,
      topTechnicians: topTechnicians, lowestTechnicians: lowestTechnicians, serviceRatings: serviceRatings,
      recentReviews: recentReviews,
      inventoryStats: inventoryStats, serviceDistribution: serviceDistribution,
      expensesByType: expenses,
      orders: ordersStats,
      alerts: {
        awaitingAssignment: pipeline.confirmed,
        pendingPaymentReview: pendingPayAgg&&pendingPayAgg[0]?1:0,
        lowStock: lowStock.length,
        lowRatings: allRatings.filter(function(r){return r.score<=2;}).length
      }
    });
  } catch (err) { console.error('[DASHBOARD] Overview error:', err.message, err.stack); next(err); }
});

// â”€â”€â”€ Ratings Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get("/ratings/dashboard", async (req, res, next) => {
  try {
    const Rating = require("../models/Rating");
    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");

    const [ratingDocs, bookingDocs, allTechDocs] = await Promise.all([
      Rating.find({}).populate("customerId", "firstName lastName").lean(),
      BookingService.find({ customerRating: { $ne: null } })
        .populate("customerId", "firstName lastName")
        .populate("technicianId", "name")
        .select("customerRating customerRatingComment createdAt customerId technicianId service serviceType status")
        .lean(),
      Technician.find({ active: true }).select("name rating ratingCount").lean(),
    ]);

    // Merge all ratings into a unified array
    const allRatings = [
      ...ratingDocs.map(r => ({
        score: r.score,
        comment: r.comment || "",
        createdAt: r.createdAt,
        type: r.targetType,
        customer: r.customerId ? `${r.customerId.firstName || ""} ${r.customerId.lastName || ""}`.trim() || "Customer" : "Customer",
        serviceName: r.targetType === "inventory" ? "Product" : r.targetType,
        technicianName: "",
        hasComment: !!(r.comment && r.comment.trim()),
      })),
      ...bookingDocs.map(b => ({
        score: b.customerRating,
        comment: b.customerRatingComment || "",
        createdAt: b.createdAt,
        type: "booking",
        customer: b.customerId ? `${b.customerId.firstName || ""} ${b.customerId.lastName || ""}`.trim() || "Customer" : "Customer",
        serviceName: b.service?.name || (b.serviceType === "repair" ? "Repair" : "Service"),
        technicianName: b.technicianId?.name || b.technician?.name || "",
        hasComment: !!(b.customerRatingComment && b.customerRatingComment.trim()),
        bookingId: String(b._id),
        status: b.status,
      })),
    ];

    // â”€â”€ KPI Stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const totalRatings = allRatings.length;
    const avgRating = totalRatings > 0
      ? +(allRatings.reduce((s, r) => s + r.score, 0) / totalRatings).toFixed(1)
      : 0;
    const lowRatingCount = allRatings.filter(r => r.score <= 2).length;
    const respondedCount = allRatings.filter(r => r.hasComment).length;
    const responseRate = totalRatings > 0 ? Math.round((respondedCount / totalRatings) * 100) : 0;

    // Previous period comparison (same duration before current month)
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentMonthRatings = allRatings.filter(r => new Date(r.createdAt) >= currentMonthStart);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthRatings = allRatings.filter(r => {
      const d = new Date(r.createdAt);
      return d >= prevMonthStart && d < prevMonthEnd;
    });
    const currentMonthAvg = currentMonthRatings.length > 0
      ? +(currentMonthRatings.reduce((s, r) => s + r.score, 0) / currentMonthRatings.length).toFixed(1)
      : 0;
    const prevMonthAvg = prevMonthRatings.length > 0
      ? +(prevMonthRatings.reduce((s, r) => s + r.score, 0) / prevMonthRatings.length).toFixed(1)
      : 0;
    const ratingChange = +(currentMonthAvg - prevMonthAvg).toFixed(1);

    // â”€â”€ Rating Trend (6 months) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const trendLabels = [];
    const trendData = [];
    const trendCounts = [];
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
      trendCounts.push(monthRatings.length);
    }

    // â”€â”€ Star Distribution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const distribution = { "5": 0, "4": 0, "3": 0, "2": 0, "1": 0 };
    for (const r of allRatings) {
      const key = String(Math.round(r.score));
      if (distribution[key] !== undefined) distribution[key]++;
    }

    // â”€â”€ Sentiment Analysis â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const positive = allRatings.filter(r => r.score >= 4).length;
    const neutral = allRatings.filter(r => r.score === 3).length;
    const negative = allRatings.filter(r => r.score <= 2).length;
    const sentimentScore = totalRatings > 0
      ? Math.round(((positive * 1 + neutral * 0.5 + negative * 0) / totalRatings) * 100)
      : 0;

    // â”€â”€ Technician Leaderboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Build from technician-targeted ratings + booking ratings with technicianId
    const techRatingMap = {};
    for (const r of ratingDocs) {
      if (r.targetType === "technician") {
        const tid = String(r.targetId);
        if (!techRatingMap[tid]) techRatingMap[tid] = { total: 0, count: 0 };
        techRatingMap[tid].total += r.score;
        techRatingMap[tid].count++;
      }
    }
    // Also include technician IDs from BookingService
    for (const b of bookingDocs) {
      if (b.technicianId && b.customerRating) {
        const tid = String(b.technicianId._id || b.technicianId);
        if (!techRatingMap[tid]) techRatingMap[tid] = { total: 0, count: 0 };
        techRatingMap[tid].total += b.customerRating;
        techRatingMap[tid].count++;
      }
    }
    const techNames = {};
    for (const t of allTechDocs) {
      techNames[String(t._id)] = t.name;
    }
    const technicians = Object.entries(techRatingMap)
      .map(([tid, g]) => ({
        id: tid,
        name: techNames[tid] || "Unknown",
        avgRating: +(g.total / g.count).toFixed(1),
        reviewCount: g.count,
      }))
      .sort((a, b) => b.avgRating - a.avgRating);

    const topTechnicians = technicians.filter(t => t.reviewCount >= 1).slice(0, 5);
    const lowestTechnicians = technicians.filter(t => t.reviewCount >= 1).slice(-5).reverse();

    // â”€â”€ Service Ratings Breakdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const serviceGroups = {};
    for (const r of allRatings) {
      const svc = r.serviceName || "Unknown";
      if (!serviceGroups[svc]) serviceGroups[svc] = { total: 0, count: 0 };
      serviceGroups[svc].total += r.score;
      serviceGroups[svc].count++;
    }
    const serviceRatings = Object.entries(serviceGroups)
      .map(([name, v]) => ({
        name,
        avgRating: +(v.total / v.count).toFixed(1),
        count: v.count,
      }))
      .sort((a, b) => b.avgRating - a.avgRating);

    // â”€â”€ Complaint Categories (keyword extraction from comments) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const complaintKeywords = {
      "Late Arrival": ["late", "delayed", "slow", "took long", "waiting", "waited", "hours"],
      "Poor Communication": ["no update", "didn't inform", "no response", "unresponsive", "ignored", "never called", "no call"],
      "Incomplete Repair": ["still broken", "not fixed", "didn't fix", "came back", "same problem", "issue remains", "recurring"],
      "Pricing": ["expensive", "overcharged", "too much", "price", "cost", "billing", "hidden fee"],
      "Rude Behavior": ["rude", "unprofessional", "impolite", "attitude", "disrespectful"],
      "Poor Quality": ["poor quality", "bad work", "sloppy", "messy", "damaged"],
      "Other": [],
    };
    const complaintCounts = {};
    for (const [category] of Object.entries(complaintKeywords)) {
      complaintCounts[category] = 0;
    }
    for (const r of allRatings) {
      if (!r.comment) continue;
      const lower = r.comment.toLowerCase();
      let matched = false;
      for (const [category, keywords] of Object.entries(complaintKeywords)) {
        if (category === "Other") continue;
        if (keywords.some(kw => lower.includes(kw))) {
          complaintCounts[category]++;
          matched = true;
        }
      }
      if (!matched && r.score <= 2) {
        complaintCounts["Other"]++;
      }
    }
    const complaintCategories = Object.entries(complaintCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .filter(c => c.count > 0);

    // â”€â”€ Review Alerts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const lowRatingReviews = allRatings.filter(r => r.score <= 2).length;
    // Bookings with rating but no comment (no response)
    const noResponseReviews = allRatings.filter(r => r.score <= 3 && !r.hasComment).length;
    // Reviews with 1-star (flagged)
    const flaggedReviews = allRatings.filter(r => r.score === 1).length;

    // â”€â”€ Recent Reviews (enriched with technician + service) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const recentReviews = allRatings
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 20)
      .map(r => ({
        date: r.createdAt,
        type: r.type,
        customer: r.customer,
        score: r.score,
        comment: r.comment,
        serviceName: r.serviceName,
        technicianName: r.technicianName,
        priority: r.score <= 2 ? "high" : r.score === 3 ? "medium" : "low",
      }));

    // â”€â”€ Review Sources â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const sourceBooking = allRatings.filter(r => r.type === "booking").length;
    const sourceProduct = allRatings.filter(r => r.type === "inventory").length;
    const sourceTechnician = allRatings.filter(r => r.type === "technician").length;
    const reviewSources = {
      completedBooking: totalRatings > 0 ? Math.round((sourceBooking / totalRatings) * 100) : 0,
      productReview: totalRatings > 0 ? Math.round((sourceProduct / totalRatings) * 100) : 0,
      technicianReview: totalRatings > 0 ? Math.round((sourceTechnician / totalRatings) * 100) : 0,
    };

    // â”€â”€ AI Insights (keyword-based recommendations) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const insights = [];
    // Check for low-rated service categories
    const weakServices = serviceRatings.filter(s => s.avgRating < 4.0 && s.count >= 2);
    if (weakServices.length > 0) {
      insights.push(`${weakServices.map(s => s.name).join(", ")} receive${weakServices.length === 1 ? "s" : ""} lower ratings (below 4.0).`);
    }
    // Top technician
    if (topTechnicians.length > 0) {
      insights.push(`${topTechnicians[0].name} consistently receives excellent reviews (${topTechnicians[0].avgRating}â˜…).`);
    }
    // Complaint insight
    if (complaintCategories.length > 0 && complaintCategories[0].count >= 3) {
      insights.push(`Customers mention "${complaintCategories[0].name.toLowerCase()}" ${complaintCategories[0].count} times this period.`);
    }
    // Trend insight
    if (ratingChange < 0) {
      insights.push(`Average rating dropped by ${Math.abs(ratingChange).toFixed(1)} stars compared to last month.`);
    } else if (ratingChange > 0) {
      insights.push(`Average rating improved by ${ratingChange.toFixed(1)} stars compared to last month.`);
    }
    // Low rating alert
    if (lowRatingCount > 0) {
      insights.push(`${lowRatingCount} review${lowRatingCount !== 1 ? "s" : ""} with 1-2 stars need${lowRatingCount === 1 ? "s" : ""} attention.`);
    }

    res.json({
      stats: { totalRatings, avgRating, lowRatingCount, responseRate },
      ratingChange,
      currentMonthAvg,
      prevMonthAvg,
      recentReviews,
      trend: { labels: trendLabels, data: trendData, counts: trendCounts },
      distribution,
      sentiment: { positive, neutral, negative, sentimentScore },
      topTechnicians,
      lowestTechnicians,
      serviceRatings,
      complaintCategories,
      reviewAlerts: { lowRatingReviews, noResponseReviews, flaggedReviews },
      reviewSources,
      insights,
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

    // Fetch ALL technicians
    const allTechs = await Technician.find({}).sort({ name: 1 }).lean();

    // 1. Get ratings from Rating collection (targetType: "technician")
    const techRatings = await Rating.find({ targetType: "technician" })
      .populate("customerId", "firstName lastName email")
      .sort({ createdAt: -1 })
      .lean();

    // 2. Get ratings from BookingService (customerRating on completed bookings with a technician)
    const ratedBookings = await BookingService.find({
      customerRating: { $exists: true, $ne: null },
      technicianId: { $exists: true, $ne: null },
    })
      .populate("customerId", "firstName lastName email")
      .select("technicianId customerRating customerRatingComment createdAt")
      .sort({ createdAt: -1 })
      .lean();

    // Merge: group all ratings by technician ID
    const techGroups = {};

    // From Rating collection
    for (const r of techRatings) {
      const tid = String(r.targetId);
      if (!techGroups[tid]) techGroups[tid] = { ratings: [], total: 0, count: 0 };
      techGroups[tid].ratings.push({
        customer: r.customerId ? ((r.customerId.firstName || "") + " " + (r.customerId.lastName || "")).trim() : "Customer",
        rating: r.score,
        comment: r.comment || "",
        date: r.createdAt,
      });
      techGroups[tid].total += r.score;
      techGroups[tid].count++;
    }

    // From BookingService
    for (const b of ratedBookings) {
      const tid = String(b.technicianId);
      if (!techGroups[tid]) techGroups[tid] = { ratings: [], total: 0, count: 0 };
      techGroups[tid].ratings.push({
        customer: b.customerId ? ((b.customerId.firstName || "") + " " + (b.customerId.lastName || "")).trim() : "Customer",
        rating: b.customerRating,
        comment: b.customerRatingComment || "",
        date: b.createdAt,
      });
      techGroups[tid].total += b.customerRating;
      techGroups[tid].count++;
    }

    // Count completed jobs per technician
    let jobCounts = {};
    try {
      const completedBookings = await BookingService.find({ status: "completed" }).select("technicianId").lean();
      for (const b of completedBookings) {
        if (b.technicianId) {
          const tid = String(b.technicianId);
          jobCounts[tid] = (jobCounts[tid] || 0) + 1;
        }
      }
    } catch (e) {
      console.error("Error counting jobs:", e.message);
    }

    // Build technician objects — only include those with at least 1 rating
    const technicians = allTechs
      .map(t => {
        const tid = String(t._id);
        const g = techGroups[tid];
        const createdDate = t.createdAt ? new Date(t.createdAt) : null;
        const yearsSinceCreation = createdDate
          ? Math.max(0, Math.floor((Date.now() - createdDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000)))
          : 0;

        return {
          id: tid,
          name: t.name || "Unknown Technician",
          email: t.userEmail || "",
          department: "",
          avgRating: g ? +(g.total / g.count).toFixed(1) : 0,
          reviewCount: g ? g.count : 0,
          jobsCompleted: jobCounts[tid] || 0,
          experience: yearsSinceCreation,
          status: t.active ? (t.availabilityStatus || "Offline") : "inactive",
          avatar: null,
          recentReviews: g ? g.ratings.slice(0, 5) : [],
        };
      })
      .filter(t => t.reviewCount > 0)
      .sort((a, b) => b.avgRating - a.avgRating);

    const totalReviews = techRatings.length + ratedBookings.length;
    const totalTechnicians = technicians.length;
    const allScores = [...techRatings.map(r => r.score), ...ratedBookings.map(b => b.customerRating)];
    const avgRating = allScores.length > 0
      ? +(allScores.reduce((s, v) => s + v, 0) / allScores.length).toFixed(1)
      : 0;
    const topPerformers = technicians.filter(t => t.avgRating >= 4.5).length;

    const ratingDistribution = { "5": 0, "4": 0, "3": 0, "2": 0, "1": 0 };
    for (const score of allScores) {
      const key = String(Math.round(score));
      if (ratingDistribution[key] !== undefined) ratingDistribution[key]++;
    }

    // Performance trends (last 6 months)
    const allDated = [
      ...techRatings.map(r => ({ score: r.score, date: r.createdAt })),
      ...ratedBookings.map(b => ({ score: b.customerRating, date: b.createdAt })),
    ];
    const now = new Date();
    const trendLabels = [];
    const avgRatings = [];
    const jobCountsTrend = [];
    for (let m = 5; m >= 0; m--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - m + 1, 1);
      trendLabels.push(monthStart.toLocaleString("default", { month: "short" }));
      const monthScores = allDated.filter(r => {
        const d = new Date(r.date);
        return d >= monthStart && d < monthEnd;
      });
      avgRatings.push(monthScores.length > 0
        ? +(monthScores.reduce((s, r) => s + r.score, 0) / monthScores.length).toFixed(1)
        : 0);
      jobCountsTrend.push(monthScores.length);
    }

    res.json({
      stats: { totalTechnicians, avgRating, totalReviews, topPerformers },
      technicians,
      ratingDistribution,
      performanceTrends: { labels: trendLabels, avgRatings, jobCounts: jobCountsTrend },
    });
  } catch (err) {
    console.error("Error in /ratings/technicians:", err);
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

// â”€â”€â”€ Business Profile Settings (admin) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/admin/settings/business-profile
router.get("/settings/business-profile", async (req, res, next) => {
  try {
    const keys = [
      "companyName",
      "companyTagline",
      "companyPhone",
      "companyEmail",
      "companyLocationAddress",
    ];
    const docs = await SiteSetting.find({ key: { $in: keys } }).lean();
    const map = {};
    for (const d of docs) map[d.key] = d.value;
    return res.json({
      businessName: map.companyName || "CALIDRO RACS",
      tagline: map.companyTagline || "Premium air conditioning & appliance care powered by transparent service and certified technicians.",
      phone: map.companyPhone || "0965 605 6495",
      email: map.companyEmail || "calidroracs@gmail.com",
      address: map.companyLocationAddress || "San Leonardo, Nueva Ecija",
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/settings/business-profile
router.put("/settings/business-profile", async (req, res, next) => {
  try {
    const updates = {};
    const fields = [
      { body: "businessName", key: "companyName", max: 100 },
      { body: "tagline", key: "companyTagline", max: 300 },
      { body: "phone", key: "companyPhone", max: 30 },
      { body: "email", key: "companyEmail", max: 100 },
      { body: "address", key: "companyLocationAddress", max: 500 },
    ];
    for (const f of fields) {
      if (req.body[f.body] !== undefined) {
        const val = String(req.body[f.body]).trim().slice(0, f.max);
        if (val) {
          await SiteSetting.findOneAndUpdate(
            { key: f.key },
            { value: val },
            { upsert: true, setDefaultsOnInsert: true },
          );
          updates[f.key] = val;
        }
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }
    await audit.logEvent({
      actor: req.user && req.user._id,
      target: req.user && req.user._id,
      action: "settings.businessProfile.update",
      module: "admin",
      req,
      details: updates,
    }).catch(() => { });
    return res.json({ message: "Business profile saved successfully", updates });
  } catch (err) {
    next(err);
  }
});

// â”€â”€â”€ Company Location Settings (admin) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Attendance Settings & Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const crypto = require("crypto");
const Technician = require("../models/Technician");
const TechnicianAttendance = require("../models/TechnicianAttendance");

// helper to get or create today's QR token
async function getOrCreateDailyToken() {
  const todayStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  let tokenSetting = await SiteSetting.findOne({ key: "attendance_qr_token" }).lean();

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
        // Checked in â†’ ready to work
        tech.availabilityStatus = "Available";
        updates.availabilityStatus = "Available";
      } else if (["Absent", "Checked Out", "On Leave", "Sick Leave"].includes(status)) {
        // Not at work â†’ offline
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

// â”€â”€â”€ Repair Queue Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Warranty Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
 * Status: repair_requested â†’ awaiting_assignment
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
 * Status: awaiting_assignment â†’ inspection_scheduled
 */
router.post("/repair-queue/:id/assign-technician", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");
    const Assignment = require("../models/Assignment");
    const PartsRequest = require("../models/PartsRequest");
    const StockReservation = require("../models/StockReservation");

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Repair booking not found" });

    if (booking.status !== "awaiting_assignment") {
      return res.status(400).json({ error: `Cannot assign technician from status "${booking.status}". Expected "awaiting_assignment".` });
    }

    const { technicianId, scheduledDate, scheduledTime, priority, notes } = req.body;
    if (!technicianId || !mongoose.Types.ObjectId.isValid(technicianId)) {
      return res.status(400).json({ error: "A valid technician is required" });
    }
    if (!scheduledDate) return res.status(400).json({ error: "Inspection date is required" });
    const inspectionDate = new Date(scheduledDate);
    if (Number.isNaN(inspectionDate.getTime())) {
      return res.status(400).json({ error: "Inspection date is invalid" });
    }

    const tech = await Technician.findById(technicianId).lean();
    if (!tech) return res.status(404).json({ error: "Technician not found" });

    // Enterprise: Allow priority override during assignment
    if (priority && ['low', 'medium', 'high', 'critical'].includes(priority)) {
      booking.priority = priority;
    }

    // Set inspection schedule
    booking.inspection = {
      scheduledDate: inspectionDate,
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

    const serviceItems = Array.isArray(booking.services) ? booking.services : [];
    const repairItems = serviceItems.filter(item => item?.type === "repair");
    const technicianName = tech.name ||
      [tech.firstName, tech.lastName].filter(Boolean).join(" ") ||
      "Technician";
    const serviceName = booking.service?.name ||
      repairItems.map(item => item?.name).filter(Boolean).join(", ") ||
      `Inspection: ${booking.unitInfo?.unitType || "Repair"}`;

    const assignment = new Assignment({
      bookingId: booking._id,
      technicianId: tech._id,
      bookingDate: inspectionDate,
      startTime: scheduledTime || "",
      status: "pending_acceptance",
      priority: priority === 'critical' ? 'urgent' : priority === 'high' ? 'high' : 'normal',
      slaDeadline,
      customerName: booking.customer?.name || "",
      customerPhone: booking.customer?.phone || "",
      customerEmail: booking.customer?.email || "",
      address: booking.location?.address || "",
      serviceName,
      serviceType: "repair",
      estimatedFee: booking.initialCost || 0,
      notes: [{ text: `Repair inspection scheduled by admin. Priority: ${booking.priority}`, byName: req.user.name || "Admin" }],
    });
    await assignment.save();

    booking.assignmentId = assignment._id;
    booking.technicianId = tech._id;

    for (const item of repairItems) {
      if (item.technicianId && String(item.technicianId) !== String(tech._id)) continue;
      item.technicianId = tech._id;
      item.technicianName = technicianName;
      item.assignmentId = assignment._id;
      item.status = "inspection_scheduled";
      item.phase = "repair_phase_1";
      item.schedule = {
        date: inspectionDate,
        startTime: scheduledTime || "",
        endTime: "",
        durationMinutes: Number(item.duration || booking.serviceDurationMinutes) || 60,
        kind: "inspection",
      };
    }

    // Record status transition
    booking.recordStatusHistory({
      fromStatus: "awaiting_assignment",
      toStatus: "inspection_scheduled",
      reason: `Technician ${technicianName} assigned for inspection on ${scheduledDate}`,
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: req.user.name || req.user.email || "Admin",
      metadata: {
        technicianId: tech._id,
        technicianName,
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
          serviceName,
          dateLabel,
          timeLabel,
          totalLabel: `â‚±${Number(booking.initialCost || 0).toLocaleString()}`,
          locationAddress: booking.location?.address || '',
          issueDescription: booking.issueDescription || '',
        }).catch(err => console.error('[MAILER] Failed to send repair assignment email:', err.message));
      }
    } catch (mailErr) {
      console.error('[MAILER] Repair assignment email error:', mailErr.message);
    }

    return res.json({ message: `Technician ${technicianName} assigned for inspection`, booking, assignment });
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
    let partsRequest = await PartsRequest.findOne({ bookingId: id, status: { $in: ["pending", "procuring"] } }).lean();
    if (!partsRequest && booking.partsRequest?.items?.length) {
      const recovered = await PartsRequest.create({
        bookingId: booking._id,
        workOrderNumber: booking.workOrderNumber,
        customerId: booking.customerId,
        customerName: booking.customer?.name || 'Customer',
        technicianId: booking.technicianId,
        requestedBy: booking.partsRequest.requestedBy,
        requestedAt: booking.partsRequest.requestedAt || new Date(),
        resumeStatus: booking.partsRequest.resumeStatus || 'inspection_scheduled',
        status: booking.partsRequest.status === 'procuring' ? 'procuring' : 'pending',
        items: booking.partsRequest.items.map(item => ({
          toolId: item.toolId || null,
          itemName: item.itemName,
          requestedQty: item.requestedQty || 1,
          availableQty: item.availableQty || 0,
          status: item.status || 'waiting',
        })),
      });
      partsRequest = recovered.toObject();
    }
    if (!partsRequest) {
      return res.status(404).json({ error: "No active parts request found for this booking" });
    }

    const { toolIds } = req.body;

    // "Received" must represent real inventory. Resolve every selected item,
    // verify stock, and reserve it before allowing the workflow to resume.
    const Tool = require("../models/Tool");
    const requestDoc = await PartsRequest.findById(partsRequest._id);
    const selectedToolIds = Array.isArray(toolIds) ? new Set(toolIds.map(String)) : null;
    const itemsToReceive = requestDoc.items.filter(item =>
      item.status !== "received"
      && (!selectedToolIds?.size || (item.toolId && selectedToolIds.has(String(item.toolId))))
    );
    const existingReservations = await StockReservation.find({
      bookingId: booking._id,
      status: { $in: ["reserved", "checked_out"] },
    }).select("toolId quantity").lean();
    const existingByTool = existingReservations.reduce((map, reservation) => {
      const key = String(reservation.toolId || "");
      if (key) map.set(key, (map.get(key) || 0) + (Number(reservation.quantity) || 0));
      return map;
    }, new Map());
    const reservationParts = [];
    const unavailableItems = [];

    for (const item of itemsToReceive) {
      const required = Number(item.requestedQty) || 1;
      let tool = item.toolId
        ? await Tool.findOne({ _id: item.toolId, active: { $ne: false }, $and: [Tool.merchandiseFilter()] }).lean()
        : null;
      if (!tool) {
        const escaped = String(item.itemName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const exact = new RegExp(`^${escaped}$`, "i");
        const candidates = await Tool.find({ itemName: exact, active: { $ne: false }, $and: [Tool.merchandiseFilter()] })
          .sort({ quantity: -1 }).lean();
        tool = candidates[0] || null;
      }
      const alreadyReserved = tool ? (existingByTool.get(String(tool._id)) || 0) : 0;
      const remaining = Math.max(0, required - alreadyReserved);
      if (!tool || Number(tool.quantity || 0) < remaining) {
        unavailableItems.push({
          itemName: item.itemName,
          requested: required,
          available: tool ? Number(tool.quantity || 0) : 0,
        });
        continue;
      }
      item.toolId = tool._id;
      item.availableQty = Number(tool.quantity || 0);
      if (remaining > 0) {
        reservationParts.push({
          toolId: tool._id,
          name: item.itemName,
          quantity: remaining,
          cost: Number(item.unitPrice) || Number(tool.costPrice) || 0,
        });
      }
    }

    if (unavailableItems.length) {
      return res.status(409).json({
        error: `Record the procured stock before receiving: ${unavailableItems.map(item => `${item.itemName} (${item.available}/${item.requested})`).join(", ")}.`,
        code: "STOCK_NOT_RECORDED",
        unavailableItems,
      });
    }

    if (reservationParts.length) {
      const reservationResult = await StockReservation.reserveForBooking({
        bookingId: booking._id,
        parts: reservationParts,
        reservedBy: req.user._id,
      });
      if (reservationResult.insufficientStock?.length) {
        return res.status(409).json({
          error: "Stock changed before it could be reserved. Restock the requested quantity and try again.",
          code: "STOCK_RESERVATION_FAILED",
          unavailableItems: reservationResult.insufficientStock,
        });
      }
    }
    const receivedAt = new Date();
    itemsToReceive.forEach(item => {
      item.status = "received";
      item.receivedAt = receivedAt;
    });
    if (requestDoc.items.every(item => item.status === "received")) {
      requestDoc.status = "received";
      requestDoc.completedAt = receivedAt;
      requestDoc.completedBy = req.user._id;
    }
    await requestDoc.save();

    // Check if all items are now received
    const updatedRequest = await PartsRequest.findById(partsRequest._id).lean();
    const allReceived = updatedRequest.items.every(i => i.status === "received");

    if (allReceived) {
      const prevStatus = booking.status;
      const lastWaitingTransition = [...(booking.statusHistory || [])]
        .reverse()
        .find(entry => entry.toStatus === "waiting_parts");
      const resumeStatus = updatedRequest.resumeStatus
        || booking.partsRequest?.resumeStatus
        || lastWaitingTransition?.fromStatus;
      const phaseOneStatuses = ["assigned", "accepted", "confirmed", "inspection_scheduled", "inspection_in_progress"];
      const targetStatus = phaseOneStatuses.includes(resumeStatus)
        ? resumeStatus
        : "ready_for_repair";
      if (phaseOneStatuses.includes(resumeStatus) && booking.technicianAssistant?.summary) {
        booking.technicianAssistant.verifiedByTechnician = true;
        booking.technicianAssistant.verifiedAt = booking.technicianAssistant.verifiedAt || new Date();
      }
      const receivedMessage = targetStatus === "ready_for_repair"
        ? "All parts received. Booking ready for scheduling."
        : "All parts received. Technician preparation can continue.";
      booking.status = targetStatus;
      booking.recordStatusHistory({
        fromStatus: prevStatus,
        toStatus: targetStatus,
        reason: targetStatus === "ready_for_repair" ? "All parts received - ready for repair" : "All preparation parts received - inspection workflow resumed",
        changedBy: req.user._id,
        changedByModel: "User",
        changedByName: req.user.firstName || req.user.name || "Admin",
      });

      // Store the parts reservation info
      booking.partsRequest = {
        ...booking.partsRequest,
        status: "received",
        resumeStatus: updatedRequest.resumeStatus || booking.partsRequest?.resumeStatus,
        completedAt: new Date(),
        completedBy: req.user._id,
        items: updatedRequest.items.map(item => ({
          toolId: item.toolId || null,
          itemName: item.itemName,
          requestedQty: item.requestedQty,
          availableQty: item.availableQty,
          status: item.status,
          receivedAt: item.receivedAt,
        })),
      };

      await booking.save();

      // Notify technician
      if (global.io && booking.technicianId) {
        const Technician = require("../models/Technician");
        const tech = await Technician.findById(booking.technicianId).lean();
        if (tech?.user) {
          global.io.to(`user:${tech.user}`).emit("booking:updated", {
            bookingId: booking._id,
            status: booking.status,
            message: `Parts received for ${booking.workOrderNumber || booking._id}. ${receivedMessage}`,
          });
        }
      }

      // Notify customer
      if (global.io && booking.customerId) {
        global.io.to(`customer:${booking.customerId}`).emit("booking:updated", {
          bookingId: booking._id,
          status: booking.status,
          message: `Parts for your repair have arrived. ${receivedMessage}`,
        });
      }

      // Send email to customer
      try {
        const { sendEmail } = require("../utils/mailer");
        if (booking.customer?.email && targetStatus === 'ready_for_repair') {
          const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL || 'https://racs.com';
          await sendEmail(booking.customer.email, "Parts Received – Ready to Schedule Repair",
            `Dear ${booking.customer.name || 'Customer'},

Great news! The required parts for your repair have arrived and are now in stock.

Your Repair Quotation:
${(booking.quotation?.parts || []).map(p => `  - ${p.name}: â‚±${(p.cost || 0).toLocaleString()} x ${p.quantity || 1}`).join('\n')}
Labor: â‚±${(booking.quotation?.laborCost || 0).toLocaleString()}
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Total: â‚±${(booking.quotation?.totalCost || 0).toLocaleString()}

We will contact you shortly to schedule your repair appointment.

You can view your booking details here:
${baseUrl}/book-history?highlight=${booking._id}

Work Order: ${booking.workOrderNumber || `#${String(booking._id).slice(-6).toUpperCase()}`}

If you have any questions, please contact our support team.

Best regards,
RACS Repair Team`);
        }
      } catch (e) { console.error('[MAILER] Parts received email error:', e.message); }

      return res.json({ message: receivedMessage, booking, partsRequest: updatedRequest });
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

// ════════════════════════════════════════════════════════════════════════════
// REPAIR SCHEDULING QUEUE — "Schedule Repair Later" management
// ════════════════════════════════════════════════════════════════════════════

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
      $or: [
        { status: "waiting_parts" },
        {
          "partsRequest.status": "pending",
          "partsRequest.resumeStatus": { $in: ["assigned", "accepted", "confirmed", "inspection_scheduled", "inspection_in_progress"] },
        },
        {
          "repairSchedule.preference": "later",
          status: { $in: ["repair_approved", "repair_scheduled", "ready_for_repair"] },
        },
      ],
    })
      .populate("technicianId", "name user")
      .populate("customerId", "name email phone")
      .populate("inspection.technicianId", "name user")
      .sort({ updatedAt: -1 })
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
      const partsReq = await PartsRequest.findOne({
        bookingId: b._id,
        status: { $in: ["pending", "procuring"] },
      }).lean();
      const embeddedRequestItems = b.partsRequest?.items || [];
      const requestedParts = (partsReq?.items?.length ? partsReq.items : embeddedRequestItems).map(item => ({
        name: item.itemName,
        quantity: item.requestedQty || 1,
        toolId: item.toolId || null,
        currentStock: item.availableQty || 0,
        needsProcurement: item.status !== 'received',
        requestStatus: item.status || 'waiting',
      }));
      const lastWaitingTransition = [...(b.statusHistory || [])]
        .reverse()
        .find(entry => entry.toStatus === 'waiting_parts');
      const requestResumeStatus = partsReq?.resumeStatus
        || b.partsRequest?.resumeStatus
        || lastWaitingTransition?.fromStatus;
      const phaseOneStatuses = ['assigned', 'accepted', 'confirmed', 'inspection_scheduled', 'inspection_in_progress'];
      const requestPhase = phaseOneStatuses.includes(requestResumeStatus)
        ? 'phase_1_ai_preparation'
        : 'phase_2_repair';
      const quotationParts = b.quotation?.parts || [];
      // Phase 1 must display the technician's reviewed AI/custom list. A stale
      // quotation must not replace the preparation request in the admin modal.
      const baseParts = requestPhase === 'phase_1_ai_preparation' && requestedParts.length
        ? requestedParts
        : (quotationParts.length ? quotationParts : requestedParts);
      const hasParts = baseParts.length > 0;
      let bookingReservations = [];
      if (hasParts) {
        bookingReservations = await StockReservation.find({
          bookingId: b._id,
          status: "reserved",
        }).select("toolId quantity").lean();
        if (bookingReservations.length >= baseParts.length && baseParts.every(part => part.toolId)) {
          partsStatus = 'reserved';
        } else if (partsReq || (b.status === 'waiting_parts' && embeddedRequestItems.length)) {
          partsStatus = 'waiting_parts';
          partsRequestStatus = partsReq?.status || b.partsRequest?.status || 'pending';
        } else {
          partsStatus = 'pending_check';
        }
      }

      // Enrich each quotation part with stock availability
      const reservedQuantityByTool = bookingReservations.reduce((map, reservation) => {
        const key = String(reservation.toolId);
        map.set(key, (map.get(key) || 0) + (Number(reservation.quantity) || 0));
        return map;
      }, new Map());
      const enrichedParts = await Promise.all(baseParts.map(async (p) => {
        const qty = p.quantity || 1;
        let currentStock = 0;
        let toolFound = false;

        // Prefer the linked tool if it has enough stock
        if (p.toolId) {
          const tool = await Tool.findOne({ _id: p.toolId, $and: [Tool.merchandiseFilter()] }).select("quantity active").lean();
          const bookingReserved = reservedQuantityByTool.get(String(p.toolId)) || 0;
          if (tool && tool.active !== false && (tool.quantity || 0) + bookingReserved >= qty) {
            currentStock = (tool.quantity || 0) + bookingReserved;
            toolFound = true;
          }
        }

        // Otherwise find the active tool with the most matching name that can fulfill
        if (!toolFound) {
          const escaped = (p.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (escaped) {
            const regex = new RegExp(escaped.replace(/\\s+/g, '.*'), 'i');
            const candidates = await Tool.find({ itemName: regex, active: true, $and: [Tool.merchandiseFilter()] })
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
        submittedAt: partsReq?.requestedAt || b.partsRequest?.requestedAt || b.preferredSchedule?.submittedAt,
        status: b.status,
        scheduledDate: b.schedulingRequest?.scheduledDate || null,
        unitInfo: b.unitInfo,
        quotation: { ...b.quotation, parts: enrichedParts },
        diagnosis: b.diagnosis,
        technicianAssistant: {
          estimatedDurationMinutes: Math.min(480, Math.max(30, Number(b.technicianAssistant?.estimatedDurationMinutes) || 90)),
          repairComplexity: b.technicianAssistant?.repairComplexity || b.repairComplexity || 'standard',
        },
        serviceDurationMinutes: Math.min(480, Math.max(30, Number(b.technicianAssistant?.estimatedDurationMinutes) || Number(b.serviceDurationMinutes) || 90)),
        travelDurationMinutes: Number.isFinite(Number(b.travelDurationMinutes)) ? Math.max(0, Number(b.travelDurationMinutes)) : undefined,
        travelTime: Number.isFinite(Number(b.travelTime)) ? Math.max(0, Number(b.travelTime)) : 30,
        repairComplexity: b.diagnosis?.laborCategory || b.repairComplexity || b.technicianAssistant?.repairComplexity || 'standard',
        requestedParts,
        priority: b.priority || 'medium',
        partsStatus,
        partsRequestStatus,
        requestPhase,
        requestResumeStatus: requestResumeStatus || null,
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

    const activePartsRequest = await PartsRequest.findOne({
      bookingId: booking._id,
      status: { $in: ["pending", "procuring"] },
    });
    const quotationParts = (booking.quotation?.parts || []).filter(p => p.name);
    const requestItems = activePartsRequest?.items?.length
      ? activePartsRequest.items
      : (booking.partsRequest?.items || []);
    // Technician preparation requests may exist before a quotation.
    const parts = quotationParts.length
      ? quotationParts
      : requestItems.filter(item => item.itemName).map(item => ({
          name: item.itemName,
          quantity: item.requestedQty || 1,
          toolId: item.toolId || null,
          cost: item.unitPrice || 0,
        }));
    if (parts.length === 0) {
      return res.status(400).json({ error: "No quotation parts or active technician parts request found." });
    }

    const existingReservations = await StockReservation.find({
      bookingId: booking._id,
      status: { $in: ["reserved", "checked_out"] },
    }).select("toolId quantity status").lean();
    const existingByTool = existingReservations.reduce((map, reservation) => {
      const key = String(reservation.toolId || "");
      if (key) map.set(key, (map.get(key) || 0) + (Number(reservation.quantity) || 0));
      return map;
    }, new Map());

    // Step 1 & 2: Match each quotation part to an inventory Tool and persist the link
    const matchedParts = [];
    const insufficientStock = [];
    let bookingModified = false;

    for (const p of parts) {
      const qty = p.quantity || 1;
      let tool = null;

      // Use the linked tool if it has enough stock
      if (p.toolId && mongoose.Types.ObjectId.isValid(p.toolId)) {
        const linkedTool = await Tool.findOne({ _id: p.toolId, $and: [Tool.merchandiseFilter()] }).lean();
        const alreadyReserved = linkedTool ? (existingByTool.get(String(linkedTool._id)) || 0) : 0;
        if (linkedTool && linkedTool.active !== false && (linkedTool.quantity || 0) + alreadyReserved >= qty) {
          tool = linkedTool;
        }
      }

      // Otherwise fuzzy-match by name, preferring a tool that can fulfill the quantity
      if (!tool && p.name) {
        const escaped = String(p.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped.replace(/\s+/g, '.*'), 'i');
        const candidates = await Tool.find({ itemName: regex, active: true, $and: [Tool.merchandiseFilter()] }).sort({ quantity: -1 }).lean();
        tool = candidates.find(t => (t.quantity || 0) + (existingByTool.get(String(t._id)) || 0) >= qty) || candidates[0] || null;
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
      const remainingExisting = new Map(existingByTool);
      const partsToReserve = matchedParts.map(part => {
        const key = String(part.toolId);
        const required = Number(part.quantity) || 1;
        const availableExisting = remainingExisting.get(key) || 0;
        const appliedExisting = Math.min(required, availableExisting);
        remainingExisting.set(key, Math.max(0, availableExisting - appliedExisting));
        return { ...part, quantity: required - appliedExisting };
      }).filter(part => part.quantity > 0);
      const result = await StockReservation.reserveForBooking({
        bookingId: booking._id,
        parts: partsToReserve,
        reservedBy: req.user._id,
      });
      reserveInsufficient = result.insufficientStock || [];
      reservedToolIds = [
        ...existingReservations.map(r => String(r.toolId)),
        ...(result.reservations || []).map(r => String(r.toolId)),
      ];
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
    let resolvedWorkflowPhase = null;
    if (insufficientStock.length === 0) {
      // All stock was reserved — ready for scheduling
      const lastWaitingTransition = [...(booking.statusHistory || [])]
        .reverse()
        .find(entry => entry.toStatus === "waiting_parts");
      const resumeStatus = activePartsRequest?.resumeStatus
        || booking.partsRequest?.resumeStatus
        || lastWaitingTransition?.fromStatus;
      const phaseOneStatuses = ["assigned", "accepted", "confirmed", "inspection_scheduled", "inspection_in_progress"];
      const isPhaseOneRequest = phaseOneStatuses.includes(resumeStatus);
      resolvedWorkflowPhase = isPhaseOneRequest ? "phase_1_ai_preparation" : "phase_2_repair";
      const targetStatus = isPhaseOneRequest
        ? resumeStatus
        : "repair_approved";
      if (isPhaseOneRequest && booking.technicianAssistant?.summary) {
        booking.technicianAssistant.verifiedByTechnician = true;
        booking.technicianAssistant.verifiedAt = booking.technicianAssistant.verifiedAt || new Date();
      }
      if (prevStatus !== targetStatus) {
        booking.status = targetStatus;
        booking.recordStatusHistory({
          fromStatus: prevStatus,
          toStatus: targetStatus,
          reason: targetStatus === "repair_approved"
            ? "Parts stock verified and reserved"
            : "Requested preparation parts reserved; technician workflow resumed",
          changedBy: req.user._id,
          changedByModel: "User",
          changedByName: req.user.firstName || req.user.name || "Admin",
        });
      }
      if (activePartsRequest) {
        activePartsRequest.items.forEach(item => {
          item.status = "received";
          item.receivedAt = item.receivedAt || new Date();
          const matched = matchedParts.find(part => String(part.name || "").trim().toLowerCase() === String(item.itemName || "").trim().toLowerCase());
          if (matched?.toolId) item.toolId = matched.toolId;
        });
        activePartsRequest.status = "received";
        activePartsRequest.completedAt = new Date();
        activePartsRequest.completedBy = req.user._id;
        await activePartsRequest.save();
      }
      if (booking.partsRequest?.items?.length) {
        booking.partsRequest.items.forEach(item => {
          item.status = "received";
          item.receivedAt = item.receivedAt || new Date();
          const matched = matchedParts.find(part => String(part.name || "").trim().toLowerCase() === String(item.itemName || "").trim().toLowerCase());
          if (matched?.toolId) item.toolId = matched.toolId;
        });
        booking.partsRequest.status = "received";
        booking.partsRequest.completedAt = new Date();
        booking.partsRequest.completedBy = req.user._id;
      }
      if (targetStatus === "repair_approved") {
        if (!booking.approval) booking.approval = {};
        booking.approval.status = "approved";
        booking.approval.decidedAt = booking.approval.decidedAt || new Date();
      }
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
    const readyForScheduling = allReady
      && resolvedWorkflowPhase === "phase_2_repair"
      && ["repair_approved", "ready_for_repair"].includes(booking.status);
    return res.json({
      success: true,
      allReady,
      readyForScheduling,
      workflowPhase: resolvedWorkflowPhase,
      status: booking.status,
      message: allReady
        ? (readyForScheduling
            ? `All parts verified and reserved. Ready for scheduling.`
            : `All requested parts were reserved. The technician workflow can continue.`)
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
    const PartsRequest = require("../models/PartsRequest");

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

    let embeddedRequestItem = null;
    let activeRequest = null;
    let activeRequestItem = null;
    if (!matched) {
      embeddedRequestItem = (booking.partsRequest?.items || []).find(item => {
        const name = String(item.itemName || '').trim().toLowerCase();
        return name && (name === targetName || name.includes(targetName) || targetName.includes(name));
      }) || null;
    }
    if (!matched && !embeddedRequestItem) {
      activeRequest = await PartsRequest.findOne({ bookingId: booking._id, status: { $in: ['pending', 'procuring'] } });
      activeRequestItem = activeRequest?.items?.find(item => {
        const name = String(item.itemName || '').trim().toLowerCase();
        return name && (name === targetName || name.includes(targetName) || targetName.includes(name));
      }) || null;
    }

    if (!matched && !embeddedRequestItem && !activeRequestItem) {
      return res.status(404).json({ error: "Quotation or technician-requested part not found" });
    }

    const tool = await Tool.findById(toolId).select("quantity type inventoryClass").lean();
    if (!tool || Tool.effectiveInventoryClass(tool) !== 'merchandise') {
      return res.status(400).json({ error: 'Only merchandise can be linked as a repair part' });
    }
    const linkedQuantity = Number(quantity) || (tool?.quantity || 0);
    if (matched) {
      matched.toolId = toolId;
      matched.currentStock = linkedQuantity;
      booking.markModified('quotation.parts');
    }
    if (embeddedRequestItem) {
      embeddedRequestItem.toolId = toolId;
      embeddedRequestItem.availableQty = linkedQuantity;
      booking.markModified('partsRequest.items');
    }
    if (activeRequestItem) {
      activeRequestItem.toolId = toolId;
      activeRequestItem.availableQty = linkedQuantity;
      await activeRequest.save();
    }
    await booking.save();

    return res.json({
      success: true,
      message: "Procured inventory linked to the repair request",
      part: matched || embeddedRequestItem || activeRequestItem,
    });
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
    const Tool = require("../models/Tool");
    const PartsRequest = require("../models/PartsRequest");
    const booking = await BookingService.findById(id).select("quotation partsRequest workOrderNumber").lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const quotationParts = (booking.quotation?.parts || []).filter(p => p.name);
    const activeRequest = await PartsRequest.findOne({
      bookingId: booking._id,
      status: { $in: ["pending", "procuring"] },
    }).lean();
    const requestedItems = activeRequest?.items?.length
      ? activeRequest.items
      : (booking.partsRequest?.items || []);
    const requestedParts = requestedItems.filter(item => item.itemName && item.status !== 'received').map(item => ({
      name: item.itemName,
      quantity: Number(item.requestedQty) || 1,
      toolId: item.toolId || null,
      cost: Number(item.unitPrice) || 0,
      source: 'technician_ai_request',
    }));
    const sourceParts = quotationParts.length ? quotationParts : requestedParts;
    const parts = [];

    // Send only real stock shortfalls. Returning every quotation line caused
    // the next (already available) part to pop up after procurement.
    for (const part of sourceParts) {
      const quantity = Number(part.quantity) || 1;
      let tool = null;

      if (part.toolId && mongoose.Types.ObjectId.isValid(part.toolId)) {
        tool = await Tool.findOne({ _id: part.toolId, active: { $ne: false }, $and: [Tool.merchandiseFilter()] }).lean();
      }
      if (!tool || (tool.quantity || 0) < quantity) {
        const linkedTool = tool;
        const escaped = String(part.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escaped.replace(/\s+/g, ".*"), "i");
        const candidates = await Tool.find({ itemName: regex, active: true, type: { $in: ['part', 'consumable'] }, $and: [Tool.merchandiseFilter()] }).sort({ quantity: -1 }).lean();
        tool = candidates.find(candidate => (candidate.quantity || 0) >= quantity) || candidates[0] || linkedTool || null;
      }

      const currentStock = Number(tool?.quantity) || 0;
      if (currentStock < quantity) {
        parts.push({
          ...(typeof part.toObject === "function" ? part.toObject() : part),
          toolId: tool?._id || part.toolId || null,
          currentStock,
          quantity,
          shortfall: quantity - currentStock,
        });
      }
    }

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

    const [pendingCount, scheduledCount, totalCount, waitingPartsCount] = await Promise.all([
      BookingService.countDocuments({
        "repairSchedule.preference": "later",
        status: { $in: ["repair_approved", "ready_for_repair"] },
      }),
      BookingService.countDocuments({
        "repairSchedule.preference": "later",
        status: "repair_scheduled",
      }),
      BookingService.countDocuments({
        $or: [
          { status: "waiting_parts" },
          {
            "repairSchedule.preference": "later",
            status: { $in: ["repair_approved", "ready_for_repair", "repair_scheduled"] },
          },
        ],
      }),
      BookingService.countDocuments({ status: "waiting_parts" }),
    ]);

    return res.json({
      pendingScheduling: pendingCount,
      scheduled: scheduledCount,
      total: totalCount,
      waitingParts: waitingPartsCount,
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
    const rawRepairTravelMinutes = booking.travelDurationMinutes ?? booking.travelTime;
    const repairTravelMinutes = Number.isFinite(Number(rawRepairTravelMinutes)) ? Math.max(0, Number(rawRepairTravelMinutes)) : 30;
    const repairBufferMinutes = require("../utils/bookingPolicy").getBufferMinutesSync();
    const requiredCapacityMinutes = estimatedDuration + repairTravelMinutes + repairBufferMinutes;

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
        }).select("startTime endTime serviceDurationMinutes travelTime").lean();

        // Calculate total booked minutes
        let bookedMinutes = 0;
        for (const a of existingAssignments) {
          bookedMinutes += (Number(a.serviceDurationMinutes) || 90) + Math.max(0, Number(a.travelTime) || 0) + repairBufferMinutes;
        }

        const workStartMin = workingDay.startMinutes || 480; // 8:00 AM
        const workEndMin = workingDay.endMinutes || 1020;    // 5:00 PM
        const availableMinutes = (workEndMin - workStartMin) - bookedMinutes;

        if (availableMinutes < requiredCapacityMinutes) {
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

    const estimatedDuration = Math.min(480, Math.max(30, parseInt(req.query.duration) || 90));
    const requestedTravelTime = Number(req.query.travelTime);
    const TRAVEL_TIME = Number.isFinite(requestedTravelTime) ? Math.min(240, Math.max(0, requestedTravelTime)) : 30;
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

    const duration = Math.min(480, Math.max(30, parseInt(durParam) || 90));
    const requestedTravelTime = Number(req.query.travelTime);
    const TRAVEL_TIME = Number.isFinite(requestedTravelTime) ? Math.min(240, Math.max(0, requestedTravelTime)) : 30;
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
    const PartsRequest = require("../models/PartsRequest");
    const StockReservation = require("../models/StockReservation");

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    if (!["repair_approved", "ready_for_repair", "repair_scheduled"].includes(booking.status)) {
      return res.status(400).json({ error: `Cannot assign from status "${booking.status}"` });
    }

    // Scheduling is the final gate: quotation parts must be procured and held
    // for this booking. Never trust the modal state alone.
    const quotationParts = (booking.quotation?.parts || []).filter(part => part?.name);
    if (quotationParts.length > 0) {
      const [activePartsRequest, reservations] = await Promise.all([
        PartsRequest.findOne({
          bookingId: booking._id,
          status: { $in: ["pending", "procuring"] },
        }).select("items status").lean(),
        StockReservation.find({
          bookingId: booking._id,
          status: { $in: ["reserved", "checked_out"] },
        }).select("toolId quantity").lean(),
      ]);

      const requestItems = activePartsRequest?.items?.length
        ? activePartsRequest.items
        : (booking.partsRequest?.items || []);
      const unresolvedRequestItems = requestItems.filter(item => item.status !== "received");
      if (unresolvedRequestItems.length > 0) {
        return res.status(409).json({
          error: `Cannot schedule yet. Procure the missing part(s): ${unresolvedRequestItems.map(item => item.itemName).filter(Boolean).join(", ")}.`,
          code: "PARTS_NOT_PROCURED",
        });
      }

      const reservedByTool = reservations.reduce((totals, reservation) => {
        const key = String(reservation.toolId || "");
        if (key) totals.set(key, (totals.get(key) || 0) + (Number(reservation.quantity) || 0));
        return totals;
      }, new Map());
      const requiredByTool = new Map();
      const unlinkedParts = [];
      quotationParts.forEach(part => {
        const key = String(part.toolId || "");
        if (!key) {
          unlinkedParts.push(part.name);
          return;
        }
        requiredByTool.set(key, (requiredByTool.get(key) || 0) + (Number(part.quantity) || 1));
      });
      const unreservedParts = quotationParts
        .filter(part => part.toolId && (reservedByTool.get(String(part.toolId)) || 0) < (requiredByTool.get(String(part.toolId)) || 0))
        .map(part => part.name);
      const unavailableParts = [...new Set([...unlinkedParts, ...unreservedParts])];
      if (unavailableParts.length > 0) {
        return res.status(409).json({
          error: `Cannot schedule yet. Procure and reserve the required part(s): ${unavailableParts.join(", ")}.`,
          code: "PARTS_NOT_READY",
        });
      }
    }

    const tech = await Technician.findById(technicianId).populate("user", "name email").lean();
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
    const repairDurationMinutes = Math.min(480, Math.max(30, Number(booking.technicianAssistant?.estimatedDurationMinutes) || 90));
    const rawRepairTravel = booking.travelDurationMinutes ?? booking.travelTime;
    const repairTravelTime = Number.isFinite(Number(rawRepairTravel)) ? Math.max(0, Number(rawRepairTravel)) : 30;
    const repairBufferTime = require("../utils/bookingPolicy").getBufferMinutesSync();
    const parseScheduleTime = value => {
      const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (!match) return 540;
      let hour = Number(match[1]); const minute = Number(match[2]);
      if (match[3]) { hour %= 12; if (match[3].toUpperCase() === 'PM') hour += 12; }
      return hour * 60 + minute;
    };
    const formatScheduleTime = minutes => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    booking.serviceDurationMinutes = repairDurationMinutes;
    booking.travelTime = repairTravelTime;
    booking.endTime = formatScheduleTime(parseScheduleTime(booking.startTime) + repairDurationMinutes + repairTravelTime + repairBufferTime);

    // Revalidate the selected slot at commit time. The browser availability
    // result may be stale if another admin schedules work in the meantime.
    const scheduleDayStart = new Date(scheduledDate); scheduleDayStart.setHours(0, 0, 0, 0);
    const scheduleDayEnd = new Date(scheduledDate); scheduleDayEnd.setHours(23, 59, 59, 999);
    const requestedStart = parseScheduleTime(booking.startTime);
    const requestedEnd = requestedStart + repairDurationMinutes + repairTravelTime + repairBufferTime;
    const [conflictingAssignments, conflictingBookings] = await Promise.all([
      Assignment.find({
        bookingId: { $ne: booking._id }, technicianId: tech._id,
        bookingDate: { $gte: scheduleDayStart, $lte: scheduleDayEnd },
        status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
      }).select("startTime endTime serviceDurationMinutes travelTime").lean(),
      BookingService.find({
        _id: { $ne: booking._id }, technicianId: tech._id,
        bookingDate: { $gte: scheduleDayStart, $lte: scheduleDayEnd },
        status: { $in: ["pending", "payment_verified", "awaiting_assignment", "assigned", "confirmed", "scheduled", "on-the-way", "arrived", "in-progress", "repair_scheduled", "repair_in_progress"] },
      }).select("startTime endTime serviceDurationMinutes travelTime").lean(),
    ]);
    const overlapsRequestedSlot = row => {
      const start = parseScheduleTime(row.startTime);
      const explicitEnd = row.endTime ? parseScheduleTime(row.endTime) : NaN;
      const end = Number.isFinite(explicitEnd) && explicitEnd > start
        ? explicitEnd
        : start + (Number(row.serviceDurationMinutes) || 90) + Math.max(0, Number(row.travelTime) || 0) + repairBufferTime;
      return requestedStart < end && requestedEnd > start;
    };
    if ([...conflictingAssignments, ...conflictingBookings].some(overlapsRequestedSlot)) {
      return res.status(409).json({ error: "That time slot is no longer available. Refresh the schedule and select another slot.", code: "SLOT_CONFLICT" });
    }

    // Store scheduling details
    if (!booking.schedulingRequest) booking.schedulingRequest = {};
    booking.schedulingRequest.scheduledDate = new Date(scheduledDate);
    booking.schedulingRequest.scheduledTime = scheduledTime || "09:00";
    booking.schedulingRequest.scheduledBy = req.user._id;
    booking.schedulingRequest.status = "confirmed";
    booking.schedulingRequest.notes = notes || "";

    const isMixedBooking = booking.serviceType === "mixed"
      || ((booking.services || []).some(item => item.type === "core")
        && (booking.services || []).some(item => item.type === "repair"));
    if (isMixedBooking) {
      for (const item of booking.services.filter(row => row.type === "repair" && !["completed", "repair_declined", "cancelled"].includes(row.status))) {
        item.status = "repair_scheduled";
        item.phase = "repair_phase_2";
        item.technicianId = tech._id;
        item.technicianName = tech.name || tech.user?.name || "Technician";
        item.schedule = {
          date: new Date(scheduledDate),
          startTime: scheduledTime || "09:00",
          endTime: booking.endTime,
          durationMinutes: repairDurationMinutes,
          kind: "repair",
        };
        item.statusHistory = item.statusHistory || [];
        item.statusHistory.push({
          status: "repair_scheduled",
          changedAt: new Date(),
          changedBy: req.user._id,
          changedByName: req.user.firstName || req.user.name || "Admin",
          reason: "Admin scheduled Phase 2 Repair visit",
        });
      }
    }

    booking.recordStatusHistory({
      fromStatus: prevStatus,
      toStatus: "repair_scheduled",
      reason: `Repair scheduled for ${new Date(scheduledDate).toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} with ${tech.name || "technician"}`,
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: req.user.firstName || req.user.name || "Admin",
      metadata: { technicianId: tech._id, scheduledDate, scheduledTime, repairDurationMinutes, repairTravelTime, repairBufferTime },
    });

    await booking.save();

    // â”€â”€ Assignment handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // A Phase 2 reassignment replaces the original technician's active visit;
    // do not leave two live assignments for the same mixed booking.
    const replacedAssignments = await Assignment.find({
      bookingId: booking._id,
      technicianId: { $ne: tech._id },
      status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
    });
    for (const replaced of replacedAssignments) {
      replaced.status = "completed";
      replaced.completedAt = new Date();
      replaced.notes = replaced.notes || [];
      replaced.notes.push({
        text: `Phase 1 visit closed; Phase 2 Repair assigned to ${tech.name || tech.user?.name || "another technician"}.`,
        by: req.user._id,
        byName: req.user.firstName || req.user.name || "Admin",
        createdAt: new Date(),
      });
      await replaced.save();
      const previousTechnician = await Technician.findById(replaced.technicianId);
      if (previousTechnician) {
        const { resolveAvailabilityStatus } = require("../utils/availability");
        await resolveAvailabilityStatus(previousTechnician, null, null, { syncDb: true });
      }
    }

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
      assignment.endTime = booking.endTime;
      assignment.serviceDurationMinutes = repairDurationMinutes;
      assignment.travelTime = repairTravelTime;
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
        serviceDurationMinutes: repairDurationMinutes,
        travelTime: repairTravelTime,
        endTime: booking.endTime,
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

    if (isMixedBooking) {
      for (const item of booking.services.filter(row => row.type === "repair" && row.status === "repair_scheduled")) {
        item.assignmentId = assignment._id;
      }
      await booking.save();
    }

    const isReschedule = assignment.status === "accepted";

    // â”€â”€ Sync technician into Project.assignedTechnicians (large-scale repairs)
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
        const isLarge = await isLargeProject({ totalUnits: booking.quantity || 1, totalEstimatedMinutes: estimatedMinutes }).catch(() => false);
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

    // â”€â”€ Notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// ═══ ATTENTION REQUIRED QUEUE ═════════════════════════════════════════════

/**
 * GET /api/admin/attention-queue
 * Returns bookings that need admin action: declined assignments, expired
 * assignments that need reassignment, customer reschedule requests, etc.
 */
router.get("/attention-queue", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");

    const status = req.query.status;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 100));
    const skip = (page - 1) * limit;

    const attentionStatuses = [
      "pending_reassignment",
      "re-scheduled",
      "repair_requested",
      "pending_inspection",
      "awaiting_assignment",
    ];

    const query = status && attentionStatuses.includes(status)
      ? { status }
      : { status: { $in: attentionStatuses } };

    const [total, bookings] = await Promise.all([
      BookingService.countDocuments(query),
      BookingService.find(query)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("customerId", "firstName lastName email phone")
        .populate("technicianId", "name")
        .lean(),
    ]);

    const items = bookings.map((b) => {
      const lastAction = b.cancellationHistory && b.cancellationHistory.length
        ? b.cancellationHistory[b.cancellationHistory.length - 1]
        : null;

      let reason = "";
      if (b.status === "pending_reassignment") {
        reason = lastAction
          ? `${lastAction.technicianName || "Technician"} ${lastAction.action}${lastAction.reason ? ": " + lastAction.reason : ""}`
          : "Needs new technician";
      } else if (b.status === "re-scheduled") {
        reason = b.rescheduleReason || "Customer requested reschedule";
      } else if (b.status === "repair_requested") {
        reason = "New repair request awaiting review";
      } else if (b.status === "pending_inspection") {
        reason = "Inspection needs to be scheduled";
      } else if (b.status === "awaiting_assignment") {
        reason = "Waiting for technician assignment";
      }

      const customer = b.customerId
        ? `${b.customerId.firstName || ""} ${b.customerId.lastName || ""}`.trim()
        : (b.customer?.name || "Customer");

      const phone = b.customerId?.phone || b.customer?.phone || b.customer?.mobile || "";

      return {
        id: String(b._id),
        reference: b.bookingReference || b.workOrderNumber || `#${String(b._id).slice(-6).toUpperCase()}`,
        customer,
        email: b.customerId?.email || b.customer?.email || "",
        phone,
        serviceName: b.service?.name || (b.serviceModel === "RepairService" ? "Repair Service" : "Service"),
        serviceModel: b.serviceModel || "CoreService",
        status: b.status,
        reason,
        bookingDate: b.bookingDate,
        startTime: b.startTime || "",
        technicianName: b.technicianId?.name || b.technician?.name || "Unassigned",
        updatedAt: b.updatedAt,
        requiresReschedule: ["re-scheduled", "pending_reassignment"].includes(b.status),
        proposedReschedule: b.proposedReschedule || null,
        isProposedPassed: (() => {
          const now = new Date();
          const prop = b.proposedReschedule;
          const rawDate = (prop && prop.date) ? prop.date : (b.bookingDate || null);
          const effectiveTimeStr = (prop && prop.time) ? prop.time : (b.startTime || '');
          if (!rawDate || !effectiveTimeStr) return false;
          const raw = new Date(rawDate);
          const effDate = new Date(raw.getFullYear(), raw.getMonth(), raw.getDate());
          const tm = String(effectiveTimeStr).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
          if (tm) {
            let h = parseInt(tm[1], 10);
            const m = parseInt(tm[2], 10);
            if (tm[3]) {
              const ap = tm[3].toUpperCase();
              if (ap === 'PM' && h < 12) h += 12;
              if (ap === 'AM' && h === 12) h = 0;
            }
            effDate.setHours(h, m, 0, 0);
          } else {
            effDate.setHours(23, 59, 59, 999);
          }
          return effDate < now;
        })(),
      };
    });

    res.json({
      items,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/attention-queue/:bookingId/suggestions
 * Real technician availability for rescheduling.
 * Considers: TechnicianSchedule, leaves, holidays, non-working days,
 * BookingService, Assignment, Order, and Project reservations.
 */
router.get("/attention-queue/:bookingId/suggestions", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Technician = require("../models/Technician");
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const Assignment = require("../models/Assignment");
    const Order = require("../models/Order");
    const LeaveRequest = require("../models/LeaveRequest");
    const NonWorkingDay = require("../models/NonWorkingDay");
    const Project = require("../models/Project");
    const CoreService = require("../models/CoreService");

    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ error: "Invalid booking id" });
    }

    const booking = await BookingService.findById(bookingId).lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const durationMinutes = booking.serviceDurationMinutes || booking.service?.durationMinutes || 60;
    const daysToScan = Math.min(parseInt(req.query.days) || 10, 21);
    const slotInterval = 60; // minutes between slot starts

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const candidates = await Technician.find({ active: true }).select("name _id user").lean();
    const candidateIds = candidates.map(c => String(c._id));

    // Resolve the service duration and default working hours
    let serviceDuration = durationMinutes;
    try {
      if (booking.serviceId && mongoose.Types.ObjectId.isValid(booking.serviceId)) {
        const cs = await CoreService.findById(booking.serviceId).select("durationMinutes").lean();
        if (cs && cs.durationMinutes) serviceDuration = cs.durationMinutes;
      }
    } catch (_) { /* ignore */ }
    const totalSlotDuration = serviceDuration; // total time a slot occupies

    // Load holidays and non-working days once for the scan range
    const scanEnd = new Date(today);
    scanEnd.setDate(scanEnd.getDate() + daysToScan);

    const [holidays, nonWorkingDays, approvedLeaves, schedules] = await Promise.all([
      NonWorkingDay.find({
        date: { $gte: today, $lte: scanEnd },
      }).select("date").lean(),
      NonWorkingDay.find({
        date: { $gte: today, $lte: scanEnd },
      }).select("date").lean(),
      LeaveRequest.find({
        status: "approved",
        startDate: { $lte: scanEnd },
        endDate: { $gte: today },
      }).select("technicianId startDate endDate").lean(),
      TechnicianSchedule.find({
        technicianId: { $in: candidateIds },
      }).select("technicianId workingDays nonWorkingWeekdays restDates").lean(),
    ]);

    // Build lookup sets
    const holidaySet = new Set(
      holidays.map(h => new Date(h.date).toISOString().slice(0, 10))
    );
    const nonWorkingSet = new Set(
      nonWorkingDays.map(n => new Date(n.date).toISOString().slice(0, 10))
    );

    // Build leave lookup: techId â†’ Set of date strings
    const leaveMap = new Map();
    for (const lr of approvedLeaves) {
      const tid = String(lr.technicianId);
      if (!leaveMap.has(tid)) leaveMap.set(tid, new Set());
      const s = new Date(lr.startDate);
      const e = new Date(lr.endDate);
      for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
        leaveMap.get(tid).add(d.toISOString().slice(0, 10));
      }
    }

    // Build schedule lookup: techId â†’ schedule doc
    const scheduleMap = new Map();
    for (const sched of schedules) {
      scheduleMap.set(String(sched.technicianId), sched);
    }

    /**
     * Get working-hour blocks for a technician on a given Date.
     * Returns [{ start, end }] in minutes-from-midnight, or [] if non-working.
     */
    function getWorkingBlocks(techId, date) {
      const defaultBlock = [{ start: 8 * 60, end: 19 * 60 }];
      const sched = scheduleMap.get(String(techId));
      if (!sched || !Array.isArray(sched.workingDays) || !sched.workingDays.length) {
        return defaultBlock;
      }
      const dow = date.getDay();
      const matching = sched.workingDays.filter(w => w.dayOfWeek === dow);
      if (!matching.length) return [];
      return matching.map(w => ({
        start: w.startMinutes || 8 * 60,
        end: w.endMinutes || 19 * 60,
      }));
    }

    /**
     * Parse a time string (e.g. "8:00 AM", "13:00", "480") to minutes-from-midnight.
     */
    function parseTime(str) {
      if (!str || typeof str !== "string") return NaN;
      const s = str.trim();
      if (/^\d{1,4}$/.test(s)) return parseInt(s, 10);
      const m1 = s.match(/^(\d{1,2}):(\d{2})$/);
      if (m1) return parseInt(m1[1], 10) * 60 + parseInt(m1[2], 10);
      const m2 = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (m2) {
        let hh = parseInt(m2[1], 10) % 12;
        if (m2[3].toUpperCase() === "PM") hh += 12;
        return hh * 60 + parseInt(m2[2], 10);
      }
      return NaN;
    }

    /**
     * Convert minutes-from-midnight to 12-hour label.
     */
    function toLabel(totalMinutes) {
      const h = Math.floor(totalMinutes / 60);
      const m = totalMinutes % 60;
      const ampm = h >= 12 ? "PM" : "AM";
      const h12 = ((h + 11) % 12) + 1;
      return `${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
    }

    /**
     * Merge overlapping ranges and find free gaps within working blocks.
     */
    function findFreeGaps(workingBlocks, busyRanges) {
      const sorted = [...busyRanges].sort((a, b) => a.start - b.start);
      const merged = [];
      for (const r of sorted) {
        if (merged.length && r.start <= merged[merged.length - 1].end) {
          merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, r.end);
        } else {
          merged.push({ ...r });
        }
      }
      const gaps = [];
      for (const block of workingBlocks) {
        let cursor = block.start;
        for (const busy of merged) {
          if (busy.start >= block.end) break;
          if (busy.end <= block.start) continue;
          const gapEnd = Math.min(busy.start, block.end);
          if (gapEnd > cursor) gaps.push({ start: cursor, end: gapEnd });
          cursor = Math.max(cursor, Math.min(busy.end, block.end));
        }
        if (cursor < block.end) gaps.push({ start: cursor, end: block.end });
      }
      return gaps;
    }

    /**
     * Generate slot labels from free gaps.
     */
    function generateSlotLabels(gaps, totalDur, interval) {
      const labels = [];
      for (const gap of gaps) {
        for (let t = gap.start; t + totalDur <= gap.end; t += interval) {
          labels.push({ startMin: t, endMin: t + totalDur, label: toLabel(t) + " – " + toLabel(t + totalDur) });
        }
      }
      return labels;
    }

    const suggestions = [];

    for (let i = 0; i < daysToScan; i++) {
      const day = new Date(today);
      day.setDate(day.getDate() + i);
      const dateStr = day.toISOString().slice(0, 10);

      // Skip holidays and global non-working days
      if (holidaySet.has(dateStr) || nonWorkingSet.has(dateStr)) continue;

      const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);

      const dayDateLabel = day.toLocaleDateString("en-PH", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      });

      const availableTechs = [];

      for (const tech of candidates) {
        const tid = String(tech._id);

        // Check leave
        if (leaveMap.has(tid) && leaveMap.get(tid).has(dateStr)) continue;

        // Check technician schedule rest days
        const sched = scheduleMap.get(tid);
        if (sched && Array.isArray(sched.restDates)) {
          const isRest = sched.restDates.some(rd => {
            const rdDate = new Date(rd.date).toISOString().slice(0, 10);
            return rdDate === dateStr;
          });
          if (isRest) continue;
        }

        // Get working blocks — if empty array â†’ tech doesn't work this day
        const workingBlocks = getWorkingBlocks(tech._id, day);
        if (!workingBlocks.length) continue;

        // Resolve all IDs to match (user vs technician _id)
        const techIdsToMatch = [tid];
        const byTechId = await Technician.findById(tech._id).select("_id user").lean();
        if (byTechId) {
          if (byTechId._id) techIdsToMatch.push(String(byTechId._id));
          if (byTechId.user) techIdsToMatch.push(String(byTechId.user));
        }

        const uniqueTechIds = [...new Set(techIdsToMatch)];

        // Load all busy ranges in parallel: bookings, assignments, orders, project reservations
        const [bookings, assignments, orders, projectRes] = await Promise.all([
          BookingService.find({
            _id: { $ne: booking._id },
            technicianId: { $in: uniqueTechIds },
            bookingDate: { $gte: dayStart, $lte: dayEnd },
            status: { $in: ["pending", "confirmed", "scheduled", "on-the-way", "arrived", "in-progress", "assigned", "inspection_scheduled", "inspection_in_progress", "repair_scheduled", "repair_in_progress", "payment_verified"] },
          }).select("startTime endTime serviceDurationMinutes travelTime").lean(),
          Assignment.find({
            technicianId: { $in: uniqueTechIds },
            bookingDate: { $gte: dayStart, $lte: dayEnd },
            status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
          }).select("startTime endTime bookingDate").lean(),
          Order.find({
            technicianId: { $in: uniqueTechIds },
            "delivery.preferredDate": { $gte: dayStart, $lte: dayEnd },
            status: { $in: ["technician_assigned", "technician_accepted", "out_for_delivery", "arrived", "installing"] },
          }).select("delivery.preferredDate timeSlot").lean(),
          (async () => {
            try {
              const engine = require("../utils/enterpriseSchedulingEngine");
              if (engine.getProjectReservationsForDate) {
                return await engine.getProjectReservationsForDate(day);
              }
            } catch (_) { /* ignore */ }
            return [];
          })(),
        ]);

        const busyRanges = [];

        // BookingService conflicts
        for (const b of bookings) {
          const startMin = parseTime(b.startTime);
          if (Number.isNaN(startMin)) continue;
          let endMin = parseTime(b.endTime);
          if (Number.isNaN(endMin)) {
            const dur = (Number(b.serviceDurationMinutes) || serviceDuration) + Math.max(0, Number(b.travelTime) || 0);
            endMin = startMin + dur;
          }
          if (endMin > startMin) busyRanges.push({ start: startMin, end: endMin });
        }

        // Assignment conflicts
        for (const a of assignments) {
          const startMin = parseTime(a.startTime);
          if (Number.isNaN(startMin)) continue;
          let endMin = parseTime(a.endTime);
          if (Number.isNaN(endMin)) endMin = startMin + serviceDuration + 30;
          if (endMin > startMin) busyRanges.push({ start: startMin, end: endMin });
        }

        // Order conflicts (delivery/installation)
        for (const o of orders) {
          const startMin = parseTime(o.timeSlot);
          if (!Number.isNaN(startMin)) {
            busyRanges.push({ start: startMin, end: startMin + serviceDuration });
          } else {
            // Default 8AM–5PM block for orders without explicit time
            busyRanges.push({ start: 8 * 60, end: 17 * 60 });
          }
        }

        // Project reservations (large-scale)
        if (Array.isArray(projectRes)) {
          for (const pr of projectRes) {
            const prTechId = pr.technicianId ? String(pr.technicianId) : null;
            const prTechUser = pr.technicianUser ? String(pr.technicianUser) : null;
            if (prTechId && uniqueTechIds.includes(prTechId) || prTechUser && uniqueTechIds.includes(prTechUser)) {
              const startMin = parseTime(pr.startTime || "08:00");
              const endMin = parseTime(pr.endTime || "17:00");
              if (!Number.isNaN(startMin) && !Number.isNaN(endMin) && endMin > startMin) {
                busyRanges.push({ start: startMin, end: endMin });
              }
            }
          }
        }

        const gaps = findFreeGaps(workingBlocks, busyRanges);
        const slots = generateSlotLabels(gaps, totalSlotDuration, slotInterval);

        if (slots.length) {
          availableTechs.push({
            id: tid,
            name: tech.name,
            slots: slots.map(s => ({ time: s.label, startMin: s.startMin, endMin: s.endMin })),
          });
        }
      }

      if (availableTechs.length) {
        suggestions.push({
          date: dayStart.toISOString(),
          dateLabel: dayDateLabel,
          availableTechnicians: availableTechs,
        });
      }
    }

    res.json({
      bookingId,
      currentBookingDate: booking.bookingDate,
      serviceDurationMinutes: serviceDuration,
      suggestions,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// REVENUE REPORTS — FILTERED API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/reports/revenue
 * Filtered revenue analytics endpoint. Supports:
 *   from / to          — date range (ISO strings)
 *   source             — "all" | "service" | "order" | "pos"
 *   paymentMethod      — "all" | "gcash" | "cod" | "bank" | "other"
 *   paymentStatus      — "all" | "paid" | "pending" | "partial" | "failed"
 *   serviceType        — "all" | "core" | "repair"
 *   technician         — technician ID or "all"
 *   period             — preset: "this_month" | "last_month" | "last_3_months" | "last_6_months" | "ytd" | "custom"
 */
router.get("/reports/revenue", async (req, res, next) => {
  try {
    const { buildRevenueAnalytics } = require("../utils/revenueAnalytics");
    const { filters, technicians, analytics } = await buildRevenueAnalytics(req.query);
    return res.json({ success: true, filters, technicians, analytics });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    console.error("Revenue reports API error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});


module.exports = router;


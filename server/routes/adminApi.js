const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const QRCode = require("qrcode");
const admin = require("../controllers/adminController");
const auth = require("../middleware/authenticate");
const audit = require("../utils/audit");
const User = require("../models/User");
const { requirePermission } = require("../middleware/requirePermission");
const { assertAdminTransition, assertResolution, REMITTANCE_STATUSES } = require("../utils/remittancePolicy");
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

async function reconcileOrderRefundState(orderId) {
  const Payment = require("../models/Payment");
  const Order = require("../models/Order");
  const relatedPayments = await Payment.find({ orderId }).select("refundStatus refundAmount refundReason").lean();
  const refundable = relatedPayments.filter(payment => Number(payment.refundAmount) > 0 || payment.refundStatus !== "none");
  const requestedAmount = refundable.reduce((sum, payment) => sum + Math.max(0, Number(payment.refundAmount) || 0), 0);
  const completedAmount = refundable
    .filter(payment => payment.refundStatus === "completed")
    .reduce((sum, payment) => sum + Math.max(0, Number(payment.refundAmount) || 0), 0);
  const hasOutstanding = refundable.some(payment => ["pending", "processing"].includes(payment.refundStatus));
  const refundStatus = hasOutstanding
    ? (completedAmount > 0 ? "partial" : "pending")
    : (requestedAmount > 0 ? "completed" : "none");
  const latestReason = [...refundable].reverse().find(payment => payment.refundReason)?.refundReason || "";

  await Order.findByIdAndUpdate(orderId, {
    ...(refundStatus === "completed" ? { paymentStatus: "refunded" } : {}),
    refundStatus,
    refundAmount: requestedAmount,
    ...(latestReason ? { refundReason: latestReason } : {}),
  });
}

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

// Authoritative operational control-center snapshot. This intentionally stays
// separate from long-range analytics: every number represents current work,
// a review queue, custody exposure, or cash-control responsibility.
router.get("/dashboard/operations", async (req, res, next) => {
  try {
    const { buildAdminOperationsDashboard } = require("../utils/adminOperationsDashboard");
    res.set("Cache-Control", "no-store");
    return res.json(await buildAdminOperationsDashboard(new Date()));
  } catch (error) {
    return next(error);
  }
});

// Live records behind a selected Service Analytics chart element. The route
// inherits the admin authentication middleware above and accepts only bounded,
// valid database identifiers supplied by the rendered report.
router.post("/reports/service/drilldown", async (req, res, next) => {
  try {
    const mongoose = require("mongoose");
    const BookingService = require("../models/BookingService");
    const Order = require("../models/Order");
    const WarrantyClaim = require("../models/WarrantyClaim");
    const Assignment = require("../models/Assignment");
    const Rating = require("../models/Rating");
    const Technician = require("../models/Technician");
    const { isRepairBooking, ratingForBooking, resolveBookedValue, statusGroup } = require("../utils/serviceAnalytics");

    const supplied = Array.isArray(req.body?.records) ? req.body.records : [];
    if (supplied.length > 500) return res.status(400).json({ error: "A maximum of 500 records can be requested." });

    const unique = new Map();
    supplied.forEach((record) => {
      const type = record?.type === "order" ? "order" : "booking";
      const id = String(record?.id || "");
      if (mongoose.isValidObjectId(id)) unique.set(`${type}:${id}`, { type, id });
    });
    const selections = [...unique.values()];
    const bookingIds = selections.filter(record => record.type === "booking").map(record => record.id);
    const orderIds = selections.filter(record => record.type === "order").map(record => record.id);

    const [bookings, orders, ratings] = await Promise.all([
      bookingIds.length ? BookingService.find({ _id: { $in: bookingIds } }).lean() : [],
      orderIds.length ? Order.find({ _id: { $in: orderIds } }).lean() : [],
      bookingIds.length ? Rating.find({ targetType: "booking", targetId: { $in: bookingIds } }).select("targetId score").lean() : [],
    ]);
    const technicianIds = [...new Set(bookings.map(booking => String(booking.technicianId || "")).filter(mongoose.isValidObjectId))];
    const technicians = technicianIds.length
      ? await Technician.find({ _id: { $in: technicianIds } }).select("name").lean()
      : [];
    const technicianNames = new Map(technicians.map(technician => [String(technician._id), technician.name]));
    const ratingTotals = new Map();
    ratings.forEach((rating) => {
      const id = String(rating.targetId);
      const current = ratingTotals.get(id) || { total: 0, count: 0 };
      current.total += Number(rating.score) || 0;
      current.count += 1;
      ratingTotals.set(id, current);
    });
    const ratingByBooking = new Map([...ratingTotals].map(([id, value]) => [id, value.count ? value.total / value.count : 0]));

    const bookingRows = bookings.map(booking => ({
      id: String(booking._id),
      recordType: "booking",
      reference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
      date: booking.createdAt,
      customer: booking.customer?.name || "Unknown Customer",
      contact: booking.customer?.phone || booking.customer?.email || "-",
      service: booking.service?.name || booking.services?.map(service => service.name).filter(Boolean).join(", ") || booking.serviceType || "Service",
      segment: isRepairBooking(booking) ? "Repair" : "Core Service",
      status: booking.status || "pending",
      statusGroup: statusGroup(booking.status),
      technician: booking.technician?.name || technicianNames.get(String(booking.technicianId || "")) || "Unassigned",
      payment: String(booking.paymentMethod || "other").toUpperCase(),
      scale: booking.isProject ? "Large-scale" : "Standard",
      rating: ratingForBooking(booking, ratingByBooking),
      amount: resolveBookedValue(booking),
    }));
    const orderRows = orders.map(order => ({
      id: String(order._id),
      recordType: "order",
      reference: order.orderReference || `#${String(order._id).slice(-6).toUpperCase()}`,
      date: order.createdAt,
      customer: order.customer?.name || "Unknown Customer",
      contact: order.customer?.phone || order.customer?.email || "-",
      service: (order.items || []).map(item => [item.brand, item.modelLine].filter(Boolean).join(" ")).filter(Boolean).join(", ") || "Product Order",
      segment: "Orders",
      status: order.status || "pending",
      statusGroup: statusGroup(order.status),
      technician: order.technician?.name || "Unassigned",
      payment: String(order.paymentMethod || "other").toUpperCase(),
      scale: "Order",
      rating: 0,
      amount: Number(order.total || order.totalAmount) || 0,
    }));
    const rowByKey = new Map([...bookingRows, ...orderRows].map(row => [`${row.recordType}:${row.id}`, row]));
    const rows = selections.map(record => rowByKey.get(`${record.type}:${record.id}`)).filter(Boolean);
    const ratedRows = rows.filter(row => Number(row.rating) > 0);

    res.json({
      rows,
      summary: {
        records: rows.length,
        bookedValue: rows.reduce((total, row) => total + Number(row.amount || 0), 0),
        completed: rows.filter(row => row.statusGroup === "completed").length,
        averageRating: ratedRows.length ? ratedRows.reduce((total, row) => total + Number(row.rating), 0) / ratedRows.length : 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/reports/orders/drilldown", async (req, res, next) => {
  try {
    const Order = require("../models/Order");
    const Payment = require("../models/Payment");
    const { inRange, netPaymentsThrough, orderCompletionDate, parseReportDate } = require("../utils/enterpriseRevenue");
    const { buildOrderFilter, combineOrderFilters, parseOrderReportFilters } = require("../utils/orderReportFilters");

    const from = parseReportDate(req.body?.from);
    const to = parseReportDate(req.body?.to, true);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      return res.status(400).json({ error: "A valid reporting date range is required." });
    }
    if (to - from > 365 * 86400000) return res.status(400).json({ error: "Order drilldowns are limited to 366 days." });

    const dimension = String(req.body?.dimension || "all");
    const allowedDimensions = new Set(["all", "status", "fulfillment", "payment", "brand", "trend"]);
    if (!allowedDimensions.has(dimension)) return res.status(400).json({ error: "Invalid order drilldown dimension." });
    const value = String(req.body?.value || "").trim().slice(0, 100);
    const dimensionValues = {
      status: new Set(["pending_payment", "preparing_unit", "ready_for_pickup", "technician_assigned", "technician_accepted", "technician_declined", "out_for_delivery", "arrived", "installing", "completed", "cancelled", "unknown"]),
      fulfillment: new Set(["delivery_only", "delivery_installation", "customer_pickup", "unknown"]),
      payment: new Set(["pending", "payment_collected", "waiting_for_remittance", "remitted", "verified", "rejected", "refunded", "paid", "failed", "partial"]),
    };
    if (dimensionValues[dimension] && !dimensionValues[dimension].has(value)) {
      return res.status(400).json({ error: "Invalid order chart selection." });
    }
    if (dimension === "brand" && !value) return res.status(400).json({ error: "A brand selection is required." });
    const dataset = String(req.body?.dataset || "orders").trim().slice(0, 100).toLowerCase();
    const allowedTrendDatasets = new Set(["orders placed", "booked order value", "recognized sales"]);
    if (dimension === "trend" && !allowedTrendDatasets.has(dataset)) {
      return res.status(400).json({ error: "Invalid order trend dataset." });
    }
    const completionBased = dimension === "brand" || (dimension === "trend" && dataset === "recognized sales");
    const reportFilters = parseOrderReportFilters(req.body);
    const baseOrderFilter = buildOrderFilter(reportFilters);
    let bucketStart = null;
    let bucketEnd = null;
    if (dimension === "trend") {
      bucketStart = new Date(req.body?.bucketStart);
      bucketEnd = new Date(req.body?.bucketEnd);
      const invalidBucket = Number.isNaN(bucketStart.getTime())
        || Number.isNaN(bucketEnd.getTime())
        || bucketStart > bucketEnd
        || bucketStart < from
        || bucketEnd > to;
      if (invalidBucket) return res.status(400).json({ error: "Invalid chart bucket." });
    }

    let query;
    if (completionBased) {
      const completionWindow = dimension === "trend"
        ? { $gte: bucketStart, $lte: bucketEnd }
        : { $gte: from, $lte: to };
      const completionFilter = {
        status: "completed",
        $or: [
          { completedAt: completionWindow },
          { statusHistory: { $elemMatch: { status: "completed", timestamp: completionWindow } } },
          { completedAt: null, "statusHistory.status": { $ne: "completed" }, updatedAt: completionWindow },
        ],
      };
      let dimensionFilter = {};
      if (dimension === "brand" && value === "Unspecified") {
        dimensionFilter = { $or: [{ "items.brand": { $exists: false } }, { "items.brand": null }, { "items.brand": "" }] };
      } else if (dimension === "brand") dimensionFilter = { "items.brand": value };
      query = combineOrderFilters(baseOrderFilter, completionFilter, dimensionFilter);
    } else {
      const createdAt = dimension === "trend"
        ? { $gte: bucketStart, $lte: bucketEnd }
        : { $gte: from, $lte: to };
      let dimensionFilter = {};
      if (dimension === "status") dimensionFilter = { status: value === "unknown" ? null : value };
      if (dimension === "fulfillment") dimensionFilter = { fulfillmentType: value === "unknown" ? null : value };
      if (dimension === "payment") dimensionFilter = { paymentStatus: value };
      if (dimension === "trend" && dataset === "booked order value") dimensionFilter = { status: { $ne: "cancelled" } };
      query = combineOrderFilters(baseOrderFilter, { createdAt }, dimensionFilter);
    }

    let orders = await Order.find(query).sort({ createdAt: -1 }).limit(501).lean();
    if (completionBased) orders = orders.filter(order => inRange(orderCompletionDate(order),
      dimension === "trend" ? bucketStart : from,
      dimension === "trend" ? bucketEnd : to));
    const truncated = orders.length > 500;
    orders = orders.slice(0, 500);
    const orderIds = orders.map(order => order._id);
    const payments = orderIds.length ? await Payment.find({ orderId: { $in: orderIds } }).lean() : [];
    const paymentsByOrder = new Map();
    payments.forEach(payment => {
      const key = String(payment.orderId);
      if (!paymentsByOrder.has(key)) paymentsByOrder.set(key, []);
      paymentsByOrder.get(key).push(payment);
    });

    const rows = orders.map(order => {
      const collected = netPaymentsThrough(paymentsByOrder.get(String(order._id)) || [], to);
      const amount = Number(order.total || 0);
      const selectedItems = dimension === "brand"
        ? (order.items || []).filter(item => value === "Unspecified" ? !item.brand : item.brand === value)
        : [];
      const selectedUnits = selectedItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      const selectedRevenue = selectedItems.reduce((sum, item) => {
        const quantity = Math.max(0, Number(item.quantity) || 0);
        const lineTotal = Number(item.totalPrice) || (Number(item.unitPrice) || 0) * quantity;
        return sum + Math.max(0, lineTotal);
      }, 0);
      return {
        id: String(order._id),
        reference: order.orderReference || `#${String(order._id).slice(-6).toUpperCase()}`,
        customer: order.customer?.name || "Unknown Customer",
        products: (order.items || []).map(item => [item.brand, item.modelLine].filter(Boolean).join(" ")).filter(Boolean).join(", ") || "Product order",
        status: order.status || "unknown",
        fulfillment: order.fulfillmentType || "unknown",
        payment: order.paymentStatus || "pending",
        date: order.createdAt,
        completionDate: orderCompletionDate(order),
        units: (order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
        selectedUnits,
        selectedRevenue,
        amount,
        collected,
        balance: Math.max(0, amount - collected),
      };
    });
    res.json({
      rows,
      truncated,
      summary: {
        records: rows.length,
        orderValue: rows.reduce((sum, row) => sum + row.amount, 0),
        selectedRevenue: rows.reduce((sum, row) => sum + row.selectedRevenue, 0),
        selectedUnits: rows.reduce((sum, row) => sum + row.selectedUnits, 0),
        collected: rows.reduce((sum, row) => sum + row.collected, 0),
        outstanding: rows.reduce((sum, row) => sum + row.balance, 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/reports/orders/export", async (req, res, next) => {
  try {
    const Order = require("../models/Order");
    const { parseReportDate } = require("../utils/enterpriseRevenue");
    const { buildOrderFilter, combineOrderFilters, parseOrderReportFilters } = require("../utils/orderReportFilters");
    const from = parseReportDate(req.query.from);
    const to = parseReportDate(req.query.to, true);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to || to - from > 365 * 86400000) {
      return res.status(400).json({ error: "Export requires a valid reporting range of no more than 366 days." });
    }
    const reportFilters = parseOrderReportFilters(req.query);
    const filter = combineOrderFilters(
      buildOrderFilter(reportFilters),
      { createdAt: { $gte: from, $lte: to } },
    );
    const count = await Order.countDocuments(filter);
    if (count > 50000) return res.status(413).json({ error: "This export exceeds 50,000 orders. Select a smaller date range." });
    const orders = await Order.find(filter).sort({ createdAt: -1 }).lean();
    const safeCell = value => {
      let text = String(value ?? "").replace(/\r?\n/g, " ");
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const header = ["Date", "Reference", "Customer", "Email", "Units", "Fulfillment", "Payment Method", "Payment Status", "Order Status", "Subtotal", "Fees", "Total"];
    const rows = orders.map(order => [
      new Date(order.createdAt).toISOString(), order.orderReference || order._id, order.customer?.name,
      order.customer?.email, (order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
      order.fulfillmentType, order.paymentMethod, order.paymentStatus, order.status, Number(order.subtotal || 0),
      Number(order.deliveryFee || 0) + Number(order.installationFee || 0) + Number(order.transportationFee || 0), Number(order.total || 0),
    ]);
    const csv = [header, ...rows].map(row => row.map(safeCell).join(",")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="order-analytics-${req.query.from}-${req.query.to}.csv"`);
    res.send(`\uFEFF${csv}`);
  } catch (err) {
    next(err);
  }
});

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

// Create new technician
router.post("/technicians", async (req, res) => {
  try {
    const Technician = require("../models/Technician");
    const { name, userEmail, phone, active, locationText } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: "Name is required." });
    const tech = await Technician.create({
      name: name.trim(),
      userEmail: userEmail ? userEmail.trim().toLowerCase() : undefined,
      phone: phone ? phone.trim() : undefined,
      active: active !== false,
      locationText: locationText ? locationText.trim() : undefined,
    });
    res.json({ success: true, technician: tech });
  } catch (err) {
    console.error("POST /api/admin/technicians error:", err);
    res.status(500).json({ error: err.message || "Failed to create technician." });
  }
});

// Update technician
router.put("/technicians/:id", async (req, res) => {
  try {
    const Technician = require("../models/Technician");
    const { name, userEmail, phone, active, locationText } = req.body;
    const update = {};
    if (name !== undefined) update.name = name.trim();
    if (userEmail !== undefined) update.userEmail = userEmail ? userEmail.trim().toLowerCase() : null;
    if (phone !== undefined) update.phone = phone ? phone.trim() : null;
    if (active !== undefined) update.active = active;
    if (locationText !== undefined) update.locationText = locationText ? locationText.trim() : null;
    const tech = await Technician.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!tech) return res.status(404).json({ error: "Technician not found." });
    res.json({ success: true, technician: tech });
  } catch (err) {
    console.error("PUT /api/admin/technicians/:id error:", err);
    res.status(500).json({ error: err.message || "Failed to update technician." });
  }
});

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
    const category = await ServiceCategory.findByIdAndUpdate(req.params.id, update, { returnDocument: "after", runValidators: true });
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
    const category = await ServiceCategory.findByIdAndUpdate(req.params.id, { order }, { returnDocument: "after" });
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

    // Normalize reason: convert empty string to null, and ensure it's a valid enum value or null
    let normalizedReason = reason || null;
    if (typeof normalizedReason === 'string' && normalizedReason.trim() === '') {
      normalizedReason = null;
    }

    const result = await StockAdjustment.record({
      toolId: id,
      type,
      delta,
      adjustedBy: req.user._id,
      reason: normalizedReason,
      notes: notes || null,
    });

    return res.json({ message: "Stock adjusted", adjustment: result.adjustment, tool: result.tool });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[STOCK] Adjustment error:', err.message, err);
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
    const status = String(req.query.status || "all");
    const requestedStatus = status !== "all" ? status : null;
    if (requestedStatus && !REMITTANCE_STATUSES.includes(requestedStatus)) {
      return res.status(400).json({ error: "Invalid remittance status filter." });
    }
    const normalStatuses = requestedStatus ? [requestedStatus] : REMITTANCE_STATUSES;
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

    const limit = Math.min(Math.max(1, Number(req.query.limit) || 100), 200);
    const page = Math.max(0, Number(req.query.page) || 0);
    const paged = visiblePayments.slice(page * limit, (page + 1) * limit);
    const summaryRows = await Payment.aggregate([
      { $match: { status: { $in: REMITTANCE_STATUSES } } },
      { $group: { _id: { status: "$status", resolved: { $cond: [{ $ifNull: ["$resolvedAt", false] }, true, false] } }, count: { $sum: 1 }, amount: { $sum: "$amount" } } },
    ]);
    const summary = { waiting_for_remittance: { count: 0, amount: 0 }, remitted: { count: 0, amount: 0 }, verified: { count: 0, amount: 0 }, rejected: { count: 0, amount: 0 }, unaccounted: { count: 0, amount: 0 }, resolved: { count: 0, amount: 0 } };
    summaryRows.forEach((row) => {
      const key = row._id.status === "unaccounted" && row._id.resolved ? "resolved" : row._id.status;
      if (summary[key]) summary[key] = { count: Number(row.count || 0), amount: Number(row.amount || 0) };
    });

    res.json({ payments: paged, total: visiblePayments.length, page, limit, summary });
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
    const User = require("../models/User");
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid payment ID." });
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    const transition = assertAdminTransition(payment, req.body.action, req.body);
    const action = transition.action;
    const allowed = { verify: "verified", reject: "rejected", refund: "refunded", override: "verified", flag: "unaccounted", reopen: "waiting_for_remittance" };
    const nextStatus = allowed[action];
    const now = new Date();
    const closesFlaggedException = Boolean(payment.flaggedAt && !payment.resolvedAt && ["verify", "override"].includes(action));
    const previousResolution = action === "reopen" ? {
      type: payment.resolutionType,
      resolvedAt: payment.resolvedAt,
      notes: payment.resolutionNotes,
      payrollDeductionId: payment.payrollDeductionId,
    } : null;
    payment.status = nextStatus;
    if (action === "verify") { payment.verifiedBy = req.user._id; payment.verifiedAt = now; payment.completedAt = now; }
    if (action === "override") {
      payment.verifiedBy = req.user._id;
      payment.verifiedAt = now;
      payment.completedAt = now;
      payment.overrideBy = req.user._id;
      payment.overrideAt = now;
      payment.overrideNotes = transition.notes;
    }
    if (closesFlaggedException) {
      payment.resolutionType = "recovery";
      payment.resolvedBy = req.user._id;
      payment.resolvedAt = now;
      payment.resolutionNotes = transition.notes || "Recovered remittance evidence verified by administration.";
      payment.recoveryFollowUpDate = undefined;
    }
    if (action === "reopen") {
      payment.resolutionType = "recovery";
      payment.resolvedBy = undefined;
      payment.resolvedAt = undefined;
      payment.resolutionNotes = transition.reason;
      payment.recoveryFollowUpDate = undefined;
    }
    if (action === "flag") {
      payment.flaggedBy = req.user._id;
      payment.flaggedAt = now;
      payment.flagReason = transition.reason;
      // Create violation on the technician's linked User account
      const Technician = require("../models/Technician");
      const tech = payment.collectedBy ? await Technician.findById(payment.collectedBy) : null;
      const techUser = tech && tech.user ? await User.findById(tech.user) : null;
      if (techUser) {
        const ref = payment.bookingId?.bookingReference || payment.orderId?.orderReference || payment.projectId?.projectReference || String(payment._id).slice(-8);
        techUser.addViolation("remittance_unaccounted", `Payment ₱${Number(payment.amount || 0).toLocaleString()} for ${ref} was not remitted. ${transition.reason}`);
        await techUser.save();
        payment.violationUserId = techUser._id;
      }
    }
    if (action === "reject") { payment.rejectedBy = req.user._id; payment.rejectedAt = now; payment.rejectionReason = transition.reason; }
    if (action === "refund") {
      payment.refundedBy = req.user._id;
      payment.refundedAt = now;
      payment.refundReason = transition.reason;
      payment.refundStatus = "completed";
      payment.refundAmount = Math.min(
        Number(payment.amount) || 0,
        Number(payment.refundAmount) > 0 ? Number(payment.refundAmount) : Number(payment.amount) || 0,
      );
      payment.refundMethod = payment.refundMethod || "original";
    }
    payment.events = payment.events || [];
    payment.events.push({ status: nextStatus, actor: req.user._id, actorName: req.user.name || req.user.email, actorRole: req.user.role, note: transition.reason || transition.notes, at: now, metadata: { action, ...(previousResolution ? { previousResolution } : {}) } });
    await payment.save();
    const subjectPaymentStatus = ["reject", "flag"].includes(action) ? "waiting_for_remittance" : nextStatus;
    const update = { paymentStatus: subjectPaymentStatus };
    if (payment.bookingId) {
      const booking = await BookingService.findById(payment.bookingId);
      if (booking) {
        const relatedPayments = await Payment.find({ bookingId: booking._id }).lean();
        const { reconcileBookingPayments } = require("../utils/paymentSummary");
        const reconciliation = reconcileBookingPayments(booking, relatedPayments);
        booking.amountPaid = reconciliation.ledgerCollected;
        booking.balanceAmount = reconciliation.outstandingFromLedger;
        booking.balanceCollected = reconciliation.outstandingFromLedger <= 0.01;
        if (!booking.balanceCollected) {
          booking.balanceCollectedAt = null;
          booking.balanceCollectedBy = null;
        }
        if (action === "verify" || action === "override") booking.paymentStatus = booking.balanceCollected ? "verified" : "partial";
        else if (action === "reject" || action === "flag") booking.paymentStatus = booking.balanceCollected ? "waiting_for_remittance" : "partial";
        else booking.paymentStatus = subjectPaymentStatus;
        await booking.save();
      }
    }
    if (payment.orderId) {
      if (action === "refund") await reconcileOrderRefundState(payment.orderId);
      else await Order.findByIdAndUpdate(payment.orderId, update);
    }
    if (payment.projectId) await Project.findByIdAndUpdate(payment.projectId, { "payment.paymentStatus": subjectPaymentStatus });
    if (payment.collectedBy && ["verify", "reject", "flag", "override", "reopen"].includes(action)) {
      const { createNotification } = require("../utils/notify");
      const Technician = require("../models/Technician");
      const technician = await Technician.findById(payment.collectedBy).select("user").lean();
      const technicianUserId = payment.remittedBy || technician?.user;
      const notification = {
        verify: { title: "Remittance verified", message: `Your ₱${Number(payment.amount || 0).toLocaleString()} remittance was verified by administration.`, priority: "normal" },
        override: { title: "Cash handover verified", message: `Administration recorded and verified the ₱${Number(payment.amount || 0).toLocaleString()} in-person handover.`, priority: "normal" },
        reject: { title: "Remittance correction required", message: `Your ₱${Number(payment.amount || 0).toLocaleString()} remittance needs correction: ${transition.reason}`, priority: "high" },
        flag: { title: "Remittance escalated", message: `The ₱${Number(payment.amount || 0).toLocaleString()} collection was escalated as unaccounted: ${transition.reason}`, priority: "urgent" },
        reopen: { title: "Recovery submission required", message: `Administration reopened the ₱${Number(payment.amount || 0).toLocaleString()} exception for recovery: ${transition.reason}`, priority: "high" },
      }[action];
      if (technicianUserId) {
        await createNotification({ type: action === "reopen" ? "remittance_recovery" : `remittance_${action}`, ...notification, userId: technicianUserId, role: "technician", referenceId: payment._id, referenceModel: "Payment", link: "/technician/remittances", io: req.app.get("io") });
      }
    }
    await audit.logEvent({ actor: req.user._id, target: payment._id, action: `payment.${nextStatus}`, module: "payment", req, details: { reason: req.body.reason, notes: req.body.notes } }).catch(() => {});
    res.json({ message: `Payment marked ${nextStatus.replace(/_/g, " ")}.`, payment });
  } catch (err) { next(err); }
});

/**
 * PATCH /api/admin/remittances/:id/resolve
 * Resolve an unaccounted payment: write-off, deduct from payroll, or recovery.
 */
router.patch("/remittances/:id/resolve", async (req, res, next) => {
  try {
    const Payment = require("../models/Payment");
    const Technician = require("../models/Technician");
    const Payroll = require("../models/Payroll");
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid payment ID." });
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    const now = new Date();
    const resolution = assertResolution(payment, req.body, now);
    const { resolutionType } = resolution;
    payment.resolutionType = resolutionType;
    payment.resolvedBy = req.user._id;
    payment.resolvedAt = now;
    payment.resolutionNotes = resolution.notes;
    payment.events = payment.events || [];
    payment.events.push({ status: "resolved", actor: req.user._id, actorName: req.user.name || req.user.email, actorRole: req.user.role, note: `Resolved: ${resolutionType.replace(/_/g, " ")}. ${payment.resolutionNotes}`, at: now, metadata: { resolutionType } });

    if (resolutionType === "deduct_from_payroll") {
      const tech = payment.collectedBy ? await Technician.findById(payment.collectedBy) : null;
      if (!tech || !tech.user) return res.status(400).json({ error: "Cannot deduct: no linked user account found for this technician." });
      const techUserId = tech.user;
      const payroll = await Payroll.findOne({ employee: techUserId, periodStart: { $lte: now }, periodEnd: { $gte: now }, status: "draft" });
      if (!payroll) {
        return res.status(409).json({ error: "Generate the technician's draft payroll for the current period before applying this deduction. No placeholder payroll was created." });
      }
      const paymentMarker = String(payment._id).slice(-8);
      const sourceReference = payment.bookingId?.bookingReference || payment.orderId?.orderReference || payment.projectId?.projectReference || paymentMarker;
      const deductionName = `Remittance ${sourceReference} [${paymentMarker}]`.slice(0, 80);
      const deductionAmount = Number(payment.amount) || 0;
      if (!payroll.deductions.some((line) => String(line.name || "").includes(paymentMarker))) {
        payroll.deductions.push({ name: deductionName, amount: deductionAmount });
        payroll.totalDeductions = payroll.deductions.reduce((sum, d) => sum + Number(d.amount || 0), 0);
        payroll.netPay = Math.max(0, (payroll.grossPay || 0) - payroll.totalDeductions);
        await payroll.save();
      }
      payment.payrollDeductionId = payroll._id;
    }

    // Recovery: reset status to waiting_for_remittance so technician can resubmit
    if (resolutionType === "recovery") {
      payment.status = "waiting_for_remittance";
      payment.resolutionType = "recovery";
      payment.recoveryFollowUpDate = resolution.followUpDate;
    }

    await payment.save();
    if (resolutionType === "recovery") {
      if (payment.bookingId) await require("../models/BookingService").findByIdAndUpdate(payment.bookingId, { paymentStatus: "waiting_for_remittance" });
      if (payment.orderId) await require("../models/Order").findByIdAndUpdate(payment.orderId, { paymentStatus: "waiting_for_remittance" });
      if (payment.projectId) await require("../models/Project").findByIdAndUpdate(payment.projectId, { "payment.paymentStatus": "waiting_for_remittance" });
      const { createNotification } = require("../utils/notify");
      const technician = payment.collectedBy ? await Technician.findById(payment.collectedBy).select("user").lean() : null;
      const technicianUserId = payment.remittedBy || technician?.user;
      if (technicianUserId) await createNotification({ type: "remittance_recovery", title: "Remittance correction required", message: `The ₱${Number(payment.amount || 0).toLocaleString()} collection was returned for recovery. Submit corrected handover evidence by ${resolution.followUpDate.toLocaleDateString("en-PH")}.`, userId: technicianUserId, role: "technician", referenceId: payment._id, referenceModel: "Payment", link: "/technician/remittances", priority: "high", io: req.app.get("io") });
    }
    await audit.logEvent({ actor: req.user._id, target: payment._id, action: `payment.resolved.${resolutionType}`, module: "payment", req, details: { resolutionType, notes: req.body.notes } }).catch(() => {});
    res.json({ message: `Payment resolved: ${resolutionType.replace(/_/g, " ")}.`, payment });
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/payments/:id/complete-refund
 * Admin marks a pending refund as completed after processing it externally.
 * Uploads proof and finalizes the refund status.
 *
 * Body: { proofUrl: string }
 */
router.post("/payments/:id/complete-refund", async (req, res, next) => {
  try {
    const Payment = require("../models/Payment");
    const BookingService = require("../models/BookingService");
    const { id } = req.params;
    const { proofUrl } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid payment ID" });

    const payment = await Payment.findById(id);
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    if (!["pending", "processing"].includes(payment.refundStatus)) {
      return res.status(409).json({ error: `Refund is not pending (current: ${payment.refundStatus}).` });
    }

    const now = new Date();
    payment.refundStatus = "completed";
    payment.status = "refunded";
    payment.refundedAt = now;
    payment.refundedBy = req.user?._id;
    if (proofUrl) payment.refundProofUrl = proofUrl;
    payment.events.push({
      status: "refunded",
      actor: req.user?._id,
      actorName: req.user?.name || req.user?.email || "Admin",
      actorRole: "admin",
      note: `Refund completed. Amount: ₱${payment.refundAmount || 0}${proofUrl ? " (proof uploaded)" : ""}`,
      at: now,
    });
    await payment.save();

    // Update booking refund status
    if (payment.bookingId) {
      await BookingService.findByIdAndUpdate(payment.bookingId, {
        paymentStatus: "refunded",
        refundStatus: "completed",
        refundProofUrl: proofUrl || undefined,
      }).catch(() => {});
    }
    if (payment.orderId) {
      await reconcileOrderRefundState(payment.orderId).catch(() => {});
    }

    await audit.logEvent({
      actor: req.user?._id,
      target: payment._id,
      action: "payment.refund_completed",
      module: "payment",
      req,
      details: { refundAmount: payment.refundAmount, proofUrl: !!proofUrl },
    }).catch(() => {});

    return res.json({ success: true, message: "Refund marked as completed.", payment });
  } catch (err) {
    console.error("Complete refund error:", err);
    next(err);
  }
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
  SETTING_KEY: AFTERCARE_SETTING_KEY,
  getAftercarePolicy,
  normalizeAftercarePolicy,
  warrantyRuleForBooking,
} = require("../utils/aftercarePolicy");
const {
  getDownpaymentPercentage,
  normalizeDownpaymentPercentage,
} = require("../utils/paymentPolicy");

/** GET /api/admin/settings/aftercare */
router.get("/settings/aftercare", async (_req, res, next) => {
  try {
    return res.json({ policy: await getAftercarePolicy() });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/settings/aftercare/governance
 *
 * One read model for the Aftercare governance screen. Catalog policies remain
 * stored on their owning service/product documents; this endpoint deliberately
 * does not create a second warranty configuration store.
 */
router.get("/settings/aftercare/governance", async (_req, res, next) => {
  try {
    const CoreService = require("../models/CoreService");
    const RepairService = require("../models/RepairService");
    const ServiceCategory = require("../models/ServiceCategory");
    const Inventory = require("../models/Inventory");
    const BookingService = require("../models/BookingService");
    const Order = require("../models/Order");
    const WarrantyClaim = require("../models/WarrantyClaim");
    const { normalizeServiceWarrantyPolicy, SERVICE_WARRANTY_DEFAULTS } = require("../utils/serviceWarrantyPolicy");

    const policy = await getAftercarePolicy();
    const now = new Date();
    const [coreDocs, repairDocs, repairCategoryDocs, productDocs, activeBookingWarranties, activeOrderWarranties, openClaims] = await Promise.all([
      CoreService.find({}).select("name slug category active warrantyPolicy updatedAt").sort({ active: -1, name: 1 }).lean(),
      RepairService.find({}).select("name slug applianceType active warrantyDays warrantyPolicy updatedAt").sort({ active: -1, name: 1 }).lean(),
      ServiceCategory.find({}).select("name slug unitTypes active warrantyPolicy updatedAt").sort({ active: -1, order: 1, name: 1 }).lean(),
      Inventory.find({}).select("modelLine capacity capacityUnit brand active warranty updatedAt").populate("brand", "name").sort({ active: -1, modelLine: 1 }).lean(),
      BookingService.countDocuments({ "warranty.endDate": { $gte: now }, "warranty.status": { $in: ["active", "claimed"] } }),
      Order.countDocuments({ "warranty.endDate": { $gte: now }, "warranty.status": { $in: ["active", "claimed"] } }),
      WarrantyClaim.countDocuments({ active: true, status: { $nin: ["resolved", "closed", "withdrawn"] } }),
    ]);

    function serviceRow(service, kind) {
      const policyKind = kind === "core" ? "core" : "repair";
      const configured = Boolean(service.warrantyPolicy && Number.isFinite(Number(service.warrantyPolicy.workmanshipDays)));
      const hasRecommendedDefault = Boolean(SERVICE_WARRANTY_DEFAULTS[String(service.slug || "").toLowerCase()]);
      const fallbackDays = policyKind === "repair" ? policy.warranty.repairBookingDays : policy.warranty.serviceBookingDays;
      const fallbackEnabled = policyKind === "repair" ? policy.warranty.repairBookingsEnabled : policy.warranty.serviceBookingsEnabled;
      const effectivePolicy = configured
        ? normalizeServiceWarrantyPolicy(service.warrantyPolicy, service, policyKind)
        : normalizeServiceWarrantyPolicy({ enabled: fallbackEnabled, ...(hasRecommendedDefault ? {} : { workmanshipDays: fallbackDays }) }, service, policyKind);
      return {
        id: String(service._id),
        kind,
        name: service.name,
        slug: service.slug,
        category: kind === "core"
          ? (service.category || "Core service")
          : kind === "repair_category"
            ? `${Array.isArray(service.unitTypes) ? service.unitTypes.length : 0} unit types`
            : (service.applianceType || "Repair catalog"),
        active: service.active !== false,
        policySource: configured ? "configured" : "fallback",
        fallbackKind: configured ? null : (hasRecommendedDefault ? "recommended_service_default" : "global_legacy_fallback"),
        policy: effectivePolicy,
        updatedAt: service.updatedAt || null,
      };
    }

    const services = [
      ...coreDocs.map(service => serviceRow(service, "core")),
      ...repairDocs.map(service => serviceRow(service, "repair")),
      ...repairCategoryDocs.map(service => serviceRow(service, "repair_category")),
    ];
    const products = productDocs.map(product => ({
      id: String(product._id),
      name: [product.brand?.name, product.modelLine].filter(Boolean).join(" ") || product.modelLine || "Product",
      capacity: [product.capacity, product.capacityUnit].filter(Boolean).join(" "),
      active: product.active !== false,
      manufacturerWarranty: String(product.warranty || "").trim(),
      configured: Boolean(String(product.warranty || "").trim()),
      updatedAt: product.updatedAt || null,
    }));
    const configuredServices = services.filter(service => service.policySource === "configured").length;
    const fallbackServices = services.length - configuredServices;
    const configuredProducts = products.filter(product => product.configured).length;

    res.set("Cache-Control", "no-store");
    return res.json({
      policy,
      summary: {
        totalServices: services.length,
        configuredServices,
        fallbackServices,
        totalProducts: products.length,
        configuredProducts,
        activeBookingWarranties,
        activeOrderWarranties,
        openClaims,
      },
      services,
      products,
      precedence: [
        "Issued warranty snapshot (immutable)",
        "Configured service, repair category, or product policy",
        "Legacy fallback policy",
      ],
      orderCoverage: {
        sellerEnabled: policy.warranty.productOrdersEnabled,
        sellerDays: policy.warranty.productOrderDays,
        installationWorkmanshipDays: 180,
        manufacturerTermsSource: "Product inventory",
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Strict, warranty-only update used by the governance hub. */
router.patch("/settings/aftercare/services/:kind/:id/warranty", async (req, res, next) => {
  try {
    const kind = String(req.params.kind || "").toLowerCase();
    if (!mongoose.Types.ObjectId.isValid(req.params.id) || !["core", "repair", "repair_category"].includes(kind)) {
      return res.status(400).json({ error: "A valid service type and service id are required." });
    }
    const Model = kind === "repair_category"
      ? require("../models/ServiceCategory")
      : kind === "repair"
        ? require("../models/RepairService")
        : require("../models/CoreService");
    const policyKind = kind === "core" ? "core" : "repair";
    const { normalizeServiceWarrantyPolicy } = require("../utils/serviceWarrantyPolicy");
    const service = await Model.findById(req.params.id);
    if (!service) return res.status(404).json({ error: "Service not found." });

    const previous = normalizeServiceWarrantyPolicy(service.warrantyPolicy, service, policyKind);
    const incoming = req.body?.warrantyPolicy || req.body || {};
    const nextPolicy = normalizeServiceWarrantyPolicy(incoming, service, policyKind);
    const comparablePrevious = { ...previous, termsVersion: undefined };
    const comparableNext = { ...nextPolicy, termsVersion: undefined };
    nextPolicy.termsVersion = JSON.stringify(comparablePrevious) === JSON.stringify(comparableNext)
      ? previous.termsVersion
      : Math.min(1000000, Math.max(1, Number(previous.termsVersion) || 1) + 1);

    service.warrantyPolicy = nextPolicy;
    if (kind === "repair") service.warrantyDays = nextPolicy.workmanshipDays;
    await service.save();
    await audit.logEvent({
      actor: req.user && req.user._id,
      target: service._id,
      action: kind === "repair_category"
        ? "settings.aftercare.repairCategoryWarranty.update"
        : `settings.aftercare.${kind}ServiceWarranty.update`,
      module: "admin",
      req,
      details: { serviceName: service.name, previous, warrantyPolicy: nextPolicy },
    }).catch(() => {});
    return res.json({
      message: `${service.name} warranty policy updated. Future completions will use version ${nextPolicy.termsVersion}.`,
      service: {
        id: String(service._id),
        kind,
        name: service.name,
        policySource: "configured",
        policy: nextPolicy,
      },
    });
  } catch (err) {
    next(err);
  }
});

/** Strict manufacturer-terms update. Existing order snapshots are untouched. */
router.patch("/settings/aftercare/products/:id/warranty", async (req, res, next) => {
  try {
    const Inventory = require("../models/Inventory");
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid product id." });
    if (typeof req.body?.manufacturerWarranty !== "string") return res.status(400).json({ error: "Manufacturer warranty terms are required." });
    const manufacturerWarranty = req.body.manufacturerWarranty.trim();
    if (manufacturerWarranty.length > 500) return res.status(400).json({ error: "Manufacturer warranty terms cannot exceed 500 characters." });
    const product = await Inventory.findById(req.params.id);
    if (!product) return res.status(404).json({ error: "Product not found." });
    const previous = String(product.warranty || "");
    product.warranty = manufacturerWarranty;
    await product.save();
    await audit.logEvent({
      actor: req.user && req.user._id,
      target: product._id,
      action: "settings.aftercare.productManufacturerWarranty.update",
      module: "admin",
      req,
      details: { productName: product.modelLine, previous, manufacturerWarranty },
    }).catch(() => {});
    return res.json({ message: "Manufacturer warranty terms updated for future orders.", product: { id: String(product._id), manufacturerWarranty } });
  } catch (err) {
    next(err);
  }
});

/** Update only future order seller coverage without overwriting other tabs. */
router.patch("/settings/aftercare/order-policy", async (req, res, next) => {
  try {
    const enabled = req.body?.enabled;
    const days = Number(req.body?.days);
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "Order seller coverage must be enabled or disabled explicitly." });
    if (!Number.isInteger(days) || days < 1 || days > 3650) return res.status(400).json({ error: "Order seller coverage must be between 1 and 3650 days." });
    await SiteSetting.findOneAndUpdate(
      { key: AFTERCARE_SETTING_KEY },
      { $set: { "value.warranty.productOrdersEnabled": enabled, "value.warranty.productOrderDays": days } },
      { upsert: true, setDefaultsOnInsert: true, runValidators: true },
    );
    const policy = await getAftercarePolicy();
    await audit.logEvent({
      actor: req.user && req.user._id,
      target: req.user && req.user._id,
      action: "settings.aftercare.orderWarranty.update",
      module: "admin",
      req,
      details: { enabled, days },
    }).catch(() => {});
    return res.json({ message: "Order warranty policy saved for future completions.", policy });
  } catch (err) {
    next(err);
  }
});

/** Update automation, reminders, and legacy fallback fields as one scoped form. */
router.patch("/settings/aftercare/automation", async (req, res, next) => {
  try {
    const supplied = req.body || {};
    const maintenance = supplied.maintenance || {};
    const reminders = supplied.reminders || {};
    const fallback = supplied.fallback || {};
    const numericRules = [
      ["Booking maintenance interval", maintenance.bookingIntervalDays, 30, 730],
      ["Order maintenance interval", maintenance.orderIntervalDays, 30, 730],
      ["First reminder", reminders.firstReminderDays, 2, 90],
      ["Final reminder", reminders.finalReminderDays, 1, 30],
      ["Core-service fallback", fallback.serviceBookingDays, 90, 3650],
      ["Repair fallback", fallback.repairBookingDays, 90, 3650],
    ];
    for (const [label, value, min, max] of numericRules) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) return res.status(400).json({ error: `${label} must be between ${min} and ${max} days.` });
    }
    const booleanRules = [
      maintenance.bookingsEnabled, maintenance.allowTechnicianRecommendation, maintenance.ordersEnabled,
      reminders.enabled, reminders.dueDateEnabled, reminders.overdueEnabled, reminders.notifyAdminWhenOverdue,
      fallback.serviceBookingsEnabled, fallback.repairBookingsEnabled,
    ];
    if (booleanRules.some(value => typeof value !== "boolean")) return res.status(400).json({ error: "Every automation and fallback switch must be enabled or disabled explicitly." });
    if (Number(reminders.firstReminderDays) <= Number(reminders.finalReminderDays)) return res.status(400).json({ error: "The first reminder must occur earlier than the final reminder." });

    const set = {
      "value.maintenance.bookingsEnabled": maintenance.bookingsEnabled,
      "value.maintenance.bookingIntervalDays": Number(maintenance.bookingIntervalDays),
      "value.maintenance.allowTechnicianRecommendation": maintenance.allowTechnicianRecommendation,
      "value.maintenance.ordersEnabled": maintenance.ordersEnabled,
      "value.maintenance.orderIntervalDays": Number(maintenance.orderIntervalDays),
      "value.reminders.enabled": reminders.enabled,
      "value.reminders.firstReminderDays": Number(reminders.firstReminderDays),
      "value.reminders.finalReminderDays": Number(reminders.finalReminderDays),
      "value.reminders.dueDateEnabled": reminders.dueDateEnabled,
      "value.reminders.overdueEnabled": reminders.overdueEnabled,
      "value.reminders.notifyAdminWhenOverdue": reminders.notifyAdminWhenOverdue,
      "value.warranty.serviceBookingsEnabled": fallback.serviceBookingsEnabled,
      "value.warranty.serviceBookingDays": Number(fallback.serviceBookingDays),
      "value.warranty.repairBookingsEnabled": fallback.repairBookingsEnabled,
      "value.warranty.repairBookingDays": Number(fallback.repairBookingDays),
    };
    await SiteSetting.findOneAndUpdate(
      { key: AFTERCARE_SETTING_KEY },
      { $set: set },
      { upsert: true, setDefaultsOnInsert: true, runValidators: true },
    );
    const policy = await getAftercarePolicy();
    await audit.logEvent({
      actor: req.user && req.user._id,
      target: req.user && req.user._id,
      action: "settings.aftercare.automationAndFallback.update",
      module: "admin",
      req,
      details: { maintenance: policy.maintenance, reminders: policy.reminders, fallback: { serviceBookingsEnabled: policy.warranty.serviceBookingsEnabled, serviceBookingDays: policy.warranty.serviceBookingDays, repairBookingsEnabled: policy.warranty.repairBookingsEnabled, repairBookingDays: policy.warranty.repairBookingDays } },
    }).catch(() => {});
    return res.json({ message: "Automation, reminders, and fallback policies saved.", policy });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/admin/settings/aftercare */
router.put("/settings/aftercare", async (req, res, next) => {
  try {
    const supplied = req.body?.policy || req.body || {};
    const numericRules = [
      ["Booking maintenance interval", supplied.maintenance?.bookingIntervalDays, 30, 730],
      ["Order maintenance interval", supplied.maintenance?.orderIntervalDays, 30, 730],
      ["First reminder", supplied.reminders?.firstReminderDays, 2, 90],
      ["Final reminder", supplied.reminders?.finalReminderDays, 1, 30],
      ["Service booking warranty", supplied.warranty?.serviceBookingDays, 90, 3650],
      ["Repair booking warranty", supplied.warranty?.repairBookingDays, 90, 3650],
      ["Product order warranty", supplied.warranty?.productOrderDays, 1, 3650],
    ];
    for (const [label, value, minimum, maximum] of numericRules) {
      const number = Number(value);
      if (!Number.isInteger(number) || number < minimum || number > maximum) {
        return res.status(400).json({ error: `${label} must be a whole number between ${minimum} and ${maximum} days.` });
      }
    }
    const booleanRules = [
      ["Booking maintenance automation", supplied.maintenance?.bookingsEnabled],
      ["Technician maintenance recommendations", supplied.maintenance?.allowTechnicianRecommendation],
      ["Order maintenance automation", supplied.maintenance?.ordersEnabled],
      ["Maintenance reminders", supplied.reminders?.enabled],
      ["Due-date reminders", supplied.reminders?.dueDateEnabled],
      ["Overdue reminders", supplied.reminders?.overdueEnabled],
      ["Administrator overdue alerts", supplied.reminders?.notifyAdminWhenOverdue],
      ["Service booking warranty", supplied.warranty?.serviceBookingsEnabled],
      ["Repair booking warranty", supplied.warranty?.repairBookingsEnabled],
      ["Product order warranty", supplied.warranty?.productOrdersEnabled],
    ];
    for (const [label, value] of booleanRules) {
      if (typeof value !== "boolean") return res.status(400).json({ error: `${label} must be enabled or disabled explicitly.` });
    }
    if (Number(supplied.reminders.firstReminderDays) <= Number(supplied.reminders.finalReminderDays)) {
      return res.status(400).json({ error: "The first reminder must occur earlier than the final reminder." });
    }

    const policy = normalizeAftercarePolicy(supplied);
    await SiteSetting.findOneAndUpdate(
      { key: AFTERCARE_SETTING_KEY },
      { value: policy },
      { upsert: true, setDefaultsOnInsert: true, runValidators: true },
    );
    await audit.logEvent({
      actor: req.user && req.user._id,
      target: req.user && req.user._id,
      action: "settings.aftercare.update",
      module: "admin",
      req,
      details: policy,
    }).catch(() => {});
    return res.json({ message: "Aftercare configuration saved successfully.", policy });
  } catch (err) {
    next(err);
  }
});

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
router.get("/roles", requirePermission("roles.view"), admin.listRoles);
router.get("/roles/:id", requirePermission("roles.view"), admin.getRole);
router.patch("/roles/:id", requirePermission("roles.manage"), admin.updateRolePermissions);
router.get("/roles/:id/users", requirePermission("roles.view"), admin.listRoleUsers);
router.patch("/users/:id/permissions", requirePermission("roles.manage"), admin.setUserPermissions);
router.delete("/users/:id/permissions", requirePermission("roles.manage"), admin.clearUserPermissions);
router.get("/permissions/all", requirePermission("roles.view"), admin.listAllPermissions);

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
    const { loadServiceRatingReport } = require("../utils/serviceRatingReport");
    const report = await loadServiceRatingReport(req.query);
    res.set("Cache-Control", "no-store, private");
    res.json({
      ratings: report.rows,
      analytics: report.analytics,
      stats: report.analytics.stats,
      starBreakdown: report.analytics.starBreakdown,
      categories: report.analytics.services,
      trend: report.analytics.trend,
      filters: report.filters,
      filterOptions: report.filterOptions,
      pagination: report.pagination,
      reportStart: report.reportStart,
      reportEnd: report.reportEnd,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/ratings/service/export", async (req, res, next) => {
  try {
    const { loadServiceRatingReport } = require("../utils/serviceRatingReport");
    const report = await loadServiceRatingReport(req.query, { paginate: false });
    if (report.allRows.length > 50000) {
      return res.status(413).json({ error: "This export exceeds 50,000 reviews. Select a smaller reporting window." });
    }
    const safeCell = value => {
      let output = String(value ?? "").replace(/\r?\n/g, " ");
      if (/^[=+\-@]/.test(output)) output = `'${output}`;
      return `"${output.replace(/"/g, '""')}"`;
    };
    const header = ["Review Date", "Booking Reference", "Customer", "Email", "Service Class", "Service", "Technician", "Rating", "Attention", "Comment", "Record Source"];
    const rows = report.allRows.map(row => [
      new Date(row.date).toISOString(), row.reference, row.customer, row.email, row.serviceType, row.serviceName,
      row.technician, row.rating, row.attention.replaceAll("_", " "), row.comment, row.source,
    ]);
    const csv = [header, ...rows].map(row => row.map(safeCell).join(",")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="service-ratings-${report.reportStart}-${report.reportEnd}.csv"`);
    res.send(`\uFEFF${csv}`);
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
    let inventoryDocs = [];
    if (inventoryIds.length > 0) {
      inventoryDocs = await Inventory.find({ _id: { $in: inventoryIds } })
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
        productImageUrl: inv?.imageUrl || "/images/products/default.png",
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
    const brandEntries = Object.entries(brandGroups)
      .sort((a, b) => (b[1].total / b[1].count) - (a[1].total / a[1].count));
    const brandPerformance = {
      labels: brandEntries.map(([b]) => b),
      data: brandEntries.map(([, v]) => +(v.total / v.count).toFixed(1)),
      colors: brandEntries.map((_, i) => [
        'rgba(13, 110, 253, 0.8)',
        'rgba(25, 135, 84, 0.8)',
        'rgba(255, 193, 7, 0.8)',
        'rgba(220, 53, 69, 0.8)',
        'rgba(108, 117, 125, 0.8)',
      ][i % 5]),
    };

    const prodGroups = {};
    for (const r of reviews) {
      const key = r.productName;
      if (!prodGroups[key]) prodGroups[key] = { total: 0, count: 0, brand: r.brand };
      prodGroups[key].total += r.rating;
      prodGroups[key].count++;
    }

    // Star breakdown for aircon ratings
    const starBreakdown = [0, 0, 0, 0, 0]; // [5star, 4star, 3star, 2star, 1star]
    for (const r of reviews) {
      const idx = 5 - Math.round(r.rating);
      if (idx >= 0 && idx < 5) starBreakdown[idx]++;
    }

    // Enrich top products with price range and inventory details
    const enrichedTopProducts = [];
    for (const [name, v] of Object.entries(prodGroups)) {
      const matchingInventory = inventoryDocs.filter(inv => inv.modelLine === name);
      const prices = matchingInventory.map(inv => inv.sellingPrice).filter(p => p > 0);
      const images = matchingInventory.map(inv => inv.imageUrl).filter(Boolean);
      const ids = matchingInventory.map(inv => String(inv._id));
      enrichedTopProducts.push({
        name,
        model: name,
        brand: v.brand,
        avgRating: +(v.total / v.count).toFixed(1),
        reviewCount: v.count,
        id: ids[0] || '',
        imageUrl: images[0] || '/images/products/default.png',
        minPrice: prices.length > 0 ? Math.min(...prices) : 0,
        maxPrice: prices.length > 0 ? Math.max(...prices) : 0,
      });
    }
    enrichedTopProducts.sort((a, b) => b.reviewCount - a.reviewCount);
    const topProductsLimited = enrichedTopProducts.slice(0, 5);

    res.json({
      stats: { totalProducts, avgRating, totalReviews, verifiedReviews: totalReviews },
      reviews: reviews.slice(0, 50),
      brandPerformance,
      topProducts: topProductsLimited,
      starBreakdown,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Aircon Top Products (standalone endpoint for aircons tab) ─────────────
router.get("/ratings/top-products", async (req, res, next) => {
  try {
    const Rating = require("../models/Rating");
    const Inventory = require("../models/Inventory");

    const ratingDocs = await Rating.find({ targetType: "inventory" })
      .populate("customerId", "firstName lastName email")
      .sort({ createdAt: -1 })
      .lean();

    const inventoryIds = [...new Set(ratingDocs.map(r => String(r.targetId)))];
    let inventoryMap = {};
    let inventoryDocs = [];
    if (inventoryIds.length > 0) {
      inventoryDocs = await Inventory.find({ _id: { $in: inventoryIds } })
        .populate("brand", "name")
        .lean();
      for (const inv of inventoryDocs) {
        inventoryMap[String(inv._id)] = inv;
      }
    }

    const prodGroups = {};
    for (const r of ratingDocs) {
      const inv = inventoryMap[String(r.targetId)];
      const name = inv?.modelLine || "Unknown";
      const brandName = inv?.brand?.name || "Unknown";
      if (!prodGroups[name]) prodGroups[name] = { total: 0, count: 0, brand: brandName };
      prodGroups[name].total += r.score;
      prodGroups[name].count++;
    }

    const products = Object.entries(prodGroups).map(([name, v]) => {
      const matchingInventory = inventoryDocs.filter(inv => inv.modelLine === name);
      const prices = matchingInventory.map(inv => inv.sellingPrice).filter(p => p > 0);
      const images = matchingInventory.map(inv => inv.imageUrl).filter(Boolean);
      const ids = matchingInventory.map(inv => String(inv._id));
      return {
        name,
        model: name,
        brand: v.brand,
        avgRating: +(v.total / v.count).toFixed(1),
        reviewCount: v.count,
        id: ids[0] || '',
        imageUrl: images[0] || '/images/products/default.png',
        minPrice: prices.length > 0 ? Math.min(...prices) : 0,
        maxPrice: prices.length > 0 ? Math.max(...prices) : 0,
      };
    }).sort((a, b) => b.reviewCount - a.reviewCount);

    res.json({ products });
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
      "companyFoundedYear",
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
      foundedYear: Number(map.companyFoundedYear) || null,
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
    if (req.body.foundedYear !== undefined) {
      const foundedYear = Number(req.body.foundedYear);
      const currentYear = new Date().getFullYear();
      if (!Number.isInteger(foundedYear) || foundedYear < 1900 || foundedYear > currentYear) {
        return res.status(400).json({ error: `Founded year must be between 1900 and ${currentYear}.` });
      }
      await SiteSetting.findOneAndUpdate(
        { key: "companyFoundedYear" },
        { value: foundedYear },
        { upsert: true, setDefaultsOnInsert: true },
      );
      updates.companyFoundedYear = foundedYear;
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
    require("../utils/publicBusinessStats").invalidatePublicBusinessStats();
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
const SecretaryAttendance = require("../models/SecretaryAttendance");
const { attendanceDay, attendanceRange } = require("../utils/attendanceTime");

// helper to get or create today's QR token
async function getOrCreateDailyToken() {
  const todayStr = attendanceDay().key;
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
    { upsert: true, returnDocument: "after" }
  );
  return newToken;
}

/** GET /api/admin/attendance/qr-token */
router.get("/attendance/qr-token", async (req, res, next) => {
  try {
    const token = await getOrCreateDailyToken();
    const todayStr = attendanceDay().key;

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
    const todayStr = attendanceDay().key;
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
    const day = attendanceDay();
    const startOfToday = day.start;
    const endOfToday = day.end;

    // Get all active technicians (you can filter by role or status if needed)
    const technicians = await Technician.find({}).populate("user", "firstName lastName email").lean();

    // Get all attendance records for today
    const attendanceRecords = await TechnicianAttendance.find({
      date: { $gte: startOfToday, $lte: endOfToday }
    }).lean();

    const attendanceMap = new Map(attendanceRecords.map(r => [String(r.technicianId), r]));

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

    const technicianResult = await Promise.all(technicians.map(async (tech) => {
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
        staffId: tech._id,
        technicianId: tech._id,
        userId: tech.user ? tech.user._id : null,
        staffType: "technician",
        role: "technician",
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

    const secretaries = await User.find({ role: "secretary", active: { $ne: false } })
      .select("firstName lastName email")
      .lean();
    const secretaryRecords = await SecretaryAttendance.find({
      userId: { $in: secretaries.map(item => item._id) },
      date: { $gte: startOfToday, $lte: endOfToday },
    }).lean();
    const secretaryMap = new Map(secretaryRecords.map(record => [String(record.userId), record]));
    const secretaryResult = secretaries.map((secretary) => {
      const record = secretaryMap.get(String(secretary._id)) || null;
      return {
        staffId: secretary._id,
        technicianId: null,
        userId: secretary._id,
        staffType: "secretary",
        role: "secretary",
        name: `${secretary.firstName || ""} ${secretary.lastName || ""}`.trim(),
        email: secretary.email,
        attendanceStatus: record ? (record.checkOutTime ? "Checked Out" : record.status) : "Absent",
        availabilityStatus: null,
        checkInTime: record ? record.checkInTime : null,
        checkOutTime: record ? record.checkOutTime : null,
        method: record ? record.method : null,
        updatedBy: record ? record.updatedBy : null,
      };
    });

    return res.json([...technicianResult, ...secretaryResult].sort((a, b) => a.name.localeCompare(b.name)));
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/attendance/:staffId */
router.patch("/attendance/:staffId", async (req, res, next) => {
  try {
    const { staffId } = req.params;
    const { status, availabilityStatus, staffType } = req.body;

    if (!mongoose.Types.ObjectId.isValid(staffId)) {
      return res.status(400).json({ error: "Invalid staff ID" });
    }

    const validStatuses = ["Absent", "Present", "Late", "On Leave", "Sick Leave", "Checked Out"];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid attendance status" });
    }

    if (staffType === "secretary") {
      const secretary = await User.findOne({ _id: staffId, role: "secretary", active: { $ne: false } }).lean();
      if (!secretary) return res.status(404).json({ error: "Secretary not found" });
      if (availabilityStatus) {
        return res.status(400).json({ error: "Operational availability only applies to technicians." });
      }
      if (!status) return res.status(400).json({ error: "Attendance status is required." });

      const day = attendanceDay();
      const now = new Date();
      const current = await SecretaryAttendance.findOne({ userId: secretary._id, date: day.start }).lean();
      const storedStatus = status === "Checked Out"
        ? (["Present", "Late"].includes(current?.status) ? current.status : "Present")
        : status;
      const update = {
        $set: {
          status: storedStatus,
          method: "manual",
          qrVerified: false,
          updatedBy: req.user._id,
          ...(status === "Checked Out" ? { checkOutTime: now } : { checkOutTime: null }),
          ...(["Absent", "On Leave", "Sick Leave"].includes(status) ? { checkInTime: null } : {}),
        },
      };
      if (["Present", "Late", "Checked Out"].includes(status) && !current?.checkInTime) {
        update.$set.checkInTime = now;
      }
      const record = await SecretaryAttendance.findOneAndUpdate(
        { userId: secretary._id, date: day.start },
        update,
        { upsert: true, returnDocument: "after", runValidators: true },
      );

      await audit.logEvent({
        actor: req.user._id,
        target: secretary._id,
        action: "attendance.manual.update",
        module: "admin",
        req,
        entityId: record._id,
        entityType: "SecretaryAttendance",
        details: { status, staffType: "secretary" },
      }).catch(() => {});
      return res.json({ message: "Secretary attendance updated", attendance: record });
    }

    const tech = await Technician.findById(staffId);
    if (!tech) return res.status(404).json({ error: "Technician not found" });

    const updates = {};

    if (status) {
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
      const startOfToday = attendanceDay().start;

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

/** GET /api/admin/attendance/history */
router.get("/attendance/history", async (req, res, next) => {
  try {
    const requestedTo = req.query.to ? new Date(`${req.query.to}T12:00:00+08:00`) : new Date();
    const requestedFrom = req.query.from
      ? new Date(`${req.query.from}T12:00:00+08:00`)
      : new Date(requestedTo.getTime() - 29 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(requestedFrom.getTime()) || Number.isNaN(requestedTo.getTime())) {
      return res.status(400).json({ error: "Use valid from and to dates." });
    }
    if (requestedFrom > requestedTo) {
      return res.status(400).json({ error: "From date cannot be after to date." });
    }
    if (requestedTo - requestedFrom > 366 * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: "Attendance history is limited to 366 days per request." });
    }

    const { start, end } = attendanceRange(requestedFrom, requestedTo);
    const role = ["technician", "secretary"].includes(req.query.role) ? req.query.role : "all";
    const status = validAttendanceHistoryStatus(req.query.status);
    const search = String(req.query.search || "").trim().toLowerCase();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 25));

    const rows = [];
    if (role !== "secretary") {
      const techRecords = await TechnicianAttendance.find({ date: { $gte: start, $lte: end } })
        .populate({ path: "technicianId", select: "name email firstName lastName user", populate: { path: "user", select: "firstName lastName email" } })
        .lean();
      techRecords.forEach((record) => {
        const tech = record.technicianId;
        if (!tech) return;
        rows.push(attendanceHistoryRow(record, {
          staffId: tech._id,
          role: "technician",
          name: tech.name || `${tech.firstName || ""} ${tech.lastName || ""}`.trim() || `${tech.user?.firstName || ""} ${tech.user?.lastName || ""}`.trim(),
          email: tech.email || tech.user?.email || "",
        }));
      });
    }
    if (role !== "technician") {
      const secretaryRecords = await SecretaryAttendance.find({ date: { $gte: start, $lte: end } })
        .populate("userId", "firstName lastName email role")
        .lean();
      secretaryRecords.forEach((record) => {
        const employee = record.userId;
        if (!employee) return;
        rows.push(attendanceHistoryRow(record, {
          staffId: employee._id,
          role: "secretary",
          name: `${employee.firstName || ""} ${employee.lastName || ""}`.trim(),
          email: employee.email || "",
        }));
      });
    }

    const filtered = rows
      .filter(row => !status || (status === "Checked Out" ? row.shiftState === "Checked Out" : row.attendanceStatus === status))
      .filter(row => !search || `${row.name} ${row.email}`.toLowerCase().includes(search))
      .sort((a, b) => new Date(b.date) - new Date(a.date) || a.name.localeCompare(b.name));
    const summary = filtered.reduce((totals, row) => {
      totals.records += 1;
      totals.hoursWorked += row.hoursWorked;
      if (row.attendanceStatus === "Late") totals.late += 1;
      if (row.attendanceStatus === "Present") totals.present += 1;
      return totals;
    }, { records: 0, present: 0, late: 0, hoursWorked: 0 });
    summary.hoursWorked = Math.round(summary.hoursWorked * 100) / 100;
    const pages = Math.max(1, Math.ceil(filtered.length / limit));
    const safePage = Math.min(page, pages);
    const items = filtered.slice((safePage - 1) * limit, safePage * limit);

    return res.json({
      items,
      summary,
      pagination: { page: safePage, pages, limit, total: filtered.length },
      filters: { from: attendanceDay(requestedFrom).key, to: attendanceDay(requestedTo).key, role, status: status || "all", search },
    });
  } catch (error) {
    next(error);
  }
});

function validAttendanceHistoryStatus(value) {
  const normalized = String(value || "");
  return ["Present", "Late", "Absent", "On Leave", "Sick Leave", "Checked Out"].includes(normalized)
    ? normalized
    : "";
}

function attendanceHistoryRow(record, staff) {
  const checkIn = record.checkInTime ? new Date(record.checkInTime) : null;
  const checkOut = record.checkOutTime ? new Date(record.checkOutTime) : null;
  const hoursWorked = checkIn && checkOut && checkOut > checkIn
    ? Math.round(((checkOut - checkIn) / 3600000) * 100) / 100
    : 0;
  return {
    ...staff,
    date: record.date,
    attendanceStatus: record.status,
    shiftState: checkOut ? "Checked Out" : (checkIn ? "Checked In" : "No Shift"),
    recordedStatus: record.status,
    checkInTime: record.checkInTime || null,
    checkOutTime: record.checkOutTime || null,
    hoursWorked,
    method: record.method,
    qrVerified: Boolean(record.qrVerified),
    remarks: record.remarks || "",
  };
}

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

const WARRANTY_BOOKING_STATUSES = [
  "completed",
  "repair_completed",
  "under_warranty",
  "warranty_claim",
  "closed",
];
const {
  resolveWarrantyCoverage,
  bookingCompletionDate,
} = require("../utils/warrantyLifecycle");

function effectiveWarrantySnapshot(warranty, now = new Date(), fallbackStart = null) {
  return resolveWarrantyCoverage(warranty, fallbackStart, now);
}

function warrantyClaimHistory(claim, req, status, note) {
  claim.history.push({
    status,
    actorId: req.user._id,
    actorRole: "admin",
    actorName: req.user.name || req.user.email || "Administrator",
    note: String(note || "").trim().slice(0, 2000),
  });
}

function publicWarrantyClaim(claim) {
  const value = claim?.toObject ? claim.toObject() : claim;
  return { ...value, coverageSnapshot: value?.coverageSnapshot || {} };
}

router.get("/warranty-claims", async (req, res, next) => {
  try {
    const WarrantyClaim = require("../models/WarrantyClaim");
    const { escapeRegex } = require("../utils/stringSecurity");
    const filter = {};
    const allowedStatuses = new Set(require("../models/WarrantyClaim").CLAIM_STATUSES);
    if (req.query.status && req.query.status !== "all" && allowedStatuses.has(req.query.status)) filter.status = req.query.status;
    if (["booking", "order"].includes(req.query.sourceType)) filter.sourceType = req.query.sourceType;
    if (["normal", "high", "critical"].includes(req.query.priority)) filter.priority = req.query.priority;
    if (String(req.query.active || "") === "true") filter.active = true;
    const search = String(req.query.search || "").trim().slice(0, 100);
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      filter.$or = [
        { claimReference: regex }, { sourceReference: regex }, { "affectedItem.name": regex }, { description: regex },
      ];
    }
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const [claims, total] = await Promise.all([
      WarrantyClaim.find(filter)
        .populate("customerId", "name email phone")
        .populate("assignedTechnicianId", "name userEmail phone")
        .sort({ active: -1, priority: 1, submittedAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      WarrantyClaim.countDocuments(filter),
    ]);
    return res.json({ claims, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (error) {
    return next(error);
  }
});

router.get("/warranty-claims/:id", async (req, res, next) => {
  try {
    const WarrantyClaim = require("../models/WarrantyClaim");
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid warranty claim id." });
    const claim = await WarrantyClaim.findById(req.params.id)
      .populate("customerId", "name email phone address")
      .populate("assignedTechnicianId", "name userEmail phone")
      .lean();
    if (!claim) return res.status(404).json({ error: "Warranty claim not found." });
    return res.json({ claim });
  } catch (error) {
    return next(error);
  }
});

router.patch("/warranty-claims/:id/triage", async (req, res, next) => {
  try {
    const WarrantyClaim = require("../models/WarrantyClaim");
    const { cleanText } = require("../utils/warrantyClaimPolicy");
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid warranty claim id." });
    const claim = await WarrantyClaim.findById(req.params.id);
    if (!claim) return res.status(404).json({ error: "Warranty claim not found." });
    if (!["submitted", "triage"].includes(claim.status)) return res.status(409).json({ error: "This claim is no longer awaiting triage." });
    if (["normal", "high", "critical"].includes(req.body.priority)) claim.priority = req.body.priority;
    claim.status = "triage";
    claim.acknowledgedAt ||= new Date();
    warrantyClaimHistory(claim, req, "triage", cleanText(req.body.note, 2000) || "Claim acknowledged and under review");
    await claim.save();
    return res.json({ success: true, claim: publicWarrantyClaim(claim) });
  } catch (error) {
    return next(error);
  }
});

router.patch("/warranty-claims/:id/schedule-inspection", async (req, res, next) => {
  try {
    const WarrantyClaim = require("../models/WarrantyClaim");
    const Technician = require("../models/Technician");
    const { cleanText } = require("../utils/warrantyClaimPolicy");
    if (!mongoose.Types.ObjectId.isValid(req.params.id) || !mongoose.Types.ObjectId.isValid(req.body.technicianId)) {
      return res.status(400).json({ error: "Select a valid technician." });
    }
    const [claim, technician] = await Promise.all([
      WarrantyClaim.findById(req.params.id),
      Technician.findOne({ _id: req.body.technicianId, active: true }),
    ]);
    if (!claim) return res.status(404).json({ error: "Warranty claim not found." });
    if (!technician) return res.status(400).json({ error: "The selected technician is unavailable." });
    if (!["submitted", "triage", "inspection_scheduled"].includes(claim.status)) {
      return res.status(409).json({ error: "This claim cannot be scheduled from its current status." });
    }
    const scheduledDate = new Date(req.body.scheduledDate);
    if (Number.isNaN(scheduledDate.getTime())) return res.status(400).json({ error: "Enter a valid inspection date." });
    const startToday = new Date();
    startToday.setHours(0, 0, 0, 0);
    if (scheduledDate < startToday) return res.status(400).json({ error: "Inspection date cannot be in the past." });
    claim.assignedTechnicianId = technician._id;
    claim.inspection.scheduledDate = scheduledDate;
    claim.inspection.timeSlot = cleanText(req.body.timeSlot, 100);
    claim.status = "inspection_scheduled";
    claim.acknowledgedAt ||= new Date();
    warrantyClaimHistory(claim, req, "inspection_scheduled", cleanText(req.body.note, 2000) || `Inspection assigned to ${technician.name}`);
    await claim.save();
    const { createNotification } = require("../utils/notify");
    await Promise.all([
      createNotification({ type: "warranty_inspection_scheduled", title: "Warranty inspection scheduled", message: `${claim.claimReference} is scheduled for inspection.`, userId: claim.customerId, referenceId: claim._id, referenceModel: "WarrantyClaim", link: "/book-history", priority: "high", io: req.app.get("io") }),
      createNotification({ type: "warranty_inspection_assigned", title: "New warranty inspection", message: `${claim.claimReference} requires your inspection.`, userId: technician._id, role: "technician", referenceId: claim._id, referenceModel: "WarrantyClaim", link: "/technician/warranty-claims", priority: claim.priority === "critical" ? "urgent" : "high", io: req.app.get("io") }),
    ]);
    return res.json({ success: true, claim: publicWarrantyClaim(claim) });
  } catch (error) {
    return next(error);
  }
});

router.patch("/warranty-claims/:id/decision", async (req, res, next) => {
  try {
    const WarrantyClaim = require("../models/WarrantyClaim");
    const { canTransitionClaim, cleanText } = require("../utils/warrantyClaimPolicy");
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid warranty claim id." });
    const claim = await WarrantyClaim.findById(req.params.id);
    if (!claim) return res.status(404).json({ error: "Warranty claim not found." });
    const outcome = cleanText(req.body.outcome, 30);
    if (!["approved", "partially_approved", "denied"].includes(outcome) || !canTransitionClaim(claim.status, outcome, "admin")) {
      return res.status(409).json({ error: "That decision is not allowed from the claim's current status." });
    }
    const reason = cleanText(req.body.reason, 3000);
    if (reason.length < 10) return res.status(400).json({ error: "Record a clear decision reason of at least 10 characters." });
    const remedyType = ["repair", "replacement", "refund", "manufacturer_referral", "reinspection", "none"].includes(req.body.remedyType)
      ? req.body.remedyType : (outcome === "denied" ? "none" : "repair");
    claim.status = outcome;
    claim.decision = { outcome, reason, decidedAt: new Date(), decidedBy: req.user._id };
    claim.remedy.type = remedyType;
    claim.remedy.amount = Math.max(0, Number(req.body.amount) || 0);
    if (outcome === "denied") claim.remedy.status = "cancelled";
    warrantyClaimHistory(claim, req, outcome, reason);
    await claim.save();
    const { createNotification } = require("../utils/notify");
    await createNotification({ type: "warranty_claim_decided", title: `Warranty claim ${outcome.replace(/_/g, " ")}`, message: `${claim.claimReference}: ${reason}`, userId: claim.customerId, referenceId: claim._id, referenceModel: "WarrantyClaim", link: claim.sourceType === "order" ? `/my-orders/${claim.sourceId}` : "/book-history", priority: "high", io: req.app.get("io") });
    const customer = await require("../models/User").findById(claim.customerId).select("email name").lean();
    if (customer?.email) {
      require("../utils/mailer").sendEmail(
        customer.email,
        `Warranty claim decision - ${claim.claimReference}`,
        `Your warranty claim was ${outcome.replace(/_/g, " ")}\n\nDecision reason: ${reason}\n\nApproved remedy: ${remedyType.replace(/_/g, " ")}`,
      ).catch(() => {});
    }
    return res.json({ success: true, claim: publicWarrantyClaim(claim) });
  } catch (error) {
    return next(error);
  }
});

router.patch("/warranty-claims/:id/remedy", async (req, res, next) => {
  try {
    const WarrantyClaim = require("../models/WarrantyClaim");
    const { cleanText } = require("../utils/warrantyClaimPolicy");
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid warranty claim id." });
    const claim = await WarrantyClaim.findById(req.params.id);
    if (!claim) return res.status(404).json({ error: "Warranty claim not found." });
    if (!["approved", "partially_approved", "remedy_in_progress"].includes(claim.status)) return res.status(409).json({ error: "No approved remedy is available for this claim." });
    const complete = String(req.body.complete) === "true" || req.body.complete === true;
    claim.status = complete ? "resolved" : "remedy_in_progress";
    claim.remedy.status = complete ? "completed" : "in_progress";
    claim.remedy.notes = cleanText(req.body.notes, 3000);
    claim.remedy.oldSerialNumber = cleanText(req.body.oldSerialNumber, 120);
    claim.remedy.newSerialNumber = cleanText(req.body.newSerialNumber, 120);
    if (complete) claim.remedy.completedAt = new Date();
    warrantyClaimHistory(claim, req, claim.status, claim.remedy.notes || (complete ? "Remedy completed" : "Remedy started"));
    await claim.save();
    return res.json({ success: true, claim: publicWarrantyClaim(claim) });
  } catch (error) {
    return next(error);
  }
});

router.patch("/warranty-claims/:id/close", async (req, res, next) => {
  try {
    const WarrantyClaim = require("../models/WarrantyClaim");
    const { cleanText } = require("../utils/warrantyClaimPolicy");
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid warranty claim id." });
    const claim = await WarrantyClaim.findById(req.params.id);
    if (!claim) return res.status(404).json({ error: "Warranty claim not found." });
    if (!["resolved", "denied"].includes(claim.status)) return res.status(409).json({ error: "Only resolved or denied claims can be closed." });
    const overrideReason = cleanText(req.body.overrideReason, 1000);
    if (claim.status === "resolved" && !claim.customerConfirmedAt && overrideReason.length < 20) {
      return res.status(409).json({ error: "Customer confirmation is required, or record an override reason of at least 20 characters." });
    }
    claim.status = "closed";
    claim.active = false;
    claim.closedAt = new Date();
    warrantyClaimHistory(claim, req, "closed", overrideReason || "Administrative closure after decision");
    await claim.save();
    await require("../utils/warrantyClaimService").reconcileWarrantySource(claim);
    return res.json({ success: true, claim: publicWarrantyClaim(claim) });
  } catch (error) {
    return next(error);
  }
});

function technicianSnapshot(record) {
  const populated = record.technicianId && typeof record.technicianId === "object"
    ? record.technicianId
    : null;
  const snapshot = record.technician || {};
  return {
    name: snapshot.name || populated?.name || [populated?.firstName, populated?.lastName].filter(Boolean).join(" ") || null,
    email: snapshot.email || populated?.email || null,
    phone: snapshot.phone || populated?.phone || null,
  };
}

/**
 * GET /api/admin/warranties
 * Returns bookings and orders with warranty data.
 */
router.get("/warranties", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Order = require("../models/Order");
    const { escapeRegex } = require("../utils/stringSecurity");
    const { status, search, page = 1, limit = 20, type } = req.query;

    const bookingFilter = {
      "warranty.status": { $exists: true, $ne: null },
      status: { $in: WARRANTY_BOOKING_STATUSES },
    };
    const orderFilter = {
      "warranty.status": { $exists: true, $ne: null },
      status: "completed",
    };

    if (search) {
      const re = new RegExp(escapeRegex(search, 80), "i");
      bookingFilter.$or = [
        { bookingReference: re },
        { workOrderNumber: re },
        { "customer.name": re },
      ];
      orderFilter.$or = [
        { orderReference: re },
        { "customer.name": re },
      ];
    }

    let bookingItems = [];
    let orderItems = [];

    if (!type || type === "all" || type === "booking") {
      bookingItems = await BookingService.find(bookingFilter).sort({ "warranty.endDate": 1 }).lean();
    }
    if (!type || type === "all" || type === "order") {
      orderItems = await Order.find(orderFilter).sort({ "warranty.endDate": 1 }).lean();
    }

    const now = new Date();
    const completedAssignments = bookingItems.length
      ? await Assignment.find({ bookingId: { $in: bookingItems.map(booking => booking._id) }, completedAt: { $ne: null } })
        .select("bookingId completedAt")
        .sort({ completedAt: -1 })
        .lean()
      : [];
    const assignmentByBooking = new Map();
    completedAssignments.forEach(assignment => {
      const bookingId = String(assignment.bookingId);
      if (!assignmentByBooking.has(bookingId)) assignmentByBooking.set(bookingId, assignment);
    });
    const normalizedBookings = bookingItems.map(b => ({
      _id: b._id,
      reference: b.bookingReference || b.workOrderNumber,
      customer: b.customer,
      service: b.service?.name || b.services?.map(service => service.name).filter(Boolean).join(", ") || b.serviceType,
      type: "booking",
      warranty: effectiveWarrantySnapshot(
        b.warranty,
        now,
        bookingCompletionDate(b, assignmentByBooking.get(String(b._id))),
      ),
    }));
    const normalizedOrders = orderItems.map(o => ({
      _id: o._id,
      reference: o.orderReference,
      customer: o.customer,
      service: (o.items || []).map(i => `${i.brand || ''} ${i.modelLine || ''}`).join(', ') || 'Product Order',
      type: "order",
      warranty: effectiveWarrantySnapshot(
        o.warranty,
        now,
        o.completedAt || [...(o.statusHistory || [])].reverse().find(entry => entry.status === "completed")?.timestamp,
      ),
    }));

    const allItems = [...normalizedBookings, ...normalizedOrders]
      .filter(item => !status || status === "all" || item.warranty?.status === status)
      .sort((a, b) => {
        const dateA = a.warranty?.endDate ? new Date(a.warranty.endDate) : 0;
        const dateB = b.warranty?.endDate ? new Date(b.warranty.endDate) : 0;
        return dateA - dateB;
      });

    const total = allItems.length;
    const requestedPage = Math.max(1, Number.parseInt(page, 10) || 1);
    const lim = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 20));
    const skip = (requestedPage - 1) * lim;
    const paginatedItems = allItems.slice(skip, skip + lim);

    return res.json({ items: paginatedItems, total, page: requestedPage, pages: Math.ceil(total / lim) || 1 });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/warranties/stats
 * Returns warranty statistics from both bookings and orders.
 */
router.get("/warranties/stats", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Order = require("../models/Order");
    const WarrantyClaim = require("../models/WarrantyClaim");

    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const bsQuery = { "warranty.status": { $exists: true, $ne: null }, status: { $in: WARRANTY_BOOKING_STATUSES } };
    const orderQuery = { "warranty.status": { $exists: true, $ne: null }, status: "completed" };

    const [bookings, orders, warrantyClaimCount] = await Promise.all([
      BookingService.find(bsQuery)
        .select("warranty completedAt repairCompletion.completedAt statusHistory services.statusHistory")
        .lean(),
      Order.find(orderQuery).select("warranty completedAt statusHistory").lean(),
      WarrantyClaim.countDocuments({ status: { $ne: "withdrawn" } }),
    ]);
    const Assignment = require("../models/Assignment");
    const assignments = bookings.length
      ? await Assignment.find({ bookingId: { $in: bookings.map(booking => booking._id) }, completedAt: { $ne: null } })
        .select("bookingId completedAt")
        .sort({ completedAt: -1 })
        .lean()
      : [];
    const assignmentByBooking = new Map();
    assignments.forEach(assignment => {
      const bookingId = String(assignment.bookingId);
      if (!assignmentByBooking.has(bookingId)) assignmentByBooking.set(bookingId, assignment);
    });

    const coverages = [
      ...bookings.map(booking => effectiveWarrantySnapshot(
        booking.warranty,
        now,
        bookingCompletionDate(booking, assignmentByBooking.get(String(booking._id))),
      )),
      ...orders.map(order => effectiveWarrantySnapshot(
        order.warranty,
        now,
        order.completedAt || [...(order.statusHistory || [])].reverse().find(entry => entry.status === "completed")?.timestamp,
      )),
    ].filter(Boolean);

    const countStatus = status => coverages.filter(coverage => coverage.status === status).length;
    const expiringSoon = coverages.filter(coverage => (
      coverage.status === "active"
      && coverage.endDate
      && new Date(coverage.endDate) >= now
      && new Date(coverage.endDate) <= thirtyDaysFromNow
    )).length;

    return res.json({
      activeWarranty: countStatus("active"),
      warrantyClaims: warrantyClaimCount,
      expiredWarranties: countStatus("expired"),
      incompleteWarranties: countStatus("incomplete"),
      expiringSoon,
      totalWarranties: coverages.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/warranties/:type/:id
 * Returns a curated, current warranty record for the in-page detail modal.
 */
router.get("/warranties/:type/:id", async (req, res, next) => {
  try {
    const { type, id } = req.params;
    if (!["booking", "order"].includes(type)) return res.status(400).json({ error: "Invalid warranty record type" });
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid warranty record id" });

    const Model = type === "booking"
      ? require("../models/BookingService")
      : require("../models/Order");
    const record = await Model.findById(id)
      .populate({ path: "technicianId", select: "name firstName lastName email phone" })
      .lean();

    if (!record || !record.warranty?.status) return res.status(404).json({ error: "Warranty record not found" });

    const Assignment = require("../models/Assignment");
    const Payment = require("../models/Payment");
    const [assignment, payments] = await Promise.all([
      type === "booking"
        ? Assignment.findOne({ bookingId: record._id, completedAt: { $ne: null } }).sort({ completedAt: -1 }).lean()
        : null,
      Payment.find(type === "booking" ? { bookingId: record._id } : { orderId: record._id })
        .select("amount method type status reference notes submittedAt collectedAt collectedByName remittedAt remittanceNotes remittanceProofUrl verifiedAt completedAt rejectedAt rejectionReason refundedAt refundAmount events")
        .sort({ submittedAt: 1 })
        .lean(),
    ]);
    const fallbackCompletion = type === "booking"
      ? bookingCompletionDate(record, assignment)
      : record.completedAt || [...(record.statusHistory || [])].reverse().find(entry => entry.status === "completed")?.timestamp;
    const warranty = effectiveWarrantySnapshot(record.warranty, new Date(), fallbackCompletion);
    const collectedStatuses = new Set(["payment_collected", "waiting_for_remittance", "remitted", "verified", "paid", "partial"]);
    const paymentLedger = payments.map(payment => ({
      id: String(payment._id),
      amount: payment.amount,
      method: payment.method,
      type: payment.type,
      status: payment.status,
      reference: payment.reference,
      submittedAt: payment.submittedAt,
      collectedAt: payment.collectedAt,
      collectedByName: payment.collectedByName,
      remittedAt: payment.remittedAt,
      remittanceNotes: payment.remittanceNotes,
      remittanceProofSubmitted: Boolean(payment.remittanceProofUrl),
      verifiedAt: payment.verifiedAt,
      completedAt: payment.completedAt,
      rejectedAt: payment.rejectedAt,
      rejectionReason: payment.rejectionReason,
      refundedAt: payment.refundedAt,
      refundAmount: payment.refundAmount,
      notes: payment.notes,
      events: payment.events,
    }));
    const totalCollected = paymentLedger.reduce((sum, payment) => (
      collectedStatuses.has(payment.status) ? sum + Math.max(0, Number(payment.amount) || 0) : sum
    ), 0);
    const common = {
      id: String(record._id),
      type,
      reference: type === "booking"
        ? (record.bookingReference || record.workOrderNumber || String(record._id))
        : (record.orderReference || String(record._id)),
      workflowStatus: record.status,
      warranty,
      customer: {
        name: record.customer?.name || null,
        email: record.customer?.email || null,
        phone: record.customer?.phone || record.delivery?.contactNumber || null,
        address: record.customer?.address || record.location?.address || record.delivery?.address || null,
      },
      technician: technicianSnapshot(record),
      payments: paymentLedger,
      totalCollected,
      statusHistory: (record.statusHistory || []).map(entry => ({
        status: entry.status || entry.toStatus || entry.fromStatus,
        at: entry.changedAt || entry.timestamp,
        by: entry.changedByName || null,
        note: entry.reason || entry.note || entry.notes || null,
      })),
    };

    if (type === "booking") {
      const equipmentService = (record.services || []).find(service => (
        service.brand || service.model || service.applianceTypeName || service.airconTypeName || service.hpDescription || service.hp
      ));
      const equipment = {
        unitType: record.unitInfo?.unitType || equipmentService?.applianceTypeName || equipmentService?.airconTypeName || equipmentService?.unitCategory,
        brand: record.unitInfo?.brand || equipmentService?.brand || record.brand,
        model: record.unitInfo?.model || equipmentService?.model,
        hpDescription: record.unitInfo?.hpDescription || equipmentService?.hpDescription || (equipmentService?.hp ? `${equipmentService.hp} HP` : record.hpDescription),
        problemDescription: record.unitInfo?.problemDescription,
      };
      const bookingTotal = Number(record.totalPrice ?? record.estimatedFee ?? record.servicePrice) || 0;
      const { reconcileBookingPayments } = require("../utils/paymentSummary");
      const reconciliation = reconcileBookingPayments(record, payments);
      return res.json({
        ...common,
        serviceType: record.serviceType,
        services: (record.services?.length ? record.services : [{
          name: record.service?.name || record.serviceType || "Service",
          quantity: record.quantity || 1,
          unitPrice: record.servicePrice,
          totalPrice: record.totalPrice,
          brand: record.brand || record.unitInfo?.brand,
          model: record.unitInfo?.model,
          applianceTypeName: record.applianceTypeName || record.unitInfo?.unitType,
          hpDescription: record.hpDescription || record.unitInfo?.hpDescription,
        }]).map(service => ({
          name: service.name,
          quantity: service.quantity || 1,
          unitPrice: service.unitPrice,
          totalPrice: service.totalPrice,
          brand: service.brand,
          model: service.model,
          unitType: service.applianceTypeName || service.airconTypeName || service.unitCategory,
          capacity: service.hpDescription || (service.hp ? `${service.hp} HP` : null),
          status: ["completed", "repair_completed", "under_warranty", "warranty_claim", "closed"].includes(record.status)
            ? "completed"
            : service.status,
        })),
        equipment,
        issueDescription: record.issueDescription || record.repairIssues || record.unitInfo?.problemDescription || null,
        completion: {
          ...(record.repairCompletion || {}),
          proofSubmitted: Boolean(record.proofPhoto),
          nextMaintenanceDays: record.maintenance?.nextRecommendedDays,
          nextMaintenanceNotes: record.maintenance?.nextRecommendationNotes,
        },
        payment: {
          method: record.paymentMethod,
          status: record.paymentStatus,
          total: bookingTotal,
          amountPaid: reconciliation.ledgerCollected,
          snapshotAmountPaid: Number(record.amountPaid) || 0,
          balance: reconciliation.hasLedgerMismatch
            ? reconciliation.outstandingFromLedger
            : record.balanceAmount,
          reconciliation,
        },
        dates: {
          created: record.createdAt,
          updated: record.updatedAt,
          requestedService: record.preferredDate,
          scheduledService: record.bookingDate,
          inspectionScheduled: record.inspection?.scheduledDate,
          inspectionCompleted: record.inspection?.completedAt,
          diagnosisCompleted: record.diagnosis?.completedAt,
          quotationCreated: record.quotation?.createdAt,
          quotationExpires: record.quotation?.expiresAt,
          customerDecision: record.approval?.decidedAt,
          assigned: record.assignedAt,
          paymentVerified: record.paymentVerifiedAt,
          paymentCollected: record.balanceCollectedAt,
          serviceCompleted: fallbackCompletion,
          warrantyStarted: warranty.startDate,
          warrantyEnds: warranty.endDate,
          warrantyClaimed: warranty.claimedAt,
          followUpScheduled: record.followUp?.scheduledDate,
          followUpCompleted: record.followUp?.completedAt,
        },
      });
    }

    return res.json({
      ...common,
      fulfillmentType: record.fulfillmentType,
      items: (record.items || []).map(item => ({
        brand: item.brand,
        model: item.modelLine,
        capacity: item.capacity ? `${item.capacity} ${item.capacityUnit || "HP"}` : null,
        quantity: item.quantity || 1,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
      })),
      delivery: record.delivery || null,
      pickupLocation: record.pickupLocation,
      payment: {
        method: record.paymentMethod,
        status: record.paymentStatus,
        subtotal: record.subtotal,
        deliveryFee: record.deliveryFee,
        installationFee: record.installationFee,
        transportationFee: record.transportationFee,
        total: record.total,
        amountPaid: totalCollected,
        downpayment: record.downpaymentAmount,
        balance: record.balanceAmount,
      },
      dates: {
        created: record.createdAt,
        updated: record.updatedAt,
        requestedDelivery: record.delivery?.preferredDate,
        requestedPickup: record.pickupDate,
        technicianResponded: record.technicianAcceptance?.respondedAt,
        orderCompleted: record.completedAt,
        warrantyStarted: warranty.startDate,
        warrantyEnds: warranty.endDate,
        warrantyClaimed: warranty.claimedAt,
      },
    });
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

    // Reject confirmation of past repair bookings — require reschedule
    if (require("../utils/bookingPolicy").isBookingPast(booking)) {
      return res.status(400).json({
        error: "Cannot confirm a repair request whose scheduled time has passed. Please reschedule to a future date/time first.",
      });
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

    // Reject assignment to a past inspection date
    if (require("../utils/bookingPolicy").isBookingPast({ bookingDate: inspectionDate, startTime: scheduledTime })) {
      return res.status(400).json({
        error: "Cannot schedule an inspection in the past. Please select a future date/time.",
      });
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
      // Quotation parts never get their toolId written back once procurement
      // resolves the match — only the parts request items do. Merge that
      // resolution in so already-received parts don't look unmatched here.
      if (baseParts === quotationParts && requestedParts.length) {
        const resolvedToolIdByName = new Map(
          requestedParts
            .filter(item => item.toolId && item.name)
            .map(item => [String(item.name).trim().toLowerCase(), item.toolId])
        );
        for (const p of baseParts) {
          if (!p.toolId && p.name) {
            const resolved = resolvedToolIdByName.get(String(p.name).trim().toLowerCase());
            if (resolved) p.toolId = resolved;
          }
        }
      }
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
          const partName = String(p.name || '').trim().toLowerCase();
          if (partName) {
            const escaped = partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escaped.replace(/\\s+/g, '.*'), 'i');
            const candidates = await Tool.find({ itemName: regex, active: true, $and: [Tool.merchandiseFilter()] })
              .select("quantity itemName").lean();
            
            // Score candidates: prefer exact match, then shorter names (more specific)
            const scored = candidates.map(t => {
              const toolName = String(t.itemName || '').trim().toLowerCase();
              let score = 0;
              if (toolName === partName) score = 1000; // Exact match
              else if (toolName.startsWith(partName)) score = 500; // Starts with
              else if (partName.startsWith(toolName)) score = 400; // Part name starts with tool name
              else score = 100 - toolName.length; // Fuzzy match, prefer shorter names
              return { ...t, score };
            });
            
            // Sort by: score (desc), then quantity (desc)
            scored.sort((a, b) => b.score - a.score || (b.quantity || 0) - (a.quantity || 0));
            const best = scored[0];
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

      // Auto-correct stale waiting_parts status: if all parts are in stock,
      // transition to repair_approved so the booking can be scheduled
      let effectiveStatus = b.status;
      if (b.status === 'waiting_parts' && hasParts) {
        const allPartsInStock = enrichedParts.every(p => (p.currentStock || 0) >= (p.quantity || 1));
        const noActiveProcurement = !partsReq || partsReq.items.every(i => i.status === 'received');
        if (allPartsInStock && noActiveProcurement) {
          effectiveStatus = 'repair_approved';
          partsStatus = 'reserved';
          partsRequestStatus = null;
          // Update the booking in the database
          await BookingService.updateOne(
            { _id: b._id },
            {
              $set: { status: 'repair_approved' },
              $push: {
                statusHistory: {
                  fromStatus: 'waiting_parts',
                  toStatus: 'repair_approved',
                  reason: 'Auto-corrected: all parts confirmed in stock',
                  changedAt: new Date(),
                },
              },
            }
          );
        }
      }

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
        status: effectiveStatus,
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
        stockAvailable: partsStatus === 'reserved' || partsStatus === 'none' || effectiveStatus === 'repair_approved',
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
    // Prefer whichever parts request (still active, or already received) has
    // items — either one already carries the toolId resolved during
    // procurement/receiving.
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
    // Quotation parts never get their toolId written back to
    // booking.quotation.parts once procurement resolves the match — only the
    // parts request items do. Without this, already-received parts get
    // re-matched from scratch by name and can fail or resolve to the wrong
    // Tool document, wrongly reporting "insufficient stock".
    const resolvedToolIdByName = new Map(
      requestItems
        .filter(item => item.toolId && item.itemName)
        .map(item => [String(item.itemName).trim().toLowerCase(), item.toolId])
    );
    for (const p of parts) {
      if (!p.toolId && p.name) {
        const resolved = resolvedToolIdByName.get(String(p.name).trim().toLowerCase());
        if (resolved) p.toolId = resolved;
      }
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
    let insufficientStock = [];
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
        const partName = String(p.name || '').trim().toLowerCase();
        if (partName) {
          const escaped = partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escaped.replace(/\s+/g, '.*'), 'i');
          const candidates = await Tool.find({ itemName: regex, active: true, $and: [Tool.merchandiseFilter()] }).select("quantity itemName").lean();
          
          // Score candidates: prefer exact match, then shorter names (more specific)
          const scored = candidates.map(t => {
            const toolName = String(t.itemName || '').trim().toLowerCase();
            let score = 0;
            if (toolName === partName) score = 1000; // Exact match
            else if (toolName.startsWith(partName)) score = 500; // Starts with
            else if (partName.startsWith(toolName)) score = 400; // Part name starts with tool name
            else score = 100 - toolName.length; // Fuzzy match, prefer shorter names
            return { ...t, score };
          });
          
          // Sort by: score (desc), then quantity (desc)
          scored.sort((a, b) => b.score - a.score || (b.quantity || 0) - (a.quantity || 0));
          tool = scored.find(t => (t.quantity || 0) + (existingByTool.get(String(t._id)) || 0) >= qty) || scored[0] || null;
        }
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
        const partName = String(part.name || '').trim().toLowerCase();
        if (partName) {
          const escaped = partName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const regex = new RegExp(escaped.replace(/\s+/g, ".*"), "i");
          const candidates = await Tool.find({ itemName: regex, active: true, type: { $in: ['part', 'consumable'] }, $and: [Tool.merchandiseFilter()] }).select("quantity itemName").lean();
          
          // Score candidates: prefer exact match, then shorter names (more specific)
          const scored = candidates.map(t => {
            const toolName = String(t.itemName || '').trim().toLowerCase();
            let score = 0;
            if (toolName === partName) score = 1000; // Exact match
            else if (toolName.startsWith(partName)) score = 500; // Starts with
            else if (partName.startsWith(toolName)) score = 400; // Part name starts with tool name
            else score = 100 - toolName.length; // Fuzzy match, prefer shorter names
            return { ...t, score };
          });
          
          // Sort by: score (desc), then quantity (desc)
          scored.sort((a, b) => b.score - a.score || (b.quantity || 0) - (a.quantity || 0));
          tool = scored[0] || linkedTool || null;
        } else {
          tool = linkedTool || null;
        }
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
    const NonWorkingDay = require("../models/NonWorkingDay");
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

    // Get company non-working days (holidays)
    const nonWorkingDays = await NonWorkingDay.find({ service: null }).lean();

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

      // Check company non-working days (holidays)
      const isNonWorkingDay = nonWorkingDays.some(nwd => {
        const nwdDate = new Date(nwd.date);
        nwdDate.setHours(0, 0, 0, 0);
        return nwdDate.getTime() === d.getTime();
      });
      if (isNonWorkingDay) {
        results.push({ date: dayStr, available: false, reason: "Holiday" });
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

        // Count available slots using 30-minute intervals (matching service page)
        const bookedRanges = getBookedRangesForDate(d);
        const SLOT_INTERVAL = 30;
        let totalSlots = 0;
        let bookedSlots = 0;
        for (let s = workStartMin; s + capacityPerSlot <= workEndMin; s += SLOT_INTERVAL) {
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
        const SLOT_INTERVAL = 30;
        let totalSlots = 0;
        let bookedSlots = 0;
        for (let s = 480; s + capacityPerSlot <= 1020; s += SLOT_INTERVAL) {
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
    const NonWorkingDay = require("../models/NonWorkingDay");
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

    // Check company non-working days (holidays)
    const nonWorkingDay = await NonWorkingDay.findOne({
      service: null,
      date: { $gte: dayStart, $lte: dayEnd },
    }).lean();
    if (nonWorkingDay) return res.json({ slots: [], reason: "Holiday", duration, capacityPerSlot });

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
    const now = new Date();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isToday = target.getTime() === today.getTime();

    const slots = [];
    for (let min = workStartMin; min + capacityPerSlot <= workEndMin; min += slotInterval) {
      const slotEnd = min + capacityPerSlot;
      const isBooked = bookedRanges.some(b => min < b.end && slotEnd > b.start);

      // For today: skip past time slots (matching service page logic)
      if (isToday) {
        const slotStartTime = new Date(target);
        slotStartTime.setHours(Math.floor(min / 60), min % 60, 0, 0);
        const cutoffTime = new Date(now.getTime() + 30 * 60000);
        if (slotStartTime <= cutoffTime) continue;
      }

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

    const allowedStatuses = ["repair_approved", "ready_for_repair", "repair_scheduled", "waiting_parts"];
    if (!allowedStatuses.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot assign from status "${booking.status}"` });
    }

    // Scheduling is the final gate: quotation parts must be available in stock
    // (either reserved for this booking, or currently in inventory). Check
    // actual current stock as the source of truth — do not rely solely on
    // possibly-stale PartsRequest item statuses.
    const quotationParts = (booking.quotation?.parts || []).filter(part => part?.name);
    if (quotationParts.length > 0) {
      const Tool = require("../models/Tool");
      const reservations = await StockReservation.find({
        bookingId: booking._id,
        status: { $in: ["reserved", "checked_out"] },
      }).select("toolId quantity").lean();

      const reservedByTool = reservations.reduce((totals, reservation) => {
        const key = String(reservation.toolId || "");
        if (key) totals.set(key, (totals.get(key) || 0) + (Number(reservation.quantity) || 0));
        return totals;
      }, new Map());

      const unavailableParts = [];
      for (const part of quotationParts) {
        const qty = Number(part.quantity) || 1;

        // 1. Check reservation for this specific booking+tool
        if (part.toolId && (reservedByTool.get(String(part.toolId)) || 0) >= qty) {
          continue;
        }

        // 2. Check the linked tool's current stock directly
        let inStock = false;
        if (part.toolId) {
          const tool = await Tool.findOne({ _id: part.toolId, $and: [Tool.merchandiseFilter()] }).select("quantity active").lean();
          const bookingReserved = reservedByTool.get(String(part.toolId)) || 0;
          if (tool && tool.active !== false && (tool.quantity || 0) + bookingReserved >= qty) {
            inStock = true;
          }
        }

        // 3. Fall back to name-matching against active inventory
        if (!inStock) {
          const partName = String(part.name || '').trim().toLowerCase();
          if (partName) {
            const escaped = partName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escaped.replace(/\\s+/g, '.*'), 'i');
            const candidates = await Tool.find({ itemName: regex, active: true, $and: [Tool.merchandiseFilter()] })
              .select("quantity itemName").lean();
            
            // Score candidates: prefer exact match, then shorter names (more specific)
            const scored = candidates.map(t => {
              const toolName = String(t.itemName || '').trim().toLowerCase();
              let score = 0;
              if (toolName === partName) score = 1000; // Exact match
              else if (toolName.startsWith(partName)) score = 500; // Starts with
              else if (partName.startsWith(toolName)) score = 400; // Part name starts with tool name
              else score = 100 - toolName.length; // Fuzzy match, prefer shorter names
              return { ...t, score };
            });
            
            // Sort by: score (desc), then quantity (desc)
            scored.sort((a, b) => b.score - a.score || (b.quantity || 0) - (a.quantity || 0));
            const best = scored[0];
            if (best && (best.quantity || 0) >= qty) {
              inStock = true;
            }
          }
        }

        if (!inStock) {
          unavailableParts.push(part.name);
        }
      }

      if (unavailableParts.length > 0) {
        return res.status(409).json({
          error: `Cannot schedule yet. Procure and reserve the required part(s): ${[...new Set(unavailableParts)].join(", ")}.`,
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

    // Check if reassigning to a different technician.
    // If yes: create fresh pending_acceptance assignment (requires acceptance).
    // If no: reuse/update existing assignment (no re-acceptance if already accepted).
    const previousTechnicianId = booking.technicianId ? String(booking.technicianId) : null;
    const currentTechnicianId = String(tech._id);
    const isReassignment = previousTechnicianId && previousTechnicianId !== currentTechnicianId;
    
    let assignment;
    if (isReassignment) {
      // Reassigning to a DIFFERENT technician — require fresh acceptance
      // Mark any old pending assignments for this technician as expired
      await Assignment.updateMany(
        {
          bookingId: booking._id,
          technicianId: currentTechnicianId,
          status: "pending_acceptance",
        },
        { status: "expired" }
      );
      
      // Create new pending_acceptance assignment for the new technician
      const assignmentData = {
        bookingId: booking._id,
        technicianId: currentTechnicianId,
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
          text: `Assigned to new technician. ${notes.trim()}`,
          by: req.user._id,
          byName: req.user.firstName || req.user.name || "Admin",
          createdAt: new Date(),
        }];
      } else {
        assignmentData.notes = [{
          text: `Assigned to new technician for repair visit.`,
          by: req.user._id,
          byName: req.user.firstName || req.user.name || "Admin",
          createdAt: new Date(),
        }];
      }
      assignment = await Assignment.create(assignmentData);
    } else {
      // SAME technician or first assignment — check for existing assignment
      // Look for active assignments first
      assignment = await Assignment.findOne({
        bookingId: booking._id,
        technicianId: currentTechnicianId,
        status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
      });

      // If no active assignment found but same technician, check if there's a completed one
      // (from a previous phase) that we can reactivate instead of creating a new pending one
      if (!assignment && previousTechnicianId === currentTechnicianId) {
        const completedAssignment = await Assignment.findOne({
          bookingId: booking._id,
          technicianId: currentTechnicianId,
          status: "completed",
        });
        if (completedAssignment) {
          // Reactivate the completed assignment instead of creating a new one
          assignment = completedAssignment;
        }
      }

      if (assignment) {
        // Reuse existing assignment — update schedule only
        const wasPendingAcceptance = assignment.status === "pending_acceptance";
        const wasCompleted = assignment.status === "completed";
        assignment.bookingDate = new Date(scheduledDate);
        assignment.startTime = scheduledTime || "09:00";
        assignment.endTime = booking.endTime;
        assignment.serviceDurationMinutes = repairDurationMinutes;
        assignment.travelTime = repairTravelTime;
        // If it was completed, reactivate as accepted (no re-acceptance needed)
        // If it was pending, keep pending. Otherwise keep accepted (no re-acceptance)
        assignment.status = wasPendingAcceptance ? "pending_acceptance" : "accepted";
        assignment.completedAt = null; // Clear completed timestamp if reactivating
        assignment.notes.push({
          text: wasCompleted
            ? `Repair rescheduled for ${new Date(scheduledDate).toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} at ${scheduledTime || "09:00"}. Reactivated.${notes ? " Notes: " + notes.trim() : ""}`
            : wasPendingAcceptance
            ? `Repair schedule updated to ${new Date(scheduledDate).toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} at ${scheduledTime || "09:00"}.${notes ? " Notes: " + notes.trim() : ""}`
            : `Repair rescheduled for ${new Date(scheduledDate).toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} at ${scheduledTime || "09:00"}.${notes ? " Notes: " + notes.trim() : ""}`,
          by: req.user._id,
          byName: req.user.firstName || req.user.name || "Admin",
          createdAt: new Date(),
        });
        await assignment.save();
      } else {
        // No existing assignment — create new one in pending_acceptance
        const assignmentData = {
          bookingId: booking._id,
          technicianId: currentTechnicianId,
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
    }

    if (isMixedBooking) {
      for (const item of booking.services.filter(row => row.type === "repair" && row.status === "repair_scheduled")) {
        item.assignmentId = assignment._id;
      }
      await booking.save();
    }

    const isReschedule = assignment.status === "accepted";
    const repairWarrantyRule = warrantyRuleForBooking(await getAftercarePolicy(), booking);

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
            warranty: { days: repairWarrantyRule.enabled ? repairWarrantyRule.days : 0 },
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
          projectPhase: booking.serviceType === 'repair' ? 'assessment' : 'execution',
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
              warranty: { days: repairWarrantyRule.enabled ? repairWarrantyRule.days : 0 },
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
      let eventName, message;
      if (isReassignment) {
        // Reassigned to a different technician
        eventName = "assignment:new";
        message = `You have been assigned to a repair job — ${workOrderNum} on ${scheduledDateLabel}. Please accept or decline within the deadline.`;
      } else if (isReschedule) {
        // Same technician, rescheduled
        eventName = "booking:updated";
        message = `Repair rescheduled — ${workOrderNum} on ${scheduledDateLabel}. Inspection already done, proceed to En Route.`;
      } else {
        // New assignment
        eventName = "assignment:new";
        message = `New repair job assigned — ${workOrderNum} on ${scheduledDateLabel}`;
      }
      
      global.io.to(`tech:${tech._id}`).emit(eventName, {
        bookingId: booking._id,
        workOrderNumber: workOrderNum,
        customerName: booking.customer?.name,
        scheduledDate,
        scheduledTime,
        message,
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
      let serviceName, issueDescription;
      if (isReassignment) {
        serviceName = "Repair Assignment (Requires Acceptance)";
        issueDescription = "You have been assigned to this repair job. Please accept or decline the assignment within the deadline.";
      } else if (isReschedule) {
        serviceName = "Repair Reschedule (Inspection Done)";
        issueDescription = "This is a repair reschedule — the inspection is already complete. Proceed directly to repair execution.";
      } else {
        serviceName = "Repair Service";
        issueDescription = booking.issueDescription || booking.unitInfo?.problemDescription || "";
      }
      
      sendTechnicianNotificationEmail({
        to: tech.user?.email,
        technicianName: techFullName,
        customerName: booking.customer?.name || "Customer",
        bookingReference: workOrderNum,
        serviceName,
        dateLabel: scheduledDateLabel,
        timeLabel: scheduledTime || "09:00",
        totalLabel: `${booking.serviceDurationMinutes || 90} min`,
        locationAddress: booking.location?.address || "",
        issueDescription,
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
 * GET /api/admin/resolution-center
 * Unified operational exceptions for service bookings and aircon orders.
 * Linked delivery-installation bookings are suppressed when their order is
 * already the authoritative exception, preventing duplicate admin work.
 */
router.get("/resolution-center", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Order = require("../models/Order");
    const ServiceReport = require("../models/ServiceReport");
    const { bookingReviewState } = require("../utils/bookingReview");
    const { REVIEWABLE_ORDER_STATUSES } = require("../utils/orderAttention");
    const {
      filterResolutionCases,
      orderResolutionCase,
      paginateResolutionCases,
      sortResolutionCases,
      summarizeResolutionCases,
    } = require("../utils/resolutionCenter");
    const now = new Date();
    const recentCancellationCutoff = new Date(now.getTime() - 90 * 86400000);
    const candidateStatuses = [
      "pending", "no-show-reported", "no-show", "reschedule-required", "awaiting_assignment", "pending_reassignment", "re-scheduled",
      "confirmed", "scheduled", "on-the-way", "arrived", "in-progress",
      "inspection_scheduled", "inspection_in_progress", "repair_scheduled", "repair_in_progress",
    ];

    const [followUpReports, attentionOrders, linkedActiveOrderBookingIds] = await Promise.all([
      ServiceReport.find({ followUpRequired: true })
        .sort({ updatedAt: -1 })
        .select("bookingId followUpNotes followUpDate updatedAt")
        .lean(),
      Order.find({ status: { $in: [...REVIEWABLE_ORDER_STATUSES] } })
        .sort({ createdAt: -1 })
        .limit(500)
        .populate("technicianId", "name phone")
        .lean(),
      Order.distinct("bookingId", { bookingId: { $ne: null }, status: { $nin: ["completed", "cancelled"] } }),
    ]);
    const followUpByBooking = new Map();
    for (const report of followUpReports) {
      const key = String(report.bookingId);
      if (!followUpByBooking.has(key)) followUpByBooking.set(key, report);
    }
    const followUpBookingIds = [...followUpByBooking.keys()].filter((id) => mongoose.Types.ObjectId.isValid(id));
    const orderCases = attentionOrders.map((order) => orderResolutionCase(order, now)).filter(Boolean);
    const linkedOrderBookingIds = linkedActiveOrderBookingIds
      .map((id) => String(id || ""))
      .filter((id) => mongoose.Types.ObjectId.isValid(id));

    const bookings = await BookingService.find({
      isProject: { $ne: true },
      ...(linkedOrderBookingIds.length ? { _id: { $nin: linkedOrderBookingIds } } : {}),
      $or: [
        { status: { $in: candidateStatuses } },
        { status: "cancelled", updatedAt: { $gte: recentCancellationCutoff } },
        { _id: { $in: followUpBookingIds } },
      ],
    })
      .sort({ bookingDate: 1, updatedAt: -1 })
      .limit(500)
      .populate("customerId", "firstName lastName name email phone")
      .populate("technicianId", "name")
      .populate("assignmentId", "technicianId customerName serviceName arrivalProofUrl")
      .lean();

    const parseMinutes = (value) => {
      const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (!match) return null;
      let hour = Number(match[1]);
      const minute = Number(match[2]);
      if (match[3]) {
        const ap = match[3].toUpperCase();
        if (ap === "PM" && hour < 12) hour += 12;
        if (ap === "AM" && hour === 12) hour = 0;
      }
      return hour * 60 + minute;
    };
    const visitDateTime = (booking) => {
      if (!booking.bookingDate) return null;
      const visit = new Date(booking.bookingDate);
      const minutes = parseMinutes(booking.startTime);
      if (minutes === null) visit.setHours(23, 59, 59, 999);
      else visit.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      return visit;
    };

    // Detect overlapping service visits for each technician/day.
    const conflictBookingIds = new Set();
    const byTechnicianDay = new Map();
    for (const booking of bookings) {
      if (!booking.technicianId || !booking.bookingDate || booking.status === "cancelled") continue;
      const start = parseMinutes(booking.startTime);
      if (start === null) continue;
      const day = new Date(booking.bookingDate).toISOString().slice(0, 10);
      const technicianId = String(booking.technicianId._id || booking.technicianId);
      const key = `${technicianId}:${day}`;
      const rows = byTechnicianDay.get(key) || [];
      rows.push({ id: String(booking._id), start, end: start + Math.max(30, Number(booking.serviceDurationMinutes) || 60) });
      byTechnicianDay.set(key, rows);
    }
    for (const rows of byTechnicianDay.values()) {
      rows.sort((a, b) => a.start - b.start);
      for (let i = 0; i < rows.length; i += 1) {
        for (let j = i + 1; j < rows.length && rows[j].start < rows[i].end; j += 1) {
          conflictBookingIds.add(rows[i].id);
          conflictBookingIds.add(rows[j].id);
        }
      }
    }

    const cases = [];
    const caseKeys = new Set();
    const activeExecutionStatuses = new Set([
      "on-the-way", "arrived", "in-progress", "inspection_scheduled",
      "inspection_in_progress", "repair_scheduled", "repair_in_progress",
    ]);
    const noTechnicianStatuses = new Set(["awaiting_assignment", "confirmed", "scheduled"]);

    const addCase = (booking, issueType, details = {}) => {
      const caseKey = `${booking._id}:${issueType}`;
      if (caseKeys.has(caseKey)) return;
      const alreadyResolved = (booking.resolutionCases || []).some((decision) =>
        decision.issueType === issueType && decision.sourceStatus === booking.status &&
        ["closed", "rescheduled", "reassigned"].includes(decision.state),
      );
      if (alreadyResolved) return;
      caseKeys.add(caseKey);

      const customerDoc = booking.customerId || {};
      const embeddedCustomer = booking.customer || {};
      const customerName = customerDoc.name || `${customerDoc.firstName || ""} ${customerDoc.lastName || ""}`.trim() || embeddedCustomer.name || "Customer";
      const report = booking.noShowReport || {};
      const bookingDate = visitDateTime(booking);
      const isPastDate = Boolean(bookingDate && bookingDate < now);
      const daysPast = isPastDate ? Math.max(0, Math.floor((now - bookingDate) / 86400000)) : 0;
      const lastAction = booking.cancellationHistory?.length ? booking.cancellationHistory[booking.cancellationHistory.length - 1] : null;

      cases.push({
        caseId: `booking:${caseKey}`,
        id: String(booking._id),
        bookingId: String(booking._id),
        sourceType: "booking",
        sourceLabel: "Booking",
        reference: booking.bookingReference || booking.workOrderNumber || `#${String(booking._id).slice(-6).toUpperCase()}`,
        customer: customerName,
        email: customerDoc.email || embeddedCustomer.email || "",
        phone: customerDoc.phone || embeddedCustomer.phone || embeddedCustomer.mobile || "",
        serviceName: booking.service?.name || booking.serviceName || (booking.serviceModel === "RepairService" ? "Repair Service" : "Service"),
        serviceModel: booking.serviceModel || "CoreService",
        serviceDurationMinutes: Math.max(30, Number(booking.serviceDurationMinutes) || 60),
        quantity: Math.max(1, Number(booking.quantity) || 1),
        capacityQuantity: Number(booking.serviceDurationMinutes) > 0 ? 1 : Math.max(1, Number(booking.quantity) || 1),
        status: booking.status,
        issueType,
        severity: details.severity || (isPastDate ? (daysPast >= 2 ? "critical" : "high") : "medium"),
        reason: details.reason || "Admin decision required",
        bookingDate: booking.bookingDate,
        scheduledAt: bookingDate ? bookingDate.toISOString() : null,
        startTime: booking.startTime || "",
        technicianName: booking.technicianId?.name || booking.technician?.name || booking.technicianName || report.reportedByName || "Unassigned",
        isPastDate,
        daysPast,
        requiresReschedule: details.requiresReschedule ?? isPastDate,
        canReassign: details.canReassign ?? (!isPastDate && issueType !== "cancelled" && issueType !== "no_show"),
        proposedReschedule: booking.proposedReschedule || null,
        cancellationReason: booking.cancellationReason || lastAction?.reason || "",
        noShowReport: issueType === "no_show" ? {
          arrivedAt: report.arrivedAt || null,
          contactAttempts: report.contactAttempts || [],
          waitedMinutes: Number(report.waitedMinutes) || 0,
          arrivalProofUrl: report.arrivalProofUrl || booking.assignmentId?.arrivalProofUrl || "",
          reportedAt: report.reportedAt || null,
          reportedByName: report.reportedByName || "",
        } : null,
        awaitingCustomerSchedule: booking.status === "reschedule-required",
        rescheduleAccessExpiry: booking.rescheduleAccessExpiry || booking.noShowRescheduleExpiry || null,
        servicePrice: Number(booking.service?.price || booking.quotation?.totalAmount || booking.estimatedTotal || 0),
        amountPaid: Number(booking.payment?.downpaymentAmount || booking.downpaymentAmount || 0),
        allowedActions: [
          "view", "close", "reschedule",
          ...((details.canReassign ?? (!isPastDate && issueType !== "cancelled" && issueType !== "no_show")) ? ["reassign"] : []),
          ...(customerDoc.phone || embeddedCustomer.phone || embeddedCustomer.mobile ? ["call"] : []),
        ],
      });
    };

    for (const booking of bookings) {
      const bookingDate = visitDateTime(booking);
      const isPastDate = Boolean(bookingDate && bookingDate < now);
      const daysPast = isPastDate ? Math.max(0, Math.floor((now - bookingDate) / 86400000)) : 0;

      if (bookingReviewState(booking, now).isReviewOverdue) {
        addCase(booking, "past_date", {
          severity: "high",
          reason: "Requested schedule passed before admin review. Contact the customer to reschedule or cancel and review any refund.",
          requiresReschedule: true,
          canReassign: false,
        });
      }

      const noShowReviewStatus = booking.noShowReport?.reviewStatus;
      const isPendingNoShow = booking.status === "no-show-reported"
        || (booking.status === "no-show" && !["confirmed", "rescheduled", "cancelled"].includes(noShowReviewStatus));
      if (isPendingNoShow) {
        addCase(booking, "no_show", { severity: "critical", reason: "Technician reported the customer unavailable; confirm or reschedule the visit", requiresReschedule: false, canReassign: false });
      }
      if (booking.status === "reschedule-required") {
        // Past-date bookings that need a new date vs. no-show bookings
        if (isPastDate) {
          addCase(booking, "past_date", {
            severity: daysPast >= 2 ? "critical" : "high",
            reason: `Scheduled ${daysPast} day${daysPast === 1 ? "" : "s"} ago with no service activity. Needs a new date/time.`,
            requiresReschedule: true,
            canReassign: false,
          });
        } else {
          addCase(booking, "no_show", {
            severity: "high",
            reason: "No-show confirmed; waiting for the customer to select a new available schedule",
            requiresReschedule: true,
            canReassign: false,
          });
        }
      }
      if (booking.status === "cancelled") {
        addCase(booking, "cancelled", { severity: "high", reason: booking.cancellationReason || "Cancelled booking requires an admin decision", requiresReschedule: true, canReassign: false });
      }
      if (noTechnicianStatuses.has(booking.status) && !booking.technicianId && booking.proposedReschedule?.status !== "pending") {
        addCase(booking, "no_technician", {
          reason: isPastDate ? `Past schedule (${daysPast} day${daysPast === 1 ? "" : "s"} ago) has no technician; reschedule before assigning` : "No technician is assigned to this visit",
          requiresReschedule: isPastDate,
          canReassign: !isPastDate,
        });
      }
      if (booking.status === "pending_reassignment") {
        const lastAction = booking.cancellationHistory?.length ? booking.cancellationHistory[booking.cancellationHistory.length - 1] : null;
        addCase(booking, "technician_issue", {
          severity: "high",
          reason: lastAction ? `${lastAction.technicianName || "Technician"} ${lastAction.action}: ${lastAction.reason || "No reason provided"}` : "Technician declined or cancelled; a new technician is required",
          requiresReschedule: isPastDate,
          canReassign: !isPastDate,
        });
      }
      if (activeExecutionStatuses.has(booking.status) && isPastDate && !followUpByBooking.has(String(booking._id))) {
        addCase(booking, "incomplete", { reason: `Visit is incomplete and ${daysPast} day${daysPast === 1 ? "" : "s"} past its scheduled date`, requiresReschedule: true, canReassign: false });
      }
      const followUpReport = followUpByBooking.get(String(booking._id));
      if (followUpReport) {
        const followUpDate = followUpReport.followUpDate ? new Date(followUpReport.followUpDate).toLocaleDateString("en-PH") : "not specified";
        addCase(booking, "incomplete", {
          severity: "high",
          reason: followUpReport.followUpNotes || `Technician marked follow-up work required (target: ${followUpDate})`,
          requiresReschedule: true,
          canReassign: false,
        });
      }
      if (conflictBookingIds.has(String(booking._id))) {
        addCase(booking, "schedule_conflict", { severity: "critical", reason: "This technician has another service booking that overlaps this time slot", requiresReschedule: true, canReassign: !isPastDate });
      }
      if ((booking.status === "re-scheduled" || booking.proposedReschedule?.status === "pending" || booking.rescheduleRequest?.status === "pending") && booking.status !== "reschedule-required") {
        addCase(booking, "customer_reschedule", { reason: booking.rescheduleReason || "Customer/admin reschedule requires review and confirmation", requiresReschedule: true, canReassign: false });
      }
    }

    cases.push(...orderCases);
    sortResolutionCases(cases);
    const summary = summarizeResolutionCases(cases);
    const filtered = filterResolutionCases(cases, {
      source: req.query.source,
      issue: req.query.issue,
      severity: req.query.severity,
      q: req.query.q,
    });
    const paginated = paginateResolutionCases(filtered, req.query.page, req.query.perPage);

    res.set("Cache-Control", "no-store");
    return res.json({
      cases: paginated.cases,
      summary,
      filteredTotal: filtered.length,
      pagination: paginated.pagination,
      filters: {
        source: String(req.query.source || ""),
        issue: String(req.query.issue || ""),
        severity: String(req.query.severity || ""),
        q: String(req.query.q || ""),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/resolution-center/:id/close", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const audit = require("../utils/audit");
    const { id } = req.params;
    const issueType = String(req.body?.issueType || "").trim();
    const note = String(req.body?.note || "").trim().slice(0, 1000);
    const validIssueTypes = ["no_show", "cancelled", "incomplete", "no_technician", "technician_issue", "schedule_conflict", "customer_reschedule", "past_date"];
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking ID" });
    if (!validIssueTypes.includes(issueType)) return res.status(400).json({ error: "A valid issue type is required" });

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    booking.resolutionCases.push({
      issueType,
      sourceStatus: booking.status,
      state: "closed",
      action: "close",
      note: note || "Case closed by admin",
      decidedAt: new Date(),
      decidedBy: req.user?._id,
      decidedByName: req.user?.name || "Admin",
    });
    await booking.save();

    await audit.logEvent({
      actor: req.user?._id,
      target: booking._id,
      action: "booking.resolution.closed",
      module: "bookings",
      req,
      details: { bookingId: booking._id, issueType, note },
    }).catch(() => {});
    return res.json({ success: true, message: "Resolution case closed." });
  } catch (err) {
    next(err);
  }
});

router.post("/resolution-center/:id/reassign", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const audit = require("../utils/audit");
    const { id } = req.params;
    const issueType = String(req.body?.issueType || "technician_issue").trim();
    const note = String(req.body?.note || "").trim().slice(0, 1000);
    const validIssueTypes = ["no_show", "cancelled", "incomplete", "no_technician", "technician_issue", "schedule_conflict", "customer_reschedule", "past_date"];
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking ID" });
    if (!validIssueTypes.includes(issueType)) return res.status(400).json({ error: "A valid issue type is required" });

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const scheduledAt = booking.bookingDate ? new Date(booking.bookingDate) : null;
    if (scheduledAt) {
      const match = String(booking.startTime || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (match) {
        let hour = Number(match[1]);
        const minute = Number(match[2]);
        if (match[3]) {
          const ap = match[3].toUpperCase();
          if (ap === "PM" && hour < 12) hour += 12;
          if (ap === "AM" && hour === 12) hour = 0;
        }
        scheduledAt.setHours(hour, minute, 0, 0);
      } else {
        scheduledAt.setHours(23, 59, 59, 999);
      }
    }
    if (scheduledAt && scheduledAt < new Date()) {
      return res.status(409).json({ error: "This booking date has passed. Reschedule the visit before assigning a technician.", code: "RESCHEDULE_REQUIRED" });
    }
    if (["cancelled", "no-show", "no-show-reported"].includes(booking.status)) {
      return res.status(409).json({ error: "Reschedule this case before assigning a technician.", code: "RESCHEDULE_REQUIRED" });
    }

    const previousStatus = booking.status;
    const previousTechnicianId = booking.technicianId;
    await Assignment.updateMany(
      { bookingId: booking._id, status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] } },
      { $set: { status: "expired", expiredAt: new Date(), expiredReason: "Reassigned from Booking Resolution Center" } },
    );

    booking.status = "pending_reassignment";
    booking.assignmentId = null;
    booking.technicianId = null;
    booking.technician = null;
    booking.reassignmentCount = (booking.reassignmentCount || 0) + 1;
    booking.statusHistory.push({
      fromStatus: previousStatus,
      toStatus: "pending_reassignment",
      changedBy: req.user?._id,
      changedByModel: "User",
      changedByName: req.user?.name || "Admin",
      reason: note || "Admin requested reassignment from Booking Resolution Center",
      timestamp: new Date(),
    });
    booking.resolutionCases.push({
      issueType,
      sourceStatus: previousStatus,
      state: "reassigned",
      action: "reassign",
      note: note || "Sent to assignment queue",
      decidedAt: new Date(),
      decidedBy: req.user?._id,
      decidedByName: req.user?.name || "Admin",
    });
    await booking.save();

    if (previousTechnicianId) {
      const Technician = require("../models/Technician");
      const previousTechnician = await Technician.findById(previousTechnicianId).catch(() => null);
      if (previousTechnician) {
        const { resolveAvailabilityStatus } = require("../utils/availability");
        await resolveAvailabilityStatus(previousTechnician, null, null, { syncDb: true }).catch(() => {});
      }
    }
    await audit.logEvent({
      actor: req.user?._id,
      target: booking._id,
      action: "booking.resolution.reassigned",
      module: "bookings",
      req,
      details: { bookingId: booking._id, issueType, previousStatus },
    }).catch(() => {});
    return res.json({ success: true, message: "Booking sent to the assignment queue." });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/resolution-center/:id/payment-summary
 * Actual amount the customer has paid, computed from Payment records
 * (sum of received payments minus any refunds already issued).
 */
router.get("/resolution-center/:id/payment-summary", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Payment = require("../models/Payment");
    const { summarizeBookingPayments } = require("../utils/paymentSummary");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking ID" });

    const booking = await BookingService.findById(id).select("paymentStatus paymentMethod downpaymentAmount totalPrice").lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Pending rows are returned separately so the UI can show submitted money
    // without treating it as refundable before an admin verifies it.
    const payments = await Payment.find({ bookingId: id }).sort({ submittedAt: -1 }).lean();
    const summary = summarizeBookingPayments(booking, payments);

    return res.json({
      success: true,
      ...summary,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/resolution-center/:id/verify-pending-payment
 * Verifies a submitted payment without advancing an overdue booking to the
 * assignment queue. The booking remains actionable in the Resolution Center.
 */
router.post("/resolution-center/:id/verify-pending-payment", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Payment = require("../models/Payment");
    const { summarizeBookingPayments } = require("../utils/paymentSummary");
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking ID" });

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (["cancelled", "completed", "closed"].includes(booking.status)) {
      return res.status(400).json({ error: `Cannot verify payment for a booking with status "${booking.status}".` });
    }

    const payment = await Payment.findOne({ bookingId: booking._id, status: "pending" }).sort({ submittedAt: -1 });
    if (!payment) return res.status(404).json({ error: "No pending payment submission was found for this booking." });
    if (!(Number(payment.amount) > 0)) return res.status(400).json({ error: "The pending payment has no valid amount." });
    if (!payment.proofUrl && !booking.paymentProof && !payment.reference) {
      return res.status(400).json({ error: "Payment proof or a transaction reference is required before verification." });
    }

    const now = new Date();
    // COD describes how the remaining balance is collected. Its initial
    // downpayment is commonly submitted through GCash, so use booking terms.
    const isCOD = String(booking.paymentMethod || "").toLowerCase() === "cod";
    payment.status = isCOD ? "partial" : "paid";
    payment.verifiedAt = now;
    payment.verifiedBy = req.user?._id;
    payment.events.push({
      status: payment.status,
      actor: req.user?._id,
      actorName: req.user?.name || req.user?.email || "Admin",
      actorRole: "admin",
      note: "Payment verified from the Booking Resolution Center",
      at: now,
    });
    await payment.save();

    const payments = await Payment.find({ bookingId: booking._id }).sort({ submittedAt: -1 }).lean();
    const summary = summarizeBookingPayments(booking, payments);
    booking.paymentStatus = isCOD ? "partial" : "paid";
    booking.amountPaid = summary.amountPaid;
    booking.balanceAmount = Math.max(0, Number(booking.totalPrice || booking.estimatedFee || 0) - summary.amountPaid);
    booking.paymentVerifiedAt = now;
    booking.paymentVerifiedBy = req.user?._id;
    await booking.save();

    await audit.logEvent({
      actor: req.user?._id,
      target: booking._id,
      action: "booking.payment_verify_resolution",
      module: "bookings",
      req,
      details: { bookingId: booking._id, paymentId: payment._id, amount: payment.amount, method: payment.method },
    }).catch(() => {});

    return res.json({ success: true, message: "Payment verified. The submitted amount is now refundable.", ...summary });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/resolution-center/:id/cancel-with-refund
 * Admin cancels a booking with full control over refund amount and method.
 *
 * Body: {
 *   reason: string,
 *   reasonType: "customer_request" | "no_longer_needs_service" | "scheduling_issue" | "other",
 *   refundDecision: "full" | "partial" | "none",
 *   refundAmount?: number,   // required if refundDecision === "partial"
 *   refundMethod?: string,   // "original" | "gcash" | "bank" | "cash"
 *   refundNotes?: string
 * }
 */
router.post("/resolution-center/:id/cancel-with-refund", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Payment = require("../models/Payment");
    const audit = require("../utils/audit");
    const { id } = req.params;
    const { reason, reasonType, refundDecision, refundAmount, refundMethod, refundNotes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking ID" });

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (["cancelled", "completed", "closed"].includes(booking.status)) {
      return res.status(400).json({ error: `Cannot cancel a booking with status "${booking.status}".` });
    }

    const previousStatus = booking.status;

    // Cancel existing assignment if any
    if (booking.assignmentId) {
      try {
        await Assignment.findByIdAndUpdate(booking.assignmentId, {
          status: "cancelled",
          cancelledAt: new Date(),
          notes: "Auto-cancelled: booking cancelled by admin",
        });
      } catch (_) {}
    }

    // Set booking to cancelled
    booking.status = "cancelled";
    booking.cancellationReason = reason || "Cancelled by admin";
    booking.technicianId = null;
    booking.assignmentId = null;

    // Handle refund
    let payment = null;
    if (refundDecision && refundDecision !== "none") {
      // Money actually received from the customer (any payment type —
      // downpayment for COD, full amount for GCash, etc.)
      const PAID_STATUSES = ["verified", "paid", "remitted", "payment_collected", "partial", "waiting_for_remittance"];
      payment = await Payment.findOne({
        bookingId: booking._id,
        status: { $in: PAID_STATUSES },
      }).sort({ submittedAt: -1 });

      if (payment) {
        // Full refund returns exactly what the customer actually paid on this record;
        // partial refunds are capped at the paid amount.
        const maxRefundable = Math.max(0, (Number(payment.amount) || 0) - (Number(payment.refundAmount) || 0));
        let refundAmt = refundDecision === "full"
          ? maxRefundable
          : Math.min(maxRefundable, Math.max(0, Number(refundAmount) || 0));
        if (!(refundAmt > 0)) {
          return res.status(400).json({ error: "No refundable amount found on this payment. The customer may not have a verified payment, or it was already refunded." });
        }

        payment.refundStatus = refundDecision === "full" ? "pending" : (refundAmt > 0 ? "pending" : "none");
        payment.refundAmount = refundAmt;
        payment.refundMethod = refundMethod || "original";
        payment.refundNotes = refundNotes || "";
        payment.refundReason = reason || "Admin-initiated cancellation";

        if (refundDecision === "full" && refundAmt === (payment.amount || 0)) {
          payment.status = "refunded";
          payment.refundedAt = new Date();
          payment.refundedBy = req.user?._id;
        }

        payment.events.push({
          status: payment.status === "refunded" ? "refunded" : "refund_pending",
          actor: req.user?._id,
          actorName: req.user?.name || req.user?.email || "Admin",
          actorRole: "admin",
          note: refundDecision === "full"
            ? `Full refund of ₱${refundAmt} approved`
            : refundDecision === "partial"
              ? `Partial refund of ₱${refundAmt} approved`
              : "No refund",
          at: new Date(),
          metadata: { refundDecision, refundMethod, refundNotes },
        });
        await payment.save();

        booking.paymentStatus = payment.status === "refunded" ? "refunded" : booking.paymentStatus;
        booking.refundStatus = payment.refundStatus;
        booking.refundAmount = payment.refundAmount;
        booking.refundMethod = payment.refundMethod;
        booking.refundNotes = payment.refundNotes;
      }
    }

    // Record status history
    booking.recordStatusHistory({
      fromStatus: previousStatus,
      toStatus: "cancelled",
      changedBy: req.user?._id,
      changedByModel: "User",
      changedByName: req.user?.name || "Admin",
      reason: reason || "Cancelled by admin",
    });

    // Record in cancellation history so the Cancellation Log page picks it up
    if (!Array.isArray(booking.cancellationHistory)) booking.cancellationHistory = [];
    booking.cancellationHistory.push({
      technicianId: undefined,
      technicianName: req.user?.name || "Admin",
      action: "cancelled",
      reason: `${reasonType ? reasonType.replace(/_/g, " ") : "admin cancellation"}${reason ? `: ${reason}` : ""}${refundDecision !== "none" ? ` (refund ${refundDecision}${refundAmount ? ` ₱${refundAmount}` : ""})` : ""}`,
      timestamp: new Date(),
    });

    // Record resolution case
    const validIssueTypes = ["no_show", "cancelled", "incomplete", "no_technician", "technician_issue", "schedule_conflict", "customer_reschedule", "past_date"];
    const issueType = req.body.issueType || "past_date";
    if (validIssueTypes.includes(issueType)) {
      booking.resolutionCases.push({
        issueType,
        sourceStatus: previousStatus,
        state: "closed",
        action: "close",
        note: reason || "Cancelled by admin from resolution center",
        decidedAt: new Date(),
        decidedBy: req.user?._id,
        decidedByName: req.user?.name || "Admin",
      });
    }

    // Close any open past_date resolution cases — the scheduling issue is resolved
    if (booking.resolutionCases && Array.isArray(booking.resolutionCases)) {
      for (const rc of booking.resolutionCases) {
        if (rc.issueType === "past_date" && !["closed", "rescheduled", "reassigned"].includes(rc.state)) {
          rc.state = "rescheduled";
          rc.action = "reschedule";
          rc.note = reason || "New visit scheduled by admin";
          rc.decidedAt = new Date();
          rc.decidedBy = req.user?._id;
          rc.decidedByName = req.user?.name || "Admin";
        }
      }
    }

    await booking.save();

    // Notify customer
    try {
      const { createNotification } = require("./notify");
      const customerName = booking.customer?.name || "Customer";
      const refundSummary = refundDecision === "full"
        ? "A full refund will be processed."
        : refundDecision === "partial"
          ? `A partial refund of ₱${refundAmount || 0} will be processed.`
          : "No refund will be issued.";

      await createNotification({
        type: "booking_cancelled",
        title: "Booking Cancelled",
        message: `Your booking ${booking.bookingReference || ""} has been cancelled. ${refundSummary}`,
        userId: booking.customerId,
        role: "customer",
        referenceId: booking._id,
        referenceModel: "BookingService",
        link: "/tracking",
      }).catch(() => {});
    } catch (_) {}

    // Audit
    await audit.logEvent({
      actor: req.user?._id,
      target: booking._id,
      action: "booking.admin_cancel",
      module: "bookings",
      req,
      details: {
        bookingId: booking._id,
        previousStatus,
        reason,
        reasonType,
        refundDecision,
        refundAmount: refundAmount || 0,
        refundMethod,
        paymentRefunded: payment?.status === "refunded",
      },
    }).catch(() => {});

    return res.json({
      success: true,
      message: "Booking cancelled.",
      refund: refundDecision !== "none" ? {
        status: payment?.refundStatus || "none",
        amount: payment?.refundAmount || 0,
        method: payment?.refundMethod || "",
      } : null,
    });
  } catch (err) {
    console.error("Cancel with refund error:", err);
    next(err);
  }
});

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
      "no-show-reported",
      "reschedule-required",
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
        .populate("assignmentId", "technicianId customerName serviceName arrivalProofUrl")
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
      } else if (b.status === "no-show-reported") {
        reason = "Technician reported the customer unavailable; admin decision required";
      } else if (b.status === "reschedule-required") {
        reason = "This booking has passed its scheduled date. A future visit must be set before assignment.";
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
        technicianName: b.technicianId?.name || b.technician?.name || b.technicianName || b.noShowReport?.reportedByName || "Unassigned",
        serviceDurationMinutes: Number(b.serviceDurationMinutes) || 60,
        updatedAt: b.updatedAt,
        requiresReschedule: ["re-scheduled", "pending_reassignment"].includes(b.status),
        noShowReport: b.status === "no-show-reported" ? {
          arrivedAt: b.noShowReport?.arrivedAt || null,
          contactAttempts: b.noShowReport?.contactAttempts || [],
          waitedMinutes: Number(b.noShowReport?.waitedMinutes) || 0,
          arrivalProofUrl: b.noShowReport?.arrivalProofUrl || b.assignmentId?.arrivalProofUrl || "",
          reportedAt: b.noShowReport?.reportedAt || null,
          reportedByName: b.noShowReport?.reportedByName || "",
        } : null,
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
        servicePrice: Number(b.service?.price || b.quotation?.totalAmount || b.estimatedTotal || 0),
        amountPaid: Number(b.payment?.downpaymentAmount || b.downpaymentAmount || 0),
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

// ─── Review & Reschedule Scanner ──────────────────────────────────────────────

/**
 * GET /api/admin/review-reschedule
 * Scans all active bookings and identifies problems that need admin action
 * before the next dispatch cycle.
 *
 * Problem categories:
 *  1. past_date_no_tech   – bookingDate passed, no technician assigned
 *  2. stalled_in_queue    – stuck in awaiting_assignment / pending_reassignment 24h+
 *  3. expiring_proposal   – proposedReschedule about to expire, no customer response
 *  4. overdue_job         – bookingDate passed, still in on-the-way / arrived / in-progress
 */
router.get("/review-reschedule", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const now = new Date();

    // Status groups
    const needsTechStatuses = ["scheduled", "confirmed", "awaiting_assignment", "pending_reassignment"];
    const activeJobStatuses = ["on-the-way", "arrived", "in-progress"];
    const queueStatuses = ["awaiting_assignment", "pending_reassignment"];

    // Fetch all relevant bookings in one query
    const allBookings = await BookingService.find({
      status: { $in: [...needsTechStatuses, ...activeJobStatuses] },
    })
      .populate("customerId", "name email phone")
      .populate("technicianId", "name")
      .lean();

    const problems = [];

    for (const b of allBookings) {
      const bookingDate = b.bookingDate ? new Date(b.bookingDate) : null;
      const msPassed = bookingDate ? now - bookingDate : 0;
      const hoursPassed = msPassed / (1000 * 60 * 60);
      const daysPassed = hoursPassed / 24;

      // ── Category 1: Past date, no technician ──
      if (bookingDate && msPassed > 0 && needsTechStatuses.includes(b.status) && !b.technicianId) {
        problems.push({
          bookingId: b._id,
          reference: b.bookingReference,
          customer: b.customer?.name || "—",
          customerEmail: b.customer?.email || "",
          customerPhone: b.customer?.phone || "",
          serviceName: b.service || b.serviceType || "—",
          status: b.status,
          bookingDate: b.bookingDate,
          startTime: b.startTime || "—",
          technician: null,
          category: "past_date_no_tech",
          severity: daysPassed > 2 ? "critical" : daysPassed > 1 ? "high" : "medium",
          elapsed: `${Math.floor(daysPassed)}d ${Math.floor(hoursPassed % 24)}h`,
          elapsedHours: Math.floor(hoursPassed),
          reason: `Scheduled ${Math.floor(daysPassed)} day(s) ago with no technician assigned`,
          proposedReschedule: b.proposedReschedule || null,
        });
      }

      // ── Category 2: Stalled in queue 24h+ ──
      if (queueStatuses.includes(b.status) && hoursPassed > 24 && b.technicianId) {
        problems.push({
          bookingId: b._id,
          reference: b.bookingReference,
          customer: b.customer?.name || "—",
          customerEmail: b.customer?.email || "",
          customerPhone: b.customer?.phone || "",
          serviceName: b.service || b.serviceType || "—",
          status: b.status,
          bookingDate: b.bookingDate,
          startTime: b.startTime || "—",
          technician: b.technicianId?.name || "—",
          category: "stalled_in_queue",
          severity: daysPassed > 3 ? "critical" : "high",
          elapsed: `${Math.floor(daysPassed)}d ${Math.floor(hoursPassed % 24)}h`,
          elapsedHours: Math.floor(hoursPassed),
          reason: `Assigned but stuck for ${Math.floor(hoursPassed)}h without progress`,
          proposedReschedule: b.proposedReschedule || null,
        });
      }

      // ── Category 3: Expiring proposals ──
      if (b.proposedReschedule && b.proposedReschedule.status === "pending" && b.proposedReschedule.expiresAt) {
        const expiresAt = new Date(b.proposedReschedule.expiresAt);
        const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);
        if (hoursUntilExpiry < 24 && hoursUntilExpiry > 0) {
          problems.push({
            bookingId: b._id,
            reference: b.bookingReference,
            customer: b.customer?.name || "—",
            customerEmail: b.customer?.email || "",
            customerPhone: b.customer?.phone || "",
            serviceName: b.service || b.serviceType || "—",
            status: b.status,
            bookingDate: b.bookingDate,
            startTime: b.startTime || "—",
            technician: b.technicianId?.name || "—",
            category: "expiring_proposal",
            severity: hoursUntilExpiry < 6 ? "critical" : "high",
            elapsed: `${Math.floor(hoursUntilExpiry)}h`,
            elapsedHours: Math.floor(hoursUntilExpiry),
            reason: `Reschedule proposal expires in ${Math.floor(hoursUntilExpiry)}h — customer hasn't responded`,
            proposedReschedule: b.proposedReschedule,
          });
        }
      }

      // ── Category 4: Overdue jobs ──
      if (activeJobStatuses.includes(b.status) && bookingDate && msPassed > 0) {
        const overdueDays = daysPassed;
        problems.push({
          bookingId: b._id,
          reference: b.bookingReference,
          customer: b.customer?.name || "—",
          customerEmail: b.customer?.email || "",
          customerPhone: b.customer?.phone || "",
          serviceName: b.service || b.serviceType || "—",
          status: b.status,
          bookingDate: b.bookingDate,
          startTime: b.startTime || "—",
          technician: b.technicianId?.name || "Unassigned",
          category: "overdue_job",
          severity: overdueDays > 3 ? "critical" : overdueDays > 1 ? "high" : "medium",
          elapsed: `${Math.floor(overdueDays)}d ${Math.floor(hoursPassed % 24)}h`,
          elapsedHours: Math.floor(hoursPassed),
          reason: `Job should be completed — ${Math.floor(overdueDays)} day(s) overdue`,
          proposedReschedule: null,
        });
      }
    }

    // Sort by severity then by most overdue
    const severityOrder = { critical: 0, high: 1, medium: 2 };
    problems.sort((a, b) => {
      const sv = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
      if (sv !== 0) return sv;
      return b.elapsedHours - a.elapsedHours;
    });

    // Summary counts
    const summary = {
      total: problems.length,
      critical: problems.filter(p => p.severity === "critical").length,
      high: problems.filter(p => p.severity === "high").length,
      medium: problems.filter(p => p.severity === "medium").length,
      byCategory: {
        past_date_no_tech: problems.filter(p => p.category === "past_date_no_tech").length,
        stalled_in_queue: problems.filter(p => p.category === "stalled_in_queue").length,
        expiring_proposal: problems.filter(p => p.category === "expiring_proposal").length,
        overdue_job: problems.filter(p => p.category === "overdue_job").length,
      },
    };

    return res.json({ problems, summary });
  } catch (err) {
    console.error("Review & Reschedule scan error:", err);
    next(err);
  }
});

/**
 * POST /api/admin/review-reschedule/:id/reschedule
 * Reschedule a problematic booking to a new date/time.
 * Notifies customer via email + socket + in-app notification.
 */
router.post("/review-reschedule/:id/reschedule", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const audit = require("../utils/audit");
    const { sendRescheduleNotificationEmail } = require("../utils/mailer");
    const { io } = require("../index");
    const { id } = req.params;
    const { date, time, technicianId, technicianName, reason, issueType } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid booking ID" });
    }

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    if (!date || !time) return res.status(400).json({ error: "A new date and time are required." });
    const dateObj = new Date(date);
    if (Number.isNaN(dateObj.getTime())) return res.status(400).json({ error: "Invalid reschedule date." });
    const timeMatch = String(time).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (!timeMatch) return res.status(400).json({ error: "Invalid reschedule time." });
    let scheduledHour = Number(timeMatch[1]);
    const scheduledMinute = Number(timeMatch[2]);
    if (timeMatch[3]) {
      const ap = timeMatch[3].toUpperCase();
      if (ap === "PM" && scheduledHour < 12) scheduledHour += 12;
      if (ap === "AM" && scheduledHour === 12) scheduledHour = 0;
    }
    const scheduledAt = new Date(dateObj);
    scheduledAt.setHours(scheduledHour, scheduledMinute, 0, 0);
    if (scheduledAt <= new Date()) {
      return res.status(400).json({ error: "The new visit must be scheduled in the future." });
    }

    // Store original date/time for reference
    const originalDate = booking.bookingDate;
    const originalTime = booking.startTime;

    // Cancel existing assignment if any
    if (booking.assignmentId) {
      await Assignment.findByIdAndUpdate(booking.assignmentId, { status: "cancelled" }).catch(() => {});
    }

    // Invalidate any outstanding customer reschedule request
    if (booking.rescheduleRequest && booking.rescheduleRequest.requested && booking.rescheduleRequest.status === "pending") {
      booking.rescheduleRequest.status = "superseded";
      booking.rescheduleRequest.processedBy = req.user?._id;
      booking.rescheduleRequest.processedAt = new Date();
    }

    // Set proposed reschedule
    booking.proposedReschedule = {
      proposedAt: new Date(),
      proposedBy: req.user?._id,
      proposedByName: req.user?.name || "Admin",
      date: dateObj,
      time: time || "",
      dateLabel: dateObj.toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
      timeLabel: time || "",
      originalDate: originalDate,
      originalTime: originalTime,
      technicianId: technicianId || undefined,
      technicianName: technicianName || "",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: "pending",
    };

    // Update the actual booking date/time immediately
    booking.bookingDate = dateObj;
    if (booking.preferredDate) booking.preferredDate = dateObj;
    if (time) booking.startTime = time;
    // New future schedule set — clear the past-date/overdue flag
    booking.autoReschedulePending = false;

    // If no technician assigned, go to awaiting_assignment so admin can assign one
    // If technician exists, go to re-scheduled for customer confirmation
    const previousStatus = booking.status;
    const retainedTechnicianId = issueType === "customer_reschedule" ? booking.technicianId : null;
    const targetTechnicianId = technicianId || retainedTechnicianId || null;
    const isPendingReviewReschedule = previousStatus === "pending";
    booking.status = isPendingReviewReschedule
      ? "pending"
      : (targetTechnicianId ? "re-scheduled" : "awaiting_assignment");
    // When no technician is included, the schedule is committed by admin and
    // needs no customer confirmation. Auto-apply the proposal so booking
    // history does not show "Needs Confirmation / Accept / Pick New Date".
    if (!targetTechnicianId) {
      booking.proposedReschedule.status = "accepted";
    }
    booking.rescheduleReason = reason || "Admin rescheduled (Review & Reschedule)";
    booking.assignmentId = null;
    booking.technicianId = targetTechnicianId;
    booking.technician = technicianId
      ? { _id: technicianId, name: technicianName || "" }
      : (retainedTechnicianId ? booking.technician : null);

    // Record status history
    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      fromStatus: previousStatus,
      toStatus: booking.status,
      changedBy: req.user?._id,
      changedByName: req.user?.name || "Admin",
      changedByModel: "User",
      reason: reason || "Admin rescheduled (Review & Reschedule)",
      notes: `Rescheduled from ${originalDate ? new Date(originalDate).toLocaleDateString("en-PH") : "N/A"} to ${dateObj.toLocaleDateString("en-PH")} ${time || ""}`,
      timestamp: new Date(),
    });
    const validIssueTypes = ["cancelled", "incomplete", "no_technician", "technician_issue", "schedule_conflict", "customer_reschedule", "past_date"];
    if (validIssueTypes.includes(issueType)) {
      booking.resolutionCases.push({
        issueType,
        sourceStatus: previousStatus,
        state: "rescheduled",
        action: "reschedule",
        note: reason || "New visit scheduled by admin",
        decidedAt: new Date(),
        decidedBy: req.user?._id,
        decidedByName: req.user?.name || "Admin",
      });
    }

    await booking.save();

    // ── Notify customer ──
    const customerEmail = booking.customer?.email || booking.customerId?.email;
    const customerName = booking.customer?.name || "Customer";
    const bookingRef = booking.bookingReference || String(booking._id).slice(-8);

    // 1. Send email notification
    if (customerEmail) {
      try {
        await sendRescheduleNotificationEmail({
          to: customerEmail,
          customerName,
          bookingReference: bookingRef,
          newDate: dateObj.toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
          newTime: time || "To be assigned",
          currentDate: originalDate ? new Date(originalDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" }) : "N/A",
          currentTime: originalTime || "N/A",
          reason: reason || "Schedule adjustment",
          serviceName: booking.service || booking.serviceType || "Service",
        });
        console.log("[MAILER] Reschedule notification sent to:", customerEmail);
      } catch (emailErr) {
        console.error("[MAILER] Failed to send reschedule email:", emailErr.message);
      }
    }

    const needsCustomerConfirmation = Boolean(targetTechnicianId) && !isPendingReviewReschedule;
    const customerScheduleMessage = isPendingReviewReschedule
      ? `Your requested schedule was updated to ${dateObj.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} ${time || ""}. Your booking remains pending admin review.`
      : (needsCustomerConfirmation
          ? `Your booking has been rescheduled to ${dateObj.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} ${time || ""}. Please confirm or request a new schedule.`
          : `Your booking has been rescheduled to ${dateObj.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} ${time || ""}. A technician will be assigned shortly.`);

    // 2. Send socket notification to customer
    if (io && booking.customerId) {
      try {
        io.to("customer-" + booking.customerId).emit("booking:rescheduled", {
          bookingId: booking._id,
          bookingReference: bookingRef,
          message: customerScheduleMessage,
          proposedReschedule: booking.proposedReschedule,
        });
      } catch (socketErr) {
        console.error("[SOCKET] Failed to notify customer:", socketErr.message);
      }
    }

    // 3. Create in-app notification for customer
    if (booking.customerId) {
      try {
        const Notification = require("../models/Notification");
        await Notification.create({
          userId: booking.customerId,
          type: "booking_rescheduled",
          title: "Booking Rescheduled",
          message: isPendingReviewReschedule
            ? `Your requested schedule for booking ${bookingRef} was updated to ${dateObj.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} ${time || ""}. It remains pending admin review.`
            : (needsCustomerConfirmation
                ? `Your booking ${bookingRef} has been rescheduled to ${dateObj.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} ${time || ""}. Please review and confirm.`
                : `Your booking ${bookingRef} has been rescheduled to ${dateObj.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })} ${time || ""}. A technician will be assigned shortly.`),
          bookingId: booking._id,
          read: false,
        });
      } catch (notifErr) {
        console.error("[NOTIF] Failed to create notification:", notifErr.message);
      }
    }

    // 4. Notify admin room via socket
    if (io) {
      try {
        io.to("admin-room").emit("booking:rescheduled", {
          bookingId: booking._id,
          bookingReference: bookingRef,
          message: `Booking ${bookingRef} rescheduled by admin`,
        });
      } catch (e) { /* optional */ }
    }

    // Audit log
    try {
      await audit.logEvent({
        actor: req.user?._id,
        target: booking._id,
        action: "booking.review_reschedule",
        module: "bookings",
        req,
        details: { bookingId: booking._id, newDate: date, newTime: time, reason, previousStatus },
      });
    } catch (e) { /* audit optional */ }

    return res.json({ success: true, booking: booking.toObject() });
  } catch (err) {
    console.error("Review reschedule error:", err);
    next(err);
  }
});

/**
 * POST /api/admin/review-reschedule/:id/cancel
 * Cancel a problematic booking.
 */
router.post("/review-reschedule/:id/cancel", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const audit = require("../utils/audit");
    const { id } = req.params;
    const { reason } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid booking ID" });
    }

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    booking.status = "cancelled";
    booking.cancellationReason = reason || "Cancelled via Review & Reschedule";
    await booking.save();

    try {
      await audit.logEvent({
        actor: req.user?._id,
        target: booking._id,
        action: "booking.review_cancel",
        module: "bookings",
        req,
        details: { bookingId: booking._id, reason },
      });
    } catch (e) { /* audit optional */ }

    return res.json({ success: true });
  } catch (err) {
    console.error("Review cancel error:", err);
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// NO-SHOW REVIEW — admin reviews technician-reported no-shows
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/no-show-review
 * Returns all bookings currently in "no-show-reported" (pending review) with
 * the technician evidence: contact attempts, arrival proof, waited minutes.
 */
router.get("/no-show-review", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const pendingNoShowQuery = {
      $or: [
        { status: "no-show-reported" },
        { status: "no-show", "noShowReport.reviewStatus": { $nin: ["confirmed", "rescheduled", "cancelled"] } },
      ],
    };

    const [bookings, stats] = await Promise.all([
      BookingService.find(pendingNoShowQuery)
        .populate("assignmentId", "technicianId customerName serviceName arrivalProofUrl")
        .lean(),
      Promise.all([
        BookingService.countDocuments(pendingNoShowQuery),
        BookingService.countDocuments({ "noShowReport.reviewStatus": "confirmed" }),
        BookingService.countDocuments({ "noShowReport.reviewStatus": "rescheduled" }),
      ]),
    ]);

    const items = bookings.map((b) => {
      const report = b.noShowReport || {};
      const assignment = b.assignmentId || null;
      const cust = b.customer || {};
      const serv = b.service || {};
      const techName = b.technicianName || (assignment && assignment.technicianId ? (assignment.technicianId.name || "") : "") || "";
      return {
        bookingId: b._id,
        reference: b.bookingReference || `#${String(b._id).slice(-6).toUpperCase()}`,
        customer: cust.name || (assignment ? assignment.customerName : "—"),
        customerEmail: cust.email || "",
        customerPhone: cust.phone || "",
        serviceName: serv.name || b.serviceName || (assignment ? assignment.serviceName : "—") || "Service",
        technicianId: assignment && assignment.technicianId ? assignment.technicianId._id : (b.technicianId || null),
        technicianName: techName,
        arrivalTime: report.arrivedAt || null,
        contactAttempts: report.contactAttempts || [],
        waitedMinutes: report.waitedMinutes || 0,
        arrivalProofUrl: report.arrivalProofUrl || assignment?.arrivalProofUrl || "",
        reportedAt: report.reportedAt || null,
        reportedByName: report.reportedByName || "",
        waitingUntil: report.waitingUntil || null,
        noShowRescheduleStatus: b.noShowRescheduleStatus || "pending",
        noShowAt: b.noShowAt || null,
      };
    });

res.json({
      items,
      stats: { pending: stats[0], confirmed: stats[1], rescheduled: stats[2] },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/no-show-review/:id/confirm
 * Admin confirms the no-show and either closes it or explicitly grants the
 * customer a 72-hour window to select a new available schedule.
 */
router.post("/no-show-review/:id/confirm", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const SiteSetting = require("../models/SiteSetting");
    const audit = require("../utils/audit");
    const { createNotification } = require("../utils/notify");
    const { sendNoShowRescheduleEmail } = require("../utils/mailer");

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid booking ID" });
    }

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const isLegacyPendingNoShow = booking.status === "no-show"
      && !["confirmed", "rescheduled", "cancelled"].includes(booking.noShowReport?.reviewStatus);
    if (booking.status !== "no-show-reported" && !isLegacyPendingNoShow) {
      return res.status(409).json({ error: "This booking is not pending no-show review." });
    }

    // Load configured fee policy
    const policyDoc = await SiteSetting.findOne({ key: "noShowPolicy" }).lean();
    const policy = policyDoc?.value || { mode: "none", fixedFeeAmount: 0 };
    const mode = policy.mode === "travel_fee" ? "travel_fee" : policy.mode === "fixed_fee" ? "fixed_fee" : "none";
    const feeAmount = mode === "fixed_fee"
      ? Math.max(0, Number(policy.fixedFeeAmount) || 0)
      : mode === "travel_fee"
        ? Math.max(0, Number(booking.travelFare) || 0)
        : 0;

    const now = new Date();
    const prevStatus = booking.status;
    const allowCustomerReschedule = req.body?.allowCustomerReschedule === true;
    const token = allowCustomerReschedule
      ? (booking.rescheduleAccessToken || booking.noShowRescheduleToken || require("crypto").randomBytes(32).toString("hex"))
      : null;
    const expiry = allowCustomerReschedule ? new Date(Date.now() + 72 * 60 * 60 * 1000) : null;
    const nextStatus = allowCustomerReschedule ? "reschedule-required" : "no-show";
    const statusEntries = [{
          fromStatus: prevStatus,
          toStatus: "no-show",
          reason: `No-show confirmed by admin${mode !== "none" ? `. ${mode === "travel_fee" ? "Travel" : "No-show"} fee applied: ₱${feeAmount}.` : ""}`,
          timestamp: now,
          changedByName: req.user.name || "Admin",
          changedByModel: "User",
    }];
    if (allowCustomerReschedule) {
      statusEntries.push({
        fromStatus: "no-show",
        toStatus: "reschedule-required",
        reason: "Admin allowed the customer to select a new available schedule.",
        timestamp: now,
        changedBy: req.user._id,
        changedByName: req.user.name || "Admin",
        changedByModel: "User",
      });
    }

    const bookingUpdate = {
      $set: {
        status: nextStatus,
        noShowAt: now,
        noShowFeeType: mode,
        noShowFeeAmount: feeAmount,
        noShowRescheduleStatus: allowCustomerReschedule ? "pending" : "cancelled",
        "noShowReport.reviewStatus": "confirmed",
        "noShowReport.decisionAt": now,
        "noShowReport.decisionBy": req.user._id,
        "noShowReport.decisionByName": req.user.name || "Admin",
      },
      $push: { statusHistory: { $each: statusEntries } },
    };
    if (allowCustomerReschedule) {
      Object.assign(bookingUpdate.$set, {
        noShowRescheduleToken: token,
        noShowRescheduleExpiry: expiry,
        rescheduleAccessToken: token,
        rescheduleAccessExpiry: expiry,
        rescheduleAccessStatus: "allowed",
        rescheduleSource: "customer",
        rescheduleReasonType: "no_show",
      });
      bookingUpdate.$push.rescheduleHistory = {
        previousDate: booking.bookingDate,
        previousTime: booking.startTime,
        reasonType: "no_show",
        source: "customer",
        authorizedAt: now,
        authorizedBy: req.user._id,
      };
    } else {
      bookingUpdate.$unset = {
        noShowRescheduleToken: 1,
        noShowRescheduleExpiry: 1,
        rescheduleAccessToken: 1,
        rescheduleAccessExpiry: 1,
        rescheduleAccessStatus: 1,
      };
    }
    await BookingService.findByIdAndUpdate(booking._id, bookingUpdate);

    await Assignment.updateMany(
      { bookingId: booking._id, status: { $in: ["on_site", "waiting_for_customer", "no_show_reported"] } },
      { $set: { status: "no_show" } },
    );

    // Send the customer-selection link only when admin explicitly allows it.
    const bookingRef = booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`;
    if (allowCustomerReschedule && booking.customer && booking.customer.email) {
      const rescheduleUrl = `${req.protocol}://${req.get("host")}/reschedule/no-show/${token}`;
      await sendNoShowRescheduleEmail({
        to: booking.customer.email,
        customerName: booking.customer.name,
        bookingReference: bookingRef,
        serviceName: booking.service?.name || "Service",
        technicianName: "",
        dateLabel: booking.bookingDate ? new Date(booking.bookingDate).toLocaleDateString() : "TBD",
        timeLabel: booking.startTime || "TBD",
        rescheduleUrl,
      }).catch((e) => console.error("[MAILER] No-show confirm email error:", e.message));
    }

    await createNotification({
      role: "admin",
      type: "booking_no_show",
      title: allowCustomerReschedule ? "Customer Reschedule Required" : "No-Show Confirmed",
      message: allowCustomerReschedule
        ? `${bookingRef} was confirmed as no-show. The customer may now select a new available schedule.`
        : `${bookingRef} confirmed as no-show${feeAmount > 0 ? ` — ${mode === "travel_fee" ? "travel" : "no-show"} fee of ₱${feeAmount} applied.` : " — no fee applied."}`,
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: "/admin/appointments/attention?issue=no_show",
      priority: "high",
      io: req.app.get("io"),
    }).catch(() => {});

    await audit.logEvent({
      actor: req.user?._id,
      target: booking._id,
      action: "booking.no_show.confirmed",
      module: "bookings",
      req,
      details: { bookingId: booking._id, feeType: mode, feeAmount, allowCustomerReschedule },
    }).catch(() => {});

    return res.json({
      success: true,
      status: nextStatus,
      feeType: mode,
      feeAmount,
      message: allowCustomerReschedule
        ? "No-show confirmed. The customer has been invited to select a new available schedule."
        : (feeAmount > 0 ? `No-show confirmed. ${mode === "travel_fee" ? "Travel" : "No-show"} fee of ₱${feeAmount} applied.` : "No-show confirmed. No fee applied."),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/no-show-review/:id/reschedule
 * Admin reschedules the no-show booking to a future visit, expires the old
 * assignment, and sends the booking to technician assignment.
 */
router.post("/no-show-review/:id/reschedule", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const audit = require("../utils/audit");
    const { createNotification } = require("../utils/notify");
    const { sendRescheduleApprovedEmail } = require("../utils/mailer");
    const scheduleRoutes = require("./scheduleRoutes");

    const { id } = req.params;
    const { newDate, newTime } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid booking ID" });
    }
    if (!newDate || !newTime) {
      return res.status(400).json({ error: "newDate and newTime are required." });
    }

    const noShowDate = new Date(newDate);
    const noShowTimeMatch = String(newTime).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (Number.isNaN(noShowDate.getTime()) || !noShowTimeMatch) {
      return res.status(400).json({ error: "A valid new date and time are required." });
    }
    let noShowHour = Number(noShowTimeMatch[1]);
    const noShowMinute = Number(noShowTimeMatch[2]);
    if (noShowTimeMatch[3]) {
      const ap = noShowTimeMatch[3].toUpperCase();
      if (ap === "PM" && noShowHour < 12) noShowHour += 12;
      if (ap === "AM" && noShowHour === 12) noShowHour = 0;
    }
    const noShowScheduledAt = new Date(noShowDate);
    noShowScheduledAt.setHours(noShowHour, noShowMinute, 0, 0);
    if (noShowScheduledAt <= new Date()) {
      return res.status(400).json({ error: "The new visit must be scheduled in the future." });
    }

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    const isLegacyPendingNoShow = booking.status === "no-show"
      && !["confirmed", "rescheduled", "cancelled"].includes(booking.noShowReport?.reviewStatus);
    const isAwaitingCustomerSchedule = booking.status === "reschedule-required"
      && (booking.rescheduleAccessStatus === "allowed" || booking.noShowRescheduleStatus === "pending");
    if (booking.status !== "no-show-reported" && !isLegacyPendingNoShow && !isAwaitingCustomerSchedule) {
      return res.status(409).json({ error: "This booking is not available for no-show rescheduling." });
    }

    const toMinutes = (value) => {
      const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
      if (!match) return null;
      let hour = Number(match[1]);
      const minute = Number(match[2]);
      if (minute > 59 || hour > (match[3] ? 12 : 23)) return null;
      if (match[3]) {
        const period = match[3].toUpperCase();
        if (period === "PM" && hour < 12) hour += 12;
        if (period === "AM" && hour === 12) hour = 0;
      }
      return hour * 60 + minute;
    };
    const serviceId = booking.serviceId || booking.service?._id;
    const slotResult = await scheduleRoutes.getTimeSlotsForQuery({
      date: String(newDate),
      serviceId: serviceId ? String(serviceId) : undefined,
      duration: String(Math.max(1, Number(booking.serviceDurationMinutes) || 60)),
      quantity: String(Number(booking.serviceDurationMinutes) > 0 ? 1 : Math.max(1, Number(booking.quantity) || 1)),
    });
    if (slotResult.statusCode >= 500) {
      return res.status(503).json({ error: "Availability could not be checked. Please try again." });
    }
    const selectedMinutes = toMinutes(newTime);
    const availableSlot = Array.isArray(slotResult.payload?.timeSlots)
      ? slotResult.payload.timeSlots.find((slot) => slot.available !== false && toMinutes(slot.startTime) === selectedMinutes)
      : null;
    if (selectedMinutes === null || !availableSlot) {
      return res.status(409).json({
        error: "That time slot is no longer available. Please choose another available time.",
        code: "SLOT_UNAVAILABLE",
        refreshSlots: true,
      });
    }

    const now = new Date();
    const prevStatus = booking.status;
    const previousDate = booking.bookingDate;
    const previousTime = booking.startTime;
    const canonicalTime = availableSlot.startTime;
    const capacityEndMinutes = selectedMinutes + Math.max(
      Number(booking.serviceDurationMinutes) || 60,
      Number(slotResult.payload?.capacityPerSlot) || Number(booking.serviceDurationMinutes) || 60,
    );
    const previousTechnicianId = booking.technicianId;
    await Assignment.updateMany(
      { bookingId: booking._id, status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "waiting_for_customer", "no_show_reported", "no_show", "in_progress"] } },
      { $set: { status: "expired", expiredAt: now, expiredReason: "New visit scheduled after no-show review" } },
    );
    await BookingService.findByIdAndUpdate(booking._id, {
      $set: {
        status: "awaiting_assignment",
        bookingDate: new Date(newDate),
        startTime: canonicalTime,
        selectedTimeLabel: canonicalTime,
        endTime: String(capacityEndMinutes),
        assignmentId: null,
        technicianId: null,
        technician: null,
        rescheduleReason: "Rescheduled by admin after no-show report.",
        noShowRescheduleStatus: "rescheduled",
        rescheduleAccessStatus: "submitted",
        rescheduleSource: "admin_on_behalf_of_customer",
        rescheduleReasonType: "no_show",
        "noShowReport.reviewStatus": "rescheduled",
        "noShowReport.decisionAt": now,
        "noShowReport.decisionBy": req.user._id,
        "noShowReport.decisionByName": req.user.name || "Admin",
      },
      $unset: {
        noShowRescheduleToken: 1,
        noShowRescheduleExpiry: 1,
        rescheduleAccessToken: 1,
        rescheduleAccessExpiry: 1,
      },
      $push: {
        statusHistory: {
          fromStatus: prevStatus,
          toStatus: "awaiting_assignment",
          reason: `Admin selected a new visit on the customer's behalf: ${new Date(newDate).toLocaleDateString()} ${canonicalTime}.`,
          timestamp: now,
          changedByName: req.user.name || "Admin",
          changedByModel: "User",
        },
        rescheduleHistory: {
          previousDate,
          previousTime,
          newDate: new Date(newDate),
          newTime: canonicalTime,
          reasonType: "no_show",
          source: "admin_on_behalf_of_customer",
          authorizedAt: now,
          authorizedBy: req.user._id,
          selectedAt: now,
        },
      },
    });
    if (previousTechnicianId) {
      const Technician = require("../models/Technician");
      const previousTechnician = await Technician.findById(previousTechnicianId).catch(() => null);
      if (previousTechnician) {
        await Technician.findByIdAndUpdate(previousTechnician._id, { $set: { availabilityStatus: "Available" } }).catch(() => {});
        previousTechnician.availabilityStatus = "Available";
        const { resolveAvailabilityStatus } = require("../utils/availability");
        await resolveAvailabilityStatus(previousTechnician, null, null, { syncDb: true }).catch(() => {});
      }
    }

    if (booking.customer && booking.customer.email) {
      await sendRescheduleApprovedEmail({
        to: booking.customer.email,
        customerName: booking.customer.name,
        bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
        serviceName: booking.service?.name || "Service",
        newDateLabel: new Date(newDate).toLocaleDateString(),
        newTimeLabel: canonicalTime,
      }).catch((e) => console.error("[MAILER] No-show reschedule email error:", e.message));
    }

    await createNotification({
      role: "admin",
      type: "booking_schedule_proposed",
      title: "No-Show New Visit Scheduled",
      message: `${booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`} has a new visit on ${new Date(newDate).toLocaleDateString()} ${canonicalTime} and is awaiting technician assignment.`,
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: "/admin/appointments/attention?issue=no_show",
      priority: "normal",
      io: req.app.get("io"),
    }).catch(() => {});

    await audit.logEvent({
      actor: req.user?._id,
      target: booking._id,
      action: "booking.no_show.rescheduled",
      module: "bookings",
      req,
      details: { bookingId: booking._id, newDate, newTime: canonicalTime, source: "admin_on_behalf_of_customer" },
    }).catch(() => {});

    return res.json({ success: true, message: "New visit scheduled. Assign a technician to continue." });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// NO-SHOW POLICY SETTINGS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/settings/no-show-policy
 * Returns the configured no-show waiting window and fee policy.
 */
router.get("/settings/no-show-policy", async (_req, res, next) => {
  try {
    const SiteSetting = require("../models/SiteSetting");
    const [waitDoc, policyDoc] = await Promise.all([
      SiteSetting.findOne({ key: "noShowWaitMinutes" }).lean(),
      SiteSetting.findOne({ key: "noShowPolicy" }).lean(),
    ]);
    const waitMinutes = Number(waitDoc?.value ?? 15);
    const policy = policyDoc?.value || { mode: "none", fixedFeeAmount: 0 };
    const normalizedMinutes = Number.isFinite(waitMinutes) && waitMinutes > 0 ? waitMinutes : 15;
    const normalizedMode = policy.mode === "travel_fee" || policy.mode === "fixed_fee" ? policy.mode : "none";
    const normalizedFee = Number(policy.fixedFeeAmount) || 0;
    res.json({
      noShowWaitMinutes: normalizedMinutes,
      noShowPolicy: { mode: normalizedMode, fixedFeeAmount: normalizedFee },
      // Retain the original flat response for older clients.
      waitMinutes: normalizedMinutes,
      mode: normalizedMode,
      fixedFeeAmount: normalizedFee,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/admin/settings/no-show-policy
 * Body: { waitMinutes: number, mode: 'none'|'travel_fee'|'fixed_fee', fixedFeeAmount: number }
 */
router.put("/settings/no-show-policy", async (req, res, next) => {
  try {
    const SiteSetting = require("../models/SiteSetting");
    const audit = require("../utils/audit");
    const supplied = req.body || {};
    const nestedPolicy = supplied.noShowPolicy && typeof supplied.noShowPolicy === "object"
      ? supplied.noShowPolicy
      : {};
    const waitMinutes = supplied.noShowWaitMinutes ?? supplied.waitMinutes;
    const mode = nestedPolicy.mode ?? supplied.mode;
    const fixedFeeAmount = nestedPolicy.fixedFeeAmount ?? supplied.fixedFeeAmount;

    const mins = Number(waitMinutes);
    if (!Number.isFinite(mins) || mins < 1) {
      return res.status(400).json({ error: "waitMinutes must be a positive number." });
    }
    const validModes = ["none", "travel_fee", "fixed_fee"];
    const finalMode = validModes.includes(mode) ? mode : "none";

    await SiteSetting.findOneAndUpdate(
      { key: "noShowWaitMinutes" },
      { value: Math.round(mins) },
      { upsert: true, setDefaultsOnInsert: true }
    );
    await SiteSetting.findOneAndUpdate(
      { key: "noShowPolicy" },
      { value: { mode: finalMode, fixedFeeAmount: Math.max(0, Number(fixedFeeAmount) || 0) } },
      { upsert: true, setDefaultsOnInsert: true }
    );

    await audit.logEvent({
      actor: req.user?._id,
      target: req.user?._id,
      action: "settings.no_show_policy.update",
      module: "settings",
      req,
      details: { waitMinutes: Math.round(mins), mode: finalMode, fixedFeeAmount: Math.max(0, Number(fixedFeeAmount) || 0) },
    }).catch(() => {});

    res.json({
      message: "No-show policy updated.",
      noShowWaitMinutes: Math.round(mins),
      noShowPolicy: { mode: finalMode, fixedFeeAmount: Math.max(0, Number(fixedFeeAmount) || 0) },
    });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DAILY KIT — Admin Preparation Issue Resolution
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/daily-kit/pending-issues
 * Returns all unresolved preparation issues across all technicians for today.
 */
router.get("/daily-kit/pending-issues", async (req, res, next) => {
  try {
    const DailyKit = require("../models/DailyKit");
    const Technician = require("../models/Technician");
    const BookingService = require("../models/BookingService");

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDay = new Date(today);
    nextDay.setDate(nextDay.getDate() + 1);

    const kits = await DailyKit.find({
      workDate: { $gte: today, $lt: nextDay },
      "items.checkoutStatus": "unavailable",
      "items.resolution.status": "admin_notified",
    }).populate("technicianId", "name");

    const issues = [];
    for (const kit of kits) {
      const tech = kit.technicianId;
      for (const item of kit.items) {
        if (item.checkoutStatus === "unavailable" && item.resolution?.status === "admin_notified") {
          // Find which bookings need this item
          const bookings = await BookingService.find({ _id: { $in: item.bookingIds } })
            .select("bookingReference serviceName serviceType startTime address")
            .lean();
          issues.push({
            kitId: kit._id,
            technicianId: tech?._id,
            technicianName: tech?.name || "Unknown",
            itemName: item.name,
            category: item.category,
            quantity: item.quantity,
            bookings: bookings.map(b => ({
              id: b._id,
              reference: b.bookingReference,
              service: b.serviceName,
              type: b.serviceType,
              time: b.startTime,
              address: b.address,
            })),
            reportedAt: item.resolution.resolvedAt,
          });
        }
      }
    }

    return res.json({ issues });
  } catch (err) {
    console.error("Get pending prep issues error:", err);
    next(err);
  }
});

/**
 * GET /api/admin/daily-kit/available-equipment
 * Search for available equipment that could substitute a missing item.
 * Query: ?q=<search term>
 */
router.get("/daily-kit/available-equipment", async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const q = req.query.q || "";
    if (!q.trim()) return res.json({ items: [] });

    const items = await Tool.find({
      type: "equipment",
      quantity: { $gt: 0 },
      $or: [
        { itemName: { $regex: q, $options: "i" } },
        { category: { $regex: q, $options: "i" } },
      ],
    })
      .select("itemName category quantity assetStatus toolCode")
      .limit(20)
      .lean();

    return res.json({ items });
  } catch (err) {
    console.error("Search available equipment error:", err);
    next(err);
  }
});

/**
 * PATCH /api/admin/daily-kit/resolve-item
 * Admin resolves a preparation issue.
 * Body: { kitId, itemName, resolution, note, toolId? }
 * resolution: "assigned_from_stock" | "procured" | "not_required" | "rescheduled"
 */
router.patch("/daily-kit/resolve-item", async (req, res, next) => {
  try {
    const DailyKit = require("../models/DailyKit");
    const Technician = require("../models/Technician");

    const { kitId, itemName, resolution, note, toolId } = req.body;
    if (!kitId || !itemName || !resolution) {
      return res.status(400).json({ error: "kitId, itemName, and resolution required" });
    }

    const validResolutions = ["assigned_from_stock", "procured", "not_required", "rescheduled"];
    if (!validResolutions.includes(resolution)) {
      return res.status(400).json({ error: "Invalid resolution. Must be: " + validResolutions.join(", ") });
    }

    const kit = await DailyKit.findById(kitId);
    if (!kit) return res.status(404).json({ error: "Daily kit not found" });

    const item = kit.items.find(i => i.name === itemName && i.checkoutStatus === "unavailable");
    if (!item) return res.status(404).json({ error: "Unavailable item not found in kit" });

    // Update resolution
    item.resolution = {
      status: resolution,
      resolvedBy: req.user._id,
      resolvedAt: new Date(),
      resolutionNote: note || `Resolved by admin: ${resolution}`,
    };

    // If assigning from stock, link the tool and update checkout status
    if (resolution === "assigned_from_stock" && toolId) {
      item.toolId = toolId;
      item.checkoutStatus = "reserved";
      item.conflict = { isUnavailable: false, checkedOutTo: null, message: null };
    } else if (resolution === "procured" && toolId) {
      item.toolId = toolId;
      item.checkoutStatus = "reserved";
      item.conflict = { isUnavailable: false, checkedOutTo: null, message: null };
    } else if (resolution === "not_required") {
      item.checkoutStatus = "exception";
      item.exception = { approved: true, reason: note || "Admin marked as not required", approvedBy: req.user._id };
    }

    await kit.save();

    // Notify technician
    const tech = await Technician.findById(kit.technicianId);
    if (tech) {
      const { createNotification } = require("../utils/notify");
      const messageMap = {
        assigned_from_stock: `"${itemName}" has been assigned from stock for your kit.`,
        procured: `"${itemName}" has been added to inventory and assigned to your kit.`,
        not_required: `"${itemName}" has been marked as not required.`,
        rescheduled: `The job requiring "${itemName}" has been rescheduled.`,
      };
      await createNotification({
        userId: tech.user,
        role: "technician",
        type: "system",
        title: "Daily Kit Updated",
        message: messageMap[resolution],
        referenceId: kit._id,
        referenceModel: "BookingService",
        link: "/technician/assignments",
        priority: "normal",
        io: req.app.get("io"),
      }).catch(() => {});

      // Emit real-time kit update to technician
      const io = req.app.get("io");
      if (io) {
        io.to("tech:" + tech.user.toString()).emit("daily_kit:updated", {
          kitId: kit._id,
          itemName,
          resolution,
        });
      }
    }

    return res.json({ success: true, message: `Item "${itemName}" resolved as ${resolution}` });
  } catch (err) {
    console.error("Resolve prep issue error:", err);
    next(err);
  }
});

// Email delivery operations ----------------------------------------------------
const emailTestCooldown = new Map();

router.get("/settings/email-status", async (_req, res, next) => {
  try {
    const mailer = require("../utils/mailer");
    const EmailDeliveryLog = require("../models/EmailDeliveryLog");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [summary, latest] = await Promise.all([
      EmailDeliveryLog.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      EmailDeliveryLog.findOne().sort({ createdAt: -1 }).lean(),
    ]);
    const counts = Object.fromEntries(summary.map((row) => [row._id, row.count]));
    res.set("Cache-Control", "no-store");
    return res.json({
      configuration: mailer.buildMailerStatus(process.env),
      last24Hours: { accepted: counts.accepted || 0, failed: counts.failed || 0 },
      latestAttempt: latest ? {
        status: latest.status,
        provider: latest.provider,
        createdAt: latest.createdAt,
      } : null,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/settings/email-verify", async (req, res, next) => {
  try {
    const result = await require("../utils/mailer").verifyMailerConfiguration();
    await audit.logEvent({
      actor: req.user?._id,
      target: req.user?._id,
      action: "settings.email_connection.verified",
      module: "settings",
      req,
      details: { provider: result.provider },
    });
    return res.json({ message: `${result.provider === "brevo" ? "Brevo API" : "SMTP"} credentials and network connection verified.`, provider: result.provider });
  } catch (error) {
    return res.status(502).json({ error: String(error.message || "Email provider verification failed.").slice(0, 500) });
  }
});

router.post("/settings/email-test", async (req, res, next) => {
  try {
    const recipient = String(req.body?.recipient || "").trim().toLowerCase();
    if (recipient.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      return res.status(400).json({ error: "Enter a valid recipient email address." });
    }
    const actorKey = String(req.user?._id || req.ip || "admin");
    const lastSent = emailTestCooldown.get(actorKey) || 0;
    const cooldownMs = 15_000;
    if (Date.now() - lastSent < cooldownMs) {
      return res.status(429).json({ error: "Wait 15 seconds before sending another test email." });
    }
    emailTestCooldown.set(actorKey, Date.now());

    const mailer = require("../utils/mailer");
    const result = await mailer.sendMail({
      to: recipient,
      subject: "CALIDRO RACS email delivery test",
      text: `This test was requested from the administrator email operations page at ${new Date().toISOString()}. If you received it, the selected provider can deliver messages to this address.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;"><h2 style="color:#0369a1;">Email delivery test</h2><p>This test was requested from the CALIDRO RACS administrator email operations page.</p><p><strong>Requested at:</strong> ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}</p><p style="color:#64748b;">Provider acceptance confirms the API/SMTP handoff. Inbox delivery can still be affected by sender verification, spam filtering, or recipient rules.</p></div>`,
      source: "admin_test",
    });
    if (!result) throw new Error("No email transport accepted the test message.");
    await audit.logEvent({
      actor: req.user?._id,
      target: req.user?._id,
      action: "settings.email_test.accepted",
      module: "settings",
      req,
      details: { provider: result.provider || "unknown", recipient },
    });
    return res.json({
      message: "The provider accepted the test email. Check the recipient inbox and spam folder.",
      provider: result.provider || null,
      messageId: result.messageId || null,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/settings/email-logs", async (req, res, next) => {
  try {
    const EmailDeliveryLog = require("../models/EmailDeliveryLog");
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const filter = ["accepted", "failed"].includes(req.query.status) ? { status: req.query.status } : {};
    const records = await EmailDeliveryLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.set("Cache-Control", "no-store");
    return res.json({
      records: records.map((record) => ({
        id: record._id,
        provider: record.provider,
        recipient: record.recipient,
        subject: record.subject,
        status: record.status,
        messageId: record.messageId,
        error: record.error,
        source: record.source,
        createdAt: record.createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// System settings control plane ------------------------------------------------
router.get("/settings/system-configuration", async (_req, res, next) => {
  try {
    const { getSystemConfiguration } = require("../utils/systemConfiguration");
    const configuration = await getSystemConfiguration();
    return res.json({
      configuration,
      enforcedSecurity: {
        strongPasswords: true,
        adminEmailOtp: true,
        secretaryEmailOtp: true,
        progressiveLoginThrottle: true,
        auditTrail: true,
        trustedOriginProtection: true,
      },
      capabilities: {
        inAppRealtimeNotifications: true,
        criticalEmailAlerts: true,
        smsAlerts: false,
        browserPush: false,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.put("/settings/system-configuration", async (req, res, next) => {
  try {
    const {
      getSystemConfiguration,
      saveSystemConfiguration,
      normalizeSystemConfiguration,
    } = require("../utils/systemConfiguration");
    const current = await getSystemConfiguration({ bypassCache: true });
    const suppliedApplication = req.body?.application && typeof req.body.application === "object"
      ? req.body.application
      : {};
    const suppliedNotifications = req.body?.notifications && typeof req.body.notifications === "object"
      ? req.body.notifications
      : {};
    const proposed = normalizeSystemConfiguration({
      ...current,
      application: { ...current.application, ...suppliedApplication },
      notifications: { ...current.notifications, ...suppliedNotifications },
    });
    if (proposed.notifications.criticalEmailAlerts && !proposed.notifications.adminAlertEmail) {
      return res.status(400).json({ error: "Enter a valid admin alert email before enabling email alerts." });
    }

    const configuration = await saveSystemConfiguration(proposed);
    await audit.logEvent({
      actor: req.user?._id,
      target: req.user?._id,
      action: "settings.system_configuration.update",
      module: "settings",
      req,
      details: {
        application: configuration.application,
        notifications: configuration.notifications,
      },
    });
    return res.json({ message: "System configuration saved.", configuration });
  } catch (error) {
    next(error);
  }
});

router.post("/settings/system-configuration/test-alert", async (req, res, next) => {
  try {
    const { getSystemConfiguration } = require("../utils/systemConfiguration");
    const configuration = await getSystemConfiguration({ bypassCache: true });
    if (!configuration.notifications.criticalEmailAlerts || !configuration.notifications.adminAlertEmail) {
      return res.status(400).json({ error: "Enable critical email alerts and save a destination first." });
    }
    const { createNotification } = require("../utils/notify");
    const notification = await createNotification({
      type: "system",
      title: "System alert delivery test",
      message: "Your CALIDRO RACS critical admin alert channel is working.",
      role: "admin",
      priority: configuration.notifications.minimumPriority,
      link: "/admin/settings/system",
      io: req.app.get("io"),
    });
    if (!notification) return res.status(503).json({ error: "The test notification could not be created." });
    await audit.logEvent({
      actor: req.user?._id,
      target: req.user?._id,
      action: "settings.notification_test.sent",
      module: "settings",
      req,
      details: { priority: configuration.notifications.minimumPriority },
    });
    return res.json({ message: "Test alert created and submitted to the configured email channel." });
  } catch (error) {
    next(error);
  }
});

router.put("/settings/maintenance-mode", async (req, res, next) => {
  try {
    const { getSystemConfiguration, saveSystemConfiguration } = require("../utils/systemConfiguration");
    const current = await getSystemConfiguration({ bypassCache: true });
    const enabled = req.body?.enabled === true;
    const message = String(req.body?.message || current.maintenance.message || "").trim().slice(0, 300);
    if (enabled && message.length < 10) {
      return res.status(400).json({ error: "Enter a customer-facing maintenance message of at least 10 characters." });
    }
    const configuration = await saveSystemConfiguration({
      ...current,
      maintenance: {
        enabled,
        message,
        enabledAt: enabled ? new Date().toISOString() : null,
        enabledBy: enabled ? String(req.user?._id || "") : null,
      },
    });
    await audit.logEvent({
      actor: req.user?._id,
      target: req.user?._id,
      action: enabled ? "settings.maintenance.enabled" : "settings.maintenance.disabled",
      module: "settings",
      req,
      riskLevel: enabled ? "high" : "medium",
      details: { enabled, message },
    });
    return res.json({
      message: enabled ? "Maintenance mode enabled for non-admin users." : "Maintenance mode disabled.",
      maintenance: configuration.maintenance,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/settings/system-health", async (_req, res, next) => {
  try {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const packageJson = require("../../package.json");
    const startedAt = new Date(Date.now() - process.uptime() * 1000);
    const pingStarted = Date.now();
    let databaseStatus = "offline";
    let databaseLatencyMs = null;
    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      await mongoose.connection.db.admin().ping();
      databaseStatus = "online";
      databaseLatencyMs = Date.now() - pingStarted;
    }
    const logSize = (name) => {
      try { return fs.statSync(path.join(__dirname, "..", "logs", name)).size; } catch { return 0; }
    };
    const memory = process.memoryUsage();
    res.set("Cache-Control", "no-store");
    return res.json({
      checkedAt: new Date().toISOString(),
      database: { status: databaseStatus, latencyMs: databaseLatencyMs },
      server: {
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: startedAt.toISOString(),
        loadAverage1m: Number(os.loadavg()[0].toFixed(2)),
        memoryRssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
      },
      logs: { combinedBytes: logSize("combined.log"), errorBytes: logSize("error.log") },
      platform: {
        applicationVersion: packageJson.version,
        nodeVersion: process.version,
        mongooseVersion: mongoose.version,
        environment: process.env.NODE_ENV || "development",
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/settings/system-logs", async (_req, res, next) => {
  try {
    const fs = require("fs");
    const path = require("path");
    const logPath = path.join(__dirname, "..", "logs", "combined.log");
    const stats = await fs.promises.stat(logPath);
    const maxBytes = 5 * 1024 * 1024;
    const start = Math.max(0, stats.size - maxBytes);
    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="calidro-racs-${new Date().toISOString().slice(0, 10)}.log"`,
      "Cache-Control": "no-store",
      ...(start > 0 ? { "X-Log-Truncated": "true" } : {}),
    });
    return fs.createReadStream(logPath, { start }).pipe(res);
  } catch (error) {
    if (error && error.code === "ENOENT") return res.status(404).json({ error: "No application log is available yet." });
    next(error);
  }
});

router.post("/settings/runtime-cache/clear", async (req, res, next) => {
  try {
    require("../utils/systemConfiguration").invalidateSystemConfiguration();
    require("../utils/bookingPolicy").invalidateCache();
    require("../utils/publicBusinessStats").invalidatePublicBusinessStats();
    await audit.logEvent({
      actor: req.user?._id,
      target: req.user?._id,
      action: "settings.runtime_cache.cleared",
      module: "settings",
      req,
    });
    return res.json({ message: "Runtime configuration and reporting caches cleared." });
  } catch (error) {
    next(error);
  }
});

module.exports = router;


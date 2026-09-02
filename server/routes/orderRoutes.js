const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const { authenticate, requireRole } = require("../middleware/authenticate");
const Order = require("../models/Order");
const Inventory = require("../models/Inventory");
const Technician = require("../models/Technician");
const TechnicianSchedule = require("../models/TechnicianSchedule");
const BookingService = require("../models/BookingService");
const Payment = require("../models/Payment");
const User = require("../models/User");
const {
  recordOrderConsumableUsage,
  syncDailyKit,
} = require("../utils/dailyKitService");
const { orderDepartureReadiness } = require("../utils/orderPreparation");
const { getDownpaymentPercentage, calculatePaymentBreakdown } = require("../utils/paymentPolicy");
const { hasValidStoredImageSignature, imageExtensionFor, isAllowedImage } = require("../utils/uploadSecurity");
const { buildOrderWarrantySnapshot } = require("../utils/orderWarrantyPolicy");
const { getAftercarePolicy, warrantyRuleForOrder } = require("../utils/aftercarePolicy");
const { getOrderCheckoutSettings } = require("../utils/orderCheckoutSettings");
const { buildOrderAssignmentPlan } = require("../utils/orderAssignmentPlanner");
const { orderFulfillmentScopeFilter } = require("../utils/orderFulfillmentScope");
const {
  REVIEWABLE_ORDER_STATUSES,
  orderAttentionState,
  requestedOrderCutoff,
  withOrderAttentionState,
} = require("../utils/orderAttention");
const {
  OrderCheckoutError,
  authoritativeDeliveryQuote,
  initialOrderLifecycle,
  parseDateOnly,
  validateCheckoutItems,
  validateCheckoutSelection,
  validatePickupDate,
} = require("../utils/orderCheckoutPolicy");

// â”€â”€ Multer config for GCash receipt uploads â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const gcashUploadDir = path.join(__dirname, "../public/uploads/gcash-receipts");
if (!fs.existsSync(gcashUploadDir)) {
  fs.mkdirSync(gcashUploadDir, { recursive: true });
}
const gcashStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, gcashUploadDir),
  filename: (req, file, cb) => {
    cb(null, `${crypto.randomUUID()}${imageExtensionFor(file)}`);
  },
});
const gcashUpload = multer({
  storage: gcashStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (isAllowedImage(file)) cb(null, true);
    else cb(new Error("Only image files are accepted"));
  },
});

function receiveGcashProof(req, res, next) {
  gcashUpload.single("gcashProof")(req, res, (error) => {
    if (!error) return next();
    const isTooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    return res.status(400).json({
      error: isTooLarge
        ? "Receipt image must be 5 MB or smaller."
        : "Receipt must be a valid JPG, PNG, or WEBP image.",
      code: "ORDER_PAYMENT_PROOF_INVALID",
    });
  });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Find an available technician for a given date.
 * Checks working days, rest dates, and existing assignment counts.
 * Returns { technician, nextDate } â€” technician is null when none available.
 */
async function findAvailableTechnician(preferredDate) {
  const date = new Date(preferredDate);
  const dayOfWeek = date.getDay(); // 0=Sun

  // 1. Get all active technicians
  const technicians = await Technician.find({ active: true }).lean();
  if (!technicians.length) return { technician: null, nextDate: null };

  // 2. Get schedules for all technicians
  const schedules = await TechnicianSchedule.find({
    technicianId: { $in: technicians.map((t) => t._id) },
  }).lean();

  const scheduleMap = {};
  schedules.forEach((s) => {
    scheduleMap[s.technicianId.toString()] = s;
  });

  // 3. Filter technicians available on this day
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const availableTechs = technicians.filter((tech) => {
    const sched = scheduleMap[tech._id.toString()];
    if (!sched) return true; // no schedule restrictions = available

    // check non-working weekdays
    if (sched.nonWorkingWeekdays && sched.nonWorkingWeekdays.length) {
      const isNonWorking = sched.nonWorkingWeekdays.some(
        (nw) => nw.dayOfWeek === dayOfWeek
      );
      if (isNonWorking) return false;
    }

    // check working days (if defined, must include this day)
    if (sched.workingDays && sched.workingDays.length) {
      const worksToday = sched.workingDays.some(
        (wd) => wd.dayOfWeek === dayOfWeek
      );
      if (!worksToday) return false;
    }

    // check rest dates
    if (sched.restDates && sched.restDates.length) {
      const isRest = sched.restDates.some((rd) => {
        const rdDate = new Date(rd.date);
        rdDate.setHours(0, 0, 0, 0);
        return rdDate.getTime() === startOfDay.getTime();
      });
      if (isRest) return false;
    }

    return true;
  });

  if (!availableTechs.length) {
    // Try to find next available date (up to 14 days ahead)
    for (let i = 1; i <= 14; i++) {
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + i);
      const result = await findAvailableTechnician(nextDate);
      if (result.technician) {
        return { technician: null, nextDate: nextDate.toISOString().slice(0, 10) };
      }
    }
    return { technician: null, nextDate: null };
  }

  // 4. Count existing assignments for each technician on this date
  const techIds = availableTechs.map((t) => t._id);

  const [bookingCounts, orderCounts] = await Promise.all([
    BookingService.aggregate([
      {
        $match: {
          technicianId: { $in: techIds },
          bookingDate: { $gte: startOfDay, $lte: endOfDay },
          status: { $nin: ["cancelled"] },
        },
      },
      { $group: { _id: "$technicianId", count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      {
        $match: {
          technicianId: { $in: techIds },
          "delivery.preferredDate": { $gte: startOfDay, $lte: endOfDay },
          status: { $nin: ["cancelled", "completed"] },
        },
      },
      { $group: { _id: "$technicianId", count: { $sum: 1 } } },
    ]),
  ]);

  const countMap = {};
  bookingCounts.forEach((c) => {
    countMap[c._id.toString()] = (countMap[c._id.toString()] || 0) + c.count;
  });
  orderCounts.forEach((c) => {
    countMap[c._id.toString()] = (countMap[c._id.toString()] || 0) + c.count;
  });

  // 5. Pick technician with fewest assignments (max 6 per day)
  const MAX_DAILY = 6;
  let best = null;
  let bestCount = Infinity;

  for (const tech of availableTechs) {
    const cnt = countMap[tech._id.toString()] || 0;
    if (cnt < MAX_DAILY && cnt < bestCount) {
      bestCount = cnt;
      best = tech;
    }
  }

  if (!best) {
    // all technicians maxed out
    for (let i = 1; i <= 14; i++) {
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + i);
      const result = await findAvailableTechnician(nextDate);
      if (result.technician) {
        return { technician: null, nextDate: nextDate.toISOString().slice(0, 10) };
      }
    }
    return { technician: null, nextDate: null };
  }

  return { technician: best, nextDate: null };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Routes
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * GET /api/orders/all â€” List all orders (admin/secretary only)
 * Query params: status, fulfillmentType, fulfillmentGroup, preparation, technicianId,
 * scheduledFrom, scheduledTo, search, from, to, page, limit
 */
router.get("/all", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const {
      status, fulfillmentType, fulfillmentGroup, preparation, technicianId,
      scheduledFrom, scheduledTo, search, from, to, attention,
      page = 1, limit = 50,
    } = req.query;
    const scopeFilter = orderFulfillmentScopeFilter(fulfillmentGroup, fulfillmentType);
    const filter = { ...scopeFilter };

    if (status && status !== "all") filter.status = status;
    if (technicianId && require("mongoose").isValidObjectId(technicianId)) filter.technicianId = technicianId;
    if (preparation === "dispatch_pending") filter["preparation.dispatch.status"] = { $ne: "ready" };
    if (preparation === "dispatch_ready") filter["preparation.dispatch.status"] = "ready";
    if (preparation === "kit_pending") filter["preparation.installation.status"] = "pending";
    if (preparation === "kit_blocked") filter["preparation.installation.status"] = "blocked";
    if (preparation === "kit_confirmed") filter["preparation.installation.status"] = "confirmed";
    if (preparation === "ready") {
      filter.$and = [
        { "preparation.dispatch.status": "ready" },
        { $or: [
          { fulfillmentType: "delivery_only" },
          { fulfillmentType: "delivery_installation", "preparation.installation.status": "confirmed" },
        ] },
      ];
    }

    if (scheduledFrom || scheduledTo) {
      const scheduledRange = {};
      if (scheduledFrom) scheduledRange.$gte = new Date(`${scheduledFrom}T00:00:00`);
      if (scheduledTo) scheduledRange.$lte = new Date(`${scheduledTo}T23:59:59.999`);
      filter.$and = [
        ...(filter.$and || []),
        { $or: [
          { "delivery.preferredDate": scheduledRange },
          { pickupDate: scheduledRange },
        ] },
      ];
    }

    if (search) {
      const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { orderReference: regex },
        { "customer.name": regex },
        { "customer.email": regex },
        { "items.modelLine": regex },
      ];
    }

    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = toDate;
      }
    }

    const parsedPage = Number.parseInt(page, 10);
    const parsedLimit = Number.parseInt(limit, 10);
    const pageNumber = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
    const pageLimit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 50;
    const skip = (pageNumber - 1) * pageLimit;
    let orders;
    let total;

    if (attention === "past_date") {
      const attentionRows = await Order.find({
        ...filter,
        status: { $in: [...REVIEWABLE_ORDER_STATUSES] },
      }).sort({ createdAt: -1 }).populate("technicianId", "name phone").lean();
      const overdueRows = attentionRows.map((order) => withOrderAttentionState(order)).filter((order) => order.isPastDate);
      total = overdueRows.length;
      orders = overdueRows.slice(skip, skip + pageLimit);
    } else {
      const result = await Promise.all([
        Order.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(pageLimit)
          .populate("technicianId", "name phone")
          .lean(),
        Order.countDocuments(filter),
      ]);
      orders = result[0].map((order) => withOrderAttentionState(order));
      total = result[1];
    }

    // Also return summary counts for KPI cards
    const [totalOrders, pending, inProgress, completed, cancelled, attentionCandidates, statusRows, fulfillmentRows] = await Promise.all([
      Order.countDocuments(scopeFilter),
      Order.countDocuments({ ...scopeFilter, status: "pending_payment" }),
      Order.countDocuments({ ...scopeFilter, status: { $in: ["preparing_unit", "ready_for_pickup", "technician_assigned", "technician_accepted", "out_for_delivery", "arrived", "installing"] } }),
      Order.countDocuments({ ...scopeFilter, status: "completed" }),
      Order.countDocuments({ ...scopeFilter, status: "cancelled" }),
      Order.find({ ...scopeFilter, status: { $in: [...REVIEWABLE_ORDER_STATUSES] } })
        .select("status fulfillmentType delivery.preferredDate pickupDate timeSlot")
        .lean(),
      Order.aggregate([{ $match: scopeFilter }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      Order.aggregate([{ $group: { _id: "$fulfillmentType", count: { $sum: 1 } } }]),
    ]);
    const pastDateAttention = attentionCandidates.filter((order) => orderAttentionState(order).isPastDate).length;
    const statusBreakdown = Object.fromEntries(statusRows.map((row) => [row._id, row.count]));
    const fulfillmentBreakdown = Object.fromEntries(fulfillmentRows.map((row) => [row._id || "unknown", row.count]));

    res.json({
      orders,
      total,
      page: pageNumber,
      pages: Math.ceil(total / pageLimit),
      kpi: { totalOrders, pending, inProgress, completed, cancelled, pastDateAttention, statusBreakdown, fulfillmentBreakdown },
    });
  } catch (err) {
    console.error("GET /api/orders/all error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch orders" });
  }
});
const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many checkout attempts. Wait a few minutes and try again.", code: "ORDER_CHECKOUT_RATE_LIMITED" },
});

/**
 * GET /api/orders/badge — Lightweight admin navigation badge.
 * Active field work is excluded; the number represents orders waiting for an
 * administrator to verify, prepare, release, or reassign.
 */
router.get("/badge", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const actionable = await Order.countDocuments({
      status: { $in: ["pending_payment", "preparing_unit", "ready_for_pickup", "technician_declined"] },
    });
    res.set("Cache-Control", "no-store");
    return res.json({ actionable });
  } catch (err) {
    return res.status(500).json({ error: "Unable to load the order queue count" });
  }
});

/**
 * POST /api/orders/delivery-quote — Authoritative delivery distance and fee.
 * The browser may display this quote, but order creation recomputes it so a
 * modified request cannot lower the payable amount.
 */
router.post("/delivery-quote", authenticate, requireRole("customer"), async (req, res) => {
  try {
    const settings = await getOrderCheckoutSettings();
    const quote = await authoritativeDeliveryQuote({
      origin: settings.companyLocation,
      destination: req.body,
      farePerKm: settings.farePerKm,
    });
    return res.json({ success: true, quote });
  } catch (error) {
    return checkoutErrorResponse(res, error);
  }
});

/**
 * POST /api/orders â€” Create a new aircon order
 */
router.post("/", authenticate, requireRole("customer"), checkoutLimiter, receiveGcashProof, async (req, res) => {
  let checkoutRequestId = "";
  try {
    // When submitted as FormData some fields arrive as JSON strings â€“ parse them
    let body = req.body;
    if (typeof body.items === "string") {
      try { body.items = JSON.parse(body.items); } catch (e) {}
    }
    if (typeof body.delivery === "string") {
      try { body.delivery = JSON.parse(body.delivery); } catch (e) {}
    }

    const { items, fulfillmentType, delivery, pickupDate, paymentMethod, timeSlot, gcashNumber } = body;
    checkoutRequestId = String(body.checkoutRequestId || "").trim();
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(checkoutRequestId)) {
      throw new OrderCheckoutError("This checkout session is invalid or expired. Reopen checkout and try again.", 400, "ORDER_CHECKOUT_REQUEST_ID_INVALID");
    }

    const existingOrder = await Order.findOne({ userId: req.user._id, checkoutRequestId });
    if (existingOrder) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      return res.status(200).json({ success: true, duplicate: true, order: existingOrder.toObject() });
    }

    if (req.file && !(await hasValidStoredImageSignature(req.file))) {
      throw new OrderCheckoutError("The uploaded receipt is not a valid JPG, PNG, or WEBP image.", 400, "ORDER_PAYMENT_PROOF_INVALID");
    }
    if ((paymentMethod === "cod" || paymentMethod === "gcash_full") && !req.file) {
      throw new OrderCheckoutError("A GCash receipt screenshot is required for this payment method.", 400, "ORDER_PAYMENT_PROOF_REQUIRED");
    }
    const requestedItems = validateCheckoutItems(items);

    const [settings, downpaymentPercentage] = await Promise.all([
      getOrderCheckoutSettings(),
      getDownpaymentPercentage(),
    ]);
    const selection = validateCheckoutSelection({
      fulfillmentType,
      paymentMethod,
      delivery,
      pickupDate,
      timeSlot,
    }, { storeHours: settings.storeHours });

    const HVACProduct = require("../models/HVACProduct");
    const enrichedItems = [];
    for (const requestedItem of requestedItems) {
      const inventoryId = requestedItem.inventoryId;
      const quantity = requestedItem.quantity;

      let inventory = await Inventory.findById(inventoryId).populate("brand", "name").lean();
      if (!inventory) {
        const product = await HVACProduct.findOne({ "variants._id": inventoryId }).populate("brand", "name").lean();
        const variant = product?.variants?.find(row => String(row._id) === inventoryId);
        if (product && variant) {
          inventory = {
            _id: variant._id,
            modelLine: product.modelLine,
            brand: product.brand,
            capacity: variant.capacity,
            capacityUnit: variant.capacityUnit,
            sellingPrice: variant.sellingPrice,
            quantity: variant.quantity,
            status: variant.status,
            active: variant.active,
            imageUrl: product.imageUrl,
            warranty: product.specifications?.warranty || "",
            isHvac: true,
            parentHvacId: product._id,
          };
        }
      }
      if (!inventory) {
        throw new OrderCheckoutError(`Product not found: ${inventoryId}`, 404, "ORDER_PRODUCT_NOT_FOUND");
      }
      const unavailable = inventory.active === false
        || ["out_of_stock", "discontinued", "coming_soon"].includes(inventory.status)
        || Number(inventory.quantity || 0) < quantity;
      if (unavailable) {
        throw new OrderCheckoutError(
          `Insufficient stock for ${inventory.modelLine || "the selected product"} ${inventory.capacity || ""} ${inventory.capacityUnit || "HP"}.`,
          409,
          "ORDER_STOCK_UNAVAILABLE",
        );
      }
      const unitPrice = Math.max(0, Number(inventory.sellingPrice) || 0);
      enrichedItems.push({
        inventoryId: inventory._id,
        modelLine: inventory.modelLine,
        brand: inventory.brand ? (inventory.brand.name || inventory.brand) : "",
        capacity: inventory.capacity,
        capacityUnit: inventory.capacityUnit || "HP",
        quantity,
        unitPrice,
        totalPrice: unitPrice * quantity,
        imageUrl: inventory.imageUrl || "/images/products/default.png",
        isHvac: Boolean(inventory.isHvac),
        parentHvacId: inventory.parentHvacId || null,
        manufacturerWarranty: inventory.warranty || "",
      });
    }

    const totalUnits = enrichedItems.reduce((sum, item) => sum + item.quantity, 0);
    let deliveryQuote = { distanceKm: 0, durationMin: 0, transportationFee: 0 };
    if (selection.delivery) {
      deliveryQuote = await authoritativeDeliveryQuote({
        origin: settings.companyLocation,
        destination: selection.delivery.coordinates,
        farePerKm: settings.farePerKm,
      });
      if (selection.fulfillmentType === "delivery_installation") {
        const schedulingEngine = require("../utils/enterpriseSchedulingEngine");
        if (await schedulingEngine.isLargeProject({
          totalUnits,
          totalEstimatedMinutes: totalUnits * 60,
        })) {
          throw new OrderCheckoutError(
            "This installation quantity requires large-scale project scheduling. Please contact Operations.",
            409,
            "ORDER_PROJECT_SCHEDULING_REQUIRED",
          );
        }
      }

      const scheduleRoutes = require("./scheduleRoutes");
      const slotCheck = await scheduleRoutes.getTimeSlotsForQuery({
        date: String(delivery.preferredDate).slice(0, 10),
        duration: "60",
        quantity: selection.fulfillmentType === "delivery_installation" ? String(totalUnits) : "1",
        travelTime: String(deliveryQuote.durationMin),
      });
      const requestedSlot = selection.timeSlot.toLowerCase();
      const available = slotCheck.statusCode < 400
        && Array.isArray(slotCheck.payload?.timeSlots)
        && slotCheck.payload.timeSlots.some(slot => String(slot.startTime || "").trim().toLowerCase() === requestedSlot);
      if (!available) {
        throw new OrderCheckoutError(
          slotCheck.payload?.message || "This delivery time is no longer available. Choose another schedule.",
          409,
          "ORDER_SLOT_UNAVAILABLE",
        );
      }
    }

    const lifecycle = initialOrderLifecycle(selection.fulfillmentType, selection.paymentMethod);
    const orderData = {
      userId: req.user._id,
      checkoutRequestId,
      items: enrichedItems,
      fulfillmentType: selection.fulfillmentType,
      paymentMethod: selection.paymentMethod,
      paymentStatus: lifecycle.paymentStatus,
      status: lifecycle.status,
      timeSlot: selection.timeSlot,
      transportationFee: deliveryQuote.transportationFee,
      routeDistanceKm: deliveryQuote.distanceKm,
      routeDurationMin: deliveryQuote.durationMin,
      deliveryFee: 0,
      installationFee: selection.fulfillmentType === "delivery_installation" ? settings.installationFee : 0,
      preparation: {
        dispatch: { status: selection.fulfillmentType === "customer_pickup" ? "not_required" : "pending" },
        installation: { status: selection.fulfillmentType === "delivery_installation" ? "pending" : "not_required" },
      },
      ...(selection.delivery ? {
        delivery: {
          address: selection.delivery.address,
          contactNumber: selection.delivery.contactNumber,
          preferredDate: selection.delivery.preferredDate,
          notes: selection.delivery.notes,
          coordinates: {
            type: "Point",
            coordinates: [selection.delivery.coordinates.lng, selection.delivery.coordinates.lat],
          },
        },
      } : { pickupDate: selection.pickupDate }),
    };
    if (gcashNumber) orderData.gcashNumber = String(gcashNumber).trim().slice(0, 100);
    if (req.file) orderData.gcashProofUrl = `/uploads/gcash-receipts/${req.file.filename}`;

    const calculatedOrderTotal = enrichedItems.reduce((sum, item) => sum + item.totalPrice, 0)
      + orderData.installationFee
      + orderData.transportationFee;
    if (selection.paymentMethod === "cod") {
      const breakdown = calculatePaymentBreakdown(calculatedOrderTotal, downpaymentPercentage);
      orderData.downpaymentPercentage = breakdown.downpaymentPercentage;
      orderData.downpaymentAmount = breakdown.downpaymentAmount;
      orderData.balanceAmount = breakdown.balanceAmount;
    } else if (selection.paymentMethod === "gcash_full") {
      orderData.downpaymentPercentage = 100;
      orderData.downpaymentAmount = calculatedOrderTotal;
      orderData.balanceAmount = 0;
    }

    const session = await mongoose.startSession();
    let order;
    try {
      session.startTransaction();
      for (const item of enrichedItems) {
        let reserved;
        if (item.isHvac) {
          reserved = await HVACProduct.findOneAndUpdate(
            {
              _id: item.parentHvacId,
              variants: { $elemMatch: { _id: item.inventoryId, quantity: { $gte: item.quantity }, active: { $ne: false }, status: { $nin: ["out_of_stock", "discontinued", "coming_soon"] } } },
            },
            { $inc: { "variants.$.quantity": -item.quantity } },
            { returnDocument: "after", session },
          );
        } else {
          reserved = await Inventory.findOneAndUpdate(
            { _id: item.inventoryId, quantity: { $gte: item.quantity }, active: { $ne: false }, status: { $nin: ["out_of_stock", "discontinued", "coming_soon"] } },
            { $inc: { quantity: -item.quantity } },
            { returnDocument: "after", session },
          );
        }
        if (!reserved) {
          throw new OrderCheckoutError(
            `${item.modelLine || "A selected product"} no longer has enough stock. Your order was not charged or created.`,
            409,
            "ORDER_STOCK_RACE_LOST",
          );
        }
      }

      order = new Order(orderData);
      await order.save({ session });
      if (req.file && ["cod", "gcash_full"].includes(selection.paymentMethod)) {
        const isDownpayment = selection.paymentMethod === "cod";
        const paymentRecord = new Payment({
          orderId: order._id,
          amount: isDownpayment ? order.downpaymentAmount : order.total,
          method: "gcash",
          type: isDownpayment ? "downpayment" : "final",
          gateway: "gcash",
          reference: orderData.gcashNumber || undefined,
          proofUrl: orderData.gcashProofUrl,
          status: "pending",
          notes: isDownpayment
            ? `${order.downpaymentPercentage}% order downpayment submitted for verification`
            : "Full order payment submitted for verification",
          events: [{
            status: "pending",
            actor: req.user._id,
            actorName: req.user.name || req.user.email || "Customer",
            actorRole: "customer",
            note: "Payment proof submitted with order",
            at: new Date(),
          }],
        });
        await paymentRecord.save({ session });
        order.paymentId = paymentRecord._id;
        await order.save({ session });
      }
      await session.commitTransaction();
    } catch (transactionError) {
      await session.abortTransaction().catch(() => {});
      throw transactionError;
    } finally {
      await session.endSession();
    }

    return res.status(201).json({
      success: true,
      order: order.toObject(),
      quote: deliveryQuote,
    });
  } catch (err) {
    console.error("POST /api/orders error:", err);
    if (err?.code === 11000 && checkoutRequestId) {
      const existingOrder = await Order.findOne({ userId: req.user._id, checkoutRequestId }).catch(() => null);
      if (existingOrder) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(200).json({ success: true, duplicate: true, order: existingOrder.toObject() });
      }
    }
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return checkoutErrorResponse(res, err);
  }
});

/**
 * GET /api/orders/my â€” Get current user's orders
 */
router.get("/my", authenticate, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .populate("technicianId", "name phone")
      .lean();
    res.json({ orders });
  } catch (err) {
    checkoutErrorResponse(res, err);
  }
});

/**
 * GET /api/orders/technician/tasks â€” Get tasks for logged-in technician
 */
router.get("/technician/tasks", authenticate, requireRole("technician"), async (req, res) => {
  try {
    // find technician record for current user
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) {
      return res.status(404).json({ error: "Technician record not found" });
    }

    const orders = await Order.find({
      technicianId: tech._id,
      status: { $nin: ["cancelled", "completed"] },
    })
      .sort({ "delivery.preferredDate": 1, createdAt: 1 })
      .lean();

    res.json({ tasks: orders });
  } catch (err) {
    checkoutErrorResponse(res, err);
  }
});

/**
 * GET /api/orders/technician/all â€” All orders for logged-in technician (paginated, filterable)
 * Query: status, fulfillmentType, search, from, to, page, limit
 */
router.get("/technician/all", authenticate, requireRole("technician"), async (req, res) => {
  try {
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) {
      return res.status(404).json({ error: "Technician record not found" });
    }

    const { status, fulfillmentType, search, from, to, page = 1, limit = 50 } = req.query;
    const filter = { technicianId: tech._id };

    if (status && status !== "all") filter.status = status;
    if (fulfillmentType && fulfillmentType !== "all") filter.fulfillmentType = fulfillmentType;

    if (search) {
      const safeSearch = String(search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(safeSearch, "i");
      filter.$or = [
        { orderReference: regex },
        { "customer.name": regex },
        { "customer.email": regex },
        { "items.modelLine": regex },
      ];
    }

    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = toDate;
      }
    }

    const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Order.countDocuments(filter),
    ]);

    const [totalOrders, pendingPrep, outForDelivery, installing, completed, cancelled, awaitingAcceptance] = await Promise.all([
      Order.countDocuments({ technicianId: tech._id }),
      Order.countDocuments({ technicianId: tech._id, status: { $in: ["preparing_unit", "technician_accepted"] } }),
      Order.countDocuments({ technicianId: tech._id, status: "out_for_delivery" }),
      Order.countDocuments({ technicianId: tech._id, status: "installing" }),
      Order.countDocuments({ technicianId: tech._id, status: "completed" }),
      Order.countDocuments({ technicianId: tech._id, status: "cancelled" }),
      Order.countDocuments({ technicianId: tech._id, status: "technician_assigned" }),
    ]);

    res.json({
      orders,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      kpi: { totalOrders, pendingPrep, outForDelivery, installing, completed, cancelled, awaitingAcceptance },
    });
  } catch (err) {
    console.error("GET /api/orders/technician/all error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch orders" });
  }
});

/**
 * GET /api/orders/:id/eligible-technicians â€” Get eligible technicians for an order
 */
router.get("/assignment-plan", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const requestedStatuses = String(req.query.status || "preparing_unit,technician_declined")
      .split(",")
      .filter(status => ["preparing_unit", "technician_declined"].includes(status));
    const orders = await Order.find({
      status: { $in: requestedStatuses.length ? requestedStatuses : ["preparing_unit", "technician_declined"] },
      fulfillmentType: { $in: ["delivery_only", "delivery_installation"] },
      paymentStatus: { $in: ["paid", "partial", "verified", "remitted"] },
      $or: [{ technicianId: null }, { technicianId: { $exists: false } }],
    }).sort({ "delivery.preferredDate": 1, timeSlot: 1 }).limit(200).lean();
    const eligibleOrders = orders.map(order => withOrderAttentionState(order)).filter(order => !order.isPastDate);
    const plan = await buildOrderAssignmentPlan(eligibleOrders);
    res.json({
      plan,
      total: plan.length,
      assignable: plan.filter(row => row.recommended).length,
      unmatched: plan.filter(row => !row.recommended).length,
    });
  } catch (error) {
    console.error("[OrderAssignmentPlan] preview failed:", error);
    res.status(500).json({ error: "Failed to build the order assignment plan" });
  }
});

// Every order-id endpoint inherits the same record-level access policy.
router.use("/:id", authenticate, async (req, res, next) => {
  if (!require("mongoose").Types.ObjectId.isValid(req.params.id)) return next();
  try {
    const order = await Order.findById(req.params.id).select("userId technicianId").lean();
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (["admin", "secretary"].includes(req.user.role)) return next();
    if (req.user.role === "customer" && String(order.userId || "") === String(req.user._id)) {
      return next();
    }
    if (req.user.role === "technician") {
      const technician = await Technician.findOne({ user: req.user._id }).select("_id").lean();
      if (technician && String(order.technicianId || "") === String(technician._id)) {
        return next();
      }
    }
    return res.status(403).json({ error: "Forbidden" });
  } catch (err) {
    return next(err);
  }
});

function checkoutErrorResponse(res, error) {
  const status = Number(error?.status) || 500;
  const isOperational = error instanceof OrderCheckoutError && status < 500;
  return res.status(status).json({
    error: isOperational ? error.message : "The order request could not be completed. Please try again.",
    ...(isOperational && error.code ? { code: error.code } : {}),
  });
}

function emitOrderStatus(req, order, extra = {}) {
  const io = req?.app?.get?.("io") || global.io;
  if (!io || !order?.userId) return;
  io.to(`customer:${order.userId}`).emit("order:status-change", {
    orderId: order._id,
    status: order.status,
    paymentStatus: order.paymentStatus,
    refundStatus: order.refundStatus,
    timestamp: Date.now(),
    ...extra,
  });
}

function orderKitTarget(order) {
  const technicianId = order?.technicianId?._id || order?.technicianId;
  const workDate = order?.delivery?.preferredDate;
  return technicianId && workDate ? { technicianId, workDate } : null;
}

async function syncAffectedOrderKits(...targets) {
  const unique = new Map();
  for (const target of targets.flat().filter(Boolean)) {
    const date = new Date(target.workDate);
    if (!target.technicianId || Number.isNaN(date.getTime())) continue;
    date.setHours(0, 0, 0, 0);
    unique.set(`${target.technicianId}:${date.toISOString()}`, { technicianId: target.technicianId, workDate: date });
  }
  for (const target of unique.values()) {
    try {
      await syncDailyKit(target.technicianId, target.workDate);
    } catch (error) {
      console.warn("[orders] Daily Kit synchronization failed:", error.message);
    }
  }
}

function validFieldProof(value) {
  const proof = String(value || "");
  return proof.length <= 7 * 1024 * 1024 && /^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(proof);
}

async function syncLinkedInstallationBooking(order, technician, io) {
  if (order.fulfillmentType !== "delivery_installation" || !order.bookingId) return;
  const booking = await BookingService.findById(order.bookingId);
  if (!booking) return;
  const bookingStatus = {
    technician_assigned: "scheduled",
    technician_accepted: "confirmed",
    out_for_delivery: "on-the-way",
    arrived: "arrived",
    installing: "in-progress",
    completed: "completed",
    cancelled: "cancelled",
    technician_declined: "awaiting_assignment",
  }[order.status];
  const itemStatus = {
    technician_assigned: "assigned",
    technician_accepted: "accepted",
    out_for_delivery: "en_route",
    arrived: "arrived",
    installing: "in_progress",
    completed: "completed",
    cancelled: "cancelled",
    technician_declined: "awaiting_assignment",
  }[order.status];
  if (bookingStatus) booking.status = bookingStatus;
  booking.sourceOrderId = order._id;
  booking.technicianId = order.technicianId || null;
  if (technician) {
    booking.technician = {
      _id: technician._id,
      name: technician.name || `${technician.firstName || ""} ${technician.lastName || ""}`.trim(),
      phone: technician.phone || "",
      email: technician.email || "",
    };
  } else if (!order.technicianId) {
    booking.technician = {};
  }
  if (order.delivery?.preferredDate) booking.bookingDate = order.delivery.preferredDate;
  if (order.timeSlot) booking.startTime = order.timeSlot;
  for (const item of booking.services || []) {
    const changed = Boolean(itemStatus && item.status !== itemStatus);
    if (itemStatus) item.status = itemStatus;
    if (technician) {
      item.technicianId = technician._id;
      item.technicianName = technician.name || `${technician.firstName || ""} ${technician.lastName || ""}`.trim();
    }
    if (changed) {
      item.statusHistory = item.statusHistory || [];
      item.statusHistory.push({
        status: itemStatus,
        changedAt: new Date(),
        changedByName: technician?.name || "System",
        reason: `Mirrored from installation order ${order.orderReference || order._id}`,
      });
    }
  }
  if (order.status === "completed") booking.completedAt = order.completedAt || new Date();
  if (order.proofPhoto) booking.proofPhoto = order.proofPhoto;
  await booking.save();

  const customerId = booking.customerId?._id || booking.customerId;
  if (io && customerId && bookingStatus) {
    io.to(`customer:${customerId}`).emit("booking:status-change", {
      bookingId: booking._id,
      orderId: order._id,
      status: bookingStatus,
      technicianName: technician?.name || order.technician?.name || "Technician",
      timestamp: Date.now(),
    });
  }
}

router.get("/:id/eligible-technicians", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ error: "Order not found" });

    const orderLoc = order.delivery?.coordinates?.coordinates; // [lng, lat]
    const orderLat = orderLoc ? orderLoc[1] : null;
    const orderLng = orderLoc ? orderLoc[0] : null;

    // Get active workload count per technician
    const activeOrders = await Order.find({
      status: { $in: ["technician_assigned", "out_for_delivery", "arrived", "installing"] },
      technicianId: { $ne: null },
    })
      .select("technicianId")
      .lean();
    const workloadMap = {};
    activeOrders.forEach(o => {
      const tid = o.technicianId?.toString();
      if (tid) workloadMap[tid] = (workloadMap[tid] || 0) + 1;
    });

    const technicians = await Technician.find({ active: true })
      .populate("user", "name email")
      .select("firstName lastName name email phone rating availabilityStatus lastSeen location locationText")
      .lean();

    const available = [];
    const offlinePresent = [];

    for (const tech of technicians) {
      const name = ((tech.firstName || '') + ' ' + (tech.lastName || '')).trim() || tech.name || 'Unknown';
      const rating = tech.rating || 0;
      const status = (tech.availabilityStatus || '').toLowerCase();
      const lastSeen = tech.lastSeen || tech.updatedAt;
      const currentWorkload = workloadMap[tech._id.toString()] || 0;

      // Distance / ETA
      const techCoords = tech.location?.coordinates; // [lng, lat]
      let distanceKm = null;
      let etaMin = null;
      if (orderLat && orderLng && techCoords && techCoords.length === 2) {
        const R = 6371;
        const dLat = ((techCoords[1] - orderLat) * Math.PI) / 180;
        const dLng = ((techCoords[0] - orderLng) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos((orderLat * Math.PI) / 180) * Math.cos((techCoords[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        distanceKm = Math.round(R * c * 10) / 10;
        etaMin = Math.max(10, Math.round(distanceKm * 3 + 5));
      }

      // Normalise status â€” treat blank/null as 'offline' (new technician or unset)
      const displayStatus = tech.availabilityStatus || 'Offline';

      const techInfo = {
        _id: tech._id,
        name,
        email: tech.email || (tech.user && tech.user.email) || '',
        phone: tech.phone || '',
        rating,
        availabilityStatus: displayStatus,
        lastSeen,
        currentWorkload,
        distanceKm,
        etaMin,
        location: tech.location || null,
        avatar: (name.charAt(0) || '?').toUpperCase(),
      };

      // Admin assignment: ALL active technicians are selectable.
      // Technicians that are genuinely on-break or actively busy are shown
      // in a separate "secondary" bucket so admin is informed, but they
      // remain assignable (admin has authority to override availability).
      const trulyBusy = status === 'on_break' || status === 'busy' ||
                        status === 'assigned' || status === 'on the way' ||
                        status === 'in progress';

      if (trulyBusy) {
        const reason = status === 'on_break'   ? 'On Break' :
                       status === 'busy'        ? 'Currently Busy' :
                       status === 'assigned'    ? 'Currently Assigned' :
                       status === 'on the way'  ? 'En Route' :
                       status === 'in progress' ? 'In Progress' :
                                                  'Busy';
        offlinePresent.push({ ...techInfo, reason });
      } else {
        // Available, Offline, Unknown/blank â€” all go into selectable list
        available.push(techInfo);
      }
    }

    // Sort available by AI score â€” genuinely rank by best fit
    const scoreTech = (t) => {
      let score = 0;
      const status = (t.availabilityStatus || '').toLowerCase();
      // Availability is the strongest signal: never recommend an offline/busy tech
      // when an available one exists.
      if (status === 'available') score += 100;
      else if (status === 'online') score += 60;
      else score += 0; // offline / unknown â€” heavily deprioritised
      // Rating (0â€“5) weighted
      score += (t.rating || 0) * 8;
      // Workload: fewer active jobs is better
      score += Math.max(0, 40 - (t.currentWorkload || 0) * 15);
      // Distance: closer is strongly preferred
      if (t.distanceKm != null) {
        score += Math.max(0, 60 - t.distanceKm * 2);
      }
      return score;
    };

    available.sort((a, b) => scoreTech(b) - scoreTech(a));

    res.json({ available, offlinePresent, bookingLat: orderLat, bookingLng: orderLng });
  } catch (err) {
    console.error("GET /api/orders/:id/eligible-technicians error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch technicians" });
  }
});

/**
 * GET /api/orders/check-availability â€” Check technician availability
 */
router.get("/check-availability", async (req, res) => {
  try {
    const { date, fulfillmentType } = req.query;
    if (!date) return res.status(400).json({ error: "Date is required" });
    if (fulfillmentType === "customer_pickup") {
      return res.json({ available: true });
    }

    const { technician, nextDate } = await findAvailableTechnician(new Date(date));
    res.json({
      available: !!technician,
      nextAvailableDate: nextDate,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/orders/:id â€” Get single order
 */
router.get("/:id", authenticate, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate("technicianId", "name phone")
      .lean();
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Only the owner, operational staff, or the assigned technician may view.
    const isOwner = order.userId.toString() === req.user._id.toString();
    const isStaff = ["admin", "secretary"].includes(req.user.role);
    let isAssignedTechnician = false;
    if (req.user.role === "technician") {
      const tech = await Technician.findOne({ user: req.user._id }).select("_id").lean();
      isAssignedTechnician = Boolean(
        tech && order.technicianId &&
        String(order.technicianId._id || order.technicianId) === String(tech._id)
      );
    }
    if (!isOwner && !isStaff && !isAssignedTechnician) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (isStaff && order.salesChannel === "walk_in") {
      const account = await User.findById(order.userId)
        .select("email emailVerified accountStatus invitationLastSentAt invitationActivatedAt +invitationExpiresAt")
        .lean();
      if (account) {
        order.customerAccount = {
          state: account.emailVerified !== false
            ? "active"
            : (account.accountStatus === "invited" ? "invited" : "pending_verification"),
          email: account.email,
          invitationLastSentAt: account.invitationLastSentAt || null,
          invitationExpiresAt: account.invitationExpiresAt || null,
          activatedAt: account.invitationActivatedAt || null,
          canManageInvitation: req.user.role === "admin",
        };
      }
    }

    res.json({ order: withOrderAttentionState(order) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Operations confirms that the sellable units/accessories are physically ready. */
router.post("/:id/dispatch-ready", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.fulfillmentType === "customer_pickup") {
      return res.status(400).json({ error: "Customer pickup uses the Ready for Pickup workflow." });
    }
    if (["completed", "cancelled"].includes(order.status)) {
      return res.status(409).json({ error: `Unit preparation cannot be confirmed while the order is ${order.status}.` });
    }
    order.preparation = order.preparation || {};
    order.preparation.dispatch = {
      status: "ready",
      readyAt: new Date(),
      readyBy: req.user._id,
      note: String(req.body?.note || "Ordered units and included delivery accessories physically verified").slice(0, 500),
    };
    order.pushStatus(order.status, "Physical unit preparation confirmed by operations.", {
      actor: req.user._id,
      actorRole: req.user.role,
      actorName: req.user.name || req.user.email || "Operations",
    });
    await order.save();
    return res.json({ success: true, order: order.toObject() });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to confirm unit preparation" });
  }
});

/**
 * POST /api/orders/:id/accept â€” Technician accepts their assigned order
 */
router.post("/:id/accept", authenticate, requireRole("technician"), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Verify this technician is the one assigned
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(403).json({ error: "Technician record not found" });
    if (!order.technicianId || order.technicianId.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "This order is not assigned to you" });
    }

    if (order.status !== "technician_assigned") {
      return res.status(400).json({ error: "Order is not awaiting acceptance" });
    }
    order.technicianAcceptance = {
      status: "accepted",
      respondedAt: new Date(),
    };
    order.pushStatus("technician_accepted", "Technician accepted the assignment", { actor: req.user && req.user._id, actorRole: req.user && req.user.role, actorName: (req.user && (req.user.name || req.user.email)) || 'System' });
    await order.save();
    await syncLinkedInstallationBooking(order, tech, req.app.get("io")).catch((error) => {
      console.warn("[orders] Linked installation booking acceptance sync failed:", error.message);
    });
    let preparationReview = null;
    if (order.fulfillmentType === "delivery_installation" && order.delivery?.preferredDate) {
      try {
        const kit = await syncDailyKit(tech._id, order.delivery.preferredDate);
        const deltaItems = (kit.deltaItems || []).filter((item) =>
          (item.orderIds || []).some((orderId) => String(orderId) === String(order._id)) && !item.resolution?.status
        );
        if (deltaItems.length) {
          preparationReview = {
            hasDelta: true,
            deltaItems: deltaItems.map((item) => ({ name: item.name, category: item.category, quantity: item.quantity, unit: item.unit })),
          };
        }
      } catch (kitError) {
        console.warn("[orders] Installation Daily Kit sync failed:", kitError.message);
      }
    }
    const refreshedOrder = await Order.findById(order._id).lean();
    emitOrderStatus(req, refreshedOrder || order);
    res.json({ success: true, order: refreshedOrder, preparationReview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/:id/decline â€” Technician declines their assigned order
 */
router.post("/:id/decline", authenticate, requireRole("technician"), async (req, res) => {
  try {
    const { reason } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Verify this technician is the one assigned
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(403).json({ error: "Technician record not found" });
    if (!order.technicianId || order.technicianId.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "This order is not assigned to you" });
    }

    if (order.status !== "technician_assigned") {
      return res.status(400).json({ error: "Order is not awaiting acceptance" });
    }
    const previousKitTarget = orderKitTarget(order);

    order.technicianAcceptance = {
      status: "declined",
      respondedAt: new Date(),
      declineReason: reason || "",
    };
    // Unassign and move back to preparing so admin can reassign
    order.technicianId = null;
    order.technician = {};
    order.pushStatus(
      "technician_declined",
      `Technician declined. ${reason ? "Reason: " + reason : ""}`,
      { actor: req.user && req.user._id, actorRole: req.user && req.user.role, actorName: (req.user && (req.user.name || req.user.email)) || 'System' }
    );
    await order.save();
    await syncLinkedInstallationBooking(order, null, req.app.get("io")).catch(() => {});
    await syncAffectedOrderKits(previousKitTarget);
    emitOrderStatus(req, order);
    res.json({ success: true, order: order.toObject() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/orders/:id/status â€” Update order status
 */
router.patch("/:id/status", authenticate, async (req, res) => {
  try {
    const {
      status, note, serialNumbers, arrivalProofUrl, startProofUrl,
      startProofNotes, completionProofUrl, consumables,
    } = req.body;
    if (!status) return res.status(400).json({ error: "Status is required" });
    const normalizedSerialNumbers = Array.isArray(serialNumbers)
      ? serialNumbers.map((value) => String(value || "").trim().slice(0, 120)).filter(Boolean).slice(0, 40)
      : [];
    if (new Set(normalizedSerialNumbers.map((value) => value.toLowerCase())).size !== normalizedSerialNumbers.length) {
      return res.status(400).json({ error: "Each installed unit must have a unique serial number." });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const maintainableUnitCount = (order.items || []).reduce(
      (sum, item) => sum + ((item.isHvac !== false || item.parentHvacId || item.capacity) ? Math.max(1, Number(item.quantity) || 1) : 0),
      0,
    );
    if (normalizedSerialNumbers.length > maintainableUnitCount) {
      return res.status(400).json({ error: `At most ${maintainableUnitCount} serial number(s) can be recorded for this order.` });
    }
    if (status === "completed" && order.fulfillmentType === "delivery_installation" && normalizedSerialNumbers.length !== maintainableUnitCount) {
      return res.status(400).json({ error: `Record exactly ${maintainableUnitCount} installed unit serial number(s) before completion.`, code: "ORDER_SERIAL_NUMBERS_REQUIRED" });
    }

    const isStaff = ["admin", "secretary"].includes(req.user.role);
    let tech = null;
    if (!isStaff && req.user.role !== "technician") {
      return res.status(403).json({ error: "Use the cancellation endpoint for customer cancellations" });
    }
    if (req.user.role === "technician") {
      tech = await Technician.findOne({ user: req.user._id });
      if (!tech || !order.technicianId || String(order.technicianId) !== String(tech._id)) {
        return res.status(403).json({ error: "This order is not assigned to you" });
      }
      const transitions = {
        technician_accepted: ["out_for_delivery"],
        out_for_delivery: ["arrived"],
        arrived: [order.fulfillmentType === "delivery_installation" ? "installing" : "completed"],
        installing: ["completed"],
      };
      if (!(transitions[order.status] || []).includes(status)) {
        return res.status(409).json({ error: "Invalid technician status transition" });
      }
    }

    let departureKit = null;
    if (status === "out_for_delivery") {
      if (order.fulfillmentType === "delivery_installation") {
        if (!order.delivery?.preferredDate) {
          return res.status(409).json({ error: "The installation has no scheduled work date.", code: "ORDER_SCHEDULE_REQUIRED" });
        }
        departureKit = await syncDailyKit(order.technicianId, order.delivery.preferredDate);
      }
      const readiness = orderDepartureReadiness(order, departureKit);
      if (!readiness.ready) {
        return res.status(409).json({
          error: readiness.blockers.join(" "),
          code: "ORDER_PREPARATION_REQUIRED",
          blockers: readiness.blockers,
          preparation: readiness,
        });
      }
    }
    if (status === "arrived" && !validFieldProof(arrivalProofUrl)) {
      return res.status(400).json({ error: "A valid proof-of-arrival photo is required.", code: "ARRIVAL_PROOF_REQUIRED" });
    }
    if (status === "installing" && !validFieldProof(startProofUrl)) {
      return res.status(400).json({ error: "A valid starting-work photo is required.", code: "START_PROOF_REQUIRED" });
    }
    if (status === "completed" && !validFieldProof(completionProofUrl)) {
      return res.status(400).json({ error: "A valid proof-of-completion photo is required.", code: "COMPLETION_PROOF_REQUIRED" });
    }

    const wasCancelled = status === "cancelled" && order.status !== "cancelled";
    const wasCompleted = status === "completed" && order.status !== "completed";
    const kitTarget = orderKitTarget(order);
    const now = new Date();

    if (wasCompleted && order.fulfillmentType === "delivery_installation" && Array.isArray(consumables)) {
      try {
        await recordOrderConsumableUsage({
          technicianId: order.technicianId,
          userId: req.user._id,
          orderId: order._id,
          date: order.delivery?.preferredDate || now,
          usages: consumables,
        });
      } catch (usageError) {
        return res.status(usageError.status || 409).json({ error: usageError.message, code: "ORDER_CONSUMABLE_USAGE_INVALID" });
      }
    }

    order.pushStatus(status, note || "", { actor: req.user && req.user._id, actorRole: req.user && req.user.role, actorName: (req.user && (req.user.name || req.user.email)) || 'System' });
    if (status === "out_for_delivery") order.enRouteAt = now;
    if (status === "arrived") {
      order.arrivedAt = now;
      order.arrivalProofUrl = arrivalProofUrl;
      order.arrivalProofCapturedAt = now;
    }
    if (status === "installing") {
      order.startedAt = now;
      order.startProofUrl = startProofUrl;
      order.startProofNotes = String(startProofNotes || "").slice(0, 500);
      order.startProofCapturedAt = now;
    }
    if (status === "completed") order.proofPhoto = completionProofUrl;

    // Snapshot the configured warranty when the order is completed. Existing
    // orders retain the terms that were active on their completion date.
    if (wasCompleted) {
      const completedAt = now;
      order.completedAt = completedAt;
      let serialIndex = 0;
      for (const item of order.items || []) {
        const unitCount = (item.isHvac !== false || item.parentHvacId || item.capacity) ? Math.max(1, Number(item.quantity) || 1) : 0;
        item.serialNumbers = normalizedSerialNumbers.slice(serialIndex, serialIndex + unitCount);
        serialIndex += unitCount;
      }
      if (order.fulfillmentType === "delivery_installation") {
        order.preparation = order.preparation || {};
        order.preparation.installation = {
          ...(order.preparation.installation?.toObject?.() || order.preparation.installation || {}),
          status: "completed",
          blockers: [],
        };
      }
      const warrantyRule = warrantyRuleForOrder(await getAftercarePolicy());
      const warrantySnapshot = buildOrderWarrantySnapshot(order, completedAt, warrantyRule);
      if (warrantySnapshot) order.warranty = warrantySnapshot;
    }

    await order.save();
    if (!tech && order.technicianId) tech = await Technician.findById(order.technicianId);
    await syncLinkedInstallationBooking(order, tech, req.app.get("io")).catch((error) => {
      console.warn("[orders] Linked installation booking status sync failed:", error.message);
    });

    if (tech) {
      if (status === "out_for_delivery") tech.availabilityStatus = "On The Way";
      if (["arrived", "installing"].includes(status)) tech.availabilityStatus = "In Progress";
      if (["completed", "cancelled"].includes(status)) {
        try {
          const { resolveAvailabilityStatus } = require("../utils/availability");
          await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
        } catch (_) {}
      } else {
        await tech.save();
      }
    }

    if (wasCompleted) {
      try {
        const { syncMaintenanceFromOrder } = require("../utils/maintenanceLifecycle");
        const assets = await syncMaintenanceFromOrder(order);
        if (normalizedSerialNumbers.length) {
          const CustomerAsset = require("../models/CustomerAsset");
          await Promise.all(assets.slice(0, normalizedSerialNumbers.length).map((asset, index) =>
            CustomerAsset.findByIdAndUpdate(asset._id, { "equipment.serialNumber": normalizedSerialNumbers[index] })
          ));
        }
      } catch (maintenanceError) {
        console.error("Failed to create order maintenance schedules:", maintenanceError.message);
      }
    }

    // Restore stock if cancelled via status update
    if (wasCancelled) {
      try {
        const HVACProduct = require("../models/HVACProduct");
        for (const item of order.items || []) {
          if (item.isHvac) {
            await HVACProduct.findOneAndUpdate(
              { _id: item.parentHvacId, "variants._id": item.inventoryId },
              { $inc: { "variants.$.quantity": item.quantity } }
            );
          } else {
            await Inventory.findByIdAndUpdate(item.inventoryId, {
              $inc: { quantity: item.quantity },
            });
          }
        }
      } catch (stockErr) {
        console.error("Failed to restore stock on cancel:", stockErr.message);
      }
    }

    if (wasCancelled || wasCompleted) await syncAffectedOrderKits(kitTarget);

    const io = req.app.get("io");
    if (io) {
      io.to(`customer:${order.userId}`).emit("order:status-change", {
        orderId: order._id,
        status: order.status,
        technicianName: tech?.name || order.technician?.name || "Technician",
        timestamp: Date.now(),
      });
    }

    res.json({ success: true, order: order.toObject() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record an on-site collection after product delivery/installation. No gateway
// is contacted and only an administrator may subsequently verify it.
router.post("/:id/collect-payment", authenticate, requireRole("technician"), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    const tech = await Technician.findOne({ user: req.user._id });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!tech || String(order.technicianId) !== String(tech._id)) return res.status(403).json({ error: "Order is not assigned to you" });
    if (order.status !== "completed") return res.status(400).json({ error: "Complete the order before collecting payment." });
    const { amount, method = "cash", reference, proofUrl, customerSignature, notes, location } = req.body || {};
    const paymentMethod = String(method).toLowerCase();
    const value = Number(amount);
    if (!["cash", "gcash", "bank"].includes(paymentMethod)) return res.status(400).json({ error: "Invalid payment method." });
    if (!Number.isFinite(value) || value <= 0 || value > Number(order.total || 0)) return res.status(400).json({ error: "Invalid amount collected." });
    if (!customerSignature) return res.status(400).json({ error: "Customer signature is required." });
    if (["gcash", "bank"].includes(paymentMethod) && (!String(reference || "").trim() || !proofUrl)) return res.status(400).json({ error: "Reference number and receipt screenshot are required." });
    const now = new Date();
    const payment = await Payment.create({
      orderId: order._id, amount: value, method: paymentMethod,
      type: order.paymentStatus === "partial" ? "final" : (value < Number(order.total || 0) ? "downpayment" : "final"),
      gateway: paymentMethod === "cash" ? "cod" : paymentMethod, status: "waiting_for_remittance",
      reference: String(reference || "").trim() || undefined, proofUrl: proofUrl || undefined, customerSignature,
      collectedBy: tech._id, collectedByName: tech.name, collectedAt: now, collectionLocation: location || undefined, notes,
      events: [{ status: "payment_collected", actor: req.user._id, actorName: tech.name, actorRole: "technician", at: now, metadata: { method: paymentMethod } }, { status: "waiting_for_remittance", actor: req.user._id, actorName: tech.name, actorRole: "technician", at: now }]
    });
    order.paymentStatus = "waiting_for_remittance";
    order.paymentId = payment._id;
    order.pushStatus(order.status, `Payment collected by ${tech.name}; waiting for remittance verification.`, { actor: req.user && req.user._id, actorRole: req.user && req.user.role, actorName: (req.user && (req.user.name || req.user.email)) || 'System' });
    await order.save();
    res.status(201).json({ message: "Payment recorded. Waiting for admin remittance verification.", paymentId: payment._id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/orders/:id/mark-ready-for-pickup â€” Admin marks a customer_pickup order as ready
 * Transitions: preparing_unit â†’ ready_for_pickup
 */
router.post("/:id/mark-ready-for-pickup", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.fulfillmentType !== "customer_pickup") {
      return res.status(400).json({ error: "This endpoint is only for customer pickup orders." });
    }
    if (order.status !== "preparing_unit") {
      return res.status(400).json({ error: `Order must be in "preparing_unit" status. Current: ${order.status}` });
    }
    order.pushStatus("ready_for_pickup", req.body.note || "Unit ready for customer pickup", {
      actor: req.user && req.user._id, actorRole: req.user && req.user.role,
      actorName: (req.user && (req.user.name || req.user.email)) || "System"
    });
    await order.save();
    emitOrderStatus(req, order);
    res.json({ success: true, order: order.toObject() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/orders/:id/confirm-pickup â€” Admin confirms customer has picked up the unit
 * Transitions: ready_for_pickup â†’ completed
 */
router.post("/:id/confirm-pickup", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const order = await Order.findById(req.params.id).session(session);
    if (!order) throw new OrderCheckoutError("Order not found", 404, "ORDER_NOT_FOUND");
    if (order.fulfillmentType !== "customer_pickup") {
      throw new OrderCheckoutError("This endpoint is only for customer pickup orders.", 400, "ORDER_NOT_PICKUP");
    }
    if (order.status !== "ready_for_pickup") {
      throw new OrderCheckoutError(`Order must be in "ready_for_pickup" status. Current: ${order.status}`, 409, "ORDER_PICKUP_NOT_READY");
    }
    const maintainableUnitCount = (order.items || []).reduce(
      (sum, item) => sum + ((item.isHvac !== false || item.parentHvacId || item.capacity) ? Math.max(1, Number(item.quantity) || 1) : 0),
      0,
    );
    const serialNumbers = Array.isArray(req.body?.serialNumbers)
      ? req.body.serialNumbers.map((value) => String(value || "").trim().slice(0, 120)).filter(Boolean)
      : [];
    if (new Set(serialNumbers.map((value) => value.toLowerCase())).size !== serialNumbers.length) {
      throw new OrderCheckoutError("Each handed-over unit must have a unique serial number.", 400, "ORDER_SERIAL_NUMBERS_DUPLICATE");
    }
    if (serialNumbers.length !== maintainableUnitCount) {
      throw new OrderCheckoutError(`Record exactly ${maintainableUnitCount} unit serial number(s) before confirming pickup.`, 400, "ORDER_SERIAL_NUMBERS_REQUIRED");
    }
    let paymentCollected = false;
    if (order.paymentMethod === "cash_onsite") {
      const now = new Date();
      const payment = new Payment({
        orderId: order._id,
        amount: Number(order.total) || 0,
        method: "cash",
        type: "final",
        gateway: "cod",
        status: "verified",
        collectedAt: now,
        verifiedAt: now,
        completedAt: now,
        verifiedBy: req.user._id,
        collectionLocation: { address: order.pickupLocation || "Store counter" },
        notes: String(req.body?.note || "Cash collected at customer pickup").slice(0, 500),
        events: [{
          status: "verified",
          actor: req.user._id,
          actorName: req.user.name || req.user.email || "Operations",
          actorRole: req.user.role,
          note: "Cash collected and verified at the pickup counter",
          at: now,
        }],
      });
      await payment.save({ session });
      order.paymentId = payment._id;
      order.paymentStatus = "paid";
      order.balanceAmount = 0;
      paymentCollected = true;
    } else if (!["paid", "verified", "remitted"].includes(order.paymentStatus)) {
      throw new OrderCheckoutError(
        "Verify the customer's payment before confirming pickup.",
        409,
        "ORDER_PICKUP_PAYMENT_REQUIRED",
      );
    }
    order.pushStatus("completed", req.body.note || "Customer has picked up the unit", {
      actor: req.user && req.user._id, actorRole: req.user && req.user.role,
      actorName: (req.user && (req.user.name || req.user.email)) || "System"
    });
    const completedAt = new Date();
    order.completedAt = completedAt;
    let serialIndex = 0;
    for (const item of order.items || []) {
      const unitCount = (item.isHvac !== false || item.parentHvacId || item.capacity) ? Math.max(1, Number(item.quantity) || 1) : 0;
      item.serialNumbers = serialNumbers.slice(serialIndex, serialIndex + unitCount);
      serialIndex += unitCount;
    }
    const warrantyRule = warrantyRuleForOrder(await getAftercarePolicy());
    const warrantySnapshot = buildOrderWarrantySnapshot(order, completedAt, warrantyRule);
    if (warrantySnapshot) order.warranty = warrantySnapshot;
    await order.save({ session });
    await session.commitTransaction();
    try {
      const { syncMaintenanceFromOrder } = require("../utils/maintenanceLifecycle");
      await syncMaintenanceFromOrder(order);
    } catch (maintenanceError) {
      console.error("Failed to create pickup-order maintenance record:", maintenanceError.message);
    }
    emitOrderStatus(req, order, { paymentCollected });
    res.json({ success: true, paymentCollected, order: order.toObject() });
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    checkoutErrorResponse(res, err);
  } finally {
    await session.endSession();
  }
});

/**
 * POST /api/orders/:id/cancel â€” Cancel order (admin/secretary/customer for own pending orders)
 */
router.post("/:id/cancel", authenticate, async (req, res) => {
  try {
    const { reason } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Check if user is admin or secretary
    const isAdmin = req.user && req.user.role === "admin";
    const isSecretary = req.user && req.user.role === "secretary";
    const isTechnician = req.user && req.user.role === "technician";

    // Check if user is the customer
    const isOwner = order.userId.toString() === req.user._id.toString();

    if (isTechnician) {
      const tech = await Technician.findOne({ user: req.user._id }).select("_id").lean();
      if (!tech || !order.technicianId || String(order.technicianId) !== String(tech._id)) {
        return res.status(403).json({ error: "This order is not assigned to you" });
      }
    }

    // Only allow cancellation if:
    // 1. User is admin, secretary, or technician, OR
    // 2. User is the customer AND order is in a pending state
    const pendingStatuses = ["pending_payment", "preparing_unit", "technician_assigned"];
    if (!isAdmin && !isSecretary && !isTechnician) {
      if (!isOwner) {
        return res.status(403).json({ error: "You can only cancel your own orders" });
      }
      if (!pendingStatuses.includes(order.status)) {
        return res.status(400).json({ error: "Only pending orders can be cancelled" });
      }
    }

    if (["cancelled", "completed"].includes(order.status)) {
      return res.status(409).json({ error: `A ${order.status} order cannot be cancelled again.` });
    }
    const cancellationReason = String(reason || "").trim().slice(0, 1000);
    if (!cancellationReason) {
      return res.status(400).json({ error: "A cancellation reason is required." });
    }

    const previousKitTarget = orderKitTarget(order);
    const session = await mongoose.startSession();
    let cancelledOrder;
    let refundRequested = false;
    try {
      session.startTransaction();
      cancelledOrder = await Order.findOne({
        _id: order._id,
        status: { $nin: ["cancelled", "completed"] },
      }).session(session);
      if (!cancelledOrder) {
        throw new OrderCheckoutError("This order was already completed or cancelled.", 409, "ORDER_CANCELLATION_CONFLICT");
      }

      const cancelNote = `Cancelled by ${isOwner ? "customer" : req.user.role}. Reason: ${cancellationReason}`;
      cancelledOrder.pushStatus("cancelled", cancelNote, {
        actor: req.user._id,
        actorRole: req.user.role,
        actorName: req.user.name || req.user.email || "System",
      });
      cancelledOrder.cancellationReason = cancellationReason;
      if (cancelledOrder.fulfillmentType === "delivery_installation") {
        cancelledOrder.preparation = cancelledOrder.preparation || {};
        cancelledOrder.preparation.installation = {
          ...(cancelledOrder.preparation.installation?.toObject?.() || cancelledOrder.preparation.installation || {}),
          status: "cancelled",
          blockers: [],
        };
      }

      const receivedStatuses = ["verified", "paid", "remitted", "partial", "payment_collected", "waiting_for_remittance"];
      const receivedPayments = await Payment.find({
        orderId: cancelledOrder._id,
        status: { $in: receivedStatuses },
      }).session(session);
      let refundableAmount = 0;
      for (const payment of receivedPayments) {
        const amount = Math.max(0, Number(payment.amount) || 0);
        const previouslyRefunded = payment.refundStatus === "completed" ? Math.max(0, Number(payment.refundAmount) || 0) : 0;
        const remaining = Math.max(0, amount - previouslyRefunded);
        if (!remaining) continue;
        payment.refundStatus = "pending";
        payment.refundAmount = remaining;
        payment.refundMethod = "original";
        payment.refundReason = cancellationReason;
        payment.events.push({
          status: "refund_pending",
          actor: req.user._id,
          actorName: req.user.name || req.user.email || "Customer",
          actorRole: req.user.role,
          note: `Refund review created when order was cancelled (${cancelledOrder.orderReference || cancelledOrder._id})`,
          at: new Date(),
        });
        await payment.save({ session });
        refundableAmount += remaining;
      }
      if (refundableAmount > 0) {
        refundRequested = true;
        cancelledOrder.refundStatus = "pending";
        cancelledOrder.refundAmount = refundableAmount;
        cancelledOrder.refundReason = cancellationReason;
        cancelledOrder.refundRequestedAt = new Date();
      }

      const HVACProduct = require("../models/HVACProduct");
      for (const item of cancelledOrder.items || []) {
        if (item.isHvac) {
          const restored = await HVACProduct.findOneAndUpdate(
            { _id: item.parentHvacId, "variants._id": item.inventoryId },
            { $inc: { "variants.$.quantity": item.quantity } },
            { session },
          );
          if (!restored) throw new Error(`Unable to restore stock for ${item.modelLine || item.inventoryId}`);
        } else {
          const restored = await Inventory.findByIdAndUpdate(
            item.inventoryId,
            { $inc: { quantity: item.quantity } },
            { session },
          );
          if (!restored) throw new Error(`Unable to restore stock for ${item.modelLine || item.inventoryId}`);
        }
      }

      if (cancelledOrder.bookingId) {
        await BookingService.findByIdAndUpdate(
          cancelledOrder.bookingId,
          { status: "cancelled", notes: `Order cancelled: ${cancellationReason}` },
          { session },
        );
      }
      await cancelledOrder.save({ session });
      await session.commitTransaction();
    } catch (transactionError) {
      await session.abortTransaction().catch(() => {});
      throw transactionError;
    } finally {
      await session.endSession();
    }

    await syncLinkedInstallationBooking(cancelledOrder, null, req.app.get("io")).catch(() => {});
    await syncAffectedOrderKits(previousKitTarget);
    emitOrderStatus(req, cancelledOrder, { refundRequested });
    res.json({
      message: refundRequested ? "Order cancelled. The verified payment is queued for refund review." : "Order cancelled",
      refundRequested,
      order: cancelledOrder.toObject(),
    });
  } catch (err) {
    checkoutErrorResponse(res, err);
  }
});

/**
 * POST /api/orders/:id/reschedule-request â€” Submit reschedule request (customer for own pending orders)
 */
router.post("/:id/reschedule-request", authenticate, async (req, res) => {
  try {
    const { requestedDate, requestedTime, reason } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Check if user is the customer
    const isOwner = order.userId.toString() === req.user._id.toString();

    if (!isOwner) {
      return res.status(403).json({ error: "You can only request reschedule for your own orders" });
    }

    // Only allow reschedule requests for pending orders
    const pendingStatuses = ["pending_payment", "preparing_unit", "technician_assigned"];
    if (!pendingStatuses.includes(order.status)) {
      return res.status(400).json({ error: "Only pending orders can be rescheduled" });
    }

    // Validate required fields
    const pickupRequest = order.fulfillmentType === "customer_pickup";
    if (!requestedDate || (!pickupRequest && !requestedTime) || !String(reason || "").trim()) {
      return res.status(400).json({ error: pickupRequest
        ? "Requested date and reason are required"
        : "Requested date, time, and reason are required" });
    }

    const proposedSchedule = order.toObject();
    proposedSchedule.timeSlot = pickupRequest ? null : requestedTime;
    let requestedDateValue;
    if (pickupRequest) {
      const settings = await getOrderCheckoutSettings();
      requestedDateValue = validatePickupDate(requestedDate, settings.storeHours);
    } else {
      requestedDateValue = parseDateOnly(requestedDate);
      if (!requestedDateValue) return res.status(400).json({ error: "Choose a valid delivery date." });
    }
    if (pickupRequest) proposedSchedule.pickupDate = requestedDateValue;
    else proposedSchedule.delivery = { ...(proposedSchedule.delivery || {}), preferredDate: requestedDateValue };
    const requestedCutoff = requestedOrderCutoff(proposedSchedule);
    if (!requestedCutoff || requestedCutoff.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Choose a reschedule date and time that is still in the future." });
    }

    // Store reschedule request
    order.rescheduleRequest = {
      requested: true,
      requestedDate: requestedDate,
      requestedTime: pickupRequest ? "" : String(requestedTime).trim(),
      reason: String(reason).trim().slice(0, 500),
      requestedBy: req.user._id,
      requestedAt: new Date(),
      status: "pending" // pending, approved, rejected
    };

    await order.save();

    emitOrderStatus(req, order, { rescheduleRequestStatus: "pending" });

    res.json({
      message: "Reschedule request submitted successfully",
      order: order.toObject()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/:id/reschedule-approve â€” Approve reschedule request (admin/secretary)
 */
router.post("/:id/reschedule-approve", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Check if there's a pending reschedule request
    if (!order.rescheduleRequest || order.rescheduleRequest.status !== "pending") {
      return res.status(400).json({ error: "No pending reschedule request found" });
    }

    const proposedSchedule = order.toObject();
    proposedSchedule.timeSlot = order.rescheduleRequest.requestedTime;
    const requestedDateValue = /^\d{4}-\d{2}-\d{2}$/.test(String(order.rescheduleRequest.requestedDate))
      ? new Date(`${order.rescheduleRequest.requestedDate}T00:00:00`)
      : new Date(order.rescheduleRequest.requestedDate);
    if (order.fulfillmentType === "customer_pickup") proposedSchedule.pickupDate = requestedDateValue;
    else proposedSchedule.delivery = { ...(proposedSchedule.delivery || {}), preferredDate: requestedDateValue };
    const requestedCutoff = requestedOrderCutoff(proposedSchedule);
    if (!requestedCutoff || requestedCutoff.getTime() <= Date.now()) {
      return res.status(409).json({ error: "The customer's proposed schedule has already passed. Request a new future date and time." });
    }
    const previousKitTarget = orderKitTarget(order);

    // Update order with new date/time
    if (order.fulfillmentType === "customer_pickup") {
      order.pickupDate = requestedDateValue;
    } else {
      order.delivery = order.delivery || {};
      order.delivery.preferredDate = requestedDateValue;
    }
    order.timeSlot = order.rescheduleRequest.requestedTime;

    // Update reschedule request status
    order.rescheduleRequest.status = "approved";
    order.rescheduleRequest.processedBy = req.user._id;
    order.rescheduleRequest.processedAt = new Date();

    // Add to status history
    order.pushStatus(order.status, `Rescheduled to ${order.rescheduleRequest.requestedDate} at ${order.rescheduleRequest.requestedTime}`, { actor: req.user && req.user._id, actorRole: req.user && req.user.role, actorName: (req.user && (req.user.name || req.user.email)) || 'System' });

    await order.save();
    const assignedTech = order.technicianId ? await Technician.findById(order.technicianId).lean() : null;
    await syncLinkedInstallationBooking(order, assignedTech, req.app.get("io")).catch(() => {});
    await syncAffectedOrderKits(previousKitTarget, orderKitTarget(order));
    emitOrderStatus(req, order, { rescheduleRequestStatus: "approved" });

    res.json({
      message: "Reschedule request approved",
      order: order.toObject()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/:id/reschedule-reject â€” Reject reschedule request (admin/secretary)
 */
router.post("/:id/reschedule-reject", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { reason } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Check if there's a pending reschedule request
    if (!order.rescheduleRequest || order.rescheduleRequest.status !== "pending") {
      return res.status(400).json({ error: "No pending reschedule request found" });
    }

    // Update reschedule request status
    order.rescheduleRequest.status = "rejected";
    order.rescheduleRequest.processedBy = req.user._id;
    order.rescheduleRequest.processedAt = new Date();
    order.rescheduleRequest.rejectionReason = reason || "Request rejected by administrator";

    await order.save();

    emitOrderStatus(req, order, { rescheduleRequestStatus: "rejected" });

    res.json({
      message: "Reschedule request rejected",
      order: order.toObject()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/:id/admin-reschedule
 * Replaces a passed requested schedule without cancelling or expiring the order.
 */
router.post("/:id/admin-reschedule", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { scheduledDate, timeSlot, reason } = req.body || {};
    if (!scheduledDate || !timeSlot) {
      return res.status(400).json({ error: "A new date and time are required." });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!REVIEWABLE_ORDER_STATUSES.has(order.status)) {
      return res.status(409).json({ error: `Order status "${order.status}" cannot be rescheduled from the attention queue.` });
    }

    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(scheduledDate))
      ? new Date(`${scheduledDate}T00:00:00`)
      : new Date(scheduledDate);
    if (Number.isNaN(parsedDate.getTime())) return res.status(400).json({ error: "The replacement date is invalid." });

    const proposed = order.toObject();
    proposed.timeSlot = timeSlot;
    if (order.fulfillmentType === "customer_pickup") proposed.pickupDate = parsedDate;
    else proposed.delivery = { ...(proposed.delivery || {}), preferredDate: parsedDate };

    const cutoff = requestedOrderCutoff(proposed);
    if (!cutoff || cutoff.getTime() <= Date.now()) {
      return res.status(400).json({ error: "Choose a delivery or pickup schedule that is still in the future." });
    }
    const previousKitTarget = orderKitTarget(order);

    if (order.fulfillmentType === "customer_pickup") {
      order.pickupDate = parsedDate;
    } else {
      order.delivery = order.delivery || {};
      order.delivery.preferredDate = parsedDate;
    }
    order.timeSlot = timeSlot;
    order.rescheduleRequest = {
      requested: true,
      requestedDate: scheduledDate,
      requestedTime: timeSlot,
      reason: reason || "Past requested schedule replaced by admin",
      requestedBy: req.user._id,
      requestedAt: new Date(),
      status: "approved",
      processedBy: req.user._id,
      processedAt: new Date(),
    };
    order.pushStatus(
      order.status,
      `Admin rescheduled order to ${scheduledDate} at ${timeSlot}. ${reason || "Customer schedule updated after admin delay."}`,
      { actor: req.user._id, actorRole: req.user.role, actorName: req.user.name || req.user.email || "Admin" }
    );
    await order.save();

    if (order.bookingId) {
      await BookingService.findByIdAndUpdate(order.bookingId, {
        bookingDate: parsedDate,
        startTime: timeSlot,
      }).catch(() => {});
    }
    const assignedTech = order.technicianId ? await Technician.findById(order.technicianId).lean() : null;
    await syncLinkedInstallationBooking(order, assignedTech, req.app.get("io")).catch(() => {});
    await syncAffectedOrderKits(previousKitTarget, orderKitTarget(order));

    try {
      const { createNotification } = require("../utils/notify");
      await createNotification({
        type: "order_rescheduled",
        title: "Order Schedule Updated",
        message: `Your order ${order.orderReference || ""} is now scheduled for ${scheduledDate} at ${timeSlot}.`,
        userId: order.userId,
        role: "customer",
        referenceId: order._id,
        referenceModel: "Order",
        link: `/my-orders/${order._id}`,
        io: req.app.get("io"),
      }).catch(() => {});
    } catch (_) {}

    return res.json({
      success: true,
      message: "Order schedule updated. The order remains active in its current workflow stage.",
      order: withOrderAttentionState(order.toObject()),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to reschedule order" });
  }
});

/**
 * POST /api/orders/:id/requeue-assignment
 * Releases an unanswered technician assignment back to the assignment queue.
 */
router.post("/:id/requeue-assignment", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status !== "technician_assigned") {
      return res.status(409).json({ error: "Only an order waiting for technician acceptance can be requeued." });
    }

    const previousTechnicianId = order.technicianId;
    const previousKitTarget = orderKitTarget(order);
    const reason = String(req.body?.reason || "Technician did not respond to the assignment").trim();
    order.technicianId = null;
    order.technician = {};
    order.technicianAcceptance = { status: "pending" };
    order.pushStatus("preparing_unit", `Assignment released by admin. ${reason}`, {
      actor: req.user._id,
      actorRole: req.user.role,
      actorName: req.user.name || req.user.email || "Admin",
    });
    await order.save();

    if (order.bookingId) {
      await BookingService.findByIdAndUpdate(order.bookingId, {
        technicianId: null,
        status: "awaiting_assignment",
      }).catch(() => {});
    }
    await syncLinkedInstallationBooking(order, null, req.app.get("io")).catch(() => {});
    await syncAffectedOrderKits(previousKitTarget);

    if (previousTechnicianId) {
      try {
        const technician = await Technician.findById(previousTechnicianId).select("user name").lean();
        if (technician?.user) {
          const { createNotification } = require("../utils/notify");
          await createNotification({
            type: "assignment_released",
            title: "Order Assignment Released",
            message: `Your assignment for ${order.orderReference || "an order"} was returned to the admin queue.`,
            userId: technician.user,
            role: "technician",
            referenceId: order._id,
            referenceModel: "Order",
            link: "/technician/orders",
            io: req.app.get("io"),
          }).catch(() => {});
        }
      } catch (_) {}
    }

    return res.json({ success: true, message: "Order returned to the assignment queue.", order: withOrderAttentionState(order.toObject()) });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to requeue assignment" });
  }
});

/**
 * POST /api/orders/:id/assign-technician
 * Admin assigns a technician to a confirmed order.
 * Status: preparing_unit or technician_declined -> technician_assigned
 * Also creates BookingService for delivery_installation orders.
 */
router.post("/:id/assign-technician", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    const { technicianId, scheduledDate, timeSlot, note, assignmentSource } = req.body;

    if (!technicianId) return res.status(400).json({ error: "Technician ID is required" });

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Use the scheduledDate if given, otherwise fall back to order's existing preferredDate
    const finalScheduledDate = scheduledDate || (order.delivery && order.delivery.preferredDate
      ? (() => { const d = new Date(order.delivery.preferredDate); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()
      : null);
    if (!finalScheduledDate) {
      return res.status(400).json({ error: "Set a future delivery date before assigning a technician." });
    }

    const assignableStatuses = ["preparing_unit", "technician_declined"];
    if (!assignableStatuses.includes(order.status)) {
      return res.status(400).json({
        error: `Cannot assign technician from status "${order.status}". Order must be in: ${assignableStatuses.join(", ")}.`
      });
    }
    if (!["paid", "partial", "verified", "remitted"].includes(order.paymentStatus)) {
      return res.status(409).json({
        error: "Verify the customer's payment before assigning a technician.",
        code: "ORDER_PAYMENT_NOT_VERIFIED",
      });
    }

    const proposedSchedule = {
      ...order.toObject(),
      delivery: { ...(order.delivery?.toObject?.() || order.delivery || {}), preferredDate: new Date(finalScheduledDate) },
      timeSlot: timeSlot || order.timeSlot,
    };
    const scheduleCutoff = requestedOrderCutoff(proposedSchedule);
    if (!scheduleCutoff || scheduleCutoff.getTime() <= Date.now()) {
      return res.status(409).json({
        error: "The requested delivery schedule has passed. Reschedule the order before assigning a technician.",
        code: "ORDER_SCHEDULE_PASSED",
      });
    }

    if (order.technicianId && order.status !== "technician_declined") {
      return res.status(400).json({ error: "Order already has a technician assigned. Use reassign if needed." });
    }

    const tech = await Technician.findById(technicianId);
    if (!tech) return res.status(404).json({ error: "Technician not found" });
    if (assignmentSource === "reviewed_plan") {
      const freshPlan = (await buildOrderAssignmentPlan([proposedSchedule], { reservePlan: false }))[0];
      const stillEligible = freshPlan?.candidates?.some(candidate => candidate.technicianId === String(technicianId));
      if (!stillEligible) {
        return res.status(409).json({
          error: "The selected technician is no longer eligible for this delivery schedule. Refresh the assignment plan.",
          code: "ORDER_ASSIGNMENT_PLAN_STALE",
        });
      }
    }

    // Set technician
    order.technicianId = technicianId;
    order.technician = {
      _id: tech._id,
      name: ((tech.firstName || '') + ' ' + (tech.lastName || '')).trim() || tech.name || '',
      phone: tech.phone || '',
      email: tech.email || ''
    };

    // Update delivery date using finalScheduledDate (customer's preferred date or provided)
    if (order.delivery && finalScheduledDate) {
      order.delivery.preferredDate = new Date(finalScheduledDate);
    }
    if (timeSlot) {
      order.timeSlot = timeSlot;
    }

    // Transition status
    const prevStatus = order.status;
    order.status = "technician_assigned";

    // Record status history
    if (!order.statusHistory) order.statusHistory = [];
    order.statusHistory.push({
      status: "technician_assigned",
      timestamp: new Date(),
      note: note || `Technician ${tech.firstName || tech.name || 'assigned'} assigned by ${req.user.name || req.user.email || 'Admin'}. ${finalScheduledDate ? 'Scheduled: ' + finalScheduledDate : ''}${timeSlot ? ' at ' + timeSlot : ''}`
    });

    await order.save();

    // Delivery + installation uses one linked booking across reassignments.
    if (order.fulfillmentType === "delivery_installation") {
      try {
        const bookingData = {
          sourceOrderId: order._id,
          customerId: order.userId,
          customer: order.customer,
          technicianId: tech._id,
          technician: {
            _id: tech._id,
            name: ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Technician",
            phone: tech.phone || "",
            email: tech.email || "",
          },
          bookingDate: new Date(finalScheduledDate),
          startTime: timeSlot || "09:00",
          endTime: timeSlot ? (parseInt(timeSlot.split(':')[0]) + 2).toString().padStart(2, '0') + ':00' : "11:00",
          status: "scheduled",
          serviceType: "core",
          service: {
            name: "Air Conditioner Installation",
            description: `Delivery and installation for ${order.orderReference || "product order"}`,
            basePrice: Number(order.installationFee || 0),
          },
          servicePrice: Number(order.installationFee || 0),
          services: (order.items || []).map((item) => ({
            name: `${item.brand || "Air Conditioner"} ${item.modelLine || ""} Installation`.trim(),
            type: "core",
            quantity: Math.max(1, Number(item.quantity) || 1),
            unitPrice: Number(order.installationFee || 0) / Math.max(1, (order.items || []).length),
            status: "assigned",
            hpDescription: item.capacity ? `${item.capacity} ${item.capacityUnit || "HP"}` : "",
            airconTypeName: item.modelLine || "Air Conditioner",
            technicianId: tech._id,
            technicianName: ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Technician",
          })),
          paymentMethod: order.paymentMethod || "cod",
          location: order.delivery
            ? { address: order.delivery.address, coordinates: order.delivery.coordinates }
            : undefined,
        };
        let booking = order.bookingId ? await BookingService.findById(order.bookingId) : null;
        if (booking) Object.assign(booking, bookingData);
        else booking = new BookingService(bookingData);
        await booking.save();
        order.bookingId = booking._id;
        await order.save();
        await syncLinkedInstallationBooking(order, tech, req.app.get("io"));
      } catch (e) {
        console.error("Failed to create or update installation booking:", e.message);
      }
    }

    // WebSocket notification
    if (global.io) {
      global.io.to(`tech:${tech._id}`).emit("order:assigned", {
        orderId: order._id,
        orderReference: order.orderReference,
        message: `You have been assigned to order ${order.orderReference || order._id}`
      });
    }
    try {
      const { createNotification } = require("../utils/notify");
      if (tech.user) {
        await createNotification({
          type: "assignment_new",
          title: "New Order Assignment",
          message: `You have been assigned to ${order.orderReference || "a customer order"}. Review and accept the assignment.`,
          userId: tech.user,
          role: "technician",
          referenceId: order._id,
          referenceModel: "Order",
          link: "/technician/orders",
          io: req.app.get("io"),
        }).catch(() => {});
      }
    } catch (_) {}

    // Email notification to technician
    try {
      const User = require("../models/User");
      const { sendTechnicianNotificationEmail } = require("../utils/mailer");
      const techUser = tech.user ? await User.findById(tech.user).lean() : null;
      const techEmail = techUser?.email;
      const techFullName = ((tech.firstName || '') + ' ' + (tech.lastName || '')).trim() || tech.name || 'Technician';

      if (techEmail) {
        const dateLabel = finalScheduledDate ? new Date(finalScheduledDate).toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD';
        const timeLabel = timeSlot || 'TBD';
        const fulfillLabel = order.fulfillmentType === 'delivery_installation' ? 'Delivery + Installation' : 'Delivery Only';
        const productName = (order.items || []).map(i => `${i.modelLine || 'Aircon'} ${i.capacity || ''}${i.capacityUnit || 'HP'}`).join(', ');

        sendTechnicianNotificationEmail({
          to: techEmail,
          technicianName: techFullName,
          customerName: order.customer?.name || 'Customer',
          bookingReference: order.orderReference || `#${String(order._id).slice(-6).toUpperCase()}`,
          serviceName: fulfillLabel,
          dateLabel,
          timeLabel,
          totalLabel: `â‚±${Number(order.total || 0).toLocaleString()}`,
          locationAddress: order.delivery?.address || '',
        }).catch(e => console.warn('Failed to send tech assignment email:', e.message));
      }
    } catch (emailErr) {
      console.warn('Email notification skipped:', emailErr.message);
    }

    emitOrderStatus(req, order);
    res.json({
      message: "Technician assigned successfully",
      order: order.toObject()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/orders/:id/payment â€” Update order payment status (admin/secretary)
 * Body: { paymentStatus: "paid"|"pending"|"failed", note?: string }
 */
router.patch("/:id/payment", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { paymentStatus, note } = req.body;
    if (!paymentStatus) return res.status(400).json({ error: "Payment status is required" });

    const validStatuses = ["pending", "paid", "failed", "partial"];
    if (!validStatuses.includes(paymentStatus)) {
      return res.status(400).json({ error: `Payment status must be one of: ${validStatuses.join(", ")}` });
    }

    session.startTransaction();
    const order = await Order.findById(req.params.id).session(session);
    if (!order) throw new OrderCheckoutError("Order not found", 404, "ORDER_NOT_FOUND");

    if (order.paymentMethod === "cash_onsite" && paymentStatus === "paid") {
      throw new OrderCheckoutError(
        "Cash-on-site payment must be collected through Confirm Pickup so the payment ledger and order complete together.",
        409,
        "ORDER_COUNTER_PAYMENT_REQUIRED",
      );
    }

    const isInitialDeposit = order.status === "pending_payment"
      && Number(order.downpaymentAmount || 0) > 0
      && Number(order.balanceAmount || 0) > 0;
    const effectivePaymentStatus = paymentStatus === "paid" && isInitialDeposit ? "partial" : paymentStatus;

    let paymentRecord = null;
    if (order.paymentId) {
      paymentRecord = await Payment.findById(order.paymentId).session(session);
    }
    if (["paid", "partial"].includes(effectivePaymentStatus)) {
      if (!paymentRecord) {
        throw new OrderCheckoutError(
          "This order has no submitted payment ledger entry to verify.",
          409,
          "ORDER_PAYMENT_LEDGER_MISSING",
        );
      }
      if (["cod", "gcash_full", "gcash_downpayment"].includes(order.paymentMethod) && !paymentRecord.proofUrl) {
        throw new OrderCheckoutError(
          "Payment proof is missing. Ask the customer to submit proof before verification.",
          409,
          "ORDER_PAYMENT_PROOF_MISSING",
        );
      }
    }
    order.paymentStatus = effectivePaymentStatus;

    // If payment is verified and order is still pending_payment, move to preparing_unit
    if (["paid", "partial"].includes(effectivePaymentStatus) && order.status === "pending_payment") {
      order.pushStatus("preparing_unit", note || (effectivePaymentStatus === "partial" ? "Downpayment verified. Order is now being prepared." : "Payment verified. Order is now being prepared."), { actor: req.user && req.user._id, actorRole: req.user && req.user.role, actorName: (req.user && (req.user.name || req.user.email)) || 'System' });
    } else {
      order.pushStatus(order.status, note || `Payment status updated to ${effectivePaymentStatus}`, { actor: req.user && req.user._id, actorRole: req.user && req.user.role, actorName: (req.user && (req.user.name || req.user.email)) || 'System' });
    }

    await order.save({ session });

    if (paymentRecord && ["paid", "partial", "failed"].includes(effectivePaymentStatus)) {
      paymentRecord.status = effectivePaymentStatus;
      paymentRecord.verifiedAt = effectivePaymentStatus === "failed" ? undefined : new Date();
      paymentRecord.verifiedBy = effectivePaymentStatus === "failed" ? undefined : req.user._id;
      paymentRecord.notes = note || paymentRecord.notes;
      paymentRecord.events.push({
        status: effectivePaymentStatus,
        actor: req.user._id,
        actorName: req.user.name || req.user.email || "Administrator",
        actorRole: req.user.role,
        note: note || `Order payment marked ${effectivePaymentStatus}`,
        at: new Date(),
      });
      await paymentRecord.save({ session });
    }

    await session.commitTransaction();

    emitOrderStatus(req, order);
    res.json({ success: true, order: order.toObject(), paymentStatus: effectivePaymentStatus });
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    console.error("PATCH /api/orders/:id/payment error:", err);
    checkoutErrorResponse(res, err);
  } finally {
    await session.endSession();
  }
});

module.exports = router;

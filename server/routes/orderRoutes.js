const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { authenticate, requireRole } = require("../middleware/authenticate");
const Order = require("../models/Order");
const Inventory = require("../models/Inventory");
const Technician = require("../models/Technician");
const TechnicianSchedule = require("../models/TechnicianSchedule");
const BookingService = require("../models/BookingService");
const SiteSetting = require("../models/SiteSetting");
const Payment = require("../models/Payment");
const { getDownpaymentPercentage, calculatePaymentBreakdown } = require("../utils/paymentPolicy");

// ── Multer config for GCash receipt uploads ──────────────────────────────────
const gcashUploadDir = path.join(__dirname, "../public/uploads/gcash-receipts");
if (!fs.existsSync(gcashUploadDir)) {
  fs.mkdirSync(gcashUploadDir, { recursive: true });
}
const gcashStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, gcashUploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const gcashUpload = multer({
  storage: gcashStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are accepted"));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find an available technician for a given date.
 * Checks working days, rest dates, and existing assignment counts.
 * Returns { technician, nextDate } — technician is null when none available.
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

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/orders/all — List all orders (admin/secretary only)
 * Query params: ?status=&fulfillmentType=&search=&from=&to=&page=1&limit=50
 */
router.get("/all", authenticate, requireRole("admin", "secretary"), async (req, res) => {
  try {
    const { status, fulfillmentType, search, from, to, page = 1, limit = 50 } = req.query;
    const filter = {};

    if (status && status !== "all") filter.status = status;
    if (fulfillmentType && fulfillmentType !== "all") filter.fulfillmentType = fulfillmentType;

    if (search) {
      const regex = new RegExp(search, "i");
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
        .populate("technicianId", "name phone")
        .lean(),
      Order.countDocuments(filter),
    ]);

    // Also return summary counts for KPI cards
    const [totalOrders, pending, inProgress, completed, cancelled] = await Promise.all([
      Order.countDocuments({}),
      Order.countDocuments({ status: "pending_payment" }),
      Order.countDocuments({ status: { $in: ["preparing_unit", "ready_for_pickup", "technician_assigned", "out_for_delivery", "arrived", "installing"] } }),
      Order.countDocuments({ status: "completed" }),
      Order.countDocuments({ status: "cancelled" }),
    ]);

    res.json({
      orders,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      kpi: { totalOrders, pending, inProgress, completed, cancelled },
    });
  } catch (err) {
    console.error("GET /api/orders/all error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch orders" });
  }
});

/**
 * POST /api/orders — Create a new aircon order
 */
router.post("/", authenticate, gcashUpload.single("gcashProof"), async (req, res) => {
  try {
    // When submitted as FormData some fields arrive as JSON strings – parse them
    let body = req.body;
    if (typeof body.items === "string") {
      try { body.items = JSON.parse(body.items); } catch (e) {}
    }
    if (typeof body.delivery === "string") {
      try { body.delivery = JSON.parse(body.delivery); } catch (e) {}
    }

    const {
      items,
      fulfillmentType,
      delivery,
      pickupDate,
      paymentMethod,
      technicianId,
      timeSlot,
      transportationFee,
      routeDistanceKm,
      routeDurationMin,
      gcashNumber,
    } = body;

    if (!items || !items.length) {
      return res.status(400).json({ error: "At least one item is required" });
    }
    if (!fulfillmentType) {
      return res.status(400).json({ error: "Fulfillment type is required" });
    }
    if ((paymentMethod === "cod" || paymentMethod === "gcash_full") && !req.file) {
      return res.status(400).json({ error: "A GCash receipt screenshot is required for this payment method." });
    }

    // Fetch dynamic rates
    const [settingF, settingI, downpaymentPercentage] = await Promise.all([
      SiteSetting.findOne({ key: "farePerKm" }).lean(),
      SiteSetting.findOne({ key: "airconInstallFee" }).lean(),
      getDownpaymentPercentage(),
    ]);
    const fareRaw = settingF && settingF.value != null ? parseFloat(settingF.value) : NaN;
    const installRaw = settingI && settingI.value != null ? parseFloat(settingI.value) : NaN;
    const defaultFare = !isNaN(fareRaw) ? fareRaw : 40;
    const defaultInstall = !isNaN(installRaw) ? installRaw : 1500;

    // Validate & enrich items from inventory
    // ... (rest of the enrichment logic) ...
    const enrichedItems = [];
    for (const item of items) {
      let inv = await Inventory.findById(item.inventoryId)
        .populate("brand", "name")
        .lean();
      
      const HVACProduct = require("../models/HVACProduct");
      if (!inv) {
        // Try looking up as an HVACProduct variant
        const hvacDoc = await HVACProduct.findOne({ "variants._id": item.inventoryId }).populate("brand", "name").lean();
        if (hvacDoc) {
          const hvacVariant = hvacDoc.variants.find(v => v._id.toString() === item.inventoryId.toString());
          if (hvacVariant) {
            inv = {
              _id: hvacVariant._id,
              modelLine: hvacDoc.modelLine,
              brand: hvacDoc.brand,
              capacity: hvacVariant.capacity,
              capacityUnit: hvacVariant.capacityUnit,
              sellingPrice: hvacVariant.sellingPrice,
              quantity: hvacVariant.quantity,
              status: hvacVariant.status,
              imageUrl: hvacDoc.imageUrl,
              isHvac: true,
              parentHvacId: hvacDoc._id
            };
          }
        }
      }

      if (!inv) {
        return res.status(400).json({ error: `Product not found: ${item.inventoryId}` });
      }
      
      if (inv.status === "out_of_stock" || inv.quantity < (item.quantity || 1)) {
        return res.status(400).json({
          error: `Insufficient stock for ${inv.modelLine} ${inv.capacity} ${inv.capacityUnit || "HP"}`,
        });
      }

      const qty = item.quantity || 1;
      enrichedItems.push({
        inventoryId: inv._id,
        modelLine: inv.modelLine,
        brand: inv.brand ? (inv.brand.name || inv.brand) : "",
        capacity: inv.capacity,
        capacityUnit: inv.capacityUnit || "HP",
        quantity: qty,
        unitPrice: inv.sellingPrice || 0,
        totalPrice: (inv.sellingPrice || 0) * qty,
        imageUrl: inv.imageUrl || "/images/products/default.png",
        isHvac: inv.isHvac || false,
        parentHvacId: inv.parentHvacId || null
      });
    }

    // Build order
    const orderData = {
      userId: req.user._id,
      items: enrichedItems,
      fulfillmentType,
      paymentMethod: paymentMethod || "cod",
      timeSlot: timeSlot || null,
      transportationFee: Number(transportationFee) || 0,
      routeDistanceKm: Number(routeDistanceKm) || 0,
      routeDurationMin: Number(routeDurationMin) || 0,
    };

    // GCash payment details (manual receipt upload flow)
    if (gcashNumber) orderData.gcashNumber = gcashNumber;
    if (req.file) {
      orderData.gcashProofUrl = "/uploads/gcash-receipts/" + req.file.filename;
    }

    // Delivery/Installation fee logic
    if (fulfillmentType === "customer_pickup") {
      orderData.deliveryFee = 0;
      orderData.installationFee = 0;
    } else {
      orderData.deliveryFee = 0; // We use transportationFee instead for dynamic distance-based pricing
      orderData.installationFee = (fulfillmentType === "delivery_installation") ? defaultInstall : 0;
    }

    // Set delivery/pickup info
    if (fulfillmentType !== "customer_pickup" && delivery) {
      orderData.delivery = {
        address: delivery.address || "",
        contactNumber: delivery.contactNumber || "",
        preferredDate: delivery.preferredDate ? new Date(delivery.preferredDate) : null,
        notes: delivery.notes || "",
      };
      if (delivery.coordinates) {
        orderData.delivery.coordinates = {
          type: "Point",
          coordinates: [
            delivery.coordinates.lng || delivery.coordinates[0] || 0,
            delivery.coordinates.lat || delivery.coordinates[1] || 0,
          ],
        };
      }
    } else if (fulfillmentType === "customer_pickup") {
      orderData.pickupDate = pickupDate ? new Date(pickupDate) : null;
    }

    const calculatedOrderTotal = enrichedItems.reduce((sum, item) => sum + item.totalPrice, 0)
      + orderData.deliveryFee
      + orderData.installationFee
      + orderData.transportationFee;
    if (paymentMethod === "cod" || paymentMethod === "gcash_downpayment" || paymentMethod === "downpayment") {
      const paymentBreakdown = calculatePaymentBreakdown(calculatedOrderTotal, downpaymentPercentage);
      orderData.downpaymentPercentage = paymentBreakdown.downpaymentPercentage;
      orderData.downpaymentAmount = paymentBreakdown.downpaymentAmount;
      orderData.balanceAmount = paymentBreakdown.balanceAmount;
    } else if (paymentMethod === "gcash_full") {
      orderData.downpaymentPercentage = 100;
      orderData.downpaymentAmount = calculatedOrderTotal;
      orderData.balanceAmount = 0;
    }

    // Technician is NOT assigned at order creation — admin assigns after confirming
    // Status always starts as pending_payment

    // Create order
    const order = new Order(orderData);
    await order.save();

    // Decrement inventory stock
    for (const item of enrichedItems) {
      if (item.isHvac) {
        const HVACProduct = require("../models/HVACProduct");
        await HVACProduct.findOneAndUpdate(
          { _id: item.parentHvacId, "variants._id": item.inventoryId },
          { $inc: { "variants.$.quantity": -item.quantity } }
        );
      } else {
        await Inventory.findByIdAndUpdate(item.inventoryId, {
          $inc: { quantity: -item.quantity },
        });
      }
    }

    // Manual GCash receipts enter the same verification queue as service
    // booking receipts. The amount comes from the saved policy snapshot.
    if (req.file && (paymentMethod === "cod" || paymentMethod === "gcash_full")) {
      const isDownpayment = paymentMethod === "cod";
      const paymentRecord = await Payment.create({
        orderId: order._id,
        amount: isDownpayment ? order.downpaymentAmount : order.total,
        method: "gcash",
        type: isDownpayment ? "downpayment" : "final",
        gateway: "gcash",
        reference: gcashNumber || undefined,
        proofUrl: order.gcashProofUrl,
        status: "pending",
        notes: isDownpayment
          ? `${order.downpaymentPercentage}% order downpayment submitted for verification`
          : "Full order payment submitted for verification",
      });
      order.paymentId = paymentRecord._id;
      await order.save();
    }

    // BookingService is NOT created at order creation — created when admin assigns technician

    // --- PAYMONGO PAYMENT INTEGRATION ---
    let checkoutUrl = null;

    // The checkout UI uses manual GCash receipt verification for gcash_full.
    // Only the legacy gateway-specific option should create a PayMongo source.
    if (paymentMethod === "gcash_downpayment") {
       // Calculate required amount
       const itemTotal = enrichedItems.reduce((sum, item) => sum + item.totalPrice, 0);
       const subTotal = itemTotal + orderData.transportationFee + orderData.installationFee;
       
       let paymentAmount = subTotal;
       if (paymentMethod === "gcash_downpayment") {
          paymentAmount = order.downpaymentAmount;
       }

       // Convert to centavos
       const amountInCents = Math.round(paymentAmount * 100);

       // Create PayMongo GCash Source
       try {
          const sourceData = await createGcashSource(
            amountInCents,
            { name: req.user.name, email: req.user.email, phone: req.user.phone },
            `/purchase-history?payment=success&orderId=${order._id}`,
            `/cart?payment=failed&orderId=${order._id}`
          );

          checkoutUrl = sourceData.data.attributes.checkout_url;
          const sourceId = sourceData.data.id;

          // Create pending payment record
          const paymentRecord = new Payment({
             // Link to order ID instead of bookingId for an order
             // Note: Payment schema usually expects bookingId, but we can repurpose or link. We might need to adjust Payment schema slightly if it strictly references bookingId.
             bookingId: order.bookingId || null, 
             orderId: order._id, // Assumes Payment schema supports this, will add it if not
             amount: paymentAmount,
             paymentMethod: "paymongo",
             gatewayDetails: {
                sourceId: sourceId,
                type: "gcash"
             },
             paymentType: paymentMethod === "gcash_full" ? "final" : "downpayment",
             status: "pending"
          });
          await paymentRecord.save();

          // Link to order and update status
          order.paymentId = paymentRecord._id;
          order.status = "pending_payment";
          await order.save();

       } catch (pmError) {
          console.error("PayMongo Error:", pmError);
          // We created the order, but PayMongo failed. Return a partial success indicating order exists but unpaid.
          return res.status(201).json({
             success: true,
             order: order.toObject(),
             error: "Order created but failed to generate payment link. Please contact support."
          });
       }
    }

    res.status(201).json({
      success: true,
      order: order.toObject(),
      checkoutUrl
    });
  } catch (err) {
    console.error("POST /api/orders error:", err);
    res.status(500).json({ error: err.message || "Failed to create order" });
  }
});

/**
 * GET /api/orders/my — Get current user's orders
 */
router.get("/my", authenticate, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .populate("technicianId", "name phone")
      .lean();
    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/orders/technician/tasks — Get tasks for logged-in technician
 */
router.get("/technician/tasks", authenticate, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/orders/technician/all — All orders for logged-in technician (paginated, filterable)
 * Query: status, fulfillmentType, search, from, to, page, limit
 */
router.get("/technician/all", authenticate, async (req, res) => {
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
      const regex = new RegExp(search, "i");
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
 * GET /api/orders/:id/eligible-technicians — Get eligible technicians for an order
 */
router.get("/:id/eligible-technicians", authenticate, requireRole("admin", "secretary"), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ error: "Order not found" });

    const orderLoc = order.delivery?.coordinates?.coordinates; // [lng, lat]
    const orderLat = orderLoc ? orderLoc[1] : null;
    const orderLng = orderLoc ? orderLoc[0] : null;

    // Get active workload count per technician
    const activeOrders = await Order.find({
      status: { $in: ["technician_assigned", "out_for_delivery", "arrived", "installing"] },
      "technician.technicianId": { $exists: true },
    })
      .select("technician.technicianId")
      .lean();
    const workloadMap = {};
    activeOrders.forEach(o => {
      const tid = o.technician?.technicianId?.toString();
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

      // Normalise status — treat blank/null as 'offline' (new technician or unset)
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
        // Available, Offline, Unknown/blank — all go into selectable list
        available.push(techInfo);
      }
    }

    // Sort available by AI score — genuinely rank by best fit
    const scoreTech = (t) => {
      let score = 0;
      const status = (t.availabilityStatus || '').toLowerCase();
      // Availability is the strongest signal: never recommend an offline/busy tech
      // when an available one exists.
      if (status === 'available') score += 100;
      else if (status === 'online') score += 60;
      else score += 0; // offline / unknown — heavily deprioritised
      // Rating (0–5) weighted
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
 * GET /api/orders/check-availability — Check technician availability
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
 * GET /api/orders/:id — Get single order
 */
router.get("/:id", authenticate, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate("technicianId", "name phone")
      .lean();
    if (!order) return res.status(404).json({ error: "Order not found" });

    // only allow owner or admin/tech to view
    const isOwner = order.userId.toString() === req.user._id.toString();
    const isStaff = ["admin", "secretary", "technician"].includes(req.user.role);
    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/:id/accept — Technician accepts their assigned order
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
    res.json({ success: true, order: order.toObject() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/:id/decline — Technician declines their assigned order
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
    res.json({ success: true, order: order.toObject() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/orders/:id/status — Update order status
 */
router.patch("/:id/status", authenticate, async (req, res) => {
  try {
    const { status, note } = req.body;
    if (!status) return res.status(400).json({ error: "Status is required" });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // allow admin, secretary, technician, or owner (for cancellation)
    const isOwner = order.userId.toString() === req.user._id.toString();
    const isStaff = ["admin", "secretary", "technician"].includes(req.user.role);
    if (!isOwner && !isStaff) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (isOwner && !isStaff && status !== "cancelled") {
      return res.status(403).json({ error: "Customers can only cancel orders" });
    }

    const wasCancelled = status === "cancelled" && order.status !== "cancelled";

    order.pushStatus(status, note || "", { actor: req.user && req.user._id, actorRole: req.user && req.user.role, actorName: (req.user && (req.user.name || req.user.email)) || 'System' });
    await order.save();

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
 * POST /api/orders/:id/mark-ready-for-pickup — Admin marks a customer_pickup order as ready
 * Transitions: preparing_unit → ready_for_pickup
 */
router.post("/:id/mark-ready-for-pickup", authenticate, requireRole("admin", "secretary"), async (req, res) => {
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
    res.json({ success: true, order: order.toObject() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/orders/:id/confirm-pickup — Admin confirms customer has picked up the unit
 * Transitions: ready_for_pickup → completed
 */
router.post("/:id/confirm-pickup", authenticate, requireRole("admin", "secretary"), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.fulfillmentType !== "customer_pickup") {
      return res.status(400).json({ error: "This endpoint is only for customer pickup orders." });
    }
    if (order.status !== "ready_for_pickup") {
      return res.status(400).json({ error: `Order must be in "ready_for_pickup" status. Current: ${order.status}` });
    }
    order.pushStatus("completed", req.body.note || "Customer has picked up the unit", {
      actor: req.user && req.user._id, actorRole: req.user && req.user.role,
      actorName: (req.user && (req.user.name || req.user.email)) || "System"
    });
    await order.save();
    res.json({ success: true, order: order.toObject() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * POST /api/orders/:id/cancel — Cancel order (admin/secretary/customer for own pending orders)
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

    // Build cancellation note with reason
    let cancelNote = `Cancelled by ${isOwner ? "customer" : req.user.role}`;
    if (reason && reason.trim()) {
      cancelNote += `. Reason: ${reason.trim()}`;
    }

    order.pushStatus("cancelled", cancelNote, { actor: req.user && req.user._id, actorRole: req.user && req.user.role, actorName: (req.user && (req.user.name || req.user.email)) || 'System' });

    // Store cancellation reason if order has that field
    if (reason && reason.trim()) {
      order.cancellationReason = reason.trim();
    }

    await order.save();

    // Restore inventory stock for cancelled orders
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

    // Clean up associated BookingService if any
    if (order.bookingId) {
      try {
        const BookingService = require("../models/BookingService");
        await BookingService.findByIdAndUpdate(order.bookingId, {
          status: "cancelled",
          notes: `Order cancelled: ${reason || "No reason provided"}`
        });
      } catch (bookingErr) {
        console.error("Failed to update booking on cancel:", bookingErr.message);
      }
    }

    res.json({ message: "Order cancelled", order: order.toObject() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/:id/reschedule-request — Submit reschedule request (customer for own pending orders)
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
    if (!requestedDate || !requestedTime || !reason) {
      return res.status(400).json({ error: "Requested date, time, and reason are required" });
    }

    // Store reschedule request
    order.rescheduleRequest = {
      requested: true,
      requestedDate: requestedDate,
      requestedTime: requestedTime,
      reason: reason,
      requestedBy: req.user._id,
      requestedAt: new Date(),
      status: "pending" // pending, approved, rejected
    };

    await order.save();

    res.json({
      message: "Reschedule request submitted successfully",
      order: order.toObject()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/:id/reschedule-approve — Approve reschedule request (admin/secretary)
 */
router.post("/:id/reschedule-approve", authenticate, requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Check if there's a pending reschedule request
    if (!order.rescheduleRequest || order.rescheduleRequest.status !== "pending") {
      return res.status(400).json({ error: "No pending reschedule request found" });
    }

    // Update order with new date/time
    order.delivery = order.delivery || {};
    order.delivery.preferredDate = new Date(order.rescheduleRequest.requestedDate);
    order.timeSlot = order.rescheduleRequest.requestedTime;

    // Update reschedule request status
    order.rescheduleRequest.status = "approved";
    order.rescheduleRequest.processedBy = req.user._id;
    order.rescheduleRequest.processedAt = new Date();

    // Add to status history
    order.pushStatus("preparing_unit", `Rescheduled to ${order.rescheduleRequest.requestedDate} at ${order.rescheduleRequest.requestedTime}`, { actor: req.user && req.user._id, actorRole: req.user && req.user.role, actorName: (req.user && (req.user.name || req.user.email)) || 'System' });

    await order.save();

    res.json({
      message: "Reschedule request approved",
      order: order.toObject()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/:id/reschedule-reject — Reject reschedule request (admin/secretary)
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

    res.json({
      message: "Reschedule request rejected",
      order: order.toObject()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/orders/:id/assign-technician
 * Admin assigns a technician to a confirmed order.
 * Status: pending_payment or preparing_unit → technician_assigned
 * Also creates BookingService for delivery_installation orders.
 */
router.post("/:id/assign-technician", authenticate, requireRole("admin", "secretary"), async (req, res) => {
  try {
    const { id } = req.params;
    const { technicianId, scheduledDate, timeSlot, note } = req.body;

    if (!technicianId) return res.status(400).json({ error: "Technician ID is required" });

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Use the scheduledDate if given, otherwise fall back to order's existing preferredDate
    const finalScheduledDate = scheduledDate || (order.delivery && order.delivery.preferredDate
      ? new Date(order.delivery.preferredDate).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10));

    const assignableStatuses = ["pending_payment", "preparing_unit", "technician_declined"];
    if (!assignableStatuses.includes(order.status)) {
      return res.status(400).json({
        error: `Cannot assign technician from status "${order.status}". Order must be in: ${assignableStatuses.join(", ")}.`
      });
    }

    if (order.technicianId && order.status !== "technician_declined") {
      return res.status(400).json({ error: "Order already has a technician assigned. Use reassign if needed." });
    }

    const tech = await Technician.findById(technicianId);
    if (!tech) return res.status(404).json({ error: "Technician not found" });

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

    // If delivery + installation, create BookingService entry
    if (order.fulfillmentType === "delivery_installation") {
      try {
        const booking = new BookingService({
          customerId: order.userId,
          technicianId: tech._id,
          bookingDate: new Date(finalScheduledDate),
          startTime: timeSlot || "09:00",
          endTime: timeSlot ? (parseInt(timeSlot.split(':')[0]) + 2).toString().padStart(2, '0') + ':00' : "11:00",
          status: "scheduled",
          paymentMethod: order.paymentMethod || "cod",
          location: order.delivery
            ? {
                address: order.delivery.address,
                coordinates: order.delivery.coordinates,
              }
            : undefined,
        });
        await booking.save();
        order.bookingId = booking._id;
        await order.save();
      } catch (e) {
        console.error("Failed to create installation booking:", e.message);
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
          totalLabel: `₱${Number(order.total || 0).toLocaleString()}`,
          locationAddress: order.delivery?.address || '',
        }).catch(e => console.warn('Failed to send tech assignment email:', e.message));
      }
    } catch (emailErr) {
      console.warn('Email notification skipped:', emailErr.message);
    }

    res.json({
      message: "Technician assigned successfully",
      order: order.toObject()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/orders/:id/payment — Update order payment status (admin/secretary)
 * Body: { paymentStatus: "paid"|"pending"|"failed", note?: string }
 */
router.patch("/:id/payment", authenticate, requireRole("admin", "secretary"), async (req, res) => {
  try {
    const { paymentStatus, note } = req.body;
    if (!paymentStatus) return res.status(400).json({ error: "Payment status is required" });

    const validStatuses = ["pending", "paid", "failed", "partial"];
    if (!validStatuses.includes(paymentStatus)) {
      return res.status(400).json({ error: `Payment status must be one of: ${validStatuses.join(", ")}` });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    const isInitialDeposit = order.status === "pending_payment"
      && Number(order.downpaymentAmount || 0) > 0
      && Number(order.balanceAmount || 0) > 0;
    const effectivePaymentStatus = paymentStatus === "paid" && isInitialDeposit ? "partial" : paymentStatus;
    order.paymentStatus = effectivePaymentStatus;

    // If payment is verified and order is still pending_payment, move to preparing_unit
    if (["paid", "partial"].includes(effectivePaymentStatus) && order.status === "pending_payment") {
      order.pushStatus("preparing_unit", note || (effectivePaymentStatus === "partial" ? "Downpayment verified. Order is now being prepared." : "Payment verified. Order is now being prepared."), { actor: req.user && req.user._id, actorRole: req.user && req.user.role, actorName: (req.user && (req.user.name || req.user.email)) || 'System' });
    } else {
      order.pushStatus(order.status, note || `Payment status updated to ${effectivePaymentStatus}`, { actor: req.user && req.user._id, actorRole: req.user && req.user.role, actorName: (req.user && (req.user.name || req.user.email)) || 'System' });
    }

    await order.save();

    if (order.paymentId && ["paid", "partial", "failed"].includes(effectivePaymentStatus)) {
      await Payment.findByIdAndUpdate(order.paymentId, {
        $set: {
          status: effectivePaymentStatus,
          verifiedAt: effectivePaymentStatus === "failed" ? undefined : new Date(),
          verifiedBy: effectivePaymentStatus === "failed" ? undefined : req.user._id,
          notes: note || undefined,
        },
      });
    }

    res.json({ success: true, order: order.toObject(), paymentStatus: effectivePaymentStatus });
  } catch (err) {
    console.error("PATCH /api/orders/:id/payment error:", err);
    res.status(500).json({ error: err.message || "Failed to update payment status" });
  }
});

module.exports = router;

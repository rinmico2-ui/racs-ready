const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Tool = require("../models/Tool");
const HVACProduct = require("../models/HVACProduct");
const Inventory = require("../models/Inventory");
const WalkInSale = require("../models/WalkInSale");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const User = require("../models/User");
const Technician = require("../models/Technician");
const BookingService = require("../models/BookingService");
const auth = require("../middleware/authenticate");
const { escapeRegex } = require("../utils/stringSecurity");
const {
  OrderCheckoutError,
  authoritativeDeliveryQuote,
  parseDateOnly,
  validateCheckoutItems,
  validatePickupDate,
} = require("../utils/orderCheckoutPolicy");
const { getOrderCheckoutSettings } = require("../utils/orderCheckoutSettings");
const { buildOrderWarrantySnapshot } = require("../utils/orderWarrantyPolicy");
const { getAftercarePolicy, warrantyRuleForOrder } = require("../utils/aftercarePolicy");
const { addMinutesToClock } = require("../utils/clockTime");
const {
  CustomerInvitationError,
  provisionWalkInCustomer,
} = require("../utils/customerAccountInvitation");

router.use(auth.authenticate, auth.requireRole("admin"));

// ─── Auth middleware (admin only) ─────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

function posOrderError(message, status = 400, code = "POS_AIRCON_ORDER_INVALID") {
  return new OrderCheckoutError(message, status, code);
}

function normalizedCustomer(value = {}) {
  const name = String(value.name || "").trim().replace(/\s+/g, " ").slice(0, 160);
  const email = String(value.email || "").trim().toLowerCase().slice(0, 254);
  const phone = String(value.phone || "").replace(/\D+/g, "").slice(0, 15);
  if (name.length < 2) throw posOrderError("Customer name is required for an aircon purchase.", 400, "POS_CUSTOMER_NAME_REQUIRED");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw posOrderError("A valid customer email is required for warranty access.", 400, "POS_CUSTOMER_EMAIL_REQUIRED");
  if (phone.length < 7) throw posOrderError("A valid customer phone number is required.", 400, "POS_CUSTOMER_PHONE_REQUIRED");
  const parts = name.split(" ");
  return {
    name,
    email,
    phone,
    firstName: parts.shift() || "Walk-in",
    lastName: parts.join(" ") || "Customer",
    address: String(value.address || "").trim().slice(0, 500),
  };
}

function paymentMapping(method) {
  const value = String(method || "").trim();
  const map = {
    cash: { order: "cash", payment: "cash", gateway: "cod" },
    gcash: { order: "gcash_full", payment: "gcash", gateway: "gcash" },
    maya: { order: "other", payment: "other", gateway: "other" },
    card: { order: "other", payment: "other", gateway: "other" },
    bank_transfer: { order: "other", payment: "bank", gateway: "bank" },
  };
  if (!map[value]) throw posOrderError("Choose a supported payment method.", 400, "POS_PAYMENT_METHOD_INVALID");
  return { ...map[value], source: value };
}

function normalizedSerialNumbers(values) {
  const result = (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim().slice(0, 120))
    .filter(Boolean);
  if (new Set(result.map((value) => value.toLowerCase())).size !== result.length) {
    throw posOrderError("Every aircon unit must have a unique serial number.", 400, "POS_SERIAL_DUPLICATE");
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pos/tools/generate-barcodes — Generate barcodes for all tools missing them
// ─────────────────────────────────────────────────────────────────────────────
router.post("/tools/generate-barcodes", async (req, res) => {
  try {
    const tools = await Tool.find({
      $and: [Tool.merchandiseFilter(), { $or: [{ barcode: { $exists: false } }, { barcode: "" }, { barcode: null }] }],
    }).lean();
    let updated = 0;
    for (const t of tools) {
      const base = `TOOL${t._id.toString().slice(-8).toUpperCase()}`;
      let candidate = base;
      let suffix = 0;
      while (await Tool.findOne({ barcode: candidate })) {
        suffix += 1;
        candidate = `${base}-${suffix}`;
      }
      await Tool.updateOne({ _id: t._id }, { $set: { barcode: candidate } });
      updated++;
    }
    res.json({ message: `Generated ${updated} barcodes`, updated });
  } catch (err) {
    console.error("Generate barcodes error:", err);
    res.status(500).json({ error: "Failed to generate barcodes" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/tools — Search available parts/tools for POS
// ─────────────────────────────────────────────────────────────────────────────
router.get("/tools", async (req, res) => {
  try {
    const { q, category, page = 1, limit = 50 } = req.query;
    const filter = { active: true, isStockItem: true, status: { $ne: "discontinued" }, $and: [Tool.merchandiseFilter()] };

    if (q && q.trim()) {
      const regex = new RegExp(escapeRegex(q.trim()), "i");
      filter.$or = [
        { itemName: regex },
        { barcode: regex },
        { category: regex },
        { specification: regex },
      ];
    }
    if (category && category.trim()) {
      filter.category = category.trim();
    }

    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
    const [tools, total] = await Promise.all([
      Tool.find(filter)
        .sort({ itemName: 1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Tool.countDocuments(filter),
    ]);

    // Return only available stock (quantity - reserved)
    const availableTools = tools.map((t) => ({
      _id: t._id,
      itemName: t.itemName,
      category: t.category,
      unit: t.unit,
      barcode: t.barcode,
      serialNumber: t.serialNumber,
      sellingPrice: t.sellingPrice,
      costPrice: t.costPrice,
      available: Math.max(0, (t.quantity || 0) - (t.reservedQuantity || 0)),
      quantity: t.quantity,
      specification: t.specification,
    }));

    res.json({ tools: availableTools, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    console.error("POS tools search error:", err);
    res.status(500).json({ error: "Failed to load parts" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/tools/barcode/:barcode — Lookup by barcode (searches Tools + Aircons + Inventory)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/tools/barcode/:barcode", async (req, res) => {
  try {
    const barcode = req.params.barcode;

    // 1. Try Tool collection first
    const tool = await Tool.findOne({ barcode, active: true, isStockItem: true, $and: [Tool.merchandiseFilter()] }).lean();
    if (tool) {
      const available = Math.max(0, (tool.quantity || 0) - (tool.reservedQuantity || 0));
      if (available <= 0) return res.status(400).json({ error: "Item is out of stock" });
      return res.json({
        _id: tool._id, itemName: tool.itemName, category: tool.category, unit: tool.unit,
        barcode: tool.barcode, serialNumber: tool.serialNumber,
        sellingPrice: tool.sellingPrice, costPrice: tool.costPrice,
        available, source: "tool",
      });
    }

    return res.status(404).json({
      error: "Part or tool not found. Aircon orders are created from Walk-in Appointments.",
      code: "POS_MERCHANDISE_ONLY",
    });
  } catch (err) {
    console.error("POS barcode lookup error:", err);
    res.status(500).json({ error: "Failed to lookup barcode" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/aircons — List aircon units for POS (flattened from HVACProduct variants)
// ─────────────────────────────────────────────────────────────────────────────
async function listAircons(req, res) {
  try {
    const { q, brand, type } = req.query;
    const filter = { active: true };

    // Build variant-level match
    const variantMatch = {};
    if (q && q.trim()) {
      const regex = new RegExp(escapeRegex(q.trim()), "i");
      variantMatch.$or = [
        { "variants.barcode": regex },
        { "variants.sku": regex },
      ];
      filter.$or = [
        { modelLine: regex },
        { description: regex },
        variantMatch,
      ];
    }

    // Fetch all active HVACProducts
    const products = await HVACProduct.find(filter)
      .populate("brand", "name")
      .populate("category", "name")
      .sort({ modelLine: 1 })
      .lean();

    // Flatten variants into individual sellable items
    const items = [];
    for (const p of products) {
      if (!p.variants || !p.variants.length) continue;
      for (const v of p.variants) {
        if (v.active === false) continue;
        const available = v.quantity || 0;
        if (available <= 0) continue; // Skip out-of-stock

        // Apply brand/type filter after population
        if (brand && p.brand && p.brand.name !== brand) continue;
        if (type && p.type !== type) continue;

        items.push({
          _id: v._id,
          parentHvacId: p._id,
          itemName: `${p.modelLine} ${v.capacity}${v.capacityUnit || "HP"}`,
          modelLine: p.modelLine,
          brand: p.brand ? p.brand.name : "",
          category: p.type || "Aircon",
          type: p.type,
          capacity: v.capacity,
          capacityUnit: v.capacityUnit || "HP",
          btu: v.btu || 0,
          inverter: p.inverter,
          barcode: v.barcode || "",
          sku: v.sku || "",
          sellingPrice: v.sellingPrice || 0,
          costPrice: v.costPrice || 0,
          available,
          unit: "unit",
          imageUrl: p.imageUrl || "",
          warranty: p.specifications?.warranty || "1 Year Compressor, 1 Year Parts",
        });
      }
    }

    res.json({ items, total: items.length });
  } catch (err) {
    console.error("POS aircons error:", err);
    res.status(500).json({ error: "Failed to load aircons" });
  }
}
router.get("/aircons", listAircons);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/aircon-brands — Distinct brands from HVAC products
// ─────────────────────────────────────────────────────────────────────────────
router.get("/aircon-brands", async (req, res) => {
  try {
    const products = await HVACProduct.find({ active: true }).populate("brand", "name").lean();
    const brands = [...new Set(products.map(p => p.brand?.name).filter(Boolean))].sort();
    res.json({ brands });
  } catch (err) {
    res.status(500).json({ error: "Failed to load brands" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pos/aircon-generate-barcodes — Generate barcodes for aircon variants missing them
// ─────────────────────────────────────────────────────────────────────────────
router.post("/aircon-generate-barcodes", requireAdmin, async (req, res) => {
  try {
    let updated = 0;
    const products = await HVACProduct.find({ active: true });
    for (const p of products) {
      let changed = false;
      for (const v of p.variants) {
        if (!v.barcode) {
          const base = `AC${p._id.toString().slice(-6).toUpperCase()}${v.capacity.replace(".", "")}HP`;
          let candidate = base;
          let suffix = 0;
          while (await HVACProduct.findOne({ "variants.barcode": candidate })) {
            suffix += 1;
            candidate = `${base}-${suffix}`;
          }
          v.barcode = candidate;
          changed = true;
          updated++;
        }
      }
      if (changed) await p.save();
    }
    res.json({ message: `Generated ${updated} aircon barcodes`, updated });
  } catch (err) {
    console.error("Aircon barcode gen error:", err);
    res.status(500).json({ error: "Failed to generate barcodes" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/categories — List distinct categories
// ─────────────────────────────────────────────────────────────────────────────
router.get("/categories", async (req, res) => {
  try {
    const categories = await Tool.distinct("category", {
      active: true,
      isStockItem: true,
      status: { $ne: "discontinued" },
      $and: [Tool.merchandiseFilter()],
    });
    res.json({ categories: categories.filter(Boolean).sort() });
  } catch (err) {
    res.status(500).json({ error: "Failed to load categories" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pos/aircon-quote — Counter quote for delivery + installation
// ─────────────────────────────────────────────────────────────────────────────
async function quoteAirconOrder(req, res) {
  try {
    const fulfillmentType = String(req.body?.fulfillmentType || "");
    if (fulfillmentType !== "delivery_installation") {
      return res.json({ transportationFee: 0, installationFee: 0, distanceKm: 0, durationMin: 0 });
    }
    const settings = await getOrderCheckoutSettings();
    const quote = await authoritativeDeliveryQuote({
      origin: settings.companyLocation,
      destination: req.body?.coordinates,
      farePerKm: settings.farePerKm,
    });
    return res.json({
      ...quote,
      installationFee: settings.installationFee,
      additionalTotal: quote.transportationFee + settings.installationFee,
    });
  } catch (error) {
    return res.status(Number(error.status) || 400).json({ error: error.message, code: error.code });
  }
}
router.post("/aircon-quote", quoteAirconOrder);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pos/aircon-checkout — Create a walk-in Order, never a WalkInSale
// ─────────────────────────────────────────────────────────────────────────────
async function checkoutAirconOrder(req, res) {
  let session;
  try {
    const customer = normalizedCustomer(req.body?.customer);
    const accountConsent = req.body?.accountConsent === true;
    const payment = paymentMapping(req.body?.paymentMethod);
    const checkoutRequestId = String(req.body?.checkoutRequestId || "").trim();
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(checkoutRequestId)) {
      throw posOrderError("The checkout request is invalid. Refresh the POS and try again.", 400, "POS_CHECKOUT_ID_INVALID");
    }
    const existingCustomer = await User.findOne({ email: customer.email, role: "customer" }).select("_id").lean();
    if (existingCustomer) {
      const existingOrder = await Order.findOne({
        userId: existingCustomer._id,
        checkoutRequestId,
        salesChannel: "walk_in",
      }).lean();
      if (existingOrder) {
        return res.json({ success: true, duplicate: true, order: existingOrder, customerAccountCreated: false });
      }
    }

    const paymentReference = String(req.body?.paymentReference || "").trim().slice(0, 160);
    if (payment.source !== "cash" && paymentReference.length < 4) {
      throw posOrderError("Record the electronic payment or card authorization reference.", 400, "POS_PAYMENT_REFERENCE_REQUIRED");
    }

    const requestedItems = validateCheckoutItems(
      (req.body?.items || []).map((item) => ({ inventoryId: item?.toolId || item?.inventoryId, quantity: item?.quantity })),
    );
    const fulfillmentChoice = String(req.body?.fulfillmentType || "").trim();
    if (!["carry_out", "customer_pickup", "delivery_installation"].includes(fulfillmentChoice)) {
      throw posOrderError("Choose carry-out, pickup later, or delivery with installation.", 400, "POS_FULFILLMENT_REQUIRED");
    }

    const settings = await getOrderCheckoutSettings();
    const enrichedItems = [];
    for (const requestedItem of requestedItems) {
      const product = await HVACProduct.findOne({ "variants._id": requestedItem.inventoryId })
        .populate("brand", "name")
        .lean();
      const variant = product?.variants?.find((row) => String(row._id) === requestedItem.inventoryId);
      if (!product || !variant || variant.active === false || Number(variant.quantity || 0) < requestedItem.quantity) {
        throw posOrderError("One of the selected aircon units is no longer available in the requested quantity.", 409, "POS_AIRCON_STOCK_UNAVAILABLE");
      }
      const unitPrice = Math.max(0, Number(variant.sellingPrice) || 0);
      enrichedItems.push({
        inventoryId: variant._id,
        modelLine: product.modelLine,
        brand: product.brand?.name || product.brand || "",
        capacity: variant.capacity,
        capacityUnit: variant.capacityUnit || "HP",
        quantity: requestedItem.quantity,
        unitPrice,
        totalPrice: unitPrice * requestedItem.quantity,
        imageUrl: product.imageUrl || "/images/products/default.png",
        isHvac: true,
        parentHvacId: product._id,
        manufacturerWarranty: product.specifications?.warranty || "",
        serialNumbers: [],
      });
    }

    const totalUnits = enrichedItems.reduce((sum, item) => sum + item.quantity, 0);
    const serialNumbers = normalizedSerialNumbers(req.body?.serialNumbers);
    if (fulfillmentChoice === "carry_out" && serialNumbers.length !== totalUnits) {
      throw posOrderError(`Record exactly ${totalUnits} unit serial number(s) before immediate handover.`, 400, "POS_SERIALS_REQUIRED");
    }

    let fulfillmentType = "customer_pickup";
    let pickupDate = null;
    let delivery = null;
    let timeSlot = null;
    let transportationFee = 0;
    let routeDistanceKm = 0;
    let routeDurationMin = 0;
    let installationFee = 0;
    let selectedTechnician = null;
    if (fulfillmentChoice === "carry_out") {
      pickupDate = new Date();
    } else if (fulfillmentChoice === "customer_pickup") {
      pickupDate = validatePickupDate(req.body?.pickupDate, settings.storeHours);
    } else {
      fulfillmentType = "delivery_installation";
      const technicianId = String(req.body?.technicianId || "").trim();
      if (!mongoose.isValidObjectId(technicianId)) {
        throw posOrderError("Choose an available technician for this installation.", 400, "POS_TECHNICIAN_REQUIRED");
      }
      selectedTechnician = await Technician.findOne({ _id: technicianId, active: true })
        .populate({ path: "user", select: "firstName lastName email phone active blocked role" })
        .lean();
      if (!selectedTechnician || !selectedTechnician.user || selectedTechnician.user.role !== "technician"
        || selectedTechnician.user.active === false || selectedTechnician.user.blocked === true) {
        throw posOrderError("The selected technician is no longer available for assignment.", 409, "POS_TECHNICIAN_UNAVAILABLE");
      }
      const address = String(req.body?.delivery?.address || "").trim().slice(0, 500);
      const preferredDate = parseDateOnly(req.body?.delivery?.preferredDate);
      timeSlot = String(req.body?.timeSlot || "").trim().slice(0, 40);
      const lat = Number(req.body?.delivery?.coordinates?.lat);
      const lng = Number(req.body?.delivery?.coordinates?.lng);
      if (address.length < 8) throw posOrderError("Enter and select a complete installation address.", 400, "POS_DELIVERY_ADDRESS_REQUIRED");
      if (!preferredDate || preferredDate <= new Date(new Date().setHours(0, 0, 0, 0))) throw posOrderError("Choose a future installation date.", 400, "POS_DELIVERY_DATE_REQUIRED");
      if (!timeSlot) throw posOrderError("Choose an available installation time.", 400, "POS_DELIVERY_TIME_REQUIRED");
      const quote = await authoritativeDeliveryQuote({
        origin: settings.companyLocation,
        destination: { lat, lng },
        farePerKm: settings.farePerKm,
      });
      transportationFee = quote.transportationFee;
      routeDistanceKm = quote.distanceKm;
      routeDurationMin = quote.durationMin;
      installationFee = settings.installationFee;

      const schedulingEngine = require("../utils/enterpriseSchedulingEngine");
      if (await schedulingEngine.isLargeProject({ totalUnits, totalEstimatedMinutes: totalUnits * 60 })) {
        throw posOrderError("This installation quantity requires project scheduling. Create a project quotation instead.", 409, "POS_PROJECT_SCHEDULING_REQUIRED");
      }
      const scheduleRoutes = require("./scheduleRoutes");
      const slotCheck = await scheduleRoutes.getTimeSlotsForQuery({
        date: String(req.body.delivery.preferredDate).slice(0, 10),
        duration: "60",
        quantity: String(totalUnits),
        travelTime: String(routeDurationMin),
        technicianId: String(selectedTechnician._id),
      });
      const slotAvailable = slotCheck.statusCode < 400
        && Array.isArray(slotCheck.payload?.timeSlots)
        && slotCheck.payload.timeSlots.some((slot) => slot.available === true && String(slot.startTime || "").trim().toLowerCase() === timeSlot.toLowerCase());
      if (!slotAvailable) throw posOrderError(slotCheck.payload?.message || "That installation time is no longer available.", 409, "POS_INSTALLATION_SLOT_UNAVAILABLE");
      delivery = {
        address,
        contactNumber: customer.phone,
        preferredDate,
        notes: String(req.body?.delivery?.notes || "Walk-in counter order").trim().slice(0, 1000),
        coordinates: { type: "Point", coordinates: [lng, lat] },
      };
    }

    const subtotal = enrichedItems.reduce((sum, item) => sum + item.totalPrice, 0);
    const discount = Math.max(0, Number(req.body?.discount) || 0);
    if (discount > subtotal) throw posOrderError("Discount cannot exceed the product subtotal.", 400, "POS_DISCOUNT_INVALID");
    const total = subtotal - discount + transportationFee + installationFee;
    const amountPaid = Number(req.body?.amountPaid);
    if (!Number.isFinite(amountPaid) || amountPaid < total) {
      throw posOrderError(`Collect the full counter total of ₱${total.toLocaleString("en-PH", { minimumFractionDigits: 2 })}.`, 409, "POS_PAYMENT_INSUFFICIENT");
    }

    session = await mongoose.startSession();
    session.startTransaction();
    const customerAccount = await provisionWalkInCustomer({
      customer,
      consent: accountConsent,
      invitedBy: req.user._id,
      origin: "walk_in_order",
      session,
    });
    const customerUser = customerAccount.user;
    const customerAccountCreated = customerAccount.created;
    const duplicate = await Order.findOne({ userId: customerUser._id, checkoutRequestId }).session(session);
    if (duplicate) {
      await session.abortTransaction();
      return res.json({ success: true, duplicate: true, order: duplicate.toObject(), customerAccountCreated: false });
    }

    for (const item of enrichedItems) {
      const reserved = await HVACProduct.findOneAndUpdate(
        {
          _id: item.parentHvacId,
          variants: { $elemMatch: { _id: item.inventoryId, quantity: { $gte: item.quantity }, active: { $ne: false } } },
        },
        { $inc: { "variants.$.quantity": -item.quantity } },
        { returnDocument: "after", session },
      );
      if (!reserved) throw posOrderError(`${item.modelLine} no longer has enough stock.`, 409, "POS_AIRCON_STOCK_RACE_LOST");
    }

    if (fulfillmentChoice === "carry_out") {
      let serialIndex = 0;
      enrichedItems.forEach((item) => {
        item.serialNumbers = serialNumbers.slice(serialIndex, serialIndex + item.quantity);
        serialIndex += item.quantity;
      });
    }
    const now = new Date();
    const status = fulfillmentChoice === "carry_out"
      ? "completed"
      : (fulfillmentType === "delivery_installation" ? "technician_assigned" : "preparing_unit");
    const technicianName = selectedTechnician
      ? `${selectedTechnician.user?.firstName || ""} ${selectedTechnician.user?.lastName || ""}`.trim() || selectedTechnician.name || "Technician"
      : "";
    const order = new Order({
      userId: customerUser._id,
      salesChannel: "walk_in",
      createdBy: req.user._id,
      checkoutRequestId,
      customer: { name: customer.name, email: customer.email, phone: customer.phone },
      customerAccountAccess: {
        consentedAt: new Date(),
        capturedBy: req.user._id,
        stateAtCheckout: customerAccount.state,
        invitationDelivery: "not_sent",
      },
      items: enrichedItems,
      fulfillmentType,
      pickupDate,
      delivery,
      timeSlot,
      technicianId: selectedTechnician?._id || null,
      technician: selectedTechnician ? {
        _id: selectedTechnician._id,
        name: technicianName,
        phone: selectedTechnician.user?.phone || selectedTechnician.phone || "",
        email: selectedTechnician.user?.email || selectedTechnician.userEmail || "",
      } : undefined,
      technicianAcceptance: selectedTechnician ? { status: "pending" } : undefined,
      status,
      completedAt: status === "completed" ? now : null,
      paymentMethod: payment.order,
      paymentStatus: "paid",
      downpaymentPercentage: 100,
      downpaymentAmount: total,
      balanceAmount: 0,
      discount,
      transportationFee,
      routeDistanceKm,
      routeDurationMin,
      installationFee,
      preparation: {
        dispatch: { status: fulfillmentType === "customer_pickup" ? "not_required" : "pending" },
        installation: { status: fulfillmentType === "delivery_installation" ? "pending" : "not_required" },
      },
      statusHistory: [{
        status,
        timestamp: now,
        note: fulfillmentChoice === "carry_out"
          ? "Walk-in payment and immediate handover completed"
          : (selectedTechnician ? `Walk-in aircon order created, paid, and assigned to ${technicianName}` : "Walk-in aircon order created and fully paid"),
      }],
    });
    if (status === "completed") {
      const warrantyRule = warrantyRuleForOrder(await getAftercarePolicy());
      const warrantySnapshot = buildOrderWarrantySnapshot(order, now, warrantyRule);
      if (warrantySnapshot) order.warranty = warrantySnapshot;
    }
    await order.save({ session });

    if (selectedTechnician && fulfillmentType === "delivery_installation") {
      const serviceDurationMinutes = Math.max(60, totalUnits * 60);
      const booking = new BookingService({
        sourceOrderId: order._id,
        customerId: customerUser._id,
        customer: {
          _id: customerUser._id,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          address: delivery.address,
        },
        technicianId: selectedTechnician._id,
        technician: {
          _id: selectedTechnician._id,
          name: technicianName,
          phone: selectedTechnician.user?.phone || selectedTechnician.phone || "",
          email: selectedTechnician.user?.email || selectedTechnician.userEmail || "",
        },
        bookingDate: delivery.preferredDate,
        startTime: timeSlot,
        endTime: addMinutesToClock(timeSlot, serviceDurationMinutes),
        selectedTimeLabel: timeSlot,
        status: "scheduled",
        serviceType: "core",
        service: {
          name: "Air Conditioner Installation",
          description: `Delivery and installation for ${order.orderReference || "walk-in aircon order"}`,
          basePrice: installationFee,
        },
        servicePrice: installationFee,
        serviceDurationMinutes,
        services: enrichedItems.map((item) => ({
          name: `${item.brand || "Air Conditioner"} ${item.modelLine || ""} Installation`.trim(),
          type: "core",
          quantity: item.quantity,
          unitPrice: installationFee / Math.max(1, totalUnits),
          totalPrice: (installationFee / Math.max(1, totalUnits)) * item.quantity,
          status: "assigned",
          hpDescription: item.capacity ? `${item.capacity} ${item.capacityUnit || "HP"}` : "",
          airconTypeName: item.modelLine || "Air Conditioner",
          duration: Math.max(60, item.quantity * 60),
          isAirconService: true,
          technicianId: selectedTechnician._id,
          technicianName,
          schedule: {
            date: delivery.preferredDate,
            startTime: timeSlot,
            endTime: addMinutesToClock(timeSlot, serviceDurationMinutes),
            durationMinutes: serviceDurationMinutes,
            kind: "service",
          },
        })),
        estimatedFee: installationFee + transportationFee,
        travelFare: transportationFee,
        travelTime: routeDurationMin,
        paymentMethod: payment.payment === "gcash" ? "gcash" : (payment.payment === "cash" ? "cod" : "other"),
        paymentStatus: "paid",
        amountPaid: total,
        balanceAmount: 0,
        downpaymentPercentage: 100,
        downpaymentAmount: total,
        assignedAt: now,
        assignedBy: req.user._id,
        location: { address: delivery.address, coordinates: delivery.coordinates },
      });
      await booking.save({ session });
      order.bookingId = booking._id;
    }

    const paymentRecord = new Payment({
      orderId: order._id,
      amount: order.total,
      method: payment.payment,
      type: "final",
      gateway: payment.gateway,
      reference: paymentReference || undefined,
      status: "verified",
      collectedAt: now,
      verifiedAt: now,
      completedAt: now,
      verifiedBy: req.user._id,
      collectionLocation: { address: "Store counter" },
      notes: `Walk-in ${payment.source} payment received at POS`,
      events: [{
        status: "verified",
        actor: req.user._id,
        actorName: req.user.name || req.user.email || "Admin",
        actorRole: req.user.role,
        note: "Full payment collected and verified at the walk-in counter",
        at: now,
      }],
    });
    await paymentRecord.save({ session });
    order.paymentId = paymentRecord._id;
    await order.save({ session });
    await session.commitTransaction();

    let accountEmailDelivery = customerAccount.state === "pending_verification" ? "pending_registration" : "not_sent";
    if (customerAccount.state === "active" || customerAccount.activationToken) {
      try {
        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const activationUrl = customerAccount.activationToken
          ? `${baseUrl}/activate-account?token=${encodeURIComponent(customerAccount.activationToken)}`
          : null;
        const scheduleLabel = fulfillmentChoice === "carry_out"
          ? "Released at the store counter"
          : (fulfillmentType === "customer_pickup"
              ? `Pickup on ${new Date(pickupDate).toLocaleDateString("en-PH")}`
              : `${new Date(delivery.preferredDate).toLocaleDateString("en-PH")} at ${timeSlot}`);
        const mailResult = await require("../utils/mailer").sendWalkInOrderAccountEmail({
          to: customer.email,
          customerName: customer.name,
          orderReference: order.orderReference,
          activationUrl,
          trackingUrl: `${baseUrl}/my-orders/${order._id}`,
          fulfillmentLabel: fulfillmentChoice === "delivery_installation"
            ? "Delivery and installation"
            : (fulfillmentChoice === "customer_pickup" ? "Customer pickup" : "Carry-out purchase"),
          scheduleLabel,
          totalLabel: `₱${Number(order.total || 0).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`,
        });
        accountEmailDelivery = mailResult ? "accepted" : "failed";
        if (customerAccount.activationToken && mailResult) {
          await User.updateOne({ _id: customerUser._id }, { $set: { invitationLastSentAt: new Date() } });
        }
      } catch (mailError) {
        accountEmailDelivery = "failed";
        console.error("[POS] Walk-in account/order email failed:", mailError.message);
      }
    }
    await Order.updateOne(
      { _id: order._id },
      { $set: {
        "customerAccountAccess.invitationDelivery": accountEmailDelivery,
        ...(accountEmailDelivery === "accepted" ? { "customerAccountAccess.invitationSentAt": new Date() } : {}),
      } },
    ).catch((trackingError) => console.warn("[POS] Account delivery status update failed:", trackingError.message));

    if (selectedTechnician?.user?._id) {
      try {
        const { createNotification } = require("../utils/notify");
        await createNotification({
          type: "assignment_new",
          title: "New Walk-in Aircon Order",
          message: `You have been assigned to ${order.orderReference || "an aircon installation"}. Review the order and schedule.`,
          userId: selectedTechnician.user._id,
          role: "technician",
          referenceId: order._id,
          referenceModel: "Order",
          link: "/technician/orders",
          io: req.app.get("io"),
        });
        req.app.get("io")?.to(`tech:${selectedTechnician._id}`).emit("order:assigned", {
          orderId: order._id,
          orderReference: order.orderReference,
        });
      } catch (notificationError) {
        console.error("[POS] Walk-in aircon technician notification failed:", notificationError.message);
      }
    }

    if (status === "completed") {
      try {
        const { syncMaintenanceFromOrder } = require("../utils/maintenanceLifecycle");
        await syncMaintenanceFromOrder(order);
      } catch (maintenanceError) {
        console.error("[POS] Failed to create carry-out maintenance record:", maintenanceError.message);
      }
    }
    require("../utils/audit").logEvent({
      actor: req.user._id,
      action: "pos.aircon_order.create",
      module: "Order",
      details: {
        orderReference: order.orderReference,
        total: order.total,
        fulfillmentChoice,
        customerEmail: customer.email,
        customerAccountState: customerAccount.state,
        accountEmailDelivery,
      },
      entityId: order._id,
      entityType: "Order",
      category: "order",
      actionType: "created",
      actorRole: req.user.role,
      actorName: req.user.name || req.user.email || "Admin",
      req,
    });
    return res.status(201).json({
      success: true,
      order: order.toObject(),
      customerAccountCreated,
      customerAccount: {
        state: customerAccount.state,
        email: customer.email,
        invitationDelivery: accountEmailDelivery,
      },
      amountPaid,
      change: payment.source === "cash" ? Math.max(0, amountPaid - order.total) : 0,
    });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction().catch(() => {});
    console.error("POS aircon checkout error:", error);
    const operational = error instanceof CustomerInvitationError || error instanceof OrderCheckoutError;
    return res.status(Number(error.status) || (operational ? 400 : 500)).json({
      error: operational ? error.message : "Aircon checkout failed. Please try again.",
      ...(operational && error.code ? { code: error.code } : {}),
    });
  } finally {
    if (session) await session.endSession();
  }
}
router.post("/aircon-checkout", checkoutAirconOrder);

async function resendWalkInAccountInvitation(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(404).json({ error: "Order not found." });
    const order = await Order.findOne({ _id: req.params.orderId, salesChannel: "walk_in" }).lean();
    if (!order) return res.status(404).json({ error: "Walk-in order not found." });
    const customerUser = await User.findById(order.userId);
    if (!customerUser || customerUser.role !== "customer") return res.status(404).json({ error: "Customer account not found." });
    if (customerUser.emailVerified !== false || customerUser.accountStatus !== "invited") {
      return res.status(409).json({ error: "This customer account is already active or uses another verification flow." });
    }
    const lastSent = customerUser.invitationLastSentAt ? new Date(customerUser.invitationLastSentAt).getTime() : 0;
    if (Date.now() - lastSent < 60_000) {
      return res.status(429).json({ error: "Wait one minute before resending the activation email." });
    }
    const activationToken = customerUser.createAccountInvitationToken();
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const result = await require("../utils/mailer").sendWalkInOrderAccountEmail({
      to: customerUser.email,
      customerName: `${customerUser.firstName || ""} ${customerUser.lastName || ""}`.trim(),
      orderReference: order.orderReference,
      activationUrl: `${baseUrl}/activate-account?token=${encodeURIComponent(activationToken)}`,
      trackingUrl: `${baseUrl}/my-orders/${order._id}`,
      fulfillmentLabel: order.fulfillmentType === "delivery_installation" ? "Delivery and installation" : "Customer pickup",
      scheduleLabel: order.delivery?.preferredDate
        ? `${new Date(order.delivery.preferredDate).toLocaleDateString("en-PH")} at ${order.timeSlot || "scheduled time"}`
        : "See the order after activation",
      totalLabel: `₱${Number(order.total || 0).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`,
    });
    if (!result) throw new Error("No email provider accepted the activation message.");
    customerUser.invitationLastSentAt = new Date();
    await customerUser.save();
    await Order.updateOne({ _id: order._id }, { $set: {
      "customerAccountAccess.invitationDelivery": "accepted",
      "customerAccountAccess.invitationSentAt": new Date(),
    } });
    await require("../utils/audit").logEvent({
      actor: req.user._id,
      target: customerUser._id,
      action: "CUSTOMER_INVITATION_RESENT",
      module: "Order",
      req,
      entityId: order._id,
      entityType: "Order",
      actorRole: req.user.role,
      actorName: req.user.name || req.user.email || "Admin",
      outcome: "success",
      details: { orderReference: order.orderReference, customerEmail: customerUser.email },
    }).catch((auditError) => console.warn("[POS] Invitation resend audit failed:", auditError.message));
    return res.json({ message: "A new activation email was accepted by the email provider." });
  } catch (error) {
    console.error("[POS] Resend customer activation failed:", error.message);
    return res.status(Number(error.status) || 500).json({ error: error.message || "Activation email could not be resent." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pos/checkout — Process a walk-in sale
// ─────────────────────────────────────────────────────────────────────────────
router.post("/checkout", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { customerName, customerPhone, customerTin, customerAddress, items, paymentMethod, amountPaid, discount, notes } = req.body;

    if (!items || !items.length) {
      throw new Error("No items in cart");
    }
    if (items.some((item) => ["aircon", "aircon_legacy"].includes(item?.source))) {
      throw new Error("Aircon purchases must use the walk-in Orders checkout.");
    }
    if (!paymentMethod) {
      throw new Error("Payment method is required");
    }
    if (amountPaid == null || Number(amountPaid) < 0) {
      throw new Error("Invalid payment amount");
    }

    // ── Validate & reserve stock ───────────────────────────────────────────
    const saleItems = [];
    let subtotal = 0;
    let totalCost = 0;

    for (const item of items) {
      if (!item.toolId || !item.quantity || item.quantity <= 0) {
        throw new Error(`Invalid item: ${JSON.stringify(item)}`);
      }

      let itemName, category, unit, unitPrice, costPrice, available, serialNumber, parentHvacId;
      const source = item.source || "tool";

      if (source === "aircon" || source === "aircon_legacy") {
        // Look up in HVACProduct variants or legacy Inventory
        let found = false;
        const hvac = await HVACProduct.findOne({ "variants._id": item.toolId }).session(session);
        if (hvac) {
          const variant = hvac.variants.id(item.toolId);
          if (!variant) throw new Error(`Aircon variant not found: ${item.toolId}`);
          if ((variant.quantity || 0) < item.quantity) {
            throw new Error(`Insufficient stock for "${hvac.modelLine} ${variant.capacity}${variant.capacityUnit || "HP"}": ${variant.quantity} available, ${item.quantity} requested`);
          }
          variant.quantity -= item.quantity;
          await hvac.save({ session });
          itemName = `${hvac.modelLine} ${variant.capacity}${variant.capacityUnit || "HP"}`;
          category = hvac.type || "Aircon";
          unit = "unit";
          unitPrice = variant.sellingPrice || 0;
          costPrice = variant.costPrice || 0;
          available = variant.quantity;
          parentHvacId = hvac._id;
          found = true;
        }
        if (!found) {
          // Try legacy Inventory
          const inv = await Inventory.findById(item.toolId).session(session);
          if (!inv) throw new Error(`Item not found: ${item.toolId}`);
          if ((inv.quantity || 0) < item.quantity) {
            throw new Error(`Insufficient stock for "${inv.modelLine}": ${inv.quantity} available, ${item.quantity} requested`);
          }
          inv.quantity -= item.quantity;
          await inv.save({ session });
          itemName = `${inv.modelLine} ${inv.capacity || ""}${inv.capacityUnit || "HP"}`;
          category = inv.type || "Aircon";
          unit = "unit";
          unitPrice = inv.sellingPrice || 0;
          costPrice = inv.costPrice || 0;
          available = inv.quantity;
        }
      } else {
        // Tool
        const tool = await Tool.findById(item.toolId).session(session);
        if (!tool) throw new Error(`Tool not found: ${item.toolId}`);
        if (Tool.effectiveInventoryClass(tool) !== 'merchandise') {
          throw new Error(`${tool.itemName} is an operational asset and cannot be sold`);
        }
        if (!tool.active) throw new Error(`${tool.itemName} is no longer available`);

        available = (tool.quantity || 0) - (tool.reservedQuantity || 0);
        if (available < item.quantity) {
          throw new Error(`Insufficient stock for "${tool.itemName}": ${available} available, ${item.quantity} requested`);
        }
        tool.quantity = (tool.quantity || 0) - item.quantity;
        await tool.save({ session });
        itemName = tool.itemName;
        category = tool.category;
        unit = tool.unit;
        unitPrice = tool.sellingPrice || 0;
        costPrice = tool.costPrice || 0;
        serialNumber = tool.serialNumber || null;
      }

      const totalPrice = unitPrice * item.quantity;

      saleItems.push({
        toolId: item.toolId,
        itemName,
        category,
        unit,
        quantity: item.quantity,
        unitPrice,
        costPrice,
        totalPrice,
        serialNumber,
        source,
        parentHvacId,
      });

      subtotal += totalPrice;
      totalCost += costPrice * item.quantity;
    }

    const discountAmt = Math.max(0, Number(discount) || 0);
    const totalAmount = Math.max(0, subtotal - discountAmt);
    const totalProfit = totalAmount - totalCost;
    const change = Math.max(0, (Number(amountPaid) || 0) - totalAmount);

    // ── Generate invoice number (pre-save hook may not work inside sessions) ──
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const prefix = `WIS-${yy}${mm}${dd}`;
    const lastSale = await WalkInSale.findOne({ invoiceNumber: { $regex: `^${prefix}` } })
      .sort({ invoiceNumber: -1 }).lean();
    let seq = 1;
    if (lastSale && lastSale.invoiceNumber) {
      const lastSeq = parseInt(lastSale.invoiceNumber.split("-").pop(), 10);
      if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }
    const invoiceNumber = `${prefix}-${String(seq).padStart(4, "0")}`;

    // ── Create sale record ─────────────────────────────────────────────────
    const sale = new WalkInSale({
      invoiceNumber,
      customerName: (customerName || "").trim() || "Walk-In Customer",
      customerPhone: (customerPhone || "").trim() || null,
      customerTin: (customerTin || "").trim() || null,
      customerAddress: (customerAddress || "").trim() || null,
      items: saleItems,
      subtotal,
      discount: discountAmt,
      tax: 0,
      totalAmount,
      totalCost,
      totalProfit,
      paymentMethod,
      amountPaid: Number(amountPaid) || 0,
      change,
      status: "completed",
      processedBy: req.user._id,
      processedByName: req.user.name || req.user.email || "Admin",
      notes: (notes || "").trim() || null,
      completedAt: new Date(),
    });

    await sale.save({ session });
    await session.commitTransaction();

    require("../utils/audit").logEvent({
      actor: req.user && req.user._id,
      action: "pos.sale.create",
      module: "WalkInSale",
      details: { invoiceNumber, customerName: sale.customerName, totalAmount, paymentMethod, itemCount: saleItems.length },
      entityId: sale._id,
      entityType: "WalkInSale",
      category: "order",
      actionType: "created",
      actorRole: req.user && req.user.role,
      actorName: (req.user && (req.user.name || req.user.email)) || "Admin",
      req,
    });

    // Return populated sale for receipt
    const receipt = await WalkInSale.findById(sale._id).lean();
    res.json({ success: true, sale: receipt });
  } catch (err) {
    await session.abortTransaction();
    console.error("POS checkout error:", err);
    res.status(400).json({ error: err.message || "Checkout failed" });
  } finally {
    session.endSession();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/sales — List walk-in sales (with filters)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/sales", async (req, res) => {
  try {
    const { status, from, to, page = 1, limit = 20, q, category } = req.query;
    const filter = {};

    if (status) filter.status = status;
    if (q) {
      filter.$or = [
        { invoiceNumber: { $regex: q, $options: "i" } },
        { customerName: { $regex: q, $options: "i" } },
      ];
    }
    if (category) {
      filter.items = { $elemMatch: { category: { $regex: category, $options: "i" } } };
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to + "T23:59:59");
    }

    const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
    const [sales, total] = await Promise.all([
      WalkInSale.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      WalkInSale.countDocuments(filter),
    ]);

    // Summary stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    const todayStats = await WalkInSale.aggregate([
      { $match: { status: "completed", createdAt: { $gte: today, $lte: todayEnd } } },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: "$totalAmount" }, profit: { $sum: "$totalProfit" } } },
    ]);

    res.json({
      sales,
      total,
      page: Number(page),
      pages: Math.ceil(total / Number(limit)),
      todayStats: todayStats[0] || { count: 0, revenue: 0, profit: 0 },
    });
  } catch (err) {
    console.error("POS sales list error:", err);
    res.status(500).json({ error: "Failed to load sales" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pos/sales/:id — Get single sale for receipt
// ─────────────────────────────────────────────────────────────────────────────
router.get("/sales/:id", async (req, res) => {
  try {
    const sale = await WalkInSale.findById(req.params.id).lean();
    if (!sale) return res.status(404).json({ error: "Sale not found" });
    res.json({ sale });
  } catch (err) {
    res.status(500).json({ error: "Failed to load sale" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pos/sales/:id/void — Void a completed sale
// ─────────────────────────────────────────────────────────────────────────────
router.post("/sales/:id/void", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const sale = await WalkInSale.findById(req.params.id).session(session);
    if (!sale) throw new Error("Sale not found");
    if (sale.status === "voided") throw new Error("Sale is already voided");

    // Restore stock to the same inventory collection used at checkout.
    for (const item of sale.items) {
      const source = String(item.source || "");
      const hvac = (source === "aircon" || (!source && item.parentHvacId))
        ? await HVACProduct.findOne({ "variants._id": item.toolId }).session(session)
        : null;
      if (hvac) {
        const variant = hvac.variants.id(item.toolId);
        if (!variant) throw new Error(`Aircon variant not found while restoring ${item.itemName}`);
        variant.quantity = (variant.quantity || 0) + item.quantity;
        await hvac.save({ session });
        continue;
      }
      if (source === "aircon_legacy") {
        const inventory = await Inventory.findById(item.toolId).session(session);
        if (!inventory) throw new Error(`Legacy aircon stock record not found for ${item.itemName}`);
        inventory.quantity = (inventory.quantity || 0) + item.quantity;
        await inventory.save({ session });
        continue;
      }
      const tool = await Tool.findById(item.toolId).session(session);
      if (tool) {
        tool.quantity = (tool.quantity || 0) + item.quantity;
        await tool.save({ session });
      } else {
        // Backward compatibility for aircon POS sales created before source
        // metadata existed.
        const legacyHvac = await HVACProduct.findOne({ "variants._id": item.toolId }).session(session);
        if (legacyHvac) {
          const variant = legacyHvac.variants.id(item.toolId);
          variant.quantity = (variant.quantity || 0) + item.quantity;
          await legacyHvac.save({ session });
        } else {
          const legacyInventory = await Inventory.findById(item.toolId).session(session);
          if (legacyInventory) {
            legacyInventory.quantity = (legacyInventory.quantity || 0) + item.quantity;
            await legacyInventory.save({ session });
          }
        }
      }
    }

    sale.status = "voided";
    sale.voidedAt = new Date();
    sale.voidReason = (req.body.reason || "").trim() || "Admin void";
    await sale.save({ session });

    await session.commitTransaction();

    require("../utils/audit").logEvent({
      actor: req.user && req.user._id,
      action: "pos.sale.void",
      module: "WalkInSale",
      details: { invoiceNumber: sale.invoiceNumber, reason: sale.voidReason, totalAmount: sale.totalAmount },
      entityId: sale._id,
      entityType: "WalkInSale",
      category: "order",
      actionType: "deleted",
      actorRole: req.user && req.user.role,
      actorName: (req.user && (req.user.name || req.user.email)) || "Admin",
      req,
    });

    res.json({ success: true, sale });
  } catch (err) {
    await session.abortTransaction();
    console.error("POS void error:", err);
    res.status(400).json({ error: err.message || "Void failed" });
  } finally {
    session.endSession();
  }
});

const walkInAirconRouter = express.Router();
walkInAirconRouter.use(auth.authenticate, auth.requireRole("admin"));
walkInAirconRouter.get("/products", listAircons);
walkInAirconRouter.post("/quote", quoteAirconOrder);
walkInAirconRouter.post("/checkout", checkoutAirconOrder);
walkInAirconRouter.post("/orders/:orderId/resend-invitation", resendWalkInAccountInvitation);

router.walkInAirconRouter = walkInAirconRouter;
module.exports = router;

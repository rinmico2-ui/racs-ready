const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const auth = require("../middleware/authenticate");
const CustomerAsset = require("../models/CustomerAsset");
const MaintenanceSchedule = require("../models/MaintenanceSchedule");
const BookingService = require("../models/BookingService");
const Technician = require("../models/Technician");
const CoreService = require("../models/CoreService");
const Order = require("../models/Order");
const { ensureSchedule, clampIntervalDays, effectiveScheduleStatus, addDays } = require("../utils/maintenanceLifecycle");
const { getAftercarePolicy } = require("../utils/aftercarePolicy");
const { getDownpaymentPercentage, calculatePaymentBreakdown } = require("../utils/paymentPolicy");
const { createNotification } = require("../utils/notify");
const audit = require("../utils/audit");
const { escapeRegex } = require("../utils/stringSecurity");
const SiteSetting = require("../models/SiteSetting");
const { authoritativeDeliveryQuote } = require("../utils/orderCheckoutPolicy");
const { linkScheduleToBooking } = require("../utils/maintenanceLifecycle");
const { manilaDateKey, firstMaintenanceSlot } = require("../utils/maintenanceBooking");

router.use(auth.authenticate);

const ACTIVE_DUE_STATUSES = ["upcoming", "due", "overdue"];
const OUTREACH_STATUSES = ["not_contacted", "contacted", "interested", "callback_requested", "declined", "unreachable"];
const OUTREACH_METHODS = ["phone", "email", "sms", "in_person", "other"];
const CUSTOMER_RESPONSE_STATUSES = ["booking_started", "callback_requested", "remind_later", "declined"];

function isMaintenanceService(service) {
  return /maintenan|clean|preventive|tune.?up/i.test(String(service?.name || service?.title || service?.slug || ""));
}

function parseTimeMinutes(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return NaN;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (minute > 59 || hour > 23) return NaN;
  if (match[3]) {
    if (hour < 1 || hour > 12) return NaN;
    hour %= 12;
    if (match[3].toUpperCase() === "PM") hour += 12;
  }
  return hour * 60 + minute;
}

function minutesLabel(minutes) {
  const value = Math.max(0, Number(minutes) || 0);
  return `${String(Math.floor(value / 60) % 24).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function maintenanceServiceQuote(service, asset) {
  const capacity = Number(asset?.equipment?.capacity);
  const applianceType = String(asset?.equipment?.applianceType || "").toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace("floor_mounted", "floor_standing");
  const typeDefinition = (service?.airconTypes || []).find((row) => {
    const type = String(row?.type || row?.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return type && applianceType && (type === applianceType || type.includes(applianceType) || applianceType.includes(type));
  });
  const typeTier = (typeDefinition?.hpPricing || []).find((row) => Number(row.hp) === capacity);
  const directTier = (service?.hpPricing || []).find((row) => Number(row.hp) === capacity);
  const hasTieredPrices = (service?.airconTypes || []).some((row) => row?.hpPricing?.length)
    || Boolean(service?.hpPricing?.length);
  // An arbitrary first HP tier can undercharge or misstate the visit length.
  // Unknown equipment sizes need staff help instead of a guessed quote.
  const tier = typeDefinition ? typeTier : directTier;
  return {
    price: Math.max(0, Number(tier?.price ?? (hasTieredPrices ? 0 : service?.basePrice)) || 0),
    durationMinutes: Math.min(480, Math.max(30, Number(tier?.durationMinutes ?? typeDefinition?.durationMinutes ?? service?.durationMinutes) || 90)),
  };
}

async function maintenanceLocation(asset) {
  if (asset.originType === "booking") {
    const source = await BookingService.findById(asset.originId).select("location customer").lean();
    return source?.location || { address: asset.serviceAddress || source?.customer?.address || "" };
  }
  const source = await Order.findById(asset.originId).select("delivery customer").lean();
  const coordinates = source?.delivery?.coordinates?.coordinates;
  return {
    address: asset.serviceAddress || source?.delivery?.address || source?.customer?.address || "",
    ...(Array.isArray(coordinates) && coordinates.length >= 2 ? {
      lat: Number(coordinates[1]),
      lng: Number(coordinates[0]),
      coordinates: { type: "Point", coordinates: [Number(coordinates[0]), Number(coordinates[1])] },
    } : {}),
  };
}

async function uniqueMaintenanceReference() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = require("crypto").randomBytes(3).toString("hex").slice(0, 4).toUpperCase();
    const reference = `RACS-${date}-M${suffix}`;
    if (!await BookingService.exists({ bookingReference: reference })) return reference;
  }
  throw Object.assign(new Error("Unable to generate a unique maintenance booking reference."), { status: 503 });
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  next();
}

function customerId(req) {
  return req.user?._id;
}

async function refreshDueStates(now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  await Promise.all([
    MaintenanceSchedule.updateMany(
      { status: { $in: ["upcoming", "due"] }, dueDate: { $lt: today } },
      { $set: { status: "overdue" } },
    ),
    MaintenanceSchedule.updateMany(
      { status: "upcoming", dueDate: { $gte: today, $lt: tomorrow } },
      { $set: { status: "due" } },
    ),
  ]);
}

async function summaryFor(filter) {
  const now = new Date();
  const policy = await getAftercarePolicy();
  const dueSoonCutoff = new Date(now.getTime() + policy.reminders.firstReminderDays * 24 * 60 * 60 * 1000);
  const responseFilter = {
    ...filter,
    status: { $in: ACTIVE_DUE_STATUSES },
    "customerResponse.status": { $in: ["booking_started", "callback_requested"] },
    "customerResponse.acknowledgedAt": null,
  };
  const [upcoming, due, overdue, scheduled, completed, paused, dueSoon, responses, actionable] = await Promise.all([
    MaintenanceSchedule.countDocuments({ ...filter, status: "upcoming" }),
    MaintenanceSchedule.countDocuments({ ...filter, status: "due" }),
    MaintenanceSchedule.countDocuments({ ...filter, status: "overdue" }),
    MaintenanceSchedule.countDocuments({ ...filter, status: "scheduled" }),
    MaintenanceSchedule.countDocuments({ ...filter, status: "completed" }),
    MaintenanceSchedule.countDocuments({ ...filter, status: "paused" }),
    MaintenanceSchedule.countDocuments({
      ...filter,
      status: "upcoming",
      dueDate: { $gte: now, $lte: dueSoonCutoff },
    }),
    MaintenanceSchedule.countDocuments(responseFilter),
    MaintenanceSchedule.countDocuments({
      ...filter,
      $or: [
        { status: { $in: ["due", "overdue"] } },
        {
          status: { $in: ACTIVE_DUE_STATUSES },
          "customerResponse.status": { $in: ["booking_started", "callback_requested"] },
          "customerResponse.acknowledgedAt": null,
        },
      ],
    }),
  ]);
  return { upcoming, due, overdue, scheduled, completed, paused, dueSoon, responses, actionable };
}

router.get("/badge", async (req, res, next) => {
  try {
    await refreshDueStates();
    const filter = req.user.role === "customer" ? { customerId: customerId(req) } : {};
    if (!["admin", "customer"].includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    res.json(await summaryFor(filter));
  } catch (error) { next(error); }
});

router.get("/customer", auth.requireRole("customer"), async (req, res, next) => {
  try {
    await refreshDueStates();
    const assets = await CustomerAsset.find({ customerId: customerId(req), status: { $ne: "retired" } })
      .sort({ updatedAt: -1 })
      .lean();
    const schedules = await MaintenanceSchedule.find({ customerId: customerId(req) })
      .sort({ dueDate: 1, createdAt: -1 })
      .populate("bookingId", "bookingReference status bookingDate startTime maintenance.paymentOnSite")
      .lean();
    const schedulesByAsset = new Map();
    schedules.forEach((schedule) => {
      const key = String(schedule.assetId);
      if (!schedulesByAsset.has(key)) schedulesByAsset.set(key, []);
      schedulesByAsset.get(key).push({ ...schedule, effectiveStatus: effectiveScheduleStatus(schedule) });
    });
    res.json({
      assets: assets.map((asset) => ({ ...asset, schedules: schedulesByAsset.get(String(asset._id)) || [] })),
      summary: await summaryFor({ customerId: customerId(req) }),
    });
  } catch (error) { next(error); }
});

router.get("/admin/overview", requireAdmin, async (req, res, next) => {
  try {
    await refreshDueStates();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 25));
    const status = String(req.query.status || "all");
    const search = String(req.query.search || "").trim().slice(0, 100);
    const clauses = [];
    if (status === "responses") {
      clauses.push({
        status: { $in: ACTIVE_DUE_STATUSES },
        "customerResponse.status": { $in: ["booking_started", "callback_requested"] },
        "customerResponse.acknowledgedAt": null,
      });
    } else if (status !== "all") {
      clauses.push({ status });
    }
    if (status === "upcoming") {
      const policy = await getAftercarePolicy();
      clauses.push({ dueDate: { $lte: new Date(Date.now() + policy.reminders.firstReminderDays * 24 * 60 * 60 * 1000) } });
    }

    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      const matchingAssets = await CustomerAsset.find({
        $or: [
          { originReference: re },
          { "equipment.brand": re },
          { "equipment.model": re },
          { "equipment.serialNumber": re },
        ],
      }).distinct("_id");
      const matchingCustomers = await require("../models/User").find({
        $or: [{ firstName: re }, { lastName: re }, { name: re }, { email: re }],
      }).distinct("_id");
      clauses.push({ $or: [{ assetId: { $in: matchingAssets } }, { customerId: { $in: matchingCustomers } }] });
    }
    const filter = clauses.length > 1 ? { $and: clauses } : (clauses[0] || {});

    const [schedules, total, summary] = await Promise.all([
      MaintenanceSchedule.find(filter)
        .sort({ dueDate: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("assetId")
        .populate("customerId", "firstName lastName name email phone")
        .populate("bookingId", "bookingReference status bookingDate startTime")
        .lean(),
      MaintenanceSchedule.countDocuments(filter),
      summaryFor({}),
    ]);
    res.json({ schedules, total, page, pages: Math.ceil(total / limit), summary });
  } catch (error) { next(error); }
});

router.get("/admin/booking-options", requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.query?.scheduleId)) return res.status(400).json({ error: "Invalid maintenance schedule." });
    const schedule = await MaintenanceSchedule.findById(req.query.scheduleId).populate("assetId").lean();
    if (!schedule?.assetId) return res.status(404).json({ error: "Maintenance equipment was not found." });
    const services = (await CoreService.find({ active: { $ne: false } })
      .select("name title slug description basePrice durationMinutes hpPricing airconTypes")
      .sort({ name: 1 })
      .lean())
      .filter(isMaintenanceService)
      .map((service) => {
        const quote = maintenanceServiceQuote(service, schedule.assetId);
        return {
          _id: service._id,
          name: service.name || service.title || "Maintenance Service",
          description: service.description || "",
          price: quote.price,
          durationMinutes: quote.durationMinutes,
        };
      });
    return res.json({ services });
  } catch (error) { return next(error); }
});

router.patch("/admin/schedules/:id/outreach", requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid schedule id" });
    const status = String(req.body?.status || "").trim();
    const method = String(req.body?.method || "").trim();
    const notes = String(req.body?.notes || "").trim().slice(0, 1000);
    if (!OUTREACH_STATUSES.includes(status)) return res.status(400).json({ error: "Choose a valid customer response." });
    if (status !== "not_contacted" && !OUTREACH_METHODS.includes(method)) {
      return res.status(400).json({ error: "Choose how the customer was contacted." });
    }
    let nextFollowUpAt = null;
    if (req.body?.nextFollowUpAt) {
      nextFollowUpAt = new Date(req.body.nextFollowUpAt);
      if (Number.isNaN(nextFollowUpAt.getTime())) return res.status(400).json({ error: "Invalid follow-up date." });
    }
    const now = new Date();
    const actorName = req.user.name || req.user.email || "Administrator";
    const schedule = await MaintenanceSchedule.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ACTIVE_DUE_STATUSES } },
      {
        $set: {
          "outreach.status": status,
          "outreach.method": status === "not_contacted" ? "" : method,
          "outreach.notes": notes,
          "outreach.nextFollowUpAt": nextFollowUpAt,
          "customerResponse.acknowledgedAt": now,
          "customerResponse.acknowledgedBy": req.user._id,
          ...(status === "not_contacted" ? {} : { "outreach.lastContactedAt": now }),
        },
        $push: {
          "outreach.history": {
            status,
            method: status === "not_contacted" ? "" : method,
            notes,
            nextFollowUpAt,
            changedAt: now,
            changedBy: req.user._id,
            changedByName: actorName,
          },
        },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (!schedule) return res.status(409).json({ error: "Only an open maintenance cycle can be contacted." });
    await audit.logEvent({
      actor: req.user._id,
      target: schedule._id,
      action: "maintenance.outreach.update",
      module: "maintenance",
      req,
      details: { status, method, nextFollowUpAt, notes },
    }).catch(() => {});
    return res.json({ schedule });
  } catch (error) { return next(error); }
});

router.post("/admin/schedules/:id/book", requireAdmin, async (req, res, next) => {
  let session = null;
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid schedule id" });
    if (!mongoose.isValidObjectId(req.body?.serviceId)) return res.status(400).json({ error: "Choose a maintenance service." });
    const dateText = String(req.body?.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return res.status(400).json({ error: "Choose a valid service date." });
    const bookingDate = new Date(`${dateText}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (Number.isNaN(bookingDate.getTime()) || bookingDate < today) return res.status(400).json({ error: "Maintenance must be booked for today or a future date." });
    const startTime = String(req.body?.startTime || "").trim();
    const startMinutes = parseTimeMinutes(startTime);
    if (!Number.isFinite(startMinutes)) return res.status(400).json({ error: "Choose an available service time." });
    const outreachMethod = OUTREACH_METHODS.includes(String(req.body?.method || ""))
      ? String(req.body.method)
      : "phone";

    const [schedule, service] = await Promise.all([
      MaintenanceSchedule.findOne({
        _id: req.params.id,
        status: { $in: ACTIVE_DUE_STATUSES },
        bookingId: null,
      }).populate("assetId").populate("customerId", "firstName lastName name email phone address").lean(),
      CoreService.findOne({ _id: req.body.serviceId, active: { $ne: false } }).lean(),
    ]);
    if (!schedule?.assetId) return res.status(409).json({ error: "This maintenance cycle is already booked or unavailable." });
    if (!service || !isMaintenanceService(service)) return res.status(400).json({ error: "Select a maintenance or cleaning service." });
    const quote = maintenanceServiceQuote(service, schedule.assetId);
    const durationMinutes = quote.durationMinutes;
    const slotResult = await require("./scheduleRoutes").getTimeSlotsForQuery({
      date: dateText,
      duration: String(durationMinutes),
      quantity: "1",
      travelTime: "0",
    });
    const slotAvailable = slotResult.statusCode < 400
      && Array.isArray(slotResult.payload?.timeSlots)
      && slotResult.payload.timeSlots.some((slot) => slot.available === true && parseTimeMinutes(slot.startTime) === startMinutes);
    if (!slotAvailable) return res.status(409).json({ error: slotResult.payload?.message || "That service time is no longer available." });

    const customer = schedule.customerId;
    if (!customer?._id || !customer.email) return res.status(409).json({ error: "The customer account is incomplete." });
    const asset = schedule.assetId;
    const location = await maintenanceLocation(asset);
    const requestedAddress = String(req.body?.address || "").trim().slice(0, 500);
    location.address = requestedAddress || location.address || asset.serviceAddress || "";
    if (location.address.length < 5) return res.status(400).json({ error: "Record a complete service address." });

    const servicePrice = quote.price;
    if (servicePrice <= 0) return res.status(409).json({ error: "Configure a valid price for this maintenance service before booking." });
    const percentage = await getDownpaymentPercentage();
    const payment = calculatePaymentBreakdown(servicePrice, percentage);
    const bookingReference = await uniqueMaintenanceReference();
    const customerName = customer.name || [customer.firstName, customer.lastName].filter(Boolean).join(" ") || customer.email;
    const endTime = minutesLabel(startMinutes + durationMinutes);
    const booking = new BookingService({
      bookingReference,
      customerId: customer._id,
      customer: {
        _id: customer._id,
        name: customerName,
        email: customer.email,
        phone: customer.phone || "",
        address: location.address,
      },
      serviceId: service._id,
      serviceModel: "CoreService",
      serviceType: "core",
      service: { _id: service._id, name: service.name || service.title, description: service.description || "", basePrice: servicePrice },
      servicePrice,
      serviceDurationMinutes: durationMinutes,
      services: [{
        serviceId: service._id,
        name: service.name || service.title,
        type: "core",
        quantity: 1,
        unitPrice: servicePrice,
        totalPrice: servicePrice,
        duration: durationMinutes,
        isAirconService: true,
        brand: asset.equipment?.brand || "",
        model: asset.equipment?.model || "",
        hp: Number(asset.equipment?.capacity) || undefined,
        hpDescription: asset.equipment?.capacity ? `${asset.equipment.capacity} ${asset.equipment.capacityUnit || "HP"}` : "",
        status: "awaiting_assignment",
        phase: "core",
        schedule: { date: bookingDate, startTime: minutesLabel(startMinutes), endTime, durationMinutes, kind: "service" },
      }],
      quantity: 1,
      totalPrice: servicePrice,
      estimatedFee: servicePrice,
      bookingDate,
      startTime: minutesLabel(startMinutes),
      endTime,
      selectedTimeLabel: startTime,
      location,
      status: "awaiting_assignment",
      paymentMethod: "cod",
      paymentStatus: "pending",
      downpaymentPercentage: payment.downpaymentPercentage,
      downpaymentAmount: Math.max(1, payment.downpaymentAmount),
      amountPaid: 0,
      balanceAmount: payment.total,
      maintenance: {
        isMaintenance: true,
        assetId: asset._id,
        scheduleId: schedule._id,
        nextRecommendedDays: schedule.intervalDays,
      },
      statusHistory: [{
        toStatus: "awaiting_assignment",
        changedBy: req.user._id,
        changedByModel: "User",
        changedByName: req.user.name || req.user.email || "Administrator",
        reason: "Customer confirmed maintenance during admin outreach",
      }],
    });

    session = await mongoose.startSession();
    session.startTransaction();
    await booking.save({ session });
    await BookingService.updateOne({ _id: booking._id }, { $set: {
      servicePrice,
      serviceDurationMinutes: durationMinutes,
      "service.basePrice": servicePrice,
      estimatedFee: servicePrice,
    } }, { session });
    const linked = await require("../utils/maintenanceLifecycle").linkScheduleToBooking({
      scheduleId: schedule._id,
      bookingId: booking._id,
      customerId: customer._id,
      session,
    });
    await MaintenanceSchedule.updateOne(
      { _id: schedule._id },
      {
        $set: {
          "outreach.status": "interested",
          "outreach.lastContactedAt": new Date(),
          "outreach.notes": String(req.body?.notes || "Customer confirmed maintenance booking.").trim().slice(0, 1000),
          "customerResponse.acknowledgedAt": new Date(),
          "customerResponse.acknowledgedBy": req.user._id,
        },
        $push: {
          "outreach.history": {
            status: "interested",
            method: outreachMethod,
            notes: `Maintenance booking ${bookingReference} created by administrator.`,
            changedBy: req.user._id,
            changedByName: req.user.name || req.user.email || "Administrator",
          },
        },
      },
      { session },
    );
    await session.commitTransaction();

    await Promise.all([
      createNotification({
        type: "maintenance_scheduled",
        title: "Maintenance Visit Scheduled",
        message: `${service.name || service.title} is scheduled for ${bookingDate.toLocaleDateString("en-PH")} at ${startTime}.`,
        userId: customer._id,
        referenceId: schedule._id,
        referenceModel: "MaintenanceSchedule",
        link: `/book-history?highlight=${booking._id}`,
        priority: "normal",
        io: req.app.get("io") || global.io,
      }),
      audit.logEvent({
        actor: req.user._id,
        target: schedule._id,
        action: "maintenance.assisted_booking.create",
        module: "maintenance",
        req,
        details: { bookingId: booking._id, bookingReference, serviceId: service._id, date: dateText, startTime },
      }).catch(() => {}),
    ]);
    return res.status(201).json({ booking, schedule: linked });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction().catch(() => {});
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
});

router.post("/schedules/:id/book", auth.requireRole("customer"), async (req, res, next) => {
  let session = null;
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid maintenance schedule." });
    const schedule = await MaintenanceSchedule.findOne({ _id: req.params.id, customerId: customerId(req) })
      .populate("assetId").populate("customerId", "firstName lastName name email phone address").lean();
    if (!schedule) return res.status(404).json({ error: "Maintenance reminder not found." });
    if (schedule.bookingId) {
      const existing = await BookingService.findOne({ _id: schedule.bookingId, customerId: customerId(req) })
        .select("_id bookingReference bookingDate startTime status").lean();
      if (existing) return res.json({ booking: existing, alreadyBooked: true });
    }
    if (!ACTIVE_DUE_STATUSES.includes(schedule.status) || !schedule.assetId) {
      return res.status(409).json({ error: "This maintenance reminder can no longer be booked." });
    }

    const asset = schedule.assetId;
    const customer = schedule.customerId;
    if (!customer?._id || !customer.email) return res.status(409).json({ error: "Your account needs an email address before we can book maintenance." });
    const location = await maintenanceLocation(asset);
    const lat = Number(location?.lat ?? location?.coordinates?.coordinates?.[1]);
    const lng = Number(location?.lng ?? location?.coordinates?.coordinates?.[0]);
    if (!String(location?.address || "").trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(409).json({ error: "Your saved service address has no map pin. Please contact us to update it before booking again." });
    }
    const settings = await SiteSetting.find({ key: { $in: ["companyLocationLat", "companyLocationLng", "farePerKm"] } }).lean();
    const setting = Object.fromEntries(settings.map((row) => [row.key, row.value]));
    if (setting.companyLocationLat == null || setting.companyLocationLng == null) {
      return res.status(503).json({ error: "Our service location is not set up yet. Please contact us for help booking maintenance." });
    }
    const origin = { lat: Number(setting.companyLocationLat), lng: Number(setting.companyLocationLng) };
    const farePerKm = setting.farePerKm == null ? 40 : Number(setting.farePerKm);
    const travel = await authoritativeDeliveryQuote({ origin, destination: { lat, lng }, farePerKm });
    location.lat = lat;
    location.lng = lng;
    location.coordinates = { type: "Point", coordinates: [lng, lat] };

    const services = (await CoreService.find({ active: { $ne: false } }).lean()).filter(isMaintenanceService);
    const service = services.find((item) => /clean/i.test(String(item.name || item.title || item.slug || "")) && maintenanceServiceQuote(item, asset).price > 0)
      || services.find((item) => maintenanceServiceQuote(item, asset).price > 0);
    if (!service) return res.status(409).json({ error: services.length
      ? "We could not price the saved aircon type or HP. Please contact us to book maintenance for this unit."
      : "No maintenance service is available to book right now. Please contact us." });
    const quote = maintenanceServiceQuote(service, asset);
    const today = manilaDateKey(new Date());
    const due = schedule.dueDate ? manilaDateKey(new Date(schedule.dueDate)) : today;
    const chosen = await firstMaintenanceSlot(due > today ? due : today, quote.durationMinutes, travel.durationMin,
      require("./scheduleRoutes").getTimeSlotsForQuery);
    if (!chosen) return res.status(409).json({ error: "No open maintenance time was found in the next 30 days. Please contact us to arrange a visit." });

    // Match the date-only UTC convention used by the shared scheduling engine.
    const bookingDate = new Date(`${chosen.date}T00:00:00.000Z`);
    const startMinutes = parseTimeMinutes(chosen.startTime);
    if (!Number.isFinite(startMinutes)) return res.status(503).json({ error: "The available time could not be read. Please try again." });
    const endTime = minutesLabel(startMinutes + quote.durationMinutes);
    const servicePrice = quote.price;
    const total = servicePrice + travel.transportationFee;
    const bookingReference = await uniqueMaintenanceReference();
    const customerName = customer.name || [customer.firstName, customer.lastName].filter(Boolean).join(" ") || customer.email;
    const serviceName = service.name || service.title;
    const booking = new BookingService({
      bookingReference,
      customerId: customer._id,
      customer: { _id: customer._id, name: customerName, email: customer.email, phone: customer.phone || "", address: location.address },
      serviceId: service._id,
      serviceModel: "CoreService",
      serviceType: "core",
      service: { _id: service._id, name: serviceName, description: service.description || "", basePrice: servicePrice },
      servicePrice,
      serviceDurationMinutes: quote.durationMinutes,
      brand: asset.equipment?.brand || "",
      applianceType: asset.equipment?.applianceType || "",
      applianceTypeName: asset.equipment?.applianceTypeName || "",
      hp: Number(asset.equipment?.capacity) || undefined,
      services: [{
        serviceId: service._id, name: serviceName, type: "core", quantity: 1,
        unitPrice: servicePrice, totalPrice: servicePrice, duration: quote.durationMinutes,
        isAirconService: service.isAirconService !== false, brand: asset.equipment?.brand || "",
        model: asset.equipment?.model || "", hp: Number(asset.equipment?.capacity) || undefined,
        hpDescription: asset.equipment?.capacity ? `${asset.equipment.capacity} ${asset.equipment.capacityUnit || "HP"}` : "",
        status: "awaiting_assignment", phase: "core",
        schedule: { date: bookingDate, startTime: minutesLabel(startMinutes), endTime, durationMinutes: quote.durationMinutes, kind: "service" },
      }],
      quantity: 1,
      totalPrice: total,
      estimatedFee: total,
      travelFare: travel.transportationFee,
      travelTime: travel.durationMin,
      travelDurationMinutes: travel.durationMin,
      distanceKm: travel.distanceKm,
      bookingDate,
      startTime: minutesLabel(startMinutes),
      endTime,
      selectedTimeLabel: chosen.startTime,
      location,
      status: "awaiting_assignment",
      paymentMethod: "cod",
      paymentChannel: "other",
      paymentStatus: "pending",
      downpaymentAmount: 0,
      amountPaid: 0,
      balanceAmount: total,
      paymentNotes: "Maintenance requested from Aftercare. Full payment will be collected on site after service.",
      maintenance: { isMaintenance: true, paymentOnSite: true, assetId: asset._id, scheduleId: schedule._id, nextRecommendedDays: schedule.intervalDays },
      statusHistory: [{ toStatus: "awaiting_assignment", changedBy: customer._id, changedByModel: "User", changedByName: customerName, reason: "Customer requested repeat maintenance with payment on site" }],
    });

    session = await mongoose.startSession();
    session.startTransaction();
    await booking.save({ session });
    // The model's catalogue snapshot uses basePrice on save. Store the exact
    // server-calculated HP quote only for this verified maintenance booking.
    await BookingService.updateOne({ _id: booking._id }, { $set: {
      servicePrice,
      serviceDurationMinutes: quote.durationMinutes,
      "service.basePrice": servicePrice,
      estimatedFee: total,
    } }, { session });
    await linkScheduleToBooking({ scheduleId: schedule._id, bookingId: booking._id, customerId: customer._id, session });
    await session.commitTransaction();
    await Promise.allSettled([
      createNotification({
        type: "maintenance_scheduled", title: "Maintenance Booking Requested",
        message: `${serviceName} was requested for ${chosen.date} at ${chosen.startTime}. Payment is due on site after service; technician assignment is pending.`,
        userId: customer._id, referenceId: schedule._id, referenceModel: "MaintenanceSchedule",
        link: `/book-history?highlight=${booking._id}`, priority: "normal", io: req.app.get("io") || global.io,
      }),
      createNotification({
        type: "maintenance_customer_response", title: "New Maintenance Booking Needs Follow-up",
        message: `${customerName} requested ${serviceName} for ${chosen.date} at ${chosen.startTime}. Assign a technician; full payment will be collected on site.`,
        role: "admin", referenceId: schedule._id, referenceModel: "MaintenanceSchedule",
        link: "/admin/maintenance", priority: "high", io: req.app.get("io") || global.io,
      }),
      audit.logEvent({ actor: customer._id, target: schedule._id, action: "maintenance.customer_booking.create", module: "maintenance", req,
        details: { bookingId: booking._id, bookingReference, serviceId: service._id, date: chosen.date, startTime: chosen.startTime, total } }).catch(() => {}),
    ]);
    return res.status(201).json({ booking: { _id: booking._id, bookingReference, bookingDate, startTime: booking.startTime, status: booking.status }, alreadyBooked: false });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction().catch(() => {});
    const existing = mongoose.isValidObjectId(req.params.id)
      ? await MaintenanceSchedule.findOne({ _id: req.params.id, customerId: customerId(req), bookingId: { $ne: null } }).select("bookingId").lean().catch(() => null)
      : null;
    if (existing?.bookingId) {
      const booking = await BookingService.findOne({ _id: existing.bookingId, customerId: customerId(req) })
        .select("_id bookingReference bookingDate startTime status").lean().catch(() => null);
      if (booking) return res.json({ booking, alreadyBooked: true });
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
});

router.post("/schedules/:id/respond", auth.requireRole("customer"), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid schedule id" });
    const status = String(req.body?.status || "").trim();
    if (!CUSTOMER_RESPONSE_STATUSES.includes(status)) return res.status(400).json({ error: "Choose a valid aftercare response." });
    const note = String(req.body?.note || "").trim().slice(0, 500);
    const now = new Date();
    let remindAt = null;
    if (req.body?.remindAt) {
      remindAt = new Date(req.body.remindAt);
      const latestAllowed = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
      if (Number.isNaN(remindAt.getTime()) || remindAt <= now || remindAt > latestAllowed) {
        return res.status(400).json({ error: "Choose a future date within the next 180 days." });
      }
    }
    if (status === "remind_later" && !remindAt) return res.status(400).json({ error: "Choose when you want to be reminded." });

    const schedule = await MaintenanceSchedule.findOneAndUpdate(
      {
        _id: req.params.id,
        customerId: customerId(req),
        status: { $in: ACTIVE_DUE_STATUSES },
        bookingId: null,
      },
      {
        $set: {
          "customerResponse.status": status,
          "customerResponse.respondedAt": now,
          "customerResponse.remindAt": remindAt,
          "customerResponse.reminderSentAt": null,
          "customerResponse.note": note,
          "customerResponse.acknowledgedAt": null,
          "customerResponse.acknowledgedBy": null,
        },
        $push: { "customerResponse.history": { status, respondedAt: now, remindAt, note } },
      },
      { returnDocument: "after", runValidators: true },
    ).populate("assetId");
    if (!schedule) return res.status(409).json({ error: "This maintenance cycle is already booked or unavailable." });

    const equipment = schedule.assetId?.equipment || {};
    const unit = [equipment.brand, equipment.model, equipment.capacity ? `${equipment.capacity} ${equipment.capacityUnit || "HP"}` : ""]
      .filter(Boolean).join(" ") || equipment.applianceTypeName || "equipment";
    if (["booking_started", "callback_requested"].includes(status)) {
      const callback = status === "callback_requested";
      await createNotification({
        type: "maintenance_customer_response",
        title: callback ? "Aftercare Callback Requested" : "Customer Started Maintenance Booking",
        message: `${req.user.name || req.user.email || "A customer"} ${callback ? "requested contact about" : "is ready to book"} maintenance for ${unit}.`,
        role: "admin",
        referenceId: schedule._id,
        referenceModel: "MaintenanceSchedule",
        link: "/admin/maintenance?status=responses",
        priority: "high",
        io: req.app.get("io") || global.io,
      });
    }
    await audit.logEvent({
      actor: req.user._id,
      target: schedule._id,
      action: `maintenance.customer_response.${status}`,
      module: "maintenance",
      req,
      details: { status, remindAt, note },
    }).catch(() => {});

    const query = new URLSearchParams({
      maintenanceScheduleId: String(schedule._id),
      assetId: String(schedule.assetId?._id || schedule.assetId),
    });
    return res.json({
      success: true,
      schedule,
      bookingUrl: status === "booking_started" ? `/services?${query.toString()}` : null,
    });
  } catch (error) { return next(error); }
});

router.get("/schedules/:id/booking-intent", auth.requireRole("customer"), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid schedule id" });
    const schedule = await MaintenanceSchedule.findOne({
      _id: req.params.id,
      customerId: customerId(req),
      status: { $in: ACTIVE_DUE_STATUSES },
      bookingId: null,
    }).populate("assetId").lean();
    if (!schedule) return res.status(409).json({ error: "This maintenance cycle is already booked or unavailable." });
    if (!schedule.assetId) return res.status(404).json({ error: "We could not find the equipment for this maintenance cycle." });
    const services = (await CoreService.find({ active: { $ne: false } })
      .select("_id name title slug isAirconService airconTypes hpPricing")
      .lean()).filter(isMaintenanceService);
    const preferred = services.find((service) => /clean/i.test(String(service.name || service.title || service.slug || "")))
      || services[0] || null;
    const query = new URLSearchParams({
      maintenanceScheduleId: String(schedule._id),
      assetId: String(schedule.assetId._id),
    });
    res.json({
      schedule: { _id: schedule._id, dueDate: schedule.dueDate, assetId: schedule.assetId._id },
      equipment: schedule.assetId.equipment || {},
      serviceId: preferred?._id || null,
      serviceName: preferred?.name || preferred?.title || null,
      bookingUrl: `/services?${query.toString()}`,
    });
  } catch (error) { next(error); }
});

router.patch("/assets/:id/installation-date", async (req, res, next) => {
  try {
    if (!["admin", "customer"].includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid asset id" });
    const installationDate = new Date(req.body?.installationDate);
    if (Number.isNaN(installationDate.getTime())) return res.status(400).json({ error: "A valid installation date is required." });
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (installationDate >= tomorrow) return res.status(400).json({ error: "Installation date cannot be in the future." });
    const filter = { _id: req.params.id };
    if (req.user.role === "customer") filter.customerId = customerId(req);
    const asset = await CustomerAsset.findOneAndUpdate(
      filter,
      { installationDate, lastServiceDate: installationDate, status: "active" },
      { returnDocument: "after", runValidators: true },
    );
    if (!asset) return res.status(404).json({ error: "Equipment not found" });
    const schedule = await ensureSchedule(asset, {
      baseDate: installationDate,
      intervalDays: asset.maintenanceIntervalDays,
      sourceType: "installation_date",
      sourceId: asset._id,
    });
    if (schedule && !schedule.bookingId && ["upcoming", "due", "overdue"].includes(schedule.status)) {
      schedule.dueDate = addDays(installationDate, asset.maintenanceIntervalDays);
      schedule.status = effectiveScheduleStatus({ status: "upcoming", dueDate: schedule.dueDate });
      schedule.history.push({
        status: schedule.status,
        changedBy: req.user._id,
        changedByName: req.user.name || req.user.email || "Customer",
        reason: "Installation date updated",
      });
      await schedule.save();
    }
    await audit.logEvent({
      actor: req.user._id,
      target: asset._id,
      action: "maintenance.installation_date.set",
      module: "maintenance",
      req,
      details: { installationDate },
    }).catch(() => {});
    res.json({ asset, schedule });
  } catch (error) { next(error); }
});

router.patch("/admin/schedules/:id", requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid schedule id" });
    const schedule = await MaintenanceSchedule.findById(req.params.id);
    if (!schedule) return res.status(404).json({ error: "Maintenance schedule not found" });
    const updates = {};
    if (req.body?.dueDate) {
      const dueDate = new Date(req.body.dueDate);
      if (Number.isNaN(dueDate.getTime())) return res.status(400).json({ error: "Invalid due date" });
      updates.dueDate = dueDate;
    }
    if (req.body?.intervalDays != null) updates.intervalDays = clampIntervalDays(req.body.intervalDays);
    if (req.body?.status) {
      const allowed = ["upcoming", "due", "overdue", "paused", "cancelled"];
      if (!allowed.includes(req.body.status)) return res.status(400).json({ error: "Invalid maintenance status transition" });
      if (["scheduled", "completed"].includes(schedule.status)) {
        return res.status(409).json({ error: "A scheduled or completed cycle cannot be manually rewritten." });
      }
      updates.status = req.body.status;
      if (req.body.status === "paused") {
        updates.pausedAt = new Date();
        updates.pausedReason = String(req.body.reason || "Paused by administrator").slice(0, 500);
      }
    }
    Object.assign(schedule, updates);
    schedule.history.push({
      status: schedule.status,
      changedBy: req.user._id,
      changedByName: req.user.name || req.user.email || "Administrator",
      reason: String(req.body?.reason || "Maintenance schedule updated").slice(0, 500),
    });
    await schedule.save();
    if (updates.intervalDays) await CustomerAsset.findByIdAndUpdate(schedule.assetId, { maintenanceIntervalDays: updates.intervalDays });
    await audit.logEvent({
      actor: req.user._id,
      target: schedule._id,
      action: "maintenance.schedule.update",
      module: "maintenance",
      req,
      details: updates,
    }).catch(() => {});
    res.json({ schedule });
  } catch (error) { next(error); }
});

router.get("/technician/bookings/:bookingId", auth.requireRole("technician"), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.bookingId)) return res.status(400).json({ error: "Invalid booking id" });
    const technician = await Technician.findOne({ user: req.user._id }).select("_id").lean();
    if (!technician) return res.status(404).json({ error: "Technician record not found" });
    const booking = await BookingService.findOne({ _id: req.params.bookingId, technicianId: technician._id })
      .select("maintenance customerId bookingReference")
      .lean();
    if (!booking) return res.status(404).json({ error: "Assigned booking not found" });
    if (!booking.maintenance?.assetId) return res.json({ maintenance: null });
    const asset = await CustomerAsset.findById(booking.maintenance.assetId).lean();
    const history = await MaintenanceSchedule.find({ assetId: booking.maintenance.assetId })
      .sort({ cycleNumber: -1 })
      .limit(10)
      .populate("completedByBookingId", "bookingReference completedAt service")
      .lean();
    res.json({ maintenance: { asset, history } });
  } catch (error) { next(error); }
});

module.exports = router;

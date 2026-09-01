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

router.use(auth.authenticate);

const ACTIVE_DUE_STATUSES = ["upcoming", "due", "overdue"];
const OUTREACH_STATUSES = ["not_contacted", "contacted", "interested", "callback_requested", "declined", "unreachable"];
const OUTREACH_METHODS = ["phone", "email", "sms", "in_person", "other"];

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
  const applianceType = String(asset?.equipment?.applianceType || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const typeDefinition = (service?.airconTypes || []).find((row) => {
    const type = String(row?.type || row?.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    return type && applianceType && (type === applianceType || type.includes(applianceType) || applianceType.includes(type));
  });
  const typeTier = (typeDefinition?.hpPricing || []).find((row) => Number(row.hp) === capacity);
  const directTier = (service?.hpPricing || []).find((row) => Number(row.hp) === capacity);
  const fallbackTier = typeDefinition?.hpPricing?.[0] || service?.hpPricing?.[0] || null;
  const tier = typeTier || directTier || fallbackTier;
  return {
    price: Math.max(0, Number(tier?.price ?? service?.basePrice) || 0),
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
  const [upcoming, due, overdue, scheduled, completed, paused, dueSoon] = await Promise.all([
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
  ]);
  return { upcoming, due, overdue, scheduled, completed, paused, dueSoon, actionable: due + overdue };
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
      .populate("bookingId", "bookingReference status bookingDate startTime")
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
    const filter = status === "all" ? {} : { status };
    if (status === "upcoming") {
      const policy = await getAftercarePolicy();
      filter.dueDate = { $lte: new Date(Date.now() + policy.reminders.firstReminderDays * 24 * 60 * 60 * 1000) };
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
      filter.$or = [{ assetId: { $in: matchingAssets } }, { customerId: { $in: matchingCustomers } }];
    }

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
    const query = new URLSearchParams({
      maintenanceScheduleId: String(schedule._id),
      assetId: String(schedule.assetId._id),
    });
    res.json({
      schedule,
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

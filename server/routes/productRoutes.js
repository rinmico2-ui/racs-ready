const express = require("express");
const router = express.Router();
const HVACProduct = require("../models/HVACProduct");
const Inventory = require("../models/Inventory");
const Technician = require("../models/Technician");
const TechnicianSchedule = require("../models/TechnicianSchedule");
const BookingService = require("../models/BookingService");
const NonWorkingDay = require("../models/NonWorkingDay");
const LeaveRequest = require("../models/LeaveRequest");

const COMPANY_START_MINUTES = 480;
const COMPANY_END_MINUTES = 1020;

function formatDateKey(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function timeStrToMinutes(t) {
  if (!t) return 0;
  const parts = t.replace(/(AM|PM)/gi, "").trim().split(":");
  let h = parseInt(parts[0], 10);
  const m = parseInt(parts[1] || "0", 10);
  const isPM = /PM/i.test(t);
  if (isPM && h < 12) h += 12;
  if (!isPM && h === 12) h = 0;
  return h * 60 + m;
}

function minutesToTime(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const period = h >= 12 ? "PM" : "AM";
  const display = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${display}:${String(min).padStart(2, "0")} ${period}`;
}

/**
 * GET /api/products
 * Returns HVACProduct items grouped by modelLine for the product page.
 * Each group has all HP variants, starting price, combined stock, etc.
 */
router.get("/", async (req, res) => {
  try {
    const products = await HVACProduct.find({
      active: true,
      salesChannel: { $in: ["web", "both"] },
      status: { $ne: "discontinued" },
    })
      .populate("category", "name")
      .populate("brand", "name")
      .sort({ modelLine: 1 })
      .lean();

    const grouped = products.map((item) => {
      const g = {
        _id: item._id,
        modelLine: item.modelLine,
        brand: item.brand ? item.brand.name : "",
        category: item.category ? item.category.name : "",
        type: item.type || "split",
        inverter: item.inverter || false,
        imageUrl: item.imageUrl || "/images/products/default.png",
        description: item.description || "",
        features: (item.specifications && item.specifications.features) ? item.specifications.features : [],
        warranty: (item.specifications && item.specifications.warranty) ? item.specifications.warranty : "",
        specifications: item.specifications || {},
        rating: item.rating || 0,
        ratingCount: item.ratingCount || 0,
        variants: (item.variants || []).filter(v => v.active).map(v => ({
          _id: v._id,
          capacity: v.capacity,
          capacityUnit: v.capacityUnit || "HP",
          btu: v.btu || 0,
          sellingPrice: v.sellingPrice || 0,
          quantity: v.quantity || 0,
          status: v.status || "out_of_stock",
          sku: v.sku || "",
        })).sort((a, b) => parseFloat(a.capacity) - parseFloat(b.capacity))
      };

      const prices = g.variants.map((v) => v.sellingPrice).filter((p) => p > 0);
      const totalStock = g.variants.reduce((s, v) => s + (v.quantity || 0), 0);

      return {
        ...g,
        startingPrice: prices.length ? Math.min(...prices) : 0,
        totalStock,
        inStock: totalStock > 0,
      };
    });

    res.json({ products: grouped });
  } catch (err) {
    console.error("GET /api/products error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch products" });
  }
});

/**
 * GET /api/products/:id
 * Returns a single HVACProduct with full details and sibling variants.
 */
router.get("/:id", async (req, res) => {
  try {
    const item = await HVACProduct.findById(req.params.id)
      .populate("brand", "name")
      .populate("category", "name")
      .lean();

    if (!item) {
      return res.status(404).json({ error: "Product not found" });
    }

    let variants = [];
    if (item.modelLine) {
      variants = await HVACProduct.find({
        modelLine: item.modelLine,
        active: true,
        status: { $ne: "discontinued" },
      })
        .select("variants.capacity variants.capacityUnit variants.btu variants.sellingPrice variants.quantity variants.status variants.sku")
        .sort({ "variants.capacity": 1 })
        .lean();
    }

    res.json({ product: item, variants });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/products/schedule/available-dates
 * Capacity-based date availability for the product checkout calendar.
 * Fetches ALL tech schedules and applies the same logic as the booking service.
 */
router.get("/schedule/available-dates", async (req, res) => {
  try {
    const { duration: queryDuration, mode = "manual" } = req.query;
    const serviceDuration = Number(queryDuration) || 60;
    const travelTime = 30;
    const bufferTime = 30;
    const capacityPerSlot = serviceDuration + travelTime + bufferTime;

    const technicians = await Technician.find({ active: { $ne: false } });
    const techIds = technicians.map(t => t._id);

    if (techIds.length === 0) {
      return res.json({ availableDates: [] });
    }

    const scheduleMap = {};
    const schedules = await TechnicianSchedule.find({ technicianId: { $in: techIds } });
    schedules.forEach(s => { scheduleMap[s.technicianId.toString()] = s; });

    const DEFAULT_WORKING_DAYS = [
      { dayOfWeek: 1, startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES },
      { dayOfWeek: 3, startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES },
      { dayOfWeek: 4, startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES },
      { dayOfWeek: 5, startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES },
    ];

    for (const tech of technicians) {
      const tid = tech._id.toString();
      if (!scheduleMap[tid]) {
        scheduleMap[tid] = { workingDays: DEFAULT_WORKING_DAYS, nonWorkingWeekdays: [], restDates: [] };
      }
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const windowEnd = new Date(today);
    windowEnd.setDate(today.getDate() + 60);
    windowEnd.setHours(23, 59, 59, 999);

    const activeBookingStatuses = [
      "pending", "payment_verified", "awaiting_assignment", "assigned",
      "pending_reassignment", "confirmed", "scheduled", "on-the-way", "arrived", "in-progress",
      "repair_requested", "inspection_scheduled", "inspection_in_progress",
      "repair_approved", "ready_for_repair", "repair_scheduled", "repair_in_progress",
    ];

    const allBookings = await BookingService.find({
      technicianId: { $in: techIds.length > 0 ? techIds : [new (require("mongoose").Types.ObjectId)()] },
      bookingDate: { $gte: today, $lte: windowEnd },
      status: { $in: activeBookingStatuses },
    }).select("technicianId bookingDate startTime serviceDurationMinutes travelTime").lean();

    const bookingMap = new Map();
    allBookings.forEach(b => {
      const bd = new Date(b.bookingDate);
      const dateKey = formatDateKey(bd);
      const techKey = b.technicianId.toString();
      if (!bookingMap.has(dateKey)) bookingMap.set(dateKey, new Map());
      const techBookings = bookingMap.get(dateKey);
      if (!techBookings.has(techKey)) techBookings.set(techKey, []);

      const bStart = timeStrToMinutes(b.startTime);
      const bServiceDuration = Number(b.serviceDurationMinutes) || serviceDuration;
      const bTravelTime = Number(b.travelTime) || travelTime;
      const bEnd = bStart + bServiceDuration + bTravelTime + bufferTime;

      techBookings.get(techKey).push({ start: bStart, end: bEnd });
    });

    const unassignedBookings = await BookingService.find({
      $or: [{ technicianId: { $exists: false } }, { technicianId: null }],
      bookingDate: { $gte: today, $lte: windowEnd },
      status: { $in: activeBookingStatuses },
    }).select("bookingDate startTime serviceDurationMinutes travelTime").lean();

    const unassignedBookingMap = new Map();
    unassignedBookings.forEach(b => {
      const bd = new Date(b.bookingDate);
      const dateKey = formatDateKey(bd);
      if (!unassignedBookingMap.has(dateKey)) unassignedBookingMap.set(dateKey, []);
      const bStart = timeStrToMinutes(b.startTime);
      const bServiceDuration = Number(b.serviceDurationMinutes) || serviceDuration;
      const bTravelTime = Number(b.travelTime) || travelTime;
      const bEnd = bStart + bServiceDuration + bTravelTime + bufferTime;
      unassignedBookingMap.get(dateKey).push({ start: bStart, end: bEnd });
    });

    const nonWorkingDays = await NonWorkingDay.find({
      $or: [{ service: null }],
    });
    const nonWorkingDateSet = new Set(
      nonWorkingDays.map(nwd => formatDateKey(new Date(nwd.date)))
    );

    const leaveRecords = await LeaveRequest.find({
      technicianId: { $in: techIds },
      status: "approved",
      startDate: { $lte: windowEnd },
      endDate: { $gte: today },
    }).select("technicianId startDate endDate").lean();

    const leaveMap = new Map();
    leaveRecords.forEach(lr => {
      const tid = lr.technicianId.toString();
      if (!leaveMap.has(tid)) leaveMap.set(tid, []);
      leaveMap.get(tid).push({ start: new Date(lr.startDate), end: new Date(lr.endDate) });
    });

    const availableDates = [];

    for (let i = 0; i < 60; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(today.getDate() + i);
      const dateKey = formatDateKey(checkDate);
      const dayOfWeek = checkDate.getDay();

      if (nonWorkingDateSet.has(dateKey)) continue;

      const dayBookings = bookingMap.get(dateKey) || new Map();
      let dayTotalAvailable = 0;
      let dayTotalCapacity = 0;
      let hasAnyWorkingTech = false;

      for (const tech of technicians) {
        const techId = tech._id.toString();
        const schedule = scheduleMap[techId];
        if (!schedule) continue;

        const workingDay = schedule.workingDays.find(wd => wd.dayOfWeek === dayOfWeek);
        const isNonWorkingWeekday = schedule.nonWorkingWeekdays?.some(nwd => nwd.dayOfWeek === dayOfWeek);
        if (!workingDay || isNonWorkingWeekday) continue;

        const isRestDate = schedule.restDates?.some(rd => {
          const rdDate = new Date(rd.date);
          return rdDate.getFullYear() === checkDate.getFullYear()
            && rdDate.getMonth() === checkDate.getMonth()
            && rdDate.getDate() === checkDate.getDate();
        });
        if (isRestDate) continue;

        const techLeaveDates = leaveMap.get(techId) || [];
        const isOnLeave = techLeaveDates.some(lr => checkDate >= lr.start && checkDate <= lr.end);
        if (isOnLeave) continue;

        hasAnyWorkingTech = true;

        const slotInterval = Math.max(30, capacityPerSlot);
        const techStart = workingDay.startMinutes;
        const techEnd = workingDay.endMinutes;
        let techMaxSlots = 0;
        for (let s = techStart; s + capacityPerSlot <= techEnd; s += slotInterval) {
          techMaxSlots++;
        }

        const techBookings = dayBookings.get(techId) || [];
        let techBookedCount = 0;
        for (let s = techStart; s + capacityPerSlot <= techEnd; s += slotInterval) {
          const slotEnd = s + capacityPerSlot;
          const conflicts = techBookings.some(b => s < b.end && slotEnd > b.start);
          if (conflicts) techBookedCount++;
        }

        dayTotalCapacity += techMaxSlots;
        dayTotalAvailable += Math.max(0, techMaxSlots - techBookedCount);
      }

      if (!hasAnyWorkingTech) continue;

      const dayUnassigned = unassignedBookingMap.get(dateKey) || [];
      if (dayUnassigned.length > 0) {
        let unassignedConsumed = 0;
        for (const ub of dayUnassigned) {
          if (ub.end > COMPANY_START_MINUTES && ub.start < COMPANY_END_MINUTES) {
            unassignedConsumed++;
          }
        }
        dayTotalAvailable = Math.max(0, dayTotalAvailable - unassignedConsumed);
      }

      availableDates.push({
        date: dateKey,
        availableSlots: dayTotalAvailable,
        totalSlots: dayTotalCapacity,
        reservedSlots: dayTotalCapacity - dayTotalAvailable,
      });
    }

    res.json({ availableDates });
  } catch (err) {
    console.error("GET /api/products/schedule/available-dates error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch available dates" });
  }
});

/**
 * GET /api/products/schedule/time-slots
 * Time slot availability for a specific date.
 * Fetches ALL tech schedules and applies the same logic as the booking service.
 */
router.get("/schedule/time-slots", async (req, res) => {
  try {
    const { date, duration: queryDuration } = req.query;
    if (!date) {
      return res.status(400).json({ error: "Date is required" });
    }

    const serviceDuration = Number(queryDuration) || 60;
    const travelTime = 30;
    const bufferTime = 30;
    const capacityPerSlot = serviceDuration + travelTime + bufferTime;

    const targetDate = new Date(date + "T00:00:00");
    const dayOfWeek = targetDate.getDay();

    const technicians = await Technician.find({ active: { $ne: false } });
    const techIds = technicians.map(t => t._id);

    const scheduleMap = {};
    const schedules = await TechnicianSchedule.find({ technicianId: { $in: techIds } });
    schedules.forEach(s => { scheduleMap[s.technicianId.toString()] = s; });

    const DEFAULT_WORKING_DAYS = [
      { dayOfWeek: 1, startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES },
      { dayOfWeek: 3, startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES },
      { dayOfWeek: 4, startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES },
      { dayOfWeek: 5, startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES },
    ];

    for (const tech of technicians) {
      const tid = tech._id.toString();
      if (!scheduleMap[tid]) {
        scheduleMap[tid] = { workingDays: DEFAULT_WORKING_DAYS, nonWorkingWeekdays: [], restDates: [] };
      }
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const isToday = formatDateKey(targetDate) === formatDateKey(today);

    const activeBookingStatuses = [
      "pending", "payment_verified", "awaiting_assignment", "assigned",
      "pending_reassignment", "confirmed", "scheduled", "on-the-way", "arrived", "in-progress",
      "repair_requested", "inspection_scheduled", "inspection_in_progress",
      "repair_approved", "ready_for_repair", "repair_scheduled", "repair_in_progress",
    ];

    const dayBookings = await BookingService.find({
      technicianId: { $in: techIds },
      bookingDate: targetDate,
      status: { $in: activeBookingStatuses },
    }).select("technicianId startTime serviceDurationMinutes travelTime").lean();

    const bookingMap = new Map();
    dayBookings.forEach(b => {
      const techKey = b.technicianId.toString();
      if (!bookingMap.has(techKey)) bookingMap.set(techKey, []);
      const bStart = timeStrToMinutes(b.startTime);
      const bServiceDuration = Number(b.serviceDurationMinutes) || serviceDuration;
      const bTravelTime = Number(b.travelTime) || travelTime;
      const bEnd = bStart + bServiceDuration + bTravelTime + bufferTime;
      bookingMap.get(techKey).push({ start: bStart, end: bEnd });
    });

    const unassignedBookings = await BookingService.find({
      $or: [{ technicianId: { $exists: false } }, { technicianId: null }],
      bookingDate: targetDate,
      status: { $in: activeBookingStatuses },
    }).select("startTime serviceDurationMinutes travelTime").lean();

    const unassignedIntervals = unassignedBookings.map(b => {
      const bStart = timeStrToMinutes(b.startTime);
      const bServiceDuration = Number(b.serviceDurationMinutes) || serviceDuration;
      const bTravelTime = Number(b.travelTime) || travelTime;
      return { start: bStart, end: bStart + bServiceDuration + bTravelTime + bufferTime };
    });

    const slotInterval = Math.max(30, capacityPerSlot);
    const timeSlots = [];

    for (let s = COMPANY_START_MINUTES; s + serviceDuration <= COMPANY_END_MINUTES; s += slotInterval) {
      const slotEnd = s + serviceDuration;
      let techAvailableCount = 0;

      for (const tech of technicians) {
        const techId = tech._id.toString();
        const schedule = scheduleMap[techId];
        if (!schedule) continue;

        const workingDay = schedule.workingDays.find(wd => wd.dayOfWeek === dayOfWeek);
        const isNonWorkingWeekday = schedule.nonWorkingWeekdays?.some(nwd => nwd.dayOfWeek === dayOfWeek);
        if (!workingDay || isNonWorkingWeekday) continue;

        if (s < workingDay.startMinutes || slotEnd > workingDay.endMinutes) continue;

        const techBookings = bookingMap.get(techId) || [];
        const conflicts = techBookings.some(b => s < b.end && slotEnd > b.start);
        if (conflicts) continue;

        techAvailableCount++;
      }

      const unassignedConflicts = unassignedIntervals.some(b => s < b.end && slotEnd > b.start);
      if (unassignedConflicts) {
        techAvailableCount = Math.max(0, techAvailableCount - 1);
      }

      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const bufferMinutes = 30;
      const cutoff = currentMinutes + bufferMinutes;
      const minAdvanceMinutes = 120;
      const earliestMs = now.getTime() + minAdvanceMinutes * 60000;
      const earliestDate = new Date(earliestMs);
      let earliestMinutes = 0;
      if (isToday) {
        if (earliestDate.toDateString() === targetDate.toDateString()) {
          earliestMinutes = earliestDate.getHours() * 60 + earliestDate.getMinutes();
        } else {
          earliestMinutes = 24 * 60;
        }
      }

      const isPast = isToday && (s < cutoff || s < earliestMinutes);
      const available = techAvailableCount > 0 && !isPast;

      timeSlots.push({
        startTime: minutesToTime(s),
        available,
        availableCount: techAvailableCount,
        isPast,
      });
    }

    res.json({ timeSlots });
  } catch (err) {
    console.error("GET /api/products/schedule/time-slots error:", err);
    res.status(500).json({ error: err.message || "Failed to fetch time slots" });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Technician = require('../models/Technician');
const TechnicianSchedule = require('../models/TechnicianSchedule');
const NonWorkingDay = require('../models/NonWorkingDay');
const CoreService = require('../models/CoreService');
const RepairService = require('../models/RepairService');
const BookingService = require('../models/BookingService');
const LeaveRequest = require('../models/LeaveRequest');
const {
  getMinAdvanceMinutes,
  getBufferMinutes,
  getBufferMinutesSync,
  getInspectionDurationMinutes,
  computeCapacityConsumption,
  earliestAllowedDateTime,
  checkAdvanceNotice,
} = require('../utils/bookingPolicy');
const schedulingEngine = require('../utils/enterpriseSchedulingEngine');

// ── Company-wide working hours (internal constants) ───────────────────────────
const COMPANY_START_MINUTES = 480; // 8:00 AM
const COMPANY_END_MINUTES = 1140;  // 7:00 PM (includes overtime)

// Default working days for technicians without a schedule (Mon–Fri 8–5)
const DEFAULT_WORKING_DAYS = [
  { dayOfWeek: 1, startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES },
  { dayOfWeek: 3, startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES },
  { dayOfWeek: 4, startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES },
  { dayOfWeek: 5, startMinutes: COMPANY_START_MINUTES, endMinutes: COMPANY_END_MINUTES },
];
const DEFAULT_NON_WORKING = [
  { dayOfWeek: 0 }, { dayOfWeek: 2 }, { dayOfWeek: 6 },
];

function formatDateKey(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

/**
 * GET /api/schedule/available-dates
 *
 * Capacity-based date availability for the customer-facing calendar.
 *
 * Exposes ONLY company-level capacity — no individual technician schedules,
 * names, or IDs are included in the response.  Technicians are used internally
 * to compute aggregate capacity, but the customer never sees them.
 *
 * Capacity consumption per slot:
 *   estimated service duration + travel time + operational buffer
 *
 * The buffer absorbs minor service overruns so that consecutive bookings
 * don't cascade into conflicts.
 */
router.get('/available-dates', async (req, res) => {
  try {
    const { serviceId, duration: queryDuration, quantity: queryQuantity, mode = 'ai-suggested' } = req.query;

    if (!serviceId && !queryDuration) {
      return res.status(400).json({ error: 'Service ID or duration is required' });
    }

    // ── 1. Resolve service (server-authoritative) when no explicit duration ──
    let service = null;
    let serviceDuration = 60;
    if (queryDuration && Number.isFinite(Number(queryDuration)) && Number(queryDuration) > 0) {
      serviceDuration = Number(queryDuration);
    } else if (serviceId) {
      if (mongoose.Types.ObjectId.isValid(serviceId)) {
        service = await CoreService.findById(serviceId);
        if (!service) service = await RepairService.findById(serviceId);
      } else {
        service = await CoreService.findOne({ slug: serviceId });
        if (!service) service = await RepairService.findOne({ slug: serviceId });
      }
      if (!service) {
        return res.status(404).json({ error: 'Service not found' });
      }
      serviceDuration = service.durationMinutes
        || service.estimatedDurationMinutes
        || service.duration
        || 60;
    }

    // Quantity multiplier: Total Duration = (Service Duration × Quantity) + Buffer + Travel
    const quantity = Math.max(1, Number(queryQuantity) || 1);
    const totalServiceDuration = serviceDuration * quantity;
    const travelTime = 30; // default travel buffer
    const bufferTime = await getBufferMinutes();
    const capacityPerSlot = totalServiceDuration + travelTime + bufferTime;

    // ── Block if booking exceeds working hours + overtime ──────────────────
    const totalWorkingMinutes = COMPANY_END_MINUTES - COMPANY_START_MINUTES;
    if (capacityPerSlot > totalWorkingMinutes) {
      return res.json({
        availableDates: [],
        totalAvailable: 0,
        totalBooked: 0,
        mode,
        serviceDuration,
        quantity,
        travelTime,
        bufferTime,
        capacityPerSlot,
        blocked: true,
        message: `This booking requires ${Math.ceil(capacityPerSlot / 60)} hours but only ${Math.floor(totalWorkingMinutes / 60)} hours are available. Please reduce the quantity or contact us for project scheduling.`,
      });
    }

    // ── 3. Load ALL active technicians (internal only — never exposed) ────
    const technicians = await Technician.find({ active: { $ne: false } });
    const techIds = technicians.map(t => t._id);

    if (techIds.length === 0) {
      console.warn('⚠️ No active technicians — calendar will show no available dates');
    }

    // ── 4. Load schedules and apply defaults ──────────────────────────────
    const scheduleMap = {};
    const schedules = await TechnicianSchedule.find({ technicianId: { $in: techIds } });
    schedules.forEach(s => { scheduleMap[s.technicianId.toString()] = s; });

    for (const tech of technicians) {
      const tid = tech._id.toString();
      if (!scheduleMap[tid]) {
        scheduleMap[tid] = {
          workingDays: DEFAULT_WORKING_DAYS,
          nonWorkingWeekdays: DEFAULT_NON_WORKING,
          restDates: [],
        };
      }
    }

    // ── 5. Batch-fetch bookings for 60-day window (ONE query) ─────────────
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const windowEnd = new Date(today);
    windowEnd.setDate(today.getDate() + 60);
    windowEnd.setHours(23, 59, 59, 999);

    const activeBookingStatuses = [
      'pending', 'payment_verified', 'awaiting_assignment', 'assigned',
      'pending_reassignment', 'confirmed', 'scheduled', 'on-the-way', 'arrived', 'in-progress',
      'repair_requested', 'inspection_scheduled', 'inspection_in_progress',
      'repair_approved', 'ready_for_repair', 'repair_scheduled', 'repair_in_progress',
    ];

    const allBookings = await BookingService.find({
      technicianId: { $in: techIds.length > 0 ? techIds : [new mongoose.Types.ObjectId()] },
      bookingDate: { $gte: today, $lte: windowEnd },
      status: { $in: activeBookingStatuses },
    }).select('technicianId bookingDate startTime serviceDurationMinutes travelTime').lean();

    // Build lookup: Map<"YYYY-MM-DD", Map<"technicianId", Array<{start,end}>>>
    const bookingMap = new Map();
    allBookings.forEach(b => {
      const bd = new Date(b.bookingDate);
      const dateKey = `${bd.getFullYear()}-${String(bd.getMonth() + 1).padStart(2, '0')}-${String(bd.getDate()).padStart(2, '0')}`;
      const techKey = b.technicianId.toString();
      if (!bookingMap.has(dateKey)) bookingMap.set(dateKey, new Map());
      const techBookings = bookingMap.get(dateKey);
      if (!techBookings.has(techKey)) techBookings.set(techKey, []);

      // Derive end time from stored data — use capacityPerSlot as the
      // conservative estimate for existing bookings too
      const bStart = timeStrToMinutes(b.startTime);
      const bServiceDuration = Number(b.serviceDurationMinutes) || serviceDuration;
      const bTravelTime = Number(b.travelTime) || travelTime;
      const bEnd = bStart + bServiceDuration + bTravelTime + bufferTime;

      techBookings.get(techKey).push({ start: bStart, end: bEnd });
    });

    // Also fetch bookings without a technician — they still consume capacity
    const unassignedBookings = await BookingService.find({
      $or: [
        { technicianId: { $exists: false } },
        { technicianId: null },
      ],
      bookingDate: { $gte: today, $lte: windowEnd },
      status: { $in: activeBookingStatuses },
    }).select('bookingDate startTime serviceDurationMinutes travelTime').lean();

    // Build per-date lookup for unassigned bookings
    const unassignedBookingMap = new Map();
    unassignedBookings.forEach(b => {
      const bd = new Date(b.bookingDate);
      const dateKey = `${bd.getFullYear()}-${String(bd.getMonth() + 1).padStart(2, '0')}-${String(bd.getDate()).padStart(2, '0')}`;
      if (!unassignedBookingMap.has(dateKey)) unassignedBookingMap.set(dateKey, []);
      const bStart = timeStrToMinutes(b.startTime);
      const bServiceDuration = Number(b.serviceDurationMinutes) || serviceDuration;
      const bTravelTime = Number(b.travelTime) || travelTime;
      const bEnd = bStart + bServiceDuration + bTravelTime + bufferTime;
      unassignedBookingMap.get(dateKey).push({ start: bStart, end: bEnd });
    });

    // ── 6. Load non-working days / holidays (one query) ───────────────────
    const nonWorkingDays = await NonWorkingDay.find({
      $or: [{ service: null }, ...(service ? [{ service: service._id }] : [])],
    });
    const nonWorkingDateSet = new Set(
      nonWorkingDays.map(nwd => {
        const d = new Date(nwd.date);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }),
    );

    // ── 7. Minimum advance booking notice ─────────────────────────────────
    const minAdvanceMinutes = await getMinAdvanceMinutes();
    const earliestAllowed = earliestAllowedDateTime(minAdvanceMinutes);
    const earliestAllowedMinutes = earliestAllowed.getHours() * 60 + earliestAllowed.getMinutes();
    const earliestAllowedDate = new Date(earliestAllowed);
    earliestAllowedDate.setHours(0, 0, 0, 0);

    // ── 7b. Load approved leave requests for the 60-day window ────────────
    const leaveRecords = await LeaveRequest.find({
      technicianId: { $in: techIds },
      status: "approved",
      startDate: { $lte: windowEnd },
      endDate: { $gte: today },
    }).select("technicianId startDate endDate").lean();

    // Build per-tech lookup: Map<techId, Array<{start: Date, end: Date}>>
    const leaveMap = new Map();
    leaveRecords.forEach(lr => {
      const tid = lr.technicianId.toString();
      if (!leaveMap.has(tid)) leaveMap.set(tid, []);
      leaveMap.get(tid).push({ start: new Date(lr.startDate), end: new Date(lr.endDate) });
    });

    // ── 7c. Commercial project reservations ──────────────────────────
    // Projects reserve technician capacity per working day. The remaining
    // pool (active techs − leave − project reservations) is what standard
    // bookings can consume. A day is only fully blocked when this pool
    // reaches zero. Fetched once for the whole window (single query).
    let projectResMap = new Map(); // dateKey -> reservedTechnicians
    try {
      projectResMap = await schedulingEngine.getProjectReservedByDateMap(today, windowEnd);
    } catch (projErr) {
      console.warn('⚠️ Project reservation lookup failed (non-fatal):', projErr.message);
    }

    // ── 8. Compute capacity per day ───────────────────────────────────────
    const availableDates = [];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    let debugSkipHoliday = 0, debugSkipNoTech = 0, debugIncluded = 0, debugSkipAdvance = 0;

    for (let i = 0; i < 60; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(today.getDate() + i);
      const dateKey = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}-${String(checkDate.getDate()).padStart(2, '0')}`;
      const dayOfWeek = checkDate.getDay();

      if (nonWorkingDateSet.has(dateKey)) { debugSkipHoliday++; continue; }
      if (checkDate.getTime() < earliestAllowedDate.getTime()) { debugSkipAdvance++; continue; }

      const dayBookings = bookingMap.get(dateKey) || new Map();
      const dayUnassigned = unassignedBookingMap.get(dateKey) || [];
      let hasAnyWorkingTech = false;

      // ── Collect working techs and their booking intervals for this day ──
      // Build a list of techs available on this date along with all booking
      // intervals (assigned + unassigned) that consume their capacity.
      const dayWorkingTechs = [];
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

        // Check approved leave
        const techLeaveDates = leaveMap.get(techId) || [];
        const isOnLeave = techLeaveDates.some(lr =>
          checkDate >= lr.start && checkDate <= lr.end
        );
        if (isOnLeave) continue;

        hasAnyWorkingTech = true;

        // Combine assigned bookings + unassigned bookings — both consume
        // capacity from every tech's pool (unassigned will be assigned later).
        const techBookings = dayBookings.get(techId) || [];
        const allIntervals = [...techBookings];
        for (const ub of dayUnassigned) {
          if (ub.end > COMPANY_START_MINUTES && ub.start < COMPANY_END_MINUTES) {
            allIntervals.push(ub);
          }
        }

        dayWorkingTechs.push({
          id: techId,
          startMinutes: workingDay.startMinutes,
          intervals: allIntervals,
        });
      }

      if (!hasAnyWorkingTech) { debugSkipNoTech++; continue; }

      // ── Project-reserved techs (occupied all day by commercial projects) ──
      const dayProjectReserved = projectResMap.get(dateKey) || 0;

      // ── Count distinct time windows (matches /time-slots endpoint) ──────
      // Instead of summing per-technician slot counts (which inflates the
      // number), count how many distinct 30-minute windows have at least one
      // free technician. This matches what customers actually see when they
      // pick a date and view available time-slot buttons.
      const DAY_SLOT_INTERVAL = 30;
      let dayTotalCapacity = 0;
      let dayTotalAvailable = 0;

      for (let s = COMPANY_START_MINUTES; s + capacityPerSlot <= COMPANY_END_MINUTES; s += DAY_SLOT_INTERVAL) {
        const slotEnd = s + capacityPerSlot;

        // Today: skip windows before advance-notice cutoff
        if (i === 0 && s < earliestAllowedMinutes) continue;

        // Count how many working techs are free for this entire window
        let freeTechs = 0;
        for (const t of dayWorkingTechs) {
          if (t.startMinutes > s) continue;
          const hasConflict = t.intervals.some(b => s < b.end && slotEnd > b.start);
          if (!hasConflict) freeTechs++;
        }

        // Subtract project-reserved techs (they're occupied all day)
        freeTechs = Math.max(0, freeTechs - dayProjectReserved);

        dayTotalCapacity++;
        if (freeTechs > 0) dayTotalAvailable++;
      }

      // Today: skip the day entirely if advance notice blocks all windows
      if (i === 0) {
        if (earliestAllowedMinutes >= COMPANY_END_MINUTES) {
          debugSkipAdvance++; continue;
        }
        if (dayTotalAvailable === 0) { debugSkipAdvance++; continue; }
      }

      debugIncluded++;

      availableDates.push({
        date: dateKey,
        dayName: dayNames[dayOfWeek],
        dayOfMonth: checkDate.getDate(),
        month: monthNames[checkDate.getMonth()],
        availableSlots: dayTotalAvailable,
        reservedSlots: Math.max(0, dayTotalCapacity - dayTotalAvailable),
        totalSlots: dayTotalCapacity,
      });
    }

    // ── 9. Shape response by mode ─────────────────────────────────────────
    let responseDates;
    if (mode === 'ai-suggested') {
      const twoWeeks = new Date(today);
      twoWeeks.setDate(today.getDate() + 14);
      const within14 = availableDates.filter(d => new Date(d.date) <= twoWeeks);
      const beyond = availableDates
        .filter(d => new Date(d.date) > twoWeeks && d.availableSlots > 0)
        .sort((a, b) => b.availableSlots - a.availableSlots)
        .slice(0, 3);
      responseDates = [...within14, ...beyond].sort((a, b) => new Date(a.date) - new Date(b.date));
    } else {
      responseDates = availableDates.sort((a, b) => new Date(a.date) - new Date(b.date));
    }

    console.log(`📅 available-dates [${mode}]: ${responseDates.length} dates, ` +
      `${technicians.length} techs, ${allBookings.length} bookings | ` +
      `skip=holiday:${debugSkipHoliday} noTech:${debugSkipNoTech} advance:${debugSkipAdvance} included:${debugIncluded}`);

    // ── 10. Response — NO technician data exposed ─────────────────────────
    res.json({
      availableDates: responseDates,
      totalAvailable: responseDates.filter(d => d.availableSlots > 0).length,
      totalBooked: responseDates.filter(d => d.availableSlots === 0).length,
      mode,
      serviceDuration,
      quantity,
      travelTime,
      bufferTime,
      capacityPerSlot,
      minAdvanceNoticeMinutes: minAdvanceMinutes,
    });

  } catch (error) {
    console.error('❌ Error getting available dates:', error);
    res.status(500).json({ error: 'Failed to get available dates' });
  }
});

/**
 * GET /api/bookings/technician/:technicianId/date/:date
 * Get existing bookings for a technician on a specific date
 * Professional backend implementation with comprehensive booking data
 */
router.get('/bookings/technician/:technicianId/date/:date', async (req, res) => {
  try {
    const { technicianId, date } = req.params;
    
    if (!technicianId || !date) {
      return res.status(400).json({ error: 'Technician ID and date are required' });
    }
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(technicianId)) {
      console.error(`❌ Invalid technician ID format: ${technicianId}`);
      return res.status(400).json({ error: 'Invalid technician ID format' });
    }
    
    // Parse date and create date range for the entire day
    const targetDate = new Date(date);
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);
    
    console.log(`📋 Fetching bookings for technician ${technicianId} on ${date}`);
    
    // Find all active bookings for this technician on this date
    // Include all statuses that block time slots
    const bookings = await BookingService.find({
      technicianId: technicianId,
      bookingDate: {
        $gte: startOfDay,
        $lte: endOfDay
      },
      status: { 
        $in: ['pending', 'payment_verified', 'awaiting_assignment', 'assigned', 'pending_reassignment', 'confirmed', 'scheduled', 'on-the-way', 'arrived', 'in-progress'] 
      }
    })
    .select('startTime endTime status bookingDate bookingReference customerName serviceName services totalPrice')
    .lean();
    
    console.log(`📋 Found ${bookings.length} active bookings for ${date}`);
    
    // Return bookings with formatted data
    const formattedBookings = bookings.map(booking => ({
      _id: booking._id,
      startTime: booking.startTime,
      endTime: booking.endTime,
      status: booking.status,
      bookingDate: booking.bookingDate,
      bookingReference: booking.bookingReference,
      customerName: booking.customerName || booking.customer?.name,
      serviceName: booking.serviceName || (booking.services && booking.services.length > 0 ? 
        booking.services.map(s => s.name).join(', ') : 'Service'),
      totalPrice: booking.totalPrice
    }));
    
    res.json(formattedBookings);
    
  } catch (error) {
    console.error('❌ Error fetching technician bookings:', error);
    res.status(500).json({ error: 'Failed to fetch bookings', details: error.message });
  }
});

/**
 * GET /api/schedule/technician/:technicianId/booked-dates
 * Get all booked dates for a technician within a date range
 * Used by calendar to show which dates have bookings
 */
router.get('/technician/:technicianId/booked-dates', async (req, res) => {
  try {
    const { technicianId } = req.params;
    const { startDate, endDate } = req.query;
    
    if (!technicianId) {
      return res.status(400).json({ error: 'Technician ID is required' });
    }
    
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(technicianId)) {
      return res.status(400).json({ error: 'Invalid technician ID format' });
    }
    
    // Set date range (default to next 60 days if not provided)
    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    
    console.log(`📅 Fetching booked dates for technician ${technicianId} from ${formatDateKey(start)} to ${formatDateKey(end)}`);
    
    // Get all bookings in the date range
    const bookings = await BookingService.find({
      technicianId: technicianId,
      bookingDate: {
        $gte: start,
        $lte: end
      },
      status: { 
        $in: ['pending', 'payment_verified', 'awaiting_assignment', 'assigned', 'pending_reassignment', 'confirmed', 'scheduled', 'on-the-way', 'arrived', 'in-progress', 'repair_requested', 'inspection_scheduled', 'inspection_in_progress', 'repair_approved', 'ready_for_repair', 'repair_scheduled', 'repair_in_progress'] 
      }
    })
    .select('bookingDate startTime endTime status')
    .lean();
    
    // Group bookings by date
    const bookedDateMap = {};
    bookings.forEach(booking => {
      const dateKey = formatDateKey(new Date(booking.bookingDate));
      if (!bookedDateMap[dateKey]) {
        bookedDateMap[dateKey] = [];
      }
      bookedDateMap[dateKey].push({
        startTime: booking.startTime,
        endTime: booking.endTime,
        status: booking.status
      });
    });
    
    console.log(`📅 Found bookings on ${Object.keys(bookedDateMap).length} different dates`);
    
    res.json({
      technicianId,
      dateRange: {
        start: formatDateKey(start),
        end: formatDateKey(end)
      },
      bookedDates: bookedDateMap,
      totalBookings: bookings.length
    });
    
  } catch (error) {
    console.error('❌ Error fetching booked dates:', error);
    res.status(500).json({ error: 'Failed to fetch booked dates', details: error.message });
  }
});

/**
 * GET /api/schedule/projects
 * Returns active commercial projects as multi-day calendar bars so the
 * customer and admin calendars can render them alongside standard bookings.
 *
 * Query: optional `month` (YYYY-MM) to scope the result; defaults to the
 * current month ± 1 month so cross-month projects still render.
 *
 * Response never exposes internal technician identities to customers — only
 * the count of reserved technicians and project metadata.
 */
router.get('/projects', async (req, res) => {
  try {
    const { month } = req.query;
    let focus = new Date();
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      focus = new Date(y, m - 1, 1);
    }
    const rangeStart = new Date(focus); rangeStart.setDate(1);
    rangeStart.setMonth(rangeStart.getMonth() - 1);
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = new Date(focus); rangeEnd.setMonth(rangeEnd.getMonth() + 1);
    rangeEnd.setHours(23, 59, 59, 999);

    const projects = await schedulingEngine.getProjectReservationsForMonth
      ? await schedulingEngine.getProjectReservationsForMonth(rangeStart, rangeEnd)
      : [];

    res.json({ projects, month: month || null });
  } catch (error) {
    console.error('❌ Error fetching project bars:', error);
    res.status(500).json({ error: 'Failed to fetch projects', details: error.message });
  }
});

/**
 * GET /api/schedule/booking-policy
 * Returns the minimum advance booking notice configuration and inspection duration.
 * Used by the frontend calendar to compute earliest bookable time.
 */
router.get('/booking-policy', async (req, res) => {
  try {
    const minAdvanceMinutes = await getMinAdvanceMinutes();
    const inspectionDuration = await getInspectionDurationMinutes();
    const earliest = earliestAllowedDateTime(minAdvanceMinutes);

    // Large-project threshold (configurable in Admin → Settings → Scheduling)
    let largeProjectThresholdHours = 8;
    try {
      const { getLargeProjectThresholdHours } = require('../utils/bookingPolicy');
      largeProjectThresholdHours = await getLargeProjectThresholdHours();
    } catch (e) { /* keep default */ }

    res.json({
      minAdvanceNoticeMinutes: minAdvanceMinutes,
      inspectionDurationMinutes: inspectionDuration,
      earliestAllowedDateTime: earliest.toISOString(),
      largeProjectThresholdHours,
    });
  } catch (error) {
    console.error('❌ Error getting booking policy:', error);
    res.status(500).json({ error: 'Failed to get booking policy' });
  }
});

/**
 * GET /api/schedule/holidays-and-nonworking
 * Get public holidays and non-working days
 */
router.get('/holidays-and-nonworking', async (req, res) => {
  try {
    // Get all non-working days (includes both holidays and admin-created day-offs)
    const nonWorkingDays = await NonWorkingDay.find({
      date: { $gte: new Date() }
    }).sort({ date: 1 }).limit(365);

    // Separate into holidays and regular non-working days
    // NonWorkingDay schema has no isHoliday field; use reason to identify public holidays
    // (importNagerHolidays.js stores reason = "public holiday")
    const holidays = nonWorkingDays.filter(nwd => nwd.reason === 'public holiday');
    const regularNonWorking = nonWorkingDays.filter(nwd => nwd.reason !== 'public holiday');
    
    res.json({
      holidays: holidays.map(h => ({
        date: h.date,
        name: h.note || h.reason || 'Holiday',
        description: h.description
      })),
      nonWorkingDays: regularNonWorking.map(nwd => ({
        date: nwd.date,
        reason: nwd.note || nwd.reason || 'Non-working day',
        description: nwd.description
      }))
    });
    
  } catch (error) {
    console.error('❌ Error getting holidays and non-working days:', error);
    res.status(500).json({ error: 'Failed to get holidays and non-working days' });
  }
});

/**
 * GET /api/schedule/time-slots
 *
 * Returns preferred service start times for a given date.
 *
 * These are NOT guaranteed completion times — they represent the customer's
 * requested start time.  The system uses estimated duration + travel time +
 * operational buffer internally to ensure capacity is available.
 *
 * Customers see only the start time.  Actual service completion depends on
 * site conditions, service requirements, and operational factors.
 *
 * Supports both technician-specific (admin) and capacity-based (customer) modes.
 */
router.get('/time-slots', async (req, res) => {
  try {
    const { technicianId, serviceId, date, duration: queryDuration, quantity: queryQuantity } = req.query;

    if ((!serviceId && !queryDuration) || !date) {
      return res.status(400).json({ error: 'Service ID (or duration) and date are required' });
    }

    // ── 1. Resolve service or use explicit duration ───────────────────────
    let service = null;
    let serviceDuration = 60;
    if (queryDuration && Number.isFinite(Number(queryDuration)) && Number(queryDuration) > 0) {
      serviceDuration = Number(queryDuration);
      if (serviceId) {
        service = await CoreService.findById(serviceId);
        if (!service) service = await RepairService.findById(serviceId);
      }
    } else if (serviceId) {
      service = await CoreService.findById(serviceId);
      if (!service) service = await RepairService.findById(serviceId);
      if (!service) {
        return res.status(404).json({ error: 'Service not found' });
      }
      serviceDuration = service.durationMinutes
        || service.estimatedDurationMinutes
        || service.duration
        || 60;
    }

    // Quantity multiplier: Total Duration = (Service Duration × Quantity) + Buffer + Travel
    const quantity = Math.max(1, Number(queryQuantity) || 1);
    const totalServiceDuration = serviceDuration * quantity;
    const travelTime = 30;
    const bufferTime = await getBufferMinutes();
    const capacityPerSlot = totalServiceDuration + travelTime + bufferTime;

    // ── Block if booking exceeds working hours + overtime ──────────────────
    const totalWorkingMinutes = COMPANY_END_MINUTES - COMPANY_START_MINUTES;
    if (capacityPerSlot > totalWorkingMinutes) {
      return res.json({
        timeSlots: [],
        date,
        serviceDuration,
        quantity,
        capacityPerSlot,
        mode: 'capacity',
        totalTechnicians: 0,
        blocked: true,
        message: `This booking requires ${Math.ceil(capacityPerSlot / 60)} hours but only ${Math.floor(totalWorkingMinutes / 60)} hours are available. Please reduce the quantity or contact us for project scheduling.`,
      });
    }

    // ── 2. Validate date ──────────────────────────────────────────────────
    const selectedDate = new Date(date);
    selectedDate.setHours(0, 0, 0, 0);
    const dayOfWeek = selectedDate.getDay();

    const nonWorkingDays = await NonWorkingDay.find({
      $or: [{ service: null }, { service: service?._id || null }],
    });
    const isNonWorkingDay = nonWorkingDays.some(nwd => {
      const nwdDate = new Date(nwd.date);
      nwdDate.setHours(0, 0, 0, 0);
      return nwdDate.getTime() === selectedDate.getTime();
    });
    if (isNonWorkingDay) {
      return res.json({ timeSlots: [], message: 'Non-working day', isNonWorkingDay: true });
    }

    // ── 3. Technician-specific mode (admin/rescheduling only) ─────────────
    if (technicianId) {
      if (!mongoose.Types.ObjectId.isValid(technicianId)) {
        return res.status(400).json({ error: 'Invalid technician ID format' });
      }

      let schedule = await TechnicianSchedule.findOne({ technicianId });
      if (!schedule) {
        schedule = new TechnicianSchedule({
          technicianId,
          workingDays: DEFAULT_WORKING_DAYS,
          nonWorkingWeekdays: DEFAULT_NON_WORKING,
          restDates: [],
        });
        await schedule.save();
      }

      const workingDay = schedule.workingDays.find(wd => wd.dayOfWeek === dayOfWeek);
      if (!workingDay) {
        return res.json({ timeSlots: [], message: 'Technician not working on this day' });
      }

      const timeSlots = await generateTimeSlots(technicianId, selectedDate, workingDay, capacityPerSlot);
      const minAdvMinutes = await getMinAdvanceMinutes();
      const earliestAllowed = earliestAllowedDateTime(minAdvMinutes);
      const earliestMinutes = earliestAllowed.getHours() * 60 + earliestAllowed.getMinutes();
      const isTechToday = selectedDate.getTime() === new Date().setHours(0, 0, 0, 0);
      const filteredSlots = timeSlots.filter(slot => {
        let slotStartMin = parseInt(slot.startTime.split(':')[0]) * 60 + parseInt(slot.startTime.split(':')[1]);
        // Handle 12h AM/PM format (e.g. "1:00 PM")
        const ampmMatch = slot.startTime.match(/(AM|PM)$/i);
        if (ampmMatch) {
          const isPM = ampmMatch[1].toUpperCase() === 'PM';
          const rawH = parseInt(slot.startTime.split(':')[0]);
          if (isPM && rawH < 12) slotStartMin = (rawH + 12) * 60 + parseInt(slot.startTime.split(':')[1]);
          else if (!isPM && rawH === 12) slotStartMin = parseInt(slot.startTime.split(':')[1]);
        }
        if (isTechToday && slotStartMin < earliestMinutes) return false;
        return true;
      });
      return res.json({
        timeSlots: filteredSlots,
        date,
        capacityPerSlot,
        mode: 'technician',
        minAdvanceNoticeMinutes: minAdvMinutes,
        workingHours: { start: workingDay.startMinutes, end: workingDay.endMinutes },
      });
    }

    // ── 4. Capacity-based mode (customer-facing) ──────────────────────────
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const technicians = await Technician.find({ active: { $ne: false } });
    const techIds = technicians.map(t => t._id);
    const schedules = await TechnicianSchedule.find({ technicianId: { $in: techIds } });

    const scheduleMap = {};
    schedules.forEach(s => { scheduleMap[s.technicianId.toString()] = s; });

    for (const tech of technicians) {
      const tid = tech._id.toString();
      if (!scheduleMap[tid]) {
        scheduleMap[tid] = {
          workingDays: DEFAULT_WORKING_DAYS,
          nonWorkingWeekdays: DEFAULT_NON_WORKING,
          restDates: [],
        };
      }
    }

    // ── 4a. Fetch leave requests for the selected date ─────────────────────
    const leaveRequests = await LeaveRequest.find({
      technicianId: { $in: techIds },
      status: "approved",
      startDate: { $lte: selectedDate },
      endDate: { $gte: selectedDate },
    }).select("technicianId").lean();
    const onLeaveTechIds = new Set(leaveRequests.map(lr => lr.technicianId.toString()));

    // ── Determine which technicians are workable on this date ─────────────
    // A technician contributes capacity when working this weekday, not on a
    // rest date, and not on approved leave. Their existing bookings are kept
    // so each window can be checked for overlap individually.
    const workableTechs = [];
    for (const tech of technicians) {
      const techId = tech._id.toString();
      const techSchedule = scheduleMap[techId];
      if (!techSchedule) continue;

      const workingDay = techSchedule.workingDays.find(wd => wd.dayOfWeek === dayOfWeek);
      const isNonWorkingWeekday = techSchedule.nonWorkingWeekdays?.some(nwd => nwd.dayOfWeek === dayOfWeek);
      if (!workingDay || isNonWorkingWeekday) continue;

      const isRestDate = techSchedule.restDates?.some(rd => {
        const rdDate = new Date(rd.date);
        rdDate.setHours(0, 0, 0, 0);
        return rdDate.getTime() === selectedDate.getTime();
      });
      if (isRestDate) continue;

      if (onLeaveTechIds.has(techId)) continue;

      workableTechs.push({ id: techId, workingDay });
    }

    // ── Existing bookings for the day (assigned + unassigned) ─────────────
    const dayStartUn = new Date(selectedDate);
    dayStartUn.setHours(0, 0, 0, 0);
    const dayEndUn = new Date(selectedDate);
    dayEndUn.setHours(23, 59, 59, 999);
    const activeStatues = ['pending', 'payment_verified', 'awaiting_assignment', 'assigned', 'pending_reassignment', 'confirmed', 'scheduled', 'on-the-way', 'arrived', 'in-progress', 'repair_requested', 'inspection_scheduled', 'inspection_in_progress', 'repair_approved', 'ready_for_repair', 'repair_scheduled', 'repair_in_progress'];

    const dayBookings = await BookingService.find({
      bookingDate: { $gte: dayStartUn, $lte: dayEndUn },
      status: { $in: activeStatues },
    }).select('technicianId startTime endTime serviceDurationMinutes travelTime').lean();

    // ── Commercial project reservations for this date ───────────────────────
    // Reserved technicians are removed from the pool of techs that can take a
    // standard appointment, so standard bookings consume REMAINING capacity.
    let projectReservedTechs = 0;
    try {
      const proj = await schedulingEngine.getProjectReservationsForDate(selectedDate);
      projectReservedTechs = proj.reservedTechnicians || 0;
    } catch (projErr) {
      console.warn('⚠️ Project reservation lookup failed (non-fatal):', projErr.message);
    }


    // Capacity end (minutes) for a booking, using service + travel + buffer.
    const bookingCapacityEnd = (b) => {
      const s = timeStrToMinutes(b.startTime);
      if (Number.isNaN(s)) return NaN;
      const explicitEnd = timeStrToMinutes(b.endTime);
      if (Number.isFinite(explicitEnd) && explicitEnd > s) return explicitEnd;
      const svc = Number(b.serviceDurationMinutes) || 60;
      const travel = Math.max(0, Number(b.travelTime) || 0);
      const buffer = getBufferMinutesSync();
      return s + svc + travel + buffer;
    };

    let fullDayReservations = 0; // project / date-only bookings

    // ── Per-technician booking intervals (for dynamic slot generation) ─────
    // Build a list of occupied intervals per technician so we can check each
    // candidate start time against every tech's actual bookings.
    const techBookedIntervals = new Map(); // techId -> [{start, end}]

    for (const b of dayBookings) {
      const s = timeStrToMinutes(b.startTime);
      const e = bookingCapacityEnd(b);
      if (Number.isNaN(s) || !Number.isFinite(e) || e <= s) {
        // Can't parse — treat as full-day reservation
        fullDayReservations++;
        continue;
      }
      if (b.technicianId) {
        const key = String(b.technicianId);
        if (!techBookedIntervals.has(key)) techBookedIntervals.set(key, []);
        techBookedIntervals.get(key).push({ start: s, end: e });
      } else {
        // Unassigned bookings consume one slot from every tech's pool
        for (const tech of workableTechs) {
          if (!techBookedIntervals.has(tech.id)) techBookedIntervals.set(tech.id, []);
          techBookedIntervals.get(tech.id).push({ start: s, end: e });
        }
      }
    }

    // Sort intervals by start time for each tech (for early-exit optimization)
    for (const [, intervals] of techBookedIntervals) {
      intervals.sort((a, b) => a.start - b.start);
    }

    /**
     * Count how many technicians can accommodate a booking that starts at
     * `slotStart` and occupies [slotStart, slotStart + capacityPerSlot].
     * A tech is "free" if none of their booked intervals overlap this span,
     * AND the span fits within company working hours (not just tech schedule).
     */
    function countFreeTechs(slotStart, slotEnd) {
      let free = 0;
      for (const tech of workableTechs) {
        // Must fit within company working hours (includes overtime)
        if (slotStart < COMPANY_START_MINUTES || slotEnd > COMPANY_END_MINUTES) continue;
        // Check if any existing booking overlaps this slot
        const booked = techBookedIntervals.get(tech.id) || [];
        const hasOverlap = booked.some(b => slotStart < b.end && slotEnd > b.start);
        if (!hasOverlap) free++;
      }
      // Subtract project-reserved techs (they're occupied all day)
      free = Math.max(0, free - projectReservedTechs);
      return free;
    }

    // Filter by advance notice
    const minAdvanceMinutes = await getMinAdvanceMinutes();
    const now = new Date();
    const earliestAllowed = earliestAllowedDateTime(minAdvanceMinutes);
    const earliestAllowedMinutes = earliestAllowed.getHours() * 60 + earliestAllowed.getMinutes();
    const isToday = selectedDate.getTime() === startOfToday.getTime();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const cutoff = currentMinutes + 30;

    // ── Dynamic 30-minute interval slots ──────────────────────────────────
    // Generate a potential start time every 30 minutes from company open to
    // close. For each, check: (a) the full booking fits before closing, and
    // (b) at least one technician has no overlapping bookings for the entire
    // duration (service + travel + buffer). Only show slots that pass both.
    const SLOT_INTERVAL = 30; // minutes between potential start times

    const timeSlots = [];
    for (let slotStart = COMPANY_START_MINUTES; slotStart + capacityPerSlot <= COMPANY_END_MINUTES; slotStart += SLOT_INTERVAL) {
      const slotEnd = slotStart + capacityPerSlot;

      // Skip slots in the past or before advance-notice cutoff
      const isPastSlot = isToday && slotStart < cutoff;
      const isBeforeAdvanceNotice = isToday && slotStart < earliestAllowedMinutes;
      if (isPastSlot || isBeforeAdvanceNotice) continue;

      // Count how many technicians can handle this booking
      const availableCount = countFreeTechs(slotStart, slotEnd);

      if (availableCount > 0) {
        timeSlots.push({
          startTime: minutesToTime(slotStart),
          label: minutesToTime(slotStart),
          duration: serviceDuration,
          available: true,
          availableCount,
          isPast: false,
        });
      }
    }

    res.json({
      timeSlots,
      date,
      serviceDuration,
      quantity,
      capacityPerSlot,
      mode: 'capacity',
      totalTechnicians: workableTechs.length,
      minAdvanceNoticeMinutes: minAdvanceMinutes,
      workingHours: { start: COMPANY_START_MINUTES, end: COMPANY_END_MINUTES },
    });

  } catch (error) {
    console.error('❌ Error getting time slots:', error);
    res.status(500).json({ error: 'Failed to get time slots' });
  }
});

/**
 * GET /api/schedule/technician/:technicianId/available-slots
 * Get available dates and time slots for a technician (for admin rescheduling)
 * Uses a default duration of 60 minutes if not specified
 */
router.get('/technician/:technicianId/available-slots', async (req, res) => {
  try {
    const { technicianId } = req.params;
    const { duration = 60, days = 30 } = req.query;

    if (!mongoose.Types.ObjectId.isValid(technicianId)) {
      return res.status(400).json({ error: 'Invalid technician ID format' });
    }

    const technician = await Technician.findById(technicianId);
    if (!technician) {
      return res.status(404).json({ error: 'Technician not found' });
    }

    let schedule = await TechnicianSchedule.findOne({ technicianId });
    if (!schedule) {
      schedule = new TechnicianSchedule({
        technicianId,
        workingDays: DEFAULT_WORKING_DAYS,
        nonWorkingWeekdays: DEFAULT_NON_WORKING,
        restDates: [],
      });
      await schedule.save();
    }

    const nonWorkingDays = await NonWorkingDay.find({ service: null });

    // Compute capacity consumption with buffer
    const bufferTime = await getBufferMinutes();
    const capacityPerSlot = parseInt(duration) + 30 + bufferTime; // service + travel + buffer

    const availableDates = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const daysToCheck = parseInt(days) || 30;

    for (let i = 0; i < daysToCheck; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(today.getDate() + i);
      checkDate.setHours(0, 0, 0, 0);

      const dayOfWeek = checkDate.getDay();
      const dateStr = formatDateKey(checkDate);

      const isNonWorkingDay = nonWorkingDays.some(nwd => {
        const nwdDate = new Date(nwd.date);
        nwdDate.setHours(0, 0, 0, 0);
        return nwdDate.getTime() === checkDate.getTime();
      });

      const isRestDate = schedule.restDates.some(rd => {
        const rdDate = new Date(rd.date);
        rdDate.setHours(0, 0, 0, 0);
        return rdDate.getTime() === checkDate.getTime();
      });

      const isNonWorkingWeekday = schedule.nonWorkingWeekdays.some(nwd => nwd.dayOfWeek === dayOfWeek);

      if (isNonWorkingDay || isRestDate || isNonWorkingWeekday) {
        availableDates.push({ date: dateStr, available: false, timeSlots: [] });
        continue;
      }

      const workingDay = schedule.workingDays.find(wd => wd.dayOfWeek === dayOfWeek);
      if (!workingDay) {
        availableDates.push({ date: dateStr, available: false, timeSlots: [] });
        continue;
      }

      const timeSlots = await generateTimeSlots(technicianId, checkDate, workingDay, capacityPerSlot);

      availableDates.push({
        date: dateStr,
        available: timeSlots.length > 0,
        timeSlots: timeSlots.map(slot => ({
          time: slot.startTime,
          capacityPerSlot,
        })),
      });
    }

    res.json({ availableDates, technician: { _id: technician._id, name: technician.name } });

  } catch (error) {
    console.error('❌ Error getting available slots for rescheduling:', error);
    res.status(500).json({ error: 'Failed to get available slots' });
  }
});

/**
 * Helper function to check if a date has available time slots
 */
async function hasAvailableTimeSlots(technicianId, serviceId, date, workingDay, capacityPerSlot) {
  try {
    const timeSlots = await generateTimeSlots(technicianId, date, workingDay, capacityPerSlot);
    return timeSlots.length > 0;
  } catch (error) {
    console.error('Error checking available time slots:', error);
    return false;
  }
}

/**
 * Helper function to get count and time range details of available slots
 */
async function getAvailableSlotsInfo(technicianId, date, workingDay, capacityPerSlot) {
  try {
    const timeSlots = await generateTimeSlots(technicianId, date, workingDay, capacityPerSlot);
    
    const startMinutes = workingDay.startMinutes;
    const endMinutes = workingDay.endMinutes;
    const slotInterval = Math.max(30, capacityPerSlot);
    let totalPossibleSlots = 0;
    for (let s = startMinutes; s + capacityPerSlot <= endMinutes; s += slotInterval) {
      totalPossibleSlots++;
    }
    
    const availableCount = timeSlots.length;
    const reservedCount = totalPossibleSlots - availableCount;
    
    const availableRanges = timeSlots.map(slot => ({
      start: slot.startTime,
      label: minutesToTimeDisplay(slot.startTime),
    }));
    
    return {
      availableCount,
      reservedCount: Math.max(0, reservedCount),
      totalCount: totalPossibleSlots,
      availableRanges,
    };
  } catch (error) {
    console.error('Error getting available slots info:', error);
    return { availableCount: 0, reservedCount: 0, totalCount: 0, availableRanges: [] };
  }
}

/**
 * Derive the end minutes of a booking for overlap checks.
 * Uses the stored endTime if available, otherwise computes from
 * service duration + travel time.  This is used internally for
 * capacity management — it does NOT represent a guaranteed completion time.
 */
function deriveBookingEndMinutes(booking, defaultServiceDuration = 60) {
  const bStart = timeStrToMinutes(booking.startTime);
  const explicitEnd = timeStrToMinutes(booking.endTime);
  if (Number.isFinite(explicitEnd) && explicitEnd > bStart) return explicitEnd;
  const serviceDuration = Number(booking.serviceDurationMinutes) || defaultServiceDuration;
  const travelDuration = Math.max(0, Number(booking.travelTime) || 0);
  if (!Number.isFinite(bStart)) return NaN;
  return bStart + serviceDuration + travelDuration;
}

/**
 * Helper to format time string for display (e.g., "08:00" → "8:00 AM")
 */
function minutesToTimeDisplay(timeStr) {
  const [hours, mins] = timeStr.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
  return `${displayHours}:${mins.toString().padStart(2, '0')} ${period}`;
}

/**
 * Generate time slots for a given date and working day.
 * Slots represent preferred start times — not guaranteed completion windows.
 */
async function generateTimeSlots(technicianId, date, workingDay, capacityPerSlot) {
  const timeSlots = [];
  
  // Get current date and time for comparison
  const now = new Date();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  // Check if the requested date is today or in the past
  const slotDate = new Date(date);
  slotDate.setHours(0, 0, 0, 0);
  
  // If date is in the past, return empty slots
  if (slotDate < today) {
    console.log(`📅 Date ${date} is in the past - no slots available`);
    return [];
  }
  
  // Load minimum advance notice for filtering
  const minAdvanceMinutes = await getMinAdvanceMinutes();
  const earliestAllowed = earliestAllowedDateTime(minAdvanceMinutes);
  const earliestMinutes = earliestAllowed.getHours() * 60 + earliestAllowed.getMinutes();
  const isToday = slotDate.getTime() === today.getTime();
  
  // Get existing bookings for this date
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  const existingBookings = await BookingService.find({
    technicianId,
    bookingDate: {
      $gte: startOfDay,
      $lte: endOfDay
    },
      status: { 
        $in: ['pending', 'payment_verified', 'awaiting_assignment', 'assigned', 'pending_reassignment', 'confirmed', 'scheduled', 'on-the-way', 'arrived', 'in-progress', 'repair_requested', 'inspection_scheduled', 'inspection_in_progress', 'repair_approved', 'ready_for_repair', 'repair_scheduled', 'repair_in_progress'] 
      }
  }).sort({ startTime: 1 });
  
  // Convert working hours to minutes
  const startMinutes = workingDay.startMinutes;
  const endMinutes = workingDay.endMinutes;
  
  // Generate slots using capacity per slot as the interval
  const slotInterval = Math.max(30, capacityPerSlot);
  
  for (let currentStart = startMinutes; currentStart + capacityPerSlot <= endMinutes; currentStart += slotInterval) {
    const currentEnd = currentStart + capacityPerSlot;
    
    // Check if this slot conflicts with existing bookings
    const hasConflict = existingBookings.some(booking => {
      const bookingStart = minutesFromTime(booking.startTime);
      const bookingEnd = deriveBookingEndMinutes(booking);
      
      return (currentStart < bookingEnd && currentEnd > bookingStart);
    });
    
    if (!hasConflict) {
      // STRICT PAST TIME CHECK: Block any slot that's in the past or too close to current time
      const slotStartTime = new Date(date);
      slotStartTime.setHours(Math.floor(currentStart / 60), currentStart % 60, 0, 0);
      
      // For TODAY: check if slot start time is at least 30 minutes in the future
      if (isToday) {
        const todayBuffer = 30;
        const cutoffTime = new Date(now.getTime() + todayBuffer * 60000);
        
        // Block if slot time has already passed or is within buffer
        if (slotStartTime <= cutoffTime) {
          continue; // Skip this slot
        }

        // Block slots that violate minimum advance booking notice
        if (currentStart < earliestMinutes) {
          continue; // Skip this slot
        }
      }
      
      // Add available slot — only startTime is meaningful to the customer
      timeSlots.push({
        startTime: minutesToTime(currentStart),
        available: true
      });
    }
  }
  
  return timeSlots;
}

/**
 * Convert time string (HH:MM 24h or 12h AM/PM) to minutes from midnight
 */
function timeStrToMinutes(timeString) {
  if (!timeString) return 0;
  const raw = String(timeString).trim();
  // Handle raw minutes format (e.g. "480")
  if (/^\d{1,4}$/.test(raw)) {
    return parseInt(raw, 10);
  }
  const ampmMatch = raw.match(/\s*(AM|PM)\s*$/i);
  let cleanTime = raw.replace(/\s*(AM|PM)\s*$/i, '').trim();
  const [hoursStr, minutesStr] = cleanTime.split(':');
  let hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10) || 0;
  if (ampmMatch) {
    const isPM = ampmMatch[1].toUpperCase() === 'PM';
    if (isPM && hours < 12) hours += 12;
    else if (!isPM && hours === 12) hours = 0;
  }
  return (hours * 60) + minutes;
}

/**
 * Convert time string (12-hour AM/PM or 24-hour HH:MM) to minutes
 */
function minutesFromTime(timeString) {
  if (!timeString) return 0;
  const raw = String(timeString).trim();
  
  // Handle raw minutes format (e.g. "480")
  if (/^\d{1,4}$/.test(raw)) {
    return parseInt(raw, 10);
  }
  
  // Handle 12-hour format with AM/PM (e.g., "02:30 PM", "9:00 AM")
  const ampmMatch = raw.match(/\s*(AM|PM)\s*$/i);
  let cleanTime = raw.replace(/\s*(AM|PM)\s*$/i, '').trim();
  
  const [hoursStr, minutesStr] = cleanTime.split(':');
  let hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10) || 0;
  
  if (ampmMatch) {
    const isPM = ampmMatch[1].toUpperCase() === 'PM';
    if (isPM && hours < 12) {
      hours += 12;
    } else if (!isPM && hours === 12) {
      hours = 0;
    }
  }
  
  return (hours * 60) + minutes;
}

/**
 * Convert minutes to 12-hour display string (e.g., "2:00 PM")
 */
function minutesToTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
  return `${displayHours}:${mins.toString().padStart(2, '0')} ${period}`;
}

module.exports = router;

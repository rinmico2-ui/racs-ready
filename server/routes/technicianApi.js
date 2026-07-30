/**
 * Technician-facing REST API
 * Mounted at /api/technician
 * All routes require: authenticated + role === "technician"
 */
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const router = express.Router();
const auth = require("../middleware/authenticate");
const audit = require("../utils/audit");
const EquipmentAssignment = require("../models/EquipmentAssignment");
const Tool = require("../models/Tool");

// ── Proof of completion upload config ──────────────────────────────────
const proofUploadDir = path.join(__dirname, "../public/uploads/completion-proofs");
if (!fs.existsSync(proofUploadDir)) fs.mkdirSync(proofUploadDir, { recursive: true });

const proofStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, proofUploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "proof-" + uniqueSuffix + path.extname(file.originalname));
  },
});
const proofUpload = multer({
  storage: proofStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    cb(null, extOk && mimeOk);
  },
}).single("proofPhoto");

/**
 * Parse a time string to minutes-from-midnight.
 * Handles: "480", "8:00", "8:00 AM", "2:30 PM"
 * Returns NaN on invalid input.
 */
function parseTimeStr(value) {
  if (value === null || value === undefined) return NaN;
  const raw = String(value).trim();
  if (!raw) return NaN;
  // Pure digits → minutes from midnight
  if (/^\d{1,4}$/.test(raw)) return Number(raw);
  // 24h HH:MM
  const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  // 12h with AM/PM
  const ap = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ap) { let hh = Number(ap[1]) % 12; if (ap[3].toUpperCase() === 'PM') hh += 12; return hh * 60 + Number(ap[2]); }
  return NaN;
}

function parseCalendarDateParam(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const normalized = raw.replace(
    /(T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?) (\d{2}:\d{2})$/,
    "$1+$2"
  );
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function loadTechnicianContext(userId) {
  const Technician = require("../models/Technician");
  const tech = await Technician.findOne({ user: userId }).lean();
  if (!tech) return { tech: null, technicianIds: [] };
  const technicianIds = [String(tech._id)];
  if (tech.user) technicianIds.push(String(tech.user));
  if (userId) technicianIds.push(String(userId));
  return { tech, technicianIds: Array.from(new Set(technicianIds)) };
}

// ── Auth guards ───────────────────────────────────────────────────────────────
router.use(auth.authenticate);
router.use(auth.requireRole("technician"));

// ── Leave Requests ────────────────────────────────────────────────────────────

/**
 * GET /api/technician/leave-requests
 * Returns the authenticated technician's own leave requests, newest first.
 */
router.get("/leave-requests", async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const LeaveRequest = require("../models/LeaveRequest");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const items = await LeaveRequest.find({ technicianId: tech._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/leave-requests
 * Body: { startDate: "YYYY-MM-DD", endDate?: "YYYY-MM-DD", reason?: string }
 * Creates a new pending leave request. Rejects overlapping pending requests.
 */
router.post("/leave-requests", async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const LeaveRequest = require("../models/LeaveRequest");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { startDate, endDate, reason } = req.body;
    if (!startDate) return res.status(400).json({ error: "Start date is required." });

    const start = new Date(startDate + "T00:00:00");
    const end = endDate ? new Date(endDate + "T00:00:00") : new Date(start);

    if (isNaN(start.getTime())) return res.status(400).json({ error: "Invalid start date." });
    if (isNaN(end.getTime())) return res.status(400).json({ error: "Invalid end date." });
    if (end < start) return res.status(400).json({ error: "End date cannot be before start date." });

    // Block duplicate pending requests covering the same date range
    const conflict = await LeaveRequest.findOne({
      technicianId: tech._id,
      status: "pending",
      startDate: { $lte: end },
      endDate: { $gte: start },
    }).lean();

    if (conflict) {
      return res.status(409).json({
        error: "You already have a pending leave request that overlaps with these dates.",
      });
    }

    const leave = new LeaveRequest({
      technicianId: tech._id,
      technician: {
        name: tech.name || "",
        email: tech.email || "",
        phone: tech.phone || "",
      },
      startDate: start,
      endDate: end,
      reason: String(reason || "").trim().slice(0, 500),
    });
    await leave.save();

    // Notify admins of new leave request
    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    await createNotification({
      type: "leave_requested",
      title: "Leave Request",
      message: `${tech.name} requested leave from ${new Date(start).toLocaleDateString()} to ${new Date(end || start).toLocaleDateString()}.`,
      role: "admin",
      referenceId: leave._id,
      referenceModel: "LeaveRequest",
      link: "/admin/technicians/leaves",
      priority: "normal",
      io,
    });

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "leave.request.create",
      module: "technician",
      req,
      details: { startDate, endDate: endDate || startDate, reason },
    });

    return res.status(201).json({ message: "Leave request submitted successfully.", leave });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/technician/leave-requests/:id
 * Cancel own pending leave request only (cannot cancel approved/rejected).
 */
router.delete("/leave-requests/:id", async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const LeaveRequest = require("../models/LeaveRequest");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const leave = await LeaveRequest.findOne({ _id: id, technicianId: tech._id });
    if (!leave) return res.status(404).json({ error: "Leave request not found" });
    if (leave.status !== "pending") {
      return res.status(400).json({ error: "Only pending requests can be cancelled." });
    }

    await leave.deleteOne();

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "leave.request.cancel",
      module: "technician",
      req,
      details: { leaveId: id },
    });

    return res.json({ message: "Leave request cancelled." });
  } catch (err) {
    next(err);
  }
});

// ── Tool Usage Tracking ──────────────────────────────────────────────────────

/**
 * GET /api/technician/tools/catalog
 * Lightweight tool list for tool selection from Tool model.
 */
router.get("/tools/catalog", async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const items = await Tool.find({
      active: true, // Only show active tools (no status filter)
    })
      .select("itemName quantity unit barcode costPrice sellingPrice status minStockLevel")
      .sort({ itemName: 1 })
      .limit(500)
      .lean();

    return res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});


// GET /appointments/available-dates
// Returns available repair dates for the authenticated technician (next 14 days)
router.get("/appointments/available-dates", async (req, res, next) => {
  try {
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const Assignment = require("../models/Assignment");
    const LeaveRequest = require("../models/LeaveRequest");

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const estimatedDuration = parseInt(req.query.duration) || 90;

    const dates = [];
    const today = new Date();
    for (let i = 1; i <= 14; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      dates.push(d);
    }

    const schedule = await TechnicianSchedule.findOne({ technicianId: tech._id }).lean();

    const leaves = await LeaveRequest.find({
      technicianId: tech._id,
      status: "approved",
      startDate: { $lte: dates[dates.length - 1] },
      endDate: { $gte: dates[0] },
    }).lean();

    const dayStart = new Date(dates[0]);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dates[dates.length - 1]);
    dayEnd.setHours(23, 59, 59, 999);

    const assignments = await Assignment.find({
      technicianId: tech._id,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress", "pending_acceptance"] },
      bookingDate: { $gte: dayStart, $lte: dayEnd },
    }).select("bookingDate serviceDurationMinutes").lean();

    const results = [];
    for (const d of dates) {
      const dayOfWeek = d.getDay();
      const dayStr = d.toISOString().split('T')[0];

      const onLeave = leaves.some(lv => {
        const lvStart = new Date(lv.startDate);
        const lvEnd = new Date(lv.endDate);
        return d >= lvStart && d <= lvEnd;
      });
      if (onLeave) { results.push({ date: dayStr, available: false, reason: "On leave" }); continue; }

      if (schedule) {
        if (schedule.restDates && schedule.restDates.some(rd => new Date(rd).toDateString() === d.toDateString())) {
          results.push({ date: dayStr, available: false, reason: "Rest day" }); continue;
        }
        if (schedule.nonWorkingWeekdays && schedule.nonWorkingWeekdays.includes(dayOfWeek)) {
          results.push({ date: dayStr, available: false, reason: "Non-working day" }); continue;
        }
        const workingDay = schedule.workingDays?.find(wd => wd.dayOfWeek === dayOfWeek);
        if (!workingDay) { results.push({ date: dayStr, available: false, reason: "Not a working day" }); continue; }

        const dateBookings = assignments.filter(a => new Date(a.bookingDate).toDateString() === d.toDateString());
        let bookedMinutes = 0;
        for (const a of dateBookings) bookedMinutes += a.serviceDurationMinutes || 90;

        const workStartMin = workingDay.startMinutes || 480;
        const workEndMin = workingDay.endMinutes || 1020;
        const totalDayMinutes = workEndMin - workStartMin;
        const availableMinutes = totalDayMinutes - bookedMinutes;

        if (availableMinutes < estimatedDuration) {
          results.push({ date: dayStr, available: false, reason: "Insufficient capacity", slots: dateBookings.length });
          continue;
        }
        results.push({ date: dayStr, available: true, remainingSlots: Math.floor(availableMinutes / estimatedDuration), totalSlots: Math.floor(totalDayMinutes / estimatedDuration), bookedSlots: dateBookings.length });
      } else {
        const dateBookings = assignments.filter(a => new Date(a.bookingDate).toDateString() === d.toDateString());
        let bookedMinutes = 0;
        for (const a of dateBookings) bookedMinutes += a.serviceDurationMinutes || 90;
        const availableMinutes = 540 - bookedMinutes;
        if (availableMinutes < estimatedDuration) {
          results.push({ date: dayStr, available: false, reason: "Fully booked" });
        } else {
          results.push({ date: dayStr, available: true, remainingSlots: Math.floor(availableMinutes / estimatedDuration), totalSlots: Math.floor(540 / estimatedDuration), bookedSlots: dateBookings.length });
        }
      }
    }

    return res.json({ dates: results, estimatedDuration });
  } catch (err) {
    console.error("Available dates error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/technician/appointments/:id
 * Returns booking details including quotation for the assigned technician.
 */
router.get("/appointments/:id", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid appointment id" });

    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const booking = await BookingService.findById(id)
      .select("status quotation inspection diagnosis serviceType workOrderNumber customer technicianId unitInfo technicianAssistant preventiveMaintenance previousRepairs warranty repairCompletion paymentMethod paymentStatus amountPaid balanceAmount balanceCollected downpaymentAmount totalPrice estimatedFee initialCost travelFare inspectionFeeCollected inspectionFeeAmount inspectionFeeDistanceFare inspectionFeeTotalCollected repairPaymentCollected repairPaymentAmount repairPaymentMethod repairPaymentProof")
      .lean();
    if (!booking) return res.status(404).json({ error: "Appointment not found" });
    if (!technicianIds.includes(String(booking.technicianId || ""))) {
      return res.status(403).json({ error: "You are not assigned to this appointment" });
    }

    return res.json({ booking });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/appointments/:id/tools
 * List tool usage records for one appointment (technician-scoped).
 */
router.get("/appointments/:id/tools", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const ServiceToolUsage = require("../models/ServiceToolUsage");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid appointment id" });

    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const appt = await BookingService.findById(id).lean();
    if (!appt) return res.status(404).json({ error: "Appointment not found" });
    if (!technicianIds.includes(String(appt.technicianId || ""))) {
      return res.status(403).json({ error: "You are not assigned to this appointment" });
    }

    const items = await ServiceToolUsage.find({ bookingId: id, technicianId: tech._id })
      .sort({ usedAt: -1 })
      .limit(300)
      .lean();

    return res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/tools/search?q=capacitor
 * Search the Tool catalog for parts/materials the technician can pick in quotation.
 */
router.get("/tools/search", async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const { q } = req.query;
    if (!q || q.trim().length < 1) return res.json({ items: [] });

    const regex = new RegExp(q.trim(), "i");
    const items = await Tool.find({
      active: true,
      $or: [
        { itemName: regex },
        { description: regex },
        { specification: regex },
      ],
    })
      .select("itemName unit quantity costPrice sellingPrice status")
      .sort({ itemName: 1 })
      .limit(20)
      .lean();

    return res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/tools/check-inventory
 * Body: { partIds: [string] }
 * Returns inventory status for each part (Available, Low Stock, Out of Stock).
 */
router.post("/tools/check-inventory", async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const { partIds } = req.body;
    if (!partIds || !Array.isArray(partIds) || partIds.length === 0) {
      return res.json({ items: [] });
    }

    const validIds = partIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) return res.json({ items: [] });

    const tools = await Tool.find({ _id: { $in: validIds } })
      .select("itemName quantity unit costPrice sellingPrice status minStockLevel")
      .lean();

    const items = tools.map(t => ({
      _id: t._id,
      name: t.itemName,
      quantity: t.quantity,
      unit: t.unit,
      costPrice: t.costPrice,
      sellingPrice: t.sellingPrice,
      status: t.quantity === 0 ? 'out_of_stock' : t.quantity <= (t.minStockLevel || 3) ? 'low_stock' : 'available',
      statusLabel: t.quantity === 0 ? 'Out of Stock' : t.quantity <= (t.minStockLevel || 3) ? 'Low Stock' : 'Available',
    }));

    return res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/tools/match-by-names
 * Body: { names: string[] }
 * Matches part names to inventory items (fuzzy match) and returns tool IDs + stock info.
 */
router.post("/tools/match-by-names", async (req, res, next) => {
  try {
    const Tool = require("../models/Tool");
    const { names } = req.body;
    if (!names || !Array.isArray(names) || names.length === 0) {
      return res.json({ matches: [] });
    }

    // Build regex patterns for each name to do fuzzy matching
    const patterns = names.map(n => ({
      itemName: { $regex: n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }
    }));

    const tools = await Tool.find({
      active: true,
      $or: patterns
    })
      .select("itemName quantity unit costPrice sellingPrice status minStockLevel")
      .lean();

    // Score and rank matches — prefer exact matches, then prefix matches
    const matches = names.map(name => {
      const lowerName = name.toLowerCase().trim();

      // Score matches: exact > startsWith > includes
      const scored = tools.map(t => {
        const lowerItem = t.itemName.toLowerCase().trim();
        let score = 0;
        if (lowerItem === lowerName) score = 100;
        else if (lowerItem.startsWith(lowerName)) score = 80;
        else if (lowerName.startsWith(lowerItem)) score = 70;
        else if (lowerItem.includes(lowerName) || lowerName.includes(lowerItem)) score = 50;
        else score = 0;

        return { tool: t, score };
      }).filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (best) {
        const t = best.tool;
        return {
          name,
          _id: t._id,
          itemName: t.itemName,
          quantity: t.quantity,
          unit: t.unit,
          costPrice: t.costPrice,
          sellingPrice: t.sellingPrice,
          status: t.quantity === 0 ? 'out_of_stock' : t.quantity <= (t.minStockLevel || 3) ? 'low_stock' : 'available',
          statusLabel: t.quantity === 0 ? 'Out of Stock' : t.quantity <= (t.minStockLevel || 3) ? 'Low Stock' : 'Available',
          score: best.score,
        };
      }
      return { name, _id: null, itemName: null, quantity: 0, status: 'not_found', statusLabel: 'Not in Inventory' };
    });

    return res.json({ matches });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/appointments/:id/tools
 * Body: { inventoryItemId, quantityUsed, notes }
 * Atomically deducts stock and creates usage record.
 */
router.post("/appointments/:id/tools", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Inventory = require("../models/Inventory");
    const ServiceToolUsage = require("../models/ServiceToolUsage");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid appointment id" });

    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const appt = await BookingService.findById(id);
    if (!appt) return res.status(404).json({ error: "Appointment not found" });
    if (!technicianIds.includes(String(appt.technicianId || ""))) {
      return res.status(403).json({ error: "You are not assigned to this appointment" });
    }
    if (String(appt.status || "").toLowerCase() === "cancelled") {
      return res.status(400).json({ error: "Cannot log tools for cancelled appointment" });
    }

    const inventoryItemId = String(req.body.inventoryItemId || "").trim();
    const quantityUsed = Number(req.body.quantityUsed);
    const notes = String(req.body.notes || "").trim();
    const fuelUsed = Number(req.body.fuelUsed);
    const toolCost = Number(req.body.toolCost);

    if (!mongoose.Types.ObjectId.isValid(inventoryItemId)) {
      return res.status(400).json({ error: "Select a valid tool item" });
    }
    if (!Number.isFinite(quantityUsed) || quantityUsed <= 0) {
      return res.status(400).json({ error: "Quantity used must be greater than zero" });
    }
    if (req.body.fuelUsed != null && (!Number.isFinite(fuelUsed) || fuelUsed < 0)) {
      return res.status(400).json({ error: "Fuel used must be a non-negative number" });
    }
    if (req.body.toolCost != null && (!Number.isFinite(toolCost) || toolCost < 0)) {
      return res.status(400).json({ error: "Tool cost must be a non-negative number" });
    }

    const updatedItem = await Inventory.findOneAndUpdate(
      {
        _id: inventoryItemId,
        active: true,
        isStockItem: true,
        quantity: { $gte: quantityUsed },
      },
      { $inc: { quantity: -quantityUsed } },
      { new: true },
    ).lean();

    if (!updatedItem) {
      return res.status(409).json({ error: "Insufficient stock or invalid tool item" });
    }

    const usageData = {
      bookingId: appt._id,
      technicianId: tech._id,
      inventoryItemId: updatedItem._id,
      itemName: updatedItem.itemName,
      unit: updatedItem.unit || "pcs",
      quantityUsed,
      unitPrice: Number(updatedItem.costPrice) || 0,
      deductedFromInventory: true,
      notes: notes.slice(0, 500),
      recordedBy: req.user._id,
    };
    if (Number.isFinite(fuelUsed)) usageData.fuelUsed = fuelUsed;
    if (Number.isFinite(toolCost)) usageData.toolCost = toolCost;
    if (!Number.isFinite(toolCost)) {
      usageData.toolCost = (Number(updatedItem.costPrice) || 0) * quantityUsed;
    }

    const usage = await ServiceToolUsage.create(usageData);

    // Record stock adjustment for audit trail
    try {
      const StockAdjustment = require("../models/StockAdjustment");
      await StockAdjustment.record({
        toolId: inventoryItemId,
        type: "job_usage",
        delta: -quantityUsed,
        adjustedBy: req.user._id,
        reason: "repair_used",
        notes: `Job ${appt.workOrderNumber || appt._id}`,
        referenceId: appt._id,
      });
    } catch (e) { /* non-critical */ }

    await audit.logEvent({
      actor: req.user._id,
      target: appt._id,
      action: "tool.usage.create",
      module: "technician",
      req,
      details: {
        usageId: usage._id,
        inventoryItemId,
        quantityUsed,
        remainingQty: updatedItem.quantity,
        fuelUsed: usage.fuelUsed || 0,
        toolCost: usage.toolCost || 0,
      },
    });

    return res.status(201).json({
      message: "Tool usage recorded",
      usage,
      inventory: {
        _id: updatedItem._id,
        itemName: updatedItem.itemName,
        unit: updatedItem.unit,
        quantity: updatedItem.quantity,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/technician/tool-usage/:usageId
 * Removes one usage record and restores stock. Only own records.
 */
router.delete("/tool-usage/:usageId", async (req, res, next) => {
  try {
    const Inventory = require("../models/Inventory");
    const ServiceToolUsage = require("../models/ServiceToolUsage");
    const { tech } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const usageId = req.params.usageId;
    if (!mongoose.Types.ObjectId.isValid(usageId)) return res.status(400).json({ error: "Invalid usage id" });

    const usage = await ServiceToolUsage.findOne({ _id: usageId, technicianId: tech._id });
    if (!usage) return res.status(404).json({ error: "Tool usage record not found" });

    await Inventory.findByIdAndUpdate(usage.inventoryItemId, { $inc: { quantity: usage.quantityUsed } });
    await usage.deleteOne();

    // Record stock return for audit trail
    try {
      const StockAdjustment = require("../models/StockAdjustment");
      await StockAdjustment.record({
        toolId: usage.inventoryItemId,
        type: "return",
        delta: usage.quantityUsed,
        adjustedBy: req.user._id,
        reason: "return",
        notes: `Returned from job ${usage.bookingId || ''}`,
        referenceId: usage.bookingId || null,
      });
    } catch (e) { /* non-critical */ }

    await audit.logEvent({
      actor: req.user._id,
      target: usage.bookingId,
      action: "tool.usage.delete",
      module: "technician",
      req,
      details: {
        usageId,
        inventoryItemId: usage.inventoryItemId,
        restoredQty: usage.quantityUsed,
      },
    });

    return res.json({ message: "Tool usage removed and stock restored" });
  } catch (err) {
    next(err);
  }
});

// ── Attendance Scanning ──────────────────────────────────────────────────────
const SiteSetting = require("../models/SiteSetting");
const Technician = require("../models/Technician");
const TechnicianAttendance = require("../models/TechnicianAttendance");

/**
 * GET /api/technician/attendance/status
 * Get today's attendance status with leave detection.
 * Returns: { attendanceStatus, availabilityStatus, record, isOnLeave, leaveType }
 */
router.get("/attendance/status", async (req, res, next) => {
  try {
    const { resolveAvailabilityStatus, computeAttendanceStatus } = require("../utils/availability");
    const LeaveRequest = require("../models/LeaveRequest");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // Check for approved leave covering today
    const activeLeave = await LeaveRequest.findOne({
      technicianId: tech._id,
      status: "approved",
      startDate: { $lte: startOfToday },
      endDate: { $gte: startOfToday },
    }).lean();

    const record = await TechnicianAttendance.findOne({
      technicianId: tech._id,
      date: startOfToday,
    }).lean();

    // Compute effective availability from attendance state (single source of truth)
    const availabilityStatus = await resolveAvailabilityStatus(tech, record, activeLeave, { syncDb: true });

    const attendanceStatus = computeAttendanceStatus(record, activeLeave);

    let isOnLeave = false;
    let leaveType = null;
    if (activeLeave) {
      isOnLeave = true;
      const reason = (activeLeave.reason || "").toLowerCase();
      leaveType = reason.includes("sick") ? "Sick Leave" : "On Leave";
    }

    return res.json({
      attendanceStatus,
      availabilityStatus,
      record,
      isOnLeave,
      leaveType,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/attendance/checkin
 * Body: { lat?, lng? }
 * Button-based check-in with optional GPS coordinates.
 * Enterprise alternative to QR scanning.
 */
router.post("/attendance/checkin", async (req, res, next) => {
  try {
    const { lat, lng } = req.body;

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // Check for approved leave
    const LeaveRequest = require("../models/LeaveRequest");
    const activeLeave = await LeaveRequest.findOne({
      technicianId: tech._id,
      status: "approved",
      startDate: { $lte: startOfToday },
      endDate: { $gte: startOfToday },
    }).lean();
    if (activeLeave) {
      return res.status(400).json({ error: "You are currently on approved leave." });
    }

    // Check if already checked in
    const existing = await TechnicianAttendance.findOne({ technicianId: tech._id, date: startOfToday });
    if (existing && ["Present", "Late"].includes(existing.status)) {
      return res.status(400).json({ error: "You have already checked in today." });
    }

    // Determine status (Present vs Late). Cutoff: 9:00 AM local server time.
    const now = new Date();
    let status = "Present";
    if (now.getHours() >= 9) {
      status = "Late";
    }

    // Update technician model
    tech.availabilityStatus = "Available";
    if (lat && lng) {
      tech.location = { type: "Point", coordinates: [parseFloat(lng), parseFloat(lat)] };
    }
    await tech.save();

    // Create or update attendance record
    const attendanceRecord = await TechnicianAttendance.findOneAndUpdate(
      { technicianId: tech._id, date: startOfToday },
      {
        userId: req.user._id,
        status,
        checkInTime: now,
        method: "button",
        token: "button_" + now.getTime(),
      },
      { upsert: true, new: true }
    );

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "attendance.checkin.button",
      module: "technician",
      req,
      details: { status, checkInTime: now, lat, lng }
    }).catch(() => { });

    return res.json({
      message: `Checked in as ${status}.`,
      attendanceStatus: status,
      availabilityStatus: "Available",
      record: attendanceRecord
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/attendance/checkout
 * Body: { lat?, lng? }
 * Records check-out time for today with optional GPS.
 */
router.post("/attendance/checkout", async (req, res, next) => {
  try {
    const { lat, lng } = req.body;

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const record = await TechnicianAttendance.findOne({
      technicianId: tech._id,
      date: startOfToday,
    });

    if (!record || !["Present", "Late"].includes(record.status)) {
      return res.status(400).json({ error: "You must check in before checking out today." });
    }

    if (record.checkOutTime) {
      return res.status(400).json({ error: "You have already checked out today." });
    }

    const now = new Date();
    record.checkOutTime = now;
    await record.save();

    // Set technician availability status to Offline on checkout
    tech.availabilityStatus = "Offline";
    await tech.save();

    // Calculate total hours worked
    const hoursWorked = ((now - new Date(record.checkInTime)) / 3600000).toFixed(2);

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "attendance.checkout.success",
      module: "technician",
      req,
      details: { checkOutTime: now, hoursWorked, lat, lng }
    }).catch(() => { });

    return res.json({
      message: "Checked out successfully.",
      hoursWorked: parseFloat(hoursWorked),
      record
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/attendance/history
 * Returns the last 30 attendance records for the authenticated technician.
 */
router.get("/attendance/history", async (req, res, next) => {
  try {
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const records = await TechnicianAttendance.find({ technicianId: tech._id })
      .sort({ date: -1 })
      .limit(30)
      .lean();

    return res.json({ records, count: records.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/attendance/scan
 * Body: { token }
 * Marks the technician as present or late depending on scan time.
 */
router.post("/attendance/scan", async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "QR Token is required" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    // Check for approved leave — block scanning
    const LeaveRequest = require("../models/LeaveRequest");
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const activeLeave = await LeaveRequest.findOne({
      technicianId: tech._id,
      status: "approved",
      startDate: { $lte: startOfToday },
      endDate: { $gte: startOfToday },
    }).lean();
    if (activeLeave) {
      return res.status(400).json({ error: "You are currently on approved leave. Scanning is disabled." });
    }

    // Validate the token
    const todayStr = new Date().toISOString().split("T")[0];
    const tokenSetting = await SiteSetting.findOne({ key: "attendance_qr_token" }).lean();

    if (!tokenSetting || !tokenSetting.value || tokenSetting.value.date !== todayStr || tokenSetting.value.token !== token) {
      return res.status(400).json({ error: "Invalid or expired QR code for today." });
    }

    // Check if already checked in today
    const existing = await TechnicianAttendance.findOne({ technicianId: tech._id, date: startOfToday });
    if (existing && ["Present", "Late"].includes(existing.status)) {
      return res.status(400).json({ error: "You have already scanned today's attendance." });
    }

    // Determine status (Present vs Late). Cutoff: 9:00 AM local server time.
    const now = new Date();
    let status = "Present";
    if (now.getHours() >= 9) {
      status = "Late";
    }

    // Update technician model
    // Update technician model availability
    tech.availabilityStatus = "Available"; // Set availability to Available on check-in
    await tech.save();

    // Create or update attendance record
    const attendanceRecord = await TechnicianAttendance.findOneAndUpdate(
      { technicianId: tech._id, date: startOfToday },
      {
        userId: req.user._id,
        status,
        checkInTime: now,
        method: "qr_scan",
        token
      },
      { upsert: true, new: true }
    );

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "attendance.scan.success",
      module: "technician",
      req,
      details: { status, checkInTime: now }
    }).catch(() => { });

    return res.json({
      message: `Attendance marked as ${status}. Availability status set to Available.`,
      attendanceStatus: status,
      availabilityStatus: "Available",
      record: attendanceRecord
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/availability
 * Body: { status: "Unavailable" | "Available" }
 * Allows a technician to manually toggle their own availability.
 * - Only "Unavailable" and "Available" may be set manually.
 * - Cannot toggle if currently Assigned, On The Way, or In Progress.
 * - Returning from Unavailable restores to "Available".
 */
router.post("/availability", async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ["Unavailable", "Available"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: `Only "${allowedStatuses.join("\" or \"")}" may be set manually.`,
      });
    }

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    // Block toggling if the system has assigned an active task
    const blockedStatuses = ["Assigned", "On The Way", "In Progress"];
    if (blockedStatuses.includes(tech.availabilityStatus)) {
      return res.status(409).json({
        error: `Cannot change availability while status is "${tech.availabilityStatus}". Complete your current assignment first.`,
      });
    }

    // Block setting Available if technician is Offline (not checked in)
    if (status === "Available" && tech.availabilityStatus === "Offline") {
      return res.status(409).json({
        error: "Cannot set yourself as Available while you are Offline. Please check in first.",
      });
    }

    tech.availabilityStatus = status;
    await tech.save();

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "technician.availability.manual",
      module: "technician",
      req,
      details: { status },
    }).catch(() => { });

    return res.json({
      message: `Availability set to ${status}.`,
      availabilityStatus: status,
    });
  } catch (err) {
    next(err);
  }
});

// ── Notifications ────────────────────────────────────────────────────────────

/**
 * GET /api/technician/notifications
 * Returns in-app notifications for the technician's navbar bell.
 * Uses the unified Notification model (same as admin system).
 */
router.get("/notifications", async (req, res, next) => {
  try {
    const Notification = require("../models/Notification");

    const notifications = await Notification.find({
      $or: [
        { userId: req.user._id },
        { role: "technician" },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    // Map to the format the navbar expects
    const iconMap = {
      assignment_new: { icon: "bi-person-plus", iconClass: "text-primary" },
      assignment_accepted: { icon: "bi-person-check", iconClass: "text-success" },
      assignment_declined: { icon: "bi-person-x", iconClass: "text-danger" },
      leave_approved: { icon: "bi-check-circle-fill", iconClass: "text-success" },
      leave_rejected: { icon: "bi-x-circle-fill", iconClass: "text-danger" },
      leave_requested: { icon: "bi-calendar-event", iconClass: "text-info" },
      expense_approved: { icon: "bi-check-circle", iconClass: "text-success" },
      expense_rejected: { icon: "bi-x-circle", iconClass: "text-danger" },
      expense_submitted: { icon: "bi-receipt", iconClass: "text-warning" },
      booking_cancelled: { icon: "bi-x-circle", iconClass: "text-danger" },
      booking_completed: { icon: "bi-check2-circle", iconClass: "text-success" },
      system: { icon: "bi-gear", iconClass: "text-muted" },
    };

    const mapped = notifications.map((n) => {
      const ic = iconMap[n.type] || iconMap.system;
      return {
        id: n._id,
        type: n.type,
        icon: ic.icon,
        iconClass: ic.iconClass,
        title: n.title,
        message: n.message,
        time: n.createdAt,
        link: n.link || "#",
        read: n.read || false,
      };
    });

    const unread = mapped.filter((n) => !n.read).length;

    return res.json({ notifications: mapped, unread });
  } catch (err) {
    next(err);
  }
});

// ── Badge Counts ────────────────────────────────────────────────────────────

/**
 * GET /api/technician/badge-counts
 * Returns sidebar badge counts for the technician.
 * Enterprise-level: single batch query, no N+1.
 */
router.get("/badge-counts", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const Expense = require("../models/Expense");
    const Order = require("../models/Order");
    const Notification = require("../models/Notification");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.json({ pendingAssignments: 0, todayJobs: 0, pendingExpenses: 0, pendingOrders: 0, unreadNotifications: 0 });

    const techId = tech._id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const [pendingAssignments, todayJobs, pendingExpenses, pendingOrders, unreadNotifications] = await Promise.all([
      Assignment.countDocuments({ technicianId: techId, status: "pending_acceptance" }),
      Assignment.countDocuments({ technicianId: techId, bookingDate: { $gte: today, $lt: tomorrow } }),
      Expense.countDocuments({ technicianId: techId, status: "pending" }),
      Order.countDocuments({ technicianId: techId, status: { $in: ["pending", "confirmed", "processing"] } }),
      Notification.countDocuments({
        $or: [{ userId: req.user._id }, { role: "technician" }],
        read: { $ne: true },
      }),
    ]);

    return res.json({ pendingAssignments, todayJobs, pendingExpenses, pendingOrders, unreadNotifications });
  } catch (err) {
    next(err);
  }
});

// ── Schedule ────────────────────────────────────────────────────────────────

/**
 * GET /api/technician/schedule
 * Returns the technician's schedule config, upcoming bookings, and today's jobs.
 * Enterprise-level: batch queries, server-authoritative, no N+1.
 */
router.get("/schedule", async (req, res, next) => {
  try {
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const Assignment = require("../models/Assignment");
    const LeaveRequest = require("../models/LeaveRequest");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const techId = tech._id;
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 30 days ahead for calendar
    const thirtyDaysOut = new Date(today);
    thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);

    // Batch fetch: schedule, today's assignments, upcoming assignments, active leave
    const [schedule, todayAssignments, upcomingAssignments, activeLeave] = await Promise.all([
      TechnicianSchedule.findOne({ technicianId: techId }).lean(),
      Assignment.find({
        technicianId: techId,
        bookingDate: { $gte: today, $lt: tomorrow },
      }).sort({ startTime: 1 }).limit(20).lean(),
      Assignment.find({
        technicianId: techId,
        bookingDate: { $gte: tomorrow, $lte: thirtyDaysOut },
        status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
      }).sort({ bookingDate: 1, startTime: 1 }).limit(50).lean(),
      LeaveRequest.findOne({
        technicianId: techId,
        status: "approved",
        startDate: { $lte: thirtyDaysOut },
        endDate: { $gte: today },
      }).lean(),
    ]);

    // Build working hours summary
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const workingHoursSummary = schedule
      ? (schedule.workingDays || []).map((wd) => ({
        day: dayNames[wd.dayOfWeek] || "",
        start: Math.floor(wd.startMinutes / 60) + ":" + String(wd.startMinutes % 60).padStart(2, "0"),
        end: Math.floor(wd.endMinutes / 60) + ":" + String(wd.endMinutes % 60).padStart(2, "0"),
      }))
      : [];

    return res.json({
      schedule: schedule
        ? {
          workingDays: schedule.workingDays || [],
          nonWorkingWeekdays: (schedule.nonWorkingWeekdays || []).map((nw) => nw.dayOfWeek),
          restDates: schedule.restDates || [],
          workingHoursSummary,
        }
        : null,
      todayAssignments,
      upcomingAssignments,
      activeLeave: activeLeave
        ? {
          startDate: activeLeave.startDate,
          endDate: activeLeave.endDate,
          reason: activeLeave.reason,
        }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE DASHBOARD — Overview
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/dashboard/overview
 * Returns aggregated KPIs, job pipeline, today's jobs, and upcoming jobs.
 */
router.get("/dashboard/overview", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const Expense = require("../models/Expense");
    const ServiceReport = require("../models/ServiceReport");
    const ServiceToolUsage = require("../models/ServiceToolUsage");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const techId = tech._id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // ── Job Pipeline Counts ────────────────────────────────────────────────
    const counts = await Assignment.getDashboardCounts(techId);

    // ── Today's Jobs ───────────────────────────────────────────────────────
    const todayJobs = await Assignment.find({
      technicianId: techId,
      bookingDate: { $gte: today, $lt: tomorrow },
    })
      .sort({ startTime: 1 })
      .limit(20)
      .lean();

    // Enrich todayJobs with booking status and price fields
    const todayBookingIds = todayJobs.map(a => a.bookingId).filter(Boolean);
    const todayBookings = await BookingService.find({ _id: { $in: todayBookingIds } })
      .select("status serviceType totalPrice estimatedFee initialCost inspectionFeeTotalCollected quotation approval services")
      .lean();
    const todayBookingMap = new Map(todayBookings.map(b => [String(b._id), b]));
    for (const item of todayJobs) {
      const bk = todayBookingMap.get(String(item.bookingId));
      if (bk) {
        item.bookingStatus = bk.status;
        if (!item.serviceType) item.serviceType = bk.serviceType;
        // Calculate correct revenue for this booking
        const isRepair = bk.serviceType === "repair" ||
          (bk.services && bk.services.some(s => s.type === "repair"));
        if (isRepair) {
          const inspectionRevenue = bk.inspectionFeeTotalCollected || bk.initialCost || 0;
          const quotationRevenue = (bk.quotation && bk.quotation.totalCost) || 0;
          item.computedRevenue = inspectionRevenue + quotationRevenue;
        } else {
          item.computedRevenue = bk.totalPrice || bk.estimatedFee || 0;
        }
        item.bookingTotalPrice = bk.totalPrice;
        item.bookingEstimatedFee = bk.estimatedFee;
        item.bookingInitialCost = bk.initialCost;
        item.bookingInspectionFeeCollected = bk.inspectionFeeTotalCollected;
        item.bookingQuotationTotal = bk.quotation && bk.quotation.totalCost;
        item.bookingApprovalStatus = bk.approval && bk.approval.status;
      }
    }

    // ── Active Job (most recently updated active) ────────────────────────────
    const activeJob = await Assignment.findOne({
      technicianId: techId,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress"] },
    }).sort({ updatedAt: -1 }).lean();

    // Enrich activeJob with booking payment fields and status
    const activeBookingIds = [];
    if (activeJob && activeJob.bookingId) {
      activeBookingIds.push(String(activeJob.bookingId));
    }
    const activeBookingsMap = new Map();
    if (activeBookingIds.length > 0) {
      const activeBookings = await BookingService.find({ _id: { $in: activeBookingIds.map(id => new mongoose.Types.ObjectId(id)) } })
        .select("paymentMethod paymentStatus amountPaid balanceAmount balanceCollected downpaymentAmount totalPrice estimatedFee isMultiService services service status serviceType initialCost travelFare inspectionFeeCollected repairPaymentCollected repairPaymentAmount quotation approval repairSchedule unitInfo technicianId")
        .lean();
      for (const b of activeBookings) activeBookingsMap.set(String(b._id), b);
    }
    if (activeJob && activeJob.bookingId) {
      const bk = activeBookingsMap.get(String(activeJob.bookingId));
      if (bk) {
        activeJob.paymentMethod = bk.paymentMethod;
        activeJob.paymentStatus = bk.paymentStatus;
        activeJob.amountPaid = bk.amountPaid;
        activeJob.balanceAmount = bk.balanceAmount;
        activeJob.balanceCollected = bk.balanceCollected;
        activeJob.downpaymentAmount = bk.downpaymentAmount;
        activeJob.totalPrice = bk.totalPrice;
        activeJob.estimatedFee = bk.estimatedFee;
        activeJob.initialCost = bk.initialCost;
        activeJob.travelFare = bk.travelFare;
        activeJob.bookingStatus = bk.status;
        activeJob.bookingServiceType = bk.serviceType;
        if (!activeJob.serviceType) activeJob.serviceType = bk.serviceType;
        if (!activeJob.serviceName || activeJob.serviceName === "Service" || activeJob.serviceName === "") {
          activeJob.serviceName = bk.isMultiService && Array.isArray(bk.services) && bk.services.length > 0 ? bk.services.map(s => s.name).join(", ") : (bk.service?.name || "Service");
        }

        // If this is a repair booking, attach repair-specific info to the active job
        const isRepair = bk.serviceType === "repair" || (bk.services && bk.services.some(s => s.type === "repair"));
        if (isRepair) {
          const repairStatuses = [
            "inspection_scheduled", "inspection_completed", "awaiting_approval",
            "repair_approved", "repair_declined", "waiting_parts", "parts_reserved",
            "ready_for_repair", "repair_scheduled", "repair_in_progress", "repair_completed",
            "on-the-way", "arrived"
          ];
          if (repairStatuses.includes(bk.status) || bk.status?.startsWith("repair_")) {
            activeJob.repairInfo = {
              bookingStatus: bk.status,
              bookingId: bk._id,
              quotation: bk.quotation,
              approval: bk.approval,
              repairSchedule: bk.repairSchedule,
              unitInfo: bk.unitInfo,
            };
          }
        }
      }
    }

    // ── Pending Acceptance ─────────────────────────────────────────────────
    const pendingJobs = await Assignment.find({
      technicianId: techId,
      status: "pending_acceptance",
    })
      .sort({ assignedAt: -1 })
      .limit(10)
      .lean();

    // Enrich pendingJobs with booking status and price fields
    const pendingBookingIds = pendingJobs.map(a => a.bookingId).filter(Boolean);
    const pendingBookings = await BookingService.find({ _id: { $in: pendingBookingIds } })
      .select("status serviceType totalPrice estimatedFee initialCost inspectionFeeTotalCollected quotation approval services")
      .lean();
    const pendingBookingMap = new Map(pendingBookings.map(b => [String(b._id), b]));
    for (const item of pendingJobs) {
      const bk = pendingBookingMap.get(String(item.bookingId));
      if (bk) {
        item.bookingStatus = bk.status;
        if (!item.serviceType) item.serviceType = bk.serviceType;
        const isRepair = bk.serviceType === "repair" ||
          (bk.services && bk.services.some(s => s.type === "repair"));
        if (isRepair) {
          const inspectionRevenue = bk.inspectionFeeTotalCollected || bk.initialCost || 0;
          const quotationRevenue = (bk.quotation && bk.quotation.totalCost) || 0;
          item.computedRevenue = inspectionRevenue + quotationRevenue;
        } else {
          item.computedRevenue = bk.totalPrice || bk.estimatedFee || 0;
        }
      }
    }

    // ── Completed Today ────────────────────────────────────────────────────
    const completedToday = await Assignment.find({
      technicianId: techId,
      status: "completed",
      completedAt: { $gte: today, $lt: tomorrow },
    })
      .sort({ completedAt: -1 })
      .limit(20)
      .lean();

    // Enrich completedToday with booking status and price fields
    const completedBookingIds = completedToday.map(a => a.bookingId).filter(Boolean);
    const completedBookings = await BookingService.find({ _id: { $in: completedBookingIds } })
      .select("status serviceType totalPrice estimatedFee initialCost inspectionFeeTotalCollected quotation approval services")
      .lean();
    const completedBookingMap = new Map(completedBookings.map(b => [String(b._id), b]));
    for (const item of completedToday) {
      const bk = completedBookingMap.get(String(item.bookingId));
      if (bk) {
        item.bookingStatus = bk.status;
        if (!item.serviceType) item.serviceType = bk.serviceType;
        const isRepair = bk.serviceType === "repair" ||
          (bk.services && bk.services.some(s => s.type === "repair"));
        if (isRepair) {
          const inspectionRevenue = bk.inspectionFeeTotalCollected || bk.initialCost || 0;
          const quotationRevenue = (bk.quotation && bk.quotation.totalCost) || 0;
          item.computedRevenue = inspectionRevenue + quotationRevenue;
        } else {
          item.computedRevenue = bk.totalPrice || bk.estimatedFee || 0;
        }
      }
    }

    // ── Monthly Expense Summary ────────────────────────────────────────────
    const expenseSummary = await Expense.getMonthlySummary(
      techId,
      today.getFullYear(),
      today.getMonth()
    );

    // ── Per-Job Expense Data ───────────────────────────────────────────────
    // Expenses for the active job
    let activeJobExpenses = [];
    if (activeJob && activeJob.bookingId) {
      activeJobExpenses = await Expense.find({
        technicianId: techId,
        bookingId: activeJob.bookingId,
      })
        .sort({ expenseDate: -1 })
        .lean();
    }

    // Expenses for completed today jobs
    const expenseBookingIds = completedToday
      .map(a => a.bookingId)
      .filter(Boolean);
    let completedTodayExpenses = [];
    if (expenseBookingIds.length > 0) {
      completedTodayExpenses = await Expense.find({
        technicianId: techId,
        bookingId: { $in: expenseBookingIds },
      })
        .sort({ expenseDate: -1 })
        .lean();
    }
    // Group completed expenses by bookingId
    const completedExpensesByBooking = {};
    for (const exp of completedTodayExpenses) {
      const bid = String(exp.bookingId);
      if (!completedExpensesByBooking[bid]) completedExpensesByBooking[bid] = [];
      completedExpensesByBooking[bid].push(exp);
    }

    // Recent unlinked expenses (no booking assigned)
    const unlinkedExpenses = await Expense.find({
      technicianId: techId,
      bookingId: null,
      expenseDate: { $gte: today },
    })
      .sort({ expenseDate: -1 })
      .limit(10)
      .lean();

    // Technician's active & recent assignments for the expense form dropdown
    const recentAssignments = await Assignment.find({
      technicianId: techId,
      status: { $in: ["accepted", "en_route", "on_site", "in_progress", "completed"] },
      bookingDate: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    })
      .sort({ bookingDate: -1 })
      .limit(20)
      .lean();

    // ── Tool Usage This Month ──────────────────────────────────────────────
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const toolUsageCount = await ServiceToolUsage.countDocuments({
      technicianId: techId,
      usedAt: { $gte: monthStart },
    });

    // ── Reports Status ─────────────────────────────────────────────────────
    const pendingReports = await ServiceReport.countDocuments({
      technicianId: techId,
      status: { $in: ["draft", "revision_requested"] },
    });

    // ── Repair Queue (repair bookings assigned to this technician) ──────────
    const repairStatuses = [
      "inspection_scheduled", "inspection_completed", "awaiting_approval",
      "repair_approved", "repair_declined", "waiting_parts", "parts_reserved",
      "ready_for_repair", "repair_scheduled", "repair_in_progress", "repair_completed"
    ];
    const repairBookings = await BookingService.find({
      "technicianId": techId,
      "serviceType": "repair",
      status: { $in: repairStatuses },
    })
      .sort({ updatedAt: -1 })
      .limit(20)
      .select("status serviceType unitInfo customerId technicianId quotation approval repairSchedule inspection preferredSchedule preferredTimeWindow createdAt updatedAt")
      .populate("customerId", "name email phone")
      .lean();

    // Also get the inspection technician's bookings (if this tech was the original inspector)
    const inspectorBookings = await BookingService.find({
      "inspection.technicianId": techId,
      "serviceType": "repair",
      status: { $in: repairStatuses },
      "technicianId": { $ne: techId },
    })
      .sort({ updatedAt: -1 })
      .limit(10)
      .select("status serviceType unitInfo customerId technicianId quotation approval repairSchedule inspection preferredSchedule preferredTimeWindow createdAt updatedAt")
      .populate("customerId", "name email phone")
      .lean();

    // Merge and deduplicate
    const repairBookingMap = new Map();
    for (const b of [...repairBookings, ...inspectorBookings]) {
      repairBookingMap.set(String(b._id), b);
    }

    // Find existing assignments for these bookings
    const repairBookingIds = [...repairBookingMap.keys()].map(id => new mongoose.Types.ObjectId(id));
    const repairAssignments = repairBookingIds.length > 0 ? await Assignment.find({
      technicianId: techId,
      bookingId: { $in: repairBookingIds },
    }).select("bookingId status").lean() : [];
    const assignmentMap = new Map(repairAssignments.map(a => [String(a.bookingId), a.status]));

    // Build enriched repair queue
    const activeAssignmentStatuses = ["accepted", "en_route", "on_site", "in_progress"];
    const repairQueue = [...repairBookingMap.values()]
      .filter(b => {
        // Exclude bookings that already have an active assignment (shown as Active Job)
        const assignmentStatus = assignmentMap.get(String(b._id));
        if (assignmentStatus && activeAssignmentStatuses.includes(assignmentStatus)) return false;
        return true;
      })
      .map(b => {
        const bookingStatus = b.status;
        const assignmentStatus = assignmentMap.get(String(b._id)) || null;

        // Determine if parts are ready and repair is scheduled
        const hasReservation = b.status === "parts_reserved" || b.status === "ready_for_repair" || b.status === "repair_scheduled";
        const isScheduled = b.repairSchedule?.decidedAt || b.status === "repair_scheduled" || b.status === "ready_for_repair";
        const waitingForParts = b.status === "waiting_parts";
        const waitingForSchedule = b.status === "repair_approved" && !isScheduled;

        let techAction = null;
        if (bookingStatus === "repair_scheduled" || bookingStatus === "ready_for_repair" || bookingStatus === "repair_approved" || bookingStatus === "parts_reserved") {
          techAction = "ready"; // Can go En Route
        } else if (waitingForParts) {
          techAction = "waiting_parts";
        } else if (waitingForSchedule) {
          techAction = "waiting_schedule";
        } else if (bookingStatus === "repair_in_progress") {
          techAction = "in_progress";
        }

        return {
          _id: b._id,
          bookingId: b._id,
          customerName: b.customerId?.name || "Customer",
          customerEmail: b.customerId?.email || "",
          customerPhone: b.customerId?.phone || "",
          serviceName: "Repair Service",
          serviceType: "repair",
          bookingStatus,
          assignmentStatus,
          unitInfo: b.unitInfo,
          quotation: b.quotation,
          repairSchedule: b.repairSchedule,
          inspection: b.inspection,
          preferredDates: b.preferredSchedule?.dates || [],
          preferredTimeWindow: b.preferredSchedule?.timeWindow || "any",
          techAction,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        };
      });

    // Group counts by repair sub-status for KPI
    const repairCounts = {};
    for (const s of repairStatuses) repairCounts[s] = 0;
    for (const a of repairQueue) {
      const s = a.bookingStatus || a.status;
      if (repairCounts[s] !== undefined) repairCounts[s]++;
    }

    return res.json({
      counts,
      todayJobs,
      activeJob,
      pendingJobs,
      completedToday,
      expenseSummary,
      toolUsageCount,
      pendingReports,
      activeJobExpenses,
      completedExpensesByBooking,
      unlinkedExpenses,
      recentAssignments,
      repairQueue,
      repairCounts,
    });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// KPI AGGREGATES — Enterprise Dashboard Metrics
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/kpis
 * Returns real-time aggregate KPI counts for the authenticated technician.
 * Uses MongoDB aggregation for accurate totals (not limited to one page).
 */

router.get("/kpis", async (req, res, next) => {
  try {
    const Technician = require("../models/Technician");
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const ServiceToolUsage = require("../models/ServiceToolUsage");
    const Expense = require("../models/Expense");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const baseFilter = { technicianId: tech._id };

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const [totalCount, statusCounts, todayCount, revenueResult, availableCount, toolCostResult, expenseResult] = await Promise.all([
      Assignment.countDocuments(baseFilter),
      Assignment.aggregate([
        { $match: baseFilter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Assignment.countDocuments({
        ...baseFilter,
        bookingDate: { $gte: todayStart, $lte: todayEnd },
      }),
      Assignment.aggregate([
        { $match: { ...baseFilter, status: "completed" } },
        {
          $lookup: {
            from: "bookingservices",
            localField: "bookingId",
            foreignField: "_id",
            as: "booking",
          }
        },
        { $unwind: { path: "$booking", preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            _isRepair: {
              $or: [
                { $eq: ["$booking.serviceType", "repair"] },
                {
                  $anyElementTrue: {
                    $map: {
                      input: { $ifNull: ["$booking.services", []] },
                      as: "svc",
                      in: { $eq: ["$$svc.type", "repair"] }
                    }
                  }
                }
              ]
            },
            _repairRevenue: {
              $add: [
                { $ifNull: ["$booking.inspectionFeeTotalCollected", 0] },
                { $ifNull: ["$booking.initialCost", 0] },
                { $ifNull: ["$booking.quotation.totalCost", 0] }
              ]
            },
            _coreRevenue: {
              $ifNull: ["$booking.totalPrice", { $ifNull: ["$booking.estimatedFee", 0] }]
            }
          }
        },
        {
          $group: {
            _id: null,
            revenue: {
              $sum: {
                $cond: ["$_isRepair", "$_repairRevenue", "$_coreRevenue"]
              }
            },
          }
        },
      ]),
      BookingService.countDocuments({
        status: "pending_reassignment",
        bookingDate: { $gte: todayStart },
      }),
      ServiceToolUsage.aggregate([
        { $match: { technicianId: tech._id } },
        { $group: { _id: null, totalPartsCost: { $sum: { $ifNull: ["$toolCost", 0] } } } }
      ]),
      Expense.aggregate([
        { $match: { technicianId: tech._id } },
        { $group: { _id: null, totalExpenses: { $sum: "$amount" } } }
      ]),
    ]);

    const statusMap = {};
    statusCounts.forEach(s => { statusMap[s._id] = s.count; });

    const completed = statusMap["completed"] || 0;
    const pending = statusMap["pending_acceptance"] || 0;
    const active = (statusMap["accepted"] || 0) + (statusMap["en_route"] || 0) + (statusMap["on_site"] || 0) + (statusMap["in_progress"] || 0);
    const declined = statusMap["declined"] || 0;
    const cancelled = statusMap["cancelled"] || 0;
    const revenue = revenueResult.length > 0 ? revenueResult[0].revenue : 0;
    const partsCost = toolCostResult.length > 0 ? toolCostResult[0].totalPartsCost : 0;
    const expenses = expenseResult.length > 0 ? expenseResult[0].totalExpenses : 0;
    const grossProfit = revenue - partsCost;
    const completionRate = totalCount > 0 ? Math.round((completed / totalCount) * 100) : 0;

    return res.json({
      total: totalCount,
      completed,
      pending,
      active,
      today: todayCount,
      declined,
      cancelled,
      revenue,
      partsCost,
      expenses,
      grossProfit,
      completionRate,
      available: availableCount,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/calendar
 * Returns paginated calendar events for FullCalendar.
 * Query: ?start=ISO&end=ISO&page=1&limit=5
 */
router.get("/calendar", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { start, end, page = 1, limit = 5 } = req.query;
    const filter = { technicianId: tech._id };

    if (start || end) {
      filter.bookingDate = {};
      if (start) {
        const startDate = parseCalendarDateParam(start);
        if (!startDate) return res.status(400).json({ error: "Invalid start date" });
        filter.bookingDate.$gte = startDate;
      }
      if (end) {
        const endDate = parseCalendarDateParam(end);
        if (!endDate) return res.status(400).json({ error: "Invalid end date" });
        filter.bookingDate.$lte = endDate;
      }
    }

    const parsedPage = Number.parseInt(page, 10);
    const parsedLimit = Number.parseInt(limit, 10);
    const pageNum = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
    const lim = Number.isFinite(parsedLimit) ? Math.min(500, Math.max(1, parsedLimit)) : 5;
    const skip = (pageNum - 1) * lim;

    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const [items, total, scheduleDoc] = await Promise.all([
      Assignment.find(filter)
        .sort({ bookingDate: 1, startTime: 1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      Assignment.countDocuments(filter),
      TechnicianSchedule.findOne({ technicianId: tech._id }).lean()
    ]);

    const schedule = scheduleDoc ? {
      workingDays: scheduleDoc.workingDays || [],
      nonWorkingWeekdays: (scheduleDoc.nonWorkingWeekdays || []).map(nw => typeof nw === "object" ? nw.dayOfWeek : nw),
      restDates: scheduleDoc.restDates || [],
    } : null;
    return res.json({ items, schedule, total, page: pageNum, pages: Math.ceil(total / lim) });
  } catch (err) {
    next(err);
  }
});
// ═════════════════════════════════════════════════════════════════════════════
// ASSIGNMENTS — CRUD & Status Transitions
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/assignments
 * Query: ?status=pending_acceptance|accepted|en_route|...&page=1&limit=20&search=...
 * Returns filtered, paginated assignments for the authenticated technician.
 */
router.get("/assignments", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { status, search, date, page = 1, limit = 20 } = req.query;
    const filter = { technicianId: tech._id };

    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      filter.bookingDate = { $gte: start, $lte: end };
    }

    if (status && status !== "all") {
      if (status === "active") {
        filter.status = { $in: ["accepted", "en_route", "on_site", "in_progress"] };
      } else if (status === "today") {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);
        // Only apply if date is not explicitly set
        if (!date) filter.bookingDate = { $gte: todayStart, $lte: todayEnd };
      } else if (status === "upcoming") {
        filter.status = { $in: ["pending_acceptance", "accepted"] };
        filter.bookingDate = { $gte: new Date() };
      } else {
        filter.status = status;
      }
    }

    if (search) {
      filter.$or = [
        { customerName: { $regex: search, $options: "i" } },
        { serviceName: { $regex: search, $options: "i" } },
        { address: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const lim = Math.min(100, Math.max(1, parseInt(limit)));

    // Projects belong in the technician's "Projects" tab, not the standard
    // My Work job list. Exclude assignments whose booking is a project.
    const projectBookingIds = await (require("../models/BookingService"))
      .find({ isProject: true })
      .distinct("_id");
    if (projectBookingIds.length) {
      filter.bookingId = Object.assign({}, filter.bookingId, {
        $nin: projectBookingIds,
      });
    }

    const [items, total] = await Promise.all([
      Assignment.find(filter)
        .sort({ bookingDate: 1, startTime: 1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      Assignment.countDocuments(filter),
    ]);

    // Enrich assignments with booking payment fields and status
    const BookingService = require("../models/BookingService");
    const bookingIds = items.map(a => a.bookingId).filter(Boolean);
    const bookings = await BookingService.find({ _id: { $in: bookingIds } })
      .select("paymentMethod paymentStatus amountPaid balanceAmount balanceCollected downpaymentAmount totalPrice estimatedFee isMultiService services service status serviceType initialCost travelFare inspectionFeeCollected repairPaymentCollected repairPaymentAmount quotation airconType airconTypeName hp hpDescription quantity notes address serviceDurationMinutes description features customer unitInfo")
      .lean();
    const bookingMap = new Map(bookings.map(b => [String(b._id), b]));
    for (const item of items) {
      const bk = bookingMap.get(String(item.bookingId));
      if (bk) {
        item.paymentMethod = bk.paymentMethod;
        item.paymentStatus = bk.paymentStatus;
        item.amountPaid = bk.amountPaid;
        item.balanceAmount = bk.balanceAmount;
        item.balanceCollected = bk.balanceCollected;
        item.repairPaymentCollected = bk.repairPaymentCollected;
        item.repairPaymentAmount = bk.repairPaymentAmount;
        item.downpaymentAmount = bk.downpaymentAmount;
        item.totalPrice = bk.totalPrice;
        item.estimatedFee = bk.estimatedFee;
        item.initialCost = bk.initialCost;
        item.travelFare = bk.travelFare;
        item.bookingStatus = bk.status;
        item.quotation = bk.quotation; // Added quotation here
        if (!item.serviceType) item.serviceType = bk.serviceType;
        if (!item.serviceName || item.serviceName === "Service" || item.serviceName === "") {
          item.serviceName = bk.isMultiService && Array.isArray(bk.services) && bk.services.length > 0 ? bk.services.map(s => s.name).join(", ") : (bk.service?.name || "Service");
        }
        // Enrich with service detail fields for the technician "view details" panel
        if (bk.service) {
          item.serviceDetail = {
            name: bk.service.name,
            description: bk.service.description,
            features: bk.service.features,
            durationMinutes: bk.service.serviceDurationMinutes || bk.service.durationMinutes,
            basePrice: bk.service.basePrice,
          };
        }
        if (bk.airconTypeName != null) item.airconTypeName = bk.airconTypeName;
        if (bk.airconType != null) item.airconType = bk.airconType;
        if (bk.hp != null) item.hp = bk.hp;
        if (bk.hpDescription != null) item.hpDescription = bk.hpDescription;
        if (bk.quantity != null) item.quantity = bk.quantity;
        else if (Array.isArray(bk.services) && bk.services.length > 0) {
          const sum = bk.services.reduce((s, x) => s + (Number(x.quantity) || 1), 0);
          item.quantity = sum || 1;
        } else if (bk.unitInfo && bk.unitInfo.quantity != null) {
          item.quantity = bk.unitInfo.quantity;
        } else {
          item.quantity = 1;
        }
        if (bk.serviceDurationMinutes != null) item.serviceDurationMinutes = bk.serviceDurationMinutes;
        if (bk.description != null) item.serviceDescription = bk.description;
        if (bk.notes != null) item.bookingNotes = bk.notes;
        if (bk.features != null) item.serviceFeatures = bk.features;
        if (bk.address != null) item.address = item.address || bk.address;
        if (bk.customer && !item.customerPhone) {
          item.customerPhone = bk.customer.phone || item.customerPhone;
          item.customerEmail = bk.customer.email || item.customerEmail;
        }
      }
    }

    return res.json({
      items,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / lim),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/assignments/:id
 * Returns a single assignment with full details.
 */
router.get("/assignments/:id", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id })
      .populate("bookingId")
      .lean();

    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    // Enrich with booking payment fields
    if (assignment.bookingId && assignment.bookingId._id) {
      const bk = assignment.bookingId;
      assignment.paymentMethod = bk.paymentMethod;
      assignment.paymentStatus = bk.paymentStatus;
      assignment.amountPaid = bk.amountPaid;
      assignment.balanceAmount = bk.balanceAmount;
      assignment.balanceCollected = bk.balanceCollected;
      assignment.downpaymentAmount = bk.downpaymentAmount;
      assignment.totalPrice = bk.totalPrice;
      assignment.estimatedFee = bk.estimatedFee;
      assignment.initialCost = bk.initialCost;
      assignment.travelFare = bk.travelFare;
      assignment.bookingStatus = bk.status;
      assignment.quotation = bk.quotation;
      if (!assignment.serviceType) assignment.serviceType = bk.serviceType;
      if (!assignment.serviceName || assignment.serviceName === "Service" || assignment.serviceName === "") {
        assignment.serviceName = bk.isMultiService && Array.isArray(bk.services) && bk.services.length > 0 ? bk.services.map(s => s.name).join(", ") : (bk.service?.name || "Service");
      }
      // Enrich with service detail fields for the technician "view details" panel
      if (bk.service) {
        assignment.serviceDetail = {
          name: bk.service.name,
          description: bk.service.description,
          features: bk.service.features,
          durationMinutes: bk.service.serviceDurationMinutes || bk.service.durationMinutes,
          basePrice: bk.service.basePrice,
        };
      }
      if (bk.airconTypeName != null) assignment.airconTypeName = bk.airconTypeName;
      if (bk.airconType != null) assignment.airconType = bk.airconType;
      if (bk.hp != null) assignment.hp = bk.hp;
      if (bk.hpDescription != null) assignment.hpDescription = bk.hpDescription;
      if (bk.serviceDurationMinutes != null) assignment.serviceDurationMinutes = bk.serviceDurationMinutes;
      if (bk.description != null) assignment.serviceDescription = bk.description;
      if (bk.notes != null) assignment.bookingNotes = bk.notes;
      if (bk.features != null) assignment.serviceFeatures = bk.features;
      if (bk.address != null) assignment.address = assignment.address || bk.address;
      if (bk.customer && !assignment.customerPhone) {
        assignment.customerPhone = bk.customer.phone || assignment.customerPhone;
        assignment.customerEmail = bk.customer.email || assignment.customerEmail;
      }
      // Quantity — resolve from booking, multi-service, repair unit, or default 1
      if (bk.quantity != null) assignment.quantity = bk.quantity;
      else if (Array.isArray(bk.services) && bk.services.length > 0) {
        const sum = bk.services.reduce((s, x) => s + (Number(x.quantity) || 1), 0);
        assignment.quantity = sum || 1;
      } else if (bk.unitInfo && bk.unitInfo.quantity != null) {
        assignment.quantity = bk.unitInfo.quantity;
      } else {
        assignment.quantity = 1;
      }
    }

    return res.json({ assignment, techLocation: tech.location });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/accept
 * Technician accepts a pending assignment.
 */
router.post("/assignments/:id/accept", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });
    if (assignment.status !== "pending_acceptance") {
      return res.status(400).json({ error: "Assignment is not pending acceptance." });
    }

    const isRepair = assignment.serviceType === "repair";
    assignment.status = "accepted";
    assignment.acceptedAt = new Date();
    assignment.notes.push({
      text: "Assignment accepted by technician",
      by: req.user._id,
      byName: tech.name,
      createdAt: new Date(),
    });
    await assignment.save();

    // ── Sync Booking Status ──────────────────────────────────────────────
    const BookingService = require("../models/BookingService");
    if (!isRepair) {
      await BookingService.findByIdAndUpdate(assignment.bookingId, {
        status: "confirmed",
        notes: `[Technician Accepted] ${tech.name} accepted the assignment`,
      });
    } else {
      // For repair bookings, keep the existing repair_scheduled status
      const bookingUpdate = await BookingService.findByIdAndUpdate(
        assignment.bookingId,
        { notes: `[Technician Accepted] ${tech.name} accepted the repair assignment` },
        { new: true }
      );
      if (bookingUpdate) {
        // Socket notify: customer that tech accepted
        try {
          if (global.io) {
            global.io.to(`customer:${bookingUpdate.customerId}`).emit("booking:updated", {
              bookingId: assignment.bookingId,
              status: bookingUpdate.status,
              message: `Technician ${tech.name} has accepted your repair! They will arrive on the scheduled date.`,
            });
          }
        } catch (e) { /* non-critical */ }
      }
    }

    // ── Equipment checkout is now a separate technician action ─────────────────

    // Update technician availability
    tech.availabilityStatus = "Assigned";
    await tech.save();

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "assignment.accept",
      module: "technician",
      req,
      details: { assignmentId: id, bookingId: assignment.bookingId, serviceType: assignment.serviceType },
    }).catch(() => { });

    // ── Sync Project teamStatus (if this assignment belongs to a project) ────
    // When a technician accepts a project assignment, mark them as
    // "acknowledged" in the project's team roster so the admin sees
    // real-time acceptance progress.
    try {
      const Project = require("../models/Project");
      const project = await Project.findOne({
        "assignedTechnicians._id": tech._id,
      });
      if (project) {
        const ts = project.teamStatus || [];
        let entry = ts.find((t) => t._id && t._id.toString() === tech._id.toString());
        if (!entry) {
          entry = { _id: tech._id, name: tech.name, status: "acknowledged", acknowledgedAt: new Date() };
          ts.push(entry);
        } else {
          entry.status = "acknowledged";
          entry.acknowledgedAt = new Date();
          entry.declinedReason = "";
        }
        project.teamStatus = ts;
        await project.save();

        // Notify admin room in real-time so the project detail page refreshes.
        const ioProject = req.app.get("io");
        if (ioProject) {
          ioProject.to("admin-room").emit("project:team-status", {
            projectId: project._id,
            teamStatus: project.teamStatus,
            techName: tech.name,
            action: "accepted",
          });
        }
      }
    } catch (projErr) {
      // Non-critical — don't block assignment acceptance.
      console.warn("Project teamStatus sync skipped:", projErr.message);
    }

    // Create notification for admins
    const { createNotification } = require('../utils/notify');
    const io = req.app.get('io');
    const BookingServiceForNotif = require('../models/BookingService');
    const bookingForNotif = await BookingServiceForNotif.findById(assignment.bookingId).lean();
    const isProjectAssignment = assignment.serviceType === "project";
    await createNotification({
      type: 'assignment_accepted',
      title: isProjectAssignment ? 'Project Assignment Accepted' : 'Repair Assignment Accepted',
      message: `${tech.name} accepted the ${isProjectAssignment ? 'project' : 'repair'} assignment for ${bookingForNotif?.workOrderNumber || bookingForNotif?.bookingReference || 'a service request'}.`,
      role: 'admin',
      referenceId: assignment._id,
      referenceModel: 'Assignment',
      link: '/admin/appointments/active',
      io,
    });

    // Socket: notify admins in real-time
    if (io) {
      io.to("admin-room").emit("assignment:accepted", {
        assignmentId: assignment._id,
        bookingId: assignment.bookingId,
        technicianName: tech.name,
        serviceName: bookingForNotif?.service?.name || "Repair Service",
        customerName: assignment.customerName,
        bookingDate: assignment.bookingDate,
      });
    }

    // ── Email: Notify Customer that Booking was Accepted ─────────────────
    try {
      const { sendBookingAcceptedEmail } = require("../utils/mailer");
      const booking = await BookingService.findById(assignment.bookingId).lean();
      const customerEmail = booking?.customer?.email;
      if (customerEmail) {
        const dateLabel = booking.bookingDate ? new Date(booking.bookingDate).toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD';
        const timeLabel = booking.startTime || 'TBD';
        const techFullName = ((tech.firstName || '') + ' ' + (tech.lastName || '')).trim() || tech.name || 'Your technician';
        sendBookingAcceptedEmail({
          to: customerEmail,
          customerName: booking.customer?.name || 'Customer',
          bookingReference: booking.workOrderNumber || booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: isRepair ? "Repair Service" : (booking.service?.name || 'Service'),
          technicianName: techFullName,
          dateLabel,
          timeLabel,
          locationAddress: booking.location?.address || '',
        }).catch(err => console.error('[MAILER] Failed to send acceptance email:', err.message));
      }
    } catch (mailErr) {
      console.error('[MAILER] Acceptance email error:', mailErr.message);
    }

    // ── Email: Notify admin that technician accepted ─────────────────────
    try {
      const { sendEmail } = require("../utils/mailer");
      const adminEmail = process.env.ADMIN_EMAIL || (await require("../models/User").findOne({ role: "admin" }).select("email").lean())?.email;
      if (adminEmail) {
        const workOrderNum = bookingForNotif?.workOrderNumber || bookingForNotif?.bookingReference || `#${String(assignment.bookingId).slice(-6).toUpperCase()}`;
        sendEmail(
          adminEmail,
          `Technician Accepted Repair – ${workOrderNum} | CALIDRO RACS`,
          `Technician ${tech.name} has accepted the repair assignment for ${workOrderNum}. Scheduled on ${bookingForNotif?.bookingDate ? new Date(bookingForNotif.bookingDate).toLocaleDateString('en-PH') : 'TBD'} at ${bookingForNotif?.startTime || 'TBD'}.`
        ).catch(err => console.error('[MAILER] Failed to send admin acceptance email:', err.message));
      }
    } catch (mailErr) {
      console.error('[MAILER] Admin acceptance email error:', mailErr.message);
    }

    return res.json({ message: "Assignment accepted.", assignment });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/checkout
 * Technician confirms receipt of all assigned reserved equipment.
 */
router.post("/assignments/:id/checkout", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const reserved = await EquipmentAssignment.find({ bookingId: assignment.bookingId, status: "reserved" });
    const checkedOut = [];
    const skipped = [];
    for (const eq of reserved) {
      const tool = await Tool.findById(eq.equipmentId);
      if (!tool) { skipped.push({ id: eq._id, name: eq.equipmentName, reason: "Tool not found" }); continue; }
      if (tool.quantity < eq.quantity) { skipped.push({ id: eq._id, name: eq.equipmentName, reason: "Insufficient stock" }); continue; }
      tool.quantity -= eq.quantity;
      await tool.save();
      eq.status = "checked_out";
      eq.checkedOutAt = new Date();
      eq.checkedOutBy = req.user._id;
      await eq.save();
      checkedOut.push({ id: eq._id, name: eq.equipmentName, qty: eq.quantity });
    }

    if (!reserved.length || checkedOut.length > 0) {
      assignment.equipmentCheckedOut = true;
      assignment.equipmentCheckedOutAt = new Date();
      assignment.notes.push({
        text: `Checked out ${checkedOut.length} equipment item(s)`,
        by: req.user._id,
        byName: tech.name,
        createdAt: new Date(),
      });
      await assignment.save();
    }

    return res.json({ message: "Equipment checked out.", checkedOut, skipped, assignment });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/return
 * Technician confirms return of all assigned equipment.
 */
router.post("/assignments/:id/return", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const inUse = await EquipmentAssignment.find({ bookingId: assignment.bookingId, status: { $in: ["checked_out", "in_use"] } });
    const returned = [];
    for (const eq of inUse) {
      const tool = await Tool.findById(eq.equipmentId);
      if (tool) {
        tool.quantity += eq.quantity;
        await tool.save();
      }
      eq.status = "returned";
      eq.returnedAt = new Date();
      await eq.save();
      returned.push({ id: eq._id, name: eq.equipmentName, qty: eq.quantity });
    }

    assignment.equipmentReturned = true;
    assignment.equipmentReturnedAt = new Date();
    assignment.notes.push({
      text: `Returned ${returned.length} equipment item(s)`,
      by: req.user._id,
      byName: tech.name,
      createdAt: new Date(),
    });
    await assignment.save();

    return res.json({ message: "Equipment returned.", returned, assignment });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/decline
 * Body: { reason?: string }
 * Technician declines a pending assignment.
 */
router.post("/assignments/:id/decline", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });
    if (assignment.status !== "pending_acceptance") {
      return res.status(400).json({ error: "Assignment is not pending acceptance." });
    }

    const reason = String(req.body.reason || "").trim().slice(0, 500);
    assignment.status = "declined";
    assignment.declinedAt = new Date();
    assignment.declineReason = reason;
    assignment.notes.push({
      text: `Assignment declined${reason ? ": " + reason : ""}`,
      by: req.user._id,
      byName: tech.name,
      createdAt: new Date(),
    });
    await assignment.save();

    // ── Sync Booking Status ──────────────────────────────────────────────
    const BookingService = require("../models/BookingService");
    const bookingBeforeDecline = await BookingService.findById(assignment.bookingId).lean();
    const newCount = (bookingBeforeDecline?.reassignmentCount || 0) + 1;
    await BookingService.findByIdAndUpdate(assignment.bookingId, {
      $set: {
        status: "pending_reassignment",
        technicianId: null,
        assignmentId: null,
        notes: `[Technician Declined] ${tech.name} declined: ${reason || "No reason provided"}`,
        ...(newCount >= 3 ? { escalated: true } : {}),
      },
      $inc: { reassignmentCount: 1 },
      $push: {
        cancellationHistory: {
          technicianId: tech._id,
          technicianName: tech.name,
          action: "declined",
          reason: reason || "No reason provided",
          timestamp: new Date(),
        },
      },
    });

    // ── Socket: Notify Admins ────────────────────────────────────────────
    const io = req.app.get("io");
    if (io) {
      io.to("admin-room").emit("assignment:declined", {
        assignmentId: assignment._id,
        bookingId: assignment.bookingId,
        technicianName: tech.name,
        reason: reason || "No reason provided",
        customerName: assignment.customerName,
        serviceName: assignment.serviceName,
      });
    }

    // Create notification for admins
    const { createNotification } = require('../utils/notify');
    await createNotification({
      type: 'assignment_declined',
      title: 'Assignment Declined',
      message: `${tech.name} declined the assignment for ${assignment.serviceName || 'a service'}. ${reason ? 'Reason: ' + reason : ''}`,
      role: 'admin',
      referenceId: assignment._id,
      referenceModel: 'Assignment',
      link: '/admin/appointments/queue',
      priority: 'high',
      io,
    });

    // ── Email: Notify Admins of Decline ──────────────────────────────────
    try {
      const User = require("../models/User");
      const BookingServiceForEmail = require("../models/BookingService");
      const { sendTechnicianDeclinedEmail } = require("../utils/mailer");
      const adminUser = await User.findOne({ role: "admin" }).lean();
      const adminEmail = adminUser?.email;
      const bookingForEmail = await BookingServiceForEmail.findById(assignment.bookingId).lean();
      if (adminEmail && bookingForEmail) {
        const dateLabel = assignment.bookingDate
          ? new Date(assignment.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
          : "TBD";
        sendTechnicianDeclinedEmail({
          to: adminEmail,
          adminName: adminUser.name || "Admin",
          technicianName: tech.name,
          bookingReference: bookingForEmail.bookingReference || `#${String(bookingForEmail._id).slice(-6).toUpperCase()}`,
          serviceName: assignment.serviceName || "Service",
          customerName: assignment.customerName || "Customer",
          dateLabel,
          timeLabel: assignment.startTime || "TBD",
          reason: reason || "",
        }).catch((err) => console.error("[MAILER] Failed to send decline email:", err.message));
      }
    } catch (mailErr) {
      console.error("[MAILER] Decline email error:", mailErr.message);
    }

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "assignment.decline",
      module: "technician",
      req,
      details: { assignmentId: id, reason },
    }).catch(() => { });

    // ── Sync Project teamStatus (if this assignment belongs to a project) ────
    try {
      const Project = require("../models/Project");
      const project = await Project.findOne({
        "assignedTechnicians._id": tech._id,
      });
      if (project) {
        const ts = project.teamStatus || [];
        let entry = ts.find((t) => t._id && t._id.toString() === tech._id.toString());
        if (!entry) {
          entry = { _id: tech._id, name: tech.name, status: "declined", declinedReason: reason || "" };
          ts.push(entry);
        } else {
          entry.status = "declined";
          entry.declinedReason = reason || "";
          entry.acknowledgedAt = undefined;
        }
        project.teamStatus = ts;
        await project.save();

        const ioProject = req.app.get("io");
        if (ioProject) {
          ioProject.to("admin-room").emit("project:team-status", {
            projectId: project._id,
            teamStatus: project.teamStatus,
            techName: tech.name,
            action: "declined",
          });
        }
      }
    } catch (projErr) {
      console.warn("Project teamStatus sync skipped:", projErr.message);
    }

    return res.json({ message: "Assignment declined.", assignment });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// 1D. MARK AS NO-SHOW
// ============================================================================
router.post("/assignments/:id/no-show", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const { sendNoShowRescheduleEmail } = require("../utils/mailer");
    const crypto = require("crypto");

    const id = req.params.id;
    const assignment = await Assignment.findById(id);
    if (!assignment) return res.status(404).json({ error: "Assignment not found." });

    if (assignment.status !== "on_site") {
      return res.status(400).json({ error: "Can only mark no-show if currently arrived/on-site." });
    }

    // 1. Generate Token
    const token = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours

    // 2. Update Assignment
    assignment.status = "no_show";
    if (!assignment.notes) assignment.notes = [];
    assignment.notes.push({
      text: "Technician marked customer as No-Show.",
      by: req.user._id,
      byName: req.user.name || "Technician",
      createdAt: new Date()
    });
    await assignment.save();

    // 3. Update BookingService
    const booking = await BookingService.findById(assignment.bookingId);
    if (booking) {
      booking.status = "no-show";
      booking.noShowRescheduleToken = token;
      booking.noShowRescheduleExpiry = expiry;
      booking.noShowRescheduleStatus = "pending";
      booking.noShowAt = new Date();
      if (!booking.statusHistory) booking.statusHistory = [];
      booking.statusHistory.push({
        status: "no-show",
        message: "Customer marked as No-Show by technician.",
        date: new Date(),
        by: req.user.name || "Technician"
      });
      await booking.save();

      // 4. Send Email to Customer
      if (booking.customer && booking.customer.email) {
        const rescheduleUrl = `${req.protocol}://${req.get("host")}/reschedule/no-show/${token}`;

        await sendNoShowRescheduleEmail({
          to: booking.customer.email,
          customerName: booking.customer.name,
          bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: assignment.serviceName,
          technicianName: req.user.name,
          dateLabel: booking.bookingDate ? new Date(booking.bookingDate).toLocaleDateString() : "TBD",
          timeLabel: booking.startTime || "TBD",
          rescheduleUrl
        });
      }
    }

    res.json({ message: "Job marked as no-show and customer notified." });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// 1E. TECHNICIAN-INITIATED NO-SHOW RESCHEDULE
// ============================================================================
router.post("/assignments/:id/no-show-reschedule", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const { newDate, newTime } = req.body;

    if (!newDate || !newTime) {
      return res.status(400).json({ error: "newDate and newTime are required." });
    }

    const assignment = await Assignment.findById(req.params.id);
    if (!assignment) return res.status(404).json({ error: "Assignment not found." });

    if (assignment.status !== "no_show") {
      return res.status(400).json({ error: "Can only reschedule no-show assignments." });
    }

    const booking = await BookingService.findById(assignment.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found." });

    // Conflict check
    const hasConflict = await BookingService.findOne({
      _id: { $ne: booking._id },
      bookingDate: new Date(newDate),
      startTime: newTime,
      status: { $in: ["confirmed", "scheduled", "in-progress", "en-route", "on-the-way", "re-scheduled"] },
    });
    if (hasConflict) {
      return res.status(409).json({ error: "That time slot is already booked. Please choose another." });
    }

    // Update booking
    booking.bookingDate = new Date(newDate);
    booking.startTime = newTime;
    booking.selectedTimeLabel = newTime;
    booking.status = "re-scheduled";
    booking.noShowRescheduleStatus = "rescheduled";
    booking.noShowRescheduleToken = undefined;
    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      status: "re-scheduled",
      message: `Rescheduled by technician from No-Show to ${newDate} at ${newTime}`,
      date: new Date(),
      by: req.user.name || "Technician",
    });
    await booking.save();

    // Create new assignment in pending_acceptance
    await Assignment.create({
      bookingId: booking._id,
      customerName: booking.customer?.name || "Customer",
      serviceName: booking.serviceName || "Service",
      serviceType: booking.serviceType || "core",
      bookingDate: booking.bookingDate,
      startTime: booking.startTime,
      status: "pending_acceptance",
    });

    res.json({ ok: true, message: "Booking rescheduled successfully." });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// 1F. TECHNICIAN-INITIATED NO-SHOW CANCEL
// ============================================================================
router.post("/assignments/:id/no-show-cancel", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");

    const assignment = await Assignment.findById(req.params.id);
    if (!assignment) return res.status(404).json({ error: "Assignment not found." });

    if (assignment.status !== "no_show") {
      return res.status(400).json({ error: "Can only cancel no-show assignments." });
    }

    const booking = await BookingService.findById(assignment.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found." });

    booking.status = "cancelled";
    booking.cancellationReason = "Cancelled by technician after No-Show.";
    booking.noShowRescheduleStatus = "cancelled";
    booking.noShowRescheduleToken = undefined;
    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      status: "cancelled",
      message: "Booking cancelled by technician after No-Show.",
      date: new Date(),
      by: req.user.name || "Technician",
    });
    await booking.save();

    res.json({ ok: true, message: "Booking cancelled." });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/mark-delayed
 * Technician manually flags the current job as delayed. Cascades to later
 * same-technician bookings on the same day: those are flagged and their
 * customers are NOTIFIED (notify-only — no auto-reschedule).
 * Body: { reason?: string }
 */
router.post("/assignments/:id/mark-delayed", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const { id } = req.params;
    const { reason } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });
    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const booking = await BookingService.findById(assignment.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const { markJobDelayed } = require("../utils/delayNotifier");
    const affected = await markJobDelayed(booking._id, {
      reason: reason || "Technician marked the previous job as delayed.",
      io: req.app.get("io"),
      byTechId: tech._id,
    });

    res.json({
      ok: true,
      message: `Marked delayed. ${affected.length} later appointment(s) notified.`,
      affectedCount: affected.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/technician/assignments/:id/status
 * Body: { status: "en_route" | "on_site" | "in_progress" | "completed" }
 * Transitions assignment status forward in the pipeline.
 */
router.patch("/assignments/:id/status", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const Technician = require("../models/Technician");
    const mongoose = require("mongoose");
    const audit = require("../utils/audit");

    const { id } = req.params;
    const { status: newStatus } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const validTransitions = {
      accepted: ["en_route", "cancelled"],
      en_route: ["on_site", "cancelled"],
      on_site: ["in_progress", "no_show", "cancelled"],
      in_progress: ["completed"],
    };

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const allowed = validTransitions[assignment.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return res.status(400).json({
        error: `Cannot transition from "${assignment.status}" to "${newStatus}". Allowed: ${allowed ? allowed.join(", ") : "none"}`,
      });
    }

    // -- En Route Time Guard (TEMPORARILY DISABLED) ---------------------
    // if (newStatus === "en_route" && assignment.bookingDate) {
    //   const bookingDateObj = new Date(assignment.bookingDate);
    //   const bookingDateMidnight = new Date(bookingDateObj.getFullYear(), bookingDateObj.getMonth(), bookingDateObj.getDate(), 0, 0, 0, 0);
    //   const nowLocal = new Date();
    //   const todayMidnight = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), nowLocal.getDate(), 0, 0, 0, 0);
    //   if (bookingDateMidnight > todayMidnight) {
    //     const bookingLabel = bookingDateObj.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    //     return res.status(400).json({ error: `...`, code: "TOO_EARLY" });
    //   }
    //   if (bookingDateMidnight.getTime() === todayMidnight.getTime() && assignment.startTime) { ... }
    // }

    if (newStatus === "completed") {
      const BookingService = require("../models/BookingService");
      const booking = await BookingService.findById(assignment.bookingId);
      if (booking && ["cod", "cash", "cash_onsite", "gcash_downpayment"].includes(booking.paymentMethod) && !booking.balanceCollected && (booking.balanceAmount || 0) > 0) {
        return res.status(400).json({ error: "You must collect the remaining balance before completing this job." });
      }
    }

    const now = new Date();
    assignment.status = newStatus;

    const statusTimestamps = {
      en_route: "enRouteAt",
      on_site: "arrivedAt",
      in_progress: "startedAt",
      completed: "completedAt",
      cancelled: "cancelledAt",
    };
    if (statusTimestamps[newStatus]) {
      assignment[statusTimestamps[newStatus]] = now;
    }

    assignment.notes.push({
      text: `Status changed to ${newStatus.replace(/_/g, " ")}`,
      by: req.user._id,
      byName: tech.name,
      createdAt: now,
    });
    await assignment.save();

    const availabilityMap = {
      en_route: "On The Way",
      on_site: "In Progress",
      in_progress: "In Progress",
    };
    if (availabilityMap[newStatus]) {
      tech.availabilityStatus = availabilityMap[newStatus];
      await tech.save();
    }

    if (newStatus === "completed" || newStatus === "cancelled") {
      const { resolveAvailabilityStatus } = require("../utils/availability");
      const resolvedStatus = await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
      tech.availabilityStatus = resolvedStatus;
      await tech.save();
    }

    // -- Sync Booking Status ----------------------------------------------
    const BookingService = require("../models/BookingService");
    const bookingStatusMap = {
      en_route: "on-the-way",
      on_site: "arrived",
      in_progress: "in-progress",
      completed: "completed",
      cancelled: "pending_reassignment",
    };
    if (bookingStatusMap[newStatus]) {
      const isRepair = assignment.serviceType === "repair";
      // For repair services, intermediate technician states (en_route, on_site)
      // should still sync to the booking so the customer sees "On the Way" / "Arrived".
      // The in_progress and completed states are handled by dedicated repair endpoints.
      const skipForRepair = isRepair && (newStatus === "in_progress" || newStatus === "completed");
      if (!skipForRepair) {
        const updateData = { status: bookingStatusMap[newStatus] };
        if (newStatus === "completed") updateData.completedAt = now;
        await BookingService.findByIdAndUpdate(assignment.bookingId, updateData);

        try {
          const io = req.app.get("io");
          if (io) {
            const updatedBooking = await BookingService.findById(assignment.bookingId).lean();
            const customerId = updatedBooking?.customerId?._id || updatedBooking?.customerId;
            if (customerId) {
              io.to("customer:" + customerId).emit("booking:status-change", {
                bookingId: assignment.bookingId,
                status: bookingStatusMap[newStatus],
                technicianName: tech.name,
                timestamp: Date.now(),
              });
            }
          }
        } catch (sockErr) {
          console.warn("[socket] booking:status-change emit failed", sockErr?.message);
        }
      }
    }

    if (newStatus === "en_route") {
      try {
        const { sendTechArrivalNotificationEmail } = require("../utils/mailer");
        const updatedBookingForEmail = await BookingService.findById(assignment.bookingId).lean();
        if (updatedBookingForEmail?.customer?.email) {
          const dateLabel = updatedBookingForEmail.bookingDate
            ? new Date(updatedBookingForEmail.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
            : "TBD";
          const timeLabel = updatedBookingForEmail.startTime || "TBD";
          const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
          sendTechArrivalNotificationEmail({
            to: updatedBookingForEmail.customer.email,
            customerName: updatedBookingForEmail.customer.name || "Customer",
            bookingReference: updatedBookingForEmail.bookingReference || `#${String(updatedBookingForEmail._id).slice(-6).toUpperCase()}`,
            techName: techFullName,
            serviceName: assignment.serviceName || updatedBookingForEmail.service?.name || "Service",
            dateLabel,
            timeLabel,
            locationAddress: updatedBookingForEmail.location?.address || "",
          }).catch(err => console.error("[MAILER] Failed to send on-the-way email:", err.message));
        }
      } catch (mailErr) {
        console.error("[MAILER] On-the-way email error:", mailErr.message);
      }
    }

    if (newStatus === "on_site") {
      try {
        const { sendTechnicianArrivedEmail } = require("../utils/mailer");
        const updatedBookingForEmail = await BookingService.findById(assignment.bookingId).lean();
        if (updatedBookingForEmail?.customer?.email) {
          const dateLabel = updatedBookingForEmail.bookingDate
            ? new Date(updatedBookingForEmail.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
            : "TBD";
          const timeLabel = updatedBookingForEmail.startTime || "TBD";
          const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
          sendTechnicianArrivedEmail({
            to: updatedBookingForEmail.customer.email,
            customerName: updatedBookingForEmail.customer.name || "Customer",
            bookingReference: updatedBookingForEmail.bookingReference || `#${String(updatedBookingForEmail._id).slice(-6).toUpperCase()}`,
            techName: techFullName,
            serviceName: assignment.serviceName || updatedBookingForEmail.service?.name || "Service",
            dateLabel,
            timeLabel,
            locationAddress: updatedBookingForEmail.location?.address || "",
          }).catch(err => console.error("[MAILER] Failed to send arrived email:", err.message));
        }
      } catch (mailErr) {
        console.error("[MAILER] Arrived email error:", mailErr.message);
      }
    }

    if (newStatus === "in_progress") {
      try {
        const { sendWorkStartedEmail } = require("../utils/mailer");
        const updatedBookingForEmail = await BookingService.findById(assignment.bookingId).lean();
        if (updatedBookingForEmail?.customer?.email) {
          const dateLabel = updatedBookingForEmail.bookingDate
            ? new Date(updatedBookingForEmail.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
            : "TBD";
          const timeLabel = updatedBookingForEmail.startTime || "TBD";
          const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
          sendWorkStartedEmail({
            to: updatedBookingForEmail.customer.email,
            customerName: updatedBookingForEmail.customer.name || "Customer",
            bookingReference: updatedBookingForEmail.bookingReference || `#${String(updatedBookingForEmail._id).slice(-6).toUpperCase()}`,
            techName: techFullName,
            serviceName: assignment.serviceName || updatedBookingForEmail.service?.name || "Service",
            dateLabel,
            timeLabel,
            locationAddress: updatedBookingForEmail.location?.address || "",
          }).catch(err => console.error("[MAILER] Failed to send work started email:", err.message));
        }
      } catch (mailErr) {
        console.error("[MAILER] Work started email error:", mailErr.message);
      }
    }

    if (newStatus === "completed") {
      const ServiceReport = require("../models/ServiceReport");
      const existingReport = await ServiceReport.findOne({ bookingId: assignment.bookingId });
      if (!existingReport) {
        await ServiceReport.create({
          bookingId: assignment.bookingId,
          assignmentId: assignment._id,
          technicianId: tech._id,
          customerName: assignment.customerName,
          serviceName: assignment.serviceName,
          serviceType: assignment.serviceType,
          bookingDate: assignment.bookingDate,
          status: "draft",
        });
      }

      const { createNotification } = require("../utils/notify");
      const io = req.app.get("io");
      const completedBooking = await BookingService.findById(assignment.bookingId).lean();
      await createNotification({
        type: "booking_completed",
        title: "Booking Completed",
        message: `${tech.name} completed ${assignment.serviceName || "a service"} for ${assignment.customerName || "a customer"}.`,
        role: "admin",
        referenceId: assignment.bookingId,
        referenceModel: "BookingService",
        link: "/admin/appointments/completed",
        priority: "normal",
        io,
      });

      try {
        const { sendBookingCompletedEmail } = require("../utils/mailer");
        if (completedBooking?.customer?.email) {
          const dateLabel = new Date().toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
          const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
          sendBookingCompletedEmail({
            to: completedBooking.customer.email,
            customerName: completedBooking.customer.name || "Customer",
            bookingReference: completedBooking.bookingReference || `#${String(completedBooking._id).slice(-6).toUpperCase()}`,
            serviceName: assignment.serviceName || "Service",
            technicianName: techFullName,
            dateLabel,
          }).catch((err) => console.error("[MAILER] Failed to send completion email:", err.message));
        }
      } catch (mailErr) {
        console.error("[MAILER] Completion email error:", mailErr.message);
      }
    }

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "assignment.status." + newStatus,
      module: "technician",
      req,
      details: { assignmentId: id, newStatus },
    }).catch(() => { });

    return res.json({ message: `Status updated to ${newStatus.replace(/_/g, " ")}.`, assignment });
  } catch (err) {
    next(err);
  }
});
/**
 * POST /api/technician/assignments/:id/collect-payment
 * Body: { amount: number, notes?: string }
 * Technician collects balance payment from customer after service completion.
 * Only allowed for COD bookings with remaining balance.
 */
router.post("/assignments/:id/collect-payment", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const Payment = require("../models/Payment");
    const { id } = req.params;
    const { amount, notes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const booking = await BookingService.findById(assignment.bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Only COD bookings with remaining balance can collect payment
    if (!["cod", "cash", "cash_onsite", "gcash_downpayment"].includes(booking.paymentMethod)) {
      return res.status(400).json({ error: "Payment collection is only available for Cash, Cash on Delivery, or Downpayment bookings." });
    }
    if (booking.balanceCollected) {
      return res.status(400).json({ error: "Balance has already been collected for this booking." });
    }
    const balance = booking.balanceAmount || 0;
    if (balance <= 0) {
      return res.status(400).json({ error: "No remaining balance to collect." });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Please enter a valid payment amount." });
    }

    const now = new Date();

    // Update booking payment
    booking.amountPaid = (booking.amountPaid || 0) + amount;
    booking.balanceAmount = Math.max(0, balance - amount);
    booking.balanceCollected = booking.balanceAmount <= 0;
    if (booking.balanceCollected) {
      booking.balanceCollectedAt = now;
      booking.balanceCollectedBy = tech._id;
      booking.paymentStatus = "paid";
    }
    if (notes) {
      booking.notes = (booking.notes ? booking.notes + "\n" : "") + `[Payment Collected] ₱${amount.toLocaleString()} — ${notes}`;
    }
    await booking.save();

    // Create a Payment record for this collection
    await Payment.create({
      bookingId: booking._id,
      amount: amount,
      method: "cod",
      type: "final",
      gateway: "cod",
      status: "paid",
      reference: notes || `Collected by ${tech.name}`,
      verifiedAt: now,
      completedAt: now,
      notes: `Balance collected by technician ${tech.name}`,
    });

    // Notify admins
    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    const collectedAll = booking.balanceCollected;
    await createNotification({
      type: "payment_collected",
      title: collectedAll ? "Full Payment Received" : "Partial Balance Collected",
      message: collectedAll
        ? `${tech.name} collected the remaining balance of ₱${amount.toLocaleString()} for ${booking.bookingReference}. Payment is now complete.`
        : `${tech.name} collected ₱${amount.toLocaleString()} for ${booking.bookingReference}. Remaining balance: ₱${booking.balanceAmount.toLocaleString()}.`,
      role: "admin",
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: "/admin/appointments/completed",
      priority: collectedAll ? "normal" : "high",
      io,
    });

    console.log(`💰 Payment collected for ${booking.bookingReference}: ₱${amount} (remaining: ₱${booking.balanceAmount})`);
    return res.json({
      message: collectedAll
        ? `Full payment of ₱${booking.amountPaid.toLocaleString()} recorded. Booking fully paid.`
        : `₱${amount.toLocaleString()} collected. Remaining balance: ₱${booking.balanceAmount.toLocaleString()}.`,
      booking: {
        amountPaid: booking.amountPaid,
        balanceAmount: booking.balanceAmount,
        balanceCollected: booking.balanceCollected,
        paymentStatus: booking.paymentStatus,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/cancel
 * Body: { reason: string, customReason?: string }
 * Technician cancels an active assignment. Booking goes back to reassignment queue.
 * Enterprise-level: validates status, notifies eligible techs, emails customer, audits.
 */
router.post("/assignments/:id/cancel", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const LeaveRequest = require("../models/LeaveRequest");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    const cancellableStatuses = ["accepted", "en_route", "on_site"];
    if (!cancellableStatuses.includes(assignment.status)) {
      return res.status(400).json({ error: `Cannot cancel assignment in "${assignment.status}" status. Only accepted, en route, or on site assignments can be cancelled.` });
    }

    const { reason, customReason } = req.body;
    if (!reason) return res.status(400).json({ error: "Cancellation reason is required." });

    const validReasons = ["emergency", "vehicle_breakdown", "personal", "weather", "overlapping_job", "other"];
    if (!validReasons.includes(reason)) {
      return res.status(400).json({ error: "Invalid cancellation reason." });
    }

    const reasonLabels = {
      emergency: "Emergency",
      vehicle_breakdown: "Vehicle Breakdown",
      personal: "Personal Reason",
      weather: "Weather Conditions",
      overlapping_job: "Overlapping Job Conflict",
      other: "Other",
    };
    const cancellationReason = reason === "other"
      ? `Other: ${(customReason || "").trim().slice(0, 500) || "No details provided"}`
      : reasonLabels[reason];

    const now = new Date();
    assignment.status = "cancelled";
    assignment.cancelledAt = now;
    assignment.cancellationReason = cancellationReason;
    assignment.notes.push({
      text: `Assignment cancelled by technician. Reason: ${cancellationReason}`,
      by: req.user._id,
      byName: tech.name,
      createdAt: now,
    });
    await assignment.save();

    // ── Sync Booking Status ──────────────────────────────────────────────
    const cancelNote = `[Technician Cancelled] ${tech.name} cancelled: ${cancellationReason}`;
    console.log("[CANCEL] Updating booking:", assignment.bookingId, "to status: pending_reassignment");
    const bookingBeforeCancel = await BookingService.findById(assignment.bookingId).lean();
    const newCancelCount = (bookingBeforeCancel?.reassignmentCount || 0) + 1;
    const booking = await BookingService.findByIdAndUpdate(assignment.bookingId, {
      $set: {
        status: "pending_reassignment",
        technicianId: null,
        assignmentId: null,
        cancellationReason: `[Technician Cancelled] ${tech.name}: ${cancellationReason}`,
        notes: cancelNote,
        ...(newCancelCount >= 3 ? { escalated: true } : {}),
      },
      $inc: { reassignmentCount: 1 },
      $push: {
        cancellationHistory: {
          technicianId: tech._id,
          technicianName: tech.name,
          action: "cancelled",
          reason: cancellationReason,
          timestamp: new Date(),
        },
      },
    }, { new: true }).lean();
    console.log("[CANCEL] Booking updated:", booking ? { _id: booking._id, status: booking.status } : "NOT FOUND");

    // ── Resolve Technician Availability ──────────────────────────────────
    const { resolveAvailabilityStatus } = require("../utils/availability");
    const resolvedStatus = await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
    tech.availabilityStatus = resolvedStatus;
    await tech.save();

    const io = req.app.get("io");

    // ── Find Eligible Technicians & Push Vacancy Notification ────────────
    try {
      const allTechs = await Technician.find({ active: true, _id: { $ne: tech._id } }).lean();
      const eligibleTechIds = [];

      for (const candidate of allTechs) {
        // Check leave
        const onLeave = await LeaveRequest.findOne({
          technicianId: candidate._id,
          status: "approved",
          startDate: { $lte: booking.bookingDate },
          endDate: { $gte: booking.bookingDate },
        }).lean();
        if (onLeave) continue;

        // Check schedule
        const schedule = await TechnicianSchedule.findOne({ technicianId: candidate._id }).lean();
        if (!schedule) continue;
        const bookingDay = new Date(booking.bookingDate).getDay();
        const isWorkingDay = (schedule.workingDays || []).some(wd => wd.dayOfWeek === bookingDay);
        if (!isWorkingDay) continue;
        const isRestDate = (schedule.restDates || []).some(rd => {
          const rdDate = new Date(rd).toDateString();
          return rdDate === new Date(booking.bookingDate).toDateString();
        });
        if (isRestDate) continue;

        // Check capacity (< 3 active assignments)
        const activeCount = await Assignment.countDocuments({
          technicianId: candidate._id,
          status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
        });
        if (activeCount >= 3) continue;

        eligibleTechIds.push(String(candidate._id));
      }

      // Push vacancy notification to each eligible technician
      for (const techId of eligibleTechIds) {
        if (io) {
          io.to("tech:" + techId).emit("assignment:vacancy", {
            bookingId: booking._id,
            bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
            serviceName: assignment.serviceName || "Service",
            customerName: assignment.customerName || "Customer",
            bookingDate: booking.bookingDate,
            startTime: assignment.startTime,
            address: assignment.address,
            estimatedFee: assignment.estimatedFee,
            message: `New job available: ${assignment.serviceName || "Service"} for ${assignment.customerName || "Customer"}`,
          });
        }

        // In-app notification for each eligible tech
        const { createNotification } = require("../utils/notify");
        await createNotification({
          type: "assignment_new",
          title: "New Job Available",
          message: `A job was cancelled. Available: ${assignment.serviceName || "Service"} for ${assignment.customerName || "Customer"} on ${assignment.bookingDate ? new Date(assignment.bookingDate).toLocaleDateString("en-PH") : "TBD"}.`,
          role: "technician",
          referenceId: booking._id,
          referenceModel: "BookingService",
          link: "/technician/assignments?tab=available",
          priority: "normal",
          io,
        }).catch(() => { });
      }
    } catch (vacancyErr) {
      console.error("[CANCEL] Vacancy notification error:", vacancyErr.message);
    }

    // ── Notify Admins ────────────────────────────────────────────────────
    if (io) {
      io.to("admin-room").emit("assignment:cancelled", {
        assignmentId: assignment._id,
        bookingId: assignment.bookingId,
        technicianName: tech.name,
        reason: cancellationReason,
        customerName: assignment.customerName,
        serviceName: assignment.serviceName,
        bookingDate: assignment.bookingDate,
      });
    }

    const { createNotification } = require("../utils/notify");
    await createNotification({
      type: "booking_cancelled",
      title: "Technician Cancelled Assignment",
      message: `${tech.name} cancelled the assignment for ${assignment.serviceName || "a service"}. Reason: ${cancellationReason}`,
      role: "admin",
      referenceId: assignment._id,
      referenceModel: "Assignment",
      link: "/admin/appointments/queue",
      priority: "high",
      io,
    });

    // ── Email: Notify Customer ───────────────────────────────────────────
    try {
      const { sendTechnicianCancelledEmail } = require("../utils/mailer");
      if (booking?.customer?.email) {
        const dateLabel = booking.bookingDate
          ? new Date(booking.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
          : "TBD";
        const timeLabel = booking.startTime || "TBD";
        sendTechnicianCancelledEmail({
          to: booking.customer.email,
          customerName: booking.customer?.name || "Customer",
          bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: booking.isMultiService && Array.isArray(booking.services) && booking.services.length > 0 ? booking.services.map(s => s.name).join(', ') : (booking.service?.name || assignment.serviceName || "Service"),
          technicianName: tech.name,
          dateLabel,
          timeLabel,
          reason: cancellationReason,
        }).catch(err => console.error("[MAILER] Failed to send cancellation email:", err.message));
      }
    } catch (mailErr) {
      console.error("[MAILER] Cancellation email error:", mailErr.message);
    }

    // ── Audit Log ────────────────────────────────────────────────────────
    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "assignment.cancel",
      module: "technician",
      req,
      details: {
        assignmentId: id,
        bookingId: assignment.bookingId,
        reason: cancellationReason,
        previousStatus: assignment.status,
      },
    }).catch(() => { });

    return res.json({
      message: "Assignment cancelled. The booking has been returned to the reassignment queue.",
      assignment,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/available-jobs
 * Returns pending_reassignment bookings the technician is eligible to accept.
 * Filters by: schedule, leave, capacity (< 3 active).
 */
router.get("/available-jobs", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const LeaveRequest = require("../models/LeaveRequest");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    // Check capacity
    const activeCount = await Assignment.countDocuments({
      technicianId: tech._id,
      status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
    });

    if (activeCount >= 3) {
      return res.json({ items: [], total: 0, reason: "capacity_full" });
    }

    // Check schedule
    const schedule = await TechnicianSchedule.findOne({ technicianId: tech._id }).lean();
    if (!schedule) {
      return res.json({ items: [], total: 0, reason: "no_schedule" });
    }

    // Check leave
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const activeLeave = await LeaveRequest.findOne({
      technicianId: tech._id,
      status: "approved",
      startDate: { $lte: today },
      endDate: { $gte: today },
    }).lean();
    if (activeLeave) {
      return res.json({ items: [], total: 0, reason: "on_leave" });
    }

    // Find bookings in pending_reassignment
    const bookings = await BookingService.find({
      status: "pending_reassignment",
      bookingDate: { $gte: today },
    })
      .sort({ bookingDate: 1 })
      .limit(50)
      .lean();

    // Filter by eligibility (working day, not rest date)
    const eligible = bookings.filter(b => {
      const bookingDay = new Date(b.bookingDate).getDay();
      const isWorkingDay = (schedule.workingDays || []).some(wd => wd.dayOfWeek === bookingDay);
      if (!isWorkingDay) return false;
      const isRestDate = (schedule.restDates || []).some(rd => {
        return new Date(rd).toDateString() === new Date(b.bookingDate).toDateString();
      });
      if (isRestDate) return false;
      return true;
    });

    const items = eligible.map(b => ({
      _id: b._id,
      bookingReference: b.bookingReference || `#${String(b._id).slice(-6).toUpperCase()}`,
      customerName: b.customer?.name || b.customerName || "Customer",
      serviceName: b.isMultiService && Array.isArray(b.services) && b.services.length > 0 ? b.services.map(s => s.name).join(', ') : (b.service?.name || "Service"),
      bookingDate: b.bookingDate,
      startTime: b.startTime,
      address: b.location?.address || "",
      estimatedFee: b.estimatedFee || b.totalPrice || 0,
      travelFare: b.travelFare || 0,
      priority: b.priority || "normal",
    }));

    return res.json({ items, total: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/available-jobs/:bookingId/accept
 * Technician accepts a pending_reassignment booking from the available jobs queue.
 */
router.post("/available-jobs/:bookingId/accept", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const BookingService = require("../models/BookingService");
    const TechnicianSchedule = require("../models/TechnicianSchedule");
    const LeaveRequest = require("../models/LeaveRequest");
    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: "Invalid booking id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    // Re-verify eligibility
    const activeCount = await Assignment.countDocuments({
      technicianId: tech._id,
      status: { $in: ["pending_acceptance", "accepted", "en_route", "on_site", "in_progress"] },
    });
    if (activeCount >= 3) {
      return res.status(400).json({ error: "You have reached the maximum active assignments (3)." });
    }

    const schedule = await TechnicianSchedule.findOne({ technicianId: tech._id }).lean();
    if (!schedule) return res.status(400).json({ error: "No schedule configured." });

    const booking = await BookingService.findById(bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status !== "pending_reassignment") {
      return res.status(400).json({ error: "This booking is no longer available for acceptance." });
    }

    // Check working day
    const bookingDay = new Date(booking.bookingDate).getDay();
    const isWorkingDay = (schedule.workingDays || []).some(wd => wd.dayOfWeek === bookingDay);
    if (!isWorkingDay) return res.status(400).json({ error: "This booking date is not a working day for you." });

    // Check rest date
    const isRestDate = (schedule.restDates || []).some(rd => {
      return new Date(rd).toDateString() === new Date(booking.bookingDate).toDateString();
    });
    if (isRestDate) return res.status(400).json({ error: "This date is a rest day for you." });

    // Check leave
    const activeLeave = await LeaveRequest.findOne({
      technicianId: tech._id,
      status: "approved",
      startDate: { $lte: booking.bookingDate },
      endDate: { $gte: booking.bookingDate },
    }).lean();
    if (activeLeave) return res.status(400).json({ error: "You are on approved leave for this date." });

    const now = new Date();

    // Create assignment
    const assignment = await Assignment.create({
      bookingId: booking._id,
      technicianId: tech._id,
      customerName: booking.customer?.name || booking.customerName || "",
      customerPhone: booking.customer?.phone || "",
      customerEmail: booking.customer?.email || "",
      serviceType: booking.service?.type || "",
      serviceName: booking.service?.name || "",
      servicePrice: booking.servicePrice || 0,
      bookingDate: booking.bookingDate,
      startTime: booking.startTime,
      endTime: booking.endTime,
      address: booking.location?.address || "",
      coordinates: booking.location?.coordinates,
      status: "pending_acceptance",
      priority: "normal",
      slaDeadline: new Date(now.getTime() + 2 * 60 * 60 * 1000),
      estimatedFee: booking.estimatedFee || booking.totalPrice || 0,
      travelFare: booking.travelFare || 0,
      travelTime: booking.travelTime || 0,
      assignedAt: now,
      notes: [{ text: "Assigned from available jobs queue", by: req.user._id, byName: tech.name, createdAt: now }],
    });

    // Update booking
    booking.status = "assigned";
    booking.technicianId = tech._id;
    booking.assignmentId = assignment._id;
    booking.assignedAt = now;
    booking.technician = { name: tech.name, phone: tech.phone, email: tech.email };
    await booking.save();

    // Update technician availability
    tech.availabilityStatus = "Assigned";
    await tech.save();

    const io = req.app.get("io");

    // Notify admins
    if (io) {
      io.to("admin-room").emit("assignment:accepted_from_queue", {
        assignmentId: assignment._id,
        bookingId: booking._id,
        technicianName: tech.name,
        customerName: assignment.customerName,
        serviceName: assignment.serviceName,
        bookingDate: assignment.bookingDate,
      });
    }

    const { createNotification } = require("../utils/notify");
    await createNotification({
      type: "assignment_accepted",
      title: "Job Accepted from Queue",
      message: `${tech.name} accepted the available job for ${assignment.customerName || "a customer"} (${assignment.serviceName || "Service"}).`,
      role: "admin",
      referenceId: assignment._id,
      referenceModel: "Assignment",
      link: "/admin/appointments/active",
      io,
    });

    // Email customer
    try {
      const { sendBookingAcceptedEmail } = require("../utils/mailer");
      if (booking.customer?.email) {
        const dateLabel = booking.bookingDate
          ? new Date(booking.bookingDate).toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
          : "TBD";
        sendBookingAcceptedEmail({
          to: booking.customer.email,
          customerName: booking.customer.name || "Customer",
          bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: booking.service?.name || "Service",
          technicianName: tech.name,
          dateLabel,
          timeLabel: booking.startTime || "TBD",
          locationAddress: booking.location?.address || "",
        }).catch(err => console.error("[MAILER] Failed to send acceptance email:", err.message));
      }
    } catch (mailErr) {
      console.error("[MAILER] Acceptance email error:", mailErr.message);
    }

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "assignment.accept_from_queue",
      module: "technician",
      req,
      details: { assignmentId: assignment._id, bookingId: booking._id },
    }).catch(() => { });

    return res.json({ message: "Job accepted successfully.", assignment });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/assignments/:id/note
 * Body: { text }
 * Add a note to an assignment.
 */
router.post("/assignments/:id/note", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");
    const { id } = req.params;
    const { text } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "Note text is required" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await Assignment.findOne({ _id: id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "Assignment not found" });

    assignment.notes.push({
      text: String(text).trim().slice(0, 1000),
      by: req.user._id,
      byName: tech.name,
      createdAt: new Date(),
    });
    await assignment.save();

    return res.json({ message: "Note added.", assignment });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// EXPENSES — CRUD
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/expenses/by-booking/:bookingId
 * Returns all expenses linked to a specific booking for this technician.
 */
router.get("/expenses/by-booking/:bookingId", async (req, res, next) => {
  try {
    const Expense = require("../models/Expense");
    const { bookingId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ error: "Invalid booking ID" });
    }

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const expenses = await Expense.find({
      technicianId: tech._id,
      bookingId: bookingId,
    })
      .sort({ expenseDate: -1 })
      .lean();

    const totalAmount = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
    const approvedTotal = expenses
      .filter(e => e.status === "approved")
      .reduce((sum, e) => sum + (e.amount || 0), 0);
    const pendingTotal = expenses
      .filter(e => e.status === "pending")
      .reduce((sum, e) => sum + (e.amount || 0), 0);

    return res.json({
      expenses,
      summary: { totalAmount, approvedTotal, pendingTotal, count: expenses.length },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/expenses/available-bookings
 * Returns completed assignments the technician can link expenses to.
 * Only completed bookings — expenses should be tied to finished jobs.
 */
router.get("/expenses/available-bookings", async (req, res, next) => {
  try {
    const Assignment = require("../models/Assignment");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const assignments = await Assignment.find({
      technicianId: tech._id,
      status: "completed",
      bookingDate: { $gte: since },
    })
      .sort({ bookingDate: -1 })
      .limit(50)
      .select("bookingId customerName serviceName bookingDate startTime address status")
      .lean();

    return res.json({ bookings: assignments });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/expenses
 * Query: ?type=fuel|material|...&status=pending|approved|rejected&page=1&limit=20
 */
router.get("/expenses", async (req, res, next) => {
  try {
    const Expense = require("../models/Expense");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { type, status, page = 1, limit = 20, startDate, endDate } = req.query;
    const filter = { technicianId: tech._id };

    if (type) filter.type = type;
    if (status) filter.status = status;
    if (startDate || endDate) {
      filter.expenseDate = {};
      if (startDate) {
        const sd = new Date(startDate);
        sd.setHours(0, 0, 0, 0);
        filter.expenseDate.$gte = sd;
      }
      if (endDate) {
        const ed = new Date(endDate);
        ed.setHours(23, 59, 59, 999);
        filter.expenseDate.$lte = ed;
      }
    }

    const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const lim = Math.min(100, Math.max(1, parseInt(limit)));

    const [items, total] = await Promise.all([
      Expense.find(filter)
        .sort({ expenseDate: -1 })
        .skip(skip)
        .limit(lim)
        .populate("bookingId", "bookingReference customerName service bookingDate startTime")
        .lean(),
      Expense.countDocuments(filter),
    ]);

    const summary = await Expense.getMonthlySummary(
      tech._id,
      new Date().getFullYear(),
      new Date().getMonth()
    );

    return res.json({ items, total, page: parseInt(page), pages: Math.ceil(total / lim), summary });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/expenses
 * Body: { type, amount, description, bookingId?, fuelLiters?, pricePerLiter?, odometerReading?, gasStation?, receiptImage?, expenseDate? }
 */
router.post("/expenses", async (req, res, next) => {
  try {
    const Expense = require("../models/Expense");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { type, amount, description, bookingId, fuelLiters, pricePerLiter, odometerReading, gasStation, receiptImage, expenseDate } = req.body;

    if (!type) return res.status(400).json({ error: "Expense type is required" });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: "Valid amount is required" });
    if (!description || !String(description).trim()) return res.status(400).json({ error: "Description is required" });

    const expenseData = {
      technicianId: tech._id,
      technicianName: tech.name,
      type,
      amount: Number(amount),
      description: String(description).trim().slice(0, 500),
      expenseDate: expenseDate ? new Date(expenseDate) : new Date(),
    };

    if (bookingId && mongoose.Types.ObjectId.isValid(bookingId)) {
      const Assignment = require("../models/Assignment");
      const ownAssignment = await Assignment.findOne({
        bookingId: bookingId,
        technicianId: tech._id,
      }).lean();
      if (!ownAssignment) {
        return res.status(403).json({ error: "This booking is not assigned to you." });
      }
      expenseData.bookingId = bookingId;
    }
    if (fuelLiters) expenseData.fuelLiters = Number(fuelLiters);
    if (pricePerLiter) expenseData.pricePerLiter = Number(pricePerLiter);
    if (odometerReading) expenseData.odometerReading = Number(odometerReading);
    if (gasStation) expenseData.gasStation = String(gasStation).trim();
    if (receiptImage) expenseData.receiptImage = receiptImage;

    const expense = await Expense.create(expenseData);

    // Notify admins of new expense submission
    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    await createNotification({
      type: "expense_submitted",
      title: "Expense Submitted",
      message: `${tech.name} submitted a ${type} expense of ₱${Number(amount).toLocaleString()}.`,
      role: "admin",
      referenceId: expense._id,
      referenceModel: "Expense",
      link: "/admin/appointments/expenses",
      priority: "normal",
      io,
    });

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "expense.create",
      module: "technician",
      req,
      details: { expenseId: expense._id, type, amount },
    }).catch(() => { });

    return res.status(201).json({ message: "Expense recorded.", expense });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/technician/expenses/:id
 * Only allows deleting pending expenses.
 */
router.delete("/expenses/:id", async (req, res, next) => {
  try {
    const Expense = require("../models/Expense");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const expense = await Expense.findOne({ _id: id, technicianId: tech._id });
    if (!expense) return res.status(404).json({ error: "Expense not found" });
    if (expense.status !== "pending") {
      return res.status(400).json({ error: "Only pending expenses can be deleted." });
    }

    await expense.deleteOne();

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "expense.delete",
      module: "technician",
      req,
      details: { expenseId: id },
    }).catch(() => { });

    return res.json({ message: "Expense deleted." });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SERVICE REPORTS — CRUD
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/reports
 * Query: ?status=draft|submitted|approved|revision_requested&page=1&limit=20
 */
router.get("/reports", async (req, res, next) => {
  try {
    const ServiceReport = require("../models/ServiceReport");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { status, page = 1, limit = 20 } = req.query;
    const filter = { technicianId: tech._id };

    if (status) filter.status = status;

    const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const lim = Math.min(100, Math.max(1, parseInt(limit)));

    const [items, total] = await Promise.all([
      ServiceReport.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      ServiceReport.countDocuments(filter),
    ]);

    return res.json({ items, total, page: parseInt(page), pages: Math.ceil(total / lim) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/reports/:id
 * Returns a single service report with full details.
 */
router.get("/reports/:id", async (req, res, next) => {
  try {
    const ServiceReport = require("../models/ServiceReport");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const report = await ServiceReport.findOne({ _id: id, technicianId: tech._id })
      .populate("bookingId")
      .lean();

    if (!report) return res.status(404).json({ error: "Report not found" });

    return res.json({ report });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/technician/reports/:id
 * Body: { findings?, recommendations?, actionsTaken?, partsReplaced?, laborHours?, photos?, followUpRequired?, followUpNotes?, followUpDate? }
 * Updates a draft or revision_requested report.
 */
router.put("/reports/:id", async (req, res, next) => {
  try {
    const ServiceReport = require("../models/ServiceReport");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const report = await ServiceReport.findOne({ _id: id, technicianId: tech._id });
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (!["draft", "revision_requested"].includes(report.status)) {
      return res.status(400).json({ error: "Only draft or revision_requested reports can be edited." });
    }

    const allowedFields = [
      "findings", "recommendations", "actionsTaken", "partsReplaced",
      "laborHours", "photos", "followUpRequired", "followUpNotes",
      "followUpDate", "technicianSignature",
    ];

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        report[field] = req.body[field];
      }
    });

    // Recalculate costs
    if (report.partsReplaced && report.partsReplaced.length > 0) {
      report.partsCost = report.partsReplaced.reduce((sum, p) => sum + (p.cost || 0) * (p.quantity || 1), 0);
    }
    report.totalCost = (report.partsCost || 0) + (report.laborCost || 0);

    await report.save();

    return res.json({ message: "Report updated.", report });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/reports/:id/submit
 * Submits a draft report for admin review.
 */
router.post("/reports/:id/submit", async (req, res, next) => {
  try {
    const ServiceReport = require("../models/ServiceReport");
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const report = await ServiceReport.findOne({ _id: id, technicianId: tech._id });
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (report.status !== "draft" && report.status !== "revision_requested") {
      return res.status(400).json({ error: "Only draft or revision_requested reports can be submitted." });
    }

    report.status = "submitted";
    report.submittedAt = new Date();
    await report.save();

    await audit.logEvent({
      actor: req.user._id,
      target: tech._id,
      action: "report.submit",
      module: "technician",
      req,
      details: { reportId: id, bookingId: report.bookingId },
    }).catch(() => { });

    return res.json({ message: "Report submitted for review.", report });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// TOOL ASSIGNMENTS — Assigned Tools
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/tools/assigned
 * Returns tools currently assigned to the technician.
 */
router.get("/tools/assigned", async (req, res, next) => {
  try {
    const ToolAssignment = require("../models/ToolAssignment");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const items = await ToolAssignment.find({
      technicianId: tech._id,
      status: "assigned",
    })
      .sort({ assignedDate: -1 })
      .lean();

    return res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/tools/assigned/history
 * Returns all tool assignment history (assigned + returned).
 */
router.get("/tools/assigned/history", async (req, res, next) => {
  try {
    const ToolAssignment = require("../models/ToolAssignment");

    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const items = await ToolAssignment.find({ technicianId: tech._id })
      .sort({ assignedDate: -1 })
      .limit(100)
      .lean();

    return res.json({ items, count: items.length });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// LIVE TRACKING — Location Feed
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/tracking/live
 * Returns all active technicians with locations for the live map.
 */
router.get("/tracking/live", async (req, res, next) => {
  try {
    const { resolveAvailabilityBulk } = require("../utils/availability");

    // Fetch all technicians with locations (exclude obviously offline ones at DB level for performance)
    const techs = await Technician.find({
      availabilityStatus: { $nin: ["Offline", "Unavailable"] },
      "location.coordinates": { $exists: true, $ne: null },
    })
      .select("name availabilityStatus location locationText rating")
      .lean();

    // Re-validate with centralized logic to catch stale DB statuses
    const resolvedStatuses = await resolveAvailabilityBulk(techs);

    const validTechs = techs.filter(t => {
      const effectiveStatus = resolvedStatuses.get(String(t._id)) || "Offline";
      return effectiveStatus !== "Offline" && effectiveStatus !== "Unavailable";
    }).map(t => ({
      ...t,
      availabilityStatus: resolvedStatuses.get(String(t._id)) || t.availabilityStatus,
    }));

    return res.json({ technicians: validTechs });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/tracking/history
 * Returns today's location history for the authenticated technician.
 */
router.get("/tracking/history", async (req, res, next) => {
  try {
    const tech = await Technician.findOne({ user: req.user._id }).lean();
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    // For now, return current location — full history would need a LocationHistory model
    return res.json({
      current: {
        lat: tech.location?.coordinates?.[1],
        lng: tech.location?.coordinates?.[0],
        text: tech.locationText,
        status: tech.availabilityStatus,
        updatedAt: tech.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/appointments/:id/update-cost
 * Technician updates the cost of a service after diagnosis.
 * Body: { serviceIndex, newCost, diagnosisNotes }
 */
router.post("/appointments/:id/update-cost", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { serviceIndex, newCost, diagnosisNotes } = req.body;

    if (serviceIndex === undefined || newCost === undefined) {
      return res.status(400).json({ error: "serviceIndex and newCost are required" });
    }
    if (!Number.isFinite(Number(newCost)) || Number(newCost) < 0) {
      return res.status(400).json({ error: "newCost must be a non-negative number" });
    }

    const Technician = require("../models/Technician");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Verify technician owns this booking
    if (String(booking.technicianId) !== String(tech._id)) {
      return res.status(403).json({ error: "This booking is not assigned to you" });
    }

    booking.updateServiceCost(serviceIndex, Number(newCost), tech._id, diagnosisNotes || null);
    await booking.save();

    const { createNotification } = require("../utils/notify");
    await createNotification({
      type: "cost_updated",
      title: "Service cost updated",
      message: `Service "${booking.services?.[serviceIndex]?.name || "Service"}" cost updated to ₱${Number(newCost).toLocaleString()}`,
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: `/admin/appointments/${booking._id}`,
      role: "admin",
      priority: "normal",
      io: req.app?.get("io"),
    });

    return res.json({ success: true, booking });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/technician/tracking/customers
 * Returns all accepted/confirmed/in-progress bookings with customer locations for the live map.
 */
router.get("/tracking/customers", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");

    const bookings = await BookingService.find({
      status: { $in: ["confirmed", "on-the-way", "arrived", "in-progress", "scheduled"] },
      "location.lat": { $exists: true, $ne: null },
      "location.lng": { $exists: true, $ne: null },
    })
      .select("customerName customer serviceId service status bookingDate startTime location bookingReference")
      .populate("serviceId", "name title")
      .sort({ bookingDate: -1 })
      .lean();

    const customers = bookings.map(b => {
      const serviceName = (b.serviceId && (b.serviceId.name || b.serviceId.title)) || (b.service && typeof b.service === "string" && b.service) || "Service";
      return {
        _id: b._id,
        bookingId: String(b._id),
        customerName: b.customerName || (b.customer && b.customer.name) || "Customer",
        serviceName,
        status: b.status,
        address: b.location?.address || "",
        lat: b.location?.lat,
        lng: b.location?.lng,
        bookingDate: b.bookingDate,
        startTime: b.startTime,
        bookingReference: b.bookingReference,
        technicianId: b.technicianId ? String(b.technicianId) : null,
      };
    });

    return res.json({ customers });
  } catch (err) {
    next(err);
  }
});

// ── Proof of Completion Upload + Complete Status ──────────────────────
router.post("/assignments/:id/proof-of-completion", auth.authenticate, async (req, res) => {
  try {
    if (!req.user || req.user.role !== "technician") {
      return res.status(403).json({ error: "Access denied" });
    }

    proofUpload(req, res, async (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE" ? "File too large. Max 5MB." : err.message || "Upload failed";
        return res.status(400).json({ error: msg });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Please select a photo to upload" });
      }

      const { id } = req.params;
      const Assignment = require("../models/Assignment");
      const BookingService = require("../models/BookingService");
      const Technician = require("../models/Technician");
      const User = require("../models/User");

      const assignment = await Assignment.findById(id).lean();
      if (!assignment) return res.status(404).json({ error: "Assignment not found" });

      const tech = await Technician.findOne({ user: req.user._id }).lean();
      if (!tech || String(assignment.technicianId) !== String(tech._id)) {
        return res.status(403).json({ error: "Not your assignment" });
      }

      if (assignment.status !== "in_progress" && assignment.status !== "completed") {
        return res.status(400).json({ error: "Can only submit proof from In Progress or Completed status" });
      }

      const booking = await BookingService.findById(assignment.bookingId);
      if (booking && ["cod", "cash", "cash_onsite", "gcash_downpayment"].includes(booking.paymentMethod) && !booking.balanceCollected && (booking.balanceAmount || 0) > 0) {
        return res.status(400).json({ error: "You must collect the remaining balance before completing this job." });
      }

      const proofUrl = "/uploads/completion-proofs/" + req.file.filename;

      // Update assignment
      const updatedAssignment = await Assignment.findByIdAndUpdate(id, {
        $set: {
          status: "completed",
          completedAt: new Date(),
          "proofPhoto": proofUrl,
        },
        $push: {
          notes: {
            text: `Proof of completion uploaded. Service marked as completed.`,
            by: req.user._id,
            byName: tech.name || req.user.name || "Technician",
            createdAt: new Date(),
          },
        },
      }, { new: true }).lean();

      // Update booking — only for non-repair services (repair status is managed by complete-repair)
      const bookingForCheck = await BookingService.findById(assignment.bookingId);
      const isRepair = bookingForCheck && bookingForCheck.serviceType === "repair";
      if (!isRepair) {
        await BookingService.findByIdAndUpdate(assignment.bookingId, {
          $set: {
            status: "completed",
            completedAt: new Date(),
            proofPhoto: proofUrl,
          },
        });
      } else {
        // For repair services, just attach the proof photo without overwriting status
        await BookingService.findByIdAndUpdate(assignment.bookingId, {
          $set: { proofPhoto: proofUrl },
        });
      }

      // Update technician availability
      const { resolveAvailabilityStatus } = require("../utils/availability");
      await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
      // Availability status synced via syncDb: true above

      // Emit socket event
      const io = req.app.get("io");
      if (io) {
        const booking = await BookingService.findById(assignment.bookingId).lean();
        if (booking) {
          const customerId = booking.customerId?._id || booking.customerId;
          if (customerId) {
            io.to("customer:" + customerId).emit("booking:status-change", {
              bookingId: assignment.bookingId,
              status: "completed",
              technicianName: tech.name,
              proofPhoto: proofUrl,
              timestamp: Date.now(),
            });
          }
        }
      }

      // Send completion email
      try {
        const { sendBookingCompletedEmail } = require("../utils/mailer");
        const booking = await BookingService.findById(assignment.bookingId).populate("customerId", "name email").lean();
        if (booking) {
          const customerEmail = booking.customerId?.email;
          const customerName = booking.customerId?.name || "Customer";
          if (customerEmail) {
            const dateLabel = new Date().toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
            const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
            sendBookingCompletedEmail({
              to: customerEmail,
              customerName,
              bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
              serviceName: booking.serviceName || "Service",
              technicianName: techFullName,
              dateLabel,
            }).catch(err => console.error("[MAILER] Failed to send completion email:", err.message));
          }
        }
      } catch (emailErr) {
        console.error("[MAILER] Completion email error:", emailErr.message);
      }

      return res.json({
        message: "Proof submitted and job completed",
        proofPhoto: proofUrl,
      });
    });
  } catch (err) {
    console.error("Proof of completion error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ENTERPRISE REPAIR WORK ORDER ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════
const { generateAssistantReport, getTroubleshootingGuide, callGeminiAPI, tavilyInspectionSearch, tavilyPartsPricingSearch, tavilyMaintenanceSearch } = require('../utils/aiTechnicianAssistant');

// ── Helper: Record status transition with full audit trail ───────────────────
async function transitionRepairStatus(booking, newStatus, tech, opts = {}) {
  const prevStatus = booking.status;
  booking.status = newStatus;

  if (!booking.statusHistory) booking.statusHistory = [];
  booking.statusHistory.push({
    fromStatus: prevStatus,
    toStatus: newStatus,
    changedBy: tech._id,
    changedByModel: 'Technician',
    changedByName: tech.name || 'Technician',
    reason: opts.reason || '',
    notes: opts.notes || '',
    timestamp: new Date(),
    metadata: opts.metadata || {}
  });

  // SLA tracking: record response time when technician first engages
  if (newStatus === 'inspection_scheduled' && booking.slaTracking && !booking.slaTracking.responseAt) {
    booking.slaTracking.responseAt = new Date();
    if (booking.slaTracking.responseTarget && new Date() > booking.slaTracking.responseTarget) {
      booking.slaTracking.responseBreached = true;
    }
  }

  await booking.save();
  return { prevStatus, newStatus };
}

// POST /appointments/:id/ai-diagnose
// AI Technician Assistant: generates preliminary recommendations for the technician
router.post("/appointments/:id/ai-diagnose", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    // Generate AI technician assistant report
    const assistantResult = await generateAssistantReport({
      unitType: booking.unitInfo?.unitType,
      brand: booking.unitInfo?.brand,
      model: booking.unitInfo?.model,
      problemDescription: booking.unitInfo?.problemDescription || booking.issueDescription,
      photos: booking.unitInfo?.photos || []
    });

    const ta = assistantResult.technicianAssistant || {};

    // Save to booking (including web research metadata)
    booking.technicianAssistant = {
      generatedAt: new Date(),
      source: ta._source || 'fallback',
      webResearchUsed: ta._webResearchUsed || false,
      webSources: ta._webSources || [],
      summary: ta.summary || '',
      probableCauses: ta.probableCauses || [],
      inspectionChecklist: ta.inspectionChecklist || [],
      suggestedTools: ta.suggestedTools || [],
      possibleParts: ta.possibleParts || [],
      repairComplexity: ta.repairComplexity || 'medium',
      estimatedDurationMinutes: ta.estimatedDurationMinutes || 60,
      safetyReminders: ta.safetyReminders || [],
      additionalNotes: ta.additionalNotes || '',
      technicianNotes: '',
      verifiedByTechnician: false,
    };
    booking.preventiveMaintenance = ta.preventiveMaintenance || assistantResult.preventiveMaintenance || [];
    try {
      await booking.save();
    } catch (saveErr) {
      console.error("AI diagnose: booking.save() failed:", saveErr.message, saveErr.stack);
      return res.status(500).json({ error: "Failed to save AI assistant report to booking", detail: saveErr.message });
    }

    // Get troubleshooting guide for quick reference
    const troubleshootingGuide = getTroubleshootingGuide(
      booking.unitInfo?.unitType,
      booking.unitInfo?.problemDescription
    );

    // Notify admin
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `AI Technician Assistant report generated for ${booking.workOrderNumber || booking._id}`,
      });
    }

    return res.json({
      success: true,
      technicianAssistant: booking.technicianAssistant,
      troubleshootingGuide,
      unitInfo: booking.unitInfo
    });
  } catch (err) {
    console.error("AI Technician Assistant error:", err.message, err.stack);
    return res.status(500).json({ error: "Failed to generate technician assistant report", detail: err.message });
  }
});

// POST /appointments/:id/ai-diagnose/verify
// Technician verifies/adjusts AI technician assistant recommendations
router.post("/appointments/:id/ai-diagnose/verify", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { technicianNotes, verified } = req.body;

    if (booking.technicianAssistant) {
      booking.technicianAssistant.technicianNotes = technicianNotes || '';
      booking.technicianAssistant.verifiedByTechnician = verified !== false;
      booking.technicianAssistant.verifiedAt = new Date();
      await booking.save();
    }

    return res.json({ success: true, technicianAssistant: booking.technicianAssistant });
  } catch (err) {
    console.error("Verify technician assistant error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/ai-generate-notes
// AI generates professional repair documentation based on inspection + diagnosis
router.post("/appointments/:id/ai-generate-notes", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const unitType = booking.unitInfo?.unitType || 'unit';
    const brand = booking.unitInfo?.brand || '';
    const model = booking.unitInfo?.model || '';
    const problem = booking.unitInfo?.problemDescription || booking.issueDescription || '';
    const findings = booking.inspection?.findings || '';
    const severity = booking.inspection?.severity || '';
    const diagnosis = booking.diagnosis?.findings || '';
    const parts = (booking.diagnosis?.requiredParts || []).map(p => `${p.name} x${p.quantity || 1}`).join(', ') || '';
    const laborDuration = booking.diagnosis?.laborDuration || '';
    const aiCauses = (booking.technicianAssistant?.probableCauses || []).map(c => c.cause).join('; ') || '';

    const prompt = `You are an expert HVAC/appliance repair documentation assistant. Generate a professional, concise repair report based on the following information. Return ONLY the report text, no JSON or markdown formatting.

UNIT: ${brand} ${model} (${unitType})
CUSTOMER COMPLAINT: ${problem}
AI PRELIMINARY ANALYSIS: ${aiCauses}
INSPECTION FINDINGS: ${findings}
SEVERITY: ${severity}
CONFIRMED DIAGNOSIS: ${diagnosis}
PARTS REPLACED/USED: ${parts || 'None specified yet'}
LABOR DURATION: ${laborDuration || 'Not specified'}

Write a professional repair report (3-5 paragraphs) that:
1. Describes the issue reported by the customer
2. Summarizes the inspection process and findings
3. States the confirmed diagnosis
4. Documents the repair actions taken
5. Notes any recommendations or follow-up needed

Use professional language suitable for customer-facing documentation. Do not include headers or labels.`;

    try {
      const result = await callGeminiAPI(prompt);
      const notes = typeof result === 'string' ? result : (result.text || JSON.stringify(result));
      booking.aiGeneratedNotes = notes;
      await booking.save();
      return res.json({ success: true, notes });
    } catch (geminiErr) {
      // Fallback: generate basic notes from available data
      const fallbackNotes = `REPAIR REPORT — ${brand} ${model} (${unitType})\n\nCustomer reported: ${problem}\n\nInspection: ${findings || 'Inspection completed.'}${severity ? ` Severity classified as ${severity}.` : ''}\n\nDiagnosis: ${diagnosis || 'Pending formal diagnosis.'}\n\n${parts ? `Parts used: ${parts}` : ''}${laborDuration ? ` Estimated repair time: ${laborDuration}.` : ''}\n\nReport generated by AI Technician Assistant (local fallback).`;
      booking.aiGeneratedNotes = fallbackNotes;
      await booking.save();
      return res.json({ success: true, notes: fallbackNotes, source: 'fallback' });
    }
  } catch (err) {
    console.error("AI generate notes error:", err);
    return res.status(500).json({ error: "Failed to generate repair notes" });
  }
});

// POST /appointments/:id/ai-update-on-inspection
// AI updates recommendations based on real-time inspection data entered by technician
router.post("/appointments/:id/ai-update-on-inspection", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const { inspectionData } = req.body;
    // inspectionData: { refrigerantPressure, capacitor, compressor, airflow, temperature, etc. }

    const existing = booking.technicianAssistant || {};
    const existingCauses = (existing.probableCauses || []).map(c => `${c.cause} (${c.likelihood})`).join('\n');

    // Augment with Tavily specification data
    let webContext = '';
    try {
      const webResearch = await tavilyInspectionSearch(booking.unitInfo || {}, inspectionData || {});
      if (webResearch.searchUsed) {
        webContext = webResearch.webContext;
        console.log(`[Tavily] Inspection research complete for booking ${booking._id}`);
      }
    } catch (err) {
      console.warn('[Tavily] Inspection search failed:', err.message);
    }

    const prompt = `You are an AI Technician Assistant helping a field technician during an on-site inspection. The technician has entered the following readings/observations:

${Object.entries(inspectionData || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

INITIAL ANALYSIS (before inspection):
${existingCauses || 'No initial analysis available'}

UNIT: ${booking.unitInfo?.brand || ''} ${booking.unitInfo?.unitType || ''} — ${booking.unitInfo?.problemDescription || ''}
${webContext}

Based on these inspection readings and web research data (if available), provide:
1. UPDATED likely cause (narrow down from the initial analysis)
2. RECOMMENDED NEXT STEPS for the technician
3. Any SAFETY CONCERNS based on the readings
4. Reference any specification data found in web research to validate readings

Return JSON:
{
  "updatedCause": "Most likely cause based on readings",
  "confidence": "high|medium|low",
  "nextSteps": ["step1", "step2"],
  "safetyConcerns": ["concern1"],
  "notes": "Brief explanation of reasoning"
}`;

    try {
      const result = await callGeminiAPI(prompt);
      return res.json({ success: true, update: result, webResearchUsed: webContext.length > 0 });
    } catch (geminiErr) {
      return res.json({
        success: true,
        update: {
          updatedCause: 'Requires further analysis based on readings',
          confidence: 'medium',
          nextSteps: ['Review all inspection data', 'Cross-reference with initial probable causes'],
          safetyConcerns: [],
          notes: 'AI update unavailable (local mode). Use professional judgment.'
        },
        source: 'fallback'
      });
    }
  } catch (err) {
    console.error("AI inspection update error:", err);
    return res.status(500).json({ error: "Failed to update AI analysis" });
  }
});

// POST /appointments/:id/ai-generate-quotation
// AI assists technician in building a quotation based on diagnosis
// Enhanced with Tavily for real-time parts pricing
router.post("/appointments/:id/ai-generate-quotation", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const diagnosis = booking.diagnosis?.findings || '';
    const parts = booking.diagnosis?.requiredParts || [];
    const laborDuration = booking.diagnosis?.laborDuration || '';
    const inspectionCost = booking.inspection?.estimatedRepairCost || 0;
    const aiParts = (booking.technicianAssistant?.possibleParts || []).map(p => ({
      name: typeof p === 'string' ? p : p.name,
      estimatedCost: typeof p === 'object' ? (p.estimatedCostPHP || 0) : 0
    }));
    const brand = booking.unitInfo?.brand || '';

    // Augment with Tavily real-time pricing
    let pricingContext = '';
    let webResearchUsed = false;
    try {
      const partNames = [...parts.map(p => p.name), ...aiParts.map(p => p.name)].filter(Boolean);
      if (partNames.length > 0) {
        const pricingResult = await tavilyPartsPricingSearch(partNames, brand);
        if (pricingResult.searchUsed) {
          pricingContext = pricingResult.pricingData;
          webResearchUsed = true;
          console.log(`[Tavily] Parts pricing research complete for ${partNames.length} parts`);
        }
      }
    } catch (err) {
      console.warn('[Tavily] Parts pricing search failed:', err.message);
    }

    const prompt = `You are an AI quotation assistant for an HVAC/appliance repair company in the Philippines.

CONFIRMED DIAGNOSIS: ${diagnosis}
TECHNICIAN-SPECIFIED PARTS: ${parts.map(p => `${p.name} (qty: ${p.quantity || 1}, est. cost: ₱${p.cost || 0})`).join(', ') || 'None specified yet'}
AI-SUGGESTED PARTS: ${aiParts.map(p => `${p.name} (est. ₱${p.estimatedCost})`).join(', ') || 'None'}
LABOR DURATION: ${laborDuration || 'Not specified'}
INSPECTION ESTIMATE: ₱${inspectionCost}
${pricingContext}

Generate a fair quotation recommendation in JSON:
{
  "parts": [
    { "name": "Part Name", "quantity": 1, "costPHP": 500, "reason": "Why this part" }
  ],
  "laborCostPHP": 500,
  "laborHours": 1,
  "totalEstimatePHP": 1000,
  "notes": "Brief justification for pricing"
}

RULES:
- All prices in Philippine Pesos
- Use realistic local market prices — if web research data is available, use those prices as reference
- Labor rate: ~₱300-500/hour for standard repair, ~₱500-800/hour for complex
- Include only parts actually needed for the confirmed diagnosis
- Do NOT include unnecessary parts`;

    try {
      const result = await callGeminiAPI(prompt);
      const quotation = result.quotation || result;
      return res.json({ success: true, quotation, webResearchUsed });
    } catch (geminiErr) {
      // Fallback: build from technician-specified parts
      const partsTotal = parts.reduce((sum, p) => sum + ((p.cost || 0) * (p.quantity || 1)), 0);
      const laborCost = 500;
      return res.json({
        success: true,
        quotation: {
          parts: parts.map(p => ({ name: p.name, quantity: p.quantity || 1, costPHP: p.cost || 0, reason: 'Technician-specified' })),
          laborCostPHP: laborCost,
          laborHours: 1,
          totalEstimatePHP: partsTotal + laborCost,
          notes: 'Fallback estimate. Technician should adjust prices based on actual costs.'
        },
        source: 'fallback',
        webResearchUsed: false
      });
    }
  } catch (err) {
    console.error("AI quotation error:", err);
    return res.status(500).json({ error: "Failed to generate quotation" });
  }
});

// POST /appointments/:id/ai-maintenance-tips
// AI generates preventive maintenance recommendations after repair
// Enhanced with Tavily for latest maintenance best practices
router.post("/appointments/:id/ai-maintenance-tips", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const unitType = booking.unitInfo?.unitType || 'unit';
    const brand = booking.unitInfo?.brand || '';
    const problem = booking.unitInfo?.problemDescription || '';
    const diagnosis = booking.diagnosis?.findings || booking.inspection?.findings || '';
    const prevRepairs = booking.previousRepairs || [];

    // Augment with Tavily maintenance best practices
    let webContext = '';
    let webResearchUsed = false;
    try {
      const maintenanceResearch = await tavilyMaintenanceSearch({ unitType, brand, problem });
      if (maintenanceResearch.searchUsed) {
        webContext = maintenanceResearch.webContext;
        webResearchUsed = true;
        console.log(`[Tavily] Maintenance research complete for ${brand} ${unitType}`);
      }
    } catch (err) {
      console.warn('[Tavily] Maintenance search failed:', err.message);
    }

    const prompt = `You are an HVAC/appliance maintenance expert. Based on the repair just completed, generate preventive maintenance recommendations.

UNIT: ${brand} ${unitType}
ORIGINAL ISSUE: ${problem}
CONFIRMED DIAGNOSIS: ${diagnosis}
${prevRepairs.length ? `PREVIOUS REPAIRS: ${prevRepairs.map(r => `${r.issue || r.description}`).join('; ')}` : ''}
${webContext}

Generate 4-6 specific preventive maintenance tips as a JSON array of strings:
{
  "tips": [
    "Specific maintenance action with frequency (e.g., Clean condenser coil every 6 months)",
    "..."
  ]
}

Tips should be:
- Specific to this unit type and the issue that was repaired
- Include frequency/recommended intervals
- Practical for the customer to follow
- Written in clear, simple language
- If web research data is available, incorporate manufacturer-recommended schedules and latest best practices`;

    try {
      const result = await callGeminiAPI(prompt);
      const tips = result.tips || result.maintenanceTips || result;
      booking.preventiveMaintenance = Array.isArray(tips) ? tips : (tips.tips || []);
      await booking.save();
      return res.json({ success: true, tips: booking.preventiveMaintenance, webResearchUsed });
    } catch (geminiErr) {
      const fallbackTips = [
        `Schedule preventive maintenance for ${brand} ${unitType} every 6 months`,
        'Keep the unit clean and free from dust buildup',
        'Check and clean air filters monthly',
        'Monitor performance and report unusual sounds or behavior early',
        'Schedule professional inspection annually'
      ];
      booking.preventiveMaintenance = fallbackTips;
      await booking.save();
      return res.json({ success: true, tips: fallbackTips, source: 'fallback', webResearchUsed: false });
    }
  } catch (err) {
    console.error("AI maintenance tips error:", err);
    return res.status(500).json({ error: "Failed to generate maintenance tips" });
  }
});

// POST /appointments/:id/ai-check-history
// AI checks previous repair history for recurring issues
router.post("/appointments/:id/ai-check-history", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Find previous repairs for the same customer + unit type
    const previousBookings = await BookingService.find({
      _id: { $ne: booking._id },
      $or: [
        { customerId: booking.customerId },
        { 'customer.email': booking.customer?.email }
      ],
      'unitInfo.unitType': booking.unitInfo?.unitType || '',
      status: { $in: ['repair_completed', 'closed'] }
    }).sort({ createdAt: -1 }).limit(5).lean();

    const history = previousBookings.map(pb => ({
      date: pb.createdAt ? new Date(pb.createdAt).toLocaleDateString('en-PH') : '',
      issue: pb.unitInfo?.problemDescription || pb.issueDescription || '',
      diagnosis: pb.diagnosis?.findings || '',
      cost: pb.quotation?.totalCost || 0,
      technician: pb.technicianId?.name || ''
    }));

    // Store on current booking
    booking.previousRepairs = history.map(h => ({
      date: h.date,
      issue: h.issue,
      description: h.diagnosis,
      technician: h.technician,
      cost: h.cost,
      recurring: false
    }));

    // Check if current issue is similar to any previous
    if (history.length > 0) {
      const currentProblem = (booking.unitInfo?.problemDescription || '').toLowerCase();
      for (const h of history) {
        if (h.issue && currentProblem) {
          const prevWords = h.issue.toLowerCase().split(/\s+/);
          const matchCount = prevWords.filter(w => currentProblem.includes(w) && w.length > 3).length;
          if (matchCount >= 2) {
            const idx = booking.previousRepairs.findIndex(pr => pr.date === h.date);
            if (idx >= 0) booking.previousRepairs[idx].recurring = true;
          }
        }
      }
    }

    await booking.save();
    return res.json({
      success: true,
      history,
      recurringDetected: booking.previousRepairs.some(pr => pr.recurring),
      message: history.length === 0
        ? 'No previous repair history found for this customer/unit.'
        : `Found ${history.length} previous repair(s).${booking.previousRepairs.some(pr => pr.recurring) ? ' RECURRING ISSUE DETECTED.' : ''}`
    });
  } catch (err) {
    console.error("AI check history error:", err);
    return res.status(500).json({ error: "Failed to check repair history" });
  }
});

// POST /appointments/:id/upload-photos
// Upload repair photos (before/during)
const repairPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, "../public/uploads/repair-photos");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, "repair-" + Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype));
  }
}).array("photos", 10);

router.post("/appointments/upload-repair-photos", (req, res, next) => {
  repairPhotoUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: "Photo upload failed: " + err.message });
    const urls = req.files.map(f => "/uploads/repair-photos/" + f.filename);
    return res.json({ urls });
  });
});

// POST /appointments/:id/complete-inspection
// Technician submits combined inspection + quotation → booking status: awaiting_approval (admin must approve before technician can proceed)
// Enterprise: auto-generates findings, actions, and quote from confirmed diagnosis
router.post("/appointments/:id/complete-inspection", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { diagnosis, confirmedDiagnoses, parts, laborCost, laborCategory,
      quotationNotes, photos, estimatedDurationMinutes, complexity, hasUnavailableParts, recommendedAction } = req.body;

    if (!diagnosis || !diagnosis.trim()) {
      return res.status(400).json({ error: "Diagnosis is required" });
    }

    const allowedFrom = ["inspection_scheduled", "confirmed", "on-the-way", "arrived", "inspection_completed"];
    if (!allowedFrom.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot complete inspection from status: ${booking.status}` });
    }

    // ── Auto-generate findings from confirmed diagnoses ────────────────
    const diagnosesList = confirmedDiagnoses || [diagnosis];
    const findingsText = _autoGenerateFindings(diagnosesList);
    const actionsText = _autoGenerateActions(diagnosesList, parts || []);

    // ── Save inspection data ──
    booking.inspection = {
      ...booking.inspection,
      completedAt: new Date(),
      technicianId: tech._id,
      findings: findingsText,
      severity: "",
      damagedParts: [],
      recommendedAction: recommendedAction || actionsText,
      photos: photos || [],
      estimatedRepairCost: 0,
      findingsChecklist: [],
      actionsChecklist: [],
    };

    // ── Save diagnosis data ──
    booking.diagnosis = {
      ...booking.diagnosis,
      findings: findingsText,
      diagnosisSummary: diagnosis.trim(),
      confirmedDiagnoses: diagnosesList,
      requiredParts: (parts || []).map(p => ({
        name: p.name || "",
        quantity: parseInt(p.quantity) || 1,
        cost: parseFloat(p.cost) || 0,
        toolId: p.toolId || null,
      })),
      laborDuration: estimatedDurationMinutes ? String(estimatedDurationMinutes) + ' min' : (booking.diagnosis?.laborDuration || ''),
      laborCost: parseFloat(laborCost) || 0,
      laborCategory: laborCategory || 'standard',
      completedAt: new Date(),
      technicianId: tech._id,
    };

    // ── Save quotation data (auto-computed) ──
    let quotationTotal = 0;
    if (parts && Array.isArray(parts) && parts.length > 0) {
      const partsTotal = parts.reduce((sum, p) => sum + ((p.cost || 0) * (p.quantity || 1)), 0);
      const labor = parseFloat(laborCost) || 0;
      quotationTotal = partsTotal + labor;

      booking.quotation = {
        parts: parts.map(p => ({
          name: p.name || "",
          cost: parseFloat(p.cost) || 0,
          quantity: parseInt(p.quantity) || 1,
          toolId: p.toolId || null,
        })),
        laborCost: labor,
        laborCategory: laborCategory || 'standard',
        totalCost: quotationTotal,
        notes: quotationNotes || "",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      };

      if (!hasUnavailableParts) {
        booking.approval = {
          status: "pending",
          decidedAt: undefined,
          reason: undefined,
        };
      }
    }

    // Set balance amount for COD/cash bookings
    if (["cod", "cash", "cash_onsite", "gcash_downpayment"].includes(booking.paymentMethod) && quotationTotal > 0) {
      booking.balanceAmount = Math.max(0, quotationTotal - (booking.downpaymentAmount || 0));
      booking.balanceCollected = false;
    }

    // Store estimated duration and complexity
    if (estimatedDurationMinutes) {
      booking.technicianAssistant = booking.technicianAssistant || {};
      booking.technicianAssistant.estimatedDurationMinutes = parseInt(estimatedDurationMinutes) || 90;
    }
    if (complexity) {
      booking.repairComplexity = complexity;
    }

    // Mark AI as verified
    if (booking.technicianAssistant) {
      booking.technicianAssistant.verifiedByTechnician = true;
      booking.technicianAssistant.verifiedAt = new Date();
    }

    // Status transition — inspection completed
    await transitionRepairStatus(booking, 'inspection_completed', tech, {
      reason: 'Inspection completed',
      notes: findingsText,
      metadata: {
        diagnosis: diagnosis.trim(),
        hasQuotation: quotationTotal > 0,
        hasPhotos: (photos || []).length > 0,
        technicianAssistantVerified: !!booking.technicianAssistant?.verifiedByTechnician,
      }
    });

    // Notify admin
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        priority: booking.priority,
        message: `Inspection & quotation submitted for ${booking.workOrderNumber || booking._id}`,
        quotationTotal
      });
    }

    // ── Emails ──
    try {
      const { sendInspectionCompletedEmail, sendQuotationReadyEmail } = require("../utils/mailer");
      const customerEmail = booking.customer?.email || booking.customerId?.email;
      if (customerEmail) {
        await sendInspectionCompletedEmail({
          to: customerEmail,
          customerName: booking.customer?.name || booking.customerId?.name || 'Customer',
          bookingReference: booking.workOrderNumber || booking._id?.toString().slice(-6).toUpperCase(),
          serviceName: booking.service?.name || booking.serviceName || 'Repair Service',
          findings: findingsText,
          severity: '',
        });
        await sendQuotationReadyEmail({
          to: customerEmail,
          customerName: booking.customer?.name || booking.customerId?.name || 'Customer',
          bookingReference: booking.workOrderNumber || booking._id?.toString().slice(-6).toUpperCase(),
          serviceName: booking.service?.name || booking.serviceName || 'Repair Service',
          parts: booking.quotation?.parts || [],
          laborCost: parseFloat(laborCost) || 0,
          totalCost: quotationTotal,
          quotationNotes: quotationNotes || '',
        });
      }
    } catch (e) { console.error("[MAILER] Failed to send inspection completed email:", e.message); }

    return res.json({
      success: true,
      status: booking.status,
      inspection: booking.inspection,
      quotation: booking.quotation,
      quotationTotal,
      technicianAssistant: booking.technicianAssistant,
      slaTracking: booking.slaTracking
    });
  } catch (err) {
    console.error("Complete inspection error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── Helpers: auto-generate findings and actions from confirmed diagnoses ──
function _autoGenerateFindings(diagnoses) {
  const findingsMap = {
    'capacitor': ['Capacitor shows signs of swelling', 'Capacitor not holding charge', 'Visible capacitor damage'],
    'compressor': ['Compressor not cycling properly', 'Compressor drawing excessive amps', 'Compressor making unusual noise'],
    'refrigerant': ['Low refrigerant pressure', 'Refrigerant leak detected', 'Oil residue at connection points', 'Evaporator coil shows frost pattern'],
    'fan': ['Fan motor not spinning freely', 'Fan blade damage visible', 'Fan motor bearing noise'],
    'coil': ['Evaporator coil shows damage', 'Condenser coil dirty/blocked', 'Coil fins bent or corroded'],
    'wiring': ['Wiring connections loose', 'Visible wire damage', 'Burn marks on connectors'],
    'thermostat': ['Thermostat not reading correctly', 'Temperature differential abnormal'],
    'drain': ['Condensate drain clogged', 'Drain pan overflow', 'Water leakage detected'],
    'airflow': ['Restricted airflow detected', 'Filter heavily soiled', 'Blower wheel dirty']
  };

  const matched = [];
  const allText = diagnoses.join(' ').toLowerCase();
  for (const [keyword, list] of Object.entries(findingsMap)) {
    if (allText.includes(keyword)) {
      matched.push(...list);
    }
  }

  if (matched.length === 0) {
    return 'Unit not operating normally. Physical inspection completed. Visual signs of wear/damage noted.';
  }

  return [...new Set(matched)].join('. ') + '.';
}

function _autoGenerateActions(diagnoses, parts) {
  const actionMap = {
    'capacitor': ['Replace capacitor', 'Test capacitor rating', 'Verify system startup'],
    'compressor': ['Replace compressor', 'Check compressor mounts', 'Test compressor windings', 'Verify system operation'],
    'refrigerant': ['Recharge refrigerant', 'Repair refrigerant leak', 'Replace Schrader valve', 'Braze leak point', 'Pressure test system'],
    'fan': ['Replace fan motor', 'Lubricate fan bearings', 'Replace fan blade'],
    'coil': ['Clean condenser coil', 'Replace evaporator coil', 'Chemical coil cleaning'],
    'wiring': ['Repair wiring connections', 'Replace damaged wires', 'Secure all connections'],
    'thermostat': ['Replace thermostat', 'Recalibrate thermostat', 'Check thermostat wiring'],
    'drain': ['Clear condensate drain', 'Replace drain line', 'Clean drain pan'],
    'airflow': ['Replace air filter', 'Clean blower wheel', 'Seal ductwork']
  };

  const actions = [];
  const allText = diagnoses.join(' ').toLowerCase();
  for (const [keyword, list] of Object.entries(actionMap)) {
    if (allText.includes(keyword)) {
      actions.push(...list);
    }
  }

  (parts || []).forEach(p => {
    if (p.name) actions.push(`Install ${p.name}`);
  });

  if (actions.length === 0) {
    return 'Perform diagnostic tests. Verify system operation after repair. Clean and inspect unit.';
  }

  return [...new Set(actions)].join('. ') + '.';
}

// POST /appointments/:id/collect-inspection-payment
// Technician collects inspection/diagnosis fee from customer
router.post("/appointments/:id/collect-inspection-payment", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Payment = require("../models/Payment");
    const { id } = req.params;
    const { amount, distanceFare, method, notes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid id" });

    const tech = await Technician.findOne({ user: req.user._id }).populate("user", "firstName lastName name email");
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Please enter a valid payment amount." });
    }

    const now = new Date();
    const techName = (tech.user && (tech.user.name || [tech.user.firstName, tech.user.lastName].filter(Boolean).join(' '))) || tech.name || 'Technician';
    const totalCollected = (amount || 0) + (distanceFare || 0);

    // Map frontend method values to valid Payment model enum values
    const methodMap = { cash: 'cod', cod: 'cod', gcash: 'gcash', maya: 'other', bank_transfer: 'bank' };
    const paymentMethod = methodMap[method] || 'cod';

    // Update booking payment records
    booking.amountPaid = (booking.amountPaid || 0) + totalCollected;
    booking.inspectionFeeCollected = true;
    booking.inspectionFeeAmount = amount || 0;
    booking.inspectionFeeDistanceFare = distanceFare || 0;
    booking.inspectionFeeTotalCollected = totalCollected;
    booking.inspectionFeeMethod = method || 'cash';
    booking.inspectionFeeCollectedAt = now;
    if (notes) {
      booking.notes = (booking.notes ? booking.notes + "\n" : "") + `[Inspection Fee] ₱${(amount || 0).toLocaleString()}${(distanceFare || 0) > 0 ? ' + ₱' + distanceFare.toLocaleString() + ' fare' : ''} via ${method || 'cash'} — ${notes || ''}`;
    }
    await booking.save();

    // Create a Payment record
    await Payment.create({
      bookingId: booking._id,
      amount: totalCollected,
      method: paymentMethod,
      type: "inspection",
      gateway: paymentMethod,
      status: "paid",
      reference: notes || `Inspection fee collected by ${techName}`,
      verifiedAt: now,
      completedAt: now,
      notes: `Inspection fee: ₱${(amount || 0).toLocaleString()}${(distanceFare || 0) > 0 ? ' + fare: ₱' + distanceFare.toLocaleString() : ''}. Collected by ${techName}`,
    });

    // Notify admins
    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    await createNotification({
      type: "payment_collected",
      title: "Inspection Fee Collected",
      message: `${techName} collected ₱${totalCollected.toLocaleString()} inspection fee${(distanceFare || 0) > 0 ? ' (incl. ₱' + distanceFare.toLocaleString() + ' fare)' : ''} for ${booking.bookingReference || booking.workOrderNumber || id}.`,
      role: "admin",
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: "/admin/appointments/completed",
      priority: "normal",
      io,
    });

    console.log(`💰 Inspection payment collected for ${booking.bookingReference || id}: ₱${totalCollected} via ${method || 'cash'}`);
    return res.json({
      success: true,
      message: `₱${totalCollected.toLocaleString()} inspection fee collected.`,
      booking: {
        amountPaid: booking.amountPaid,
        inspectionFeeCollected: booking.inspectionFeeCollected,
        inspectionFeeAmount: booking.inspectionFeeAmount,
        inspectionFeeDistanceFare: booking.inspectionFeeDistanceFare,
        inspectionFeeTotalCollected: booking.inspectionFeeTotalCollected,
      },
    });
  } catch (err) {
    console.error("Collect inspection payment error:", err);
    return res.status(500).json({ error: err.message || "Server error collecting payment" });
  }
});

// POST /appointments/:id/submit-diagnosis
// Technician submits formal diagnosis → booking status: awaiting_approval (ready for quotation)
router.post("/appointments/:id/submit-diagnosis", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { findings, requiredParts, laborDuration, laborCost } = req.body;
    if (!findings || !findings.trim()) {
      return res.status(400).json({ error: "Diagnosis findings are required" });
    }

    const allowedFrom = ["inspection_completed"];
    if (!allowedFrom.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot submit diagnosis from status: ${booking.status}` });
    }

    // Store diagnosis on the booking
    booking.diagnosis = {
      findings: findings.trim(),
      requiredParts: (requiredParts || []).map(p => ({
        name: p.name || "",
        quantity: parseInt(p.quantity) || 1,
        cost: parseFloat(p.cost) || 0
      })),
      laborDuration: laborDuration || "",
      laborCost: parseFloat(laborCost) || 0,
      completedAt: new Date(),
      technicianId: tech._id,
    };

    if (booking.technicianAssistant) {
      booking.technicianAssistant.verifiedByTechnician = true;
      booking.technicianAssistant.verifiedAt = new Date();
    }

    // Record diagnosis status in history (status stays inspection_completed until quotation)
    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      fromStatus: 'inspection_completed',
      toStatus: 'inspection_completed',
      changedBy: tech._id,
      changedByModel: 'Technician',
      changedByName: tech.name || 'Technician',
      reason: 'Diagnosis submitted',
      notes: findings.trim(),
      timestamp: new Date(),
      metadata: {
        type: 'diagnosis',
        requiredPartsCount: (requiredParts || []).length,
        laborCost: parseFloat(laborCost) || 0,
        laborDuration
      }
    });
    await booking.save();

    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Diagnosis completed for ${booking.workOrderNumber || booking._id}`,
      });
    }

    return res.json({
      success: true,
      status: booking.status,
      diagnosis: booking.diagnosis,
      customerName: booking.customer?.name || 'Customer',
      serviceName: booking.serviceName || 'Repair'
    });
  } catch (err) {
    console.error("Submit diagnosis error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/submit-quotation
// Technician submits repair quotation → booking status: awaiting_approval
router.post("/appointments/:id/submit-quotation", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { parts, laborCost, notes, repairActionSummary } = req.body;
    if (!parts || !Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ error: "At least one parts entry is required" });
    }

    // Validate each part has required fields
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i].name || parts[i].name.trim().length === 0) {
        return res.status(400).json({ error: `Part ${i + 1}: name is required` });
      }
      if (parts[i].cost === undefined || parts[i].cost < 0) {
        return res.status(400).json({ error: `Part ${i + 1}: valid cost is required` });
      }
    }

    const allowedFrom = ["inspection_completed", "awaiting_approval"];
    if (!allowedFrom.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot submit quotation from status: ${booking.status}` });
    }

    const partsTotal = parts.reduce((sum, p) => sum + ((p.cost || 0) * (p.quantity || 1)), 0);
    const labor = parseFloat(laborCost) || 0;
    const total = partsTotal + labor;

    // Calculate cost deviation from inspection estimate
    const estimatedCost = booking.inspection?.estimatedRepairCost || 0;
    const costDeviation = estimatedCost > 0 ? {
      estimated: estimatedCost,
      actual: total,
      difference: total - estimatedCost,
      percentage: Math.round(((total - estimatedCost) / estimatedCost) * 100),
      message: total > estimatedCost
        ? `Quotation is ${Math.round(((total - estimatedCost) / estimatedCost) * 100)}% higher than initial estimate`
        : total < estimatedCost
          ? `Quotation is ${Math.round(((estimatedCost - total) / estimatedCost) * 100)}% lower than initial estimate`
          : 'Quotation matches initial estimate'
    } : null;

    // Validate quotation total is reasonable
    if (total <= 0) {
      return res.status(400).json({ error: "Quotation total must be greater than zero" });
    }

    booking.quotation = {
      parts: parts.map(p => ({
        name: p.name || "",
        cost: parseFloat(p.cost) || 0,
        quantity: parseInt(p.quantity) || 1,
        toolId: p.toolId || null,
      })),
      laborCost: labor,
      totalCost: total,
      notes: notes || "",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    };

    booking.approval = {
      status: "pending",
      decidedAt: undefined,
      reason: undefined,
    };

    // Enterprise: Use safe status transition with audit trail
    await transitionRepairStatus(booking, 'awaiting_approval', tech, {
      reason: 'Quotation submitted for customer approval',
      notes: `Parts: ${parts.length}, Labor: ₱${labor}, Total: ₱${total}`,
      metadata: {
        partsCount: parts.length,
        laborCost: labor,
        totalCost: total,
        costDeviation,
        repairActionSummary: repairActionSummary || ''
      }
    });

    // Notify admin
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        priority: booking.priority,
        message: `Quotation submitted for ${booking.workOrderNumber || booking._id}: ₱${total.toLocaleString()}`,
        costDeviation
      });
    }

    // Notify customer
    try {
      const { sendQuotationReadyEmail } = require("../utils/mailer");
      const customerEmail = booking.customer?.email || booking.customerId?.email;
      if (customerEmail) {
        await sendQuotationReadyEmail({
          to: customerEmail,
          customerName: booking.customer?.name || booking.customerId?.name || 'Customer',
          bookingReference: booking.workOrderNumber || booking._id?.toString().slice(-6).toUpperCase(),
          serviceName: booking.service?.name || booking.serviceName || 'Repair Service',
          parts: booking.quotation?.parts || [],
          laborCost: labor,
          totalCost: total,
          quotationNotes: quotationNotes || '',
          deviationNote: costDeviation ? costDeviation.message : '',
        });
      }
    } catch (e) { console.error("[MAILER] Failed to send quotation email:", e.message); }

    return res.json({
      success: true,
      status: booking.status,
      quotation: booking.quotation,
      costDeviation
    });
  } catch (err) {
    console.error("Submit quotation error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/onsite-approve
// Technician chose "Repair Now" → start repair immediately from inspection_completed
router.post("/appointments/:id/onsite-approve", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }
    if (!["inspection_completed"].includes(booking.status)) {
      return res.status(400).json({ error: `Cannot start repair from status: ${booking.status}. Expected inspection_completed.` });
    }

    // Record approval
    booking.approval = {
      status: "approved",
      decidedAt: new Date(),
      reason: "Approved on-site by technician",
    };

    // Reserve stock for quotation parts
    let hasInsufficientStock = false;
    let insufficientItems = [];
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
          hasInsufficientStock = true;
          insufficientItems = insufficientStock;
        }
      }
    } catch (e) { console.error('[STOCK] Reservation error:', e.message); }

    if (hasInsufficientStock) {
      const prevStatus = booking.status;
      booking.status = "waiting_parts";
      if (!booking.statusHistory) booking.statusHistory = [];
      booking.statusHistory.push({
        fromStatus: prevStatus,
        toStatus: "waiting_parts",
        changedBy: tech._id,
        changedByModel: 'Technician',
        changedByName: tech.name || 'Technician',
        reason: `Parts out of stock: ${insufficientItems.map(i => i.itemName).join(', ')}`,
        notes: '',
        timestamp: new Date(),
        metadata: { approvalMethod: 'technician_decision' }
      });
      await booking.save();

      // Notify admin about waiting_parts
      if (global.io) {
        global.io.to("admin").emit("booking:updated", {
          bookingId: booking._id, status: booking.status,
          message: `On-site approval: Repair started but waiting for parts – ${insufficientItems.map(i => i.itemName).join(', ')}`,
        });
      }

      return res.json({
        success: true,
        status: booking.status,
        waitingParts: true,
        insufficientItems: insufficientItems.map(i => i.itemName),
        message: `Some parts are out of stock: ${insufficientItems.map(i => i.itemName).join(', ')}. Admin has been notified.`
      });
    }

    await transitionRepairStatus(booking, 'repair_in_progress', tech, {
      reason: 'Repair started immediately after inspection',
      metadata: { approvalMethod: 'technician_decision', quotationTotal: booking.quotation?.totalCost || 0 }
    });

    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id, status: booking.status,
        message: `On-site approval: Repair started for ${booking.workOrderNumber || booking._id}`,
      });
      global.io.to(`customer:${booking.customerId}`).emit("booking:updated", {
        bookingId: booking._id, status: booking.status,
        message: `Your repair has begun! ${booking.workOrderNumber || ""}`,
      });
    }

    return res.json({ success: true, status: booking.status, warranty: booking.warranty });
  } catch (err) {
    console.error("On-site approve error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/notify-quotation
// Send email to customer with quotation for later scheduling (on-site declined)
router.post("/appointments/:id/notify-quotation", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    try {
      const { sendQuotationReadyEmail } = require("../utils/mailer");
      const customerEmail = booking.customer?.email || booking.customerId?.email;
      if (customerEmail && booking.quotation) {
        await sendQuotationReadyEmail({
          to: customerEmail,
          customerName: booking.customer?.name || booking.customerId?.name || 'Customer',
          bookingReference: booking.workOrderNumber || booking._id?.toString().slice(-6).toUpperCase(),
          serviceName: booking.service?.name || booking.serviceName || 'Repair Service',
          parts: booking.quotation.parts || [],
          laborCost: booking.quotation.laborCost || 0,
          totalCost: booking.quotation.totalCost || 0,
          quotationNotes: booking.quotation.notes || '',
        });
      }
    } catch (e) { console.error("[MAILER] Failed to send quotation email:", e.message); }
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/technician-schedule-later
// Technician chose "Schedule Later" after inspection → auto-approves quotation, sends scheduling email
router.post("/appointments/:id/technician-schedule-later", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    // No dates needed — admin will schedule
    // Auto-approve the quotation (customer approved on-site)
    if (!booking.approval) booking.approval = {};
    booking.approval.status = "approved";
    booking.approval.decidedAt = new Date();
    booking.approval.reason = "Approved on-site by customer (Schedule Later)";

    // Set repair schedule preference
    booking.repairSchedule = {
      preference: "later",
      decidedAt: new Date(),
    };

    // Transition status to repair_approved (admin will handle scheduling), unless waiting for parts
    const prevStatus = booking.status;
    if (prevStatus !== "waiting_parts") {
      booking.status = "repair_approved";
    }
    booking.recordStatusHistory({
      fromStatus: prevStatus,
      toStatus: booking.status,
      reason: "Customer approved on-site, queued for admin scheduling",
      changedBy: req.user._id,
      changedByModel: "Technician",
      changedByName: tech.name || "Technician",
    });

    await booking.save();

    // Notify admin via socket
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Customer approved quotation for ${booking.workOrderNumber || booking._id} – chose to schedule later.`,
      });
    }

    return res.json({ success: true, status: booking.status, message: "Quotation approved. Awaiting admin scheduling." });
  } catch (err) {
    console.error("Technician schedule later error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/request-parts
// Technician reports missing parts → status: waiting_parts, creates parts request, notifies admin + customer
router.post("/appointments/:id/request-parts", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id)
      .populate("customerId", "name email phone")
      .populate("service", "name");
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { missingParts = [] } = req.body;

    // Transition to waiting_parts
    const prevStatus = booking.status;
    booking.status = "waiting_parts";
    booking.recordStatusHistory({
      fromStatus: prevStatus,
      toStatus: "waiting_parts",
      reason: `Parts out of stock: ${missingParts.join(', ')}`,
      changedBy: req.user._id,
      changedByModel: "Technician",
      changedByName: tech.name || "Technician",
    });

    // Store parts request
    booking.partsRequest = {
      status: "pending",
      requestedAt: new Date(),
      requestedBy: req.user._id,
      items: missingParts.map(name => ({
        itemName: name,
        requestedQty: 1,
        status: "waiting",
      })),
    };

    await booking.save();

    // Notify admin via socket
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: "waiting_parts",
        message: `Parts request created for booking ${booking.workOrderNumber || booking._id}: ${missingParts.join(', ')}`,
      });
    }

    // Send customer notification email
    try {
      const { sendPartsRequestEmail } = require("../utils/mailer");
      const customerEmail = booking.customerId?.email || booking.customer?.email;
      if (customerEmail && typeof sendPartsRequestEmail === "function") {
        await sendPartsRequestEmail({
          to: customerEmail,
          customerName: booking.customerId?.name || booking.customer?.name || "Customer",
          bookingReference: booking.workOrderNumber || booking._id?.toString().slice(-6).toUpperCase(),
          serviceName: booking.service?.name || booking.serviceName || "Repair Service",
          missingParts,
        });
      }
    } catch (e) { console.error("[MAILER] Failed to send parts request email:", e.message); }

    return res.json({
      success: true,
      status: "waiting_parts",
      missingParts,
      message: `Parts request created. Status set to Waiting for Parts.`,
    });
  } catch (err) {
    console.error("[REQUEST-PARTS]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/technician-decline-repair
// Technician chose "Decline" after inspection → booking status: repair_declined
// Also completes the assignment and frees the technician's time slot.
router.post("/appointments/:id/technician-decline-repair", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const { resolveAvailabilityStatus } = require("../utils/availability");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { reason } = req.body;

    booking.approval = {
      status: "declined",
      decidedAt: new Date(),
      reason: reason || "Declined by technician – customer did not approve",
    };

    await transitionRepairStatus(booking, 'repair_declined', tech, {
      reason: reason || 'Customer declined repair after inspection',
      notes: reason || 'Repair declined',
      metadata: {
        quotationTotal: booking.quotation?.totalCost || 0,
        declinedBy: 'technician_on_site'
      }
    });

    // ── Mark the assignment as declined to free the time slot ────────────
    const terminalStatuses = ["completed", "cancelled", "declined", "no_show"];
    const assignment = await Assignment.findById(booking.assignmentId)
      || await Assignment.findOne({ bookingId: booking._id, technicianId: tech._id });
    if (assignment && !terminalStatuses.includes(assignment.status)) {
      const now = new Date();
      assignment.status = "declined";
      assignment.declinedAt = now;
      assignment.declineReason = reason || "Technician declined repair after inspection";
      assignment.notes.push({
        text: `Assignment declined — repair declined after inspection. ${reason || ''}`.trim(),
        by: req.user._id,
        byName: tech.name,
        createdAt: now,
      });
      await assignment.save();
    }

    // ── Detach technician from booking so the slot is freed ───────────────
    await BookingService.findByIdAndUpdate(booking._id, {
      $set: { technicianId: null, assignmentId: null },
    });

    // ── Resolve technician availability ──────────────────────────────────
    const resolvedStatus = await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
    tech.availabilityStatus = resolvedStatus;
    await tech.save();

    // ── Notify admin ─────────────────────────────────────────────────────
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Repair declined for ${booking.workOrderNumber || booking._id}`,
      });
      global.io.to("admin-room").emit("assignment:declined", {
        assignmentId: assignment?._id,
        bookingId: booking._id,
        technicianName: tech.name,
        reason: `Repair declined: ${reason || 'Customer declined'}`,
        customerName: assignment?.customerName || booking.customer?.name,
        serviceName: assignment?.serviceName || 'Service',
        bookingDate: assignment?.bookingDate || booking.bookingDate,
      });
    }

    // ── Notify customer ──────────────────────────────────────────────────
    try {
      const { sendEmail } = require("../utils/mailer");
      if (booking.customer?.email) {
        await sendEmail(booking.customer.email, "Repair Service Update",
          `Dear ${booking.customer.name || 'Customer'},

We wanted to inform you that the repair service for work order ${booking.workOrderNumber || ''} has been declined.

${reason ? `Reason: ${reason}` : ''}

If you have any questions or would like to reschedule, please contact us.

Thank you,
RACS Team`);
      }
    } catch (e) { /* non-critical */ }

    return res.json({ success: true, status: booking.status });
  } catch (err) {
    console.error("Technician decline repair error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/start-repair
// Technician starts repair work → booking status: repair_in_progress
router.post("/appointments/:id/start-repair", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const allowedFrom = ["ready_for_repair", "scheduled", "repair_scheduled", "repair_approved", "on-the-way", "arrived"];
    if (!allowedFrom.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot start repair from status: ${booking.status}` });
    }

    // Check parts availability — prevent starting if parts are out of stock
    const quotation = booking.quotation || {};
    const parts = quotation.parts || [];
    const checkedParts = parts.filter(p => p.checked !== false);
    const EquipmentAssignment = require("../models/EquipmentAssignment");
    const Tool = require("../models/Tool");
    const outOfStockParts = [];
    for (const p of checkedParts) {
      if (p.toolId) {
        try {
          const tool = await Tool.findById(p.toolId);
          if (!tool || tool.quantity < (p.quantity || 1)) {
            outOfStockParts.push(p.name || 'Unknown part');
          }
        } catch (e) { /* skip if tool lookup fails */ }
      }
    }
    if (outOfStockParts.length > 0) {
      return res.status(400).json({ error: `Cannot start repair: parts out of stock: ${outOfStockParts.join(', ')}` });
    }

    // Enterprise: Use safe status transition with audit trail
    await transitionRepairStatus(booking, 'repair_in_progress', tech, {
      reason: 'Repair work started',
      metadata: {
        repairStartedAt: new Date(),
        estimatedDuration: booking.technicianAssistant?.estimatedDurationMinutes || null,
        safetyReminders: booking.technicianAssistant?.safetyReminders || []
      }
    });

    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        priority: booking.priority,
        message: `Repair started for ${booking.workOrderNumber || booking._id}`,
      });
      global.io.to(`customer:${booking.customerId}`).emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Your repair has begun! ${booking.workOrderNumber || ""}`,
      });
    }

    return res.json({
      success: true,
      status: booking.status,
      estimatedDuration: booking.technicianAssistant?.estimatedDurationMinutes || null,
      safetyReminders: booking.technicianAssistant?.safetyReminders || []
    });
  } catch (err) {
    console.error("Start repair error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/save-materials
// Save materials/tools used without completing the repair
router.post("/appointments/:id/save-materials", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const { partsInstalled, actionsPerformed, completionNotes } = req.body;

    booking.repairCompletion = {
      partsInstalled: partsInstalled || [],
      actionsPerformed: actionsPerformed || [],
      completionNotes: completionNotes || "",
      completedAt: null,
    };
    await booking.save();

    return res.json({ success: true, repairCompletion: booking.repairCompletion });
  } catch (err) {
    console.error("Save materials error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/collect-repair-payment
// Technician collects the full quotation payment for a completed repair
// Body: { amount, method, proofUrl? }
router.post("/appointments/:id/collect-repair-payment", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Payment = require("../models/Payment");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }
    if (!["repair_in_progress", "arrived", "in-progress"].includes(booking.status)) {
      return res.status(400).json({ error: "Can only collect payment when repair is in progress." });
    }
    if (booking.repairPaymentCollected) {
      return res.status(400).json({ error: "Payment has already been collected for this repair." });
    }

    const { amount, method, proofUrl } = req.body;
    const quotationTotal = booking.quotation?.totalCost || 0;
    const collected = parseFloat(amount) || quotationTotal;

    // Record payment
    booking.repairPaymentCollected = true;
    booking.repairPaymentAmount = collected;
    booking.repairPaymentMethod = method || "cash";
    booking.repairPaymentCollectedAt = new Date();
    booking.repairPaymentCollectedBy = tech._id;
    if (proofUrl) booking.repairPaymentProof = proofUrl;

    // Update booking payment totals
    booking.amountPaid = (booking.amountPaid || 0) + collected;
    booking.paymentStatus = "paid";

    await booking.save();

    const methodMap = { cash: 'cod', cod: 'cod', gcash: 'gcash', maya: 'other', bank_transfer: 'bank' };
    const mappedMethod = methodMap[method] || methodMap["cash"];

    // Payment record
    await Payment.create({
      bookingId: booking._id,
      amount: collected,
      method: mappedMethod,
      type: "final",
      gateway: mappedMethod,
      status: "paid",
      reference: `Repair payment collected by ${tech.name}`,
      proofUrl: proofUrl || "",
      verifiedAt: new Date(),
      completedAt: new Date(),
      notes: `Repair quotation payment of ₱${collected.toLocaleString()} collected by technician ${tech.name}`,
    });

    // Notify admin
    const { createNotification } = require("../utils/notify");
    const io = req.app.get("io");
    await createNotification({
      type: "payment_collected",
      title: "Repair Payment Collected",
      message: `${tech.name} collected ₱${collected.toLocaleString()} for repair of ${booking.workOrderNumber || booking._id}.`,
      role: "admin",
      referenceId: booking._id,
      referenceModel: "BookingService",
      link: "/admin/appointments/completed",
      io,
    });

    // Socket notify customer
    if (global.io) {
      global.io.to(`customer:${booking.customerId}`).emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Payment of ₱${collected.toLocaleString()} received for your repair.`,
      });
    }

    return res.json({
      success: true,
      message: `Repair payment of ₱${collected.toLocaleString()} collected successfully.`,
      booking: {
        repairPaymentCollected: true,
        repairPaymentAmount: collected,
        repairPaymentMethod: method || "cash",
        amountPaid: booking.amountPaid,
      },
    });
  } catch (err) {
    console.error("Collect repair payment error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// POST /appointments/:id/upload-proof
// Multer-based proof of payment upload for repair payment
const repairProofUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '../public/uploads/proofs')),
    filename: (req, file, cb) => cb(null, 'proof-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp/;
    cb(null, allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype));
  },
}).single('proofPhoto');

const proofsDir = path.join(__dirname, '../public/uploads/proofs');
if (!fs.existsSync(proofsDir)) fs.mkdirSync(proofsDir, { recursive: true });

router.post("/appointments/:id/upload-proof", (req, res, next) => {
  repairProofUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ url: '/uploads/proofs/' + req.file.filename });
  });
});

// POST /appointments/:id/complete-repair
// Technician completes repair → booking status: repair_completed + warranty + invoice
router.post("/appointments/:id/complete-repair", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id }).populate("user", "firstName lastName name email");
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const allowedFrom = ["ready_for_repair", "scheduled", "repair_approved", "repair_in_progress", "inspection_completed", "awaiting_approval", "repair_completed", "arrived", "in-progress"];
    const alreadyCompleted = booking.status === "repair_completed";
    if (!allowedFrom.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot complete repair from status: ${booking.status}` });
    }

    // Require payment collection before completing repair
    const paymentRequired = (booking.quotation?.totalCost || 0) + (booking.travelFare || 0);
    if (paymentRequired > 0 && !booking.repairPaymentCollected) {
      return res.status(400).json({ error: "Payment must be collected before completing the repair." });
    }

    // Auto-start repair if not already in progress
    if (!alreadyCompleted && booking.status !== "repair_in_progress") {
      try {
        await transitionRepairStatus(booking, 'repair_in_progress', tech, {
          reason: 'Auto-started repair for completion',
        });
      } catch (e) { console.error("Auto-start transition error:", e.message); }
    }

    const { completionNotes, actionsPerformed, partsInstalled } = req.body;

    // Save materials/parts used on the booking (safe — won't crash if field missing)
    try {
      booking.repairCompletion = {
        partsInstalled: partsInstalled || [],
        actionsPerformed: actionsPerformed || [],
        completionNotes: completionNotes || "",
        completedAt: new Date(),
      };
    } catch (e) { console.error("repairCompletion set error:", e.message); }

    // Start warranty
    const warrantyDays = 30;
    try {
      booking.warranty = {
        days: warrantyDays,
        startDate: new Date(),
        endDate: new Date(Date.now() + warrantyDays * 24 * 60 * 60 * 1000),
        status: "active",
      };
    } catch (e) { console.error("warranty set error:", e.message); }

    // Transition to repair_completed
    if (!alreadyCompleted) {
      try {
        await transitionRepairStatus(booking, 'repair_completed', tech, {
          reason: 'Repair completed',
          notes: completionNotes || '',
          metadata: {
            completionNotes,
            actionsPerformed: actionsPerformed || [],
            partsInstalled: partsInstalled || [],
            warrantyDays,
            warrantyEnd: booking.warranty?.endDate,
          }
        });
      } catch (e) { console.error("repair_completed transition error:", e.message); }
    }

    // Set SLA resolution tracking (safe)
    try {
      if (booking.slaTracking && typeof booking.slaTracking === 'object') {
        booking.slaTracking.resolutionAt = new Date();
        if (booking.slaTracking.resolutionTarget && new Date() > booking.slaTracking.resolutionTarget) {
          booking.slaTracking.resolutionBreached = true;
        }
      }
    } catch (e) { /* non-critical */ }

    // Final save (safe)
    try { await booking.save(); } catch (e) { console.error("Final booking save error:", e.message); }

    // Fulfill stock reservations (convert to ServiceToolUsage records)
    try {
      const StockReservation = require("../models/StockReservation");
      await StockReservation.fulfillForBooking({
        bookingId: booking._id,
        technicianId: tech._id,
        recordedBy: req.user._id,
      });
    } catch (e) { console.error('[STOCK] Fulfillment error:', e.message); }

    // Set assignment to completed (atomic update — always runs)
    const Assignment = require("../models/Assignment");
    const assignmentUpdate = { status: "completed", completedAt: new Date() };
    const assignmentPush = {};
    if (completionNotes) {
      assignmentPush.notes = {
        text: "[Repair Complete] " + completionNotes,
        by: req.user._id,
        byName: tech.name,
        createdAt: new Date(),
      };
    }
    const updatedAssignment = await Assignment.findOneAndUpdate(
      { bookingId: booking._id, technicianId: tech._id },
      { $set: assignmentUpdate, ...(Object.keys(assignmentPush).length ? { $push: assignmentPush } : {}) },
      { new: true }
    );
    if (!updatedAssignment) {
      console.error(`Assignment not found for booking ${booking._id} tech ${tech._id}`);
    }

    // Socket notifications (safe)
    try {
      if (global.io) {
        global.io.to("admin").emit("booking:updated", {
          bookingId: booking._id,
          status: booking.status,
          priority: booking.priority,
          message: `Repair completed for ${booking.workOrderNumber || booking._id}`,
        });
        const warrantyEndStr = booking.warranty?.endDate ? booking.warranty.endDate.toLocaleDateString() : "N/A";
        global.io.to(`customer:${booking.customerId}`).emit("booking:updated", {
          bookingId: booking._id,
          status: booking.status,
          message: `Your repair has been completed! Warranty until ${warrantyEndStr}.`,
        });
      }
    } catch (e) { /* non-critical */ }

    // Send repair completed email with invoice + thank you (safe — non-blocking)
    try {
      const { sendRepairCompletedEmail } = require("../utils/mailer");
      const populatedBooking = await BookingService.findById(booking._id).populate("customerId", "name email").lean();
      const customerEmail = populatedBooking?.customerId?.email;
      if (customerEmail) {
        const quotation = booking.quotation || {};
        const repairComp = booking.repairCompletion || {};
        const dateLabel = new Date().toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
        const techFullName = ((tech.user && (tech.user.name || [tech.user.firstName, tech.user.lastName].filter(Boolean).join(' '))) || tech.name || "Your technician");
        const partsList = (quotation.parts || repairComp.partsInstalled || []).map(p => ({
          name: p.name || p.partName || "Part",
          quantity: p.quantity || 1,
          unitPrice: p.unitPrice || p.cost || p.price || 0,
          total: (p.unitPrice || p.cost || p.price || 0) * (p.quantity || 1),
        }));
        const inspectionFee = booking.inspectionFeeTotalCollected || booking.initialCost || 0;
        const travelFee = booking.travelFare || 0;
        const invoiceData = {
          workOrderNumber: booking.workOrderNumber || `WO-${String(booking._id).slice(-6).toUpperCase()}`,
          customerName: populatedBooking?.customerId?.name || "Customer",
          serviceName: booking.serviceName || booking.serviceType || "Repair",
          technicianName: techFullName,
          parts: partsList,
          laborCost: quotation.laborCost || 0,
          partsTotal: partsList.reduce((sum, p) => sum + p.total, 0),
          inspectionFee: inspectionFee,
          travelFee: travelFee,
          totalAmount: quotation.totalCost || 0,
          grandTotal: inspectionFee + travelFee + (quotation.totalCost || 0),
          downpayment: booking.downpaymentAmount || 0,
          balanceCollected: !!booking.balanceCollected,
          balancePaid: booking.balanceCollected ? (booking.balanceAmount || Math.max(0, (booking.amountPaid || 0) - (booking.downpaymentAmount || 0))) : 0,
          totalPaid: (booking.inspectionFeeTotalCollected || 0) + (booking.repairPaymentAmount || 0) + (booking.downpaymentAmount || 0),
          actionsPerformed: repairComp.actionsPerformed || [],
        };
        sendRepairCompletedEmail({
          to: customerEmail,
          customerName: populatedBooking?.customerId?.name || "Customer",
          bookingReference: booking.workOrderNumber || `WO-${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: booking.serviceName || booking.serviceType || "Repair",
          technicianName: techFullName,
          dateLabel,
          invoice: invoiceData,
          warranty: booking.warranty ? {
            duration: `${booking.warranty.days || 30} days`,
            startDate: booking.warranty.startDate?.toLocaleDateString?.('en-PH') || 'N/A',
            endDate: booking.warranty.endDate?.toLocaleDateString?.('en-PH') || 'N/A',
          } : null,
        }).catch(err => console.error("[MAILER] Failed to send repair completion email:", err.message));
      }
    } catch (mailErr) {
      console.error("[MAILER] Repair completion email error:", mailErr.message);
    }

    // Build invoice data for response
    const quotation = booking.quotation || {};
    const repairComp = booking.repairCompletion || {};
    const inspection = booking.inspection || {};
    const diagnosis = booking.diagnosis || {};
    const inspectionFee = booking.inspectionFeeTotalCollected || booking.initialCost || 0;
    const travelFee = booking.travelFare || 0;
    const quotationTotal = quotation.totalCost || 0;
    const grandTotal = inspectionFee + travelFee + quotationTotal;
    const totalPaid = (booking.inspectionFeeTotalCollected || 0) + (booking.repairPaymentAmount || 0) + (booking.downpaymentAmount || 0);
    const invoice = {
      workOrderNumber: booking.workOrderNumber || `WO-${String(booking._id).slice(-6).toUpperCase()}`,
      customerName: booking.customer?.name || 'Customer',
      serviceName: booking.serviceName || booking.serviceType || 'Repair',
      serviceAddress: booking.customer?.address || booking.address || '',
      technicianName: (tech.user && (tech.user.name || [tech.user.firstName, tech.user.lastName].filter(Boolean).join(' '))) || tech.name || '',
      dateCompleted: new Date().toLocaleDateString('en-PH'),
      parts: (quotation.parts || repairComp.partsInstalled || []).map(p => ({
        name: p.name || p.partName || 'Part',
        quantity: p.quantity || 1,
        unitPrice: p.unitPrice || p.cost || p.price || 0,
        total: (p.unitPrice || p.cost || p.price || 0) * (p.quantity || 1),
      })),
      laborCost: quotation.laborCost || 0,
      partsTotal: (quotation.parts || []).length > 0
        ? (quotation.parts || []).reduce((sum, p) => sum + ((p.unitPrice || p.cost || p.price || 0) * (p.quantity || 1)), 0)
        : (repairComp.partsInstalled || []).reduce((sum, p) => sum + ((p.unitPrice || p.cost || p.price || 0) * (p.quantity || 1)), 0),
      inspectionFee: inspectionFee,
      travelFee: travelFee,
      totalAmount: quotationTotal,
      grandTotal: grandTotal,
      downpayment: booking.downpaymentAmount || 0,
      balanceCollected: !!booking.balanceCollected,
      balancePaid: booking.balanceCollected ? (booking.balanceAmount || Math.max(0, (booking.amountPaid || 0) - (booking.downpaymentAmount || 0))) : 0,
      totalPaid: totalPaid,
      warranty: booking.warranty ? {
        duration: `${booking.warranty.days || 30} days`,
        startDate: booking.warranty.startDate?.toLocaleDateString('en-PH') || 'N/A',
        endDate: booking.warranty.endDate?.toLocaleDateString('en-PH') || 'N/A',
      } : null,
      inspection: {
        findings: inspection.findings || '',
        severity: inspection.severity || '',
        damagedParts: inspection.damagedParts || [],
        recommendedAction: inspection.recommendedAction || '',
      },
      diagnosis: {
        findings: diagnosis.findings || '',
      },
      actionsPerformed: repairComp.actionsPerformed || [],
      completionNotes: repairComp.completionNotes || '',
    };

    return res.json({
      success: true,
      status: booking.status,
      invoice,
      warranty: booking.warranty,
      statusHistory: booking.statusHistory?.slice(-3)
    });
  } catch (err) {
    console.error("Complete repair error:", err.message, err.stack);
    return res.status(500).json({ error: "Server error: " + err.message });
  }
});

// POST /appointments/:id/scheduling-request
// Technician submits scheduling request on behalf of customer (for "schedule later" flow)
router.post("/appointments/:id/scheduling-request", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }

    const allowedFrom = ["awaiting_approval", "repair_approved"];
    if (!allowedFrom.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot submit scheduling request from status: ${booking.status}` });
    }

    const { preferredDates, preferredTime, notes } = req.body;
    if (!preferredDates || !preferredDates.length) {
      return res.status(400).json({ error: "At least one preferred date is required" });
    }

    booking.schedulingRequest = {
      preferredDates: preferredDates.map(d => new Date(d)),
      preferredTime: preferredTime || 'Any Time',
      status: 'pending',
      notes: notes || '',
      createdAt: new Date(),
    };
    await booking.save();

    // Notify admin of scheduling request
    if (global.io) {
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: booking.status,
        message: `Scheduling request submitted for ${booking.workOrderNumber || booking._id}. Customer preferred dates: ${preferredDates.join(', ')}`,
      });
    }

    return res.json({
      success: true,
      schedulingRequest: booking.schedulingRequest,
    });
  } catch (err) {
    console.error("Scheduling request error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /appointments/:id/repair-today-choice
// Technician chooses "Repair Today" or "Schedule Later" after customer approved quotation
router.post("/appointments/:id/repair-today-choice", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");
    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician profile not found" });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.technicianId?.toString() !== tech._id.toString()) {
      return res.status(403).json({ error: "Not assigned to this booking" });
    }
    if (booking.status !== "repair_approved") {
      return res.status(400).json({ error: `Cannot make scheduling choice from status: ${booking.status}` });
    }

    const { choice, preferredDates, preferredTime } = req.body;

    if (choice === "today") {
      // Check if technician has remaining working hours today
      const now = new Date();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(now);
      todayEnd.setHours(23, 59, 59, 999);

      const todayAssignments = await Assignment.find({
        technicianId: tech._id,
        status: { $in: ["accepted", "en_route", "on_site", "in_progress"] },
      }).select("bookingDate serviceDurationMinutes").lean();

      const activeJobs = todayAssignments.filter(a => {
        const bd = new Date(a.bookingDate);
        return bd >= todayStart && bd <= todayEnd;
      });

      const estimatedDuration = booking.technicianAssistant?.estimatedDurationMinutes || 90;
      const COMPANY_END = 1020; // 5 PM
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const remainingMinutes = COMPANY_END - currentMinutes;

      if (activeJobs.length > 0 || remainingMinutes < estimatedDuration) {
        return res.json({
          success: false,
          available: false,
          message: activeJobs.length > 0
            ? "Technician is currently on another job. Please schedule for another day."
            : "Not enough remaining working hours today. Please schedule for another day.",
          status: booking.status,
          remainingHours: Math.floor(remainingMinutes / 60),
          estimatedDuration
        });
      }

      // Available! Mark as ready to start
      booking.repairSchedule = {
        preference: "today",
        decidedAt: new Date(),
      };
      await booking.save();

      return res.json({
        success: true,
        available: true,
        message: "Technician is available! Repair will start shortly.",
        status: booking.status,
        technicianName: tech.name || "Technician"
      });
    }

    if (choice === "later") {
      if (!preferredDates || !Array.isArray(preferredDates) || preferredDates.length === 0) {
        return res.status(400).json({ error: "Please provide at least one preferred date" });
      }

      booking.preferredSchedule = {
        dates: preferredDates.map(d => new Date(d)),
        timeWindow: preferredTime || "any",
        submittedAt: new Date(),
        submittedBy: req.user._id,
      };
      booking.repairSchedule = {
        preference: "later",
        decidedAt: new Date(),
      };
      await booking.save();

      // Notify admin
      if (global.io) {
        global.io.to("admin").emit("booking:updated", {
          bookingId: booking._id,
          status: booking.status,
          message: `Technician submitted scheduling request for ${booking.workOrderNumber || booking._id}. Preferred dates: ${preferredDates.join(', ')}`,
        });
      }

      return res.json({
        success: true,
        message: "Scheduling request submitted. Admin will confirm the final schedule.",
        status: booking.status,
      });
    }

    return res.status(400).json({ error: "Invalid choice. Must be 'today' or 'later'." });
  } catch (err) {
    console.error("Repair today choice error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// REPAIR UNIFIED WORKFLOW — Enterprise En Route → Arrived → Start → Complete
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/technician/repairs/:bookingId/en-route
 * Technician goes en route for a repair booking.
 * Creates or updates an Assignment, transitions booking to on-the-way.
 */
router.post("/repairs/:bookingId/en-route", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");

    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: "Invalid booking id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const booking = await BookingService.findById(bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Verify this tech is assigned
    const techId = String(booking.technicianId || '');
    const inspectionTechId = String(booking.inspection?.technicianId || '');
    if (techId !== String(tech._id) && inspectionTechId !== String(tech._id)) {
      return res.status(403).json({ error: "You are not assigned to this repair" });
    }

    // Must be in a ready state — Phase 1 (inspection) or Phase 2 (repair execution)
    const allowedStatuses = [
      // Phase 1 - Inspection visit
      "inspection_scheduled", "confirmed",
      // Waiting states — admin has approved/scheduled, parts incoming
      "awaiting_approval", "repair_approved", "waiting_parts",
      // Phase 2 - Repair execution (parts ready / scheduled)
      "repair_scheduled", "ready_for_repair", "parts_reserved"
    ];
    if (!allowedStatuses.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot go en route from status "${booking.status}". Booking must be ready for a visit (${allowedStatuses.join(", ")}).` });
    }

    const now = new Date();

    // Find or create assignment
    let assignment = await Assignment.findOne({ bookingId: booking._id, technicianId: tech._id });
    if (!assignment) {
      // Create a new assignment for this repair
      assignment = await Assignment.create({
        bookingId: booking._id,
        technicianId: tech._id,
        customerName: booking.customerId?.name || "Customer",
        customerPhone: booking.customerId?.phone || "",
        customerEmail: booking.customerId?.email || "",
        serviceType: "repair",
        serviceName: "Repair Service",
        servicePrice: booking.quotation?.totalCost || 0,
        bookingDate: booking.bookingDate || now,
        startTime: booking.startTime || "",
        endTime: booking.endTime || "",
        address: booking.location?.address || "",
        coordinates: booking.location?.coordinates,
        status: "en_route",
        enRouteAt: now,
        notes: [{ text: "Technician en route for repair", by: req.user._id, byName: tech.name, createdAt: now }],
      });
    } else {
      // Update existing assignment
      const validTransitions = {
        accepted: ["en_route", "cancelled"],
        pending_acceptance: ["en_route", "cancelled"],
        in_progress: ["en_route", "cancelled"], // Allow re-route for repair reschedule
        on_site: ["en_route"], // Allow if technician needs to restart
        en_route: ["en_route"], // Allow re-trigger (idempotent)
      };
      const allowed = validTransitions[assignment.status];
      if (!allowed || !allowed.includes("en_route")) {
        return res.status(400).json({ error: `Cannot transition from "${assignment.status}" to en_route` });
      }
      // Reset assignment timestamps for the repair execution phase
      assignment.status = "en_route";
      assignment.enRouteAt = now;
      assignment.arrivedAt = null;
      assignment.startedAt = null;
      assignment.completedAt = null;
      assignment.notes.push({ text: "Technician en route for repair execution", by: req.user._id, byName: tech.name, createdAt: now });
      await assignment.save();
    }

    // Update booking status
    const prevBookingStatus = booking.status;
    booking.status = "on-the-way";
    booking.statusHistory = booking.statusHistory || [];
    booking.statusHistory.push({
      fromStatus: prevBookingStatus,
      toStatus: "on-the-way",
      reason: "Technician en route",
      changedBy: req.user._id,
      changedByModel: "User",
      changedByName: tech.name,
      timestamp: now,
    });
    await booking.save();

    // Update tech availability
    tech.availabilityStatus = "On The Way";
    await tech.save();

    // Send on-the-way email
    try {
      const { sendTechArrivalNotificationEmail } = require("../utils/mailer");
      const customer = await BookingService.findById(bookingId).populate("customerId", "name email").lean();
      if (customer?.customerId?.email) {
        const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
        sendTechArrivalNotificationEmail({
          to: customer.customerId.email,
          customerName: customer.customerId.name || "Customer",
          bookingReference: booking.workOrderNumber || `#${String(booking._id).slice(-6).toUpperCase()}`,
          techName: techFullName,
          serviceName: "Repair Service",
          dateLabel: now.toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
          timeLabel: booking.startTime || "TBD",
          locationAddress: booking.location?.address || "",
        }).catch(err => console.error("[MAILER] Repair en-route email error:", err.message));
      }
    } catch (mailErr) {
      console.error("[MAILER] Repair en-route email error:", mailErr.message);
    }

    // Socket notification
    if (global.io) {
      const customerId = booking.customerId?._id || booking.customerId;
      if (customerId) {
        global.io.to("customer:" + customerId).emit("booking:status-change", {
          bookingId: booking._id,
          status: "on-the-way",
          technicianName: tech.name,
          timestamp: Date.now(),
        });
      }
      global.io.to("admin").emit("booking:updated", {
        bookingId: booking._id,
        status: "on-the-way",
        message: `${tech.name} is en route for repair ${booking.workOrderNumber || booking._id}`,
      });
    }

    return res.json({ success: true, message: "En route! Heading to customer.", assignment });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/technician/repairs/:bookingId/status
 * Unified status transition for repairs: arrived, start_work, complete, no_show
 * Maps to the existing assignment lifecycle.
 */
router.post("/repairs/:bookingId/status", async (req, res, next) => {
  try {
    const BookingService = require("../models/BookingService");
    const Assignment = require("../models/Assignment");

    const { bookingId } = req.params;
    const { status: newStatus } = req.body;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: "Invalid booking id" });

    const tech = await Technician.findOne({ user: req.user._id });
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const booking = await BookingService.findById(bookingId);
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const assignment = await Assignment.findOne({ bookingId: booking._id, technicianId: tech._id });
    if (!assignment) return res.status(404).json({ error: "No assignment found for this repair" });

    const validTransitions = {
      en_route: ["on_site", "cancelled"],
      on_site: ["in_progress", "no_show", "cancelled"],
      in_progress: ["completed"],
    };
    const allowed = validTransitions[assignment.status];
    if (!allowed || !allowed.includes(newStatus)) {
      return res.status(400).json({ error: `Cannot transition from "${assignment.status}" to "${newStatus}"` });
    }

    const now = new Date();
    const statusTimestamps = { on_site: "arrivedAt", in_progress: "startedAt", completed: "completedAt", cancelled: "cancelledAt" };
    if (statusTimestamps[newStatus]) assignment[statusTimestamps[newStatus]] = now;

    assignment.status = newStatus;
    assignment.notes.push({ text: `Status changed to ${newStatus.replace(/_/g, " ")}`, by: req.user._id, byName: tech.name, createdAt: now });
    await assignment.save();

    // Update availability
    const availabilityMap = { on_site: "In Progress", in_progress: "In Progress" };
    if (availabilityMap[newStatus]) {
      tech.availabilityStatus = availabilityMap[newStatus];
      await tech.save();
    }
    if (newStatus === "completed" || newStatus === "cancelled") {
      const { resolveAvailabilityStatus } = require("../utils/availability");
      tech.availabilityStatus = await resolveAvailabilityStatus(tech, null, null, { syncDb: true });
      await tech.save();
    }

    // Map assignment status to booking status — phase aware
    // If inspection is already completed, any new visit is Phase 2
    const isPhase1 = !booking.inspection?.completedAt && ["inspection_scheduled", "confirmed", "on-the-way", "arrived"].includes(booking.status);
    const bookingStatusMap = {
      // on_site: "arrived" works for both phases
      on_site: "arrived",
      // in_progress: Phase 1 → stay at whatever it was (inspection_scheduled)
      //              Phase 2 → repair_in_progress
      in_progress: isPhase1 ? null : "repair_in_progress",
      completed: "repair_completed",
      cancelled: "pending_reassignment",
    };
    const newBookingStatus = bookingStatusMap[newStatus];
    if (newBookingStatus) {
      const prevStatus = booking.status;
      booking.status = newBookingStatus;
      booking.statusHistory = booking.statusHistory || [];
      booking.statusHistory.push({
        fromStatus: prevStatus,
        toStatus: newBookingStatus,
        reason: `Technician ${newStatus.replace(/_/g, " ")}`,
        changedBy: req.user._id,
        changedByModel: "User",
        changedByName: tech.name,
        timestamp: now,
      });
      if (newStatus === "completed") {
        booking.completedAt = now;
        // Fulfill stock reservations
        try {
          const StockReservation = require("../models/StockReservation");
          await StockReservation.fulfillForBooking({
            bookingId: booking._id,
            technicianId: tech._id,
            recordedBy: req.user._id,
          });
        } catch (e) {
          console.error("[STOCK] Fulfill reservation error:", e.message);
        }
      }
      await booking.save();
    }

    // Send mailer for key events
    try {
      const customer = await BookingService.findById(bookingId).populate("customerId", "name email").lean();
      if (customer?.customerId?.email) {
        const techFullName = ((tech.firstName || "") + " " + (tech.lastName || "")).trim() || tech.name || "Your technician";
        const bookingRef = booking.workOrderNumber || `#${String(booking._id).slice(-6).toUpperCase()}`;
        const dateLabel = now.toLocaleDateString("en-PH", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

        if (newStatus === "on_site") {
          const { sendTechnicianArrivedEmail } = require("../utils/mailer");
          sendTechnicianArrivedEmail({
            to: customer.customerId.email,
            customerName: customer.customerId.name || "Customer",
            bookingReference: bookingRef,
            techName: techFullName,
            serviceName: "Repair Service",
            dateLabel,
            timeLabel: booking.startTime || "TBD",
            locationAddress: booking.location?.address || "",
          }).catch(err => console.error("[MAILER] Repair arrived email error:", err.message));
        } else if (newStatus === "in_progress") {
          const { sendWorkStartedEmail } = require("../utils/mailer");
          sendWorkStartedEmail({
            to: customer.customerId.email,
            customerName: customer.customerId.name || "Customer",
            bookingReference: bookingRef,
            techName: techFullName,
            serviceName: "Repair Service",
            dateLabel,
            timeLabel: booking.startTime || "TBD",
            locationAddress: booking.location?.address || "",
          }).catch(err => console.error("[MAILER] Repair started email error:", err.message));
        } else if (newStatus === "completed") {
          const { sendRepairCompletedEmail } = require("../utils/mailer");
          sendRepairCompletedEmail({
            to: customer.customerId.email,
            customerName: customer.customerId.name || "Customer",
            bookingReference: bookingRef,
            technicianName: techFullName,
            serviceName: "Repair Service",
            dateLabel,
            quotationTotal: booking.quotation?.totalCost || 0,
          }).catch(err => console.error("[MAILER] Repair completed email error:", err.message));
        }
      }
    } catch (mailErr) {
      console.error("[MAILER] Repair status email error:", mailErr.message);
    }

    // Create service report on completion
    if (newStatus === "completed") {
      const ServiceReport = require("../models/ServiceReport");
      const existing = await ServiceReport.findOne({ bookingId: booking._id });
      if (!existing) {
        await ServiceReport.create({
          bookingId: booking._id,
          assignmentId: assignment._id,
          technicianId: tech._id,
          customerName: assignment.customerName,
          serviceName: "Repair Service",
          serviceType: "repair",
          bookingDate: assignment.bookingDate,
          status: "draft",
        });
      }
    }

    // Socket notifications
    if (global.io) {
      const customerId = booking.customerId?._id || booking.customerId;
      if (customerId) {
        global.io.to("customer:" + customerId).emit("booking:status-change", {
          bookingId: booking._id,
          status: bookingStatusMap[newStatus] || newStatus,
          technicianName: tech.name,
          timestamp: Date.now(),
        });
      }
    }

    return res.json({ success: true, message: `Status updated to ${newStatus.replace(/_/g, " ")}`, assignment });
  } catch (err) {
    next(err);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Equipment checkout / return (booking-level)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/technician/equipment
 * List all equipment assignments for the authenticated technician.
 */
router.get("/equipment", async (req, res, next) => {
  try {
    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });
    const items = await EquipmentAssignment.find({ technicianId: { $in: technicianIds.map(id => new mongoose.Types.ObjectId(id)) } })
      .populate("bookingId", "bookingReference customer service bookingDate")
      .populate("equipmentId", "itemName barcode quantity status")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ items });
  } catch (err) { next(err); }
});

/**
 * GET /api/technician/equipment/:bookingId
 * List equipment assigned to a booking for the authenticated technician.
 */
router.get("/equipment/:bookingId", async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) return res.status(400).json({ error: "Invalid booking id" });
    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const BookingService = require("../models/BookingService");
    const booking = await BookingService.findById(bookingId).select("technicianId").lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!technicianIds.includes(String(booking.technicianId || ""))) {
      return res.status(403).json({ error: "You are not assigned to this booking" });
    }

    const items = await EquipmentAssignment.find({ bookingId })
      .populate("equipmentId", "itemName barcode quantity status")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ items });
  } catch (err) { next(err); }
});

/**
 * POST /api/technician/equipment/:assignmentId/checkout
 * Technician confirms they received the assigned equipment.
 */
router.post("/equipment/:assignmentId/checkout", async (req, res, next) => {
  try {
    const { assignmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) return res.status(400).json({ error: "Invalid id" });
    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const assignment = await EquipmentAssignment.findById(assignmentId);
    if (!assignment) return res.status(404).json({ error: "Equipment assignment not found" });
    if (!technicianIds.includes(String(assignment.technicianId || ""))) {
      return res.status(403).json({ error: "Not assigned to you" });
    }
    if (assignment.status !== "reserved") return res.status(400).json({ error: "Equipment already checked out or returned" });

    const tool = await Tool.findById(assignment.equipmentId);
    if (!tool) return res.status(404).json({ error: "Tool not found" });
    if (tool.quantity < assignment.quantity) return res.status(400).json({ error: "Insufficient stock for " + tool.itemName });

    tool.quantity -= assignment.quantity;
    await tool.save();
    assignment.status = "checked_out";
    assignment.checkedOutAt = new Date();
    assignment.checkedOutBy = req.user._id;
    await assignment.save();

    res.json({ success: true, assignment });
  } catch (err) { next(err); }
});

/**
 * POST /api/technician/equipment/:assignmentId/return
 * Technician returns equipment. condition = good|damaged|lost
 */
router.post("/equipment/:assignmentId/return", async (req, res, next) => {
  try {
    const { assignmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) return res.status(400).json({ error: "Invalid id" });
    const { tech, technicianIds } = await loadTechnicianContext(req.user._id);
    if (!tech) return res.status(404).json({ error: "Technician record not found" });

    const { condition = "good", damageDescription = "", damagePhoto = "" } = req.body;
    const allowedConditions = ["good", "fair", "damaged", "lost"];
    if (!allowedConditions.includes(condition)) return res.status(400).json({ error: "Invalid condition" });

    const assignment = await EquipmentAssignment.findById(assignmentId);
    if (!assignment) return res.status(404).json({ error: "Equipment assignment not found" });
    if (!technicianIds.includes(String(assignment.technicianId || ""))) {
      return res.status(403).json({ error: "Not assigned to you" });
    }
    if (assignment.status !== "checked_out" && assignment.status !== "in_use") {
      return res.status(400).json({ error: "Equipment is not checked out" });
    }

    const tool = await Tool.findById(assignment.equipmentId);
    assignment.condition = condition;
    assignment.damageDescription = damageDescription;
    assignment.damagePhoto = damagePhoto;
    assignment.returnedAt = new Date();
    assignment.returnedTo = String(req.user._id);

    if (condition === "good" || condition === "fair") {
      if (tool) tool.quantity += assignment.quantity;
      assignment.status = "returned";
    } else if (condition === "damaged" || condition === "lost") {
      assignment.status = condition;
    }

    if (tool) await tool.save();
    await assignment.save();
    res.json({ success: true, assignment });
  } catch (err) { next(err); }
});

module.exports = router;

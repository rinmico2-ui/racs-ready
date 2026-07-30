/**
 * Enterprise Appointment Management API
 * Unified backend for the full booking lifecycle
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const BookingService = require('../models/BookingService');
const Payment = require('../models/Payment');
const Assignment = require('../models/Assignment');
const Expense = require('../models/Expense');
const EquipmentAssignment = require('../models/EquipmentAssignment');
const Tool = require('../models/Tool');
const Technician = require('../models/Technician');
const { BookingStatus, PaymentStatus, FlowStages } = require('../models/BookingStatus');
const { generateAssistantReport } = require('../utils/aiTechnicianAssistant');

const { authenticate, requireRole } = require('../middleware/authenticate');

router.use(authenticate);

// ── AI-driven repair recommendation helper ───────────────────────────────────
async function generateRepairRecommendations(booking) {
  try {
    const unitInfo = {
      unitType: booking.unitType || booking.service?.unitType || booking.service?.name || 'aircon',
      brand: booking.brand || booking.service?.brand || '',
      model: booking.model || booking.service?.model || '',
      problemDescription: booking.problemDescription || booking.customerNotes || booking.notes || booking.description || '',
      serviceName: booking.service?.name || '',
    };
    const report = await generateAssistantReport(unitInfo);
    const assistant = report?.technicianAssistant || {};
    return {
      suggestedTools: Array.isArray(assistant.suggestedTools) ? assistant.suggestedTools : [],
      possibleParts: Array.isArray(assistant.possibleParts) ? assistant.possibleParts : [],
      inspectionChecklist: Array.isArray(assistant.inspectionChecklist) ? assistant.inspectionChecklist : [],
      probableCauses: Array.isArray(assistant.probableCauses) ? assistant.probableCauses : [],
      safetyReminders: Array.isArray(assistant.safetyReminders) ? assistant.safetyReminders : [],
      repairComplexity: assistant.repairComplexity || 'medium',
      repairApproach: assistant.repairApproach || 'scheduled',
      summary: assistant.summary || '',
      _source: assistant._source || 'fallback',
    };
  } catch (err) {
    console.warn('[AppointmentManagement] AI recommendation failed:', err.message);
    return { suggestedTools: [], possibleParts: [], inspectionChecklist: [], probableCauses: [], safetyReminders: [], repairComplexity: 'medium', repairApproach: 'scheduled', summary: '', _source: 'error' };
  }
}

/**
 * GET /api/admin/appointments/flow-stats
 * Dashboard overview: counts for each flow stage
 */
router.get('/flow-stats', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const stats = {};

    for (const [key, stage] of Object.entries(FlowStages)) {
      const count = await BookingService.countDocuments({ status: { $in: stage.statuses } });
      stats[key] = { ...stage, count };
    }

    const totalBookings = await BookingService.countDocuments();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const todayBookings = await BookingService.countDocuments({
      createdAt: { $gte: todayStart, $lte: todayEnd }
    });

    const revenueResult = await BookingService.aggregate([
      { $match: { status: BookingStatus.COMPLETED, paymentStatus: PaymentStatus.PAID } },
      { $group: { _id: null, total: { $sum: '$totalPrice' } } }
    ]);
    const totalRevenue = revenueResult[0]?.total || 0;

    const todayRevenue = await BookingService.aggregate([
      { $match: { status: BookingStatus.COMPLETED, paymentStatus: PaymentStatus.PAID, updatedAt: { $gte: todayStart, $lte: todayEnd } } },
      { $group: { _id: null, total: { $sum: '$totalPrice' } } }
    ]);
    const todayRevenueAmount = todayRevenue[0]?.total || 0;

    res.json({
      stages: stats,
      summary: {
        totalBookings,
        todayBookings,
        totalRevenue,
        todayRevenue: todayRevenueAmount,
      }
    });
  } catch (error) {
    console.error('❌ Error fetching flow stats:', error);
    res.status(500).json({ error: 'Failed to fetch flow stats' });
  }
});

/**
 * GET /api/admin/appointments/list
 * Unified list endpoint with stage filtering, search, pagination
 * Query: stage (pending_review|payment_verification|assignment_queue|active|completed|rejected|cancelled),
 *        status, search, page, limit, date, sort
 */
router.get('/list', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    let { stage, status, search = '', page = 1, limit = 20, date, sort = '-createdAt' } = req.query;
    page = parseInt(page);
    limit = Math.min(parseInt(limit) || 20, 100);

    let query = {};

    // Stage-based filtering
    const stageAlias = { 'active': 'ACTIVE_JOBS' };
    const stageKey = stageAlias[(stage || '').toLowerCase()] || (stage || '').toUpperCase();
    if (stageKey && FlowStages[stageKey]) {
      query.status = { $in: FlowStages[stageKey].statuses };
    } else if (status) {
      // Support comma-separated statuses (e.g., "awaiting_assignment,pending_reassignment")
      const statusList = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statusList.length > 1) {
        query.status = { $in: statusList };
      } else {
        query.status = statusList[0] || status;
      }
    }

    // Date filter
    if (date) {
      const d = new Date(date);
      const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(d); dayEnd.setHours(23, 59, 59, 999);
      query.bookingDate = { $gte: dayStart, $lte: dayEnd };
    }

    // Search
    if (search) {
      query.$or = [
        { bookingReference: { $regex: search, $options: 'i' } },
        { 'customer.name': { $regex: search, $options: 'i' } },
        { 'customer.email': { $regex: search, $options: 'i' } },
        { 'customer.phone': { $regex: search, $options: 'i' } },
        { 'service.name': { $regex: search, $options: 'i' } },
      ];
    }

    const total = await BookingService.countDocuments(query);
    const bookings = await BookingService.find(query)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      bookings,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      }
    });
  } catch (error) {
    console.error('❌ Error fetching appointment list:', error);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
});

/**
 * GET /api/admin/appointments/cancellation-log
 * Returns bookings that have been cancelled/declined by technicians with history
 * Query: escalated (true/false), search, page, limit
 */
router.get('/cancellation-log', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    let { escalated, search = '', page = 1, limit = 20 } = req.query;
    page = parseInt(page);
    limit = Math.min(parseInt(limit) || 20, 100);

    let query = { reassignmentCount: { $gt: 0 } };
    if (escalated === 'true') {
      query.$or = [{ escalated: true }, { reassignmentCount: { $gte: 3 } }];
    }

    if (search) {
      query.$or = [
        { bookingReference: { $regex: search, $options: 'i' } },
        { 'customer.name': { $regex: search, $options: 'i' } },
        { 'customer.phone': { $regex: search, $options: 'i' } },
        { 'cancellationHistory.technicianName': { $regex: search, $options: 'i' } },
      ];
    }

    const total = await BookingService.countDocuments(query);
    const bookings = await BookingService.find(query)
      .sort({ reassignmentCount: -1, updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    res.json({
      bookings,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('❌ Error fetching cancellation log:', error);
    res.status(500).json({ error: 'Failed to fetch cancellation log' });
  }
});

/**
 * POST /api/admin/appointments/:id/verify-payment
 * Admin verifies payment and moves to assignment queue
 */
router.post('/:id/verify-payment', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== BookingStatus.PENDING) {
      return res.status(400).json({ error: `Cannot verify payment for booking in "${booking.status}" status` });
    }

    const totalAmount = booking.totalPrice || booking.estimatedFee || 0;
    const isCOD = booking.paymentMethod === 'cod';

    if (isCOD) {
      // COD: only downpayment is collected now; balance collected by technician after service
      const downpayment = booking.downpaymentAmount || 400;
      booking.paymentStatus = 'partial';
      booking.amountPaid = downpayment;
      booking.balanceAmount = Math.max(0, totalAmount - downpayment);
      booking.balanceCollected = false;
    } else {
      // GCash or other: full amount paid upfront
      booking.paymentStatus = 'paid';
      booking.amountPaid = totalAmount;
      booking.balanceAmount = 0;
    }

    booking.status = BookingStatus.PAYMENT_VERIFIED;
    booking.paymentVerifiedAt = new Date();
    booking.paymentVerifiedBy = req.user._id;
    if (req.body.notes) booking.notes = req.body.notes;
    await booking.save();

    // Update payment record
    const paymentUpdateData = isCOD
      ? { status: 'partial', verifiedAt: new Date(), verifiedBy: req.user._id, amount: booking.downpaymentAmount || 400 }
      : { status: 'paid', verifiedAt: new Date(), verifiedBy: req.user._id };
    await Payment.findOneAndUpdate({ bookingId: booking._id }, paymentUpdateData);

    console.log(`✅ Payment verified for booking ${booking.bookingReference} (${isCOD ? 'COD - downpayment only' : 'full'})`);

    // Create notification
    const { createNotification } = require('../utils/notify');
    const io = req.app.get('io');
    const notifMessage = isCOD
      ? `Downpayment for booking ${booking.bookingReference} verified. Balance of ₱${booking.balanceAmount.toLocaleString()} to be collected on-site.`
      : `Payment for booking ${booking.bookingReference} verified (full amount).`;
    await createNotification({
      type: 'payment_verified',
      title: 'Payment Verified',
      message: notifMessage,
      role: 'admin',
      referenceId: booking._id,
      referenceModel: 'BookingService',
      link: '/admin/appointments/pending',
      io,
    });

    res.json({ success: true, booking, isCOD, balanceAmount: booking.balanceAmount });
  } catch (error) {
    console.error('❌ Error verifying payment:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

/**
 * POST /api/admin/appointments/:id/move-to-queue
 * Move payment-verified booking to assignment queue
 */
router.post('/:id/move-to-queue', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== BookingStatus.PAYMENT_VERIFIED) {
      return res.status(400).json({ error: `Cannot move to queue from "${booking.status}" status` });
    }

    booking.status = BookingStatus.AWAITING_ASSIGNMENT;
    await booking.save();

    console.log(`📋 Booking ${booking.bookingReference} moved to assignment queue`);
    res.json({ success: true, booking });
  } catch (error) {
    console.error('❌ Error moving to queue:', error);
    res.status(500).json({ error: 'Failed to move to queue' });
  }
});

/**
 * POST /api/admin/appointments/:id/assign
 * Assign technician to booking
 */
router.post('/:id/assign', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { technicianId, priority, notes } = req.body;
    if (!technicianId) return res.status(400).json({ error: 'Technician ID is required' });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const validAssignStatuses = [BookingStatus.AWAITING_ASSIGNMENT, BookingStatus.PENDING_REASSIGNMENT];
    if (!validAssignStatuses.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot assign technician from "${booking.status}" status` });
    }

    // ── Safety: reject if technician already has a booking at this time ──
    {
      function _parseMin(v) {
        if (v === null || v === undefined) return NaN;
        const r = String(v).trim();
        if (!r) return NaN;
        if (/^\d{1,4}$/.test(r)) return Number(r);
        const hm = r.match(/^(\d{1,2}):(\d{2})$/);
        if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
        const ap = r.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
        if (ap) { let hh = Number(ap[1]) % 12; if (ap[3].toUpperCase() === 'PM') hh += 12; return hh * 60 + Number(ap[2]); }
        return NaN;
      }
      function _endMin(b) {
        const s = _parseMin(b.startTime);
        const e = _parseMin(b.endTime);
        if (Number.isFinite(e) && e > s) return e;
        const dur = Number(b.serviceDurationMinutes) || 60;
        const trv = Math.max(0, Number(b.travelTime) || 0);
        if (!Number.isFinite(s)) return NaN;
        return s + dur + trv + 30;
      }
      const tStart = _parseMin(booking.startTime);
      const tEnd = _endMin(booking);
      if (Number.isFinite(tStart) && Number.isFinite(tEnd)) {
        const dayS = new Date(booking.bookingDate); dayS.setHours(0, 0, 0, 0);
        const dayE = new Date(booking.bookingDate); dayE.setHours(23, 59, 59, 999);
        const conflict = await BookingService.findOne({
          _id: { $ne: booking._id },
          technicianId,
          bookingDate: { $gte: dayS, $lte: dayE },
          status: { $in: ['pending', 'payment_verified', 'awaiting_assignment', 'assigned', 'pending_reassignment', 'confirmed', 'scheduled', 'on-the-way', 'arrived', 'in-progress', 'ongoing', 'repair_requested', 'inspection_scheduled', 'inspection_in_progress', 'repair_approved', 'ready_for_repair', 'repair_scheduled', 'repair_in_progress'] },
        }).lean();
        if (conflict) {
          const cStart = _parseMin(conflict.startTime);
          const cEnd = _endMin(conflict);
          if (Number.isFinite(cStart) && Number.isFinite(cEnd) && tStart < cEnd && tEnd > cStart) {
            return res.status(409).json({ error: 'This technician already has a booking that overlaps this time slot.' });
          }
        }
      }
    }

    // Compute acceptance deadline
    function calculateAcceptanceDeadline(bookingDate, assignedAt) {
      const now = new Date(assignedAt || new Date());
      const bd = new Date(bookingDate);
      const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
      const startOfBooking = new Date(bd); startOfBooking.setHours(0, 0, 0, 0);
      const daysUntil = Math.round((startOfBooking - startOfToday) / (1000 * 60 * 60 * 24));
      if (daysUntil <= 0) return new Date(now.getTime() + 30 * 60 * 1000);
      if (daysUntil === 1) {
        const today6pm = new Date(now); today6pm.setHours(18, 0, 0, 0);
        if (today6pm > now) return today6pm;
        return new Date(now.getTime() + 30 * 60 * 1000);
      }
      return new Date(now.getTime() + 12 * 60 * 60 * 1000);
    }

    // Validate selected equipment stock before creating assignment
    const equipmentItems = [];
    if (Array.isArray(req.body.equipment) && req.body.equipment.length > 0) {
      for (const item of req.body.equipment) {
        if (!item.equipmentId || !item.quantity || !mongoose.Types.ObjectId.isValid(item.equipmentId)) continue;
        const tool = await Tool.findById(item.equipmentId);
        if (!tool) continue;
        const available = (tool.quantity || 0) - (tool.reservedQuantity || 0);
        if (item.quantity > available) {
          return res.status(400).json({ error: `Insufficient stock for ${tool.itemName}: requested ${item.quantity}, available ${available}` });
        }
        equipmentItems.push({ tool, quantity: item.quantity, notes: item.notes || '' });
      }
    }

    // ── Auto-generate AI recommendations for repair service assignments ──
    const isRepair = booking.serviceModel === "RepairService" || booking.serviceType === "repair";
    let aiRecommendations = null;
    if (isRepair) {
      aiRecommendations = await generateRepairRecommendations(booking);
    }
    if (isRepair && equipmentItems.length === 0) {
      // Load all active tool inventory for matching
      const toolInventory = await Tool.find({ active: true }).lean();
      let wanted = [];
      if (aiRecommendations && Array.isArray(aiRecommendations.suggestedTools) && aiRecommendations.suggestedTools.length > 0) {
        wanted = aiRecommendations.suggestedTools
          .map(t => (typeof t === 'string' ? t : t?.name || t?.tool || '').toLowerCase().trim())
          .filter(Boolean);
      }
      // Fallback to common inspection-tool keywords if AI produced nothing usable
      if (wanted.length === 0) {
        wanted = ['multimeter', 'clamp', 'ladder', 'tool kit', 'toolkit', 'gauge', 'vacuum pump', 'leak detector', 'thermometer', 'flashlight', 'screwdriver', 'wrench'];
      }
      const matchedTools = [];
      for (const name of wanted) {
        const words = name.split(/\s+/).filter(w => w.length > 2);
        if (words.length === 0) continue;
        const scored = toolInventory
          .filter(tool => {
            const text = `${tool.itemName} ${tool.category || ''} ${tool.description || ''} ${tool.specification || ''}`.toLowerCase();
            return words.some(w => text.includes(w));
          })
          .map(tool => {
            const text = `${tool.itemName} ${tool.category || ''} ${tool.description || ''} ${tool.specification || ''}`.toLowerCase();
            const score = words.reduce((s, w) => text.includes(w) ? s + 1 : s, 0);
            const available = Math.max(0, (tool.quantity || 0) - (tool.reservedQuantity || 0));
            return { tool, score, available };
          })
          .filter(x => x.available >= 1)
          .sort((a, b) => b.score - a.score);
        const best = scored[0];
        if (best && !matchedTools.some(m => String(m.tool._id) === String(best.tool._id))) {
          matchedTools.push(best);
        }
      }
      const kit = matchedTools.slice(0, 6);
      for (const { tool } of kit) {
        equipmentItems.push({ tool, quantity: 1, notes: 'Auto-assigned inspection kit' });
      }
      console.log(`[Assignment] Auto-assigned ${kit.length} tools for repair booking ${booking.bookingReference}: ${kit.map(k => k.tool.itemName).join(', ') || 'none'}`);
      if (kit.length === 0) {
        console.warn(`[Assignment] No active tools matched for repair booking ${booking.bookingReference}; cannot auto-assign inspection kit. Inventory count: ${toolInventory.length}`);
      }
    }

    // Create assignment
    const slaDeadline = new Date();
    slaDeadline.setHours(slaDeadline.getHours() + 2);
    const acceptanceDeadline = req.body.acceptanceDeadline ? new Date(req.body.acceptanceDeadline) : calculateAcceptanceDeadline(booking.bookingDate);

    const assignment = new Assignment({
      bookingId: booking._id,
      technicianId,
      customerName: booking.customer?.name || '',
      customerPhone: booking.customer?.phone || '',
      customerEmail: booking.customer?.email || '',
      serviceName: booking.service?.name || '',
      serviceType: booking.serviceType || (booking.serviceModel === "RepairService" ? "repair" : "core"),
      servicePrice: booking.totalPrice || booking.estimatedFee || 0,
      bookingDate: booking.bookingDate,
      startTime: booking.startTime || '',
      endTime: booking.endTime || '',
      address: booking.location?.address || '',
      priority: priority || 'normal',
      slaDeadline,
      acceptanceDeadline,
      estimatedFee: booking.totalPrice || booking.estimatedFee || 0,
      status: 'pending_acceptance',
    });
    assignment.notes.push({ text: notes || 'Assigned by admin', by: req.user._id, byName: req.user.name || req.user.email });
    await assignment.save();

    // Update booking
    // For repair bookings, set to inspection_scheduled instead of assigned
    const previousStatus = booking.status;
    booking.status = isRepair ? BookingStatus.INSPECTION_SCHEDULED : BookingStatus.ASSIGNED;
    booking.technicianId = technicianId;
    booking.assignedAt = new Date();
    booking.assignedBy = req.user._id;
    booking.assignmentId = assignment._id;

    if (isRepair) {
      booking.recordStatusHistory({
        fromStatus: previousStatus,
        toStatus: "inspection_scheduled",
        reason: "Technician assigned for inspection via Assignment Queue",
        changedBy: req.user._id,
        changedByModel: "User",
        changedByName: req.user.name || req.user.email || "Admin",
      });
      if (aiRecommendations) {
        booking.aiRecommendations = aiRecommendations;
      }
    }
    await booking.save();

    // Create equipment assignments
    const equipmentAssignments = [];
    for (const { tool, quantity, notes } of equipmentItems) {
      const eqAssignment = new EquipmentAssignment({
        bookingId: booking._id,
        technicianId,
        workDate: booking.bookingDate || new Date(),
        equipmentId: tool._id,
        equipmentName: tool.itemName,
        equipmentCode: tool.barcode || '',
        quantity,
        status: 'reserved',
        notes,
        issuedBy: req.user._id,
        issuedAt: new Date(),
      });
      await eqAssignment.save();
      // Use updateOne instead of tool.save() — tool may be a lean object
      await Tool.updateOne(
        { _id: tool._id },
        { $inc: { reservedQuantity: quantity } }
      );
      equipmentAssignments.push(eqAssignment);
    }

    // Update technician availability
    const Technician = require('../models/Technician');
    const { resolveAvailabilityStatus } = require('../utils/availability');
    const freshTech = await Technician.findById(technicianId);
    if (freshTech) {
      freshTech.availabilityStatus = "Assigned";
      const resolvedStatus = await resolveAvailabilityStatus(freshTech, null, null, { syncDb: false });
      await Technician.findByIdAndUpdate(technicianId, { availabilityStatus: resolvedStatus });
    }

    // Emit socket notification
    const io = req.app.get('io');
    if (io) {
      io.to(`tech:${technicianId}`).emit('assignment:new', {
        bookingId: booking._id,
        bookingReference: booking.bookingReference,
        serviceName: booking.service?.name,
        customerName: booking.customer?.name,
        bookingDate: booking.bookingDate,
        priority,
      });
    }

    // Create notification for technician
    const { createNotification } = require('../utils/notify');
    const tech = await Technician.findById(technicianId).lean();
    await createNotification({
      type: 'assignment_new',
      title: 'New Assignment',
      message: `You have been assigned to ${booking.service?.name || 'a service'} for ${booking.customer?.name || 'a customer'} on ${new Date(booking.bookingDate).toLocaleDateString()}.`,
      userId: technicianId,
      role: 'technician',
      referenceId: assignment._id,
      referenceModel: 'Assignment',
      link: '/technician/assignments',
      priority: priority === 'urgent' ? 'urgent' : 'high',
      io,
    });

    // ── Email: Notify Technician of Assignment ─────────────────────────────
    try {
      const Technician = require('../models/Technician');
      const User = require('../models/User');
      const { sendTechnicianNotificationEmail } = require('../utils/mailer');
      const tech = await Technician.findById(technicianId).lean();
      const techUser = tech ? await User.findById(tech.user).lean() : null;
      const techEmail = techUser?.email;
      const techName = tech ? ((tech.firstName || '') + ' ' + (tech.lastName || '')).trim() || techUser?.name || 'Technician' : 'Technician';

      if (techEmail) {
        const dateLabel = booking.bookingDate ? new Date(booking.bookingDate).toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'TBD';
        const timeLabel = booking.startTime || 'TBD';
        sendTechnicianNotificationEmail({
          to: techEmail,
          technicianName: techName,
          customerName: booking.customer?.name || 'Customer',
          bookingReference: booking.bookingReference || `#${String(booking._id).slice(-6).toUpperCase()}`,
          serviceName: booking.service?.name || 'Service',
          dateLabel,
          timeLabel,
          totalLabel: `₱${Number(booking.totalPrice || booking.estimatedFee || 0).toLocaleString()}`,
          locationAddress: booking.location?.address || '',
          issueDescription: booking.issueDescription || '',
        }).catch(err => console.error('[MAILER] Failed to send assignment email:', err.message));
      }
    } catch (mailErr) {
      console.error('[MAILER] Assignment email error:', mailErr.message);
    }

    console.log(`👤 Technician ${technicianId} assigned to booking ${booking.bookingReference}`);
    res.json({ success: true, booking, assignment, equipment: equipmentAssignments, aiRecommendations });
  } catch (error) {
    console.error('❌ Error assigning technician:', error);
    res.status(500).json({ error: 'Failed to assign technician' });
  }
});

/**
 * GET /api/admin/appointments/:id/ai-recommendations
 * AI-generated parts, tools, and inspection checklist for a repair booking.
 */
router.get('/:id/ai-recommendations', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid booking ID' });
    }
    const booking = await BookingService.findById(req.params.id).lean();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.serviceModel !== 'RepairService') {
      return res.json({ serviceModel: booking.serviceModel, aiRecommendations: null });
    }
    const aiRecommendations = await generateRepairRecommendations(booking);
    res.json({ serviceModel: booking.serviceModel, aiRecommendations });
  } catch (error) {
    console.error('❌ Error generating AI recommendations:', error);
    res.status(500).json({ error: 'Failed to generate AI recommendations' });
  }
});

/**
 * POST /api/admin/appointments/:id/reject
 * Reject a pending booking
 */
router.post('/:id/reject', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { reason, note } = req.body;
    if (!reason) return res.status(400).json({ error: 'Rejection reason is required' });

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== BookingStatus.PENDING) {
      return res.status(400).json({ error: `Cannot reject booking in "${booking.status}" status` });
    }

    booking.status = BookingStatus.REJECTED;
    booking.rejectionReason = reason;
    booking.rejectionNote = note || '';
    booking.rejectedAt = new Date();
    booking.rejectedBy = req.user._id;
    await booking.save();

    console.log(`❌ Booking ${booking.bookingReference} rejected: ${reason}`);

    // Create notification
    const { createNotification } = require('../utils/notify');
    const io = req.app.get('io');
    await createNotification({
      type: 'booking_cancelled',
      title: 'Booking Rejected',
      message: `Booking ${booking.bookingReference} has been rejected. Reason: ${reason}`,
      role: 'admin',
      referenceId: booking._id,
      referenceModel: 'BookingService',
      link: '/admin/appointments/pending',
      io,
    });

    res.json({ success: true, booking });
  } catch (error) {
    console.error('❌ Error rejecting booking:', error);
    res.status(500).json({ error: 'Failed to reject booking' });
  }
});

/**
 * POST /api/admin/appointments/:id/cancel
 * Cancel a booking at any stage
 */
router.post('/:id/cancel', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { reason } = req.body;
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const terminalStatuses = [BookingStatus.COMPLETED, BookingStatus.CANCELLED];
    if (terminalStatuses.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot cancel booking in "${booking.status}" status` });
    }

    booking.status = BookingStatus.CANCELLED;
    booking.cancellationReason = reason || 'Cancelled by admin';
    await booking.save();

    console.log(`🚫 Booking ${booking.bookingReference} cancelled`);
    res.json({ success: true, booking });
  } catch (error) {
    console.error('❌ Error cancelling booking:', error);
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

/**
 * GET /api/admin/appointments/tools/available
 * List active inventory tools with available quantity and AI recommendations for a service.
 */
router.get('/tools/available', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const serviceName = String(req.query.serviceName || '').toLowerCase();
    const tools = await Tool.find({ active: true, isStockItem: true })
      .select('_id itemName category description specification unit quantity reservedQuantity barcode')
      .sort({ itemName: 1 })
      .lean();

    const prepared = tools.map((t) => {
      const availableQuantity = Math.max(0, (t.quantity || 0) - (t.reservedQuantity || 0));
      return { ...t, availableQuantity };
    });

    let recommended = [];
    if (serviceName) {
      const tokens = serviceName.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const conceptBoosts = [
        { keys: ['clean', 'cleaning', 'wash'], terms: ['cleaner', 'coil', 'fin', 'brush', 'filter', 'vacuum'] },
        { keys: ['repair', 'fix', 'troubleshoot'], terms: ['multimeter', 'gauge', 'refrigerant', 'leak', 'solder', 'vacuum pump', 'compressor'] },
        { keys: ['install', 'installation', 'mount'], terms: ['drill', 'mount', 'bracket', 'copper', 'pipe', 'insulation', 'level'] },
        { keys: ['gas', 'refrigerant', 'leak', 'refill'], terms: ['refrigerant', 'gas', 'gauge', 'vacuum pump', 'leak detector'] },
        { keys: ['maintenance', 'checkup', 'pm', 'preventive'], terms: ['cleaner', 'filter', 'fin', 'multimeter', 'gauge'] },
      ];

      const scored = prepared.map((t) => {
        const text = `${t.itemName} ${t.category || ''} ${t.description || ''} ${t.specification || ''}`.toLowerCase();
        let score = 0;
        tokens.forEach((tok) => {
          if (text.includes(tok)) score += 2;
        });
        conceptBoosts.forEach((c) => {
          if (c.keys.some((k) => serviceName.includes(k)) && c.terms.some((term) => text.includes(term))) score += 5;
        });
        if (t.availableQuantity <= 0) score -= 20;
        return { ...t, score };
      });

      scored.sort((a, b) => b.score - a.score);
      recommended = scored
        .filter((t) => t.score > 0)
        .slice(0, 5)
        .map((t) => {
          const { score, ...rest } = t;
          return { ...rest, reason: `Suggested for ${req.query.serviceName}` };
        });
    }

    res.json({ success: true, tools: prepared, recommended });
  } catch (error) {
    console.error('[TOOLS] Error fetching available tools:', error);
    res.status(500).json({ error: 'Failed to load tools' });
  }
});

/**
 * GET /api/admin/appointments/:id/eligible-technicians
 * Get technicians eligible for assignment
 */
router.get('/:id/eligible-technicians', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const Technician = require('../models/Technician');
    const TechnicianSchedule = require('../models/TechnicianSchedule');
    const LeaveRequest = require('../models/LeaveRequest');
    const BookingService = require('../models/BookingService');
    const Assignment = require('../models/Assignment');

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid booking id' });

    // ── Helper: parse time string to minutes since midnight ────────────────
    function parseMinuteVal(value) {
      if (value === null || value === undefined) return NaN;
      const raw = String(value).trim();
      if (!raw) return NaN;
      if (/^\d{1,4}$/.test(raw)) return Number(raw);
      const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
      if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
      const ampm = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (ampm) {
        let hh = Number(ampm[1]) % 12;
        if (ampm[3].toUpperCase() === 'PM') hh += 12;
        return hh * 60 + Number(ampm[2]);
      }
      return NaN;
    }

    function deriveEndMinutes(b) {
      const bStart = parseMinuteVal(b.startTime);
      const explicitEnd = parseMinuteVal(b.endTime);
      if (Number.isFinite(explicitEnd) && explicitEnd > bStart) return explicitEnd;
      const serviceDuration = Number(b.serviceDurationMinutes) || 60;
      const travelDuration = Math.max(0, Number(b.travelTime) || 0);
      if (!Number.isFinite(bStart)) return NaN;
      return bStart + serviceDuration + travelDuration + 30;
    }

    // ── 1. Fetch the booking to get its date, time slot, and location ─────
    const booking = await BookingService.findById(id)
      .select('bookingDate startTime endTime serviceDurationMinutes travelTime location bookingLocation')
      .lean();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const bookingDate = new Date(booking.bookingDate);
    bookingDate.setHours(0, 0, 0, 0);
    const dayOfWeek = bookingDate.getDay();

    const targetStartMin = parseMinuteVal(booking.startTime);
    const targetEndMin = deriveEndMinutes(booking);

    // ── 2. Fetch ALL active technicians ───────────────────────────────────
    const allTechs = await Technician.find({ active: true })
      .select('name phone email availabilityStatus rating location locationText')
      .sort({ name: 1 })
      .lean();

    if (allTechs.length === 0) {
      return res.json({ available: [], offlinePresent: [], total: 0 });
    }

    const techIds = allTechs.map(t => t._id);

    // ── 3. Batch-fetch schedules, leave records, active assignments, and
    //        existing bookings on the same date for overlap checking ────────
    const dayEnd = new Date(bookingDate);
    dayEnd.setHours(23, 59, 59, 999);

    const [schedules, leaveRecords, activeAssignments, existingBookings] = await Promise.all([
      TechnicianSchedule.find({ technicianId: { $in: techIds } }).lean(),
      LeaveRequest.find({
        technicianId: { $in: techIds },
        status: 'approved',
        startDate: { $lte: bookingDate },
        endDate: { $gte: bookingDate },
      }).select('technicianId').lean(),
      Assignment.find({
        technicianId: { $in: techIds },
        status: { $in: ['pending_acceptance', 'accepted', 'en_route', 'on_site', 'in_progress'] },
      }).select('technicianId').lean(),
      // Fetch all bookings on the same date (active statuses) to check time overlaps
      Number.isFinite(targetStartMin) && Number.isFinite(targetEndMin)
        ? BookingService.find({
          _id: { $ne: id },
          bookingDate: { $gte: bookingDate, $lte: dayEnd },
          technicianId: { $in: techIds },
          status: {
            $in: [
              'pending', 'payment_verified', 'awaiting_assignment', 'assigned',
              'pending_reassignment', 'confirmed', 'scheduled',
              'on-the-way', 'arrived', 'in-progress', 'ongoing',
              'repair_requested', 'inspection_scheduled', 'inspection_in_progress',
              'repair_approved', 'ready_for_repair', 'repair_scheduled', 'repair_in_progress',
            ],
          },
        }).select('technicianId startTime endTime serviceDurationMinutes travelTime').lean()
        : Promise.resolve([]),
    ]);

    // Build lookup maps
    const scheduleMap = {};
    schedules.forEach(s => { scheduleMap[s.technicianId.toString()] = s; });

    const leaveTechIds = new Set(leaveRecords.map(lr => lr.technicianId.toString()));

    const workloadMap = {};
    activeAssignments.forEach(a => {
      const tid = a.technicianId.toString();
      workloadMap[tid] = (workloadMap[tid] || 0) + 1;
    });

    // Build overlap map: technicianId -> Set of reasons (time conflict)
    const overlapTechIds = new Set();
    if (Number.isFinite(targetStartMin) && Number.isFinite(targetEndMin)) {
      for (const eb of existingBookings) {
        const tid = eb.technicianId.toString();
        const ebStart = parseMinuteVal(eb.startTime);
        const ebEnd = deriveEndMinutes(eb);
        if (!Number.isFinite(ebStart) || !Number.isFinite(ebEnd) || ebEnd <= ebStart) continue;
        if (targetStartMin < ebEnd && targetEndMin > ebStart) {
          overlapTechIds.add(tid);
        }
      }
    }

    // ── 4. Filter technicians by eligibility criteria ─────────────────────
    const MAX_ACTIVE_ASSIGNMENTS = 3;

    const eligible = [];
    const ineligible = [];

    for (const tech of allTechs) {
      const tid = tech._id.toString();

      if (leaveTechIds.has(tid)) {
        ineligible.push({ ...tech, reason: 'On Leave' });
        continue;
      }

      const schedule = scheduleMap[tid];
      if (!schedule) {
        ineligible.push({ ...tech, reason: 'No Schedule' });
        continue;
      }

      const workingDay = schedule.workingDays?.find(wd => wd.dayOfWeek === dayOfWeek);
      const isNonWorkingWeekday = schedule.nonWorkingWeekdays?.some(nwd => nwd.dayOfWeek === dayOfWeek);
      if (!workingDay || isNonWorkingWeekday) {
        ineligible.push({ ...tech, reason: 'Not Working This Day' });
        continue;
      }

      const isRestDate = schedule.restDates?.some(rd => {
        const rdDate = new Date(rd.date);
        return rdDate.getFullYear() === bookingDate.getFullYear() &&
          rdDate.getMonth() === bookingDate.getMonth() &&
          rdDate.getDate() === bookingDate.getDate();
      });
      if (isRestDate) {
        ineligible.push({ ...tech, reason: 'Rest Day' });
        continue;
      }

      const currentWorkload = workloadMap[tid] || 0;
      if (currentWorkload >= MAX_ACTIVE_ASSIGNMENTS) {
        ineligible.push({ ...tech, reason: 'At Capacity', workload: currentWorkload });
        continue;
      }

      if (overlapTechIds.has(tid)) {
        ineligible.push({ ...tech, reason: 'Already Booked at This Time' });
        continue;
      }

      // Compute distance from booking location
      const bookingLat = booking.location?.lat || booking.bookingLocation?.lat || null;
      const bookingLng = booking.location?.lng || booking.bookingLocation?.lng || null;
      const techCoords = tech.location?.coordinates || null; // [lng, lat]
      let distanceKm = null;
      let etaMin = null;
      if (bookingLat && bookingLng && techCoords && techCoords.length === 2) {
        const R = 6371;
        const dLat = ((techCoords[1] - bookingLat) * Math.PI) / 180;
        const dLng = ((techCoords[0] - bookingLng) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos((bookingLat * Math.PI) / 180) * Math.cos((techCoords[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        distanceKm = Math.round(R * c * 10) / 10;
        etaMin = Math.max(10, Math.round(distanceKm * 3 + 5)); // ~3 min per km + 5 min buffer
      }

      eligible.push({
        ...tech,
        currentWorkload,
        availabilityStatus: tech.availabilityStatus || 'Offline',
        distanceKm,
        etaMin,
        bookingLat,
        bookingLng,
      });
    }

    // Sort by AI score — genuinely rank by best fit
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

    eligible.sort((a, b) => scoreTech(b) - scoreTech(a));

    const bookingLat = booking.location?.lat || booking.bookingLocation?.lat || null;
    const bookingLng = booking.location?.lng || booking.bookingLocation?.lng || null;

    return res.json({ available: eligible, offlinePresent: ineligible, total: eligible.length, bookingLat, bookingLng });
  } catch (error) {
    console.error('❌ Error fetching eligible technicians:', error);
    res.status(500).json({ error: 'Failed to fetch eligible technicians' });
  }
});

/**
 * GET /api/admin/appointments/waiting-acceptance
 * List bookings with status = assigned (waiting for technician acceptance)
 */
router.get('/waiting-acceptance/list', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const BookingService = require('../models/BookingService');
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { status: 'assigned' };
    const [bookings, total] = await Promise.all([
      BookingService.find(filter)
        .sort({ assignedAt: -1, bookingDate: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('technicianId', 'name phone email')
        .populate('assignmentId', 'acceptanceDeadline status assignedAt')
        .lean(),
      BookingService.countDocuments(filter),
    ]);

    res.json({
      bookings: bookings.map(b => ({
        _id: b._id,
        bookingReference: b.bookingReference,
        customer: b.customer,
        service: b.service,
        bookingDate: b.bookingDate,
        startTime: b.startTime,
        endTime: b.endTime,
        assignedAt: b.assignedAt,
        assignedBy: b.assignedBy,
        acceptanceDeadline: b.assignmentId?.acceptanceDeadline || null,
        assignmentId: b.assignmentId?._id || null,
        assignmentStatus: b.assignmentId?.status || null,
        technician: b.technicianId ? { _id: b.technicianId._id, name: b.technicianId.name, phone: b.technicianId.phone, email: b.technicianId.email } : null,
        address: b.location?.address || b.bookingLocation?.address || null,
        status: b.status,
      })),
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (error) {
    console.error('❌ Error fetching waiting-acceptance bookings:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

/**
 * POST /api/admin/appointments/assignments/:assignmentId/extend-deadline
 * Extend the acceptance deadline for a pending assignment.
 */
router.post('/assignments/:assignmentId/extend-deadline', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { assignmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) return res.status(400).json({ error: 'Invalid assignment id' });
    const { minutes = 60, newDeadline } = req.body;
    const assignment = await Assignment.findById(assignmentId);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    if (assignment.status !== 'pending_acceptance') return res.status(400).json({ error: 'Only pending acceptance can be extended' });
    const base = assignment.acceptanceDeadline ? new Date(assignment.acceptanceDeadline).getTime() : Date.now();
    const deadline = newDeadline ? new Date(newDeadline) : new Date(base + parseInt(minutes) * 60 * 1000);
    assignment.acceptanceDeadline = deadline;
    assignment.notes.push({
      text: `Acceptance deadline extended to ${deadline.toLocaleString()}`,
      by: req.user._id,
      byName: req.user.name || req.user.email,
      createdAt: new Date(),
    });
    await assignment.save();
    res.json({ success: true, assignment });
  } catch (error) {
    console.error('❌ Error extending deadline:', error);
    res.status(500).json({ error: 'Failed to extend deadline' });
  }
});

/**
 * POST /api/admin/appointments/:id/force-reassign
 * Admin forces reassignment by expiring the current assignment and resetting the booking.
 */
router.post('/:id/force-reassign', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid booking id' });
    const booking = await BookingService.findById(id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!['assigned', 'inspection_scheduled', 'pending_reassignment'].includes(booking.status)) {
      return res.status(400).json({ error: `Cannot reassign from "${booking.status}" status` });
    }

    const current = await Assignment.findOne({ bookingId: booking._id, status: { $in: ['pending_acceptance', 'accepted'] } });
    if (current) {
      current.status = 'expired';
      current.expiredAt = new Date();
      current.expiredReason = 'Reassigned by admin';
      current.notes.push({
        text: 'Reassigned by admin before acceptance',
        by: req.user._id,
        byName: req.user.name || req.user.email,
        createdAt: new Date(),
      });
      await current.save();
    }

    booking.recordStatusHistory({
      fromStatus: booking.status,
      toStatus: 'pending_reassignment',
      changedBy: req.user._id,
      changedByModel: 'User',
      changedByName: req.user.name || req.user.email,
      reason: 'Admin forced reassignment',
    });
    booking.status = 'pending_reassignment';
    booking.technicianId = null;
    booking.reassignmentCount = (booking.reassignmentCount || 0) + 1;
    await booking.save();

    const io = req.app.get('io');
    if (io) io.to('admin-room').emit('booking:status-change', { bookingId: booking._id, status: booking.status, reason: 'Admin forced reassignment' });

    res.json({ success: true, booking });
  } catch (error) {
    console.error('❌ Error force reassigning:', error);
    res.status(500).json({ error: 'Failed to reassign booking' });
  }
});

// ═══ EXPENSE MANAGEMENT ═══

/**
 * GET /api/admin/appointments/expenses
 * List all expenses with filtering
 */
router.get('/expenses/list', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    let { status, type, page = 1, limit = 20, search = '' } = req.query;
    page = parseInt(page);
    limit = Math.min(parseInt(limit) || 20, 100);

    let query = {};
    if (status) query.status = status;
    if (type) query.type = type;
    if (search) {
      query.$or = [
        { technicianName: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const total = await Expense.countDocuments(query);
    const expenses = await Expense.find(query)
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('bookingId', 'bookingReference customerName service bookingDate startTime')
      .lean();

    res.json({
      expenses,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('❌ Error fetching expenses:', error);
    res.status(500).json({ error: 'Failed to fetch expenses' });
  }
});

/**
 * POST /api/admin/appointments/expenses/:id/approve
 * Approve an expense
 */
router.post('/expenses/:id/approve', requireRole("admin"), async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ error: 'Expense not found' });
    if (expense.status !== 'pending') {
      return res.status(400).json({ error: `Expense already ${expense.status}` });
    }

    expense.status = 'approved';
    expense.approvedBy = req.user._id;
    expense.approvedAt = new Date();
    await expense.save();

    console.log(`✅ Expense ${expense._id} approved by ${req.user.name || req.user.email}`);

    // Create notification
    const { createNotification } = require('../utils/notify');
    const io = req.app.get('io');
    await createNotification({
      type: 'expense_approved',
      title: 'Expense Approved',
      message: `Expense for ${expense.description || 'a service'} has been approved.`,
      userId: expense.technicianId,
      role: 'technician',
      referenceId: expense._id,
      referenceModel: 'Expense',
      link: '/technician/expenses',
      io,
    });

    res.json({ success: true, expense });
  } catch (error) {
    console.error('❌ Error approving expense:', error);
    res.status(500).json({ error: 'Failed to approve expense' });
  }
});

/**
 * POST /api/admin/appointments/expenses/:id/reject
 * Reject an expense
 */
router.post('/expenses/:id/reject', requireRole("admin"), async (req, res) => {
  try {
    const { reason } = req.body;
    const expense = await Expense.findById(req.params.id);
    if (!expense) return res.status(404).json({ error: 'Expense not found' });
    if (expense.status !== 'pending') {
      return res.status(400).json({ error: `Expense already ${expense.status}` });
    }

    expense.status = 'rejected';
    expense.rejectionReason = reason || 'Rejected by admin';
    expense.rejectedBy = req.user._id;
    expense.rejectedAt = new Date();
    await expense.save();

    console.log(`❌ Expense ${expense._id} rejected by ${req.user.name || req.user.email}`);

    // Create notification
    const { createNotification } = require('../utils/notify');
    const io = req.app.get('io');
    await createNotification({
      type: 'expense_rejected',
      title: 'Expense Rejected',
      message: `Expense for ${expense.description || 'a service'} has been rejected. ${expense.rejectionReason || ''}`,
      userId: expense.technicianId,
      role: 'technician',
      referenceId: expense._id,
      referenceModel: 'Expense',
      link: '/technician/expenses',
      io,
    });

    res.json({ success: true, expense });
  } catch (error) {
    console.error('❌ Error rejecting expense:', error);
    res.status(500).json({ error: 'Failed to reject expense' });
  }
});

/**
 * GET /api/admin/appointments/expenses/stats
 * Expense summary stats
 */
router.get('/expenses/stats', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

    const [pendingCount, approvedToday, totalPending, totalApproved] = await Promise.all([
      Expense.countDocuments({ status: 'pending' }),
      Expense.countDocuments({ status: 'approved', approvedAt: { $gte: today, $lte: todayEnd } }),
      Expense.aggregate([
        { $match: { status: 'pending' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Expense.aggregate([
        { $match: { status: 'approved', approvedAt: { $gte: today, $lte: todayEnd } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
    ]);

    res.json({
      pendingCount,
      approvedToday,
      totalPending: totalPending[0]?.total || 0,
      totalApprovedToday: totalApproved[0]?.total || 0,
    });
  } catch (error) {
    console.error('❌ Error fetching expense stats:', error);
    res.status(500).json({ error: 'Failed to fetch expense stats' });
  }
});

/**
 * GET /api/admin/appointments/:id
 * Get full booking details for admin view
 */
router.get('/:id', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const booking = await BookingService.findById(req.params.id)
      .populate('technicianId', 'firstName lastName phone location')
      .lean();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    let assignment = null;
    if (booking.assignmentId) {
      assignment = await Assignment.findById(booking.assignmentId).lean();
    }

    let payment = null;
    payment = await Payment.findOne({ bookingId: booking._id }).lean();

    // Attach technician current location for tracking
    let technicianLocation = null;
    if (booking.technicianId && booking.technicianId.location &&
      booking.technicianId.location.coordinates &&
      booking.technicianId.location.coordinates.length === 2) {
      technicianLocation = {
        lat: booking.technicianId.location.coordinates[1],
        lng: booking.technicianId.location.coordinates[0]
      };
    }

    res.json({ booking, assignment, payment, technicianLocation });
  } catch (error) {
    console.error('❌ Error fetching booking detail:', error);
    res.status(500).json({ error: 'Failed to fetch booking detail' });
  }
});

/**
  * GET /api/admin/appointments/waiting-reassignment/list
  * List bookings in pending_reassignment status needing reassignment
  */
 router.get('/waiting-reassignment/list', requireRole(['admin', 'secretary']), async (req, res) => {
   try {
     const { page = 1, limit = 20, search = '' } = req.query;
     const skip = (parseInt(page) - 1) * parseInt(limit);

     const filter = { status: BookingStatus.PENDING_REASSIGNMENT };

     if (search) {
       filter.$or = [
         { bookingReference: { $regex: search, $options: 'i' } },
         { 'customer.name': { $regex: search, $options: 'i' } },
         { 'customer.phone': { $regex: search, $options: 'i' } },
         { 'service.name': { $regex: search, $options: 'i' } },
       ];
     }

     const total = await BookingService.countDocuments(filter);
     const bookings = await BookingService.find(filter)
       .sort({ reassignmentCount: -1, updatedAt: -1 })
       .skip(skip)
       .limit(parseInt(limit))
       .populate('technicianId', 'name phone email')
       .lean();

     res.json({
       bookings: bookings.map((b) => ({
         _id: b._id,
         bookingReference: b.bookingReference,
         customer: b.customer,
         service: b.service,
         bookingDate: b.bookingDate,
         startTime: b.startTime,
         endTime: b.endTime,
         reassignmentCount: b.reassignmentCount || 0,
         cancellationHistory: b.cancellationHistory || [],
         technician: b.technicianId
           ? {
               _id: b.technicianId._id,
               name: b.technicianId.name,
               phone: b.technicianId.phone,
               email: b.technicianId.email,
             }
           : null,
         address: b.location?.address || b.bookingLocation?.address || null,
         status: b.status,
       })),
       pagination: {
         page: parseInt(page),
         limit: parseInt(limit),
         total,
         pages: Math.ceil(total / parseInt(limit)),
       },
     });
   } catch (error) {
     console.error('Error fetching waiting-reassignment bookings:', error);
     res.status(500).json({ error: 'Failed to fetch waiting reassignment bookings' });
   }
 });

 /**
  * POST /api/admin/appointments/:id/auto-assign
  * Auto-assign a pending_reassignment booking to a vacant technician
  */
 router.post('/:id/auto-assign', requireRole(['admin', 'secretary']), async (req, res) => {
   try {
     const { id } = req.params;
     if (!mongoose.Types.ObjectId.isValid(id)) {
       return res.status(400).json({ error: 'Invalid booking id' });
     }

     const booking = await BookingService.findById(id);
     if (!booking) {
       return res.status(404).json({ error: 'Booking not found' });
     }

     if (booking.status !== BookingStatus.PENDING_REASSIGNMENT) {
       return res
         .status(400)
         .json({ error: `Booking is in "${booking.status}" status, not pending_reassignment` });
     }

     const result = await (require('../utils/autoAssignment').autoAssignBooking(id));

     if (result.success) {
       // Emit socket notification for the new assignment
       const io = req.app.get('io');
       if (io && result.technician) {
         io.to(`tech:${result.technician._id}`).emit('assignment:new', {
           bookingId: result.booking._id,
           bookingReference: result.booking.bookingReference,
           serviceName: result.booking.service?.name,
           customerName: result.booking.customer?.name,
           bookingDate: result.booking.bookingDate,
           priority: 'normal',
         });
       }

       console.log(
         `[AutoAssign] Booking ${booking.bookingReference} auto-assigned to ${result.technician.name}`,
       );
     }

     res.json(result);
   } catch (error) {
     console.error('Error auto-assigning booking:', error);
     res.status(500).json({ error: 'Failed to auto-assign booking' });
   }
 });

 /**
  * POST /api/admin/appointments/:id/admin-reschedule
  * Admin-triggered reschedule for pending_reassignment bookings
  * Body: { newDate, newTime, notifyCustomer: boolean }
  */
 router.post('/:id/admin-reschedule', requireRole(['admin', 'secretary']), async (req, res) => {
   try {
     const { id } = req.params;
     const { newDate, newTime, notifyCustomer = true } = req.body;

     if (!newDate || !newTime) {
       return res
         .status(400)
         .json({ error: 'newDate and newTime are required' });
     }

     const booking = await BookingService.findById(id);
     if (!booking) {
       return res.status(404).json({ error: 'Booking not found' });
     }

     if (booking.status !== BookingStatus.PENDING_REASSIGNMENT) {
       return res
         .status(400)
         .json({ error: `Cannot reschedule booking in "${booking.status}" status` });
     }

     const newDateObj = new Date(newDate);
     newDateObj.setHours(0, 0, 0, 0);

     // Conflict check
     const conflict = await BookingService.findOne({
       _id: { $ne: id },
       bookingDate: newDateObj,
       startTime: newTime,
       status: {
         $in: [
           'pending', 'payment_verified', 'awaiting_assignment', 'assigned',
           'pending_reassignment', 'confirmed', 'scheduled', 'on-the-way',
           'arrived', 'in-progress', 'ongoing', 'repair_requested',
           'inspection_scheduled', 'inspection_in_progress', 'repair_approved',
           'ready_for_repair', 'repair_scheduled', 'repair_in_progress',
         ],
       },
     }).lean();

     if (conflict) {
       return res
         .status(409)
         .json({ error: 'This date and time slot is already booked by another appointment' });
     }

     // Transition booking to re-scheduled
     const previousStatus = booking.status;
     booking.status = BookingStatus.RESCHEDULED;
     booking.bookingDate = newDateObj;
     booking.startTime = newTime;
     booking.selectedTimeLabel = newTime;
     booking.rescheduleReason = `Admin-rescheduled due to technician unavailability. Previous status: ${previousStatus}`;
     booking.reassignmentCount = (booking.reassignmentCount || 0) + 1;
     booking.cancellationHistory.push({
       technicianId: booking.technicianId,
       technicianName: booking.technician?.name || 'Unknown',
       action: 'reassigned',
       reason: 'Admin rescheduled due to technician unavailability',
       timestamp: new Date(),
     });
     await booking.save();

     // Update assignment if exists
     if (booking.assignmentId) {
       await Assignment.findByIdAndUpdate(booking.assignmentId, {
         status: 'cancelled',
         cancelledAt: new Date(),
         notes: 'Cancelled due to admin reschedule',
       });
     }

     // Record status history
     booking.recordStatusHistory({
       fromStatus: previousStatus,
       toStatus: BookingStatus.RESCHEDULED,
       reason: 'Admin rescheduled due to technician unavailability',
       changedBy: req.user._id,
       changedByModel: 'User',
       changedByName: req.user.name || req.user.email || 'Admin',
     });

     // Notify customer via socket
     const io = req.app.get('io');
     if (io && booking.customerId) {
       io.to(`customer:${booking.customerId}`).emit('booking:rescheduled', {
         bookingId: booking._id,
         bookingReference: booking.bookingReference,
         newDate: newDateObj.toISOString(),
         newTime,
         message: 'Your appointment has been rescheduled by admin due to technician unavailability.',
       });
     }

     // Create notification for customer
     const { createNotification } = require('../utils/notify');
     if (notifyCustomer && booking.customerId) {
       await createNotification({
         type: 'booking_rescheduled',
         title: 'Appointment Rescheduled',
         message: `Your appointment for ${booking.service?.name || 'a service'} has been rescheduled to ${newDateObj.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' })} at ${newTime}.`,
         userId: booking.customerId,
         role: 'customer',
         referenceId: booking._id,
         referenceModel: 'BookingService',
         link: '/book-history',
         io,
       });
     }

     // Email customer about the reschedule
     if (notifyCustomer && booking.customer?.email) {
       try {
         const { sendRescheduleNotificationEmail } = require('../utils/mailer');
         const oldDateLabel = booking.bookingDate
           ? new Date(booking.bookingDate).toLocaleDateString('en-PH', {
               weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
             })
           : 'N/A';
         const newDateLabel = newDateObj.toLocaleDateString('en-PH', {
           weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
         });

         await sendRescheduleNotificationEmail({
           to: booking.customer.email,
           customerName: booking.customer?.name || 'Customer',
           bookingReference: booking.bookingReference || 'N/A',
           serviceName: booking.service?.name || 'N/A',
           oldDateLabel,
           oldTimeLabel: booking.startTime || 'N/A',
           newDateLabel,
           newTimeLabel: newTime,
           technicianName: booking.technician?.name || 'N/A',
           reason: 'Technician was unable to fulfill the original schedule.',
         }).catch((err) =>
           console.error('[MAILER] Failed to send reschedule notification email:', err.message),
         );
       } catch (mailErr) {
         console.error('[MAILER] Reschedule notification email error:', mailErr.message);
       }
     }

     console.log(`[Reschedule] Booking ${booking.bookingReference} rescheduled to ${newDateLabel} at ${newTime}`);

     res.json({
       success: true,
       booking,
       message: 'Booking rescheduled successfully',
     });
   } catch (error) {
     console.error('Error rescheduling booking:', error);
     res.status(500).json({ error: 'Failed to reschedule booking' });
   }
 });

 /**
  * POST /api/admin/appointments/:id/auto-assign-all
  * Auto-assign all pending_reassignment bookings that are eligible
  */
 router.post('/auto-assign-all', requireRole(['admin', 'secretary']), async (req, res) => {
   try {
     const result = await (require('../utils/autoAssignment').autoAssignAllPendingReassignments());
     res.json({
       success: true,
       results: result,
       message: `Processed ${result.length} pending reassignment bookings`,
     });
   } catch (error) {
     console.error('Error auto-assigning all pending reassignments:', error);
     res.status(500).json({ error: 'Failed to auto-assign pending reassignments' });
   }
 });


/**
 * GET /api/admin/appointments/waiting-reassignment/slots
 * Get available timeslots for reschedule on a given date
 * Query: date (YYYY-MM-DD), bookingId
 */
router.get('/waiting-reassignment/slots', requireRole(['admin', 'secretary']), async (req, res) => {
  try {
    const { date, bookingId } = req.query;
    if (!date) return res.status(400).json({ error: 'date parameter is required' });

    const targetDate = new Date(date + 'T00:00:00');
    const { generateTimeWindowsForDate } = require('../utils/enterpriseSchedulingEngine');
    const BookingService = require('../models/BookingService');
    const Technician = require('../models/Technician');
    const TechnicianSchedule = require('../models/TechnicianSchedule');

    // Fetch booking data for time/duration info
    let booking = null;
    let totalEstimatedMinutes = 60;
    let travelTime = 30;
    if (bookingId && mongoose.Types.ObjectId.isValid(bookingId)) {
      booking = await BookingService.findById(bookingId)
        .select('serviceDurationMinutes travelTime startTime endTime bookingDate')
        .lean();
      if (booking) {
        totalEstimatedMinutes = (Number(booking.serviceDurationMinutes) || 60) + (Number(booking.travelTime) || 30);
        travelTime = Number(booking.travelTime) || 30;
      }
    }

    const windows = await generateTimeWindowsForDate(targetDate, {
      totalEstimatedMinutes,
      travelTime,
    });

    // Format windows as slot options
    const slots = windows.map(w => ({
      value: w.start,
      label: w.start + ' – ' + w.end,
    }));

    res.json({
      success: true,
      date,
      slots,
      count: slots.length,
    });
  } catch (error) {
    console.error('Error generating reschedule slots:', error);
    res.status(500).json({ error: 'Failed to generate timeslots' });
  }
});

/**
 * GET /api/admin/appointments/equipment-assignments
 * List all equipment assignments for bookings
 */
router.get('/equipment-assignments', requireRole(['admin', 'secretary']), async (req, res) => {
  try {
    const { status = '', search = '', page = 1, limit = 20 } = req.query;
    const filter = { bookingId: { $exists: true, $ne: null } };
    if (status) filter.status = status;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [items, total] = await Promise.all([
      EquipmentAssignment.find(filter)
        .populate('bookingId', 'bookingReference customer service bookingDate startTime endTime technicianId')
        .populate('technicianId', 'name')
        .populate('equipmentId', 'itemName barcode')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      EquipmentAssignment.countDocuments(filter),
    ]);
    res.json({ assignments: items, pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) } });
  } catch (error) {
    console.error('Error fetching equipment assignments:', error);
    res.status(500).json({ error: 'Failed to fetch equipment assignments' });
  }
});

/**
 * GET /api/admin/appointments/equipment-bookings
 * Bookings with an assigned technician that need equipment
 */
router.get('/equipment-bookings', requireRole(['admin', 'secretary']), async (req, res) => {
  try {
    const { search = '', page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const statuses = ['assigned', 'accepted', 'confirmed', 'awaiting_assignment', 'waiting_acceptance'];
    const filter = { technicianId: { $exists: true, $ne: null }, status: { $in: statuses } };
    if (search) {
      filter.$or = [
        { bookingReference: { $regex: search, $options: 'i' } },
        { 'customer.name': { $regex: search, $options: 'i' } },
        { 'service.name': { $regex: search, $options: 'i' } },
      ];
    }
    const [bookings, total] = await Promise.all([
      BookingService.find(filter)
        .populate('technicianId', 'name phone')
        .sort({ bookingDate: 1, startTime: 1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      BookingService.countDocuments(filter),
    ]);
    const ids = bookings.map((b) => String(b._id));
    const assignments = await EquipmentAssignment.find({ bookingId: { $in: ids } }).select('bookingId status').lean();
    const counts = {};
    assignments.forEach((a) => {
      const key = String(a.bookingId);
      counts[key] = (counts[key] || 0) + 1;
    });
    const result = bookings.map((b) => ({ ...b, equipmentCount: counts[String(b._id)] || 0 }));
    res.json({ bookings: result, pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) } });
  } catch (error) {
    console.error('Error fetching equipment bookings:', error);
    res.status(500).json({ error: 'Failed to fetch equipment bookings' });
  }
});

/**
 * GET /api/admin/tools/available
 * Active in-stock tools for assignment
 */
router.get('/tools/available', requireRole(['admin', 'secretary']), async (req, res) => {
  try {
    const { search = '' } = req.query;
    const filter = { active: true, status: { $in: ['in_stock', 'low_stock'] } };
    if (search) filter.itemName = { $regex: search, $options: 'i' };
    const items = await Tool.find(filter).select('itemName unit quantity barcode status minStockLevel').sort({ itemName: 1 }).limit(200).lean();
    res.json({ tools: items });
  } catch (error) {
    console.error('Error fetching tools:', error);
    res.status(500).json({ error: 'Failed to fetch tools' });
  }
});

/**
 * POST /api/admin/appointments/:id/equipment
 * Assign a tool/equipment to a booking
 */
router.post('/:id/equipment', requireRole(['admin', 'secretary']), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid booking id' });
    const { equipmentId, quantity = 1, notes = '' } = req.body;
    if (!equipmentId || !mongoose.Types.ObjectId.isValid(equipmentId)) return res.status(400).json({ error: 'Equipment id is required' });
    const [booking, tool] = await Promise.all([
      BookingService.findById(id).populate('technicianId', 'name').lean(),
      Tool.findById(equipmentId).lean(),
    ]);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!booking.technicianId) return res.status(400).json({ error: 'Booking has no assigned technician' });
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    const requestedQty = Math.max(1, parseInt(quantity) || 1);
    if (tool.quantity < requestedQty) return res.status(400).json({ error: 'Insufficient stock for ' + tool.itemName });
    const assignment = await EquipmentAssignment.create({
      bookingId: booking._id,
      bookingReference: booking.bookingReference || '',
      technicianId: booking.technicianId._id || booking.technicianId,
      workDate: booking.bookingDate || new Date(),
      equipmentId: tool._id,
      equipmentName: tool.itemName,
      equipmentCode: tool.barcode || '',
      quantity: requestedQty,
      status: 'reserved',
      notes,
      issuedBy: req.user?.name || String(req.user?._id),
      issuedAt: new Date(),
    });
    res.status(201).json({ success: true, assignment });
  } catch (error) {
    console.error('Error assigning equipment:', error);
    res.status(500).json({ error: 'Failed to assign equipment' });
  }
});

/**
 * DELETE /api/admin/equipment-assignments/:assignmentId
 * Remove a reserved equipment assignment
 */
router.delete('/equipment-assignments/:assignmentId', requireRole(['admin', 'secretary']), async (req, res) => {
  try {
    const { assignmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) return res.status(400).json({ error: 'Invalid id' });
    const assignment = await EquipmentAssignment.findById(assignmentId);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    if (assignment.status !== 'reserved') return res.status(400).json({ error: 'Cannot remove a checked-out or returned assignment' });
    await assignment.deleteOne();
    res.json({ success: true, message: 'Equipment assignment removed' });
  } catch (error) {
    console.error('Error removing equipment assignment:', error);
    res.status(500).json({ error: 'Failed to remove equipment assignment' });
  }
});

module.exports = router;

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
const { calculatePaymentBreakdown } = require('../utils/paymentPolicy');
const { bookingReviewState, withBookingReviewState } = require('../utils/bookingReview');
const { expectedReturnForWorkDate } = require('../utils/equipmentReturnPolicy');
const { releaseReservedEquipment } = require('../utils/equipmentAssignmentLifecycle');
const { assignmentTimingState, isAssignmentWindowExpired, manilaDateKey, manilaDateTime } = require('../utils/bookingDateTime');
const { listSortStages, bookingPendingFilters } = require('../utils/operationsListPolicy');
const { BOOKING_PHOTO_FIELDS, ASSIGNMENT_PHOTO_FIELDS, PAYMENT_PHOTO_FIELDS,
  exclude, currentAssignment, bookingPhotos } = require('../utils/operationsDetail');

const { authenticate, requireRole } = require('../middleware/authenticate');
const { requirePermission } = require('../middleware/requirePermission');

router.use(authenticate);
router.use((req, res, next) => {
  if (req.user.role !== 'secretary') return next();
  const permission = ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    ? 'appointments.view'
    : 'appointments.manage';
  return requirePermission(permission)(req, res, next);
});

/** Build an explainable, non-mutating assignment plan for standard bookings. */
router.get('/assignment-plan', requireRole(['admin','secretary']), async (req,res) => {
  try {
    const statuses=String(req.query.status||'awaiting_assignment,pending_reassignment').split(',').filter(s=>['awaiting_assignment','pending_reassignment'].includes(s));
    const bookings=await BookingService.find({status:{$in:statuses.length?statuses:['awaiting_assignment','pending_reassignment']},isProject:{$ne:true}}).sort({bookingDate:1,startTime:1}).limit(200).lean();
    const {buildAssignmentPlan}=require('../utils/assignmentPlanner');
    const plan=await buildAssignmentPlan(bookings);
    res.json({plan,total:plan.length,assignable:plan.filter(p=>p.recommended).length,unmatched:plan.filter(p=>!p.recommended).length});
  } catch(error){console.error('[AssignmentPlan] preview failed:',error);res.status(500).json({error:'Failed to build assignment plan'});}
});

router.get('/:id/assignment-recommendation', requireRole(['admin','secretary']), async (req,res) => {
  try {
    if(!mongoose.Types.ObjectId.isValid(req.params.id))return res.status(400).json({error:'Invalid booking id'});
    const booking=await BookingService.findById(req.params.id).lean();
    if(!booking)return res.status(404).json({error:'Booking not found'});
    const {buildAssignmentPlan}=require('../utils/assignmentPlanner');
    const recommendation=(await buildAssignmentPlan([booking],{reservePlan:false}))[0];
    res.json({recommendation});
  }catch(error){console.error('[AssignmentPlan] recommendation failed:',error);res.status(500).json({error:'Failed to recommend technician'});}
});

/** Confirm only the assignments the admin reviewed; eligibility is rechecked. */
router.post('/assignment-plan/confirm', requireRole(['admin','secretary']), async (req,res) => {
  const rows=Array.isArray(req.body.assignments)?req.body.assignments:[];
  if(!rows.length)return res.status(400).json({error:'No reviewed assignments supplied'});
  const responseMinutes=Math.min(720,Math.max(5,Number(req.body.responseMinutes)||30));
  const {createReviewedAssignment}=require('../utils/assignmentPlanner');
  const {createNotification}=require('../utils/notify');
  const io=req.app.get('io'); const results=[]; const seen=new Set();
  for(const row of rows){
    if(!mongoose.Types.ObjectId.isValid(row.bookingId)||!mongoose.Types.ObjectId.isValid(row.technicianId)||seen.has(String(row.bookingId))){results.push({bookingId:row.bookingId,success:false,error:'Invalid or duplicate assignment'});continue;}
    seen.add(String(row.bookingId));
    try{
      const result=await createReviewedAssignment(row.bookingId,row.technicianId,req.user,responseMinutes);
      if(io)io.to(`tech:${result.technician._id}`).emit('assignment:new',{assignmentId:result.assignment._id,bookingId:result.booking._id,bookingReference:result.booking.bookingReference,serviceName:result.booking.service?.name,customerName:result.booking.customer?.name,bookingDate:result.booking.bookingDate,acceptanceDeadline:result.assignment.acceptanceDeadline});
      await createNotification({type:'assignment_new',title:'New Assignment',message:`You have a new ${result.booking.service?.name||'service'} booking. Accept within ${responseMinutes} minutes.`,userId:result.technician.user,role:'technician',referenceId:result.assignment._id,referenceModel:'Assignment',link:'/technician/assignments',io}).catch(()=>{});
      results.push({bookingId:row.bookingId,technicianId:row.technicianId,technicianName:result.technician.name,assignmentId:result.assignment._id,success:true});
    }catch(error){results.push({bookingId:row.bookingId,technicianId:row.technicianId,success:false,error:error.message});}
  }
  res.status(results.some(r=>r.success)?200:409).json({success:results.every(r=>r.success),assigned:results.filter(r=>r.success).length,failed:results.filter(r=>!r.success).length,results});
});

// â”€â”€ AI-driven repair recommendation helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
 * Dashboard overview: counts for each flow stage + individual status counts
 * Query: start (YYYY-MM-DD), end (YYYY-MM-DD) â€” optional date range filter
 */
router.get('/flow-stats', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { start, end } = req.query;

    // Build date filter if provided
    let dateFilter = {};
    if (start || end) {
      dateFilter.bookingDate = {};
      if (start) {
        const s = new Date(start); s.setHours(0, 0, 0, 0);
        dateFilter.bookingDate.$gte = s;
      }
      if (end) {
        const e = new Date(end); e.setHours(23, 59, 59, 999);
        dateFilter.bookingDate.$lte = e;
      }
    }

    // Collect the dashboard in one database round trip. The previous version
    // issued stage and status count queries sequentially, making this endpoint
    // dominate the Pending tab's load time as booking volume increased.
    const allStatuses = [
      'pending', 'awaiting_assignment', 'assigned', 'confirmed',
      'on-the-way', 'in-progress', 'completed', 'expired'
    ];
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const allCompletedStatuses = [
      BookingStatus.COMPLETED,
      BookingStatus.REPAIR_COMPLETED,
      BookingStatus.UNDER_WARRANTY,
      BookingStatus.WARRANTY_CLAIM,
    ];
    const revenueMatch = { status: { $in: allCompletedStatuses }, paymentStatus: PaymentStatus.PAID, ...dateFilter };
    const [dashboard = {}] = await BookingService.aggregate([{
      $facet: {
        filteredStatuses: [
          { $match: dateFilter },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ],
        todayBookings: [
          { $match: { createdAt: { $gte: todayStart, $lte: todayEnd } } },
          { $count: 'count' },
        ],
        allTimeBookings: [{ $count: 'count' }],
        filteredRevenue: [
          { $match: revenueMatch },
          { $group: { _id: null, total: { $sum: '$totalPrice' } } },
        ],
        totalRevenue: [
          { $match: { status: { $in: allCompletedStatuses }, paymentStatus: PaymentStatus.PAID } },
          { $group: { _id: null, total: { $sum: '$totalPrice' } } },
        ],
        todayRevenue: [
          { $match: { status: { $in: allCompletedStatuses }, paymentStatus: PaymentStatus.PAID, updatedAt: { $gte: todayStart, $lte: todayEnd } } },
          { $group: { _id: null, total: { $sum: '$totalPrice' } } },
        ],
        ratings: [
          { $match: { status: { $in: allCompletedStatuses }, customerRating: { $gt: 0 } } },
          { $group: { _id: null, avg: { $avg: '$customerRating' }, count: { $sum: 1 } } },
        ],
        pendingReviews: [
          { $match: { status: 'pending' } },
          { $project: { status: 1, bookingDate: 1, preferredDate: 1, preferredTime: 1, selectedTimeLabel: 1, startTime: 1, endTime: 1, serviceDurationMinutes: 1 } },
        ],
      },
    }]);

    const statusCountMap = new Map((dashboard.filteredStatuses || []).map(row => [row._id, row.count]));
    const totalBookings = [...statusCountMap.values()].reduce((sum, count) => sum + count, 0);
    const stats = Object.fromEntries(Object.entries(FlowStages).map(([key, stage]) => [
      key,
      { ...stage, count: stage.statuses.reduce((sum, status) => sum + (statusCountMap.get(status) || 0), 0) },
    ]));
    const statusCounts = Object.fromEntries(allStatuses.map(status => [status, statusCountMap.get(status) || 0]));
    const todayBookings = dashboard.todayBookings?.[0]?.count || 0;
    const allTimeBookings = dashboard.allTimeBookings?.[0]?.count || 0;
    const filteredRevenue = dashboard.filteredRevenue?.[0]?.total || 0;
    const totalRevenue = dashboard.totalRevenue?.[0]?.total || 0;
    const todayRevenueAmount = dashboard.todayRevenue?.[0]?.total || 0;
    const rating = dashboard.ratings?.[0];
    const avgRating = rating ? Math.round(rating.avg * 10) / 10 : null;
    const totalRatings = rating?.count || 0;

    res.json({
      stages: stats,
      statusCounts,
      summary: {
        totalBookings,
        allTimeBookings,
        todayBookings,
        totalRevenue,
        filteredRevenue,
        todayRevenue: todayRevenueAmount,
        avgRating,
        totalRatings,
        reviewOverdue: (dashboard.pendingReviews || []).filter(booking => bookingReviewState(booking).isReviewOverdue).length,
      }
    });
  } catch (error) {
    console.error('âŒ Error fetching flow stats:', error);
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
    let { stage, status, search = '', page = 1, limit = 20, date } = req.query;
    page = Math.max(1, parseInt(page, 10) || 1);
    limit = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));

    let query = {};

    // Stage-based filtering
    // "completed" includes both standard completed and repair-completed statuses
    const completedMergeAlias = { 'completed': ['COMPLETED', 'REPAIR_COMPLETED'] };
    const mergedStageKeys = completedMergeAlias[(stage || '').toLowerCase()];
    if (mergedStageKeys) {
      const mergedStatuses = mergedStageKeys.flatMap(k => FlowStages[k]?.statuses || []);
      query.status = { $in: mergedStatuses };
    } else {
      const stageAlias = { 'active': 'ACTIVE_JOBS' };
      const stageKey = stageAlias[(stage || '').toLowerCase()] || (stage || '').toUpperCase();
      if (stageKey && FlowStages[stageKey]) {
        query.status = { $in: FlowStages[stageKey].statuses };
      }
      // Exclude bookings from past dates in the active tab â€” these should
      // have been expired/rescheduled by the overdue scheduler.
      if (stageKey === 'ACTIVE_JOBS') {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        if (!query.bookingDate) {
          query.bookingDate = { $gte: todayStart };
        }
      }
    }
    if (!query.status && status) {
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
        { workOrderNumber: { $regex: search, $options: 'i' } },
        { 'customer.name': { $regex: search, $options: 'i' } },
        { 'customer.email': { $regex: search, $options: 'i' } },
        { 'customer.phone': { $regex: search, $options: 'i' } },
        { 'service.name': { $regex: search, $options: 'i' } },
        { 'services.name': { $regex: search, $options: 'i' } },
      ];
    }

    if (stage === 'pending_review') {
      const conditions = bookingPendingFilters(req.query);
      if (conditions.length) query.$and = conditions;
    }
    const sortKeys = { '-createdAt': 'newest', createdAt: 'oldest', '-bookingDate': 'date_desc', bookingDate: 'date_asc' };
    const sortKey = req.query.sort || (stage === 'pending_review' ? 'date_desc' : 'newest');
    const pipeline = [{ $match: query }, ...listSortStages('booking', sortKeys[sortKey] || sortKey),
      { $skip: (page - 1) * limit }, { $limit: limit }];
    if (req.query.compact === 'true') {
      const fields = [
        'bookingReference', 'workOrderNumber', 'status', 'preferredDate', 'bookingDate',
        'preferredTime', 'selectedTimeLabel', 'startTime', 'endTime', 'serviceDurationMinutes',
        'customer.name', 'customer.email', 'service.name',
        'services.name', 'services.type', 'services.brand', 'services.model',
        'services.hpDescription', 'services.hp', 'services.applianceTypeName', 'services.applianceType',
        'services.problemDescription', 'services.repairIssue',
        'serviceType', 'serviceModel',
        'totalPrice', 'estimatedFee', 'downpaymentAmount', 'paymentMethod', 'paymentStatus',
        'createdAt', 'updatedAt',
      ];
      pipeline.push({ $project: Object.fromEntries(fields.map(field => [field, 1])) });
    } else {
      pipeline.push({ $project: { _listDate: 0, _listUndated: 0, _listAmount: 0, completionProofFileId: 0 } });
    }
    const [total, bookings] = await Promise.all([
      BookingService.countDocuments(query),
      BookingService.aggregate(pipeline),
    ]);

    res.json({
      bookings: bookings.map(booking => ({
        ...withBookingReviewState(booking),
        assignmentTiming: assignmentTimingState(booking),
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      }
    });
  } catch (error) {
    console.error('âŒ Error fetching appointment list:', error);
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

    const conditions = [];

    // Technician cancellations/declines AND admin/system cancellations/auto-reschedules
    if (escalated === 'true') {
      conditions.push({ $or: [{ escalated: true }, { reassignmentCount: { $gte: 3 } }] });
    } else {
      // Any booking that has at least one cancellation-history entry,
      // or was reassigned at least once.
      conditions.push({
        $or: [
          { reassignmentCount: { $gt: 0 } },
          { "cancellationHistory.0": { $exists: true } },
        ],
      });
    }

    if (search) {
      const rx = { $regex: String(search), $options: 'i' };
      conditions.push({
        $or: [
          { bookingReference: rx },
          { workOrderNumber: rx },
          { 'customer.name': rx },
          { 'customer.phone': rx },
          { 'cancellationHistory.technicianName': rx },
        ],
      });
    }

    const query = conditions.length ? { $and: conditions } : {};

    const total = await BookingService.countDocuments(query);
    const bookings = await BookingService.find(query)
      .sort({ reassignmentCount: -1, updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('bookingReference workOrderNumber customer service serviceModel serviceType services bookingDate status reassignmentCount escalated cancellationHistory refundStatus refundAmount refundMethod paymentStatus totalPrice downpaymentAmount updatedAt')
      .lean();

    res.json({
      bookings,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('âŒ Error fetching cancellation log:', error);
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

    const isRepair = booking.serviceModel === "RepairService" ||
      booking.serviceType === "repair" ||
      booking.services?.some(item => item?.type === "repair");
    if (booking.status !== BookingStatus.PENDING) {
      return res.status(400).json({ error: `Cannot verify payment for booking in "${booking.status}" status` });
    }
    if (bookingReviewState(booking).isReviewOverdue) {
      return res.status(409).json({
        error: 'The requested schedule has passed. Contact the customer and reschedule before verifying this booking.',
        code: 'BOOKING_REVIEW_OVERDUE',
      });
    }

    const totalAmount = booking.totalPrice || booking.estimatedFee || 0;
    const isCOD = booking.paymentMethod === 'cod';

    if (isCOD) {
      // COD: only downpayment is collected now; balance collected by technician after service
      const downpayment = booking.downpaymentAmount || calculatePaymentBreakdown(totalAmount, booking.downpaymentPercentage).downpaymentAmount;
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

    booking.transitionStatus(BookingStatus.PAYMENT_VERIFIED, {
      changedBy: req.user._id,
      changedByModel: 'User',
      changedByName: req.user.name || req.user.email || 'Operations staff',
      reason: 'Payment verified',
    });
    booking.transitionStatus(BookingStatus.AWAITING_ASSIGNMENT, {
      changedBy: req.user._id,
      changedByModel: 'User',
      changedByName: req.user.name || req.user.email || 'Operations staff',
      reason: 'Payment verified; moved to assignment queue',
    });
    booking.paymentVerifiedAt = new Date();
    booking.paymentVerifiedBy = req.user._id;
    if (req.body.notes) booking.notes = req.body.notes;
    await booking.save();

    // Update payment record
    const paymentUpdateData = isCOD
      ? { status: 'partial', verifiedAt: new Date(), verifiedBy: req.user._id, amount: booking.downpaymentAmount || calculatePaymentBreakdown(totalAmount, booking.downpaymentPercentage).downpaymentAmount }
      : { status: 'paid', verifiedAt: new Date(), verifiedBy: req.user._id };
    await Payment.findOneAndUpdate({ bookingId: booking._id }, paymentUpdateData);

    console.log(`âœ… Payment verified for booking ${booking.bookingReference} (${isCOD ? 'COD - downpayment only' : 'full'})`);

    // Create notification
    const { createNotification } = require('../utils/notify');
    const io = req.app.get('io');
    const notifMessage = isCOD
      ? `Downpayment for booking ${booking.bookingReference} verified. Balance of â‚±${booking.balanceAmount.toLocaleString()} to be collected on-site.`
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
    }).catch(error => {
      // Notification delivery must not roll back a payment decision that has
      // already been saved and moved into the assignment queue.
      console.warn('[AppointmentManagement] Payment verification notification failed:', error.message);
    });

    res.json({
      success: true,
      booking,
      isCOD,
      balanceAmount: booking.balanceAmount,
      destination: 'assignment_queue',
    });
  } catch (error) {
    console.error('âŒ Error verifying payment:', error);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

/**
 * Replace an overdue requested schedule while preserving Pending Review.
 * Payment verification remains a separate admin decision.
 */
router.post('/:id/review-reschedule', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const { newDate, newTime, contactConfirmed, notes } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid booking id' });
    if (!newDate || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(newTime || ''))) {
      return res.status(400).json({ error: 'A valid new date and time are required.' });
    }
    if (contactConfirmed !== true) {
      return res.status(400).json({ error: 'Confirm that the customer agreed to the replacement schedule.' });
    }

    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== BookingStatus.PENDING) {
      return res.status(409).json({ error: `Only Pending Review bookings can use this reschedule action (current: "${booking.status}").` });
    }
    if (!bookingReviewState(booking).isReviewOverdue) {
      return res.status(409).json({ error: 'This booking is not overdue for review.' });
    }

    const dateParts = String(newDate).split('-').map(Number);
    const timeParts = String(newTime).split(':').map(Number);
    const replacementStart = new Date(dateParts[0], dateParts[1] - 1, dateParts[2], timeParts[0], timeParts[1], 0, 0);
    if (Number.isNaN(replacementStart.getTime()) || replacementStart.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'The replacement schedule must be in the future.' });
    }

    const originalDate = booking.preferredDate || booking.bookingDate;
    const originalStartTime = booking.preferredTime || booking.startTime || '';
    const durationMinutes = Math.max(30, Number(booking.serviceDurationMinutes) || 60);
    const replacementEnd = new Date(replacementStart.getTime() + durationMinutes * 60000);
    const pad = value => String(value).padStart(2, '0');

    booking.bookingDate = replacementStart;
    if (booking.preferredDate) booking.preferredDate = replacementStart;
    booking.startTime = newTime;
    booking.endTime = `${pad(replacementEnd.getHours())}:${pad(replacementEnd.getMinutes())}`;
    if (booking.preferredTime) booking.preferredTime = newTime;
    booking.selectedTimeLabel = `${newTime} - ${booking.endTime}`;
    booking.recordStatusHistory({
      fromStatus: BookingStatus.PENDING,
      toStatus: BookingStatus.PENDING,
      changedBy: req.user._id,
      changedByModel: 'User',
      changedByName: req.user.name || req.user.email || 'Admin',
      reason: 'Overdue review schedule replaced after customer contact',
      notes: String(notes || '').trim().slice(0, 1000),
      metadata: { originalDate, originalStartTime, replacementStart },
    });
    await booking.save();

    const io = req.app.get('io');
    const { createNotification } = require('../utils/notify');
    await createNotification({
      type: 'booking_rescheduled',
      title: 'Booking Schedule Updated',
      message: `Your requested service schedule for ${booking.bookingReference || 'your booking'} was updated to ${replacementStart.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}. The booking remains pending admin review.`,
      userId: booking.customerId,
      role: 'customer',
      referenceId: booking._id,
      referenceModel: 'BookingService',
      link: '/tracking',
      io,
    }).catch(() => {});

    res.json({
      success: true,
      booking: withBookingReviewState(booking.toObject()),
      message: 'Schedule updated. The booking remains Pending Review.',
    });
  } catch (error) {
    console.error('Failed to reschedule overdue pending review:', error);
    res.status(500).json({ error: 'Failed to update the requested schedule' });
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

    console.log(`ðŸ“‹ Booking ${booking.bookingReference} moved to assignment queue`);
    res.json({ success: true, booking });
  } catch (error) {
    console.error('âŒ Error moving to queue:', error);
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

    // Reject assignment of past bookings â€” require reschedule instead
    if (isAssignmentWindowExpired(booking)) {
      return res.status(400).json({
        error: 'The technician-assignment window has expired. Please reschedule this appointment before assigning.',
      });
    }

    // Repair bookings created by the multi-service flow are represented by
    // service items and may have serviceType="mixed". The old handler referred
    // to `isRepair` without declaring it in this scope, so repair assignment
    // always ended as a generic HTTP 500 response.
    const serviceItems = Array.isArray(booking.services) ? booking.services : [];
    const repairItems = serviceItems.filter(item => item?.type === 'repair');
    const isRepair = booking.serviceModel === 'RepairService' ||
      booking.serviceType === 'repair' ||
      repairItems.length > 0;
    const serviceName = booking.service?.name ||
      serviceItems.map(item => item?.name).filter(Boolean).join(', ') ||
      (isRepair ? 'Repair Inspection' : 'Service');

    const validAssignStatuses = [BookingStatus.AWAITING_ASSIGNMENT, BookingStatus.PENDING_REASSIGNMENT, BookingStatus.RESCHEDULED];
    if (!validAssignStatuses.includes(booking.status)) {
      return res.status(400).json({ error: `Cannot assign technician from "${booking.status}" status` });
    }

    // Server-side eligibility guard: the UI list is advisory, but schedule,
    // leave, capacity and overlap rules must still hold at confirmation time.
    const { buildAssignmentPlan } = require('../utils/assignmentPlanner');
    const eligibility = (await buildAssignmentPlan([booking], { reservePlan: false }))[0];
    if (!eligibility?.candidates?.some(c => c.technicianId === String(technicianId))) {
      const reason = eligibility?.exclusionReasons?.[String(technicianId)] || 'Not Available for This Booking';
      return res.status(409).json({ error: `Cannot assign this technician: ${reason}. Refresh the list and choose an available technician.` });
    }

    // â”€â”€ Safety: reject if technician already has a booking at this time â”€â”€
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
        const dayS = manilaDateTime(booking.bookingDate, 0);
        const dayE = manilaDateTime(booking.bookingDate, 24 * 60, -1);
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
      const todayKey = manilaDateKey(now);
      const bookingKey = manilaDateKey(bookingDate);
      const daysUntil = Math.round((Date.parse(bookingKey + 'T00:00:00Z') - Date.parse(todayKey + 'T00:00:00Z')) / (1000 * 60 * 60 * 24));
      if (daysUntil <= 0) return new Date(now.getTime() + 30 * 60 * 1000);
      if (daysUntil === 1) {
        const today6pm = manilaDateTime(now, 18 * 60);
        if (today6pm > now) return today6pm;
        return new Date(now.getTime() + 30 * 60 * 1000);
      }
      return new Date(now.getTime() + 12 * 60 * 60 * 1000);
    }

    // â”€â”€ Auto-generate AI recommendations for repair service assignments â”€â”€
    let aiRecommendations = null;
    if (isRepair) {
      aiRecommendations = await generateRepairRecommendations(booking);
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
      serviceName,
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
    booking.autoReschedulePending = false;
    booking.autoRescheduleAt = undefined;
    booking.autoRescheduleReason = undefined;

    if (isRepair) {
      // Keep the item-level lifecycle in sync for repair bookings created by
      // the newer multi-appliance form. Do not overwrite an item that already
      // has its own technician assignment.
      for (const item of repairItems) {
        if (item.technicianId && String(item.technicianId) !== String(technicianId)) continue;
        item.technicianId = technicianId;
        item.technicianName = eligibility.candidates.find(c => c.technicianId === String(technicianId))?.name || '';
        item.assignmentId = assignment._id;
        item.status = 'inspection_scheduled';
        item.phase = 'repair_phase_1';
        item.schedule = {
          date: booking.bookingDate,
          startTime: booking.startTime || '',
          endTime: booking.endTime || '',
          durationMinutes: Number(item.duration || booking.serviceDurationMinutes) || 60,
          kind: 'inspection',
        };
      }
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
    for (const { tool, quantity, notes, itemType } of []) {
      const legacyType = itemType || (tool.type === 'tool' ? 'equipment' : (tool.type || 'equipment'));
      const eqAssignment = new EquipmentAssignment({
        bookingId: booking._id,
        technicianId,
        workDate: booking.bookingDate || new Date(),
        equipmentId: tool._id,
        equipmentName: tool.itemName,
        equipmentCode: tool.barcode || '',
        quantity,
        consumable: legacyType === 'consumable',
        status: 'reserved',
        notes,
        issuedBy: req.user._id,
        issuedAt: new Date(),
      });
      await eqAssignment.save();
      // Use updateOne instead of tool.save() â€” tool may be a lean object
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
        serviceName,
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
      message: `You have been assigned to ${serviceName} for ${booking.customer?.name || 'a customer'} on ${new Date(booking.bookingDate).toLocaleDateString()}.`,
      userId: freshTech?.user || technicianId,
      role: 'technician',
      referenceId: assignment._id,
      referenceModel: 'Assignment',
      link: '/technician/assignments',
      priority: priority === 'urgent' ? 'urgent' : 'high',
      io,
    });

    // â”€â”€ Email: Notify Technician of Assignment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          serviceName,
          dateLabel,
          timeLabel,
          totalLabel: `â‚±${Number(booking.totalPrice || booking.estimatedFee || 0).toLocaleString()}`,
          locationAddress: booking.location?.address || '',
          issueDescription: booking.issueDescription || '',
        }).catch(err => console.error('[MAILER] Failed to send assignment email:', err.message));
      }
    } catch (mailErr) {
      console.error('[MAILER] Assignment email error:', mailErr.message);
    }

    console.log(`ðŸ‘¤ Technician ${technicianId} assigned to booking ${booking.bookingReference}`);
    res.json({ success: true, booking, assignment, equipment: [], aiRecommendations });
  } catch (error) {
    console.error('âŒ Error assigning technician:', error);
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
    console.error('âŒ Error generating AI recommendations:', error);
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

    console.log(`âŒ Booking ${booking.bookingReference} rejected: ${reason}`);

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
    console.error('âŒ Error rejecting booking:', error);
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

    console.log(`ðŸš« Booking ${booking.bookingReference} cancelled`);
    res.json({ success: true, booking });
  } catch (error) {
    console.error('âŒ Error cancelling booking:', error);
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

/**
 * GET /api/admin/appointments/tools/available
 * List active inventory tools with available quantity and AI recommendations for a service.
 */
function buildToolContextText(b, fallbackServiceName) {
  const parts = [fallbackServiceName];
  if (b.service?.name) parts.push(b.service.name);
  if (b.service?.description) parts.push(b.service.description);
  if (Array.isArray(b.services)) {
    b.services.forEach((s) => {
      if (s.name) parts.push(s.name);
      if (s.repairIssue) parts.push(s.repairIssue);
    });
  }
  if (b.issueDescription) parts.push(b.issueDescription);
  if (Array.isArray(b.repairIssues) && b.repairIssues.length) parts.push(b.repairIssues.join(' '));
  if (b.unitInfo) {
    parts.push(b.unitInfo.unitType, b.unitInfo.brand, b.unitInfo.model, b.unitInfo.problemDescription);
  }
  if (b.applianceTypeName) parts.push(b.applianceTypeName);
  if (b.applianceType) parts.push(b.applianceType);
  if (b.brand) parts.push(b.brand);
  if (b.serviceModel) parts.push(b.serviceModel);
  if (b.serviceType) parts.push(b.serviceType);
  return parts.filter(Boolean).join(' ').trim();
}

router.get('/tools/available', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    const serviceNameRaw = req.query.serviceName || '';
    const serviceName = String(serviceNameRaw).toLowerCase();
    const bookingId = req.query.bookingId;
    const tools = await Tool.find({
      active: true, isStockItem: true, assignable: { $ne: false },
      assetStatus: { $nin: ['under_maintenance', 'damaged', 'retired'] },
      $and: [Tool.operationalAssetFilter()],
    })
      .select('_id itemName type inventoryClass assetCode assetCondition assetStatus category description specification unit quantity reservedQuantity checkedOutQuantity barcode')
      .sort({ itemName: 1 })
      .lean();

    const prepared = tools.map((t) => {
      const availableQuantity = Math.max(0, (t.quantity || 0) - (t.reservedQuantity || 0));
      return { ...t, availableQuantity };
    });

    // Only Equipment can be assigned to a technician up-front.
    // Consumables are reserved/used by the technician; repair parts are quoted.
    const legacyType = (t) => (t.type === 'tool' ? 'equipment' : t.type);
    const assignable = prepared.filter((t) => {
      const lt = legacyType(t);
      return lt === 'equipment';
    });

    let recommended = [];
    let contextText = serviceNameRaw;
    let aiSuggestedTools = [];
    let isRepair = false;

    if (bookingId && mongoose.Types.ObjectId.isValid(bookingId)) {
      const booking = await BookingService.findById(bookingId)
        .select('serviceType serviceModel service services issueDescription repairIssues unitInfo applianceTypeName brand technicianAssistant')
        .lean();
      if (booking) {
        isRepair = booking.serviceType === 'repair' || booking.serviceModel === 'RepairService';
        contextText = buildToolContextText(booking, serviceNameRaw);

        // Use cached AI suggestions when available; otherwise generate for repairs
        const cached = booking.technicianAssistant?.suggestedTools;
        if (Array.isArray(cached) && cached.length) {
          aiSuggestedTools = cached.map((t) => String(t).toLowerCase());
        } else if (isRepair) {
          const recs = await generateRepairRecommendations(booking);
          aiSuggestedTools = (recs.suggestedTools || []).map((t) => String(t).toLowerCase());
        }
      }
    }

    const ctx = contextText.toLowerCase();
    const tokens = ctx.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const conceptBoosts = [
      { keys: ['clean', 'cleaning', 'wash'], terms: ['cleaner', 'coil', 'fin', 'brush', 'filter', 'vacuum', 'foaming'] },
      { keys: ['repair', 'fix', 'troubleshoot', 'no cooling', 'not cold', 'not working', 'broken', 'faulty', 'leak', 'leaking'], terms: ['multimeter', 'gauge', 'refrigerant', 'leak', 'solder', 'vacuum pump', 'compressor', 'capacitor', 'relay', 'pcb', 'fan motor', 'thermometer'] },
      { keys: ['install', 'installation', 'mount'], terms: ['drill', 'mount', 'bracket', 'copper', 'pipe', 'insulation', 'level', 'wrench'] },
      { keys: ['gas', 'refrigerant', 'leak', 'refill', 'charge'], terms: ['refrigerant', 'gas', 'gauge', 'vacuum pump', 'leak detector', 'manifold', 'charging'] },
      { keys: ['maintenance', 'checkup', 'pm', 'preventive'], terms: ['cleaner', 'filter', 'fin', 'multimeter', 'gauge', 'brush', 'vacuum'] },
    ];

    const scored = assignable.map((t) => {
      const text = `${t.itemName} ${t.category || ''} ${t.description || ''} ${t.specification || ''}`.toLowerCase();
      let score = 0;
      tokens.forEach((tok) => {
        if (text.includes(tok)) score += 2;
      });
      conceptBoosts.forEach((c) => {
        if (c.keys.some((k) => ctx.includes(k)) && c.terms.some((term) => text.includes(term))) score += 5;
      });

      // Strong boost for AI-suggested tool names
      aiSuggestedTools.forEach((st) => {
        if (st.length <= 2) return;
        if (text.includes(st)) {
          score += 20;
        } else {
          st.split(/[^a-z0-9]+/).filter((w) => w.length > 2).forEach((w) => {
            if (text.includes(w)) score += 6;
          });
        }
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
        const legacy = t.type === 'tool' ? 'equipment' : t.type;
        return { ...rest, reason: (legacy === 'equipment' ? 'Equipment' : 'Consumable') + (isRepair ? ' for this repair' : ` for ${serviceNameRaw}`) };
      });

    res.json({ success: true, tools: assignable, recommended });
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
    const BookingService = require('../models/BookingService');
    const Assignment = require('../models/Assignment');

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid booking id' });

    // Load the booking before applying the assignment planner's rules.
    const booking = await BookingService.findById(id).lean();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    // Show only technicians the assignment confirmation would actually accept.
    // The picker previously used looser rules than the confirmation endpoint.
    const { buildAssignmentPlan } = require('../utils/assignmentPlanner');
    const assignmentPlan = (await buildAssignmentPlan([booking], { reservePlan: false }))[0];
    const candidateById = new Map((assignmentPlan?.candidates || []).map(candidate => [candidate.technicianId, candidate]));

    // â”€â”€ 2. Fetch ALL active technicians â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const allTechs = await Technician.find({ active: true })
      .select('name phone email availabilityStatus rating location locationText')
      .sort({ name: 1 })
      .lean();

    if (allTechs.length === 0) {
      return res.json({ available: [], offlinePresent: [], total: 0 });
    }

    const techIds = allTechs.map(t => t._id);

    // â”€â”€ 3. Batch-fetch schedules, leave records, active assignments, and
    //        existing bookings on the same date for overlap checking â”€â”€â”€â”€â”€â”€â”€â”€
    const activeAssignments = await Assignment.find({
      technicianId: { $in: techIds },
      status: { $in: ['pending_acceptance', 'accepted', 'en_route', 'on_site', 'in_progress'] },
    }).select('technicianId').lean();

    const workloadMap = {};
    activeAssignments.forEach(a => {
      const tid = a.technicianId.toString();
      workloadMap[tid] = (workloadMap[tid] || 0) + 1;
    });

    // â”€â”€ 4. Filter technicians by eligibility criteria â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const eligible = [];
    const ineligible = [];

    for (const tech of allTechs) {
      const tid = tech._id.toString();

      if (!candidateById.has(tid)) {
        ineligible.push({ ...tech, reason: assignmentPlan?.assignmentTiming?.isExpired
          ? 'Requested Time Has Passed'
          : assignmentPlan?.exclusionReasons?.[tid] || 'Not Available for This Booking' });
        continue;
      }

      const currentWorkload = workloadMap[tid] || 0;

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
        overtimeMinutes: candidateById.get(tid)?.overtimeMinutes || 0,
        bookingLat,
        bookingLng,
      });
    }

    // Sort by AI score â€” genuinely rank by best fit
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

    eligible.sort((a, b) => scoreTech(b) - scoreTech(a));

    const bookingLat = booking.location?.lat || booking.bookingLocation?.lat || null;
    const bookingLng = booking.location?.lng || booking.bookingLocation?.lng || null;

    return res.json({ available: eligible, offlinePresent: ineligible, total: eligible.length, bookingLat, bookingLng });
  } catch (error) {
    console.error('âŒ Error fetching eligible technicians:', error);
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

    // A pending Assignment is the source of truth. Repair inspections use an
    // inspection status on the booking itself but still require technician
    // acceptance and must therefore appear in this tab as well.
    const pendingAssignmentIds = await Assignment.find({ status: 'pending_acceptance' }).distinct('_id');
    const filter = {
      $or: [
        { status: 'assigned' },
        { assignmentId: { $in: pendingAssignmentIds } },
      ],
    };
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
    console.error('âŒ Error fetching waiting-acceptance bookings:', error);
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
    console.error('âŒ Error extending deadline:', error);
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

    // â”€â”€ Cleanup: Release reserved equipment for this booking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    try {
      await releaseReservedEquipment({
        filter: { bookingId: booking._id },
        actorId: req.user._id,
        reason: 'Released because the booking was reassigned by an administrator',
        moduleName: 'booking reassignment',
      });
    } catch (eqErr) {
      console.warn('Equipment cleanup on force-reassign skipped:', eqErr.message);
    }

    const io = req.app.get('io');
    if (io) io.to('admin-room').emit('booking:status-change', { bookingId: booking._id, status: booking.status, reason: 'Admin forced reassignment' });

    res.json({ success: true, booking });
  } catch (error) {
    console.error('âŒ Error force reassigning:', error);
    res.status(500).json({ error: 'Failed to reassign booking' });
  }
});

// â•â•â• EXPENSE MANAGEMENT â•â•â•

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
      .populate({
        path: 'bookingId',
        select: 'bookingReference customer.name service.name serviceModel serviceId services.name bookingDate workOrderNumber',
        populate: { path: 'serviceId', select: 'name' }
      })
      .lean();

    res.json({
      expenses,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    console.error('âŒ Error fetching expenses:', error);
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
    if (expense.type === 'external_parts' && expense.bookingId) {
      const booking = await BookingService.findById(expense.bookingId);
      if (booking) {
        const purchase = (booking.localPurchase || []).find(row => row.receiptUrl && row.receiptUrl === expense.receiptImage);
        if (purchase) { purchase.adminVerificationStatus = 'approved'; purchase.purchaseStatus = 'verified'; await booking.save(); }
      }
    }

    console.log(`âœ… Expense ${expense._id} approved by ${req.user.name || req.user.email}`);

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
    console.error('âŒ Error approving expense:', error);
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
    if (expense.type === 'external_parts' && expense.bookingId) {
      const booking = await BookingService.findById(expense.bookingId);
      if (booking) {
        const purchase = (booking.localPurchase || []).find(row => row.receiptUrl && row.receiptUrl === expense.receiptImage);
        if (purchase) { purchase.adminVerificationStatus = 'correction_requested'; purchase.purchaseStatus = 'rejected'; purchase.notes = `${purchase.notes || ''}${purchase.notes ? ' Â· ' : ''}Admin correction: ${expense.rejectionReason}`; await booking.save(); }
      }
    }

    console.log(`âŒ Expense ${expense._id} rejected by ${req.user.name || req.user.email}`);

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
    console.error('âŒ Error rejecting expense:', error);
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
    console.error('âŒ Error fetching expense stats:', error);
    res.status(500).json({ error: 'Failed to fetch expense stats' });
  }
});

/**
 * GET /api/admin/appointments/verification-warnings
 * Enterprise queue health summary:
 *  - overdue: queue bookings that passed their scheduled time without a
 *    committed technician (flagged by the reschedule monitor).
 *  - verify: upcoming bookings (within verify window) still needing payment
 *    verification and/or technician assignment before their schedule time.
 */
router.get('/verification-warnings', requireRole(['admin', 'secretary']), async (req, res) => {
  try {
    const { parseBookingDateTime } = require('../utils/overdueBookingScheduler');
    const now = new Date();
    const graceMin = 30;
    const verifyHours = 3;
    const windowEnd = new Date(now.getTime() + verifyHours * 3600 * 1000);
    const queueStatuses = ['awaiting_assignment', 'assigned', 'pending_reassignment'];

    const select = 'bookingDate startTime bookingReference customer serviceName service status paymentStatus autoReschedulePending autoRescheduleAt';

    const queueBookings = await BookingService.find({ status: { $in: queueStatuses } })
      .select(select)
      .lean();

    const overdueItems = [];
    for (const b of queueBookings) {
      const sched = parseBookingDateTime(b.bookingDate, b.startTime);
      if (!sched) continue;
      const graceEnd = new Date(sched.getTime() + graceMin * 60000);
      if (now <= graceEnd) continue;
      overdueItems.push({
        _id: b._id,
        bookingReference: b.bookingReference,
        customerName: b.customer ? b.customer.name : 'Customer',
        serviceName: b.serviceName || (b.service && b.service.name) || 'Service',
        status: b.status,
        bookingDate: b.bookingDate,
        startTime: b.startTime || '',
        scheduleTime: sched.toISOString(),
        overdueByMin: Math.round((now - sched) / 60000),
        autoReschedulePending: !!b.autoReschedulePending,
      });
    }

    const upcoming = await BookingService.find({
      status: {
        $in: [
          'pending', 'payment_verified', 'awaiting_assignment', 'assigned',
          'pending_reassignment', 'confirmed', 'scheduled',
        ],
      },
      verificationReminderAt: null,
    })
      .select(select)
      .lean();

    const verifyItems = [];
    for (const b of upcoming) {
      const sched = parseBookingDateTime(b.bookingDate, b.startTime);
      if (!sched || sched <= now || sched > windowEnd) continue;
      const issues = [];
      if (b.status === 'pending' || ['pending', 'failed', 'partial'].includes(b.paymentStatus)) {
        issues.push('payment');
      }
      if (queueStatuses.includes(b.status)) {
        issues.push('assignment');
      }
      if (!issues.length) continue;
      verifyItems.push({
        _id: b._id,
        bookingReference: b.bookingReference,
        customerName: b.customer ? b.customer.name : 'Customer',
        serviceName: b.serviceName || (b.service && b.service.name) || 'Service',
        status: b.status,
        bookingDate: b.bookingDate,
        startTime: b.startTime || '',
        scheduledBy: sched.toISOString(),
        hoursAway: Math.round((sched - now) / 3600000 * 10) / 10,
        issues,
      });
    }

    res.json({
      success: true,
      overdueCount: overdueItems.length,
      verifyCount: verifyItems.length,
      overdueItems: overdueItems.slice(0, 50),
      verifyItems: verifyItems.slice(0, 50),
      now: now.toISOString(),
    });
  } catch (error) {
    console.error('âŒ Error fetching verification warnings:', error);
    res.status(500).json({ error: 'Failed to fetch verification warnings' });
  }
});

/**
 * GET /api/admin/appointments/:id
 * Get full booking details for admin view
 */
router.get('/daily-kits', requireRole(['admin', 'secretary']), listDailyKits);

router.get('/:id/photos', requireRole(['admin', 'secretary']), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid booking reference.' });
    const booking = await BookingService.findById(req.params.id)
      .select(['assignmentId', ...BOOKING_PHOTO_FIELDS].join(' ')).maxTimeMS(8000).lean();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const [assignment, payments] = await Promise.all([
      currentAssignment(Assignment, booking, ASSIGNMENT_PHOTO_FIELDS.join(' '), false),
      Payment.find({ bookingId: booking._id }).select(PAYMENT_PHOTO_FIELDS.join(' ')).maxTimeMS(8000).lean(),
    ]);
    res.set('Cache-Control', 'private, no-store');
    res.json({ photos: bookingPhotos(booking, assignment, payments) });
  } catch (error) {
    console.error('Error fetching booking photos:', error);
    res.status(500).json({ error: 'Could not load photos. Please try again.' });
  }
});

router.get('/:id', requireRole(["admin", "secretary"]), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid booking reference.' });
    const modalView = req.query?.view === 'modal';
    const booking = await BookingService.findById(req.params.id)
      .select(modalView ? exclude(BOOKING_PHOTO_FIELDS) : '')
      .populate('technicianId', 'name userEmail phone location user')
      .populate('customerId', 'firstName lastName email phone address')
      .populate('serviceId', 'name description basePrice durationMinutes estimatedDurationMinutes')
      .maxTimeMS(8000).lean();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    if ((!booking.service || !booking.service.name) && booking.serviceId && typeof booking.serviceId === 'object') {
      booking.service = {
        _id: booking.serviceId._id,
        name: booking.serviceId.name || '',
        description: booking.serviceId.description || '',
        basePrice: booking.serviceId.basePrice || 0,
      };
    }

    // These independent reads must not hold up one another. Prefer the stored
    // assignment pointer, with a single-query fallback for legacy records.
    const [assignments, payments, reservedParts] = await Promise.all([
      modalView ? currentAssignment(Assignment, booking, exclude(ASSIGNMENT_PHOTO_FIELDS)) : Assignment.find(booking.assignmentId
        ? { $or: [{ _id: booking.assignmentId }, { bookingId: booking._id }] }
        : { bookingId: booking._id })
        .sort({ createdAt: -1 }).populate('technicianId', 'name userEmail phone user').maxTimeMS(8000).lean(),
      Payment.find({ bookingId: booking._id })
        .select(modalView ? exclude([...PAYMENT_PHOTO_FIELDS, 'webhookEvents']) : '')
        .sort({ submittedAt: 1, collectedAt: 1 }).maxTimeMS(8000).lean(),
      require('../models/StockReservation').find({ bookingId: booking._id })
        .populate('toolId', 'itemName quantity costPrice barcode').sort({ reservedAt: -1 }).maxTimeMS(8000).lean(),
    ]);
    const assignment = modalView ? assignments : assignments.find(row => String(row._id) === String(booking.assignmentId)) || assignments[0] || null;
    const payment = payments.length ? payments[0] : null;

    // Use the payment ledger as the read-time source of truth. Booking
    // snapshots from older online and walk-in flows may not have amountPaid or
    // balanceAmount synchronized even though Payment rows exist.
    const collectedStatuses = new Set(['paid', 'partial', 'verified', 'remitted', 'payment_collected', 'waiting_for_remittance']);
    const ledgerPaid = payments.reduce((sum, row) => collectedStatuses.has(row.status) ? sum + (Number(row.amount) || 0) : sum, 0);
    const totalDue = Number(booking.totalPrice || booking.estimatedFee || booking.servicePrice) || 0;
    booking.amountPaid = Math.max(Number(booking.amountPaid) || 0, ledgerPaid);
    booking.balanceAmount = Math.max(0, totalDue - booking.amountPaid);
    if (totalDue > 0 && booking.amountPaid >= totalDue) booking.paymentStatus = 'paid';
    else if (booking.amountPaid > 0) booking.paymentStatus = 'partial';

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

    let financialSummary = null;
    let operationalSummary = null;
    if (booking.status === "completed" && !modalView) {
      const costAnalytics = await require("../utils/serviceCostAnalytics").buildServiceCostAnalytics([booking]);
      const serviceCost = costAnalytics.services[0];
      if (serviceCost) {
        financialSummary = {
          revenue: serviceCost.revenue,
          laborCost: serviceCost.laborCost,
          repairPartsCost: serviceCost.partsCost,
          consumablesCost: serviceCost.consumablesCost,
          grossProfit: serviceCost.grossProfit,
          grossProfitMargin: serviceCost.grossProfitMargin,
        };
        operationalSummary = {
          equipmentUsed: serviceCost.equipment,
          consumablesUsed: serviceCost.consumables,
          repairPartsUsed: serviceCost.repairParts,
          assignedTechnician: serviceCost.technician,
          serviceDurationHours: serviceCost.laborHours,
        };
      }
    }

    Object.assign(booking, bookingReviewState(booking));
    booking.assignmentTiming = assignmentTimingState(booking);
    res.set('Cache-Control', 'private, no-store');
    res.json({ booking, assignment, payment, payments, reservedParts, technicianLocation, financialSummary, operationalSummary,
      ...(modalView ? { photosDeferred: true } : {}) });
  } catch (error) {
    console.error('âŒ Error fetching booking detail:', error);
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

      if (isAssignmentWindowExpired(booking)) {
        return res.status(409).json({
          error: 'The technician-assignment window has expired. Please resolve it via the Booking Resolution Center.',
          code: 'PAST_DATE_BOOKING',
          redirect: '/admin/appointments/attention?issue=past_date',
        });
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
    const { newDate, newTime, notifyCustomer = true, proposedTechnicianId } = req.body;

    if (!newDate || !newTime) {
      return res
        .status(400)
        .json({ error: 'newDate and newTime are required' });
    }

    const booking = await BookingService.findById(id);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const validRescheduleStatuses = [BookingStatus.PENDING_REASSIGNMENT, BookingStatus.RESCHEDULED];
    if (!validRescheduleStatuses.includes(booking.status)) {
      return res
        .status(400)
        .json({ error: `Cannot reschedule booking in "${booking.status}" status` });
    }

    const newDateObj = new Date(newDate);
    newDateObj.setHours(0, 0, 0, 0);

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

    // Transition booking to re-scheduled or awaiting_assignment
    // If no technician assigned, go to awaiting_assignment so admin can assign one
    const previousStatus = booking.status;
    const originalBookingDate = booking.bookingDate;
    const originalStartTime = booking.startTime;
    booking.status = booking.technicianId ? BookingStatus.RESCHEDULED : BookingStatus.AWAITING_ASSIGNMENT;
    booking.rescheduleReason = `Admin proposed reschedule due to technician unavailability. Previous status: ${previousStatus}`;
    booking.reassignmentCount = (booking.reassignmentCount || 0) + 1;
    booking.cancellationHistory.push({
      technicianId: booking.technicianId,
      technicianName: booking.technician?.name || 'Unknown',
      action: 'reassigned',
      reason: 'Admin proposed reschedule due to technician unavailability',
      timestamp: new Date(),
    });

    // Invalidate any outstanding customer reschedule-request so the queue
    // doesn't show a stale "customer requests new schedule" reminder next to
    // this fresh proposal.
    if (booking.rescheduleRequest && booking.rescheduleRequest.requested) {
      booking.rescheduleRequest.status = 'superseded';
      booking.rescheduleRequest.processedBy = req.user._id;
      booking.rescheduleRequest.processedAt = new Date();
    }

    // Store the proposed schedule pending customer confirmation
    let proposedTechnicianName = null;
    if (proposedTechnicianId && mongoose.Types.ObjectId.isValid(proposedTechnicianId)) {
      const tech = await Technician.findById(proposedTechnicianId).select('name').lean();
      if (tech) proposedTechnicianName = tech.name;
    }
    booking.proposedReschedule = {
      proposedAt: new Date(),
      proposedBy: req.user._id,
      proposedByName: req.user.name || req.user.email || 'Admin',
      date: newDateObj,
      time: newTime,
      dateLabel: newDateObj.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      timeLabel: newTime,
      originalDate: originalBookingDate ? new Date(originalBookingDate) : null,
      originalTime: originalStartTime || null,
      technicianId: proposedTechnicianName ? proposedTechnicianId : null,
      technicianName: proposedTechnicianName,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'pending',
    };
    await booking.save();

    // Update assignment if exists
    if (booking.assignmentId) {
      await Assignment.findByIdAndUpdate(booking.assignmentId, {
        $set: { status: 'cancelled', cancelledAt: new Date() },
        $push: {
          notes: {
            text: 'Cancelled due to admin reschedule',
            by: req.user._id,
            byName: req.user.name || req.user.email || 'Admin',
            createdAt: new Date(),
          },
        },
      });
    }

    // â”€â”€ Cleanup: Release reserved equipment for this booking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    try {
      await releaseReservedEquipment({
        filter: { bookingId: booking._id },
        actorId: req.user._id,
        reason: 'Released because an administrator rescheduled the booking',
        moduleName: 'booking reschedule',
      });
    } catch (eqErr) {
      console.warn('Equipment cleanup on reschedule skipped:', eqErr.message);
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
    await booking.save();

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
        title: 'Proposed Reschedule â€“ Action Required',
        message: `We propose to reschedule your ${booking.service?.name || 'a service'} appointment to ${newDateObj.toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric' })} at ${newTime}. Please review and confirm in your booking history.`,
        userId: booking.customerId,
        role: 'customer',
        referenceId: booking._id,
        referenceModel: 'BookingService',
        link: `/tracking`,
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

     console.log(`[Reschedule] Booking ${booking.bookingReference} rescheduled to ${newDateObj.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} at ${newTime}`);

     res.json({
       success: true,
       booking,
       message: 'Booking rescheduled successfully',
     });
   } catch (error) {
     console.error('Error rescheduling booking:', error);
     res.status(500).json({ error: error.message || 'Failed to reschedule booking' });
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
      value: w.displayStart || w.start,
      end: w.displayEnd || w.end,
      label: (w.displayStart || w.start) + ' â€“ ' + (w.displayEnd || w.end),
      remainingCapacity: w.remainingCapacity || 0,
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

/** Admin audit view of consolidated technician preparation. */
async function listDailyKits(req, res) {
  try {
    const DailyKit = require('../models/DailyKit');
    const Order = require('../models/Order');
    const { dayBounds } = require('../utils/dailyKitService');
    const { parseCalendarDate } = require('../utils/calendarDateRange');
    const date = String(req.query.date || '').trim();
    const selectedDate = date ? parseCalendarDate(date) : new Date();
    if (date && !selectedDate) {
      return res.status(400).json({ error: 'Date must be a valid YYYY-MM-DD value' });
    }
    const { start, end } = dayBounds(selectedDate);
    const kits = await DailyKit.find({ workDate: { $gte: start, $lt: end } })
      .populate('technicianId', 'name availabilityStatus')
      .sort({ status: 1, createdAt: 1 })
      .lean();

    const uniqueIds = (values) => [...new Set(values.filter(Boolean).map(String))];
    const bookingIds = uniqueIds(kits.flatMap(kit => [
      ...(kit.bookingIds || []),
      ...(kit.items || []).flatMap(item => item.bookingIds || []),
      ...(kit.deltaItems || []).flatMap(item => item.bookingIds || []),
    ]));
    const orderIds = uniqueIds(kits.flatMap(kit => [
      ...(kit.orderIds || []),
      ...(kit.items || []).flatMap(item => item.orderIds || []),
      ...(kit.deltaItems || []).flatMap(item => item.orderIds || []),
    ]));
    const kitIds = kits.map(kit => kit._id);

    const [bookings, orders, custody, technicians] = await Promise.all([
      BookingService.find({ _id: { $in: bookingIds } })
        .select('bookingReference customer service services serviceType status bookingDate startTime')
        .lean(),
      Order.find({ _id: { $in: orderIds } })
        .select('orderReference customer items fulfillmentType status delivery.preferredDate')
        .lean(),
      EquipmentAssignment.find({ dailyKitId: { $in: kitIds } })
        .select('dailyKitId equipmentId equipmentName equipmentCode quantity consumable status checkedOutAt expectedReturnAt returnedAt condition damageDescription bookingId orderIds')
        .lean(),
      Technician.find({ active: { $ne: false }, archivedAt: null })
        .select('name availabilityStatus')
        .sort({ name: 1 })
        .lean(),
    ]);

    const bookingMap = new Map(bookings.map(booking => [String(booking._id), booking]));
    const orderMap = new Map(orders.map(order => [String(order._id), order]));
    const custodyByKit = new Map();
    for (const row of custody) {
      const key = String(row.dailyKitId);
      if (!custodyByKit.has(key)) custodyByKit.set(key, []);
      custodyByKit.get(key).push(row);
    }

    const compactBooking = (id) => {
      const booking = bookingMap.get(String(id));
      if (!booking) return { id: String(id), type: 'booking', reference: `Booking ${String(id).slice(-6).toUpperCase()}`, label: 'Service booking' };
      return {
        id: String(booking._id),
        type: 'booking',
        reference: booking.bookingReference || `Booking ${String(booking._id).slice(-6).toUpperCase()}`,
        label: booking.service?.name || booking.services?.[0]?.name || (booking.serviceType === 'repair' ? 'Repair service' : 'Service booking'),
        customer: booking.customer?.name || 'Customer',
        status: booking.status || '',
        href: `/admin/appointments?sel=${booking._id}`,
      };
    };
    const compactOrder = (id) => {
      const order = orderMap.get(String(id));
      if (!order) return { id: String(id), type: 'order', reference: `Order ${String(id).slice(-6).toUpperCase()}`, label: 'Installation order' };
      const unitNames = uniqueIds((order.items || []).map(item => item.name)).slice(0, 2);
      return {
        id: String(order._id),
        type: 'order',
        reference: order.orderReference || `Order ${String(order._id).slice(-6).toUpperCase()}`,
        label: unitNames.join(', ') || 'Installation order',
        customer: order.customer?.name || 'Customer',
        status: order.status || '',
        href: `/admin/appointments/orders?order=${order._id}`,
      };
    };
    const compactCustody = (row) => ({
      id: String(row._id),
      equipmentId: row.equipmentId ? String(row.equipmentId) : null,
      name: row.equipmentName,
      code: row.equipmentCode || '',
      quantity: Number(row.quantity || 0),
      consumable: Boolean(row.consumable),
      status: row.status,
      checkedOutAt: row.checkedOutAt || null,
      expectedReturnAt: row.expectedReturnAt || null,
      returnedAt: row.returnedAt || null,
      condition: row.condition || '',
      damageDescription: row.damageDescription || '',
    });
    const compactItem = (item, kitCustody, isDelta = false) => {
      const itemAssignmentId = item.equipmentAssignmentId && String(item.equipmentAssignmentId);
      const ledger = kitCustody.find(row => itemAssignmentId
        ? String(row._id) === itemAssignmentId
        : item.toolId && String(row.equipmentId) === String(item.toolId));
      const jobs = [
        ...(item.bookingIds || []).map(compactBooking),
        ...(item.orderIds || []).map(compactOrder),
      ];
      return {
        id: String(item._id),
        name: item.name,
        code: item.toolCode || ledger?.equipmentCode || '',
        category: item.category,
        source: item.source,
        quantity: Number(item.quantity || 0),
        unit: item.unit || 'pcs',
        checkoutStatus: item.checkoutStatus,
        quantityIssued: Number(item.quantityIssued || 0),
        quantityUsed: Number(item.quantityUsed || 0),
        quantityReturned: Number(item.quantityReturned || 0),
        isDelta,
        conflict: item.conflict || null,
        resolution: item.resolution || null,
        exception: item.exception || null,
        custody: ledger ? compactCustody(ledger) : null,
        jobs,
      };
    };

    const payload = kits.map((kit) => {
      const kitCustody = custodyByKit.get(String(kit._id)) || [];
      const items = (kit.items || []).map(item => compactItem(item, kitCustody));
      const deltaItems = (kit.deltaItems || []).map(item => compactItem(item, kitCustody, true));
      const jobs = [
        ...(kit.bookingIds || []).map(compactBooking),
        ...(kit.orderIds || []).map(compactOrder),
      ];
      const unresolved = [...items, ...deltaItems].filter(item =>
        item.checkoutStatus === 'unavailable'
        && !item.exception?.approved
        && (!item.resolution?.status || item.resolution.status === 'admin_notified'));
      return {
        id: String(kit._id),
        workDate: kit.workDate,
        status: kit.status,
        hasDelta: Boolean(kit.hasDelta),
        generatedAt: kit.generatedAt || null,
        confirmedAt: kit.confirmedAt || null,
        completedAt: kit.completedAt || null,
        technician: kit.technicianId ? {
          id: String(kit.technicianId._id),
          name: kit.technicianId.name,
          availabilityStatus: kit.technicianId.availabilityStatus || '',
        } : null,
        counts: {
          equipment: items.filter(item => item.category === 'equipment').length,
          consumables: items.filter(item => item.category === 'consumable').length,
          repairParts: items.filter(item => item.category === 'repair_part').length,
          jobs: uniqueIds(jobs.map(job => `${job.type}:${job.id}`)).length,
          unresolved: unresolved.length,
        },
        jobs,
        items,
        deltaItems,
        custody: kitCustody.map(compactCustody),
      };
    }).sort((a, b) => String(a.technician?.name || '').localeCompare(String(b.technician?.name || '')));

    const allItems = payload.flatMap(kit => [...kit.items, ...kit.deltaItems]);
    const summary = {
      kits: payload.length,
      ready: payload.filter(kit => ['confirmed', 'in_progress'].includes(kit.status) && !kit.hasDelta && kit.counts.unresolved === 0).length,
      attention: payload.filter(kit => kit.hasDelta || kit.counts.unresolved > 0).length,
      checkedOut: custody.filter(row => ['checked_out', 'in_use'].includes(row.status)).reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      issued: allItems.reduce((sum, item) => sum + Number(item.quantityIssued || 0), 0),
      used: allItems.reduce((sum, item) => sum + Number(item.quantityUsed || 0), 0),
    };

    return res.json({
      success: true,
      date: start,
      summary,
      technicians: technicians.map(technician => ({
        id: String(technician._id),
        name: technician.name,
        availabilityStatus: technician.availabilityStatus || '',
      })),
      kits: payload,
    });
  } catch (error) {
    console.error('Error fetching daily kits:', error);
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to fetch daily kits' });
  }
}

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
    const filter = {
      active: true, status: { $in: ['in_stock', 'low_stock'] }, assignable: { $ne: false },
      assetStatus: { $nin: ['under_maintenance', 'damaged', 'retired'] },
      $and: [Tool.operationalAssetFilter()],
    };
    if (search) filter.itemName = { $regex: search, $options: 'i' };
    const items = await Tool.find(filter).select('itemName unit quantity barcode assetCode assetStatus checkedOutQuantity status minStockLevel inventoryClass').sort({ itemName: 1 }).limit(200).lean();
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
      Tool.findOne({ _id: equipmentId, active: { $ne: false } }).lean(),
    ]);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.serviceModel !== 'RepairService' && booking.serviceType !== 'repair') {
      return res.status(403).json({ error: 'Standard booking preparation is managed by the assigned technician.' });
    }
    if (!booking.technicianId) return res.status(400).json({ error: 'Booking has no assigned technician' });
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    if (Tool.effectiveInventoryClass(tool) !== 'operational_asset' || tool.assignable === false || ['under_maintenance', 'damaged', 'retired'].includes(tool.assetStatus)) {
      return res.status(400).json({ error: 'Only available operational assets can be assigned' });
    }
    const requestedQty = Math.max(1, parseInt(quantity) || 1);
    const availableQuantity = Math.max(0, (tool.quantity || 0) - (tool.reservedQuantity || 0));
    if (availableQuantity < requestedQty) return res.status(400).json({ error: 'Insufficient available stock for ' + tool.itemName });
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
      consumable: tool.type === 'consumable',
      notes,
      issuedBy: req.user?.name || String(req.user?._id),
      issuedAt: new Date(),
      expectedReturnAt: expectedReturnForWorkDate(booking.bookingDate || new Date(), booking.endTime),
    });
    await Tool.findByIdAndUpdate(tool._id, { $inc: { reservedQuantity: requestedQty } });
    res.status(201).json({ success: true, assignment });
  } catch (error) {
    console.error('Error assigning equipment:', error);
    res.status(500).json({ error: 'Failed to assign equipment' });
  }
});

/**
 * DELETE /api/admin/equipment-assignments/:assignmentId
 * Release and retain a reserved equipment assignment
 */
router.delete('/equipment-assignments/:assignmentId', requireRole(['admin', 'secretary']), async (req, res) => {
  try {
    const { assignmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(assignmentId)) return res.status(400).json({ error: 'Invalid id' });
    const assignment = await EquipmentAssignment.findById(assignmentId);
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    if (assignment.status !== 'reserved') return res.status(400).json({ error: 'Cannot remove a checked-out or returned assignment' });
    const result = await releaseReservedEquipment({
      filter: { _id: assignment._id },
      actorId: req.user._id,
      reason: req.body?.reason || 'Released by an administrator before checkout',
      moduleName: 'manual equipment release',
    });
    res.json({ success: true, message: 'Equipment reservation released and retained in history', assignment: result.released[0] });
  } catch (error) {
    console.error('Error removing equipment assignment:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to remove equipment assignment' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const BookingService = require('../models/BookingService');
const auth = require('../middleware/authenticate');
const { getBufferMinutes, assertCompanyCapacity, getInspectionDurationMinutes } = require('../utils/bookingPolicy');
const schedulingEngine = require('../utils/enterpriseSchedulingEngine');
const { sendRepairRequestSubmittedEmail } = require('../utils/mailer');

// Protect all booking routes with authentication
router.use(auth.authenticate);
router.use(auth.requireRole("customer"));

/**
 * POST /api/bookings/create-new
 * Simplified booking creation endpoint
 */
router.post('/create-new', async (req, res) => {
  try {
    console.log('📝 Creating new booking (simplified)...');
    console.log('Request body keys:', Object.keys(req.body));
    console.log('🔍 Full Request Analysis:');
    console.log('   Headers:', Object.keys(req.headers));
    console.log('   Cookies:', req.headers.cookie);
    console.log('   Session ID:', req.sessionID);
    console.log('   Session data:', req.session);
    
    // Check authentication at the very beginning
    console.log('🔐 Authentication Check:');
    console.log('   req.user exists:', !!req.user);
    console.log('   req.session exists:', !!req.session);
    console.log('   req.session.userId:', req.session?.userId);
    
    if (req.user) {
      console.log('   req.user._id:', req.user._id);
      console.log('   req.user.email:', req.user.email);
      console.log('   req.user.name:', req.user.name || req.user.fullName);
    }
    
    // Extract basic required fields
    const {
      services,
      technicianId,
      location,
      bookingDate,
      startTime,
      endTime,
      paymentMethod,
      paymentReference,
      downpaymentAmount,
      paymentNotes,
      gcashNumber,
      proofImageBase64,
      totalPrice,
      travelFare,
      distanceKm,
      travelDurationMinutes,
      isProject,
      projectScheduling,
      quantity
    } = req.body;

    // Convert 'cash' to 'cod' for the booking schema
    const bookingPaymentMethod = paymentMethod === 'cash' ? 'cod' : paymentMethod;

    console.log('Services type:', typeof services);
    console.log('Services is array:', Array.isArray(services));
    console.log('Services value:', services);
    console.log('Payment method:', paymentMethod, '-> Booking payment method:', bookingPaymentMethod);
    
    // Check if services is stringified and needs parsing
    let parsedServices = services;
    if (typeof services === 'string') {
      console.warn('⚠️ Services is stringified, parsing...');
      try {
        parsedServices = JSON.parse(services);
        console.log('✓ Services parsed successfully');
      } catch (e) {
        console.error('❌ Failed to parse services:', e);
        return res.status(400).json({ error: 'Invalid services data format' });
      }
    }
    
    // Basic validation
    if (!parsedServices || !Array.isArray(parsedServices) || parsedServices.length === 0) {
      return res.status(400).json({ error: 'At least one service is required' });
    }
    
    if (!location || !location.lat || !location.lng) {
      return res.status(400).json({ error: 'Valid location is required' });
    }
    
    if (!bookingDate) {
      return res.status(400).json({ error: 'A date is required' });
    }

    // Large-scale / project bookings have no fixed time slot — only a start date.
    if (!isProject && !startTime) {
      return res.status(400).json({ error: 'Date and start time are required' });
    }
    
    if (!paymentMethod) {
      return res.status(400).json({ error: 'Payment method is required' });
    }
    
    // ========================================
    // BACKEND EXPERT: Extract and validate user authentication
    // ========================================
    const userId = req.user?._id || req.session?.userId;
    console.log('\n========================================');
    console.log('� AUTHENTICATION VALIDATION');
    console.log('========================================');
    console.log('req.user exists:', !!req.user);
    console.log('req.user._id:', req.user?._id);
    console.log('req.user.email:', req.user?.email);
    console.log('req.session.userId:', req.session?.userId);
    console.log('Final userId:', userId);
    
    if (!userId) {
      console.error('❌ AUTHENTICATION FAILED: No user ID found');
      return res.status(401).json({ 
        error: 'User authentication required',
        details: 'Please log in to create a booking'
      });
    }
    console.log('✅ User authenticated with ID:', userId);
    
    // ========================================
    // BACKEND EXPERT: Fetch and validate customer data
    // ========================================
    console.log('\n========================================');
    console.log('👤 CUSTOMER DATA VALIDATION');
    console.log('========================================');
    const User = require('../models/User');
    console.log('Fetching user with ID:', userId);
    
    const user = await User.findById(userId);
    
    if (!user) {
      console.error('❌ CUSTOMER NOT FOUND in database for ID:', userId);
      return res.status(404).json({ 
        error: 'Customer not found',
        details: 'Your user account could not be found. Please contact support.'
      });
    }
    
    // Log complete user data for debugging
    console.log('✅ Customer found in database:');
    console.log('   ID:', user._id);
    console.log('   First Name:', user.firstName);
    console.log('   Last Name:', user.lastName);
    console.log('   Email:', user.email);
    console.log('   Phone:', user.phone || user.mobile || 'N/A');
    
    // Construct full name (backend best practice: always build from parts)
    const customerFirstName = user.firstName || '';
    const customerLastName = user.lastName || '';
    const customerFullName = `${customerFirstName} ${customerLastName}`.trim() || 'Valued Customer';
    
    console.log('   Constructed Full Name:', customerFullName);
    console.log('   Email Validation:', user.email ? '✅ Valid' : '❌ Missing');
    
    if (!user.email) {
      console.error('❌ CUSTOMER EMAIL MISSING');
      return res.status(400).json({
        error: 'Customer email required',
        details: 'Your account is missing an email address. Please update your profile.'
      });
    }
    
    // ========================================
    // BACKEND: Optional technician assignment
    const Technician = require('../models/Technician');
    let technician = null;

    if (technicianId) {
      technician = await Technician.findById(technicianId);

      if (!technician) {
        return res.status(404).json({
          error: 'Technician not found',
          details: 'The selected technician is not available. Please select another technician.'
        });
      }
    }

    // ── Compute capacity end point ──────────────────────────────────────
    // The customer's startTime is their requested service start time.
    // The endTime stored is the capacity end point (for overlap checks on
    // future bookings), NOT a guaranteed completion time.
    // Project (large-scale) bookings have no fixed time slot, so capacity
    // overlap checks are skipped — they are scheduled later by admin.
    const serviceDurationMin = parsedServices[0].duration || 60;
    const travelDurationMin = Number(travelDurationMinutes) || Number(distanceKm) * 2 || 0;
    const bufferMin = await getBufferMinutes();
    const startMin = isProject ? null : parseTimeToMinutes(startTime);
    const capacityEndMinutes = startMin == null ? null : startMin + serviceDurationMin + travelDurationMin + bufferMin;
    const capacityEndTime = capacityEndMinutes == null ? undefined : minutesToTimeString(capacityEndMinutes);

    // ── Company-wide capacity check ──────────────────────────────────────
    // For standard bookings: check single time slot.
    // For project bookings: validate the ENTIRE date range has sufficient
    // technician capacity for every working day.
    if (isProject) {
      const ps = projectScheduling || {};
      const projStartDate = ps.preferredStartDate || bookingDate;
      const projEndDate = ps.preferredCompletionDeadline || ps.preferredStartDate || bookingDate;

      if (projStartDate && projEndDate) {
        const sumQty = Array.isArray(parsedServices)
          ? parsedServices.reduce((s, sv) => s + (Number(sv.quantity) || 0), 0)
          : 0;
        const totalQty = Number(quantity) > 0 ? Number(quantity) : (sumQty > 0 ? sumQty : 1);
        const estHours = ps.estimatedTotalHours || 0;
        const rangeDays = Math.max(1, Math.ceil((new Date(projEndDate) - new Date(projStartDate)) / 86400000) + 1);
        const requiredTechs = Math.max(1, Math.ceil((estHours || (totalQty * 8)) / (rangeDays * 8)));

        const rangeCheck = await schedulingEngine.validateProjectDateRange({
          startDate: projStartDate,
          endDate: projEndDate,
          requiredTechnicians: requiredTechs,
          serviceModel: parsedServices[0]?.type === 'repair' ? 'RepairService' : 'CoreService',
        });

        if (!rangeCheck.valid || !rangeCheck.available) {
          let msg = rangeCheck.message || 'The selected date range cannot be accommodated due to insufficient technician capacity.';
          if (rangeCheck.nextAvailableRange) {
            msg += ` Suggested alternative: ${rangeCheck.nextAvailableRange.startDate} to ${rangeCheck.nextAvailableRange.endDate}.`;
          }
          return res.status(409).json({ error: msg, validationResult: rangeCheck });
        }
      }
    } else {
      try {
        await assertCompanyCapacity(new Date(bookingDate), startMin, capacityEndMinutes);
      } catch (capacityErr) {
        return res.status(409).json({ error: capacityErr.message });
      }
    }

    // Generate booking reference
    const bookingReference = `RACS-${new Date().toISOString().slice(0,10).replace(/-/g, '')}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    
    // Create comprehensive booking data with REAL user and technician data
    const bookingData = {
      bookingReference,
      customerId: userId,
      technicianId: technician ? technician._id : undefined,
      
      // Real customer snapshot
      customer: {
        _id: user._id,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || "Valued Customer",
        email: user.email,
        phone: user.phone || user.mobile || "",
        address: user.address ? 
          (typeof user.address === 'string' ? user.address : 
           `${user.address.barangay || ''}, ${user.address.city || ''}, ${user.address.province || ''}`.replace(/^[,\s]+|[,\s]+$/g, '')) :
          (location?.address || "")
      },
      
      // Real technician snapshot - use userEmail field when assigned
      technician: technician ? {
        _id: technician._id,
        name: technician.name || "Technician",
        email: technician.userEmail || technician.email || "",
        phone: technician.phone || technician.mobile || ""
      } : undefined,
      
      // Service data (single service for simplicity)
      serviceId: parsedServices[0].serviceId,
      serviceModel: parsedServices[0].type === 'core' ? 'CoreService' : 'RepairService',
      service: {
        _id: parsedServices[0].serviceId,
        name: parsedServices[0].name,
        description: parsedServices[0].name,
        basePrice: parsedServices[0].unitPrice
      },
      servicePrice: parsedServices[0].unitPrice,
      serviceDurationMinutes: serviceDurationMin,

      // Aircon brand & appliance type (captured from customer on the booking UI)
      brand: parsedServices[0].brand || null,
      applianceType: parsedServices[0].applianceType || null,
      applianceTypeName: parsedServices[0].applianceTypeName || null,

      // Use single service fields only (the BookingService.services[] path is
      // an [String] array in the compiled model, so per-item subdocs are
      // persisted via the legacy /create route; brand/applianceType are kept
      // here as top-level fields).
      isMultiService: false,
      totalPrice: totalPrice || parsedServices[0].totalPrice,
      totalInitialCost: parsedServices[0].initialCost || 0,

      // Large-scale / project support
      isProject: Boolean(isProject) || false,
      quantity: Number(quantity) || 1,
      projectScheduling: projectScheduling ? {
        preferredStartDate: projectScheduling.preferredStartDate ? new Date(projectScheduling.preferredStartDate) : undefined,
        preferredWorkingDays: Array.isArray(projectScheduling.preferredWorkingDays) ? projectScheduling.preferredWorkingDays : undefined,
        preferredWorkingHours: projectScheduling.preferredWorkingHours || undefined,
        preferredCompletionDeadline: projectScheduling.preferredCompletionDeadline ? new Date(projectScheduling.preferredCompletionDeadline) : undefined,
        estimatedTotalHours: projectScheduling.estimatedTotalHours ? Number(projectScheduling.estimatedTotalHours) : undefined,
      } : undefined,
      
      // Location with coordinates
      location: {
        address: location.address,
        lat: location.lat,
        lng: location.lng,
        coordinates: {
          type: 'Point',
          coordinates: [location.lng, location.lat]
        }
      },
      
      // Schedule — startTime is the customer's requested start time,
      // endTime is the capacity end point (for overlap checks, NOT guaranteed completion)
      bookingDate: new Date(bookingDate),
      startTime,
      endTime: capacityEndTime,
      selectedTimeLabel: startTime, // preferred start time only

      // Payment
      paymentMethod: bookingPaymentMethod,
      paymentStatus: 'pending',
      paymentReference: null,
      gcashNumber: gcashNumber || null,
      downpaymentAmount: bookingPaymentMethod === 'cod' ? (parseFloat(downpaymentAmount) || 400) : 0,
      balanceAmount: bookingPaymentMethod === 'cod'
        ? Math.max(0, (totalPrice || parsedServices[0].totalPrice || 0) - (parseFloat(downpaymentAmount) || 400))
        : 0,
      amountPaid: bookingPaymentMethod === 'cod' ? (parseFloat(downpaymentAmount) || 0) : 0,
      paymentNotes: paymentNotes || null,
      paymentProof: proofImageBase64 || null,

      // Status
      status: 'pending',
      
      // Pricing and travel
      totalPrice: totalPrice || parsedServices[0].totalPrice || 0,
      estimatedFee: totalPrice || parsedServices[0].totalPrice,
      travelFare: travelFare || 0,
      travelTime: travelDurationMinutes || 0,
      distanceKm: distanceKm || 0,
      travelDurationMinutes: travelDurationMinutes || 0,
      
      // Legacy payment fields
      gateway: paymentMethod,
      paymentProof: null,
      
      // Timestamps
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    console.log('📦 Simplified booking data created');
    console.log('  - Service:', parsedServices[0].name);
    console.log('  - Total:', totalPrice);
    console.log('  - Location:', location.address);
    
    // ========================================
    // BACKEND EXPERT: Create and save booking with validated data
    // ========================================
    console.log('\n========================================');
    console.log('� BOOKING CREATION');
    console.log('========================================');
    
    console.log('Booking data prepared:');
    console.log('   Customer ID:', bookingData.customerId);
    console.log('   Customer Name:', bookingData.customer.name);
    console.log('   Customer Email:', bookingData.customer.email);
    console.log('   Technician ID:', bookingData.technicianId);
    console.log('   Technician Name:', bookingData.technician?.name || 'Pending Assignment');
    console.log('   Technician Email:', bookingData.technician?.email || 'Pending Assignment');
    
    // Create booking instance
    console.log('\nCreating BookingService instance...');
    const booking = new BookingService(bookingData);
    
    // CRITICAL: The pre-save hooks will fetch REAL data from database
    // using customerId and technicianId
    console.log('\nSaving booking (pre-save hooks will fetch real data)...');
    await booking.save();

    // ── Large-Scale / Project detection ───────────────────────────────────
    if (req.body.isProject || (req.body.projectScheduling && req.body.projectScheduling.estimatedTotalHours)) {
      const sumServiceQty = Array.isArray(bookingData.services)
        ? bookingData.services.reduce((s, sv) => s + (Number(sv.quantity) || 0), 0)
        : 0;
      const derivedUnits = bookingData.quantity && Number(bookingData.quantity) > 0
        ? Number(bookingData.quantity)
        : (sumServiceQty > 0 ? sumServiceQty : 1);
      const projectInfo = await applyProjectScheduling(booking, req, {
        estimatedTotalHours: bookingData.projectScheduling?.estimatedTotalHours,
        totalUnits: derivedUnits,
      });
      if (projectInfo) {
        Object.assign(booking, projectInfo);
        await booking.save();

        // ── Immediately reserve technician capacity ──────────────────────
        // This prevents double-booking while the project request is pending
        // admin scheduling. The reservation is stored in the Project document.
        try {
          const ps = booking.projectScheduling || {};
          const resStart = ps.preferredStartDate || bookingDate;
          const resEnd = ps.preferredCompletionDeadline || ps.preferredStartDate || bookingDate;

          await schedulingEngine.reserveProjectCapacity({
            bookingId: booking._id,
            startDate: resStart,
            endDate: resEnd,
            reservedTechnicians: 1,
          });
          console.log('  ✅ Technician capacity reserved for project booking:', booking._id);
        } catch (reserveErr) {
          console.warn('  ⚠️ Capacity reservation failed (non-fatal):', reserveErr.message);
        }
      }
    }
    
    // BACKEND EXPERT: Save Payment Schema Integration
    console.log('\nCreating Payment record...');
    try {
      const Payment = require('../models/Payment');

      const paymentAmount = bookingPaymentMethod === 'cod' ? (downpaymentAmount || 400) : (totalPrice || parsedServices[0].totalPrice);
      const paymentSchemaMethod = bookingPaymentMethod === 'cash' ? 'cod' : bookingPaymentMethod;

      const paymentDoc = new Payment({
        bookingId: booking._id,
        amount: paymentAmount,
        method: paymentSchemaMethod,
        type: bookingPaymentMethod === 'cod' ? 'downpayment' : 'final',
        gateway: paymentSchemaMethod,
        reference: paymentReference || gcashNumber || null,
        notes: paymentNotes || gcashNumber || '',
        status: 'pending',
        proofUrl: proofImageBase64 || null
      });

      await paymentDoc.save();
      console.log('✅ Payment record created successfully:', paymentDoc._id);
    } catch (paymentErr) {
      console.error('❌ Failed to create Payment record:', paymentErr);
      // We don't throw to avoid failing the already saved booking, just log it.
    }

    // Verify data after save
    console.log('\n✅ BOOKING SAVED SUCCESSFULLY');
    console.log('========================================');
    console.log('Booking Reference:', booking.bookingReference);
    console.log('Final Customer Data:');
    console.log('   Name:', booking.customer.name);
    console.log('   Email:', booking.customer.email);
    console.log('Final Technician Data:');
    console.log('   Name:', booking.technician?.name || 'Pending Assignment');
    console.log('   Email:', booking.technician?.email || 'Pending Assignment');
    console.log('========================================\n');
    
    // Backend validation: Verify no placeholder data
    if (booking.customer.email === 'customer@example.com') {
      console.error('⚠️ WARNING: Customer email is still placeholder!');
    }
    if (booking.technician?.email === 'technician@example.com') {
      console.error('⚠️ WARNING: Technician email is still placeholder!');
    }
    
    // Send email notification to customer
    try {
      const mailer = require('../utils/mailer');
      
      // Use real customer email and name from fetched user data
      const customerEmail = user.email;
      const customerName = user.name || user.fullName || "Valued Customer";
      
      if (customerEmail) {
        await mailer.sendBookingConfirmationEmail({
          to: customerEmail,
          customerName: customerName,
          bookingReference: booking.bookingReference,
          serviceName: booking.service.name,
          dateLabel: new Date(booking.bookingDate).toLocaleDateString('en-PH', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          }),
          timeLabel: booking.startTime, // requested start time only
          totalLabel: `₱${booking.estimatedFee}`,
          paymentMethod: bookingPaymentMethod,
          estimatedFee: booking.estimatedFee,
          locationAddress: booking.location.address,
          issueDescription: null,
          travelMins: 0,
          serviceDuration: booking.serviceDurationMinutes,
          isConfirmed: false // Pending confirmation
        });
        
        console.log('📧 Booking confirmation email sent to:', customerEmail);
      } else {
        console.warn('⚠️ Customer email not available, skipping email notification');
      }
      
      // Also send notification to technician
      try {
        const technicianEmail = technician?.email || technician?.userEmail;
        const technicianName = technician?.name || "Technician";
        
        if (technicianEmail) {
          await mailer.sendTechnicianNotificationEmail({
            to: technicianEmail,
            technicianName: technicianName,
            customerName: customerName,
            bookingReference: booking.bookingReference,
            serviceName: booking.service.name,
            dateLabel: new Date(booking.bookingDate).toLocaleDateString('en-PH', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            }),
            timeLabel: booking.startTime, // requested start time only
            totalLabel: `₱${booking.estimatedFee}`,
            locationAddress: booking.location.address,
            issueDescription: null
          });
          
          console.log('📧 Technician notification email sent to:', technicianEmail);
        } else {
          console.log('No technician email available for notification, skipping');
        }
      } catch (techEmailError) {
        console.error('⚠️ Failed to send technician email:', techEmailError);
        // Don't fail the booking if technician email fails
      }
    } catch (emailError) {
      console.error('⚠️ Failed to send booking email:', emailError);
      // Don't fail the booking if email fails
    }
    
    // Return success response with all details for the modal
    res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      bookingReference: booking.bookingReference,
      serviceName: booking.service.name,
      serviceNames: parsedServices.map(s => s.name),
      isProject: Boolean(booking.isProject),
      projectScheduling: booking.projectScheduling || undefined,
      dateLabel: new Date(booking.bookingDate).toLocaleDateString('en-PH', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }),
      timeLabel: booking.startTime, // requested start time only
      locationAddress: booking.location.address,
      customerName: booking.customer.name || customerFullName,
      customerEmail: user.email,
      technicianName: booking.technician?.name || (technician ? technician.name : 'Pending Assignment'),
      technicianEmail: booking.technician?.email || (technician ? (technician.userEmail || technician.email) : ''),
      estimatedFee: booking.estimatedFee,
      paymentMethod: bookingPaymentMethod,
      _id: booking._id,
      booking: {
        bookingReference: booking.bookingReference,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        totalPrice: booking.estimatedFee,
        bookingDate: booking.bookingDate,
        startTime: booking.startTime,
        // Note: endTime is the capacity end point, not guaranteed completion
        endTime: booking.endTime,
      }
    });
    
  } catch (error) {
    console.error('❌ Booking creation error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      error: 'Failed to create booking',
      details: error.message
    });
  }
});

// ── Helper functions ───────────────────────────────────────────────────────

/**
 * Parse a time string (12h AM/PM, 24h HH:MM, or minutes-from-midnight) to minutes.
 */
function parseTimeToMinutes(timeValue) {
  if (typeof timeValue === 'number') return timeValue;
  const str = String(timeValue).trim();
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  const ampmMatch = str.match(/\s*(AM|PM)\s*$/i);
  let clean = str.replace(/\s*(AM|PM)\s*$/i, '').trim();
  const [h, m] = clean.split(':').map(Number);
  let hours = h || 0;
  const mins = m || 0;
  if (ampmMatch) {
    const isPM = ampmMatch[1].toUpperCase() === 'PM';
    if (isPM && hours < 12) hours += 12;
    else if (!isPM && hours === 12) hours = 0;
  }
  return hours * 60 + mins;
}

/**
 * Convert minutes-from-midnight to HH:MM 24h string.
 */
function minutesToTimeString(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Convert a large-scale booking into a project.
 * Sets the booking to `pending_project_scheduling`, clears time-slot fields,
 * and creates a linked Project document for the operations team to plan a
 * multi-day schedule. Returns the fields to merge into the booking, or null.
 */
async function applyProjectScheduling(booking, req, opts = {}) {
  try {
    const BookingStatus = require('../models/BookingStatus');
    const Project = require('../models/Project');
    const User = require('../models/User');

    const userId = booking.customerId || req.user?._id;
    const user = await User.findById(userId);

    booking.status = BookingStatus.PENDING_PROJECT_SCHEDULING;
    booking.selectedTimeLabel = undefined;
    booking.startTime = undefined;
    booking.endTime = undefined;
    booking.isProject = true;

    const ps = booking.projectScheduling || {};
    const estimatedTotalHours = Number(opts.estimatedTotalHours) || ps.estimatedTotalHours || 0;
    const sumServiceQty = Array.isArray(booking.services)
      ? booking.services.reduce((s, sv) => s + (Number(sv.quantity) || 0), 0)
      : 0;
    const customerQuantity = Number(booking.quantity) > 0
      ? Number(booking.quantity)
      : (sumServiceQty > 0 ? sumServiceQty : 1);
    const totalUnits = Number(opts.totalUnits) > 0
      ? Number(opts.totalUnits)
      : customerQuantity;

    // Avoid duplicate project documents
    const existing = await Project.findOne({ bookingId: booking._id });
    if (!existing) {
      const projectData = {
        bookingId: booking._id,
        customerId: userId,
        customer: {
          _id: userId,
          name: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.name : (booking.customer?.name || ''),
          email: user?.email || booking.customer?.email || '',
          phone: user?.phone || user?.mobile || booking.customer?.phone || '',
          address: typeof user?.address === 'string' ? user.address : (booking.location?.address || booking.customer?.address || ''),
        },
        service: {
          name: booking.service?.name || booking.serviceName || (booking.serviceType === 'repair' ? ['Repair', booking.unitInfo?.unitType, booking.unitInfo?.brand, booking.unitInfo?.model].filter(Boolean).join(' — ') : 'Service'),
          description: booking.service?.description || '',
          category: booking.service?.category || '',
        },
        status: 'pending_project_scheduling',
        estimatedTotalHours,
        totalUnits,
        quantity: customerQuantity,
        estimatedDurationPerUnit: estimatedTotalHours && totalUnits ? parseFloat((estimatedTotalHours / totalUnits).toFixed(1)) : undefined,
        preferredStartDate: ps.preferredStartDate || undefined,
        preferredWorkingDays: ps.preferredWorkingDays || [],
        preferredWorkingHours: ps.preferredWorkingHours || undefined,
        preferredCompletionDeadline: ps.preferredCompletionDeadline || undefined,
        reservedTechnicians: 1,
        plannedStartDate: ps.preferredStartDate ? new Date(ps.preferredStartDate) : undefined,
        location: booking.location ? {
          address: booking.location.address,
          lat: booking.location.lat,
          lng: booking.location.lng,
        } : undefined,
        isLargeScale: await require('../utils/enterpriseSchedulingEngine')
          .isLargeProject({ totalEstimatedMinutes: Math.round((estimatedTotalHours || 0) * 60) })
          .catch(() => false),
      };

      // ── Populate repair data from BookingService ──
      if (booking.serviceType === 'repair') {
        const Tool = require('../models/Tool');
        const quotationParts = (booking.quotation?.parts || []).map(p => ({
          name: p.name,
          cost: p.cost,
          quantity: p.quantity,
          toolId: p.toolId,
          currentStock: 0,
          stockStatus: 'pending_check',
        }));
        // Enrich parts with current stock
        for (const part of quotationParts) {
          if (part.toolId) {
            try {
              const tool = await Tool.findById(part.toolId).lean();
              if (tool) {
                part.currentStock = tool.availableQuantity || tool.quantity || 0;
                part.stockStatus = part.currentStock >= part.quantity ? 'in_stock'
                  : part.currentStock > 0 ? 'low_stock' : 'out_of_stock';
              }
            } catch (_) {}
          }
        }
        projectData.repair = {
          serviceType: 'repair',
          unitInfo: {
            unitType: booking.unitInfo?.unitType || '',
            brand: booking.unitInfo?.brand || '',
            model: booking.unitInfo?.model || '',
            problemDescription: booking.unitInfo?.problemDescription || '',
            photos: booking.unitInfo?.photos || [],
          },
          inspection: {
            findings: booking.inspection?.findings || '',
            severity: booking.inspection?.severity || '',
            damagedParts: booking.inspection?.damagedParts || [],
            recommendedAction: booking.inspection?.recommendedAction || '',
            technicianName: booking.inspection?.technicianId?.name || '',
            completedAt: booking.inspection?.completedAt,
          },
          diagnosis: {
            summary: booking.diagnosis?.diagnosisSummary || booking.diagnosis?.findings || '',
            confirmedDiagnoses: booking.diagnosis?.confirmedDiagnoses || [],
            laborCategory: booking.diagnosis?.laborCategory || booking.quotation?.laborCategory || 'standard',
            laborDuration: booking.diagnosis?.laborDuration || '',
            technicianName: booking.diagnosis?.technicianId?.name || '',
          },
          aiAssist: {
            summary: booking.technicianAssistant?.summary || '',
            probableCauses: booking.technicianAssistant?.probableCauses || [],
            suggestedTools: booking.technicianAssistant?.suggestedTools || [],
            possibleParts: booking.technicianAssistant?.possibleParts || [],
            repairComplexity: booking.technicianAssistant?.repairComplexity || '',
            estimatedDurationMinutes: booking.technicianAssistant?.estimatedDurationMinutes || 0,
            safetyReminders: booking.technicianAssistant?.safetyReminders || [],
          },
          quotation: {
            parts: quotationParts,
            laborCost: booking.quotation?.laborCost || 0,
            laborCategory: booking.quotation?.laborCategory || 'standard',
            totalCost: booking.quotation?.totalCost || 0,
            notes: booking.quotation?.notes || '',
            approvedAt: booking.approval?.status === 'approved' ? booking.approval.decidedAt : undefined,
          },
          warranty: {
            days: 30,
          },
        };
      }

      // ── Populate unitGroups for multi-appliance tracking ──────────────
      // When the booking has multiple services (isMultiService), build
      // unitGroups so each appliance type is tracked independently.
      if (booking.isMultiService && Array.isArray(booking.services) && booking.services.length > 0) {
        projectData.unitGroups = booking.services.map((svc, idx) => {
          const units = [];
          const qty = Number(svc.quantity) || 1;
          for (let i = 1; i <= qty; i++) {
            units.push({
              unitIndex: i,
              label: `${svc.name || 'Unit'} #${i}`,
              status: 'pending',
            });
          }
          return {
            groupIndex: idx,
            serviceId: svc.serviceId,
            serviceName: svc.name,
            serviceType: svc.type || 'repair',
            unitType: svc.airconTypeName || svc.name || 'Unknown',
            brand: svc.brand || '',
            model: '',
            applianceType: svc.applianceType || svc.airconType || '',
            applianceTypeName: svc.airconTypeName || '',
            hp: svc.hp || null,
            hpDescription: svc.hpDescription || '',
            problemDescription: svc.repairIssue || '',
            quantity: qty,
            unitPrice: svc.unitPrice || 0,
            totalPrice: svc.totalPrice || 0,
            repairIssue: svc.repairIssue || '',
            duration: svc.duration || 60,
            inspection: {},
            diagnosis: {},
            quotation: { parts: [], laborCost: 0, totalCost: 0 },
            partsUsed: [],
            units,
            completedUnits: 0,
            inspectedUnits: 0,
          };
        });
      } else if (booking.serviceType === 'repair' && booking.unitInfo) {
        // Single-service repair: create one unitGroup from top-level unitInfo
        const qty = Number(booking.quantity) || 1;
        const units = [];
        for (let i = 1; i <= qty; i++) {
          units.push({
            unitIndex: i,
            label: `${booking.unitInfo.unitType || 'Unit'} #${i}`,
            status: 'pending',
          });
        }
        projectData.unitGroups = [{
          groupIndex: 0,
          serviceId: booking.serviceId,
          serviceName: booking.service?.name || 'Repair',
          serviceType: 'repair',
          unitType: booking.unitInfo.unitType || 'Unknown',
          brand: booking.unitInfo.brand || booking.brand || '',
          model: booking.unitInfo.model || '',
          applianceType: booking.applianceType || '',
          applianceTypeName: booking.applianceTypeName || '',
          hp: null,
          hpDescription: '',
          problemDescription: booking.unitInfo.problemDescription || '',
          quantity: qty,
          unitPrice: booking.servicePrice || 0,
          totalPrice: booking.totalPrice || 0,
          repairIssue: booking.issueDescription || '',
          duration: booking.serviceDurationMinutes || 60,
          inspection: {},
          diagnosis: {},
          quotation: { parts: [], laborCost: 0, totalCost: 0 },
          partsUsed: [],
          units,
          completedUnits: 0,
          inspectedUnits: 0,
        }];
      }

      await Project.create(projectData);
    }

    return {
      status: booking.status,
      isProject: true,
    };
  } catch (err) {
    console.warn('⚠️ Project scheduling conversion failed:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/bookings/create-repair
// Simple Repair Request Creation
// ═══════════════════════════════════════════════════════════════════════════
const multer = require('multer');
const path = require('path');

// Configure multer for repair photo uploads
const repairStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../public/uploads/repairs'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'repair-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const repairUpload = multer({
  storage: repairStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
  fileFilter: function (req, file, cb) {
    const allowed = /jpeg|jpg|png|webp/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    cb(null, extOk && mimeOk);
  }
}).fields([
  { name: 'photos', maxCount: 5 },
  { name: 'gcashProof', maxCount: 1 },
  { name: 'cashProof', maxCount: 1 },
]);

// Ensure uploads directory exists
const fs = require('fs');
const uploadsDir = path.join(__dirname, '../public/uploads/repairs');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

router.post('/create-repair', (req, res, next) => {
  repairUpload(req, res, function (err) {
    if (err) {
      console.error('Repair upload error:', err.code, err.message);
      let userMessage = 'Photo upload failed.';
      if (err.code === 'LIMIT_FILE_SIZE') {
        userMessage = 'One or more files exceed the 5MB size limit. Please compress your images and try again.';
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        userMessage = 'Unexpected file field: ' + err.field;
      } else {
        userMessage = 'Photo upload failed: ' + err.message;
      }
      return res.status(400).json({ success: false, message: userMessage });
    }
    next();
  });
}, async (req, res) => {
  const startTime = Date.now();
  try {
    console.log('🔧 Creating repair request...');

    const {
      unitType, brand, model, problemDescription,
      address, lat, lng, distanceKm, travelFare,
      diagnosticFee, paymentMethod,
      gcashNumber, cashNumber, downpaymentAmount,
      preferredDate, preferredTime,
      quantity, isProject, projectScheduling
    } = req.body;

    // ── Step 1: Input Validation ──────────────────────────────────────────
    const errors = [];
    if (!unitType || unitType.trim().length < 2) errors.push('Unit type is required');
    if (!brand || brand.trim().length < 2) errors.push('Brand is required');
    if (!problemDescription || problemDescription.trim().length < 10) {
      errors.push('Problem description must be at least 10 characters');
    }
    if (!address || address.trim().length < 5) errors.push('Valid address is required');
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (isNaN(latNum) || isNaN(lngNum)) errors.push('Location coordinates are required');
    if (!paymentMethod || !['gcash', 'cod'].includes(paymentMethod)) {
      errors.push('Valid payment method is required (gcash or cod)');
    }
    if (paymentMethod === 'cod' && (!downpaymentAmount || parseFloat(downpaymentAmount) < 0)) {
      errors.push('Downpayment amount is required for cash on delivery');
    }

    if (errors.length > 0) {
      console.error('Repair validation failed:', errors, {
        unitType, brand, problemDescription: problemDescription?.substring(0, 30),
        address: address?.substring(0, 30), lat, lng, paymentMethod, downpaymentAmount
      });
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors
      });
    }

    const now = new Date();

    // ── Step 2: Validate Capacity for Inspection Slot ─────────────────────
    // Repair requests book an INSPECTION, not the full repair.
    // Only inspection duration reserves technician capacity.
    const inspectionDuration = await getInspectionDurationMinutes();
    const travelTimeDefault = 30; // default travel buffer
    const bufferTime = await getBufferMinutes();
    
    // Parse preferred time to minutes for capacity check
    let preferredTimeMinutes = 0;
    if (preferredTime) {
      const timeStr = String(preferredTime).trim();
      const ampmMatch = timeStr.match(/\s*(AM|PM)\s*$/i);
      let cleanTime = timeStr.replace(/\s*(AM|PM)\s*$/i, '').trim();
      const [h, m] = cleanTime.split(':').map(Number);
      let hours = h || 0;
      const mins = m || 0;
      if (ampmMatch) {
        const isPM = ampmMatch[1].toUpperCase() === 'PM';
        if (isPM && hours < 12) hours += 12;
        else if (!isPM && hours === 12) hours = 0;
      }
      preferredTimeMinutes = hours * 60 + mins;
    }

    // Compute capacity end point: inspection duration + travel + buffer
    const capacityEndMinutes = preferredTimeMinutes + inspectionDuration + travelTimeDefault + bufferTime;
    
    // Parse preferred date
    const parsedPreferredDate = (() => {
      if (!preferredDate) return null;
      const parts = String(preferredDate).split('-');
      if (parts.length !== 3) return null;
      return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    })();
    
    const inspectionDate = parsedPreferredDate || new Date();

    // Company-wide capacity check
    if (isProject) {
      // For large-scale repair projects: validate the ENTIRE date range
      const ps = projectScheduling ? (typeof projectScheduling === 'string' ? JSON.parse(projectScheduling) : projectScheduling) : {};
      const projStartDate = ps.preferredStartDate || preferredDate;
      const projEndDate = ps.preferredCompletionDeadline || ps.preferredStartDate || preferredDate;

      if (projStartDate && projEndDate) {
        const estHours = ps.estimatedTotalHours || (Number(quantity) || 1) * 1.5;
        const rangeDays = Math.max(1, Math.ceil((new Date(projEndDate) - new Date(projStartDate)) / 86400000) + 1);
        const requiredTechs = Math.max(1, Math.ceil(estHours / (rangeDays * 8)));

        const rangeCheck = await schedulingEngine.validateProjectDateRange({
          startDate: projStartDate,
          endDate: projEndDate,
          requiredTechnicians: requiredTechs,
          serviceModel: 'RepairService',
        });

        if (!rangeCheck.valid || !rangeCheck.available) {
          let msg = rangeCheck.message || 'The selected date range cannot be accommodated.';
          if (rangeCheck.nextAvailableRange) {
            msg += ` Suggested alternative: ${rangeCheck.nextAvailableRange.startDate} to ${rangeCheck.nextAvailableRange.endDate}.`;
          }
          return res.status(409).json({ success: false, message: msg, validationResult: rangeCheck });
        }
      }
    } else {
      try {
        await assertCompanyCapacity(inspectionDate, preferredTimeMinutes, capacityEndMinutes);
      } catch (capacityErr) {
        console.warn('⚠️ Capacity check failed for repair inspection:', capacityErr.message);
        return res.status(409).json({ 
          success: false, 
          message: 'This time slot is no longer available. Please select a different time for your inspection.' 
        });
      }
    }

    // ── Step 3: Create Repair Request ─────────────────────────────────────
    const bookingPaymentMethod = paymentMethod === 'cash' ? 'cod' : paymentMethod;
    const photoUrls = (req.files?.photos || []).map(f => '/uploads/repairs/' + f.filename);
    const gcashProofUrl = req.files?.gcashProof?.[0] ? '/uploads/repairs/' + req.files.gcashProof[0].filename : '';
    const cashProofUrl = req.files?.cashProof?.[0] ? '/uploads/repairs/' + req.files.cashProof[0].filename : '';

    const diagFee = diagnosticFee ? parseFloat(diagnosticFee) : 500;
    const tFare = travelFare ? parseFloat(travelFare) : 0;

    // Compute capacity end time string for the booking record
    const capacityEndTimeStr = (() => {
      const h = Math.floor(capacityEndMinutes / 60);
      const m = capacityEndMinutes % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    })();

    const booking = new BookingService({
      customerId: req.user._id,
      serviceModel: 'RepairService',
      serviceType: 'repair',
      // Enterprise: Initial status is 'repair_requested' — an inspection request,
      // NOT a repair job. Full diagnosis requires on-site inspection first.
      status: 'repair_requested',

      // Unit information
      unitInfo: {
        unitType: unitType.trim(),
        brand: brand.trim(),
        model: (model || '').trim(),
        problemDescription: problemDescription.trim(),
        photos: photoUrls,
      },

      // Location
      location: {
        address: address.trim(),
        lat: latNum,
        lng: lngNum,
      },
      distanceKm: distanceKm ? parseFloat(distanceKm) : 0,
      travelFare: tFare,

      // Fees — diagnostic fee + travel fare (inspection cost only)
      initialCost: diagFee,
      estimatedFee: diagFee + tFare,

      // Enterprise: Show notice that inspection fee covers diagnostic visit
      // Actual repair cost will be quoted after inspection

      // Payment
      paymentMethod: bookingPaymentMethod,
      gcashNumber: gcashNumber || '',
      paymentProof: bookingPaymentMethod === 'gcash' ? gcashProofUrl : cashProofUrl,
      paymentStatus: 'pending',
      downpaymentAmount: bookingPaymentMethod === 'cod' ? (parseFloat(downpaymentAmount) || 0) : 0,
      balanceAmount: bookingPaymentMethod === 'cod'
        ? Math.max(0, (diagFee + tFare) - (parseFloat(downpaymentAmount) || 0))
        : 0,
      amountPaid: bookingPaymentMethod === 'cod' ? (parseFloat(downpaymentAmount) || 0) : 0,
      paymentNotes: bookingPaymentMethod === 'cod' ? `Mobile: ${cashNumber || ''}` : '',

      issueDescription: problemDescription.trim(),

      // Enterprise: preferredDate is the inspection date, NOT the repair date
      preferredDate: parsedPreferredDate,
      preferredTime: preferredTime || '',

      // Enterprise: Set scheduling fields so capacity checks can detect this booking
      // Only inspection duration reserves capacity (not the full repair)
      startTime: preferredTime || '',
      serviceDurationMinutes: inspectionDuration, // configurable inspection duration
      travelTime: travelTimeDefault, // default travel buffer in minutes
      endTime: capacityEndTimeStr, // capacity end point for overlap detection

      // Enterprise: bookingDate uses the preferred inspection date
      // (the date the customer wants the technician to visit)
      bookingDate: inspectionDate,

      // Large-scale / project support (multi-unit repair)
      quantity: Number(quantity) || 1,
      isProject: Boolean(isProject) || false,
      projectScheduling: projectScheduling ? (typeof projectScheduling === 'string' ? JSON.parse(projectScheduling) : projectScheduling) : undefined,

      customer: {
        _id: req.user._id,
        name: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.name || 'Customer',
        email: req.user.email || '',
        phone: req.user.phone || req.user.mobile || '',
      },

      // Enterprise: Record initial status in audit trail
      statusHistory: [{
        fromStatus: null,
        toStatus: 'repair_requested',
        changedBy: req.user._id,
        changedByModel: 'User',
        changedByName: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || 'Customer',
        reason: 'Customer submitted repair request',
        notes: `${unitType} - ${brand} ${model || ''}: ${problemDescription}`.trim(),
        timestamp: new Date(),
      }],
    });

    await booking.save();
    console.log(`  ✅ Repair request created: ${booking.workOrderNumber || booking._id}`);

    // ── Large-Scale / Project detection (multi-unit repair) ──────────────
    if (booking.isProject || (booking.projectScheduling && booking.projectScheduling.estimatedTotalHours)) {
      const projectInfo = await applyProjectScheduling(booking, req, {
        estimatedTotalHours: booking.projectScheduling?.estimatedTotalHours,
        totalUnits: booking.quantity || 1,
      });
      if (projectInfo) {
        Object.assign(booking, projectInfo);
        await booking.save();
        console.log(`  🏗️ Converted to project booking: ${booking._id}`);

        // ── Immediately reserve technician capacity ──────────────────────
        try {
          const ps = booking.projectScheduling || {};
          const psParsed = typeof ps === 'object' ? ps : {};
          const resStart = psParsed.preferredStartDate || preferredDate || bookingDate;
          const resEnd = psParsed.preferredCompletionDeadline || psParsed.preferredStartDate || resStart;

          await schedulingEngine.reserveProjectCapacity({
            bookingId: booking._id,
            startDate: resStart,
            endDate: resEnd,
            reservedTechnicians: 1,
          });
          console.log('  ✅ Technician capacity reserved for repair project:', booking._id);
        } catch (reserveErr) {
          console.warn('  ⚠️ Capacity reservation failed (non-fatal):', reserveErr.message);
        }
      }
    }

    // ── Step 3: Send Notifications ────────────────────────────────────────
    try {
      if (req.user && req.user.email) {
        const customerName = [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.name || 'Customer';
        const workOrder = booking.workOrderNumber || booking._id;
        const preferredDateLabel = booking.preferredDate
          ? booking.preferredDate.toLocaleDateString('en-PH', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              timeZone: 'Asia/Manila',
            })
          : '';

        await sendRepairRequestSubmittedEmail({
          to: req.user.email,
          customerName,
          workOrderNumber: workOrder,
          unitType,
          brand,
          model,
          problemDescription,
          preferredDateLabel,
          preferredTime,
          locationAddress: address,
          estimatedFee: booking.estimatedFee,
          paymentMethod: booking.paymentMethod,
        });
        console.log(`  📧 Confirmation email sent to ${req.user.email}`);
      }
    } catch (emailErr) {
      console.error('  ⚠️ Email failed:', emailErr.message);
    }

    // ── Step 4: Real-time Notification to Admin ───────────────────────────
    if (global.io) {
      global.io.to('admin').emit('repair:created', {
        bookingId: booking._id,
        workOrderNumber: booking.workOrderNumber,
        unitType,
        brand,
        customerName: booking.customer.name,
      });
    }

    const elapsed = Date.now() - startTime;
    console.log(`  ⏱️ Total processing time: ${elapsed}ms`);

    res.status(201).json({
      success: true,
      workOrderNumber: booking.workOrderNumber,
      bookingId: booking._id,
      status: booking.status,
      message: 'Repair request submitted successfully.',
    });
  } catch (err) {
    console.error('❌ Repair request creation failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create repair request: ' + err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOMER QUOTATION ACTIONS (Enterprise with Audit Trail)
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/bookings/:id/approve-quotation
router.post('/:id/approve-quotation', async (req, res) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (booking.customerId?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not your booking' });
    }
    if (booking.status !== 'awaiting_approval') {
      return res.status(400).json({ success: false, message: `Cannot approve from status: ${booking.status}` });
    }

    booking.approval = { status: 'approved', decidedAt: new Date(), reason: 'Approved by customer' };

    // Enterprise: Record status transition with audit trail
    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      fromStatus: 'awaiting_approval',
      toStatus: 'repair_approved',
      changedBy: req.user._id,
      changedByModel: 'User',
      changedByName: booking.customer?.name || 'Customer',
      reason: 'Customer approved quotation',
      notes: req.body.notes || '',
      timestamp: new Date(),
      metadata: {
        quotationTotal: booking.quotation?.totalCost || 0,
        partsCount: booking.quotation?.parts?.length || 0
      }
    });
    booking.status = 'repair_approved';
    await booking.save();

    // Notify admin + technician
    if (global.io) {
      global.io.to('admin').emit('booking:updated', {
        bookingId: booking._id,
        status: booking.status,
        priority: booking.priority,
        message: `Quotation approved for ${booking.workOrderNumber || ''}`
      });
      if (booking.technicianId) {
        global.io.to(`tech:${booking.technicianId}`).emit('booking:updated', {
          bookingId: booking._id, status: booking.status,
          message: `Quotation approved by customer for ${booking.workOrderNumber || ''}. You can now proceed with parts reservation and repair.`
        });
      }
    }

    // Notify customer
    try {
      const { sendEmail } = require('../utils/mailer');
      if (booking.customer?.email) {
        await sendEmail(booking.customer.email, 'Quotation Approved',
          `Your quotation for work order ${booking.workOrderNumber || ''} has been approved.\n\nTotal: ₱${booking.quotation?.totalCost?.toLocaleString() || '0'}\n\nOur technician will proceed with parts reservation and schedule the repair. You will be notified of the next steps.`);
      }
    } catch (e) { /* non-critical */ }

    res.json({ success: true, status: booking.status, quotation: booking.quotation });
  } catch (err) {
    console.error('Approve quotation error:', err);
    res.status(500).json({ success: false, message: 'Failed to approve quotation' });
  }
});

// POST /api/bookings/:id/decline-quotation
router.post('/:id/decline-quotation', async (req, res) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (booking.customerId?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not your booking' });
    }
    if (booking.status !== 'awaiting_approval') {
      return res.status(400).json({ success: false, message: `Cannot decline from status: ${booking.status}` });
    }

    const { reason } = req.body;
    booking.approval = { status: 'declined', decidedAt: new Date(), reason: reason || 'Declined by customer' };

    // Enterprise: Record status transition with audit trail
    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      fromStatus: 'awaiting_approval',
      toStatus: 'repair_declined',
      changedBy: req.user._id,
      changedByModel: 'User',
      changedByName: booking.customer?.name || 'Customer',
      reason: reason || 'Declined by customer',
      notes: '',
      timestamp: new Date(),
      metadata: {
        quotationTotal: booking.quotation?.totalCost || 0,
        declineReason: reason || 'No reason provided'
      }
    });
    booking.status = 'repair_declined';
    await booking.save();

    if (global.io) {
      global.io.to('admin').emit('booking:updated', {
        bookingId: booking._id, status: booking.status, priority: booking.priority,
        message: `Quotation declined for ${booking.workOrderNumber || ''}. Reason: ${reason || 'No reason'}`
      });
      if (booking.technicianId) {
        global.io.to(`tech:${booking.technicianId}`).emit('booking:updated', {
          bookingId: booking._id, status: booking.status,
          message: `Quotation declined by customer for ${booking.workOrderNumber || ''}`
        });
      }
    }

    // Notify customer
    try {
      const { sendEmail } = require('../utils/mailer');
      if (booking.customer?.email) {
        await sendEmail(booking.customer.email, 'Quotation Declined',
          `You have declined the quotation for work order ${booking.workOrderNumber || ''}.\n\nIf you have any questions or would like to request a revised quotation, please contact us.\n\nThank you for your feedback.`);
      }
    } catch (e) { /* non-critical */ }

    res.json({ success: true, status: booking.status });
  } catch (err) {
    console.error('Decline quotation error:', err);
    res.status(500).json({ success: false, message: 'Failed to decline quotation' });
  }
});

// POST /api/bookings/:id/warranty-claim
// Customer files a warranty claim
router.post('/:id/warranty-claim', async (req, res) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (booking.customerId?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not your booking' });
    }
    if (booking.status !== 'under_warranty' && booking.status !== 'repair_completed') {
      return res.status(400).json({ success: false, message: `Cannot file claim from status: ${booking.status}` });
    }
    if (booking.warranty?.status === 'expired') {
      return res.status(400).json({ success: false, message: 'Warranty has expired' });
    }
    if (booking.warranty?.status === 'claimed') {
      return res.status(400).json({ success: false, message: 'A claim is already active for this booking' });
    }

    const { issue } = req.body;
    if (!issue || !issue.trim()) {
      return res.status(400).json({ success: false, message: 'Issue description is required' });
    }

    booking.warranty.status = 'claimed';
    booking.warranty.claimIssue = issue.trim();
    booking.warranty.claimedAt = new Date();

    if (!booking.statusHistory) booking.statusHistory = [];
    booking.statusHistory.push({
      fromStatus: booking.status,
      toStatus: 'warranty_claim',
      changedBy: req.user._id,
      changedByModel: 'User',
      changedByName: booking.customer?.name || 'Customer',
      reason: 'Warranty claim filed',
      notes: issue.trim(),
      timestamp: new Date(),
    });
    booking.status = 'warranty_claim';
    await booking.save();

    if (global.io) {
      global.io.to('admin').emit('booking:updated', {
        bookingId: booking._id,
        status: booking.status,
        message: `Warranty claim filed for ${booking.workOrderNumber || booking._id}: ${issue.substring(0, 100)}`,
      });
    }

    res.json({ success: true, status: booking.status });
  } catch (err) {
    console.error('Warranty claim error:', err);
    res.status(500).json({ success: false, message: 'Failed to file warranty claim' });
  }
});

module.exports = router;

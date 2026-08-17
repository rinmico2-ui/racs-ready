const express = require('express');
const router = express.Router();
const BookingService = require('../models/BookingService');
const auth = require('../middleware/authenticate');
const { getBufferMinutes, assertCompanyCapacity, getInspectionDurationMinutes } = require('../utils/bookingPolicy');
const schedulingEngine = require('../utils/enterpriseSchedulingEngine');
const { sendRepairRequestSubmittedEmail } = require('../utils/mailer');
const CoreService = require('../models/CoreService');
const RepairService = require('../models/RepairService');
const { createNotification } = require('../utils/notify');
const { bookingServices, mutationPolicy, summarizeChanges, capacityMinutes, aggregateBookingType } = require('../utils/bookingServiceItems');
const audit = require('../utils/audit');
const { getDownpaymentPercentage, calculatePaymentBreakdown } = require('../utils/paymentPolicy');

// Protect all booking routes with authentication
router.use(auth.authenticate);
router.use(auth.requireRole("customer"));

/**
 * POST /api/bookings/create-new
 * Simplified booking creation endpoint
 */
router.post('/create-new', async (req, res) => {
  let savedBooking = null;
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
      downpaymentAmount: _clientDownpaymentAmount,
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
    const normalizedQuantities = parsedServices.map(service => Number(service.quantity));
    if (normalizedQuantities.some(value => !Number.isInteger(value) || value < 1)) {
      return res.status(400).json({ error: 'Every service quantity must be a whole number of at least 1.' });
    }
    const totalBookingUnits = normalizedQuantities.reduce((sum, value) => sum + value, 0);
    if (totalBookingUnits > schedulingEngine.MAX_BOOKING_UNITS) {
      return res.status(400).json({ error: `A booking can contain at most ${schedulingEngine.MAX_BOOKING_UNITS} units across all Core and Repair services.` });
    }
    const effectiveIsProject = totalBookingUnits >= schedulingEngine.LARGE_SCALE_MIN_UNITS;
    
    if (!location || !location.lat || !location.lng) {
      return res.status(400).json({ error: 'Valid location is required' });
    }
    
    if (!bookingDate) {
      return res.status(400).json({ error: 'A date is required' });
    }

    // Large-scale / project bookings have no fixed time slot — only a start date.
    if (!effectiveIsProject && !startTime) {
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
    const inspectionDurationMinutes = await getInspectionDurationMinutes();
    const serviceDurationMin = capacityMinutes(parsedServices, inspectionDurationMinutes);
    const travelDurationMin = Number(travelDurationMinutes) || Number(distanceKm) * 2 || 0;
    const bufferMin = await getBufferMinutes();
    const startMin = effectiveIsProject ? null : parseTimeToMinutes(startTime);
    const capacityEndMinutes = startMin == null ? null : startMin + serviceDurationMin + travelDurationMin + bufferMin;
    const capacityEndTime = capacityEndMinutes == null ? undefined : minutesToTimeString(capacityEndMinutes);

    // ── Company-wide capacity check ──────────────────────────────────────
    // For standard bookings: check single time slot.
    // For project bookings: validate the ENTIRE date range has sufficient
    // technician capacity for every working day.
    if (effectiveIsProject) {
      const ps = projectScheduling || {};
      const projStartDate = ps.preferredStartDate || bookingDate;
      const projEndDate = ps.preferredCompletionDeadline || ps.preferredStartDate || bookingDate;

      if (projStartDate && projEndDate) {
        const sumQty = Array.isArray(parsedServices)
          ? parsedServices.reduce((s, sv) => s + (Number(sv.quantity) || 0), 0)
          : 0;
        const totalQty = Number(quantity) > 0 ? Number(quantity) : (sumQty > 0 ? sumQty : 1);
        const estHours = Number(ps.estimatedTotalHours) || (serviceDurationMin / 60);
        const rangeDays = Math.max(1, Math.ceil((new Date(projEndDate) - new Date(projStartDate)) / 86400000) + 1);
        const requiredTechs = Math.max(1, Math.ceil(estHours / (rangeDays * 8)));

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
    
    // ── Build services array with clean, serializable objects ──────────────
    // Deep-clone via JSON round-trip to strip any prototype methods,
    // getters, or non-serializable values that could confuse Mongoose.
    const cleanServices = JSON.parse(JSON.stringify(parsedServices.map(svc => ({
      serviceId: svc.serviceId || null,
      name: svc.name || '',
      type: svc.type || 'core',
      quantity: Number(svc.quantity) || 1,
      unitPrice: Number(svc.unitPrice) || 0,
      totalPrice: Number(svc.totalPrice) || 0,
      hp: svc.hp != null ? Number(svc.hp) : null,
      hpDescription: svc.hpDescription || null,
      airconType: svc.airconType || null,
      airconTypeName: svc.airconTypeName || null,
      applianceType: svc.applianceType || null,
      applianceTypeName: svc.applianceTypeName || null,
      brand: svc.brand || null,
      duration: svc.duration != null ? Number(svc.duration) : null,
      isAirconService: Boolean(svc.isAirconService),
      repairIssue: svc.repairIssue || null,
      problemDescription: svc.problemDescription || svc.repairIssue || null,
      model: svc.model || null,
      status: svc.type === 'repair' ? 'inspection_pending' : 'pending',
      phase: svc.type === 'repair' ? 'repair_phase_1' : 'core',
      schedule: {
        date: bookingDate ? new Date(bookingDate) : undefined,
        startTime,
        endTime: capacityEndTime,
        durationMinutes: svc.type === 'repair' ? inspectionDurationMinutes : (Number(svc.duration) || 60),
        kind: svc.type === 'repair' ? 'inspection' : 'service',
      },
      initialCost: svc.initialCost != null ? Number(svc.initialCost) : null,
    }))));

    // Rebuild the amount used for the payment policy from the submitted
    // service lines and fare, then calculate the server-authoritative deposit.
    const serviceTotal = cleanServices.reduce((sum, service) => sum + Math.max(0, Number(service.totalPrice) || 0), 0);
    const authoritativeTotal = Math.max(0, serviceTotal + Math.max(0, Number(travelFare) || 0));
    const downpaymentPercentage = await getDownpaymentPercentage();
    const paymentBreakdown = calculatePaymentBreakdown(authoritativeTotal, downpaymentPercentage);

    console.log('✅ cleanServices type:', typeof cleanServices, 'isArray:', Array.isArray(cleanServices), 'length:', cleanServices.length);

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
      serviceType: aggregateBookingType(cleanServices),
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
      hp: parsedServices[0].hp || null,
      hpDescription: parsedServices[0].hpDescription || null,

      // Multi-service support — persist the full services array so HP and
      // per-service data are preserved for admin view details.
      isMultiService: cleanServices.length > 1,
      services: cleanServices,

      // Large-scale / project support
      isProject: effectiveIsProject,
      quantity: totalBookingUnits,
      projectScheduling: effectiveIsProject ? {
        preferredStartDate: projectScheduling?.preferredStartDate ? new Date(projectScheduling.preferredStartDate) : new Date(bookingDate),
        preferredWorkingDays: Array.isArray(projectScheduling?.preferredWorkingDays) ? projectScheduling.preferredWorkingDays : undefined,
        preferredWorkingHours: projectScheduling?.preferredWorkingHours || undefined,
        preferredCompletionDeadline: projectScheduling?.preferredCompletionDeadline ? new Date(projectScheduling.preferredCompletionDeadline) : undefined,
        estimatedTotalHours: projectScheduling?.estimatedTotalHours ? Number(projectScheduling.estimatedTotalHours) : Number((serviceDurationMin / 60).toFixed(1)),
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

      // Pricing and travel
      totalPrice: authoritativeTotal,
      estimatedFee: authoritativeTotal,
      totalInitialCost: parsedServices[0].initialCost || 0,
      travelFare: travelFare || 0,
      travelTime: travelDurationMinutes || 0,
      distanceKm: distanceKm || 0,
      travelDurationMinutes: travelDurationMinutes || 0,

      // Payment
      paymentMethod: bookingPaymentMethod,
      paymentStatus: 'pending',
      paymentReference: null,
      gcashNumber: gcashNumber || null,
      downpaymentPercentage: bookingPaymentMethod === 'cod' ? paymentBreakdown.downpaymentPercentage : 100,
      downpaymentAmount: bookingPaymentMethod === 'cod' ? paymentBreakdown.downpaymentAmount : authoritativeTotal,
      balanceAmount: bookingPaymentMethod === 'cod' ? paymentBreakdown.balanceAmount : 0,
      amountPaid: 0,
      paymentNotes: paymentNotes || null,
      paymentProof: proofImageBase64 || null,

      // Status
      status: 'pending',
      
      // Legacy payment fields
      gateway: paymentMethod,
      
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
    savedBooking = booking;

    // ── Large-Scale / Project detection ───────────────────────────────────
    if (effectiveIsProject) {
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

      const paymentAmount = bookingPaymentMethod === 'cod' ? paymentBreakdown.downpaymentAmount : authoritativeTotal;
      // Both choices use a manual GCash transfer at booking time. "cod"
      // describes how the remaining balance will be collected, not the deposit channel.
      const paymentSchemaMethod = bookingPaymentMethod === 'cod' ? 'gcash' : bookingPaymentMethod;

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
    // A committed booking is successful even if later notification/payment
    // follow-up fails. Returning 500 here would invite a duplicate retry.
    if (savedBooking && !res.headersSent) {
      return res.status(201).json({
        success: true,
        message: 'Booking created successfully. Follow-up processing will continue in the background.',
        warning: error.message,
        bookingReference: savedBooking.bookingReference,
        serviceName: savedBooking.service?.name || req.body?.services?.[0]?.name || 'Selected Service',
        serviceNames: Array.isArray(req.body?.services) ? req.body.services.map(s => s.name).filter(Boolean) : [],
        isProject: Boolean(savedBooking.isProject),
        projectScheduling: savedBooking.projectScheduling || undefined,
        dateLabel: savedBooking.bookingDate ? new Date(savedBooking.bookingDate).toLocaleDateString('en-PH', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        }) : '',
        timeLabel: savedBooking.startTime,
        locationAddress: savedBooking.location?.address || '',
        customerName: savedBooking.customer?.name || '',
        customerEmail: savedBooking.customer?.email || '',
        technicianName: savedBooking.technician?.name || 'Pending Assignment',
        technicianEmail: savedBooking.technician?.email || '',
        estimatedFee: savedBooking.estimatedFee || savedBooking.totalPrice || 0,
        paymentMethod: savedBooking.paymentMethod,
        _id: savedBooking._id,
        booking: {
          bookingReference: savedBooking.bookingReference,
          status: savedBooking.status,
          paymentStatus: savedBooking.paymentStatus,
          totalPrice: savedBooking.estimatedFee || savedBooking.totalPrice || 0,
          bookingDate: savedBooking.bookingDate,
          startTime: savedBooking.startTime,
          endTime: savedBooking.endTime,
        },
      });
    }
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

function ownsBooking(booking, user) {
  return String(booking.customerId || booking.customer?._id || "") === String(user?._id || "");
}

async function validatedServiceItems(inputItems, booking) {
  if (!Array.isArray(inputItems) || inputItems.length < 1 || inputItems.length > 20) {
    const error = new Error("A booking must contain between 1 and 20 service items.");
    error.status = 400;
    throw error;
  }
  const existingServices = bookingServices(booking);
  const existing = new Map(existingServices.map(item => [String(item._id || ""), item]));
  const existingByServiceId = new Map(existingServices.filter(item => item.serviceId).map(item => [String(item.serviceId), item]));
  return Promise.all(inputItems.map(async (input) => {
    const type = input.type === "repair" ? "repair" : "core";
    const Catalog = type === "repair" ? RepairService : CoreService;
    const prior = (input._id ? existing.get(String(input._id)) : null) || existingByServiceId.get(String(input.serviceId || ""));
    const catalog = prior
      ? await Catalog.findOne({ _id: input.serviceId }).lean()
      : await Catalog.findOne({ _id: input.serviceId, active: { $ne: false } }).lean();
    if (!catalog && prior) {
      return {
        ...prior,
        _id: prior._id,
        quantity: Math.min(schedulingEngine.MAX_BOOKING_UNITS, Math.max(1, Number(input.quantity) || Number(prior.quantity) || 1)),
        brand: String(input.brand || prior.brand || "").trim().slice(0, 100),
        model: String(input.model || prior.model || "").trim().slice(0, 100),
        repairIssue: type === "repair" ? String(input.problemDescription || input.repairIssue || prior.repairIssue || "").trim().slice(0, 2000) : prior.repairIssue || "",
        problemDescription: type === "repair" ? String(input.problemDescription || input.repairIssue || prior.problemDescription || "").trim().slice(0, 2000) : prior.problemDescription || "",
      };
    }
    if (!catalog) {
      const error = new Error(`Selected ${type} service is unavailable.`);
      error.status = 400;
      throw error;
    }
    const quantity = Math.min(schedulingEngine.MAX_BOOKING_UNITS, Math.max(1, Number(input.quantity) || 1));
    const hp = Number(input.hp) || null;
    const airconType = input.airconType || input.applianceType || "";
    const typeTier = (catalog.airconTypes || []).find(row => row.type === airconType);
    const hpTier = (typeTier?.hpPricing || catalog.hpPricing || []).find(row => Number(row.hp) === hp);
    const unitPrice = type === "repair"
      ? Number(hpTier?.price || catalog.initialPrice || catalog.basePrice || 0)
      : Number(hpTier?.price || catalog.basePrice || 0);
    const duration = type === "repair"
      ? await getInspectionDurationMinutes()
      : Number(hpTier?.durationMinutes || catalog.durationMinutes || catalog.durationRange?.max || 60);
    return {
      ...(prior || {}),
      _id: prior?._id,
      serviceId: catalog._id,
      name: catalog.name,
      type,
      quantity,
      unitPrice,
      totalPrice: unitPrice * quantity,
      duration,
      hp,
      hpDescription: input.hpDescription || (hp ? `${hp} HP` : ""),
      airconType,
      airconTypeName: input.airconTypeName || input.applianceTypeName || typeTier?.name || "",
      applianceType: input.applianceType || airconType,
      applianceTypeName: input.applianceTypeName || input.airconTypeName || typeTier?.name || "",
      brand: String(input.brand || "").trim().slice(0, 100),
      model: String(input.model || "").trim().slice(0, 100),
      repairIssue: type === "repair" ? String(input.problemDescription || input.repairIssue || "").trim().slice(0, 2000) : "",
      problemDescription: type === "repair" ? String(input.problemDescription || input.repairIssue || "").trim().slice(0, 2000) : "",
      status: prior?.status || (type === "repair" ? "inspection_pending" : "pending"),
      phase: prior?.phase || (type === "repair" ? "repair_phase_1" : "core"),
      schedule: prior?.schedule || { date: booking.bookingDate, startTime: booking.startTime, endTime: booking.endTime, durationMinutes: duration, kind: type === "repair" ? "inspection" : "service" },
    };
  }));
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
        isLargeScale: totalUnits >= schedulingEngine.LARGE_SCALE_MIN_UNITS,
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
      quantity, isProject, projectScheduling, serviceItems
    } = req.body;

    let repairItems = [];
    try { repairItems = serviceItems ? JSON.parse(serviceItems) : []; } catch { repairItems = []; }
    if (!Array.isArray(repairItems) || !repairItems.length) repairItems = [{ unitType, brand, model, problemDescription, quantity }];
    repairItems = repairItems.slice(0, 20).map(item => ({
      unitType: String(item.unitType || item.applianceTypeName || '').trim(),
      brand: String(item.brand || '').trim(), model: String(item.model || '').trim(),
      problemDescription: String(item.problemDescription || item.repairIssue || '').trim(),
      quantity: Math.min(schedulingEngine.MAX_BOOKING_UNITS, Math.max(1, Number(item.quantity) || 1)),
    }));
    const totalRepairUnits = repairItems.reduce((sum, item) => sum + item.quantity, 0);
    const repairIsProject = totalRepairUnits >= schedulingEngine.LARGE_SCALE_MIN_UNITS;

    // ── Step 1: Input Validation ──────────────────────────────────────────
    const errors = [];
    if (totalRepairUnits > schedulingEngine.MAX_BOOKING_UNITS) errors.push(`A repair booking can contain at most ${schedulingEngine.MAX_BOOKING_UNITS} units.`);
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
    repairItems.forEach((item, index) => {
      if (item.unitType.length < 2) errors.push(`Appliance ${index + 1}: unit type is required`);
      if (item.brand.length < 2) errors.push(`Appliance ${index + 1}: brand is required`);
      if (item.problemDescription.length < 10) errors.push(`Appliance ${index + 1}: problem description must be at least 10 characters`);
    });
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
    const capacityEndMinutes = preferredTimeMinutes + (inspectionDuration * totalRepairUnits) + travelTimeDefault + bufferTime;
    
    // Parse preferred date
    const parsedPreferredDate = (() => {
      if (!preferredDate) return null;
      const parts = String(preferredDate).split('-');
      if (parts.length !== 3) return null;
      return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    })();
    
    const inspectionDate = parsedPreferredDate || new Date();

    // Company-wide capacity check
    if (repairIsProject) {
      // For large-scale repair projects: validate the ENTIRE date range
      const ps = projectScheduling ? (typeof projectScheduling === 'string' ? JSON.parse(projectScheduling) : projectScheduling) : {};
      const projStartDate = ps.preferredStartDate || preferredDate;
      const projEndDate = ps.preferredCompletionDeadline || ps.preferredStartDate || preferredDate;

      if (projStartDate && projEndDate) {
        const estHours = Number(ps.estimatedTotalHours) || ((inspectionDuration * totalRepairUnits) / 60);
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
    const totalDiagnosticFee = diagFee * totalRepairUnits;
    const tFare = travelFare ? parseFloat(travelFare) : 0;
    const repairDownpaymentPercentage = await getDownpaymentPercentage();
    const repairPaymentBreakdown = calculatePaymentBreakdown(totalDiagnosticFee + tFare, repairDownpaymentPercentage);

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

      // Store even a single repair as a service item so it can later coexist
      // with core services or additional repair appliances.
      isMultiService: repairItems.length > 1,
      services: repairItems.map(item => ({
        name: `${item.unitType} Repair`,
        type: 'repair',
        quantity: item.quantity,
        unitPrice: diagFee,
        totalPrice: diagFee * item.quantity,
        initialCost: diagFee,
        duration: inspectionDuration,
        applianceType: item.unitType.toLowerCase().replace(/\s+/g, '_'),
        applianceTypeName: item.unitType,
        brand: item.brand,
        model: item.model,
        repairIssue: item.problemDescription,
        problemDescription: item.problemDescription,
        status: 'inspection_pending',
        phase: 'repair_phase_1',
        schedule: { date: inspectionDate, startTime: preferredTime || '', endTime: capacityEndTimeStr, durationMinutes: inspectionDuration, kind: 'inspection' },
      })),

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
      initialCost: totalDiagnosticFee,
      estimatedFee: totalDiagnosticFee + tFare,

      // Enterprise: Show notice that inspection fee covers diagnostic visit
      // Actual repair cost will be quoted after inspection

      // Payment
      paymentMethod: bookingPaymentMethod,
      gcashNumber: gcashNumber || '',
      paymentProof: bookingPaymentMethod === 'gcash' ? gcashProofUrl : cashProofUrl,
      paymentStatus: 'pending',
      downpaymentPercentage: bookingPaymentMethod === 'cod' ? repairPaymentBreakdown.downpaymentPercentage : 100,
      downpaymentAmount: bookingPaymentMethod === 'cod' ? repairPaymentBreakdown.downpaymentAmount : repairPaymentBreakdown.total,
      balanceAmount: bookingPaymentMethod === 'cod' ? repairPaymentBreakdown.balanceAmount : 0,
      amountPaid: 0,
      paymentNotes: bookingPaymentMethod === 'cod' ? `Mobile: ${cashNumber || ''}` : '',

      issueDescription: problemDescription.trim(),
      repairIssues: repairItems.map(item => `${item.brand} ${item.unitType}: ${item.problemDescription}`).join(" | "),

      // Enterprise: preferredDate is the inspection date, NOT the repair date
      preferredDate: parsedPreferredDate,
      preferredTime: preferredTime || '',

      // Enterprise: Set scheduling fields so capacity checks can detect this booking
      // Only inspection duration reserves capacity (not the full repair)
      startTime: preferredTime || '',
      serviceDurationMinutes: inspectionDuration * totalRepairUnits,
      travelTime: travelTimeDefault, // default travel buffer in minutes
      endTime: capacityEndTimeStr, // capacity end point for overlap detection

      // Enterprise: bookingDate uses the preferred inspection date
      // (the date the customer wants the technician to visit)
      bookingDate: inspectionDate,

      // Large-scale / project support (multi-unit repair)
      quantity: totalRepairUnits,
      isProject: repairIsProject,
      projectScheduling: repairIsProject
        ? (projectScheduling ? (typeof projectScheduling === 'string' ? JSON.parse(projectScheduling) : projectScheduling) : { preferredStartDate: preferredDate, estimatedTotalHours: (inspectionDuration * totalRepairUnits) / 60 })
        : undefined,

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

    const submittedProof = bookingPaymentMethod === 'gcash' ? gcashProofUrl : cashProofUrl;
    if (submittedProof) {
      const Payment = require('../models/Payment');
      await Payment.create({
        bookingId: booking._id,
        amount: bookingPaymentMethod === 'cod' ? repairPaymentBreakdown.downpaymentAmount : repairPaymentBreakdown.total,
        method: 'gcash',
        type: bookingPaymentMethod === 'cod' ? 'downpayment' : 'inspection',
        gateway: 'gcash',
        reference: bookingPaymentMethod === 'cod' ? cashNumber : gcashNumber,
        proofUrl: submittedProof,
        status: 'pending',
        notes: bookingPaymentMethod === 'cod'
          ? `${repairPaymentBreakdown.downpaymentPercentage}% repair inspection downpayment submitted for verification`
          : 'Repair inspection payment submitted for verification',
      });
    }

    // ── Large-Scale / Project detection (multi-unit repair) ──────────────
    if (repairIsProject) {
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

// GET /api/bookings/:id/service-items
// Customer-safe service-item view used by booking history/edit screens.
router.get('/:id/service-items', async (req, res) => {
  try {
    const booking = await BookingService.findById(req.params.id).lean();
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!ownsBooking(booking, req.user)) return res.status(403).json({ error: 'Forbidden' });
    return res.json({
      bookingId: booking._id,
      bookingReference: booking.bookingReference,
      status: booking.status,
      policy: mutationPolicy(booking),
      services: bookingServices(booking),
      changeRequests: (booking.serviceChangeRequests || []).map(row => ({
        _id: row._id, status: row.status, requestedAt: row.requestedAt,
        summary: row.summary, reason: row.reason, proposedSchedule: row.proposedSchedule,
        adminDecision: row.adminDecision,
      })),
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to load service items' });
  }
});

// POST /api/bookings/:id/service-change-requests
// Before assignment this applies immediately; once operationally committed it
// records an immutable before/proposed snapshot for admin review.
router.post('/:id/service-change-requests', async (req, res) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!ownsBooking(booking, req.user)) return res.status(403).json({ error: 'Forbidden' });
    if ((booking.serviceChangeRequests || []).some(row => ["pending", "schedule_proposed"].includes(row.status))) {
      return res.status(409).json({ error: 'This booking already has a service change awaiting a decision.' });
    }

    const beforeServices = bookingServices(booking);
    const proposedServices = await validatedServiceItems(req.body.services, booking);
    const summary = summarizeChanges(beforeServices, proposedServices);
    if (!summary.added && !summary.edited && !summary.removed) {
      return res.status(400).json({ error: 'No service changes were detected.' });
    }
    const policy = mutationPolicy(booking);
    const requestRecord = {
      requestedBy: req.user._id,
      requestedByName: req.user.fullName || req.user.name || req.user.email,
      reason: String(req.body.reason || '').trim(),
      status: policy.direct ? 'approved' : 'pending',
      changeType: policy.direct ? 'direct_edit' : 'change_request',
      beforeServices,
      proposedServices,
      summary,
      adminDecision: policy.direct ? { decidedBy: req.user._id, decidedByName: 'System policy', decidedAt: new Date(), reason: policy.reason } : undefined,
    };

    if (policy.direct) {
      const inspectionDuration = await getInspectionDurationMinutes();
      const buffer = await getBufferMinutes();
      const startMinutes = parseTimeToMinutes(booking.startTime);
      const endMinutes = startMinutes + capacityMinutes(proposedServices, inspectionDuration) + Number(booking.travelTime || 0) + buffer;
      if (booking.bookingDate && Number.isFinite(startMinutes)) {
        await assertCompanyCapacity(booking.bookingDate, startMinutes, endMinutes, booking._id);
        booking.endTime = minutesToTimeString(endMinutes);
      }
      booking.services = proposedServices;
      booking.isMultiService = proposedServices.length > 1;
      booking.serviceType = aggregateBookingType(proposedServices);
      const totals = booking.calculateTotalCosts();
      booking.totalInitialCost = totals.totalInitialCost;
      booking.totalFinalCost = totals.totalFinalCost;
      booking.totalPrice = totals.totalPrice;
      if (booking.paymentMethod === 'cod' && booking.totalPrice > 0) {
        const dp = Number(booking.downpaymentAmount) || 0;
        booking.balanceAmount = Math.max(0, booking.totalPrice - dp);
        booking.amountPaid = dp;
      }
    }
    booking.serviceChangeRequests.push(requestRecord);
    await booking.save();

    await createNotification({
      type: policy.direct ? 'booking_change_approved' : 'booking_change_requested',
      title: policy.direct ? 'Booking services updated' : 'Booking service change requested',
      message: `${booking.bookingReference || booking._id}: ${summary.added} added, ${summary.edited} edited, ${summary.removed} removed.`,
      role: 'admin', referenceId: booking._id, referenceModel: 'BookingService',
      link: `/admin/appointments?booking=${booking._id}`, priority: policy.direct ? 'normal' : 'high', io: req.app.get('io'),
    });
    return res.status(policy.direct ? 200 : 202).json({ success: true, applied: policy.direct, policy, changeRequest: booking.serviceChangeRequests.at(-1) });
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message || 'Unable to change booking services' });
  }
});

router.post('/:id/service-change-requests/:requestId/schedule-response', async (req, res) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!ownsBooking(booking, req.user)) return res.status(403).json({ error: 'Forbidden' });
    const change = booking.serviceChangeRequests.id(req.params.requestId);
    if (!change || change.status !== 'schedule_proposed') return res.status(409).json({ error: 'No active schedule proposal was found.' });
    const accepted = req.body.accept === true;
    if (!accepted) {
      change.status = 'customer_rejected_schedule';
      await booking.save();
      await createNotification({ type: 'booking_change_requested', title: 'Customer declined proposed schedule', message: `${booking.bookingReference || booking._id} requires another admin review.`, role: 'admin', referenceId: booking._id, referenceModel: 'BookingService', link: `/admin/appointments?booking=${booking._id}`, priority: 'high', io: req.app.get('io') });
      return res.json({ success: true, accepted: false });
    }
    const date = new Date(change.proposedSchedule.date);
    const start = parseTimeToMinutes(change.proposedSchedule.startTime);
    const end = parseTimeToMinutes(change.proposedSchedule.endTime);
    await assertCompanyCapacity(date, start, end, booking._id);
    booking.bookingDate = date; booking.startTime = change.proposedSchedule.startTime; booking.endTime = change.proposedSchedule.endTime;
    booking.services = change.proposedServices;
    booking.isMultiService = booking.services.length > 1;
    booking.serviceType = aggregateBookingType(booking.services);
    booking.services.forEach(item => { item.schedule = { ...(item.schedule?.toObject?.() || item.schedule || {}), date, startTime: booking.startTime, endTime: booking.endTime, kind: item.type === 'repair' ? 'inspection' : 'service' }; });
    const totals = booking.calculateTotalCosts();
    booking.totalInitialCost = totals.totalInitialCost; booking.totalFinalCost = totals.totalFinalCost; booking.totalPrice = totals.totalPrice;
    change.status = 'customer_accepted_schedule';
    change.adminDecision = { ...(change.adminDecision?.toObject?.() || change.adminDecision || {}), decidedAt: new Date(), reason: 'Customer accepted the proposed schedule.' };
    await booking.save();
    await Promise.all([
      createNotification({ type: 'booking_change_approved', title: 'Customer accepted proposed schedule', message: `${booking.bookingReference || booking._id} was updated.`, role: 'admin', referenceId: booking._id, referenceModel: 'BookingService', link: `/admin/appointments?booking=${booking._id}`, priority: 'normal', io: req.app.get('io') }),
      booking.technicianId ? createNotification({ type: 'booking_update_acknowledgement', title: 'Assigned booking updated', message: `Services and schedule changed for ${booking.bookingReference || booking._id}.`, userId: booking.technicianId, role: 'technician', referenceId: booking._id, referenceModel: 'BookingService', link: '/technician/assignments', priority: 'high', io: req.app.get('io') }) : Promise.resolve(),
    ]);
    return res.json({ success: true, accepted: true, booking });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to process schedule response' });
  }
});

router.post('/:id/service-items/:itemId/quotation-decision', async (req, res) => {
  try {
    const booking = await BookingService.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (!ownsBooking(booking, req.user)) return res.status(403).json({ error: 'Forbidden' });
    const item = booking.services.id(req.params.itemId);
    if (!item || item.type !== 'repair' || item.quotation?.status !== 'submitted') return res.status(409).json({ error: 'No submitted quotation is awaiting a decision for this service item.' });
    const approved = req.body.approved === true;
    item.quotation.status = approved ? 'approved' : 'declined';
    item.quotation.decidedAt = new Date();
    item.status = approved ? 'repair_approved' : 'repair_declined';
    item.phase = approved ? 'repair_phase_2' : 'repair_phase_1';
    item.statusHistory.push({ status: item.status, changedAt: new Date(), changedBy: req.user._id, changedByName: req.user.fullName || req.user.email, reason: approved ? 'Customer approved item quotation' : 'Customer declined item quotation' });
    await booking.save();
    await audit.logEvent({ actor: req.user._id, target: booking._id, action: approved ? 'booking.quotation_item_approve' : 'booking.quotation_item_decline', module: 'bookings', req, details: { bookingId: booking._id, itemId: item._id, itemName: item.name } }).catch(() => {});
    await createNotification({ type: 'system', title: approved ? 'Item quotation approved' : 'Item quotation declined', message: `${item.name} on ${booking.bookingReference || booking._id} was ${approved ? 'approved' : 'declined'} by the customer.`, role: 'admin', referenceId: booking._id, referenceModel: 'BookingService', link: `/admin/appointments?booking=${booking._id}`, priority: approved ? 'normal' : 'high', io: req.app.get('io') });
    return res.json({ success: true, serviceItem: item });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Unable to record quotation decision' });
  }
});

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

    await audit.logEvent({ actor: req.user._id, target: booking._id, action: 'booking.quotation_approve', module: 'bookings', req, details: { bookingId: booking._id, quotationTotal: booking.quotation?.totalCost || 0 } }).catch(() => {});

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

    await audit.logEvent({ actor: req.user._id, target: booking._id, action: 'booking.quotation_decline', module: 'bookings', req, details: { bookingId: booking._id, reason: reason || 'Declined by customer' } }).catch(() => {});

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

    await audit.logEvent({ actor: req.user._id, target: booking._id, action: 'booking.warranty_claim', module: 'bookings', req, details: { bookingId: booking._id, issue: issue.trim() } }).catch(() => {});

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

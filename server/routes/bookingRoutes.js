const express = require('express');
const router = express.Router();
const BookingService = require('../models/BookingService');
const auth = require('../middleware/authenticate');
const { assertCompanyCapacity } = require('../utils/bookingPolicy');
const { getDownpaymentPercentage, calculatePaymentBreakdown } = require('../utils/paymentPolicy');

// Protect all booking routes with authentication
router.use(auth.authenticate);
router.use(auth.requireRole("customer"));

/**
 * POST /api/bookings/create
 * Create a new multi-service booking
 */
router.post('/create', async (req, res) => {
  try {
    console.log('📝 Creating new booking...');
    
    // Parse services if it comes as a string (fix for double-stringification)
    let parsedServices = req.body.services;
    if (typeof req.body.services === 'string') {
      console.warn('⚠️ Services received as string, parsing...');
      try {
        parsedServices = JSON.parse(req.body.services);
        console.log('✓ Services parsed successfully');
      } catch (e) {
        console.error('❌ Failed to parse services:', e);
        return res.status(400).json({ error: 'Invalid services data format' });
      }
    }
    
    // Use parsedServices and ensure it's a proper array
    let services = parsedServices;
    
    // Ensure services is an array and create clean objects
    if (!Array.isArray(services)) {
      console.error('❌ Services is not an array after parsing:', typeof services);
      return res.status(400).json({ error: 'Services must be an array' });
    }
    
    // Create clean service objects to avoid any casting issues
    services = services.map(s => ({
      serviceId: s.serviceId,
      name: String(s.name || ''),
      type: String(s.type || 'core'),
      quantity: Number(s.quantity) || 1,
      unitPrice: Number(s.unitPrice) || 0,
      totalPrice: Number(s.totalPrice) || 0,
      hp: s.hp ? Number(s.hp) : undefined,
      hpDescription: s.hpDescription ? String(s.hpDescription) : undefined,
      airconType: s.airconType ? String(s.airconType) : undefined,
      airconTypeName: s.airconTypeName ? String(s.airconTypeName) : undefined,
      duration: s.duration ? Number(s.duration) : undefined,
      isAirconService: Boolean(s.isAirconService),
      repairIssue: s.repairIssue ? String(s.repairIssue) : undefined,
      initialCost: s.initialCost ? Number(s.initialCost) : undefined
    }));
    
    console.log('✓ Services cleaned and validated:', services.length, 'services');
    
    const {
      isMultiService,
      totalPrice,
      totalInitialCost,
      travelFare,
      travelDurationMinutes,
      distanceKm,
      technicianId,
      location,
      technicianLocation,
      bookingDate,
      startTime,
      endTime,
      selectedTimeLabel,
      paymentMethod,
      paymentStatus,
      status,
      gcashNumber,
      paymentReference,
      downpaymentAmount,
      paymentNotes
    } = req.body;
    
    // Validate required fields
    if (!services || services.length === 0) {
      return res.status(400).json({ error: 'At least one service is required' });
    }
    
    if (!technicianId) {
      return res.status(400).json({ error: 'Technician ID is required' });
    }
    
    if (!location || !location.lat || !location.lng) {
      return res.status(400).json({ error: 'Valid location is required' });
    }
    
    if (!bookingDate || !startTime || !endTime) {
      return res.status(400).json({ error: 'Date and time are required' });
    }
    
    if (!paymentMethod) {
      return res.status(400).json({ error: 'Payment method is required' });
    }
    
    // Get user ID from session (if authenticated)
    let userId = req.user?._id || req.session?.userId;
    
    // For testing: if no user session, log warning but allow booking
    if (!userId) {
      console.warn('⚠️ No user session found - this should not happen in production');
      console.warn('User data:', req.user);
      
      // Try to get from session in different ways
      userId = req.session?.user?._id || req.session?.passport?.user;
      
      if (!userId) {
        return res.status(401).json({ 
          error: 'User must be logged in to create a booking',
          hint: 'Please log in and try again'
        });
      }
    }
    
    console.log('✓ User ID:', userId);

    // ── Company-wide capacity check ──────────────────────────────────────
    try {
      const startMins = parseTimeToMinutes2(startTime);
      const endMins = parseTimeToMinutes2(endTime);
      if (Number.isFinite(startMins) && Number.isFinite(endMins) && endMins > startMins) {
        await assertCompanyCapacity(new Date(bookingDate), startMins, endMins);
      }
    } catch (capacityErr) {
      return res.status(409).json({ error: capacityErr.message });
    }

    // Generate booking reference
    const bookingReference = `BK${Date.now()}${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    
    // Prepare booking data
    const bookingData = {
      bookingReference,
      userId,
      technicianId,
      
      // Multi-service data
      isMultiService: isMultiService || services.length > 1,
      services: services.map(service => ({
        serviceId: service.serviceId,
        name: service.name,
        type: service.type,
        quantity: service.quantity || 1,
        unitPrice: service.unitPrice,
        totalPrice: service.totalPrice,
        hp: service.hp,
        hpDescription: service.hpDescription,
        airconType: service.airconType,
        airconTypeName: service.airconTypeName,
        applianceType: service.applianceType,
        applianceTypeName: service.applianceTypeName,
        brand: service.brand,
        duration: service.duration,
        isAirconService: service.isAirconService,
        repairIssue: service.repairIssue,
        initialCost: service.initialCost
      })),
      
      // Pricing
      totalPrice: totalPrice || 0,
      totalInitialCost: totalInitialCost || 0,
      travelFare: travelFare || 0,
      travelDurationMinutes: travelDurationMinutes || 0,
      distanceKm: distanceKm || 0,
      
      // Location
      location: {
        address: location.address,
        lat: location.lat,
        lng: location.lng,
        coordinates: location.coordinates || {
          type: 'Point',
          coordinates: [location.lng, location.lat]
        }
      },
      
      // Technician location (if provided)
      technicianLocation: technicianLocation ? {
        address: technicianLocation.address,
        lat: technicianLocation.lat,
        lng: technicianLocation.lng,
        coordinates: technicianLocation.coordinates || {
          type: 'Point',
          coordinates: [technicianLocation.lng, technicianLocation.lat]
        }
      } : undefined,
      
      // Schedule
      bookingDate: new Date(bookingDate),
      startTime,
      endTime,
      selectedTimeLabel,
      
      // Payment
      paymentMethod,
      paymentStatus: paymentStatus || 'pending',
      paymentReference,
      
      // Status
      status: status || 'pending',
      
      // Timestamps
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    // Add payment-specific fields
    if (paymentMethod === 'gcash') {
      bookingData.gcashNumber = gcashNumber;
    } else if (paymentMethod === 'cod') {
      const percentage = await getDownpaymentPercentage();
      const breakdown = calculatePaymentBreakdown(Number(totalPrice) || 0, percentage);
      bookingData.downpaymentPercentage = breakdown.downpaymentPercentage;
      bookingData.downpaymentAmount = breakdown.downpaymentAmount;
      bookingData.balanceAmount = breakdown.balanceAmount;
      bookingData.amountPaid = 0;
      bookingData.paymentNotes = paymentNotes;
    }
    
    // Log the final booking data structure
    console.log('📦 Final bookingData structure:');
    console.log('  - services type:', typeof bookingData.services);
    console.log('  - services is array:', Array.isArray(bookingData.services));
    console.log('  - services length:', bookingData.services?.length);
    console.log('  - first service:', JSON.stringify(bookingData.services?.[0], null, 2));
    
    // Create booking
    console.log('🔨 Creating BookingService model...');
    const booking = new BookingService(bookingData);
    console.log('✓ Model created, now saving...');
    await booking.save();
    
    console.log('✅ Booking created successfully:', booking.bookingReference);
    
    // Return success response
    res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      bookingReference: booking.bookingReference,
      _id: booking._id,
      booking: {
        bookingReference: booking.bookingReference,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        totalPrice: booking.totalPrice,
        bookingDate: booking.bookingDate,
        startTime: booking.startTime,
        endTime: booking.endTime
      }
    });
    
  } catch (error) {
    console.error('❌ Booking creation error:', error);
    console.error('Error stack:', error.stack);
    console.error('Error name:', error.name);
    
    // Log validation errors specifically
    if (error.name === 'ValidationError') {
      console.error('Validation errors:', error.errors);
    }
    
    res.status(500).json({
      error: 'Failed to create booking',
      details: error.message,
      errorType: error.name
    });
  }
});

/**
 * GET /api/bookings/:id
 * Get booking by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const booking = await BookingService.findById(req.params.id)
      .populate('userId', 'name email phone')
      .populate('technicianId', 'name email phone');
    
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    res.json(booking);
  } catch (error) {
    console.error('Error fetching booking:', error);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// ── Helper ───────────────────────────────────────────────────────────────────
function parseTimeToMinutes2(timeValue) {
  if (typeof timeValue === 'number') return timeValue;
  const str = String(timeValue || '').trim();
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

module.exports = router;

#!/usr/bin/env node

/**
 * Trace Complete Booking Flow
 * Identify exactly where the placeholder data is coming from
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Technician = require('../models/Technician');
const BookingService = require('../models/BookingService');

async function traceBookingFlow() {
  console.log('🔍 TRACE COMPLETE BOOKING FLOW');
  console.log('=================================\n');

  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/calidro-racs');
    console.log('✅ Connected to database');

    // Step 1: Check current database state
    console.log('📋 STEP 1: Current Database State');
    console.log('=====================================');
    
    const customerId = '69b473cbdffbff80c430a32c';
    const technicianId = '69a310f58fa21216104677fe';

    const customer = await User.findById(customerId);
    const technician = await Technician.findById(technicianId);
    
    console.log('Customer in DB:', {
      name: `${customer.firstName} ${customer.lastName}`.trim(),
      email: customer.email,
      phone: customer.phone
    });
    
    console.log('Technician in DB:', {
      name: technician.name,
      email: technician.userEmail,
      phone: technician.phone
    });

    // Step 2: Simulate the exact API call
    console.log('\n📋 STEP 2: Simulate API Call');
    console.log('===============================');
    
    // This simulates what happens in bookingRoutesNew.js
    console.log('Simulating: POST /api/bookings/create-new');
    console.log('With body:', {
      services: [{ serviceId: '507f1f77bcf86cd799439011', name: 'Test Service' }],
      technicianId: technicianId,
      location: { address: 'Test Address' },
      bookingDate: '2026-03-20',
      startTime: '10:00',
      endTime: '12:00',
      paymentMethod: 'gcash'
    });

    // Step 3: Create booking exactly like the route does
    console.log('\n📋 STEP 3: Create Booking Like Route');
    console.log('===================================');
    
    const bookingData = {
      bookingReference: `RACS-${new Date().toISOString().slice(0,10).replace(/-/g, '')}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
      customerId: customerId,
      technicianId: technicianId,
      
      // This is what should be set by our fixed route
      customer: {
        _id: customer._id,
        name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || "Valued Customer",
        email: customer.email,
        phone: customer.phone || customer.mobile || "",
        address: customer.address || "Default Address"
      },
      
      technician: {
        _id: technician._id,
        name: technician.name || "Technician",
        email: technician.userEmail || technician.email || "",
        phone: technician.phone || technician.mobile || ""
      },
      
      // Service data
      serviceId: new mongoose.Types.ObjectId(),
      serviceModel: 'CoreService',
      service: {
        _id: new mongoose.Types.ObjectId(),
        name: 'Test Service',
        basePrice: 1000
      },
      bookingDate: new Date(),
      startTime: '10:00',
      endTime: '12:00',
      location: { address: 'Test Location' },
      status: 'pending',
      estimatedFee: 1000,
      paymentMethod: 'gcash',
      paymentReference: 'TEST-' + Date.now(),
      downpaymentAmount: 400
    };
    
    console.log('Booking data before save:', {
      customer: bookingData.customer,
      technician: bookingData.technician
    });
    
    const booking = new BookingService(bookingData);
    await booking.save();
    
    console.log('Booking data after save:', {
      customer: booking.customer,
      technician: booking.technician
    });

    // Step 4: Check if pre-save hooks overwrote our data
    console.log('\n📋 STEP 4: Check Pre-Save Hook Behavior');
    console.log('========================================');
    
    const customerOverwritten = booking.customer.email !== customer.email;
    const technicianOverwritten = booking.technician.email !== (technician.userEmail || technician.email);
    
    console.log('Customer data overwritten by pre-save:', customerOverwritten);
    console.log('Technician data overwritten by pre-save:', technicianOverwritten);
    
    if (customerOverwritten || technicianOverwritten) {
      console.log('⚠️ ISSUE: Pre-save hooks are overwriting our real data!');
    } else {
      console.log('✅ GOOD: Pre-save hooks preserved our real data');
    }

    // Step 5: Test what the API response would be
    console.log('\n📋 STEP 5: Simulate API Response');
    console.log('=================================');
    
    const apiResponse = {
      success: true,
      message: 'Booking created successfully',
      bookingReference: booking.bookingReference,
      serviceName: booking.service.name,
      dateLabel: new Date(booking.bookingDate).toLocaleDateString('en-PH', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }),
      timeLabel: `${booking.startTime} - ${booking.endTime}`,
      locationAddress: booking.location.address,
      customerEmail: booking.customer.email,
      technicianName: booking.technician.name,
      estimatedFee: booking.estimatedFee,
      paymentMethod: booking.paymentMethod
    };
    
    console.log('API Response would be:', JSON.stringify(apiResponse, null, 2));

    // Step 6: Check recent bookings to see what's actually being stored
    console.log('\n📋 STEP 6: Check Recent Bookings');
    console.log('===============================');
    
    const recentBookings = await BookingService.find({})
      .sort({ createdAt: -1 })
      .limit(3)
      .lean();
    
    console.log(`Found ${recentBookings.length} recent bookings:`);
    
    recentBookings.forEach((booking, index) => {
      console.log(`\n📅 Booking ${index + 1}: ${booking.bookingReference}`);
      console.log(`   Customer: ${booking.customer?.name || 'NO NAME'} (${booking.customer?.email || 'NO EMAIL'})`);
      console.log(`   Technician: ${booking.technician?.name || 'NO NAME'} (${booking.technician?.email || 'NO EMAIL'})`);
      
      // Check for placeholders
      const customerIsPlaceholder = booking.customer?.email === 'customer@example.com' || !booking.customer?.email;
      const technicianIsPlaceholder = booking.technician?.email === 'technician@example.com' || !booking.technician?.email;
      
      if (customerIsPlaceholder) console.log('   ⚠️ CUSTOMER DATA IS PLACEHOLDER');
      if (technicianIsPlaceholder) console.log('   ⚠️ TECHNICIAN DATA IS PLACEHOLDER');
      
      if (!customerIsPlaceholder && !technicianIsPlaceholder) {
        console.log('   ✅ REAL DATA CAPTURED');
      }
    });

    // Clean up test booking
    await BookingService.findByIdAndDelete(booking._id);

  } catch (error) {
    console.error('❌ Trace failed:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from database');
  }
}

// Run the trace
traceBookingFlow().catch(console.error);

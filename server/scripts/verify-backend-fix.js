#!/usr/bin/env node

/**
 * BACKEND EXPERT: Complete Backend Fix Verification
 * This script simulates the exact flow that happens when a booking is created
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Technician = require('../models/Technician');
const BookingService = require('../models/BookingService');

async function verifyBackendFix() {
  console.log('========================================');
  console.log('🎯 BACKEND EXPERT: COMPLETE FIX VERIFICATION');
  console.log('========================================\n');

  try {
    // Connect to local MongoDB
    await mongoose.connect("mongodb://localhost:27017/appointment_scheduler");
    console.log('✅ Connected to local MongoDB\n');

    const customerId = '69b473cbdffbff80c430a32c';
    const technicianId = '69a310f58fa21216104677fe';

    // ========================================
    // STEP 1: Verify customer exists
    // ========================================
    console.log('========================================');
    console.log('👤 STEP 1: CUSTOMER DATA VALIDATION');
    console.log('========================================');
    
    const user = await User.findById(customerId);
    
    if (!user) {
      console.error('❌ CRITICAL: Customer not found in database');
      process.exit(1);
    }
    
    console.log('✅ Customer found:');
    console.log('   ID:', user._id);
    console.log('   First Name:', user.firstName);
    console.log('   Last Name:', user.lastName);
    console.log('   Email:', user.email);
    console.log('   Phone:', user.phone || user.mobile || 'N/A');
    
    const customerFullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    console.log('   Full Name:', customerFullName);
    
    if (!user.email) {
      console.error('❌ CRITICAL: Customer email is missing');
      process.exit(1);
    }

    // ========================================
    // STEP 2: Verify technician exists
    // ========================================
    console.log('\n========================================');
    console.log('🔧 STEP 2: TECHNICIAN DATA VALIDATION');
    console.log('========================================');
    
    const technician = await Technician.findById(technicianId);
    
    if (!technician) {
      console.error('❌ CRITICAL: Technician not found in database');
      process.exit(1);
    }
    
    console.log('✅ Technician found:');
    console.log('   ID:', technician._id);
    console.log('   Name:', technician.name);
    console.log('   Email (email field):', technician.email);
    console.log('   Email (userEmail field):', technician.userEmail);
    console.log('   Phone:', technician.phone || technician.mobile || 'N/A');
    
    const technicianEmail = technician.userEmail || technician.email;
    console.log('   Final Email:', technicianEmail);

    // ========================================
    // STEP 3: Create booking with IDs only (like frontend sends)
    // ========================================
    console.log('\n========================================');
    console.log('💾 STEP 3: CREATE BOOKING (SIMULATE API CALL)');
    console.log('========================================');
    
    const bookingData = {
      bookingReference: `TEST-${new Date().toISOString().slice(0,10).replace(/-/g, '')}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
      customerId: customerId,
      technicianId: technicianId,
      
      // Minimal data - the pre-save hooks should fetch the rest
      serviceId: new mongoose.Types.ObjectId(),
      serviceModel: 'CoreService',
      service: {
        _id: new mongoose.Types.ObjectId(),
        name: 'Test Service',
        basePrice: 1500
      },
      bookingDate: new Date(),
      startTime: '10:00',
      endTime: '12:00',
      location: { address: 'Test Location' },
      status: 'pending',
      estimatedFee: 1500,
      paymentMethod: 'gcash'
    };
    
    console.log('Creating booking with minimal data...');
    console.log('   Customer ID:', customerId);
    console.log('   Technician ID:', technicianId);
    console.log('   Note: Pre-save hooks should fetch real data from database');
    
    const booking = new BookingService(bookingData);
    
    console.log('\nSaving booking (pre-save hooks executing)...');
    await booking.save();

    // ========================================
    // STEP 4: Verify saved data
    // ========================================
    console.log('\n========================================');
    console.log('✅ STEP 4: VERIFY SAVED DATA');
    console.log('========================================');
    
    console.log('Booking Reference:', booking.bookingReference);
    console.log('\nCustomer Data Saved:');
    console.log('   Name:', booking.customer.name);
    console.log('   Email:', booking.customer.email);
    console.log('   Phone:', booking.customer.phone);
    
    console.log('\nTechnician Data Saved:');
    console.log('   Name:', booking.technician.name);
    console.log('   Email:', booking.technician.email);
    console.log('   Phone:', booking.technician.phone);

    // ========================================
    // STEP 5: Final validation
    // ========================================
    console.log('\n========================================');
    console.log('🎯 STEP 5: FINAL VALIDATION');
    console.log('========================================');
    
    const customerHasRealData = booking.customer.email !== 'customer@example.com' && 
                                booking.customer.email === user.email;
    const technicianHasRealData = booking.technician.email !== 'technician@example.com' && 
                                   booking.technician.email === technicianEmail;
    
    console.log('Customer Email Validation:');
    console.log('   Expected:', user.email);
    console.log('   Actual:', booking.customer.email);
    console.log('   Match:', customerHasRealData ? '✅ YES' : '❌ NO');
    
    console.log('\nTechnician Email Validation:');
    console.log('   Expected:', technicianEmail);
    console.log('   Actual:', booking.technician.email);
    console.log('   Match:', technicianHasRealData ? '✅ YES' : '❌ NO');
    
    console.log('\nCustomer Name Validation:');
    console.log('   Expected:', customerFullName);
    console.log('   Actual:', booking.customer.name);
    console.log('   Match:', booking.customer.name === customerFullName ? '✅ YES' : '❌ NO');
    
    console.log('\nTechnician Name Validation:');
    console.log('   Expected:', technician.name);
    console.log('   Actual:', booking.technician.name);
    console.log('   Match:', booking.technician.name === technician.name ? '✅ YES' : '❌ NO');

    // Clean up
    await BookingService.findByIdAndDelete(booking._id);
    console.log('\n🧹 Test booking cleaned up');

    // Final result
    console.log('\n========================================');
    if (customerHasRealData && technicianHasRealData) {
      console.log('🎉 SUCCESS! BACKEND FIX IS WORKING!');
      console.log('========================================');
      console.log('✅ Customer data is REAL');
      console.log('✅ Technician data is REAL');
      console.log('✅ Pre-save hooks are working correctly');
      console.log('✅ Ready for production use');
      console.log('\n📋 NEXT STEP: Restart the server and test through web interface');
    } else {
      console.log('❌ FAILURE! BACKEND FIX NOT WORKING');
      console.log('========================================');
      if (!customerHasRealData) console.log('❌ Customer data is still placeholder');
      if (!technicianHasRealData) console.log('❌ Technician data is still placeholder');
      console.log('\n📋 TROUBLESHOOTING: Check BookingService.js pre-save hooks');
    }
    console.log('========================================\n');

  } catch (error) {
    console.error('\n❌ VERIFICATION FAILED:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from database\n');
  }
}

// Run verification
verifyBackendFix().catch(console.error);

#!/usr/bin/env node

/**
 * Check Existing Bookings - See what's actually in the database
 */

require('dotenv').config();
const mongoose = require('mongoose');
const BookingService = require('../models/BookingService');

async function checkExistingBookings() {
  console.log('🔍 CHECK EXISTING BOOKINGS IN DATABASE');
  console.log('=====================================\n');

  try {
    // Connect to local MongoDB
    await mongoose.connect("mongodb://localhost:27017/appointment_scheduler");
    console.log('✅ Connected to local MongoDB');

    // Get all recent bookings
    const bookings = await BookingService.find()
      .sort({ createdAt: -1 })
      .limit(10);
    
    console.log(`📋 Found ${bookings.length} recent bookings:\n`);

    bookings.forEach((booking, index) => {
      console.log(`\n--- BOOKING ${index + 1} ---`);
      console.log('Reference:', booking.bookingReference);
      console.log('Created:', booking.createdAt);
      console.log('Customer:', booking.customer.name, `(${booking.customer.email})`);
      console.log('Technician:', booking.technician.name, `(${booking.technician.email})`);
      
      const customerHasRealData = booking.customer.email !== 'customer@example.com';
      const technicianHasRealData = booking.technician.email !== 'technician@example.com';
      
      console.log('Customer has real data:', customerHasRealData ? '✅ YES' : '❌ NO');
      console.log('Technician has real data:', technicianHasRealData ? '✅ YES' : '❌ NO');
    });

    // Check for any placeholder data bookings
    const placeholderBookings = bookings.filter(b => 
      b.customer.email === 'customer@example.com' || 
      b.technician.email === 'technician@example.com'
    );
    
    console.log('\n📋 SUMMARY:');
    console.log('Total bookings checked:', bookings.length);
    console.log('Bookings with placeholder data:', placeholderBookings.length);
    console.log('Bookings with real data:', bookings.length - placeholderBookings.length);
    
    if (placeholderBookings.length > 0) {
      console.log('\n❌ ISSUE DETECTED: Some bookings still have placeholder data');
      console.log('This means the old route is still being used or server needs restart');
      
      placeholderBookings.forEach((booking, index) => {
        console.log(`\nPlaceholder Booking ${index + 1}:`);
        console.log('Reference:', booking.bookingReference);
        console.log('Customer email:', booking.customer.email);
        console.log('Technician email:', booking.technician.email);
        console.log('Created:', booking.createdAt);
      });
    } else {
      console.log('\n✅ SUCCESS: All recent bookings have real data');
      console.log('The fix is working correctly!');
    }

  } catch (error) {
    console.error('❌ Check failed:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from database');
  }
}

// Run the check
checkExistingBookings().catch(console.error);

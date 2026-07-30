#!/usr/bin/env node

/**
 * Fix Technician Schedule
 * Updates technician schedule to match user's requirements:
 * - Sunday: OFF
 * - Tuesday: OFF  
 * - Saturday: OFF
 * - Monday, Wednesday, Thursday, Friday: WORKING (8 AM - 5 PM)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Technician = require('../models/Technician');
const TechnicianSchedule = require('../models/TechnicianSchedule');

async function fixTechnicianSchedule() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/racs-db');
    
    console.log('🔧 Fixing Technician Schedule');
    console.log('=============================\n');
    
    // Get all active technicians
    const technicians = await Technician.find({ active: true });
    console.log(`📋 Found ${technicians.length} active technicians`);
    
    if (technicians.length === 0) {
      console.log('❌ No active technicians found');
      return;
    }
    
    // Define the correct schedule (Sunday, Tuesday, Saturday OFF)
    const correctWorkingDays = [
      { dayOfWeek: 1, startMinutes: 8 * 60, endMinutes: 19 * 60 }, // Monday: 8 AM - 7 PM
      { dayOfWeek: 3, startMinutes: 8 * 60, endMinutes: 19 * 60 }, // Wednesday: 8 AM - 7 PM
      { dayOfWeek: 4, startMinutes: 8 * 60, endMinutes: 19 * 60 }, // Thursday: 8 AM - 7 PM
      { dayOfWeek: 5, startMinutes: 8 * 60, endMinutes: 19 * 60 }, // Friday: 8 AM - 7 PM
    ];
    
    const correctNonWorkingDays = [
      { dayOfWeek: 0 }, // Sunday: OFF
      { dayOfWeek: 2 }, // Tuesday: OFF
      { dayOfWeek: 6 }  // Saturday: OFF
    ];
    
    console.log('📅 Target Schedule:');
    console.log('  Working Days: Monday, Wednesday, Thursday, Friday (8 AM - 5 PM)');
    console.log('  Non-working Days: Sunday, Tuesday, Saturday');
    
    // Update each technician's schedule
    for (const technician of technicians) {
      console.log(`\n🔧 Processing: ${technician.name} (${technician._id})`);
      
      // Find existing schedule
      let schedule = await TechnicianSchedule.findOne({ technicianId: technician._id });
      
      if (schedule) {
        console.log('  📋 Existing schedule found - updating...');
        
        // Update existing schedule
        schedule.workingDays = correctWorkingDays;
        schedule.nonWorkingWeekdays = correctNonWorkingDays;
        schedule.restDates = schedule.restDates || []; // Keep existing rest dates
        
        await schedule.save();
        console.log('  ✅ Schedule updated successfully');
        
      } else {
        console.log('  📋 No existing schedule - creating new...');
        
        // Create new schedule
        schedule = new TechnicianSchedule({
          technicianId: technician._id,
          workingDays: correctWorkingDays,
          nonWorkingWeekdays: correctNonWorkingDays,
          restDates: []
        });
        
        await schedule.save();
        console.log('  ✅ New schedule created successfully');
      }
      
      // Verify the schedule
      const updatedSchedule = await TechnicianSchedule.findOne({ technicianId: technician._id });
      console.log('  🔍 Verification:');
      console.log(`    Working Days: ${updatedSchedule.workingDays.length}`);
      console.log(`    Non-working Days: ${updatedSchedule.nonWorkingWeekdays.length}`);
      
      // Show day details
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      
      console.log('    Working:');
      updatedSchedule.workingDays.forEach(day => {
        const startTime = `${Math.floor(day.startMinutes / 60)}:${String(day.startMinutes % 60).padStart(2, '0')}`;
        const endTime = `${Math.floor(day.endMinutes / 60)}:${String(day.endMinutes % 60).padStart(2, '0')}`;
        console.log(`      ${dayNames[day.dayOfWeek]}: ${startTime} - ${endTime}`);
      });
      
      console.log('    Non-working:');
      updatedSchedule.nonWorkingWeekdays.forEach(day => {
        console.log(`      ${dayNames[day.dayOfWeek]}: OFF`);
      });
    }
    
    console.log('\n🎉 Schedule Fix Complete!');
    console.log('📋 All technicians now have the correct schedule:');
    console.log('  ✅ Sunday: OFF');
    console.log('  ✅ Monday: WORKING (8 AM - 5 PM)');
    console.log('  ✅ Tuesday: OFF');
    console.log('  ✅ Wednesday: WORKING (8 AM - 5 PM)');
    console.log('  ✅ Thursday: WORKING (8 AM - 5 PM)');
    console.log('  ✅ Friday: WORKING (8 AM - 5 PM)');
    console.log('  ✅ Saturday: OFF');
    
    console.log('\n🚀 The calendar should now show the correct availability!');
    
  } catch (error) {
    console.error('❌ Error fixing schedule:', error);
  } finally {
    await mongoose.disconnect();
  }
}

// Run the fix
fixTechnicianSchedule();

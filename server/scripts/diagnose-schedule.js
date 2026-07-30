#!/usr/bin/env node

/**
 * Diagnose Technician Schedule Issues
 * Checks if technicians have schedules in TechnicianSchedule collection
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Technician = require('../models/Technician');
const TechnicianSchedule = require('../models/TechnicianSchedule');

async function diagnoseSchedule() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/racs-db');
    
    console.log('🔍 Diagnosing Technician Schedule Issues');
    console.log('==========================================\n');
    
    // 1. Count technicians
    const technicianCount = await Technician.countDocuments();
    console.log(`📋 Total Technicians: ${technicianCount}`);
    
    // 2. Count technician schedules
    const scheduleCount = await TechnicianSchedule.countDocuments();
    console.log(`📅 Total Technician Schedules: ${scheduleCount}`);
    
    // 3. Get all technicians
    const technicians = await Technician.find({}).select('_id name active');
    console.log('\n👥 Technicians:');
    technicians.forEach(tech => {
      console.log(`  - ${tech.name} (${tech._id}) - Active: ${tech.active}`);
    });
    
    // 4. Get all schedules
    const schedules = await TechnicianSchedule.find({}).populate('technicianId', 'name active');
    console.log('\n📅 Schedules:');
    if (schedules.length === 0) {
      console.log('  ❌ No schedules found!');
    } else {
      schedules.forEach(schedule => {
        const techName = schedule.technicianId?.name || 'Unknown';
        console.log(`  - ${techName} (${schedule.technicianId})`);
        console.log(`    Working Days: ${schedule.workingDays?.length || 0}`);
        console.log(`    Non-working Weekdays: ${schedule.nonWorkingWeekdays?.length || 0}`);
        console.log(`    Rest Dates: ${schedule.restDates?.length || 0}`);
      });
    }
    
    // 5. Check for missing schedules
    console.log('\n🔍 Missing Schedules:');
    const techniciansWithSchedules = schedules.map(s => s.technicianId._id.toString());
    const techniciansWithoutSchedules = technicians.filter(
      tech => !techniciansWithSchedules.includes(tech._id.toString())
    );
    
    if (techniciansWithoutSchedules.length === 0) {
      console.log('  ✅ All technicians have schedules');
    } else {
      console.log('  ❌ Technicians without schedules:');
      techniciansWithoutSchedules.forEach(tech => {
        console.log(`    - ${tech.name} (${tech._id})`);
      });
    }
    
    // 6. Test API call for first technician
    if (technicians.length > 0) {
      const testTech = technicians[0];
      console.log(`\n🧪 Testing API for ${test.name}:`);
      
      const schedule = await TechnicianSchedule.findOne({ 
        technicianId: testTech._id 
      });
      
      if (schedule) {
        console.log('  ✅ Schedule found');
        console.log(`  📅 Working Days: ${schedule.workingDays.length}`);
        schedule.workingDays.forEach(wd => {
          console.log(`    - Day ${wd.dayOfWeek}: ${wd.startMinutes} - ${wd.endMinutes} minutes`);
        });
      } else {
        console.log('  ❌ No schedule found');
        console.log('  💡 This is likely causing the calendar issue!');
      }
    }
    
    console.log('\n🎯 Diagnosis Complete!');
    
    if (scheduleCount === 0) {
      console.log('\n❌ ISSUE IDENTIFIED:');
      console.log('   No TechnicianSchedule documents exist in the database.');
      console.log('   The calendar is trying to fetch schedules that don\'t exist.');
      console.log('\n💡 RECOMMENDED FIX:');
      console.log('   Create default schedules for all technicians.');
    }
    
  } catch (error) {
    console.error('❌ Error during diagnosis:', error);
  } finally {
    await mongoose.disconnect();
  }
}

// Run the diagnosis
diagnoseSchedule();

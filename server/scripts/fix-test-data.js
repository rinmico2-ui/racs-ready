#!/usr/bin/env node

/**
 * Fix Test Data
 * Add proper test users and technicians to match the booking IDs
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Technician = require('../models/Technician');

async function fixTestData() {
  console.log('🔧 Fix Test Data');
  console.log('==================\n');

  try {
    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/calidro-racs');
    console.log('✅ Connected to database');

    // Create proper test customer
    const customerId = '69b473cbdffbff80c430a32c';
    let customer = await User.findById(customerId);
    
    if (!customer) {
      console.log('👤 Creating test customer...');
      
      const passwordHash = await bcrypt.hash('password123', 10);
      
      customer = new User({
        _id: customerId,
        firstName: 'John',
        lastName: 'Doe',
        email: 'johndoe@gmail.com',
        phone: '09123456789',
        address: {
          province: 'Nueva Ecija',
          city: 'Carranglan',
          barangay: 'Puncan',
          postalCode: '3121'
        },
        passwordHash: passwordHash,
        role: 'customer',
        createdAt: new Date()
      });
      
      await customer.save();
      console.log('✅ Test customer created');
    } else {
      console.log('✅ Test customer already exists');
    }

    // Create proper test technician
    const technicianId = '69a310f58fa21216104677fe';
    let technician = await Technician.findById(technicianId);
    
    if (!technician) {
      console.log('🔧 Creating test technician...');
      
      technician = new Technician({
        _id: technicianId,
        name: 'Juan Technician',
        email: 'juan@calidro.com',
        phone: '09876543210',
        active: true,
        rating: 4.5,
        ratingCount: 10,
        location: {
          type: 'Point',
          coordinates: [121.043731, 14.676049] // Default location
        },
        locationText: 'Cabanatuan City, Nueva Ecija',
        createdAt: new Date()
      });
      
      await technician.save();
      console.log('✅ Test technician created');
    } else {
      console.log('✅ Test technician already exists');
    }

    // Verify the data
    console.log('\n🔍 Verification:');
    
    const verifyCustomer = await User.findById(customerId).lean({ virtuals: true });
    console.log('Customer:', {
      name: verifyCustomer.name || verifyCustomer.fullName,
      email: verifyCustomer.email,
      phone: verifyCustomer.phone
    });
    
    const verifyTechnician = await Technician.findById(technicianId).lean();
    console.log('Technician:', {
      name: verifyTechnician.name,
      email: verifyTechnician.email,
      phone: verifyTechnician.phone
    });

    console.log('\n🎯 Test data is now ready!');
    console.log('The booking system should now fetch real customer and technician data.');

  } catch (error) {
    console.error('❌ Fix failed:', error.message);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from database');
  }
}

// Run the fix
fixTestData().catch(console.error);

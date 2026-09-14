const mongoose = require('mongoose');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/appointment_scheduler';

const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);

const TIME_SLOTS = [
  { startTime: '13:00', endTime: '14:00', label: '1:00 PM - 2:00 PM' },
  { startTime: '14:00', endTime: '15:00', label: '2:00 PM - 3:00 PM' },
  { startTime: '15:00', endTime: '16:00', label: '3:00 PM - 4:00 PM' },
  { startTime: '16:00', endTime: '17:00', label: '4:00 PM - 5:00 PM' },
  { startTime: '17:00', endTime: '18:00', label: '5:00 PM - 6:00 PM' },
  { startTime: '18:00', endTime: '19:00', label: '6:00 PM - 7:00 PM' },
];

const CUSTOMER_NAMES = [
  { firstName: 'Juan', lastName: 'Dela Cruz' },
  { firstName: 'Maria', lastName: 'Santos' },
  { firstName: 'Pedro', lastName: 'Reyes' },
  { firstName: 'Anna', lastName: 'Garcia' },
  { firstName: 'Luis', lastName: 'Mendoza' },
  { firstName: 'Sofia', lastName: 'Lopez' },
  { firstName: 'Miguel', lastName: 'Torres' },
];

const SERVICES_DATA = [
  { name: 'Aircon Cleaning', description: 'Standard aircon cleaning and maintenance', basePrice: 800, hp: 1.5, brand: 'Carrier' },
  { name: 'Aircon Installation', description: 'Split-type aircon installation', basePrice: 2500, hp: 1.5, brand: 'Daikin' },
  { name: 'Aircon Recharging', description: 'Freon recharge for split-type aircon', basePrice: 1200, hp: 2.0, brand: 'Panasonic' },
  { name: 'Aircon Repair', description: 'General aircon repair service', basePrice: 1500, hp: 1.5, brand: 'Samsung' },
  { name: 'Aircon General Service', description: 'Comprehensive aircon servicing', basePrice: 1000, hp: 2.5, brand: 'LG' },
];

const ADDRESSES = [
  '123 Rizal Ave, Makati City, Metro Manila',
  '456 Quezon Blvd, Quezon City, Metro Manila',
  '789 España St, Manila, Metro Manila',
  '321 Ortigas Center, Pasig City, Metro Manila',
  '654 Alabang, Muntinlupa City, Metro Manila',
  '987 Katipunan Ave, Quezon City, Metro Manila',
  '147 Shaw Blvd, Mandaluyong City, Metro Manila',
];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const User = require('../models/User');
  const Technician = require('../models/Technician');
  const CoreService = require('../models/CoreService');
  const BookingService = require('../models/BookingService');
  const Assignment = require('../models/Assignment');

  // Ensure we have at least 5 customers
  let customers = await User.find({ role: 'customer' }).limit(10);
  if (customers.length < 5) {
    console.log('Creating seed customers...');
    const hash = await bcrypt.hash('password123', 12);
    for (let i = 0; i < 5 - customers.length; i++) {
      const info = CUSTOMER_NAMES[i];
      const u = await User.create({
        firstName: info.firstName,
        lastName: info.lastName,
        email: `seed-customer-${Date.now()}-${i}@example.com`,
        phone: `0917${String(1000000 + i).slice(0, 7)}`,
        passwordHash: hash,
        role: 'customer',
        address: { province: 'Metro Manila', city: 'Makati', barangay: 'Bel-Air', postalCode: '1200' },
      });
      customers.push(u);
    }
    console.log(`Created ${5 - customers.length} customers`);
  }

  // Ensure we have at least 3 technicians
  let techs = await Technician.find({ active: true }).limit(10);
  if (techs.length < 3) {
    console.log('Creating seed technicians...');
    for (let i = 0; i < 3 - techs.length; i++) {
      const t = await Technician.create({
        name: `Tech ${Date.now()}-${i}`,
        phone: `0918${String(2000000 + i).slice(0, 7)}`,
        active: true,
        availabilityStatus: 'Available',
      });
      techs.push(t);
    }
    console.log(`Created ${3 - techs.length} technicians`);
  }

  // Find or create core services
  let services = await CoreService.find().limit(10);
  if (services.length < 3) {
    console.log('Creating seed core services...');
    for (const svc of SERVICES_DATA.slice(0, 3)) {
      const s = await CoreService.create({
        name: svc.name,
        description: svc.description,
        basePrice: svc.basePrice,
        category: 'Air Conditioning',
        hpOptions: [
          { hp: 1.0, price: svc.basePrice * 0.8 },
          { hp: 1.5, price: svc.basePrice },
          { hp: 2.0, price: svc.basePrice * 1.2 },
          { hp: 2.5, price: svc.basePrice * 1.5 },
        ],
        isActive: true,
      });
      services.push(s);
    }
    console.log('Created seed services');
  }

  // Get bookings for today to check existing count
  const existingToday = await BookingService.countDocuments({
    bookingDate: { $gte: TODAY, $lt: new Date(TODAY.getTime() + 86400000) },
  });
  console.log(`Existing bookings for today: ${existingToday}`);

  // Create 5 bookings spread across 1-7pm
  const bookingsToCreate = TIME_SLOTS.slice(0, 5);
  const created = [];

  for (let i = 0; i < bookingsToCreate.length; i++) {
    const slot = TIME_SLOTS[i];
    const customer = customers[i % customers.length];
    const tech = techs[i % techs.length];
    const svc = services[i % services.length];

    const bookingData = {
      customerId: customer._id,
      technicianId: tech._id,

      customer: {
        _id: customer._id,
        name: `${customer.firstName} ${customer.lastName}`,
        email: customer.email,
        phone: customer.phone,
        address: ADDRESSES[i % ADDRESSES.length],
      },

      technician: {
        _id: tech._id,
        name: tech.name,
        phone: tech.phone,
        email: tech.userEmail || '',
      },

      serviceId: svc._id,
      serviceModel: 'CoreService',
      serviceType: 'core',

      service: {
        _id: svc._id,
        name: svc.name,
        description: svc.description,
        basePrice: svc.basePrice,
      },

      brand: SERVICES_DATA[i % SERVICES_DATA.length].brand,
      applianceType: 'split',
      applianceTypeName: 'Split Type',
      hp: SERVICES_DATA[i % SERVICES_DATA.length].hp,
      hpDescription: `${SERVICES_DATA[i % SERVICES_DATA.length].hp} HP Split Type`,

      bookingDate: TODAY,
      startTime: slot.startTime,
      endTime: slot.endTime,
      selectedTimeLabel: slot.label,

      servicePrice: svc.basePrice || SERVICES_DATA[i % SERVICES_DATA.length].basePrice,
      serviceDurationMinutes: 60,
      travelFare: 150,
      travelTime: 30,
      distanceKm: 5,
      estimatedFee: (svc.basePrice || SERVICES_DATA[i % SERVICES_DATA.length].basePrice) + 150,

      totalPrice: svc.basePrice || SERVICES_DATA[i % SERVICES_DATA.length].basePrice,
      initialCost: 500,

      status: 'pending',
      priority: 'medium',

      isMultiService: false,
      quantity: 1,

      location: {
        address: ADDRESSES[i % ADDRESSES.length],
        coordinates: { type: 'Point', coordinates: [121.0 + Math.random() * 0.1, 14.5 + Math.random() * 0.1] },
      },

      paymentMethod: i % 2 === 0 ? 'cod' : 'gcash',
      downpaymentAmount: i % 2 === 0 ? Math.round((svc.basePrice || SERVICES_DATA[i % SERVICES_DATA.length].basePrice) * 0.5) : undefined,
      paymentStatus: 'pending',

      statusHistory: [
        {
          fromStatus: null,
          toStatus: 'pending',
          changedBy: customer._id,
          changedByName: `${customer.firstName} ${customer.lastName}`,
          timestamp: new Date(),
        },
      ],
    };

    const booking = await BookingService.create(bookingData);
    created.push(booking);

    const assignment = await Assignment.create({
      bookingId: booking._id,
      technicianId: tech._id,
      customerName: `${customer.firstName} ${customer.lastName}`,
      customerPhone: customer.phone,
      customerEmail: customer.email,
      serviceType: 'core',
      serviceName: svc.name,
      servicePrice: svc.basePrice || SERVICES_DATA[i % SERVICES_DATA.length].basePrice,
      bookingDate: TODAY,
      startTime: slot.startTime,
      endTime: slot.endTime,
      address: ADDRESSES[i % ADDRESSES.length],
      coordinates: {
        lat: 14.5 + Math.random() * 0.1,
        lng: 121.0 + Math.random() * 0.1,
      },
      status: 'pending_acceptance',
      priority: 'normal',
      estimatedFee: (svc.basePrice || SERVICES_DATA[i % SERVICES_DATA.length].basePrice) + 150,
      travelFare: 150,
    });

    console.log(`Created booking ${i + 1}: ${booking.bookingReference || booking._id} | ${slot.label} | ${svc.name} (assignment: ${assignment._id})`);
  }

  console.log(`\n✅ Successfully seeded ${created.length} bookings for today (1PM-7PM)`);
  console.log('\nBooking summary:');
  created.forEach((b, i) => {
    console.log(`  ${i + 1}. ${b.customer.name} - ${b.service.name} at ${b.startTime}-${b.endTime} [${b.status}]`);
  });

  await mongoose.disconnect();
  console.log('\nDone.');
}

run().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});

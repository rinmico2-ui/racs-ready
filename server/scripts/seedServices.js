/**
 * Seed script to populate default services and repairs into the database.
 * Usage: NODE_ENV=development node server/scripts/seedServices.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Service = require('../models/Service');

dotenv.config();
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/appointment_scheduler';

const defaults = {
  services: [
    { name: 'Aircon Installation', duration: 180, price: 3500, icon: 'bi-gear-wide-connected' },
    { name: 'Aircon Cleaning', duration: 90, price: 1200, icon: 'bi-droplet-half' },
    { name: 'Freon Recharging', duration: 60, price: 800, icon: 'bi-lightning-charge' },
    { name: 'Aircon Relocation', duration: 120, price: 2000, icon: 'bi-truck' },
    { name: 'Dismantling & Reinstall', duration: 120, price: 2000, icon: 'bi-nut' },
    { name: 'System Reprocess', duration: 60, price: 1000, icon: 'bi-arrow-repeat' },
    { name: 'Pump Down', duration: 45, price: 700, icon: 'bi-funnel' },
    { name: 'Leak Testing', duration: 45, price: 700, icon: 'bi-activity' },
    { name: 'CCTV Installation', duration: 60, price: 1200, icon: 'bi-shield-lock' }
  ],
  repairs: [
    { name: 'Refrigerator Repair', duration: 90, price: 1200, icon: 'bi-snow' },
    { name: 'Washing Machine', duration: 90, price: 1200, icon: 'bi-droplet' },
    { name: 'Microwave Oven', duration: 60, price: 800, icon: 'bi-radioactive' },
    { name: 'Freezer Service', duration: 90, price: 1200, icon: 'bi-thermometer-snow' },
    { name: 'Dryer Repair', duration: 60, price: 800, icon: 'bi-wind' },
    { name: 'Rice Cooker', duration: 45, price: 700, icon: 'bi-cup-hot' },
    { name: 'Electric Fan', duration: 45, price: 700, icon: 'bi-fan' },
    { name: 'Water Dispenser', duration: 60, price: 800, icon: 'bi-cup-straw' },
    { name: 'Electric Kettle', duration: 30, price: 500, icon: 'bi-lightning' }
  ]
};

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  let created = 0;
  for (const svc of defaults.services) {
    const existing = await Service.findOne({ name: svc.name, category: 'service' });
    if (existing) {
      await Service.updateOne({ _id: existing._id }, { $set: { ...svc, active: true } });
    } else {
      await Service.create({ ...svc, category: 'service' });
      created += 1;
    }
  }

  for (const svc of defaults.repairs) {
    const existing = await Service.findOne({ name: svc.name, category: 'repair' });
    if (existing) {
      await Service.updateOne({ _id: existing._id }, { $set: { ...svc, active: true } });
    } else {
      await Service.create({ ...svc, category: 'repair' });
      created += 1;
    }
  }

  console.log(`Seeding complete. New records created: ${created}`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

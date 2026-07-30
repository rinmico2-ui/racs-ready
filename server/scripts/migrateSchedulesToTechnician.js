/*
 * Migration: copy TechnicianSchedule documents into Technician.workingDays / restDates
 * Usage:
 *   NODE_ENV=development node server/scripts/migrateSchedulesToTechnician.js
 *   Add --delete to remove TechnicianSchedule documents after migration
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/appointment_scheduler';

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  const TechnicianSchedule = require('../models/TechnicianSchedule');
  const Technician = require('../models/Technician');

  const schedules = await TechnicianSchedule.find({}).lean();
  if (!schedules.length) {
    console.log('No TechnicianSchedule documents found — nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  let migrated = 0;
  for (const s of schedules) {
    if (!s.technicianId) continue;
    const tech = await Technician.findById(s.technicianId);
    if (!tech) {
      console.warn('Technician not found for schedule:', s.technicianId);
      continue;
    }
    tech.workingDays = Array.isArray(s.workingDays) ? s.workingDays : [];
    tech.restDates = Array.isArray(s.restDates) ? s.restDates.map(r => ({ date: r.date, reason: r.reason || '' })) : [];
    await tech.save();
    migrated++;
    console.log('Migrated schedule for technician:', String(s.technicianId));
  }

  console.log('Migration complete — migrated', migrated, 'schedules');

  if (process.argv.includes('--delete')) {
    const del = await TechnicianSchedule.deleteMany({});
    console.log('Deleted TechnicianSchedule documents:', del.deletedCount);
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
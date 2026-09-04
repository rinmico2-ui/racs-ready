require("dotenv").config();
const mongoose = require("mongoose");
const { buildMongoConnectionUri } = require("../utils/mongoConnection");

const configuredUri =
  process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler";
const { uri: MONGODB_URI } = buildMongoConnectionUri(configuredUri, {
  directHosts: process.env.MONGODB_DIRECT_HOSTS,
  replicaSet: process.env.MONGODB_REPLICA_SET,
  authSource: process.env.MONGODB_AUTH_SOURCE,
});

const TechnicianAttendance = require("../models/TechnicianAttendance");
const Technician = require("../models/Technician");

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB");

  const technicians = await Technician.find({ active: true }).lean();
  if (!technicians.length) {
    console.log("No active technicians found. Exiting.");
    await mongoose.disconnect();
    return;
  }
  console.log(`Found ${technicians.length} active technicians`);

  const today = new Date();
  const daysBack = 7;
  let created = 0;
  let skipped = 0;

  for (let d = 0; d < daysBack; d++) {
    const date = new Date(today);
    date.setDate(date.getDate() - d);
    date.setHours(0, 0, 0, 0);

    const dow = date.getDay();
    if (dow === 0) continue; // skip Sundays

    for (const tech of technicians) {
      // ~80% chance of being present on a weekday
      if (Math.random() > 0.8) {
        skipped++;
        continue;
      }

      const checkIn = new Date(date);
      checkIn.setHours(8, 0, 0, 0); // constant 8:00 AM

      const checkOut = new Date(date);
      const endHour = randomInt(16, 18); // 4 PM - 6 PM
      const endMin = randomInt(0, 59);
      checkOut.setHours(endHour, endMin, 0, 0);

      const isLate = Math.random() < 0.15; // 15% chance late

      try {
        await TechnicianAttendance.findOneAndUpdate(
          { technicianId: tech._id, date: date },
          {
            $setOnInsert: {
              technicianId: tech._id,
              date: date,
              userId: tech.user || undefined,
              status: isLate ? "Late" : "Present",
              checkInTime: isLate ? new Date(date.getTime() + 15 * 60000) : checkIn,
              checkOutTime: checkOut,
              qrVerified: false,
              method: "manual",
              remarks: "Seeded attendance record",
            },
          },
          { upsert: true, new: true }
        );
        created++;
      } catch (err) {
        if (err.code === 11000) {
          skipped++; // duplicate, already exists
        } else {
          console.error(`Error for ${tech.name}:`, err.message);
        }
      }
    }
  }

  console.log(`\nDone! Created/updated: ${created}, Skipped: ${skipped}`);
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Seed EmployeeCompensation records for all active technicians and secretaries
 * that don't have an active compensation record yet.
 *
 * Usage:  node server/scripts/seedEmployeeCompensation.js
 *
 * Default pay rates (override via env vars):
 *   TECHNICIAN_DAILY_RATE  (default: 650)
 *   SECRETARY_MONTHLY_RATE (default: 18000)
 *   OT_RATE_PER_HOUR       (default: 100)
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler";
const User = require("../models/User");
const EmployeeCompensation = require("../models/EmployeeCompensation");

const TECH_DAILY = Number(process.env.TECHNICIAN_DAILY_RATE) || 650;
const SEC_MONTHLY = Number(process.env.SECRETARY_MONTHLY_RATE) || 18000;
const OT_RATE = Number(process.env.OT_RATE_PER_HOUR) || 100;

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB.");

  // Drop the old strict unique index if it exists so the new partial unique index takes over
  try {
    const indexes = await EmployeeCompensation.collection.indexes();
    const oldUnique = indexes.find(
      (ix) => ix.key.employee === 1 && ix.key.effectiveFrom === 1 && ix.unique && !ix.partialFilterExpression,
    );
    if (oldUnique) {
      await EmployeeCompensation.collection.dropIndex(oldUnique.name);
      console.log(`Dropped old unique index: ${oldUnique.name}`);
    }
  } catch (e) {
    // Index may not exist — ignore
  }

  const staff = await User.find({
    role: { $in: ["technician", "secretary"] },
    active: { $ne: false },
  }).select("firstName lastName role").lean();

  console.log(`Found ${staff.length} active staff members.`);

  let created = 0;
  let skipped = 0;

  for (const member of staff) {
    const existing = await EmployeeCompensation.findOne({ employee: member._id, active: true }).lean();
    if (existing) {
      skipped++;
      continue;
    }

    const isTech = member.role === "technician";
    await EmployeeCompensation.create({
      employee: member._id,
      payType: isTech ? "daily" : "monthly",
      baseRate: isTech ? TECH_DAILY : SEC_MONTHLY,
      overtimeRate: OT_RATE,
      effectiveFrom: new Date("2026-01-01"),
      active: true,
    });

    created++;
    console.log(`  + ${member.firstName} ${member.lastName} (${member.role}) — ${isTech ? "Daily ₱" + TECH_DAILY : "Monthly ₱" + SEC_MONTHLY}`);
  }

  console.log(`\nDone. Created: ${created}, Skipped (already has active): ${skipped}`);
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

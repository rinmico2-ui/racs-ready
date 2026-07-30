#!/usr/bin/env node
/*
Script to fetch public holidays from Nager.Date and save them as global
NonWorkingDay entries.  Useful for populating the database ahead of the
booking calendar or running on a schedule.

Usage:
  node importNagerHolidays.js [COUNTRY] [YEAR|START-END] [...YEARS]

- COUNTRY defaults to process.env.NAGER_COUNTRY || 'PH'.
- If no years are provided the current year is used.
- A single token "2024-2026" will import all years in the inclusive range.

The script is idempotent: duplicates are skipped thanks to the unique index
on (date, service).
*/

require("dotenv").config();
const mongoose = require("mongoose");
const { getPublicHolidays } = require("../utils/nagerDateService");
const NonWorkingDay = require("../models/NonWorkingDay");

async function parseYears(args) {
  if (!args || args.length === 0) {
    return [new Date().getFullYear()];
  }
  const years = [];
  for (const tok of args) {
    if (tok.includes("-")) {
      const parts = tok.split("-").map((s) => parseInt(s, 10));
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        const [start, end] = parts;
        for (let y = start; y <= end; y++) years.push(y);
        continue;
      }
    }
    const y = parseInt(tok, 10);
    if (!isNaN(y)) years.push(y);
  }
  if (years.length === 0) years.push(new Date().getFullYear());
  return years;
}

async function run() {
  const mongoUri =
    process.env.MONGODB_URI ||
    "mongodb://localhost:27017/appointment_scheduler";
  const country = (
    process.argv[2] ||
    process.env.NAGER_COUNTRY ||
    "PH"
  ).toUpperCase();
  const yearArgs = process.argv.slice(3);
  const years = await parseYears(yearArgs);

  console.log("Connecting to", mongoUri);
  await mongoose.connect(mongoUri);
  try {
    for (const year of years) {
      console.log(`Fetching holidays for ${country} ${year}`);
      let holidays = [];
      try {
        holidays = await getPublicHolidays(country, year);
      } catch (err) {
        console.error(`fetch failed for ${year}:`, err.message || err);
        continue;
      }
      for (const h of holidays) {
        const date = new Date(h.date + "T00:00:00");
        const note = h.localName || h.name || "";
        try {
          await NonWorkingDay.updateOne(
            { date: date, service: null },
            { $setOnInsert: { date, note, reason: "public holiday" } },
            { upsert: true },
          );
        } catch (e) {
          if (e.code !== 11000) {
            console.warn("write error", date.toISOString(), e.message || e);
          }
        }
      }
      console.log(`Imported ${holidays.length} holidays for ${year}`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error("Script error:", err && err.message ? err.message : err);
  process.exit(1);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ejs = require("ejs");

const root = path.join(__dirname, "..");
const pages = fs.readFileSync(path.join(root, "routes/pages.js"), "utf8");
const tracking = fs.readFileSync(path.join(root, "views/pages/tracking.ejs"), "utf8");

test("My Schedule renders a shell before its owned data query", () => {
  const shell = pages.match(/router\.get\("\/tracking",[\s\S]*?\n\}\);/)?.[0] || "";
  const feed = pages.match(/router\.get\("\/tracking\/data",[\s\S]*?\n\}\);/)?.[0] || "";
  assert.match(shell, /res\.render\("pages\/tracking"/);
  assert.doesNotMatch(shell, /BookingService\.find|Project\.find/);
  assert.match(feed, /pageAuth\.requireRole\("customer"\)/);
  assert.match(feed, /customerId: req\.user\._id/);
  assert.match(feed, /\.select\("_id customerId customer technicianId/);
  assert.match(feed, /\.sort\(\{ bookingDate: -1 \}\)/);
  assert.match(feed, /res\.json\(\{ bookings: items, currentBookingId:/);
});

test("My Schedule shows loading and retry states and hydrates cards and calendar", async () => {
  const html = await ejs.renderFile(path.join(root, "views/pages/tracking.ejs"), {
    initialBookings: [], initialBooking: null,
  });
  assert.match(tracking, /bookingsLoading = true/);
  assert.match(tracking, /Loading your schedule/);
  assert.match(tracking, /id="trkRetrySchedule"/);
  assert.match(tracking, /window\.customerSchedulePrefetch = fetch\('\/tracking\/data'/);
  assert.match(tracking, /const request = window\.customerSchedulePrefetch/);
  assert.match(tracking, /fetch\('\/tracking\/data'/);
  assert.match(tracking, /bookings\.splice\(0, bookings\.length, \.\.\.data\.bookings\)/);
  assert.match(tracking, /calendar\.addEventSource\(bookings\.map\(bookingToEvent\)/);
  for (const match of html.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim() && !match[0].includes('type="application/json"')) {
      assert.doesNotThrow(() => new vm.Script(match[1]));
    }
  }
});

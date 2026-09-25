"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const styles = fs.readFileSync(path.join(__dirname, "../public/css/services-mobile-ux.css"), "utf8");

test("each booking popup briefly draws attention to its enabled next button", () => {
  const cue = styles.slice(styles.indexOf("/* Point out the newly available next action once"));
  assert.match(cue, /\.mobile-booking-bar\.is-guiding \.mobile-booking-continue/);
  assert.match(cue, /\.location-next-action\.just-became-ready\.is-ready \.location-next-button/);
  assert.match(cue, /\.schedule-next-action\.just-became-ready\.is-ready button:not\(:disabled\)/);
  assert.match(cue, /\.booking-review-mobile-action\.just-became-ready button/);
  assert.match(cue, /animation: bookingNextButtonCue 1\.35s \.18s ease-out both/);
  assert.doesNotMatch(cue, /bookingNextButtonCue[^;]*infinite/);
});

test("the button cue is disabled when the customer prefers reduced motion", () => {
  const cue = styles.slice(styles.indexOf("/* Point out the newly available next action once"));
  assert.match(cue, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.booking-review-mobile-action\.just-became-ready button \{ animation: none; \}/);
});

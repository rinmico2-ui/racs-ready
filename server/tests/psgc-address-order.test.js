"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const serverRoot = path.join(__dirname, "..");
const read = relativePath => fs.readFileSync(path.join(serverRoot, relativePath), "utf8");

const handler = read("public/js/psgc-handler.js");
const pages = read("routes/pages.js");
const profile = read("views/pages/profile.ejs");

test("PSGC address levels are alphabetized by their displayed names", () => {
  assert.match(handler, /new Intl\.Collator\("en-PH"/);
  assert.match(handler, /function alphabetizeByName\(items\)/);
  assert.match(handler, /const provinces = alphabetizeByName\(normalizeList\(raw\)\)/);
  assert.match(handler, /const matches = alphabetizeByName\(cities\.filter/);
  assert.match(handler, /const barangays = alphabetizeByName\(normalizeList\(raw\)\)/);
});

test("sign-up and customer profile load the alphabetized PSGC handler", () => {
  const asset = "/js/psgc-handler.js?v=20260928-alphabetical-address-v2";
  assert.ok(pages.split(asset).length - 1 >= 2);
  assert.match(profile, /psgc-handler\.js\?v=20260928-alphabetical-address-v2/);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = relativePath => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("chatbot uses the live services route and normalizes legacy AI links", () => {
  const chat = read("routes/chatRoutes.js");
  assert.doesNotMatch(chat, /\[Core Service page\]\(\/core-service\)/);
  assert.match(chat, /\[Services page\]\(\/services\)/);
  assert.match(chat, /function normalizeCustomerFacingLinks\(text\)/);
  assert.match(chat, /\.replace\(\/\\\/core-service\\b\/gi, "\/services"\)/);
  assert.match(chat, /safePayload\.fullText = normalizeCustomerFacingLinks/);
});

test("legacy service URLs redirect and public links use the canonical page", () => {
  const pages = read("routes/pages.js");
  const about = read("views/pages/about.ejs");
  assert.match(pages, /router\.get\("\/core-service", pageAuth\.requireCustomerOrGuest,[\s\S]*?res\.redirect\(301, "\/services"\)/);
  assert.match(about, /href="\/services" class="about-btn-primary"/);
  assert.doesNotMatch(about, /href="\/core-service"/);
});

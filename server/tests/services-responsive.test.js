"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const servicesScript = fs.readFileSync(
  path.join(__dirname, "../public/js/services-multi.js"),
  "utf8",
);
const servicesView = fs.readFileSync(
  path.join(__dirname, "../views/pages/services.ejs"),
  "utf8",
);

test("core services use a two-column mobile grid", () => {
  assert.match(
    servicesScript,
    /type === 'core'[\s\S]*?'col-6 col-md-4 core-service-column'/,
  );
  assert.match(servicesView, /#coreServiceCards > \.core-service-column/);
});

test("mobile core-service cards remain compact and touch friendly", () => {
  assert.match(servicesView, /#coreServiceCards \.service-card-media[\s\S]*?aspect-ratio: 4 \/ 3/);
  assert.match(servicesView, /#coreServiceCards \.card-title[\s\S]*?-webkit-line-clamp: 2/);
  assert.match(servicesView, /#coreServiceCards \.add-service-btn[\s\S]*?min-height: 44px/);
});

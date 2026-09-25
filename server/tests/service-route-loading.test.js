"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/js/services-multi.js"), "utf8");
const loadingFunctions = ["showRouteLoading", "hideRouteLoading"]
  .map(name => {
    const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`));
    assert.ok(match, `${name} must be available`);
    return match[0];
  }).join("\n");

test("route loading message does not remain after repeated pin changes and route completion", () => {
  const overlays = [];
  const document = {
    getElementById: id => id === "technicianMap" ? {
      insertAdjacentHTML: () => {
        const overlay = { remove: () => overlays.splice(overlays.indexOf(overlay), 1) };
        overlays.push(overlay);
      },
    } : null,
    querySelectorAll: selector => selector === "#routeLoading" ? [...overlays] : [],
  };
  const { showRouteLoading, hideRouteLoading } = vm.runInNewContext(
    `${loadingFunctions}\n({ showRouteLoading, hideRouteLoading })`, { document },
  );

  showRouteLoading();
  showRouteLoading();
  assert.equal(overlays.length, 1);
  hideRouteLoading();
  assert.equal(overlays.length, 0);

  // Also clear duplicate overlays left by a prior version of the page.
  showRouteLoading();
  overlays.push({ remove: () => overlays.pop() });
  hideRouteLoading();
  assert.equal(overlays.length, 0);
});

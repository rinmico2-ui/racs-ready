"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const serverRoot = path.join(__dirname, "..");

function sourceFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (["node_modules", "vendor"].includes(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (/\.(?:js|ejs)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

const runtimeSources = [
  ...sourceFiles(path.join(serverRoot, "public", "js")),
  ...sourceFiles(path.join(serverRoot, "views")),
];

test("server sends a tile-compatible privacy-preserving referrer policy", () => {
  const index = fs.readFileSync(path.join(serverRoot, "index.js"), "utf8");
  assert.match(index, /Referrer-Policy", "strict-origin-when-cross-origin"/);
  assert.match(index, /https:\/\/\*\.arcgisonline\.com/);
  assert.doesNotMatch(index, /tile\.openstreetmap\.org|basemaps\.cartocdn\.com/);
});

test("active maps do not use the volunteer OSM tile server and keep attribution enabled", () => {
  const violations = [];
  for (const file of runtimeSources) {
    const source = fs.readFileSync(file, "utf8");
    if (/https:\/\/(?:\{s\}\.)?tile\.openstreetmap\.org/.test(source)) {
      violations.push(`${path.relative(serverRoot, file)} uses the volunteer OSM tile server`);
    }
    if (/attributionControl\s*:\s*false/.test(source)) {
      violations.push(`${path.relative(serverRoot, file)} hides map attribution`);
    }
  }
  assert.deepEqual(violations, []);
});

test("all application maps use the shared Esri hybrid provider", () => {
  const providerPath = path.join(serverRoot, "public/js/esri-hybrid-layer.js");
  const violations = runtimeSources.filter((file) => {
    if (file === providerPath) return false;
    const source = fs.readFileSync(file, "utf8");
    return /(?:L|window\.L)\.tileLayer\(/.test(source)
      || /basemaps\.cartocdn\.com|World_Street_Map|World_Transportation/.test(source);
  }).map((file) => path.relative(serverRoot, file));
  assert.deepEqual(violations, []);

  const provider = fs.readFileSync(providerPath, "utf8");
  assert.match(provider, /World_Imagery/);
  assert.match(provider, /World_Boundaries_and_Places/);
  assert.match(provider, /Tiles &copy; Esri/);
  assert.match(provider, /Labels &copy; Esri/);
  assert.match(provider, /maxNativeZoom:\s*19/);
  assert.match(provider, /maxZoom:\s*22/);

  for (const layout of ["main", "admin", "secretary", "technician"]) {
    const source = fs.readFileSync(path.join(serverRoot, `views/layouts/${layout}.ejs`), "utf8");
    assert.match(source, /\/js\/esri-hybrid-layer\.js/);
    assert.match(source, /esri-hybrid-layer\.js\?v=20260914-esri-overzoom-v3/);
  }
});

test("appointment queue maps use Esri hybrid without a layer selector", () => {
  const queue = fs.readFileSync(
    path.join(serverRoot, "views/pages/admin/Appointments/AppointmentsUnified.ejs"),
    "utf8",
  );
  assert.ok((queue.match(/createEsriHybridLayer\(\)/g) || []).length >= 2);
  assert.doesNotMatch(queue, /id="tdLayerSelector"/);
  assert.doesNotMatch(queue, /tileLayer\(|basemaps\.cartocdn\.com/);
  assert.doesNotMatch(queue, /__assignMap[\s\S]{0,800}tile\.openstreetmap\.org/);
});

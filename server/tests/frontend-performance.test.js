"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("shared staff navigation does not force layout work on scroll", () => {
  const adminScript = read("public/js/admin.js");

  assert.doesNotMatch(
    adminScript,
    /addEventListener\s*\(\s*["']scroll["']\s*,\s*adjustAdminOffsets/,
  );
  assert.match(adminScript, /ResizeObserver/);
  assert.match(adminScript, /requestAnimationFrame/);
});

test("layouts use the low-power profile and do not globally load GSAP", () => {
  const layouts = ["main.ejs", "admin.ejs", "secretary.ejs", "technician.ejs", "auth.ejs"];

  for (const layout of layouts) {
    const source = read(`views/layouts/${layout}`);
    assert.match(source, /performance\.css/);
    assert.match(source, /performance\.js/);
    assert.doesNotMatch(source, /gsap\.min\.js/);
  }
});

test("heavy staff libraries are guarded by page capability checks", () => {
  for (const layout of ["admin.ejs", "secretary.ejs", "technician.ejs"]) {
    const source = read(`views/layouts/${layout}`);
    assert.match(source, /pageUsesAos/);
    assert.match(source, /pageUsesLeaflet/);
  }

  assert.match(read("views/layouts/secretary.ejs"), /pageUsesChart/);
  assert.match(read("views/layouts/technician.ejs"), /pageUsesChart/);
});

test("mobile performance stylesheet removes continuous compositing", () => {
  const styles = read("public/css/performance.css");

  assert.match(styles, /max-width:\s*767px/);
  assert.match(styles, /backdrop-filter:\s*none\s*!important/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
  assert.match(styles, /content-visibility:\s*auto/);
});

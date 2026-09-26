"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const styles = read("public/css/customer-sidebar.css");
const script = read("public/js/navbar-auth.js");
const layout = read("views/layouts/main.ejs");

test("expanded customer sidebar does not create a wide page gutter", () => {
  assert.doesNotMatch(styles, /body\.has-racs-dock\s*\{[^}]*padding-right/);
  assert.doesNotMatch(styles, /body\.has-racs-dock #publicNavbar\s*\{[^}]*right:/);
  assert.doesNotMatch(styles, /body\.has-racs-dock\.racs-dock-expanded/);
  assert.doesNotMatch(script, /classList\.(?:add|remove|toggle)\("racs-dock-expanded"/);
});

test("customer sidebar assets are cache-busted together", () => {
  assert.match(layout, /customer-sidebar\.css\?v=20260926-overlay-dock-v3/);
  assert.match(layout, /navbar-auth\.js\?v=20260926-overlay-dock-v3/);
});

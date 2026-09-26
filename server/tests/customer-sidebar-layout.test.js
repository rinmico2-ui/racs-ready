"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const styles = read("public/css/customer-sidebar.css");
const script = read("public/js/navbar-auth.js");
const layout = read("views/layouts/main.ejs");

test("customer account drawer creates no page gutter or persistent content cover", () => {
  assert.doesNotMatch(styles, /body\.has-racs-dock\s*\{[^}]*padding-right/);
  assert.doesNotMatch(styles, /body\.has-racs-dock #publicNavbar\s*\{[^}]*right:/);
  assert.doesNotMatch(styles, /body\.has-racs-dock\.racs-dock-expanded/);
  assert.doesNotMatch(script, /classList\.(?:add|remove|toggle)\("racs-dock-expanded"/);
  assert.doesNotMatch(layout, /has-racs-dock/);
  assert.match(styles, /#authSidebar\.auth-sidebar\s*\{[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none[^}]*translateX\(100%\)/);
  assert.match(styles, /#authSidebar\.auth-sidebar\.open\s*\{[^}]*visibility:\s*visible[^}]*pointer-events:\s*auto/);
  assert.doesNotMatch(styles, /#authSidebar\.auth-sidebar\.is-collapsed/);
});

test("customer sidebar assets are cache-busted together", () => {
  assert.match(layout, /customer-sidebar\.css\?v=20260926-account-drawer-v4/);
  assert.match(layout, /navbar-auth\.js\?v=20260926-account-drawer-v4/);
});

test("desktop and mobile expose one accessible account drawer trigger", () => {
  const navbar = read("views/partials/navbar.ejs");
  const sidebar = read("views/partials/sidebar.ejs");
  assert.match(styles, /\.racs-menu-trigger\s*\{[^}]*display:\s*inline-flex/);
  assert.match(navbar, /id="racsMenuTrigger"[\s\S]*?racs-menu-trigger-label">My Account/);
  assert.match(navbar, /<\/div>\s*<% if \(typeof user !== 'undefined' && user\) \{ %>\s*[\s\S]*?class="racs-navbar-account/);
  assert.match(sidebar, /id="authSidebar"[^>]*role="dialog"[^>]*aria-hidden="true"[^>]*inert/);
  assert.match(script, /sidebar\.removeAttribute\("inert"\)/);
  assert.match(script, /event\.key !== "Tab"/);
  assert.match(script, /sidebar\.querySelectorAll\([\s\S]*?button:not\(\[disabled\]\)/);
});

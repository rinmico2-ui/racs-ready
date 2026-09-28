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
  assert.match(layout, /customer-sidebar\.css\?v=20260928-account-top-v6/);
  assert.match(layout, /navbar-auth\.js\?v=20260928-account-top-v6/);
});

test("customer identity appears at the top without duplicating its profile menu", () => {
  const sidebar = read("views/partials/sidebar.ejs");
  const identity = sidebar.indexOf('class="racs-sidebar-account"');
  const navigation = sidebar.indexOf('class="racs-sidebar-nav"');

  assert.ok(identity > -1 && identity < navigation);
  assert.doesNotMatch(sidebar, /id="racsGroupAccount"/);
  assert.equal((sidebar.match(/href="\/profile"/g) || []).length, 1);
  assert.match(styles, /\.racs-sidebar-menu\s*\{[^}]*top:\s*calc\(100% \+ 0\.5rem\)[^}]*bottom:\s*auto/);
});

test("authenticated mobile navigation uses one accessible combined drawer trigger", () => {
  const navbar = read("views/partials/navbar.ejs");
  const sidebar = read("views/partials/sidebar.ejs");
  assert.match(styles, /\.racs-menu-trigger\s*\{[^}]*display:\s*inline-flex/);
  assert.match(navbar, /id="racsMenuTrigger"[\s\S]*?racs-menu-trigger-label">My Account/);
  assert.match(navbar, /has-customer-drawer/);
  assert.match(styles, /#publicNavbar\.has-customer-drawer \.navbar-toggler,[\s\S]*?#publicNavbar\.has-customer-drawer #mainNav\s*\{\s*display:\s*none\s*!important/);
  assert.match(styles, /\.racs-sidebar-site-navigation\s*\{\s*display:\s*block/);
  assert.match(sidebar, /racs-sidebar-site-navigation[\s\S]*?href="\/"[\s\S]*?href="\/services"[\s\S]*?href="\/products"[\s\S]*?href="\/about"[\s\S]*?href="\/contact"/);
  assert.match(navbar, /<\/div>\s*<% if \(typeof user !== 'undefined' && user\) \{ %>\s*[\s\S]*?class="racs-navbar-account/);
  assert.match(sidebar, /id="authSidebar"[^>]*role="dialog"[^>]*aria-hidden="true"[^>]*inert/);
  assert.match(script, /sidebar\.removeAttribute\("inert"\)/);
  assert.match(script, /event\.key !== "Tab"/);
  assert.match(script, /sidebar\.querySelectorAll\([\s\S]*?button:not\(\[disabled\]\)/);
});

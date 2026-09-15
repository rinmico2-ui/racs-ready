const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relativePath => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
const layout = read('views/layouts/technician.ejs');
const navbar = read('views/partials/technician-navbar.ejs');
const responsive = read('public/css/technician/technician-enterprise-responsive.css');

test('technician layout loads one shared enterprise responsive shell', () => {
  assert.match(layout, /technician-enterprise-responsive\.css\?v=/);
  assert.match(layout, /<main class="technician-main"><%- body %><\/main>/);
  assert.doesNotMatch(layout, /<main class="p-4"><%- body %><\/main>/);
  assert.match(responsive, /--tech-page-gutter:\s*1\.5rem/);
  assert.match(responsive, /\.admin-content\s*\{[^}]*padding:\s*var\(--admin-topbar-height, 56px\) 0 0 !important/s);
});

test('shared technician shell covers every page-root family', () => {
  for (const rootClass of ['technician-page', 'exp-page', 'admin-dashboard', 'technician-dashboard-page', 'tw-page']) {
    assert.match(responsive, new RegExp('technician-main > \\.' + rootClass.replace('-', '\\-')));
  }
  assert.match(responsive, /technician-schedule-page > \.container/);
  assert.match(responsive, /\.tracker-wrap/);
});

test('technician navbar mobile grid is scoped to the navbar only', () => {
  assert.match(navbar, /#technicianNavbar > \.container-fluid\s*\{/);
  assert.match(navbar, /#technicianNavbar > \.container-fluid > div:first-child/);
  assert.doesNotMatch(navbar, /^\s*\.container-fluid\s*\{/m);
  assert.doesNotMatch(navbar, /^\s*\.container-fluid > div/m);
});

test('technician phone shell protects touch, forms, tables, modals, and motion preferences', () => {
  assert.match(responsive, /@media \(max-width: 767\.98px\)/);
  assert.match(responsive, /font-size:\s*16px/);
  assert.match(responsive, /-webkit-overflow-scrolling:\s*touch/);
  assert.match(responsive, /max-height:\s*calc\(100dvh - 1rem\)/);
  assert.match(responsive, /min-height:\s*42px/);
  assert.match(responsive, /@media \(prefers-reduced-motion: reduce\)/);
});

test('legacy technician cards and action groups cannot force phone overflow', () => {
  assert.match(responsive, /\.tw-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(responsive, /\.tw-head\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(responsive, /\.tracker-status-card \.status-meta\s*\{[^}]*minmax\(0, 1fr\)/s);
  assert.match(responsive, /\.profile-technician-page \.card-body\.p-4/);
});

test('technician notifications stay centered inside the mobile viewport', () => {
  assert.match(responsive, /#notifDropdown\s*\{[^}]*position:\s*fixed\s*!important/s);
  assert.match(responsive, /#notifDropdown\s*\{[^}]*left:\s*50%\s*!important/s);
  assert.match(responsive, /#notifDropdown\s*\{[^}]*width:\s*min\(380px, calc\(100vw - 1\.5rem\)\)\s*!important/s);
  assert.match(responsive, /#notifDropdown\s*\{[^}]*transform:\s*translateX\(-50%\)\s*!important/s);
  assert.match(responsive, /#notifList\s*\{[^}]*100dvh/s);
  assert.doesNotMatch(navbar, /#notifDropdown\s*\{[^}]*left:\s*0/s);
  assert.doesNotMatch(navbar, /#notifDropdown\s*\{[^}]*border-left:\s*none/s);
});

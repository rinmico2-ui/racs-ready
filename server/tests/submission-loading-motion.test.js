const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const motionCss = read('public/css/racs-loading-motion.css');
const servicesView = read('views/pages/services.ejs');
const servicesScript = read('public/js/services-multi.js');
const cartWizard = read('views/partials/cart-wizard.ejs');

test('service booking and order checkout load the isolated vehicle motion stylesheet', () => {
  assert.match(servicesView, /racs-loading-motion\.css\?v=/);
  assert.match(cartWizard, /racs-loading-motion\.css\?v=/);
  assert.match(motionCss, /@keyframes racsVehicleTraverse/);
  assert.match(motionCss, /animation:\s*racsVehicleTraverse 2\.8s linear infinite !important/);
  assert.match(motionCss, /html\.perf-lite|\.racs-loader \.racs-vanwrap/);
});

test('RACS branding remains attached to the van and readable after the vehicle flip', () => {
  assert.match(servicesView, /<g class="racs-van-brand"[^>]*>[\s\S]*?>RACS<\/text>/);
  assert.match(cartWizard, /<g class="racs-van-brand"[^>]*>[\s\S]*?>RACS<\/text>/);
  assert.match(motionCss, /\.racs-loader \.racs-van-brand\s*\{[^}]*transform:\s*scaleX\(-1\) !important;[^}]*transform-box:\s*fill-box;[^}]*transform-origin:\s*center;/s);
});

test('submission loaders remain visible long enough to paint meaningful progress', () => {
  assert.match(servicesScript, /waitForCarLoadingMinimum\(minimumMs = 900\)/);
  assert.match(servicesScript, /await waitForCarLoadingMinimum\(\)/);
  assert.match(cartWizard, /waitForOrderLoadingMinimum\(startedAt, minimumMs\)/);
  assert.match(cartWizard, /await hideModalBeforeLoading\(checkoutModalElement, checkoutModal\)/);
  assert.match(cartWizard, /await waitForOrderLoadingMinimum\(loadingStartedAt, 900\)/);
});

test('essential motion still respects the operating system reduced-motion preference', () => {
  assert.match(motionCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(motionCss, /\.racs-loader \.racs-vanwrap\s*\{[^}]*animation:\s*none !important/s);
});

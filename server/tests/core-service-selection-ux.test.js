'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { serviceDescription, groupServiceCards } = require('../public/js/core-appliance-batch');

const item = (name, options = {}) => ({ service: { name }, html: `<label>${name}</label>`, available: true, checked: false, ...options });

test('technical service names have short customer explanations and custom descriptions are retained', () => {
  assert.match(serviceDescription({ name: 'Freon Recharging' }), /refrigerant used for cooling/);
  assert.match(serviceDescription({ name: 'Dismantling & Reinstall' }), /Remove an aircon/);
  assert.match(serviceDescription({ name: 'Pump Down' }), /before removing or servicing/);
  assert.match(serviceDescription({ name: 'Leak Testing' }), /refrigerant leaks/);
  assert.equal(serviceDescription({ name: 'Custom care', description: 'A service arranged with staff.' }), 'A service arranged with staff.');
});

test('common choices stay visible while other unselected services are available in More services', () => {
  const html = groupServiceCards([item('Freon Recharging'), item('Aircon Installation'), item('Aircon Cleaning'), item('Dismantling & Reinstall')]);
  const extra = html.indexOf('<details');
  assert.ok(html.indexOf('<label>Aircon Installation') < extra);
  assert.ok(html.indexOf('<label>Aircon Cleaning') < extra);
  assert.ok(html.indexOf('<label>Freon Recharging') > extra);
  assert.ok(html.indexOf('<label>Dismantling & Reinstall') > extra);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
});

test('saved additional services are visible when returning to an aircon', () => {
  const html = groupServiceCards([item('Cleaning'), item('Leak Testing', { checked: true })]);
  assert.match(html, /<details class="cab-more-services" open>/);
  assert.match(html, /<label>Leak Testing<\/label>/);
});

test('unsupported choices stay separate while a stale selected choice remains available for removal', () => {
  const html = groupServiceCards([item('Cleaning'), item('Freon Recharging', { available: false }), item('Leak Testing', { available: false, checked: true })]);
  const unavailable = html.indexOf('cab-unavailable-services');
  assert.ok(html.indexOf('<label>Leak Testing') < unavailable);
  assert.ok(html.indexOf('<label>Freon Recharging') > unavailable);
  assert.match(html, /Services not available/);
});

test('a catalog of custom services is visible without an unnecessary disclosure step', () => {
  const html = groupServiceCards([item('Custom care'), item('Special maintenance')]);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /<label>Custom care/);
  assert.match(html, /<label>Special maintenance/);
});

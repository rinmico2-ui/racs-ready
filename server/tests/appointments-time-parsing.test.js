const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const view = fs.readFileSync(
  path.join(__dirname, '..', 'views', 'pages', 'admin', 'Appointments', 'AppointmentsUnified.ejs'),
  'utf8',
);

function loadAppointmentTimeParser() {
  const start = view.indexOf('function appointmentTimeMinutes(value)');
  const end = view.indexOf('\n  function statusLabel', start);
  assert.notEqual(start, -1, 'shared appointment time parser should exist');
  assert.notEqual(end, -1, 'shared appointment time parser should have a stable boundary');
  const context = {};
  vm.runInNewContext(`${view.slice(start, end)}\nthis.parse = appointmentTimeMinutes;`, context);
  return context.parse;
}

test('appointment time parser preserves 24-hour afternoon values', () => {
  const parse = loadAppointmentTimeParser();
  assert.equal(parse('17:00'), 17 * 60);
  assert.equal(parse('18:00'), 18 * 60);
  assert.equal(parse('5:00 PM'), 17 * 60);
  assert.equal(parse('12:00 AM'), 0);
  assert.equal(parse('1020'), 17 * 60);
});

test('assignment queue uses the shared parser instead of modulo-folding 24-hour time', () => {
  assert.doesNotMatch(view, /var aqParseMin=/);
  assert.match(view, /var sMin=appointmentTimeMinutes\(b\.startTime\)/);
  assert.match(view, /sMin\+30/);
});

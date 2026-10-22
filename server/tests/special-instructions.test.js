'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const instructions = require('../public/js/special-instructions');
const { presentTechnicianBooking } = require('../utils/technicianDataPresentation');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const message = 'Use the side gate.\nCall <before> arrival & ask for "Sam".';

test('booking instructions retain line breaks and render customer text safely', () => {
  const html = instructions.renderBooking({ paymentNotes: message });
  assert.match(html, /aria-label="Special instructions"/);
  assert.match(html, /Use the side gate\.\nCall &lt;before&gt; arrival &amp; ask for &quot;Sam&quot;\./);
  assert.doesNotMatch(html, /<before>/);
});

test('order instructions escape markup and use the saved delivery instructions', () => {
  const html = instructions.renderOrder({ delivery: { notes: '<img src=x onerror="alert(1)">\nRing twice.' } });
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;\nRing twice\./);
  assert.doesNotMatch(html, /<img/);
});

test('missing, blank, or malformed instructions have a clear empty state', () => {
  for (const value of [undefined, null, '', ' \n\t ', {}, ['text'], 123]) {
    assert.match(instructions.render(value), /No special instructions provided\./);
  }
  assert.match(instructions.renderBooking(null), /No special instructions provided\./);
  assert.match(instructions.renderOrder({}), /No special instructions provided\./);
});

test('staff activity and payment-record notes are not presented as customer instructions', () => {
  const booking = { notes: '[Payment Collected] internal note', bookingNotes: 'staff note',
    payments: [{ notes: 'Cash payment verified by staff' }] };
  const order = { notes: 'Warehouse notes', statusHistory: [{ note: 'Assigned by staff' }] };
  assert.match(instructions.renderBooking(booking), /No special instructions provided\./);
  assert.match(instructions.renderOrder(order), /No special instructions provided\./);
  assert.doesNotMatch(instructions.renderBooking(booking), /Payment Collected|staff note|verified by staff/);
});

test('the browser asset exposes the same safe renderer used by the detail views', () => {
  const context = { window: {} };
  vm.runInNewContext(read('public/js/special-instructions.js'), context);
  assert.equal(context.window.SpecialInstructions.renderBooking({ paymentNotes: message }),
    instructions.renderBooking({ paymentNotes: message }));
});

for (const serviceType of ['core', 'repair', 'mixed']) {
  test(`technician ${serviceType} booking overview shows customer instructions once`, () => {
    const source = read('views/pages/technician/assignments.ejs');
    const start = source.indexOf('    function renderCustomerDetails(');
    const end = source.indexOf('    function renderOverviewPage(', start);
    assert.ok(start > 0 && end > start);
    const mixedDetails = require('../public/js/mixed-service-details');
    const context = { MixedServiceDetails: mixedDetails, window: { MixedServiceDetails: mixedDetails, SpecialInstructions: instructions, RACSVisitSchedule: require('../public/js/technician-visit-schedule') },
      isRepairAssignment: () => serviceType === 'repair', isMixedWorkStarted: () => false,
      statusLabels: { accepted: 'Accepted' }, toPhTime: value => value };
    vm.runInNewContext(source.slice(source.indexOf('    function renderDailyPreparationCard('), source.indexOf('    function getWizardPageActions(')), context);
    vm.runInNewContext(source.slice(start, end), context);
    const html = context.renderCustomerDetails({ status: 'accepted', serviceType,
      bookingId: { paymentNotes: message, serviceType, services: [] } }, 'Oct 15, 2026', 'TEST', false, null, null, '');
    assert.equal((html.match(/aria-label="Special instructions"/g) || []).length, 1);
    assert.match(html, /Call &lt;before&gt; arrival &amp; ask for &quot;Sam&quot;/);
    assert.match(html, /data-visit-daily-preparation/);
  });
}

test('technician calendar booking API retains instructions and enforces the assigned technician', async () => {
  const source = read('routes/technicianApi.js');
  const start = source.indexOf('router.get("/appointments/:id",');
  const end = source.indexOf('\n/**', start);
  let handler, selected, assigned = true;
  const context = {
    router: { get: (_path, callback) => { handler = callback; } },
    mongoose: { Types: { ObjectId: { isValid: () => true } } },
    loadTechnicianContext: async () => ({ tech: { _id: 'tech-1' }, technicianIds: ['tech-1'] }),
    presentTechnicianBooking,
    require: module => module.includes('repair-visit-payment') ? require('../public/js/repair-visit-payment') : ({ findById: () => ({ select(value) { selected = [selected, value].filter(Boolean).join(' '); return this; },
      lean: async () => ({ technicianId: assigned ? 'tech-1' : 'tech-2', paymentNotes: message,
        customer: { name: 'Fixture', email: 'private@example.test' }, paymentProof: 'private' }) }) }),
  };
  vm.runInNewContext(source.slice(start, end), context);
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } });
  const allowed = response();
  await handler({ params: { id: 'booking-1' }, user: { _id: 'user-1' } }, allowed, error => { throw error; });
  assert.equal(allowed.body.booking.paymentNotes, message);
  assert.ok(selected.split(' ').includes('paymentNotes'));
  assert.equal(allowed.body.booking.paymentProof, undefined);
  assert.equal(allowed.body.booking.customer.email, undefined);
  assigned = false;
  const denied = response();
  await handler({ params: { id: 'booking-1' }, user: { _id: 'user-1' } }, denied, error => { throw error; });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.booking, undefined);
});

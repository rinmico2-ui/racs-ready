const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const route = read('routes/appointmentManagement.js');
const view = read('views/pages/admin/Appointments/AppointmentsUnified.ejs');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing section start: ${startMarker}`);
  assert.notEqual(end, -1, `missing section end: ${endMarker}`);
  return source.slice(start, end);
}

test('pending tab requests one bounded compact booking payload', () => {
  const pendingLoad = section(view, 'AU.Pending.load=function()', 'AU.Pending.applyFilters=function');
  assert.match(pendingLoad, /stage=pending_review&page=1&limit=100&compact=true/);
  assert.doesNotMatch(pendingLoad, /limit=500/);
  assert.match(route, /req\.query\.compact === 'true'/);
  assert.match(route, /'services\.name'.*'services\.repairIssue'/s);
  assert.doesNotMatch(route, /'services', 'serviceType'/);
});

test('flow statistics use one faceted aggregation instead of sequential count loops', () => {
  const statsRoute = section(route, "router.get('/flow-stats'", "router.get('/list'");
  assert.match(statsRoute, /BookingService\.aggregate\(\[\{\s*\$facet:/s);
  assert.doesNotMatch(statsRoute, /await BookingService\.countDocuments/);
  assert.doesNotMatch(statsRoute, /for \(const \[key, stage\]/);
});

test('payment verification completes the assignment-queue transition in one request', () => {
  const verifyRoute = section(route, "router.post('/:id/verify-payment'", '/**\n * Replace an overdue requested schedule');
  assert.match(verifyRoute, /transitionStatus\(BookingStatus\.PAYMENT_VERIFIED/);
  assert.match(verifyRoute, /transitionStatus\(BookingStatus\.AWAITING_ASSIGNMENT/);
  assert.match(verifyRoute, /destination:\s*'assignment_queue'/);

  const verifyClient = section(view, 'AU.Pending.verifyPayment=async function', 'AU.Pending.openReviewReschedule=function');
  assert.doesNotMatch(verifyClient, /move-to-queue/);
  assert.match(verifyClient, /destination!==['"]assignment_queue['"]/);
  assert.match(verifyClient, /_pdAll=_pdAll\.filter/);
  assert.match(verifyClient, /AU\.Pending\.load\(\)/);
  assert.doesNotMatch(verifyClient, /bootstrap\.Tab\.getOrCreateInstance/);
});

test('deep-linked appointment tabs do not perform a duplicate initial load', () => {
  const init = section(view, 'function auInit()', "if(typeof bootstrap!=='undefined')");
  assert.match(init, /classList\.contains\('active'\)\)switchTab\(initialTab\)/);
  assert.doesNotMatch(init, /loaded\[initialTab\]=true/);
  assert.doesNotMatch(init, /\n\s*loadTab\(initialTab\)/);
});

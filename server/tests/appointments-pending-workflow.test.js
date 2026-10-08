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
  const pendingLoad = section(view, 'AU.Pending.applyFilters=function', 'AU.Pending.renderStats=function');
  assert.match(pendingLoad, /stage:'pending_review',page:page,limit:_pdLimit,compact:'true',sort:sort/);
  assert.doesNotMatch(pendingLoad, /limit=500/);
  assert.match(route, /req\.query\.compact === 'true'/);
  assert.match(route, /'services\.name'.*'services\.repairIssue'/s);
  assert.doesNotMatch(route, /'services', 'serviceType'/);
});

test('pending sorting and filters run on the whole queue before server-side pagination', () => {
  const pendingLoad = section(view, 'AU.Pending.applyFilters=function', 'AU.Pending.renderStats=function');
  assert.match(pendingLoad, /operationsFetchJson/);
  assert.match(pendingLoad, /dateRange/);
  assert.match(pendingLoad, /_pdRequest/);
  assert.doesNotMatch(pendingLoad, /f\.sort|f\.slice|_pdAll\.slice/);
  assert.match(route, /listSortStages\('booking'/);
  assert.match(view, /Service Date: Latest First/);
  assert.match(view, /<th>Service Date<\/th>/);
});

test('flow statistics trim documents before the faceted aggregation', () => {
  const statsRoute = section(route, "router.get('/flow-stats'", "router.get('/list'");
  assert.match(statsRoute, /BookingService\.aggregate\(\[\{\s*\$project:[\s\S]*?\},\s*\{\s*\$facet:/);
  assert.match(statsRoute, /pendingReviews:\s*\[\s*\{\s*\$match:\s*\{\s*status:\s*'pending'/);
  assert.doesNotMatch(statsRoute, /await BookingService\.countDocuments/);
  assert.doesNotMatch(statsRoute, /for \(const \[key, stage\]/);
});

test('overview renders recent bookings independently of statistics and uses compact indexed pages', () => {
  const overview = section(view, 'AU.Overview.load=function()', 'AU.Overview.renderPipeline=function');
  assert.doesNotMatch(overview, /Promise\.all/);
  assert.match(overview, /list\?page=1&limit='\+_ovLimit\+'&compact=true'/);
  assert.match(overview, /_overviewListRequest/);
  assert.match(overview, /_overviewStatsRequest/);
  assert.match(route, /sortPreset === 'newest' \|\| sortPreset === 'oldest'/);
  assert.match(route, /'customer\.phone', 'technician\.name'/);
});

test('payment verification completes the assignment-queue transition in one request', () => {
  const verifyRoute = section(route, "router.post('/:id/verify-payment'", '/**\n * Replace a requested schedule');
  assert.match(verifyRoute, /transitionStatus\(BookingStatus\.PAYMENT_VERIFIED/);
  assert.match(verifyRoute, /transitionStatus\(BookingStatus\.AWAITING_ASSIGNMENT/);
  assert.match(verifyRoute, /destination:\s*'assignment_queue'/);

  const verifyClient = section(view, 'AU.Pending.verifyPayment=async function', 'AU.Pending.openReviewReschedule=function');
  assert.doesNotMatch(verifyClient, /move-to-queue/);
  assert.match(verifyClient, /destination!==['"]assignment_queue['"]/);
  assert.match(verifyClient, /_pdAll=_pdAll\.filter/);
  assert.match(verifyClient, /AU\.Pending\.load\(\)/);
  assert.doesNotMatch(verifyClient, /bootstrap\.Tab\.getOrCreateInstance/);

  for (const legacyView of [
    read('views/pages/admin/Appointments/PaymentVerification.ejs'),
    read('views/pages/admin/Appointments/PendingReview.ejs'),
  ]) {
    assert.doesNotMatch(legacyView, /move-to-queue/);
    assert.match(legacyView, /data\.destination\s*(?:===|!==)\s*'assignment_queue'/);
  }
});

test('deep-linked appointment tabs do not perform a duplicate initial load', () => {
  const init = section(view, 'function auInit()', "if(typeof bootstrap!=='undefined')");
  assert.match(init, /classList\.contains\('active'\)\)switchTab\(initialTab\)/);
  assert.doesNotMatch(init, /loaded\[initialTab\]=true/);
  assert.doesNotMatch(init, /\n\s*loadTab\(initialTab\)/);
});

test('schedule conflicts keep pending requests open for customer-agreed rescheduling', () => {
  const reschedule = section(route, "router.post('/:id/review-reschedule'", "router.post('/:id/move-to-queue'");
  assert.match(reschedule, /booking\.status !== BookingStatus\.PENDING/);
  assert.doesNotMatch(reschedule, /isReviewOverdue/);
  assert.match(reschedule, /contactConfirmed !== true/);
  assert.match(view, /value="schedule_conflict">Schedule conflict/);
  assert.match(view, /AU\.Pending\.rescheduleFromReject/);
  assert.match(route, /RESCHEDULE_RECOMMENDED/);
});

test('assignment queue priority is persisted and sorted before pagination', () => {
  assert.match(route, /sortPreset === 'priority'[\s\S]*?_priorityRank: -1, bookingDate: 1/);
  assert.match(route, /router\.patch\('\/:id\/priority'/);
  assert.match(view, /url\+='&sort=priority'/);
  assert.match(view, /AU\.Queue\.setPriority=function/);
});

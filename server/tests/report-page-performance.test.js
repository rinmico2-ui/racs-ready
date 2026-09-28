const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { clear, remember } = require('../utils/reportCache');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('report cache shares pending work and expires quickly', async () => {
  clear('performance-test');
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const producer = async () => { calls += 1; await gate; return { ready: true }; };

  const first = remember('performance-test', { range: '30' }, producer, { ttlMs: 1000 });
  const second = remember('performance-test', { range: '30' }, producer, { ttlMs: 1000 });
  release();

  assert.deepEqual(await first, { ready: true });
  assert.deepEqual(await second, { ready: true });
  assert.equal(calls, 1);
  clear('performance-test');
});

test('high-cost revenue and rating analytics use the bounded shared cache', () => {
  const revenue = read('utils/revenueAnalytics.js');
  const ratings = read('utils/serviceRatingReport.js');

  assert.match(revenue, /remember\("revenue-analytics", query/);
  assert.match(revenue, /ttlMs:\s*30000/);
  assert.match(ratings, /remember\("service-rating-report", source/);
  assert.match(ratings, /options\.paginate === false \|\| options\.now/);
});

test('revenue analytics keeps evidence blobs off the critical path', () => {
  const revenue = read('utils/revenueAnalytics.js');
  const bookingModel = read('models/BookingService.js');
  const paymentModel = read('models/Payment.js');

  assert.match(revenue, /const BOOKING_EVIDENCE_EXCLUSIONS/);
  assert.match(revenue, /const ORDER_ANALYTICS_FIELDS/);
  assert.match(revenue, /const PAYMENT_ANALYTICS_FIELDS/);
  assert.match(revenue, /const WALK_IN_ANALYTICS_FIELDS/);
  assert.match(revenue, /BookingService\.find\(bookingsQuery\)[\s\S]*?\.select\(`\$\{BOOKING_EVIDENCE_EXCLUSIONS\} -statusHistory`\)/);
  assert.match(revenue, /Payment\.find\(paymentsQuery\)\.select\(PAYMENT_ANALYTICS_FIELDS\)/);
  assert.match(revenue, /completedServiceCosts:[\s\S]*?serviceCategory:/);
  assert.match(bookingModel, /index\(\{ status: 1, completedAt: -1 \}\)/);
  assert.match(paymentModel, /index\(\{ submittedAt: -1 \}\)/);
});

test('report routes batch independent database work', () => {
  const pages = read('routes/pages.js');
  const api = read('routes/adminApi.js');

  assert.match(pages, /const \[payments, productRefunds, inventoryItems\] = await Promise\.all/);
  assert.match(pages, /const \[toolUsage, productOrders, merchandiseSales, reservations, adjustments\] = await Promise\.all/);
  assert.match(pages, /const \[ratingRows, serviceCostAnalytics, workflowAssignments, partsRequests\] = await Promise\.all/);
  assert.match(api, /const \[allTechs, techRatings, ratedBookings, completedJobCounts\] = await Promise\.all/);
  assert.match(api, /BookingService\.aggregate\(\[/);
  assert.doesNotMatch(api, /const completedBookings = await BookingService\.find\(\{ status: "completed" \}\)/);
});

test('admin and secretary shells avoid unnecessary remote blocking assets', () => {
  const admin = read('views/layouts/admin.ejs');
  const secretary = read('views/layouts/secretary.ejs');

  [admin, secretary].forEach(layout => {
    assert.match(layout, /href="\/vendor\/aos\/aos\.css"/);
    assert.match(layout, /src="\/vendor\/aos\/aos\.js"/);
    assert.match(layout, /src="https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@5\.3\.2\/dist\/js\/bootstrap\.bundle\.min\.js"/);
    assert.match(layout, /rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net"/);
  });
  assert.match(admin, /if \(pageUsesSocket\)/);
  assert.match(secretary, /const pageEmbedsChart/);
});

test('report documents use a short private navigation cache', () => {
  const pages = read('routes/pages.js');
  const api = read('routes/adminApi.js');
  assert.match(pages, /private, max-age=15, stale-while-revalidate=45/);
  assert.match(pages, /res\.vary\("Cookie"\)/);
  assert.match(api, /revenue-analytics;dur=/);
  assert.match(api, /private, max-age=15, stale-while-revalidate=30/);
});

test('revenue navigation renders a shell before expensive analytics finish', () => {
  const pages = read('routes/pages.js');
  const template = read('views/pages/admin/Reports/RevenueReports.ejs');
  const route = pages.slice(
    pages.indexOf('"/admin/reports/revenue"'),
    pages.indexOf('// Admin - Settings: Scheduling'),
  );

  assert.match(route, /analytics:\s*null/);
  assert.match(route, /deferredAnalytics:\s*true/);
  assert.doesNotMatch(route, /await buildRevenueAnalytics/);
  assert.match(template, /window\.__revenueInitialRequest\s*=\s*fetch\('\/api\/admin\/reports\/revenue'/);
  assert.match(template, /requestAnimationFrame\(\(\)\s*=>\s*applyFilters\(\{ initialLoad: true \}\)\)/);
  assert.match(template, /id="revenueDataState"/);
});

test('completed walk-in sales use completion time and refresh revenue immediately', () => {
  const analytics = read('utils/revenueAnalytics.js');
  const walkInSale = read('models/WalkInSale.js');
  const posRoutes = read('routes/posRoutes.js');
  const template = read('views/pages/admin/Reports/RevenueReports.ejs');

  assert.match(analytics, /status:\s*"completed",[\s\S]*?\{ completedAt: dateFilter \}/);
  assert.match(analytics, /s\.completedAt \|\| s\.createdAt/);
  assert.match(walkInSale, /index\(\{ status: 1, completedAt: -1 \}\)/);
  assert.ok((posRoutes.match(/clearReportCache\("revenue-analytics"\)/g) || []).length >= 3);
  assert.match(analytics, /order\.salesChannel === "walk_in"/);
  assert.match(analytics, /walkInOrderRevenue/);
  assert.match(template, /Walk-in Counter \/ POS Sales/);
  assert.match(template, /A\.walkInOrderRevenue/);
});

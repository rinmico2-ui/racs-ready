# Admin performance changes and verification

## MongoDB pool timeout follow-up (October 12, 2026)

The local application uses a 20-connection pool and a five-second checkout wait.
The reported timeout means a command could not acquire a connection within that
wait. It does not itself identify a bad password or missing transaction support.

Changes made locally:

- Dashboard booking counters, status totals, service distribution and seven
  trend days now use one compact aggregation instead of 14 separate count/group
  commands. Its current-schedule read selects only fields displayed in the card;
  it does not download inline booking photos.
- Preparation issues fetch linked bookings once across all technicians and both
  kit item lists. Reads select display fields and have server execution limits.
- Hidden dashboards skip kit polling, concurrent polls cannot overlap, and failed
  responses show an error instead of claiming there are no issues.
- The booking-monitor timer skips a cycle while its previous cycle is running.
  Calling its start function twice cannot create duplicate timers. Schedule and
  notification rules are unchanged.
- Pool telemetry records waiting and checked-out connections, checkout duration,
  configured pool size and timeout counts. Rate-limited warnings include these
  values and active HTTP requests, without connection credentials.

Read-only verification on the configured remote MongoDB found 67 bookings,
approximately 40 MB of booking data, and average booking documents of 633,541
bytes. The original status-group query used a collection scan. Server connections
were 53 with 356 available at the sample, so that sample did not show exhaustion
of the server's connection limit. These measurements do not establish the exact
application-pool occupancy when the earlier timeout occurred.

The new compact booking aggregation completed in 643 ms. Its six bookings for
today matched the original count query. The first diagnostic connection attempt
failed; a later read connected successfully. No live records, indexes or photos
were changed and no application background jobs were started for verification.
43 relevant isolated checks passed before the final documentation update.

After restarting the application, inspect the new `MongoDB checkout failed`
warning if the problem recurs. A safe read-only diagnostic is available:

```powershell
node server/scripts/diagnoseMongoPool.js
```

For only the compact summary and original today's-count comparison:

```powershell
node server/scripts/diagnoseMongoPool.js --summary-only
```

The diagnostic uses at most two connections, disables model/index creation,
omits credentials and query contents, and closes its connection when finished.
Awaitable MongoDB heartbeat commands are excluded from its slow-operation sample.
Public-network latency and the database host's CPU/disk still require live
monitoring if timeouts persist; these code changes do not prove the server's
capacity or guarantee that a remote connection will always succeed.

## What changed

- Dashboard attendance loads asynchronously instead of using synchronous XHR.
- Inventory rows render before decorative chart loading completes.
- Admin navigation starts with one compact summary request instead of eight endpoints. Warranty and resolution badges retain their existing policies and load later.
- Maintenance badge counts use one read-only aggregation; visiting a page no longer triggers maintenance status writes through its sidebar.
- Page authentication reuses the identity already validated for that same request. It is not a cross-request user cache.
- Informational admin summaries have a bounded, per-administrator, five-second process cache. Concurrent identical requests share work. API mutations invalidate it before and after writing; record details, operational decisions and write results are not cached.
- Payment table requests omit inline evidence and webhook/event blobs. Proof availability stays visible; opening payment details retrieves the existing evidence. Legacy API consumers retain their full response.
- Project detail reads run independent queries in parallel and no longer persist a planning preview merely by viewing the record. Explicit planning write endpoints are unchanged.
- Project, maintenance, audit and order overview filters cancel superseded requests and ignore stale results.
- Order actions refresh without waiting for the success popup timer and only reload a modal if that same order is still open.
- Order analytics initially renders its page shell, then loads the authenticated report with its existing filters, evidence and chart dependencies.

## Local checks

Run from the project directory, without loading production credentials:

```powershell
$env:NODE_ENV = "test"
$env:JWT_SECRET = "local-admin-performance-test-only"
node --test server/tests/admin-performance-optimization.test.js server/tests/page-auth.test.js server/tests/resolution-sidebar-counts.test.js server/tests/report-page-performance.test.js server/tests/operations-staff-api.test.js
```

These tests use fixtures/mocks, not the production database. Close this terminal after testing so these temporary environment variables cannot affect a later application start.

## Deployment smoke checks

Deploy through the existing Railway workflow; no deployment is performed by these code changes. On staging with a separate database, check:

1. Dashboard and inventory controls remain responsive while attendance/charts load.
2. In DevTools Network, initial navigation uses `/api/admin/navigation-summary`. Warranty and resolution reads start later. On the Resolution Center page, its own summary is reused for the badge.
3. Change filters rapidly on orders, projects, maintenance and audit. The last selection wins and canceled requests do not display errors.
4. Open two different order modals, close one, then complete an action. Only the currently open matching order refreshes.
5. Verify a test booking/payment, edit a project and update an order. Refresh the relevant list and check both the persisted result and permissions. Cached summaries must not preserve a pre-write result on the same replica.
6. Payment proof buttons still open details and display the evidence. Compare list response bytes before and after; the compact list must not contain base64 images, signatures or gateway checkout URLs.
7. Order reports render, filter, export and open evidence/chart drilldowns correctly. Expired sessions must not inject a login page into the report.
8. Test two administrators and a secretary/customer: summary caches must not cross identities or grant new access. Authentication still executes for every request.

Use DevTools with browser caching disabled. Record document load time, API duration, payload size and p50/p95 over repeated comparable reads; separate cold and warm reads. Use existing request IDs to match Railway logs. Booking verification logs include `bookingRead`, `bookingSave` and `paymentUpdate` durations in `stages`; navigation summaries include `navigationSummary`. Total request time includes middleware and notification work outside these stages.

## Remaining limits

These are code-level reductions, not a measured capacity or DoS guarantee. The five-second cache is process-local, not shared across Railway replicas; writes or background jobs on another replica can leave informational counts stale until expiry. Required payment, inventory and authorization checks must continue to use uncached authoritative endpoints.

Cold warranty/resolution queries, large report datasets and project health filtering still need profiling with representative staging data. Payment lists retain the existing 1,000-record limit and client-side summaries; server pagination needs a separate aggregate-summary contract before changing that behavior. MongoDB query plans/index availability, network distance, connection-pool waits and Railway CPU/memory cannot be confirmed from source alone. Do not run account-creation bursts on production as an admin performance benchmark.

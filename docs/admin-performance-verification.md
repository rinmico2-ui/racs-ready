# Admin performance changes and verification

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

# Scalability, Concurrency, Security, and Reliability Audit

Date: 2026-09-29

## Scope and method

This audit covers the Express bootstrap and middleware order, authentication,
registration, session storage, booking and order creation, payment persistence,
MongoDB models/index declarations, uploads, email delivery, Socket.IO,
background schedulers, logging, and Render deployment configuration. Findings
below are based on code inspection. They do not claim production throughput or
identify a production crash signature that has not yet been reproduced under
instrumented load.

## Architecture summary

- One Express/Socket.IO Node.js process is started by `server/index.js`.
- One shared Mongoose connection is established before the HTTP listener starts.
- Express sessions use MongoDB through `connect-mongo`.
- Authentication supports a signed JWT cookie with a Mongo-backed session fallback.
- Most business APIs use Mongoose directly from controllers/routes.
- Four in-process schedulers/watchdogs run in the web process.
- Render currently starts one `node server/index.js` process; no instance size,
  health check, worker process, or autoscaling policy is declared.

## Confirmed strengths

1. `User.email` has a unique index and registration converts duplicate-key
   errors into HTTP 409 responses.
2. The application uses one shared Mongoose connection and waits for it before
   accepting HTTP traffic.
3. Product checkout uses a MongoDB transaction, conditional atomic `$inc`
   stock reservations, and a unique `(userId, checkoutRequestId)` idempotency
   index. A losing stock race returns HTTP 409 instead of creating negative
   inventory.
4. Payment submissions have a unique partial index on `clientSubmissionId`.
5. Main booking, order, payment, and assignment models already declare several
   useful compound indexes.
6. Upload routes generally enforce file-count and file-size limits and validate
   image signatures in critical checkout paths.
7. Production 5xx responses are normalized rather than returning stack traces.
8. The process handles SIGINT/SIGTERM and closes HTTP and MongoDB connections.

## Priority 0: observability gap

The reported 50-user crash cannot be attributed to one measured exception yet.
There is no application-wide request ID, active-request count, event-loop lag,
latency histogram, or public readiness endpoint. Request logs contain method,
path, status, and duration but cannot correlate a failing request with database,
email, or audit work. Production root-cause confirmation requires these signals
before a controlled load test.

## Priority 1: confirmed concurrency and exhaustion risks

### Booking request memory amplification

`POST /api/bookings/create-new` accepts a payment image as a base64 JSON field
under a global 10 MB JSON parser. It then stores the same base64 string in both
`BookingService.paymentProof` and `Payment.proofUrl`. Base64 adds roughly 33%
encoding overhead, request parsing creates additional string/object copies, and
multiple concurrent requests retain those objects while database and email work
continues. Fifty near-limit submissions can therefore create hundreds of
megabytes of transient heap pressure and very large MongoDB documents.

Required correction: use bounded multipart upload/direct object storage, store
only a durable URL/storage key, and lower the default JSON body limit.

### Booking check-then-write race

Booking creation calls `assertCompanyCapacity(...)` and later inserts the
booking. Concurrent requests can all observe capacity as available before any
of them writes. There is no capacity lease, unique slot key, conditional counter,
or transaction connecting the final capacity decision to booking insertion.
This can overbook a time window even when every individual request passes
validation.

Required correction: introduce an atomic capacity reservation/lease keyed by
the affected time buckets, reserve it in the same transaction as booking
creation, and release it on cancellation or failed creation.

### Booking has no server idempotency contract

The browser can retry or double-submit booking creation and produce multiple
bookings. The random four-character booking-reference suffix is a display
reference, not an idempotency key.

Required correction: require a bounded client submission ID, enforce a unique
partial `(customerId, clientSubmissionId)` index, and return the original
booking for a repeated key.

### Booking and payment are not atomic

The booking is saved first and the payment record is saved later outside a
transaction. Payment creation errors are logged and swallowed, leaving a
committed booking with no corresponding payment ledger row.

Required correction: save the booking, capacity reservation, maintenance link,
and initial payment in a transaction where the deployment supports transactions.
Non-critical notifications must happen after commit.

### External email remains in request latency

Registration, login OTP, and booking creation await the mail provider. Brevo
has a 15-second timeout and every send also performs an `EmailDeliveryLog`
write. A slow provider retains request objects, sockets, parsed bodies, and DB
documents for up to the external timeout. Booking can await customer and
technician emails sequentially.

Required correction: durable Mongo-backed outbox jobs, bounded worker
concurrency, retry with backoff, and immediate HTTP responses after the local
transaction commits.

### Password hashing saturation

Registration and password changes used the pure-JavaScript `bcryptjs`
implementation at cost 12. Its async implementation yields periodically but
still performs the CPU work on the JavaScript thread. A controlled benchmark
confirmed severe event-loop starvation: at cost 11, 50 simultaneous hashes
took 7.92 seconds with 2.86 seconds P99 event-loop delay; 100 took 16.38 seconds
with 10.11 seconds P99 event-loop delay.

Implemented correction: runtime password hashing now uses native asynchronous
`bcrypt`, with a bounded configurable work factor (default 11), and Render sets
`UV_THREADPOOL_SIZE=16`. Existing bcrypt hashes remain compatible. The same
machine completed 50 native hashes in 1.99 seconds with 38.44 ms P99 event-loop
delay and 100 in 4.31 seconds with 24.79 ms P99 event-loop delay.

### Shared-IP throttles reject legitimate concurrency

The strict login limiter permits 10 requests per 15 minutes per IP, the general
API limiter permits 100 requests per minute per IP, and product checkout permits
12 requests per 10 minutes per IP. Fifty legitimate users behind one NAT can
therefore receive 429 responses. This is rejection rather than a process crash,
but it prevents the required workload.

Required correction: combine a high IP abuse ceiling with tighter per-account
limits, and key authenticated write limits by user ID. Rate-limit state must use
a shared store before horizontal scaling.

### Process-local critical state

Progressive login limits, OTP login records, several caches, chat sessions, and
express-rate-limit counters are held in process memory. Restarts erase them and
multiple instances disagree. Local upload paths and in-process Socket.IO rooms
also prevent correct horizontal scaling without shared/object storage and a
Socket.IO adapter.

### Duplicate authentication reads

`attachCurrentUser` queries `User` for most requests and protected API middleware
queries the same user again. Together with Mongo-backed session access this
creates avoidable database traffic per request.

### Background work runs in every web instance

Schedulers and watchdogs are started by each web process. Horizontal scaling
would run duplicate scans and notifications. The acceptance watchdog performs
additional per-record reads/writes inside a loop, which is an N+1 pattern.

Required correction: use a dedicated worker or distributed lease and replace
per-record loops with bounded/atomic batch operations where possible.

## Priority 2: database and API performance risks

- Mongoose connection pool, server-selection timeout, socket timeout, and wait
  queue timeout are not explicitly sized for the hosting/database tier.
- Several reports load entire 90-day or unbounded collections and aggregate in
  JavaScript. Notable examples exist in `routes/pages.js` and admin rating,
  inventory, warranty, and report paths.
- Some pagination values are passed through `parseInt(limit)` without a local
  maximum; other routes correctly cap them. A shared pagination normalizer is
  needed.
- Hot catalog/config reads have several independent process-local caches with
  no cross-instance invalidation.
- Booking pre-save hooks query customer and technician records even when the
  route already loaded them.
- There are more than 800 direct `console.log/error/warn` call sites. The hot
  booking path emits many lines per request, increasing stdout and log-service
  pressure under concurrency.
- Many queries lack `maxTimeMS`; an expensive query can retain a pool connection
  for an unbounded period.

## Security and resilience findings

- Helmet, trusted-origin enforcement, secure production cookies, role checks,
  and production error normalization are present.
- CSP still permits `unsafe-inline` and `unsafe-eval`; this weakens XSS defense.
- A 10 MB JSON limit is globally available to every JSON API although most
  endpoints need far less.
- The application writes uploaded files to local disk in multiple flows; this
  is ephemeral on Render and is not shared between instances.
- Public health/readiness probes are absent. An admin-only runtime status route
  cannot be used safely by the platform load balancer.
- The Render manifest lacks health-check configuration and does not separate web
  and worker responsibilities.

## Root-cause status

The audit confirms architectural mechanisms that can produce overload or
incorrect behavior at 50 concurrent users, especially base64 receipt memory
amplification, bcrypt queue saturation, synchronous-in-request email waits,
duplicate authentication reads, and booking check-then-write races. The exact
production crash trigger remains **unconfirmed** until request/heap/event-loop
instrumentation and a controlled reproduction capture the failing resource or
exception. Rate-limit 429 responses must not be mislabeled as server crashes.

## Implementation order

1. Add request IDs, bounded operational metrics, `/health`, `/ready`, server
   timeouts, and explicit Mongo pool/timeouts.
2. Remove duplicate auth reads; redesign rate-limit keys and endpoint budgets.
3. Add booking idempotency and atomic booking/payment persistence.
4. Replace base64 booking receipts with bounded file/object storage.
5. Add a durable email outbox and worker.
6. Add an atomic booking-capacity reservation model.
7. Bound remaining list/report queries and move schedulers behind a worker lease.
8. Run isolated and mixed load tests at 10/25/50/100 concurrency, recording
   status distribution, latency, memory, CPU, event-loop lag, and data invariants.

## Implemented remediation status

Items 1 through 6 above are now implemented for the primary registration,
login, booking, and product checkout paths. Booking capacity uses a short-lived
Mongo-backed distributed critical section with a final capacity recheck; the
booking and initial payment commit in one transaction. Receipt uploads use
bounded multipart temporary files and private GridFS storage. Registration and
login email calls enqueue encrypted Mongo-backed outbox jobs. Login OTP state is
hashed in MongoDB rather than process memory. Authenticated API and checkout
limits are keyed by user, while high IP ceilings still constrain floods.

Item 7 remains partial: the audited large report queries and multi-instance
scheduler leadership still require follow-up before unrestricted horizontal
scaling. The HTTP load harness is present for item 8, but mutation scenarios
must run against an isolated test database/deployment, not the configured live
data set.

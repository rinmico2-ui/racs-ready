# DoS and DDoS review

Reviewed: October 1, 2026 (Asia/Manila). Hosting confirmed by the owner: Railway.

## Assessment

The application has useful abuse controls, and this review strengthens them.
It does not establish a measured DDoS capacity or guarantee that legitimate
customers remain available during an attack. Railway's live service settings,
instance resources, replica count, and edge rules were not inspected. Changes
from this review are local and require deployment to affect the hosted website.

Railway documents protection for network attacks at layer 4 and below. Its
application traffic limits may still allow enough requests to overwhelm a
service. [Railway networking limits](https://docs.railway.com/networking/public-networking/specs-and-limits)

## Findings and changes

| Finding | Change |
| --- | --- |
| API limits ran after JSON parsing, session reads and user lookups; rendered pages had no equivalent limit. | A broad HTTP guard now rejects excess dynamic requests before body parsing, sessions, user lookups, and payment webhook parsing. Existing account limits remain. |
| Large JSON proofs could be buffered by many requests at once. | Only four large or chunked JSON/form requests may be active together by default. Auth and chat receive smaller parser budgets. |
| The app lacked an overall request concurrency ceiling. | Active requests have global and per-IP ceilings, with 503 and Retry-After backpressure. |
| Missing public assets could reach database-backed middleware. | Missing/invalid asset requests now fail within static routing. Private uploads still require authentication. |
| Socket.IO transports bypass Express limits and allocated resources before namespace authentication. | Handshakes require a valid signed token before transport allocation. Transport counts are capped globally and per account. The existing database account/session checks still run. |
| Live tracking messages could trigger repeated database writes and broadcasts. | Events are limited across an account's tabs, GPS work has global and per-account concurrency limits, and oversized messages are rejected. |
| Nominatim searches could build an unlimited serialized queue. | Pending provider work is capped, and stale queued work does not start after its admission deadline. Long provider cooldowns are honored without sleeping HTTP requests for minutes. |
| External chat/suggestion work could outlive disconnected clients and accumulate. | Chat, autocomplete, and GPS task slots stay reserved until their actual work settles. There is no unbounded task queue. Chat session storage also has a size cap. |
| Rejected requests could create substantial auth/error logging. | Early rejections update counters without producing one auth log per rejected request. Expected client errors no longer emit stack traces. |
| Distinct account/IP identities could grow the existing in-memory rate-limit stores without a hard cap. | All request limiters now use bounded stores by default. Full stores reject new keys without evicting existing counters; malformed IP values fall back to a stable connection address. |

## Default protection settings

These are process-local safety ceilings, not tested user capacity. Tune them
against normal customer traffic and the Railway instance's memory/CPU limits.
The configurable values are listed in `.env.example`; `.env` was not changed.

| Control | Default |
| --- | --- |
| Broad dynamic HTTP request budget | 1,200/minute per IP or IPv6 subnet |
| Active dynamic HTTP requests | 128 globally, 64 per IP |
| Concurrent large/chunked buffered JSON/form requests | 4 |
| HTTP IP counter capacity | 10,000 identities; full stores reject new identities |
| Other request limiter counter capacity | 10,000 identities per limiter |
| Auth / chat parser budgets | 64 KiB / 256 KiB |
| HTTP headers / full request reception / keep-alive | 10 s / 30 s / 5 s |
| Idle socket timeout / TCP connections / requests per HTTP socket | 120 s / 1,024 / 1,000 |
| Socket.IO transports | 300 globally, 12 per account |
| New Socket.IO handshakes | 60/minute per signed account |
| Socket.IO message size / namespace join deadline | 16 KiB / 10 s |
| Socket.IO events / location messages | 60 / 10 per 10 seconds per account |
| Actual concurrent GPS update tasks | 16 globally, 1 per account |
| Pending Nominatim provider requests | 8; new work must start within its 5 s admission window |
| Concurrent Geoapify autocomplete tasks | 8 |
| Concurrent chat tasks / retained chat sessions | 8 globally, 2 per client / 200 sessions |

MongoDB already has a shared pool (20 connections by default), a 5-second
checkout wait, and bounded network timeouts. Individual query execution limits
remain necessary: pool and HTTP timeouts do not cancel every expensive query.
Node's request timeout limits receiving a request, rather than the duration of
arbitrary route work. [Node HTTP documentation](https://nodejs.org/api/http.html)

The admin system-status response now reports HTTP rejection counts and active
work, plus Socket.IO rejection counts and active GPS updates.

## Validation performed

- 64 targeted security, authentication, scalability, static-delivery, geocoding,
  chatbot, and new traffic-protection tests passed. Another 50 refund,
  attendance, product-return, warranty, and unit-pricing regression tests passed
  after replacing their rate-limit stores (114 tests in total).
- Real HTTP fixtures listened only on 127.0.0.1. They verified early rejection,
  forged forwarding headers on direct connections, IPv6 grouping, global
  backpressure, payload limits, and release/recovery behavior.
- A 100-request local burst used an intentionally small eight-request ceiling
  and simulated 50 ms work. The final run returned 12 successful
  responses and 88 controlled busy responses; peak admitted work was eight.
  The fixture recovered and served its next request. This fixture did not use
  the full application, production instance, or MongoDB.
- Socket.IO HTTP transport fixtures verified rejection of anonymous/forged
  tokens and untrusted origins, plus per-account and global transport ceilings.
- Provider mocks verified that a full geocoding queue returns 503 without
  making another outbound provider call. GPS/task tests verified that pending
  expensive work remains bounded until completion.

No flood was sent to Railway or the configured Atlas database. No accounts,
bookings, orders, payments, or production infrastructure were changed.

## Remaining deployment work

1. Deploy the reviewed code and check Railway CPU, memory, latency, 429/503
   counts, and database pool failures during ordinary traffic.
2. Verify that the application identifies the real client IP through the actual
   Railway forwarding chain. Production defaults to one trusted proxy hop;
   direct development defaults to none. Set `TRUST_PROXY_HOPS` only after
   verifying the chain. Incorrect proxy trust can combine unrelated customers
   into one budget or allow forged identities. [Express proxy guidance](https://expressjs.com/en/guide/behind-proxies/)
3. Before running multiple replicas, use a shared rate-limit store such as
   Redis for account/request counters. Current counters and capacity controls
   are per process and reset on restart. [express-rate-limit stores](https://express-rate-limit.mintlify.app/reference/stores)
4. Keep public assets behind edge caching. Public static delivery and cheap
   health probes bypass the dynamic guard; the app cannot absorb bandwidth
   floods by itself.
5. Review expensive reporting/scheduling queries for execution limits, bounded
   pagination, and cancellation. HTTP client disconnection alone does not stop
   every downstream task.
6. Prepare Railway edge rules and an incident response. Railway exposes Under
   Attack Mode in the service's Settings > Edge section. It challenges browsers
   and blocks non-browser clients, so it can interrupt PayMongo webhook delivery
   on this same service. Verify payment-provider recovery before using it and
   do not assume edge allow rules bypass service-wide attack mode. [Railway production guidance](https://docs.railway.com/guides/lock-down-production-project), [edge rules](https://docs.railway.com/networking/edge-rules)

The focused tests validate the controls above. A separate isolated full-system
capacity test with realistic database and provider behavior is still needed
before publishing a supported concurrency or throughput figure.

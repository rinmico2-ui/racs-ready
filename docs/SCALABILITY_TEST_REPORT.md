# Scalability Validation Report

Date: 2026-09-29

## Tests actually executed

### Password-hashing concurrency benchmark

The benchmark ran on this development machine with identical passwords and a
cost factor of 11. Each level started all hash operations concurrently.

| Implementation | Concurrent hashes | Elapsed | Event-loop P99 | RSS |
|---|---:|---:|---:|---:|
| previous `bcryptjs` | 10 | 2.140 s | 1,016.07 ms | 43 MB |
| previous `bcryptjs` | 25 | 3.993 s | 1,468.01 ms | 47 MB |
| previous `bcryptjs` | 50 | 7.916 s | 2,864.71 ms | 47 MB |
| previous `bcryptjs` | 100 | 16.377 s | 10,108.27 ms | 46 MB |
| native async `bcrypt` | 10 | 0.604 s | 23.90 ms | not recorded |
| native async `bcrypt` | 25 | 1.552 s | 43.09 ms | not recorded |
| native async `bcrypt` | 50 | 1.990 s | 38.44 ms | not recorded |
| native async `bcrypt` | 100 | 4.305 s | 24.79 ms | 39 MB |

This validates removal of a confirmed registration/login event-loop bottleneck;
it is not a substitute for end-to-end HTTP and database testing.

### Automated regression and invariant tests

- Focused scalability/auth/booking/order suite: 55 passed, 0 failed.
- Repository-wide suite was executed. It still contains unrelated existing UI
  assertion failures (including admin modal, chatbot intent, stale-selection,
  and walk-in view expectations). The focused paths changed by this refactor
  passed.
- Syntax validation and `git diff --check` passed for the changed runtime files.

## End-to-end load status

The required registration, login, booking, ordering, and mixed HTTP mutation
tests have **not** been run against the configured remote database. Running
those tests would create accounts, bookings, payments, and orders and therefore
requires an isolated test database plus seeded service/product/technician data.
No throughput or error-rate claim is made for those workflows yet.

The reusable harness is `server/load/http-concurrency.js` (`npm run load:http`).
It supports 10/25/50/100 levels, unique request templates, expected-status
checking, P50/P95/P99 latency, throughput, client event-loop lag, and RSS delta.

## Data invariants to verify in the isolated run

- Duplicate registration email returns 409 and creates one user.
- Repeated booking submission ID returns one booking and one payment.
- Same-slot bookings never exceed effective technician capacity.
- Competing orders never produce negative inventory or oversell stock.
- No unexpected 5xx, pool checkout failure, or unhandled rejection occurs.
- 429 responses occur only at the documented per-account/abuse thresholds.

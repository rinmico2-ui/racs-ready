# Architecture and model audit findings

Audited **09 October 2026** against the current working tree. Findings are documented for review; application behavior was not changed. Severity describes the consequence if the stated trigger occurs. No production exploit or live data defect is claimed.

## Confirmed findings

| ID | Priority | Finding and source | Consequence / follow-up |
| --- | --- | --- | --- |
| A01 | High | [server/index.js:135](../../server/index.js#L135) bootstraps an administrator whenever `adminCount === 0`; it uses a built-in password fallback when `ADMIN_PASSWORD` is absent, and can promote/reactivate an existing matching email account. | A fresh or administratively emptied database can acquire a predictable privileged credential. Require explicit bootstrap credentials and a deliberate one-time bootstrap action; avoid silently elevating/resetting an existing account. Whether this trigger exists in production is unverified. |
| A02 | High | [paymentController.js:394](../../server/controllers/paymentController.js#L394) catches webhook processing errors at the end and only logs them. [paymongoRoutes.js:54](../../server/routes/paymongoRoutes.js#L54) then returns HTTP 200 after awaiting that handler. | A database/save failure can be acknowledged as successfully processed, preventing retry through this response path. Propagate failures or durably enqueue verified events before acknowledging. Add failure/retry coverage. |
| A03 | Medium | [Purchase.js:11](../../server/models/Purchase.js#L11) declares `items.productId` with `ref: "Product"`. Loading every model registers no `Product` target. | Populating this legacy reference can fail with an unregistered model error. Decide whether this record should reference Inventory/HVACProduct or retain a historical snapshot without population; migrate deliberately. Snapshot names/prices still exist. |
| A04 | Medium | [Payment.js:12](../../server/models/Payment.js#L12) requires a numeric `amount` but has no `min` or nonnegative validator. A schema-only construction with `amount: -1` and `method: 'cash'` passed validation. | The schema boundary accepts a negative payment. Route/policy checks may reject particular requests, so public exploitability is not established. Define permitted adjustments explicitly and enforce the intended amount invariant at every write boundary. |
| A05 | Medium | [Payment.js:29](../../server/models/Payment.js#L29) allows `method: 'card'` or `'cash'`, while `gateway` excludes both. Schema-only `method: 'card', gateway: 'card'` fails validation. [orderCheckoutWrite.js](../../server/utils/orderCheckoutWrite.js) derives gateway from a normalized method. | Method and gateway describe different concepts, but helper writers that copy method into gateway are fragile. Audit all payment constructors and standardize mapping. This is a confirmed enum mismatch; a currently enabled failing customer checkout was not reproduced. |
| A06 | Medium | [googleCalendarSync.js:57](../../server/utils/googleCalendarSync.js#L57) builds booking times with host-local `setHours`. Reminder code in [server/index.js:1013](../../server/index.js#L1013) also uses host-local dates. Other scheduling paths use [bookingDateTime.js](../../server/utils/bookingDateTime.js), which explicitly handles Manila dates. | A non-Manila host timezone can change calendar/reminder instants. Consolidate date-only/time-slot conversion through the shared timezone-aware functions and test a UTC host. Existing timezone-aware code is present; the remaining paths need separate checks. |
| A07 | Medium | [LeaveRequest.js](../../server/models/LeaveRequest.js) declares no secondary index. [availability.js:51](../../server/utils/availability.js#L51) queries technician, approved status and leave date intervals; its bulk path also filters approved intervals. | Availability calculation can scan an increasing leave collection. Evaluate compound indexes against actual query plans and production selectivity before adding them. Live index presence and query performance were not measured. |
| A08 | Medium | [productImageStorage.js](../../server/utils/productImageStorage.js) falls back to `/uploads/hvac/...` when Cloudinary is not configured. Other legacy/local upload paths remain. [render.yaml](../../render.yaml) declares no persistent disk. | The checked-in deployment does not establish durability for local fallback/legacy files across replacement of the service filesystem. Configure external storage or verified persistent storage and migrate historical files. GridFS evidence and Cloudinary images already address newer paths. |
| A09 | Medium | [operationLock.js:22](../../server/utils/operationLock.js#L22) uses a finite lease and deletes it conditionally by owner after work; no lease renewal/fencing mechanism is implemented. | Work that outlives the lease can overlap a replacement owner. Bound protected work below its lease, renew ownership conditionally, or add fencing where concurrent writes matter. A live overlapping-write failure was not reproduced. |
| A10 | Medium | [server/index.js:207](../../server/index.js#L207) includes `'unsafe-inline'` and `'unsafe-eval'` in script CSP. | CSP offers reduced containment for injected script. Migrate inline/evaluated code before tightening policy using nonces/hashes and permitted resource origins. This finding does not establish an XSS injection point. |
| A11 | Medium | [emailOutbox.js:71](../../server/utils/emailOutbox.js#L71) atomically claims jobs with a stale-lock timeout. Delivery precedes the persisted sent result; completion updates match ID/status without a claim-owner token. | Delivery is at-least-once after crash/retry, and unusually long delivery can overlap a reclaimed lease. Use provider idempotency where available and owner-bound completion/renewal. Encryption, retries and atomic claiming are existing safeguards. |
| A12 | Maintenance | Domain routes/templates contain large implementations: technician assignments template about 18,559 lines, services.js about 16,394, services-multi.js about 15,350, technicianApi.js about 11,959, adminApi.js about 10,216. | Change impact and duplication are difficult to review. Extract bounded domain/presentation units incrementally with behavior-focused regression coverage; these sizes are measured architecture concerns, not proof of incorrect behavior. |

Source line numbers correspond to this working tree and may shift. `#L` fragments are conventional source references; local browser viewers may not scroll plain source files to them.

## Runtime/deployment limitations to resolve before replication

- Socket.IO rooms use the default process-local adapter. No shared adapter is configured; a browser connected to one replica will not automatically receive another replica's broadcasts.
- Rate/admission budgets, report/provider caches and chat histories are bounded in-memory structures. Replicas have independent counters and state; restarts clear them.
- Timers run in the web service. Some flows already use Mongo-backed leases or atomic reminder fields; each job still needs a multi-replica ownership/deduplication check before assuming safe horizontal scaling.
- Transactions are used beyond checkout/submission. The standalone compensation implemented in `bookingSubmissionWrite` and `orderCheckoutWrite` is not a general fallback for every cancellation/refund route.
- `BookingService` has dynamic references. Its service-model enum is CoreService/RepairService; the history actor-model enum also permits `System`, which is not a registered Mongoose model. A non-null history actor populated as `System` would need special handling. No such stored record was inspected.
- Numeric money fields use JavaScript/Mongoose Number. Precision/rounding correctness depends on policy helpers and route writes; live ledger reconciliation was not performed.

## Existing controls verified in source

The application has fail-fast JWT configuration, production MongoDB TLS checks, shared connection pooling, readiness/liveness endpoints, HTTP admission control, bounded rate/work limiters, secure/HTTP-only cookie settings, account-state checks, role/permission checks, origin protection, private evidence access controls, signature-based image validation and raw-body PayMongo signature checks. Socket events bind technician identity and scope customer GPS publication to an owned booking. The email outbox encrypts queued payloads with authenticated encryption. Checkout/submission implement conditional writes, idempotency identifiers and transaction/compensation handling.

These controls establish architecture boundaries in code. They do not certify coverage of every endpoint, penetration-test results or production configuration.

## Test baseline

Command: `node server/tests/run-all.js`

**1,117 tests: 1,105 passed, 12 failed, 0 cancelled, 0 skipped.** Run duration reported by Node: approximately 33 seconds. Test log: `temp/architecture-audit-tests.log` (local, ignored). [test-results.json](test-results.json) retains the concise result and failing-test names.

| Test source | Failure |
| --- | --- |
| booking-history-regression.test.js:21 | Booking-history rows expose only View Details and keep operations in the modal; expected source marker `project-date-guide-v12` absent |
| booking-history-regression.test.js:123 | Edit-booking repair fields guide focus to the next step; same source-marker assertion |
| chat-intent.test.js:16 | Whole-phrase intent detection produces an unexpected result |
| customer-slot-validity.test.js:36 | Stale-selection guidance text does not match the assertion |
| operations-list-policy.test.js:91 | Deferred-evidence endpoint source/comment assertion does not match |
| payment-option-presentation.test.js:152 | Order-total source-expression assertion does not match |
| resolution-center.test.js:42 | Expected slot-query function/source pattern does not match |
| services-booking-draft.test.js:42 | Expected restore-step source expression does not match |
| services-review-fees.test.js:63 | Repair-only review VM harness raises `ReferenceError: currentBookingReward is not defined` |
| services-review-fees.test.js:82 | Mixed-booking review raises the same VM harness error |
| services-review-fees.test.js:96 | Zero-travel/escaped-details review raises the same VM harness error |
| walk-in-aircon.test.js:91 | POS template still contains the aircon-tab pattern prohibited by the assertion |

Several failures assert source text or execute extracted functions in incomplete VM contexts. They require triage to distinguish stale tests from actual workflow defects. The VM errors alone do not demonstrate that the browser page is missing `currentBookingReward`. Failures were observed in the existing working tree and were not caused by changes to application code in this documentation task.

## Corrections to historical architecture descriptions

The older architecture material counted 43 models, placed EJS rendering in a client container, described a native technician mobile app / isolated microservice-like containers, overstated tenancy, simplified email to SMTP, and showed evidence only as local files. The current deliverables use 63 models, server-side EJS, four browser roles, one web process, Brevo/SMTP with Mongo outbox, GridFS proofs and Cloudinary with local fallback.

The old claim that product stock always moves through `StockReservation` is inaccurate for the current checkout implementation. That model reserves Tool stock for service work; product checkout conditionally decrements Inventory/HVACProduct variant stock. Online card helper code is retained, but the public checkout-session route explicitly returns HTTP 410.

## Not verified

Live records, actual MongoDB indexes/query plans, orphaned references, production authorization behavior, backup/restore operation, database replica-set/transaction capability, hosting replicas/disks, provider credentials/availability, package advisory vulnerabilities, browser end-to-end workflows and production performance were not audited. No migrations, account changes, business-record writes or application fixes were made.

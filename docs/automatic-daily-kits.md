# Automatic Daily Kit generation

Daily Kits now generate in the background, independently of the technician opening Daily Preparation. The worker starts after MongoDB is ready and runs again one minute after each completed sweep.

## Work covered

The worker prepares today and the next 60 Philippine calendar days:

- Accepted service/repair assignments and visits already en route, on site, or in progress.
- Accepted delivery-and-installation orders and installations already in progress.
- Confirmed project daily schedules with `planningOnly` disabled.

Pending technician acceptance, pickup-only orders, and project planning drafts do not create packing requirements. Existing kits in this date range are refreshed too, so cancellation, reassignment, and rescheduling remove obsolete demand from the old technician/day. Already-issued equipment and material custody remain recorded. A cancellation between discovery and generation does not create a new empty kit.

## Generation and physical checkout

Automatic generation creates or refreshes the draft requirements using the existing service rules, approved Phase 2 repair quotations, order installation preparation, and project allocation calculations. It preserves valid physical checkbox selections and manual extras under the existing rules.

Technicians still review and confirm their kit on the work date. Generation alone does not deduct stock, issue equipment, or mark a draft confirmed. Additional work after confirmation uses the existing delta/review flow.

The technician endpoint retains an immediate refresh as a fallback for changes arriving between sweeps. The page is no longer the only trigger for generation.

## Reliability

- Technician/day targets are deduplicated in MongoDB and streamed in small batches.
- One kit transaction runs at a time per worker. A database lease protects the automatic refresh of each technician/day across application instances.
- The successful automatic refresh time is committed with the kit. Another instance checks that timestamp under the lease before repeating the same refresh.
- Failed kits retry on the next sweep without preventing other technicians' kits from generating. Database discovery failures also retry; disconnected databases are skipped.
- Shutdown stops new work, waits for the active transaction, and closes the discovery cursor before MongoDB disconnects.

## Verification

Regression coverage checks startup generation without a page request, Philippine date boundaries, source status filters, project planning exclusions, refresh coalescing, multi-instance checks, retries, shutdown, future draft creation, rescheduling cleanup, physical-check preservation, transaction rollback, and no automatic stock issue.

Validation: the full suite passed **1,975 tests across 272 files**, with zero failures. The targeted scheduler, checkout-safety, and installation preparation checks passed **83 tests**. JavaScript syntax and Git whitespace checks passed.

A read-only database check successfully executed target discovery against the existing schedules. Verification did not start background workers against the live catalog or change live kits/stock.

Restart or redeploy the backend to activate the scheduler. No `.env` changes or data migration are required.

# Booking overview after resolving a case

## Current behavior: booking and order outcomes stay consistent

A booking that still needs a date or technician remains actionable. A saved
review note cannot make that booking ready, cancel it or complete it. Closing
an already cancelled booking's review remains supported.

- Close case is unavailable for unfinished schedule, assignment, no-show or
  customer-confirmation issues. The API rejects attempts with HTTP 409 and
  `BOOKING_OUTCOME_REQUIRED` before saving history or auditing a decision.
- Legacy Close case notes are retained. If the booking still needs an outcome,
  the Resolution Center includes it and the overview/detail show New schedule
  needed and Review saved, with a Resolve action. They do not show Case closed.
- Staff can send the customer a schedule link, select an available schedule,
  cancel with payment/refund review, or reassign where eligible. Only an actual
  applicable outcome clears the scheduling problem.
- A genuine closed review on a finished/cancelled booking shows Case closed
  alongside the booking's actual status.
- Current technician display requires a current technician ID and excludes
  cancelled assignments and bookings awaiting a replacement schedule. Old
  technician snapshots remain available in history and are not presented as
  current assignments. An old accepted assignment cannot make an unfinished
  service item look accepted after the booking requires a new schedule.
- List, detail and queue share the scheduling-outcome predicate. The schedule
  dialog retains the selected issue type rather than always using past_date.

Validation: 98 relevant checks passed, including legacy dismissed bookings,
guards for both staff roles, cancelled-review closure, current technician display,
API/modal consistency, links, queue counts, scheduling and loading locks. No
existing booking or payment was changed during this code fix. Changes are local.

## Earlier display fixes (superseded where they allowed note-only dismissal)

The overview previously inferred its Resolve button and Needs Resolution badge
from the old schedule alone. Its compact list response omitted saved resolution
decisions, even though the Resolution Center used those decisions to hide closed
cases. Returning with browser Back could also restore stale rows from the browser
page cache.

The booking list now returns `overviewScheduleResolution`, calculated from the
saved schedule and case decisions. The overview uses that result rather than
reopening a closed case from an old date. The Resolution Center and overview
share the predicate that recognizes a closed/rescheduled/reassigned issue for
the same booking status. Closing a schedule issue changes this presentation;
it does not mark the underlying booking completed or invent a new date.
Other open issues on an overdue visit, including a missing technician or pending
schedule confirmation, remain visible.

The overview refreshes its rows, statistics and resolution count when the browser
restores the page or the user returns to its tab. The refresh keeps pagination,
search and filters, coalesces overlapping browser events, skips hidden/inactive
overview pages and requests fresh responses. Statistics and list results still
render independently, so unavailable statistics do not clear current rows.
Admin and secretary share the page and booking-list implementation.

The original display fix did not change booking or payment workflows.
Validation: 84 relevant tests passed, including actual
compact API responses, row rendering, closed/open issue distinctions, browser
return refresh, preserved filters and statistics failure isolation. The EJS
template compiles and its two inline scripts parse.

## Follow-up: reviewed and cancelled booking statuses

The overview and details previously replaced the booking status with Needs
Resolution. They now keep the booking status visible and show the remaining
schedule issue separately. A pending booking whose payment has already been
verified displays Payment verified. Reviewing an overdue payment still does not
approve the old date or move it into assignment; staff must resolve its schedule.
Cancelled bookings suppress stale schedule flags and Resolve actions, and their
unfinished service items display Cancelled even for older records.

The Resolution Center cancellation endpoint now uses the shared cancellation
rules to update unfinished service items, cancellation metadata and history.
Its assignment note previously supplied a string to an array of note objects;
the cast failure was swallowed. It now appends a valid note and updates the
assignment, booking and any refund request in one transaction. Failed writes
roll back all of these changes. Audit and customer notification run after commit;
the customer notification import path has also been corrected.

A requested refund remains pending until the separate Complete refund action.
Cancellation no longer marks a queued refund as money already returned. Requests
to refund unverified payments are rejected. Finished visits cannot be cancelled.

Validation: 160 relevant checks passed across booking overview, payment review,
cancellation, refund summaries, maintenance cancellation, Resolution Center
loading, scheduling and shared admin/secretary flows. Tests execute the real
route handler with isolated models and cover write failures and rollback.
The EJS template and inline scripts parse. No live records were changed or
customer notifications sent during verification. Changes remain local.

## Close case in booking details

The user confirmed the affected records were bookings reviewed with Close case.
The detail endpoint returned review and assignment timing but omitted
`overviewScheduleResolution`. The popup therefore fell back to checking the
old date and reopened an already reviewed issue in its display.

The detail endpoint now returns the same saved-case calculation as the compact
list. The overview and details show Case closed (or the number of distinct closed
issues) alongside the current booking status. Reviews from an older booking stage
do not mark the current stage closed. Another unreviewed issue can still offer
Resolve. The Close case confirmation states that the booking keeps its status.

Validation: 62 focused checks passed. A new regression executes the real Close
case handler followed by both list and full/modal detail reads for admin and
secretary, proving the popup respects the saved decision without changing the
booking lifecycle. No live records were changed.

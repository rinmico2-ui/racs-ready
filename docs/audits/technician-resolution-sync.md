# Technician work after admin resolution

The October 12 example was reproduced with read-only database queries. All
three `RACS-20261012-TEST0*` source bookings were cancelled, while their
assignment snapshots remained accepted. The 22:50 visit remained assigned.

The technician assignment list, pagination totals, KPI scope, sidebar counts,
calendar and dashboard now validate assignments against the current booking
before querying visible work. Cancelled, archived, superseded, reassigned and
rescheduled active snapshots are excluded. Completed and properly cancelled
assignment history remains available. Mixed service-item and repair follow-up
schedules use their own ownership and visit date. Order installation bookings
appear in the Orders workspace rather than twice across both workspaces.

Assignment detail marks unavailable work, and status actions check the source
booking before toolkit or status writes. Acceptance applies the same check
inside its existing transaction. Daily Kit generation applies the same current
work decision, so stale visits cannot add generated requirements.

Admin resolution cancellation and rescheduling retire all unfinished assignment
attempts within the existing transaction, including attempts whose main
assignment reference was lost. Completed attempts are preserved. Case review,
reassignment, cancellation and rescheduling publish booking updates to the
affected old/new technician rooms and their account rooms after saving. Staff
order rescheduling now sends its existing order status event as well as
customer rescheduling.

Both technician pages use shared refresh handling for booking/order events,
reconnection, browser focus and visibility. Events are debounced, requests do
not overlap, and action dialogs finish before refreshing. Visible tabs refresh
every minute to recover missed events. Assignment list refreshes preserve
filters and avoid clearing existing cards while loading. Open obsolete job
details close with an explanation.

The actual work-scope service was verified against the configured database on
an isolated connection with collection/index creation disabled: four active
assignment snapshots became one valid visit, excluding the three cancelled
bookings. No live bookings, assignments, payments or stock were changed by
the diagnostic or tests. Checks cover source-state decisions, ownership,
schedule changes, list/count agreement, stale action rejection, transaction
rollback, private update recipients, order schedule events, browser refresh
coalescing and template/script syntax.

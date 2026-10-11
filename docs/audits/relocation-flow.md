# Relocation flow audit

Date: 2026-10-11

Result: the customer, staff and technician flows are connected, but relocation is not fully reliable yet. This is an audit of the local implementation, not a successful production run. The supplied work-order URL could not be inspected with a signed-in technician session. No production records, payments, assignments or settings were changed.

## Current process

| Step | Current behavior |
| --- | --- |
| Customer chooses relocation | A move within the same property uses the normal service price and checkout. A move to another property creates a quote request with both locations and a preferred date. The preferred date does not reserve a time slot. |
| Admin or secretary reviews | Staff can request a site check or send an itemized quote with verified unit details and estimated work time. Quote decisions are customer-owned, version checked and expiry checked. |
| Customer accepts and books | Accepting a quote does not create an assignment. The customer continues to Services, chooses a schedule and submits any payment required by the booking policy. Checkout rechecks the accepted quote and uses its price and duration. Quoted relocation does not receive another automatic travel fee. |
| Booking is saved | Booking and payment persistence claims the accepted quote and links its request to the booking. The request becomes `converted`, displayed as “Booking submitted”. |
| Staff assigns the visit | Relocation uses the existing core-service assignment workflow. There is also an individual service-item assignment endpoint, which makes item ownership relevant to the checklist and completion routes. |
| Technician accepts and prepares | The common acceptance workflow saves the assignment and booking together. Departure uses Daily Preparation. Arrival and starting work require photos. |
| Technician records the move | The work-order page records Removal, Transport, Installation and Testing. Later stages require earlier stages to be checked. It contains 17 tasks. Job acceptance, travel, starting work, payment collection and final proof take place in Assignments, not on this checklist page. |
| Technician completes | The completion-proof endpoint checks relocation tasks and applicable balance collection, stores proof, then commits assignment and booking completion. |
| Customer follows progress | The common booking status updates feed My bookings and My schedules. The relocation request page keeps its separate quote/booking-submission status until completion; it does not currently show the four checklist stages. |
| Aftercare | Completion updates a linked saved aircon's destination address and service history, or creates an aircon record when no existing asset was selected. Maintenance schedules are created according to the aftercare policy. |

## Confirmed issues

### 1. Checklist access is checked against the booking, not the assigned service item — high priority

`server/routes/technicianApi.js:212` and `:231` accept any qualifying assignment for the booking. The GET route returns every relocation item; the POST route does not check `assignment.serviceItemId`, `item.technicianId` or `item.assignmentId`.

A read-only probe ran both actual handlers with an in-progress cleaning assignment and a relocation item belonging to a different technician. Reading the relocation checklist and recording a task both succeeded. A technician should only see and update relocation items within their own assignment.

### 2. Booking submission accepts prefilled technician progress — high priority

`server/routes/bookingRoutesNew.js:392` normalizes customer-submitted relocation details but does not discard `completedTasks` or `taskEvents`. At `:564`, the full relocation object is copied into the saved service item. The booking schema permits both fields.

A probe of the actual normalization block confirmed that all 17 submitted completed tasks and a technician task event survive. This undermines the completion checklist gate. New customer bookings must start with empty technician progress; only technician task endpoints should add that progress.

### 3. Cancelling the booking does not update its quote request — high priority

The request is changed from accepted to converted in `server/utils/bookingSubmissionWrite.js:50`, and from converted to completed in `server/utils/maintenanceLifecycle.js:207`. The booking cancellation paths do not change the linked relocation request to cancelled.

Consequently, a cancelled booking can still appear as “Booking submitted” in the customer request list and in the staff booked count. Cancellation and rejection should update the linked request without reopening a used quote automatically or bypassing refund decisions.

### 4. A move within the same property loses the map pin for aftercare — high priority

At `server/routes/bookingRoutesNew.js:403`, same-property origin and destination are saved with address and position details but no coordinates. `server/utils/maintenanceLifecycle.js:78` prefers the destination object over the pinned booking location. The linked-aircon update and `server/utils/maintenanceLocation.js` recovery use the same destination preference.

The normalization probe confirmed that a booking with a valid map pin produces a destination without that pin. Later maintenance can therefore ask the customer to choose the same location again. Same-property moves should retain the original property pin; moves to another property must use the new property's pin.

### 5. Checklist writes can continue on a cancelled booking — medium priority

`server/routes/technicianApi.js:244` blocks only a parent booking whose status is completed. If an assignment still says in progress during cancellation or after a partial cancellation failure, the task endpoint permits writes on a cancelled booking. Its update filter also does not recheck parent status or assignment ownership.

A probe of the actual task handler with a cancelled parent and an in-progress assignment returned success and attempted a task write. Terminal booking states and assignment ownership need to be checked during the write.

### 6. Completion checks every relocation item, then completes the entire parent — high priority for bookings split between technicians

`server/routes/technicianApi.js:6242` checks every relocation item in the booking, including work assigned to other technicians. At `:6324`, non-repair proof submission sets the entire booking to completed without checking whether other service items are finished.

This can block a technician behind another technician's unfinished relocation, or complete a parent booking while other non-relocation services are still unfinished. The completion operation needs to complete the owned item or shared visit and derive the parent state from all remaining work. This finding is based on source inspection; the multipart completion route was not executed against production.

### 7. Checklist assignment selection and refresh can give stale results — medium priority

The work-order GET uses `Assignment.findOne` without distinguishing an old completed assignment from the current active assignment. The browser script loads on page entry and after checking a task, but has no manual refresh, focus refresh or live status listener. A stale page can therefore show disabled controls after the job starts, or remain editable after cancellation until the next server request rejects it.

Select the current applicable assignment explicitly, and refresh when returning to the page or receiving an assignment/booking update. Keep server checks authoritative.

## Validation

- Ran eight existing test files covering relocation, booking persistence, customer aftercare, repeat-payment labels, technician acceptance, technician integrity, maintenance technician workflows and customer/staff UI.
- Result: **75 checks, 74 passed, 1 failed**.
- The failure is an outdated source-text assertion in `server/tests/relocation-workflow.test.js:13`: it expects a literal HTML unknown-brand option. The implementation now creates that option using `select.add(new Option(...))`. This failure does not by itself establish that customer quote submission is broken.
- Five additional read-only probes confirmed wrong-item checklist read access, wrong-item task writes, cancelled-booking task writes, customer-supplied completed-task preservation, and the same-property lost pin.
- The probes used local source with model doubles and normalization functions. They opened no database connection and sent no mail.
- Application code was not changed in this audit. Passing existing tests does not cover the issues identified above or prove that the supplied deployed booking works.

## Recommended order of repair

1. Remove customer-supplied technician progress and enforce service-item assignment ownership.
2. Make completion respect individual service items and parent booking state.
3. Keep relocation request status aligned with booking cancellation/rejection/completion.
4. Preserve the correct destination pin through completion and aftercare.
5. Select the current assignment, add safe page refresh, and replace the outdated test assertion with a behavior test.

## Follow-up: work-order page server error

The customer later reported an internal server error when opening the technician work-order URL. Rendering the page together with its actual technician layout reproduced `ReferenceError: technician is not defined` at `server/views/layouts/technician.ejs:213`.

The relocation page route omitted the technician local supplied by other technician pages. The route now loads the signed-in technician and supplies `technician: tech || {}`. The layout also checks whether that local exists before rendering the socket-room join. Database lookup errors go to the existing page error handler.

Six new regression checks execute the actual page handler and render the full EJS page and layout, including missing/null technician data and lookup failures. Those checks and the existing technician calendar/integrity checks passed: **15 passed, 0 failed**. This fixes the locally reproduced page-render failure; the other workflow findings above remain open. The deployed page has not been verified after this change.

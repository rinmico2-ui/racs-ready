# Large aircon purchases

Large installation purchases now use a preferred date range and create linked project planning records. The current limit is 40 units per checkout, subject to stock. Installation orders with at least 8 units, or work exceeding the configured project-hours threshold, enter Projects. Pickup orders retain the store pickup workflow.

Customers choose a preferred start and finish-by date. Capacity is checked again when the order is saved, using the same distributed project reservation lock as service bookings. Staff confirms the final daily plan; the preferred range is not a promised single-day appointment. Unconfirmed windows can be changed through customer requests and staff review. Confirmed plans use the existing Operations schedule-recovery workflow.

Staff workflow: verify the purchase payment and confirm physical unit preparation in Aircon Orders, then open the linked installation project. Approve the project, assign the crew, review materials, create work-order batches, generate the daily schedule, obtain team acceptance, and confirm the plan. The single-technician order workflow is blocked for these purchases.

Technicians use Large-Scale Projects and daily preparation. Each completed unit needs the existing proof-backed work submission and lead review. At handover, the lead records every purchased unit's serial number and collects any remaining purchase balance. Purchase completion, warranty and maintenance records use that handover. Product revenue and payments remain on the purchase; included installation does not create a second charge. Cancelling an unconfirmed project purchase cancels its planning records and uses the existing stock/refund transaction. Confirmed or active projects require an Operations review before stock can be returned.

## Investigation and plan

The original cart accepted up to 40 units, but online installation checkout blocked 8 or more units (and jobs exceeding the configured project hours). Its single-date calendar could not fulfill that workload. The existing Projects workflow supports crews, daily capacity, work-order batches, individual unit progress, proof submissions, material planning, and schedule recovery.

Connect large purchases to that workflow rather than introducing a second project system:

1. Keep the responsive checkout modal. For installation projects, collect a preferred start date and finish-by date instead of promising a single appointment time. Check aggregate technician capacity, holidays, leave, and other reservations. Explain that Operations confirms the daily plan.
2. Derive the project decision, workload, inventory quantities, price, and payment amounts on the server. Keep the current 40-unit limit and ordinary pickup/small-order flows.
3. Persist the purchase, stock reservation, payment, installation booking, and linked project together. Retain retry protection and compensate failed writes on standalone MongoDB.
4. Keep payment and product revenue attached to the purchase. Project planning and included installation must not create a second customer charge. Require payment review and physical unit preparation before execution.
5. Give staff a project planning action instead of the single-technician assignment action. Give the project crew the purchased model/HP, unit scope, daily work plan, and proof-backed completion workflow.
6. Keep order tracking, project completion, cancellation, and final payment consistent. Validate with regression tests and isolated customer, staff, and technician browser checks.

Capacity forecasts use the existing preliminary estimate of 60 minutes per installation unit. Staff must review site complexity, crew size, materials, and daily work hours before confirming the actual plan. A purchase is for one service address; separate sites require separate orders.

## Validation

Twelve new regression tests cover project classification, strict date ranges, trusted capacity estimates, linked purchase/booking/project creation, compensation after failed planning writes, payment and preparation gates, serial numbers, prepaid handover/warranty, confirmed crew state, ownership, and protection of confirmed schedules. Full suite: 1,998 passed, 0 failed.

Isolated browser checks passed complete 10- and 40-unit installation checkout flows at 1440, 390, and 320 pixels, including failed capacity-check recovery. Admin and secretary project links, customer date-range reschedule requests, and technician handover of all 40 serial numbers also passed. Fixtures used mocked accounts and orders; no live purchases or payments were created.

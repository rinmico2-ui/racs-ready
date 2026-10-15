# Unfinished visits and project rescheduling

For a standard service booking or ordinary installation order that has already started, the technician can select **Continue on another visit**. They must record a reason, the remaining work, and an estimated visit duration. This closes the current visit for scheduling purposes; it preserves completed service items, prices, payments, and the visit history.

Staff see **Unfinished work** under the active Bookings or Orders tab. Select **Schedule next visit**, choose a technician and date, and check availability. The server checks the selected slot again when saving. A replacement technician must accept the assignment. A scheduled continuation returns to preparation and requires its Daily Kit before departure. It does not create a second charge.

For large projects, **Complete Today's Work** closes today's committed daily allocations without adding completed appliances. **Confirm Next Workday** refers to the next committed allocation date. Unfinished appliances missing from the remaining schedule require an Operations review through **Recovery Plan**. A crew decline keeps departure blocked until Operations reviews and approves the plan, after which the scheduled crew must confirm again. Equipment shared with another active job remains protected from premature returns.

In project details, **Schedule Dates** now displays technician availability before saving a preferred window. The calendar considers working hours, rest dates, approved leave, holidays, customer bookings, travel time, and other committed project allocations. A preferred window still requires generating and confirming the daily work plan. Approved projects use **Recovery Plan**, which also displays availability and requires the existing schedule approval check.

Saving a changed preferred window, or approving a recovery/extension, requests an in-app customer notification and an email. Notification failures are reported separately from a successful save; **Notify** retries a project update containing the current dates. Email requests enter the existing mail delivery workflow.

Completion payment checks apply to all payment methods, including partial GCash, Maya, card, and bank-transfer walk-ins. Received payments and refunds in the payment ledger determine the remaining balance when ledger records exist.

Validation uses isolated model fixtures and browser fixtures. It does not submit bookings, change schedules, or send customer email against the live database.

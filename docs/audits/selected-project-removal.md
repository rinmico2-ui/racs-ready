# Requested removal of ten large-scale projects

Status: applied on October 12, 2026 after the user explicitly approved the full
removal, including the linked booking/work-order cancellations and stock
reservation releases.

The read-only database check matched every project in the supplied list:

| Customer | Service | Units | Hours | Approved completion in Philippine time |
| --- | --- | ---: | ---: | --- |
| Joshua Javier | Dismantling & Reinstall | 40 | 115.6 | October 27, 2026 |
| testET test | Aircon Installation, Aircon Installation | 40 | 80.0 | October 11, 2026 |
| Joshua Javier | Aircon Installation | 40 | 99.5 | October 18, 2026 |
| Joshua Javier | Aircon Installation | 40 | 236.5 | October 20, 2026 |
| Joshua Javier | Aircon Cleaning | 40 | 41.0 | October 24, 2026 |
| Joshua Javier | Aircon Installation | 40 | 189.5 | October 22, 2026 |
| Joshua Javier | Aircon Installation | 40 | 189.5 | October 22, 2026 |
| Joshua Javier | Aircon Installation | 40 | 108.3 | October 13, 2026 |
| testET test | Aircon Installation | 40 | 101.8 | October 2, 2026 |
| testET test | Aircon Installation | 11 | 16.5 | September 7, 2026 |

The prepared cleanup targets ten explicit IDs and checks names, services,
units, hours and approved dates before changing anything. It retains the
project records as archived/cancelled history, cancels nine existing linked
bookings and three unfinished work orders, and releases eight uncollected
material reservations. Two collected-material records and all payment records
remain. The 11-unit project's original booking is already missing; this
cleanup does not create a replacement booking. No linked aircon orders or
equipment-assignment records were found. Payments are currently pending.

A private EJSON recovery backup in the ignored `temp` directory is written
before the transaction. Changed payment states, started work, mismatched
project identities or database errors stop the cleanup. It does not send
customer emails. Stock counters are decremented only for the affected original
reservations when the counter is sufficient, preserving other kit reservations.
Insufficient/missing counters are reported for review instead of guessed.

Project list queries and dashboard counts exclude archived projects, while
individual records remain available by ID. The local query changes require
the updated application code to be running to hide the archived records.

Validation: six archive checks, six schedule-health tests and six schedule
recovery tests passed. The broader admin-performance suite had an unrelated
existing inventory-view assertion failure; no inventory-view changes were
made for this project removal.

Post-transaction database verification confirmed ten archived/cancelled
projects, zero still-visible target projects, nine cancelled linked bookings,
three cancelled work orders and eight cancelled uncollected reservations.
All payment records and the two collected-material records match the backup
exactly. Physical stock quantities did not change; reserved counters decreased
by exactly the released reservations. No stock warnings were produced.

Recovery backup (ignored by Git):
`temp/selected-projects-before-archive-1791800092616.json`.
